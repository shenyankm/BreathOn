import { stages } from '@/lib/catalog-types'
import { learningLabels, type LearningPlan } from '@/lib/learning'
import { api } from '@/lib/platform-api'
import { useEffect, useRef, useState } from 'react'
import type { StartTraining, TrainingChoice } from './scenario-picker'
import { Button } from './ui/button'

export function RetrainingList({ onStart, refresh = 0, compact = false, onChanged }: {
  onStart: StartTraining; refresh?: number; compact?: boolean; onChanged?: () => void
}) {
  const [plans, setPlans] = useState<LearningPlan[]>([]), [error, setError] = useState(''), [failedId, setFailedId] = useState('')
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0)
  const posting = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    api<LearningPlan[]>('/remediations', { signal: controller.signal }).then(rows => {
      if (!controller.signal.aborted) { setPlans(rows.filter(plan => ['assigned', 'awaiting_verification', 'awaiting_review'].includes(plan.status))); setError('') }
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : '重练加载失败'); setFailedId('') } })
    return () => controller.abort()
  }, [refresh, retry])
  async function act(plan: LearningPlan, action: 'next' | 'archive' | 'restart') {
    if (posting.current) return
    posting.current = true; setBusy(true); setError(''); setFailedId(plan.id)
    try {
      const result = await api<TrainingChoice>(`/remediations/${plan.id}/${action}`, action === 'next' ? {} : { method: 'POST', body: '{}' })
      if (action !== 'next') { setRetry(value => value + 1); onChanged?.() }
      if (action !== 'archive') onStart(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。') }
    finally { posting.current = false; setBusy(false) }
  }
  if (!plans.length && !error) return null
  return <section aria-label="待重练任务" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">待重练{plans.length ? ` · ${plans.length} 项` : ''}</h2>{compact && plans.length > 1 && <a className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href="#records">查看全部</a>}</div>
    {error && !failedId && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" disabled={busy} onClick={() => setRetry(value => value + 1)}>重新读取重练任务</Button></div>}
    {(compact ? plans.slice(0, 1) : plans).map(plan => <article key={plan.id} className="space-y-3 py-3">
      <h3 className="text-sm font-medium">{plan.focus_label} · {stages[plan.stage] ?? '完整拜访'}</h3>
      <p className="text-sm">{learningLabels[plan.learning_status ?? 'needs_practice']}</p>
      <p className="break-words text-sm leading-6 text-muted-foreground">{plan.note}</p>
      {plan.status === 'awaiting_verification' && <p className="text-sm leading-6 text-muted-foreground">接下来换一个情境，关闭实时辅助；通过后仍需培训师复核。</p>}
      {plan.status === 'awaiting_review' && <p className="text-sm leading-6 text-muted-foreground">无提示验证已记录，等待培训师核对原话；尚不表示能力认证。</p>}
      <div className="flex flex-wrap gap-2">
        {plan.status !== 'awaiting_review' && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void act(plan, 'next')}>{plan.status === 'awaiting_verification' ? '开始新情境验证' : '开始重练'}</Button>}
        <Button asChild variant="ghost" className="min-h-11"><a href={`#records?session=${encodeURIComponent(plan.verification_record_id ?? plan.parent_record_id)}`}>查看原记录与前后对比</a></Button>
        <Button variant="ghost" className="min-h-11" disabled={busy} onClick={() => void act(plan, 'archive')}>归档任务</Button>
      </div>
      {failedId === plan.id && error && <div role="alert" className="space-y-3"><p className="text-sm leading-6 text-destructive">{error}</p><p className="text-sm leading-6">旧记录与对比会保留。按当前版本开始后，新的记录作为新基线，不与旧版本混算。</p><Button variant="outline" disabled={busy} className="min-h-11" onClick={() => void act(plan, 'restart')}>按当前版本重新练习</Button></div>}
    </article>)}
  </section>
}
