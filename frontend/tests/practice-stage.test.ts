import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Node = { type: string; props: any }
function find(node: any, type: string): Node[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}
function render(overrides: Record<string, unknown> = {}) {
  const exports: any = {}
  const jsx = (type: string, props: any) => ({ type, props })
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/practice-stage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(name: string) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react') return { useState: (value: unknown) => [value, () => {}] }
      if (name === '@/lib/session') return { formatTime: () => '00:12' }
      assert.ok(name === 'lucide-react' || name.startsWith('./ui/'))
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return exports.PracticeStage({ practice: true, doctorName: '模拟医生', seconds: 12, active: true, connecting: false,
    status: '通话中', muted: false, outputMuted: false, policyPaused: false,
    transcript: '对话原文', coach: '教练建议', onMute() {}, onOutputMute() {}, onEnd() {}, onRestart() {}, ...overrides })
}

test('assisted practice exposes conversation and real-time coach', () => {
  const tree = render()
  assert.equal(tree.props['aria-label'], '辅助练习对话')
  assert.deepEqual(find(tree, 'TabsTrigger').map(node => node.props.value), ['transcript', 'coach'])
})

test('combat keeps transcript reachable and wires independent call controls', () => {
  let ended = 0, muted = 0, output = 0
  const tree = render({ practice: false, onEnd: () => ended++, onMute: () => muted++, onOutputMute: () => output++ })
  assert.equal(find(tree, 'Dialog').length, 1)
  const buttons = find(tree, 'Button')
  for (const label of ['结束演练', '静音麦克风', '关闭医生声音']) buttons.find(node => node.props['aria-label'] === label)!.props.onClick()
  assert.deepEqual([ended, muted, output], [1, 1, 1])
})

test('policy pause prevents unmuting and connecting offers cancellation', () => {
  const paused = find(render({ muted: true, policyPaused: true }), 'Button').find(node => node.props['aria-label'] === '取消静音')!
  assert.equal(paused.props.disabled, true)
  const connecting = find(render({ active: false, connecting: true }), 'Button')
  assert.ok(connecting.some(node => node.props['aria-label'] === '取消连接'))
  assert.equal(connecting.find(node => node.props['aria-label'] === '静音麦克风')!.props.disabled, true)
})

test('combat shows the specific failure inside the fullscreen stage', () => {
  const tree = render({ practice: false, active: false, status: '连接失败', error: '音频播放已暂停，请重新开始演练' })
  assert.equal(find(tree, 'p').find(node => node.props.role === 'alert')?.props.children, '音频播放已暂停，请重新开始演练')
})
