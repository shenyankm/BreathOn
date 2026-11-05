import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { fixture, origin } from './helpers.ts'
import { resource, type Doc, canonical, identity } from '../src/core.ts'
import { hashPassword } from '../src/password.ts'
import { estimateCost } from '../src/platform.ts'
import { parse } from '../src/validation.ts'
import { kappa } from '../src/operations.ts'

test('all existing HTTP routes and the realtime endpoint are registered', async () => {
  const f = await fixture()
  try {
    for (const [path, methods] of Object.entries(resource('api-contract').paths))
      for (const method of Object.keys(methods))
        assert.equal(
          f.app.hasRoute({
            method: method.toUpperCase() as any,
            url: path.replace(/\{([^}]+)\}/g, ':$1'),
          }),
          true,
          `${method} ${path}`,
        )
    assert(f.app.hasRoute({ method: 'GET', url: '/api/realtime' }))
    const health = await f.call('GET', '/api/health')
    assert.equal(health.json().agent_framework, 'pi')
    assert.equal((await f.call('GET', '/api/ready')).statusCode, 200)
  } finally {
    await f.close()
  }
})

test('legacy scrypt credentials, cookie revocation, Origin and account isolation survive the runtime change', async () => {
  const encoded = await hashPassword('synthetic-only-password'),
    f = await fixture({
      auth: true,
      users: { admin: encoded, rep: encoded, other: encoded },
      admins: ['admin'],
    })
  try {
    assert.equal((await f.call('GET', '/api/sessions')).statusCode, 401)
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/auth/login',
          { username: 'rep', password: 'synthetic-only-password' },
          { Origin: 'https://untrusted.invalid' },
        )
      ).statusCode,
      403,
    )
    const login = await f.call('POST', '/api/auth/login', {
        username: 'rep',
        password: 'synthetic-only-password',
      }),
      cookie = String(login.headers['set-cookie']).split(';')[0]
    assert.equal(login.statusCode, 200)
    assert.equal(login.json().role, 'representative')
    assert(cookie.startsWith('medvisit_session='))
    assert.equal(
      (await f.call('GET', '/api/admin/settings', undefined, { Cookie: cookie })).statusCode,
      403,
    )
    const created = await f.call(
      'POST',
      '/api/visits',
      { visited_at: '2026-01-01', text: '自述测试' },
      { Cookie: cookie },
    )
    assert.equal(created.statusCode, 201)
    const otherLogin = await f.call('POST', '/api/auth/login', {
        username: 'other',
        password: 'synthetic-only-password',
      }),
      other = String(otherLogin.headers['set-cookie']).split(';')[0]
    assert.equal(
      (await f.call('GET', `/api/visits/${created.json().id}`, undefined, { Cookie: other }))
        .statusCode,
      404,
    )
    assert.equal(
      (await f.call('POST', '/api/auth/logout', undefined, { Cookie: cookie })).statusCode,
      200,
    )
    assert.equal(
      (await f.call('GET', '/api/sessions', undefined, { Cookie: cookie })).statusCode,
      401,
    )
  } finally {
    await f.close()
  }
})

test('catalogue edits use CAS, approved evidence is revoked by revisions, and stable doctor identity retains history', async () => {
  const f = await fixture()
  try {
    let doc = (
      await f.call('POST', '/api/catalog/content', {
        title: '合成资料',
        version_label: 'v1',
        scope: '软件测试',
        pages: [{ number: 1, text: '这是用于核对逐字引文与版本的合成教学材料。' }],
      })
    ).json()
    for (const action of ['submit', 'approve']) {
      const response = await f.call('POST', `/api/catalog/content/${doc.id}/review`, {
        version: doc.version,
        action,
        reason: '合成流程测试',
      })
      assert.equal(response.statusCode, 200, response.body)
      doc = response.json()
    }
    const doctorBody = {
        name: '虚构医生',
        specialty: '内分泌科',
        population: '训练人群',
        focus: '来源边界',
        training_style: '每次一个问题',
        opening: '你好',
      },
      created = await f.call('POST', '/api/catalog/doctor', doctorBody)
    assert.equal(created.statusCode, 201, created.body)
    let doctor = created.json()
    assert.equal(
      (await f.call('PUT', `/api/catalog/doctor/${doctor.id}`, { ...doctorBody, version: 99 }))
        .statusCode,
      409,
    )
    doctor = (
      await f.call('POST', `/api/catalog/doctor/${doctor.id}/publish`, { version: doctor.version })
    ).json()
    const revision = (await f.call('POST', `/api/catalog/doctor/${doctor.id}/revision`)).json()
    const edited = await f.call('PUT', `/api/catalog/doctor/${revision.id}`, {
      ...doctorBody,
      name: '虚构医生修订',
      version: revision.version,
    })
    assert.equal(edited.statusCode, 200, edited.body)
    const published = await f.call('POST', `/api/catalog/doctor/${revision.id}/publish`, {
      version: edited.json().version,
    })
    assert.equal(published.statusCode, 200, published.body)
    assert.equal(published.json().id, doctor.id)
    assert.equal(published.json().name, '虚构医生修订')
    assert(
      (await f.call('GET', `/api/admin/catalog/doctor/${doctor.id}/history`))
        .json()
        .some((row: Doc) => row.source_version === doctor.version),
    )
    const file = await stat(f.config.records + '/platform.sqlite3')
    assert.equal(file.mode & 0o777, 0o600)
  } finally {
    await f.close()
  }
})

test('input validation retains the custom rules that JSON schema alone cannot express', () => {
  for (const value of ['invalid', 123, true, [], null, { name: 123 }])
    assert.throws(
      () => parse('platform.models.Drug', value),
      (error: any) => error.status === 422 || error.statusCode === 422,
    )
  const content = {
    title: '测试',
    version_label: '1',
    scope: '测试',
    pages: [{ number: 1, text: '原文' }],
  }
  assert.throws(() =>
    parse('platform.models.Content', { ...content, pages: [...content.pages, ...content.pages] }),
  )
  assert.throws(() =>
    parse('platform.models.Content', { ...content, source_url: 'http://127.0.0.1/private' }),
  )
  assert.throws(
    () =>
      parse('platform.models.Content', { ...content, secret: 'private input must not be echoed' }),
    (error) => !String(error).includes('private input'),
  )
  assert.throws(() =>
    parse('platform.models.Rubric', {
      name: '量表',
      dimensions: [
        { key: 'needs', label: '需求', weight: 99, anchors: ['一', '二', '三', '四', '五'] },
      ],
    }),
  )
  assert.throws(() =>
    parse('platform.models.Doctor', {
      name: '公开医生',
      specialty: '科室',
      background_type: 'public',
      population: '测试',
      focus: '测试',
      training_style: '测试',
      opening: '你好',
    }),
  )
  assert.equal(
    parse('platform.models.Drug', { name: '玛仕度肽注射液' }).practice_departments[0],
    '内分泌科',
  )
})

test('decimal pricing and calibration statistics retain their numerical boundaries', () => {
  const rate = {
    provider: 'deepseek',
    model: 'mock',
    unit: 'input_tokens',
    amount: '0.1',
    per_units: 1,
    currency: 'CNY',
  }
  assert.equal(
    estimateCost(
      [{ provider: 'deepseek', model: 'mock', prompt_tokens: 3, completion_tokens: 0 }],
      [rate],
    ).totals.CNY,
    '0.300000',
  )
  assert.equal(
    estimateCost(
      [{ provider: 'deepseek', model: 'mock', prompt_tokens: 1, completion_tokens: 2 }],
      [],
    ).status,
    'unavailable',
  )
  assert.equal(
    kappa([
      [0, 0],
      [4, 4],
    ]),
    1,
  )
  assert.equal(
    kappa([
      [2, 2],
      [2, 2],
    ]),
    null,
  )
})

test('recording text stays in a private file and stale edits never delete committed text', async () => {
  const f = await fixture()
  try {
    let created = await f.call('POST', '/api/visits', {
      source: 'recording',
      visited_at: '2026-01-01',
      text: '原始私人转写',
    })
    assert.equal(created.statusCode, 201, created.body)
    let row = created.json()
    assert.equal(row.text, '原始私人转写')
    const user = {
        id: 'local',
        workspace: f.store.workspace,
        role: 'admin' as const,
        team: '',
        authenticated: false,
      },
      stored = await f.store.transaction(
        user.workspace,
        (tx) => tx.require(user.workspace, 'visit', row.id),
        false,
      )
    assert(!('text' in stored))
    assert.equal((await stat(f.visits.folder + '/' + stored.transcript_file)).mode & 0o777, 0o600)
    const failed = await f.call('PUT', `/api/visits/${row.id}`, {
      version: 99,
      visited_at: '2026-01-01',
      text: '未提交修改',
    })
    assert.equal(failed.statusCode, 409)
    assert.equal((await f.call('GET', `/api/visits/${row.id}`)).json().text, '原始私人转写')
    const edited = await f.call('PUT', `/api/visits/${row.id}`, {
      version: row.version,
      visited_at: '2026-01-01',
      text: '成功提交转写',
    })
    assert.equal(edited.statusCode, 200, edited.body)
    assert.equal((await f.call('GET', `/api/visits/${row.id}`)).json().text, '成功提交转写')
    const committed = edited.json(),
      transact = f.store.transaction.bind(f.store)
    let failOnce = true
    f.store.transaction = (async (...args: any[]) => {
      const result = await (transact as any)(...args)
      if (failOnce && result?.id === row.id && result?.version === committed.version + 1) {
        failOnce = false
        throw new Error('Synthetic lost commit acknowledgement')
      }
      return result
    }) as typeof f.store.transaction
    const uncertain = await f.call('PUT', `/api/visits/${row.id}`, {
      version: committed.version,
      visited_at: '2026-01-01',
      text: '已经提交但确认丢失的转写',
    })
    assert.equal(uncertain.statusCode, 503)
    f.store.transaction = transact
    assert.equal(
      (await f.call('GET', `/api/visits/${row.id}`)).json().text,
      '已经提交但确认丢失的转写',
    )
  } finally {
    await f.close()
  }
})
