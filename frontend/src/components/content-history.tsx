import { useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'
import { statusLabels } from '@/lib/catalog-types'
export function ContentHistory({kind,itemId}:{kind:string;itemId:string}) {
 const [rows,setRows]=useState<{id:string;version:number;source_version?:number;status:string;updated_at:string;created_by:string}[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 async function load(){setBusy(true);setError('');try{setRows(await api(`/admin/catalog/${kind}/${encodeURIComponent(itemId)}/history`))}catch(e){setError(e instanceof Error?e.message:'读取失败')}finally{setBusy(false)}}
 return <section className="my-4 space-y-3"><Button variant="outline" disabled={busy} onClick={()=>void load()}>{busy?'正在读取…':'查看内容版本'}</Button>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{rows&&<ul className="space-y-2 text-sm">{rows.map((r,i)=><li key={`${r.id}-${i}`} className="rounded-lg border p-3">v{r.source_version||r.version} · {statusLabels[r.status]||r.status} · {new Date(r.updated_at).toLocaleString('zh-CN')} · {r.created_by}</li>)}</ul>}</section>
}
