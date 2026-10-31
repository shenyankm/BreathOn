import { useState } from 'react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { api } from '@/lib/platform-api'
import { Label } from '@/components/ui/label'
const failure=(e:unknown)=>e instanceof Error?e.message:'操作未完成，请重试。'

export function BulkImport({onImported}:{onImported:()=>void}){const [error,setError]=useState('');const [note,setNote]=useState('');const [busy,setBusy]=useState(false)
  async function upload(file:File){setError('');setNote('');if(file.size>7_500_000){setError('JSON文件须小于7.5MB。');return}setBusy(true);try{const body=JSON.parse(await file.text());const result=await api<{document_ids:string[];reused:boolean}>('/content/import',{method:'POST',body:JSON.stringify(body)});setNote(`${result.reused?'已存在，复用原导入结果':'已导入'} ${result.document_ids.length} 份资料草稿；请逐项提交核对。`);onImported()}catch(e){setError(failure(e))}finally{setBusy(false)}}
  const template={documents:[{title:'填写资料标题',version_label:'v1',scope:'填写适用范围',source_url:'',pages:[{number:1,text:'填写原文，保留真实页码'}]}]}
  return <Accordion type="single" collapsible className="bg-card"><AccordionItem value="import"><AccordionTrigger className="min-h-11">批量导入本地资料</AccordionTrigger><AccordionContent className="space-y-4"><p className="text-sm leading-6 text-muted-foreground">最多 50 份 JSON 资料，校验后导入草稿。</p><Button asChild variant="outline"><a download="content-template.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(template,null,2))}`}>下载导入模板</a></Button><Label className="grid max-w-lg gap-2 text-sm font-medium leading-normal">选择 JSON 文件<Input className="font-normal" type="file" accept="application/json,.json" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value=''}}/></Label>{busy&&<p role="status" className="text-sm">正在校验与导入…</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{note&&<p role="status" className="text-sm">{note}</p>}</AccordionContent></AccordionItem></Accordion>
}
