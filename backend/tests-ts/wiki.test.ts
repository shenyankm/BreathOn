import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, modelMock } from './helpers.ts'
import { type Doc, sha } from '../src/core.ts'
import { privateWrite } from '../src/store.ts'
import { ingestMedical, compileMedical, validateFacts, productPages } from '../src/wiki.ts'
import { lintWiki } from '../src/medical.ts'

test('medical maintenance preserves failed originals, receipts and logs; Pi compilation validates quotes and reuses its cache', async () => {
  const text =
    '合成资料身份。这里的连续原文只用于软件维护流程测试，不代表真实医学研究、疗效、诊疗意见或政策结论。'.repeat(
      3,
    )
  let calls = 0
  const f = await fixture(
    { key: 'synthetic' },
    modelMock(() => {
      calls++
      return {
        facts: [{ claim: '仅测试合成文本', source_id: 'source-one', page: 1, quote: text }],
        gaps: [],
      }
    }),
  )
  const root = f.medical.root,
    old = Buffer.from('旧合成原件'),
    original = `raw/sources/source-one/${sha(old)}.html`
  const initial: Doc = {
    format: 1,
    products: [
      {
        id: 'synthetic-product',
        brand: '合成',
        name: '合成产品',
        sources: ['source-one'],
        gaps: [],
      },
    ],
    sources: [
      {
        id: 'source-one',
        title: '合成原文',
        url: 'https://example.org/public',
        original_path: original,
        sha256: sha(old),
        quality: 'original',
        kind: 'label',
        product_ids: ['synthetic-product'],
        pages: [{ number: 1, text: '旧文' }],
        retrieved_at: '2026-01-01',
        required_terms: ['合成资料身份'],
      },
    ],
    compiled: { 'synthetic-product': { facts: [], gaps: ['旧编译'], status: 'compiled' } },
  }
  try {
    await privateWrite(join(root, original), old)
    await privateWrite(join(root, 'corpus.json'), JSON.stringify(initial))
    await privateWrite(join(root, 'wiki/log.md'), '# 历史日志\n原有记录保留\n')
    const failed = await ingestMedical(root, { refresh: true }, async () => {
      throw new Error('Synthetic unavailable')
    })
    assert.equal(failed.sources[0].sha256, sha(old))
    assert(failed.compiled['synthetic-product'])
    assert.equal(failed.errors.length, 1)
    const html = Buffer.from(`<html><title>合成原文</title><p>${text}</p></html>`)
    const fetcher = async () => ({
      raw: html,
      url: 'https://example.org/public',
      headers: { 'content-type': 'text/html' },
    })
    const updated = await ingestMedical(root, { refresh: true }, fetcher)
    assert.equal(updated.sources[0].review_status, 'pending')
    assert(!updated.compiled['synthetic-product'])
    for (const digest of [sha(old), sha(html)])
      assert.equal(
        JSON.parse(await readFile(join(root, 'versions/source-one', digest + '.json'), 'utf8'))
          .sha256,
        digest,
      )
    assert.equal(await readFile(join(root, original), 'utf8'), old.toString())
    assert(
      (await readFile(join(root, 'wiki/log.md'), 'utf8')).startsWith('# 历史日志\n原有记录保留\n'),
    )
    assert.deepEqual(await lintWiki(root), [])
    const unchanged = await ingestMedical(root, { refresh: true }, fetcher)
    assert.equal(unchanged.sources[0].retrieved_at, updated.sources[0].retrieved_at)
    const compiled = await compileMedical(root, f.models)
    assert.equal(compiled.compiled['synthetic-product'].facts.length, 1)
    await compileMedical(root, f.models)
    assert.equal(calls, 1)
    const invalid = validateFacts(
      {
        facts: [
          {
            claim: '无依据',
            source_id: 'source-one',
            page: 1,
            quote: '模型自造而且不在原文中的引用文字',
          },
        ],
        gaps: [],
      },
      compiled.sources,
    )
    assert.equal(invalid.facts.length, 0)
    assert(invalid.gaps.length)
    assert.equal(
      validateFacts(
        { facts: [{ claim: '合成', source_id: 'source-one', page: 1, quote: text }], gaps: [] },
        [{ ...compiled.sources[0], quality: 'ocr' }],
      ).facts.length,
      0,
    )
    assert.equal(
      productPages(
        {
          kind: 'reimbursement',
          pages: [
            { number: 1, text: '目录' },
            { number: 99, text: '合成产品的限定支付条件' },
          ],
        },
        initial.products[0],
      )[0].number,
      99,
    )
  } finally {
    await f.close()
  }
})
