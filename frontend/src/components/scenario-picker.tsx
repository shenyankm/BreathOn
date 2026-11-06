import { Label } from '@/components/ui/label'
import { isAppDrug } from '@/lib/app-drugs'
import { stages,type Doctor,type FreePracticeContext,type ManagedDrug,type Scenario,type TrainingSnapshot } from '@/lib/catalog-types'
import { doctorLabel } from '@/lib/doctor-label'
import { api } from '@/lib/platform-api'
import { recommendedScenario } from '@/lib/training-setup'
import { useEffect,useId,useRef,useState } from 'react'
import { Accordion,AccordionContent,AccordionItem,AccordionTrigger } from './ui/accordion'
import { Alert,AlertDescription,AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from './ui/select'
import { Tabs,TabsList,TabsTrigger } from './ui/tabs'

export type TrainingChoice = {scenario_id:string;stage:string;drug_id?:string;doctor_id?:string;focus?:'first'|'evidence'|'next';remediation_id?:string;focus_label?:string;note?:string;experience?:'practice'|'combat';mode?:'assisted'|'independent'}
export type StartTraining = (choice:TrainingChoice)=>void
function matches(drug: ManagedDrug | undefined, doctor: Doctor | undefined) {
  return Boolean(doctor && drug?.practice_departments?.includes(doctor.practice_department ?? doctor.specialty))
}

type Preview = {kind:'scenario';key:string;data:TrainingSnapshot} | {kind:'free';key:string;data:FreePracticeContext}

export function ScenarioPicker({ value, onChange, onReady }: {value:TrainingChoice;onChange:(value:TrainingChoice)=>void;onReady:(ready:boolean)=>void}) {
  const [selectionMode,setSelectionMode]=useState<'scenario'|'free'>(value.drug_id||value.doctor_id?'free':'scenario')
  const kind=value.scenario_id||value.remediation_id?'scenario':value.drug_id||value.doctor_id?'free':selectionMode
  const [scenes,setScenes]=useState<Scenario[]>([])
  const [drugs,setDrugs]=useState<ManagedDrug[]>([])
  const [doctors,setDoctors]=useState<Doctor[]>([])
  const [preview,setPreview]=useState<Preview|null>(null)
  const [catalogFailure,setCatalogFailure]=useState<{kind:string;message:string}|null>(null)
  const [previewError,setPreviewError]=useState<{key:string;message:string}|null>(null)
  const [loadedKind,setLoadedKind]=useState('')
  const loaded=loadedKind===kind
  const catalogError=catalogFailure?.kind===kind?catalogFailure.message:''
  const [refresh,setRefresh]=useState(0)
  const requestVersion=useRef(0)
  const defaultApplied=useRef({scenario:false,free:false})
  const drugId=useId(),doctorId=useId(),sceneId=useId(),stageId=useId()
  const selectedScene=scenes.find(scene=>scene.id===value.scenario_id)
  const selectedDrug=drugs.find(drug=>drug.id===value.drug_id)
  const selectedDoctor=doctors.find(doctor=>doctor.id===value.doctor_id)
  const compatible=matches(selectedDrug,selectedDoctor)
  const availableDoctors=selectedDrug?doctors.filter(doctor=>matches(selectedDrug,doctor)):doctors
  const availableDrugs=selectedDoctor?drugs.filter(drug=>matches(drug,selectedDoctor)):drugs

  const selectionKey=JSON.stringify(kind==='scenario'?['scenario',value.scenario_id,value.stage]:['free',value.drug_id,value.doctor_id])

  useEffect(()=>{
    const controller=new AbortController()
    onReady(false)
    const request=kind==='scenario'?api<Scenario[]>('/catalog/scenario',{signal:controller.signal}).then(rows=>{
      if(!controller.signal.aborted)setScenes(rows.filter(row=>row.status==='published'))
    }):Promise.all([
      api<ManagedDrug[]>('/catalog/drug',{signal:controller.signal}),
      api<Doctor[]>('/catalog/doctor',{signal:controller.signal}),
    ]).then(([drugRows,doctorRows])=>{
      if(controller.signal.aborted)return
      setDrugs(drugRows.filter(isAppDrug))
      setDoctors(doctorRows.filter(row=>row.status==='published'))
    })
    request.then(()=>{if(!controller.signal.aborted){setCatalogFailure(null);setLoadedKind(kind)}}).catch(cause=>{
      if(controller.signal.aborted)return
      setCatalogFailure({kind,message:cause instanceof Error?cause.message:'演练选项加载失败'});setLoadedKind(kind)
    })
    return()=>controller.abort()
  },[kind,refresh,onReady])

  useEffect(()=>{
    if(!loaded||catalogError||defaultApplied.current[kind])return
    defaultApplied.current[kind]=true
    if(kind==='scenario'){
      if(!value.scenario_id&&!value.remediation_id){const scene=recommendedScenario(scenes);if(scene)onChange({scenario_id:scene.id,stage:'full'})}
      return
    }
    if(value.drug_id)return
    const drug=drugs.find(item=>!value.doctor_id||matches(item,selectedDoctor))
    if(drug)onChange({...value,drug_id:drug.id})
  },[loaded,catalogError,kind,value,drugs,scenes,selectedDoctor,onChange])

  useEffect(()=>{
    const version=++requestVersion.current
    onReady(false)
    if(!loaded||catalogError)return
    if(kind==='scenario'?!selectedScene||!(value.stage==='full'||selectedScene.stages.includes(value.stage)):!value.drug_id||!value.doctor_id)return
    if(kind==='free'&&!compatible)return
    const controller=new AbortController()
    const request=kind==='scenario'
      ? api<TrainingSnapshot>(`/scenarios/${encodeURIComponent(value.scenario_id)}/preview?stage=${encodeURIComponent(value.stage)}`,{signal:controller.signal}).then(data=>({kind:'scenario' as const,data}))
      : api<FreePracticeContext>(`/practice/preview?${new URLSearchParams({drug_id:value.drug_id!,doctor_id:value.doctor_id!})}`,{signal:controller.signal}).then(data=>({kind:'free' as const,data}))
    request.then(result=>{
      if(controller.signal.aborted||version!==requestVersion.current)return
      setPreview({...result,key:selectionKey});setPreviewError(null);onReady(true)
    }).catch(cause=>{
      if(controller.signal.aborted||version!==requestVersion.current)return
      setPreviewError({key:selectionKey,message:cause instanceof Error?cause.message:'演练配置暂时不可用'});onReady(false)
    })
    return()=>controller.abort()
  },[kind,value.scenario_id,value.stage,value.drug_id,value.doctor_id,selectionKey,loaded,catalogError,onReady,refresh,compatible,selectedScene])

  const current=preview?.kind==='scenario'&&preview.key===selectionKey?preview.data:null
  const freeReady=compatible&&preview?.kind==='free'&&preview.key===selectionKey
  const error=catalogError||(previewError?.key===selectionKey?previewError.message:'')
  function change(next:TrainingChoice){setSelectionMode(kind);requestVersion.current++;setPreview(null);setPreviewError(null);onReady(false);onChange(next)}
  function retry(){requestVersion.current++;setPreview(null);setPreviewError(null);setCatalogFailure(null);setLoadedKind('');onReady(false);setRefresh(value=>value+1)}

  return <section className="@container min-w-0 space-y-3">
      {!value.remediation_id&&<Tabs value={kind} onValueChange={next=>{if(next!=='scenario'&&next!=='free')return;change({scenario_id:'',stage:'full'});setSelectionMode(next)}}><TabsList aria-label="练习内容"><TabsTrigger className="min-h-11" value="scenario">场景训练</TabsTrigger><TabsTrigger className="min-h-11" value="free">自由练习</TabsTrigger></TabsList></Tabs>}
      {kind==='free'&&<div className="min-w-0 space-y-3"><p className="text-sm leading-6 text-muted-foreground">自由练习可获得沟通复盘，不生成场景量表评分。</p>
        <div className="grid min-w-0 gap-3 items-start @lg:grid-cols-2">
          <div className="min-w-0 space-y-2"><Label htmlFor={drugId} className="block px-1 text-muted-foreground">练习药品</Label><Select value={value.drug_id??''} disabled={!loaded||!availableDrugs.length} onValueChange={id=>change({scenario_id:'',stage:'full',drug_id:id,doctor_id:matches(drugs.find(drug=>drug.id===id),selectedDoctor)?value.doctor_id:undefined})}><SelectTrigger id={drugId} aria-label="练习药品" className="w-full data-[size=default]:h-auto"><SelectValue placeholder="选择药品" /></SelectTrigger><SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">{value.drug_id&&!selectedDrug&&<SelectItem value={value.drug_id} disabled>所选药品已不可用</SelectItem>}{availableDrugs.map(drug=><SelectItem key={drug.id} value={drug.id} disabled={!drug.practice_departments?.length} className="min-h-11"><span className="min-w-0 whitespace-normal break-words leading-5">{drug.name}{drug.brand?` · ${drug.brand}`:''}{!drug.practice_departments?.length?' · 对口科室待配置':''}</span></SelectItem>)}</SelectContent></Select></div>
          <div className="min-w-0 space-y-2"><Label htmlFor={doctorId} className="block px-1 text-muted-foreground">模拟医生</Label><Select value={value.doctor_id??''} disabled={!loaded||!availableDoctors.length} onValueChange={id=>change({scenario_id:'',stage:'full',drug_id:matches(selectedDrug,doctors.find(doctor=>doctor.id===id))?value.drug_id:undefined,doctor_id:id})}><SelectTrigger id={doctorId} aria-label="模拟医生" className="w-full data-[size=default]:h-auto"><SelectValue placeholder="选择医生" /></SelectTrigger><SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">{value.doctor_id&&!availableDoctors.some(doctor=>doctor.id===value.doctor_id)&&<SelectItem value={value.doctor_id} disabled>所选医生已不可用或科室不匹配</SelectItem>}{availableDoctors.map(doctor=><SelectItem key={doctor.id} value={doctor.id} className="min-h-11"><span className="min-w-0 whitespace-normal break-words leading-5">{doctorLabel(doctor.name)} · {doctor.specialty}</span></SelectItem>)}</SelectContent></Select></div>
        </div>
        {(value.drug_id||value.doctor_id)&&<Button type="button" variant="ghost" className="min-h-11" onClick={()=>change({scenario_id:'',stage:'full'})}>清除选择</Button>}
        {loaded&&!catalogError&&selectedDrug&&selectedDoctor&&!compatible&&<p role="alert" className="text-sm text-destructive">所选药品与医生科室不匹配，请重新选择。</p>}
        {loaded&&!catalogError&&selectedDoctor&&!availableDrugs.length&&<p role="status" className="text-sm text-muted-foreground">该医生暂无科室对口的已发布药品，请更换医生或联系管理员。</p>}
        {loaded&&!catalogError&&selectedDrug&&!availableDoctors.length&&<p role="status" className="text-sm text-muted-foreground">该药品暂无科室对口的已发布医生，请更换药品或联系管理员。</p>}
        {loaded&&!catalogError&&<div role="status" className="text-sm leading-6 text-muted-foreground">{!drugs.length&&<p>暂无已发布药品，请联系管理员。</p>}{!doctors.length&&<p>暂无已发布医生，请联系管理员。</p>}{compatible&&value.drug_id&&value.doctor_id&&!freeReady&&!error&&<p>正在核对药品与医生…</p>}</div>}
      </div>}
      {kind==='scenario'&&<div className="min-w-0 space-y-4">
        <div className="grid min-w-0 items-start gap-3 @lg:grid-cols-2"><div className="min-w-0 space-y-2"><Label htmlFor={sceneId}>训练场景</Label><Select value={value.scenario_id} disabled={Boolean(value.remediation_id)||!loaded||!scenes.length} onValueChange={id=>change({scenario_id:id,stage:'full'})}><SelectTrigger id={sceneId} aria-label="训练场景" className="w-full data-[size=default]:h-auto min-h-11"><SelectValue placeholder="选择已发布场景" /></SelectTrigger><SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">{value.scenario_id&&!selectedScene&&<SelectItem value={value.scenario_id} disabled>所选场景已不可用</SelectItem>}{scenes.map(scene=><SelectItem key={scene.id} value={scene.id} className="min-h-11"><span className="whitespace-normal break-words">{scene.title}</span></SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label htmlFor={stageId}>训练环节</Label><Select value={value.stage} disabled={Boolean(value.remediation_id)||!selectedScene||!loaded} onValueChange={stage=>change({scenario_id:value.scenario_id,stage})}><SelectTrigger id={stageId} aria-label="训练环节" className="w-full min-h-11"><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectItem value="full">完整拜访</SelectItem>{[...new Set(selectedScene?.stages??[])].filter(stage=>stage!=='full').map(stage=><SelectItem key={stage} value={stage}>{stages[stage]??stage}</SelectItem>)}</SelectContent></Select></div></div>
        {loaded&&!catalogError&&!scenes.length&&<p role="status" className="text-sm leading-6 text-muted-foreground">暂无已发布训练场景，请联系管理员；也可以切换自由练习。</p>}
        {loaded&&!catalogError&&value.scenario_id&&!selectedScene&&<p role="alert" className="text-sm text-destructive">所选场景已不可用，请重新选择或联系管理员。</p>}
        {loaded&&selectedScene&&value.stage!=='full'&&!selectedScene.stages.includes(value.stage)&&<p role="alert" className="text-sm text-destructive">该场景不支持所选环节，请重新选择或联系管理员。</p>}
        {loaded&&selectedScene&&(value.stage==='full'||selectedScene.stages.includes(value.stage))&&!current&&!error&&<p role="status" className="text-sm text-muted-foreground">正在核对资料与评分标准…</p>}
        {current&&<div className="space-y-2 text-sm leading-6"><h3 className="font-medium">本次训练目标</h3><p>{current.scenario.objective}</p></div>}
        {current&&<Accordion type="single" collapsible ><AccordionItem value="sources"><AccordionTrigger className="min-h-11 px-0 text-muted-foreground">场景详情与评分依据</AccordionTrigger><AccordionContent className="space-y-4">{current.scenario.success_criteria?.length? <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{current.scenario.success_criteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul>:null}<dl className="grid gap-4 py-4 sm:grid-cols-2"><div className="space-y-1.5"><dt className="text-xs text-muted-foreground">模拟医生</dt><dd className="font-medium">{doctorLabel(current.doctor.display_name)}</dd><dd className="text-xs text-muted-foreground">{current.doctor.specialty}</dd></div><div className="space-y-1.5"><dt className="text-xs text-muted-foreground">建议时长</dt><dd className="font-medium tabular-nums">{Math.round(current.scenario.duration_seconds/60*10)/10} 分钟</dd></div></dl><div className="space-y-2"><p>{current.documents.length} 份已核对资料 · {current.rubric.name}</p>{current.documents.map(document=><p key={document.id}>{document.title} · {document.version_label}</p>)}{current.rubric.calibration_status!=='calibrated'&&<p className="text-muted-foreground">评分标准尚未完成专家校准，仅作练习反馈。</p>}</div></AccordionContent></AccordionItem></Accordion>}
        {value.remediation_id&&<div className="space-y-2 text-sm leading-6"><p>本次重练重点：{value.focus_label??'沿用原训练目标'}</p>{value.note&&<p className="whitespace-pre-wrap break-words">{value.note}</p>}<p className="text-muted-foreground">沿用原场景 · {stages[value.stage]??'完整拜访'}，场景和环节已锁定。</p></div>}
      </div>}
    {!loaded&&<p role="status" className="text-sm text-muted-foreground">正在读取演练选项…</p>}
    {error&&<Alert variant="destructive" role="alert"><AlertTitle>演练配置暂时无法使用</AlertTitle><AlertDescription><p>{error}</p><Button variant="outline" className="mt-2 min-h-11" onClick={retry}>重新读取</Button></AlertDescription></Alert>}
  </section>
}
