import { readFile, cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  type Doc,
  assert,
  now,
  sha,
  canonical,
  constants,
  resource,
  settings,
  pick,
} from './core.ts'
import { Models } from './agents.ts'
import { privateWrite } from './store.ts'
import { downloadPublic, htmlText, normalizedText, confined } from './archive.ts'
import { parseDocument } from './documents.ts'
import { lintWiki } from './medical.ts'

const seed = new URL('../resources/medical/', import.meta.url).pathname
const safeID = (value: string) =>
  assert(/^[a-z0-9][a-z0-9._-]{0,150}$/i.test(value), 422, '资料标识无效。')
export function validateFacts(raw: Doc, sources: Doc[]): Doc {
  assert(
    raw &&
      Array.isArray(raw.facts) &&
      raw.facts.length <= 12 &&
      Array.isArray(raw.gaps) &&
      raw.gaps.every((gap: unknown) => typeof gap === 'string' && gap.length <= 1000),
    502,
    '无效的医学编译结果。',
  )
  const facts: Doc[] = [],
    gaps = [...raw.gaps]
  for (const row of raw.facts) {
    const source = sources.find((source) => source.id === row?.source_id),
      page = source?.pages.find((page: Doc) => page.number === row.page)
    if (
      !page ||
      ['ocr', 'version_uncertain', 'patient_guide'].includes(source!.quality) ||
      (row.sha256 && row.sha256 !== source!.sha256) ||
      typeof row.quote !== 'string' ||
      normalizedText(row.quote).length < 12 ||
      normalizedText(row.quote).length > 1000 ||
      !normalizedText(page.text).includes(normalizedText(row.quote)) ||
      typeof row.claim !== 'string' ||
      !row.claim.trim() ||
      row.claim.length > 1400
    )
      continue
    facts.push({ ...pick(row, ['claim', 'source_id', 'page', 'quote']), sha256: source!.sha256 })
  }
  if (facts.length !== raw.facts.length)
    gaps.push(`${raw.facts.length - facts.length} 条生成要点未通过原文引用检查，已剔除。`)
  return { facts, gaps: gaps.slice(0, 7) }
}
export function productPages(source: Doc, product: Doc): Doc[] {
  const aliases = [product.id, product.name, ...(product.aliases ?? [])]
    .filter(Boolean)
    .map((v: string) => normalizedText(v).toLowerCase())
  if (source.kind === 'reimbursement') {
    const matched = source.pages.filter((page: Doc) =>
      aliases.some((alias: string) => normalizedText(page.text).toLowerCase().includes(alias)),
    )
    return [
      ...matched,
      ...source.pages
        .slice(0, 7)
        .filter((page: Doc) => !matched.some((p: Doc) => p.number === page.number)),
    ]
  }
  if (source.kind === 'guideline')
    return source.pages.flatMap((page: Doc) => {
      const lower = page.text.toLowerCase(),
        positions = new Set<number>([0])
      for (const alias of [product.id, product.name, ...(product.aliases ?? [])].filter(Boolean)) {
        const index = lower.indexOf(alias.toLowerCase())
        if (index >= 0) positions.add(Math.max(0, index - 800))
      }
      return [...positions]
        .sort((a, b) => a - b)
        .slice(0, 5)
        .map((position) => ({
          number: page.number,
          text: page.text.slice(position, position + 3000),
        }))
    })
  return source.pages
}
export async function renderWiki(root: string, data: Doc, operation = 'maintain') {
  const link = (target: string, label = target) => `[[${target}|${label}]]`
  const put = async (path: string, meta: Doc, body: string) =>
    privateWrite(
      join(root, path),
      '---\n' +
        Object.entries(meta)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n') +
        '\n---\n\n' +
        body.trim() +
        '\n',
    )
  const index = ['# 医学 Wiki 索引', '自动归档与编译，待医学审核；原文、地区与版本须单独核对。']
  for (const source of data.sources) {
    safeID(source.id)
    const body = [
      `# ${source.title}`,
      `来源：${source.url}`,
      `地区：${source.jurisdiction ?? '未确认'}；发表/修订：${source.published_at ?? '未确认'}；抓取：${source.retrieved_at}`,
      `质量：${source.quality}；自动归档，待医学审核。`,
      source.scope_note ?? '以原文、地区与版本为准。',
      '## 关联产品',
      ...source.product_ids
        .filter((id: string) => data.products.some((p: Doc) => p.id === id))
        .map((id: string) => link('entities/' + id)),
      ...source.pages.map((page: Doc) => `## 原文第 ${page.number} 页 / 段\n\n${page.text}`),
    ]
    await put(
      `wiki/sources/${source.id}.md`,
      { type: 'source', sha256: source.sha256, review_status: 'pending' },
      body.join('\n\n'),
    )
    index.push('- ' + link('sources/' + source.id, source.title))
  }
  for (const product of data.products) {
    safeID(product.id)
    const related = data.sources.filter((s: Doc) => s.product_ids.includes(product.id)),
      compiled = data.compiled?.[product.id] ?? {},
      comparisons = data.products.filter(
        (p: Doc) =>
          (p.compares_with ?? []).includes(product.id) ||
          (p.id === product.id && p.compares_with?.length),
      )
    const body = [
      `# ${product.brand} / ${product.name}`,
      product.ownership === 'competitor'
        ? '竞品资料；自动整理，待医学审核。'
        : '本公司产品目录；自动整理，待医学审核。',
      '## 来源',
      ...related.map((s: Doc) => '- ' + link('sources/' + s.id, s.title)),
      '## 比较参考',
      ...comparisons.map((p: Doc) => '- ' + link('comparisons/' + p.id, p.brand)),
      '## 尚待补齐与冲突',
      ...[...(product.gaps ?? []), ...(compiled.gaps ?? [])].map((gap) => '- ' + gap),
      '## 编译的医学要点',
      '自动整理，未经医学复核；判断必须返回引用原文。',
      ...(compiled.facts ?? []).map(
        (fact: Doc) =>
          `- ${fact.claim}\n  - ${link('sources/' + fact.source_id)} 第 ${fact.page} 页；SHA-256：${fact.sha256}；原文：${fact.quote}`,
      ),
    ]
    await put(
      `wiki/entities/${product.id}.md`,
      { type: 'entity', review_status: 'pending' },
      body.join('\n\n'),
    )
    index.push('- ' + link('entities/' + product.id, `${product.brand} / ${product.name}`))
    if (product.compares_with?.length) {
      await put(
        `wiki/comparisons/${product.id}.md`,
        { type: 'comparison', review_status: 'pending' },
        [
          `# ${product.brand} 比较参考`,
          product.relationship ?? '仅建立资料关系，不构成优效或可替换性结论。',
          ...[product.id, ...product.compares_with]
            .filter((id) => data.products.some((p: Doc) => p.id === id))
            .map((id) => link('entities/' + id)),
          '分别核对地区、制剂、适应症、人群、线次、联合方案、终点、随访与修订版本；国外批准不能推断中国适应症，跨试验数值不能推出头对头优效。',
        ].join('\n\n'),
      )
      index.push('- ' + link('comparisons/' + product.id, product.brand + ' 比较边界'))
    }
  }
  if (data.demo_pack) {
    const pack = data.demo_pack,
      body = [
        `# ${pack.title}`,
        pack.scope,
        `核查日期：${pack.checked_at}；自动整理，待医学审核。`,
        ...(pack.product_ids ?? [])
          .filter((id: string) => data.products.some((p: Doc) => p.id === id))
          .map((id: string) => link('entities/' + id)),
      ].filter(Boolean)
    for (const id of new Set<string>([
      ...(pack.source_ids ?? []),
      ...(pack.existing_source_ids ?? []),
    ]))
      if (data.sources.some((s: Doc) => s.id === id)) body.push(link('sources/' + id))
    for (const doctor of pack.doctors ?? []) {
      safeID(doctor.id)
      if (!data.sources.some((s: Doc) => s.id === doctor.source_id)) continue
      await put(
        `wiki/doctors/${doctor.id}.md`,
        { type: 'doctor', review_status: 'pending' },
        `# ${doctor.name}\n\nAI 模拟角色，非医生本人，不代表其观点或产品推荐。\n\n${doctor.facts}\n\n${link('sources/' + doctor.source_id)}\n\n## 独立训练设定\n\n${doctor.training_focus}\n\n${link('demo')}`,
      )
      body.push(link('doctors/' + doctor.id, doctor.name))
    }
    body.push(
      '## 未取得正文',
      ...(pack.failures ?? []).map((row: Doc) => `${row.id}：${row.url}；不可用作已核验依据。`),
    )
    await put('wiki/demo.md', { type: 'demo', review_status: 'pending' }, body.join('\n\n'))
    index.push('- ' + link('demo', pack.title))
  }
  await privateWrite(join(root, 'wiki/index.md'), index.join('\n\n') + '\n')
  const log = join(root, 'wiki/log.md'),
    previous = existsSync(log) ? await readFile(log, 'utf8') : '# 维护日志\n'
  await privateWrite(
    log,
    previous +
      `\n## [${now()}] ${operation} | 医学 Wiki\n\n${data.products.length} 个实体、${data.sources.length} 份来源。自动整理，保留审批边界与来源版本。\n`,
  )
}
export async function ingestMedical(root: string, options: Doc = {}, download = downloadPublic) {
  if (!existsSync(join(root, 'corpus.json')))
    await cp(seed, root, { recursive: true, force: false, errorOnExist: true })
  const data = JSON.parse(await readFile(join(root, 'corpus.json'), 'utf8')),
    sources = new Map<string, Doc>(data.sources.map((s: Doc) => [s.id, s])),
    products = new Map<string, Doc>(data.products.map((p: Doc) => [p.id, p])),
    failures: Doc[] = []
  const manifest: Doc =
    options.manifest === 'demo'
      ? resource('mazdutide-demo')
      : options.manifest === 'competitors'
        ? { products: resource('competitors') }
        : {}
  const rows =
    options.manifest === 'demo'
      ? manifest.sources
      : options.manifest === 'competitors'
        ? manifest.products.map((p: Doc) => ({
            id: 'label-' + p.id,
            title: p.brand + ' 美国处方说明书',
            url: p.url,
            kind: 'label',
            product_ids: [p.id],
            jurisdiction: 'US',
            quality: 'version_uncertain',
            trials: [],
            required_terms: [p.brand],
          }))
        : data.sources
  for (const product of manifest?.products ?? []) {
    safeID(product.id)
    products.set(product.id, { ...products.get(product.id), ...product })
  }
  for (const row of rows) {
    safeID(row.id)
    const previous = sources.get(row.id)
    if (
      previous &&
      !options.refresh &&
      existsSync(join(root, previous.original_path)) &&
      sha(await readFile(await confined(root, previous.original_path))) === previous.sha256
    )
      continue
    try {
      const downloaded = await download(row.url),
        raw = downloaded.raw,
        digest = sha(raw)
      const suffix =
          raw.subarray(0, 5).toString() === '%PDF-'
            ? 'pdf'
            : raw[0] === 0xff && raw[1] === 0xd8
              ? 'jpg'
              : 'html',
        relative = `raw/sources/${row.id}/${digest}.${suffix}`
      await privateWrite(join(root, relative), raw)
      if (previous?.sha256 === digest) continue
      let pages: Doc[],
        quality = row.quality ?? 'original'
      try {
        if (suffix === 'pdf') pages = (await parseDocument(raw, 'pdf')).pages
        else {
          assert(suffix === 'html', 422, '图片需 OCR。')
          pages = [
            {
              number: 1,
              text: htmlText(raw, downloaded.headers['content-type'] ?? '', downloaded.url).text,
            },
          ]
        }
      } catch (error) {
        if (!options.ocr) throw error
        const result = await promisify(execFile)(resolve(options.ocr), [join(root, relative)], {
          timeout: 240000,
          maxBuffer: 8_000_000,
          env: { PATH: '/usr/bin:/bin' },
          encoding: 'utf8',
        })
        pages = JSON.parse(result.stdout)
        quality = 'ocr'
      }
      assert(
        Array.isArray(pages) &&
          pages.length <= 200 &&
          pages.every(
            (p) =>
              Number.isInteger(p.number) &&
              p.number > 0 &&
              typeof p.text === 'string' &&
              p.text.length <= 20000,
          ) &&
          pages.reduce((n, p) => n + p.text.length, 0) <= 1_000_000,
        422,
        '页码或文档内容无效。',
      )
      const text = normalizedText(pages.map((p) => p.text).join('\n'))
      assert(
        text.length >= 100 &&
          !text.slice(0, 500).includes('Checkingyourbrowser') &&
          (row.required_terms ?? []).every((term: string) => text.includes(normalizedText(term))),
        422,
        '正文缺失或与目标资料不匹配。',
      )
      const updated = {
        ...row,
        url: downloaded.url,
        sha256: digest,
        original_path: relative,
        pages,
        quality,
        trials: row.trials ?? [],
        retrieved_at: now(),
        review_status: 'pending',
      }
      delete updated.required_terms
      for (const version of [previous, updated])
        if (version) {
          const receipt = join(root, 'versions', row.id, version.sha256 + '.json')
          if (!existsSync(receipt)) await privateWrite(receipt, JSON.stringify(version))
        }
      sources.set(row.id, updated)
      for (const id of updated.product_ids) delete data.compiled?.[id]
    } catch {
      failures.push({
        id: row.id,
        url: row.url,
        error: '抓取或正文身份校验未完成；保留已有版本。',
        previous_retained: !!previous,
      })
    }
  }
  for (const product of products.values())
    product.sources = [...sources.values()]
      .filter((s) => s.product_ids.includes(product.id))
      .map((s) => s.id)
  if (options.manifest === 'demo')
    data.demo_pack = {
      ...manifest,
      source_ids: manifest.sources.map((s: Doc) => s.id),
      product_ids: ['mazdutide', ...manifest.products.map((p: Doc) => p.id)],
      failures,
    }
  if (data.demo_pack) {
    delete data.demo_pack.products
    delete data.demo_pack.sources
  }
  Object.assign(data, {
    sources: [...sources.values()],
    products: [...products.values()],
    errors: failures,
    built_at: now(),
    review_status: 'pending',
  })
  await privateWrite(join(root, 'corpus.json'), JSON.stringify(data))
  await renderWiki(root, data, 'ingest')
  return data
}
export async function compileMedical(root: string, models: Models) {
  assert(models.config.key, 503, '编译需要配置模型密钥。')
  const data = JSON.parse(await readFile(join(root, 'corpus.json'), 'utf8'))
  data.compiled ??= {}
  for (const product of data.products) {
    safeID(product.id)
    const sources = data.sources.filter((source: Doc) => source.product_ids.includes(product.id)),
      fingerprint = sha(
        // Match existing Python compilation receipts, including ensure_ascii=True.
        canonical({
          sources,
          prompt: constants.compile.PROMPT,
          model: models.config.model,
        }).replace(
          /[\u007f-\uffff]/g,
          (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
        ),
      ),
      path = join(root, 'compiled', product.id, fingerprint + '.json')
    try {
      let result: Doc
      if (existsSync(path)) {
        result = JSON.parse(await readFile(path, 'utf8'))
        Object.assign(result, validateFacts(result, sources))
      } else {
        const evidence = sources.map((source: Doc) => {
          let budget =
            source.kind === 'label'
              ? 24000
              : ['guideline', 'reimbursement'].includes(source.kind)
                ? 16000
                : 8000
          const pages = []
          for (const page of productPages(source, product)) {
            if (budget <= 0) break
            const text = page.text.slice(0, budget)
            budget -= text.length
            pages.push({ number: page.number, text })
          }
          return {
            ...pick(source, [
              'id',
              'title',
              'kind',
              'url',
              'sha256',
              'quality',
              'published_at',
              'jurisdiction',
            ]),
            pages,
          }
        })
        const reply = await models.json(
          constants.compile.PROMPT,
          { product: pick(product, ['id', 'name', 'brand']), sources: evidence },
          { tokens: 6000, timeout: 40 },
        )
        result = {
          ...validateFacts(reply.data, sources),
          fingerprint,
          status: 'compiled',
          model: models.config.model,
          compiled_at: now(),
          usage: reply.usage,
        }
        await privateWrite(path, JSON.stringify(result))
      }
      data.compiled[product.id] = result
    } catch {
      data.compiled[product.id] = {
        status: 'unavailable',
        facts: [],
        gaps: ['知识条目编译未完成；原文已保留。'],
      }
    }
    await privateWrite(join(root, 'corpus.json'), JSON.stringify(data))
  }
  await renderWiki(root, data, 'compile')
  return data
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  const args = process.argv.slice(2),
    allowed = new Set(['--root', '--manifest', '--ocr-command', '--refresh', '--compile-wiki']),
    config = settings(),
    options: Doc = {}
  let root = join(config.records, 'medical-wiki')
  while (args.length) {
    const arg = args.shift()!
    assert(allowed.has(arg), 400, '未知医学维护参数。')
    if (arg === '--refresh') options.refresh = true
    else if (arg === '--compile-wiki') options.compile = true
    else {
      const value = args.shift()
      assert(value && !value.startsWith('--'), 400, '维护参数缺少值。')
      if (arg === '--root') root = resolve(value)
      else if (arg === '--manifest') options.manifest = value
      else options.ocr = value
    }
  }
  assert(
    !options.manifest || ['demo', 'competitors'].includes(options.manifest),
    400,
    '未知资料清单。',
  )
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = join(root, '.maintenance-lock')
  await mkdir(lock, { mode: 0o700 })
  try {
    let data = await ingestMedical(root, options)
    if (options.compile) data = await compileMedical(root, new Models(config))
    const errors = await lintWiki(root)
    console.log(
      JSON.stringify({
        sources: data.sources.length,
        products: data.products.length,
        failures: data.errors?.length ?? 0,
        wiki_errors: errors,
      }),
    )
    if (errors.length || data.errors?.length) process.exitCode = 1
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
