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
  const nav = find(tree, 'nav').find(node => node.props['aria-label'] === '底部标签栏')
  assert.ok(nav)
  return { tree, links: find(nav, 'a') }
}

test('the app exposes exactly three bottom destinations in the intended order', () => {
  const { links } = navigation('home')
  assert.deepEqual(links.map(link => [textOf(link), link.props.href]), [
    ['练习', '#home'], ['学习', '#library'], ['我的', '#me'],
  ])
  assert.equal(links.filter(link => link.props['aria-current'] === 'page').length, 1)
})

test('records and visits retain the My tab selection', () => {
  for (const page of ['me', 'records', 'visits']) {
    const { links } = navigation(page)
    const current = links.filter(link => link.props['aria-current'] === 'page')
    assert.equal(current.length, 1, page)
    assert.equal(current[0].props.href, '#me', page)
    assert.equal(textOf(current[0]), '我的', page)
  }
})

test('an active practice keeps the Practice tab selected and returns to the session', () => {
  const { links } = navigation('start', true)
  assert.equal(links[0].props.href, '#start')
  assert.equal(links[0].props['aria-current'], 'page')
  assert.deepEqual(links.slice(1).map(link => [textOf(link), link.props.href]), [
    ['学习', '#library'], ['我的', '#me'],
  ])
  assert.equal(links.filter(link => link.props['aria-current'] === 'page').length, 1)
  assert.equal(navigation('library', true).links[0].props.href, '#start')
})

test('the navigation contains no management, legacy destination or account sheet', () => {
  for (const [page, active] of [['home', false], ['start', true], ['records', false], ['visits', false]] as const) {
    const { tree, links } = navigation(page, active)
    assert.equal(links.length, 3)
    assert.equal(find(tree, 'a').filter(link => /\/admin|#workspace|#settings|#records|#visits/.test(link.props.href)).length, 0)
    for (const component of ['Sheet', 'SheetTrigger', 'SheetContent']) assert.equal(find(tree, component).length, 0)
    assert.equal(find(tree, 'Button').filter(node => /退出登录|账号与管理|打开账号/.test(textOf(node) + (node.props['aria-label'] || ''))).length, 0)
  }
})
