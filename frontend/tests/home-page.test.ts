import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Node = { type: string; props: any }
const jsx = (type: string, props: any): Node => ({ type, props })
const exports: { HomePage?: (props: { username?: string; sessionStatus: string; seconds: number }) => Node } = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/pages/home-page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  exports,
  require(name: string) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === '@/lib/session') return { formatTime: () => '01:00' }
    assert.ok(name === 'lucide-react' || name.startsWith('@/components/'), name)
    return new Proxy({}, { get: (_, key) => String(key) })
  },
})
function find(node: any, type: string): Node[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}

test('home keeps unfinished and unsaved sessions reachable without starting another call', () => {
  for (const sessionStatus of ['正在连接…', '正在保存记录…', '对话尚未保存']) {
    const tree = exports.HomePage!({ username: '真实账号', sessionStatus, seconds: 60 })
    assert.ok(find(tree, 'a').some(node => node.props.href === '#start'))
    assert.ok(JSON.stringify(tree).includes(sessionStatus))
    assert.ok(JSON.stringify(tree).includes('真实账号'))
  }
  const tree = exports.HomePage!({ sessionStatus: '', seconds: 0 })
  assert.equal(find(tree, 'a').some(node => node.props.href === '#start'), false)
})
