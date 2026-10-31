import { useState } from 'react'
import { ArrowRight, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
    <h1 className="sr-only">练习</h1>
    {sessionState ? <Card>
      <CardHeader><CardTitle><h2>{sessionState === 'thinking' ? '正在整理本次复盘' : sessionState === 'connecting' ? '演练正在连接' : '演练正在进行'}</h2></CardTitle><CardDescription className="leading-7">{sessionState === 'thinking' ? '等待最终转录与保存完成后，再开始下一次练习。' : `已进行 ${formatTime(seconds)}`}</CardDescription></CardHeader>
      <CardFooter><Button asChild className="h-11"><a href="#start">返回当前演练<ArrowRight /></a></Button></CardFooter>
    </Card> : <Card className="min-w-0 rounded-none bg-transparent py-0 ring-0 sm:rounded-2xl sm:bg-card sm:py-6 sm:ring-1">
      <CardContent className="grid items-start gap-4 px-0 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6">
        <section className="min-w-0" aria-label="选择演练内容"><ScenarioPicker value={choice} onChange={onChoiceChange} onReady={setReady} /></section>
        <section aria-label="准备开始" className="min-w-0 space-y-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <div className="space-y-1.5"><span id="practice-preset-label" className="text-sm font-medium">演练方式</span><div role="group" aria-labelledby="practice-preset-label" className="grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1">{trainingPresets.map(option => <Button key={option.id} type="button" variant={preset.id === option.id ? 'default' : 'ghost'} aria-pressed={preset.id === option.id} className="h-12 min-w-0 rounded-xl px-2 motion-reduce:transition-none" onClick={() => onPresetChange(option)}>{option.label}</Button>)}</div><p className="text-xs leading-5 text-muted-foreground">{preset.description}</p></div>
          <Button className="h-12 w-full" disabled={!ready} onClick={() => onStart(choice, preset)}>开始练习<ArrowRight /></Button>
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Mic className="mt-1 size-3.5 shrink-0" aria-hidden="true" />需麦克风权限 · 请勿输入真实患者信息。</p>
        </section>
      </CardContent>
    </Card>}
  </div>
}
