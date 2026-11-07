import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { gzipSync, gunzipSync } from 'node:zlib'
import { WebSocketServer } from 'ws'

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]
const root = resolve(arg('--root')), name = arg('--case'), small = process.argv.includes('--small')
const samples = Number(arg('--samples') || 5)
const load = (file: string) => import(pathToFileURL(join(root, 'src', file + '.ts')).href)
const core = await load('core'), agents = await load('agents'), { Dialogue } = await load('live')
const { Store } = await load('store'), training = await load('training'), { Medical } = await load('medical')
const voice = await load('voice-protocol')
const folder = await mkdtemp(join(tmpdir(), 'latency-probe-'))
const cleanup: (() => Promise<unknown>)[] = []
const user = { id: 'local', workspace: 'local', team: '', role: 'admin', authenticated: false }
const coach = { focus: '确认需求', analysis: '围绕原话核对目标。', points: ['先确认需求。'], reply: '请先确认目标。', risk: '',
  delivery: { tone: '声音语调未评估。', fluency: '语句完整。', logic: '按问题回应。', turn_taking: '未观察。' } }
const sse = (value: unknown) => new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: null }] }) + '\n\ndata: ' +
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
const config = () => ({ ...core.settings({}), key: 'synthetic-key', search: false, modelConcurrency: 4, records: join(folder, 'sessions') })
const fetcher = async (_: unknown, init: any) => sse(JSON.stringify(JSON.parse(init.body).messages[0]).includes('本次只扮演医生') ? { doctor_reply: '请先确认您的交流需求。' } : { coach })
type Result = { latency_ms: number; complete_ms: number; output: unknown; outer_ms?: number }
let probe: () => Promise<Result>
let iterations = 1
async function storeFixture() { const store = new Store(config()); await store.open(); cleanup.push(() => store.close()); return store }
async function server() {
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening')
  cleanup.push(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return server
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
try {
  if (name.startsWith('med_')) {
    const store = await storeFixture(), products = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `药品${i}`, brand: `brand${i}`, compares_with: i ? ['p0'] : [] })), sources: any[] = []
    await store.transaction('local', async (tx: any) => {
      for (let i = 0; i < (small ? 2 : 12); i++) {
        const pages = Array.from({ length: small ? 1 : 5 }, (_, j) => ({ number: j + 1, text: `研究 2024 安全人群 evidence brand${i % 4} 风险 资料${i}。`.repeat(small ? 2 : 180) }))
        const url = `https://example.invalid/${i}`
        await tx.create('local', 'content', { status: 'approved', title: `资料${i}`, source_url: url, pages }, `d${i}`)
        await tx.execute('UPDATE platform_entities SET updated_at=? WHERE tenant_id=? AND kind=? AND id=?', ['fixture', 'local', 'content', `d${i}`])
        sources.push({ id: `s${i}`, title: `资料${i}`, url, quality: 'original', kind: 'label', product_ids: [`p${i % 4}`], published_at: '2024', pages })
      }
    })
    const medical = new Medical(store, { config: {} })
    medical.load = async () => ({ format: 1, version: 'v', products, sources, compiled: {} })
    iterations = small ? 8 : 2
    probe = async () => {
      const start = performance.now()
      const result = name === 'med_reference' ? await medical.reference(user, products[0], '研究2024 安全人群 evidence') : await medical.evidence(user, 'brand0 brand1 brand2 brand3 研究2024 安全人群 evidence')
      const ms = performance.now() - start
      return { latency_ms: ms, complete_ms: ms, output: result }
    }
  } else if (name === 'privacy') {
    const queries = ['研究2024 安全人群 evidence', '患者王先生 联系我', '患者王明 45岁', '电话13812345678', '指南 RCT 研究']
    iterations = small ? 40 : 2000
    probe = async () => { const start = performance.now(); const output = queries.map(q => agents.personalDataKind(q)); const ms = performance.now() - start; return { latency_ms: ms, complete_ms: ms, output } }
  } else if (name === 'asr_packet' || name === 'tts_packet') {
    let seed = 12
    const pcm = Buffer.from(Array.from({ length: small ? 640 : 6400 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed >>> 24 }))
    iterations = small ? 20 : 80
    probe = async () => { const start = performance.now(); const packet = name === 'asr_packet' ? voice.asrPacket(pcm, true, true) : voice.ttsRequest(200, { req_params: { text: '你好'.repeat(small ? 1 : 600) } }, 'synthetic-session'); const ms = performance.now() - start
      if (name === 'asr_packet') { assert.equal(packet.readUInt32BE(4), packet.length - 8); assert.deepEqual(gunzipSync(packet.subarray(8)), pcm) }
      return { latency_ms: ms, complete_ms: ms, output: name === 'asr_packet' ? { header: packet.subarray(0, 4).toString('hex'), pcm: gunzipSync(packet.subarray(8)).toString('base64') } : packet.toString('base64') }
    }
  } else if (name.startsWith('browser_')) {
    const { BrowserAudio, decodePcm16, encodeAudio } = await import(pathToFileURL(join(root, '../frontend/src/lib/audio/browser-audio.ts')).href)
    if (name === 'browser_open') {
      const events: string[] = []
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) } } })
      const gain = () => ({ connect() { return this }, disconnect() {}, gain: { value: 1 } })
      globalThis.AudioContext = class { sampleRate = 16000; destination = {}; audioWorklet = { addModule: async () => { await delay(small ? 0 : 15); events.push('module') } }; createGain = gain; createMediaStreamSource = gain; resume = async () => { await delay(small ? 0 : 20); events.push('resume') }; close = async () => {} } as any
      globalThis.AudioWorkletNode = class { port = { close() {} }; connect = gain().connect; disconnect() {} } as any
      probe = async () => { events.length = 0; const audio = new BrowserAudio(), start = performance.now(); await audio.open(() => {}, () => {}); const ms = performance.now() - start; audio.stop(); return { latency_ms: ms, complete_ms: ms, output: [...events].sort() } }
    } else {
      const buffer = new Uint8Array(small ? 640 : 9600).map((_, i) => i * 73).buffer, encoded = Buffer.from(buffer).toString('base64')
      iterations = small ? 80 : 25
      probe = async () => { const start = performance.now(); const result = name === 'browser_encode' ? encodeAudio(buffer) : decodePcm16(encoded); const ms = performance.now() - start; return { latency_ms: ms, complete_ms: ms, output: typeof result === 'string' ? result : Array.from(result) } }
    }
  } else if (name === 'dialogue_real' || name === 'dialogue_reference') {
    const store = await storeFixture(), documents: any[] = []
    await store.transaction('local', async (tx: any) => {
      await tx.create('local', 'workspace_settings', { training_scoring: false }, 'admin')
      for (let i = 0; i < (small ? 1 : 20); i++) documents.push(await tx.create('local', 'content', {
        status: 'approved', title: `资料${i}`, pages: [{ number: 1, text: '合成审核资料。'.repeat(small ? 3 : 30000) }],
      }, `d${i}`))
    })
    const models = new agents.Models(config(), fetcher), medical = new Medical(store, models)
    const products = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `药品${i}`, brand: `brand${i}`, compares_with: i ? ['p0'] : [] }))
    if (name === 'dialogue_reference') medical.load = async () => ({ version: 'v', products, sources: [], compiled: {} })
    const captured = { documents, drugs: [], policies: [], stage: 'full',
      scenario: { id: 's', title: '合成交流', objective: '确认需求和下一步安排', situation: 'first_visit', difficulty: 'basic' },
      doctor: { id: 'd', display_name: '模拟医生', mood: 'neutral' }, rubric: { id: 'r', dimensions: [] } }
    probe = async () => {
      const record: any = { id: '00000000-0000-4000-8000-000000000001', experience: 'practice', mode: 'assisted',
        messages: [{ id: 'u', role: 'trainee', text: '我先确认您的交流需求，再讨论下一步。', final: true }], usage: [] }
      if (name === 'dialogue_reference') record.free_context = { drug: products[0], doctor: { id: 'd', name: '模拟医生', mood: 'neutral' } }
      let thinking = 0, first = 0, doctorText = ''; const start = performance.now()
      const dialogue = new Dialogue({ send: async (event: any) => {
        if (event.type === 'practice_state' && event.state === 'thinking') thinking = performance.now()
        if (event.type === 'practice_turn') { first = performance.now(); doctorText = event.message.text }
      } }, store, models, medical, user, record, captured)
      dialogue.checkpoint = async () => {}; dialogue.startSpeech = () => {}
      await dialogue.respond(0, 'u', new AbortController().signal)
      assert.ok(thinking && first)
      return { latency_ms: first - thinking, outer_ms: first - start, complete_ms: performance.now() - thinking,
        output: { doctorText, focus: record.coaching.at(-1)?.focus } }
    }
  } else if (name === 'stream') {
    const models = new agents.Models(config(), async () => new Response(new ReadableStream({ async start(controller) {
      await delay(small ? 1 : 8)
      controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '{"doctor_reply":"你好"}' }, finish_reason: null }] }) + '\n\n'))
      await delay(small ? 1 : 65)
      controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n'))
      controller.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    probe = async () => {
      const agent = models.agent('只输出 JSON'), start = performance.now(); let first = 0
      const unsubscribe = agent.agent.subscribe((event: any) => { if (!first && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') first = performance.now() - start })
      try { const reply = await agent.reply('合成输入'); assert.ok(first); return { latency_ms: first, complete_ms: performance.now() - start, output: reply.text } } finally { unsubscribe() }
    }
  } else if (name === 'queue' || name === 'serialize' || name === 'tokens') {
    const models = new agents.Models({ ...config(), modelConcurrency: name === 'queue' && !small ? 1 : 4 }, async (_: any, init: any) => {
      const doctor = JSON.stringify(JSON.parse(init.body).messages[0]).includes('本次只扮演医生')
      if (name === 'queue') await delay(doctor ? 8 : 65)
      return sse(doctor ? { doctor_reply: '请先确认您的交流需求。' } : { coach })
    })
    const history = Array.from({ length: small ? 2 : 16 }, (_, i) => ({ id: `u${i}`, role: i % 2 ? 'trainee' : 'doctor', final: true, text: name === 'serialize' ? '合成交流内容。'.repeat(small ? 2 : 500) : '请先确认需求。' }))
    probe = async () => { const start = performance.now(); let first = 0
      const reply = await agents.generateReply(models, history, { onDoctor: () => { first = performance.now() - start } })
      assert.ok(first); return { latency_ms: first, complete_ms: performance.now() - start, output: reply.result }
    }
  } else if (name.startsWith('dialogue_')) {
    const cost = (n: number) => small ? 0 : n
    probe = async () => {
      const record: any = { id: '00000000-0000-4000-8000-000000000001', experience: 'practice', mode: 'assisted', messages: Array.from({ length: name === 'dialogue_history' && !small ? 5000 : 2 }, (_, i) => ({ id: `u${i}`, role: i % 2 ? 'trainee' : 'doctor', text: '请先核对需求。'.repeat(name === 'dialogue_history' && !small ? 120 : 1), final: true })), usage: [], medical_checks: [] }
      const timed = name !== 'dialogue_history'
      const models = new agents.Models(config(), fetcher)
      const store = { config: config(), transaction: async (_: string, callback: any) => callback({ get: async () => { if (timed) await delay(cost(25)); return { training_scoring: false } } }) }
      const medical = { invalidate: async () => { if (timed) await delay(cost(18)) }, reference: async () => { if (timed) await delay(cost(40)); return { version: 'v', evidence: [] } }, validReference: async () => true }
      let thinking = 0, first = 0, doctorText = ''; const start = performance.now()
      const dialogue = new Dialogue({ send: async (event: any) => { if (event.type === 'practice_state' && event.state === 'thinking') thinking = performance.now(); if (event.type === 'practice_turn') { first = performance.now(); doctorText = event.message.text } } }, store, models, medical, user, record)
      record.free_context = { drug: { id: 'p', name: '合成药品' }, doctor: { id: 'd', name: '模拟医生', mood: 'neutral' } }
      dialogue.checkpoint = async () => {}
      dialogue.validate = async () => { if (timed) await delay(cost(22)) }
      dialogue.startSpeech = () => {}
      dialogue.checks.snapshot = async () => { if (timed) await delay(cost(30)); return [] }
      await dialogue.respond(0, record.messages.at(-1).id, new AbortController().signal)
      assert.ok(first && thinking)
      return { latency_ms: first - thinking, outer_ms: first - start, complete_ms: performance.now() - thinking,
        output: { doctorText, coach: record.coaching.at(-1)?.focus, responded: [...dialogue.responded].sort() } }
    }
  } else if (name === 'skill' || name === 'skill_regex') {
    iterations = small ? 4 : 40
    probe = async () => { const start = performance.now(); const text = await agents.skill('medical-rep-academic-visit'); const ms = performance.now() - start; return { latency_ms: ms, complete_ms: ms, output: text } }
  } else if (name.startsWith('materials') || name === 'reference_metadata' || name === 'reference_real') {
    const store = await storeFixture(), count = small ? 1 : 20
    await store.transaction('local', async (tx: any) => { for (let i = 0; i < count; i++) await tx.create('local', 'content', { status: 'approved', pages: [{ number: 1, text: '合成审核资料。'.repeat(small ? 4 : 30000) }] }, `d${i}`) })
    const documents = Array.from({ length: count * (name === 'materials_duplicates' ? 5 : 1) }, (_, i) => ({ id: `d${i % count}`, version: 1 }))
    const medical = new Medical(store, { config: {} })
    const products = name === 'reference_real' ? Array.from({ length: small ? 1 : 4 }, (_, i) => ({ id: `p${i}`, name: `药品${i}`, brand: `brand${i}`, compares_with: i ? ['p0'] : [] })) : []
    medical.load = async () => ({ version: 'v', products, sources: [], compiled: {} })
    probe = async () => {
      const busy = name === 'materials_empty' ? store.transaction('local', async () => delay(small ? 0 : 15), false) : undefined
      const start = performance.now()
      const result = name === 'reference_real' ? await medical.reference(user, products[0], '合成审核资料') : name === 'reference_metadata' ? await medical.reference(user, { id: 'none', name: '无匹配药品' }, '需求') : await training.checkMaterials(store, user, name === 'materials_empty' ? undefined : { documents, drugs: [], policies: [] })
      const ms = performance.now() - start; await busy
      return { latency_ms: ms, complete_ms: ms, output: result ?? true }
    }
    iterations = small ? 5 : 2
  } else if (name === 'reference_parallel') {
    const data = { version: 'v', products: Array.from({ length: small ? 1 : 4 }, (_, i) => ({ id: `p${i}`, name: `药品${i}`, brand: `brand${i}`, compares_with: i ? ['p0'] : [] })) }
    const medical = new Medical({ config: { records: folder } }, { config: {} })
    medical.load = async () => data
    medical.evidence = async () => { await delay(small ? 1 : 12); return { data, rows: data.products.map(p => ({ source: { product_ids: [p.id], quality: 'original' }, id: p.id })) } }
    probe = async () => { const start = performance.now(); const result = await medical.reference(user, data.products[0], '需求'); const ms = performance.now() - start; return { latency_ms: ms, complete_ms: ms, output: result } }
  } else if (name === 'retrieve') {
    const docs = Array.from({ length: small ? 1 : 18 }, (_, i) => ({ id: `d${i}`, version: 1, title: '合成资料', pages: Array.from({ length: small ? 1 : 12 }, (_, j) => ({ number: j + 1, text: '研究依据需要核对人群和安全。evidence study '.repeat(small ? 3 : 220) })) }))
    iterations = small ? 20 : 3
    probe = async () => { const start = performance.now(); const result = training.retrieve(docs, '研究 人群 安全 evidence'); const ms = performance.now() - start; return { latency_ms: ms, complete_ms: ms, output: result } }
  } else if (name === 'tts_notify' || name === 'tts_direct') {
    const tts = await server()
    tts.on('connection', ws => ws.on('message', raw => {
      const b = Buffer.from(raw as Buffer), event = b.readUInt32BE(4), id = [1, 2].includes(event) ? '' : b.subarray(12, 12 + b.readUInt32BE(8)).toString()
      const send = (event: number, audio?: Buffer) => { const payload = audio ?? Buffer.from('{}'), identity = Buffer.from(id); ws.send(Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]), u32(event), u32(identity.length), identity, u32(payload.length), payload])) }
      if (event === 1) send(50); if (event === 100) send(150); if (event === 102) { send(352, Buffer.alloc(960)); send(152) }; if (event === 2) send(52)
    }))
    probe = async () => {
      const record = { id: 'session', messages: [{ id: 'd', role: 'doctor', text: '你好' }], usage: [] }, events: string[] = []
      let first = 0; const start = performance.now()
      const dialogue = new Dialogue({ send: async (event: any) => { events.push(event.type); if (event.type === 'audio') first = performance.now() - start; if (name !== 'tts_direct') await delay(small ? 0 : 12) } }, { config: { ...config(), ttsKey: 'synthetic', ttsUrl: `ws://127.0.0.1:${(tts.address() as any).port}` } }, {}, {}, user, record)
      await dialogue.speak('你好', 'd', new AbortController().signal); assert.ok(first)
      return { latency_ms: first, complete_ms: performance.now() - start, output: { events, status: record.messages[0].speech_status } }
    }
  } else if (name === 'asr_first') {
    const asr = await server(), tts = await server(); tts.on('connection', ws => ws.close())
    let received: Buffer[] = []
    asr.on('connection', ws => { received = []; ws.on('message', raw => {
      const b = Buffer.from(raw as Buffer)
      if (b[1] >> 4 !== 2) return
      received.push(gunzipSync(b.subarray(8)))
      const final = !!(b[1] & 2), payload = gzipSync(Buffer.from(JSON.stringify({ code: 20000000, result: { text: '合成识别文字', utterances: [{ text: '合成识别文字', definite: false }] } })))
      ws.send(Buffer.concat([Buffer.from([0x11, final ? 0x92 : 0x90, 0x11, 0]), u32(payload.length), payload]))
    }) })
    const { createApp } = await load('app')
    const runtime = await createApp({ ...config(), asrKey: 'synthetic', ttsKey: 'synthetic', asrUrl: `ws://127.0.0.1:${(asr.address() as any).port}`, ttsUrl: `ws://127.0.0.1:${(tts.address() as any).port}` }, fetcher)
    await runtime.app.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => runtime.app.close())
    probe = async () => {
      const client = await voice.Socket.connect(`ws://127.0.0.1:${(runtime.app.server.address() as any).port}/api/realtime?experience=practice`, { Origin: runtime.store.config.origins[0] })
      await client.send({ type: 'start', mode: 'assisted' })
      while (JSON.parse((await client.read()).toString()).type !== 'ready') {}
      const start = performance.now(); let first = 0
      const reading = (async () => { for (;;) { const event = JSON.parse((await client.read(undefined, 10000)).toString()); if (!first && event.type === 'transcript' && event.role === 'trainee') first = performance.now() - start; if (event.type === 'ended') return } })()
      for (let i = 0; i < 10; i++) { await delay(small ? 0 : 20); await client.send({ type: 'audio', audio: Buffer.alloc(640, i).toString('base64') }) }
      await client.send({ type: 'stop' }); await reading; client.close(); assert.ok(first)
      const bytes = Buffer.concat(received); assert.deepEqual(bytes, Buffer.concat(Array.from({ length: 10 }, (_, i) => Buffer.alloc(640, i))))
      return { latency_ms: first, complete_ms: performance.now() - start, output: bytes.toString('base64') }
    }
  } else throw new Error('Unknown case: ' + name)
  await probe!()
  const timings: number[] = [], complete: number[] = [], outer: number[] = []; let output: unknown
  for (let i = 0; i < samples; i++) {
    global.gc?.(); let sum = 0, tail = 0, outside = 0
    for (let j = 0; j < iterations; j++) { const result = await probe!(); sum += result.latency_ms; tail += result.complete_ms; outside += result.outer_ms ?? result.latency_ms; output = result.output }
    timings.push(sum / iterations); complete.push(tail / iterations); outer.push(outside / iterations)
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  console.log(JSON.stringify({ case: name, small, samples, iterations, elapsed_ms: timings, median_ms: median(timings), complete_ms: complete, outer_ms: outer,
    output_sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'), node: process.version }))
} finally { for (const close of cleanup.reverse()) await close(); await rm(folder, { recursive: true, force: true }) }
