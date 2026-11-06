import { ScenarioPicker,type TrainingChoice,type StartTraining } from '@/components/scenario-picker'
import { RetrainingList } from '@/components/retraining-list'
import { TrainingProgress } from '@/components/training-progress'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { ToggleGroup,ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatTime } from '@/lib/session'
import { presetFor,trainingPresets,type TrainingPreset } from '@/lib/training-setup'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'

export function PracticeHome({ initialChoice, initialPreset, sessionState, seconds, onStart, onResume, onChoiceChange, onPresetChange }: {
  initialChoice: TrainingChoice; initialPreset: TrainingPreset; sessionState: string; seconds: number
  onStart: (choice: TrainingChoice, preset: TrainingPreset) => void
  onResume: StartTraining
  onChoiceChange: (choice: TrainingChoice) => void; onPresetChange: (preset: TrainingPreset) => void
}) {
  const choice = initialChoice
  const preset = choice.remediation_id?presetFor(choice.experience??'practice',choice.mode):initialPreset
  const [ready, setReady] = useState(false)
  return <div className="space-y-4 sm:space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><Brand /><h1 className="text-xl font-semibold">练习</h1></header>
    {sessionState ? <section className="space-y-3">
      <h2 className="font-medium">{sessionState === 'thinking' ? '正在整理本次复盘' : sessionState === 'connecting' ? '演练正在连接' : '演练正在进行'}</h2>
      <p className="text-sm text-muted-foreground">{sessionState === 'thinking' ? '等待最终转录与保存完成后，再开始下一次练习。' : `已进行 ${formatTime(seconds)}`}</p>
      <Button asChild><a href="#start">返回当前演练<ArrowRight /></a></Button>
    </section> : <>
      <RetrainingList onStart={onResume} compact/>
      <div className="grid min-w-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_16rem] lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0" aria-label="选择演练内容"><ScenarioPicker value={choice} onChange={onChoiceChange} onReady={setReady} />{choice.remediation_id&&<Button variant="ghost" className="mt-3 min-h-11" onClick={()=>{setReady(false);onChoiceChange({scenario_id:'',stage:'full'})}}>退出重练，选择新训练</Button>}</section>
        <section aria-label="准备开始" className="min-w-0 space-y-3">
          {choice.remediation_id?<p className="text-sm">沿用原演练方式：{choice.experience!=='combat'&&choice.mode==='independent'?'练习（关闭实时辅助）':preset.label}</p>:<ToggleGroup type="single" variant="outline" className="flex-wrap" aria-label="演练方式" value={preset.id} onValueChange={id => { const option = trainingPresets.find(option => option.id === id); if (option) onPresetChange(option) }}>{trainingPresets.map(option => <ToggleGroupItem key={option.id} value={option.id} className="min-h-11">{option.label}</ToggleGroupItem>)}</ToggleGroup>}<p role="status" className="text-sm leading-6 text-muted-foreground">{choice.remediation_id?'沿用原场景和演练方式，结束后查看反馈与原记录对比。':preset.description}</p>
          <Button size="lg" className="w-full min-h-11" disabled={!ready} onClick={() => onStart(choice, preset)}>开始练习<ArrowRight /></Button>
        </section>
      </div>
      <TrainingProgress refresh={0}/>
    </>}
  </div>
}
