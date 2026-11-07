import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, symlink, mkdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { fixture, modelMock, sse } from './helpers.ts'
import { createApp } from '../src/app.ts'
import { type Doc, sha, uuid, identity } from '../src/core.ts'
import { privateWrite, newRecord } from '../src/store.ts'
import { readSource, evidenceBlocks, normalizedText, htmlText, confined } from '../src/archive.ts'
import { validateResearch } from '../src/research.ts'
import { lintWiki } from '../src/medical.ts'

if (process.env.CI) assert(process.env.TEST_DATABASE_URL, 'CI must run the PostgreSQL tests')

const user = {
  id: 'local',
  workspace: 'local',
  role: 'admin' as const,
  team: '',
  authenticated: false,
}
test('wiki lint checks navigation, excludes raw document brackets, and reports orphan pages', async () => {
  const f = await fixture()
  try {
    await privateWrite(join(f.medical.root, 'wiki/index.md'), '[[sources/a|原文]] [[missing]]')
    await privateWrite(
      join(f.medical.root, 'wiki/sources/a.md'),
      '正文\n## 原文第 1 页\n[[raw brackets]]',
    )
    await privateWrite(join(f.medical.root, 'wiki/orphan.md'), '没有入链')
    assert.deepEqual((await lintWiki(f.medical.root)).sort(), [
      'index: 断链 missing',
      'orphan: 孤立页',
    ])
  } finally {
    await f.close()
  }
})
test('immutable archives validate every receipt and reject tampering or symlink escape', async () => {
  const f = await fixture()
  try {
    const root = f.research.archives,
      url = 'https://example.org/public',
      id = sha(url).slice(0, 24),
      raw = Buffer.from(
        '<p>这是保留在原文中的公开事实。数字 1 2 必须保留边界。这里只用于软件测试和数据完整性验证，不代表真实医学资料。</p>',
      ),
      version = sha(raw),
      text =
        '这是保留在原文中的公开事实。数字 1 2 必须保留边界。这里只用于软件测试和数据完整性验证，不代表真实医学资料。',
      folder = join(root, id, version),
      metadata = {
        id,
        url,
        resolved_url: url,
        title: '合成公开原文',
        kind: 'html',
        retrieved_at: new Date().toISOString(),
        raw_sha256: version,
        text_sha256: sha(normalizedText(text)),
        headers: { 'content-type': 'text/html' },
        original_file: 'original.html',
        reader_file: 'reader.html',
        text_file: 'content.txt',
        links: [],
      }
    for (const [name, body] of [
      ['metadata.json', JSON.stringify(metadata)],
      ['original.html', raw],
      ['reader.html', '<html>reader</html>'],
      ['content.txt', text],
    ] as [string, string | Buffer][])
      await privateWrite(join(folder, name), body)
    assert.equal((await readSource(root, id, version)).text, text)
    await privateWrite(join(folder, 'content.txt'), text + '损坏')
    await assert.rejects(() => readSource(root, id, version))
    await privateWrite(join(folder, 'content.txt'), text)
    await symlink('/etc/passwd', join(folder, 'escape.txt'))
    await assert.rejects(() => confined(root, id, version, 'escape.txt'))
    assert.equal(normalizedText('结果为 1 2 与 12。'), '结果为1 2与12。')
    const parsed = htmlText(
      Buffer.from(
        '<title>标题</title><script>secret()</script><p>可读正文</p><a href="http://127.0.0.1/private">unsafe</a>',
      ),
      'text/html',
      url,
    )
    assert(!parsed.text.includes('secret'))
    assert(!parsed.links.length)
    const evidence = evidenceBlocks(text, version),
      captured = {
        archives: [metadata],
        queries: ['合成机构官网', '合成机构专业背景'],
        evidence_seen: { [id]: [evidence[0].id] },
        search_results: [],
        errors: [],
      },
      rawResult = {
        findings: [
          {
            title: '公开候选',
            details: [
              { label: '姓名', value: '测试医生', source_id: id, evidence_id: evidence[0].id },
            ],
            caveats: [],
          },
        ],
        further_checks: [],
      },
      result = await validateResearch(
        rawResult,
        { fields: ['姓名'], primary_hosts: [], minimum_searches: 2 },
        root,
        captured,
      )
    assert.equal(result.findings[0].details[0].quote, text)
    await assert.rejects(() =>
      validateResearch(
        {
          ...rawResult,
          findings: [
            {
              ...rawResult.findings[0],
              details: [
                { ...rawResult.findings[0].details[0], evidence_id: 'E2-' + version.slice(0, 12) },
              ],
            },
          ],
        },
        { fields: ['姓名'], primary_hosts: [], minimum_searches: 2 },
        root,
        captured,
      ),
    )
  } finally {
    await f.close()
  }
})

test('medical judgments lose their authority when the actual approved content is retired', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>
  f = await fixture({ key: 'synthetic-only', search: false }, async (_input, init) => {
    const body = JSON.parse(String(init?.body)),
      system = JSON.stringify(body.messages[0]),
      content = body.messages.at(-1).content,
      input = JSON.parse(typeof content === 'string' ? content : content[0].text)
    if (system.includes('独立审查医学'))
      return sse({
        judgments: input.map((row: Doc) => ({
          id: row.id,
          admissible: true,
          reason: '仅软件测试',
        })),
      })
    return sse({
      statements: input.statements.map((row: Doc) => ({
        id: row.id,
        status: 'supported',
        reason: '软件合成依据',
        correction: '',
        citations: [{ chunk_id: input.evidence[0].id, quote: input.evidence[0].text }],
      })),
    })
  })
  try {
    const text = '合成教学资料说明：成人研究人群与终点必须核对原始文本。'
    let row = (
      await f.call('POST', '/api/catalog/content', {
        title: '软件合成资料',
        version_label: '1',
        scope: '软件测试',
        pages: [{ number: 1, text }],
      })
    ).json()
    for (const action of ['submit', 'approve'])
      row = (
        await f.call('POST', `/api/catalog/content/${row.id}/review`, {
          version: row.version,
          action,
          reason: '合成流程测试',
        })
      ).json()
    const result = await f.medical.check(user, text)
    assert.equal(result.status, 'supported', JSON.stringify(result))
    const check = { ...result, message_id: 'u', final: true }
    await f.call('POST', `/api/catalog/content/${row.id}/review`, {
      version: row.version,
      action: 'retire',
      reason: '撤销测试资料',
    })
    await f.medical.invalidate(user, [check])
    assert.equal(check.status, 'insufficient')
    assert.equal(check.statements.length, 0)
  } finally {
    await f.close()
  }
})

test('research restart recovers validated checkpoints without replaying provider requests', async () => {
  let network = 0
  const f = await fixture({}, async () => {
    network++
    throw new Error('Unexpected paid call')
  })
  try {
    const job = await f.store.transaction('local', (tx) =>
        tx.create('local', 'research_job', {
          kind: 'doctor',
          query: '合成检索',
          status: 'running',
          source_ids: [],
          usage: {},
          result: null,
          seed_urls: [],
        }),
      ),
      url = 'https://example.org/source',
      id = sha(url).slice(0, 24),
      raw = Buffer.from(
        '这是用于核对研究结果恢复的合成公开文本，不属于任何真实人物的医学事实或职业信息。',
      ),
      version = sha(raw),
      text = raw.toString(),
      metadata = {
        id,
        url,
        resolved_url: url,
        title: '合成原文',
        kind: 'html',
        retrieved_at: new Date().toISOString(),
        raw_sha256: version,
        text_sha256: sha(normalizedText(text)),
        headers: {},
        original_file: 'original.html',
        reader_file: 'reader.html',
        text_file: 'content.txt',
        links: [],
      },
      folder = join(f.research.archives, id, version)
    for (const [name, body] of [
      ['metadata.json', JSON.stringify(metadata)],
      ['original.html', raw],
      ['reader.html', 'reader'],
      ['content.txt', text],
    ] as [string, string | Buffer][])
      await privateWrite(join(folder, name), body)
    const block = evidenceBlocks(text, version)[0],
      captured = {
        archives: [metadata],
        queries: ['query one', 'query two'],
        evidence_seen: { [id]: [block.id] },
        search_results: [],
        errors: [],
      },
      result = {
        findings: [
          {
            title: '合成身份',
            details: [{ label: '姓名', value: '虚构候选', source_id: id, evidence_id: block.id }],
            caveats: [],
          },
        ],
        further_checks: ['待人工核对'],
      }
    await privateWrite(
      join(f.research.base, 'jobs', job.id, 'observations.json'),
      JSON.stringify(captured),
    )
    await privateWrite(
      join(f.research.base, 'jobs', job.id, 'result.json'),
      JSON.stringify({ result, usage: { prompt_tokens: 10 } }),
    )
    await f.research.recover()
    const recovered = await f.research.get(user, job.id)
    assert.equal(recovered.status, 'completed')
    assert.equal(recovered.result.findings[0].details[0].source_version, version)
    assert.equal(network, 0)
  } finally {
    await f.close()
  }
})

test(
  'PostgreSQL preserves the existing tables, transaction conflicts and records across restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const base = new URL(process.env.TEST_DATABASE_URL!)
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
      'Only a disposable loopback database is permitted',
    )
    const admin = new Pool({ connectionString: base.href }),
      name = 'breathon_ts_' + uuid().replaceAll('-', '')
    await admin.query(`CREATE DATABASE ${name}`)
    base.pathname = '/' + name
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      f = await fixture({ database: base.href })
      let row = (
        await f.call('POST', '/api/catalog/audience', {
          name: '合成人群',
          audience_type: 'representative',
          task: '验证事务',
          needs: ['一致性'],
        })
      ).json()
      assert(row.id)
      const content = (await f.call('POST', '/api/catalog/content', {
        title: '隔离PG全文投影验证', version_label: 'v1', scope: '合成测试',
        pages: [{ number: 1, text: '只用于软件测试的全文内容。'.repeat(100) }],
      })).json()
      const listed = (await f.call('GET', '/api/catalog/content')).json().find((item: Doc) => item.id === content.id)
      assert(listed)
      assert.equal('pages' in listed, false)
      assert.deepEqual((await f.call('GET', `/api/catalog/content/${content.id}`)).json().pages, content.pages)
      await f.store.transaction(f.store.workspace, async tx => {
        const full = await tx.get(f!.store.workspace, 'content', content.id)
        const metadata = await tx.get(f!.store.workspace, 'content', content.id, true)
        assert(full && metadata)
        const { pages, ...expected } = full
        assert.deepEqual(metadata, expected)
        assert.deepEqual(pages, content.pages)
      }, false)
      const updates = await Promise.all([
        f.call('PUT', `/api/catalog/audience/${row.id}`, {
          name: '第一次修改',
          audience_type: 'representative',
          task: '验证事务',
          needs: ['一致性'],
          version: row.version,
        }),
        f.call('PUT', `/api/catalog/audience/${row.id}`, {
          name: '第二次修改',
          audience_type: 'representative',
          task: '验证事务',
          needs: ['一致性'],
          version: row.version,
        }),
      ])
      assert.deepEqual(updates.map((r) => r.statusCode).sort(), [200, 409])
      const record = newRecord(user, 'practice', 'assisted')
      record.messages.push({ id: 'u', role: 'trainee', text: '保留的合成学员原话。', final: true })
      await f.store.saveRecord(record, 'completed')
      const recovery = join(f.root, 'recovery')
      await mkdir(recovery)
      await privateWrite(join(recovery, record.id + '.json'), JSON.stringify(record))
      assert.deepEqual(await f.store.importRecords(recovery), { imported: 0, existing: 1 })
      const extra = { ...record, id: uuid() }
      await privateWrite(join(recovery, extra.id + '.json'), JSON.stringify(extra))
      await privateWrite(join(recovery, uuid() + '.json'), '{invalid')
      await assert.rejects(() => f.store.importRecords(recovery))
      assert.equal(await f.store.record(extra.id), null)

      await f.app.close()
      const restarted = await createApp(f.config)
      await restarted.app.ready()
      try {
        assert.equal(
          (await restarted.store.record(record.id))?.messages[0].text,
          '保留的合成学员原话。',
        )
        assert.equal((await restarted.app.inject('/api/ready')).statusCode, 200)
      } finally {
        await restarted.app.close()
      }
    } finally {
      await f?.close()
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
      await admin.end()
    }
  },
)
