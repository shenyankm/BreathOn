import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Node = { type: string; props: any }
type Props = { username?: string; onLogout?: () => void; logoutDisabled?: boolean; onPresetChange?: (preset: any) => void }

function render(props: Props = {}) {
  const exports: { MePage?: (props: Props) => Node } = {}
  const jsx = (type: string, properties: any) => ({ type, props: properties })
  const source = readFileSync(new URL('../src/pages/me-page.tsx', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(module: string) {
      if (module === 'react') return { memo: (component: unknown) => component, useState: (initial: unknown) => [initial, () => {}] }
      if (module === '@/lib/training-setup') return { trainingPresets: [{ id: 'coached', label: '辅助练习' }, { id: 'combat', label: '实战练习' }] }
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      assert.ok(module === 'lucide-react' || module.startsWith('@/components/'), module)
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return exports.MePage!({ preset: { id: 'coached' }, onPresetChange() {}, ...props } as Props)
}

function find(node: any, type: string): Node[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node && typeof node === 'object' ? textOf(node.props?.children) : ''
}

test('settings only shows the account, persisted practice mode and logout', () => {
  const username = '一位姓名很长的测试代表·姓名显示应保持完整'
  const view = render({ username })
  assert.ok(textOf(view).includes(username))
  assert.ok(textOf(view).includes('默认练习方式'))
  assert.equal(find(view, 'a').length, 0)
  assert.equal(find(view, 'Checkbox').length, 0)
  assert.equal(find(view, 'HealthObservations').length, 0)
  assert.equal(textOf(view).includes('审核'), false)
  const chosen: any[] = []
  const mode = find(render({ onPresetChange: preset => chosen.push(preset) }), 'ToggleGroup')[0]
  mode.props.onValueChange('combat')
  mode.props.onValueChange('')
  assert.deepEqual(chosen.map(value => value.id), ['combat'])
})

test('an account without a username has an honest fallback and no unavailable logout action', () => {
  const view = render()
  assert.ok(textOf(view).includes('当前账号'))
  assert.equal(find(view, 'Button').filter(node => textOf(node).includes('退出登录')).length, 0)
  assert.equal(find(view, 'a').filter(node => /\/admin|#workspace|#settings/.test(node.props.href)).length, 0)
})

test('an available logout action calls its supplied callback and is enabled by default', () => {
  let calls = 0
  const onLogout = () => { calls++ }
  const view = render({ username: '测试代表', onLogout })
  const logout = find(view, 'Button').find(node => textOf(node).includes('退出登录'))
  assert.ok(logout)
  assert.equal(logout.props.disabled, false)
  assert.equal(logout.props.onClick, onLogout)
  logout.props.onClick()
  assert.equal(calls, 1)
})

test('a blocked logout explains that the current practice must be finished and saved', () => {
  const onLogout = () => {}
  const view = render({ onLogout, logoutDisabled: true })
  const logout = find(view, 'Button').find(node => textOf(node).includes('退出登录'))
  assert.ok(logout)
  assert.equal(logout.props.disabled, true)
  assert.equal(logout.props.onClick, onLogout)
  assert.ok(textOf(view).includes('请先结束演练并确认保存，再退出登录。'))
})
