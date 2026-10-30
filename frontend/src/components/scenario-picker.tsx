import { useEffect, useId, useRef, useState } from 'react'
import { api } from '@/lib/platform-api'
import { stages, type Scenario, type TrainingSnapshot } from '@/lib/catalog-types'
import { recommendedScenario } from '@/lib/training-setup'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export type TrainingChoice = {scenario_id:string;stage:string;remediation_id?:string;experience?:'practice'|'combat';mode?:'assisted'|'independent'}
export type StartTraining = (choice:TrainingChoice)=>void
export function ScenarioPicker({ value, onChange, onReady, autoSelect=false }: {value:TrainingChoice;onChange:(value:TrainingChoice)=>void;onReady:(ready:boolean)=>void;autoSelect?:boolean}) {
  const [scenes,setScenes]=useState<Scenario[]>([])
  const [preview,setPreview]=useState<TrainingSnapshot|null>(null)
  const [error,setError]=useState('')
  const [loaded,setLoaded]=useState(false)
  const [refresh,setRefresh]=useState(0)
  const autoSelected=useRef(false)
  const sceneId=useId(),stageId=useId()
  useEffect(()=>{const controller=new AbortController();api<Scenario[]>('/catalog/scenario',{signal:controller.signal}).then(rows=>{setScenes(rows.filter(row=>row.status==='published'));setLoaded(true)}).catch(cause=>{if(!controller.signal.aborted){setError(cause instanceof Error?cause.message:'场景加载失败');setLoaded(true);onReady(false)}});return()=>controller.abort()},[refresh,onReady])
  useEffect(()=>{
    if(!loaded||error)return
    if(autoSelect&&!autoSelected.current){
      autoSelected.current=true
      const recommended=recommendedScenario(scenes)
      if(!value.scenario_id&&recommended){onReady(false);onChange({scenario_id:recommended.id,stage:'full'});return}
    }
    if(!value.scenario_id)onReady(true)
  },[autoSelect,loaded,error,scenes,value.scenario_id,onChange,onReady])
  useEffect(()=>{
    if(!value.scenario_id)return
    const controller=new AbortController()
    api<TrainingSnapshot>(`/scenarios/${encodeURIComponent(value.scenario_id)}/preview?stage=${value.stage}`,{signal:controller.signal}).then(data=>{setPreview(data);onReady(true)}).catch(cause=>{if(!controller.signal.aborted){setError(cause instanceof Error?cause.message:'场景无效');onReady(false)}})
    return()=>controller.abort()
  },[value.scenario_id,value.stage,onReady,refresh])
  const selected=scenes.find(s=>s.id===value.scenario_id)
  const current=preview?.scenario.id===value.scenario_id&&preview.stage===value.stage?preview:null
  function change(next:TrainingChoice){autoSelected.current=true;setError('');setPreview(null);onReady(!next.scenario_id&&loaded);onChange(next)}
  return <section className="space-y-4">
    <div className="space-y-2"><label htmlFor={sceneId} className="text-sm font-medium">本次训练场景</label><Select value={value.scenario_id||'free'} disabled={!loaded||Boolean(value.remediation_id)} onValueChange={id=>change({scenario_id:id==='free'?'':id,stage:'full'})}><SelectTrigger id={sceneId} className="min-h-12 w-full"><SelectValue placeholder="正在读取训练场景…"/></SelectTrigger><SelectContent><SelectItem value="free">自由沟通练习 · 不评分</SelectItem>{value.scenario_id&&!selected&&<SelectItem value={value.scenario_id}>{current?.scenario.title??'正在核对所选场景…'}</SelectItem>}{scenes.map(scene=><SelectItem key={scene.id} value={scene.id}>{scene.title}</SelectItem>)}</SelectContent></Select></div>
    {!loaded&&<p role="status" className="text-sm text-muted-foreground">正在准备可用场景…</p>}
    {error&&<div role="alert" className="space-y-2 text-sm"><p className="leading-6 text-destructive">{error}</p><Button variant="outline" onClick={()=>{setError('');setLoaded(false);onReady(false);setRefresh(value=>value+1)}}>重新读取场景</Button></div>}
    {value.scenario_id&&!current&&!error&&<p role="status" className="text-sm text-muted-foreground">正在核对资料与评分标准…</p>}
    {current&&<div className="space-y-3"><p className="text-sm leading-7">{current.scenario.objective}</p><p className="text-sm text-muted-foreground">{current.doctor.display_name} · 建议 {Math.round(current.scenario.duration_seconds/60*10)/10} 分钟</p><details className="text-sm"><summary className="cursor-pointer text-muted-foreground">资料与评分依据</summary><div className="mt-3 space-y-2 border-l pl-3 leading-6"><p>{current.documents.length} 份已核对资料 · {current.rubric.name}</p>{current.documents.map(document=><p key={document.id}>{document.title} · {document.version_label}</p>)}{current.rubric.calibration_status!=='calibrated'&&<p className="text-muted-foreground">评分标准尚未完成专家校准，仅作练习反馈。</p>}</div></details></div>}
    {selected&&!value.remediation_id&&<details className="text-sm"><summary className="cursor-pointer text-muted-foreground">训练环节：{stages[value.stage]??'完整拜访'}<span className="ml-2">更改</span></summary><div className="mt-3 space-y-2"><label htmlFor={stageId}>本轮训练环节</label><Select value={value.stage} onValueChange={stage=>change({...value,stage})}><SelectTrigger id={stageId} className="min-h-11 w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="full">完整拜访</SelectItem>{selected.stages.map(stage=><SelectItem key={stage} value={stage}>{stages[stage]}</SelectItem>)}</SelectContent></Select></div></details>}
    {value.remediation_id&&<p className="text-sm leading-6 text-muted-foreground">沿用原场景 · {stages[value.stage]??'完整拜访'}</p>}
    {loaded&&!value.scenario_id&&!error&&<p className="text-sm leading-7 text-muted-foreground">{scenes.length?'自由练习不评分。':'暂无已发布场景，可先进行不评分的自由练习。'}<a href="#workspace" className="underline underline-offset-4">配置评分场景</a>。</p>}
  </section>
}
