import { useEffect, useRef, useState } from 'react'
import { learningLabels, type LearningPlan } from '@/lib/learning'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from './ui/select'
import { Textarea } from './ui/textarea'

export function LearningReview({ id, recordId, messages }: { id: string; recordId: string; messages: {id:string;role:string;text:string;final:boolean}[] }) {
  const [messageId,setMessageId]=useState(''),[quote,setQuote]=useState('')
  const [plan, setPlan] = useState<LearningPlan>(), [reason, setReason] = useState(''), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0), posting = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    api<LearningPlan>(`/admin/remediations/${id}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setPlan(value); setError('') } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取学习状态。') })
    return () => controller.abort()
  }, [id, retry])
  async function review(decision: 'confirm' | 'practice') {
    if (!plan || posting.current) return
    posting.current = true; setBusy(true); setError('')
    try { setPlan(await api<LearningPlan>(`/admin/remediations/${id}/review`, { method: 'POST', body: JSON.stringify({ version: plan.version, decision, reason, message_id:messageId, quote }) })); setReason('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '复核未完成，请重新读取后重试。') }
    finally { posting.current = false; setBusy(false) }
  }
  return <section aria-label="学习表现复核" className="space-y-3">
    <h3 className="font-medium">学习表现复核</h3>
    {error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重新读取学习状态</Button></div>}
    {plan && <><p className="text-sm">{plan.focus_label} · {learningLabels[plan.learning_status ?? 'needs_practice']}</p>
      <p className="text-sm leading-6 text-muted-foreground">核对下方验证原话是否体现目标行为。只确认本次迁移表现，不构成医学审核或能力认证；不能复核自己的记录。</p>
      {plan.learning_review && <div className="space-y-2">{plan.learning_review.quote&&<blockquote className="text-sm leading-7">复核原话：“{plan.learning_review.quote}”</blockquote>}<p className="text-sm leading-7">{plan.learning_review.reason}</p></div>}
      {plan.status === 'awaiting_review' && plan.verification_record_id === recordId && <><Label className="grid gap-2">验证中的学员发言<Select value={messageId} onValueChange={setMessageId}><SelectTrigger className="w-full" aria-label="验证学员发言"><SelectValue placeholder="选择下方待复核的完整原话"/></SelectTrigger><SelectContent>{messages.filter(message=>message.role==='trainee'&&message.final).map(message=><SelectItem key={message.id} value={message.id}>{message.text.slice(0,60)}</SelectItem>)}</SelectContent></Select></Label><Label className="grid gap-2">逐字引用<Textarea aria-label="验证原话引用" value={quote} maxLength={600} onChange={event=>setQuote(event.target.value)}/></Label><Label className="grid gap-2">目标行为与原话依据<Textarea aria-label="学习表现复核理由" minLength={6} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></Label><div className="flex flex-wrap gap-2"><Button disabled={busy || reason.trim().length < 6 || quote.replace(/\s+/gu,'').length<6 || !messageId} onClick={() => void review('confirm')}>确认本次迁移表现</Button><Button variant="outline" disabled={busy || reason.trim().length < 6 || quote.replace(/\s+/gu,'').length<6 || !messageId} onClick={() => void review('practice')}>需要继续验证</Button></div></>}
    </>}
  </section>
}
