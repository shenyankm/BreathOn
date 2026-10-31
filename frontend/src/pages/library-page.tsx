import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, BookOpen, ExternalLink, GraduationCap, Hospital, Landmark, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MedicalLibrary } from '@/components/medical-library'
import { api } from '@/lib/platform-api'

type Drug = { id: string; status: string; name: string; brand: string; aliases: string[]; ownership: 'company' | 'competitor' | 'unknown'; category: string; diseases: string[]; mechanism: string; dosage_form: string; regions: string[]; indications: string[]; overview: string; source_url: string; company: string; manufacturer: string }
type Policy = { id: string; status: string; usable: boolean; title: string; version_label: string; scope: string; source_url: string; issuer: string; document_number: string; level: string; jurisdiction: string; effective_date: string | null; end_date: string | null; legal_status: string; asset_id?: string | null }
type Doctor = { id: string; status: string; name: string; display_name?: string; specialty: string; hospital?: string; professional_title?: string; background_type: string; public_facts: string; focus: string; training_style: string; sources: string[] }
type LibraryDocument = { name: string; content: string; url?: string }
type LoadState<T> = { data: T[]; loading: boolean; error: string }

const skillDocument: LibraryDocument = {
  name: '优秀医药代表必备知识与技能',
  url: 'https://www.yutumed.com/a/21',
  content: '优秀医药代表必备知识与技能\n来源：钰兔科技 · 发布日期：2022-02-24\n\n知识准备：了解行业、疾病与药品，以及公司制度。\n\n技能训练：职业礼仪、时间安排、信息整理与专业拜访。\n\n阅读方向：从访前准备、倾听提问、回应问题，到访后复盘，梳理自己的练习目标。\n\n本页为阅读导览，完整内容请查看原文。外部培训资料不作为现行政策依据。',
}
const modules = [
  { id: 'drugs', mobileName: '药品', name: '药品文档', icon: BookOpen },
  { id: 'medical', mobileName: '核验', name: '医学依据核验', icon: BookOpen },
  { id: 'skills', mobileName: '技能', name: '医药代表技能', icon: GraduationCap },
  { id: 'doctors', mobileName: '医生', name: '医生医院文档', icon: Hospital },
  { id: 'policies', mobileName: '政策', name: '政策文档', icon: Landmark },
]
const emptyState = <T,>(): LoadState<T> => ({ data: [], loading: true, error: '' })
const ownershipLabels = { company: '本公司产品', competitor: '竞品', unknown: '归属待核实' }

function publicLink(value: string | undefined) {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}

function LoadNotice<T>({ state, retry, label }: { state: LoadState<T>; retry: () => void; label: string }) {
  if (state.loading) return <div role="status" className="space-y-4"><p className="text-sm text-muted-foreground">正在加载{label}…</p><div aria-hidden="true" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(index => <Skeleton key={index} className="h-48 rounded-xl" />)}</div></div>
  if (state.error) return <Alert variant="destructive"><AlertCircle aria-hidden="true" /><AlertTitle>无法加载{label}</AlertTitle><AlertDescription><p className="break-words">{state.error}</p><Button variant="outline" className="mt-2 min-h-11" onClick={retry}><RotateCcw aria-hidden="true" />重新加载</Button></AlertDescription></Alert>
  return null
}

export function LibraryPage({ companyOnly = false }: { companyOnly?: boolean }) {
  const [category, setCategory] = useState('drugs')
  const [drugSearch, setDrugSearch] = useState('')
  const [drugOwnership, setDrugOwnership] = useState('all')
  const [policyLevel, setPolicyLevel] = useState('all')
  const [policyArea, setPolicyArea] = useState('all')
  const [drugs, setDrugs] = useState<LoadState<Drug>>(emptyState)
  const [policies, setPolicies] = useState<LoadState<Policy>>(emptyState)
  const [doctors, setDoctors] = useState<LoadState<Doctor>>(emptyState)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<LibraryDocument | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    function load<T>(path: string, setState: (value: LoadState<T>) => void, visible: (row: T) => boolean) {
      api<T[]>(path, { signal: controller.signal }).then(rows => {
        if (!controller.signal.aborted) setState({ data: rows.filter(visible), loading: false, error: '' })
      }).catch(error => {
        if (!controller.signal.aborted) setState({ data: [], loading: false, error: error instanceof Error ? error.message : '请稍后重试。' })
      })
    }
    // Admins can see drafts through the catalog API; the representative library never displays them.
    load<Drug>('/catalog/drug', setDrugs, row => row.status === 'published')
    load<Policy>('/catalog/policy', setPolicies, row => row.status === 'approved' && row.usable === true)
    load<Doctor>('/catalog/doctor', setDoctors, row => row.status === 'published')
    return () => controller.abort()
  }, [retry])

  function openDocument(document: LibraryDocument, button: HTMLButtonElement) {
    openerRef.current = button
    setSelected(document)
    setPreviewOpen(true)
  }
  const recheck = () => { setDrugs(emptyState()); setPolicies(emptyState()); setDoctors(emptyState()); setRetry(value => value + 1) }
  const query = drugSearch.trim().toLocaleLowerCase()
  const filteredDrugs = drugs.data.filter(drug => (companyOnly ? drug.ownership === 'company' : drugOwnership === 'all' || drug.ownership === drugOwnership) &&
    (!query || [drug.name, drug.brand, ...drug.aliases, drug.category, drug.mechanism, ...drug.diseases].some(value => value.toLocaleLowerCase().includes(query))))
  const filteredPolicies = policies.data.filter(policy => (policyLevel === 'all' || policy.level === policyLevel) && (policyArea === 'all' || policy.jurisdiction === policyArea))
  const levels = [...new Set(policies.data.map(policy => policy.level).filter(Boolean))].sort()
  const areas = [...new Set(policies.data.map(policy => policy.jurisdiction).filter(Boolean))].sort()
  const count: Record<string, number | null> = { drugs: drugs.loading || drugs.error ? null : drugs.data.length, medical: null, skills: 1, doctors: doctors.loading || doctors.error ? null : doctors.data.length, policies: policies.loading || policies.error ? null : policies.data.length }

  return <div className="min-w-0 space-y-4 sm:space-y-6">
    <header className="space-y-1.5"><h1 className="text-2xl font-semibold tracking-tight">{companyOnly ? '公司产品' : '资料空间'}</h1></header>
    <Tabs value={category} onValueChange={setCategory} className="min-w-0 gap-4 sm:gap-6">
      <TabsList hidden={companyOnly} className={`${companyOnly ? 'hidden!' : ''} grid h-auto! w-full grid-cols-5 items-stretch gap-1 rounded-2xl p-1`} aria-label="文档分类">
        {modules.map(module => <TabsTrigger key={module.id} value={module.id} aria-label={module.name} className="h-auto min-h-16 min-w-0 flex-col gap-1.5 rounded-xl px-1 py-2 text-xs sm:min-h-12 sm:flex-row sm:gap-2 sm:px-2 sm:text-sm">
          <module.icon aria-hidden="true" className="size-5 sm:size-4" />
          <span className="sm:hidden">{module.mobileName}</span>
          <span className="hidden sm:inline">{module.name}</span>
          {count[module.id] !== null && <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{count[module.id]}</span>}
        </TabsTrigger>)}
      </TabsList>
      <TabsContent value="medical"><MedicalLibrary /></TabsContent>
      <TabsContent value="drugs"><section className="space-y-4 sm:space-y-5" aria-label="药品文档资料">
        <header><h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">药品文档</h2></header>
        <LoadNotice state={drugs} retry={recheck} label="药品" />
        {!drugs.loading && !drugs.error && <><div className="space-y-1"><label htmlFor="drug-search" className="sr-only">搜索药品、疾病或机制</label><div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="drug-search" className="h-11 bg-card pl-9" value={drugSearch} onChange={event => setDrugSearch(event.target.value)} placeholder="搜索药品、别名或疾病" /></div><Accordion type="single" collapsible className={companyOnly ? 'hidden' : 'rounded-none border-0'}><AccordionItem value="drug-filters"><AccordionTrigger className="min-h-11 px-0 py-2 font-normal">产品归属：{drugOwnership === 'all' ? '全部归属' : ownershipLabels[drugOwnership as keyof typeof ownershipLabels]}</AccordionTrigger><AccordionContent><div className="space-y-2"><label htmlFor="drug-ownership" className="text-sm font-medium">产品归属</label><Select value={drugOwnership} onValueChange={setDrugOwnership}><SelectTrigger id="drug-ownership" className="h-11 w-full sm:max-w-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部归属</SelectItem><SelectItem value="company">本公司产品</SelectItem><SelectItem value="competitor">竞品</SelectItem><SelectItem value="unknown">归属待核实</SelectItem></SelectContent></Select></div></AccordionContent></AccordionItem></Accordion></div>
          <p role="status" className="text-sm text-muted-foreground">显示 {filteredDrugs.length} / {companyOnly ? drugs.data.filter(drug => drug.ownership === 'company').length : drugs.data.length} 个产品</p>
          {filteredDrugs.length ? <div className="grid items-start gap-4 sm:grid-cols-2 sm:gap-6 xl:grid-cols-3">{filteredDrugs.map(drug => <Card key={drug.id} className="[--card-spacing:--spacing(4)] sm:[--card-spacing:--spacing(6)]"><CardContent className="flex min-w-0 flex-1 flex-col items-start gap-4"><div><p className="mb-2 text-xs text-muted-foreground">{ownershipLabels[drug.ownership] ?? '归属待核实'} · {drug.category || '治疗领域待补充'}</p><CardTitle className="break-words text-base leading-7"><h3>{drug.name}</h3></CardTitle><CardDescription className="mt-1">{drug.brand || '商品名未提供'}</CardDescription></div><p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{drug.overview || '暂无产品概述。'}</p><dl className="space-y-1 text-sm leading-6"><div><dt className="inline font-medium">机制：</dt><dd className="inline">{drug.mechanism || '待补充'}</dd></div><div><dt className="inline font-medium">疾病：</dt><dd className="inline">{drug.diseases.join('、') || '待补充'}</dd></div></dl><div className="mt-auto flex flex-wrap gap-2"><Button variant="outline" size="sm" className="min-h-11" onClick={event => openDocument({ name: drug.name, content: [`${drug.brand || drug.name} · ${ownershipLabels[drug.ownership] ?? '归属待核实'}`, drug.overview || '暂无产品概述。', `治疗领域：${drug.category || '待补充'}\n机制：${drug.mechanism || '待补充'}\n剂型：${drug.dosage_form || '待补充'}\n地区：${drug.regions.join('、') || '待补充'}\n适应症：${drug.indications.join('、') || '待补充'}`, `相关企业：${drug.company || '待补充'}\n生产企业：${drug.manufacturer || '待补充'}`].join('\n\n'), url: publicLink(drug.source_url) }, event.currentTarget)}>阅读概述</Button>{publicLink(drug.source_url) && <Button asChild variant="outline" size="sm" className="min-h-11"><a href={publicLink(drug.source_url)} target="_blank" rel="noreferrer">查看来源<ExternalLink aria-hidden="true" /></a></Button>}</div></CardContent></Card>)}</div> : <p className="rounded-xl border px-5 py-8 text-sm text-muted-foreground">{drugs.data.length ? '当前筛选下暂无产品，请调整筛选条件。' : '暂无已发布产品，请联系管理员。'}</p>}</>}
      </section></TabsContent>
      <TabsContent value="policies"><section className="space-y-4 sm:space-y-5" aria-label="政策文档资料">
        <header><h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">政策文档</h2><p className="text-sm leading-6 text-muted-foreground sm:mt-2">适用范围以原文及机构要求为准。</p></header>
        <LoadNotice state={policies} retry={recheck} label="政策" />
        {!policies.loading && !policies.error && <><Accordion type="single" collapsible className="bg-card"><AccordionItem value="policy-filters"><AccordionTrigger className="min-h-11 px-4 py-3 font-normal">筛选政策 · {policyLevel === 'all' ? '全部层级' : policyLevel} · {policyArea === 'all' ? '全部范围' : policyArea}</AccordionTrigger><AccordionContent><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label htmlFor="policy-level" className="text-sm font-medium">发布层级</label><Select value={policyLevel} onValueChange={setPolicyLevel}><SelectTrigger id="policy-level" className="h-11 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部层级</SelectItem>{levels.map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><label htmlFor="policy-area" className="text-sm font-medium">适用地域或机构</label><Select value={policyArea} onValueChange={setPolicyArea}><SelectTrigger id="policy-area" className="h-11 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部范围</SelectItem>{areas.map(area => <SelectItem key={area} value={area}>{area}</SelectItem>)}</SelectContent></Select></div></div></AccordionContent></AccordionItem></Accordion><p role="status" className="text-sm text-muted-foreground">显示 {filteredPolicies.length} / {policies.data.length} 份文档</p>
          {filteredPolicies.length ? <div className="grid items-start gap-6 lg:grid-cols-2">{filteredPolicies.map(policy => <Card key={policy.id} className="[--card-spacing:--spacing(4)] sm:[--card-spacing:--spacing(6)]"><CardContent className="flex min-w-0 flex-1 flex-col items-start gap-4"><div><p className="mb-2 text-sm text-muted-foreground">{policy.level || '层级待核对'} · {policy.jurisdiction || '地域待核对'}</p><CardTitle className="break-words text-base leading-7"><h3>{policy.title}</h3></CardTitle></div><dl className="space-y-1.5 text-sm leading-6"><div><dt className="inline font-medium">发布机关：</dt><dd className="inline">{policy.issuer || '待核对'}</dd></div><div><dt className="inline font-medium">文号：</dt><dd className="inline">{policy.document_number || '待核对'}</dd></div><div><dt className="inline font-medium">施行日期：</dt><dd className="inline">{policy.effective_date || '待核对'}</dd></div><div><dt className="inline font-medium">适用范围：</dt><dd className="inline">{policy.scope || '待核对'}</dd></div><div><dt className="inline font-medium">版本：</dt><dd className="inline">{policy.version_label}</dd></div></dl><div className="mt-auto flex flex-wrap gap-2">{publicLink(policy.source_url) && <Button asChild variant="outline" size="sm" className="min-h-11"><a href={publicLink(policy.source_url)} target="_blank" rel="noreferrer">查看原文<ExternalLink aria-hidden="true" /></a></Button>}{policy.asset_id && <Button asChild variant="outline" size="sm" className="min-h-11"><a href={`/api/catalog/policy/${encodeURIComponent(policy.id)}/file`} target="_blank" rel="noreferrer">查看归档文件</a></Button>}</div></CardContent></Card>)}</div> : <p className="rounded-xl border px-5 py-8 text-sm text-muted-foreground">{policies.data.length ? '当前筛选下暂无政策，请调整筛选条件。' : '暂无可用政策，请联系管理员。'}</p>}</>}
      </section></TabsContent>
      <TabsContent value="doctors"><section className="space-y-4 sm:space-y-5" aria-label="医生资料"><header><h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">医生医院文档</h2><p className="text-sm leading-6 text-muted-foreground sm:mt-2">AI 角色不代表真实医生本人。</p></header><LoadNotice state={doctors} retry={recheck} label="医生资料" />{!doctors.loading && !doctors.error && (doctors.data.length ? <div className="grid items-start gap-4 sm:grid-cols-2 sm:gap-6">{doctors.data.map(doctor => <Card key={doctor.id} className="[--card-spacing:--spacing(4)] sm:[--card-spacing:--spacing(6)]"><CardContent className="space-y-3"><CardTitle className="text-base"><h3>{doctor.display_name || doctor.name}</h3></CardTitle><p className="text-sm text-muted-foreground">{[doctor.hospital, doctor.specialty, doctor.professional_title].filter(Boolean).join(' · ')}</p><p className="text-sm leading-6"><span className="font-medium">{doctor.background_type === 'public' ? '公开背景' : '虚构背景'}：</span>{doctor.public_facts || '暂无公开背景。'}</p><p className="text-sm leading-6"><span className="font-medium">模拟训练设定：</span>{doctor.training_style || '暂无'}</p><div className="flex flex-wrap gap-3">{doctor.sources.map((source, index) => publicLink(source) && <a key={source} className="inline-flex min-h-11 items-center gap-1.5 text-sm underline underline-offset-4" href={publicLink(source)} target="_blank" rel="noreferrer">来源 {index + 1}<ExternalLink aria-hidden="true" className="size-3.5" /></a>)}</div></CardContent></Card>)}</div> : <p className="rounded-xl border px-5 py-8 text-sm text-muted-foreground">暂无已发布医生资料，请联系管理员。</p>)}</section></TabsContent>
      <TabsContent value="skills"><section className="space-y-4 sm:space-y-5" aria-label="医药代表技能资料"><h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">医药代表技能</h2><div className="grid items-start gap-4 sm:grid-cols-2 sm:gap-6 xl:grid-cols-3"><Card><CardContent className="space-y-4"><div><CardTitle className="break-words text-base leading-7"><h3>{skillDocument.name}</h3></CardTitle><CardDescription className="mt-2 leading-6">钰兔科技 · 2022-02-24 · 外部培训参考</CardDescription></div><p className="text-sm leading-7 text-muted-foreground">知识准备、职业礼仪、时间管理与专业拜访。</p><div className="grid grid-cols-2 gap-2"><Button variant="outline" size="sm" className="min-h-11" onClick={event => openDocument(skillDocument, event.currentTarget)}>阅读概述</Button><Button asChild variant="outline" size="sm" className="min-h-11"><a href={skillDocument.url} target="_blank" rel="noreferrer">详细文档</a></Button></div></CardContent></Card></div></section></TabsContent>
    </Tabs>
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); openerRef.current?.focus() }} className="inset-0 left-0 top-0 flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 ring-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[85svh] sm:w-full sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:ring-1">
        <DialogHeader className="shrink-0 border-b px-4 pb-4 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:px-6 sm:pt-4">
          <DialogClose asChild><Button variant="ghost" className="-ml-2 min-h-11 self-start"><ArrowLeft aria-hidden="true" />返回资料</Button></DialogClose>
          <DialogTitle className="text-lg leading-7">{selected?.name}</DialogTitle>
          <DialogDescription className="leading-6">具体适用范围和风险请核对来源原文。</DialogDescription>
        </DialogHeader>
        {selected && <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:h-full sm:[&>[data-slot=scroll-area-viewport]]:max-h-[calc(85svh-12rem)]"><article aria-label="文档概述正文" className="space-y-5 whitespace-pre-line px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] text-sm leading-7 sm:px-6">{selected.content.split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}{selected.url && <a className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4" href={selected.url} target="_blank" rel="noreferrer">查看来源原文<ExternalLink aria-hidden="true" className="size-4" /></a>}</article></ScrollArea>}
      </DialogContent>
    </Dialog>
  </div>
}
