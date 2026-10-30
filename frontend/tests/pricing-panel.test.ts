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

test('pricing opens invalid and new rules and preserves exact prices on save', async () => {
  const state: any[] = [], effects: (() => void)[] = [], exports: Record<string, () => any> = {}
  let cursor = 0, saved: any
  const rate = { provider: 'deepseek', model: 'model', unit: 'input_tokens', per_units: 1_000_000, amount: '0.00000001', currency: 'USD', source_url: 'https://example.com/prices', checked_on: '2026-10-01', note: '' }
  const jsx = (type: unknown, props: unknown, key: unknown) => ({ type, props, key })
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/pricing-panel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController,
    require(module: string) {
      if (module === 'react') return {
        useState(initial: any) {
          const i = cursor++
          if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
          return [state[i], (next: any) => { state[i] = typeof next === 'function' ? next(state[i]) : next }]
        },
        useEffect(effect: () => void, deps: unknown[]) {
          const i = cursor++
          if (!state[i] || deps.some((value, j) => value !== state[i][j])) { effects.push(effect); state[i] = deps }
        },
      }
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (module === '@/lib/platform-api') return { api: async (_path: string, options?: RequestInit) => {
        if (options?.method === 'PUT') return saved = JSON.parse(String(options.body))
        return { version: 4, rates: [rate] }
      } }
      if (module === '@/lib/progress') return { providerLabels: { deepseek: 'DeepSeek' }, unitLabels: { input_tokens: '输入 token' } }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  const render = () => { cursor = 0; const view = exports.PricingPanel(); effects.splice(0).forEach(effect => effect()); return view }
  render()
  await new Promise<void>(resolve => setImmediate(resolve))
  let view = render()
  find(view, 'form')[0].props.onInvalidCapture()
  assert.deepEqual(Array.from(find(render(), 'Accordion')[0].props.value), ['0'])
  find(view, 'Button').find(button => button.props.children === '添加计价规则').props.onClick()
  view = render()
  assert.ok(find(view, 'Accordion')[0].props.value.includes('1'))
  find(view, 'Input').find(input => input.props.value === rate.amount).props.onChange({ target: { value: '0.00000002' } })
  view = render()
  await find(view, 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(saved.version, 4)
  assert.equal(saved.rates[0].amount, '0.00000002')
  assert.equal(saved.rates[0].per_units, 1_000_000)
  assert.equal(saved.rates.length, 2)
})
