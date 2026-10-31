import { useState } from 'react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { api } from '@/lib/platform-api'
import type { Scenario } from '@/lib/catalog-types'
import { Label } from '@/components/ui/label'

export function ScenarioTransfer({scenario,onImported}:{scenario?:Scenario;onImported:(scene:Scenario)=>void}) {
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  async function download() {
    if(!scenario)return
    setBusy(true);setError('');setNotice('')
    try{const packageData=await api(`/scenarios/${scenario.id}/export`);const url=URL.createObjectURL(new Blob([JSON.stringify(packageData,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`training-${scenario.id}.json`;link.click();URL.revokeObjectURL(url);setNotice('已导出场景、医生、量表和资料文本；接收方导入后仍需核对并发布。')}
    catch(cause){setError(cause instanceof Error?cause.message:'场景导出未完成')}
    finally{setBusy(false)}
  }
  async function upload(file:File|undefined) {
    if(!file)return
    setBusy(true);setError('');setNotice('')
    try{if(file.size>7_500_000)throw new Error('场景模板须小于7.5MB。');const result=await api<{scenario_id:string;reused:boolean}>('/scenarios/import',{method:'POST',body:await file.text()});const next=await api<Scenario>(`/catalog/scenario/${result.scenario_id}`);onImported(next);setNotice(result.reused?'该模板已导入，已打开原配置。':'已导入为草稿。请分别核对资料、医生和量表，再发布场景；外部审核状态不会继承。')}
    catch(cause){setError(cause instanceof Error?cause.message:'场景导入未完成')}
    finally{setBusy(false)}
  }
  return <Accordion type="single" collapsible className="bg-card"><AccordionItem value="transfer"><AccordionTrigger className="min-h-11">分享或导入训练场景</AccordionTrigger><AccordionContent className="space-y-4"><p className="text-sm leading-7 text-muted-foreground">导入内容均为草稿，需重新审核和校准。</p>{scenario?<Button variant="outline" disabled={busy} onClick={()=>void download()}>{busy?'正在处理…':`导出当前场景模板`}</Button>:<p className="text-xs text-muted-foreground">先在列表选择一个场景，再导出模板。</p>}<Label className="grid max-w-lg gap-2 text-sm font-medium leading-normal">导入训练场景模板<Input className="font-normal" type="file" accept="application/json,.json" disabled={busy} onChange={event=>{void upload(event.target.files?.[0]);event.target.value=''}}/></Label>{notice&&<p role="status" className="text-sm leading-7">{notice}</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</AccordionContent></AccordionItem></Accordion>
}
