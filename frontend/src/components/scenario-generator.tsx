import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from './ui/button'
import { Field, inputClass } from './ui/form-field'
import { Textarea } from './ui/textarea'
import { api } from '@/lib/platform-api'
import { situations, type Content, type Doctor, type Rubric, type Scenario, type TrainingCase } from '@/lib/catalog-types'

export function ScenarioGenerator({doctors,rubrics,contents,cases,onGenerated}:{doctors:Doctor[];rubrics:Rubric[];contents:Content[];cases:TrainingCase[];onGenerated:(scene:Scenario)=>void}) {
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [selected,setSelected]=useState<string[]>([])
  const [duration,setDuration]=useState(300)
  const [caseId,setCaseId]=useState(()=>new URLSearchParams(location.hash.split('?')[1]).get('case')??'')
  const request=useRef<AbortController|null>(null)
  useEffect(()=>()=>request.current?.abort(),[])
  const availableDoctors=doctors.filter(item=>item.status==='published')
  const availableRubrics=rubrics.filter(item=>item.status==='published')
  const availableContent=contents.filter(item=>item.status==='approved'&&item.usable!==false)
  const ready=availableDoctors.length>0&&availableRubrics.length>0&&availableContent.length>0
  async function generate(event:FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data=new FormData(event.currentTarget)
    const controller=new AbortController();request.current=controller
    setBusy(true);setError('')
    try {
      const body={...Object.fromEntries(['product','disease','objective','doctor_id','rubric_id','situation','difficulty'].map(key=>[key,String(data.get(key)??'')])),duration_seconds:duration,content_ids:selected,...(caseId?{case_id:caseId}:{})}
      const scene=await api<Scenario>('/scenarios/generate',{method:'POST',body:JSON.stringify(body),signal:controller.signal,timeoutMs:60000})
      onGenerated(scene)
    }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'场景生成失败，请重试。')}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  return <details open={caseId?true:undefined} className="rounded-xl border bg-background p-5"><summary className="cursor-pointer text-sm font-medium">AI 生成拜访场景</summary>
    <p className="mt-4 text-sm leading-7 text-muted-foreground">生成草稿后，核对情境与原文再发布。</p>
    {!ready&&<p role="status" className="mt-3 text-sm leading-7">需已发布医生、量表及至少一份有效的已核对资料。</p>}
    <form onSubmit={generate} className="mt-5"><fieldset disabled={busy||!ready} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><Field label="产品" name="product" value="玛仕度肽注射液" maxLength={120}/><Field label="治疗领域" name="disease" value="成人体重管理" maxLength={120}/></div>
      <Field label="本次训练目标"><Textarea name="objective" required maxLength={1500} defaultValue="先确认医生关注点，依据资料说明适用人群与证据边界，并约定后续跟进。"/></Field>
      <Field label="参考经验案例（可选）"><select className={inputClass} value={caseId} onChange={event=>setCaseId(event.target.value)}><option value="">不使用案例</option>{cases.filter(item=>item.status==='confirmed').map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="模拟医生"><select name="doctor_id" required className={inputClass} defaultValue=""><option value="" disabled>选择已发布医生</option>{availableDoctors.map(item=><option value={item.id} key={item.id}>{item.display_name}</option>)}</select></Field><Field label="评分量表"><select name="rubric_id" required className={inputClass} defaultValue=""><option value="" disabled>选择已发布量表</option>{availableRubrics.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>
      <div className="grid gap-4 sm:grid-cols-3"><Field label="拜访情境"><select name="situation" className={inputClass} onChange={event=>setDuration(event.target.value==='time_pressure'?90:300)}>{Object.entries(situations).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="训练难度"><select name="difficulty" className={inputClass}><option value="basic">基础</option><option value="intermediate">中等</option><option value="advanced">进阶</option></select></Field><Field label="拜访时限（秒）"><input className={inputClass} type="number" min={30} max={600} required value={duration} onChange={event=>setDuration(Number(event.target.value))}/></Field></div>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">本次生成依据</legend>{availableContent.map(item=><label key={item.id} className="flex min-h-11 items-start gap-3 py-2 text-sm leading-6"><input type="checkbox" className="mt-1" checked={selected.includes(item.id)} onChange={event=>setSelected(event.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id))}/><span>{item.title}<span className="block text-xs text-muted-foreground">{item.version_label} · {item.scope}</span></span></label>)}</fieldset>
      <Button type="submit" disabled={busy||!ready||selected.length===0}>{busy?'正在生成草稿…':'生成场景草稿'}</Button>
    </fieldset></form>
    {busy&&<p role="status" className="mt-4 text-sm leading-6">正在根据所选资料设计情境并校验引用，请稍候。</p>}
    {error&&<p role="alert" className="mt-4 text-sm leading-7 text-destructive">{error}</p>}
  </details>
}
