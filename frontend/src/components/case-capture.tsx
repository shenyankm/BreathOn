import { useState, type FormEvent } from 'react'
import { Button } from './ui/button'
import { Field, inputClass } from './ui/form-field'
import { api } from '@/lib/platform-api'
import type { ReviewRecord } from './review-panel'

export function CaseCapture({record}:{record:ReviewRecord}) {
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [caseId,setCaseId]=useState('')
  const messages=record.messages.filter(message=>message.role==='trainee'&&message.final&&message.text.length<=4000)
  async function extract(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError('')
    try{const result=await api<{id:string}>(`/sessions/${record.id}/cases`,{method:'POST',body:JSON.stringify({message_id:new FormData(event.currentTarget).get('message_id')})});setCaseId(result.id)}
    catch(cause){setError(cause instanceof Error?cause.message:'未能提炼案例，请重试。')}
    finally{setBusy(false)}
  }
  if(!messages.length)return null
  return <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">沉淀为训练案例</summary><p className="mt-4 text-xs leading-6 text-muted-foreground">选择一条学员原话，保留医生问题与复盘建议；编辑并确认适用边界后，再用于其他训练。</p><form onSubmit={extract} className="mt-4 space-y-4"><Field label="案例对应的学员原话"><select name="message_id" required className={inputClass} disabled={busy}>{messages.map((message,index)=><option key={message.id} value={message.id}>{index+1}. {message.text.slice(0,60)}</option>)}</select></Field><Button type="submit" variant="outline" disabled={busy}>{busy?'正在提炼…':'提炼案例草稿'}</Button></form>{error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{caseId&&<p role="status" className="mt-4 text-sm leading-7">案例草稿已保存。<a className="underline underline-offset-4" href={`#workspace?tab=cases&case=${caseId}`}>编辑与确认案例</a></p>}</details>
}
