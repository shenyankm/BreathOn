import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('records defer progress work until first expansion and retain it on reopen', () => {
  const slots: unknown[] = []
  let cursor = 0
  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useEffect() {},
  }
  const jsx = (type: unknown, props: any) => ({ type, props })
  const exports: { RecordsPage?: (props: unknown) => any } = {}
  const source = readFileSync(new URL('../src/pages/records-page.tsx', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, URLSearchParams, window: { location: { hash: '#records' } },
    require: (name: string) => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@/lib/platform-api') return { api() {} }
      assert.ok(name === 'lucide-react' || name.startsWith('@/components/'), name)
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  function render() { cursor = 0; return exports.RecordsPage!({ onStart() {} }) }
  function find(node: any, type: string): any[] {
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(child => find(child, type))
    return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
  }
  let page = render()
  assert.equal(find(page, 'TrainingProgress').length, 0)
  const section = find(page, 'Accordion')[0]
  section.props.onValueChange('progress')
  page = render()
  assert.equal(find(page, 'TrainingProgress').length, 1)
  find(page, 'Accordion')[0].props.onValueChange('')
  page = render()
  assert.equal(find(page, 'TrainingProgress').length, 1)
})
