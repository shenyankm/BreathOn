import type { FastifyInstance } from 'fastify'
import { assert, canonical, HttpError, identity, normalize, now, sha, type Doc, type User } from './core.ts'
import { activity, Store, trainingFingerprint } from './store.ts'
import { prepareTraining, snapshot } from './training.ts'
import { route } from './http.ts'

export const finalCoach = (record: Doc) => {
  const coach = (record.coaching ?? []).findLast((row: Doc) => row.final_report) ?? {}
  return coach.superseded || coach.degraded ? {} : coach
}
const contextOf = (training: Doc) => canonical([training.doctor?.id, training.scenario?.situation ?? 'first_visit',
  training.scenario?.background ?? '', training.scenario?.objections ?? [], training.scenario?.difficulty ?? ''])
export function reviewedDimensions(record: Doc, reviews: Doc[]) {
  const dimensions: Doc[] = (finalCoach(record).assessment?.dimensions ?? []).map((dimension: Doc) => ({ ...dimension }))
  const byKey = new Map<string, Doc>()
  for (const dimension of dimensions) if (!byKey.has(dimension.key)) byKey.set(dimension.key, dimension)
  for (const review of [...reviews].reverse()) for (const change of review.overrides ?? []) {
    const dimension = byKey.get(change.key)
    if (dimension) { dimension.score = change.score; dimension.reason = change.reason }
  }
  return dimensions
}
export function observedTarget(record: Doc, key: string): boolean {
  const dimension = finalCoach(record).assessment?.dimensions?.find((row: Doc) => row.key === key)
  return activity(record).valid && Number.isInteger(dimension?.score) && dimension.score >= 3 && dimension.score <= 4 &&
    (dimension.utterances ?? []).some((quote: Doc) => {
      if (typeof quote.quote !== 'string') return false
      const text = normalize(quote.quote)
      return text.length >= 6 && record.messages.some((message: Doc) => message.id === quote.message_id &&
        message.role === 'trainee' && message.final && normalize(message.text).includes(text))
    })
}

export async function prepareRemediation(store: Store, user: User, id: string, requested?: string) {
  const plan = await store.transaction(user.workspace, tx => tx.require(user.workspace, 'remediation', id), false)
  assert(['assigned', 'awaiting_verification'].includes(plan.status), 409, '本任务暂不可启动，请查看复盘中的当前状态。')
  const baseline = await store.ownRecord(user, plan.parent_record_id)
  const current = await prepareTraining(store, user, plan.scenario_id, plan.stage)
  assert(typeof plan.focus_key === 'string' && current.rubric.dimensions.some((dimension: Doc) => dimension.key === plan.focus_key),
    409, '旧任务缺少可核对的目标维度，请按当前版本重新练习并建立新基线。')
  current.practice_instruction = plan.note ?? ''
  current.focus_dimensions = plan.focus_key ? [plan.focus_key] : []
  assert(trainingFingerprint(baseline.training) && trainingFingerprint(baseline.training) === trainingFingerprint(snapshot(current)),
    409, '医生、场景或资料版本已变化，请归档旧任务，或按新版本练习并建立新基线。')
  if (plan.status === 'assigned') return { plan, training: current, phase: 'practice',
    choice: { scenario_id: plan.scenario_id, stage: plan.stage, remediation_id: plan.id,
      experience: baseline.experience === 'combat' ? 'combat' : 'practice', mode: baseline.mode === 'independent' ? 'independent' : 'assisted' } }
  const scenes = await store.transaction(user.workspace, tx => tx.list(user.workspace, 'scenario'), false)
  for (const scene of scenes.filter(row => row.status === 'published' && row.id !== plan.scenario_id &&
    row.rubric_id === current.rubric.id && (!requested || row.id === requested)).sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      const training = await prepareTraining(store, user, scene.id, plan.stage)
      training.practice_instruction = plan.note ?? ''
      training.focus_dimensions = plan.focus_key ? [plan.focus_key] : []
      assert(contextOf(training) !== contextOf(baseline.training), 409, '需使用不同医生、情境或约束，不能只更换场景名称。')
      assert(sha(canonical(training.rubric.dimensions)) === sha(canonical(baseline.training.rubric.dimensions)), 409, '量表不同。')
      return { plan, training, phase: 'verification', choice: { scenario_id: scene.id, stage: plan.stage,
        remediation_id: plan.id, experience: 'combat', mode: 'independent' } }
    } catch (error) {
      if (!(error instanceof HttpError) || ![404, 409].includes(error.statusCode)) throw error
    }
  }
  throw new HttpError(409, '暂无相同量表和环节的另一已发布情境，请联系培训师补充；也可先归档此任务。')
}

export async function finishLearning(store: Store, user: User, record: Doc) {
  if (!record.remediation_id || !activity(record).valid) return
  await store.transaction(user.workspace, async tx => {
    const plan = await tx.require(user.workspace, 'remediation', record.remediation_id)
    assert(record.workspace === user.workspace && plan.owner_id === user.id && record.owner_id === user.id, 404, '重练记录不属于当前账号。')
    if (plan.last_record_id === record.id || !['assigned', 'awaiting_verification'].includes(plan.status)) return
    const verification = record.remediation_phase === 'verification'
    if (plan.status !== (verification ? 'awaiting_verification' : 'assigned')) return
    const stamp = record.ended_at ?? record.started_at
    if (plan.last_record_at && stamp <= plan.last_record_at) return
    const baseline = await store.ownRecord(user, plan.parent_record_id)
    if (verification) {
      assert(plan.status === 'awaiting_verification' && record.experience === 'combat' && record.mode === 'independent' &&
        record.training?.scenario.id !== plan.scenario_id && record.training?.rubric.id === baseline.training?.rubric.id &&
        contextOf(record.training) !== contextOf(baseline.training) &&
        canonical(record.training?.rubric.dimensions) === canonical(baseline.training?.rubric.dimensions) && record.training?.stage === plan.stage,
      409, '迁移验证必须使用同量表、同环节的另一情境，并关闭实时辅助。')
    } else {
      assert(plan.status === 'assigned' && trainingFingerprint(record.training) &&
        trainingFingerprint(record.training) === trainingFingerprint(baseline.training) && record.training.stage === plan.stage,
      409, '练习条件已变化，不能推进旧任务。')
    }
    const reviews = (await tx.list(user.workspace, 'review')).filter(row => row.record_id === record.id)
    const target = reviewedDimensions(record, reviews).find(row => row.key === plan.focus_key)
    const observed = target?.score >= 3 && observedTarget(record, plan.focus_key)
    await tx.update(user.workspace, 'remediation', plan.id, { ...plan, last_record_id: record.id, last_record_at: stamp,
      status: observed ? verification ? 'awaiting_review' : 'awaiting_verification' : plan.status,
      learning_status: observed ? verification ? 'awaiting_review' : 'needs_verification' : verification ? 'needs_verification' : 'needs_practice',
      ...(verification ? { verification_record_id: record.id } : { practice_record_id: record.id }),
    }, plan.version)
  })
}

async function adminPlan(store: Store, user: User, id: string) {
  assert(user.role === 'admin', 403, '仅培训管理人员可复核。')
  return store.transaction(user.workspace, async tx => {
    const found = (await tx.all('remediation')).find(row => row.tenant === user.workspace && row.item.id === id)?.item
    assert(found, 404, '任务不存在。')
    await tx.audit(user, 'learning.read', 'remediation', id)
    return found
  })
}

export function registerLearning(app: FastifyInstance, store: Store) {
  route(app, 'POST', '/api/remediations/{item_id}/archive', undefined, (user, p) =>
    store.transaction(user.workspace, async tx => {
      const plan = await tx.require(user.workspace, 'remediation', p.item_id)
      assert(plan.owner_id === user.id, 404, '任务不存在。')
      if (plan.status === 'archived') return plan
      assert(plan.status !== 'completed', 409, '已复核的历史任务无需归档。')
      const result = await tx.update(user.workspace, 'remediation', plan.id, { ...plan, status: 'archived', archived_at: now() }, plan.version)
      await tx.audit(user, 'learning.archive', 'remediation', plan.id)
      return result
    }))
  route(app, 'POST', '/api/remediations/{item_id}/restart', undefined, async (user, p) => {
    const plan = await store.transaction(user.workspace, tx => tx.require(user.workspace, 'remediation', p.item_id), false)
    const baseline = await store.ownRecord(user, plan.parent_record_id)
    assert(plan.owner_id === user.id && plan.status !== 'completed', 409, '本任务不能重新建立基线。')
    await prepareTraining(store, user, plan.scenario_id, plan.stage)
    await store.transaction(user.workspace, async tx => {
      await tx.update(user.workspace, 'remediation', plan.id, { ...plan, status: 'archived', archived_at: now() }, plan.version)
      await tx.audit(user, 'learning.restart', 'remediation', plan.id)
    })
    return { scenario_id: plan.scenario_id, stage: plan.stage, experience: baseline.experience, mode: baseline.mode }
  })
  route(app, 'GET', '/api/admin/remediations/{item_id}', undefined, (user, p) => adminPlan(store, user, p.item_id))
  route(app, 'POST', '/api/admin/remediations/{item_id}/review', undefined, async (user, p, body) => {
    assert(body && ['confirm', 'practice'].includes(body.decision) && typeof body.reason === 'string' &&
      body.reason.trim().length >= 6 && body.reason.length <= 1000 && Number.isInteger(body.version) && body.version >= 1 &&
      typeof body.message_id === 'string' && body.message_id.length <= 80 && typeof body.quote === 'string' &&
      normalize(body.quote).length >= 6 && body.quote.length <= 600, 422, '请填写至少六字的原话观察与复核理由。')
    const plan = await adminPlan(store, user, p.item_id)
    assert(plan.owner_id !== user.id, 403, '不能复核自己的学习表现。')
    assert(plan.status === 'awaiting_review' && plan.verification_record_id, 409, '请先完成另一情境下的无提示验证。')
    const record = await store.record(plan.verification_record_id)
    assert(record && record.workspace === user.workspace && record.owner_id === plan.owner_id &&
      record.remediation_id === plan.id && record.remediation_phase === 'verification' &&
      record.experience === 'combat' && record.mode === 'independent' && observedTarget(record, plan.focus_key),
    409, '尚无可核对的无提示目标行为原话。')
    assert(record.messages.some((message: Doc) => message.id === body.message_id && message.role === 'trainee' && message.final &&
      normalize(message.text).includes(normalize(body.quote))), 422, '复核引用须来自本次验证的完整学员原话。')
    if (body.decision === 'confirm') {
      const current = await prepareTraining(store, user, record.training.scenario.id, record.training.stage)
      assert(trainingFingerprint(snapshot(current)) === trainingFingerprint(record.training), 409, '验证资料已变化，请重新建立有效基线。')
    }
    return store.transaction(user.workspace, async tx => {
      const result = await identity.run({ ...user, id: plan.owner_id }, () => tx.update(user.workspace, 'remediation', plan.id, { ...plan,
        status: body.decision === 'confirm' ? 'completed' : 'awaiting_verification',
        learning_status: body.decision === 'confirm' ? 'verified' : 'needs_verification',
        learning_review: { actor: user.id, reason: body.reason.trim(), decision: body.decision, time: now(), record_id: record.id, message_id: body.message_id, quote: body.quote },
      }, body.version))
      await tx.audit(user, 'learning.review', 'remediation', plan.id, { record_id: record.id })
      return result
    })
  })
  route(app, 'GET', '/api/training/next', undefined, async user => {
    const pending = await store.transaction(user.workspace, tx => tx.list(user.workspace, 'remediation'), false)
    if (pending.some(plan => ['assigned', 'awaiting_verification', 'awaiting_review'].includes(plan.status))) return { kind: 'task_pending' }
    const records = (await store.records(user, null)).filter(record => !record.validation_only)
    const latest = records.find(record => record.training && activity(record).valid)
    if (latest) {
      try {
        const current = await prepareTraining(store, user, latest.training.scenario.id, latest.training.stage)
        if (trainingFingerprint(snapshot(current)) !== trainingFingerprint(latest.training))
          return { kind: 'baseline', focus: '按当前版本建立新基线', action: '旧训练条件已经变化。请从下方选择当前有效场景，新的结果单独记录。' }
      } catch (error) {
        if (!(error instanceof HttpError) || ![404, 409].includes(error.statusCode)) throw error
        return { kind: 'baseline', focus: '重新选择有效训练', action: '上次场景已经失效。请从下方选择当前有效场景。' }
      }
      const reviews = await store.transaction(user.workspace, async tx => (await tx.list(user.workspace, 'review')).filter(row => row.record_id === latest.id), false)
      const dimensions = reviewedDimensions(latest, reviews)
      const focus = dimensions.filter((row: Doc) => Number.isInteger(row.score) && row.score >= 0 && row.score <= 4).sort((a: Doc, b: Doc) => a.score - b.score)[0]
      if (!focus) return { kind: 'baseline', focus: '完成一次可观察的场景练习', action: '上次尚无可核对的目标维度，保留原话供复核，并从下方选择场景重新建立基线。' }
      return { kind: 'review', record_id: latest.id, focus: focus?.label ?? '回应结构',
        action: finalCoach(latest).points?.[0] ?? '对照原话确认一个改进动作，再开始短练习。',
        reason: '根据最近一次有效训练安排；AI 分数变化不代表掌握。' }
    }
    return { kind: 'baseline', focus: '先完成一次基线练习', action: '选择下面的已发布场景，先观察自己的表达，再决定下一次练什么。' }
  })
  route(app, 'POST', '/api/training/review-opened', undefined, async (user, _p, body) => {
    assert(typeof body?.record_id === 'string' && body.record_id.length <= 80, 422, '无效记录。')
    await store.ownRecord(user, body.record_id)
    return store.transaction(user.workspace, async tx => {
      const id = sha(`${user.id}:${body.record_id}`)
      return await tx.get(user.workspace, 'learning_event', id) ?? tx.create(user.workspace, 'learning_event',
        { owner_id: user.id, event: 'review_opened', record_id: body.record_id }, id)
    })
  })
  route(app, 'GET', '/api/training/outcomes', undefined, async user => {
    const records = (await store.records(user.role === 'admin' ? undefined : user, null))
      .filter(record => record.workspace === user.workspace && record.training && !record.validation_only)
    const data = await store.transaction(user.workspace, async tx => ({
      plans: (await tx.all('remediation')).filter(row => row.tenant === user.workspace && (user.role === 'admin' || row.item.owner_id === user.id)).map(row => row.item),
      reviews: await tx.list(user.workspace, 'review'),
      views: (await tx.all('learning_event')).filter(row => row.tenant === user.workspace && (user.role === 'admin' || row.item.owner_id === user.id)).map(row => row.item),
    }), false)
    const reviewsByRecord = new Map<string, Doc[]>()
    for (const review of data.reviews) {
      const group = reviewsByRecord.get(review.record_id)
      if (group) group.push(review)
      else reviewsByRecord.set(review.record_id, [review])
    }
    const viewed = new Map(data.views.map(row => [row.record_id, row.created_at]))
    const byOwner = new Map<string, Doc[]>(), plans = new Map(data.plans.map(plan => [plan.id, plan]))
    for (const record of records) {
      const group = byOwner.get(record.owner_id) ?? []
      group.push(record); byOwner.set(record.owner_id, group)
    }
    const validRecords = records.filter(record => activity(record).valid)
    const baselines = new Map(records.map(record => [record.id, record]))
    const today = Math.floor(Date.now() / 86400000)
    let firstValid = 0, eligible = 0, returned = 0, repeatedWeakness = 0, practiceAttempts = 0, transferAttempts = 0, transferObserved = 0
    for (const group of byOwner.values()) {
      group.sort((a, b) => a.started_at.localeCompare(b.started_at))
      if (activity(group[0]).valid) firstValid++
      const firstDay = Math.floor(Date.parse(group[0].started_at) / 86400000)
      if (firstDay <= today - 14) {
        eligible++
        if (group.some(record => { const day = Math.floor(Date.parse(record.started_at) / 86400000); return day >= firstDay + 7 && day < firstDay + 14 })) returned++
      }
    }
    for (const record of validRecords) {
      const plan = plans.get(record.remediation_id)
      if (!plan) continue
      const target = reviewedDimensions(record, reviewsByRecord.get(record.id) ?? []).find(row => row.key === plan.focus_key)
      if (!target || !Number.isInteger(target.score) || target.score < 0 || target.score > 4) continue
      const observed = target.score >= 3 && observedTarget(record, plan.focus_key)
      if (record.remediation_phase === 'verification') {
        const baseline = baselines.get(plan.parent_record_id)
        if (record.experience !== 'combat' || record.mode !== 'independent' || !baseline ||
          contextOf(record.training) === contextOf(baseline.training) || record.training?.stage !== plan.stage ||
          canonical(record.training?.rubric.dimensions) !== canonical(baseline.training?.rubric.dimensions)) continue
        transferAttempts++; if (observed) transferObserved++
      } else { practiceAttempts++; if (!observed) repeatedWeakness++ }
    }
    return { first_saved_users: byOwner.size, first_saved_valid: firstValid,
      practice_attempts: practiceAttempts, repeated_weakness: repeatedWeakness,
      transfer_attempts: transferAttempts, transfer_observed: transferObserved,
      return_eligible: eligible, returned_second_week: returned,
      saved_attempts: records.length, valid_attempts: validRecords.length,
      reviewed_records: viewed.size, reviewed_then_retrained: new Set(data.plans.filter(plan => viewed.has(plan.parent_record_id) &&
        plan.created_at >= viewed.get(plan.parent_record_id)).map(plan => plan.parent_record_id)).size,
      needs_practice: data.plans.filter(plan => plan.status === 'assigned').length,
      needs_verification: data.plans.filter(plan => plan.status === 'awaiting_verification').length,
      awaiting_review: data.plans.filter(plan => plan.status === 'awaiting_review').length,
      verified: data.plans.filter(plan => plan.learning_status === 'verified').length,
      scope: '累计已保存场景训练；复盘访问从本功能启用后记录。次周回练按 UTC 自首条记录第 7–13 天统计，仅纳入已满 14 天的用户；不能推算未保存的启动或实际拜访能力。' }
  })
  route(app, 'GET', '/api/training/challenges', undefined, async user => {
    const { visits, scenes } = await store.transaction(user.workspace, async tx => ({
      visits: (await tx.list(user.workspace, 'visit')).filter(row => row.owner_id === user.id && row.training_challenge === true),
      scenes: (await tx.list(user.workspace, 'scenario')).filter(row => row.status === 'published'),
    }), false)
    const scenesByCase = new Map<string, Doc[]>()
    for (const scene of scenes) {
      const id = scene.generation?.case?.id
      if (!id) continue
      const group = scenesByCase.get(id)
      if (group) group.push(scene)
      else scenesByCase.set(id, [scene])
    }
    return visits.map(visit => ({ id: visit.id, version: visit.version, status: visit.status, text: visit.redacted_text || visit.text || '',
      visited_at: visit.visited_at, review: visit.review ? { decision: visit.review.decision, reason: visit.review.reason } : null,
      scenarios: (scenesByCase.get(visit.review?.case_id) ?? [])
        .map(scene => ({ id: scene.id, title: scene.title })),
    }))
  })
}
