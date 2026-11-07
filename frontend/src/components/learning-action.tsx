import { useRef, useState } from 'react'
import { nextAction } from '@/lib/learning'
import { api } from '@/lib/platform-api'
import type { LiveCoach } from '@/lib/voice-events'
import type { StartTraining, TrainingChoice } from './scenario-picker'
import { Button } from './ui/button'

export function LearningAction({ record, onStart, onChanged }: {
  record: { id: string; training?: { stage: string }; messages: { id: string; role: string; text: string; final: boolean }[]; coaching?: LiveCoach[] }
  onStart: StartTraining; onChanged: () => void
}) {
  const action = nextAction(record)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const posting = useRef(false), planId = useRef('')
  async function start() {
    if (posting.current) return
    posting.current = true; setBusy(true); setError('')
    try {
      if (!planId.current) {
        const plan = await api<{ id: string }>(`/sessions/${record.id}/retrain`, {
          method: 'POST', body: JSON.stringify({ stage: record.training?.stage, note: action.action }),
        })
        planId.current = plan.id; onChanged()
      }
      onStart(await api<TrainingChoice>(`/remediations/${planId.current}/next`))
    } catch (cause) { setError(`${planId.current ? '任务已建立，可在待练列表继续。' : ''}${cause instanceof Error ? cause.message : '暂时无法准备练习，请重试。'}`) }
    finally { posting.current = false; setBusy(false) }
  }
  return <section aria-label="下一次改什么" className="space-y-3 rounded-lg bg-muted/40 p-4">
    <h2 className="font-medium">下一次只练：{action.focus}</h2>
    {action.quote && <blockquote className="space-y-1 text-sm leading-7"><p className="text-muted-foreground">这次的原话</p><p>“{action.quote}”</p></blockquote>}
    {action.reason && <p className="text-sm leading-7">{action.reason}</p>}
    <p className="text-sm leading-7"><span className="font-medium">下一步动作：</span>{action.action}</p>
    <p className="text-sm leading-6 text-muted-foreground">{action.calibrated ? '量表已校准，仍需在另一情境中无提示验证。' : '量表尚未完成专家校准，反馈用于练习，不能据此认定掌握。'}</p>
    {record.training&&!action.scorable&&<p className="text-sm leading-6 text-muted-foreground">本次尚无有效目标维度。原话已保留，完成一次有效场景练习后再建立针对性任务。</p>}
    {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
    {record.training && action.scorable && <Button className="min-h-11" disabled={busy} onClick={() => void start()}>{busy ? '正在准备…' : '直接练这个动作'}</Button>}
  </section>
}
