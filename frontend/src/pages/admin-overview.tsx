import { useEffect, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/platform-api'
import { statusLabels } from '@/lib/catalog-types'
import { overviewSources, overviewSummary, type SummaryItem } from '@/lib/admin-overview'

export function AdminOverview() {
  const [groups, setGroups] = useState<Record<string, SummaryItem[]>>({})
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [updated, setUpdated] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void Promise.allSettled(overviewSources.map(source => api<SummaryItem[]>(source.path, { signal: controller.signal }))).then(results => {
      if (controller.signal.aborted) return
      const next: Record<string, SummaryItem[]> = {}, failures: string[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') next[overviewSources[index].key] = result.value
        else failures.push(`${overviewSources[index].label}：${result.reason instanceof Error ? result.reason.message : '读取失败'}`)
      })
      setGroups(next); setErrors(failures); setLoading(false); setUpdated(new Date().toLocaleString('zh-CN'))
    })
    return () => controller.abort()
  }, [refresh])
  const { pending, recent } = overviewSummary(groups)
  const metrics = [
    { label: '产品内容', value: groups.drug?.length, note: '工作区药品，含草稿与停用版本', href: '#admin?section=drug' },
    { label: '医生 IP', value: groups.doctor?.length, note: '工作区医生画像，含待发布草稿', href: '#admin?section=doctor' },
    { label: '训练场景', value: groups.scenario?.length, note: '已保存场景，含草稿', href: '#admin?section=training' },
    { label: '待审核', value: pending, note: '与审核队列使用相同统计口径', href: '#admin?section=review' },
  ]
  return <div className="space-y-6">
    <div className="admin-view-head"><div className="admin-heading"><h1>管理后台</h1><p>灵息 BREATHON · 产品、医生 IP、培训和合规内容的统一工作台</p></div><div className="flex flex-wrap gap-2"><details className="relative"><summary className="cursor-pointer rounded-lg border bg-primary px-4 py-2 text-sm text-primary-foreground">添加内容</summary><div className="absolute right-0 z-20 mt-2 grid w-48 gap-1 rounded-xl border bg-card p-2 shadow-md">{[['drug', '添加药品'], ['doctor', '添加医生 IP'], ['training', '创建训练']].map(([section, title]) => <a className="rounded-lg px-3 py-2 text-sm hover:bg-muted" key={section} href={`#admin?section=${section}`}>{title}</a>)}</div></details><Button variant="outline" disabled={loading} onClick={() => { setLoading(true); setErrors([]); setGroups({}); setUpdated(''); setRefresh(value => value + 1) }}><RefreshCw aria-hidden="true" />{loading ? '正在刷新…' : '刷新列表'}</Button></div></div>
    {errors.length > 0 && <div role="alert" className="admin-notice"><p>部分数据未能读取，请刷新重试。未读取的数量显示为「—」。</p>{errors.map(error => <p key={error}>{error}</p>)}</div>}
    <div className="admin-metrics" aria-busy={loading}>{metrics.map(metric => <a href={metric.href} className="admin-metric" key={metric.label}><span>{metric.label}</span><strong>{loading ? '…' : metric.value ?? '—'}</strong><small>{metric.note}</small><ArrowUpRight aria-hidden="true" /></a>)}</div>
    <div className="admin-overview-grid"><section className="admin-panel"><h2 className="text-base font-semibold">常用入口</h2><div className="admin-quick-grid">{[
      ['doctor', '医生 IP 管理', '按科室与沟通设定查看模拟角色'], ['training', '训练内容', '配置资料、场景与评分标准'],
      ['review', '审核队列', '核对医生画像、资料和政策'], ['records', '代表记录', '查看真实保存的演练与转录'],
    ].map(([section, title, note]) => <a className="admin-quick" href={`#admin?section=${section}`} key={section}><strong>{title}<ArrowUpRight aria-hidden="true" /></strong><span>{note}</span></a>)}</div></section>
    <section className="admin-panel"><h2 className="text-base font-semibold">最近内容更新</h2><p className="mt-2 text-xs text-muted-foreground">按目录更新时间排序{errors.length > 0 ? ' · 仅显示读取成功的目录' : ''}</p>{loading ? <p role="status" className="py-8 text-sm">正在读取动态…</p> : recent.length ? <ul className="admin-timeline">{recent.map(item => <li key={`${item.kind}-${item.id}`}><a href={item.href}><strong>{item.display_name || item.name || item.title || item.label}</strong><span>{item.label} · {statusLabels[item.status] ?? item.status} · {new Date(item.updated_at!).toLocaleString('zh-CN')}</span></a></li>)}</ul> : <p className="py-8 text-sm text-muted-foreground">暂无可显示的内容更新。</p>}</section></div>
    {updated && <p className="text-xs text-muted-foreground">最近读取：{updated} · 当前工作区数据</p>}
  </div>
}
