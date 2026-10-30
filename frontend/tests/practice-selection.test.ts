import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { stages } from '../src/lib/catalog-types.ts'
import { presetFor, recommendedScenario, trainingPresets } from '../src/lib/training-setup.ts'

type Node = { type: string; props: any }
type Choice = { scenario_id: string; stage: string; drug_id?: string; doctor_id?: string; remediation_id?: string }
type Api = (path: string, options?: RequestInit) => Promise<unknown>

function component(file: string, name: string, api: Api) {
  const slots: any[] = [], effects: (() => void)[] = []
  let cursor = 0
  const react = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) {
        const slot = { value: typeof initial === 'function' ? initial() : initial, set: (_next: any) => {} }
        slot.set = next => { slot.value = typeof next === 'function' ? next(slot.value) : next }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].set]
    },
    useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
    useId() { const index = cursor++; return slots[index] ??= `control-${index}` },
    useEffect(callback: () => void | (() => void), dependencies: unknown[]) {
      const index = cursor++, previous = slots[index]
      if (!previous || dependencies.length !== previous.dependencies.length || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        effects.push(() => {
          previous?.cleanup?.()
          slots[index] = { dependencies, cleanup: callback() }
        })
      }
    },
  }
  const jsx = (type: string, props: any) => ({ type, props })
  const exports: Record<string, (props: unknown) => Node> = {}
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController, Error, URLSearchParams,
    require(module: string) {
      if (module === 'react') return react
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (module === '@/lib/platform-api') return { api }
      if (module === '@/lib/catalog-types') return { stages }
      if (module === '@/lib/training-setup') return { presetFor, recommendedScenario, trainingPresets }
      if (module === '@/lib/session') return { formatTime: () => '00:00' }
      assert.ok(module === 'lucide-react' || module.startsWith('./ui/') || module.startsWith('@/components/'), module)
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    render(props: unknown) { cursor = 0; const result = exports[name](props); effects.splice(0).forEach(effect => effect()); return result },
  }
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
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
const drugs = [
  { id: 'drug-a', version: 1, status: 'published', name: '药品 A', brand: '品牌 A' },
  { id: 'drug-b', version: 2, status: 'published', name: '药品 B', brand: '品牌 B' },
  { id: 'draft-drug', version: 1, status: 'draft', name: '草稿药品', brand: '' },
]
const doctors = [
  { id: 'doctor-a', version: 1, status: 'published', display_name: '模拟医生 A', specialty: '内分泌科', sources: [] },
  { id: 'doctor-b', version: 1, status: 'published', display_name: '模拟医生 B', specialty: '心内科', sources: [] },
  { id: 'retired-doctor', version: 1, status: 'retired', display_name: '停用医生', specialty: '', sources: [] },
]
const scenes = [
  { id: 'scene-a', status: 'published', title: '固定组合场景', drug_id: 'drug-a', doctor_id: 'doctor-a', difficulty: 'basic', stages: ['evidence'] },
  { id: 'draft-scene', status: 'draft', title: '草稿场景', drug_id: 'drug-b', doctor_id: 'doctor-b', stages: [] },
]
const freeContext = (drugId: string, doctorId: string) => ({ drug: drugs.find(drug => drug.id === drugId), doctor: doctors.find(doctor => doctor.id === doctorId) })
const scenePreview = { scenario: { id: 'scene-a', title: '固定组合场景', objective: '回应医生问题', duration_seconds: 180 }, doctor: doctors[0], rubric: { name: '训练量表', calibration_status: 'calibrated' }, documents: [], stage: 'full' }

function picker(preview: Api = async path => { throw new Error(`Unexpected preview: ${path}`) }, initial: Choice = { scenario_id: '', stage: 'full' }, catalog = { drugs, doctors, scenes }) {
  let value = initial
  const readiness: boolean[] = [], calls: string[] = []
  const api: Api = async (path, options) => {
    assert.equal(options?.method, undefined)
    calls.push(path)
    if (path === '/catalog/drug') return catalog.drugs
    if (path === '/catalog/doctor') return catalog.doctors
    if (path === '/catalog/scenario') return catalog.scenes
    return preview(path, options)
  }
  const app = component('components/scenario-picker.tsx', 'ScenarioPicker', api)
  const onChange = (next: Choice) => { value = next }
  const onReady = (ready: boolean) => { readiness.push(ready) }
  const render = () => app.render({ value, onChange, onReady })
  return {
    render, readiness, calls,
    get value() { return value },
    async flush() { await settle(); render(); await settle(); return render() },
    choose(label: string, id: string) {
      const select = find(render(), 'Select').find(node => find(node, 'SelectTrigger').some(trigger => trigger.props['aria-label'] === label))
      assert.ok(select, label)
      select.props.onValueChange(id)
    },
  }
}

test('free practice defaults to independent published drug and doctor choices', async () => {
  const app = picker(async path => {
    const query = new URLSearchParams(path.split('?')[1])
    assert.equal(path.split('?')[0], '/practice/preview')
    assert.equal(query.get('scenario_id'), null)
    return freeContext(query.get('drug_id')!, query.get('doctor_id')!)
  })
  app.render()
  let view = await app.flush()
  assert.equal(find(view, 'Tabs')[0].props.value, 'free')
  const options = find(view, 'SelectItem').map(node => node.props.value)
  for (const id of ['drug-a', 'drug-b', 'doctor-a', 'doctor-b', 'scene-a']) assert.ok(options.includes(id), id)
  for (const id of ['draft-drug', 'retired-doctor', 'draft-scene']) assert.ok(!options.includes(id), id)
  assert.deepEqual(plain(app.value), { scenario_id: '', stage: 'full' })
  assert.equal(app.readiness.at(-1), false)
  app.choose('练习药品', 'drug-b')
  await app.flush()
  assert.equal(app.calls.filter(path => path.startsWith('/practice/preview')).length, 0)
  app.choose('模拟医生', 'doctor-a')
  view = await app.flush()
  assert.deepEqual(plain(app.value), { scenario_id: '', stage: 'full', drug_id: 'drug-b', doctor_id: 'doctor-a' })
  assert.equal(app.readiness.at(-1), true)
  assert.equal(app.calls.filter(path => path.startsWith('/practice/preview')).length, 1)
  assert.equal(find(view, 'a').filter(node => /\/admin|#workspace|#settings/.test(node.props.href)).length, 0)
})

test('long drug and doctor labels remain available in the current free-pair summary after a stale preview arrives', async () => {
  const longDrugs = [
    { ...drugs[0], name: '测试药品名称甲——检验窄屏中完整通用名的可读性', brand: '测试长商品名甲' },
    { ...drugs[1], name: '测试药品名称乙——验证重新选择后仍能读取完整名称', brand: '测试长商品名乙' },
  ]
  const longDoctors = [
    { ...doctors[0], display_name: '某医学中心门诊模拟医生甲（长角色名称）', specialty: '内分泌与代谢病学专科甲' },
    { ...doctors[1], display_name: '另一医学中心模拟医生乙（完整角色名称）', specialty: '心血管内科学专科乙' },
  ]
  const pending: ((value: unknown) => void)[] = []
  const app = picker(() => new Promise(resolve => pending.push(resolve)), undefined, { drugs: longDrugs, doctors: longDoctors, scenes })
  app.render()
  await app.flush()
  app.choose('练习药品', longDrugs[0].id)
  app.choose('模拟医生', longDoctors[0].id)
  await app.flush()
  app.choose('练习药品', longDrugs[1].id)
  app.choose('模拟医生', longDoctors[1].id)
  let view = await app.flush()
  assert.ok(pending.length >= 2)
  function assertCurrentSummary() {
    const summary = find(view, 'p').find(node => node.props['aria-label'] === '本次自由组合')
    assert.ok(summary, 'the chosen pair has an accessible full-label summary')
    const text = textOf(summary)
    for (const label of [longDrugs[1].name, longDrugs[1].brand, longDoctors[1].display_name, longDoctors[1].specialty]) assert.ok(text.includes(label), label)
    for (const label of [longDrugs[0].name, longDoctors[0].display_name]) assert.ok(!text.includes(label), label)
  }
  assertCurrentSummary()
  pending.at(-1)!({ drug: longDrugs[1], doctor: longDoctors[1] })
  view = await app.flush()
  assertCurrentSummary()
  pending[0]({ drug: longDrugs[0], doctor: longDoctors[0] })
  view = await app.flush()
  assertCurrentSummary()
  assert.equal(app.readiness.at(-1), true)
})

for (const result of ['resolve', 'reject'] as const) {
  test(`a stale free preview ${result} cannot overwrite readiness for a newer pair`, async () => {
    const pending: { signal?: AbortSignal | null; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
    const app = picker((_path, options) => new Promise((resolve, reject) => pending.push({ signal: options?.signal, resolve, reject })))
    app.render()
    await app.flush()
    app.choose('练习药品', 'drug-a')
    app.choose('模拟医生', 'doctor-a')
    await app.flush()
    app.choose('练习药品', 'drug-b')
    await app.flush()
    assert.equal(pending.length, 2)
    assert.equal(pending[0].signal?.aborted, true)
    pending[1].resolve(freeContext('drug-b', 'doctor-a'))
    await app.flush()
    assert.equal(app.readiness.at(-1), true)
    const before = [...app.readiness]
    if (result === 'resolve') pending[0].resolve(freeContext('drug-a', 'doctor-a'))
    else pending[0].reject(new Error('旧组合已停用'))
    const view = await app.flush()
    assert.deepEqual(app.readiness, before)
    assert.equal(find(view, 'Alert').length, 0)
    assert.equal(app.value.drug_id, 'drug-b')
  })
}

test('switching to a scored scene removes free overrides and invalidates its pending preview immediately', async () => {
  let finishFree!: (value: unknown) => void
  const app = picker(path => path.startsWith('/practice/preview') ? new Promise(resolve => { finishFree = resolve }) : Promise.resolve(scenePreview))
  app.render()
  await app.flush()
  app.choose('练习药品', 'drug-b')
  app.choose('模拟医生', 'doctor-b')
  await app.flush()
  find(app.render(), 'Tabs')[0].props.onValueChange('scenario')
  assert.deepEqual(plain(app.value), { scenario_id: 'scene-a', stage: 'full' })
  const before = [...app.readiness]
  finishFree(freeContext('drug-b', 'doctor-b'))
  await settle()
  assert.deepEqual(app.readiness, before)
  await app.flush()
  assert.ok(app.calls.some(path => path.startsWith('/scenarios/scene-a/preview?')))
  assert.equal(app.readiness.at(-1), true)
})

test('empty published choices keep free practice unavailable and direct the user to an administrator', async () => {
  const app = picker(undefined, undefined, { drugs: [drugs[2]], doctors: [doctors[2]], scenes })
  app.render()
  const view = await app.flush()
  assert.match(textOf(view), /暂无已发布药品/)
  assert.match(textOf(view), /暂无已发布医生/)
  assert.match(textOf(view), /请联系管理员/)
  assert.equal(app.readiness.at(-1), false)
  assert.equal(app.calls.filter(path => path.includes('/preview')).length, 0)
})

test('a failed current free preview can be retried without losing the selected pair', async () => {
  let attempts = 0, finishRetry!: (value: unknown) => void
  const initial = { scenario_id: '', stage: 'full', drug_id: 'drug-b', doctor_id: 'doctor-a' }
  const app = picker(async () => {
    if (++attempts === 1) throw new Error('组合核对暂时失败')
    return new Promise(resolve => { finishRetry = resolve })
  }, initial)
  app.render()
  let view = await app.flush()
  assert.equal(attempts, 1)
  assert.equal(app.readiness.at(-1), false)
  assert.match(textOf(find(view, 'Alert')[0]), /组合核对暂时失败/)
  const retry = find(view, 'Button').find(node => textOf(node) === '重新读取')
  assert.ok(retry)
  retry.props.onClick()
  assert.equal(app.readiness.at(-1), false)
  await app.flush()
  assert.equal(attempts, 2)
  assert.deepEqual(plain(app.value), initial)
  assert.equal(app.readiness.at(-1), false)
  finishRetry(freeContext('drug-b', 'doctor-a'))
  view = await app.flush()
  assert.equal(find(view, 'Alert').length, 0)
  assert.equal(app.readiness.at(-1), true)
})

test('an existing scene or remediation keeps its binding and does not request a free preview', async () => {
  const initial = { scenario_id: 'scene-a', stage: 'evidence', remediation_id: 'remediation-1' }
  const app = picker(async () => ({ ...scenePreview, stage: 'evidence' }), initial)
  app.render()
  await app.flush()
  assert.deepEqual(plain(app.value), initial)
  assert.equal(app.calls.filter(path => path.startsWith('/practice/preview')).length, 0)
  assert.ok(app.calls.some(path => path.includes('/scenarios/scene-a/preview?stage=evidence')))
  assert.equal(app.readiness.at(-1), true)
})

test('the home page preserves a restored free pair through the start callback', () => {
  const app = component('pages/practice-home.tsx', 'PracticeHome', async () => [])
  const initialChoice = { scenario_id: '', stage: 'full', drug_id: 'drug-b', doctor_id: 'doctor-a' }
  const started: unknown[] = []
  const props = { initialChoice, initialPreset: trainingPresets[0], sessionState: '', seconds: 0, onStart: (choice: unknown) => started.push(choice) }
  let view = app.render(props)
  const selection = find(view, 'ScenarioPicker')[0]
  assert.deepEqual(plain(selection.props.value), initialChoice)
  assert.ok(!selection.props.autoSelect)
  selection.props.onReady(true)
  view = app.render(props)
  const start = find(view, 'Button').find(node => textOf(node).includes('开始练习'))
  assert.ok(start)
  assert.equal(start.props.disabled, false)
  start.props.onClick()
  assert.deepEqual(plain(started), [initialChoice])
})


test('practice choices stay in the app owner when the home page is unmounted for another tab', () => {
  let choice = { scenario_id: '', stage: 'full', drug_id: 'drug-a', doctor_id: 'doctor-a' }
  let preset = trainingPresets[0] as typeof trainingPresets[number]
  const next = { ...choice, drug_id: 'drug-b', doctor_id: 'doctor-b' }
  const props = () => ({ initialChoice: choice, initialPreset: preset, sessionState: '', seconds: 0,
    onStart() {}, onChoiceChange: (value: typeof choice) => { choice = value }, onPresetChange: (value: typeof preset) => { preset = value } })
  const before = component('pages/practice-home.tsx', 'PracticeHome', async () => [])
  const view = before.render(props())
  find(view, 'ScenarioPicker')[0].props.onChange(next)
  find(view, 'Select')[0].props.onValueChange('combat')
  const after = component('pages/practice-home.tsx', 'PracticeHome', async () => [])
  const returned = after.render(props())
  assert.deepEqual(plain(find(returned, 'ScenarioPicker')[0].props.value), next)
  assert.equal(find(returned, 'Select')[0].props.value, 'combat')
})
