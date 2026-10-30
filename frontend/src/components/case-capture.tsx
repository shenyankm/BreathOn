import { useState, type FormEvent } from 'react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Field } from './ui/form-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
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
  return <Accordion type="single" collapsible className="bg-card [&_[data-slot=accordion-content][data-state=closed]]:hidden"><AccordionItem value="capture"><AccordionTrigger className="min-h-11">沉淀为训练案例</AccordionTrigger><AccordionContent forceMount><form onSubmit={extract} className="mt-4 space-y-4"><Field label="案例对应的学员原话" htmlFor={`case-message-${record.id}`}><Select key={record.id} name="message_id" defaultValue={messages[0].id} required disabled={busy}><SelectTrigger id={`case-message-${record.id}`} className="min-h-11 w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">{messages.map((message,index)=><SelectItem key={message.id} value={message.id} className="min-h-11">{index+1}. {message.text.slice(0,60)}</SelectItem>)}</SelectContent></Select></Field><Button type="submit" variant="outline" className="h-11" disabled={busy}>{busy?'正在提炼…':'提炼案例草稿'}</Button></form>{error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{caseId&&<p role="status" className="mt-4 text-sm leading-7">案例草稿已保存。<a className="underline underline-offset-4" href={`#workspace?tab=cases&case=${caseId}`}>编辑与确认案例</a></p>}</AccordionContent></AccordionItem></Accordion>
}
