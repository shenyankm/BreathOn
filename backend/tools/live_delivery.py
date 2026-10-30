"""Real-provider acceptance in the isolated server; synthetic inputs are explicitly labelled."""
import argparse
import asyncio
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import struct
from time import monotonic
from urllib.request import Request, urlopen
from uuid import uuid4

from websockets.asyncio.client import connect

from medvisit.core.config import Settings
from medvisit.platform.operations import Operations
from medvisit.platform.progress import capture_prices
from medvisit.platform.store import PlatformStore
from medvisit.platform.training import prepare_training, snapshot, check_materials
from medvisit.services.final_review import review_training
from medvisit.storage.records import FileRecords, SessionRecord
from medvisit.voice.tts import synthesize
from tools.acceptance_app import RECORDS
from tools.prepare_training import prepare, official_pdf

BASE = 'http://127.0.0.1:8001/api'
ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://127.0.0.1:5174'


def call(method, path, body=None, *, raw=None):
    payload = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    request = Request(BASE+path, data=payload, method=method,
        headers={'Origin':ORIGIN,'Content-Type':'application/pdf' if raw is not None else 'application/json'})
    with urlopen(request, timeout=80) as response:
        return json.load(response)


def resample(pcm):
    samples = struct.unpack('<'+'h'*(len(pcm)//2), pcm)
    output = []
    for offset in range(0, len(samples)-2, 3):
        output.extend((samples[offset], (samples[offset+1]+samples[offset+2])//2))
    return struct.pack('<'+'h'*len(output), *output)


def turn_complete(events, earlier_doctors):
    return (any(event.get('type')=='transcript' and event.get('role')=='trainee' and event.get('final') for event in events)
            and any(event.get('type')=='transcript' and event.get('role')=='doctor' and event.get('final')
                    and event['id'] not in earlier_doctors for event in events))


async def voice(settings, scene_id, experience):
    chunks = []
    async def collect(chunk):
        chunks.append(chunk)
    await synthesize(settings, '您好，我想先了解您在成人体重管理中最关心的问题，然后核对原始资料的适用范围。', 'acceptance-input', collect)
    audio = resample(b''.join(chunks))+bytes(32000*2)
    events, output_bytes = [], 0
    trace = ROOT/'data/validation'/('voice-trace-'+str(uuid4())+'.json')
    async with asyncio.timeout(180), connect(f'ws://127.0.0.1:8001/api/realtime?experience={experience}&scenario_id={scene_id}',
        origin=ORIGIN, max_size=2**20, max_queue=32) as ws:
        await ws.send(json.dumps({'type':'start','mode':'assisted' if experience=='practice' else 'independent'}))
        async def receive(predicate):
            nonlocal output_bytes
            while True:
                event = json.loads(await ws.recv())
                if event['type'] == 'audio':
                    output_bytes += len(base64.b64decode(event['audio']))
                else:
                    events.append(event)
                    trace.write_text(json.dumps({'events':events,'output_audio_bytes':output_bytes,'synthetic_audio':True},ensure_ascii=False,indent=2))
                if event['type'] == 'error':
                    raise AssertionError(event)
                if predicate(event):
                    return event
        ready = await receive(lambda event:event['type']=='ready')
        speaking, sent = asyncio.Event(), asyncio.Event()
        async def send():
            started, offset, frames = monotonic(), 0, 0
            while True:
                frame = bytes(640)
                if speaking.is_set() and offset<len(audio):
                    frame = audio[offset:offset+640].ljust(640,b'\0')
                    offset += 640
                    if offset>=len(audio):sent.set()
                await ws.send(json.dumps({'type':'audio','audio':base64.b64encode(frame).decode(),'playing':False}))
                frames += 1
                await asyncio.sleep(max(0,frames/50-(monotonic()-started)))
        sending = asyncio.create_task(send())
        try:
            if experience == 'practice':
                await receive(lambda event:event['type']=='tts_state' and event['state']=='done')
                speaking.set()
                await receive(lambda event:event['type']=='practice_turn')
                await sent.wait()
                await receive(lambda event:event['type']=='tts_state' and event['state']=='done')
            else:
                await receive(lambda event:event['type']=='audio')
                earlier_doctors = {event['id'] for event in events if event.get('type')=='transcript' and event.get('role')=='doctor'}
                speaking.set()
                await receive(lambda _event:turn_complete(events,earlier_doctors))
                await sent.wait()
                while True:
                    try:
                        await asyncio.wait_for(receive(lambda event:event['type']=='audio'),1.5)
                    except TimeoutError:
                        break
            await ws.send(json.dumps({'type':'stop'}))
            sending.cancel()
            ended = await receive(lambda event:event['type']=='ended')
        finally:
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)
    record = call('GET','/sessions/'+ready['session_id'])
    assert ended['saved'] and record['capture_status']=='completed', ended
    assert output_bytes>0 and any(message['role']=='trainee' and message['final'] for message in record['messages'])
    assert record['analysis_status']=='completed' and any(item.get('final_report') for item in record['coaching'])
    record['validation_only'] = True
    (RECORDS/(record['id']+'.json')).write_text(json.dumps(record,ensure_ascii=False))
    return {'session_id':record['id'],'output_audio_bytes':output_bytes,'events':events,'record':record,
            'synthetic_audio':True,'microphone_tested':False}


async def verify_voice(settings, scene_id, record_phase, experience=None):
    for experience in (experience,) if experience else ('practice','combat'):
        started = monotonic()
        try:
            result = await voice(settings,scene_id,experience)
            result['elapsed_seconds'] = round(monotonic()-started,2)
            record_phase('real_voice_'+experience,result)
        except Exception as exc:
            record_phase('real_voice_'+experience,{'error_type':type(exc).__name__,'error':str(exc)},passed=False)
    totals = call('GET','/progress?days=7')
    assert totals['cost_totals'] and totals['session_count']>=4
    record_phase('usage_and_cost_records',totals)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--voice-only', action='store_true', help='复用已有基线，只复验真实语音链路')
    parser.add_argument('--experience', choices=('practice','combat'), help='只复验指定语音模式')
    args = parser.parse_args()
    assert resample(struct.pack('<hhhhhh',0,10,20,30,40,50)) == struct.pack('<hhhh',0,15,30,45)
    doctor = {'type':'transcript','role':'doctor','id':'reply','final':True}
    trainee = {'type':'transcript','role':'trainee','id':'input','final':True}
    assert turn_complete([doctor,trainee],set()) and turn_complete([trainee,doctor],set())
    assert not turn_complete([doctor,trainee],{'reply'})
    path = ROOT/'data/validation'/('delivery-live-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')+'.json')
    report = {'completed':False,'mocked_services':False,'synthetic_dialogue':True,'medical_expert_review':False,'microphone_tested':False,'results':[]}
    def record_phase(name, data, passed=True):
        report['results'].append({'phase':name,'passed':passed,**data})
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({'phase':name,'passed':passed},ensure_ascii=False),flush=True)
    baseline = prepare(call, official_pdf())
    record_phase('sourced_baseline',baseline)
    settings = Settings(records=RECORDS,database_url='')
    if args.voice_only:
        await verify_voice(settings,baseline['scenario_id'],record_phase,args.experience)
        print('REPORT='+str(path),flush=True)
        assert all(result['passed'] for result in report['results']), '真实语音验收未全部通过，请检查报告。'
        report['completed'] = True
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        return
    store, records, user = PlatformStore(RECORDS/'platform.sqlite3'), FileRecords(RECORDS), {'workspace':'local','id':'local','team':''}
    service = Operations(store,records)
    scenes = []
    for situation,difficulty,seconds in [('first_visit','basic',300),('follow_up','intermediate',300),('time_pressure','intermediate',90),('evidence_challenge','advanced',300)]:
        body = {'product':'玛仕度肽注射液','disease':'成人体重管理','objective':'先确认关注点，依据本次说明书说明适用范围与证据边界；澄清异议后约定合规跟进，不作个体效果保证。',
            'doctor_id':baseline['doctor_id'],'rubric_id':baseline['rubric_id'],'content_ids':[baseline['document_id']],
            'situation':situation,'difficulty':difficulty,'duration_seconds':seconds}
        scene = call('POST','/scenarios/generate',body)
        assert scene['status']=='draft' and scene['generation']['usage']['total_tokens']>0
        assert scene['generation']['cost']['totals']
        scenes.append(scene)
        record_phase('generate_'+situation,{'scene':scene})
    history_bad = [
        ('doctor','你好，你今天想交流什么？'),('trainee','这个药适合所有想减重的人，肯定安全，每个人的效果都一样。'),
        ('doctor','你依据什么证据，适用人群是什么？'),('trainee','不用看说明书，任何年龄和BMI都可以，没有风险。'),
        ('doctor','我对适用范围和甲状腺风险有疑问，今天先到这里。'),('trainee','您应该立即开处方，后续没有什么需要核实的。')]
    history_good = [
        ('doctor','你好，你今天想交流什么？'),('trainee','您好，我想交流成人体重管理资料，您现在方便吗？您更关心适用人群、证据范围，还是安全性？'),
        ('doctor','我主要关心适用人群和证据是否可以外推。'),('trainee','依据本次2025年6月24日版说明书，在控制饮食和增加体力活动基础上，用于成人长期体重控制：初始BMI至少28，或BMI至少24且有至少一种体重相关合并症。资料以外的人群需要核实，不能从机制直接推导适用。'),
        ('doctor','能保证每个人效果一样吗？甲状腺风险如何解释？'),('trainee','不能作个体效果保证。说明书报告的甲状腺C细胞肿瘤是啮齿类动物发现，与人类的相关性尚未确定。甲状腺髓样癌个人史或家族史、或MEN2的患者禁用；其他问题按原文核实，不把未知说成安全。'),
        ('doctor','我今天时间不多，剩余问题以后再看。'),('trainee','好的，今天先到这里。我们已确认需要核对适用人群和风险；尚未覆盖的问题，我会通过授权渠道核实后，在您方便的时间反馈。如果您同意，我们再约后续交流。')]
    async def reviewed(history, remediation=None):
        training = prepare_training(store,user,baseline['scenario_id'])
        if remediation and remediation.get('focus_key'):
            training['focus_dimensions'] = [remediation['focus_key']]
        record = SessionRecord(str(uuid4()),'independent')
        record.training = training
        record.validate_training = lambda:check_materials(store,user['workspace'],training)
        record.data.update(workspace='local',owner_id='local',team='',experience='practice',capture_status='completed',
            training=snapshot(training),pricing=capture_prices(store,user),validation_only=True,capture_kind='synthetic_text')
        if remediation:record.data['remediation_id'] = remediation['id']
        for index,(role,text) in enumerate(history):record.transcript('m'+str(index),role,text,final=True)
        coach = await review_training(settings,record)
        record_phase('real_review_candidate', {'record':record.data}, passed=not coach['assessment']['validation_errors'])
        assert coach['assessment']['validation_errors']==[], coach['assessment']
        assert coach['reply'] and coach['points'] and coach['analysis']
        records.save(record,'completed')
        return record
    poor = await reviewed(history_bad)
    record_phase('real_review_baseline',{'record':poor.data})
    plan = call('POST','/sessions/'+poor.data['id']+'/retrain',{})
    assert call('GET','/remediations/'+plan['id']+'/next')['remediation_id']==plan['id']
    improved = await reviewed(history_good,plan)
    service.finish_remediation(user,improved)
    progress = call('GET','/remediations/'+plan['id']+'/progress')
    assert progress['status']=='completed' and progress['comparable']
    assert any(dimension['delta'] is not None and dimension['delta']>0 for dimension in progress['dimensions']), progress
    record_phase('real_review_retraining',{'record':improved.data,'progress':progress})
    case = call('POST','/sessions/'+improved.data['id']+'/cases',{'message_id':'m7'})
    assert case['quotes'][-1]['text']==history_good[-1][1]
    case = call('POST','/cases/'+case['id']+'/confirm',{'version':case['version']})
    exported = call('GET','/cases/'+case['id']+'/export')
    imported = call('POST','/cases/import',exported)
    assert imported['status']=='draft' and not imported['origin_verified']
    reused = call('POST','/scenarios/generate',{'product':'玛仕度肽注射液','disease':'成人体重管理','objective':'借鉴案例的澄清与跟进方式，生成新的首次拜访训练，医学事实仅来自本次说明书。',
        'doctor_id':baseline['doctor_id'],'rubric_id':baseline['rubric_id'],'content_ids':[baseline['document_id']],'case_id':case['id']})
    assert reused['generation']['case']['id']==case['id'] and reused['status']=='draft'
    record_phase('case_extract_export_import_reuse',{'case':case,'imported_case':imported,'generated_scene':reused})
    template = call('GET','/scenarios/'+baseline['scenario_id']+'/export')
    template['scenario']['title'] += ' · 验收'+path.stem.removeprefix('delivery-live-')
    receipt = call('POST','/scenarios/import',template)
    assert call('GET','/catalog/scenario/'+receipt['scenario_id'])['status']=='draft'
    record_phase('portable_training_template',{'receipt':receipt})
    await verify_voice(settings,baseline['scenario_id'],record_phase)
    print('REPORT='+str(path),flush=True)
    assert all(result['passed'] for result in report['results']), '真实服务验收未全部通过，请检查报告。'
    report['completed'] = True
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    asyncio.run(main())
