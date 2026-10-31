import { doctorLabel } from '@/lib/doctor-label'
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronRight, CircleHelp, FileText, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ReviewPanel, type ReviewRecord } from '@/components/review-panel'
import { CoachAnalysis } from '@/components/coach-analysis'
import { MedicalCheckView } from '@/components/medical-check'
import type { FreePracticeContext } from '@/lib/catalog-types'
import type { MedicalCheck } from '@/lib/medical'
import type { LiveCoach } from '@/lib/voice-events'
import { RetrainingList } from '@/components/retraining-list'
import { TrainingProgress } from '@/components/training-progress'
import type { StartTraining } from '@/components/scenario-picker'
import { api } from '@/lib/platform-api'

type Summary = { id: string; experience: string; mode: string; started_at: string; status: string; message_count: number; scenario_title?: string | null }
type Record = Summary & ReviewRecord & { free_context?: FreePracticeContext; doctor?: { display_name: string }; analysis_status?: string; coaching?: LiveCoach[]; medical_checks?: MedicalCheck[]; messages: { id: string; role: string; text: string; final: boolean }[] }
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
  const [detailRetry, setDetailRetry] = useState(0)
  const [detailTab, setDetailTab] = useState('review')

  useEffect(() => {
    const controller = new AbortController()
    api<Summary[]>('/sessions', { signal: controller.signal, timeoutMs: 5000 })
      .then(data => { if (!controller.signal.aborted) { setRecords(data); setError('') } })
      .catch(() => { if (!controller.signal.aborted) setError('无法加载记录，请检查后端服务后重试。') })
    return () => controller.abort()
  }, [refresh])

  useEffect(()=>{function change(){setDetail(null);setDetailError('');setDetailTab('review');setSelected(new URLSearchParams(window.location.hash.split('?')[1]).get('session'))}window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change)},[])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    api<Record>(`/sessions/${encodeURIComponent(selected)}`, { signal: controller.signal, timeoutMs: 5000 })
      .then(data => { if (!controller.signal.aborted) { setDetail(data); setDetailError('') } })
      .catch(() => { if (!controller.signal.aborted) setDetailError('无法读取这条记录，请稍后重试。') })
    return () => controller.abort()
  }, [selected, detailRetry])

  return <div className="space-y-6">
    <div className="flex items-center justify-between gap-4"><div><h1 className="text-[22px] font-semibold sm:text-2xl">练习记录</h1><p className="mt-2 text-sm leading-7 text-muted-foreground">最近 50 次演练</p></div><Button variant="outline" className="h-11 shrink-0" onClick={() => { setRecords(null); setError(''); setRefresh(value => value + 1) }}><RotateCcw />刷新</Button></div>
    <RetrainingList onStart={onStart} refresh={refresh}/>
    {error ? <Alert role="alert" variant="destructive"><CircleHelp /><AlertTitle>记录暂时无法加载</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : records === null ? <Card role="status" aria-label="正在加载演练记录"><CardContent className="space-y-5">{[0, 1, 2].map(index => <div className="space-y-3 border-b pb-5 last:border-0 last:pb-0" key={index}><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-40" /></div>)}<span className="sr-only">正在加载记录…</span></CardContent></Card> : records.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-4 py-12 text-center"><FileText aria-hidden="true" className="size-7 text-muted-foreground" /><div className="space-y-2"><h2 className="font-medium">暂无演练记录</h2></div><Button asChild className="h-11"><a href="#home">开始演练<ArrowRight /></a></Button></CardContent></Card> : <Card className="gap-0 py-0"><ul className="divide-y">{records.map(record=><li key={record.id}><Button asChild variant="ghost" className="h-auto min-h-24 w-full justify-between gap-3 rounded-none px-4 py-4 text-left font-normal whitespace-normal sm:px-6"><a href={`#records?session=${record.id}`} aria-label={`查看${record.scenario_title??'自由沟通练习'}的复盘`}><span className="min-w-0 flex-1 space-y-2"><span className="block break-words text-sm font-medium leading-6">{record.scenario_title??'自由沟通练习'}</span><span className="flex flex-wrap items-center gap-x-3 gap-y-1"><Badge variant="outline">{experienceLabel(record.experience)}</Badge><span className="text-xs text-muted-foreground">{statusLabels[record.status]??record.status}</span><span className="text-xs text-muted-foreground tabular-nums">{record.message_count} 条对话</span></span><span className="block text-xs leading-5 text-muted-foreground tabular-nums">{dateLabel(record.started_at)}</span></span><ChevronRight className="size-5 text-muted-foreground" /></a></Button></li>)}</ul></Card>}

    <Accordion type="single" collapsible className="bg-card" onValueChange={value => { if (value) setProgressOpened(true) }}><AccordionItem value="progress"><AccordionTrigger className="min-h-14 px-5">训练变化与服务用量</AccordionTrigger><AccordionContent forceMount>{progressOpened && <TrainingProgress refresh={refresh}/>}</AccordionContent></AccordionItem></Accordion>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) {setSelected(null);window.location.hash='records'} }}>
      <DialogContent fullscreen showCloseButton={false} className="inset-0 top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[88vh] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl">
        <DialogHeader className="shrink-0 border-b px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3"><Button variant="ghost" className="h-11 shrink-0 px-2" aria-label="返回练习记录" onClick={()=>{setSelected(null);window.location.hash='records'}}><ArrowLeft />返回</Button><DialogTitle className="text-base font-semibold">演练复盘</DialogTitle></div>
          <DialogDescription className="text-xs leading-6">{detail ? `${detail.free_context ? `${detail.free_context.drug.name} · ${doctorLabel(detail.free_context.doctor.display_name)} · 自由演练不评分 · ` : ''}${experienceLabel(detail.experience)} · ${dateLabel(detail.started_at)} · ${statusLabels[detail.status] ?? detail.status}` : '原话、AI 复盘与人工点评'}</DialogDescription>
        </DialogHeader>
        <Tabs value={detailTab} onValueChange={setDetailTab} className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="mx-4 h-12 w-auto shrink-0 justify-start rounded-none border-b sm:mx-6"><TabsTrigger className="min-h-11 px-4" value="review">教练复盘</TabsTrigger><TabsTrigger className="min-h-11 px-4" value="transcript">对话原文{detail ? ` · ${detail.messages.length}` : ''}</TabsTrigger></TabsList>
          <TabsContent value="review" forceMount className="m-0 min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:block!">
              <div className="space-y-5 px-4 py-5 sm:px-6">
                {detailError ? <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{detailError}</p><Button variant="outline" onClick={() => { setDetailError(''); setDetailRetry(value => value + 1) }}>重新读取</Button></div> : !detail ? <p role="status" className="text-sm text-muted-foreground">正在加载复盘…</p> : <>
                  {detail.coaching?.length ? <section className="space-y-5"><h2 className="text-base font-medium">{detail.experience === 'combat' ? 'AI 复盘' : '教练分析记录'}</h2>{detail.coaching.map((coach,index)=><CoachAnalysis key={index} coach={coach} review />)}</section> : <p className="text-sm leading-6 text-muted-foreground">{detail.analysis_status === 'no_speech' ? '没有可分析的学员发言。' : '本次未保存教练复盘。'}</p>}
                  {!!detail.medical_checks?.length && <section className="space-y-4"><h2 className="text-base font-medium">逐句医学依据核验</h2>{detail.medical_checks.map((check,index)=><div key={index}><p className="text-sm leading-7">{check.text}</p><MedicalCheckView check={check}/></div>)}</section>}
                  <>{detail.free_context && <Button className="min-h-12 w-full" onClick={() => onStart({ scenario_id: '', stage: 'full', drug_id: detail.free_context!.drug.id, doctor_id: detail.free_context!.doctor.id, experience: detail.experience === 'combat' ? 'combat' : 'practice', mode: detail.experience === 'combat' ? 'independent' : 'assisted' })}>按此组合再练<ArrowRight /></Button>}</><ReviewPanel key={detail.id} record={detail} onRetrain={()=>setRefresh(value=>value+1)}/>
                </>}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="transcript" forceMount className="m-0 min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:block!">
              <div className="space-y-5 px-4 py-5 sm:px-6">
                {detailError ? <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{detailError}</p><Button variant="outline" onClick={() => { setDetailError(''); setDetailRetry(value => value + 1) }}>重新读取</Button></div> : !detail ? <p role="status" className="text-sm text-muted-foreground">正在加载对话…</p> : detail.messages.length===0 ? <p className="text-sm text-muted-foreground">本次未产生文字转录。</p> : detail.messages.map(message=><div key={message.id} className={`flex flex-col ${message.role==='trainee'?'items-end':'items-start'}`}><p className="mb-2 text-xs text-muted-foreground">{message.role==='doctor'?doctorLabel(detail.doctor?.display_name??'医生'):'我'}{!message.final&&' · 未完成转录'}</p><p className={`max-w-[92%] whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-sm leading-7 sm:max-w-[85%] ${message.role==='trainee'?'bg-primary text-primary-foreground':'bg-muted'}`}>{message.text}</p></div>)}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  </div>
}
