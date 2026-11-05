import type { FastifyInstance } from 'fastify'
import { Decimal } from 'decimal.js'
import {
  type Doc,
  type User,
  assert,
  constants,
  pick,
  now,
  unique,
  canonical,
  sha,
} from './core.ts'
import { Store, Transaction, activity } from './store.ts'
import { Catalog, kinds, defaults, workspaceSettings, approvalState } from './catalog.ts'
import { parse, schemaFields } from './validation.ts'
import { prepareFree, prepareTraining, snapshot } from './training.ts'
import { route } from './http.ts'

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN })

const member = async (tx: Transaction, user: User) =>
  (await tx.get(user.workspace, 'member_state', user.id)) ?? {
    plan: [],
    completed: {},
    settings: {},
    version: 0,
  }
async function saveMember(tx: Transaction, user: User, data: Doc) {
  const body = { ...pick(data, ['plan', 'completed', 'settings']), owner_id: user.id }
  return data.version
    ? tx.update(user.workspace, 'member_state', user.id, body, data.version)
    : tx.create(user.workspace, 'member_state', body, user.id)
}
export async function prices(store: Store, user: User) {
  return store.transaction(
    user.workspace,
    async (tx) =>
      (await tx.get(user.workspace, 'settings', 'usage-prices')) ?? { version: 0, rates: [] },
    false,
  )
}
export function estimateCost(usages: Doc[], rates: Doc[]): Doc {
  const totals: Record<string, Decimal> = {},
    lines: Doc[] = [],
    missing: string[] = [],
    fields: Doc = {
      deepseek: {
        input_tokens: 'prompt_tokens',
        output_tokens: 'completion_tokens',
        search_requests: 'search_requests',
        fetch_requests: 'fetch_requests',
      },
      seedasr: { audio_seconds: 'audio_seconds' },
      'doubao-tts': { text_characters: 'submitted_characters' },
      'doubao-duplex': { input_tokens: 'input_tokens', output_tokens: 'output_tokens' },
    }
  for (const usage of usages) {
    const provider = usage.provider,
      model = usage.model,
      mapping = fields[provider] ?? {}
    if (usage.incomplete)
      missing.push(`${provider ?? '未标明服务'}部分请求未返回用量，费用尚未完整核算。`)
    if (!Object.keys(mapping).some((key) => typeof usage[mapping[key]] === 'number'))
      missing.push(`${provider ?? '未标明服务'}未记录可计价用量。`)
    for (const [unit, key] of Object.entries(mapping)) {
      const quantity = usage[key as string]
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
        if (!['search_requests', 'fetch_requests'].includes(unit))
          missing.push(`${provider} 未报告 ${unit}，无法核算该项费用。`)
        continue
      }
      if (!quantity) continue
      const rate = rates.find(
        (row) => row.provider === provider && row.model === model && row.unit === unit,
      )
      if (!rate) {
        missing.push(`${provider} / ${model ?? '未记录模型'} / ${unit} 未配置当次计价依据。`)
        continue
      }
      try {
        assert(
          new Decimal(rate.amount).isFinite() &&
            new Decimal(rate.amount).gte(0) &&
            Number.isInteger(rate.per_units) &&
            rate.per_units > 0,
          422,
          '无效计价依据。',
        )
        const amount = new Decimal(quantity).mul(rate.amount).div(rate.per_units).toDecimalPlaces(6)
        totals[rate.currency] = (totals[rate.currency] ?? new Decimal(0)).add(amount)
        lines.push({
          provider,
          model,
          unit,
          quantity: String(quantity),
          amount: amount.toFixed(6),
          currency: rate.currency,
          rate,
        })
      } catch {
        missing.push('历史计价快照损坏，此项费用无法核算。')
      }
    }
  }
  return {
    status: missing.length
      ? lines.length
        ? 'partial'
        : 'unavailable'
      : usages.length
        ? 'estimated'
        : 'unavailable',
    totals: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [key, value.toFixed(6)]),
    ),
    lines,
    missing: unique(missing.length ? missing : usages.length ? [] : ['未记录服务用量。']),
  }
}
export async function curriculum(store: Store, user: User): Promise<Doc> {
  return store.transaction(
    user.workspace,
    async (tx) => {
      const state = await member(tx, user),
        saved = await tx.list(user.workspace, 'lesson'),
        source = constants.curriculum.CURRICULUM
      const levels = source.levels.map((level: Doc) => {
        const lessons = saved
          .filter((row) => row.status === 'published' && row.level === level.level)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({
            ...row,
            state:
              row.id in state.completed
                ? 'completed'
                : state.plan.includes(row.id)
                  ? 'planned'
                  : 'none',
          }))
        return {
          ...pick(level, ['level', 'title', 'subtitle', 'summary']),
          lessons,
          completed: lessons.filter((row) => row.state === 'completed').length,
          total: lessons.length,
        }
      })
      const all = levels.flatMap((level: Doc) => level.lessons)
      return {
        levels,
        plan: state.plan
          .map((id: string) => all.find((row: Doc) => row.id === id))
          .filter(Boolean)
          .map((row: Doc) => ({ ...row, state: 'planned' })),
      }
    },
    false,
  )
}
export async function memberSettings(store: Store, user: User): Promise<Doc> {
  return store.transaction(
    user.workspace,
    async (tx) => {
      const state = await member(tx, user),
        workspace = await workspaceSettings(tx, user.workspace),
        result = { ...constants.curriculum.SETTING_DEFAULTS, ...state.settings }
      result.doctor_recommendation &&= workspace.doctor_recommendation
      return result
    },
    false,
  )
}
export async function home(store: Store, user: User): Promise<Doc> {
  const rows = (await store.records(user, null)).map(activity),
    scored = rows
      .filter((row) => row.valid && typeof row.assessment.total === 'number')
      .sort((a, b) => a.started_at.localeCompare(b.started_at)),
    source = await curriculum(store, user),
    all = source.levels.flatMap((l: Doc) => l.lessons),
    completed = all.filter((l: Doc) => l.state === 'completed'),
    current = source.levels.find((l: Doc) => l.completed < l.total) ?? source.levels.at(-1)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - 6)
  const week = scored.filter((row) => Date.parse(row.started_at) >= +start),
    last = scored.filter(
      (row) =>
        Date.parse(row.started_at) >= +start - 7 * 86400000 && Date.parse(row.started_at) < +start,
    ),
    average = (items: Doc[]) =>
      items.length
        ? Math.round(items.reduce((n, r) => n + r.assessment.total, 0) / items.length)
        : null,
    days = new Set(rows.map((row) => new Date(row.started_at).toLocaleDateString('en-CA')))
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  if (!days.has(cursor.toLocaleDateString('en-CA'))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (days.has(cursor.toLocaleDateString('en-CA'))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return {
    streak_days: streak,
    practice_days: days.size,
    session_count: rows.length,
    latest_score: scored.at(-1)?.assessment.total ?? null,
    week_average: average(week),
    week_delta: week.length && last.length ? average(week)! - average(last)! : null,
    mastery_percent: all.length ? Math.round((100 * completed.length) / all.length) : 0,
    level: {
      level: current.level,
      title: current.title,
      done: current.completed,
      total: current.total,
      remaining: current.total - current.completed,
      percent: current.total ? Math.round((100 * current.completed) / current.total) : 100,
      next_level: source.levels.find((l: Doc) => l.level > current.level)?.level ?? null,
    },
    recent: scored
      .slice(-3)
      .reverse()
      .map((row) => ({
        id: row.id,
        title: row.scenario_title ?? '自由演练',
        score: row.assessment.total,
        started_at: row.started_at,
      })),
    tasks: source.plan.slice(0, 3),
  }
}
export async function progress(store: Store, user: User, days = 30): Promise<Doc> {
  const records = (await store.records(user, null)).filter(
      (row) =>
        Date.parse(row.started_at) >= Date.now() - days * 86400000 &&
        Date.parse(row.started_at) <= Date.now(),
    ),
    sessions: Doc[] = [],
    groups = new Map<string, Doc[]>(),
    totals: Record<string, Decimal> = {}
  for (const record of records) {
    const row = activity(record),
      cost = estimateCost(record.usage ?? [], record.pricing?.rates ?? []),
      duration = (Date.parse(record.ended_at) - Date.parse(record.started_at)) / 1000
    if (
      (record.analysis_status !== 'completed' && record.analysis_status !== 'no_speech') ||
      record.capture_status !== 'completed' ||
      record.messages.some((m: Doc) => ['interrupted', 'error'].includes(m.speech_status))
    ) {
      cost.missing.push('采集、分析或语音未完整结束，部分用量可能未返回。')
      cost.status = cost.lines.length ? 'partial' : 'unavailable'
    }
    for (const [currency, value] of Object.entries(cost.totals))
      totals[currency] = (totals[currency] ?? new Decimal(0)).add(value as string)
    sessions.push({
      id: record.id,
      started_at: record.started_at,
      scenario_title: row.scenario_title,
      status: row.status,
      duration_seconds:
        Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 10) / 10 : null,
      cost,
      usage: record.usage ?? [],
      validation_only: !!record.validation_only,
    })
    const key = [
      row.training_fingerprint,
      row.stage,
      row.experience,
      row.assessment.rubric_fingerprint,
      row.assessment.model,
      row.assessment.evaluator_version,
    ]
    if (row.valid && key.every(Boolean) && !record.validation_only) {
      const bucket = groups.get(JSON.stringify(key)) ?? []
      bucket.push(row)
      groups.set(JSON.stringify(key), bucket)
    }
  }
  const results = [...groups.values()]
    .map((group) => {
      group.sort((a, b) => a.started_at.localeCompare(b.started_at))
      const first = group[0],
        last = group.at(-1)!
      return {
        scenario_title: last.scenario_title,
        stage: last.stage,
        experience: last.experience,
        attempts: group.length,
        model: last.assessment.model,
        calibration_status: last.assessment.calibration_status,
        first_record_id: first.id,
        latest_record_id: last.id,
        latest_at: last.started_at,
        comparable: group.length > 1,
        dimensions: last.assessment.dimensions.map((d: Doc) => {
          const old = first.assessment.dimensions.find((o: Doc) => o.key === d.key)?.score ?? null
          return {
            key: d.key,
            label: d.label,
            before: old,
            after: d.score,
            delta: group.length > 1 && old !== null && d.score !== null ? d.score - old : null,
          }
        }),
      }
    })
    .sort((a, b) => b.latest_at.localeCompare(a.latest_at))
  return {
    days,
    session_count: sessions.length,
    completed_count: sessions.filter((s) => s.status === 'completed').length,
    valid_practice_count: results.reduce((n, r) => n + r.attempts, 0),
    duration_seconds:
      Math.round(sessions.reduce((n, s) => n + (s.duration_seconds ?? 0), 0) * 10) / 10,
    unknown_duration_count: sessions.filter((s) => s.duration_seconds === null).length,
    cost_totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toFixed(6)])),
    unpriced_session_count: sessions.filter((s) => s.cost.status !== 'estimated').length,
    groups: results,
    sessions,
  }
}
export function registerPlatform(app: FastifyInstance, store: Store, catalog: Catalog) {
  const get = (path: string, handler: Parameters<typeof route>[4]) =>
    route(app, 'GET', path, undefined, handler)
  const put = (path: string, schema: string, handler: Parameters<typeof route>[4]) =>
    route(app, 'PUT', path, schema, handler)
  get('/api/catalog/{kind}', (u, p) => catalog.list(u, p.kind))
  get('/api/catalog/{kind}/{item_id}', (u, p) => catalog.get(u, p.kind, p.item_id))
  route(
    app,
    'POST',
    '/api/catalog/{kind}',
    undefined,
    (u, p, b) => {
      assert(kinds.includes(p.kind), 422, '目录类型无效。')
      return catalog.create(
        u,
        p.kind,
        parse(
          `platform.models.${({ policy_rule: 'PolicyRule' } as Doc)[p.kind] ?? p.kind[0].toUpperCase() + p.kind.slice(1)}`,
          b,
        ),
      )
    },
    201,
  )
  route(app, 'PUT', '/api/catalog/{kind}/{item_id}', undefined, (u, p, b) => {
    assert(kinds.includes(p.kind), 422, '目录类型无效。')
    return catalog.edit(
      u,
      p.kind,
      p.item_id,
      parse(
        `platform.models.${({ policy_rule: 'PolicyRule' } as Doc)[p.kind] ?? p.kind[0].toUpperCase() + p.kind.slice(1)}Edit`,
        b,
      ),
      Object.keys(b),
    )
  })
  get('/api/catalog/taxonomy', (u) =>
    store.transaction(
      u.workspace,
      async (tx) =>
        (await tx.list(u.workspace, 'taxonomy')).map((row) =>
          u.role === 'admin'
            ? row
            : { ...row, terms: row.terms.filter((t: Doc) => t.status === 'active') },
        ),
      false,
    ),
  )
  put('/api/catalog/taxonomy/{kind}', 'platform.models.TaxonomyEdit', (u, p, b) =>
    catalog.updateTaxonomy(u, p.kind, b),
  )
  route(app, 'DELETE', '/api/catalog/doctor/{item_id}', undefined, (u, p, _b, q) =>
    catalog.removeDoctor(u, p.item_id, q.version),
  )
  route(
    app,
    'POST',
    '/api/catalog/{kind}/{item_id}/revision',
    undefined,
    (u, p) => catalog.revision(u, p.kind, p.item_id),
    201,
  )
  route(
    app,
    'POST',
    '/api/catalog/{kind}/{item_id}/review',
    'platform.models.Transition',
    (u, p, b) => catalog.review(u, p.kind, p.item_id, b),
  )
  route(
    app,
    'POST',
    '/api/catalog/{kind}/{item_id}/publish',
    'platform.models.Publish',
    (u, p, b) => catalog.publish(u, p.kind, p.item_id, b.version),
  )
  route(app, 'POST', '/api/catalog/drug/{item_id}/retire', 'platform.models.Publish', (u, p, b) =>
    catalog.retire(u, p.item_id, b.version),
  )
  get('/api/practice/preview', (u, _p, _b, q) =>
    prepareFree(store, u, q.drug_id, q.doctor_id, q.focus),
  )
  get('/api/scenarios/{item_id}/preview', async (u, p, _b, q) =>
    snapshot(await prepareTraining(store, u, p.item_id, q.stage ?? 'full', u.role === 'admin')),
  )
  get('/api/curriculum', (u) => curriculum(store, u))
  get('/api/home', (u) => home(store, u))
  get('/api/progress', (u, _p, _b, q) => progress(store, u, q.days ?? 30))
  put('/api/curriculum/lessons/{lesson_id}', 'platform.curriculum.LessonState', async (u, p, b) => {
    const all = (await curriculum(store, u)).levels.flatMap((l: Doc) => l.lessons)
    assert(
      all.some((l: Doc) => l.id === p.lesson_id),
      404,
      '课程不存在。',
    )
    await store.transaction(u.workspace, async (tx) => {
      const state = await member(tx, u)
      state.plan = state.plan.filter((id: string) => id !== p.lesson_id)
      if (b.state === 'planned') {
        state.plan.push(p.lesson_id)
        delete state.completed[p.lesson_id]
      } else if (b.state === 'completed') state.completed[p.lesson_id] = now()
      else delete state.completed[p.lesson_id]
      await saveMember(tx, u, state)
    })
    return curriculum(store, u)
  })
  get('/api/me/settings', (u) => memberSettings(store, u))
  put('/api/me/settings', 'platform.curriculum.SettingsEdit', async (u, _p, b) => {
    await store.transaction(u.workspace, async (tx) => {
      assert(
        b.doctor_recommendation !== true ||
          (await workspaceSettings(tx, u.workspace)).doctor_recommendation,
        409,
        '管理员已关闭工作区医生推荐，暂时无法启用。',
      )
      const state = await member(tx, u)
      Object.assign(
        state.settings,
        Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null)),
      )
      await saveMember(tx, u, state)
    })
    return memberSettings(store, u)
  })
  get('/api/me/review-queue', (u) =>
    store.transaction(
      u.workspace,
      async (tx) => {
        const items: Doc[] = []
        for (const kind of ['visit', 'case'])
          for (const row of await tx.list(u.workspace, kind))
            if (!u.authenticated || (kind === 'visit' ? row.owner_id : row.created_by) === u.id)
              items.push({
                id: row.id,
                kind,
                type: kind === 'visit' ? '拜访记录' : '案例',
                title: row.title || '拜访记录',
                status: row.status,
                status_label:
                  (
                    {
                      draft: '草稿',
                      submitted: '待审核',
                      reviewed: '已审核',
                      confirmed: '已确认',
                    } as Doc
                  )[row.status] ?? '处理中',
                updated_at: row.updated_at,
              })
        return {
          pending: items.filter((row) => row.status === 'submitted').length,
          items: items.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50),
        }
      },
      false,
    ),
  )
  get('/api/usage/prices', (u) => prices(store, u))
  put('/api/usage/prices', 'platform.progress.Prices', (u, _p, b) =>
    store.transaction(u.workspace, async (tx) => {
      assert(
        unique(b.rates.map((r: Doc) => `${r.provider}:${r.model}:${r.unit}`)).length ===
          b.rates.length,
        422,
        '同一服务、模型和计量单位不能重复配置。',
      )
      assert(
        b.rates.every(
          (r: Doc) =>
            r.checked_on <= now().slice(0, 10) &&
            new Decimal(r.amount).isFinite() &&
            new Decimal(r.amount).gte(0) &&
            new Decimal(r.amount).decimalPlaces() <= 8,
        ),
        422,
        '计价金额或核对日期无效。',
      )
      const old = await tx.get(u.workspace, 'settings', 'usage-prices')
      assert(old || b.version === 0, 409, '计价配置已变化，请刷新后重试。')
      const item = old
        ? await tx.update(u.workspace, 'settings', old.id, { ...old, rates: b.rates }, b.version)
        : await tx.create(u.workspace, 'settings', { rates: b.rates }, 'usage-prices')
      await tx.audit(u, 'pricing.save', 'settings', item.id)
      return item
    }),
  )
  registerAdmin(app, store)
  registerHealth(app, store)
  registerSharing(app, store)
}

function registerAdmin(app: FastifyInstance, store: Store) {
  const accounts = (u: User) => (store.config.admins.length ? store.config.admins : [u.id])
  route(app, 'GET', '/api/admin/settings', undefined, (u) =>
    store.transaction(
      u.workspace,
      async (tx) => ({
        ...(await workspaceSettings(tx, u.workspace)),
        administrators: accounts(u),
      }),
      false,
    ),
  )
  route(app, 'PUT', '/api/admin/settings', 'platform.management.WorkspaceSettings', (u, _p, b) =>
    store.transaction(u.workspace, async (tx) => {
      const available = accounts(u)
      assert(
        [...b.medical_reviewers, ...b.compliance_reviewers].every((v) => available.includes(v)),
        422,
        '审核人必须为已配置的管理员账号。',
      )
      assert(
        !Object.values(b.review_rules).includes('two_admins') || available.length >= 2,
        422,
        '双人审核需要至少两个管理员账号。',
      )
      assert(
        !Object.values(b.review_rules).includes('medical_compliance') ||
          b.medical_reviewers.some((a: string) =>
            b.compliance_reviewers.some((c: string) => a !== c),
          ),
        422,
        '医学与合规审核需分配不同的管理员。',
      )
      const old = await workspaceSettings(tx, u.workspace)
      assert(old.version === b.version, 409, '设置已更新，请刷新后重试。')
      const { version, ...data } = b,
        item = version
          ? await tx.update(u.workspace, 'workspace_settings', 'admin', data, version)
          : await tx.create(u.workspace, 'workspace_settings', data, 'admin')
      await tx.audit(u, 'settings.update', 'workspace_settings', 'admin', { version: item.version })
      return { ...pick(item, Object.keys(defaults)), administrators: available }
    }),
  )
  route(app, 'GET', '/api/admin/versions', undefined, (u) =>
    store.transaction(
      u.workspace,
      async (tx) => {
        const result: Doc[] = []
        for (const kind of ['content', 'drug', 'doctor', 'rubric', 'scenario', 'policy', 'lesson'])
          for (const row of await tx.list(u.workspace, kind))
            if (!['deleted', 'archived'].includes(row.status))
              result.push({
                kind,
                ...pick(row, [
                  'id',
                  'name',
                  'title',
                  'display_name',
                  'version',
                  'version_label',
                  'status',
                  'updated_at',
                  'created_by',
                  'published_by',
                  'approved_by',
                ]),
              })
        return result
      },
      false,
    ),
  )
  route(app, 'GET', '/api/admin/catalog/{kind}/{item_id}/history', undefined, (u, p) =>
    store.transaction(
      u.workspace,
      async (tx) => {
        const old = await tx.require(u.workspace, p.kind, p.item_id),
          series = old.series_id ?? old.id
        return [
          ...(await tx.list(u.workspace, p.kind)).filter(
            (r) =>
              r.id === p.item_id ||
              (r.series_id ?? r.id) === series ||
              r[`${p.kind}_id`] === p.item_id,
          ),
          ...(await tx.list(u.workspace, `${p.kind}_history`)).filter(
            (r) => r[`${p.kind}_id`] === p.item_id,
          ),
        ]
      },
      false,
    ),
  )
  route(app, 'GET', '/api/admin/catalog/{kind}/{item_id}/approval', undefined, (u, p) =>
    store.transaction(
      u.workspace,
      async (tx) =>
        approvalState(tx, u.workspace, p.kind, await tx.require(u.workspace, p.kind, p.item_id)),
      false,
    ),
  )
  route(
    app,
    'POST',
    '/api/admin/catalog/{kind}/{item_id}/approval',
    'platform.management.Approval',
    (u, p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const item = await tx.require(u.workspace, p.kind, p.item_id),
          config = await workspaceSettings(tx, u.workspace)
        assert(
          item.version === b.version &&
            config.version === b.settings_version &&
            ['draft', 'submitted'].includes(item.status),
          409,
          '内容或审核设置已更新，请刷新后重试。',
        )
        assert(
          b.role === 'admin' || config[`${b.role}_reviewers`].includes(u.id),
          403,
          '当前账号未分配此审核职责。',
        )
        const state = await approvalState(tx, u.workspace, p.kind, item),
          old = await tx.get(u.workspace, 'publication_approval', state.key),
          votes = [
            ...state.votes.filter((v: Doc) => v.actor !== u.id),
            { actor: u.id, role: b.role, reason: b.reason, decision: b.decision, at: now() },
          ]
        if (old)
          await tx.update(u.workspace, 'publication_approval', state.key, { votes }, old.version)
        else await tx.create(u.workspace, 'publication_approval', { votes }, state.key)
        await tx.audit(u, 'publication.approve', p.kind, item.id, {
          version: b.version,
          role: b.role,
        })
        return approvalState(tx, u.workspace, p.kind, item)
      }),
  )
  route(app, 'GET', '/api/admin/audience-metrics', undefined, async (u) => {
    const rows = (await store.records(undefined, null))
        .filter((r) => r.workspace === u.workspace)
        .map(activity),
      valid = rows.filter((r) => r.valid && typeof r.assessment.total === 'number'),
      dimensions = new Map<string, Doc>()
    for (const r of valid)
      for (const d of r.assessment.dimensions)
        if (typeof d.score === 'number') {
          const bucket = dimensions.get(d.key) ?? { label: d.label, values: [] }
          bucket.values.push(d.score)
          dimensions.set(d.key, bucket)
        }
    await store.transaction(u.workspace, (tx) => tx.audit(u, 'audience.metrics', 'session', '*'))
    return {
      sessions: rows.length,
      participants: unique(rows.map((r) => r.owner_id).filter(Boolean)).length,
      scored_sessions: valid.length,
      average_score: valid.length
        ? Math.round((valid.reduce((n, r) => n + r.assessment.total, 0) / valid.length) * 10) / 10
        : null,
      dimensions: [...dimensions].map(([key, d]) => ({
        key,
        label: d.label,
        average:
          Math.round(
            (d.values.reduce((a: number, b: number) => a + b, 0) / d.values.length) * 100,
          ) / 100,
        count: d.values.length,
      })),
      updated_at: now(),
      scope: '当前工作区全部有效评分记录；维度满分 4 分，不代表医学能力认证',
    }
  })
  route(app, 'GET', '/api/admin/sessions', undefined, async (u) => {
    const rows = (await store.records(undefined, null))
      .filter((row) => row.workspace === u.workspace)
      .slice(0, 50)
    await store.transaction(u.workspace, (tx) => tx.audit(u, 'session.admin_list', 'session', '*'))
    return rows.map((row) => ({
      ...pick(row, [
        'id',
        'experience',
        'mode',
        'started_at',
        'ended_at',
        'status',
        'owner_id',
        'doctor',
      ]),
      message_count: row.messages.length,
      scenario_title: row.training?.scenario?.title ?? null,
    }))
  })
  route(app, 'GET', '/api/admin/sessions/{session_id}', undefined, async (u, p) => {
    const row = await store.record(p.session_id)
    assert(row?.workspace === u.workspace, 404, '记录不存在。')
    await store.transaction(u.workspace, (tx) =>
      tx.audit(u, 'session.admin_read', 'session', p.session_id),
    )
    return row
  })
}

function registerHealth(app: FastifyInstance, store: Store) {
  const own = async (tx: Transaction, u: User, id: string) => {
    const row = await tx.require(u.workspace, 'health_observation', id)
    assert(row.owner_id === u.id, 404, '观察记录不存在。')
    return row
  }
  route(app, 'GET', '/api/health/observations', undefined, (u) =>
    store.transaction(
      u.workspace,
      async (tx) =>
        (await tx.list(u.workspace, 'health_observation')).filter((row) => row.owner_id === u.id),
      false,
    ),
  )
  route(
    app,
    'POST',
    '/api/health/observations',
    'platform.health.Observation',
    (u, _p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const item = await tx.create(u.workspace, 'health_observation', {
          ...b,
          owner_id: u.id,
          status: 'private',
          consent: false,
          source: 'manual',
        })
        await tx.audit(u, 'health.create', 'health_observation', item.id)
        return item
      }),
    201,
  )
  route(
    app,
    'POST',
    '/api/health/observations/{item_id}/consent',
    'platform.health.Consent',
    (u, p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const old = await own(tx, u, p.item_id)
        assert(
          (await workspaceSettings(tx, u.workspace)).health_sharing,
          409,
          '工作区尚未开启共享，个人记录仍可保存和撤回。',
        )
        assert(
          ['private', 'revoked', 'rejected'].includes(old.status),
          409,
          '记录已提交，请刷新查看状态。',
        )
        const item = await tx.update(
          u.workspace,
          'health_observation',
          old.id,
          {
            ...old,
            consent: true,
            consented_at: now(),
            status: 'submitted',
            reviewed_by: null,
            review_reason: null,
          },
          b.version,
        )
        await tx.audit(u, 'health.consent', 'health_observation', old.id)
        return item
      }),
  )
  route(
    app,
    'POST',
    '/api/health/observations/{item_id}/revoke',
    'platform.health.Version',
    (u, p) =>
      store.transaction(u.workspace, async (tx) => {
        const old = await own(tx, u, p.item_id),
          item = await tx.update(
            u.workspace,
            'health_observation',
            old.id,
            { ...old, consent: false, status: 'revoked', revoked_at: now() },
            old.version,
          )
        await tx.audit(u, 'health.revoke', 'health_observation', old.id)
        return item
      }),
  )
  route(app, 'GET', '/api/admin/health/observations', undefined, (u) =>
    store.transaction(u.workspace, async (tx) => {
      await tx.audit(u, 'health.review_list', 'health_observation', '*')
      return (await tx.list(u.workspace, 'health_observation')).filter(
        (row) => row.consent && ['submitted', 'approved'].includes(row.status),
      )
    }),
  )
  route(
    app,
    'POST',
    '/api/admin/health/observations/{item_id}/review',
    'platform.health.HealthReview',
    (u, p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const old = await tx.get(u.workspace, 'health_observation', p.item_id)
        assert(old?.consent && old.status === 'submitted', 409, '记录已变更或授权已撤回，请刷新。')
        assert(old.owner_id !== u.id, 403, '请由另一位管理员审核本人提交的记录。')
        const item = await tx.update(
          u.workspace,
          'health_observation',
          old.id,
          {
            ...old,
            status: b.decision === 'approve' ? 'approved' : 'rejected',
            reviewed_by: u.id,
            reviewed_at: now(),
            review_reason: b.reason,
          },
          b.version,
        )
        await tx.audit(u, 'health.' + b.decision, 'health_observation', old.id)
        return item
      }),
  )
  route(app, 'GET', '/api/health/shared', undefined, (u) =>
    store.transaction(u.workspace, async (tx) => {
      const enabled = (await workspaceSettings(tx, u.workspace)).health_sharing,
        items = enabled
          ? (await tx.list(u.workspace, 'health_observation'))
              .filter((row) => row.consent && row.status === 'approved')
              .map((row) =>
                pick(row, [
                  'id',
                  'metric',
                  'value',
                  'unit',
                  'observed_at',
                  'conditions',
                  'limitations',
                  'source',
                  'reviewed_at',
                ]),
              )
          : []
      await tx.audit(u, 'health.shared_list', 'health_observation', '*')
      return { enabled, items }
    }),
  )
}

function registerSharing(app: FastifyInstance, store: Store) {
  route(
    app,
    'POST',
    '/api/content/import',
    'platform.importer.Batch',
    (u, _p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const digest = sha(canonical(b)),
          old = await tx.get(u.workspace, 'import_receipt', digest)
        if (old) return { ...old, reused: true }
        const ids: string[] = []
        for (const doc of b.documents) {
          const { previous_id, ...data } = doc,
            previous = previous_id ? await tx.require(u.workspace, 'content', previous_id) : null
          if (data.asset_id) await tx.require(u.workspace, 'asset', data.asset_id)
          const item = await tx.create(u.workspace, 'content', {
            ...data,
            status: 'draft',
            created_by: u.id,
            ...(previous
              ? { previous_id: previous.id, series_id: previous.series_id ?? previous.id }
              : {}),
          })
          if (!previous)
            await tx.update(
              u.workspace,
              'content',
              item.id,
              { ...item, series_id: item.id },
              item.version,
            )
          ids.push(item.id)
        }
        const receipt = await tx.create(
          u.workspace,
          'import_receipt',
          { document_ids: ids, created_by: u.id },
          digest,
        )
        await tx.audit(u, 'content.import', 'import_receipt', digest, { count: ids.length })
        return { ...receipt, reused: false }
      }),
    201,
  )
  route(app, 'GET', '/api/scenarios/{item_id}/export', undefined, async (u, p) => {
    const training = await prepareTraining(store, u, p.item_id, 'full', true)
    return parse('platform.sharing.TrainingTemplate', {
      schema_version: 1,
      doctor: schemaFields('platform.models.Doctor', training.doctor),
      rubric: schemaFields('platform.models.Rubric', training.rubric),
      documents: training.documents.map((d: Doc) => ({
        ...schemaFields('platform.models.Content', d),
        key: d.id,
        asset_id: null,
      })),
      scenario: {
        ...schemaFields('platform.models.Scenario', training.scenario),
        doctor_id: training.doctor.id,
        rubric_id: training.rubric.id,
        content_ids: training.documents.map((d: Doc) => d.id),
      },
    })
  })
  route(
    app,
    'POST',
    '/api/scenarios/import',
    'platform.sharing.TrainingTemplate',
    (u, _p, b) =>
      store.transaction(u.workspace, async (tx) => {
        const digest = sha(JSON.stringify(b)),
          old = await tx.get(u.workspace, 'template_receipt', digest)
        if (old) return { ...old, reused: true }
        const doctor = await tx.create(u.workspace, 'doctor', {
            ...b.doctor,
            display_name: b.doctor.name + '（训练模拟）',
            status: 'draft',
            created_by: u.id,
            imported: true,
          }),
          rubric = await tx.create(u.workspace, 'rubric', {
            ...b.rubric,
            status: 'draft',
            calibration_status: 'uncalibrated',
            created_by: u.id,
            imported: true,
          }),
          documents: Doc = {}
        for (const d of b.documents) {
          const { key, ...data } = d,
            item = await tx.create(u.workspace, 'content', {
              ...data,
              status: 'draft',
              created_by: u.id,
              imported: true,
            })
          await tx.update(
            u.workspace,
            'content',
            item.id,
            { ...item, series_id: item.id },
            item.version,
          )
          documents[key] = item.id
        }
        const scene = await tx.create(u.workspace, 'scenario', {
            ...b.scenario,
            doctor_id: doctor.id,
            rubric_id: rubric.id,
            content_ids: b.scenario.content_ids.map((id: string) => documents[id]),
            status: 'draft',
            created_by: u.id,
            imported: true,
          }),
          receipt = await tx.create(
            u.workspace,
            'template_receipt',
            {
              scenario_id: scene.id,
              doctor_id: doctor.id,
              rubric_id: rubric.id,
              document_ids: Object.values(documents),
              created_by: u.id,
            },
            digest,
          )
        await tx.audit(u, 'scenario.import', 'scenario', scene.id)
        return { ...receipt, reused: false }
      }),
    201,
  )
}
