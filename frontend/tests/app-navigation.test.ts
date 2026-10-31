import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Node = { type: string; props: any }
const jsx = (type: string, props: any): Node => ({ type, props })
const exports: { AppHome?: (props: { inSession: boolean; username?: string }) => Node; AppNavigation?: (props: { page: string; inSession: boolean }) => Node } = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/app-navigation.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  exports,
  require(name: string) {
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

test('the default main page exposes learning, products, practice, history and avatar', () => {
  const tree = exports.AppHome!({ inSession: false, username: '代表' })
  const links = find(tree, 'a')
  assert.deepEqual(links.map(link => link.props.href), ['#library', '#products', '#practice', '#records', '#me'])
  assert.deepEqual(links.slice(0, 4).map(textOf), ['资料空间', '公司产品', '开始练习', '练习记录'])
  assert.equal(find(tree, 'Button').filter(node => node.props['aria-label'] === '进入我的').length, 1)
})

test('an active practice is reachable from the main page without starting another', () => {
  const tree = exports.AppHome!({ inSession: true })
  assert.equal(find(tree, 'a')[2].props.href, '#start')
})

test('content pages return to the main page and keep a live practice reachable', () => {
  for (const page of ['practice', 'library', 'products', 'records', 'visits', 'me', 'start']) {
    const { tree, links } = navigation(page, true)
    assert.equal(links[0].props.href, '#home')
    assert.equal(find(tree, 'Sheet').length, 0)
    if (page !== 'start') assert.ok(links.some(link => link.props.href === '#start'))
    assert.equal(links.some(link => /admin|workspace|settings/.test(link.props.href)), false)
  }
})
