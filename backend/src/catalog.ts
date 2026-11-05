import { type Doc, type User, assert, now, resource, pick, unique } from './core.ts'
import { Store, Transaction } from './store.ts'
import { usable, policyUsable, withDepartments, matchDepartment } from './validation.ts'

export const kinds = [
  'lesson',
  'audience',
  'content',
  'policy',
  'policy_rule',
  'drug',
  'doctor',
  'rubric',
  'scenario',
]
export const taxonomyFields: Doc = {
  category: 'category',
  disease: 'diseases',
  mechanism: 'mechanism',
  dosage_form: 'dosage_form',
  region: 'regions',
}
export const terms = (drug: Doc, key: string): string[] =>
  Array.isArray(drug[key]) ? drug[key] : drug[key] ? [drug[key]] : []
export const defaults: Doc = {
  version: 0,
  doctor_recommendation: true,
  training_scoring: true,
  health_sharing: false,
  review_rules: {
    drug: 'admin',
    doctor: 'admin',
    content: 'admin',
    scenario: 'admin',
    lesson: 'admin',
  },
  medical_reviewers: [],
  compliance_reviewers: [],
}
export async function workspaceSettings(tx: Transaction, tenant: string): Promise<Doc> {
  const row = await tx.get(tenant, 'workspace_settings', 'admin')
  return row ? pick(row, Object.keys(defaults)) : structuredClone(defaults)
}
export async function approvalState(
  tx: Transaction,
  tenant: string,
  kind: string,
  item: Doc,
): Promise<Doc> {
  const config = await workspaceSettings(tx, tenant),
    mode = config.review_rules[kind] ?? 'admin',
    key = `${kind}:${item.id}:${item.version}:${config.version}`
  const votes = (await tx.get(tenant, 'publication_approval', key))?.votes ?? [],
    approved = votes.filter((v: Doc) => (v.decision ?? 'approve') === 'approve')
  const medical = approved
    .filter((v: Doc) => v.role === 'medical' && config.medical_reviewers.includes(v.actor))
    .map((v: Doc) => v.actor)
  const compliance = approved
    .filter((v: Doc) => v.role === 'compliance' && config.compliance_reviewers.includes(v.actor))
    .map((v: Doc) => v.actor)
  return {
    key,
    mode,
    votes,
    settings_version: config.version,
    ready:
      !votes.some((v: Doc) => v.decision === 'reject') &&
      (mode === 'admin' ||
        (mode === 'two_admins' && unique(approved.map((v: Doc) => v.actor)).length >= 2) ||
        (mode === 'medical_compliance' &&
          medical.length > 0 &&
          compliance.length > 0 &&
          unique([...medical, ...compliance]).length > 1)),
  }
}
export async function requireApproval(tx: Transaction, tenant: string, kind: string, item: Doc) {
  assert(
    (await approvalState(tx, tenant, kind, item)).ready,
    409,
    '本版本尚未满足发布审核规则，请先完成双人或医学/合规审核。',
  )
}
export class Catalog {
  constructor(readonly store: Store) {}
  async seed() {
    const tenant = this.store.workspace,
      seeds = resource('seeds')
    await this.store.transaction(tenant, async (tx) => {
      for (const [kind, rows] of Object.entries(seeds))
        for (const row of rows as Doc[]) {
          if (await tx.get(tenant, kind, row.id)) continue
          const data = { ...row }
          for (const key of [
            'id',
            'version',
            'created_at',
            'updated_at',
            'usable',
            'practice_department',
            'any_drug',
          ])
            delete data[key]
          await tx.create(tenant, kind, data, row.id)
        }
      const drugs = await tx.list(tenant, 'drug')
      for (const [kind, field] of Object.entries(taxonomyFields)) {
        const item = await tx.get(tenant, 'taxonomy', kind)
        if (item) {
          const known = item.terms.map((t: Doc) => t.value),
            missing = unique(drugs.flatMap((drug) => terms(drug, field as string))).filter(
              (v) => !known.includes(v),
            )
          if (missing.length)
            await tx.update(
              tenant,
              'taxonomy',
              kind,
              {
                ...item,
                terms: [
                  ...item.terms,
                  ...missing.sort().map((value) => ({ value, status: 'pending' })),
                ],
              },
              item.version,
            )
        }
      }
    })
  }
  async list(user: User, kind: string) {
    assert(kinds.includes(kind), 422, '目录类型无效。')
    return this.store.transaction(
      user.workspace,
      async (tx) =>
        (await tx.list(user.workspace, kind))
          .filter((row) => !['deleted', 'archived'].includes(row.status))
          .filter(
            (row) =>
              user.role === 'admin' ||
              (['content', 'policy'].includes(kind)
                ? kind === 'policy'
                  ? policyUsable(row)
                  : usable(row)
                : row.status === 'published'),
          )
          .map((row) => {
            if (['content', 'policy'].includes(kind)) {
              const { pages, ...rest } = row
              return { ...rest, usable: kind === 'policy' ? policyUsable(row) : usable(row) }
            }
            return withDepartments(kind, row)
          }),
      false,
    )
  }
  async get(user: User, kind: string, id: string) {
    assert(kinds.includes(kind), 422, '目录类型无效。')
    return this.store.transaction(
      user.workspace,
      async (tx) => {
        const row = await tx.require(user.workspace, kind, id)
        assert(
          user.role === 'admin' ||
            (['content', 'policy'].includes(kind)
              ? kind === 'policy'
                ? policyUsable(row)
                : usable(row)
              : row.status === 'published'),
          404,
          '记录不存在。',
        )
        return withDepartments(kind, row)
      },
      false,
    )
  }
  async validateTerms(
    tx: Transaction,
    tenant: string,
    data: Doc,
    old: Doc = {},
    publishing = false,
  ) {
    for (const [kind, field] of Object.entries(taxonomyFields)) {
      const taxonomy = await tx.require(tenant, 'taxonomy', kind),
        allowed = [
          ...taxonomy.terms.filter((t: Doc) => t.status === 'active').map((t: Doc) => t.value),
          ...(publishing ? [] : terms(old, field as string)),
        ]
      assert(
        terms(data, field as string).every((value) => allowed.includes(value)),
        422,
        '药品分类须选择已启用的词条；原有待核验词条可保留至审核。',
      )
    }
  }
  async bindings(tx: Transaction, tenant: string, data: Doc, publishing: boolean) {
    const doctor = await tx.require(tenant, 'doctor', data.doctor_id),
      rubric = await tx.require(tenant, 'rubric', data.rubric_id)
    assert(
      !publishing || (doctor.status === 'published' && rubric.status === 'published'),
      409,
      '场景绑定的医生和量表必须先发布。',
    )
    for (const id of data.content_ids) {
      const item = await tx.require(tenant, 'content', id)
      assert(!publishing || usable(item), 409, '场景包含未审核、过期或停用资料。')
    }
    for (const id of [data.drug_id, data.competitor_id].filter(Boolean)) {
      const item = await tx.require(tenant, 'drug', id)
      assert(!publishing || item.status === 'published', 409, '场景药品必须先发布。')
      if (id === data.drug_id) matchDepartment(item, doctor)
    }
    for (const id of data.policy_ids ?? []) {
      const item = await tx.require(tenant, 'policy', id)
      assert(!publishing || policyUsable(item), 409, '场景政策必须先审核并有效。')
    }
  }
  async create(user: User, kind: string, body: Doc) {
    return this.store.transaction(user.workspace, async (tx) => {
      const data: Doc = { ...body, status: 'draft', created_by: user.id }
      if (kind === 'doctor') data.display_name = data.name + '（训练模拟）'
      if (kind === 'rubric') data.calibration_status = 'uncalibrated'
      let research: Doc | null = null
      if (kind === 'doctor' && body.research_job_id) {
        research = await tx.require(user.workspace, 'research_job', body.research_job_id)
        assert(!research.doctor_id, 409, '本次画像草稿已保存，请打开已有医生角色继续编辑。')
        assert(
          research.kind === 'doctor' &&
            ['completed', 'partial'].includes(research.status) &&
            research.doctor_draft,
          409,
          '本次检索尚无可保存的医生画像草稿。',
        )
        Object.assign(data, {
          research_evidence: research.doctor_evidence ?? [],
          identity_confirmed_by: user.id,
          identity_confirmed_at: now(),
          research_evidence_review_required: [
            'name',
            'hospital',
            'professional_title',
            'specialty',
            'public_facts',
            'sources',
            'honors',
          ].some(
            (key) => JSON.stringify(data[key]) !== JSON.stringify(research!.doctor_draft[key]),
          ),
        })
      }
      if (['content', 'policy'].includes(kind) && data.asset_id)
        await tx.require(user.workspace, 'asset', data.asset_id)
      if (kind === 'drug') await this.validateTerms(tx, user.workspace, data)
      if (kind === 'scenario') await this.bindings(tx, user.workspace, data, false)
      let item = await tx.create(user.workspace, kind, data)
      if (research)
        await tx.update(
          user.workspace,
          'research_job',
          research.id,
          { ...research, doctor_id: item.id },
          research.version,
        )
      if (['content', 'policy'].includes(kind))
        item = await tx.update(
          user.workspace,
          kind,
          item.id,
          { ...item, series_id: item.id },
          item.version,
        )
      await tx.audit(user, `${kind}.create`, kind, item.id)
      return withDepartments(kind, item)
    })
  }
  async edit(user: User, kind: string, id: string, body: Doc, provided = Object.keys(body)) {
    return this.store.transaction(user.workspace, async (tx) => {
      const old = await tx.require(user.workspace, kind, id)
      assert(
        (['content', 'policy'].includes(kind) ? ['draft', 'rejected'] : ['draft']).includes(
          old.status,
        ),
        409,
        '只能编辑草稿；已发布内容请创建新版本。',
      )
      const { version, ...data } = body
      if (kind === 'policy')
        assert(
          !old.text_is_summary ||
            data.text_is_summary ||
            JSON.stringify(data.pages) !== JSON.stringify(old.pages),
          409,
          '请先将目录摘要替换为政策原文。',
        )
      if (['content', 'policy'].includes(kind) && data.asset_id)
        await tx.require(user.workspace, 'asset', data.asset_id)
      if (kind === 'doctor') {
        data.display_name = data.name + '（训练模拟）'
        if (!provided.includes('honors')) data.honors = old.honors ?? []
        data.research_job_id = old.research_job_id
        if (
          old.research_evidence &&
          [
            'name',
            'hospital',
            'professional_title',
            'specialty',
            'public_facts',
            'sources',
            'honors',
          ].some((key) => JSON.stringify(data[key]) !== JSON.stringify(old[key]))
        )
          data.research_evidence_review_required = true
      }
      if (kind === 'scenario') await this.bindings(tx, user.workspace, data, false)
      if (kind === 'drug') await this.validateTerms(tx, user.workspace, data, old)
      const item = await tx.update(
        user.workspace,
        kind,
        id,
        { ...old, ...data, status: 'draft' },
        version,
      )
      await tx.audit(user, `${kind}.edit`, kind, id)
      return withDepartments(kind, item)
    })
  }
  async revision(user: User, kind: string, id: string) {
    return this.store.transaction(user.workspace, async (tx) => {
      const old = await tx.require(user.workspace, kind, id)
      if (['doctor', 'drug', 'lesson'].includes(kind))
        assert(
          old.status === 'published' && !old[`${kind}_id`],
          409,
          '只能为已发布内容创建新草稿。',
        )
      const data: Doc = {
        ...old,
        status: 'draft',
        created_by: user.id,
        previous_id: old.id,
        series_id: old.series_id ?? old.id,
      }
      for (const key of [
        'id',
        'version',
        'created_at',
        'updated_at',
        'approved_by',
        'approved_at',
        'review_reason',
      ])
        delete data[key]
      if (['doctor', 'drug', 'lesson'].includes(kind))
        Object.assign(data, { [`${kind}_id`]: old.id, base_version: old.version })
      if (kind === 'rubric') data.calibration_status = 'uncalibrated'
      const item = await tx.create(user.workspace, kind, data)
      await tx.audit(user, `${kind}.revision`, kind, item.id, { previous_id: id })
      return withDepartments(kind, item)
    })
  }
  async review(user: User, kind: string, id: string, body: Doc) {
    return this.store.transaction(user.workspace, async (tx) => {
      const old = await tx.require(user.workspace, kind, id),
        action = body.action
      const expected: Doc = {
        submit: ['draft', 'rejected'],
        approve: ['submitted'],
        reject: ['submitted'],
        retire: ['approved'],
      }
      assert(expected[action]?.includes(old.status), 409, '资料状态已改变，请刷新后重试。')
      if (action === 'approve') {
        assert(
          !old.expires_at || Date.parse(old.expires_at) > Date.now(),
          409,
          '资料已过期，不能审核通过。',
        )
        assert(
          kind !== 'policy' || !old.text_is_summary,
          409,
          '目录摘要不是政策原文，请先导入原文并核对。',
        )
        await requireApproval(tx, user.workspace, kind, old)
      }
      const status = (
        { submit: 'submitted', approve: 'approved', reject: 'rejected', retire: 'retired' } as Doc
      )[action]
      const item = await tx.update(
        user.workspace,
        kind,
        id,
        {
          ...old,
          status,
          review_reason: body.reason,
          ...(action === 'approve' ? { approved_by: user.id, approved_at: now() } : {}),
        },
        body.version,
      )
      await tx.audit(user, `${kind}.${action}`, kind, id, { reason: body.reason })
      return item
    })
  }
  async publish(user: User, kind: string, id: string, version: number) {
    return this.store.transaction(user.workspace, async (tx) => {
      let old = await tx.require(user.workspace, kind, id)
      assert(old.status === 'draft', 409, '只能发布草稿。')
      await requireApproval(tx, user.workspace, kind, old)
      if (kind === 'scenario') await this.bindings(tx, user.workspace, old, true)
      if (kind === 'lesson') {
        assert(!old.unverified_figures, 409, '请核实课程内容与来源后再发布。')
        if (old.action?.kind === 'practice')
          assert(
            (await tx.require(user.workspace, 'doctor', old.action.ip_id)).status === 'published',
            409,
            '课程需要绑定已发布医生。',
          )
      }
      if (kind === 'doctor')
        for (const evidence of old.fact_evidence ?? []) {
          const source = await tx.get(user.workspace, 'content', evidence.content_id),
            page = source?.pages.find((p: Doc) => p.number === evidence.page)
          assert(
            usable(source) &&
              source!.version === evidence.content_version &&
              source!.source_url === evidence.source_url &&
              page?.text.includes(evidence.quote) &&
              old.public_facts.includes(evidence.quote),
            409,
            '医生画像引用的审核资料已变更或不可用，请重新核对。',
          )
        }
      if (kind === 'policy_rule') {
        const policy = await tx.require(user.workspace, 'policy', old.policy_id)
        assert(
          policyUsable(policy) && policy.pages.some((p: Doc) => p.text.includes(old.quote)),
          409,
          '规则需要引用已审核、有效政策的原文。',
        )
        assert(old.action !== 'pause' || old.risk === 'high', 409, '只有高风险规则可以暂停训练。')
        old = { ...old, policy_version: policy.version, runtime_enforced: true }
      }
      if (kind === 'drug') {
        await this.validateTerms(tx, user.workspace, old, {}, true)
        assert(
          ['company', 'competitor'].includes(old.ownership),
          409,
          '发布药品前请确认本公司产品或竞品归属。',
        )
        for (const content of old.content_ids)
          assert(
            usable(await tx.require(user.workspace, 'content', content)),
            409,
            '药品关联资料必须先审核。',
          )
        for (const relation of old.comparisons) {
          assert(![id, old.drug_id].includes(relation.drug_id), 409, '药品不能与自身建立同类关系。')
          await tx.require(user.workspace, 'drug', relation.drug_id)
        }
      }
      let item: Doc
      const stable = ['doctor', 'drug', 'lesson'].includes(kind) && old[`${kind}_id`]
      if (stable) {
        const current = await tx.require(user.workspace, kind, stable)
        assert(current.version === old.base_version, 409, '内容已更新，请重新创建草稿。')
        await tx.create(user.workspace, `${kind}_history`, {
          ...current,
          [`${kind}_id`]: stable,
          source_version: current.version,
        })
        const changes = { ...old }
        for (const key of [
          'id',
          'version',
          'created_at',
          'updated_at',
          `${kind}_id`,
          'base_version',
          'previous_id',
          'series_id',
        ])
          delete changes[key]
        item = await tx.update(
          user.workspace,
          kind,
          stable,
          {
            ...current,
            ...changes,
            status: 'published',
            published_by: user.id,
            published_at: now(),
          },
          current.version,
        )
        await tx.update(user.workspace, kind, id, { ...old, status: 'archived' }, version)
      } else
        item = await tx.update(
          user.workspace,
          kind,
          id,
          { ...old, status: 'published', published_by: user.id, published_at: now() },
          version,
        )
      await tx.audit(user, `${kind}.publish`, kind, item.id, stable ? { draft_id: id } : {})
      return withDepartments(kind, item)
    })
  }
  async removeDoctor(user: User, id: string, version: number) {
    return this.store.transaction(user.workspace, async (tx) => {
      const old = await tx.require(user.workspace, 'doctor', id)
      assert(
        !(await tx.list(user.workspace, 'scenario')).some((row) => row.doctor_id === id),
        409,
        '医生仍被训练场景使用，请先更换场景中的医生。',
      )
      await tx.update(user.workspace, 'doctor', id, { ...old, status: 'deleted' }, version)
      if (old.research_job_id) {
        const job = await tx.get(user.workspace, 'research_job', old.research_job_id)
        if (job?.doctor_id === id)
          await tx.update(
            user.workspace,
            'research_job',
            job.id,
            { ...job, doctor_id: null },
            job.version,
          )
      }
      await tx.audit(user, 'doctor.delete', 'doctor', id)
      return { id }
    })
  }
  async retire(user: User, id: string, version: number) {
    return this.store.transaction(user.workspace, async (tx) => {
      const old = await tx.require(user.workspace, 'drug', id)
      assert(old.status === 'published', 409, '只能停用已发布的药品。')
      const item = await tx.update(
        user.workspace,
        'drug',
        id,
        { ...old, status: 'retired' },
        version,
      )
      await tx.audit(user, 'drug.retire', 'drug', id)
      return item
    })
  }
  async updateTaxonomy(user: User, kind: string, body: Doc) {
    assert(kind in taxonomyFields, 422, '分类类型无效。')
    return this.store.transaction(user.workspace, async (tx) => {
      const old = await tx.require(user.workspace, 'taxonomy', kind),
        active = body.terms.filter((t: Doc) => t.status === 'active').map((t: Doc) => t.value),
        removed = old.terms
          .filter((t: Doc) => t.status === 'active' && !active.includes(t.value))
          .map((t: Doc) => t.value),
        deleted = old.terms
          .filter((t: Doc) => !body.terms.some((n: Doc) => n.value === t.value))
          .map((t: Doc) => t.value)
      for (const drug of await tx.list(user.workspace, 'drug')) {
        assert(
          !terms(drug, taxonomyFields[kind]).some((v) => deleted.includes(v)),
          409,
          '药品仍引用此分类，请先修改相关药品。',
        )
        assert(
          drug.status !== 'published' ||
            !terms(drug, taxonomyFields[kind]).some((v) => removed.includes(v)),
          409,
          '已发布药品仍使用此分类，请先修改或停用相关药品。',
        )
      }
      const item = await tx.update(
        user.workspace,
        'taxonomy',
        kind,
        { ...old, terms: body.terms },
        body.version,
      )
      await tx.audit(user, 'taxonomy.edit', 'taxonomy', kind)
      return item
    })
  }
}
