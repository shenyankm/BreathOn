import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { isAppDrug } from '../src/lib/app-drugs.ts'
import * as logic from '../src/bp/logic.ts'

function load(file: string, store: any, extras: Record<string, any> = {}) {
  const exports: any = {}, slots: any[] = [], effects: any[] = []
  let cursor = 0
  const jsx = (type: any, props: any) => ({ type, props })
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/bp/${file}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, ...extras, require(name: string) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'react') return {
      useMemo: (fn: any) => fn(),
      useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
      useEffect: (fn: any, deps: any[]) => { const i = cursor++; if (!slots[i] || deps.some((v, n) => v !== slots[i][n])) { slots[i] = deps; effects.push(fn) } },
    }
    if (name === './data') return { useBp: () => store }
    if (name === './logic') return logic
    if (name === './images') return { ipImage: () => '/test.png' }
    if (name === '@/lib/app-drugs') return { isAppDrug }
    if (name === '@/lib/platform-api') return { api: extras.api }
    return new Proxy({}, { get: (_, key) => String(key) })
  } })
  return (name: string, props = {}) => { cursor = 0; const view = exports[name](props); effects.splice(0).forEach(fn => fn()); return view }
}
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props?.children)]
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('doctor refresh reaches the data source and copy reports actual clipboard failure', async () => {
  let reloads = 0, fail = false, copied = ''
  const notices: string[] = []
  const row = { id: 'ip-test', name: '测试医生', status: 'published', ip_profile: { ip_key: 'blood', tags: [], entry: '切入', question: '追问', match: '证据' } }
  const render = load('doctors', { doctors: { data: [row], reload: () => reloads++ }, notify: (message: string) => notices.push(message) }, {
    navigator: { clipboard: { writeText: async (text: string) => { if (fail) throw new Error('denied'); copied = text } } },
  })
  const tree = render('BpDoctors')
  nodes(tree).find(n => n.type === 'button' && n.props.children === '刷新医生资料').props.onClick()
  assert.equal(reloads, 1)
  assert.deepEqual(notices, [])
  const detail = nodes(tree).find(n => typeof n.type === 'function' && n.props.onDraft)
  await detail.props.onDraft()
  assert.ok(copied.includes('切入方式：切入'))
  assert.equal(notices.at(-1), '已复制沟通要点')
  fail = true
  await detail.props.onDraft()
  assert.match(notices.at(-1)!, /复制失败/)
})

test('home distinguishes disabled recommendations from an empty published catalogue', () => {
  const render = load('home', { home: {}, curriculum: {}, doctors: { data: [] }, settings: { data: { doctor_recommendation: false } } })
  const text = JSON.stringify(render('BpHome'))
  assert.match(text, /医生推荐已关闭/)
  assert.doesNotMatch(text, /暂无已发布的医生/)
})

test('coach drug loading has a recoverable network error rather than an empty catalogue claim', async () => {
  let fail = true
  const render = load('coach', {}, { api: async () => { if (fail) throw new Error('offline'); return [{ id: 'drug', name: '玛仕度肽', status: 'published' }] } })
  render('useAppDrug')
  await settle()
  let result = render('useAppDrug')
  assert.match(result.error, /读取失败/)
  assert.equal(result.drug, null)
  fail = false
  result.reload(); render('useAppDrug'); await settle()
  result = render('useAppDrug')
  assert.equal(result.error, '')
  assert.equal(result.drug.id, 'drug')
})
