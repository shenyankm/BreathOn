import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('self-report recording stops in background and uploads only with consent', async () => {
  const slots: any[] = [], effects: (() => unknown)[] = [], listeners: Record<string, () => void> = {}
  let cursor = 0, stopped = false, uploaded: any, callback = false, opens = 0, uploads = 0, failUpload = true, failStart = false
  class Recorder {
    static isTypeSupported(type: string) { return type === 'audio/mp4' }
    state = 'inactive'; ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void
    constructor(_stream: unknown, _options: unknown) {}
    start() { if (failStart) throw new Error('recording unavailable'); this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.() }
  }
  const react = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ??= { current: initial } },
    useEffect(effect: () => unknown) { effects.push(effect) },
  }
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  const document = { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => { listeners[name] = fn }, removeEventListener: () => {} }
  const exports: any = {}
  const imports: Record<string, unknown> = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@/components/ui/button': { Button: 'button' }, '@/components/ui/checkbox': { Checkbox: 'checkbox' }, '@/lib/platform-api': { api: async (path: string, options: unknown) => { uploads++; if (failUpload) throw new Error('upload interrupted'); uploaded = { path, options }; return {} } } }
  const code = ts.transpileModule(readFileSync(new URL('../src/components/self-report-recorder.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, Error, require: (name: string) => imports[name], Blob, MediaRecorder: Recorder, document, navigator: { mediaDevices: { getUserMedia: async () => { opens++; return { getTracks: () => [{ stop: () => { stopped = true } }] } } } }, window: { setTimeout: () => 1, clearTimeout: () => {} } })
  const render = () => { cursor = 0; return exports.SelfReportRecorder({ visitId: 'v1', onUploaded: () => { callback = true } }) }
  const find = (node: any, type: string, label?: string): any => {
    if (!node || typeof node !== 'object') return null
    if (node.type === type && (!label || node.props.children === label)) return node
    const children = node.props?.children
    for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, type, label); if (result) return result }
    return null
  }
  let tree = render(); effects.splice(0).forEach(effect => effect())
  assert.equal(find(tree, 'button', '开始录音').props.disabled, true)
  find(tree, 'checkbox').props.onCheckedChange(true)
  tree = render(); find(tree, 'button', '开始录音').props.onClick(); find(tree, 'button', '开始录音').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(opens, 1)
  document.visibilityState = 'hidden'; listeners.visibilitychange()
  assert.equal(stopped, true)
  tree = render(); find(tree, 'button', '上传录音').props.onClick(); find(tree, 'button', '上传录音').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(uploads, 1)
  assert.equal(callback, false)
  tree = render(); assert.ok(find(tree, 'button', '上传录音'))
  document.visibilityState = 'visible'
  failStart = true
  find(tree, 'button', '重新录音').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = render(); assert.ok(find(tree, 'button', '上传录音'), 'failed recording startup preserves the previous audio')
  failUpload = false
  find(tree, 'button', '上传录音').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(uploads, 2)
  assert.equal(uploaded.path, '/visits/v1/audio')
  assert.equal(uploaded.options.headers['Content-Type'], 'audio/mp4')
  assert.equal(uploaded.options.headers['X-Recording-Authorized'], 'true')
  assert.equal(callback, true)
})
