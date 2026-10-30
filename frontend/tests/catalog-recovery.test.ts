import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function page(file: string, name: string, api: (path: string, options?: RequestInit) => Promise<unknown>, hash = '') {
  const slots: any[] = [], effects: (() => void)[] = []
  let cursor = 0
  const react = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
    useEffect(callback: () => void, dependencies: unknown[]) {
      const index = cursor++
      if (!slots[index] || dependencies.some((value, i) => value !== slots[index][i])) {
        effects.push(callback)
        slots[index] = dependencies
      }
    },
  }
  const jsx = (type: unknown, props: any, key: unknown) => ({ type, props, key })
  const exports: Record<string, (props: unknown) => any> = {}
  const source = readFileSync(new URL(`../src/pages/${file}`, import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source + (name === 'CatalogPage' ? '\nexport { CatalogPage }' : ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController, URLSearchParams, location: { hash },
    window: { addEventListener() {}, removeEventListener() {} },
    FormData: class { get(key: string) { return key } },
    require: (module: string) => {
      if (module === 'react') return react
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (module === '@/lib/platform-api') return { api }
      if (module === '@/lib/catalog-types') return { kindLabels: {}, statusLabels: {}, titleOf: (row: any) => row.title ?? row.name }
      if (module === '@/lib/progress') return { costLabel: () => '' }
      assert.ok(module.startsWith('@/components/') || module.startsWith('@/pages/'), module)
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    render(props: unknown = {}) { cursor = 0; const result = exports[name](props); effects.splice(0).forEach(effect => effect()); return result },
  }
}

function find(node: any, type: string): any[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => find(child, type))
  return [...(node.type === type ? [node] : []), ...find(node.props?.children, type)]
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('saved case responses remain usable when the next list request would fail', async () => {
  const original = { id: 'case-1', version: 1, status: 'draft', title: 'Original', quotes: [], origin_verified: false }
  let reads = 0
  const writes: any[] = []
  const app = page('cases-page.tsx', 'CasesPage', async (path, options) => {
    if (!options?.method) {
      assert.equal(path, '/cases')
      if (++reads > 1) throw new Error('List temporarily unavailable')
      return [original]
    }
    const body = JSON.parse(String(options.body))
    writes.push(body)
    return { ...original, version: body.version + 1, status: options.method === 'POST' ? 'confirmed' : 'draft' }
  }, '#workspace?tab=cases&case=case-1')
  app.render()
  await settle()
  let view = app.render()
  find(view, 'Button').find(button => button.props.children === '确认适用边界').props.onClick()
  await settle()
  view = app.render()
  assert.equal(find(view, 'form')[0].key, 'case-1-2')
  assert.equal(find(view, 'p').filter(node => node.props.role === 'alert').length, 0)
  find(view, 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: {} })
  await settle()
  assert.deepEqual(writes.map(body => body.version), [1, 2])
  assert.equal(find(app.render(), 'form')[0].key, 'case-1-3')
  assert.equal(reads, 1)
})

test('catalog save acknowledges the returned version without a fallible list reload', async () => {
  const original = { id: 'doctor-1', version: 1, status: 'draft', name: 'Original', updated_at: '2026-10-30T00:00:00Z' }
  let listReads = 0
  const app = page('platform-page.tsx', 'CatalogPage', async (path, options) => {
    if (options?.method) return { ...original, version: 2, name: 'Saved' }
    if (path === '/catalog/doctor/doctor-1') return original
    assert.equal(path, '/catalog/doctor')
    if (++listReads > 1) throw new Error('List temporarily unavailable')
    return [original]
  })
  app.render({ kind: 'doctor' })
  await settle()
  let view = app.render({ kind: 'doctor' })
  find(view, 'button')[0].props.onClick()
  await settle()
  view = app.render({ kind: 'doctor' })
  find(view, 'DoctorForm')[0].props.save({ name: 'Saved' })
  await settle()
  view = app.render({ kind: 'doctor' })
  assert.equal(find(view, 'DoctorForm')[0].key, 'doctor-1-2')
  assert.equal(find(view, 'div').filter(node => node.props.role === 'alert').length, 0)
  assert.ok(find(view, 'p').some(node => node.props.children === '医生资料已保存。'))
  assert.equal(listReads, 1)
})

test('an older case list cannot hide a newly imported case', async () => {
  let finishRead!: (rows: unknown[]) => void
  const imported = { id: 'imported', version: 1, status: 'draft', title: 'Imported', quotes: [], origin_verified: false }
  const app = page('cases-page.tsx', 'CasesPage', async (_path, options) => {
    if (options?.method) return imported
    return new Promise(resolve => { finishRead = resolve })
  })
  let view = app.render()
  find(view, 'input')[0].props.onChange({ target: { files: [{ size: 2, text: async () => '{}' }], value: 'case.json' } })
  await settle()
  assert.equal(find(app.render(), 'form')[0].key, 'imported-1')
  finishRead([{ ...imported, id: 'existing-case', title: 'Existing' }])
  await settle()
  view = app.render()
  assert.equal(find(view, 'form')[0]?.key, 'imported-1')
  assert.equal(find(view, 'button').length, 2)
})

test('an older catalog list cannot remove a newly saved entry', async () => {
  let finishRead!: (rows: unknown[]) => void
  const saved = { id: 'new-doctor', version: 1, status: 'draft', name: 'Saved', updated_at: '2026-10-30T00:00:00Z' }
  const app = page('platform-page.tsx', 'CatalogPage', async (_path, options) => {
    if (options?.method) return saved
    return new Promise(resolve => { finishRead = resolve })
  })
  let view = app.render({ kind: 'doctor' })
  find(view, 'Button').find(button => button.props.children === '添加undefined').props.onClick()
  find(app.render({ kind: 'doctor' }), 'DoctorForm')[0].props.save({ name: 'Saved' })
  await settle()
  finishRead([{ ...saved, id: 'existing-doctor', name: 'Existing' }])
  await settle()
  view = app.render({ kind: 'doctor' })
  assert.equal(find(view, 'DoctorForm')[0].key, 'new-doctor-1')
  assert.equal(find(view, 'button').length, 2)
})

test('an older catalog list cannot remove a generated scene', async () => {
  let finishRead!: (rows: unknown[]) => void
  const app = page('platform-page.tsx', 'CatalogPage', async path => {
    if (path === '/catalog/scenario') return new Promise(resolve => { finishRead = resolve })
    return []
  })
  const view = app.render({ kind: 'scenario' })
  find(view, 'ScenarioGenerator')[0].props.onGenerated({ id: 'scene', version: 1, status: 'draft', title: 'Generated' })
  await settle()
  finishRead([{ id: 'existing-scene', version: 1, status: 'draft', title: 'Existing' }])
  await settle()
  assert.equal(find(app.render({ kind: 'scenario' }), 'button').length, 2)
})

test('a refreshed case list preserves concurrent edits and merges other records', async () => {
  const original = { id: 'case-1', version: 1, status: 'draft', title: 'Original', quotes: [], origin_verified: false }
  let reads = 0
  let finishRead!: (rows: unknown[]) => void
  const app = page('cases-page.tsx', 'CasesPage', async (_path, options) => {
    if (options?.method) return { ...original, version: 2, title: 'Edited' }
    if (++reads === 1) return [original]
    return new Promise(resolve => { finishRead = resolve })
  }, '#workspace?tab=cases&case=case-1')
  app.render()
  await settle()
  find(app.render(), 'Button').find(button => button.props.children === '刷新案例').props.onClick()
  const view = app.render()
  find(view, 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: {} })
  await settle()
  finishRead([original, { ...original, id: 'other', title: 'Other' }])
  await settle()
  assert.equal(find(app.render(), 'form')[0].key, 'case-1-2')
  assert.equal(find(app.render(), 'button').length, 2)
})

test('a pending catalog read cannot resurrect a doctor deleted after creation', async () => {
  const saved = { id: 'new-doctor', version: 1, status: 'draft', name: 'Saved', updated_at: '2026-10-30T00:00:00Z' }
  let finishRead!: (rows: unknown[]) => void
  const app = page('platform-page.tsx', 'CatalogPage', async (_path, options) => {
    if (options?.method === 'DELETE') return {}
    if (options?.method) return saved
    return new Promise(resolve => { finishRead = resolve })
  })
  let view = app.render({ kind: 'doctor' })
  find(view, 'Button').find(button => button.props.children === '添加undefined').props.onClick()
  find(app.render({ kind: 'doctor' }), 'DoctorForm')[0].props.save({ name: 'Saved' })
  await settle()
  view = app.render({ kind: 'doctor' })
  find(view, 'Button').find(button => button.props.children === '确认删除').props.onClick()
  await settle()
  finishRead([saved, { ...saved, id: 'other-doctor', name: 'Other' }])
  await settle()
  view = app.render({ kind: 'doctor' })
  const rows = find(view, 'button')
  assert.equal(rows.length, 1)
  assert.equal(find(rows[0], 'span')[0].props.children, 'Other')
  assert.equal(find(view, 'DoctorForm').length, 0)
})
