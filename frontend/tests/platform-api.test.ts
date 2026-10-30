import assert from 'node:assert/strict'
import test from 'node:test'
import { api } from '../src/lib/platform-api.ts'

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
    assert.equal(options.body, '{}')
    assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json')
    assert.equal('timeoutMs' in options, false)
    return Response.json({ id: 'scene' })
  })
  assert.deepEqual(await api('/scenarios/generate', {
    method: 'POST', body: '{}', signal: new AbortController().signal, timeoutMs: 60000,
  }), { id: 'scene' })
})
