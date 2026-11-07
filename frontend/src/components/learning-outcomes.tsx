import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from './ui/button'

type Outcomes = { first_saved_users:number;first_saved_valid:number;practice_attempts:number;repeated_weakness:number;transfer_attempts:number;transfer_observed:number;return_eligible:number;returned_second_week:number;saved_attempts: number; valid_attempts: number; reviewed_records: number; reviewed_then_retrained: number;
  needs_practice: number; needs_verification: number; awaiting_review: number; verified: number; scope: string }
export function LearningOutcomes() {
  const [data, setData] = useState<Outcomes>(), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<Outcomes>('/training/outcomes', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setData(value); setError('') } })
      .catch(() => { if (!controller.signal.aborted) setError('训练闭环统计暂时无法读取。') })
    return () => controller.abort()
  }, [refresh])
  return <section aria-label="训练闭环统计" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">累计训练闭环</h2><Button variant="ghost" onClick={() => setRefresh(value => value + 1)}>刷新统计</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data ? <p role="status" className="text-sm text-muted-foreground">正在读取训练记录…</p> : <>
      <dl className="grid grid-cols-2 gap-4">{[
        ['首条记录有效 / 有记录用户',`${data.first_saved_valid} / ${data.first_saved_users}`],
        ['目标仍需巩固或核实 / 有效重练',`${data.repeated_weakness} / ${data.practice_attempts}`],
        ['观察到目标行为 / 有效无提示验证',`${data.transfer_observed} / ${data.transfer_attempts}`],
        ['次周回练 / 已满14天用户',data.return_eligible?`${data.returned_second_week} / ${data.return_eligible}`:'尚无完整观察样本'],
        ['有效训练 / 已保存尝试', `${data.valid_attempts} / ${data.saved_attempts}`],
        ['看过复盘后建立重练 / 看过复盘', `${data.reviewed_then_retrained} / ${data.reviewed_records}`],
        ['仍需巩固', data.needs_practice], ['待新情境验证', data.needs_verification],
        ['待培训师复核', data.awaiting_review], ['迁移表现已复核', data.verified],
      ].map(([label, value]) => <div key={label}><dt className="text-sm leading-6 text-muted-foreground">{label}</dt><dd className="mt-1 text-lg tabular-nums">{value}</dd></div>)}</dl>
      <p className="text-sm leading-6 text-muted-foreground">{data.scope}</p>
    </>}
  </section>
}
