import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Medical } from '../src/medical.ts'
import { Dialogue } from '../src/live.ts'
import { Models } from '../src/agents.ts'
import { type Doc, settings } from '../src/core.ts'
import { coach, sse } from './helpers.ts'

const user = { id: 'local', workspace: 'local', role: 'admin' as const, team: '', authenticated: false }

test('multi-product references share preparation only within one request and reject revoked receipts', async () => {
  const products = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `药品${i}`, brand: `brand${i}`, compares_with: i ? ['p0'] : [] }))
  const text = '研究说明，安全与人群需要核实。'.repeat(30)
  const sources = products.map((product, i) => ({ id: `s${i}`, url: `https://example.invalid/${i}`, quality: 'original', kind: 'label', product_ids: [product.id], pages: [{ number: 1, text }] }))
  const documents = sources.map((source, i) => ({ id: `d${i}`, title: '合成审核资料', version: 1, version_label: 'v1', status: 'approved', source_url: source.url, pages: source.pages }))
  let reads = 0, loads = 0
  const data = { version: 'v1', products, sources, compiled: {} }
  const medical = new Medical({ config: { records: '/tmp/unused-latency-batch2' }, transaction: async (_: string, callback: any) => { reads++; return callback({ list: async () => documents }) } } as any, {} as any)
  medical.load = async () => { loads++; return data }
  const reference = await medical.reference(user, products[0], '研究安全人群')
  assert.equal(loads, 1)
  assert.equal(reads, 1)
  assert.equal(reference.gaps.length, 0)
  for (const product of products) assert(reference.evidence.some((row: Doc) => row.source.product_ids.includes(product.id)))
  assert.equal(await medical.validReference(user, reference), true)
  assert.equal(reads, 2)
  documents[0].status = 'retired'
  assert.equal(await medical.validReference(user, reference), false)
  const changed = await medical.reference(user, products[0], '研究安全人群')
  assert(changed.gaps.some((row: Doc) => row.product === products[0].name))
  documents[0].status = 'approved'
  data.version = 'v2'
  assert.equal(await medical.validReference(user, reference), false)
  const before = reads
  const none = await medical.reference(user, { id: 'unknown', name: '未知药品' }, '研究')
  assert.equal(reads, before)
  assert.deepEqual(none.evidence, [])
})

test('parallel preflight starts every task but dispatches no model until all validations finish', async () => {
  const started = new Set<string>(), events: Doc[] = []
  let release!: () => void, prepared!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const allStarted = new Promise<void>(resolve => { prepared = resolve })
  const mark = (name: string) => { started.add(name); if (started.size === 4) prepared() }
  const config = { ...settings({}), key: 'synthetic-key', search: false }
  const models = new Models(config, async (_: any, init: any) => {
    calls++
    return sse(JSON.stringify(JSON.parse(init.body).messages[0]).includes('本次只扮演医生') ? { doctor_reply: '请确认需求。' } : { coach })
  })
  const record: Doc = { id: 'preflight', experience: 'practice', mode: 'assisted', messages: [{ id: 'u', role: 'trainee', text: '请确认需求。', final: true }], usage: [], free_context: { drug: { id: 'p', name: '药品' }, doctor: { id: 'd', name: '医生', mood: 'neutral' } } }
  const store = { config, transaction: async (_: string, callback: any) => callback({ get: async () => { mark('scoring'); return { training_scoring: false } } }) }
  const medical = { reference: async () => { mark('reference'); return { version: 'v', evidence: [] } }, validReference: async () => true, invalidate: async () => {} }
  const dialogue = new Dialogue({ send: async (event: Doc) => { events.push(event) } } as any, store as any, models, medical as any, user, record)
  dialogue.checks.snapshot = async () => { mark('checks'); return [] }
  dialogue.validate = async () => { mark('validate'); await gate }
  dialogue.checkpoint = async () => {}
  dialogue.startSpeech = () => {}
  const running = dialogue.respond(0, 'u', new AbortController().signal)
  try {
    await Promise.race([allStarted, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('preflight did not start concurrently')), 2000); timer.unref() })])
    assert.equal(calls, 0)
    assert.equal(events.some(event => event.type === 'practice_turn'), false)
    release()
    await running
    assert.equal(calls, 2)
    assert.equal(events.filter(event => event.type === 'practice_turn').length, 1)
  } finally { release(); await running }
})

test('binary request writers preserve all connection/session headers and ASR flags', async () => {
  const { asrPacket, ttsRequest } = await import('../src/voice-protocol.ts')
  const { gzipSync } = await import('node:zlib')
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  for (const payload of [Buffer.alloc(0), Buffer.from('合成资料'), Buffer.from(Array.from({ length: 6400 }, (_, i) => i * 73))])
    for (const audio of [false, true]) for (const final of [false, true]) {
      const body = gzipSync(payload)
      assert.deepEqual(asrPacket(payload, audio, final), Buffer.concat([Buffer.from([0x11, (audio ? 0x20 : 0x10) | (final ? 2 : 0), audio ? 1 : 0x11, 0]), u32(body.length), body]))
    }
  for (const event of [1, 2, 100, 102, 200]) for (const id of ['', '合成会话', 's'.repeat(256)]) {
    const value = { text: '你好', nested: { number: 12 } }, data = Buffer.from(JSON.stringify(value)), identity = Buffer.from(id)
    const expected = Buffer.concat([Buffer.from('11141000', 'hex'), u32(event), ...([1, 2].includes(event) ? [] : [u32(identity.length), identity]), u32(data.length), data])
    assert.deepEqual(ttsRequest(event, value, id), expected)
  }
})

test('reused privacy patterns stay stateless across safe and blocked searches', async () => {
  const { personalDataKind } = await import('../src/agents.ts')
  const cases: [string, string | undefined][] = [
    ['联系电话13812345678', 'phone'], ['138 1234 5678', 'phone'],
    ['abc@example.com', 'email'], ['住院号A12345', 'record_id'],
    ['患者王明，', 'patient_name'], ['男，45岁', 'demographics'],
    ['The RCT study in 2024', undefined], ['药品安全与患者教育', undefined],
  ]
  for (let i = 0; i < 20; i++) for (const [query, kind] of cases) assert.equal(personalDataKind(query), kind)
})
