import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Field, inputClass } from '@/components/ui/form-field'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/platform-api'
import type { TrainingCase } from '@/lib/catalog-types'

export function CasesPage() {
  const [rows,setRows]=useState<TrainingCase[]|null>(null)
  const [selected,setSelected]=useState<string|null>(()=>new URLSearchParams(location.hash.split('?')[1]).get('case'))
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const [dirty,setDirty]=useState(false)
  const [refresh,setRefresh]=useState(0)
  const listChanges=useRef(new Set<string>())
  useEffect(()=>{
    const controller=new AbortController();const changed=new Set<string>();listChanges.current=changed
    api<TrainingCase[]>('/cases',{signal:controller.signal}).then(rows=>{if(!controller.signal.aborted)setRows(current=>[...(current??[]).filter(row=>changed.has(row.id)),...rows.filter(row=>!changed.has(row.id))])}).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'案例加载失败')})
    return()=>controller.abort()
  },[refresh])
  useEffect(()=>{function change(){setSelected(new URLSearchParams(location.hash.split('?')[1]).get('case'));setDirty(false)}window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change)},[])
  const item=rows?.find(row=>row.id===selected)
  async function mutate(path:string,body:object,method='POST') {
    setBusy(true);setError('');setNotice('')
    try {
      const next=await api<TrainingCase>(path,{method,body:JSON.stringify(body)})
      listChanges.current.add(next.id)
      setRows(rows=>[next,...(rows??[]).filter(row=>row.id!==next.id)]);setSelected(next.id);setDirty(false)
      setNotice(next.status==='confirmed'?'案例已确认，可作为沟通参考复用。':'已保存为待核对案例，请确认适用边界后再复用。')
    }catch(cause){setError(cause instanceof Error?cause.message:'案例操作未完成')}
    finally{setBusy(false)}
  }
  function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!item)return
    const data=new FormData(event.currentTarget)
    void mutate(`/cases/${item.id}`,{...Object.fromEntries(['title','situation','approach','rationale','limitations'].map(key=>[key,String(data.get(key)??'')])),version:item.version},'PUT')
  }
  async function importFile(file:File|undefined) {
    if(!file)return
    try{if(file.size>100000)throw new Error('案例文件须小于100KB。');await mutate('/cases/import',JSON.parse(await file.text()))}
    catch(cause){setError(cause instanceof Error?cause.message:'无法解析案例文件')}
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-medium">经验案例</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">案例仅作沟通参考，不作为独立医学证据。</p></div><Button variant="outline" disabled={busy} onClick={()=>{setError('');setRefresh(value=>value+1)}}>刷新案例</Button></div>
    <label className="grid max-w-lg gap-2 text-sm font-medium">导入分享的 JSON 案例<input type="file" accept="application/json,.json" className={inputClass} disabled={busy} onChange={event=>{void importFile(event.target.files?.[0]);event.target.value=''}}/><span className="text-xs font-normal leading-6 text-muted-foreground">导入后为待核对草稿，原话与来源未核实。</span></label>
    {notice&&<p role="status" className="text-sm leading-7">{notice}</p>}{error&&<p role="alert" className="text-sm leading-7 text-destructive">{error}</p>}
    <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <section aria-label="经验案例列表" className={`rounded-xl border bg-background ${selected?'hidden lg:block':''}`}>
        {rows===null?<p role="status" className="p-5 text-sm">正在加载案例…</p>:rows.length===0?<div className="space-y-3 p-5 text-sm leading-7"><p>暂无经验案例。在演练记录中选择一条学员原话，即可开始提炼。</p><a href="#records" className="underline underline-offset-4">查看演练记录</a></div>:<ul>{rows.map(row=><li key={row.id} className="border-b last:border-0"><button className={`min-h-11 w-full p-4 text-left text-sm leading-7 ${selected===row.id?'bg-muted':'hover:bg-muted/40'}`} disabled={busy} onClick={()=>{setSelected(row.id);setDirty(false);setError('')}}><span className="block break-words font-medium">{row.title}</span><span className="text-xs text-foreground/70">{row.status==='confirmed'?'已确认':'待核对'} · {row.origin_verified?'本机原记录':'外来素材'}</span></button></li>)}</ul>}
      </section>
      <section className={`min-w-0 space-y-5 rounded-xl border bg-background p-5 sm:p-6 ${selected?'':'hidden lg:block'}`}>
        {!selected?<p className="text-sm leading-7 text-muted-foreground">选择案例查看详情</p>:!item?<div className="space-y-3 text-sm"><p>{rows===null?'正在读取案例…':'此案例不存在，请返回列表重新选择。'}</p><Button variant="outline" onClick={()=>setSelected(null)}>返回列表</Button></div>:<>
          <Button className="lg:hidden" variant="ghost" onClick={()=>setSelected(null)}>返回列表</Button>
          <div className="space-y-2"><h3 className="font-medium">{item.title}</h3><p className="text-xs leading-6 text-muted-foreground">{item.origin_verified?'保留本机演练的原话；参考表达尚不证明实际拜访有效。':'外来素材的原话和引用未在本机核实，只能作为沟通设计参考。'}</p></div>
          {item.quotes.map((quote,index)=><blockquote key={index} className="rounded-lg bg-muted/30 p-4 text-sm leading-7"><p className="text-xs text-muted-foreground">{quote.role==='trainee'?'学员原话':'医生问题'}</p><p className="whitespace-pre-wrap break-words">{quote.text}</p></blockquote>)}
          <form key={`${item.id}-${item.version}`} onSubmit={save} onChange={()=>setDirty(true)}><fieldset disabled={busy} className="space-y-5"><Field label="案例名称" name="title" value={item.title} maxLength={160}/>{([['situation','适用情境'],['approach','回应方式'],['rationale','处理理由'],['limitations','适用边界']] as const).map(([key,label])=><Field label={label} key={key}><Textarea name={key} required maxLength={2000} defaultValue={item[key]}/></Field>)}<Button type="submit" disabled={busy}>{busy?'正在保存…':'保存待核对案例'}</Button></fieldset></form>
          <div className="flex flex-wrap items-center gap-3 border-t pt-5">{item.status==='draft'&&<Button variant="outline" disabled={busy||dirty} onClick={()=>void mutate(`/cases/${item.id}/confirm`,{version:item.version})}>确认适用边界</Button>}{item.status==='confirmed'&&!busy&&!dirty&&<Button asChild variant="outline"><a href={`#workspace?tab=scenario&case=${item.id}`}>用此案例生成场景</a></Button>}<a className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/api/cases/${item.id}/export`}>导出 JSON</a><a className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/api/cases/${item.id}/export?format=markdown`}>导出 Markdown</a></div>
          {dirty&&<p className="text-xs leading-6 text-muted-foreground">请先保存修改，再确认案例；已确认案例修改后也需重新确认。</p>}
        </>}
      </section>
    </div>
  </div>
}
