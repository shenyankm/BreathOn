import assert from 'node:assert/strict'
import test from 'node:test'
import { api, ApiError } from '../src/lib/platform-api.ts'

test('caller cancellation and the API deadline both end stalled requests', async t => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 30000)
    return deadline.signal
  })
  t.mock.method(globalThis, 'fetch', (_input: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  }))
  const caller = new AbortController()
  const cancelled = api('/catalog/scenario', { signal: caller.signal })
  caller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })

  const active = new AbortController()
  const stalled = api('/catalog/scenario', { signal: active.signal })
  const rejected = assert.rejects(stalled, { name: 'TimeoutError' })
  deadline.abort(new DOMException('Timed out', 'TimeoutError'))
  await rejected
  assert.equal(active.signal.aborted, false)
})

test('long generation requests retain their 60 second deadline and JSON body', async t => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 60000)
    return deadline.signal
  })
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    assert.equal(input, '/api/scenarios/generate')
    assert.equal(options.method, 'POST')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.body, '{}')
    assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json')
    assert.equal('timeoutMs' in options, false)
    return Response.json({ id: 'scene' })
  })
  assert.deepEqual(await api('/scenarios/generate', {
    method: 'POST', body: '{}', signal: new AbortController().signal, timeoutMs: 60000,
  }), { id: 'scene' })
})


test('only a server 401 notifies the auth gate and API errors stay intact', async t => {
  const browser = new EventTarget(), events: string[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') })
  browser.addEventListener('medvisit:unauthorized', event => events.push(event.type))
  let status: number | null = 401
  t.mock.method(globalThis, 'fetch', async (_input: string, options: RequestInit) => {
    assert.equal(options.credentials, 'omit')
    if (status === null) throw new TypeError('Network unavailable')
    return Response.json({ detail: `Server response ${status}` }, { status })
  })
  for (const code of [401, 403, 503]) {
    status = code
    await assert.rejects(api('/sessions', { credentials: 'omit' }), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, code)
      assert.equal(error.message, `Server response ${code}`)
      return true
    })
  }
  status = null
  await assert.rejects(api('/sessions', { credentials: 'omit' }), { name: 'TypeError' })
  assert.deepEqual(events, ['medvisit:unauthorized'])
})

test('a non-browser 401 remains an ApiError', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Please sign in' }, { status: 401 }))
  await assert.rejects(api('/sessions'), error => error instanceof ApiError && error.status === 401)
})

for (const status of [408, 429, 502, 503, 504]) test(`safe read recovers once from ${status}`, async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('temporary', { status, headers: { 'Retry-After': '0' } }) : Response.json({ recovered: true }))
  assert.deepEqual(await api('/sessions'), { recovered: true })
  assert.equal(calls, 2)
})

test('network read failure retries once and never loops', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('offline') })
  await assert.rejects(api('/sessions'), /offline/)
  assert.equal(calls, 2)
})

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${method} is never automatically replayed`, async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unavailable', { status: 503 }) })
  await assert.rejects(api('/visits', { method }), error => error instanceof ApiError && error.status === 503)
  assert.equal(calls, 1)
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('response lost') })
  await assert.rejects(api('/visits', { method }), /尚未确认操作结果/)
  assert.equal(calls, 2)
})

test('cancellation during backoff prevents the next request', async t => {
  const caller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 503, headers: { 'Retry-After': '2' } }) })
  const pending = api('/sessions', { signal: caller.signal })
  await new Promise(resolve => setImmediate(resolve))
  caller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('retry uses the original deadline and stops when it expires', async t => {
  const deadline = new AbortController()
  let deadlines = 0, calls = 0
  t.mock.method(AbortSignal, 'timeout', () => { deadlines++; return deadline.signal })
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 503, headers: { 'Retry-After': '2' } }) })
  const pending = api('/sessions')
  await new Promise(resolve => setImmediate(resolve))
  deadline.abort(new DOMException('Timed out', 'TimeoutError'))
  await assert.rejects(pending, { name: 'TimeoutError' })
  assert.equal(deadlines, 1); assert.equal(calls, 1)
})

test('long or invalid Retry-After values never trigger an early retry', async t => {
  let calls = 0
  for (const value of ['60', new Date(Date.now() + 60000).toUTCString(), 'invalid']) {
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': value } }) })
    await assert.rejects(api('/sessions'), error => error instanceof ApiError && error.status === 429)
  }
  assert.equal(calls, 3)
})

test('non-transient statuses and malformed error bodies remain actionable', async t => {
  let calls = 0
  for (const [status, body] of [[400, 'null'], [403, '<html>forbidden</html>'], [404, '{}'], [409, '{"detail":[null,{}, {"loc":123,"msg":false}]}'], [500, '[]']] as const) {
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(body, { status }) })
    await assert.rejects(api('/sessions'), error => error instanceof ApiError && error.status === status && error.message.length > 0)
  }
  assert.equal(calls, 5)
})

test('empty success and HEAD do not parse JSON', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }))
  assert.equal(await api('/visits', { method: 'DELETE' }), undefined)
  t.mock.method(globalThis, 'fetch', async () => new Response(null))
  assert.equal(await api('/sessions', { method: 'HEAD' }), undefined)
})

test('invalid success payload does not replay a write and explains uncertain completion', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('<html>proxy</html>') })
  await assert.rejects(api('/visits', { method: 'POST' }), /刷新确认操作结果/)
  assert.equal(calls, 1)
  await assert.rejects(api('/sessions'), /重新加载/)
  assert.equal(calls, 2)
})

test('Headers instances preserve upload content type and authorization headers', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers)
    assert.equal(headers.get('Content-Type'), 'audio/mp4')
    assert.equal(headers.get('X-Recording-Authorized'), 'true')
    return Response.json({})
  })
  await api('/visits/one/audio', { method: 'POST', body: new Blob(['audio']), headers: new Headers({ 'Content-Type': 'audio/mp4', 'X-Recording-Authorized': 'true' }) })
})

test('pre-cancelled reads do not reach the network', async t => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch') })
  await assert.rejects(api('/sessions', { signal: AbortSignal.abort() }), { name: 'AbortError' })
})
