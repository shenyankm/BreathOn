import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture as baseFixture, modelMock, coach } from './helpers.ts'
import { createApp } from '../src/app.ts'
import { newRecord, privateWrite, trainingFingerprint } from '../src/store.ts'
import { Dialogue } from '../src/live.ts'
import { type Doc, sha, canonical, uuid } from '../src/core.ts'
import { parse } from '../src/validation.ts'
import { prepareTraining, snapshot } from '../src/training.ts'
import { Pool } from 'pg'

async function fixture(options: Doc = {}, fetcher?: typeof fetch) {
  if (!process.env.TEST_DATABASE_URL) return baseFixture(options, fetcher)
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
    name = 'lifecycle_' + uuid().replaceAll('-', ''),
    url = new URL(process.env.TEST_DATABASE_URL)
  try {
    await admin.query(`CREATE DATABASE ${name}`)
    url.pathname = '/' + name
    const f = await baseFixture({ ...options, database: String(url) }, fetcher)
    return { ...f, close: async () => {
      try { await f.close() }
      finally {
        try { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`) }
        finally { await admin.end() }
      }
    } }
  } catch (error) {
    try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) }
    finally { await admin.end() }
    throw error
  }
}

async function publishedTraining(f: Awaited<ReturnType<typeof fixture>>) {
  return f.store.transaction('local', async tx => {
    const doctor = await tx.create('local', 'doctor', { ...parse('platform.models.Doctor', { name: '虚构医生', specialty: '测试', population: '教学', focus: '证据', training_style: '克制', opening: '请说明需求。' }), status: 'published' })
    const rubric = await tx.create('local', 'rubric', { ...parse('platform.models.Rubric', { name: '隔离量表', dimensions: [{ key: 'communication', label: '沟通', weight: 100, anchors: ['未观察', '待改进', '基本完成', '充分完成', '清晰完整'], requires_content: false }] }), status: 'published', calibration_status: 'uncalibrated' })
    const scenario = await tx.create('local', 'scenario', { title: '隔离场景', doctor_id: doctor.id, rubric_id: rubric.id, content_ids: [], policy_ids: [], stages: ['full'], status: 'published', objective: '需求确认', product: '教学', disease: '测试', situation: 'first_visit', background: '测试', opening: '请说明需求。', objections: [], success_criteria: [], duration_seconds: 60, difficulty: 'standard' })
    const sample = await tx.create('local', 'calibration_sample', { rubric_id: rubric.id, rubric_fingerprint: sha(canonical(rubric.dimensions)), scenario_id: scenario.id, stage: 'full', messages: [{ id: 'u', role: 'trainee', text: '您好，我先确认您的需求再核对原文资料。', final: true }], expected_scores: { communication: 3 }, label_type: 'synthetic' })
    return { doctor, rubric, scenario, sample }
  })
}
const calibrationReply = { coach, assessment: { dimensions: [{ key: 'communication', score: 3, reason: '确认需求', utterances: [{ message_id: 'u', quote: '确认您的需求' }], citations: [] }] } }
async function waitFor(done: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await done()) {
    assert(Date.now() < deadline, 'Timed out waiting for lifecycle transition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const user = { id: 'local', workspace: 'local', role: 'admin' as const, team: '', authenticated: false }
const validRecord = () => ({
  ...newRecord(user, 'practice', 'assisted'),
  status: 'completed', capture_status: 'completed', analysis_status: 'completed',
  messages: [{ id: 'u', role: 'trainee', text: '您好，我先确认您的需求再核对原文资料。', final: true }],
  coaching: [{ based_on: 'u', final_report: true, assessment: { total: 75, validation_errors: [], dimensions: [] } }],
})

test('restart archives orphan checkpoints once and preserves already saved complete records', async () => {
  let network = 0
  const f = await fixture({}, async () => { network++; throw new Error('No provider replay') })
  try {
    const orphan = newRecord(user, 'practice', 'assisted')
    orphan.messages.push({ id: 'u', role: 'trainee', text: '重启前已确认的原话。', final: true })
    const dialogue = new Dialogue({ send: async () => {} } as any, f.store, f.models, f.medical, user, orphan)
    await dialogue.checkpoint()
    const complete = validRecord()
    await f.store.saveRecord(complete, 'completed')
    const completeSnapshot = await f.store.record(complete.id)
    await privateWrite(join(f.config.records, 'checkpoints', complete.id + '.json'), JSON.stringify({ ...orphan, id: complete.id }))
    await f.app.close()
    const restarted = await createApp(f.config, async () => { network++; throw new Error('No provider replay') })
    await restarted.app.ready()
    try {
      const recovered = await restarted.store.record(orphan.id)
      assert.equal(recovered?.status, 'interrupted')
      assert.equal(recovered?.analysis_status, 'interrupted')
      assert.equal(recovered?.messages[0].text, orphan.messages[0].text)
      assert(recovered?.ended_at)
      assert.deepEqual(await restarted.store.record(complete.id), completeSnapshot)
      const before = recovered!.ended_at
      await restarted.sessions.recover(true)
      assert.equal((await restarted.store.record(orphan.id))?.ended_at, before)
      assert.equal(await restarted.sessions.checkpoint(orphan.id), null)
      assert.equal(network, 0)
    } finally { await restarted.app.close() }
  } finally { await f.close() }
})

test('checkpoint recovery keeps its durable copy on storage failure and rejects active or foreign sessions', async () => {
  const f = await fixture()
  try {
    const record = newRecord(user, 'practice', 'assisted')
    record.messages.push({ id: 'u', role: 'trainee', text: '存储故障后仍应保留。', final: true })
    const path = join(f.config.records, 'checkpoints', record.id + '.json')
    await privateWrite(path, JSON.stringify(record))
    const save = f.store.saveRecord.bind(f.store)
    f.store.saveRecord = async () => { throw new Error('Storage down') }
    await f.sessions.recover()
    assert.equal((JSON.parse(await readFile(path, 'utf8'))).messages[0].text, record.messages[0].text)
    assert.equal(await f.store.record(record.id), null)
    f.store.saveRecord = save
    ;(f.sessions as any).active.set(record.id, {})
    assert.equal((await f.call('POST', `/api/sessions/${record.id}/retry-save`)).statusCode, 409)
    await f.sessions.recover()
    assert.equal(await f.store.record(record.id), null)
    ;(f.sessions as any).active.delete(record.id)
    const foreign = { ...record, owner_id: 'another-user' }
    await privateWrite(path, JSON.stringify(foreign))
    assert.equal((await f.call('POST', `/api/sessions/${record.id}/retry-save`)).statusCode, 404)
    await privateWrite(path, JSON.stringify(record))
    const retry = await f.call('POST', `/api/sessions/${record.id}/retry-save`)
    assert.equal(retry.statusCode, 200, retry.body)
    assert.equal((await f.store.record(record.id))?.status, 'interrupted')
    assert.equal(await f.sessions.checkpoint(record.id), null)
  } finally { await f.close() }
})

test('a concurrent import wins over orphan checkpoint recovery', async () => {
  const f = await fixture()
  try {
    const complete = validRecord()
    await privateWrite(join(f.config.records, 'checkpoints', complete.id + '.json'), JSON.stringify({ ...complete, ended_at: null, status: 'interrupted', coaching: [], messages: [] }))
    const read = f.store.record.bind(f.store), save = f.store.saveRecord.bind(f.store)
    let interleaved = false
    f.store.record = async id => {
      const found = await read(id)
      if (id === complete.id && !found && !interleaved) {
        interleaved = true
        await save(complete, 'completed')
        return null
      }
      return found
    }
    const retry = await f.call('POST', `/api/sessions/${complete.id}/retry-save`)
    assert.equal(retry.statusCode, 200, retry.body)
    assert(interleaved)
    assert.equal((await read(complete.id))?.status, 'completed')
    assert.deepEqual((await read(complete.id))?.coaching, complete.coaching)
    assert.deepEqual((await read(complete.id))?.messages, complete.messages)
    assert.equal(await f.sessions.checkpoint(complete.id), null)
  } finally { await f.close() }
})

test('saved records reconcile retraining after a transient failure without changing a completed plan again', async () => {
  const f = await fixture()
  try {
    const plan = await f.store.transaction('local', tx => tx.create('local', 'remediation', { owner_id: 'local', status: 'assigned' }))
    const record: Doc = { ...validRecord(), remediation_id: plan.id }
    await f.store.saveRecord(record, 'completed')
    const original = f.sessions.finishRemediation.bind(f.sessions)
    f.sessions.finishRemediation = async () => { throw new Error('Transient transaction failure') }
    await f.sessions.recover(true)
    assert.equal((await f.store.transaction('local', tx => tx.require('local', 'remediation', plan.id), false)).status, 'assigned')
    f.sessions.finishRemediation = original
    await f.sessions.recover()
    const complete = await f.store.transaction('local', tx => tx.require('local', 'remediation', plan.id), false)
    assert.equal(complete.status, 'completed')
    assert.equal(complete.completed_record_id, record.id)
    const retry = await f.call('POST', `/api/sessions/${record.id}/retry-save`)
    assert.equal(retry.statusCode, 200, retry.body)
    assert.equal((await f.store.transaction('local', tx => tx.require('local', 'remediation', plan.id), false)).version, complete.version)
    const later = { ...record, id: newRecord(user, 'practice', 'assisted').id }
    await f.sessions.finishRemediation(user, later)
    assert.equal((await f.store.transaction('local', tx => tx.require('local', 'remediation', plan.id), false)).completed_record_id, record.id)
  } finally { await f.close() }
})

test('finalization retains a recovery handoff when saving succeeds but its follow-up fails', async () => {
  const f = await fixture()
  try {
    const record = newRecord(user, 'practice', 'assisted'), events: Doc[] = []
    const original = f.sessions.finishRemediation.bind(f.sessions)
    f.sessions.finishRemediation = async () => { throw new Error('Follow-up unavailable') }
    await f.sessions.run({
      ws: { readyState: 1 }, read: async () => { throw new Error('Disconnected') },
      send: async (event: Doc) => { events.push(event) }, close: () => {},
    } as any, { user } as any, record, undefined, new AbortController().signal)
    assert.equal(events.find(event => event.type === 'ended')?.saved, true)
    assert.equal((await f.sessions.checkpoint(record.id, 'recovery'))?.id, record.id)
    const ended = (await f.store.record(record.id))!.ended_at
    f.sessions.finishRemediation = original
    await f.sessions.recover()
    assert.equal(await f.sessions.checkpoint(record.id, 'recovery'), null)
    assert.equal((await f.store.record(record.id))?.ended_at, ended)
  } finally { await f.close() }
})

test('a live calibration survives an expired lease and prevents overlapping runs', async () => {
  let release!: () => void, entered = false, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ key: 'synthetic', search: false, repeats: 2 }, modelMock(async () => {
    calls++; entered = true; await gate; return calibrationReply
  }))
  try {
    const { rubric } = await publishedTraining(f)
    const start = await f.call('POST', `/api/rubrics/${rubric.id}/calibration`, { version: rubric.version })
    assert.equal(start.statusCode, 202, start.body)
    const run = start.json()
    await waitFor(() => entered)
    await f.store.transaction('local', async tx => {
      const row = await tx.require('local', 'calibration_run', run.id)
      await tx.update('local', 'calibration_run', row.id, { ...row, lease_until: new Date(0).toISOString() }, row.version)
    })
    assert.equal((await f.call('GET', `/api/calibration/runs/${run.id}`)).json().status, 'running')
    assert.equal((await f.call('GET', `/api/rubrics/${rubric.id}/calibration/runs`)).json()[0].status, 'running')
    assert.equal((await f.call('POST', `/api/rubrics/${rubric.id}/calibration`, { version: rubric.version })).statusCode, 409)
    release()
    await waitFor(() => !f.tasks.active(run.id))
    const complete = (await f.call('GET', `/api/calibration/runs/${run.id}`)).json()
    assert.equal(complete.status, 'completed', JSON.stringify(complete))
    assert.equal(complete.completed_count, 1)
    assert.equal(calls, 3)
    assert.equal((await f.call('POST', `/api/calibration/runs/${run.id}/cancel`)).json().version, complete.version)
  } finally { release(); await f.close() }
})

test('calibration restart, list and cancellation settle orphan tasks without replaying models', async () => {
  const f = await fixture()
  try {
    const { rubric } = await publishedTraining(f)
    const createRun = (status: string, lease = Date.now() + 120000) => f.store.transaction('local', tx => tx.create('local', 'calibration_run', { rubric_id: rubric.id, status, lease_until: new Date(lease).toISOString(), samples: [], results: [{ sample_id: 'retained' }], completed_count: 1 }))
    const running = await createRun('running'), cancelling = await createRun('cancel_requested'), completed = await createRun('completed')
    await f.app.close()
    const restarted = await createApp(f.config, async () => { throw new Error('Do not replay provider calls') })
    await restarted.app.ready()
    try {
      assert.equal((await restarted.store.transaction('local', tx => tx.require('local', 'calibration_run', running.id), false)).status, 'interrupted')
      const cancelled = await restarted.store.transaction('local', tx => tx.require('local', 'calibration_run', cancelling.id), false)
      assert.equal(cancelled.status, 'cancelled')
      assert(cancelled.finished_at)
      assert.equal(cancelled.completed_count, 1)
      assert.deepEqual(cancelled.results, cancelling.results)
      assert.equal((await restarted.store.transaction('local', tx => tx.require('local', 'calibration_run', completed.id), false)).version, completed.version)
    } finally { await restarted.app.close() }
    const live = await createApp(f.config)
    await live.app.ready()
    try {
      const orphan = await live.store.transaction('local', tx => tx.create('local', 'calibration_run', { rubric_id: rubric.id, status: 'running', lease_until: new Date(0).toISOString(), samples: [] }))
      const list = (await live.app.inject(`/api/rubrics/${rubric.id}/calibration/runs`)).json().find((r: Doc) => r.id === orphan.id)
      const detail = (await live.app.inject(`/api/calibration/runs/${orphan.id}`)).json()
      assert.equal(list.status, 'interrupted')
      assert.equal(list.version, detail.version)
      const noWorker = await live.store.transaction('local', tx => tx.create('local', 'calibration_run', { rubric_id: rubric.id, status: 'running', lease_until: new Date(Date.now() + 120000).toISOString(), samples: [] }))
      const cancel = await live.app.inject({ method: 'POST', url: `/api/calibration/runs/${noWorker.id}/cancel`, headers: { Origin: f.config.origins[0] } })
      assert.equal(cancel.json().status, 'cancelled')
      assert(cancel.json().finished_at)
    } finally { await live.app.close() }
  } finally { await f.close() }
})

test('cancelling an active calibration preserves its terminal state and does not publish late results', async () => {
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ key: 'synthetic', search: false }, modelMock(async () => {
    entered = true; await gate; return calibrationReply
  }))
  try {
    const { rubric } = await publishedTraining(f)
    const run = (await f.call('POST', `/api/rubrics/${rubric.id}/calibration`, { version: rubric.version })).json()
    await waitFor(() => entered)
    const cancelling = f.call('POST', `/api/calibration/runs/${run.id}/cancel`)
    await waitFor(async () => (await f.store.transaction('local', tx => tx.require('local', 'calibration_run', run.id), false)).status === 'cancel_requested')
    release()
    const cancelled = (await cancelling).json()
    assert.equal(cancelled.status, 'cancelled')
    assert(cancelled.finished_at)
    assert.equal((await f.store.transaction('local', tx => tx.require('local', 'rubric', rubric.id), false)).calibration_run_id, undefined)
    assert.equal((await f.call('GET', `/api/calibration/runs/${run.id}`)).json().version, cancelled.version)
  } finally { release(); await f.close() }
})

test('speech retry runs independently of pending coaching and explicitly acknowledges rejected retries', async () => {
  const f = await fixture()
  try {
    const events: Doc[] = [], record = newRecord(user, 'practice', 'assisted')
    record.messages.push({ id: 'doctor', role: 'doctor', text: '请说明您的问题。', final: true })
    const dialogue = new Dialogue({ send: async (event: Doc) => { events.push(event) } } as any, f.store, f.models, f.medical, user, record)
    let spoken = 0
    dialogue.speak = async () => { spoken++; await dialogue.send({ type: 'tts_state', state: 'speaking' }) }
    ;(dialogue as any).pending = { controller: new AbortController(), promise: Promise.resolve() }
    ;(dialogue as any).voiceFailed = true
    await dialogue.retrySpeech()
    assert.equal(events[0].type, 'retry_speech_result')
    assert.equal(events[0].accepted, true)
    assert.equal(events[1].state, 'speaking')
    assert.equal(spoken, 1)
    await dialogue.retrySpeech()
    assert.equal(events.at(-1)?.accepted, false)
    assert.equal(spoken, 1)
    await dialogue.close()
    ;(dialogue as any).voiceFailed = true
    await dialogue.retrySpeech()
    assert.equal(events.at(-1)?.accepted, false)
    assert.equal(spoken, 1)
  } finally { await f.close() }
})

test('retraining uses the same material fingerprint in HTTP, WebSocket and progress comparisons', async () => {
  const f = await fixture()
  try {
    const { scenario, rubric } = await publishedTraining(f)
    const drug = await f.store.transaction('local', tx => tx.create('local', 'drug', { name: '合成药品', status: 'published', practice_departments: ['测试'] }))
    await f.store.transaction('local', tx => tx.update('local', 'scenario', scenario.id, { ...scenario, drug_id: drug.id }, scenario.version))
    const baseline: Doc = { ...validRecord(), training: snapshot(await prepareTraining(f.store, user, scenario.id)) }
    baseline.coaching[0].assessment = { ...baseline.coaching[0].assessment, rubric_fingerprint: sha(canonical(rubric.dimensions)), model: f.config.model, evaluator_version: 'test' }
    await f.store.saveRecord(baseline, 'completed')
    const planResponse = await f.call('POST', `/api/sessions/${baseline.id}/retrain`, {})
    assert.equal(planResponse.statusCode, 201, planResponse.body)
    const plan = planResponse.json()
    const wsValidation = async () => {
      const events: Doc[] = []
      await f.sessions.begin({ send: async (event: Doc) => { events.push(event) }, ws: { close: () => {} } } as any,
        { user, headers: { origin: f.config.origins[0] }, query: { experience: 'practice', remediation_id: plan.id } } as any)
      return events[0].code
    }
    await f.store.transaction('local', tx => tx.update('local', 'rubric', rubric.id, { ...rubric, calibration_status: 'calibrated', calibrated_model: f.config.model }, rubric.version))
    assert.equal((await f.call('GET', `/api/remediations/${plan.id}/next`)).statusCode, 200)
    assert.equal(await wsValidation(), 'not_configured')
    assert.equal((await f.call('POST', `/api/sessions/${baseline.id}/retrain`, {})).statusCode, 201)
    const child: Doc = { ...baseline, id: newRecord(user, 'practice', 'assisted').id, remediation_id: plan.id,
      training: snapshot(await prepareTraining(f.store, user, scenario.id)), messages: [{ id: 'u', role: 'trainee', text: '我会确认问题并进一步核对研究原文与适用范围。', final: true }] }
    await f.store.saveRecord(child, 'completed')
    assert.equal((await f.call('GET', `/api/remediations/${plan.id}/progress`)).json().comparable, true)
    await f.store.transaction('local', tx => tx.update('local', 'drug', drug.id, { ...drug, brand: '修订版本' }, drug.version))
    assert.equal((await f.call('GET', `/api/remediations/${plan.id}/next`)).statusCode, 409)
    assert.equal(await wsValidation(), 'invalid_scenario')
    assert.equal((await f.call('POST', `/api/sessions/${baseline.id}/retrain`, {})).statusCode, 409)
    child.training = snapshot(await prepareTraining(f.store, user, scenario.id))
    await f.store.saveRecord(child, 'completed')
    assert.equal((await f.call('GET', `/api/remediations/${plan.id}/progress`)).json().comparable, false)
    for (const key of ['policies', 'documents', 'rubric']) {
      const changed = structuredClone(baseline.training)
      if (key === 'rubric') changed.rubric.dimensions[0].anchors[3] = '变化的锚点'
      else changed[key].push(key === 'policies' ? { id: 'policy', version: 2 } : { id: 'document', version: 2, sha256: 'changed' })
      assert.notEqual(trainingFingerprint(changed), trainingFingerprint(baseline.training), key)
    }
    assert.equal(trainingFingerprint({ ...baseline.training, rubric: null }), null)
  } finally { await f.close() }
})
