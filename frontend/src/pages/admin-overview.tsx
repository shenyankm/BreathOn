import { Button } from '@/components/ui/button'
import { Card,CardContent } from '@/components/ui/card'
import { DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Item,ItemContent,ItemDescription,ItemTitle } from '@/components/ui/item'
import { overviewSources,overviewSummary,type SummaryItem } from '@/lib/admin-overview'
import { statusLabels } from '@/lib/catalog-types'
import { api } from '@/lib/platform-api'
import { ArrowUpRight,RefreshCw } from 'lucide-react'
import { useEffect,useState } from 'react'

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
    { label: '产品内容', value: groups.drug?.length, href: '#admin?section=drug' },
    { label: '医生 IP', value: groups.doctor?.length, href: '#admin?section=doctor' },
    { label: '训练场景', value: groups.scenario?.length, href: '#admin?section=training' },
    { label: '待审核', value: pending, href: '#admin?section=review' },
  ]
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><Item className="flex-1"><ItemContent><ItemTitle><h1>管理后台</h1></ItemTitle><ItemDescription>{updated && <span>更新于 {updated}</span>}</ItemDescription></ItemContent></Item><div className="flex flex-wrap gap-2"><DropdownMenu><DropdownMenuTrigger asChild><Button>添加内容</Button></DropdownMenuTrigger><DropdownMenuContent align="end">{[['drug', '添加药品'], ['doctor', '添加医生 IP'], ['training', '创建训练']].map(([section, title]) => <DropdownMenuItem asChild key={section}><a href={`#admin?section=${section}`}>{title}</a></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu><Button variant="outline" disabled={loading} onClick={() => { setLoading(true); setErrors([]); setGroups({}); setUpdated(''); setRefresh(value => value + 1) }}><RefreshCw aria-hidden="true" />{loading ? '正在刷新…' : '刷新列表'}</Button></div></div>
    {errors.length > 0 && <Card role="alert" className="text-sm leading-7"><CardContent className="space-y-4"><p>部分数据未能读取，请刷新重试。未读取的数量显示为「—」。</p>{errors.map(error => <p key={error}>{error}</p>)}</CardContent></Card>}
    <section aria-label="内容统计"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy={loading}>{metrics.map(metric => <a href={metric.href} className="relative grid gap-2 p-4 [&>span]:text-sm [&>span]:text-muted-foreground [&>strong]:text-3xl [&>strong]:tabular-nums [&>svg]:absolute [&>svg]:right-4 [&>svg]:top-4 [&>svg]:size-4" key={metric.label}><span>{metric.label}</span><strong>{loading ? '…' : metric.value ?? '—'}</strong><ArrowUpRight aria-hidden="true" /></a>)}</div><p className="mt-3 text-xs text-muted-foreground">数量含草稿、停用版本。</p></section>
    <Card className="min-w-0"><CardContent className="space-y-4"><h2 className="text-base font-semibold">常用入口</h2><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
      ['doctor', '医生 IP 管理'], ['training', '训练内容'], ['review', '审核队列'], ['records', '代表记录'],
    ].map(([section, title]) => <a className="p-4 [&>strong]:flex [&>strong]:items-center [&>strong]:justify-between [&_svg]:size-4" href={`#admin?section=${section}`} key={section}><strong>{title}<ArrowUpRight aria-hidden="true" /></strong></a>)}</div></CardContent></Card>
    <Card className="min-w-0"><CardContent className="space-y-4"><h2 className="text-base font-semibold">最近内容更新</h2>{errors.length > 0 && <p className="mt-2 text-xs text-muted-foreground">仅显示读取成功的目录</p>}{loading ? <p role="status" className="py-8 text-sm">正在读取动态…</p> : recent.length ? <ul className="mt-4 divide-y [&_a]:flex [&_a]:flex-wrap [&_a]:items-baseline [&_a]:gap-x-4 [&_a]:gap-y-1 [&_a]:py-3 [&_strong]:flex-1 [&_strong]:basis-48 [&_span]:text-sm [&_span]:text-muted-foreground [&_time]:text-xs [&_time]:text-muted-foreground">{recent.map(item => <li key={`${item.kind}-${item.id}`}><a href={item.href}><strong>{item.display_name || item.name || item.title || item.label}</strong><span>{item.label} · {statusLabels[item.status] ?? item.status}</span><time dateTime={item.updated_at}>{new Date(item.updated_at!).toLocaleString('zh-CN')}</time></a></li>)}</ul> : <p className="py-8 text-sm text-muted-foreground">暂无可显示的内容更新。</p>}</CardContent></Card>
  </div>
}
