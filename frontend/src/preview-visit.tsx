import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { AppNavigation } from './components/app-navigation'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './components/ui/dialog'
import { VisitSummaryCard, type VisitSummary } from './components/visit-summary-card'

const summary: VisitSummary = {
  total: 83.2,
  overview: '整体表达清楚，需收紧适用人群与医保边界，并先回应医生最关心的问题。',
  dimensions: [
    { key: 'medical', label: '医学准确性', weight: 40, score: 82, weighted_points: 32.8, reason: '适用人群的表述过于宽泛，需要补充边界。' },
    { key: 'compliance', label: '合规性', weight: 30, score: 90, weighted_points: 27, reason: '避免对报销作保证，先核对限定支付范围。' },
    { key: 'communication', label: '沟通技巧', weight: 30, score: 78, weighted_points: 23.4, reason: '先探询关注点，再用简短证据回应。' },
  ],
  edits: [
    { message_id: 'example-1', quote: '这个药所有患者都能用。', category: 'medical', reason: '把特定适用范围扩大到了所有患者。', rewrite: '具体适用人群以当前有效说明书为准。我先确认您关注的人群，再核对适应症和用药限制。' },
    { message_id: 'example-2', quote: '只要开了这个药，医保都会报销。', category: 'compliance', reason: '把纳入医保目录等同于所有用法都能报销。', rewrite: '能否报销还需要核对限定支付范围和当地政策，我确认后再给您准确的信息。' },
    { message_id: 'example-3', quote: '我先把所有研究数据讲完。', category: 'communication', reason: '没有先确认医生的关注点，容易造成信息过量。', rewrite: '您现在更关心适用人群、疗效还是安全性？我先围绕这一点简要说明。' },
  ],
}
export function Preview() {
  const [experience, setExperience] = useState<'practice' | 'combat'>('practice')
  const [dialog, setDialog] = useState('')
  return <div className="min-h-svh bg-muted/30 pt-16 lg:pl-56 lg:pt-0"><AppNavigation page="records" inSession={false}/><main className="mx-auto max-w-[1100px] px-4 py-6 sm:px-8 sm:py-8"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-lg font-semibold">本次复盘</h1><p className="mt-1 text-xs leading-6 text-muted-foreground">卡片样式预览 · 演示数据不计入训练记录</p></div><div className="flex gap-1 rounded-lg border bg-background p-1"><Button variant={experience === 'practice' ? 'secondary' : 'ghost'} className="h-11 sm:h-9" onClick={() => setExperience('practice')}>练习结束</Button><Button variant={experience === 'combat' ? 'secondary' : 'ghost'} className="h-11 sm:h-9" onClick={() => setExperience('combat')}>实战结束</Button></div></div><VisitSummaryCard summary={summary} experience={experience} duration="04:32" example onViewRecord={() => setDialog('查看原话与依据')} onRetrain={() => setDialog('针对这 3 句再练')}/><Dialog open={!!dialog} onOpenChange={open => {if (!open) setDialog('')}}><DialogContent><DialogHeader><DialogTitle>{dialog}</DialogTitle><DialogDescription>{dialog === '查看原话与依据' ? '正式版将定位到对应原话、说明书 / 研究引用与资料版本；示例不提供虚构的医学引用。' : '正式版将以这次的三项改进点进入重练；当前仅展示卡片样式。'}</DialogDescription></DialogHeader></DialogContent></Dialog></main></div>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
