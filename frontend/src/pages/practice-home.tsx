import { useEffect, useState } from 'react'
import { ArrowRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScenarioPicker, type TrainingChoice } from '@/components/scenario-picker'
import { api } from '@/lib/platform-api'
import { formatTime } from '@/lib/session'
import { trainingPresets, type TrainingPreset } from '@/lib/training-setup'

type LatestRecord = { id: string; started_at: string; status: string }

export function PracticeHome({ initialChoice, initialPreset, sessionState, seconds, onStart }: {
  initialChoice: TrainingChoice; initialPreset: TrainingPreset; sessionState: string; seconds: number
  onStart: (choice: TrainingChoice, preset: TrainingPreset) => void
}) {
  const [choice, setChoice] = useState<TrainingChoice>(() => ({ scenario_id: initialChoice.scenario_id, stage: initialChoice.stage }))
  const [preset, setPreset] = useState(initialPreset)
  const [ready, setReady] = useState(false)
  const [latest, setLatest] = useState<LatestRecord>()
  useEffect(() => {
    const controller = new AbortController()
    api<LatestRecord[]>('/sessions', { signal: controller.signal }).then(records => setLatest(records[0])).catch(() => {})
    return () => controller.abort()
  }, [])
  return <div className="mx-auto max-w-3xl space-y-6">
    <header><h1 className="text-2xl font-semibold">开始拜访练习</h1></header>
      <section className="min-w-0 rounded-xl border bg-background p-5 sm:p-6" aria-label="开始演练">
        {sessionState ? <div className="space-y-5"><div><h2 className="text-lg font-medium">{sessionState === 'thinking' ? '正在整理本次复盘' : sessionState === 'connecting' ? '演练正在连接' : '演练正在进行'}</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">{sessionState === 'thinking' ? '等待最终转录与保存完成后，再开始下一次练习。' : `已进行 ${formatTime(seconds)}，可以返回继续交流。`}</p></div><Button asChild className="h-11"><a href="#start">返回当前演练<ArrowRight /></a></Button></div> : <div className="space-y-5">
          <ScenarioPicker value={choice} onChange={setChoice} onReady={setReady} autoSelect />
          <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">演练方式：{preset.label}<span className="ml-2 font-normal text-muted-foreground">更改</span></summary><fieldset className="mt-4 space-y-2"><legend className="sr-only">选择演练方式</legend>{trainingPresets.map(option => <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${preset.id === option.id ? 'border-foreground/35 bg-muted/30' : ''}`} key={option.id}><input className="mt-1" type="radio" name="training-preset" checked={preset.id === option.id} onChange={() => setPreset(option)} /><span className="min-w-0 text-sm"><span className="block font-medium">{option.label}{option.id === 'coached' && ' · 新手推荐'}</span><span className="mt-1 block leading-6 text-muted-foreground">{option.description}</span></span></label>)}</fieldset></details>
          <div className="space-y-3 border-t pt-5"><Button className="h-12 w-full sm:w-auto sm:min-w-44" disabled={!ready} onClick={() => onStart(choice, preset)}>开始练习<ArrowRight /></Button><p className="text-sm leading-6 text-muted-foreground">需开启麦克风 · AI 模拟训练，请勿输入真实患者信息。</p></div>
        </div>}
      </section>
      <nav aria-label="练习快捷入口" className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="outline" className="h-11"><a href={latest ? `#records?session=${latest.id}` : '#records'}><RotateCcw />{latest ? '查看最近复盘' : '查看演练记录'}</a></Button>
        <Button asChild variant="ghost" className="h-11"><a href="#workspace">训练管理<ArrowRight /></a></Button>
      </nav>
  </div>
}
