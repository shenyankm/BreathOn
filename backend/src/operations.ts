import type { FastifyInstance } from 'fastify'
import {
  type Doc,
  type User,
  assert,
  now,
  sha,
  canonical,
  normalize,
  pick,
  constants,
  unique,
} from './core.ts'
import { Store, Transaction, activity, trainingFingerprint } from './store.ts'
import { Catalog } from './catalog.ts'
import { parse, usable, stages } from './validation.ts'
import { prepareTraining, snapshot, retrieve, checkMaterials, scenarioTemplates } from './training.ts'
import { Models, generateReply } from './agents.ts'
import { Tasks } from './tasks.ts'
import { route } from './http.ts'
import { prices, estimateCost } from './platform.ts'

const caseKeys = ['title', 'situation', 'approach', 'rationale', 'limitations']
async function validateCase(tx: Transaction, u: User, item: Doc) {
  const documents = new Map<string, Doc>()
  for (const captured of item.documents ?? []) {
    const doc = await tx.require(u.workspace, 'content', captured.id)
    assert(
      usable(doc) &&
        doc.version === captured.version &&
        sha(canonical(doc.pages)) === captured.sha256,
      409,
      '案例原始资料已改变、停用或过期，请重新核对有效资料后建立案例。',
    )
    documents.set(doc.id, doc)
  }
  for (const citation of item.citations ?? []) {
    const doc =
        documents.get(citation.document_id) ??
        (await tx.require(u.workspace, 'content', citation.document_id)),
      page = doc.pages.find((p: Doc) => p.number === citation.page)
    assert(
      item.documents.some((d: Doc) => d.id === doc.id && d.version === citation.document_version) &&
        page &&
        normalize(page.text).includes(normalize(citation.quote)),
      422,
      '案例引文无法与原训练资料核对。',
    )
  }
}
async function caseForGeneration(store: Store, u: User, id: string) {
  return store.transaction(
    u.workspace,
    async (tx) => {
      const item = await tx.require(u.workspace, 'case', id)
      assert(item.status === 'confirmed', 409, '案例需先编辑核对并确认，才能复用。')
      await validateCase(tx, u, item)
      return item
    },
    false,
  )
}
export function registerOperations(
  app: FastifyInstance,
  store: Store,
  catalog: Catalog,
  models: Models,
  tasks: Tasks,
) {
  route(app, 'GET', '/api/sessions/{item_id}/reviews', undefined, async (u, p) => {
    const record = await store.ownRecord(u, p.item_id)
    return store.transaction(
      record.workspace ?? u.workspace,
      async (tx) => ({
        reviews: (await tx.list(record.workspace ?? u.workspace, 'review')).filter(
          (r) => r.record_id === p.item_id,
        ),
        responses: (await tx.list(record.workspace ?? u.workspace, 'review_response')).filter(
          (r) => r.record_id === p.item_id,
        ),
      }),
      false,
    )
  })
  route(
    app,
    'POST',
    '/api/sessions/{item_id}/reviews',
    'platform.operations.Review',
    async (u, p, b) => {
      const record = await store.ownRecord(u, p.item_id)
      if (b.message_id)
        assert(
          record.messages.some((m: Doc) => m.id === b.message_id),
          422,
          '点评的原话不存在。',
        )
      return store.transaction(record.workspace ?? u.workspace, async (tx) => {
        const dimensions = record.training?.rubric.dimensions ?? []
        assert(
          unique(b.overrides.map((o: Doc) => o.key)).length === b.overrides.length,
          422,
          '调整维度不能重复。',
        )
        for (const override of b.overrides) {
          const dimension = dimensions.find((d: Doc) => d.key === override.key)
          assert(dimension, 422, '评价维度不属于本次量表。')
          assert(
            !dimension.requires_content || override.score === null || override.citations.length,
            422,
            '医学评价调整需要审核资料的原文引用。',
          )
          for (const citation of override.citations) {
            const doc = await tx.require(
                record.workspace ?? u.workspace,
                'content',
                citation.document_id,
              ),
              captured = record.training.documents.find((d: Doc) => d.id === doc.id),
              page = doc.pages.find((p: Doc) => p.number === citation.page)
            assert(
              captured &&
                captured.version === doc.version &&
                usable(doc) &&
                page &&
                normalize(page.text).includes(normalize(citation.quote)),
              422,
              '调整引用不属于本次有效资料或原文无法核对。',
            )
          }
        }
        const item = await tx.create(record.workspace ?? u.workspace, 'review', {
          record_id: p.item_id,
          reviewer_id: u.id,
          action: 'comment',
          ...b,
        })
        await tx.audit(
          { ...u, workspace: record.workspace ?? u.workspace },
          'review.comment',
          'review',
          item.id,
          { record_id: p.item_id },
        )
        return item
      })
    },
    201,
  )
  route(
    app,
    'POST',
    '/api/sessions/{item_id}/retrain',
    'platform.operations.Retrain',
    async (u, p, b) => {
      const record = await store.ownRecord(u, p.item_id)
      assert(
        !record.workspace || record.workspace === u.workspace,
        409,
        '该记录属于其他旧工作区，不能在当前资料库中建立重练。',
      )
      assert(record.training, 409, '此记录未绑定场景，不能建立同版本重练。')
      const stage = b.stage ?? record.training.stage
      assert(stages.includes(stage), 422, '环节无效。')
      const training = await prepareTraining(store, u, record.training.scenario.id, stage)
      const fingerprint = trainingFingerprint(record.training)
      assert(
        fingerprint && fingerprint === trainingFingerprint(snapshot(training)),
        409,
        '医生、场景或资料版本已变化，不能建立同条件重练。',
      )
      return store.transaction(u.workspace, async (tx) => {
        const dimensions = activity(record).assessment.dimensions ?? []
        for (const review of (await tx.list(u.workspace, 'review'))
          .filter((r) => r.record_id === record.id)
          .reverse())
          for (const change of review.overrides ?? []) {
            const d = dimensions.find((d: Doc) => d.key === change.key)
            if (d) d.score = change.score
          }
        const focus = dimensions
            .filter((d: Doc) => d.score !== null && d.score < 4)
            .sort((a: Doc, b: Doc) => a.score - b.score)[0],
          item = await tx.create(u.workspace, 'remediation', {
            owner_id: u.id,
            workspace: u.workspace,
            team: record.team ?? '',
            parent_record_id: record.id,
            scenario_id: training.scenario.id,
            stage,
            rubric_id: training.rubric.id,
            focus_key: focus?.key ?? null,
            focus_label: focus?.label ?? '证据与回应结构巩固',
            note: b.note || '沿用同一评价量表巩固练习；未观察项不视为缺点。',
            status: 'assigned',
            assigned_by: u.id,
          })
        await tx.audit(u, 'retrain.create', 'remediation', item.id)
        return item
      })
    },
    201,
  )
  const remediationProgress = async (u: User, id: string) => {
    const item = await store.transaction(
        u.workspace,
        (tx) => tx.require(u.workspace, 'remediation', id),
        false,
      ),
      rows = (await store.records(u, null)).map(activity),
      baseline = rows.find((row) => row.id === item.parent_record_id),
      seen = new Set<string>(),
      children = rows
        .filter((row) => row.valid && row.remediation_id === id)
        .sort((a, b) => (a.ended_at ?? a.started_at).localeCompare(b.ended_at ?? b.started_at))
        .filter((row) => {
          const key = JSON.stringify([
            row.owner_id,
            row.scenario_id,
            row.stage,
            row.transcript_hash,
          ])
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }),
      latest = children.at(-1),
      reasons: string[] = []
    if (!baseline || !latest) reasons.push('尚无完整的原记录和有效重练结果。')
    else {
      if (!baseline.valid) reasons.push('原记录未形成有效评价。')
      if (
        !baseline.training_fingerprint ||
        baseline.training_fingerprint !== latest.training_fingerprint
      )
        reasons.push('医生、场景或资料版本不同，或历史版本信息不完整。')
      if (baseline.stage !== latest.stage) reasons.push('训练环节不同。')
      if (baseline.experience !== latest.experience) reasons.push('演练模式不同。')
      if (
        ['rubric_fingerprint', 'model', 'evaluator_version'].some(
          (k) => !baseline.assessment[k] || baseline.assessment[k] !== latest.assessment[k],
        )
      )
        reasons.push('量表、模型或评价器版本不同。')
    }
    return {
      ...item,
      attempts: children.length,
      latest_record_id: latest?.id ?? null,
      comparable: !reasons.length,
      same_stage: !!baseline && !!latest && baseline.stage === latest.stage,
      comparison_reasons: reasons,
      dimensions: reasons.length
        ? []
        : latest!.assessment.dimensions.map((d: Doc) => {
            const before =
              baseline!.assessment.dimensions.find((o: Doc) => o.key === d.key)?.score ?? null
            return {
              key: d.key,
              label: d.label,
              before,
              after: d.score,
              delta: before !== null && d.score !== null ? d.score - before : null,
            }
          }),
    }
  }
  route(app, 'GET', '/api/remediations', undefined, (u) =>
    store.transaction(u.workspace, (tx) => tx.list(u.workspace, 'remediation'), false),
  )
  route(app, 'GET', '/api/sessions/{item_id}/remediations', undefined, async (u, p) => {
    await store.ownRecord(u, p.item_id)
    const plans = await store.transaction(
      u.workspace,
      (tx) => tx.list(u.workspace, 'remediation'),
      false,
    )
    return Promise.all(
      plans
        .filter((r) => r.parent_record_id === p.item_id)
        .map((r) => remediationProgress(u, r.id)),
    )
  })
  route(app, 'GET', '/api/remediations/{item_id}/progress', undefined, (u, p) =>
    remediationProgress(u, p.item_id),
  )
  route(app, 'GET', '/api/remediations/{item_id}/next', undefined, async (u, p) => {
    const item = await store.transaction(
      u.workspace,
      (tx) => tx.require(u.workspace, 'remediation', p.item_id),
      false,
    )
    assert(item.status === 'assigned', 403, '补练已关闭。')
    const baseline = await store.ownRecord(u, item.parent_record_id),
      training = await prepareTraining(store, u, item.scenario_id, item.stage),
      fingerprint = trainingFingerprint(baseline.training)
    assert(
      fingerprint && fingerprint === trainingFingerprint(snapshot(training)),
      409,
      '医生、场景或资料版本已变化，不能启动同条件重练。',
    )
    return {
      ...item,
      remediation_id: item.id,
      experience: ['practice', 'combat'].includes(baseline.experience)
        ? baseline.experience
        : 'practice',
      mode: ['assisted', 'independent'].includes(baseline.mode) ? baseline.mode : 'assisted',
    }
  })
  route(app, 'GET', '/api/cases', undefined, (u) =>
    store.transaction(u.workspace, (tx) => tx.list(u.workspace, 'case'), false),
  )
  route(app, 'GET', '/api/cases/{item_id}', undefined, (u, p) =>
    store.transaction(u.workspace, (tx) => tx.require(u.workspace, 'case', p.item_id), false),
  )
  route(
    app,
    'POST',
    '/api/sessions/{item_id}/cases',
    'platform.cases.CaseFromRecord',
    async (u, p, b) => {
      const record = await store.ownRecord(u, p.item_id)
      assert(
        !record.workspace || record.workspace === u.workspace,
        409,
        '请先导出旧工作区案例，再作为外来素材导入核对。',
      )
      const index = record.messages.findIndex((m: Doc) => m.id === b.message_id),
        selected = record.messages[index]
      assert(
        selected?.role === 'trainee' &&
          selected.final &&
          selected.text.trim() &&
          selected.text.length <= 4000,
        422,
        '请选择一条完整的学员原话。',
      )
      const doctor = record.messages
          .slice(0, index)
          .reverse()
          .find((m: Doc) => m.role === 'doctor' && m.final),
        coaching = [...record.coaching].reverse().find((c: Doc) => c.final_report) ?? {},
        relevant = (coaching.assessment?.dimensions ?? []).filter((d: Doc) =>
          d.utterances.some((q: Doc) => q.message_id === selected.id),
        ),
        citations: Doc[] = []
      for (const d of relevant)
        for (const c of d.citations)
          if (
            !citations.some((row) => JSON.stringify(row) === JSON.stringify(c)) &&
            citations.length < 12
          )
            citations.push(c)
      return store.transaction(u.workspace, async (tx) => {
        const item = await tx.create(u.workspace, 'case', {
          title: (record.training?.scenario.title ?? '拜访沟通').slice(0, 150) + '：回应案例',
          situation: doctor?.text.slice(0, 2000) ?? '根据原记录补充拜访背景与医生关注点。',
          approach:
            selected.text.length <= 2000
              ? selected.text
              : '请结合完整原话，提炼希望复用的回应方式。',
          rationale: (
            relevant.map((d: Doc) => d.reason).join('\n') || '请结合原话填写处理理由。'
          ).slice(0, 2000),
          limitations: (
            coaching.risk || '仅供模拟沟通训练；参考表达尚不证明实际拜访有效，不作为独立医学证据。'
          ).slice(0, 2000),
          status: 'draft',
          created_by: u.id,
          origin_record_id: record.id,
          origin_verified: true,
          quotes: [...(doctor ? [doctor] : []), selected].map((m) => pick(m, ['role', 'text'])),
          documents: record.training?.documents ?? [],
          citations,
        })
        await tx.audit(u, 'case.extract', 'case', item.id, { record_id: record.id })
        return item
      })
    },
    201,
  )
  route(app, 'PUT', '/api/cases/{item_id}', 'platform.cases.CaseEdit', (u, p, b) =>
    store.transaction(u.workspace, async (tx) => {
      const old = await tx.require(u.workspace, 'case', p.item_id),
        { version, ...data } = b,
        item = await tx.update(
          u.workspace,
          'case',
          old.id,
          { ...old, ...data, status: 'draft' },
          version,
        )
      await tx.audit(u, 'case.edit', 'case', item.id)
      return item
    }),
  )
  route(app, 'POST', '/api/cases/{item_id}/confirm', 'platform.models.Publish', (u, p, b) =>
    store.transaction(u.workspace, async (tx) => {
      const old = await tx.require(u.workspace, 'case', p.item_id)
      assert(old.status === 'draft', 409, '案例已经确认；修改后需重新确认。')
      await validateCase(tx, u, old)
      const item = await tx.update(
        u.workspace,
        'case',
        old.id,
        { ...old, status: 'confirmed', confirmed_by: u.id },
        b.version,
      )
      await tx.audit(u, 'case.confirm', 'case', old.id)
      return item
    }),
  )
  route(
    app,
    'POST',
    '/api/cases/import',
    'platform.cases.CaseImport',
    (u, _p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const digest = sha(canonical(b.case)),
          old = (await tx.list(u.workspace, 'case')).find((row) => row.import_sha256 === digest)
        if (old) return { ...old, reused: true }
        const item = await tx.create(u.workspace, 'case', {
          ...pick(b.case, caseKeys),
          quotes: b.case.quotes,
          external_sources: b.case.sources,
          documents: [],
          citations: [],
          status: 'draft',
          created_by: u.id,
          origin_verified: false,
          import_sha256: digest,
        })
        await tx.audit(u, 'case.import', 'case', item.id)
        return item
      }),
    201,
  )
  route(app, 'GET', '/api/cases/{item_id}/export', undefined, async (u, p, _b, q, reply) => {
    const item = await store.transaction(
        u.workspace,
        (tx) => tx.require(u.workspace, 'case', p.item_id),
        false,
      ),
      sources = item.external_sources?.length
        ? item.external_sources
        : (item.citations ?? []).map((c: Doc) =>
            pick(c, ['title', 'version_label', 'source_url', 'page', 'quote']),
          ),
      packet = parse('platform.cases.CaseImport', {
        schema_version: 1,
        case: { ...pick(item, caseKeys), quotes: item.quotes, sources },
      })
    reply.header(
      'Content-Disposition',
      `attachment; filename="case-${p.item_id}.${q.format === 'markdown' ? 'md' : 'json'}"`,
    )
    if (q.format !== 'markdown') return packet
    reply.type('text/markdown; charset=utf-8')
    return (
      '# 沟通训练案例\n\n仅为沟通参考，导出不代表原话和医学结论已通过外部核实。\n\n' +
      caseKeys.map((key) => `## ${key}\n\n${item[key]}`).join('\n\n') +
      '\n\n## 原记录片段\n\n' +
      item.quotes
        .map((r: Doc) => `${r.role === 'doctor' ? '医生' : '学员'}：${r.text}`)
        .join('\n\n') +
      '\n\n## 资料引用\n\n' +
      sources
        .map(
          (s: Doc) =>
            `${s.title} · ${s.version_label} · 第 ${s.page} 页\n\n${s.quote}\n\n${s.source_url}`,
        )
        .join('\n\n')
    )
  })
  route(
    app,
    'POST',
    '/api/scenarios/generate',
    'platform.generation.GenerateScenario',
    async (u, _p, b) => {
      assert(models.config.key, 503, '场景生成服务尚未配置。')
      const prepared = await store.transaction(
          u.workspace,
          async (tx) => {
            await catalog.bindings(tx, u.workspace, b, true)
            return {
              doctor: await tx.require(u.workspace, 'doctor', b.doctor_id),
              rubric: await tx.require(u.workspace, 'rubric', b.rubric_id),
              documents: await Promise.all(
                b.content_ids.map((id: string) => tx.require(u.workspace, 'content', id)),
              ),
            }
          },
          false,
        ),
        evidence = retrieve(prepared.documents, b.objective + ' ' + b.product),
        reference = b.case_id ? await caseForGeneration(store, u, b.case_id) : undefined,
        pricing = await prices(store, u),
        started = Date.now()
      const { data, usage } = await models.json(
          constants.generation.PROMPT,
          {
            brief: b,
            doctor: prepared.doctor,
            rubric: prepared.rubric,
            evidence: evidence.map((row) => pick(row, ['id', 'document_id', 'page', 'text'])),
            situation_rule: scenarioTemplates[b.situation].doctor_rule,
            training_focus: { stages: scenarioTemplates[b.situation].stages, success_criteria: scenarioTemplates[b.situation].success_criteria },
            difficulty_rule: constants.training.DIFFICULTY_RULES[b.difficulty],
            ...(reference
              ? { case_reference: { ...pick(reference, caseKeys), is_medical_evidence: false } }
              : {}),
          },
          { tokens: 3000, timeout: 45 },
        ),
        outline = parse('platform.generation.Outline', data),
        citations = outline.citations.map((quote: Doc) => {
          const source = evidence.find((row) => row.id === quote.source_id)
          assert(
            source && normalize(source.text).includes(normalize(quote.quote)),
            502,
            '生成内容的资料引文无法核对，未保存草稿。',
          )
          const { text, ...metadata } = source
          return { ...metadata, quote: quote.quote }
        })
      const { case_id, ...brief } = b,
        scene = parse('platform.models.Scenario', {
          ...brief,
          ...pick(outline, ['title', 'background', 'opening', 'objections', 'success_criteria']),
          stages: scenarioTemplates[b.situation].stages,
        }),
        generation = {
          model: models.config.model,
          usage,
          elapsed_seconds: (Date.now() - started) / 1000,
          doctor_version: prepared.doctor.version,
          rubric_version: prepared.rubric.version,
          documents: prepared.documents.map((d) => pick(d, ['id', 'version'])),
          citations,
          reviewed: false,
          pricing,
          cost: estimateCost([usage], pricing.rates),
          ...(reference ? { case: pick(reference, ['id', 'version', 'origin_verified']) } : {}),
        }
      return store.transaction(u.workspace, async (tx) => {
        await catalog.bindings(tx, u.workspace, b, true)
        for (const [kind, items] of [
          ['doctor', [prepared.doctor]],
          ['rubric', [prepared.rubric]],
          ['content', prepared.documents],
        ] as [string, Doc[]][])
          for (const old of items)
            assert(
              (await tx.require(u.workspace, kind, old.id)).version === old.version,
              409,
              '生成期间医生、量表或资料已变化，未保存草稿。',
            )
        if (reference) {
          const current = await tx.require(u.workspace, 'case', reference.id)
          assert(
            current.version === reference.version && current.status === 'confirmed',
            409,
            '生成期间案例已变化。',
          )
          await validateCase(tx, u, current)
        }
        const item = await tx.create(u.workspace, 'scenario', {
          ...scene,
          status: 'draft',
          created_by: u.id,
          generation,
        })
        await tx.audit(u, 'scenario.generate', 'scenario', item.id)
        return item
      })
    },
    201,
  )
  return registerCalibration(app, store, models, tasks)
}

export function kappa(pairs: [number, number][]): number | null {
  if (pairs.length < 2) return null
  const n = pairs.length,
    rows = Array(5).fill(0),
    cols = Array(5).fill(0)
  let actual = 0
  for (const [a, b] of pairs) {
    rows[a]++
    cols[b]++
    actual += (a - b) ** 2 / 16 / n
  }
  let chance = 0
  for (let a = 0; a < 5; a++)
    for (let b = 0; b < 5; b++) chance += (((a - b) ** 2 / 16) * rows[a] * cols[b]) / n ** 2
  return chance ? Math.round((1 - actual / chance) * 1000) / 1000 : null
}
function calibrationMetrics(
  samples: Doc[],
  results: Doc[],
  dimensions: Doc[],
  minimum: number,
  repeats: Doc,
): Doc {
  const expert = samples.filter((s) => s.label_type === 'expert'),
    rows = dimensions.map((d) => {
      let expected = 0
      const pairs: [number, number][] = [],
        stable: boolean[] = []
      for (const sample of expert) {
        const truth = sample.expected_scores[d.key]
        if (truth === null || truth === undefined) continue
        expected++
        const assessment = results.find((r) => r.sample_id === sample.id)?.assessment,
          predicted = assessment?.dimensions.find((row: Doc) => row.key === d.key)?.score
        if (predicted !== null && predicted !== undefined && !assessment.validation_errors.length) {
          pairs.push([truth, predicted])
          for (const again of repeats[sample.id] ?? []) {
            const second = again.dimensions.find((row: Doc) => row.key === d.key)?.score
            if (second !== null && second !== undefined && !again.validation_errors.length)
              stable.push(Math.abs(second - predicted) <= 1)
          }
        }
      }
      return {
        key: d.key,
        label: d.label,
        expected_count: expected,
        paired_count: pairs.length,
        mae: pairs.length
          ? pairs.reduce((n, [a, b]) => n + Math.abs(a - b), 0) / pairs.length
          : null,
        within_one: pairs.length
          ? pairs.filter(([a, b]) => Math.abs(a - b) <= 1).length / pairs.length
          : null,
        kappa: kappa(pairs),
        bias: pairs.length ? pairs.reduce((n, [a, b]) => n + b - a, 0) / pairs.length : null,
        stability: stable.length ? stable.filter(Boolean).length / stable.length : null,
        repeat_comparisons: stable.length,
      }
    })
  return {
    expert_samples: expert.length,
    synthetic_samples: samples.length - expert.length,
    dimensions: rows,
    calibrated:
      rows.length > 0 &&
      expert.length >= minimum &&
      rows.every(
        (r) =>
          r.expected_count >= minimum &&
          r.paired_count === r.expected_count &&
          r.mae !== null &&
          r.mae <= 0.5 &&
          r.within_one !== null &&
          r.within_one >= 0.9 &&
          (r.kappa === null || r.kappa >= 0.6) &&
          (r.stability === null || r.stability >= 0.9),
      ),
    criteria: {
      minimum_expert_samples_per_dimension: minimum,
      maximum_mae: 0.5,
      minimum_within_one: 0.9,
      minimum_weighted_kappa: 0.6,
      minimum_stability: 0.9,
    },
  }
}
function registerCalibration(app: FastifyInstance, store: Store, models: Models, tasks: Tasks) {
  const clean = (run: Doc) => {
    const { samples, ...rest } = run
    return rest
  }
  const running = (run: Doc) => ['running', 'cancel_requested'].includes(run.status)
  // shortcut: Task ownership is local to one API process; use shared ownership before adding API workers.
  const settle = async (tx: Transaction, tenant: string, run: Doc, restarting = false) => {
    if (
      !running(run) || tasks.active(run.id) ||
      (!restarting && Date.parse(run.lease_until) > Date.now())
    )
      return run
    return tx.update(
      tenant, 'calibration_run', run.id,
      {
        ...run,
        status: run.status === 'cancel_requested' ? 'cancelled' : 'interrupted',
        error: run.status === 'cancel_requested' ? null : '执行进程已停止，任务已中断；不会自动重试。',
        finished_at: now(),
      },
      run.version,
    )
  }
  const get = async (u: User, id: string) =>
    store.transaction(u.workspace, async (tx) =>
      clean(await settle(tx, u.workspace, await tx.require(u.workspace, 'calibration_run', id))),
    )
  route(app, 'GET', '/api/rubrics/{rubric_id}/samples', undefined, (u, p) =>
    store.transaction(
      u.workspace,
      async (tx) =>
        (await tx.list(u.workspace, 'calibration_sample')).filter(
          (row) => row.rubric_id === p.rubric_id,
        ),
      false,
    ),
  )
  route(app, 'GET', '/api/rubrics/{rubric_id}/calibration/runs', undefined, (u, p) =>
    store.transaction(
      u.workspace,
      async (tx) => {
        const rows = (await tx.list(u.workspace, 'calibration_run'))
          .filter((row) => row.rubric_id === p.rubric_id)
          .slice(0, 20)
        const result = []
        for (const row of rows) result.push(clean(await settle(tx, u.workspace, row)))
        return result
      },
    ),
  )
  route(
    app,
    'POST',
    '/api/calibration/samples',
    'platform.calibration.CalibrationSample',
    async (u, _p, b) => {
      const training = await prepareTraining(store, u, b.scenario_id, b.stage),
        keys = training.rubric.dimensions.map((d: Doc) => d.key)
      assert(
        JSON.stringify(Object.keys(b.expected_scores).sort()) === JSON.stringify(keys.sort()) &&
          Object.values(b.expected_scores).every(
            (value) =>
              value === null ||
              (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4),
          ),
        422,
        '标注维度必须与场景绑定的量表完全一致，分数须为0至4整数或null。',
      )
      assert(
        unique(b.messages.map((m: Doc) => m.id)).length === b.messages.length &&
          b.messages.some((m: Doc) => m.role === 'trainee' && m.final),
        422,
        '消息id必须唯一，且必须有完整学员原话。',
      )
      return store.transaction(u.workspace, async (tx) => {
        const item = await tx.create(
          u.workspace,
          'calibration_sample',
          {
            ...b,
            rubric_id: training.rubric.id,
            rubric_fingerprint: sha(canonical(training.rubric.dimensions)),
            labelled_by: u.id,
          },
          training.rubric.id +
            '-' +
            sha(canonical(b.messages.map((m: Doc) => pick(m, ['role', 'text'])))).slice(0, 24),
        )
        await tx.audit(u, 'calibration.sample', 'calibration_sample', item.id)
        return item
      })
    },
    201,
  )
  route(app, 'GET', '/api/calibration/runs/{run_id}', undefined, (u, p) => get(u, p.run_id))
  route(app, 'POST', '/api/calibration/runs/{run_id}/cancel', undefined, async (u, p) => {
    await store.transaction(u.workspace, async (tx) => {
      const run = await tx.require(u.workspace, 'calibration_run', p.run_id)
      if (running(run)) {
        const active = tasks.active(run.id)
        await tx.update(
          u.workspace,
          'calibration_run',
          run.id,
          {
            ...run,
            status: active ? 'cancel_requested' : 'cancelled',
            ...(!active ? { finished_at: now(), error: null } : {}),
          },
          run.version,
        )
        await tx.audit(u, 'calibration.cancel', 'calibration_run', run.id)
      }
    })
    await tasks.cancel(p.run_id)
    return get(u, p.run_id)
  })
  route(
    app,
    'POST',
    '/api/rubrics/{rubric_id}/calibration',
    'platform.models.Publish',
    async (u, p, b) => {
      const run = await store.transaction(u.workspace, async (tx) => {
        const rubric = await tx.require(u.workspace, 'rubric', p.rubric_id)
        assert(
          rubric.version === b.version && rubric.status === 'published',
          409,
          '请刷新并选择已发布的量表版本。',
        )
        assert(
          !(await tx.list(u.workspace, 'calibration_run')).some(
            (row) =>
              row.rubric_id === rubric.id &&
              running(row) &&
              (tasks.active(row.id) || Date.parse(row.lease_until) > Date.now()),
          ),
          409,
          '此量表已有校准任务执行中。',
        )
        const samples = (await tx.list(u.workspace, 'calibration_sample'))
          .filter(
            (s) =>
              s.rubric_id === rubric.id &&
              s.rubric_fingerprint === sha(canonical(rubric.dimensions)),
          )
          .sort((a, b) => Number(a.label_type !== 'expert') - Number(b.label_type !== 'expert'))
          .slice(0, 20)
        assert(samples.length, 409, '请先录入专家或合成样本。')
        const item = await tx.create(u.workspace, 'calibration_run', {
          rubric_id: rubric.id,
          rubric_fingerprint: sha(canonical(rubric.dimensions)),
          status: 'running',
          model: models.config.model,
          evaluator_version: constants.evaluation.EVALUATOR_VERSION,
          created_by: u.id,
          samples,
          results: [],
          lease_until: new Date(Date.now() + 120000).toISOString(),
          sample_count: samples.length,
          completed_count: 0,
          metrics: null,
        })
        await tx.audit(u, 'calibration.start', 'calibration_run', item.id)
        return item
      })
      tasks.start(run.id, u, async (signal) => {
        const results: Doc[] = [],
          repeats: Doc = {}
        let status = 'completed',
          error: null | string = null,
          rubric: Doc | undefined
        try {
          rubric = await store.transaction(
            u.workspace,
            (tx) => tx.require(u.workspace, 'rubric', run.rubric_id),
            false,
          )
          for (const sample of run.samples) {
            signal.throwIfAborted()
            const current = await get(u, run.id)
            if (current.status !== 'running') {
              status = current.status === 'cancel_requested' ? 'cancelled' : current.status
              break
            }
            const training = await prepareTraining(store, u, sample.scenario_id, sample.stage),
              reply = await generateReply(models, sample.messages, {
                training,
                speak: false,
                signal,
              })
            await checkMaterials(store, u, training)
            signal.throwIfAborted()
            results.push({
              sample_id: sample.id,
              sample_version: sample.version,
              assessment: reply.result.coach.assessment,
              usage: reply.usage,
            })
            for (let repeat = 0; repeat < store.config.repeats; repeat++) {
              const again = await generateReply(models, sample.messages, {
                training,
                speak: false,
                signal,
              })
              signal.throwIfAborted()
              ;(repeats[sample.id] ??= []).push(again.result.coach.assessment)
            }
            await store.transaction(u.workspace, async (tx) => {
              const old = await tx.require(u.workspace, 'calibration_run', run.id)
              if (old.status !== 'running') return
              await tx.update(
                u.workspace,
                'calibration_run',
                run.id,
                {
                  ...old,
                  results,
                  completed_count: results.length,
                  lease_until: new Date(Date.now() + 120000).toISOString(),
                },
                old.version,
              )
            })
          }
        } catch {
          status = signal.aborted ? 'interrupted' : 'failed'
          error = signal.aborted
            ? '服务停止或任务取消，校准中断；不会自动重试。'
            : '部分样本未完成，请核对资料有效性与模型服务。'
        } finally {
          await store.transaction(u.workspace, async (tx) => {
            const old = await tx.require(u.workspace, 'calibration_run', run.id)
            if (!running(old)) return
            const summary = rubric
                ? calibrationMetrics(
                    old.samples,
                    results,
                    rubric.dimensions,
                    store.config.minSamples,
                    repeats,
                  )
                : null,
              final = old.status === 'cancel_requested' ? 'cancelled' : status
            await tx.update(
              u.workspace,
              'calibration_run',
              old.id,
              {
                ...old,
                status: final,
                error,
                metrics: summary,
                results,
                completed_count: results.length,
                finished_at: now(),
              },
              old.version,
            )
            if (final === 'completed' && summary) {
              const active = await tx.require(u.workspace, 'rubric', old.rubric_id)
              assert(
                sha(canonical(active.dimensions)) === old.rubric_fingerprint,
                409,
                '校准期间量表已改变。',
              )
              await tx.update(
                u.workspace,
                'rubric',
                active.id,
                {
                  ...active,
                  calibration_status: summary.calibrated ? 'calibrated' : 'uncalibrated',
                  calibration_run_id: old.id,
                  calibrated_model: models.config.model,
                  calibrated_evaluator_version: constants.evaluation.EVALUATOR_VERSION,
                },
                active.version,
              )
            }
            await tx.audit(u, 'calibration.finish', 'calibration_run', old.id, { status: final })
          })
        }
      })
      return clean(run)
    },
    202,
  )
  return {
    recover: async (restarting = false) => {
      const rows = await store.transaction('', tx => tx.all('calibration_run'), false)
      for (const { tenant, item } of rows)
        if (running(item) && !tasks.active(item.id))
          await store.transaction(tenant, async tx => {
            await settle(tx, tenant, await tx.require(tenant, 'calibration_run', item.id), restarting)
          })
    },
  }
}
