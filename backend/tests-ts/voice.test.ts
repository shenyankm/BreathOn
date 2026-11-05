import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { gzipSync } from 'node:zlib'
import { once } from 'node:events'
import { fixture, modelMock, coach } from './helpers.ts'
import { type Doc } from '../src/core.ts'
import {
  asrPacket,
  parseAsr,
  ttsRequest,
  parseTts,
  parseClient,
  SpeechEvidence,
  Socket,
} from '../src/voice-protocol.ts'
import { setTimeout as delay } from 'node:timers/promises'

const u32 = (value: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
const asrResult = (result: Doc, final = false) => {
  const body = gzipSync(Buffer.from(JSON.stringify({ code: 20000000, result })))
  return Buffer.concat([
    Buffer.from([0x11, 0x90 | (final ? 2 : 0), 0x11, 0]),
    u32(body.length),
    body,
  ])
}
function ttsEvent(event: number, id = '', audio?: Buffer) {
  const body = audio ?? Buffer.from('{}'),
    name = Buffer.from(id)
  return Buffer.concat([
    Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]),
    u32(event),
    u32(name.length),
    name,
    u32(body.length),
    body,
  ])
}

test('ASR and TTS binary codecs reject truncation, oversized output, mismatched sizes, and invalid client frames', () => {
  const packet = asrResult({ text: '合成识别文本' }, true),
    parsed = parseAsr(packet)
  assert.equal(parsed.final, true)
  assert.equal(parsed.data.result.text, '合成识别文本')
  assert.throws(() => parseAsr(packet.subarray(0, -1)))
  const tooLarge = asrResult({ text: 'x'.repeat(2 ** 20 + 1) })
  assert.throws(() => parseAsr(tooLarge))
  assert.equal(parseTts(ttsEvent(150, 'session')).id, 'session')
  assert.throws(() => parseTts(ttsEvent(150, 'session').subarray(0, -1)))
  assert.equal(
    parseClient(JSON.stringify({ type: 'audio', audio: Buffer.alloc(640).toString('base64') })).pcm
      .length,
    640,
  )
  assert.throws(() => parseClient(JSON.stringify({ type: 'audio', audio: '!!!!' })))
  assert.throws(() =>
    parseClient(JSON.stringify({ type: 'audio', audio: Buffer.alloc(638).toString('base64') })),
  )
  assert.throws(() => parseClient(JSON.stringify({ type: 'mute', muted: 'yes' })))
  const evidence = new SpeechEvidence()
  evidence.observe(Buffer.alloc(640), true, false)
  assert.equal(evidence.describe(0, 20).tone_audio_assessed, false)
  assert.equal(evidence.describe(0, 20).playback_overlap_ms, 20)
  assert.equal(evidence.describe('bad', 20).available, false)
})

test('practice runs through real WebSockets, Pi, ASR, TTS, final review and durable saving', async () => {
  const asr = new WebSocketServer({ port: 0 }),
    tts = new WebSocketServer({ port: 0 })
  await Promise.all([once(asr, 'listening'), once(tts, 'listening')])
  let audioFrames = 0,
    ttsRequests = 0
  asr.on('connection', (ws) => {
    let submitted = false
    ws.on('message', (raw) => {
      const packet = Buffer.from(raw as Buffer),
        audio = packet[1] >> 4 === 2,
        final = !!(packet[1] & 2)
      if (audio) {
        audioFrames++
        if (!submitted && !final) {
          submitted = true
          ws.send(
            asrResult({
              text: '您好，我会先确认您的交流需求，再核对研究原文。',
              utterances: [
                {
                  start_time: 0,
                  end_time: 200,
                  text: '您好，我会先确认您的交流需求，再核对研究原文。',
                  definite: true,
                },
              ],
            }),
          )
        }
        if (final)
          ws.send(
            asrResult(
              {
                text: '您好，我会先确认您的交流需求，再核对研究原文。',
                utterances: [
                  {
                    start_time: 0,
                    end_time: 200,
                    text: '您好，我会先确认您的交流需求，再核对研究原文。',
                    definite: true,
                  },
                ],
              },
              true,
            ),
          )
      }
    })
  })
  tts.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const packet = Buffer.from(raw as Buffer),
        event = packet.readUInt32BE(4)
      let id = ''
      if (![1, 2].includes(event)) {
        const size = packet.readUInt32BE(8)
        id = packet.subarray(12, 12 + size).toString()
      }
      if (event === 1) ws.send(ttsEvent(50))
      if (event === 100) {
        ttsRequests++
        ws.send(ttsEvent(150, id))
      }
      if (event === 102) {
        ws.send(ttsEvent(352, id, Buffer.alloc(960)))
        ws.send(ttsEvent(152, id))
      }
      if (event === 2) ws.send(ttsEvent(52))
    })
  })
  const f = await fixture(
    {
      key: 'synthetic-key',
      asrKey: 'synthetic-asr',
      ttsKey: 'synthetic-tts',
      search: false,
      asrUrl: `ws://127.0.0.1:${(asr.address() as any).port}`,
      ttsUrl: `ws://127.0.0.1:${(tts.address() as any).port}`,
    },
    modelMock(),
  )
  try {
    await f.app.listen({ host: '127.0.0.1', port: 0 })
    const address = f.app.server.address() as any,
      socket = await Socket.connect(
        `ws://127.0.0.1:${address.port}/api/realtime?experience=practice`,
        { Origin: f.config.origins[0] },
      )
    await socket.send({ type: 'start', mode: 'assisted' })
    const events: Doc[] = []
    let ready = false,
      doctor = false,
      coaching = false,
      ended: Doc | undefined
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !ended) {
      const data = JSON.parse((await socket.read(undefined, 16000)).toString())
      events.push(data)
      if (data.type === 'ready' && !ready) {
        ready = true
        for (let i = 0; i < 10; i++)
          await socket.send({ type: 'audio', audio: Buffer.alloc(640).toString('base64') })
      }
      if (data.type === 'practice_turn') doctor = true
      if (data.type === 'coaching' && doctor && !coaching) {
        coaching = true
        await socket.send({ type: 'stop' })
      }
      if (data.type === 'ended') ended = data
    }
    assert(ready && doctor && coaching, JSON.stringify(events.map((e) => e.type)))
    assert(ended?.saved)
    assert.equal(ended.status, 'completed')
    assert(audioFrames >= 2)
    assert(ttsRequests >= 1)
    const record = (await f.call('GET', `/api/sessions/${ended.session_id}`)).json()
    assert.equal(record.capture_status, 'completed')
    assert(record.messages.some((m: Doc) => m.role === 'trainee' && m.final))
    assert(record.usage.some((u: Doc) => u.provider === 'deepseek'))
    assert.equal(record.summary_card.total, null)
    assert.equal(
      (await f.call('GET', `/api/sessions/${ended.session_id}/status`)).json().state,
      'saved',
    )
    socket.close()
  } finally {
    await f.close()
    for (const server of [asr, tts]) {
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

test('combat bridges duplex audio, mute and interruption while ASR and Pi save an independent transcript', async () => {
  const asr = new WebSocketServer({ port: 0 }),
    duplex = new WebSocketServer({ port: 0 })
  await Promise.all([once(asr, 'listening'), once(duplex, 'listening')])
  const controls: string[] = [],
    text = '您好，我会先确认交流需求，再核对原始研究资料。'
  asr.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const packet = Buffer.from(raw as Buffer)
      if (packet[1] >> 4 === 2)
        ws.send(
          asrResult(
            { text, utterances: [{ start_time: 0, end_time: 200, text, definite: true }] },
            !!(packet[1] & 2),
          ),
        )
    }),
  )
  duplex.on('connection', (ws) => {
    let replied = false
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString())
      controls.push(data.type)
      if (data.type === 'session.create')
        ws.send(JSON.stringify({ type: 'session.created', session: { id: 'synthetic-duplex' } }))
      if (data.type === 'input_audio_buffer.append' && !replied) {
        replied = true
        for (const event of [
          {
            type: 'response.output_text.done',
            response_id: 'doctor-1',
            text: '请问您的资料来自哪项研究？',
          },
          {
            type: 'response.output_audio.delta',
            response_id: 'doctor-1',
            delta: Buffer.alloc(960).toString('base64'),
          },
          { type: 'response.done', usage: { audio_tokens: 12 } },
        ])
          ws.send(JSON.stringify(event))
      }
      if (data.type === 'response.cancel')
        ws.send(JSON.stringify({ type: 'response.canceled', response_id: 'doctor-1' }))
      if (data.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed' }))
    })
  })
  const f = await fixture(
    {
      key: 'synthetic',
      asrKey: 'synthetic',
      voiceKey: 'synthetic',
      asrUrl: `ws://127.0.0.1:${(asr.address() as any).port}`,
      voiceUrl: `ws://127.0.0.1:${(duplex.address() as any).port}`,
    },
    modelMock(),
  )
  try {
    await f.app.listen({ host: '127.0.0.1', port: 0 })
    const socket = await Socket.connect(
      `ws://127.0.0.1:${(f.app.server.address() as any).port}/api/realtime?experience=combat`,
      { Origin: f.config.origins[0] },
    )
    await socket.send({ type: 'start', mode: 'assisted' })
    let ended: Doc | undefined,
      receivedAudio = false,
      interrupted = false,
      muted = false,
      submitted = false
    while (!ended) {
      const event = JSON.parse((await socket.read(undefined, 15000)).toString())
      if (event.type === 'ready')
        for (let i = 0; i < 10; i++)
          await socket.send({ type: 'audio', audio: Buffer.alloc(640).toString('base64') })
      if (event.type === 'audio') receivedAudio = true
      if (event.type === 'audio' && !submitted) {
        submitted = true
        await socket.send({ type: 'mute', muted: true })
        await socket.send({ type: 'interrupt' })
      }
      if (event.type === 'muted') muted = event.muted
      if (event.type === 'interrupted') {
        interrupted = true
        await socket.send({ type: 'stop' })
      }
      if (event.type === 'error') assert.fail(JSON.stringify(event))
      if (event.type === 'ended') ended = event
    }
    assert(receivedAudio && interrupted && muted)
    assert(ended.saved)
    assert.equal(ended.status, 'completed')
    const record = (await f.call('GET', `/api/sessions/${ended.session_id}`)).json()
    assert(
      record.messages.some((row: Doc) => row.role === 'trainee' && row.text === text && row.final),
    )
    assert(record.messages.some((row: Doc) => row.role === 'doctor' && row.id === 'doctor-1'))
    assert(record.interaction_events.some((row: Doc) => row.type === 'manual_interrupt'))
    assert(record.usage.some((row: Doc) => row.provider === 'doubao-duplex'))
    for (const name of ['input_audio_mute.commit', 'response.cancel', 'session.close'])
      assert(controls.includes(name))
    socket.close()
  } finally {
    await f.close()
    for (const server of [asr, duplex]) {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})
