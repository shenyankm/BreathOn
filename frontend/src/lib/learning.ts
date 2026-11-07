import type { LiveCoach } from './voice-events'

export const learningLabels: Record<string, string> = {
  needs_practice: '继续巩固', needs_verification: '待新情境验证', awaiting_review: '待培训师复核', verified: '本次迁移表现已复核',
}
export type LearningPlan = {
  id: string; version: number; status: string; learning_status?: string; focus_label: string; stage: string; note: string
  parent_record_id: string; practice_record_id?: string; verification_record_id?: string
  learning_review?: { reason: string; actor: string; decision: string; quote?: string }
}
export function nextAction(record: { coaching?: LiveCoach[]; messages: { id: string; role: string; text: string; final: boolean }[] }) {
  const latest = record.coaching?.findLast(row => row.final_report)
  const coach = latest?.superseded || latest?.degraded ? undefined : latest
  const dimension = coach?.assessment?.dimensions.filter(row => typeof row.score==='number' && Number.isInteger(row.score) && row.score>=0 && row.score<=4).sort((a, b) => a.score! - b.score!)[0]
  const compact = (text: string) => text.replace(/\s+/gu, '')
  const normalized = new Map<string, string>()
  const sourceText = (text: string) => {
    let value = normalized.get(text)
    if (value === undefined) { value = compact(text); normalized.set(text, value) }
    return value
  }
  const quote = dimension?.utterances.find(quote => {
    const text = compact(quote.quote)
    return text.length >= 6 && record.messages.some(message => message.id === quote.message_id &&
      message.role === 'trainee' && message.final && sourceText(message.text).includes(text))
  })
  return { scorable:!!dimension && !coach?.assessment?.validation_errors?.length, focus: dimension?.label ?? coach?.focus ?? '回应结构', quote: quote?.quote,
    action: coach?.points?.[0] ?? '先核对原话与本次目标，再明确下一次要完成的一个动作。',
    reason: dimension?.reason, calibrated: coach?.assessment?.calibration_status === 'calibrated' }
}
