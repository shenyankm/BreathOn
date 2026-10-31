import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { isNearBottom } from '../src/lib/scroll-position.ts'

test('incoming messages preserve history reading and the new-message button resumes following', () => {
  const slots: any[] = []
  let cursor = 0, pending: (() => void) | undefined, previousMessages: unknown
  const viewport = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 }
  const root = { querySelector: () => viewport }
  const exports: any = {}
  const jsx = (type: string, props: any) => ({ type, props })
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/transcript-scroll-area.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name: string) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'react') return {
      useRef(value: unknown) { const i = cursor++; return slots[i] ??= { current: value === null ? root : value } },
      useState(value: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next: unknown) => { slots[i] = next }] },
      useLayoutEffect(effect: () => void, deps: unknown[]) { if (deps[0] !== previousMessages) { previousMessages = deps[0]; pending = effect } },
    }
    if (name === '@/lib/scroll-position') return { isNearBottom }
    assert.ok(name === 'lucide-react' || name.startsWith('./ui/'))
    return new Proxy({}, { get: (_, key) => String(key) })
  } })
  function render(messages: unknown[]) {
    cursor = 0
    const tree = exports.TranscriptScrollArea({ messages, children: 'transcript' })
    const effect = pending; pending = undefined; effect?.()
    return tree
  }
  const initial = [{ text: 'first' }]
  let tree = render(initial)
  assert.equal(viewport.scrollTop, 1000)
  viewport.scrollTop = 100
  tree.props.children[0].props.onScrollCapture({ target: viewport })
  const next = [...initial, { text: 'second' }]
  viewport.scrollHeight = 1200
  render(next); tree = render(next)
  assert.equal(viewport.scrollTop, 100)
  assert.equal(tree.props.children[1].type, 'Button')
  tree.props.children[1].props.onClick()
  assert.equal(viewport.scrollTop, 1200)
  tree = render(next)
  assert.equal(tree.props.children[1], false)
  viewport.scrollHeight = 1400
  render([...next, { text: 'third' }])
  assert.equal(viewport.scrollTop, 1400)
})
