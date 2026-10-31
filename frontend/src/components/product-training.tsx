import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'
export function ProductTraining({id,published}:{id:string;published:boolean}){
 const [rows,setRows]=useState<{id:string;title:string;doctor_id:string}[]>(),[error,setError]=useState('')
 useEffect(()=>{const c=new AbortController();api<{id:string;title:string;doctor_id:string;drug_id:string;status:string}[]>('/catalog/scenario',{signal:c.signal}).then(items=>setRows(items.filter(item=>item.drug_id===id&&item.status==='published'))).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort()},[id])
 return <section className="my-5 space-y-3 border-t pt-5"><h3 className="font-semibold">关联训练与医生</h3>{error?<p role="alert" className="text-sm text-destructive">{error}</p>:!rows?<p role="status">正在读取关联…</p>:rows.length?rows.map(row=><div key={row.id} className="text-sm"><p>{row.title}</p><a className="inline-flex min-h-11 items-center underline" href={`#workspace?tab=doctor&doctor=${encodeURIComponent(row.doctor_id)}`}>查看此场景的医生</a></div>):<p className="text-sm text-muted-foreground">暂无绑定此药品的已发布场景。</p>}{published?<Button asChild><a href={`#workspace?tab=scenario&drug=${encodeURIComponent(id)}`}>用此药品生成训练</a></Button>:<p className="text-sm text-muted-foreground">药品发布后可生成训练。</p>}</section>
}
