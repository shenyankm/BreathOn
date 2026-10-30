import { useEffect, useState } from 'react'
import { FileText, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ReviewPanel, type ReviewRecord } from '@/components/review-panel'
import { CoachAnalysis } from '@/components/coach-analysis'
import { MedicalCheckView } from '@/components/medical-check'
import type { MedicalCheck } from '@/lib/medical'
import type { LiveCoach } from '@/lib/voice-events'
import { RetrainingList } from '@/components/retraining-list'
import { TrainingProgress } from '@/components/training-progress'
import type { StartTraining } from '@/components/scenario-picker'

type Summary = { id: string; experience: string; mode: string; started_at: string; status: string; message_count: number; scenario_title?: string | null }
type Record = Summary & ReviewRecord & { doctor?: { display_name: string }; analysis_status?: string; coaching?: LiveCoach[]; medical_checks?: MedicalCheck[]; messages: { id: string; role: string; text: string; final: boolean }[] }
const statusLabels: { [key: string]: string } = { completed: '已完成', interrupted: '已中断', timeout: '已超时', error: '异常结束' }
const experienceLabel = (value: string) => value === 'practice' ? '练习模式' : '实战模式'
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function RecordsPage({onStart}:{onStart:StartTraining}) {
  const [records, setRecords] = useState<Summary[] | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [progressOpened, setProgressOpened] = useState(false)
  const [selected, setSelected] = useState<string | null>(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('session'))
  const [detail, setDetail] = useState<Record | null>(null)
  const [detailError, setDetailError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/sessions', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
      .then(response => { if (!response.ok) throw new Error(); return response.json() })
      .then(setRecords)
      .catch(() => { if (!controller.signal.aborted) setError('无法加载记录，请检查后端服务后重试。') })
    return () => controller.abort()
  }, [refresh])

  useEffect(()=>{function change(){setDetail(null);setDetailError('');setSelected(new URLSearchParams(window.location.hash.split('?')[1]).get('session'))}window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change)},[])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    fetch(`/api/sessions/${encodeURIComponent(selected)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
      .then(response => { if (!response.ok) throw new Error(); return response.json() })
      .then(setDetail)
      .catch(() => { if (!controller.signal.aborted) setDetailError('无法读取这条记录，请稍后重试。') })
    return () => controller.abort()
  }, [selected])

  return <div className="space-y-6">
    <div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">复盘记录</h1><p className="mt-2 text-sm leading-7 text-muted-foreground">最近 50 次演练</p></div><Button variant="outline" className="h-11 shrink-0" onClick={() => { setRecords(null); setError(''); setRefresh(value => value + 1) }}><RotateCcw />刷新</Button></div>
    <RetrainingList onStart={onStart} refresh={refresh}/>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : records === null ? <p role="status" className="py-12 text-sm text-muted-foreground">正在加载记录…</p> : records.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-4 py-16 text-center"><FileText className="size-7 text-muted-foreground" /><h2 className="font-medium">暂无演练记录</h2><Button asChild variant="outline"><a href="#start">开始演练</a></Button></CardContent></Card> : <div className="overflow-hidden rounded-2xl border bg-background">{records.map(record => <div key={record.id} className="flex items-center justify-between gap-6 border-b px-6 py-5 last:border-b-0"><div className="min-w-0 space-y-2"><div className="flex flex-wrap items-center gap-x-3 gap-y-2"><h2 className="w-full break-words text-sm font-medium">{record.scenario_title??'自由沟通练习'}</h2><Badge variant="outline">{experienceLabel(record.experience)}</Badge><span className="text-sm text-muted-foreground">{statusLabels[record.status] ?? record.status}</span></div><p className="text-sm text-muted-foreground">{dateLabel(record.started_at)} · {record.message_count} 条对话</p></div><Button variant="outline" className="h-11 shrink-0" onClick={() => {window.location.hash=`records?session=${record.id}`}}>查看复盘</Button></div>)}</div>}
    <details className="rounded-xl border bg-background p-5" onToggle={event => { if (event.currentTarget.open) setProgressOpened(true) }}><summary className="cursor-pointer text-sm font-medium">查看训练变化与服务用量</summary>{progressOpened && <div className="mt-5"><TrainingProgress refresh={refresh}/></div>}</details>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) {setSelected(null);window.location.hash='records'} }}><DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl"><DialogHeader><DialogTitle>演练记录</DialogTitle><DialogDescription>{detail ? `${experienceLabel(detail.experience)} · ${dateLabel(detail.started_at)} · ${statusLabels[detail.status] ?? detail.status}` : '原话、AI 复盘与人工点评'}</DialogDescription></DialogHeader><ScrollArea className="min-h-0 [&>[data-slot=scroll-area-viewport]]:max-h-[65vh]"><div className="space-y-5 py-3 pr-4">{detailError ? <p role="alert" className="text-sm text-destructive">{detailError}</p> : !detail ? <p role="status" className="text-sm text-muted-foreground">正在加载对话…</p> : detail.messages.length === 0 ? <p className="text-sm text-muted-foreground">本次未产生文字转录。</p> : detail.messages.map(message => <div key={message.id} className={`flex flex-col ${message.role === 'trainee' ? 'items-end' : 'items-start'}`}><p className="mb-2 text-xs text-muted-foreground">{message.role === 'doctor' ? detail.doctor?.display_name ?? '医生（历史训练）' : '我'}{!message.final && ' · 未完成转录'}</p><p className={`max-w-[92%] sm:max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === 'trainee' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{message.text}</p></div>)}{!!detail?.medical_checks?.length && <section className="space-y-4"><h2 className="font-medium">逐句医学依据核验</h2>{detail.medical_checks.map((check,index) => <div key={index}><p className="text-sm leading-7">{check.text}</p><MedicalCheckView check={check}/></div>)}</section>}{detail?.coaching?.length ? <section className="space-y-5"><h2 className="font-medium">{detail.experience === 'combat' ? 'AI 复盘' : '教练分析记录'}</h2>{detail.coaching.map((coach, index) => <CoachAnalysis key={index} coach={coach} review />)}</section> : detail?.experience === 'combat' && <p className="text-sm text-muted-foreground">{detail.analysis_status === 'no_speech' ? '没有可分析的学员发言。' : '本次未保存 AI 复盘。'}</p>}{detail&&<ReviewPanel key={detail.id} record={detail} onRetrain={()=>setRefresh(value=>value+1)}/>}</div></ScrollArea></DialogContent></Dialog>
  </div>
}
