import type { FastifyInstance } from 'fastify'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import {
  type Doc,
  type User,
  assert,
  sha,
  canonical,
  normalize,
  now,
  constants,
  Semaphore,
  pick,
  unique,
} from './core.ts'
import { Store } from './store.ts'
import { usable } from './validation.ts'
import { Models } from './agents.ts'
import { confined, readerHTML } from './archive.ts'
import { route } from './http.ts'

export const sentences = (text: string) =>
  text
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean)
const compact = (text: string) => normalize(text).toLowerCase()
export async function lintWiki(root: string): Promise<string[]> {
  const folder = join(root, 'wiki'),
    pages = new Map<string, string>(),
    inbound = new Set<string>(),
    errors: string[] = []
  if (!existsSync(folder)) return errors
  for (const name of await readdir(folder, { recursive: true })) {
    if (!name.endsWith('.md')) continue
    const file = await confined(folder, name)
    pages.set(name.slice(0, -3), (await readFile(file, 'utf8')).split('## 原文第 ')[0])
  }
  for (const [name, text] of pages)
    for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      if (pages.has(match[1])) inbound.add(match[1])
      else errors.push(`${name}: 断链 ${match[1]}`)
    }
  for (const name of pages.keys())
    if (!inbound.has(name) && !['index', 'log'].includes(name)) errors.push(`${name}: 孤立页`)
  return errors
}
export class Medical {
  readonly root: string
  readonly seed: string
  private slots = new Semaphore(2)
  constructor(
    readonly store: Store,
    readonly models: Models,
  ) {
    this.root = join(store.config.records, 'medical-wiki')
    this.seed = new URL('../resources/medical', import.meta.url).pathname
  }
  async load(): Promise<Doc> {
    try {
      const root = existsSync(join(this.root, 'corpus.json')) ? this.root : this.seed,
        raw = await readFile(join(root, 'corpus.json')),
        data = JSON.parse(raw.toString())
      assert(data.format === 1 && Array.isArray(data.sources), 409, '医学资料库格式无效。')
      return { ...data, version: sha(raw), root }
    } catch {
      return {
        format: 1,
        version: 'unavailable',
        products: [],
        sources: [],
        compiled: {},
        built_at: null,
        error: '医学依据库尚未导入或暂不可读取。',
        root: this.seed,
      }
    }
  }
  private async prepareEvidence(u: User, data?: Doc) {
    const corpus = data ?? await this.load(),
      documents = await this.store.transaction(
        u.workspace,
        async (tx) => (await tx.list(u.workspace, 'content')).filter(usable),
        false,
      ),
      approvals = new Map<string, Doc>(),
      normalizedSources = new Map<string, string>(),
      sourcesByURL = new Map<string, Doc[]>(),
      derived: Doc[] = []
    for (const source of corpus.sources) {
      const group = sourcesByURL.get(source.url)
      if (group) group.push(source)
      else sourcesByURL.set(source.url, [source])
    }
    for (const doc of documents) {
      const normalizedPages = new Map<number, Set<string>>()
      if (doc.source_url && sourcesByURL.has(doc.source_url))
        for (const page of doc.pages) {
          const texts = normalizedPages.get(page.number) ?? new Set<string>()
          texts.add(normalize(page.text))
          normalizedPages.set(page.number, texts)
        }
      const digest = sha(canonical(doc.pages)),
        receipt = {
          document_id: doc.id,
          document_version: doc.version,
          version_label: doc.version_label,
          document_sha256: digest,
        }
      for (const page of doc.pages)
        approvals.set(`platform-document-${doc.id}:${page.number}`, receipt)
      derived.push({
        id: `platform-document-${doc.id}`,
        title: doc.title,
        url: doc.source_url ?? '',
        sha256: digest,
        published_at: doc.publication_date ?? null,
        retrieved_at: doc.approved_at ?? '',
        kind: 'reviewed_content',
        quality: 'original',
        jurisdiction: doc.scope ?? '',
        product_ids: [],
        trials: [],
        pages: doc.pages,
        original_path: '',
        document_id: doc.id,
        document_version: doc.version,
      })
      for (const source of doc.source_url ? sourcesByURL.get(doc.source_url) ?? [] : []) {
        for (const page of source.pages ?? []) {
          let text = normalizedSources.get(page.text)
          if (text === undefined) {
            text = normalize(page.text)
            normalizedSources.set(page.text, text)
          }
          if (text && normalizedPages.get(page.number)?.has(text)) {
            const key = `${source.id}:${page.number}`,
              previous = approvals.get(key)
            if (!previous || doc.id.localeCompare(previous.document_id) < 0)
              approvals.set(key, receipt)
          }
        }
      }
    }
    return { data: corpus, approvals, sources: [...corpus.sources, ...derived], normalized: new Map<string, string>() }
  }
  async evidence(u: User, text: string, context = '') {
    return this.rankEvidence(await this.prepareEvidence(u), text, context)
  }
  private rankEvidence(prepared: { data: Doc; approvals: Map<string, Doc>; sources: Doc[]; normalized: Map<string, string> }, text: string, context = '') {
    const { data, approvals, sources, normalized } = prepared
    if (!text.trim() && !context.trim())
      return { data, approvals, rows: [], sources }
    const query = compact(text),
      background = compact(context),
      matches = (p: Doc, input: string) =>
        [p.id, p.name, p.brand, ...(p.aliases ?? [])].some(
          (alias) => alias && input.includes(compact(alias)),
        ),
      explicit = data.products.filter((p: Doc) => matches(p, query)),
      products = explicit.length
        ? explicit
        : data.products.filter((p: Doc) => matches(p, background)),
      ids = products.map((p: Doc) => p.id),
      tokens = unique([
        ...(query.match(/[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?/g) ?? []),
        ...Array.from({ length: Math.max(0, query.length - 1) }, (_, i) =>
          query.slice(i, i + 2),
        ).filter((t) => /^[\u4e00-\u9fff]{2}$/u.test(t)),
      ]),
      ranked: Doc[] = []
    for (const source of sources) {
      const { pages, original_path, ...metadata } = source
      const related = source.product_ids.some((id: string) => ids.includes(id))
      if (
        ids.length &&
        !related &&
        !['reimbursement', 'policy', 'reviewed_content'].includes(source.kind)
      )
        continue
      const trialMatch = (source.trials ?? []).some((trial: string) =>
          (
            trial.match(/\b(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+|monarchE|MONARCH\s*[23])\b/g) ?? []
          ).some((t) => query.includes(compact(t))),
        ),
        year = (text.match(/\b20\d{2}\b/g) ?? []).some((year) =>
          String(source.published_at ?? '').includes(year),
        )
      for (const page of source.pages ?? []) {
        const receipt = approvals.get(`${source.id}:${page.number}`)
        if (
          !receipt ||
          (source.document_version &&
            (receipt.document_version !== source.document_version ||
              receipt.document_sha256 !== source.sha256))
        )
          continue
        const factMatch = products.some((p: Doc) =>
          (data.compiled?.[p.id]?.facts ?? []).some(
            (fact: Doc) => {
              if (fact.source_id !== source.id || fact.page !== page.number) return false
              const claim = compact(fact.claim)
              return tokens.filter((t) => claim.includes(t)).length >= 2
            },
          ),
        )
        for (let offset = 0; offset < page.text.length; offset += 1000) {
          const body = page.text.slice(Math.max(0, offset - 200), offset + 1200),
            lower = normalized.get(body) ?? compact(body)
          normalized.set(body, lower)
          let score =
            tokens.reduce(
              (n, t) => n + (lower.includes(t) ? 1 + Math.min(t.length, 12) / 12 : 0),
              0,
            ) +
            (related ? 8 : 0) +
            (trialMatch ? 20 : 0) +
            (year ? 5 : 0)
          if (
            source.kind === 'label' &&
            /适应|剂量|用法|禁忌|不良|安全|人群|用药/.test(text) &&
            related
          )
            score += 3
          if (['reimbursement', 'policy'].includes(source.kind) && /医保|报销|支付|商保/.test(text))
            score += 8
          if (factMatch) score += 5
          if (score > (related ? 8 : 3)) {
            ranked.push({
              id: `${source.id}:p${page.number}:${offset}`,
              source_id: source.id,
              page: page.number,
              text: body,
              ...receipt,
              score: Math.round(score * 100) / 100,
              source: metadata,
            })
          }
        }
      }
    }
    ranked.sort((a, b) => b.score - a.score)
    const per = new Map<string, number>(),
      rows = ranked
        .filter((row) => {
          const count = per.get(row.source_id) ?? 0
          if (count >= 4) return false
          per.set(row.source_id, count + 1)
          return true
        })
        .slice(0, 12)
    return { data, approvals, rows, sources }
  }
  async check(u: User, text: string, context = '', signal?: AbortSignal): Promise<Doc> {
    const started = Date.now(),
      { data, approvals, rows: evidence } = await this.evidence(u, text, context),
      result: Doc = {
        text,
        corpus_version: data.version,
        checked_at: now(),
        preliminary: true,
        statements: [],
        status: 'insufficient',
      }
    if (text.length > 6000 || sentences(text).length > 24)
      return {
        ...result,
        status: 'unavailable',
        reason: '本段过长，未完成逐句核验；不能视为准确。',
      }
    if (!evidence.length)
      return { ...result, reason: data.error ?? '未检索到足够的适用依据，暂不能判断。' }
    if (!this.models.config.key)
      return { ...result, status: 'unavailable', reason: '核验服务未配置，暂不能判断。' }
    try {
      await this.slots.run(async () => {
        const reply = await this.models.json(
          constants.verify.PROMPT,
          {
            statements: sentences(text).map((text, i) => ({ id: `s${i}`, text })),
            context: context.slice(-3000),
            evidence,
          },
          { signal, timeout: 15, tokens: 4000 },
        )
        result.usage = { ...reply.usage, purpose: 'medical_check' }
        result.statements = validateMedical(reply.data, text, evidence)
        const candidates = result.statements.filter((row: Doc) =>
          ['supported', 'contradicted'].includes(row.status),
        )
        if (candidates.length) {
          const review = await this.models.json(constants.verify.REVIEW_PROMPT, candidates, {
            signal,
            timeout: 15,
            tokens: 1200,
          })
          for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'])
            result.usage[key] = (result.usage[key] ?? 0) + (review.usage[key] ?? 0)
          result.usage.incomplete ||= review.usage.incomplete
          const judgments = review.data.judgments,
            valid =
              Array.isArray(judgments) &&
              judgments.length === candidates.length &&
              unique(judgments.map((j: Doc) => j.id)).length === candidates.length
          for (const row of candidates) {
            if (valid && judgments.some((j: Doc) => j.id === row.id && j.admissible === true))
              row.review_status = 'admissible'
            else
              Object.assign(row, {
                status: 'insufficient',
                reason: '引用原文不足以直接支持这项判断，仍需核实适用范围或当地依据。',
                correction: '',
                review_status: 'insufficient',
              })
          }
        }
        result.status =
          ['contradicted', 'insufficient', 'supported', 'not_medical'].find((status) =>
            result.statements.some((row: Doc) => row.status === status),
          ) ?? 'insufficient'
        const current = await this.evidence(u, '')
        if (
          current.data.version !== data.version ||
          canonical([...current.approvals]) !== canonical([...approvals])
        )
          Object.assign(result, {
            status: 'insufficient',
            reason: '核验期间资料版本已更新，请重新核验本句。',
            statements: [],
          })
      })
    } catch {
      Object.assign(result, {
        status: 'unavailable',
        reason: '医学核验暂未完成；原话已保留，请核对资料后再使用。',
        statements: [],
      })
    }
    result.elapsed_seconds = (Date.now() - started) / 1000
    return result
  }
  async invalidate(u: User, checks: Doc[]) {
    if (!checks.some((check) => ['supported', 'contradicted'].includes(check.status))) return
    const { data, approvals } = await this.evidence(u, '')
    for (const check of checks)
      if (['supported', 'contradicted'].includes(check.status)) {
        const citations = check.statements.flatMap((s: Doc) => s.citations),
          valid =
            check.corpus_version === data.version &&
            citations.length &&
            citations.every(
              (c: Doc) =>
                canonical(approvals.get(`${c.source_id}:${c.page}`)) ===
                canonical(
                  pick(c, ['document_id', 'document_version', 'version_label', 'document_sha256']),
                ),
            )
        if (!valid)
          Object.assign(check, {
            status: 'insufficient',
            reason: '原依据已停用或变更，请重新核验。',
            statements: [],
          })
      }
  }
  async reference(u: User, drug: Doc, text: string): Promise<Doc> {
    const data = await this.load(),
      names = [drug.id, drug.name, drug.brand].filter(Boolean).map(compact),
      selected = data.products.filter((p: Doc) =>
        [p.id, p.name, p.brand, ...(p.aliases ?? [])].some((v) => v && names.includes(compact(v))),
      ),
      ids = selected.map((p: Doc) => p.id),
      peers = data.products.filter((p: Doc) =>
        p.compares_with?.some((id: string) => ids.includes(id)),
      ),
      evidence: Doc[] = [],
      gaps: Doc[] = []
    const products = [...selected, ...peers].slice(0, 4)
    const prepared = products.length ? await this.prepareEvidence(u, data) : undefined
    for (const product of products) {
      const found = this.rankEvidence(prepared!, text + ' ' + product.brand).rows
        .filter(
          (row) => row.source.product_ids.includes(product.id) && row.source.quality === 'original',
        )
        .slice(0, 2)
      evidence.push(...found)
      if (!found.length)
        gaps.push({ product: product.name, reason: '缺少当前有效审核的相关原文，不能作医学比较。' })
    }
    return { version: data.version, evidence, gaps }
  }
  async validReference(u: User, context: Doc) {
    const { data, approvals } = await this.evidence(u, '')
    return (
      data.version === context.version &&
      context.evidence.every(
        (row: Doc) =>
          canonical(approvals.get(`${row.source_id}:${row.page}`)) ===
          canonical(
            pick(row, ['document_id', 'document_version', 'version_label', 'document_sha256']),
          ),
      )
    )
  }
  async source(u: User, id: string, version?: string): Promise<{ source: Doc; data: Doc }> {
    assert(/^[a-z0-9][a-z0-9-]{0,120}$/.test(id), 404, '医学依据不存在。')
    const { data, approvals, sources } = await this.evidence(u, '')
    let source = sources.find((row) => row.id === id)
    if (version && source?.sha256 !== version && !id.startsWith('platform-document-')) {
      assert(/^[a-f0-9]{64}$/.test(version), 404, '医学依据不存在。')
      try {
        source = JSON.parse(
          await readFile(await confined(this.root, 'versions', id, version + '.json'), 'utf8'),
        )
      } catch {
        source = undefined
      }
    }
    assert(
      source &&
        (!version || source.sha256 === version) &&
        (u.role === 'admin' ||
          (source.pages?.length &&
            source.pages.every((p: Doc) => approvals.has(`${id}:${p.number}`)))),
      404,
      '医学依据不存在。',
    )
    return { source, data }
  }
  register(app: FastifyInstance) {
    route(app, 'GET', '/api/medical', undefined, async (u) => {
      const { data, approvals, sources } = await this.evidence(u, '')
      return {
        ...pick(data, ['version', 'built_at', 'error']),
        products: u.role === 'admin' ? data.products : [],
        compiled: u.role === 'admin' ? (data.compiled ?? {}) : {},
        sources: sources
          .filter(
            (source) =>
              u.role === 'admin' ||
              (source.pages?.length &&
                source.pages.every((p: Doc) => approvals.has(`${source.id}:${p.number}`))),
          )
          .map((source) => {
            const { pages, original_path, ...metadata } = source
            return {
              ...metadata,
              original_available: !!original_path && existsSync(join(this.root, original_path)),
            }
          }),
        integration: {
          project: 'https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f',
          mode: 'source_wiki',
          note: '原始资料、知识条目、索引和日志独立保存；自动摘要不是医学证据。',
        },
      }
    })
    route(app, 'POST', '/api/medical/check', 'knowledge.api.CheckRequest', (u, _p, b) => {
      assert(b.text.trim(), 422, '请输入待核验的原话。')
      return this.check(u, b.text, b.context)
    })
    route(app, 'POST', '/api/medical/audit', undefined, async (u) => {
      assert(u.role === 'admin', 403, '仅管理员可审计待审核资料。')
      const data = await this.load(),
        errors: string[] = []
      let verified = 0,
        missing = 0,
        facts = 0
      for (const source of data.sources) {
        try {
          assert(source.original_path.startsWith('raw/sources/'), 409, '原件路径无效。')
          if (!existsSync(join(this.root, source.original_path))) {
            missing++
            continue
          }
          assert(
            sha(await readFile(await confined(this.root, source.original_path))) === source.sha256,
            409,
            '原件校验值不符。',
          )
          verified++
        } catch {
          errors.push(source.id + ': 原件路径或校验值无效。')
        }
      }
      for (const product of data.products) {
        if (product.sources.some((id: string) => !data.sources.some((s: Doc) => s.id === id)))
          errors.push(product.id + ': 来源链接失效。')
        for (const fact of data.compiled?.[product.id]?.facts ?? []) {
          const source = data.sources.find((s: Doc) => s.id === fact.source_id),
            page = source?.pages.find((p: Doc) => p.number === fact.page)
          if (
            page &&
            source.sha256 === fact.sha256 &&
            typeof fact.quote === 'string' &&
            normalize(fact.quote).length >= 12 &&
            normalize(page.text).includes(normalize(fact.quote))
          )
            facts++
          else errors.push(product.id + ': 编译引用失效。')
        }
      }
      errors.push(...(await lintWiki(data.root)))
      return {
        version: data.version,
        ok: !errors.length && !!data.sources.length,
        sources: data.sources.length,
        verified_originals: verified,
        originals_not_local: missing,
        verified_fact_quotes: facts,
        errors,
        scope: '仅检查文件与引用完整性，不代表医学人工审核。',
      }
    })
    route(app, 'GET', '/api/medical/sources/{source_id}', undefined, async (u, p, _b, q, reply) => {
      const { source } = await this.source(u, p.source_id, q.version)
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'Content-Security-Policy',
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
        )
        .send(
          readerHTML(
            source.title,
            source.url,
            source.retrieved_at,
            source.pages.map((p: Doc) => [`第 ${p.number} 页 / 段`, p.text]),
          ),
        )
    })
    route(
      app,
      'GET',
      '/api/medical/sources/{source_id}/original',
      undefined,
      async (u, p, _b, q, reply) => {
        const { source } = await this.source(u, p.source_id, q.version)
        assert(source.original_path, 404, '原件未下载到此环境。')
        const path = await confined(this.root, source.original_path),
          raw = await readFile(path)
        assert(sha(raw) === source.sha256, 409, '原件校验失败。')
        return reply
          .type('application/octet-stream')
          .header(
            'Content-Disposition',
            `attachment; filename="${p.source_id}.${source.original_path.split('.').at(-1)}"`,
          )
          .send(raw)
      },
    )
    route(app, 'GET', '/api/medical/wiki.zip', undefined, async (u, _p, _b, _q, reply) => {
      assert(u.role === 'admin', 403, '仅管理员可导出待审核资料。')
      const data = await this.load()
      assert(data.sources.length, 404, '医学依据库尚未导入。')
      const files: Record<string, Uint8Array> = {}
      let total = 0
      const include = async (root: string, path: string) => {
        const full = await confined(root, path)
        total += (await stat(full)).size
        assert(total <= 400_000_000, 413, '资料较大，请从服务器备份目录取得项目。')
        files[path] = await readFile(full)
      }
      for (const source of data.sources)
        if (existsSync(join(this.root, source.original_path)))
          await include(this.root, source.original_path)
      for (const name of ['purpose.md', 'schema.md', 'AGENTS.md'])
        if (existsSync(join(data.root, name))) await include(data.root, name)
      if (existsSync(join(data.root, 'wiki')))
        for (const entry of await readdir(join(data.root, 'wiki'), { recursive: true }))
          if (entry.endsWith('.md')) await include(data.root, join('wiki', entry))
      files['raw/sources/manifest.json'] = Buffer.from(
        JSON.stringify(
          data.sources.map((s: Doc) =>
            pick(s, ['id', 'title', 'url', 'sha256', 'original_path', 'retrieved_at']),
          ),
          null,
          2,
        ),
      )
      return reply
        .type('application/zip')
        .header('Content-Disposition', 'attachment; filename="EviSpeak-medical-wiki.zip"')
        .send(Buffer.from(zipSync(files)))
    })
  }
}
export function validateMedical(raw: Doc, text: string, evidence: Doc[]): Doc[] {
  const parts = sentences(text)
  const normalized = new Map<string, string>()
  const sourceText = (value: string) => {
    let result = normalized.get(value)
    if (result === undefined) {
      result = normalize(value)
      normalized.set(value, result)
    }
    return result
  }
  assert(
    Array.isArray(raw.statements) && raw.statements.length === parts.length,
    502,
    '医学逐句核验覆盖不完整。',
  )
  return parts.map((sentence, index) => {
    const row = raw.statements[index]
    assert(
      row?.id === `s${index}` &&
        ['supported', 'contradicted', 'insufficient', 'not_medical'].includes(row.status) &&
        typeof row.reason === 'string' &&
        row.reason.length <= 1200 &&
        typeof row.correction === 'string' &&
        row.correction.length <= 1600 &&
        Array.isArray(row.citations) &&
        row.citations.length <= 6,
      502,
      '医学核验结构无效。',
    )
    let valid = true
    const citations: Doc[] = []
    for (const citation of row.citations) {
      const chunk = evidence.find((e) => e.id === citation?.chunk_id),
        quote = citation?.quote,
        quoteText = typeof quote === 'string' ? normalize(quote) : ''
      if (
        !chunk ||
        typeof quote !== 'string' ||
        quoteText.length < 12 ||
        quoteText.length > 1000 ||
        !sourceText(chunk.text).includes(quoteText) ||
        sourceText(chunk.source.title).includes(quoteText)
      ) {
        valid = false
        continue
      }
      citations.push({
        chunk_id: chunk.id,
        ...pick(chunk, [
          'source_id',
          'page',
          'document_id',
          'document_version',
          'version_label',
          'document_sha256',
        ]),
        quote,
        ...pick(chunk.source, [
          'title',
          'url',
          'sha256',
          'retrieved_at',
          'published_at',
          'kind',
          'jurisdiction',
          'quality',
        ]),
      })
    }
    let status = row.status,
      reason = row.reason,
      correction = row.correction
    if (
      ['supported', 'contradicted'].includes(status) &&
      (!valid ||
        !citations.length ||
        citations.some((c) => ['ocr', 'version_uncertain', 'patient_guide'].includes(c.quality)))
    ) {
      status = 'insufficient'
      reason = '模型引用或资料类型未通过原文核对，暂不能确认该句。'
      correction = ''
    }
    if (status !== 'contradicted') correction = ''
    else if (!correction.trim()) {
      status = 'insufficient'
      reason = '尚未形成可追溯的纠正内容。'
    }
    return { id: `s${index}`, text: sentence, status, reason, correction, citations }
  })
}
export function validateSummary(raw: Doc, record: Doc, model: string, checks: Doc[]): Doc {
  const trainees = new Map<string, string>(
      record.messages
        .filter((m: Doc) => m.role === 'trainee' && m.final)
        .map((m: Doc) => [m.id, m.text]),
    ),
    normalizedTrainees = new Map<string, string>(),
    sourceText = (id: string) => {
      let text = normalizedTrainees.get(id)
      if (text === undefined) {
        text = normalize(trainees.get(id)!)
        normalizedTrainees.set(id, text)
      }
      return text
    },
    validQuote = (row: Doc) =>
      row &&
      typeof row.quote === 'string' &&
      row.quote.length >= 1 &&
      row.quote.length <= 1200 &&
      trainees.has(row.message_id) &&
      sourceText(row.message_id).includes(normalize(row.quote)),
    medical: Doc[] = [],
    edits: Doc[] = []
  let missing = false
  const checkIndex = new Map<string, Map<string, Doc>>()
  for (const check of checks) {
    const versions = checkIndex.get(check.message_id) ?? new Map<string, Doc>()
    versions.set(check.text, check)
    checkIndex.set(check.message_id, versions)
  }
  for (const [id, text] of trainees) {
    const check = checkIndex.get(id)?.get(text)
    if (!check || ['insufficient', 'unavailable', 'checking'].includes(check.status)) missing = true
    for (const row of check?.statements ?? []) {
      if (['supported', 'contradicted'].includes(row.status)) medical.push(row)
      else if (row.status !== 'not_medical') missing = true
      if (row.status === 'contradicted' && row.correction && row.citations.length)
        edits.push({
          message_id: id,
          quote: row.text,
          category: 'medical',
          reason: row.reason,
          rewrite: row.correction,
          citations: row.citations,
        })
    }
  }
  const medicalScore =
      medical.length && !missing
        ? Math.round(
            (1000 * medical.filter((r) => r.status === 'supported').length) / medical.length,
          ) / 10
        : null,
    dimensions: Doc[] = [
      {
        key: 'medical',
        label: '医学准确性',
        weight: 40,
        score: medicalScore,
        reason:
          `已核实 ${medical.length} 条医学断言，其中 ${medical.filter((r) => r.status === 'contradicted').length} 条存在原文冲突。` +
          (missing || !medical.length
            ? '仍有未核实内容，本维度暂不评分。'
            : '按有依据支持的断言比例计算，未经专家校准。'),
        quotes: [],
        verified_statements: medical.length,
      },
    ]
  for (const [key, label, weight] of [
    ['compliance', '合规性', 30],
    ['communication', '沟通技巧', 30],
  ] as [string, string, number][]) {
    const rows = Array.isArray(raw.dimensions)
        ? raw.dimensions.filter((d: Doc) => d?.key === key)
        : [],
      row = rows.length === 1 ? rows[0] : {},
      valid =
        Number.isInteger(row.score) &&
        row.score >= 0 &&
        row.score <= 100 &&
        Array.isArray(row.quotes) &&
        row.quotes.length >= 1 &&
        row.quotes.length <= 4 &&
        row.quotes.every(validQuote) &&
        typeof row.reason === 'string' &&
        row.reason.length >= 1 &&
        row.reason.length <= 1000
    dimensions.push({
      key,
      label,
      weight,
      score: valid ? row.score : null,
      reason: valid ? row.reason : '缺少可核对的观察或原话，本维度暂不评分。',
      quotes: valid ? row.quotes : [],
    })
  }
  for (const row of Array.isArray(raw.edits) ? raw.edits.slice(0, 3) : []) {
    if (
      !validQuote(row) ||
      !['medical', 'compliance', 'communication'].includes(row.category) ||
      edits.some((e) => normalize(e.quote) === normalize(row.quote)) ||
      ['reason', 'rewrite'].some(
        (k) => typeof row[k] !== 'string' || row[k].length < 1 || row[k].length > 1200,
      )
    )
      continue
    edits.push({
      ...pick(row, ['message_id', 'quote', 'category', 'reason', 'rewrite']),
      ...(row.category === 'medical'
        ? {
            rewrite: '我会先核对适用人群、原文版本和依据，确认后再回应。',
            reason: '当前资料不足，需要核实，不能据此断定临床错误。',
          }
        : {}),
    })
  }
  for (const row of dimensions) {
    if (record.free_context) row.score = null
    row.weighted_points = row.score === null ? null : Math.round((row.score * row.weight) / 10) / 10
  }
  const complete =
    dimensions.every((row) => row.score !== null) && record.capture_status === 'completed'
  return {
    version: 1,
    title: record.free_context ? '自由练习复盘' : '拜访复盘评分卡',
    model,
    created_at: now(),
    status: complete ? 'complete' : 'partial',
    total: complete
      ? Math.round(dimensions.reduce((n, d) => n + d.weighted_points, 0) * 10) / 10
      : null,
    dimensions,
    edits: edits.slice(0, 3),
    overview:
      typeof raw.overview === 'string'
        ? raw.overview.slice(0, 640)
        : '本次依据不足，先核对原话与资料后再重练。',
    capture_complete: record.capture_status === 'completed',
    calibration_status: 'uncalibrated',
  }
}
