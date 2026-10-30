import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function mount(fetcher: typeof fetch, target: 'admin'|'android' = 'android') {
  const slots: any[] = [], effects: (() => void)[] = []
  const timers = new Map<number, { callback: () => void; at: number }>()
  const listeners = new Map<string, Set<() => void>>()
  const removedCache: string[] = []
  let cursor = 0, now = Date.now(), timerId = 0
  const react = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
    useEffect(callback: () => (() => void) | void, dependencies: any[]) {
      const i = cursor++, previous = slots[i]
      if (!previous || dependencies.some((value, j) => value !== previous.dependencies[j])) {
        const effect = { dependencies, cleanup: undefined as (() => void) | void }
        slots[i] = effect
        effects.push(() => { previous?.cleanup?.(); effect.cleanup = callback() })
      }
    },
  }
  const jsx = (type: unknown, props: any, key: unknown) => ({ type, props, key })
  const exports: { AuthGate?: (props: unknown) => any } = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/auth-gate.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, fetch: fetcher, AbortController, AbortSignal, Date: { now: () => now },
    FormData: class { get(name: string) { return name === 'username' ? 'admin' : 'a-test-password' } },
    window: {
      setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id },
      clearTimeout(id: number) { timers.delete(id) },
      addEventListener(name: string, callback: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback) },
      removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback) },
    },
    localStorage: { removeItem(key: string) { removedCache.push(key) } },
    require: (name: string) => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  const dispatch = (name: string) => { [...(listeners.get(name) ?? [])].forEach(callback => callback()) }
  return {
    removedCache,
    render() { cursor = 0; const view = exports.AuthGate!({ AppComponent: 'App', target }); effects.splice(0).forEach(effect => effect()); return view },
    expire() { now += 9 * 60 * 60 * 1000; [...timers].forEach(([id, timer]) => { if (timer.at <= now) { timers.delete(id); timer.callback() } }) },
    focus() { dispatch('focus') },
    unauthorized() { dispatch('medvisit:unauthorized') },
  }
}
function find(node: any, type: string): any[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}
function text(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return node && typeof node === 'object' ? text(node.props?.children) : ''
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const anonymous = { enabled: true, authenticated: false, expires_at: null }
const authenticated = (username = 'admin', role = 'representative') => ({ enabled: true, authenticated: true, expires_at: Date.now() / 1000 + 28800, username, role })
const formEvent = (reset = () => {}) => ({ preventDefault() {}, currentTarget: { reset } })

test('missing, malformed and incomplete identities never mount the private application', async () => {
  for (const fetcher of [
    async () => { throw new Error('offline') },
    async () => Response.json({}),
    async () => Response.json({ ...authenticated(), username: undefined }),
    async () => Response.json({ ...authenticated(), role: 'unknown' }),
    async () => Response.json({ ...authenticated(), enabled: false }),
  ]) {
    const app = mount(fetcher)
    assert.equal(find(app.render(), 'App').length, 0)
    await settle()
    const view = app.render()
    assert.equal(find(view, 'App').length, 0)
    assert.ok(find(view, 'Alert').length)
    assert.equal(find(view, 'form').length, 0)
  }
})

test('Android requires server authentication while local web management stays compatible', async () => {
  const local = { enabled: false, authenticated: false, expires_at: null, role: 'admin' }
  const android = mount(async () => Response.json(local))
  android.render(); await settle()
  const blocked = android.render()
  assert.equal(find(blocked, 'App').length, 0)
  assert.equal(find(blocked, 'form').length, 0)
  assert.match(text(blocked), /服务器尚未开启账号登录/)
  assert.ok(find(blocked, 'Button').some(button => text(button) === '重新连接'))
  const admin = mount(async () => Response.json(local), 'admin')
  admin.render(); await settle()
  const application = find(admin.render(), 'App')[0]
  assert.equal(application.props.role, 'admin')
  assert.equal(application.props.onLogout, undefined)
})

test('invalid credentials keep the form; cookie login and logout update the application', async () => {
  let valid = false, resets = 0
  const calls: string[] = []
  const app = mount(async (url, options) => {
    calls.push(String(url))
    assert.equal(options?.credentials, 'same-origin')
    if (url === '/api/auth/session') {
      assert.equal(options?.cache, 'no-store')
      return Response.json(anonymous)
    }
    if (url === '/api/auth/logout') return Response.json({ ok: true })
    assert.equal(options?.method, 'POST')
    assert.deepEqual(JSON.parse(String(options?.body)), { username: 'admin', password: 'a-test-password' })
    return valid ? Response.json(authenticated()) : Response.json({ detail: 'invalid' }, { status: 401 })
  })
  app.render(); await settle()
  let view = app.render()
  assert.equal(find(view, 'a')[0].props.href, '#home')
  const password = find(view, 'Input').find(node => node.props.name === 'password')
  assert.equal(password.props.autoComplete, 'current-password')
  assert.equal(password.props.type, 'password')
  const submit = async () => { await find(app.render(), 'form')[0].props.onSubmit(formEvent(() => { resets++ })) }
  await submit()
  assert.equal(find(app.render(), 'App').length, 0)
  assert.match(text(app.render()), /账号或密码不正确/)
  assert.equal(resets, 0)
  valid = true
  await submit()
  view = app.render()
  assert.equal(find(view, 'App')[0].props.role, 'representative')
  assert.equal(resets, 1)
  await find(view, 'App')[0].props.onLogout()
  assert.equal(find(app.render(), 'App').length, 0)
  assert.equal(calls.at(-1), '/api/auth/logout')
  assert.deepEqual(app.removedCache, ['medvisit.service-status'])
})

test('local expiry and an expired server cookie both require login again', async () => {
  const app = mount(async () => Response.json(authenticated()))
  app.render(); await settle()
  assert.equal(find(app.render(), 'App').length, 1)
  app.expire()
  assert.equal(find(app.render(), 'App').length, 0)
  assert.match(text(app.render()), /登录已失效/)
  assert.equal(app.removedCache.length, 1)
  const stale = mount(async () => Response.json({ ...authenticated(), expires_at: Date.now() / 1000 - 1 }))
  stale.render(); await settle()
  assert.equal(find(stale.render(), 'App').length, 0)
  assert.equal(find(stale.render(), 'form').length, 1)
})

test('confirmed account or role switches remount isolated application state', async () => {
  let session = authenticated('representative-a')
  const app = mount(async () => Response.json(session))
  app.render(); await settle()
  const original = find(app.render(), 'App')[0]
  session = authenticated('representative-b')
  app.focus(); await settle()
  const switched = find(app.render(), 'App')[0]
  assert.equal(switched.props.username, 'representative-b')
  assert.notEqual(switched.key, original.key)
  session = authenticated('representative-b', 'admin')
  app.focus(); await settle()
  assert.notEqual(find(app.render(), 'App')[0].key, switched.key)
  assert.equal(app.removedCache.length, 2)
})

test('temporary focus failures preserve verified identity and recover on retry', async () => {
  let offline = false
  const app = mount(async () => { if (offline) throw new Error('offline'); return Response.json(authenticated()) })
  app.render(); await settle()
  const original = find(app.render(), 'App')[0]
  offline = true
  app.focus(); await settle()
  let view = app.render()
  assert.equal(find(view, 'App')[0].key, original.key)
  assert.match(text(view), /无法连接服务器/)
  assert.equal(app.removedCache.length, 0)
  offline = false
  find(view, 'Button').find(button => text(button) === '重新连接').props.onClick()
  app.render(); await settle()
  view = app.render()
  assert.equal(find(view, 'App')[0].key, original.key)
  assert.equal(find(view, 'Alert').length, 0)
})

test('a late API 401 rechecks the current cookie before removing a newer session', async () => {
  let current: any = authenticated()
  const app = mount(async () => Response.json(current))
  app.render(); await settle()
  const original = find(app.render(), 'App')[0]
  app.unauthorized(); await settle()
  assert.equal(find(app.render(), 'App')[0].key, original.key)
  assert.equal(app.removedCache.length, 0)
  current = anonymous
  app.unauthorized(); await settle()
  const view = app.render()
  assert.equal(find(view, 'App').length, 0)
  assert.equal(find(view, 'form').length, 1)
  assert.match(text(view), /登录已失效/)
  assert.equal(app.removedCache.length, 1)
})

test('a stale anonymous response cannot overwrite a successful login', async () => {
  let sessionReads = 0, finishRead!: (response: Response) => void
  const app = mount(async url => {
    if (url === '/api/auth/login') return Response.json(authenticated('new-user'))
    if (++sessionReads === 1) return Response.json(anonymous)
    return new Promise<Response>(resolve => { finishRead = resolve })
  })
  app.render(); await settle()
  app.focus()
  await find(app.render(), 'form')[0].props.onSubmit(formEvent())
  assert.equal(find(app.render(), 'App')[0].props.username, 'new-user')
  finishRead(Response.json(anonymous)); await settle()
  assert.equal(find(app.render(), 'App')[0].props.username, 'new-user')
})

test('focus and old 401 events cannot interrupt an in-progress login', async () => {
  let sessionReads = 0, finishLogin!: (response: Response) => void
  const app = mount(async url => {
    if (url === '/api/auth/session') { sessionReads++; return Response.json(anonymous) }
    return new Promise<Response>(resolve => { finishLogin = resolve })
  })
  app.render(); await settle()
  const login = find(app.render(), 'form')[0].props.onSubmit(formEvent())
  app.focus(); app.unauthorized()
  assert.equal(sessionReads, 1)
  finishLogin(Response.json(authenticated('new-user')))
  await login
  assert.equal(find(app.render(), 'App')[0].props.username, 'new-user')
})

test('failed logout preserves the session; confirmed missing cookie logs out', async () => {
  let status = 503
  const app = mount(async url => url === '/api/auth/session' ? Response.json(authenticated()) : Response.json({}, { status }))
  app.render(); await settle()
  let view = app.render()
  await find(view, 'App')[0].props.onLogout()
  view = app.render()
  assert.equal(find(view, 'App').length, 1)
  assert.match(text(view), /退出失败/)
  assert.equal(app.removedCache.length, 0)
  status = 401
  await find(view, 'App')[0].props.onLogout()
  assert.equal(find(app.render(), 'App').length, 0)
  assert.equal(app.removedCache.length, 1)
})

test('the web management entry rejects representative sessions but permits admins', async () => {
  const login = mount(async () => Response.json(anonymous), 'admin')
  login.render(); await settle()
  assert.equal(find(login.render(), 'a')[0].props.href, '/admin')
  const representative = mount(async () => Response.json(authenticated()), 'admin')
  representative.render(); await settle()
  const blocked = representative.render()
  assert.equal(find(blocked, 'App').length, 0)
  assert.ok(find(blocked, 'p').some(node => node.props.role === 'alert'))
  const admin = mount(async () => Response.json(authenticated('admin', 'admin')), 'admin')
  admin.render(); await settle()
  assert.equal(find(admin.render(), 'App').length, 1)
})


test('both login targets omit the removed footer notice', async () => {
  for (const target of ['admin', 'android'] as const) {
    const app = mount(async () => Response.json(anonymous), target)
    app.render(); await settle()
    const view = app.render()
    assert.equal(find(view, 'form').length, 1)
    assert.equal(find(view, 'Brand').length, 1)
    assert.doesNotMatch(text(view), /管理员可查看演练和拜访记录|请勿输入未经授权的患者信息/)
  }
})
