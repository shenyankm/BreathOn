import { Field,FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { stages,type Content,type Doctor,type ManagedDrug,type Rubric,type Scenario,type TrainingCase } from '@/lib/catalog-types'
import { scenarioTemplates,scenarioGroups } from '@/lib/scenario-templates'
import { api } from '@/lib/platform-api'
import { useEffect,useRef,useState,type FormEvent } from 'react'
import { Accordion,AccordionContent,AccordionItem,AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Select,SelectContent,SelectGroup,SelectItem,SelectLabel,SelectTrigger,SelectValue } from './ui/select'
import { Textarea } from './ui/textarea'

export function ScenarioGenerator({doctors,rubrics,contents,cases,drugs=[],onGenerated}:{doctors:Doctor[];rubrics:Rubric[];contents:Content[];cases:TrainingCase[];drugs?:ManagedDrug[];onGenerated:(scene:Scenario)=>void}) {
  const linkedDrugId=new URLSearchParams(location.hash.split('?')[1]).get('drug')??''
  const linkedDrug=drugs.find(drug=>drug.id===linkedDrugId)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [selected,setSelected]=useState<string[]>([])
  const [duration,setDuration]=useState(scenarioTemplates.first_visit.duration_seconds)
  const [situation,setSituation]=useState('first_visit')
  const [objective,setObjective]=useState(scenarioTemplates.first_visit.objective)
  const [difficulty,setDifficulty]=useState(scenarioTemplates.first_visit.difficulty)
  const [caseId,setCaseId]=useState(()=>new URLSearchParams(location.hash.split('?')[1]).get('case')??'')
  const request=useRef<AbortController|null>(null)
  useEffect(()=>()=>request.current?.abort(),[])
  const availableDoctors=doctors.filter(item=>item.status==='published')
  const availableRubrics=rubrics.filter(item=>item.status==='published')
  const availableContent=contents.filter(item=>item.status==='approved'&&item.usable!==false)
  const ready=(!linkedDrugId||linkedDrug?.status==='published')&&availableDoctors.length>0&&availableRubrics.length>0&&availableContent.length>0
  async function generate(event:FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data=new FormData(event.currentTarget)
    const controller=new AbortController();request.current=controller
    setBusy(true);setError('')
    try {
      const body={...Object.fromEntries(['product','disease','objective','doctor_id','rubric_id','situation','difficulty'].map(key=>[key,String(data.get(key)??'')])),duration_seconds:duration,content_ids:selected,...(linkedDrugId?{drug_id:linkedDrugId}:{}),...(caseId?{case_id:caseId}:{})}
      const scene=await api<Scenario>('/scenarios/generate',{method:'POST',body:JSON.stringify(body),signal:controller.signal,timeoutMs:60000})
      onGenerated(scene)
    }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'场景生成失败，请重试。')}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  return <Accordion type="single" collapsible defaultValue={caseId||linkedDrugId?'generator':undefined} className="px-5 [&_[data-slot=accordion-content][data-state=closed]]:hidden"><AccordionItem value="generator" ><AccordionTrigger className="min-h-14">AI 生成拜访场景</AccordionTrigger><AccordionContent forceMount>

    {!ready&&<p role="status" className="mt-3 text-sm leading-7">需已发布医生、量表及至少一份有效的已核对资料。</p>}
    <form key={linkedDrug?.id??'default'} onSubmit={generate} className="mt-5"><fieldset disabled={busy||!ready} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3"><Field><FieldLabel htmlFor="generator-situation">{"拜访情境"}</FieldLabel><Select name="situation" value={situation} disabled={busy||!ready} onValueChange={value=>{setSituation(value);setObjective(scenarioTemplates[value].objective);setDuration(scenarioTemplates[value].duration_seconds);setDifficulty(scenarioTemplates[value].difficulty)}}><SelectTrigger id="generator-situation" className="w-full min-h-11"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start">{scenarioGroups.map(group=><SelectGroup key={group}><SelectLabel>{group}</SelectLabel>{Object.entries(scenarioTemplates).filter(([,template])=>template.group===group).map(([key,template])=><SelectItem key={key} value={key}>{template.label}</SelectItem>)}</SelectGroup>)}</SelectContent></Select></Field><Field><FieldLabel htmlFor="generator-difficulty">{"训练难度"}</FieldLabel><Select name="difficulty" value={difficulty} onValueChange={setDifficulty} disabled={busy||!ready}><SelectTrigger id="generator-difficulty" className="w-full min-h-11"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectItem value="basic">基础</SelectItem><SelectItem value="intermediate">中等</SelectItem><SelectItem value="advanced">进阶</SelectItem></SelectContent></Select></Field><Field><FieldLabel className="grid w-full gap-2">{"拜访时限（秒）"}<Input className="min-h-11" type="number" min={30} max={600} required value={duration} onChange={event=>setDuration(Number(event.target.value))}/></FieldLabel></Field></div>
      <p className="text-sm text-muted-foreground">训练环节：{scenarioTemplates[situation].stages.map(stage=>stages[stage]).join('、')}</p>
      <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="product">{"产品"}</FieldLabel><Input name="product" maxLength={120} type="text" required id="product" defaultValue={linkedDrug?.name??''} /></Field><Field><FieldLabel htmlFor="disease">{"治疗领域"}</FieldLabel><Input name="disease" maxLength={120} type="text" required id="disease" defaultValue="" /></Field></div>
      <Field><FieldLabel className="grid w-full gap-2">{"本次训练目标"}<Textarea name="objective" required maxLength={1500} value={objective} onChange={event=>setObjective(event.target.value)}/></FieldLabel></Field>
      <Field><FieldLabel htmlFor="generator-case">{"参考经验案例（可选）"}</FieldLabel><Select value={caseId} disabled={busy||!ready} onValueChange={value=>setCaseId(value==='__none__'?'':value)}><SelectTrigger id="generator-case" className="w-full min-h-11"><SelectValue placeholder="不使用案例" /></SelectTrigger><SelectContent position="popper" align="start"><SelectItem value="__none__">不使用案例</SelectItem>{cases.filter(item=>item.status==='confirmed').map(item=><SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="generator-doctor">{"模拟医生"}</FieldLabel><Select name="doctor_id" required disabled={busy||!ready}><SelectTrigger id="generator-doctor" className="w-full min-h-11"><SelectValue placeholder="选择已发布医生" /></SelectTrigger><SelectContent position="popper" align="start">{availableDoctors.map(item=><SelectItem value={item.id} key={item.id}>{item.display_name}</SelectItem>)}</SelectContent></Select></Field><Field><FieldLabel htmlFor="generator-rubric">{"评分量表"}</FieldLabel><Select name="rubric_id" required disabled={busy||!ready}><SelectTrigger id="generator-rubric" className="w-full min-h-11"><SelectValue placeholder="选择已发布量表" /></SelectTrigger><SelectContent position="popper" align="start">{availableRubrics.map(item=><SelectItem value={item.id} key={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></Field></div>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">本次生成依据</legend>{availableContent.map(item=><Label key={item.id} className="flex min-h-11 items-start gap-3 py-2"><Checkbox disabled={busy||!ready} className="mt-1" checked={selected.includes(item.id)} onCheckedChange={checked=>setSelected(checked===true?[...selected,item.id]:selected.filter(id=>id!==item.id))}/><span>{item.title}<span className="block text-xs text-muted-foreground">{item.version_label} · {item.scope}</span></span></Label>)}</fieldset>
      <Button type="submit" disabled={busy||!ready||selected.length===0}>{busy?'正在生成草稿…':'生成场景草稿'}</Button>
    </fieldset></form>
    {busy&&<p role="status" className="mt-4 text-sm leading-6">正在根据所选资料设计情境并校验引用，请稍候。</p>}
    {error&&<p role="alert" className="mt-4 text-sm leading-7 text-destructive">{error}</p>}
  </AccordionContent></AccordionItem></Accordion>
}
