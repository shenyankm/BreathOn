import { PublicationApproval } from '@/components/publication-approval'
import { ContentHistory } from '@/components/content-history'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { LoadingBlock } from '@/components/loading-block'
import { Badge } from '@/components/ui/badge'
import { CalibrationPanel } from '@/components/calibration-panel'
import { BulkImport } from '@/components/content-import'
import { ScenarioGenerator } from '@/components/scenario-generator'
import { ScenarioTransfer } from '@/components/scenario-transfer'
import { CasesPage } from '@/pages/cases-page'
import { PricingPanel } from '@/components/pricing-panel'
import { ResearchPanel } from '@/components/research-panel'
import { DoctorGenerator } from '@/components/doctor-generator'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ContentForm, DoctorForm, RubricForm, ScenarioForm } from '@/components/catalog-forms'
import { api } from '@/lib/platform-api'
import { costLabel } from '@/lib/progress'
import { kindLabels, statusLabels, titleOf, type Kind, type CatalogRecord, type Content, type Policy, type ManagedDrug, type Doctor, type DoctorDraft, type Rubric, type Scenario, type TrainingSnapshot, type TrainingCase } from '@/lib/catalog-types'
import { Label } from '@/components/ui/label'

function failure(cause: unknown) { return cause instanceof Error ? cause.message : '操作未完成，请重试。' }

function CatalogPage({ kind }: { kind: Kind }) {
  const [rows,setRows]=useState<CatalogRecord[]>([])
  const [item,setItem]=useState<CatalogRecord>()
  const [selection,setSelection]=useState<string|null|undefined>()
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [deleteOpen,setDeleteOpen]=useState(false)
  const [reason,setReason]=useState('')
  const [preview,setPreview]=useState<TrainingSnapshot>()
  const [refresh,setRefresh]=useState(0)
  const [doctorDraft,setDoctorDraft]=useState<{id:string;fields:DoctorDraft}>()
  const [bindings,setBindings]=useState<{doctors:Doctor[];rubrics:Rubric[];contents:Content[];policies:Policy[];drugs:ManagedDrug[];cases:TrainingCase[]}>({doctors:[],rubrics:[],contents:[],policies:[],drugs:[],cases:[]})
  const [bindingsLoaded,setBindingsLoaded]=useState(false)
  const detailRequest=useRef<AbortController|null>(null)
  const listChanges=useRef(new Set<string>())
  useEffect(()=>{
    const controller=new AbortController()
    const changed=new Set<string>();listChanges.current=changed
    api<CatalogRecord[]>(`/catalog/${kind}`,{signal:controller.signal}).then(rows=>{if(!controller.signal.aborted)setRows(current=>[...current.filter(row=>changed.has(row.id)),...rows.filter(row=>!changed.has(row.id))])}).catch(cause=>{if(!controller.signal.aborted)setError(failure(cause))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    if(kind==='scenario') Promise.all([api<Doctor[]>('/catalog/doctor',{signal:controller.signal}),api<Rubric[]>('/catalog/rubric',{signal:controller.signal}),api<Content[]>('/catalog/content',{signal:controller.signal}),api<Policy[]>('/catalog/policy',{signal:controller.signal}),api<ManagedDrug[]>('/catalog/drug',{signal:controller.signal}),api<TrainingCase[]>('/cases',{signal:controller.signal})]).then(([doctors,rubrics,contents,policies,drugs,cases])=>{setBindings({doctors,rubrics,contents,policies,drugs,cases});setBindingsLoaded(true)}).catch(cause=>{if(!controller.signal.aborted)setError(failure(cause))})
    const linkedDoctor=new URLSearchParams(location.hash.split('?')[1]).get('doctor')
    if(kind==='doctor'&&linkedDoctor) api<CatalogRecord>(`/catalog/doctor/${encodeURIComponent(linkedDoctor)}`,{signal:controller.signal}).then(row=>{if(!controller.signal.aborted){setItem(row);setSelection(row.id)}}).catch(cause=>{if(!controller.signal.aborted)setError(failure(cause))})
    return()=>{controller.abort();detailRequest.current?.abort()}
  },[kind,refresh])
  async function select(id:string) {
    detailRequest.current?.abort();const controller=new AbortController();detailRequest.current=controller
    setSelection(id);setItem(undefined);setDoctorDraft(undefined);setPreview(undefined);setError('');setNotice('')
    try{
      const row=await api<CatalogRecord>(`/catalog/${kind}/${id}`,{signal:controller.signal})
      if(!controller.signal.aborted){listChanges.current.add(row.id);setItem(row);setRows(rows=>[row,...rows.filter(item=>item.id!==row.id)])}
    }catch(cause){if(!controller.signal.aborted)setError(failure(cause))}
  }
  async function mutate(path:string,body?:object,method='POST') {
    setBusy(true);setError('');setNotice('')
    try{
      const next=await api<CatalogRecord>(path,{method,...(body?{body:JSON.stringify(body)}:{})})
      listChanges.current.add(next.id);if(item && item.id!==next.id && path.endsWith('/publish'))listChanges.current.add(item.id);setLoading(false)
      setItem(next);setSelection(next.id);setReason('');setPreview(undefined);setRows(rows=>[next,...rows.filter(row=>row.id!==next.id && !(item && item.id!==next.id && path.endsWith('/publish') && row.id===item.id))])
      if(kind==='doctor'){setDoctorDraft(undefined);setNotice(doctorDraft&&next.status==='draft'?'医生草稿已保存，核对后发布即可用于自由练习。':'医生资料已保存。')}
    }catch(cause){setError(failure(cause))}finally{setBusy(false)}
  }
  function save(body:object){void mutate(`/catalog/${kind}${item?`/${item.id}`:''}`,item?{...body,version:item.version}:body,item?'PUT':'POST')}
  async function deleteDoctor(){
    if(!item||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      await api(`/catalog/doctor/${item.id}?version=${item.version}`,{method:'DELETE'})
      listChanges.current.add(item.id)
      setRows(rows=>rows.filter(row=>row.id!==item.id));setItem(undefined);setSelection(undefined);setDeleteOpen(false);setNotice('医生角色已删除。')
    }catch(cause){setError(failure(cause))}finally{setBusy(false)}
  }
  function transition(action:string){if(item)void mutate(`/catalog/content/${item.id}/review`,{version:item.version,action,reason})}
  async function showPreview(){if(!item)return;setBusy(true);setError('');try{setPreview(await api<TrainingSnapshot>(`/scenarios/${item.id}/preview`))}catch(cause){setError(failure(cause))}finally{setBusy(false)}}
  const disabled=Boolean(item && !['draft',...(kind==='content'?['rejected']:[])].includes(item.status))
  const researchJobId=kind==='doctor'?(doctorDraft?.id??(item as Doctor|undefined)?.research_job_id):undefined
  const missingPreparation=[
    {label:'训练资料',tab:'content',ready:bindings.contents.some(row=>row.status==='approved'&&row.usable!==false)},
    {label:'医生角色',tab:'doctor',ready:bindings.doctors.some(row=>row.status==='published')},
    {label:'评分标准',tab:'rubric',ready:bindings.rubrics.some(row=>row.status==='published')},
  ].filter(step=>!step.ready)
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{kindLabels[kind]}</h2><p className="mt-1 text-sm text-muted-foreground">{loading?'读取中':`${rows.length} 项`}</p></div><Button variant={kind==='scenario'?'outline':'default'} disabled={busy} onClick={()=>{detailRequest.current?.abort();setItem(undefined);setDoctorDraft(undefined);setSelection(null);setError('');setNotice('')}}>{kind==='scenario'?'手动创建场景':`添加${kindLabels[kind]}`}</Button></div>
    {kind==='doctor'&&selection===undefined&&<DoctorGenerator onOpen={id=>void select(id)} onGenerated={(id,fields)=>{detailRequest.current?.abort();setDoctorDraft({id,fields});setItem(undefined);setSelection(null);setError('');setNotice('请核对公开事实与来源，并调整训练设定；保存草稿后再发布。')}}/>}
    {kind==='scenario'&&bindingsLoaded&&missingPreparation.length>0&&<section className="space-y-2 border-l-2 pl-4 text-sm" aria-label="场景准备提示"><p className="font-medium">生成场景前，还需要准备</p><div className="flex flex-wrap gap-4">{missingPreparation.map(step=><a className="inline-flex min-h-11 items-center underline underline-offset-4" href={`#workspace?tab=${step.tab}`} key={step.tab}>{step.label}<span aria-hidden="true" className="ml-1">→</span></a>)}</div></section>}
    {kind==='scenario'&&<ScenarioGenerator {...bindings} onGenerated={scene=>{listChanges.current.add(scene.id);setLoading(false);setItem(scene);setSelection(scene.id);setRows(rows=>[scene,...rows.filter(row=>row.id!==scene.id)]);setPreview(undefined);setNotice('已生成草稿，请核对背景、异议、完成标准和引用，再发布。')}}/>}
    {kind==='doctor'&&item?.status==='published'&&<section className="space-y-2 rounded-lg border p-4 text-sm" aria-label="医生发布后续步骤"><p>已可在用户端搭配已发布药品进行自由练习。评分练习需创建并发布场景。</p><a href="#workspace?tab=scenario" className="inline-flex min-h-11 items-center underline">创建评分场景</a></section>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
    {error&&!deleteOpen&&<Alert variant="destructive" role="alert"><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><p>{error}</p><Button variant="ghost" size="sm" onClick={()=>{setLoading(true);setError('');setItem(undefined);setSelection(undefined);setRefresh(v=>v+1)}}>刷新数据</Button></AlertDescription></Alert>}
    {/* 240px doctor list (280px otherwise) + 24px gutter + editor = full canvas width. */}
    <div className={`grid items-start gap-6 ${kind==='doctor'?'lg:grid-cols-[240px_minmax(0,1fr)]':'lg:grid-cols-[280px_minmax(0,1fr)]'}`}>
      <Card aria-label={`${kindLabels[kind]}列表`} className={`gap-0 overflow-hidden py-0 ${kind==='doctor'?'lg:sticky lg:top-6':''} ${selection!==undefined?'hidden lg:block':''}`}>
        <CardHeader className="border-b px-4 py-4"><CardTitle className="text-sm">{kindLabels[kind]}列表</CardTitle></CardHeader>
        <CardContent className="p-0">{loading?<LoadingBlock className="p-5" label="正在加载…" />:rows.length===0?<p className="p-5 text-sm leading-6 text-muted-foreground">暂无{kindLabels[kind]}</p>:<ul className="max-h-[65vh] overflow-auto">{rows.map(row=><li key={row.id} className="border-b last:border-0"><Button variant="ghost" disabled={busy} aria-current={selection===row.id?'true':undefined} className={`h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal rounded-none px-4 py-4 text-left ${selection===row.id?'bg-muted':''}`} onClick={()=>void select(row.id)}><span className="block break-words text-sm font-medium">{titleOf(row)}</span><span className="block text-xs leading-5 text-muted-foreground">{statusLabels[row.status]??row.status}{'version_label'in row?` · ${row.version_label}`:''}</span></Button></li>)}</ul>}</CardContent>
      </Card>
      <Card className={`min-w-0 gap-0 py-0 ${selection===undefined?'hidden lg:block':''}`}><CardContent className="p-5 sm:p-6">
        {selection===undefined?<div className="flex min-h-56 flex-col items-center justify-center gap-2 text-center"><h3 className="text-sm font-medium">请选择{kindLabels[kind]}</h3></div>:<>
          <Button className={`mb-4 ${kind==='doctor'?'':'lg:hidden'}`} variant="ghost" onClick={()=>{setSelection(undefined);setItem(undefined);setDoctorDraft(undefined)}}>返回列表</Button>
          {selection!==null&&!item?<p role="status" className="text-sm text-muted-foreground">正在读取详情…</p>:<>
            <div className={`mb-6 flex flex-wrap items-center justify-between gap-3 ${kind==='doctor'?'border-b pb-5':''}`}>
              <div className="space-y-1"><h3 className="text-base font-medium">{item?titleOf(item):`新建${kindLabels[kind]}`}</h3></div>
              {item&&<div className="flex items-center gap-3"><Badge variant="outline">{statusLabels[item.status]??item.status}</Badge>{kind==='doctor'&&item.status==='draft'&&<Button variant="outline" disabled={busy} onClick={()=>void mutate(`/catalog/${kind}/${item.id}/publish`,{version:item.version})}>发布医生</Button>}</div>}
            </div>
            {item&&<div className="mb-6 flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" disabled={busy} onClick={()=>void mutate(`/catalog/${kind}/${item.id}/revision`)}>创建新版本</Button>
              {kind!=='content'&&kind!=='doctor'&&item.status==='draft'&&<Button size="sm" disabled={busy} onClick={()=>void mutate(`/catalog/${kind}/${item.id}/publish`,{version:item.version})}>发布此版本</Button>}
              <p className="text-xs text-muted-foreground">更新于 {new Date(item.updated_at).toLocaleString('zh-CN',{hour12:false})}</p>
            </div>}
            {kind==='content'&&<ContentForm key={item?`${item.id}-${item.version}`:'new'} item={item as Content|undefined} busy={busy} disabled={disabled} save={save}/>}
            {kind==='doctor'&&item?.status==='draft'&&Boolean((item as Doctor).research_evidence_review_required)&&<p className="mb-4 rounded-lg border p-3 text-sm text-muted-foreground">公开事实已经修改，原检索记录仅作历史参考；发布前请重新核对事实与来源。</p>}
            {researchJobId&&<p className="mb-5 text-sm leading-7"><a href={`#workspace?tab=research&job=${encodeURIComponent(researchJobId)}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">查看本次检索原文与待核对项</a></p>}
            {kind==='doctor'&&<DoctorForm key={item?`${item.id}-${item.version}`:doctorDraft?.id??'new'} item={item as Doctor|undefined} initial={doctorDraft?.fields} busy={busy} disabled={disabled} save={save}/>}
            {kind==='doctor'&&item&&<section className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t pt-5">
              <h4 className="text-sm font-medium">删除医生角色</h4>
              <Dialog open={deleteOpen} onOpenChange={open=>{if(!busy){setDeleteOpen(open);setError('')}}}>
                <DialogTrigger asChild><Button variant="outline" className="text-destructive" disabled={busy}>删除角色</Button></DialogTrigger>
                <DialogContent showCloseButton={!busy}>
                  <DialogHeader><DialogTitle>删除医生角色？</DialogTitle><DialogDescription>将“{titleOf(item)}”从医生列表移除，历史演练记录保留。仍被训练场景使用的医生需先更换绑定。</DialogDescription></DialogHeader>
                  {error&&<p role="alert" className="text-destructive">{error}</p>}
                  <DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setDeleteOpen(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={()=>void deleteDoctor()}>{busy?'正在删除…':'确认删除'}</Button></DialogFooter>
                </DialogContent>
              </Dialog>
            </section>}
            {item&&<ContentHistory kind={kind} itemId={item.id}/>}
            {item&&['doctor','scenario','content'].includes(kind)&&['draft','submitted'].includes(item.status)&&<PublicationApproval kind={kind} item={item}/>}
            {kind==='rubric'&&<RubricForm key={item?`${item.id}-${item.version}`:'new'} item={item as Rubric|undefined} busy={busy} disabled={disabled} save={save}/>}
            {kind==='scenario'&&<ScenarioForm key={item?`${item.id}-${item.version}`:'new'} item={item as Scenario|undefined} busy={busy} disabled={disabled} save={save} {...bindings}/>}
            {kind==='scenario'&&(item as Scenario|undefined)?.generation&&<section className="mt-6 space-y-3 border-t pt-5"><h3 className="text-sm font-medium">生成依据</h3><p className="text-xs leading-6 text-muted-foreground tabular-nums">{(item as Scenario).generation!.model} · 生成耗时 {(item as Scenario).generation!.elapsed_seconds} 秒 · {(item as Scenario).generation!.usage.total_tokens??'未记录'} token · {costLabel((item as Scenario).generation!.cost?.totals??{})}</p><p className="text-xs leading-6 text-muted-foreground">AI 生成内容需核对后发布；引文匹配不等于整份情境已通过医学审核。</p>{(item as Scenario).generation!.citations.map((citation,index)=><blockquote className="rounded-lg bg-muted/30 p-3 text-sm leading-7" key={index}><p className="text-xs text-muted-foreground">{citation.title} · {citation.version_label} · 第 {citation.page} 页</p><p>{citation.quote}</p></blockquote>)}</section>}
            {kind==='scenario'&&item&&<div className="mt-6 space-y-4 border-t pt-5"><Button variant="outline" disabled={busy} onClick={()=>void showPreview()}>预览已保存配置</Button>{preview&&<div className="space-y-2 rounded-lg bg-muted/30 p-4 text-sm leading-7"><p className="font-medium">{preview.scenario.title} · {item.status==='draft'?'草稿预览':'已发布'}</p><p>{preview.scenario.product} · {preview.scenario.disease}</p><p>医生：{preview.doctor.display_name} · {preview.doctor.specialty}</p><p>目标：{preview.scenario.objective}</p><p>{preview.rubric.name} · {preview.documents.length} 份有效训练资料 · {preview.scenario.duration_seconds} 秒</p><p className="text-xs text-muted-foreground">仅预览已保存版本；发布后可演练。</p></div>}</div>}
            {kind==='rubric'&&item?.status==='published'&&<CalibrationPanel key={item.id} rubric={item as Rubric}/>}
            {kind==='content'&&item&&<section className="mt-8 space-y-4 border-t pt-6"><h3 className="text-sm font-medium">资料核对</h3><p className="text-xs leading-6 text-muted-foreground">自我核对不代表专业医学审核；正式使用前请由专业人员确认。</p>{'review_reason'in item&&<p className="text-sm leading-7 text-muted-foreground">最近意见：{String(item.review_reason)}</p>}
              <Label className="block space-y-2 text-sm font-normal leading-normal">核对说明<Textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000}/></Label><div className="flex flex-wrap gap-3">{['draft','rejected'].includes(item.status)&&<Button disabled={busy||!reason.trim()} onClick={()=>transition('submit')}>提交核对</Button>}{item.status==='submitted'&&<><Button disabled={busy||!reason.trim()} onClick={()=>transition('approve')}>确认核对</Button><Button variant="outline" disabled={busy||!reason.trim()} onClick={()=>transition('reject')}>返回修改</Button></>}{item.status==='approved'&&<Button variant="outline" disabled={busy||!reason.trim()} onClick={()=>transition('retire')}>停用此版本</Button>}</div>
            </section>}
          </>}
        </>}</CardContent>
      </Card>
    </div>
    {kind==='scenario'&&<ScenarioTransfer scenario={item as Scenario|undefined} onImported={scene=>{setItem(scene);setSelection(scene.id);setPreview(undefined);setRefresh(value=>value+1)}}/>}
    {kind==='content'&&<BulkImport onImported={()=>setRefresh(v=>v+1)}/>}
  </div>
}

export function PlatformPage() {
  const readTab=()=>{const value=new URLSearchParams(location.hash.split('?')[1]).get('tab');return ['scenario','doctor','content','rubric','cases','pricing','research'].includes(value??'')?value!:'scenario'}
  const [tab,setTab]=useState(readTab)
  useEffect(()=>{function change(){setTab(readTab())}window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change)},[])
  const groups=[{label:'训练内容',items:[['scenario','训练场景'],['cases','经验案例']]},{label:'内容准备',items:[['content','训练资料'],['doctor','医生角色'],['rubric','评分标准'],['research','资料检索']]},{label:'使用成本',items:[['pricing','用量计价']]}]
  return <div className="space-y-6"><PageHeader title="训练管理" actions={<Button asChild variant="outline"><a href="#admin">返回管理后台</a></Button>} />
    <div className="space-y-2 md:hidden"><Label htmlFor="workspace-section" className="block text-sm font-medium leading-normal">管理内容</Label><Select value={tab} onValueChange={value=>{window.location.hash=`workspace?tab=${value}`}}><SelectTrigger id="workspace-section" className="w-full"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start">{groups.map(group=><SelectGroup key={group.label}><SelectLabel>{group.label}</SelectLabel>{group.items.map(([key,label])=><SelectItem value={key} key={key}>{label}</SelectItem>)}</SelectGroup>)}</SelectContent></Select></div>
    <nav aria-label="训练管理导航" className="hidden flex-wrap gap-x-7 gap-y-4 border-b pb-4 md:flex">{groups.map(group=><div className="space-y-2" key={group.label}><p className="px-3 text-xs text-muted-foreground">{group.label}</p><div className="flex gap-1">{group.items.map(([key,label])=><Button key={key} variant={tab===key?'secondary':'ghost'} aria-current={tab===key?'page':undefined} onClick={()=>{window.location.hash=`workspace?tab=${key}`}}>{label}</Button>)}</div></div>)}</nav>
    {tab==='cases'?<CasesPage/>:tab==='pricing'?<PricingPanel/>:tab==='research'?<ResearchPanel/>:<CatalogPage key={tab} kind={tab as Kind}/>}</div>
}
