import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function find(node: any, type: string): any[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}

test('calibration keeps zero distinct from unobserved and resets saved scores', async () => {
  const slots: any[] = [], effects: (() => void)[] = [], exports: Record<string, (props: unknown) => any> = {}
  const requests: any[] = []
  let cursor = 0, formValues: Record<string, unknown> = {}
  const jsx = (type: unknown, props: unknown, key: unknown) => ({ type, props, key })
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/calibration-panel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController, window: {}, FormData: class { get(name: string) { return formValues[name] ?? '' } },
    require(module: string) {
      if (module === 'react') return {
        useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
        useEffect(effect: () => void, deps: unknown[]) { const i = cursor++; if (!slots[i] || deps.some((value, j) => value !== slots[i][j])) { effects.push(effect); slots[i] = deps } },
      }
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (module === '@/lib/platform-api') return { api: async (path: string, options?: RequestInit) => {
        if (options?.method === 'POST') { requests.push(JSON.parse(String(options.body))); return {} }
        return path === '/catalog/scenario' ? [{ id: 'scene', status: 'published', rubric_id: 'rubric', title: '场景' }] : []
      } }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  const render = () => {
    cursor = 0
    const view = exports.CalibrationPanel({ rubric: { id: 'rubric', dimensions: [{ key: 'accuracy', label: '准确性', anchors: ['不准确', '部分准确'] }] } })
    effects.splice(0).forEach(effect => effect())
    return view
  }
  const submit = async (view: any) => {
    formValues = Object.fromEntries(find(view, 'Select').filter(control => control.props.name).map(control => [control.props.name, control.props.value ?? control.props.defaultValue ?? '']))
    await find(view, 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { reset() {} } })
  }
  render()
  await new Promise<void>(resolve => setImmediate(resolve))
  let view = render()
  find(view, 'Select').find(control => control.props.name === 'accuracy').props.onValueChange('0')
  await submit(render())
  assert.equal(requests[0].expected_scores.accuracy, 0)
  view = render()
  assert.equal(find(view, 'Select').find(control => control.props.name === 'accuracy').props.value, '')
  find(view, 'Select').find(control => control.props.name === 'accuracy').props.onValueChange('__none__')
  await submit(render())
  assert.equal(requests[1].expected_scores.accuracy, null)
})
