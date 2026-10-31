import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

type State = { mode: string; ready: boolean; settings_version: number; votes: {actor:string;role:string;decision?:string;reason:string;at:string}[] }
export function PublicationApproval({kind,item}:{kind:string;item:{id:string;version:number}}) {
  const [state,setState]=useState<State>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[role,setRole]=useState('admin'),[refresh,setRefresh]=useState(0)
  useEffect(()=>{const c=new AbortController();api<State>(`/admin/catalog/${kind}/${item.id}/approval`,{signal:c.signal}).then(setState).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort()},[kind,item.id,item.version,refresh])
  async function approve(decision:'approve'|'reject'){setBusy(true);setError('');try{setState(await api<State>(`/admin/catalog/${kind}/${item.id}/approval`,{method:'POST',body:JSON.stringify({version:item.version,settings_version:state!.settings_version,role,reason,decision})}));setReason('')}catch(e){setError(e instanceof Error?e.message:'审核失败')}finally{setBusy(false)}}
  return <section className="my-5 space-y-3 rounded-xl border p-4"><h3 className="font-semibold">发布前审核</h3>{error&&<p role="alert" className="text-sm text-destructive">{error}<Button variant="ghost" onClick={()=>{setError('');setRefresh(v=>v+1)}}>刷新审核状态</Button></p>}{state?<><p className="text-sm">{state.mode==='admin'?'管理员审核':state.mode==='two_admins'?'两位不同管理员确认':'医学与合规分别确认，须由不同管理员完成'} · {state.ready?'已满足，可发布':'尚未满足发布条件'}</p>{state.votes.map(v=><p key={v.actor} className="text-sm text-muted-foreground">{v.actor} · {v.decision==='reject'?'退回修改':'已确认'} · {v.role==='medical'?'医学':v.role==='compliance'?'合规':'管理员'}：{v.reason}</p>)}<Label className="grid gap-2">审核职责<Select value={role} onValueChange={setRole}><SelectTrigger aria-label="审核职责"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="admin">管理员</SelectItem><SelectItem value="medical">医学审核</SelectItem><SelectItem value="compliance">合规审核</SelectItem></SelectContent></Select></Label><Label className="grid gap-2">审核意见<Textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000}/></Label><Button disabled={busy||!reason.trim()} onClick={()=>void approve('approve')}>{busy?'正在提交…':'确认本版本审核'}</Button><Button variant="outline" disabled={busy||!reason.trim()} onClick={()=>void approve('reject')}>退回修改</Button><p className="text-xs text-muted-foreground">内容或审核设置变更后，原审核不再用于新版本发布。</p></>:!error&&<p role="status">读取审核要求…</p>}</section>
}
