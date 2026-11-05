import { AdminRecords } from '@/components/admin-review'
import { ResearchPanel } from '@/components/research-panel'
import { Accordion,AccordionContent,AccordionItem,AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card,CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Item,ItemContent,ItemTitle } from '@/components/ui/item'
import { Label } from '@/components/ui/label'
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select'
import { Tabs,TabsContent,TabsList,TabsTrigger } from '@/components/ui/tabs'
import { statusLabels,type Doctor } from '@/lib/catalog-types'
import { ipImage } from '@/lib/doctor-images'
import { api } from '@/lib/platform-api'
import { useEffect,useRef,useState } from 'react'

type AdminDoctor = Doctor & { ip_profile?: { ip_key: string;area:string;style:string;entry:string;question:string;match:string;tags:string[] } }
export function AdminDoctors() {
  const [area,setArea]=useState('all'),[style,setStyle]=useState('all')
  const detailRef = useRef<HTMLDivElement>(null)
  const [rows, setRows] = useState<AdminDoctor[]>([]), [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<AdminDoctor[]>('/catalog/doctor', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setRows(data) }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  const matches = rows.filter(row => (area==='all'||row.ip_profile?.area===area)&&(style==='all'||row.ip_profile?.style===style)&&[row.name, row.specialty, row.hospital, row.focus, row.training_style].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const detail = matches.find(row => row.id === selected) ?? matches[0]
  return <div className="space-y-6"><div className="flex flex-wrap items-start justify-between gap-3"><Item className="flex-1"><ItemContent><ItemTitle><h1>医生画像</h1></ItemTitle></ItemContent></Item><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading} onClick={() => { setLoading(true); setError(''); setRefresh(value => value + 1) }}>刷新</Button><Button asChild><a href="#workspace?tab=doctor">管理医生画像</a></Button></div></div>
    <Card className="min-w-0"><CardContent className="space-y-4"><Label className="grid gap-2">搜索医生画像<Input value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名、科室、医院或沟通设定" /></Label><div className="mt-4 grid gap-4 sm:grid-cols-2">{[{label:'疾病线',value:area,set:setArea,values:rows.map(r=>r.ip_profile?.area)},{label:'沟通风格',value:style,set:setStyle,values:rows.map(r=>r.ip_profile?.style)}].map(field=><Label key={field.label} className="grid gap-2">{field.label}<Select value={field.value} onValueChange={field.set}><SelectTrigger aria-label={field.label} className="w-full min-h-11"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部</SelectItem>{[...new Set(field.values.filter((v):v is string=>!!v))].map(v=><SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></Label>)}</div></CardContent></Card>
    {error ? <p role="alert" className="p-4 text-sm leading-7">无法读取医生画像：{error}。请刷新重试。</p> : loading ? <p role="status">正在读取医生画像…</p> : !matches.length ? <Card className="min-w-0 text-sm text-muted-foreground"><CardContent className="space-y-4">{rows.length ? '没有匹配的医生画像，请调整搜索条件。' : '暂无医生画像，请先添加。'}</CardContent></Card> : <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]"><div className="grid gap-3 sm:grid-cols-2">{matches.map(row => <Button variant="outline" type="button" className="h-auto min-w-0 flex-col items-stretch justify-start gap-0 overflow-hidden rounded-2xl p-0 text-left whitespace-normal break-words" key={row.id} aria-pressed={detail?.id === row.id} onClick={() => {
      setSelected(row.id)
      if (window.matchMedia('(max-width: 1250px)').matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start' }))
    }}><img src={ipImage(row.ip_profile?.ip_key)} alt="" loading="lazy" className="aspect-[3/4] w-full bg-muted object-contain" /><div className="min-w-0 p-4"><strong className="block text-sm">{row.name}</strong><p className="my-2 text-xs text-muted-foreground">{row.specialty}</p><Badge variant="secondary">{statusLabels[row.status] ?? row.status}</Badge></div></Button>)}</div>{detail && <Card role="region" ref={detailRef} className="min-w-0 xl:sticky xl:top-6 space-y-4" aria-label="医生画像详情"><CardContent className="space-y-4"><div><h2 className="text-lg font-semibold">{detail.name}</h2><p className="mt-2 text-sm text-muted-foreground">{detail.specialty} · {detail.hospital || '模拟角色'}</p></div><p className="p-4 text-sm leading-7">示意图非本人照片，沟通方式为模拟设定。</p><Tabs defaultValue="portrait" key={detail.id}><TabsList className="w-full"><TabsTrigger value="portrait">画像</TabsTrigger><TabsTrigger value="strategy">拜访策略</TabsTrigger><TabsTrigger value="history">沟通记录</TabsTrigger></TabsList><TabsContent value="portrait" className="space-y-4"><div><h3 className="text-sm font-semibold">专业背景</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{detail.public_facts || '暂无公开背景资料'}</p></div>{!!detail.honors?.length && <section className="min-w-0 space-y-3" aria-label="荣誉与奖项"><h3 className="text-sm font-semibold">荣誉与奖项</h3><ul className="min-w-0 space-y-4">{detail.honors.map((honor, index) => <li key={index} className="min-w-0 space-y-2 break-words text-sm leading-7"><p className="font-medium">{honor.name}</p><p className="text-muted-foreground">{honor.organization || '授予机构未载明'} · {honor.year ?? '年份未载明'}</p><blockquote className="whitespace-pre-wrap text-muted-foreground">{honor.quote}</blockquote>{/^https?:\/\//i.test(honor.source_url) && <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={honor.source_url} target="_blank" rel="noreferrer">核对荣誉来源</a>}</li>)}</ul></section>}<div><h3 className="text-sm font-semibold">训练关注点</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{detail.focus}</p></div><div><h3 className="text-sm font-semibold">沟通设定</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{detail.training_style}</p></div></TabsContent><TabsContent value="strategy" className="space-y-4"><h3 className="font-semibold">推荐拜访路径（训练设定）</h3><p>切入方式：{detail.ip_profile?.entry||detail.training_style}</p><p>关注问题：{detail.ip_profile?.question||detail.focus}</p><p>匹配内容：{detail.ip_profile?.match||'暂无配置，请在医生编辑中补充。'}</p></TabsContent><TabsContent value="history"><AdminRecords key={detail.id} doctorId={detail.id}/></TabsContent></Tabs><Button asChild variant="outline"><a href={`#workspace?tab=doctor&doctor=${encodeURIComponent(detail.id)}`}>查看来源与编辑</a></Button></CardContent></Card>}</div>}
    <Accordion type="single" collapsible><AccordionItem value="research"><AccordionTrigger>资料检索与研究记录</AccordionTrigger><AccordionContent><ResearchPanel /></AccordionContent></AccordionItem></Accordion>
  </div>
}
