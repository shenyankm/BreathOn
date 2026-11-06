import { Card,CardContent } from '@/components/ui/card'
import { stages } from '@/lib/catalog-types'
import { api } from '@/lib/platform-api'
import type { ProgressData } from '@/lib/progress'
import { useEffect,useState } from 'react'
import { Accordion,AccordionContent,AccordionItem,AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'

export function TrainingProgress({refresh}:{refresh:number}) {
  const [days,setDays]=useState(30)
  const [report,setReport]=useState<ProgressData|null>(null)
  const [settled,setSettled]=useState('')
  const [error,setError]=useState('')
  const [retry,setRetry]=useState(0)
  const requestKey=`${days}:${refresh}:${retry}`
  const loading=settled!==requestKey
  useEffect(()=>{const controller=new AbortController();api<ProgressData>(`/progress?days=${days}`,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted){setReport(data);setError('')}}).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'训练进步加载失败')}).finally(()=>{if(!controller.signal.aborted)setSettled(requestKey)});return()=>controller.abort()},[days,refresh,retry,requestKey])
  return <Card role="region" className="space-y-4" aria-label="个人训练进步"><CardContent className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">个人训练进步</h2><div className="flex gap-1" aria-label="统计时间范围">{[7,30,90].map(value=><Button key={value} variant={days===value?'secondary':'ghost'} aria-pressed={days===value} onClick={()=>setDays(value)}>{value} 天</Button>)}</div></div>
    {loading&&<p role="status" className="text-sm text-muted-foreground">正在读取近 {days} 天的训练记录…</p>}
    {error&&!loading&&<div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-destructive">{error}</p><Button variant="outline" disabled={loading} onClick={()=>setRetry(value=>value+1)}>重试统计</Button></div>}
    {report&&<>
      <p className="text-sm leading-6 text-muted-foreground">近 {report.days} 天 · 同条件训练反馈变化，不代表实际拜访能力认证；不同医生、资料、环节、模式或评分版本分开统计。</p>
      <dl className="grid grid-cols-2 gap-5 py-5 sm:grid-cols-4">{[['保存的演练',`${report.session_count} 次`],['完整结束',`${report.completed_count} 次`],['有效可评分训练',`${report.valid_practice_count} 次`],['已记录时长',report.unknown_duration_count===report.session_count&&report.session_count>0?'未记录':`${Math.floor(report.duration_seconds/60)} 分 ${Math.round(report.duration_seconds%60)} 秒`]].map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-2 text-lg tabular-nums">{value}</dd></div>)}</dl>
      <Accordion type="multiple" ><AccordionItem value="comparison"><AccordionTrigger className="min-h-11 px-0 py-4">同条件反馈对比 · {report.groups.length} 组</AccordionTrigger><AccordionContent className="space-y-5">{report.groups.length===0?<p className="text-sm leading-7 text-muted-foreground">暂无可评分训练。选择已发布场景完成演练后，再沿用相同条件重练。</p>:report.groups.map(group=><article key={group.latest_record_id} className="space-y-2 pb-4"><h3 className="text-sm font-medium">{group.scenario_title} · {stages[group.stage]??'完整拜访'}</h3><p className="text-sm leading-6 text-muted-foreground">{group.experience==='practice'?'练习':'实战'} · {group.attempts} 次 · {group.calibration_status==='calibrated'?'量表已校准':'量表未完成专家校准'}</p>{group.comparable?group.dimensions.map(dimension=><p className="text-sm tabular-nums" key={dimension.key}>{dimension.label}：{dimension.before??'未观察'} → {dimension.after??'未观察'}{dimension.delta!==null?`（${dimension.delta>0?'+':''}${dimension.delta}）`:''}</p>):<p className="text-sm text-muted-foreground">目前只有一次记录，尚不能判断变化。</p>}<a className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`#records?session=${group.latest_record_id}`}>查看最近一次原话与复盘</a></article>)}</AccordionContent></AccordionItem></Accordion>
    </>}
  </CardContent></Card>
}
