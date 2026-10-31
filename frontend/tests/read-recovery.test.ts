import { doctorLabel } from '../src/lib/doctor-label.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { indexProductSources } from '../src/lib/medical.ts'

type Node = { type: unknown; props: any }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function nodes(node: any, type: string): Node[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type))
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)]
}
function text(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return node && typeof node === 'object' ? text(node.props?.children) : ''
}
const button = (tree: Node, label: string) => nodes(tree, 'Button').find(node => text(node) === label)!
function mount(file: string, component: string, api: (path: string, options?: RequestInit) => Promise<unknown>, props = {}, hash = '#records?session=one') {
  const slots: any[] = [], pending: (() => void)[] = [], listeners: Record<string, () => void> = {}
  let cursor = 0
  const jsx = (type: unknown, props: any) => ({ type, props })
  const exports: Record<string, (props: unknown) => Node> = {}
  const location = { hash }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Error, AbortController, URLSearchParams, encodeURIComponent,
    FormData: class { values: Record<string, string>; constructor(values: Record<string, string>) { this.values = values } get(key: string) { return this.values[key] } },
    window: { location, addEventListener(key: string, fn: () => void) { listeners[key] = fn }, removeEventListener() {} },
    require(name: string) {
      if (name === '@/lib/doctor-label') return { doctorLabel }
      if (name === 'react') return {
        useState(initial: any) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (next: any) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next }] },
        useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
        useMemo(fn: () => unknown) { return fn() },
        useEffect(fn: () => unknown, deps: unknown[]) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) pending.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: fn() } }) },
      }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@/lib/platform-api') return { api }
      if (name === '@/lib/medical') return { indexProductSources }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    render() { cursor = 0; const tree = exports[component](props); pending.splice(0).forEach(fn => fn()); return tree },
    hash(value: string) { location.hash = value; listeners.hashchange?.() },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}

test('record detail retry recovers without leaving the dialog; late old record cannot overwrite current detail', async () => {
  let fail = true, oldResolve!: (value: unknown) => void
  const record = (id: string) => ({ id, experience: 'practice', started_at: '', status: 'completed', messages: [], coaching: [], free_context: { drug: { name: id }, doctor: { display_name: 'doctor' } } })
  const app = mount('pages/records-page.tsx', 'RecordsPage', async path => {
    if (path === '/sessions') return []
    if (path === '/sessions/old') return new Promise(resolve => { oldResolve = resolve })
    if (fail) throw new Error('offline')
    return record(path.split('/').at(-1)!)
  })
  app.render(); await settle()
  assert.ok(text(app.render()).includes('无法读取这条记录'))
  fail = false
  button(app.render(), '重新读取').props.onClick()
  app.render(); await settle()
  assert.ok(text(app.render()).includes('one · doctor'))
  app.hash('#records?session=old'); app.render()
  app.hash('#records?session=new'); app.render(); await settle()
  oldResolve(record('old')); await settle()
  assert.ok(text(app.render()).includes('new · doctor'))
  assert.equal(text(app.render()).includes('old · doctor'), false)
})

test('medical source read can retry and paid checks reject duplicate activation', async () => {
  let fail = true, checks = 0, finish!: (value: unknown) => void
  const app = mount('components/medical-library.tsx', 'MedicalLibrary', async path => {
    if (path === '/medical/check') { checks++; return new Promise(resolve => { finish = resolve }) }
    if (fail) throw new Error('offline')
    return { products: [], sources: [{ id: 'source' }], built_at: null }
  })
  app.render(); await settle()
  assert.ok(text(app.render()).includes('offline'))
  fail = false; button(app.render(), '重新读取依据').props.onClick()
  app.render(); await settle()
  let tree = app.render()
  assert.equal(text(tree).includes('offline'), false)
  nodes(tree, 'Textarea')[0].props.onChange({ target: { value: '待核验表述' } })
  tree = app.render()
  const check = button(tree, '查找依据并核验')
  check.props.onClick(); check.props.onClick()
  assert.equal(checks, 1)
  finish({}); await settle()
  assert.equal(button(app.render(), '查找依据并核验').props.disabled, false)
})

test('review read recovers and repeated save retains form on failure then unlocks', async () => {
  let failRead = true, writes = 0, rejectWrite!: (error: Error) => void, resets = 0
  const app = mount('components/review-panel.tsx', 'ReviewPanel', async (path, options) => {
    if (options?.method) { writes++; return new Promise((_resolve, reject) => { rejectWrite = reject }) }
    if (failRead) throw new Error('read offline')
    return path.endsWith('/reviews') ? { reviews: [], responses: [] } : []
  }, { record: { id: 'one', messages: [] } })
  app.render(); await settle()
  failRead = false; button(app.render(), '重新读取点评').props.onClick()
  app.render(); await settle()
  let tree = app.render()
  assert.equal(text(tree).includes('read offline'), false)
  const form = nodes(tree, 'form')[0]
  const event = { preventDefault() {}, currentTarget: { comment: '保留点评', reset() { resets++ } } }
  form.props.onSubmit(event); form.props.onSubmit(event)
  assert.equal(writes, 1)
  assert.equal(nodes(app.render(), 'fieldset')[0].props.disabled, true)
  rejectWrite(new Error('write failed')); await settle()
  tree = app.render()
  assert.equal(resets, 0)
  assert.equal(button(tree, '保存点评').props.disabled, false)
  assert.ok(text(tree).includes('write failed'))
})

test('progress ignores late superseded responses and shows recoverable current failure', async () => {
  let oldResolve!: (value: unknown) => void
  const app = mount('components/training-progress.tsx', 'TrainingProgress', async path => {
    if (path.endsWith('30')) return new Promise(resolve => { oldResolve = resolve })
    throw new Error('current failure')
  }, { refresh: 0 })
  app.render()
  button(app.render(), '7 天').props.onClick(); app.render(); await settle()
  oldResolve({ invalid: true }); await settle()
  assert.ok(text(app.render()).includes('current failure'))
  assert.ok(button(app.render(), '重试统计'))
})
