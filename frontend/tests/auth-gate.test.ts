import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function mount(fetcher: typeof fetch) {
  const slots: any[] = [], effects: (() => void)[] = [], timers: (() => void)[] = []
  let cursor = 0, now = Date.now()
  const react = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useEffect(callback: () => void, dependencies: any[]) {
      const i = cursor++
      if (!slots[i] || dependencies.some((value, j) => value !== slots[i][j])) {
        effects.push(callback); slots[i] = dependencies
      }
    },
  }
  const jsx = (type: unknown, props: any) => ({ type, props })
  const exports: { AuthGate?: () => any } = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/auth-gate.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, fetch: fetcher, AbortController, AbortSignal, Date: { now: () => now },
    FormData: class { get(name: string) { return name === 'username' ? 'admin' : 'a-test-password' } },
    window: { setTimeout(callback: () => void) { timers.push(callback); return timers.length }, clearTimeout() {}, addEventListener() {}, removeEventListener() {} },
    localStorage: { removeItem() {} },
    require: (name: string) => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (name === '../App') return { __esModule: true, default: 'App' }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    render() { cursor = 0; const view = exports.AuthGate!(); effects.splice(0).forEach(effect => effect()); return view },
    expire() { now += 9 * 60 * 60 * 1000; timers.forEach(timer => timer()) },
  }
}
function find(node: any, type: string): any[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const anonymous = { enabled: true, authenticated: false, expires_at: null }
const authenticated = () => ({ enabled: true, authenticated: true, expires_at: Date.now() / 1000 + 28800 })

test('a missing or malformed session never mounts the private application', async () => {
  for (const fetcher of [async () => { throw new Error('offline') }, async () => Response.json({})]) {
    const app = mount(fetcher)
    assert.equal(find(app.render(), 'App').length, 0)
    await settle()
    const view = app.render()
    assert.equal(find(view, 'App').length, 0)
    assert.ok(find(view, 'p').some(node => node.props.role === 'alert'))
    assert.equal(find(view, 'form').length, 0)
  }
})

test('invalid credentials keep the form; login mounts the app and logout removes it', async () => {
  let valid = false, resets = 0
  const calls: string[] = []
  const app = mount(async (url, options) => {
    calls.push(String(url))
    if (url === '/api/auth/session') return Response.json(anonymous)
    if (url === '/api/auth/logout') return Response.json({ ok: true })
    assert.equal(options?.method, 'POST')
    assert.deepEqual(JSON.parse(String(options?.body)), { username: 'admin', password: 'a-test-password' })
    return valid ? Response.json(authenticated()) : Response.json({ detail: 'invalid' }, { status: 401 })
  })
  app.render(); await settle()
  let view = app.render()
  const password = find(view, 'Input').find(node => node.props.name === 'password')
  assert.equal(password.props.autoComplete, 'current-password')
  assert.equal(password.props.type, 'password')
  const submit = async () => { await find(app.render(), 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { reset() { resets++ } } }) }
  await submit()
  assert.equal(find(app.render(), 'App').length, 0)
  assert.equal(resets, 0)
  valid = true
  await submit()
  view = app.render()
  assert.equal(find(view, 'App').length, 1)
  assert.equal(resets, 1)
  await find(view, 'App')[0].props.onLogout()
  assert.equal(find(app.render(), 'App').length, 0)
  assert.equal(calls.at(-1), '/api/auth/logout')
})

test('session expiry unmounts the private application', async () => {
  const app = mount(async () => Response.json(authenticated()))
  app.render(); await settle()
  assert.equal(find(app.render(), 'App').length, 1)
  app.expire()
  assert.equal(find(app.render(), 'App').length, 0)
})
