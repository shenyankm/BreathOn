import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retrieve } from '../src/training.ts'
import { type Doc } from '../src/core.ts'
import { fixture } from './helpers.ts'
import { Dialogue } from '../src/live.ts'
import { Medical, validateSummary, validateMedical } from '../src/medical.ts'
import { newRecord, privateWrite, trainingFingerprint } from '../src/store.ts'
import { Catalog } from '../src/catalog.ts'
import { join } from 'node:path'
import { decode64, SpeechEvidence } from '../src/voice-protocol.ts'

const user = { id: 'local', workspace: 'local', team: '', role: 'admin' as const, authenticated: false }

// Exhaustive selection is the oracle for the bounded retrieval implementation.
function exhaustive(documents: Doc[], query: string, limit: number) {
  const terms = [...new Set([
    ...(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []),
    ...(query.match(/[\u4e00-\u9fff]+/gu) ?? []).flatMap(text => Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2))),
  ])]
  const rows: Doc[] = []
  for (const doc of documents) for (const page of doc.pages)
    for (let offset = 0; offset < page.text.length; offset += 1100) {
      const text = page.text.slice(offset, offset + 1300)
      rows.push({ doc, page: page.number, text, score: terms.reduce((sum, term) => sum + Math.min(text.toLowerCase().split(term).length - 1, 4), 0) })
    }
  return rows.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id) || a.page - b.page).slice(0, limit)
    .map((row, i) => ({ id: `D${i + 1}`, document_id: row.doc.id, document_version: row.doc.version, title: row.doc.title, version_label: row.doc.version_label, page: row.page, text: row.text, scope: row.doc.scope ?? '', source_url: row.doc.source_url }))
}

test('retrieval retains non-overlapping counts, tie order and all existing limit semantics', () => {
  const documents = Array.from({ length: 12 }, (_, i) => ({ id: `doc-${i % 3}`, title: `资料${i}`, version: 1,
    pages: [{ number: 2, text: ('aa aaaa 原文依据 alpha 安全 ').repeat(180) }, { number: 1, text: '无关材料。'.repeat(450) }] }))
  for (const query of ['aa alpha 原文依据', '不存在', '', '安全安全', 'a'])
    for (const limit of [-2, 0, 1, 2, 10, 1.5, NaN, Infinity])
      assert.deepEqual(retrieve(documents, query, limit), exhaustive(documents, query, limit))
})

test('ASR indexes preserve message identity and persist every acknowledged final transcript', async () => {
  const f = await fixture()
  try {
    const record = newRecord(user, 'combat', 'assisted')
    const original = { id: 'combat-u-0', role: 'trainee', text: '旧原话', final: true, annotation: '保留' }
    record.messages.push(original)
    const dialogue = new Dialogue({ send: async (event: Doc) => {
      if (event.type === 'transcript') {
        const checkpoint = await f.sessions.checkpoint(record.id)
        assert(checkpoint?.messages.some((message: Doc) => message.id === event.id && message.text === event.text))
      }
    } } as any, f.store, f.models, f.medical, user, record)
    dialogue.scheduleChecks = () => {}
    await dialogue.observe({ utterances: [{ text: '修正后的原话', definite: true }, { text: '新增原话', definite: true }] }, false)
    assert.equal(record.messages[0], original)
    assert.equal(original.annotation, '保留')
    const version = record.messages[0]
    await dialogue.observe({ utterances: [{ text: '修正后的原话', definite: true }, { text: '新增原话', definite: true }] }, false)
    assert.equal(record.messages.length, 2)
    assert.equal(record.messages[0], version)
    await assert.rejects(() => dialogue.observe({ utterances: [{ text: '已经接受的内容', definite: true }, { text: 42 }] }, false), (error: any) => error.statusCode === 502)
    assert.equal((await f.sessions.checkpoint(record.id))?.messages[0].text, '已经接受的内容')
  } finally { await f.close() }
})

test('non-authoritative checks do no approval I/O and authoritative checks always revalidate current receipts', async () => {
  const medical = new Medical({ config: { records: '/tmp/unused-medical-performance' } } as any, {} as any)
  const receipt = { document_id: 'doc', document_version: 1, version_label: 'v1', document_sha256: 'digest' }
  let reads = 0
  medical.evidence = async () => { reads++; return { data: { version: 'corpus' }, approvals: new Map([['source:1', receipt]]), rows: [], sources: [] } }
  await medical.invalidate(user, [{ status: 'checking' }, { status: 'insufficient' }, { status: 'unavailable' }])
  assert.equal(reads, 0)
  const check = { status: 'supported', corpus_version: 'corpus', statements: [{ citations: [{ source_id: 'source', page: 1, ...receipt }] }] }
  await medical.invalidate(user, [check])
  assert.equal(reads, 1)
  assert.equal(check.status, 'supported')
  receipt.document_version++
  await medical.invalidate(user, [check])
  assert.equal(reads, 2)
  assert.equal(check.status, 'insufficient')
  assert.deepEqual(check.statements, [])
})

test('medical retrieval preserves duplicate-page matching, receipt precedence, scoring, limits and revocation', async () => {
  const text = '原文依据说明，安全与人群需要核实。'.repeat(130)
  const documents: Doc[] = ['b', 'a'].map(id => ({ id, title: id, version: 2, version_label: 'v2', status: 'approved', source_url: 'https://example.org/shared', pages: [{ number: 1, text: '不匹配的重复页码' }, { number: 1, text }, { number: 2, text }] }))
  documents.push({ ...documents[0], id: 'expired', expires_at: '2000-01-01' })
  const sources = Array.from({ length: 7 }, (_, i) => ({ id: `source-${i}`, url: 'https://example.org/shared', title: `原始资料${i}`, kind: 'label', quality: 'original', product_ids: ['product'], pages: [{ number: 1, text: text.replaceAll('，', '， ') }, { number: 2, text }], trials: [], published_at: '2026-01-01' }))
  const data: Doc = { version: 'corpus', products: [{ id: 'product', name: '合成药品', aliases: [] }], sources,
    compiled: { product: { facts: [{ source_id: 'source-0', page: 1, claim: '原文依据安全人群' }] } } }
  const medical = new Medical({ config: { records: '/tmp/unused-medical-performance' }, transaction: async (_tenant: string, callback: any) => callback({ list: async () => documents }) } as any, {} as any)
  medical.load = async () => data
  const result = await medical.evidence(user, '合成药品 2026 原文依据 安全 人群')
  assert.equal(result.approvals.get('source-0:1')?.document_id, 'a')
  assert.equal(result.rows.length, 12)
  for (const source of sources) assert(result.rows.filter(row => row.source_id === source.id).length <= 4)
  const scored = result.rows.find(row => row.source_id === 'source-0' && row.page === 1)!
  data.compiled = {}
  const plain = await medical.evidence(user, '合成药品 2026 原文依据 安全 人群')
  assert.equal(scored.score - plain.rows.find(row => row.id === scored.id)!.score, 5)
  documents[1].status = 'retired'
  assert.equal((await medical.evidence(user, '')).approvals.get('source-0:1')?.document_id, 'b')
  sources[0].pages[0].text = '原件已经发生变化，不应继续使用旧凭证。'
  const changed = await medical.evidence(user, '')
  assert.equal(changed.approvals.has('source-0:1'), false)
})

test('catalogue summaries omit only pages, retain full details and reflect review changes immediately', async () => {
  const f = await fixture()
  try {
    const catalog = new Catalog(f.store), pages = [{ number: 1, text: '仅用于合成测试的完整原文。'.repeat(500) }]
    let row = (await f.call('POST', '/api/catalog/content', { title: '大资料', version_label: 'v1', scope: '测试', pages })).json()
    assert.equal((await catalog.list(user, 'content')).find(item => item.id === row.id)?.pages, undefined)
    assert.deepEqual((await catalog.get(user, 'content', row.id)).pages, pages)
    const representative = { ...user, role: 'representative' as const, authenticated: true }
    assert.equal((await catalog.list(representative, 'content')).some(item => item.id === row.id), false)
    for (const action of ['submit', 'approve']) row = (await f.call('POST', `/api/catalog/content/${row.id}/review`, { version: row.version, action, reason: '合成审核' })).json()
    assert.equal((await catalog.list(representative, 'content')).find(item => item.id === row.id)?.usable, true)
    await f.call('POST', `/api/catalog/content/${row.id}/review`, { version: row.version, action: 'retire', reason: '撤销审核' })
    assert.equal((await catalog.list(representative, 'content')).some(item => item.id === row.id), false)
    assert.deepEqual((await catalog.get(user, 'content', row.id)).pages, pages)
  } finally { await f.close() }
})

test('reused SQLite statements see fresh rows and preserve rollback and compare-and-swap boundaries', async () => {
  const f = await fixture()
  try {
    const original = await f.store.transaction('local', tx => tx.create('local', 'audience', { name: '原值' }))
    await assert.rejects(() => f.store.transaction('local', async tx => {
      await tx.update('local', 'audience', original.id, { ...original, name: '应回滚' }, original.version)
      throw new Error('rollback')
    }))
    assert.equal((await f.store.transaction('local', tx => tx.require('local', 'audience', original.id), false)).name, '原值')
    const changed = await f.store.transaction('local', tx => tx.update('local', 'audience', original.id, { ...original, name: '已提交' }, original.version))
    await assert.rejects(() => f.store.transaction('local', tx => tx.update('local', 'audience', original.id, original, original.version)))
    assert.equal((await f.store.transaction('local', tx => tx.require('local', 'audience', original.id), false)).version, changed.version)
  } finally { await f.close() }
})

test('bounded record reads retain account filtering, order, malformed-file handling and I/O failures', async () => {
  const f = await fixture()
  try {
    const records: Doc[] = []
    for (let i = 0; i < 20; i++) {
      const record = newRecord(user, 'combat', 'assisted')
      record.owner_id = i % 3 ? 'local' : 'other'
      record.started_at = record.ended_at = new Date(Date.UTC(2026, 10, 6, 0, 0, i)).toISOString()
      await f.store.saveRecord(record, 'interrupted')
      records.push(record)
    }
    const invalid = newRecord(user, 'combat', 'assisted')
    await privateWrite(join(f.config.records, invalid.id + '.json'), '{malformed')
    const expected = records.filter(record => record.owner_id === 'local').reverse().map(record => record.id)
    const owner = { ...user, authenticated: true }
    assert.deepEqual((await f.store.records(owner, null)).map(record => record.id), expected)
    assert.deepEqual((await f.store.records(owner, 3)).map(record => record.id), expected.slice(0, 3))
    const read = f.store.record.bind(f.store)
    f.store.record = async id => {
      if (id === records[0].id) throw Object.assign(new Error('read denied'), { code: 'EACCES' })
      return read(id)
    }
    await assert.rejects(() => f.store.records(owner, null), (error: any) => error.code === 'EACCES')
  } finally { await f.close() }
})

test('training fingerprints detect in-place mutations and ignore only calibration bookkeeping', () => {
  const training: Doc = { scenario: { id: 'scene', version: 1 }, doctor: { id: 'doctor', version: 1 },
    rubric: { id: 'rubric', version: 1, dimensions: [{ key: 'd', weight: 100, anchors: ['0', '1', '2', '3', '4'] }] },
    documents: [], drugs: [], policies: [] }
  const before = trainingFingerprint(training)
  training.rubric.version++; training.rubric.calibration_status = 'calibrated'
  assert.equal(trainingFingerprint(training), before)
  training.rubric.dimensions[0].anchors[2] = '新锚点'
  assert.notEqual(trainingFingerprint(training), before)
})

test('base64 validation retains padding, alphabet and non-string rejection', () => {
  const old = (value: string) => value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  const alphabet = ['A', '/', '+', '=', '\n', '$']
  for (let i = 0; i < 6 ** 4; i++) {
    let index = i, tail = ''
    for (let j = 0; j < 4; j++) { tail += alphabet[index % 6]; index = Math.floor(index / 6) }
    for (const prefix of ['', 'AAAA', 'AA==']) {
      const value = prefix + tail
      if (old(value)) assert.deepEqual(decode64(value), Buffer.from(value, 'base64'))
      else assert.throws(() => decode64(value), (error: any) => error.statusCode === 422)
    }
  }
  for (const invalid of [null, undefined, 42, {}, 'A', 'AAA']) assert.throws(() => decode64(invalid))
  assert.equal(decode64('').length, 0)
})

test('speech statistics retain mute, playback, rounding and clipped-window semantics', () => {
  const speech = new SpeechEvidence()
  speech.frames = Array.from({ length: 1200 }, (_, i) => ({ power: (i % 400) ** 2 / 3, muted: i % 7 === 0, playing: i % 3 === 0 ? true : i % 5 === 0 ? undefined : false }))
  const db = (power: number) => Math.round(100 * Math.log10(Math.max(power, 1) / 32768 ** 2)) / 10
  for (const [start, end] of [[0, 1], [1.5, 87], [0, 24000], [23990, 24199], [45, 367]]) {
    const frames = speech.frames.slice(Math.floor(start / 20), Math.ceil(end / 20)), audible = frames.filter(frame => !frame.muted)
    const expected = audible.length ? { available: true, start_ms: start, end_ms: end, duration_ms: end - start,
      rms_dbfs: db(audible.reduce((sum, frame) => sum + frame.power, 0) / audible.length), peak_frame_dbfs: db(Math.max(...audible.map(frame => frame.power))),
      playback_overlap_ms: frames.filter(frame => frame.playing && !frame.muted).length * 20, playback_observed: frames.some(frame => frame.playing !== undefined), tone_audio_assessed: false } : { available: false }
    assert.deepEqual(speech.describe(start, end), expected)
  }
  for (const [start, end] of [[-1, 40], [0, Infinity], [1, 1], [0, 24201]]) assert.deepEqual(speech.describe(start, end), { available: false })
})

test('summary uses the latest check matching both message id and original text', () => {
  const messages = [{ id: 'u1', role: 'trainee', text: '我会核对原文与人群。', final: true }, { id: 'u2', role: 'trainee', text: '我会明确适用边界。', final: true }]
  const supported = { status: 'supported', citations: [], text: '陈述', correction: '', reason: '支持' }
  const checks = [
    { message_id: 'u1', text: messages[0].text, status: 'supported', statements: [supported] },
    { message_id: 'u1', text: messages[0].text, status: 'contradicted', statements: [{ ...supported, status: 'contradicted', correction: '核对后再回应', citations: [{}] }] },
    { message_id: 'u1', text: '不匹配的迟到版本', status: 'unavailable', statements: [] },
    { message_id: 'u2', text: messages[1].text, status: 'supported', statements: [supported] },
  ]
  const card = validateSummary({}, { messages, capture_status: 'completed' }, 'synthetic', checks)
  assert.equal(card.dimensions[0].score, 50)
  assert.equal(card.dimensions[0].verified_statements, 2)
  assert.equal(card.edits[0].message_id, 'u1')
})

test('medical citations retain strict length, first matching evidence and malformed-quote handling', () => {
  const text = '原始研究结论必须核对适用人群。'
  const chunk = { id: 'e', text, source_id: 'source', page: 1, source: { title: '合成原件标题', quality: 'original' } }
  const raw = { statements: [{ id: 's0', status: 'supported', reason: '依据', correction: '', citations: [{ chunk_id: 'e', quote: text }] }] }
  const evidence = [chunk, { ...chunk, text: '第二个重复id不得覆盖原件', source: { title: 'wrong', quality: 'ocr' } }]
  assert.equal(validateMedical(raw, text, evidence)[0].status, 'supported')
  for (const quote of ['', '过短', '不属于原始材料的足够长的伪造引用', null, '字'.repeat(1001)]) {
    const changed = structuredClone(raw)
    changed.statements[0].citations[0].quote = quote as any
    assert.equal(validateMedical(changed, text, evidence)[0].status, 'insufficient')
  }
  chunk.text = '原件已更新，旧引文必须失效。'
  assert.equal(validateMedical(raw, text, evidence)[0].status, 'insufficient')
})
