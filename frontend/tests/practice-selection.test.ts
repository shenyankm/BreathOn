import { isAppDrug } from '../src/lib/app-drugs.ts'
import { doctorLabel } from '../src/lib/doctor-label.ts'
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
      if (module === '@/lib/app-drugs') return { isAppDrug }
      if (module === '@/lib/doctor-label') return { doctorLabel }
      if (module === 'react') return react
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (module === '@/lib/practice-images') return { drugImage: () => undefined, doctorIllustration: '/doctor-illustration.png' }
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
  { id: 'drug-a', version: 1, status: 'published', name: '玛仕度肽', brand: '品牌 A', practice_departments: ['内分泌科', '心内科'] },
  { id: 'drug-b', version: 2, status: 'published', name: '玛仕度肽注射液', brand: '品牌 B', practice_departments: ['内分泌科', '心内科'] },
  { id: 'draft-drug', version: 1, status: 'draft', name: '草稿药品', brand: '' },
]
const doctors = [
  { id: 'doctor-a', version: 1, status: 'published', name: '模拟医生 A', display_name: '模拟医生 A（训练模拟）', specialty: '内分泌科', practice_department: '内分泌科', sources: [] },
  { id: 'doctor-b', version: 1, status: 'published', name: '模拟医生 B', display_name: '模拟医生 B（训练模拟）', specialty: '心内科', practice_department: '心内科', sources: [] },
  { id: 'retired-doctor', version: 1, status: 'retired', name: '停用医生', display_name: '停用医生（训练模拟）', specialty: '', sources: [] },
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

test('free practice starts with published drugs and enables matching doctors after selection', async () => {
  const app = picker(async path => {
    const query = new URLSearchParams(path.split('?')[1])
    assert.equal(path.split('?')[0], '/practice/preview')
    assert.equal(query.get('scenario_id'), null)
    return freeContext(query.get('drug_id')!, query.get('doctor_id')!)
  })
  app.render()
  let view = await app.flush()
  assert.equal(find(view, 'Tabs').length, 0)
  assert.equal(app.calls.includes('/catalog/scenario'), false)
  const options = find(view, 'SelectItem').map(node => node.props.value)
  for (const id of ['drug-a', 'drug-b', 'doctor-a', 'doctor-b']) assert.ok(options.includes(id), id)
  for (const id of ['draft-drug', 'retired-doctor', 'draft-scene']) assert.ok(!options.includes(id), id)
  assert.deepEqual(plain(app.value), { scenario_id: '', stage: 'full', drug_id: 'drug-a' })
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

test('selected cards retain full drug, brand, doctor and specialty labels after a stale preview arrives', async () => {
  const longDrugs = [
    { ...drugs[0], brand: '测试长商品名甲' },
    { ...drugs[1], brand: '测试长商品名乙' },
  ]
  const longDoctors = [
    { ...doctors[0], name: '某医学中心门诊模拟医生甲（长角色名称）', specialty: '内分泌与代谢病学专科甲' },
    { ...doctors[1], name: '另一医学中心模拟医生乙（完整角色名称）', specialty: '心血管内科学专科乙' },
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
    const text = find(view, 'SelectValue').map(textOf).join(' ')
    for (const label of [longDrugs[1].name, longDrugs[1].brand, longDoctors[1].name, longDoctors[1].specialty]) assert.ok(text.includes(label), label)
    for (const label of [longDrugs[0].brand, longDoctors[0].name]) assert.ok(!text.includes(label), label)
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

test('new practice exposes only free pairing with no scored scenario selector', async () => {
  const app = picker()
  app.render(); const view = await app.flush()
  assert.equal(find(view, 'Tabs').length, 0)
  assert.equal(find(view, 'Select').length, 2)
  assert.doesNotMatch(textOf(view), /评分场景|自由练习 · 不评分|本次训练场景/)
  assert.equal(app.calls.includes('/catalog/scenario'), false)
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
  const modeButtons = find(view, 'Button').filter(node => ['辅助练习', '实战练习'].includes(textOf(node)))
  assert.deepEqual(modeButtons.map(textOf), ['辅助练习', '实战练习'])
  assert.equal(modeButtons[0].props['aria-pressed'], true)
  modeButtons[1].props.onClick()
  const after = component('pages/practice-home.tsx', 'PracticeHome', async () => [])
  const returned = after.render(props())
  assert.deepEqual(plain(find(returned, 'ScenarioPicker')[0].props.value), next)
  assert.equal(find(returned, 'Button').find(node => textOf(node) === '实战练习')!.props['aria-pressed'], true)
  assert.equal(find(returned, 'Button').find(node => textOf(node) === '辅助练习')!.props['aria-pressed'], false)
})

test('choosing a drug filters doctors and changing drugs clears only an incompatible doctor', async () => {
  const scopedDrugs = [{ ...drugs[0], practice_departments: ['内分泌科'] }, drugs[1]]
  const app = picker(async path => { const query = new URLSearchParams(path.split('?')[1]); return freeContext(query.get('drug_id')!, query.get('doctor_id')!) }, undefined, { drugs: scopedDrugs, doctors, scenes })
  app.render(); await app.flush()
  app.choose('练习药品', 'drug-b')
  let view = await app.flush()
  let options = find(view, 'SelectItem').map(node => node.props.value)
  assert.ok(options.includes('doctor-a') && options.includes('doctor-b'))
  app.choose('模拟医生', 'doctor-b'); await app.flush()
  assert.equal(app.readiness.at(-1), true)
  app.choose('练习药品', 'drug-a')
  view = await app.flush()
  assert.equal(app.value.doctor_id, undefined)
  assert.equal(app.readiness.at(-1), false)
  options = find(view, 'SelectItem').map(node => node.props.value)
  assert.ok(options.includes('doctor-a'))
  assert.ok(!options.includes('doctor-b'))
  app.choose('模拟医生', 'doctor-a'); await app.flush()
  app.choose('练习药品', 'drug-b'); await app.flush()
  assert.equal(app.value.doctor_id, 'doctor-a')
  assert.equal(app.readiness.at(-1), true)
})

test('restored incompatible pairs cannot be previewed or started', async () => {
  const app = picker(async () => assert.fail('incompatible preview'), { scenario_id: '', stage: 'full', drug_id: 'drug-a', doctor_id: 'doctor-b' },
    { drugs: [{ ...drugs[0], practice_departments: ['内分泌科'] }], doctors, scenes })
  app.render(); const view = await app.flush()
  assert.equal(app.readiness.at(-1), false)
  assert.match(textOf(view), /科室不匹配/)
  assert.equal(app.calls.filter(path => path.startsWith('/practice/preview')).length, 0)
})

test('a drug with no matching published doctors shows an empty state and cannot start', async () => {
  const app = picker(async () => assert.fail('empty match preview'), { scenario_id: '', stage: 'full', drug_id: 'drug-a' },
    { drugs: [{ ...drugs[0], practice_departments: ['眼科'] }], doctors, scenes })
  app.render(); const view = await app.flush()
  assert.equal(app.readiness.at(-1), false)
  assert.match(textOf(view), /暂无科室对口的已发布医生/)
  assert.ok(find(view, 'Select').some(node => node.props.disabled && find(node, 'SelectTrigger').some(trigger => trigger.props['aria-label'] === '模拟医生')))
})


test('doctor-first selection filters drugs and previews only a compatible pair', async () => {
  const app = picker(async path => { const q = new URLSearchParams(path.split('?')[1]); return freeContext(q.get('drug_id')!, q.get('doctor_id')!) }, undefined,
    { drugs: [{ ...drugs[0], practice_departments: ['内分泌科'] }, { ...drugs[1], practice_departments: ['心内科'] }], doctors, scenes })
  app.render(); let view = await app.flush()
  assert.ok(find(view, 'Select').some(node => !node.props.disabled && find(node, 'SelectTrigger').some(trigger => trigger.props['aria-label'] === '模拟医生')))
  app.choose('模拟医生', 'doctor-b'); view = await app.flush()
  assert.equal(app.readiness.at(-1), false)
  assert.equal(app.calls.filter(path => path.startsWith('/practice/preview')).length, 0)
  const drugSelect = find(view, 'Select').find(node => find(node, 'SelectTrigger').some(trigger => trigger.props['aria-label'] === '练习药品'))!
  assert.deepEqual(find(drugSelect, 'SelectItem').map(node => node.props.value), ['drug-b'])
  app.choose('练习药品', 'drug-b'); view = await app.flush()
  assert.equal(app.value.doctor_id, 'doctor-b')
  assert.equal(app.readiness.at(-1), true)
  assert.ok(find(view, 'AvatarImage').some(node => node.props.alt === '统一医生模拟插图，非本人照片'))
  app.choose('模拟医生', 'doctor-a'); await app.flush()
  assert.equal(app.value.drug_id, undefined)
  assert.equal(app.readiness.at(-1), false)
})

test('a doctor with no matching drug can be selected first and shows a recoverable empty state', async () => {
  const app = picker(undefined, {scenario_id:'', stage:'full', doctor_id:'doctor-b'}, {drugs:[{...drugs[0], practice_departments:['内分泌科']}], doctors, scenes})
  app.render(); const view = await app.flush()
  assert.match(textOf(view), /该医生暂无科室对口的已发布药品/)
  assert.equal(app.readiness.at(-1), false)
  assert.ok(find(view, 'Button').some(node => textOf(node) === '清除选择'))
})

test('pair information follows selection and clearing without repeating the full pair', async () => {
  const app = picker(async () => freeContext('drug-a', 'doctor-a'))
  app.render(); let view = await app.flush()
  const info = () => find(view, 'div').find(node => node.props['aria-label'] === '练习组合信息')!
  assert.match(textOf(info()), /可选科室/)
  app.choose('练习药品', 'drug-a'); view = await app.flush()
  assert.match(textOf(info()), /可选科室/)
  app.choose('模拟医生', 'doctor-a'); view = await app.flush()
  assert.match(textOf(info()), /科室已匹配/)
  assert.doesNotMatch(textOf(info()), /请选择|均可先选/)
  find(info(), 'Button').find(node => textOf(node) === '清除选择')!.props.onClick()
  view = await app.flush()
  assert.equal(app.value.drug_id, undefined)
  assert.equal(app.value.doctor_id, undefined)
  assert.match(textOf(info()), /药品、医生均可先选/)
})

test('App limits drugs to mazdutide while keeping multiple doctors and rejecting stale selections', async () => {
  const other = { ...drugs[0], id: 'other', name: '阿达木单抗注射液' }
  const app = picker(undefined, { scenario_id: '', stage: 'full', drug_id: 'other', doctor_id: 'doctor-a' }, { drugs: [drugs[0], other], doctors, scenes })
  app.render()
  const view = await app.flush()
  const options = find(view, 'SelectItem').filter(node => !node.props.disabled).map(node => node.props.value)
  assert.ok(options.includes('drug-a'))
  assert.ok(!options.includes('other'))
  assert.ok(options.includes('doctor-a') && options.includes('doctor-b'))
  assert.equal(app.readiness.at(-1), false)
  assert.ok(!app.calls.some(path => path.startsWith('/practice/preview')))
})


test('default mazdutide preserves a compatible doctor and waits for the verified preview', async () => {
  const app = picker(async () => freeContext('drug-a', 'doctor-a'), { scenario_id: '', stage: 'full', doctor_id: 'doctor-a' })
  app.render(); await app.flush(); await app.flush()
  assert.equal(app.value.drug_id, 'drug-a')
  assert.equal(app.value.doctor_id, 'doctor-a')
  assert.equal(app.readiness.at(-1), true)
  assert.equal(app.calls.filter(path => path.startsWith('/practice/preview')).length, 1)
})
