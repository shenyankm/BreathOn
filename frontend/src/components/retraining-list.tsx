import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { api } from '@/lib/platform-api'
import { stages } from '@/lib/catalog-types'
import type { StartTraining, TrainingChoice } from './scenario-picker'

type Plan={id:string;status:string;focus_label:string;stage:string;note:string;parent_record_id:string}

export function RetrainingList({onStart,refresh=0}:{onStart:StartTraining;refresh?:number}) {
  const [plans,setPlans]=useState<Plan[]>([])
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  useEffect(()=>{const c=new AbortController();api<Plan[]>('/remediations',{signal:c.signal}).then(rows=>{setPlans(rows.filter(p=>p.status==='assigned'));setError('')}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'重练加载失败')});return()=>c.abort()},[refresh])
  async function start(id:string){setBusy(true);setError('');try{onStart(await api<TrainingChoice>(`/remediations/${id}/next`))}catch(e){setError(e instanceof Error?e.message:'无法启动重练')}finally{setBusy(false)}}
  if(!plans.length&&!error)return null
  return <section className="space-y-4"><h2 className="font-medium">待重练</h2>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{plans.map(p=><article key={p.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-background p-5"><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{p.focus_label} · {stages[p.stage]??'完整拜访'}</h3><p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{p.note}</p><a className="mt-2 inline-block text-xs underline underline-offset-4" href={`#records?session=${p.parent_record_id}`}>原记录与前后对比</a></div><Button variant="outline" disabled={busy} onClick={()=>void start(p.id)}>开始重练</Button></article>)}</section>
}
