import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Node = { type: string; props: any }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
function find(node: any, type: string): Node[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}
function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return node && typeof node === 'object' ? textOf(node.props?.children) : ''
}
const button = (tree: Node, label: string) => find(tree, 'Button').find(node => textOf(node) === label)!
const visit = (id: string) => ({ id, version: 1, source: 'self_report', status: 'draft', text: `原文 ${id}`, redacted_text: '', doctor_id: 'doctor', drug_id: 'drug', visited_at: '2026-10-30', speakers: [], audio_status: 'none' })
function mount(hash = '#visits', records = [visit('one'), visit('two')]) {
  const slots: any[] = [], effects: (() => void)[] = [], listeners: Record<string, () => void> = {}, calls: { path: string; options?: RequestInit }[] = []
  let cursor = 0
  let interval: (() => void) | undefined
  let detailPending: Promise<unknown> | undefined
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  let listFailure: string | null = null
  const location = { get hash() { return hash }, set hash(value: string) { hash = value.startsWith('#') ? value : `#${value}` } }
  const jsx = (type: string, props: any) => ({ type, props })
  const exports: { VisitsPage?: () => Node } = {}
  const api = async (path: string, options?: RequestInit) => {
    calls.push({ path, options })
    if (path === '/visits' && options?.method === 'POST') return visit('created/id')
    if (path === '/visits') {
      if (listFailure) throw new Error(listFailure)
      return records
    }
    if (path === '/catalog/doctor' || path === '/catalog/drug') return []
    const record = records.find(row => path === `/visits/${row.id}`)
    if (record) return detailPending ?? record
    throw new Error(`Unexpected request: ${path}`)
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/pages/visits-page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Error, AbortController, URLSearchParams, encodeURIComponent,
    FormData: class { values: Record<string, string>; constructor(values: Record<string, string>) { this.values = values } get(name: string) { return this.values[name] } },
    document,
    window: { setInterval(callback: () => void) { interval = callback; return 1 }, clearInterval() { interval = undefined }, location, history: { replaceState(_state: unknown, _title: string, path: string) { location.hash = path } }, addEventListener(name: string, listener: () => void) { listeners[name] = listener }, removeEventListener() {} },
    require(name: string) {
      if (name === 'react') return {
        useState(initial: any) {
          const index = cursor++
          if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial, set(next: any) { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next } }
          return [slots[index].value, slots[index].set]
        },
        useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
        useCallback(callback: unknown) { return callback },
        useEffect(callback: () => void | (() => void), deps: unknown[]) {
          const index = cursor++, previous = slots[index]
          if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() } })
        },
      }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@/lib/platform-api') return { api }
      assert.ok(name === 'lucide-react' || name.startsWith('@/components/') || name === '@/lib/visit-audio', name)
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    calls, location, document,
    poll() { interval?.() },
    deferDetail(promise: Promise<unknown>) { detailPending = promise },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
    failList(message: string | null) { listFailure = message },
    render() { cursor = 0; const tree = exports.VisitsPage!(); effects.splice(0).forEach(effect => effect()); return tree },
    hash(value: string) { location.hash = value; listeners.hashchange() },
  }
}

test('visit list opens a separate editor and keeps all unsaved new fields on return', async () => {
  const app = mount('#visits', [])
  app.render(); await settle()
  let tree = app.render()
  assert.equal(find(tree, 'form').length, 0)
  assert.equal(find(tree, 'Textarea').length, 0)
  button(tree, '新建日记').props.onClick()
  tree = app.render()
  assert.equal(app.location.hash, '#visits?new=1')
  assert.equal(find(tree, 'Dialog')[0].props.open, true)
  assert.equal(find(tree, 'DialogContent')[0].props.showCloseButton, false)
  for (const [name, value] of [['doctor_id', 'doctor-two'], ['drug_id', 'drug-two'], ['source', 'voice']]) find(tree, 'Select').find(node => node.props.name === name)!.props.onValueChange(value)
  find(tree, 'Input').find(node => node.props.name === 'visited_at')!.props.onChange({ target: { value: '2026-10-29' } })
  find(tree, 'Textarea')[0].props.onChange({ target: { value: '未保存的访后观察' } })
  tree = app.render(); find(tree, 'Dialog')[0].props.onOpenChange(false)
  tree = app.render()
  assert.equal(app.location.hash, '#visits')
  assert.equal(find(tree, 'form').length, 0)
  button(tree, '继续未保存的日记').props.onClick()
  tree = app.render()
  assert.equal(find(tree, 'Textarea')[0].props.value, '未保存的访后观察')
  assert.deepEqual(plain(Object.fromEntries(find(tree, 'Select').map(node => [node.props.name, node.props.value]))), { doctor_id: 'doctor-two', drug_id: 'drug-two', source: 'voice' })
  assert.equal(find(tree, 'Input')[0].props.value, '2026-10-29')
  app.hash('#visits'); app.render(); app.hash('#visits?new=1'); tree = app.render()
  assert.equal(find(tree, 'Textarea')[0].props.value, '未保存的访后观察')
  await find(tree, 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { doctor_id: 'doctor-two', drug_id: 'drug-two', visited_at: '2026-10-29', source: 'voice' } })
  app.render()
  assert.equal(app.location.hash, '#visits?visit=created%2Fid')
  assert.deepEqual(JSON.parse(String(app.calls.find(call => call.options?.method === 'POST')?.options?.body)), { doctor_id: 'doctor-two', drug_id: 'drug-two', visited_at: '2026-10-29', source: 'self_report', private_audio: true, text: '未保存的访后观察' })
})

test('visit deep links retain local detail edits and require confirmation before another record', async () => {
  const app = mount('#visits?visit=one')
  app.render(); await settle()
  let tree = app.render()
  assert.equal(find(tree, 'Textarea').find(node => node.props.id === 'visit-original')!.props.value, '原文 one')
  find(tree, 'Textarea').find(node => node.props.id === 'visit-original')!.props.onChange({ target: { value: '未保存修改' } })
  tree = app.render(); button(tree, '返回日记列表').props.onClick(); tree = app.render()
  find(tree, 'Button').find(node => node.props.onClick && textOf(node).includes('2026-10-30'))!.props.onClick()
  tree = app.render()
  assert.equal(find(tree, 'Textarea').find(node => node.props.id === 'visit-original')!.props.value, '未保存修改')
  assert.equal(app.calls.filter(call => call.path === '/visits/one').length, 1)
  button(tree, '返回日记列表').props.onClick(); tree = app.render()
  find(tree, 'Button').filter(node => textOf(node).includes('2026-10-30'))[1].props.onClick()
  app.render(); tree = app.render()
  assert.equal(find(tree, 'Dialog')[1].props.open, true)
  assert.equal(app.calls.filter(call => call.path === '/visits/two').length, 0)
  button(tree, '返回当前记录').props.onClick(); tree = app.render()
  assert.equal(app.location.hash, '#visits?visit=one')
  assert.equal(find(tree, 'Textarea').find(node => node.props.id === 'visit-original')!.props.value, '未保存修改')
  app.hash('#visits?visit=two'); app.render(); tree = app.render()
  button(tree, '丢弃修改并切换').props.onClick(); app.render(); await settle(); tree = app.render()
  assert.equal(find(tree, 'Textarea').find(node => node.props.id === 'visit-original')!.props.value, '原文 two')
})

test('visit refresh retains current failures and clears the error after recovery', async () => {
  const app = mount()
  app.render(); await settle()
  const refresh = () => find(app.render(), 'Button').find(node => node.props['aria-label'] === '刷新日记列表')!.props.onClick()
  for (const failure of ['Temporary service outage', 'Still unavailable, try again']) {
    app.failList(failure)
    refresh(); await settle()
    const errors = find(app.render(), 'AlertDescription')
    assert.ok(errors.length > 0)
    assert.ok(errors.every(node => textOf(node) === failure))
  }
  app.failList(null)
  refresh(); await settle()
  const tree = app.render()
  assert.equal(find(tree, 'Alert').length, 0)
  assert.equal(find(tree, 'Button').filter(node => textOf(node).includes('2026-10-30')).length, 2)
  assert.equal(app.calls.filter(call => call.path === '/visits').length, 4)
})


test('transcription polling avoids overlapping requests, pauses in background, and aborts on unmount', async () => {
  const record = { ...visit('polling'), audio_status: 'transcribing' }
  const app = mount('#visits?visit=polling', [record])
  app.render(); await settle(); app.render()
  let finish!: (value: unknown) => void
  app.deferDetail(new Promise(resolve => { finish = resolve }))
  const count = () => app.calls.filter(call => call.path === '/visits/polling').length
  const before = count()
  app.poll(); app.poll()
  assert.equal(count(), before + 1)
  const signal = app.calls.at(-1)!.options!.signal!
  finish(record); await settle()
  app.document.visibilityState = 'hidden'; app.poll()
  assert.equal(count(), before + 1)
  app.unmount()
  assert.equal(signal.aborted, true)
})
