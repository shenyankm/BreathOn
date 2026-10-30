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
