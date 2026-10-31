import { useEffect, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import { api } from '@/lib/platform-api'
import type { Scenario } from '@/lib/catalog-types'
import type { TrainingChoice } from '@/components/scenario-picker'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export function ScenariosPage({ onPractice }: { onPractice: (choice: TrainingChoice) => void }) {
  const [rows, setRows] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api<Scenario[]>('/catalog/scenario', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setRows(data.filter(row => row.status === 'published')); setLoading(false) }
    }).catch(cause => {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : '请稍后重试。'); setLoading(false) }
    })
    return () => controller.abort()
  }, [retry])
  const search = query.trim().toLocaleLowerCase()
  const visible = rows.filter(row => [row.title, row.disease, row.product].some(value => value.toLocaleLowerCase().includes(search)))
  return <div className="space-y-5"><p className="breathon-eyebrow">L2 · CLINICAL SCENARIOS</p><PageHeader title="疾病与临床场景" description="阅读训练目标，再进入教练确认资料和演练方式。" />
    <div><Label htmlFor="scenario-search" className="sr-only">搜索疾病、产品或场景</Label><div className="relative"><Search aria-hidden="true" className="absolute top-3 left-3 size-5 text-muted-foreground" /><Input id="scenario-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索疾病、产品或场景" className="bg-card pl-10" /></div></div>
    {loading ? <p role="status">正在加载训练场景…</p> : error ? <Alert variant="destructive"><AlertTitle>无法加载训练场景</AlertTitle><AlertDescription><p>{error}</p><Button variant="outline" onClick={() => { setLoading(true); setError(''); setRetry(value => value + 1) }}>重新加载</Button></AlertDescription></Alert> : visible.length ? <div className="grid gap-4 sm:grid-cols-2">{visible.map(row => <Card key={row.id}><CardHeader><p className="text-sm text-muted-foreground">{row.disease} · {row.product}</p><CardTitle><h2 className="leading-7">{row.title}</h2></CardTitle></CardHeader><CardContent className="space-y-4"><p className="whitespace-pre-wrap text-sm leading-7">{row.objective}</p><Button onClick={() => onPractice({ scenario_id: row.id, stage: 'full' })}>选择此场景<ArrowRight aria-hidden="true" /></Button></CardContent></Card>)}</div> : <Card><CardContent className="space-y-3"><p className="text-sm leading-6 text-muted-foreground">{rows.length ? '没有匹配的场景，请换一个关键词。' : '暂无已发布训练场景。你仍可以选择药品和医生开展练习。'}</p><Button asChild variant="outline"><a href="#practice">进入 AI 教练<ArrowRight aria-hidden="true" /></a></Button></CardContent></Card>}
  </div>
}
