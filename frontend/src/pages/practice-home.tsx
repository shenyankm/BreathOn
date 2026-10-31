import { useEffect, useState } from 'react'
import { ArrowRight, Mic, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScenarioPicker, type TrainingChoice } from '@/components/scenario-picker'
import { api } from '@/lib/platform-api'
import { formatTime } from '@/lib/session'
import { trainingPresets, type TrainingPreset } from '@/lib/training-setup'

type LatestRecord = { id: string; started_at: string; status: string }

export function PracticeHome({ initialChoice, initialPreset, sessionState, seconds, onStart, onChoiceChange, onPresetChange }: {
  initialChoice: TrainingChoice; initialPreset: TrainingPreset; sessionState: string; seconds: number
  onStart: (choice: TrainingChoice, preset: TrainingPreset) => void
  onChoiceChange: (choice: TrainingChoice) => void; onPresetChange: (preset: TrainingPreset) => void
}) {
  const choice = initialChoice
  const preset = initialPreset
  const [ready, setReady] = useState(false)
  const [latest, setLatest] = useState<LatestRecord>()
  useEffect(() => {
    const controller = new AbortController()
    api<LatestRecord[]>('/sessions', { signal: controller.signal }).then(records => setLatest(records[0])).catch(() => {})
    return () => controller.abort()
  }, [])
  return <div className="space-y-4 sm:space-y-6">
    <header><h1 className="text-[22px] leading-8 font-semibold tracking-tight sm:text-2xl">开始拜访练习</h1></header>
    {sessionState ? <Card>
      <CardHeader><CardTitle><h2>{sessionState === 'thinking' ? '正在整理本次复盘' : sessionState === 'connecting' ? '演练正在连接' : '演练正在进行'}</h2></CardTitle><CardDescription className="leading-7">{sessionState === 'thinking' ? '等待最终转录与保存完成后，再开始下一次练习。' : `已进行 ${formatTime(seconds)}`}</CardDescription></CardHeader>
      <CardFooter><Button asChild className="h-11"><a href="#start">返回当前演练<ArrowRight /></a></Button></CardFooter>
    </Card> : <Card className="min-w-0 rounded-none bg-transparent py-0 ring-0 sm:rounded-2xl sm:bg-card sm:py-6 sm:ring-1">
      <CardContent className="grid items-start gap-4 px-0 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6">
        <section className="min-w-0" aria-label="选择演练内容"><ScenarioPicker value={choice} onChange={onChoiceChange} onReady={setReady} /></section>
        <section aria-label="准备开始" className="min-w-0 space-y-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <div className="space-y-1.5"><label htmlFor="practice-preset" className="text-sm font-medium">演练方式</label><Select value={preset.id} onValueChange={id => onPresetChange(trainingPresets.find(option => option.id === id) ?? initialPreset)}><SelectTrigger id="practice-preset" className="h-11 w-full"><SelectValue /></SelectTrigger><SelectContent>{trainingPresets.map(option => <SelectItem key={option.id} value={option.id} className="min-h-11">{option.label}</SelectItem>)}</SelectContent></Select><p className="text-xs leading-5 text-muted-foreground">{preset.description}</p></div>
          <Button className="h-12 w-full" disabled={!ready} onClick={() => onStart(choice, preset)}>开始练习<ArrowRight /></Button>
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Mic className="mt-1 size-3.5 shrink-0" aria-hidden="true" />需麦克风权限 · 请勿输入真实患者信息。</p>
        </section>
      </CardContent>
    </Card>}
    <nav aria-label="练习快捷入口" className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      <Button asChild variant="ghost" className="h-11"><a href={latest ? `#records?session=${latest.id}` : '#records'}><RotateCcw />{latest ? '查看最近复盘' : '查看演练记录'}</a></Button>
      <Button asChild variant="ghost" className="h-11"><a href="#library">资料空间<ArrowRight /></a></Button>
    </nav>
  </div>
}
