import { useEffect, useId, useRef, useState } from 'react'
import { api } from '@/lib/platform-api'
import { stages, type Doctor, type FreePracticeContext, type ManagedDrug, type Scenario, type TrainingSnapshot } from '@/lib/catalog-types'
import { recommendedScenario } from '@/lib/training-setup'
import { Button } from './ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

export type TrainingChoice = {scenario_id:string;stage:string;drug_id?:string;doctor_id?:string;remediation_id?:string;experience?:'practice'|'combat';mode?:'assisted'|'independent'}
export type StartTraining = (choice:TrainingChoice)=>void
function matches(drug: ManagedDrug | undefined, doctor: Doctor | undefined) {
  return Boolean(doctor && drug?.practice_departments?.includes(doctor.practice_department ?? doctor.specialty))
}

type Preview = {kind:'scenario';key:string;data:TrainingSnapshot} | {kind:'free';key:string;data:FreePracticeContext}

export function ScenarioPicker({ value, onChange, onReady }: {value:TrainingChoice;onChange:(value:TrainingChoice)=>void;onReady:(ready:boolean)=>void}) {
  const [tab,setTab]=useState('free')
  const kind=value.scenario_id?'scenario':tab
  const [scenes,setScenes]=useState<Scenario[]>([])
  const [drugs,setDrugs]=useState<ManagedDrug[]>([])
  const [doctors,setDoctors]=useState<Doctor[]>([])
  const [preview,setPreview]=useState<Preview|null>(null)
  const [catalogError,setCatalogError]=useState('')
  const [previewError,setPreviewError]=useState<{key:string;message:string}|null>(null)
  const [loaded,setLoaded]=useState(false)
  const [refresh,setRefresh]=useState(0)
  const requestVersion=useRef(0)
  const sceneId=useId(),stageId=useId(),drugId=useId(),doctorId=useId()
  const selectedDrug=drugs.find(drug=>drug.id===value.drug_id)
  const selectedDoctor=doctors.find(doctor=>doctor.id===value.doctor_id)
  const compatible=matches(selectedDrug,selectedDoctor)
  const availableDoctors=selectedDrug?doctors.filter(doctor=>matches(selectedDrug,doctor)):[]
  const selectionKey=JSON.stringify(kind==='scenario'?['scenario',value.scenario_id,value.stage]:['free',value.drug_id,value.doctor_id])

  useEffect(()=>{
    const controller=new AbortController()
    onReady(false)
    Promise.all([
      api<Scenario[]>('/catalog/scenario',{signal:controller.signal}),
      api<ManagedDrug[]>('/catalog/drug',{signal:controller.signal}),
      api<Doctor[]>('/catalog/doctor',{signal:controller.signal}),
    ]).then(([sceneRows,drugRows,doctorRows])=>{
      if(controller.signal.aborted)return
      setScenes(sceneRows.filter(row=>row.status==='published'))
      setDrugs(drugRows.filter(row=>row.status==='published'))
      setDoctors(doctorRows.filter(row=>row.status==='published'))
      setLoaded(true)
    }).catch(cause=>{
      if(controller.signal.aborted)return
      setCatalogError(cause instanceof Error?cause.message:'演练选项加载失败');setLoaded(true)
    })
    return()=>controller.abort()
  },[refresh,onReady])

  useEffect(()=>{
    const version=++requestVersion.current
    onReady(false)
    if(!loaded||catalogError)return
    if(kind==='scenario'?!value.scenario_id:Boolean(value.scenario_id)||!value.drug_id||!value.doctor_id)return
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
  },[kind,value.scenario_id,value.stage,value.drug_id,value.doctor_id,selectionKey,loaded,catalogError,onReady,refresh,compatible])

  const selected=scenes.find(scene=>scene.id===value.scenario_id)
  const current=preview?.kind==='scenario'&&preview.key===selectionKey?preview.data:null
  const freeReady=compatible&&preview?.kind==='free'&&preview.key===selectionKey
  const error=catalogError||(previewError?.key===selectionKey?previewError.message:'')
  function change(next:TrainingChoice){requestVersion.current++;setPreview(null);setPreviewError(null);onReady(false);onChange(next)}
  function switchKind(next:string){setTab(next);change(next==='scenario'?{scenario_id:recommendedScenario(scenes)?.id??'',stage:'full'}:{scenario_id:'',stage:'full'})}
  function retry(){requestVersion.current++;setPreview(null);setPreviewError(null);setCatalogError('');setLoaded(false);onReady(false);setRefresh(value=>value+1)}

  return <section className="min-w-0 space-y-3">
    <Tabs value={kind} onValueChange={switchKind} className="gap-3">
      {!value.remediation_id&&<TabsList className="grid h-[50px]! w-full grid-cols-2 items-stretch" aria-label="演练内容类型"><TabsTrigger value="free" className="h-full min-h-11 w-full min-w-0 rounded-full">自由练习 · 不评分</TabsTrigger><TabsTrigger value="scenario" className="h-full min-h-11 w-full min-w-0 rounded-full">评分场景</TabsTrigger></TabsList>}
      <TabsContent value="free" className="min-w-0 space-y-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5"><label htmlFor={drugId} className="text-sm font-medium">练习药品</label><Select value={value.drug_id??''} disabled={!loaded||!drugs.length} onValueChange={id=>change({scenario_id:'',stage:'full',drug_id:id,doctor_id:matches(drugs.find(drug=>drug.id===id),selectedDoctor)?value.doctor_id:undefined})}><SelectTrigger id={drugId} aria-label="练习药品" className="min-h-11 w-full min-w-0 text-left whitespace-normal data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none"><SelectValue placeholder="选择药品">{selectedDrug?.name}</SelectValue></SelectTrigger><SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">{value.drug_id&&!selectedDrug&&<SelectItem value={value.drug_id} disabled>所选药品已不可用</SelectItem>}{drugs.map(drug=><SelectItem key={drug.id} value={drug.id} disabled={!drug.practice_departments?.length} className="min-h-11"><span className="min-w-0 whitespace-normal break-words leading-5">{drug.name}{drug.brand?` · ${drug.brand}`:''}{!drug.practice_departments?.length?' · 对口科室待配置':''}</span></SelectItem>)}</SelectContent></Select></div>
          <div className="min-w-0 space-y-1.5"><label htmlFor={doctorId} className="text-sm font-medium">模拟医生</label><Select value={value.doctor_id??''} disabled={!loaded||!selectedDrug||!availableDoctors.length} onValueChange={id=>change({scenario_id:'',stage:'full',drug_id:value.drug_id,doctor_id:id})}><SelectTrigger id={doctorId} aria-label="模拟医生" className="min-h-11 w-full min-w-0 text-left whitespace-normal data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none"><SelectValue placeholder={selectedDrug?"选择对口医生":"请先选择药品"}>{selectedDoctor?.name}</SelectValue></SelectTrigger><SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">{value.doctor_id&&!availableDoctors.some(doctor=>doctor.id===value.doctor_id)&&<SelectItem value={value.doctor_id} disabled>所选医生已不可用或科室不匹配</SelectItem>}{availableDoctors.map(doctor=><SelectItem key={doctor.id} value={doctor.id} className="min-h-11"><span className="min-w-0 whitespace-normal break-words leading-5">{doctor.name} · {doctor.specialty}</span></SelectItem>)}</SelectContent></Select></div>
        </div>
        {selectedDrug&&<p className="text-xs leading-5 text-muted-foreground">对口科室：{selectedDrug.practice_departments?.join('、')||'待配置'}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs leading-5 text-muted-foreground">选择药品后，只显示科室对口的可练习医生。</p>{(value.drug_id||value.doctor_id)&&<Button type="button" variant="ghost" className="min-h-11" onClick={()=>change({scenario_id:'',stage:'full'})}>清除选择</Button>}</div>
        {loaded&&!catalogError&&selectedDrug&&selectedDoctor&&!compatible&&<p role="alert" className="text-sm text-destructive">所选药品与医生科室不匹配，请重新选择。</p>}
        {loaded&&!catalogError&&selectedDrug&&!availableDoctors.length&&<p role="status" className="text-sm text-muted-foreground">该药品暂无科室对口的已发布医生，请更换药品或联系管理员。</p>}
        {compatible&&selectedDrug&&selectedDoctor&&<p aria-label="本次自由组合" className="break-words text-xs leading-5 text-muted-foreground">{selectedDrug.name}{selectedDrug.brand?`（${selectedDrug.brand}）`:''} × {selectedDoctor.name} · {selectedDoctor.specialty}</p>}
        {loaded&&!catalogError&&<div role="status" className="text-sm leading-6 text-muted-foreground">{!drugs.length&&<p>暂无已发布药品，请联系管理员。</p>}{!doctors.length&&<p>暂无已发布医生，请联系管理员。</p>}{compatible&&value.drug_id&&value.doctor_id&&!freeReady&&!error&&<p>正在核对药品与医生…</p>}</div>}
      </TabsContent>
      <TabsContent value="scenario" className="min-w-0 space-y-4">
        <div className="space-y-2"><label htmlFor={sceneId} className="text-sm font-medium">本次训练场景</label><Select value={value.scenario_id||''} disabled={!loaded||Boolean(value.remediation_id)||!scenes.length} onValueChange={id=>change({scenario_id:id,stage:'full'})}><SelectTrigger id={sceneId} className="min-h-11 w-full min-w-0 text-left whitespace-normal data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none"><SelectValue placeholder="选择已发布场景" /></SelectTrigger><SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">{value.scenario_id&&!selected&&<SelectItem value={value.scenario_id} className="min-h-11">{current?.scenario.title??'正在核对所选场景…'}</SelectItem>}{scenes.map(scene=><SelectItem key={scene.id} value={scene.id} className="min-h-11"><span className="min-w-0 whitespace-normal break-words leading-5">{scene.title}</span></SelectItem>)}</SelectContent></Select></div>
        {loaded&&!scenes.length&&!catalogError&&<p className="text-sm leading-6 text-muted-foreground">暂无已发布评分场景。</p>}
        {value.scenario_id&&!current&&!error&&<p role="status" className="text-sm text-muted-foreground">正在核对资料与评分标准…</p>}
        {selected&&!value.remediation_id&&<div className="space-y-2"><label htmlFor={stageId} className="text-sm font-medium">本轮训练环节</label><Select value={value.stage} onValueChange={stage=>change({scenario_id:value.scenario_id,stage})}><SelectTrigger id={stageId} className="min-h-11 w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="full" className="min-h-11">完整拜访</SelectItem>{selected.stages.map(stage=><SelectItem key={stage} value={stage} className="min-h-11">{stages[stage]}</SelectItem>)}</SelectContent></Select></div>}
        {current&&<Accordion type="single" collapsible className="rounded-none border-x-0 border-b-0"><AccordionItem value="sources"><AccordionTrigger className="min-h-11 px-0 text-muted-foreground">场景详情与评分依据</AccordionTrigger><AccordionContent className="space-y-4 leading-6"><div className="space-y-2"><h3 className="font-medium">本次训练目标</h3><p className="text-muted-foreground">{current.scenario.objective}</p></div><dl className="grid gap-4 border-y py-4 sm:grid-cols-2"><div className="space-y-1.5"><dt className="text-xs text-muted-foreground">模拟医生</dt><dd className="font-medium">{current.doctor.display_name}</dd><dd className="text-xs text-muted-foreground">{current.doctor.specialty}</dd></div><div className="space-y-1.5"><dt className="text-xs text-muted-foreground">建议时长</dt><dd className="font-medium tabular-nums">{Math.round(current.scenario.duration_seconds/60*10)/10} 分钟</dd></div></dl><div className="space-y-2"><p>{current.documents.length} 份已核对资料 · {current.rubric.name}</p>{current.documents.map(document=><p key={document.id}>{document.title} · {document.version_label}</p>)}{current.rubric.calibration_status!=='calibrated'&&<p className="text-muted-foreground">评分标准尚未完成专家校准，仅作练习反馈。</p>}</div></AccordionContent></AccordionItem></Accordion>}
        {value.remediation_id&&<p className="text-sm leading-6 text-muted-foreground">沿用原场景 · {stages[value.stage]??'完整拜访'}</p>}
      </TabsContent>
    </Tabs>
    {!loaded&&<p role="status" className="text-sm text-muted-foreground">正在读取演练选项…</p>}
    {error&&<Alert variant="destructive" role="alert"><AlertTitle>演练配置暂时无法使用</AlertTitle><AlertDescription><p>{error}</p><Button variant="outline" className="mt-2 h-11" onClick={retry}>重新读取</Button></AlertDescription></Alert>}
  </section>
}
