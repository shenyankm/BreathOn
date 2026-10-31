import { ArrowRight, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export type VisitSummary = {
  total: number | null
  overview: string
  dimensions: { key: string; label: string; weight: number; score: number | null; reason: string; weighted_points: number | null }[]
  edits: { message_id: string; quote: string; category: string; reason: string; rewrite: string }[]
}
const categories: Record<string, string> = { medical: '医学准确性', compliance: '合规性', communication: '沟通技巧' }

export function VisitSummaryCard({ summary, experience, duration, example = false, onViewRecord, onRetrain }: {
  summary: VisitSummary; experience: 'practice' | 'combat'; duration: string; example?: boolean; onViewRecord?: () => void; onRetrain?: () => void
}) {
  return <Card className="gap-0 overflow-hidden py-0">
    <CardHeader className="gap-5 px-6 pt-6 pb-5 sm:px-8 sm:pt-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm text-muted-foreground"><span>{experience === 'practice' ? '练习' : '实战'}已结束</span><span aria-hidden="true">·</span><span className="tabular-nums">{duration}</span></div><Badge variant="outline">{example ? '示例数据' : 'AI 训练反馈'}</Badge></div>
      <div className="flex items-start justify-between gap-5"><div className="space-y-2"><CardTitle className="text-xl sm:text-2xl"><h2>拜访复盘评分卡</h2></CardTitle><p className="max-w-xl text-sm leading-7 text-muted-foreground">{summary.overview}</p></div><div className="shrink-0 text-right"><p className="text-3xl font-medium tracking-tight tabular-nums sm:text-4xl">{summary.total === null ? '—' : summary.total.toFixed(1)}<span className="ml-1 text-sm font-normal text-muted-foreground">/ 100</span></p><p className="mt-2 text-xs text-muted-foreground">{summary.total === null ? '依据不足，暂不形成总分' : '三维加权总分'}</p></div></div>
    </CardHeader>
    <CardContent className="space-y-6 px-6 pb-6 sm:px-8 sm:pb-7">
      <div className="grid divide-y rounded-xl border sm:grid-cols-3 sm:divide-x sm:divide-y-0">{summary.dimensions.map(dimension => <div key={dimension.key} className="space-y-3 px-4 py-4 sm:px-5"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{dimension.label}</h3><span className="text-xs tabular-nums text-muted-foreground">{dimension.weight}%</span></div><p className="text-2xl font-medium tabular-nums">{dimension.score ?? '—'}<span className="ml-1 text-xs font-normal text-muted-foreground">/ 100</span></p><div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-foreground/75" style={{ width: `${dimension.score ?? 0}%` }}/></div><p className="text-xs leading-6 text-muted-foreground">{dimension.reason}</p></div>)}</div>
      <section className="space-y-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold">最该改的 3 句话</h2><p className="text-xs text-muted-foreground">保留原话，把建议落到下一次表达</p></div>
        <ol className="divide-y rounded-xl border">{summary.edits.map((edit, index) => <li key={`${edit.message_id}-${index}`} className="flex gap-3 px-4 py-5 sm:gap-4 sm:px-5"><span className="pt-0.5 text-sm tabular-nums text-muted-foreground">{index + 1}.</span><div className="min-w-0 flex-1 space-y-2.5"><div className="flex flex-wrap items-center gap-x-3 gap-y-2"><h3 className="text-sm font-medium leading-7">“{edit.quote}”</h3><Badge variant="outline" className={edit.category === 'medical' ? 'border-destructive/25 text-destructive' : ''}>{categories[edit.category] ?? edit.category}</Badge></div><p className="text-xs leading-6 text-muted-foreground">{edit.reason}</p><div className="rounded-lg bg-muted/50 px-3 py-2.5"><p className="mb-1 text-xs font-medium">建议改为</p><p className="text-sm leading-7">{edit.rewrite}</p></div></div></li>)}</ol>
        {summary.edits.length < 3 && <p className="text-xs leading-6 text-muted-foreground">本次只有 {summary.edits.length} 条可核对的改进原话，其余不补造。</p>}
      </section>
      <div className="flex flex-col justify-between gap-4 border-t pt-5 sm:flex-row sm:items-center"><p className="max-w-lg text-xs leading-6 text-muted-foreground">{example ? '以下为虚构演示，不对应真实药品、患者或实际训练成绩。' : '评分仅用于训练；医学依据不足的维度不评分，结论需专业复核。'}</p><div className="flex shrink-0 flex-wrap gap-2">{onViewRecord && <Button variant="outline" onClick={onViewRecord}>查看原话与依据<ArrowRight className="size-4"/></Button>}{onRetrain && <Button onClick={onRetrain}><RotateCcw className="size-4"/>针对这 3 句再练</Button>}</div></div>
    </CardContent>
  </Card>
}
