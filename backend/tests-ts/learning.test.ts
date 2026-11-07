import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './helpers.ts'
import { hashPassword } from '../src/password.ts'
import { canonical, identity, sha, uuid, type Doc, type User } from '../src/core.ts'
import { newRecord } from '../src/store.ts'
import { Pool } from 'pg'
import { prepareTraining, snapshot } from '../src/training.ts'

async function setup() {
  const password = await hashPassword('isolated-learning-test-password')
  const database = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : undefined
  const admin = database ? new Pool({connectionString:database.href}) : undefined
  const dbName = 'learning_' + uuid().replaceAll('-', '')
  if (admin && database) {
    assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname),'Only disposable loopback PostgreSQL is permitted')
    await admin.query(`CREATE DATABASE ${dbName}`); database.pathname = '/' + dbName
  }
  let f: Awaited<ReturnType<typeof fixture>>
  try { f = await fixture({ database: database?.href ?? '', auth: true, users: { learner: password, other: password, trainer: password }, admins: ['trainer'] }) } catch (error) {
    if (admin) { await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await admin.end() }
    throw error
  }
  const users: Record<string, User> = Object.fromEntries(['learner', 'other', 'trainer'].map(id => [id, { id, workspace: f.store.workspace, team: '', authenticated: true, role: id === 'trainer' ? 'admin' : 'representative' }]))
  const cookies: Record<string, string> = {}
  for (const id of Object.keys(users)) {
    const login = await f.call('POST', '/api/auth/login', { username: id, password: 'isolated-learning-test-password' })
    cookies[id] = String(login.headers['set-cookie']).split(';')[0]
  }
  const call = (id: string, method: any, path: string, body?: unknown) => f.call(method, path, body, { cookie: cookies[id] })
  const { scene, variant, rubric } = await f.store.transaction(f.store.workspace, async tx => {
    const doctor = await tx.create(f.store.workspace, 'doctor', { name: '虚构训练医生', specialty: '测试', status: 'published' })
    const rubric = await tx.create(f.store.workspace, 'rubric', { name: '需求确认', status: 'published', calibration_status: 'uncalibrated', dimensions: [{ key: 'needs', label: '需求确认', weight: 100, anchors: ['未观察', '遗漏', '部分', '完成', '清晰完整'], requires_content: false }] })
    const body = { title: '首次拜访', status: 'published', doctor_id: doctor.id, rubric_id: rubric.id, content_ids: [], policy_ids: [], stages: ['needs'], objective: '确认本次交流需求', duration_seconds: 180, situation: 'first_visit', difficulty: 'basic' }
    const scene = await tx.create(f.store.workspace, 'scenario', body)
    const variant = await tx.create(f.store.workspace, 'scenario', { ...body, title: '时间紧张时确认需求', situation: 'time_pressure' })
    return { scene, variant, rubric }
  })
  let tick = 0
  async function record(score: number, options: Doc = {}) {
    const user = users[options.owner ?? 'learner'], target = options.variant ? variant : scene
    const training = snapshot(await prepareTraining(f.store, user, target.id))
    const text = `第${tick}次模拟：您好，我先确认您最希望交流的问题，再约定下一步。`
    const saved: Doc = { ...newRecord(user, options.variant ? 'combat' : 'practice', options.variant ? 'independent' : 'assisted'), training,
      started_at: new Date(Date.UTC(2026, 10, 7, 0, 0, tick++)).toISOString(), capture_status: 'completed', analysis_status: 'completed',
      messages: [{ id: 'u', role: 'trainee', text, final: true }], ...options,
      coaching: [{ based_on: 'u', final_report: true, points: ['先复述关注点，再确认交流目标。'], focus: '需求确认',
        assessment: { status: 'complete', total: score * 25, validation_errors: [], model: 'synthetic', evaluator_version: 'test', rubric_fingerprint: sha(canonical(rubric.dimensions)),
          dimensions: [{ key: 'needs', label: '需求确认', weight: 100, score, reason: '核对原话中的需求确认行为', anchor: rubric.dimensions[0].anchors[score],
            utterances: options.withoutQuote ? [] : [{ message_id: 'u', quote: text }], citations: [] }] } }],
    }
    await f.store.saveRecord(saved, 'completed')
    return saved
  }
  const plan = async (baseline: Doc) => {
    const response = await call(baseline.owner_id, 'POST', `/api/sessions/${baseline.id}/retrain`, {})
    assert.equal(response.statusCode, 201, response.body)
    return response.json()
  }
  const finish = (record: Doc) => identity.run(users[record.owner_id], () => f.sessions.finishRemediation(users[record.owner_id], record))
  return { ...f, users, call, scene, variant, rubric, record, plan, finish, close: async () => {
    try { await f.close() } finally { if (admin) { try { await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`) } finally { await admin.end() } } }
  } }
}

test('practice, transfer and independent trainer review require evidence and never close on a worse score', async () => {
  const f = await setup()
  try {
    const baseline = await f.record(2), plan = await f.plan(baseline)
    const worse = await f.record(1, { remediation_id: plan.id })
    await f.finish(worse)
    assert.equal((await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json().status, 'assigned')
    const ungrounded = await f.record(4, { remediation_id: plan.id, withoutQuote: true })
    await f.finish(ungrounded)
    assert.equal((await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json().status, 'assigned')
    const improved = await f.record(3, { remediation_id: plan.id })
    await f.finish(improved)
    const progress = (await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json()
    assert.equal(progress.status, 'awaiting_verification')
    await f.finish(improved)
    assert.equal((await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json().version, progress.version)
    const next = (await f.call('learner', 'GET', `/api/remediations/${plan.id}/next`)).json()
    assert.equal(next.scenario_id, f.variant.id)
    assert.equal(next.experience, 'combat'); assert.equal(next.mode, 'independent'); assert.equal(next.phase, 'verification')
    const fake = await f.record(4, { remediation_id: plan.id, remediation_phase: 'verification' })
    await assert.rejects(() => f.finish(fake), /另一情境/)
    const verification = await f.record(3, { variant: true, remediation_id: plan.id, remediation_phase: 'verification' })
    await f.finish(verification)
    const awaiting = (await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json()
    assert.equal(awaiting.status, 'awaiting_review')
    assert.equal(awaiting.latest_record_id, improved.id, 'transfer scores must stay out of the same-condition comparison')
    assert.equal((await f.call('learner', 'POST', `/api/admin/remediations/${plan.id}/review`, { version: awaiting.version, decision: 'confirm', reason: '原话中先确认了交流目标。' })).statusCode, 403)
    const approved = await f.call('trainer', 'POST', `/api/admin/remediations/${plan.id}/review`, { version: awaiting.version, decision: 'confirm', reason: '原话先确认交流目标，再约定下一步，体现本次目标行为。', message_id:'u', quote:verification.messages[0].text })
    assert.equal(approved.statusCode, 200, approved.body)
    assert.equal(approved.json().learning_status, 'verified')
    await f.finish(verification)
    assert.equal((await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json().version, approved.json().version)
  } finally { await f.close() }
})

test('stale tasks can be archived or restarted with a fresh baseline, while cross-account access stays forbidden', async () => {
  const f = await setup()
  try {
    const baseline = await f.record(2), plan = await f.plan(baseline)
    const original = await f.store.record(baseline.id)
    await f.store.transaction(f.store.workspace, tx => tx.update(f.store.workspace, 'scenario', f.scene.id, { ...f.scene, objective: '新版本目标' }, f.scene.version))
    assert.equal((await f.call('learner', 'GET', `/api/remediations/${plan.id}/next`)).statusCode, 409)
    assert.equal((await f.call('other', 'POST', `/api/remediations/${plan.id}/restart`, {})).statusCode, 404)
    assert.equal((await f.call('other', 'POST', `/api/remediations/${plan.id}/archive`, {})).statusCode, 404)
    const restarted = await f.call('learner', 'POST', `/api/remediations/${plan.id}/restart`, {})
    assert.equal(restarted.statusCode, 200, restarted.body)
    assert.equal(restarted.json().remediation_id, undefined)
    assert.equal((await f.call('learner', 'GET', '/api/remediations')).json()[0].status, 'archived')
    assert.deepEqual(await f.store.record(baseline.id), original)
    assert.equal((await f.call('learner', 'POST', `/api/remediations/${plan.id}/archive`, {})).statusCode, 200)
  } finally { await f.close() }
})

test('missing alternate scenes leave verification pending and trainer rejection preserves the practice loop', async () => {
  const f = await setup()
  try {
    const baseline = await f.record(3), plan = await f.plan(baseline)
    assert.equal(plan.status, 'awaiting_verification')
    await f.store.transaction(f.store.workspace, tx => tx.update(f.store.workspace, 'scenario', f.variant.id, { ...f.variant, status: 'retired' }, f.variant.version))
    const next = await f.call('learner', 'GET', `/api/remediations/${plan.id}/next`)
    assert.equal(next.statusCode, 409); assert.match(next.json().detail, /另一已发布情境/)
    assert.equal((await f.call('learner', 'GET', `/api/remediations/${plan.id}/progress`)).json().status, 'awaiting_verification')
  } finally { await f.close() }
})

test('a submitted field challenge reaches only its owner and returns only published derived scenes', async () => {
  const f = await setup()
  try {
    const body = { request_id: uuid(), visited_at: '2026-11-07', text: '医生时间紧张，我没有先确认希望讨论的问题。', source: 'self_report', training_challenge: true }
    const response = await f.call('learner', 'POST', '/api/visits', body)
    assert.equal(response.statusCode, 201, response.body)
    const draft = response.json()
    assert.equal((await f.call('learner', 'POST', '/api/visits', body)).json().id, draft.id)
    assert.equal((await f.call('learner', 'POST', '/api/visits', { ...body, text: '不同内容必须通过编辑更新。' })).statusCode, 409)
    assert.equal((await f.call('other', 'GET', '/api/training/challenges')).json().length, 0)
    assert.equal((await f.call('other', 'POST', `/api/visits/${draft.id}/confirm`, { version: draft.version, redacted_text: body.text, redaction_confirmed: true })).statusCode, 404)
    const submitted = (await f.call('learner', 'POST', `/api/visits/${draft.id}/confirm`, { version: draft.version, redacted_text: body.text, redaction_confirmed: true })).json()
    const reviewed = await f.call('trainer', 'POST', `/api/visits/${draft.id}/review`, { version: submitted.version, decision: 'scenario', reason: '该沟通问题适合转为时间紧张情境练习。' })
    assert.equal(reviewed.statusCode, 200, reviewed.body)
    const caseId = reviewed.json().review.case_id
    await f.store.transaction(f.store.workspace, async tx => {
      await tx.create(f.store.workspace, 'scenario', { ...f.scene, title: '已发布的派生训练', status: 'published', generation: { case: { id: caseId } } })
      await tx.create(f.store.workspace, 'scenario', { ...f.scene, title: '草稿不得泄露', status: 'draft', generation: { case: { id: caseId } } })
    })
    const result = (await f.call('learner', 'GET', '/api/training/challenges')).json()[0]
    assert.equal(result.review.decision, 'scenario')
    assert.equal(result.scenarios.length, 1); assert.equal(result.scenarios[0].title, '已发布的派生训练')
  } finally { await f.close() }
})

test('next actions and outcome counts use owned records, deduplicate review visits and distinguish verified learning', async () => {
  const f = await setup()
  try {
    assert.equal((await f.call('learner', 'GET', '/api/training/next')).json().kind, 'baseline')
    const baseline = await f.record(2)
    const next = (await f.call('learner', 'GET', '/api/training/next')).json()
    assert.equal(next.record_id, baseline.id); assert.equal(next.focus, '需求确认')
    for (let i = 0; i < 2; i++) assert.equal((await f.call('learner', 'POST', '/api/training/review-opened', { record_id: baseline.id })).statusCode, 200)
    assert.equal((await f.call('other', 'POST', '/api/training/review-opened', { record_id: baseline.id })).statusCode, 404)
    await f.plan(baseline)
    assert.equal((await f.call('learner', 'GET', '/api/training/next')).json().kind, 'task_pending')
    const outcomes = (await f.call('learner', 'GET', '/api/training/outcomes')).json()
    assert.equal(outcomes.reviewed_records, 1); assert.equal(outcomes.reviewed_then_retrained, 1)
    assert.equal(outcomes.needs_practice, 1); assert.equal(outcomes.verified, 0)
    assert.equal((await f.call('other', 'GET', '/api/training/outcomes')).json().saved_attempts, 0)
  } finally { await f.close() }
})

test('human score corrections determine the next target and a trainer cannot approve their own verification', async () => {
  const f = await setup()
  try {
    const baseline = await f.record(4)
    await f.store.transaction(f.store.workspace, tx => tx.create(f.store.workspace,'review', { record_id:baseline.id, overrides:[{key:'needs',score:1,reason:'培训师认为目标确认仍不足。'}] }))
    const plan = await f.plan(baseline)
    assert.equal(plan.status,'assigned')
    const attempt = await f.record(4,{remediation_id:plan.id})
    await f.store.transaction(f.store.workspace, tx => tx.create(f.store.workspace,'review', { record_id:attempt.id, overrides:[{key:'needs',score:1,reason:'仍需确认具体目标。'}] }))
    await f.finish(attempt)
    assert.equal((await f.call('learner','GET',`/api/remediations/${plan.id}/progress`)).json().status,'assigned')
    const teacherBaseline=await f.record(3,{owner:'trainer'}), ownPlan=await f.plan(teacherBaseline)
    const verification=await f.record(3,{owner:'trainer',variant:true,remediation_id:ownPlan.id,remediation_phase:'verification'})
    await f.finish(verification)
    const current=(await f.call('trainer','GET',`/api/admin/remediations/${ownPlan.id}`)).json()
    const response=await f.call('trainer','POST',`/api/admin/remediations/${ownPlan.id}/review`, {version:current.version,decision:'confirm',reason:'不能自行确认自己的表现。',message_id:'u',quote:verification.messages[0].text})
    assert.equal(response.statusCode,403)
  } finally { await f.close() }
})

test('trainer review rejects invented quotes, stale materials and stale versions, and can request further verification', async () => {
  const f=await setup()
  try {
    const baseline=await f.record(3),plan=await f.plan(baseline)
    const verification=await f.record(3,{variant:true,remediation_id:plan.id,remediation_phase:'verification'})
    await f.finish(verification)
    const current=(await f.call('trainer','GET',`/api/admin/remediations/${plan.id}`)).json()
    const body={version:current.version,decision:'confirm',reason:'核对原话确认本次目标行为。',message_id:'u',quote:verification.messages[0].text}
    assert.equal((await f.call('trainer','POST',`/api/admin/remediations/${plan.id}/review`,{...body,quote:'没有出现在原话中的主张。'})).statusCode,422)
    assert.equal((await f.call('trainer','POST',`/api/admin/remediations/${plan.id}/review`,{...body,version:1})).statusCode,409)
    await f.store.transaction(f.store.workspace,tx=>tx.update(f.store.workspace,'scenario',f.variant.id,{...f.variant,objective:'已更新的目标'},f.variant.version))
    assert.equal((await f.call('trainer','POST',`/api/admin/remediations/${plan.id}/review`,body)).statusCode,409)
    const rejected=await f.call('trainer','POST',`/api/admin/remediations/${plan.id}/review`,{...body,decision:'practice'})
    assert.equal(rejected.statusCode,200,rejected.body)
    assert.equal(rejected.json().status,'awaiting_verification')
    assert.equal(rejected.json().learning_status,'needs_verification')
  } finally { await f.close() }
})

test('unscored, invalid and title-only duplicate scenarios cannot masquerade as learning progress', async () => {
  const f=await setup()
  try {
    const missing=await f.record(2)
    missing.coaching[0].assessment.dimensions=[]
    await f.store.saveRecord(missing,'completed')
    assert.equal((await f.call('learner','GET','/api/training/next')).json().kind,'baseline')
    assert.equal((await f.call('learner','POST',`/api/sessions/${missing.id}/retrain`,{})).statusCode,409)
    const invalid=await f.record(99)
    assert.equal((await f.call('learner','POST',`/api/sessions/${invalid.id}/retrain`,{})).statusCode,409)
    const baseline=await f.record(3),plan=await f.plan(baseline)
    await f.store.transaction(f.store.workspace,async tx=>{
      await tx.update(f.store.workspace,'scenario',f.variant.id,{...f.variant,status:'retired'},f.variant.version)
      await tx.create(f.store.workspace,'scenario',{...f.scene,title:'只改了标题的复制品'})
    })
    assert.equal((await f.call('learner','GET',`/api/remediations/${plan.id}/next`)).statusCode,409)
    const legacy=await f.store.transaction(f.store.workspace,tx=>tx.create(f.store.workspace,'remediation',{owner_id:'learner',parent_record_id:baseline.id,scenario_id:f.scene.id,stage:'full',status:'assigned'}))
    const response=await f.call('learner','GET',`/api/remediations/${legacy.id}/next`)
    assert.equal(response.statusCode,409);assert.match(response.json().detail,/缺少可核对的目标维度/)
  } finally {await f.close()}
})

test('learning metrics show explicit denominators and require a complete second-week observation window', async () => {
  const f=await setup()
  try {
    const today=Math.floor(Date.now()/86400000)*86400000
    await f.record(2,{started_at:new Date(today-20*86400000).toISOString()})
    await f.record(3,{started_at:new Date(today-12*86400000).toISOString()})
    await f.record(2,{owner:'other',started_at:new Date(today-5*86400000).toISOString()})
    const learner=(await f.call('learner','GET','/api/training/outcomes')).json()
    assert.equal(learner.first_saved_users,1);assert.equal(learner.first_saved_valid,1)
    assert.equal(learner.return_eligible,1);assert.equal(learner.returned_second_week,1)
    const other=(await f.call('other','GET','/api/training/outcomes')).json()
    assert.equal(other.return_eligible,0);assert.equal(other.returned_second_week,0)
    const admin=(await f.call('trainer','GET','/api/training/outcomes')).json()
    assert.equal(admin.first_saved_users,2);assert.equal(admin.return_eligible,1)
  } finally {await f.close()}
})
