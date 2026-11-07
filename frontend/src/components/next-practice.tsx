import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'

type Next = { kind: string; record_id?: string; focus: string; action: string; reason?: string }
export function NextPractice({ refresh = 0 }: { refresh?: number }) {
  const [next, setNext] = useState<Next>(), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<Next>('/training/next', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setNext(data); setError('') } })
      .catch(() => { if (!controller.signal.aborted) setError('暂时无法读取下一步建议，可在下方选择场景或重试。') })
    return () => controller.abort()
  }, [refresh, retry])
  if (next?.kind === 'task_pending') return null
  return <section aria-label="下一步训练建议" className="space-y-3">
    <h2 className="font-medium">{next?.kind === 'review' ? `接着练：${next.focus}` : next?.focus ?? '先完成一次基线练习'}</h2>
    <p className="text-sm leading-7">{next?.action ?? '先选择一个有效场景，完成后根据原话安排下一步。'}</p>
    {next?.reason && <p className="text-sm leading-6 text-muted-foreground">{next.reason}</p>}
    {next?.record_id && <Button asChild className="min-h-11"><a href={`#records?session=${encodeURIComponent(next.record_id)}`}>查看原话并练这个动作</a></Button>}
    {error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重试建议</Button></div>}
  </section>
}
