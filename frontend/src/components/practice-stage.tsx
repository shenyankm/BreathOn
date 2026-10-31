import { useState, type ReactNode } from 'react'
import { ArrowLeft, Maximize2, Mic, MicOff, Minimize2, Phone, Volume2, VolumeX } from 'lucide-react'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { formatTime } from '@/lib/session'

export function PracticeStage({ actions, practice, doctorName, seconds, status, error, active, connecting, muted, outputMuted, policyPaused, transcript, coach, onMute, onOutputMute, onEnd, onInterrupt }: {
  actions?: ReactNode; practice: boolean; doctorName: string; seconds: number; status: string; error?: string; active: boolean; connecting: boolean
  muted: boolean; outputMuted: boolean; policyPaused: boolean; transcript: ReactNode; coach: ReactNode
  onMute: () => void; onOutputMute: () => void; onEnd: () => void; onInterrupt?: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const controls = <div data-slot="call-controls" className={`flex shrink-0 items-end justify-evenly gap-3 ${practice ? 'px-3 py-4' : 'px-4 py-8'}`}>
    <div className="flex flex-col items-center gap-2"><Button variant="secondary" className={practice ? 'size-12 rounded-full' : 'size-18 rounded-full [&_svg]:size-7'} aria-label={outputMuted ? '开启医生声音' : '关闭医生声音'} aria-pressed={outputMuted} disabled={!active} onClick={onOutputMute}>{outputMuted ? <VolumeX aria-hidden="true" className={practice ? 'size-5' : 'size-7'} /> : <Volume2 aria-hidden="true" className={practice ? 'size-5' : 'size-7'} />}</Button>{!practice && <span className="text-sm">声音</span>}</div>
    <div className="flex flex-col items-center gap-2"><Button variant={active || connecting ? 'destructive' : 'secondary'} className={`${practice ? active || connecting ? 'size-12 rounded-full' : 'h-12 rounded-full px-6' : 'size-20 rounded-full [&_svg]:size-7'} ${active || connecting ? 'bg-destructive text-white hover:bg-destructive/90' : ''}`} aria-label={active ? '结束演练' : connecting ? '取消连接' : '查看复盘'} onClick={onEnd}><Phone aria-hidden="true" className={`rotate-[135deg] ${practice ? 'size-5' : 'size-7'}`} />{practice && !active && !connecting && '查看复盘'}</Button>{!practice && <span className="text-sm" aria-hidden={active || connecting}>{active || connecting ? '\u00a0' : '复盘'}</span>}</div>
    <div className="flex flex-col items-center gap-2"><Button variant="secondary" className={practice ? 'size-12 rounded-full' : 'size-18 rounded-full [&_svg]:size-7'} disabled={!active || policyPaused} aria-label={muted ? '取消静音' : '静音麦克风'} aria-pressed={muted} onClick={onMute}>{muted ? <MicOff aria-hidden="true" className={practice ? 'size-5' : 'size-7'} /> : <Mic aria-hidden="true" className={practice ? 'size-5' : 'size-7'} />}</Button>{!practice && <span className="text-sm">{muted ? '已静音' : '静音'}</span>}</div>
  </div>
  const identity = <div data-slot="call-identity" className={`flex flex-col items-center gap-3 ${practice ? 'py-3' : 'shrink-0 pt-20'}`}><Avatar className={practice ? 'size-14' : 'size-24'}><AvatarFallback className="text-2xl">{doctorName.slice(0, 1)}</AvatarFallback></Avatar><h2 className="max-w-full break-words text-center text-lg font-medium">{doctorName}</h2></div>
  return <section key={practice ? "practice" : expanded ? "expanded" : "compact"} aria-label={practice ? '辅助练习对话' : '实战语音通话'} className={practice ? 'flex h-[max(32rem,calc(100svh-6.25rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)))] sm:h-[max(32rem,calc(100svh-6.75rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)))] flex-col' : `combat-stage flex flex-col ${expanded ? 'fixed inset-0 z-40 h-svh overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : 'relative min-h-96 rounded-[2rem]'}`}>
    {!practice && expanded && <Button asChild variant="ghost" className="absolute top-3 left-3 size-12 rounded-full text-white hover:bg-white/15 hover:text-white" aria-label="返回练习配置"><a href="#practice"><ArrowLeft aria-hidden="true" /></a></Button>}
    {!practice && <Button variant="ghost" className="absolute top-3 right-3 size-12 rounded-full text-white hover:bg-white/15 hover:text-white" aria-label={expanded ? '收起通话界面' : '展开通话界面'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</Button>}
    {!practice && <div className="absolute top-3 right-16">{actions}</div>}
    {identity}
    {practice ? <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-3">
      <section aria-label="对话记录" className="flex min-h-0 flex-col">{transcript}</section>
      <section aria-label="AI 分析与建议" className="flex min-h-0 flex-col border-t pt-3">
        <h3 className="mb-2 shrink-0 text-sm font-medium">AI 分析与建议</h3>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{coach}</div>
      </section>
    </div> : <div data-slot="call-status" className="flex flex-1 flex-col items-center justify-center gap-4 py-8"><p className="text-4xl font-light tabular-nums" aria-label="通话时长">{formatTime(seconds)}</p><p role="status" className="text-sm">{status}</p>{error && <p role="alert" className="max-w-md px-6 text-center text-sm leading-6">{error}</p>}<div className="flex gap-2"><Dialog><DialogTrigger asChild><Button variant="ghost" className="h-12 rounded-full px-5 text-white hover:bg-white/15 hover:text-white">对话</Button></DialogTrigger><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>实战对话</DialogTitle><DialogDescription className="sr-only">与模拟医生的对话记录</DialogDescription></DialogHeader><div className="h-[60svh] min-h-0">{transcript}</div></DialogContent></Dialog>{active && onInterrupt && <Button variant="ghost" className="h-12 rounded-full px-5 text-white hover:bg-white/15 hover:text-white" onClick={onInterrupt}>打断医生</Button>}</div></div>}
    {practice && <p role="status" className="mt-2 text-center text-xs text-muted-foreground">{status} · {formatTime(seconds)}</p>}
    {controls}
  </section>
}
