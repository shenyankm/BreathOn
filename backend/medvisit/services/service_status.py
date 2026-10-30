"""Short provider requests for the settings page; no training records are created."""
import asyncio
import base64
import json
from pathlib import Path
from uuid import uuid4

from openai import AsyncClient, APIStatusError, APITimeoutError
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from ..voice.asr import ASR_MODEL, asr_connection, packet, parse_response, request_packet
from ..voice.protocol import BridgeError, DUPLEX_MODEL, event, session_config
from ..voice.tts import TTS_RESOURCE, synthesize

CHECK_TIMEOUT = 20
# Fixed synthetic "你好", 16 kHz mono int16; speech is needed to verify recognition, not just a handshake.
CHECK_AUDIO = Path(__file__).parents[1] / 'voice' / 'service-check.pcm'


async def check_asr(settings):
    session_id = str(uuid4())
    audio = CHECK_AUDIO.read_bytes()
    async with asr_connection(settings, session_id) as upstream:
        await upstream.send(request_packet(session_id))
        for offset in range(0, len(audio), 6400):
            final = offset + 6400 >= len(audio)
            await upstream.send(packet(audio[offset:offset + 6400], audio=True, final=final))
            if not final:
                await asyncio.sleep(0.2)
        recognized = ''
        while True:
            data, final = parse_response(await upstream.recv())
            result = data.get('result', {})
            if not isinstance(result, dict) or not isinstance(result.get('text', ''), str):
                raise ValueError('Invalid recognition result')
            recognized = result.get('text', '').strip() or recognized
            if final:
                if not recognized:
                    raise ValueError('No recognized speech')
                return


async def check_tts(settings):
    async def discard_audio(pcm):
        pass
    await synthesize(settings, '你好', str(uuid4()), discard_audio)


async def check_analysis(settings):
    async with settings._deepseek_slots, AsyncClient(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_endpoint.removesuffix('/chat/completions'),
        timeout=15, max_retries=0,
    ) as client:
        result = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[{'role': 'user', 'content': '服务检测。请只输出 JSON：{"status":"ok"}'}],
            response_format={'type': 'json_object'}, max_tokens=32,
            extra_body={'thinking': {'type': 'disabled'}},
        )
        if not result.choices or result.choices[0].finish_reason != 'stop' or json.loads(result.choices[0].message.content or '{}') != {'status': 'ok'}:
            raise ValueError('Invalid model result')


async def check_duplex(settings):
    async with connect(settings.endpoint, additional_headers={'X-Api-Key': settings.api_key},
                       open_timeout=10, close_timeout=2, max_size=2**20, max_queue=16, proxy=None) as upstream:
        await upstream.send(json.dumps(session_config(str(uuid4()), settings.voice,
            instructions='你是服务检测助手。听到问候后只回复一句：你好。')))
        while True:
            data = json.loads(await upstream.recv())
            if data.get('type') == 'error':
                raise BridgeError('provider_error', '实战语音服务拒绝请求，请核对权限、音色和额度。')
            if data.get('type') == 'session.created':
                break
        audio = CHECK_AUDIO.read_bytes() + bytes(16000 * 2 * 2)
        for offset in range(0, len(audio), 640):
            await upstream.send(json.dumps({'type': 'input_audio_buffer.append',
                'audio': base64.b64encode(audio[offset:offset + 640].ljust(640, b'\0')).decode()}))
            await asyncio.sleep(0.02)
        audio_bytes = 0
        while True:
            data = json.loads(await upstream.recv())
            kind = data.get('type')
            if kind == 'error':
                raise BridgeError('provider_error', '实战语音服务返回错误，请核对权限、音色和额度。')
            if kind == 'response.output_audio.delta':
                pcm = base64.b64decode(data.get('delta', ''), validate=True)
                if not pcm or len(pcm) % 2:
                    raise ValueError('Invalid duplex audio')
                audio_bytes += len(pcm)
            if kind == 'response.done':
                if not audio_bytes:
                    raise ValueError('No duplex audio')
                await upstream.send(json.dumps(event('session.close')))
                return


async def check_provider(settings, probe, required):
    if any(not getattr(settings, key) for key in required):
        return {'ok': False, 'message': '缺少服务配置，请补齐后重启后端。'}
    try:
        async with asyncio.timeout(CHECK_TIMEOUT):
            await probe(settings)
        return {'ok': True, 'message': ''}
    except (TimeoutError, APITimeoutError):
        message = '检测超时，请稍后重试。'
    except (APIStatusError, InvalidStatus) as exc:
        status = exc.status_code if isinstance(exc, APIStatusError) else exc.response.status_code
        message = '鉴权或服务权限校验失败。' if status in (401, 403) else '请求受限或额度不足。' if status == 429 else '服务返回异常，请稍后重试。'
    except BridgeError as exc:
        message = exc.message
    except Exception:
        # Provider exception strings may contain credentials or private response bodies.
        message = '未收到有效服务结果，请检查网络、服务权限和额度。'
    return {'ok': False, 'message': message}


def combined_status(dependencies):
    failures = [f'{label}：{result["message"].rstrip("。")}' for label, result in dependencies if not result['ok']]
    return {'ok': not failures, 'message': '；'.join(failures) + ('。' if failures else '')}


async def check_services(settings):
    asr, tts, analysis, duplex = await asyncio.gather(
        check_provider(settings, check_asr, ('asr_api_key',)),
        check_provider(settings, check_tts, ('tts_api_key', 'tts_voice')),
        check_provider(settings, check_analysis, ('deepseek_api_key', 'deepseek_model')),
        check_provider(settings, check_duplex, ('api_key', 'voice')),
    )
    services = {
        'asr': asr, 'tts': tts, 'analysis': analysis,
        'practice': combined_status([('语音识别', asr), ('医生朗读', tts), ('AI 分析', analysis)]),
        'combat': combined_status([('实战语音', duplex), ('语音识别', asr), ('AI 分析', analysis)]),
    }
    models = {
        'asr': f'SeedASR · {ASR_MODEL}', 'tts': TTS_RESOURCE,
        'practice': settings.deepseek_model or '未设置模型',
        'analysis': settings.deepseek_model or '未设置模型',
        'combat': f'Seeduplex · {DUPLEX_MODEL}',
    }
    return {'services': {key: {**result, 'model': models[key]} for key, result in services.items()}}
