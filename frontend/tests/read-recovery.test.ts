import { doctorLabel } from '../src/lib/doctor-label.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { indexProductSources } from '../src/lib/medical.ts'

type Node = { type: unknown; props: any }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function nodes(node: any, type: string): Node[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type))
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)]
}
function text(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return node && typeof node === 'object' ? text(node.props?.children) : ''
}
const button = (tree: Node, label: string) => nodes(tree, 'Button').find(node => text(node) === label)!
function mount(file: string, component: string, api: (path: string, options?: RequestInit) => Promise<unknown>, props = {}, hash = '#records?session=one') {
  const slots: any[] = [], pending: (() => void)[] = [], listeners: Record<string, () => void> = {}
  let cursor = 0
  const jsx = (type: unknown, props: any) => ({ type, props })
  const exports: Record<string, (props: unknown) => Node> = {}
  const location = { hash }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Error, AbortController, URLSearchParams, encodeURIComponent,
    FormData: class { values: Record<string, string>; constructor(values: Record<string, string>) { this.values = values } get(key: string) { return this.values[key] } },
    window: { location, addEventListener(key: string, fn: () => void) { listeners[key] = fn }, removeEventListener() {} },
    require(name: string) {
      if (name === '@/lib/doctor-label') return { doctorLabel }
      if (name === 'react') return {
        useState(initial: any) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (next: any) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next }] },
        useRef(initial: unknown) { return slots[cursor++] ??= { current: initial } },
        useMemo(fn: () => unknown) { return fn() },
        useEffect(fn: () => unknown, deps: unknown[]) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) pending.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: fn() } }) },
      }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@/lib/platform-api') return { api }
      if (name === '@/lib/medical') return { indexProductSources }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return {
    render() { cursor = 0; const tree = exports[component](props); pending.splice(0).forEach(fn => fn()); return tree },
    hash(value: string) { location.hash = value; listeners.hashchange?.() },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}

test('record detail retry recovers without leaving the dialog; late old record cannot overwrite current detail', async () => {
  let fail = true, oldResolve!: (value: unknown) => void
  const record = (id: string) => ({ id, experience: 'practice', started_at: '', status: 'completed', messages: [], coaching: [], free_context: { drug: { name: id }, doctor: { display_name: 'doctor' } } })
  const app = mount('pages/records-page.tsx', 'RecordsPage', async path => {
    if (path === '/sessions') return []
    if (path === '/sessions/old') return new Promise(resolve => { oldResolve = resolve })
    if (fail) throw new Error('offline')
    return record(path.split('/').at(-1)!)
  })
  app.render(); await settle()
  assert.ok(text(app.render()).includes('无法读取这条记录'))
  fail = false
  button(app.render(), '重新读取').props.onClick()
  app.render(); await settle()
  assert.ok(text(app.render()).includes('one · doctor'))
  app.hash('#records?session=old'); app.render()
  app.hash('#records?session=new'); app.render(); await settle()
  oldResolve(record('old')); await settle()
  assert.ok(text(app.render()).includes('new · doctor'))
  assert.equal(text(app.render()).includes('old · doctor'), false)
})

test('feedback read recovers and repeated retrain retains form on failure then unlocks', async () => {
  let failRead = true, writes = 0, rejectWrite!: (error: Error) => void, resets = 0
  const app = mount('components/review-panel.tsx', 'ReviewPanel', async (path, options) => {
    if (options?.method) { writes++; return new Promise((_resolve, reject) => { rejectWrite = reject }) }
    if (failRead) throw new Error('read offline')
    return path.endsWith('/reviews') ? { reviews: [], responses: [] } : []
  }, { record: { id: 'one', messages: [], training: { stage: 'full', scenario: { stages: [] }, rubric: { dimensions: [] }, documents: [] } } })
  app.render(); await settle()
  failRead = false; button(app.render(), '重新读取点评').props.onClick()
  app.render(); await settle()
  let tree = app.render()
  assert.equal(text(tree).includes('read offline'), false)
  const form = nodes(tree, 'form')[0]
  const event = { preventDefault() {}, currentTarget: { stage: 'full', note: '保留补练说明', reset() { resets++ } } }
  form.props.onSubmit(event); form.props.onSubmit(event)
  assert.equal(writes, 1)
  assert.equal(nodes(app.render(), 'fieldset')[0].props.disabled, true)
  rejectWrite(new Error('write failed')); await settle()
  tree = app.render()
  assert.equal(resets, 0)
  assert.equal(button(tree, '生成补练任务').props.disabled, false)
  assert.ok(text(tree).includes('write failed'))
})

test('progress ignores late superseded responses and shows recoverable current failure', async () => {
  let oldResolve!: (value: unknown) => void
  const app = mount('components/training-progress.tsx', 'TrainingProgress', async path => {
    if (path.endsWith('30')) return new Promise(resolve => { oldResolve = resolve })
    throw new Error('current failure')
  }, { refresh: 0 })
  app.render()
  button(app.render(), '7 天').props.onClick(); app.render(); await settle()
  oldResolve({ invalid: true }); await settle()
  assert.ok(text(app.render()).includes('current failure'))
  assert.ok(button(app.render(), '重试统计'))
})

test('a retraining record shows its parent comparison and prepares another assigned task without duplicate starts', async()=>{
  const started:unknown[]=[];let nextCalls=0,finish!:(value:unknown)=>void
  const app=mount('components/review-panel.tsx','ReviewPanel',async(path)=>{
    if(path.endsWith('/reviews'))return {reviews:[],responses:[]}
    if(path.endsWith('/remediations'))return [{id:'next-plan',parent_record_id:'child',status:'assigned',focus_label:'需求确认',note:'再次确认',attempts:0,comparable:false,dimensions:[]}]
    if(path.endsWith('/progress'))return {id:'parent-plan',parent_record_id:'baseline',status:'completed',focus_label:'需求确认',note:'聚焦沟通',attempts:1,comparable:true,same_stage:true,latest_record_id:'child',dimensions:[{key:'communication',label:'沟通',before:2,after:3,delta:1}]}
    if(path.endsWith('/next')){nextCalls++;return new Promise(resolve=>{finish=resolve})}
    assert.fail(path)
  },{record:{id:'child',remediation_id:'parent-plan',messages:[]},onStart:(choice:unknown)=>started.push(choice)})
  app.render();await settle();let tree=app.render()
  assert.match(text(tree),/原记录与最新重练/)
  assert.match(text(tree),/2.*3.*\+1/)
  assert.equal(nodes(tree,'a').find(node=>text(node)==='查看原训练记录')?.props.href,'#records?session=baseline')
  button(tree,'开始针对性重练').props.onClick();button(tree,'开始针对性重练').props.onClick()
  assert.equal(nextCalls,1)
  finish({scenario_id:'scene',stage:'full',remediation_id:'next-plan',experience:'practice',mode:'assisted'});await settle()
  assert.equal(started.length,1)
})

test('pending retraining can recover from a failed read and only starts assigned tasks',async()=>{
  let offline=true;const started:unknown[]=[]
  const app=mount('components/retraining-list.tsx','RetrainingList',async path=>{
    if(offline)throw new Error('任务加载失败')
    if(path==='/remediations')return ['assigned','completed'].map(status=>({id:status,status,focus_label:status,stage:'full',parent_record_id:'baseline'}))
    return {remediation_id:'assigned'}
  },{onStart:(choice:unknown)=>started.push(choice)})
  app.render();await settle()
  assert.match(text(app.render()),/任务加载失败/)
  offline=false;button(app.render(),'重新读取重练任务').props.onClick();app.render();await settle()
  const tree=app.render()
  assert.equal(nodes(tree,'article').length,1)
  button(tree,'开始重练').props.onClick();await settle()
  assert.equal(started.length,1)
})

test('representative progress exposes practice changes without provider usage details',async()=>{
  const app=mount('components/training-progress.tsx','TrainingProgress',async()=>({days:30,session_count:0,completed_count:0,valid_practice_count:0,duration_seconds:0,unknown_duration_count:0,groups:[],sessions:[],cost_totals:{CNY:'999'},unpriced_session_count:0}),{refresh:0})
  app.render();await settle();const tree=app.render()
  assert.match(text(tree),/暂无可评分训练/)
  assert.doesNotMatch(text(tree),/计价|用量|999|token/)
})
