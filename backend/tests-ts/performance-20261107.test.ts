import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { normalize, type Doc } from '../src/core.ts'
import { validateAssessment } from '../src/training.ts'
import { Medical } from '../src/medical.ts'
import { asrPacket, SpeechEvidence } from '../src/voice-protocol.ts'

test('normalization preserves non-whitespace and removes every ECMAScript whitespace character', () => {
  const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
  const text = `${whitespace}原文${whitespace.repeat(20)}依\u200b据${whitespace}`
  assert.equal(normalize(text), text.replace(/\s/gu, ''))
  assert.equal(normalize(text), '原文依\u200b据')
})

test('assessment normalization is local, checks every quote and never touches unused malformed history', () => {
  const quote = '必须核对研究原文与适用人群。'
  const history = [{ id: 'u', speaker: 'trainee', final: true, text: quote }, { id: 'unused', speaker: 'trainee', final: true, text: null }]
  const evidence = [{ id: 'D1', text: quote, title: '测试原件' }]
  const dimensions = ['one', 'two'].map(key => ({ key, label: key, weight: 50, requires_content: true, anchors: ['0', '1', '2', '3', '4'] }))
  const training = { rubric: { id: 'r', name: '测试', dimensions }, evidence }
  const raw = { dimensions: dimensions.map(d => ({ key: d.key, score: 4, reason: '合成测试', utterances: [{ message_id: 'u', quote }], citations: [{ source_id: 'D1', quote }] })) }
  assert.equal(validateAssessment(raw, training, history, 'test').total, 100)
  evidence[0].text = '原件已经修改，旧引文不得继续通过。'
  assert.equal(validateAssessment(raw, training, history, 'test').total, null)
  evidence[0].text = quote
  history[0].text = '转录已修改。'
  assert.equal(validateAssessment(raw, training, history, 'test').total, null)
  history[0].text = quote
  raw.dimensions[1].utterances[0].quote = '没有出现的原话'
  assert.equal(validateAssessment(raw, training, history, 'test').total, null)
})

test('medical ranking matches exhaustive stable selection and empty lookups refresh approval receipts', async () => {
  const user = { id: 'local', workspace: 'local', team: '', role: 'admin' as const, authenticated: false }
  const documents: Doc[] = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, title: `资料${i}`, version: 1, status: 'approved',
    pages: Array.from({ length: 10 }, (_, j) => ({ number: j + 1, text: `${'填充。'.repeat(340)}${j % 3 ? 'alpha beta gamma' : 'alpha'} ${'原文。'.repeat(340)}` })) }))
  const medical = new Medical({ config: { records: '/tmp/unused-medical-perf-20261107' }, transaction: async (_: string, callback: any) => callback({ list: async () => documents }) } as any, {} as any)
  medical.load = async () => ({ version: 'test', products: [], sources: [], compiled: {} })
  const expected: Doc[] = []
  for (const doc of documents) for (const page of doc.pages)
    for (let offset = 0; offset < page.text.length; offset += 1000) {
      const text = page.text.slice(Math.max(0, offset - 200), offset + 1200)
      const score = ['alpha', 'beta', 'gamma'].reduce((sum, token) => sum + (normalize(text).toLowerCase().includes(token) ? 1 + token.length / 12 : 0), 0)
      if (score > 3) expected.push({ id: `platform-document-${doc.id}:p${page.number}:${offset}`, score: Math.round(score * 100) / 100, text, source_id: `platform-document-${doc.id}` })
    }
  const per = new Map<string, number>()
  const selected = expected.sort((a, b) => b.score - a.score).filter(row => {
    const count = per.get(row.source_id) ?? 0
    if (count === 4) return false
    per.set(row.source_id, count + 1)
    return true
  }).slice(0, 12)
  const result = await medical.evidence(user, 'alpha,beta,gamma')
  assert.deepEqual(result.rows.map(({ id, score, text, source_id }) => ({ id, score, text, source_id })), selected)
  const blank = await medical.evidence(user, ' \n\t')
  assert.deepEqual(blank.rows, [])
  assert.equal(blank.approvals.size, 50)
  documents[0].status = 'retired'
  assert.equal((await medical.evidence(user, '')).approvals.has('platform-document-d0:1'), false)
})

test('PCM statistics respect signed little-endian samples, unaligned buffers and truncated frames', () => {
  const bytes = Buffer.alloc(641)
  let power = 0
  for (let i = 0; i < 320; i++) {
    const sample = i % 2 ? -32768 + i : 32767 - i
    bytes.writeInt16LE(sample, i * 2 + 1)
    power += sample * sample
  }
  const speech = new SpeechEvidence()
  speech.observe(bytes.subarray(1), true, false)
  assert.deepEqual(speech.frames, [{ power: power / 320, playing: true, muted: false }])
  assert.throws(() => speech.observe(Buffer.alloc(639)), RangeError)
  assert.equal(speech.frames.length, 1)
})

test('ASR packet compression preserves protocol flags, payload sizes and decoded audio', () => {
  for (const size of [0, 640, 6400]) for (const audio of [false, true]) for (const final of [false, true]) {
    const payload = Buffer.alloc(size)
    for (let i = 0; i < size; i++) payload[i] = i * 37 % 256
    const packet = asrPacket(payload, audio, final)
    assert.equal(packet[0], 0x11)
    assert.equal(packet[1], (audio ? 0x20 : 0x10) | (final ? 2 : 0))
    assert.equal(packet[2], audio ? 1 : 0x11)
    assert.equal(packet.readUInt32BE(4), packet.length - 8)
    assert.deepEqual(gunzipSync(packet.subarray(8)), payload)
  }
})
