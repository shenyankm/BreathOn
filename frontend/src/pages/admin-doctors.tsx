import { AdminRecords } from '@/components/admin-review'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ResearchPanel } from '@/components/research-panel'
import { api } from '@/lib/platform-api'
import { statusLabels, type Doctor } from '@/lib/catalog-types'
import { ipImage } from '@/bp/images'

type AdminDoctor = Doctor & { ip_profile?: { ip_key: string;area:string;style:string;entry:string;question:string;match:string;tags:string[] } }
export function AdminDoctors() {
  const [area,setArea]=useState('all'),[style,setStyle]=useState('all')
  const detailRef = useRef<HTMLElement>(null)
  const [rows, setRows] = useState<AdminDoctor[]>([]), [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<AdminDoctor[]>('/catalog/doctor', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setRows(data) }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  const matches = rows.filter(row => (area==='all'||row.ip_profile?.area===area)&&(style==='all'||row.ip_profile?.style===style)&&[row.name, row.specialty, row.hospital, row.focus, row.training_style].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const detail = matches.find(row => row.id === selected) ?? matches[0]
  return <div className="space-y-6"><div className="admin-view-head"><div className="admin-heading"><h1>医生画像</h1><p>AI 模拟角色，不代表医生本人。</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading} onClick={() => { setLoading(true); setError(''); setRefresh(value => value + 1) }}>刷新</Button><Button asChild><a href="#workspace?tab=doctor">管理医生画像</a></Button></div></div>
    <div className="admin-panel"><Label className="grid gap-2 text-sm">搜索医生画像<Input value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名、科室、医院或沟通设定" /></Label><div className="mt-4 grid gap-4 sm:grid-cols-2">{[{label:'疾病线',value:area,set:setArea,values:rows.map(r=>r.ip_profile?.area)},{label:'沟通风格',value:style,set:setStyle,values:rows.map(r=>r.ip_profile?.style)}].map(field=><Label key={field.label} className="grid gap-2">{field.label}<Select value={field.value} onValueChange={field.set}><SelectTrigger aria-label={field.label} className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部</SelectItem>{[...new Set(field.values.filter((v):v is string=>!!v))].map(v=><SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></Label>)}</div></div>
    {error ? <p role="alert" className="admin-notice">无法读取医生画像：{error}。请刷新重试。</p> : loading ? <p role="status">正在读取医生画像…</p> : !matches.length ? <div className="admin-panel text-sm text-muted-foreground">{rows.length ? '没有匹配的医生画像，请调整搜索条件。' : '暂无医生画像，请先添加。'}</div> : <div className="admin-doctor-layout"><div className="admin-doctor-grid">{matches.map(row => <button type="button" className="admin-panel admin-doctor-card" key={row.id} aria-pressed={detail?.id === row.id} onClick={() => {
      setSelected(row.id)
      if (window.matchMedia('(max-width: 1250px)').matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start' }))
    }}><img src={ipImage(row.ip_profile?.ip_key)} alt="" loading="lazy" /><div><strong className="block text-sm">{row.name}</strong><p className="my-2 text-xs text-muted-foreground">{row.specialty}</p><Badge variant="secondary">{statusLabels[row.status] ?? row.status}</Badge></div></button>)}</div>{detail && <section ref={detailRef} className="admin-panel admin-doctor-detail space-y-4" aria-label="医生画像详情"><div><h2 className="text-lg font-semibold">{detail.name}</h2><p className="mt-2 text-sm text-muted-foreground">{detail.specialty} · {detail.hospital || '模拟角色'}</p></div><p className="admin-notice">卡片为角色示意图，非本人照片。沟通方式为训练设定。</p><Tabs defaultValue="portrait" key={detail.id}><TabsList className="w-full"><TabsTrigger value="portrait">画像</TabsTrigger><TabsTrigger value="strategy">拜访策略</TabsTrigger><TabsTrigger value="history">沟通记录</TabsTrigger></TabsList><TabsContent value="portrait" className="space-y-4"><div><h3 className="text-sm font-semibold">专业背景</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{detail.public_facts || '暂无公开背景资料'}</p></div><div><h3 className="text-sm font-semibold">训练关注点</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{detail.focus}</p></div><div><h3 className="text-sm font-semibold">沟通设定</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{detail.training_style}</p></div></TabsContent><TabsContent value="strategy" className="space-y-4 text-sm leading-7"><h3 className="font-semibold">推荐拜访路径（训练设定）</h3><p>切入方式：{detail.ip_profile?.entry||detail.training_style}</p><p>关注问题：{detail.ip_profile?.question||detail.focus}</p><p>匹配内容：{detail.ip_profile?.match||'暂无配置，请在医生编辑中补充。'}</p><p className="text-muted-foreground">以已审核的产品资料为依据，确认下一步跟进安排。</p></TabsContent><TabsContent value="history"><AdminRecords key={detail.id} doctorId={detail.id}/></TabsContent></Tabs><Button asChild variant="outline"><a href={`#workspace?tab=doctor&doctor=${encodeURIComponent(detail.id)}`}>查看来源与编辑</a></Button></section>}</div>}
    <Accordion type="single" collapsible><AccordionItem value="research"><AccordionTrigger>资料检索与研究记录</AccordionTrigger><AccordionContent><ResearchPanel /></AccordionContent></AccordionItem></Accordion>
  </div>
}
