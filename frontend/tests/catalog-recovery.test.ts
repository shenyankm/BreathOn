import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function page(file: string, name: string, api: (path: string, options?: RequestInit) => Promise<unknown>, hash = '') {
  const slots: any[] = [], effects: (() => void)[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let cursor = 0
  const react = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
    useId() { const index = cursor++; return slots[index] ??= `control-${index}` },
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
    setTimeout(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer },
    clearTimeout(id: number) { timers.delete(id) },
    FormData: class {
      values: Record<string, string>
      constructor(values: Record<string, string>) { this.values = values }
      get(key: string) { return this.values[key] ?? key }
    },
    require: (module: string) => {
      if (module === 'react') return react
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (module === '@/lib/platform-api') return { api }
      if (module === '@/lib/catalog-types') return { kindLabels: {}, statusLabels: {}, titleOf: (row: any) => row.title ?? row.name }
      if (module === '@/lib/progress') return { costLabel: () => '' }
      assert.ok(module.startsWith('@/components/') || module.startsWith('@/pages/') || module.startsWith('./ui/') || module === 'lucide-react', module)
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    render(props: unknown = {}) { cursor = 0; const result = exports[name](props); effects.splice(0).forEach(effect => effect()); return result },
    async tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); await settle() },
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

const doctorDraft = { name: '陈明', specialty: '内分泌科', hospital: '教学大学附属医院', professional_title: '', background_type: 'public', public_facts: '医院：教学大学附属医院',
  sources: ['https://hospital.example.edu/chen'], population: '训练人群', focus: '证据局限', training_style: '每轮追问一个问题', mood: 'neutral', opening: '今天讨论什么？', research_job_id: 'research-1' }
const doctorJob = { id: 'research-1', kind: 'doctor', query: '陈明 教学大学附属医院 内分泌科', status: 'running',
  doctor_identity: { name: '陈明', hospital: '教学大学附属医院', department: '内分泌科' }, result: null }

test('generated doctor fields are editable and never saved until the review form submits', async () => {
  const writes: any[] = []
  const app = page('platform-page.tsx', 'CatalogPage', async (_path, options) => {
    if (!options?.method) return []
    writes.push(JSON.parse(String(options.body)))
    return { ...doctorDraft, id: 'saved', version: 1, status: 'draft' }
  })
  let view = app.render({ kind: 'doctor' })
  find(view, 'DoctorGenerator')[0].props.onGenerated('research-1', doctorDraft)
  await settle()
  view = app.render({ kind: 'doctor' })
  assert.equal(writes.length, 0)
  const form = find(view, 'DoctorForm')[0]
  assert.equal(form.key, 'research-1')
  assert.deepEqual(form.props.initial, doctorDraft)
  form.props.save({ ...doctorDraft, focus: '人工调整后的训练关注点' })
  await settle()
  view = app.render({ kind: 'doctor' })
  assert.equal(writes[0].focus, '人工调整后的训练关注点')
  assert.equal(find(view, 'DoctorForm')[0].props.initial, undefined)
  assert.ok(find(view, 'Button').some(button => button.props.children === '发布医生'))
})

test('generated doctor form requires explicit review and preserves source fields', () => {
  const saves: any[] = []
  const app = page('../components/catalog-forms.tsx', 'DoctorForm', async () => {})
  const props = { initial: doctorDraft, busy: false, disabled: false, save: (body: any) => saves.push(body) }
  let view = app.render(props)
  assert.equal(find(view, 'Field').find(field => field.props.name === 'name').props.value, doctorDraft.name)
  assert.equal(find(view, 'Textarea').find(field => field.props.name === 'public_facts').props.defaultValue, doctorDraft.public_facts)
  const submit = () => find(view, 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: { ...doctorDraft, sources: doctorDraft.sources.join('\n') } })
  submit()
  assert.equal(saves.length, 0)
  assert.equal(find(view, 'Button')[0].props.disabled, true)
  find(view, 'Checkbox')[0].props.onCheckedChange(true)
  view = app.render(props)
  assert.equal(find(view, 'Button')[0].props.disabled, false)
  submit()
  assert.deepEqual(JSON.parse(JSON.stringify(saves[0])), doctorDraft)
})

test('doctor generation starts only on submit and polling exposes the draft for review', async () => {
  const writes: { path: string; body: object }[] = []
  const drafts: unknown[] = []
  const app = page('../components/doctor-generator.tsx', 'DoctorGenerator', async (path, options) => {
    if (path === '/research') return { configured: true, jobs: [] }
    if (options?.method) { writes.push({ path, body: JSON.parse(String(options.body)) }); return doctorJob }
    assert.equal(path, '/research/jobs/research-1')
    return { ...doctorJob, status: 'completed', doctor_draft: doctorDraft }
  })
  const props = { onGenerated: (id: string, draft: unknown) => drafts.push([id, draft]) }
  app.render(props)
  await settle()
  let view = app.render(props)
  assert.equal(writes.length, 0)
  find(view, 'form')[0].props.onSubmit({ preventDefault() {}, currentTarget: doctorJob.doctor_identity })
  await settle()
  app.render(props)
  assert.deepEqual(writes, [{ path: '/research/doctor-jobs', body: doctorJob.doctor_identity }])
  await app.tick()
  view = app.render(props)
  assert.equal(drafts.length, 0)
  find(view, 'Button').find(button => button.props.children === '核对并编辑画像草稿').props.onClick()
  assert.deepEqual(drafts, [['research-1', doctorDraft]])
})

test('doctor progress retry recovers a failed initial read without a second paid search', async () => {
  let reads = 0
  const app = page('../components/doctor-generator.tsx', 'DoctorGenerator', async (path, options) => {
    assert.equal(options?.method, undefined)
    assert.equal(path, '/research')
    if (++reads === 1) throw new Error('暂时断网')
    return { configured: true, jobs: [{ ...doctorJob, status: 'partial', doctor_draft: doctorDraft }] }
  })
  const props = { onGenerated() {} }
  app.render(props)
  await settle()
  find(app.render(props), 'Button').find(button => button.props.children === '重新读取进度').props.onClick()
  app.render(props)
  await settle()
  assert.equal(reads, 2)
  assert.ok(find(app.render(props), 'Button').some(button => button.props.children === '核对并编辑画像草稿'))
})

test('a cancelled doctor search cannot be revived by an older progress response', async () => {
  let completePoll!: (job: unknown) => void
  const app = page('../components/doctor-generator.tsx', 'DoctorGenerator', async (path, options) => {
    if (path === '/research') return { configured: true, jobs: [doctorJob] }
    if (options?.method) return { ...doctorJob, status: 'interrupted' }
    return new Promise(resolve => { completePoll = resolve })
  })
  const props = { onGenerated() {} }
  app.render(props)
  await settle()
  let view = app.render(props)
  await app.tick()
  find(view, 'Button').find(button => button.props.children === '停止检索').props.onClick()
  await settle()
  app.render(props)
  completePoll(doctorJob)
  await settle()
  view = app.render(props)
  assert.ok(find(view, 'p').some(node => node.props.children === '检索已停止，已归档资料保留。'))
  assert.equal(find(view, 'Button').filter(button => button.props.children === '停止检索').length, 0)
})

test('a saved research draft opens its existing doctor instead of offering another creation', async () => {
  const opened: string[] = []
  const app = page('../components/doctor-generator.tsx', 'DoctorGenerator', async () => ({ configured: true,
    jobs: [{ ...doctorJob, status: 'completed', doctor_draft: doctorDraft, doctor_id: 'saved-doctor' }] }))
  const props = { onGenerated() { assert.fail('saved draft must not create another role') }, onOpen: (id: string) => opened.push(id) }
  app.render(props)
  await settle()
  const view = app.render(props)
  assert.equal(find(view, 'Button').filter(button => button.props.children === '核对并编辑画像草稿').length, 0)
  find(view, 'Button').find(button => button.props.children === '查看已保存的医生角色').props.onClick()
  assert.deepEqual(opened, ['saved-doctor'])
})

test('source review links load the requested job even outside the recent history', async () => {
  const older = { ...doctorJob, id: 'older', query: '本次角色的原始检索', created_at: '2026-10-30T00:00:00Z', status: 'completed', source_ids: [] }
  const reads: string[] = []
  const app = page('../components/research-panel.tsx', 'ResearchPanel', async path => {
    reads.push(path)
    return path === '/research/jobs/older' ? older : { configured: true, profiles: [],
      jobs: [{ ...older, id: 'latest', query: '另一位医生的最新检索' }], sources: [], watches: [] }
  }, '#workspace?tab=research&job=older')
  app.render()
  await settle()
  const view = app.render()
  assert.equal(find(view, 'h3')[0].props.children, older.query)
  assert.deepEqual(reads, ['/research', '/research/jobs/older'])
})

test('published doctor changes require a draft and publishing returns to stable identity', async () => {
  const original = { id: 'doctor-1', version: 1, status: 'published', name: 'Doctor', updated_at: '2026-10-30T00:00:00Z' }
  const draft = { ...original, id: 'revision-1', status: 'draft' }
  const calls: string[] = []
  const app = page('platform-page.tsx', 'CatalogPage', async (path, options) => {
    calls.push(path)
    if (path === '/catalog/doctor') return [original]
    if (path === '/catalog/doctor/doctor-1' && !options?.method) return original
    if (path === '/catalog/doctor/doctor-1/revision') return draft
    if (path === '/catalog/doctor/revision-1/publish') return { ...original, version: 2 }
    throw new Error(`Unexpected path ${path}`)
  })
  app.render({kind:'doctor'}); await settle()
  find(app.render({kind:'doctor'}), 'button')[0].props.onClick(); await settle()
  let view=app.render({kind:'doctor'})
  assert.equal(find(view,'DoctorForm')[0].props.disabled,true)
  find(view,'Button').find(button=>button.props.children==='创建新版本').props.onClick(); await settle()
  view=app.render({kind:'doctor'})
  assert.equal(find(view,'DoctorForm')[0].props.disabled,false)
  find(view,'Button').find(button=>button.props.children==='发布医生').props.onClick(); await settle()
  view=app.render({kind:'doctor'})
  assert.equal(find(view,'DoctorForm')[0].key,'doctor-1-2')
  assert.equal(find(view,'DoctorForm')[0].props.disabled,true)
  assert.equal(find(view,'button').length,1)
  assert.deepEqual(calls,['/catalog/doctor','/catalog/doctor/doctor-1','/catalog/doctor/doctor-1/revision','/catalog/doctor/revision-1/publish'])
})

test('doctor draft deep link opens the reviewed draft', async () => {
  const draft = { id: 'draft-1', version: 1, status: 'draft', name: '医生草稿', updated_at: '2026-10-30T00:00:00Z' }
  const app = page('platform-page.tsx','CatalogPage',async path=>path==='/catalog/doctor'?[draft]:draft,'#workspace?tab=doctor&doctor=draft-1')
  app.render({kind:'doctor'});await settle()
  const view=app.render({kind:'doctor'})
  assert.equal(find(view,'DoctorForm')[0].key,'draft-1-1')
})
