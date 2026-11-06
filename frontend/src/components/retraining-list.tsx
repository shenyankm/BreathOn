import { stages } from '@/lib/catalog-types'
import { api } from '@/lib/platform-api'
import { useEffect,useRef,useState } from 'react'
import type { StartTraining,TrainingChoice } from './scenario-picker'
import { Button } from './ui/button'

type Plan={id:string;status:string;focus_label:string;stage:string;note:string;parent_record_id:string}

export function RetrainingList({onStart,refresh=0,compact=false}:{onStart:StartTraining;refresh?:number;compact?:boolean}) {
  const [plans,setPlans]=useState<Plan[]>([])
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [retry,setRetry]=useState(0)
  const starting=useRef(false)
  useEffect(()=>{const c=new AbortController();api<Plan[]>('/remediations',{signal:c.signal}).then(rows=>{if(!c.signal.aborted){setPlans(rows.filter(p=>p.status==='assigned'));setError('')}}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'重练加载失败')});return()=>c.abort()},[refresh,retry])
  async function start(id:string){if(starting.current)return;starting.current=true;setBusy(true);setError('');try{onStart(await api<TrainingChoice>(`/remediations/${id}/next`))}catch(e){setError(e instanceof Error?e.message:'无法启动重练')}finally{starting.current=false;setBusy(false)}}
  if(!plans.length&&!error)return null
  return <section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">待重练{plans.length>0?` · ${plans.length} 项`:null}</h2>{compact&&plans.length>1&&<a className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href="#records">查看全部</a>}</div>{error&&<div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" disabled={busy} onClick={()=>setRetry(value=>value+1)}>重新读取重练任务</Button></div>}{(compact?plans.slice(0,1):plans).map(p=><article key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-3"><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{p.focus_label} · {stages[p.stage]??'完整拜访'}</h3><p className={`mt-2 break-words text-sm leading-6 text-muted-foreground ${compact?'line-clamp-1':''}`}>{p.note}</p><a className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`#records?session=${p.parent_record_id}`}>查看原记录与前后对比</a></div><Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void start(p.id)}>开始重练</Button></article>)}</section>
}
