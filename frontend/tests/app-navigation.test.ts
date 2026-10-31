import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Node = { type: string; props: any }
const jsx = (type: string, props: any): Node => ({ type, props })
const exports: { AppNavigation?: (props: { page: string; inSession: boolean }) => Node } = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/app-navigation.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  exports,
  require(name: string) {
    if (name === 'react') return { memo: (component: unknown) => component }
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
    assert.ok(name === 'lucide-react' || name === './brand' || name.startsWith('./ui/'), name)
    return new Proxy({}, { get: (_, key) => String(key) })
  },
})
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
function navigation(page: string, inSession = false) {
  const tree = exports.AppNavigation!({ page, inSession })
  return { tree, links: find(tree, 'a') }
}

test('bottom navigation has five accessible labeled prototype entries', () => {
  const { tree, links } = navigation('home')
  assert.deepEqual(links.map(link => link.props.href), ['#home', '#doctors', '#training', '#practice', '#me'])
  assert.deepEqual(links.map(link => link.props['aria-label']), ['首页', '医生', '训练', '教练', '我的'])
  assert.deepEqual(links.map(textOf), ['首页', '医生', '训练', '教练', '我的'])
  assert.equal(find(tree, 'nav')[0].props['aria-label'], '主导航')
  for (const icon of ['House', 'Stethoscope', 'GraduationCap', 'Sparkles', 'UserRound']) assert.equal(find(tree, icon)[0].props['aria-hidden'], 'true')
})

test('nested pages keep their parent navigation entry selected', () => {
  for (const [page, label] of Object.entries({ home: '首页', doctors: '医生', training: '训练', scenarios: '训练', practice: '教练', library: '训练', products: '训练', me: '我的', records: '我的', visits: '我的' })) {
    const selected = navigation(page).links.filter(link => link.props['aria-current'] === 'page')
    assert.equal(selected.length, 1)
    assert.equal(selected[0].props['aria-label'], label)
  }
})

test('practice entry resumes an active session from any page', () => {
  for (const page of ['home', 'practice', 'library', 'products', 'me', 'records', 'visits']) {
    assert.equal(navigation(page, true).links[3].props.href, '#start')
    assert.equal(navigation(page).links[3].props.href, '#practice')
  }
})

test('practice session hides navigation while connecting, active, or ended', () => {
  for (const inSession of [true, false]) assert.equal(navigation('start', inSession).tree, null)
})
