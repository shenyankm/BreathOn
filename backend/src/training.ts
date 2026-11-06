import {
  type Doc,
  type User,
  constants,
  resource,
  assert,
  pick,
  now,
  sha,
  canonical,
  normalize,
  unique,
} from './core.ts'
import { Store } from './store.ts'
import { stages, usable, policyUsable, matchDepartment } from './validation.ts'

export const scenarioTemplates = resource('scenario-templates')

export async function prepareTraining(
  store: Store,
  user: User,
  id: string,
  stage = 'full',
  preview = false,
): Promise<Doc> {
  assert(
    typeof id === 'string' && id.length <= 80 && stages.includes(stage),
    422,
    '场景或训练环节无效。',
  )
  return store.transaction(
    user.workspace,
    async (tx) => {
      const scene = await tx.require(user.workspace, 'scenario', id)
      assert(
        (scene.status === 'published' || (preview && scene.status === 'draft')) &&
          (stage === 'full' || scene.stages.includes(stage)),
        409,
        '场景未发布或不支持该环节。',
      )
      const doctor = await tx.require(user.workspace, 'doctor', scene.doctor_id),
        rubric = await tx.require(user.workspace, 'rubric', scene.rubric_id)
      assert(
        doctor.status === 'published' && rubric.status === 'published',
        409,
        '绑定的医生或量表尚未发布。',
      )
      const documents = await Promise.all(
        scene.content_ids.map((key: string) => tx.require(user.workspace, 'content', key)),
      )
      assert(documents.every(usable), 409, '场景资料未审核、已过期或停用，请选择有效版本。')
      const drugs = await Promise.all(
        [scene.drug_id, scene.competitor_id]
          .filter(Boolean)
          .map((key) => tx.require(user.workspace, 'drug', key)),
      )
      const policies = await Promise.all(
        (scene.policy_ids ?? []).map((key: string) => tx.require(user.workspace, 'policy', key)),
      )
      assert(
        drugs.every((row) => row.status === 'published') && policies.every(policyUsable),
        409,
        '场景药品或政策已失效，请选择有效版本。',
      )
      if (scene.drug_id) matchDepartment(drugs[0], doctor)
      return {
        scenario: pick(scene, [
          'id',
          'title',
          'product',
          'disease',
          'objective',
          'duration_seconds',
          'difficulty',
          'stages',
          'version',
          'situation',
          'background',
          'opening',
          'objections',
          'success_criteria',
        ]),
        doctor: pick(doctor, [
          'id',
          'version',
          'name',
          'display_name',
          'specialty',
          'background_type',
          'public_facts',
          'sources',
          'population',
          'focus',
          'training_style',
          'mood',
          'opening',
          'honors',
        ]),
        rubric: pick(rubric, [
          'id',
          'version',
          'name',
          'dimensions',
          'calibration_status',
          'calibrated_model',
          'calibrated_evaluator_version',
        ]),
        stage,
        as_of: now(),
        documents,
        drugs,
        policies,
      }
    },
    false,
  )
}
export async function prepareFree(
  store: Store,
  user: User,
  drugId: string,
  doctorId: string,
  focus?: string,
): Promise<Doc> {
  assert(!focus || focus in constants.training.FREE_FOCUS, 422, '练习重点无效。')
  assert(
    [drugId, doctorId].every((v) => typeof v === 'string' && v.trim() && v.length <= 80),
    422,
    '请同时选择有效的药品和医生。',
  )
  return store.transaction(
    user.workspace,
    async (tx) => {
      const drug = await tx.require(user.workspace, 'drug', drugId),
        doctor = await tx.require(user.workspace, 'doctor', doctorId)
      assert(
        drug.status === 'published' && doctor.status === 'published',
        409,
        '自由演练的药品和医生必须已发布。',
      )
      matchDepartment(drug, doctor)
      return {
        drug: pick(drug, ['id', 'version', 'name', 'brand']),
        doctor: pick(doctor, [
          'id',
          'version',
          'name',
          'display_name',
          'specialty',
          'background_type',
          'public_facts',
          'sources',
          'population',
          'focus',
          'training_style',
          'mood',
          'opening',
          'honors',
          ...(doctor.ip_profile ? ['ip_profile'] : []),
        ]),
        ...(focus
          ? {
              focus: {
                key: focus,
                label: constants.training.FREE_FOCUS[focus][0],
                goal: constants.training.FREE_FOCUS[focus][1],
              },
            }
          : {}),
      }
    },
    false,
  )
}
export function snapshot(training: Doc): Doc {
  return {
    ...pick(training, ['scenario', 'doctor', 'rubric', 'stage', 'as_of']),
    focus_dimensions: training.focus_dimensions ?? [],
    drugs: (training.drugs ?? []).map((d: Doc) => pick(d, ['id', 'version', 'name', 'brand'])),
    policies: (training.policies ?? []).map((d: Doc) =>
      pick(d, ['id', 'version', 'title', 'version_label']),
    ),
    documents: training.documents.map((d: Doc) => ({
      ...pick(d, ['id', 'version', 'title', 'version_label', 'approved_at']),
      sha256: sha(canonical(d.pages)),
    })),
  }
}
export async function checkMaterials(store: Store, user: User, training?: Doc, free?: Doc) {
  await store.transaction(
    user.workspace,
    async (tx) => {
      if (free) {
        const drug = await tx.require(user.workspace, 'drug', free.drug.id),
          doctor = await tx.require(user.workspace, 'doctor', free.doctor.id)
        assert(
          drug.status === 'published' &&
            drug.version === free.drug.version &&
            doctor.status === 'published',
          409,
          '所选药品或医生已停用或版本改变，请重新选择。',
        )
        matchDepartment(drug, doctor)
      }
      if (training)
        for (const [kind, items] of [
          ['content', training.documents],
          ['drug', training.drugs ?? []],
          ['policy', training.policies ?? []],
        ] as [string, Doc[]][]) {
          for (const captured of items) {
            const current = await tx.get(user.workspace, kind, captured.id)
            assert(
              current &&
                current.version === captured.version &&
                (kind === 'content'
                  ? usable(current)
                  : kind === 'policy'
                    ? policyUsable(current)
                    : current.status === 'published'),
              409,
              '训练资料已失效或状态改变，本次暂停分析；请重新选择有效场景。',
            )
          }
        }
    },
    false,
  )
}
export function retrieve(documents: Doc[], query: string, limit = 10): Doc[] {
  if (limit === 0) return []
  const chinese = query.match(/[\u4e00-\u9fff]+/gu) ?? [],
    terms = unique([
      ...(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []),
      ...chinese.flatMap((s) => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2))),
    ])
  const candidates: Doc[] = []
  const compare = (a: Doc, b: Doc) => b.score - a.score || a.doc.id.localeCompare(b.doc.id) || a.page - b.page
  const bounded = Number.isInteger(limit) && limit > 0
  for (const doc of documents)
    for (const page of doc.pages)
      for (let offset = 0; offset < page.text.length; offset += 1100) {
        const text = page.text.slice(offset, offset + 1300),
          lower = text.toLowerCase()
        let score = 0
        for (const term of terms) {
          let start = 0
          for (let count = 0; count < 4; count++) {
            const found = lower.indexOf(term, start)
            if (found < 0) break
            score++
            start = found + term.length
          }
        }
        const candidate = {
          score,
          doc,
          page: page.number,
          text,
        }
        if (bounded) {
          let low = 0, high = candidates.length
          while (low < high) {
            const middle = (low + high) >>> 1
            if (compare(candidates[middle], candidate) <= 0) low = middle + 1
            else high = middle
          }
          if (low < limit) {
            candidates.splice(low, 0, candidate)
            if (candidates.length > limit) candidates.pop()
          }
        } else candidates.push(candidate)
      }
  return candidates
    .sort(compare)
    .slice(0, limit)
    .map((row, i) => ({
      id: `D${i + 1}`,
      document_id: row.doc.id,
      document_version: row.doc.version,
      title: row.doc.title,
      version_label: row.doc.version_label,
      page: row.page,
      text: row.text,
      scope: row.doc.scope ?? '',
      source_url: row.doc.source_url,
    }))
}
export function trainingContext(training: Doc, messages: Doc[]): Doc {
  return {
    ...pick(training, ['scenario', 'doctor', 'rubric', 'stage', 'as_of']),
    focus_dimensions: training.focus_dimensions ?? [],
    stage_label: (
      {
        full: '完整拜访',
        opening: '开场',
        needs: '需求探询',
        evidence: '研究介绍',
        objections: '异议处理',
        safety: '安全沟通',
        closing: '收尾',
      } as Doc
    )[training.stage],
    evidence: retrieve(
      training.documents,
      messages
        .slice(-4)
        .map((m) => m.text.slice(-2000))
        .join(' ') +
        ' ' +
        training.scenario.objective,
    ),
  }
}
export function speechInstructions(training?: Doc): string {
  return (
    '请用中文普通话说出模拟医生的台词。' +
    (constants.training.SPEECH_STYLES[training?.doctor?.mood] ??
      constants.training.SPEECH_STYLES.neutral) +
    (training?.scenario?.situation === 'time_pressure'
      ? '当前交流时间有限，优先采用紧凑节奏、稍快语速，保持吐字清晰。'
      : '') +
    constants.doctor.DOCTOR_VOICE +
    '只朗读台词，不读指令，不添加额外内容；不模仿真实医生本人的声音。'
  )
}
export function opening(training?: Doc, free?: Doc): string {
  if (!training)
    return free
      ? free.focus && free.doctor.opening
        ? free.doctor.opening
        : `你好，今天想聊${free.drug.name}的哪方面？`
      : constants.doctor.OPENING
  if (training.stage !== 'full') return constants.training.STAGE_OPENINGS[training.stage]
  return training.scenario.situation === 'time_pressure'
    ? `我只有${training.scenario.duration_seconds}秒，请先确认你今天最想交流的一个重点。`
    : training.scenario.opening || training.doctor.opening
}
export function doctorInstructions(training?: Doc, free?: Doc): string {
  if (!training && !free) return constants.doctor.DOCTOR_PROMPT
  let behavior = '',
    configuration: Doc
  if (training) {
    behavior =
      (scenarioTemplates[training.scenario.situation ?? 'first_visit'] ?? scenarioTemplates.first_visit).doctor_rule +
      '\n' +
      constants.training.DIFFICULTY_RULES[training.scenario.difficulty]
    configuration = pick(training, ['scenario', 'doctor', 'stage'])
  } else {
    configuration = free!
    behavior =
      '本次为自由沟通，不评分，不要求完成固定环节。围绕drug中的药品主题和学员原话自然交流。drug只有名称与身份信息，不是已审核医学证据；不能据此补充适应症、疗效、剂量或安全性结论。'
    if (free!.doctor.ip_profile)
      behavior += '\n沟通风格角色是虚构训练角色：' + JSON.stringify(free!.doctor.ip_profile)
    if (free!.focus) behavior += '\n本轮练习重点：' + free!.focus.label + '。' + free!.focus.goal
  }
  return (
    constants.training.DOCTOR_PREFIX +
    constants.doctor.DOCTOR_CONVERSATION +
    '\n' +
    speechInstructions(training ?? { doctor: free!.doctor }) +
    '\n情境与难度规则：\n' +
    behavior +
    '\n培训配置数据：\n' +
    JSON.stringify(configuration)
  )
}
export function validateAssessment(
  raw: Doc | undefined,
  training: Doc,
  history: Doc[],
  model: string,
): Doc {
  const normalized = new Map<string, string>()
  const normalizedText = (text: string) => {
    let value = normalized.get(text)
    if (value === undefined) {
      value = normalize(text)
      normalized.set(text, value)
    }
    return value
  }
  const errors: string[] = [],
    supplied = new Map<string, Doc>(),
    trainees = new Map(
      history.filter((m) => m.speaker === 'trainee' && m.final).map((m) => [m.id, m.text]),
    ),
    sources = new Map<string, Doc>(training.evidence.map((s: Doc) => [s.id, s]))
  const rows = Array.isArray(raw?.dimensions) && raw!.dimensions.length <= 10 ? raw!.dimensions : []
  if (!Array.isArray(raw?.dimensions) || raw!.dimensions.length > 10)
    errors.push('未收到有效的维度评价。')
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || supplied.has(row.key)) {
      errors.push('维度结构无效或重复。')
      continue
    }
    supplied.set(row.key, row)
  }
  const dimensions = training.rubric.dimensions.map((dimension: Doc) => {
    const key = dimension.key,
      row = supplied.get(key) ?? {}
    let valid = supplied.has(key),
      score = row.score ?? null,
      reason = row.reason,
      utterances: Doc[] = [],
      citations: Doc[] = []
    if (!valid) errors.push(`${key}缺少评价。`)
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 600) {
      reason = '未形成可核对的评价。'
      valid = false
    }
    if (score !== null && (!Number.isInteger(score) || score < 0 || score > 4)) {
      valid = false
      errors.push(`${key}评分超出量表。`)
    }
    if (!Array.isArray(row.utterances ?? []) || (row.utterances ?? []).length > 4) valid = false
    else
      for (const quote of row.utterances ?? []) {
        if (
          typeof quote?.quote !== 'string' ||
          quote.quote.length < 1 ||
          quote.quote.length > 600 ||
          !trainees.has(quote.message_id) ||
          !normalizedText(trainees.get(quote.message_id)).includes(normalize(quote.quote))
        ) {
          valid = false
          errors.push(`${key}学员引文无法核对。`)
        } else utterances.push(pick(quote, ['message_id', 'quote']))
      }
    if (!Array.isArray(row.citations ?? []) || (row.citations ?? []).length > 3) valid = false
    else
      for (const citation of row.citations ?? []) {
        const source = sources.get(citation?.source_id)
        if (
          !source ||
          typeof citation.quote !== 'string' ||
          citation.quote.length < 6 ||
          citation.quote.length > 500 ||
          !normalizedText(source.text).includes(normalize(citation.quote))
        ) {
          valid = false
          errors.push(`${key}资料引文无法核对。`)
        } else {
          const { text, ...metadata } = source
          citations.push({ ...metadata, quote: citation.quote })
        }
      }
    if (
      score !== null &&
      (!utterances.length || (dimension.requires_content && !citations.length))
    ) {
      valid = false
      errors.push(`${key}评分缺少原话或审核资料。`)
    }
    if (!valid) {
      score = null
      reason = '该维度的原话、资料引用或评分结构未通过校验，本轮不计分。'
    } else if (
      score === null &&
      (!utterances.length || (dimension.requires_content && !citations.length))
    )
      reason = '未观察到可由当前原话及审核资料核对的回答，本轮不评分。'
    return {
      key,
      label: dimension.label,
      weight: dimension.weight,
      score,
      reason,
      anchor: score === null ? null : dimension.anchors[score],
      utterances,
      citations,
    }
  })
  const weight = dimensions.reduce((n: number, d: Doc) => n + (d.score === null ? 0 : d.weight), 0),
    total =
      weight === 100 && !errors.length
        ? Math.round(
            dimensions.reduce((n: number, d: Doc) => n + (d.score / 4) * d.weight, 0) * 10,
          ) / 10
        : null,
    rubric = training.rubric
  return {
    evaluator_version: constants.evaluation.EVALUATOR_VERSION,
    model,
    rubric_id: rubric.id,
    rubric_name: rubric.name,
    rubric_fingerprint: sha(canonical(rubric.dimensions)),
    calibration_status:
      rubric.calibration_status === 'calibrated' &&
      rubric.calibrated_model === model &&
      rubric.calibrated_evaluator_version === constants.evaluation.EVALUATOR_VERSION
        ? 'calibrated'
        : 'uncalibrated',
    status: total !== null ? 'complete' : weight ? 'partial' : 'unavailable',
    total,
    observed_weight: weight,
    dimensions,
    validation_errors: unique(errors).slice(0, 12),
  }
}
export function applyApplicability(
  assessment: Doc,
  raw: Doc | undefined,
  candidates: string[],
  available = true,
): Doc {
  const rows = Array.isArray(raw?.dimensions) ? raw!.dimensions : [],
    decisions = new Map<string, boolean>()
  for (const row of rows.slice(0, 10))
    if (typeof row?.key === 'string' && typeof row.admissible === 'boolean') {
      if (decisions.has(row.key)) available = false
      decisions.set(row.key, row.admissible)
    }
  if (candidates.length !== decisions.size || candidates.some((key) => !decisions.has(key)))
    available = false
  for (const dimension of assessment.dimensions) {
    if (!candidates.includes(dimension.key)) continue
    if (available && decisions.get(dimension.key) === true) dimension.admissibility = 'reviewed'
    else
      Object.assign(dimension, {
        score: null,
        anchor: null,
        reason: available
          ? '当前资料未直接覆盖这个主张，不能据此判定事实准确性，本轮不评分。'
          : '资料适用性复核未完成，本维度暂不评分。',
        admissibility: available ? 'insufficient' : 'unavailable',
      })
  }
  assessment.observed_weight = assessment.dimensions.reduce(
    (n: number, d: Doc) => n + (d.score === null ? 0 : d.weight),
    0,
  )
  assessment.total =
    assessment.observed_weight === 100 && !assessment.validation_errors.length
      ? Math.round(
          assessment.dimensions.reduce((n: number, d: Doc) => n + (d.score / 4) * d.weight, 0) * 10,
        ) / 10
      : null
  assessment.status =
    assessment.total !== null ? 'complete' : assessment.observed_weight ? 'partial' : 'unavailable'
  assessment.applicability_review = available ? 'completed' : 'incomplete'
  return assessment
}
