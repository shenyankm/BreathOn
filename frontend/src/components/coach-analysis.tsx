import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { memo } from 'react'
import { AssessmentView } from './assessment-view'
import { Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { LiveCoach } from '@/lib/voice-events'

export const CoachAnalysis = memo(function CoachAnalysis({ coach, review = false, expanded = false }: { coach: LiveCoach; review?: boolean; expanded?: boolean }) {
  if (coach.superseded) return <p role="status" className="text-sm text-muted-foreground">转录已修正，这条提示已失效，请以更新后的建议或最终复盘为准。</p>
  if (!review && !expanded) return <div className="space-y-3"><p className="text-sm font-medium leading-6">{coach.points[0] || coach.focus}</p>{coach.risk && <p className="text-sm leading-6 text-muted-foreground">需核实：{coach.risk}</p>}<Collapsible><CollapsibleTrigger>查看分析与参考表达</CollapsibleTrigger><CollapsibleContent><CoachAnalysis coach={coach} expanded /></CollapsibleContent></Collapsible></div>
  return <div className="space-y-5">
    {coach.incomplete && <p className="text-sm text-muted-foreground">本次记录不完整，复盘仅覆盖已收到的内容。</p>}
    <section><h2 className="mb-2 text-sm font-medium">观察重点</h2><p className="mb-2 font-medium leading-7">{coach.focus}</p><p className="text-sm leading-7 text-muted-foreground">{coach.analysis}</p></section>
    {coach.delivery && <section><h2 className="mb-3 text-sm font-medium">表达与互动</h2><dl className="space-y-3">{([
      ['tone', '语气与措辞'], ['fluency', '表达连贯性'], ['logic', '论证逻辑'], ['turn_taking', '轮次与插话'],
    ] as const).map(([key, label]) => <div key={key}><dt className="text-sm font-medium">{label}</dt><dd className="mt-1 text-sm leading-7 text-muted-foreground">{coach.delivery?.[key]}</dd></div>)}</dl><p className="mt-3 text-xs leading-6 text-muted-foreground">声音语调未评估；措辞、时序与播放重叠仅作为观察依据。</p></section>}
    <section><h2 className="mb-3 text-sm font-medium">{review ? '重练建议' : '建议回应顺序'}</h2><ol className="list-decimal space-y-2 pl-5 text-sm leading-7">{coach.points.map((point, i) => <li key={i}>{point}</li>)}</ol></section>
    <section><h2 className="mb-2 text-sm font-medium">{review ? '改写示例' : '参考话术'}</h2><p className="text-sm leading-7">{coach.reply}</p><p className="mt-2 text-xs leading-6 text-muted-foreground">仅供沟通训练，医学事实需核对资料原文。</p></section>
    {coach.risk && <Alert><Info /><AlertTitle>需要核实</AlertTitle><AlertDescription>{coach.risk}</AlertDescription></Alert>}
    {!!coach.sources?.length && <section><h2 className="mb-2 text-sm font-medium">检索来源</h2><ul className="space-y-2 text-sm leading-6">{coach.sources.filter(source => /^https?:\/\//i.test(source.url)).map(source => <li key={source.url}><a className="break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4" href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title}<span className="sr-only">（在新标签页打开）</span></a>{source.date && <time className="ml-2 text-xs text-muted-foreground" dateTime={source.date}>{new Date(source.date).toLocaleDateString('zh-CN')}</time>}</li>)}</ul><p className="mt-2 text-xs leading-6 text-muted-foreground">公开网页资料未经产品医学审核，使用前请核对原文与当前有效说明书。</p></section>}
    {coach.assessment && <AssessmentView assessment={coach.assessment} />}
  </div>
})
