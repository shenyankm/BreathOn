import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/platform-api'
import { Field, inputClass } from './ui/form-field'
import { stages, type Content, type Doctor, type Rubric, type Scenario, type Dimension } from '@/lib/catalog-types'


function text(data: FormData, name: string) { return String(data.get(name) ?? '') }
function Save({ busy }: { busy: boolean }) { return <Button className="h-11" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存草稿'}</Button> }
type Submit = { busy: boolean; disabled: boolean; save: (body: object) => void }

export function ContentForm({ item, busy, disabled, save }: Submit & { item?: Content }) {
  const [pages, setPages] = useState(item?.pages ?? [{ number: 1, text: '' }])
  const [assetId, setAssetId] = useState(item?.asset_id ?? null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  async function upload(file: File | undefined) {
    if (!file) return
    setUploadError('')
    if (file.size > 20_000_000) { setUploadError('PDF超过20MB上限。'); return }
    setUploading(true)
    try {
      const parsed = await api<{ pages: {number:number;text:string}[]; asset_id:string }>('/content/pdf', {method:'POST',headers:{'Content-Type':'application/pdf'},body:file})
      setPages(parsed.pages); setAssetId(parsed.asset_id)
    } catch (cause) { setUploadError(cause instanceof Error ? cause.message : 'PDF未能解析') }
    finally { setUploading(false) }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    save({ title: text(data,'title'), version_label: text(data,'version_label'), scope: text(data,'scope'), source_url: text(data,'source_url'),
      publication_date: text(data,'publication_date') || null, expires_at: text(data,'expires_at') ? new Date(text(data,'expires_at')).toISOString() : null, pages, asset_id:assetId })
  }
  const dateValue = item?.expires_at ? new Date(new Date(item.expires_at).getTime() - new Date(item.expires_at).getTimezoneOffset()*60000).toISOString().slice(0,16) : ''
  return <form onSubmit={submit}><fieldset disabled={disabled || busy || uploading} className="space-y-5">
    {!disabled && <label className="block space-y-2 text-sm font-medium">导入PDF原件<Input className="min-h-11 font-normal" type="file" accept="application/pdf,.pdf" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }}/><span className="block text-xs font-normal leading-6 text-muted-foreground">最多 20MB、200 页；导入后请核对页码与正文。</span></label>}
    {uploading && <p role="status" className="text-sm text-muted-foreground">正在安全解析PDF…</p>}
    {uploadError && <p role="alert" className="text-sm text-destructive">{uploadError}</p>}
    {item?.asset_id && <a className="inline-block text-sm underline underline-offset-4" href={`/api/catalog/content/${item.id}/file`}>下载此版本PDF原件</a>}
    <div className="grid gap-4 sm:grid-cols-2"><Field label="资料名称" name="title" value={item?.title} maxLength={180} /><Field label="资料版本" name="version_label" value={item?.version_label} maxLength={40} /></div>
    <Field label="适用范围" name="scope" value={item?.scope} />
    <Field label="原始来源链接（可选）" name="source_url" type="url" required={false} value={item?.source_url} maxLength={8192} />
    <div className="grid gap-4 sm:grid-cols-2"><Field label="发布日期（可选）" name="publication_date" type="date" required={false} value={item?.publication_date ?? ''} /><Field label="到期时间（本地时间，可选）" name="expires_at" type="datetime-local" required={false} value={dateValue} /></div>
    <section className="space-y-4"><h3 className="text-sm font-medium">可引用原文</h3><p className="text-xs leading-6 text-muted-foreground">保留原文页码和上下文；自我核对不等于医学审核。</p>
      {pages.map((page,index) => <div key={index} className="space-y-3 rounded-xl border p-4"><div className="flex items-end gap-3"><label className="block max-w-28 space-y-2 text-sm">原文页码<Input aria-label={`第${index+1}段原文页码`} className="min-h-11 font-normal" type="number" min={1} max={2000} required value={page.number} onChange={event => setPages(pages.map((p,i) => i===index ? { ...p, number: Number(event.target.value) } : p))} /></label>{pages.length > 1 && <Button type="button" variant="ghost" onClick={() => setPages(pages.filter((_,i) => i!==index))}>移除此页</Button>}</div><label className="block space-y-2 text-sm">原文正文<Textarea required maxLength={20000} className="min-h-40" value={page.text} onChange={event => setPages(pages.map((p,i) => i===index ? { ...p, text:event.target.value } : p))} /></label></div>)}
      {!disabled && <Button type="button" variant="outline" disabled={pages.length>=200} onClick={() => setPages([...pages,{ number:Math.max(...pages.map(p=>p.number))+1,text:'' }])}>添加下一页</Button>}
    </section>{!disabled && <Save busy={busy} />}
  </fieldset></form>
}

export function DoctorForm({ item, busy, disabled, save }: Submit & { item?: Doctor }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data=new FormData(event.currentTarget)
    save({...Object.fromEntries(['name','specialty','background_type','public_facts','population','focus','training_style','mood','opening'].map(key=>[key,text(data,key)])), sources:text(data,'sources').split('\n').map(s=>s.trim()).filter(Boolean)})
  }
  return <form aria-label="医生资料" onSubmit={submit}><fieldset disabled={disabled || busy} className="min-w-0 space-y-6 [&_label]:min-w-0 [&_textarea]:bg-background [&_textarea]:font-normal [&_textarea]:leading-6">
    <section aria-labelledby="doctor-basic" className="space-y-4">
      <h4 id="doctor-basic" className="text-sm font-semibold">基本信息</h4>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="医生姓名" name="name" value={item?.name} maxLength={60} />
        <Field label="专科" name="specialty" value={item?.specialty} maxLength={80} />
        <div className="min-w-0 sm:col-span-2 xl:col-span-1"><Field label="背景类型" htmlFor="doctor-background-type"><Select name="background_type" defaultValue={item?.background_type ?? 'fictional'} disabled={disabled || busy}><SelectTrigger id="doctor-background-type" className="min-h-11 w-full font-normal"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectItem value="fictional">虚构训练角色</SelectItem><SelectItem value="public">依据公开人物背景的训练模拟</SelectItem></SelectContent></Select></Field></div>
      </div>
    </section>
    <div className="grid gap-6 border-t pt-6 xl:grid-cols-2 xl:gap-8">
      <section aria-labelledby="doctor-training" className="min-w-0 space-y-4">
        <h4 id="doctor-training" className="text-sm font-semibold">训练设定</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="训练患者人群"><Textarea name="population" required maxLength={1000} defaultValue={item?.population} className="min-h-20" /></Field>
          <Field label="训练关注点"><Textarea name="focus" required maxLength={1000} defaultValue={item?.focus} className="min-h-20" /></Field>
          <Field label="训练交流方式"><Textarea name="training_style" required maxLength={1000} defaultValue={item?.training_style} className="min-h-20" /></Field>
          <Field label="医生互动状态" htmlFor="doctor-mood"><Select name="mood" defaultValue={item?.mood ?? 'neutral'} disabled={disabled || busy}><SelectTrigger id="doctor-mood" className="min-h-11 w-full font-normal"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectItem value="neutral">平和</SelectItem><SelectItem value="busy">时间紧张</SelectItem><SelectItem value="skeptical">对证据存疑</SelectItem><SelectItem value="friendly">愿意交流</SelectItem></SelectContent></Select></Field>
          <div className="sm:col-span-2"><Field label="开场白"><Textarea name="opening" required maxLength={400} defaultValue={item?.opening} className="min-h-24" /></Field></div>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">互动状态、关注点与交流方式均为训练设计，不能作为真实人物的性格、处方偏好或产品背书。</p>
      </section>
      <section aria-labelledby="doctor-background" className="min-w-0 space-y-4">
        <div className="space-y-1"><h4 id="doctor-background" className="text-sm font-semibold">背景与来源</h4><p className="text-xs leading-6 text-muted-foreground">公开人物需填写专业事实及来源，虚构角色可留空。</p></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <Field label="公开专业事实"><Textarea name="public_facts" defaultValue={item?.public_facts} maxLength={3000} className="min-h-28" /></Field>
          <Field label="事实来源链接（每行一条）"><Textarea name="sources" defaultValue={item?.sources.join('\n')} maxLength={65000} className="min-h-28" /></Field>
        </div>
      </section>
    </div>
    {!disabled && <div className="sticky bottom-0 z-10 -mx-5 flex flex-wrap items-center justify-between gap-3 border-t bg-background px-5 py-4 sm:-mx-6 sm:px-6"><p className="text-xs leading-6 text-muted-foreground">{item?'修改将覆盖当前医生资料。':'保存草稿后可发布医生。'}</p><Button className="h-11" type="submit" disabled={busy}>{busy?'正在保存…':item?'保存修改':'保存草稿'}</Button></div>}
  </fieldset></form>
}

const firstDimension: Dimension={ key:'accuracy',label:'医学准确性',weight:100,requires_content:true,anchors:['关键事实错误','主要事实不清','基本正确，局限不足','准确且说明局限','准确完整并明确适用边界'] }
export function RubricForm({ item,busy,disabled,save }: Submit & { item?: Rubric }) {
  const [dimensions,setDimensions]=useState<Dimension[]>(item?.dimensions ?? [{...firstDimension}])
  const total=dimensions.reduce((sum,d)=>sum+d.weight,0)
  function change(index:number, patch:Partial<Dimension>) { setDimensions(dimensions.map((d,i)=>i===index ? {...d,...patch}:d)) }
  function submit(event:FormEvent<HTMLFormElement>) { event.preventDefault();save({name:new FormData(event.currentTarget).get('name'),dimensions}) }
  return <form onSubmit={submit}><fieldset disabled={disabled || busy} className="space-y-5">
    <Field label="量表名称" name="name" value={item?.name} maxLength={100} />
    <p className="text-sm">权重合计：<span className="tabular-nums">{total}%</span>，应为 100%。</p>
    {dimensions.map((dimension,index)=><section key={index} className="space-y-4 rounded-xl border p-4"><div className="grid gap-3 sm:grid-cols-3"><Field label="维度标识"><Input className="min-h-11 font-normal" pattern="[a-z][a-z_]{1,40}" required value={dimension.key} onChange={e=>change(index,{key:e.target.value})}/></Field><Field label="维度名称"><Input className="min-h-11 font-normal" required maxLength={60} value={dimension.label} onChange={e=>change(index,{label:e.target.value})}/></Field><Field label="权重（%）"><Input type="number" className="min-h-11 font-normal" min={1} max={100} required value={dimension.weight} onChange={e=>change(index,{weight:Number(e.target.value)})}/></Field></div>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={dimension.requires_content} onChange={e=>change(index,{requires_content:e.target.checked})}/>该维度必须有有效训练资料才能评价</label>
      {dimension.anchors.map((anchor,i)=><Field key={i} label={`${i} 分锚点`}><Input className="min-h-11 font-normal" required maxLength={500} value={anchor} onChange={e=>change(index,{anchors:dimension.anchors.map((a,j)=>i===j?e.target.value:a)})}/></Field>)}
      {!disabled && dimensions.length>1 && <Button type="button" variant="ghost" onClick={()=>setDimensions(dimensions.filter((_,i)=>i!==index))}>移除维度</Button>}
    </section>)}
    {!disabled && <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={dimensions.length>=10} onClick={()=>setDimensions([...dimensions,{key:`skill_${dimensions.length}`,label:'',weight:1,requires_content:false,anchors:['','','','','']}])}>添加维度</Button><Button disabled={busy || total!==100} type="submit">{busy?'正在保存…':'保存草稿'}</Button></div>}
    <p className="text-xs leading-6 text-muted-foreground">发布不代表专家校准；未校准量表不可视为已验证标准。</p>
  </fieldset></form>
}

export function ScenarioForm({ item,busy,disabled,save,doctors,rubrics,contents }: Submit & {item?:Scenario;doctors:Doctor[];rubrics:Rubric[];contents:Content[]}) {
  const [selectedStages,setStages]=useState(item?.stages ?? Object.keys(stages))
  const [selectedContent,setContent]=useState(item?.content_ids ?? [])
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const data=new FormData(event.currentTarget)
    save({...Object.fromEntries(['title','product','disease','objective','doctor_id','rubric_id','difficulty','situation','background','opening'].map(key=>[key,text(data,key)])),objections:text(data,'objections').split('\n').map(value=>value.trim()).filter(Boolean),success_criteria:text(data,'success_criteria').split('\n').map(value=>value.trim()).filter(Boolean),duration_seconds:Number(data.get('duration_seconds')),stages:selectedStages,content_ids:selectedContent})
  }
  return <form onSubmit={submit}><fieldset disabled={disabled || busy} className="space-y-5">
    <Field label="场景名称" name="title" value={item?.title} maxLength={160}/>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="产品" name="product" value={item?.product} maxLength={120}/><Field label="疾病／治疗领域" name="disease" value={item?.disease} maxLength={120}/></div>
    <Field label="训练目标"><Textarea name="objective" required maxLength={1500} defaultValue={item?.objective} /></Field>
    <Field label="模拟拜访背景"><Textarea name="background" maxLength={2000} defaultValue={item?.background}/></Field>
    <Field label="情境类型"><select name="situation" className={inputClass} defaultValue={item?.situation??'first_visit'}><option value="first_visit">首次拜访</option><option value="time_pressure">时间紧张</option><option value="evidence_challenge">证据质疑</option></select></Field>
    <Field label="医生开场白" name="opening" value={item?.opening} required={false} maxLength={400}/>
    <Field label="核心异议与追问（每行一项）"><Textarea name="objections" defaultValue={item?.objections?.join('\n')} maxLength={4007}/></Field>
    <Field label="可观察的完成标准（每行一项）"><Textarea name="success_criteria" defaultValue={item?.success_criteria?.join('\n')} maxLength={4007}/></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="医生角色" htmlFor="scenario-doctor"><Select name="doctor_id" required defaultValue={item?.doctor_id} disabled={disabled || busy}><SelectTrigger id="scenario-doctor" className="min-h-11 w-full font-normal"><SelectValue placeholder="选择医生角色" /></SelectTrigger><SelectContent position="popper" align="start">{doctors.map(d=><SelectItem key={d.id} value={d.id}>{d.display_name} · {d.status==='published'?'已发布':'草稿'}</SelectItem>)}</SelectContent></Select></Field><Field label="评价量表" htmlFor="scenario-rubric"><Select name="rubric_id" required defaultValue={item?.rubric_id} disabled={disabled || busy}><SelectTrigger id="scenario-rubric" className="min-h-11 w-full font-normal"><SelectValue placeholder="选择量表版本" /></SelectTrigger><SelectContent position="popper" align="start">{rubrics.map(r=><SelectItem key={r.id} value={r.id}>{r.name} · {r.status==='published'?'已发布':'草稿'}</SelectItem>)}</SelectContent></Select></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="建议时长（秒）"><Input type="number" name="duration_seconds" min={30} max={600} required defaultValue={item?.duration_seconds??300} className="min-h-11 font-normal"/></Field><Field label="难度" htmlFor="scenario-difficulty"><Select name="difficulty" defaultValue={item?.difficulty??'basic'} disabled={disabled || busy}><SelectTrigger id="scenario-difficulty" className="min-h-11 w-full font-normal"><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectItem value="basic">基础</SelectItem><SelectItem value="intermediate">中等</SelectItem><SelectItem value="advanced">进阶</SelectItem></SelectContent></Select></Field></div>
    <section className="space-y-3"><h3 className="text-sm font-medium">包含的训练环节</h3><div className="grid gap-2 sm:grid-cols-2">{Object.entries(stages).map(([key,label])=><label key={key} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={selectedStages.includes(key)} onChange={e=>setStages(e.target.checked?[...selectedStages,key]:selectedStages.filter(s=>s!==key))}/>{label}</label>)}</div></section>
    <section className="space-y-3"><h3 className="text-sm font-medium">绑定资料版本</h3>{contents.length?contents.map(c=><label key={c.id} className="flex min-h-11 items-start gap-2 py-2 text-sm"><input type="checkbox" className="mt-1" checked={selectedContent.includes(c.id)} onChange={e=>setContent(e.target.checked?[...selectedContent,c.id]:selectedContent.filter(id=>id!==c.id))}/><span>{c.title} · {c.version_label}<span className="block text-xs leading-6 text-muted-foreground">{c.status==='approved'?'已核对':c.status==='submitted'?'待核对':'尚未核对或已停用'}</span></span></label>):<p className="text-sm leading-6 text-muted-foreground">暂无资料。可先保存沟通训练场景；没有有效训练资料时，医学准确性不得作为已核实结论。</p>}</section>
    {!disabled && <Button type="submit" disabled={busy || !selectedStages.length}>{busy?'正在保存…':'保存草稿'}</Button>}
  </fieldset></form>
}
