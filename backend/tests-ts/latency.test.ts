import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { Models, generateReply, skill } from '../src/agents.ts'
import { settings, type Doc, uuid } from '../src/core.ts'
import { Dialogue } from '../src/live.ts'
import { checkMaterials } from '../src/training.ts'
import { fixture, modelMock, coach, sse } from './helpers.ts'

const user = { id: 'local', workspace: 'local', role: 'admin' as const, team: '', authenticated: false }
const config = () => ({ ...settings({}), key: 'synthetic-key', search: false })
const deadline = <T>(promise: Promise<T>) => Promise.race([promise, delay(2000).then(() => { throw new Error('Expected event did not arrive') })])

test('model text deltas arrive before the tail is released, while the complete reply remains pending', async () => {
  let release!: () => void, first!: () => void, completed = false
  const tail = new Promise<void>(resolve => { release = resolve }), seen = new Promise<void>(resolve => { first = resolve })
  const models = new Models(config(), async () => new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '{"ok":true}' }, finish_reason: null }] }) + '\n\n'))
    await tail
    controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const agent = models.agent('输出JSON'), unsubscribe = agent.agent.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') first()
  })
  const running = agent.reply('test').then(reply => { completed = true; return reply })
  try {
    await deadline(seen)
    assert.equal(completed, false)
    release()
    const result = await running
    assert.equal(result.text, '{"ok":true}')
    assert.equal(result.usage.total_tokens, 5)
  } finally { release(); await running.catch(() => {}); unsubscribe() }
})

test('streaming responses hold concurrency until consumption or cancellation and abort unread bodies', async () => {
  let calls = 0
  const models = new Models({ ...config(), modelConcurrency: 1 }, async () => {
    calls++
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('prefix')) } }))
  })
  const request: typeof fetch = (models as any).providerFetch
  const abort = new AbortController(), first = await request('https://example.invalid', { signal: abort.signal })
  const second = request('https://example.invalid')
  await delay(10); assert.equal(calls, 1)
  abort.abort(new Error('cancelled by caller'))
  await assert.rejects(first.text(), /cancelled by caller/)
  const next = await deadline(second)
  assert.equal(calls, 2)
  await next.body!.cancel()
  const third = await deadline(request('https://example.invalid'))
  assert.equal(calls, 3)
  await third.body!.cancel()
})

test('a response body error after publication releases its slot without retrying exposed bytes', async () => {
  let calls = 0, source!: ReadableStreamDefaultController<Uint8Array>
  const models = new Models({ ...config(), modelConcurrency: 1 }, async () => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(Buffer.from('prefix')) } }))
  })
  const request: typeof fetch = (models as any).providerFetch
  const response = await request('https://example.invalid'), reader = response.body!.getReader()
  assert.equal(Buffer.from((await reader.read()).value!).toString(), 'prefix')
  source.error(new Error('connection lost'))
  await assert.rejects(reader.read(), /connection lost/)
  assert.equal(calls, 1)
  const next = await deadline(request('https://example.invalid'))
  await next.body!.cancel()
  assert.equal(calls, 2)
})

test('a single model slot serves validated doctor text before a blocked coach and never publishes invalid JSON', async () => {
  let release!: () => void, delivered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), first = new Promise<void>(resolve => { delivered = resolve })
  const controller = new AbortController()
  const models = new Models({ ...config(), modelConcurrency: 1 }, async (_, init) => {
    const doctor = JSON.stringify(JSON.parse(String(init?.body)).messages[0]).includes('本次只扮演医生')
    if (!doctor) await gate
    return sse(doctor ? { doctor_reply: '请确认您的交流目标。' } : { coach })
  })
  const running = generateReply(models, [{ id: 'u', role: 'trainee', text: '请先确认需求。', final: true }], {
    signal: controller.signal, onDoctor: () => { delivered() },
  })
  try { await deadline(first); release(); assert.equal((await running).result.doctor_reply, '请确认您的交流目标。') }
  finally { release(); controller.abort(); await running.catch(() => {}) }
  let invalidPublished = false
  const invalid = new Models(config(), modelMock(body => JSON.stringify(body.messages[0]).includes('本次只扮演医生') ? { doctor_reply: '' } : { coach }))
  await assert.rejects(generateReply(invalid, [], { onDoctor: () => { invalidPublished = true } }))
  assert.equal(invalidPublished, false)
})

function responseFixture(messages: Doc[]) {
  const requests: Doc[] = [], events: Doc[] = []
  const models = new Models(config(), modelMock(body => { requests.push(body); return JSON.stringify(body.messages[0]).includes('本次只扮演医生') ? { doctor_reply: '请确认您的交流目标。' } : { coach } }))
  const record: Doc = { id: uuid(), messages, mode: 'assisted', experience: 'practice', usage: [], medical_checks: [] }
  const store = { config: {}, transaction: async (_: string, callback: any) => callback({ get: async () => ({ training_scoring: false }) }) }
  const medical = { invalidate: async () => {}, validReference: async () => true }
  const dialogue = new Dialogue({ send: async (event: Doc) => { events.push(event) } } as any, store as any, models, medical as any, user, record)
  dialogue.validate = async () => {}; dialogue.checkpoint = async () => {}; dialogue.startSpeech = () => {}
  return { dialogue, record, events, requests }
}

test('live responses preserve the 16-message prompt window and all prior response acknowledgements', async () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, role: i % 2 ? 'trainee' : 'doctor', text: `合成原话${i}`, final: true }))
  const f = responseFixture(messages)
  await f.dialogue.respond(0, 'u99', new AbortController().signal)
  assert.equal(f.events.filter(e => e.type === 'practice_turn').length, 1)
  for (const request of f.requests) {
    const content = request.messages.at(-1).content
    const input = JSON.parse(typeof content === 'string' ? content : content.filter((part: Doc) => part.type === 'text').map((part: Doc) => part.text).join(''))
    assert.equal(input.transcript.length, 16)
    assert.equal(input.transcript[0].id, 'u84')
  }
  assert.equal((f.dialogue as any).responded.size, 50)
  assert.equal(f.record.messages.length, 101)
})

test('parallel preparation still rejects a material change before publishing doctor text', async () => {
  const f = responseFixture([{ id: 'u', role: 'trainee', text: '请确认本次交流需求。', final: true }])
  let validations = 0
  f.dialogue.validate = async () => { if (++validations > 1) throw Object.assign(new Error('资料已变化'), { statusCode: 409 }) }
  await f.dialogue.respond(0, 'u', new AbortController().signal)
  assert.equal(f.events.some(e => e.type === 'practice_turn'), false)
  assert.equal(f.record.messages.length, 1)
  assert.ok(f.events.some(e => e.type === 'notice' && e.message === '资料已变化'))
})

test('material metadata projection keeps original content reads and rejects stale versions and retired content', async () => {
  const f = await fixture()
  try {
    const doc = await f.store.transaction('local', tx => tx.create('local', 'content', { status: 'approved', pages: [{ number: 1, text: '合成原文' }] }))
    const training = { documents: [{ id: doc.id, version: 1 }], drugs: [], policies: [] }
    await checkMaterials(f.store, user, training)
    assert.deepEqual((await f.store.transaction('local', tx => tx.get('local', 'content', doc.id), false))?.pages, doc.pages)
    await assert.rejects(checkMaterials(f.store, user, { ...training, documents: [...training.documents, { id: doc.id, version: 99 }] }), /资料已失效/)
    await f.store.transaction('local', tx => tx.update('local', 'content', doc.id, { ...doc, status: 'retired' }, doc.version))
    await assert.rejects(checkMaterials(f.store, user, training), /资料已失效/)
  } finally { await f.close() }
})

test('skill text refreshes after edits, missing files and recovery', async () => {
  const name = 'latency-test-' + uuid().replace(/[0-9]/g, 'a'), directory = new URL(`../resources/skills/${name}/`, import.meta.url)
  const path = new URL('SKILL.md', directory)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(path, '---\ntitle: test\n---\n第一份内容')
    assert.equal(await skill(name), '第一份内容')
    await writeFile(path, '---\ntitle: changed\n---\n编辑后的第二份内容')
    assert.equal(await skill(name), '编辑后的第二份内容')
    await rm(path)
    await assert.rejects(skill(name))
    await writeFile(path, '恢复后的内容，没有前置信息。')
    assert.equal(await skill(name), '恢复后的内容，没有前置信息。')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
