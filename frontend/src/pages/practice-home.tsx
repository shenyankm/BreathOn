import { useState } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { ScenarioPicker, type TrainingChoice } from '@/components/scenario-picker'
import { formatTime } from '@/lib/session'
import { trainingPresets, type TrainingPreset } from '@/lib/training-setup'

export function PracticeHome({ initialChoice, initialPreset, sessionState, seconds, onStart, onChoiceChange, onPresetChange }: {
  initialChoice: TrainingChoice; initialPreset: TrainingPreset; sessionState: string; seconds: number
  onStart: (choice: TrainingChoice, preset: TrainingPreset) => void
  onChoiceChange: (choice: TrainingChoice) => void; onPresetChange: (preset: TrainingPreset) => void
}) {
  const choice = initialChoice
  const preset = initialPreset
  const [ready, setReady] = useState(false)
  return <div className="space-y-4 sm:space-y-6">
    <PageHeader title="练习" />
    {sessionState ? <Card>
      <CardHeader><CardTitle><h2>{sessionState === 'thinking' ? '正在整理本次复盘' : sessionState === 'connecting' ? '演练正在连接' : '演练正在进行'}</h2></CardTitle><CardDescription className="leading-7">{sessionState === 'thinking' ? '等待最终转录与保存完成后，再开始下一次练习。' : `已进行 ${formatTime(seconds)}`}</CardDescription></CardHeader>
      <CardFooter><Button asChild><a href="#start">返回当前演练<ArrowRight /></a></Button></CardFooter>
    </Card> : <Card className="min-w-0 rounded-none bg-transparent py-0 ring-0 sm:rounded-2xl sm:bg-card sm:py-6 sm:ring-1">
      <CardContent className="grid items-start gap-4 px-0 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6">
        <section className="min-w-0" aria-label="选择演练内容"><ScenarioPicker value={choice} onChange={onChoiceChange} onReady={setReady} /></section>
        <section aria-label="准备开始" className="min-w-0 space-y-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <div className="space-y-1.5"><div role="group" aria-label="演练方式" className="grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1">{trainingPresets.map(option => <Button key={option.id} type="button" variant={preset.id === option.id ? 'default' : 'ghost'} aria-pressed={preset.id === option.id} className="h-12 min-w-0 rounded-xl px-2 motion-reduce:transition-none" onClick={() => onPresetChange(option)}>{option.label}</Button>)}</div><Alert role="status" aria-live="polite" className="mt-3 rounded-2xl border-0 bg-muted/50 px-4 py-3"><Info aria-hidden="true" className="size-4 text-muted-foreground"/><AlertDescription className="text-sm leading-6 text-foreground/80">{preset.description}</AlertDescription></Alert></div>
          <Button size="lg" className="w-full" disabled={!ready} onClick={() => onStart(choice, preset)}>开始练习<ArrowRight /></Button>
        </section>
      </CardContent>
    </Card>}
  </div>
}
