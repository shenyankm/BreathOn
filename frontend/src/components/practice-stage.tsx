import { useState, type ReactNode } from 'react'
import { ArrowLeft, Maximize2, Mic, MicOff, Minimize2, Phone, Volume2, VolumeX } from 'lucide-react'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { formatTime } from '@/lib/session'

export function PracticeStage({ practice, doctorName, seconds, status, error, active, connecting, muted, outputMuted, policyPaused, transcript, coach, onMute, onOutputMute, onEnd, onRestart, onInterrupt }: {
  practice: boolean; doctorName: string; seconds: number; status: string; error?: string; active: boolean; connecting: boolean
  muted: boolean; outputMuted: boolean; policyPaused: boolean; transcript: ReactNode; coach: ReactNode
  onMute: () => void; onOutputMute: () => void; onEnd: () => void; onRestart: () => void; onInterrupt?: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const controls = <div data-slot="call-controls" className={`flex shrink-0 items-end justify-evenly gap-3 ${practice ? 'px-3 py-4' : 'px-4 py-8'}`}>
    <div className="flex flex-col items-center gap-2"><Button variant="secondary" className={practice ? 'size-12 rounded-full' : 'size-18 rounded-full [&_svg]:size-7'} aria-label={outputMuted ? '开启医生声音' : '关闭医生声音'} aria-pressed={outputMuted} disabled={!active} onClick={onOutputMute}>{outputMuted ? <VolumeX aria-hidden="true" className={practice ? 'size-5' : 'size-7'} /> : <Volume2 aria-hidden="true" className={practice ? 'size-5' : 'size-7'} />}</Button>{!practice && <span className="text-sm">声音</span>}</div>
    <div className="flex flex-col items-center gap-2"><Button variant={active || connecting ? 'destructive' : 'secondary'} className={`${practice ? 'h-12 rounded-full px-6' : 'size-20 rounded-full [&_svg]:size-7'} ${active || connecting ? 'bg-destructive text-white hover:bg-destructive/90' : ''}`} aria-label={active ? '结束演练' : connecting ? '取消连接' : '查看复盘'} onClick={onEnd}><Phone aria-hidden="true" className={`rotate-[135deg] ${practice ? 'size-5' : 'size-7'}`} />{practice && (active ? '结束练习' : connecting ? '取消连接' : '查看复盘')}</Button>{!practice && <span className="text-sm">{active ? '结束' : connecting ? '取消' : '复盘'}</span>}</div>
    <div className="flex flex-col items-center gap-2"><Button variant="secondary" className={practice ? 'size-12 rounded-full' : 'size-18 rounded-full [&_svg]:size-7'} disabled={!active || policyPaused} aria-label={muted ? '取消静音' : '静音麦克风'} aria-pressed={muted} onClick={onMute}>{muted ? <MicOff aria-hidden="true" className={practice ? 'size-5' : 'size-7'} /> : <Mic aria-hidden="true" className={practice ? 'size-5' : 'size-7'} />}</Button>{!practice && <span className="text-sm">{muted ? '已静音' : '静音'}</span>}</div>
  </div>
  const identity = <div data-slot="call-identity" className={`flex flex-col items-center gap-3 ${practice ? 'py-3' : 'shrink-0 pt-12'}`}><Avatar className={practice ? 'size-14' : 'size-24'}><AvatarFallback className="text-2xl">{doctorName.slice(0, 1)}</AvatarFallback></Avatar><h2 className="max-w-full break-words text-center text-lg font-medium">{doctorName}</h2><p className={`text-xs ${practice ? 'text-muted-foreground' : 'text-white/80'}`}>AI 模拟医生</p></div>
  return <section aria-label={practice ? '辅助练习对话' : '实战语音通话'} className={practice ? 'flex h-[max(32rem,calc(100svh-10rem))] flex-col' : `combat-stage flex flex-col ${expanded ? 'fixed inset-0 z-40 h-svh overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : 'relative min-h-96 rounded-[2rem]'}`}>
    {!practice && expanded && <Button asChild variant="ghost" className="absolute top-3 left-3 size-12 rounded-full text-white hover:bg-white/15 hover:text-white" aria-label="返回主页面"><a href="#home"><ArrowLeft aria-hidden="true" /></a></Button>}
    {!practice && <Button variant="ghost" className="absolute top-3 right-3 size-12 rounded-full text-white hover:bg-white/15 hover:text-white" aria-label={expanded ? '收起通话界面' : '展开通话界面'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</Button>}
    {identity}
    {practice ? <Tabs defaultValue="transcript" className="min-h-0 flex-1 gap-2 [&>[role=tablist]]:shrink-0">
      <TabsList className="mx-auto h-14!"><TabsTrigger className="min-h-12 px-5" value="transcript">对话</TabsTrigger><TabsTrigger className="min-h-12 px-5" value="coach">实时教练</TabsTrigger></TabsList>
      <TabsContent value="transcript" className="min-h-0 flex-1">{transcript}</TabsContent><TabsContent value="coach" className="min-h-0 flex-1 overflow-y-auto">{coach}</TabsContent>
    </Tabs> : <div data-slot="call-status" className="flex flex-1 flex-col items-center justify-center gap-4 py-8"><p className="text-4xl font-light tabular-nums" aria-label="通话时长">{formatTime(seconds)}</p><p role="status" className="text-sm">{policyPaused ? '收音已暂停，请先核对风险提示' : muted && active ? '麦克风已静音' : status}</p>{error && <p role="alert" className="max-w-md px-6 text-center text-sm leading-6">{error}</p>}<div className="flex gap-2"><Dialog><DialogTrigger asChild><Button variant="ghost" className="h-12 rounded-full px-5 text-white hover:bg-white/15 hover:text-white">查看对话</Button></DialogTrigger><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>实战对话</DialogTitle><DialogDescription>AI 模拟练习 · 结束后查看复盘</DialogDescription></DialogHeader><div className="h-[60svh] min-h-0">{transcript}</div></DialogContent></Dialog>{active && onInterrupt && <Button variant="ghost" className="h-12 rounded-full px-5 text-white hover:bg-white/15 hover:text-white" onClick={onInterrupt}>打断医生</Button>}</div></div>}
    {practice && <p role="status" className="mt-2 text-center text-xs text-muted-foreground">{status} · {formatTime(seconds)}{muted && active ? ' · 麦克风已静音' : ''}</p>}
    {controls}
    {!active && !connecting && <Button variant="ghost" className="mx-auto mb-4 min-h-12" onClick={onRestart}>再次练习</Button>}
  </section>
}
