import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import type { Assessment } from '@/lib/catalog-types'

export function AssessmentView({ assessment }: {assessment:Assessment}) {
  return <section className="space-y-4 border-t pt-5"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-medium">{assessment.rubric_name}</h3><p className="text-sm tabular-nums">{assessment.total===null?'本轮未形成总分':`${assessment.total.toFixed(1)} / 100`}</p></div><p className="text-xs leading-6 text-muted-foreground">已观察维度权重 {assessment.observed_weight}% · {assessment.calibration_status==='calibrated'?'量表已校准':'量表尚未完成专家校准'}。评分是训练反馈，医学判断仍需专业复核。</p>
    {assessment.validation_errors.length>0&&<p className="text-sm leading-6 text-muted-foreground">部分原话、引用或评分未通过校验，本轮不形成可靠的能力结论。有效观察可在下方核对。</p>}
    <Accordion type="multiple">{assessment.dimensions.map(dimension=><AccordionItem key={dimension.key} value={dimension.key}><AccordionTrigger><span className="flex w-full items-center justify-between gap-3 pr-2 text-left"><span>{dimension.label}</span><span className="shrink-0 tabular-nums text-muted-foreground">{dimension.score===null?'未评分':`${dimension.score} / 4`}</span></span></AccordionTrigger><AccordionContent className="space-y-4">
      <p className="text-sm leading-7">{dimension.reason}</p>{dimension.anchor&&<p className="text-xs leading-6 text-muted-foreground">对应锚点：{dimension.anchor}</p>}
      {dimension.utterances.map((quote,index)=><blockquote key={index} className="space-y-1 rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">学员原话</p><p className="whitespace-pre-wrap text-sm leading-7">{quote.quote}</p></blockquote>)}
      {dimension.citations.map((citation,index)=><div key={index} className="space-y-2 rounded-lg border p-3"><p className="text-xs leading-6 text-muted-foreground">{citation.title} · {citation.version_label} · 第 {citation.page} 页</p><blockquote className="whitespace-pre-wrap text-sm leading-7">{citation.quote}</blockquote>{/^https?:\/\//.test(citation.source_url)&&<a className="text-xs underline underline-offset-4" href={citation.source_url} target="_blank" rel="noopener noreferrer">查看外部原文<span className="sr-only">（新标签页打开）</span></a>}</div>)}
    </AccordionContent></AccordionItem>)}</Accordion>
  </section>
}
