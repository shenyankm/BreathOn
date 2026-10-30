import { useState } from 'react'
import { inputClass } from './ui/form-field'
import { api } from '@/lib/platform-api'
const failure=(e:unknown)=>e instanceof Error?e.message:'操作未完成，请重试。'

export function BulkImport({onImported}:{onImported:()=>void}){const [error,setError]=useState('');const [note,setNote]=useState('');const [busy,setBusy]=useState(false)
  async function upload(file:File){setError('');setNote('');if(file.size>7_500_000){setError('JSON文件须小于7.5MB。');return}setBusy(true);try{const body=JSON.parse(await file.text());const result=await api<{document_ids:string[];reused:boolean}>('/content/import',{method:'POST',body:JSON.stringify(body)});setNote(`${result.reused?'已存在，复用原导入结果':'已导入'} ${result.document_ids.length} 份资料草稿；请逐项提交核对。`);onImported()}catch(e){setError(failure(e))}finally{setBusy(false)}}
  const template={documents:[{title:'填写资料标题',version_label:'v1',scope:'填写适用范围',source_url:'',pages:[{number:1,text:'填写原文，保留真实页码'}]}]}
  return <details className="rounded-xl border bg-background p-5"><summary className="cursor-pointer text-sm font-medium">批量导入本地资料</summary><div className="mt-4 space-y-4"><p className="text-xs leading-6 text-muted-foreground">上传最多50份资料的 JSON；全部校验通过后一次写入草稿，重复文件不会重复导入。新版本可附 previous_id 指向已有资料。</p><a className="inline-block text-sm underline underline-offset-4" download="content-template.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(template,null,2))}`}>下载导入模板</a><label className="block space-y-2 text-sm">选择 JSON 文件<input className={inputClass} type="file" accept="application/json,.json" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value=''}}/></label>{busy&&<p role="status" className="text-sm">正在校验与导入…</p>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{note&&<p role="status" className="text-sm">{note}</p>}</div></details>
}
