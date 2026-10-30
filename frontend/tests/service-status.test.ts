import assert from 'node:assert/strict'
import test from 'node:test'
import { loadServiceStatus, readServiceStatus, saveServiceStatus } from '../src/lib/service-status.ts'

const good = { ok: true, message: '', model: 'configured-model' }
const bad = { ok: false, message: '服务返回异常。', model: 'configured-model' }
const services = { asr: good, practice: bad, tts: bad, combat: good, analysis: good }

test('service checks request real probes and preserve failures', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    assert.equal(input, '/api/services/check')
    assert.equal(options.method, 'POST')
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json({ services })
  })
  const result = await readServiceStatus(new AbortController().signal)
  assert.equal(result.asr.ok, true)
  assert.equal(result.practice.ok, false)
  assert.equal(result.tts.message, bad.message)
  assert.equal(result.combat.ok, true)
  assert.equal(result.practice.model, 'configured-model')
})

test('failed HTTP checks reject without a replacement result', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  await assert.rejects(readServiceStatus(new AbortController().signal), /检查失败/)
})

test('configuration flags and incomplete probe results cannot appear healthy', async t => {
  for (const value of [null, {}, [], { status: 'ok', asr_configured: true },
    { services: { ...services, asr: { ok: 'true', message: '' } } },
    { services: { ...services, tts: undefined } },
    { services: { ...services, analysis: { ok: true } } },
    { services: { ...services, analysis: { ...good, model: '' } } }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(value))
    await assert.rejects(readServiceStatus(new AbortController().signal), /格式无效|不完整/)
    mock.mock.restore()
  }
})

test('leaving the page can abort an in-flight service check', async t => {
  t.mock.method(globalThis, 'fetch', (_input: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  }))
  const controller = new AbortController()
  const request = readServiceStatus(controller.signal)
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
})

test('last results restore locally without a service call and invalid cache is ignored', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let cached: string | null = null
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => cached,
    setItem: (_key: string, value: string) => { cached = value },
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call services') })
  assert.equal(loadServiceStatus(), null)
  saveServiceStatus(services)
  assert.deepEqual(loadServiceStatus(), services)
  assert.deepEqual(loadServiceStatus(), services)
  for (const value of ['not-json', '{}', JSON.stringify({ services: { asr: good } })]) {
    cached = value
    assert.equal(loadServiceStatus(), null)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('blocked storage does not break service status display', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked storage') } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  assert.equal(loadServiceStatus(), null)
  assert.doesNotThrow(() => saveServiceStatus(services))
})
