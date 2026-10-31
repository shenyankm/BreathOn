import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'
type Metrics={sessions:number;participants:number;scored_sessions:number;average_score:number|null;dimensions:{key:string;label:string;average:number;count:number}[];scope:string;updated_at:string}
export function AudienceMetrics(){
 const [data,setData]=useState<Metrics>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0)
 useEffect(()=>{const c=new AbortController();api<Metrics>('/admin/audience-metrics',{signal:c.signal}).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort()},[refresh])
 return <section className="admin-panel space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">代表训练观察指标</h2><Button variant="outline" onClick={()=>{setError('');setData(undefined);setRefresh(v=>v+1)}}>刷新指标</Button></div>{error?<p role="alert" className="text-sm text-destructive">{error}</p>:data?<><div className="admin-metrics">{[['有记录的账号',data.participants],['保存的演练',data.sessions],['有效评分样本',data.scored_sessions],['平均训练分',data.average_score??'暂无评分']].map(([label,value])=><div className="rounded-xl bg-muted/50 p-4" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold">{value}</p></div>)}</div>{data.dimensions.map(d=><p className="text-sm" key={d.key}>{d.label}：{d.average} / 4 · {d.count} 个有效样本</p>)}<p className="text-xs leading-6 text-muted-foreground">{data.scope}。这些为工作区汇总，不将自定义画像当作个人分组，也不把训练分数解释为医生能力或健康效果。</p></>:<p role="status">正在读取指标…</p>}</section>
}
