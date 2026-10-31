import { isAppDrug } from '@/lib/app-drugs'
import { doctorLabel } from '@/lib/doctor-label'
import { memo, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, BookOpen, ChevronRight, ExternalLink, Hospital, Info, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/platform-api'

type Drug = { id: string; status: string; name: string; brand: string; aliases: string[]; ownership: 'company' | 'competitor' | 'unknown'; category: string; diseases: string[]; mechanism: string; dosage_form: string; regions: string[]; indications: string[]; overview: string; source_url: string; company: string; manufacturer: string }
type Doctor = { id: string; status: string; name: string; display_name?: string; specialty: string; hospital?: string; professional_title?: string; background_type: string; public_facts: string; focus: string; training_style: string; sources: string[] }
type LibraryDocument = { name: string; content: string; url?: string; doctor?: Doctor }
type LoadState<T> = { data: T[]; loading: boolean; error: string }

const modules = [
  { id: 'drugs', mobileName: '药品', name: '药品文档', icon: BookOpen },
  { id: 'doctors', mobileName: '医生', name: '医生医院文档', icon: Hospital },
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

export const LibraryPage = memo(function LibraryPage({ companyOnly = false }: { companyOnly?: boolean }) {
  const [category, setCategory] = useState('drugs')
  const [drugSearch, setDrugSearch] = useState('')
  const [drugOwnership, setDrugOwnership] = useState('all')
  const [drugs, setDrugs] = useState<LoadState<Drug>>(emptyState)
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
    if ((companyOnly || category === 'drugs') && drugs.loading) load<Drug>('/catalog/drug', setDrugs, isAppDrug)
    if (category === 'doctors' && doctors.loading) load<Doctor>('/catalog/doctor', setDoctors, row => row.status === 'published')
    return () => controller.abort()
  }, [category, companyOnly, retry, drugs.loading, doctors.loading])

  function openDocument(document: LibraryDocument, button: HTMLButtonElement) {
    openerRef.current = button
    setSelected(document)
    setPreviewOpen(true)
  }
  const recheck = () => { setDrugs(emptyState()); setDoctors(emptyState()); setRetry(value => value + 1) }
  const query = drugSearch.trim().toLocaleLowerCase()
  const filteredDrugs = drugs.data.filter(drug => (companyOnly ? drug.ownership === 'company' : drugOwnership === 'all' || drug.ownership === drugOwnership) &&
    (!query || [drug.name, drug.brand, ...drug.aliases, drug.category, drug.mechanism, ...drug.diseases].some(value => value.toLocaleLowerCase().includes(query))))
  const count: Record<string, number | null> = { drugs: drugs.loading || drugs.error ? null : drugs.data.length, doctors: doctors.loading || doctors.error ? null : doctors.data.length }

  return <div className="min-w-0 space-y-4 sm:space-y-6">
    <h1 className="sr-only">{companyOnly ? '公司产品' : '资料库'}</h1>
    <Tabs value={category} onValueChange={setCategory} className="min-w-0 gap-4 sm:gap-6">
      <TabsList hidden={companyOnly} className={`${companyOnly ? 'hidden!' : ''} grid h-auto! w-full grid-cols-2 items-stretch gap-1 rounded-2xl p-1`} aria-label="文档分类">
        {modules.map(module => <TabsTrigger key={module.id} value={module.id} aria-label={module.name} className="h-auto min-h-16 min-w-0 flex-col gap-1.5 rounded-xl px-1 py-2 text-xs sm:min-h-12 sm:flex-row sm:gap-2 sm:px-2 sm:text-sm">
          <module.icon aria-hidden="true" className="size-5 sm:size-4" />
          <span className="sm:hidden">{module.mobileName}</span>
          <span className="hidden sm:inline">{module.name}</span>
          {count[module.id] !== null && <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{count[module.id]}</span>}
        </TabsTrigger>)}
      </TabsList>
      <TabsContent value="drugs"><section className="space-y-4 sm:space-y-5" aria-label="药品文档资料">
        <header><h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">药品文档</h2></header>
        <LoadNotice state={drugs} retry={recheck} label="药品" />
        {!drugs.loading && !drugs.error && <><div className="space-y-3"><label htmlFor="drug-search" className="sr-only">搜索药品、疾病或机制</label><div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="drug-search" className="h-11 bg-card pl-9" value={drugSearch} onChange={event => setDrugSearch(event.target.value)} placeholder="搜索药品、别名或疾病" /></div>{!companyOnly && <div role="group" aria-label="产品归属" className="grid grid-cols-4 gap-1 rounded-2xl bg-muted/70 p-1">{[['all', '全部'], ['company', '本公司'], ['competitor', '竞品'], ['unknown', '待核实']].map(([value, label]) => <Button key={value} type="button" variant="ghost" aria-label={value === 'all' ? '全部产品' : ownershipLabels[value as keyof typeof ownershipLabels]} aria-pressed={drugOwnership === value} onClick={() => setDrugOwnership(value)} className={`h-11 min-w-0 rounded-xl px-2 text-sm font-normal ${drugOwnership === value ? 'bg-background text-foreground shadow-sm hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}>{label}</Button>)}</div>}</div>
          <p role="status" className="text-sm text-muted-foreground">显示 {filteredDrugs.length} / {companyOnly ? drugs.data.filter(drug => drug.ownership === 'company').length : drugs.data.length} 个产品</p>
          {filteredDrugs.length ? <div className="grid items-start gap-4 sm:grid-cols-2 sm:gap-6 xl:grid-cols-3">{filteredDrugs.map(drug => <Card key={drug.id} className="[--card-spacing:--spacing(4)] sm:[--card-spacing:--spacing(6)]"><CardContent className="flex min-w-0 flex-1 flex-col items-start gap-4"><div><p className="mb-2 text-xs text-muted-foreground">{ownershipLabels[drug.ownership] ?? '归属待核实'} · {drug.category || '治疗领域待补充'}</p><CardTitle className="break-words text-base leading-7"><h3>{drug.name}</h3></CardTitle><CardDescription className="mt-1">{drug.brand || '商品名未提供'}</CardDescription></div><p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{drug.overview || '暂无产品概述。'}</p><dl className="space-y-1 text-sm leading-6"><div><dt className="inline font-medium">机制：</dt><dd className="inline">{drug.mechanism || '待补充'}</dd></div><div><dt className="inline font-medium">疾病：</dt><dd className="inline">{drug.diseases.join('、') || '待补充'}</dd></div></dl><div className="mt-auto flex flex-wrap gap-2"><Button variant="outline" size="sm" className="min-h-11" onClick={event => openDocument({ name: drug.name, content: [`${drug.brand || drug.name} · ${ownershipLabels[drug.ownership] ?? '归属待核实'}`, drug.overview || '暂无产品概述。', `治疗领域：${drug.category || '待补充'}\n机制：${drug.mechanism || '待补充'}\n剂型：${drug.dosage_form || '待补充'}\n地区：${drug.regions.join('、') || '待补充'}\n适应症：${drug.indications.join('、') || '待补充'}`, `相关企业：${drug.company || '待补充'}\n生产企业：${drug.manufacturer || '待补充'}`].join('\n\n'), url: publicLink(drug.source_url) }, event.currentTarget)}>阅读概述</Button>{publicLink(drug.source_url) && <Button asChild variant="outline" size="sm" className="min-h-11"><a href={publicLink(drug.source_url)} target="_blank" rel="noreferrer">查看来源<ExternalLink aria-hidden="true" /></a></Button>}</div></CardContent></Card>)}</div> : <p className="rounded-xl border px-5 py-8 text-sm text-muted-foreground">{drugs.data.length ? '当前筛选下暂无产品，请调整筛选条件。' : '暂无已发布产品，请联系管理员。'}</p>}</>}
      </section></TabsContent>
      <TabsContent value="doctors"><section className="space-y-4 sm:space-y-5" aria-label="医生资料"><header><h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">医生医院文档</h2><Alert className="border-primary/20 bg-muted/60 p-4 sm:mt-3"><Info aria-hidden="true" className="size-5 text-foreground" /><AlertTitle className="text-base font-semibold">AI 模拟角色，非医生本人</AlertTitle><AlertDescription className="text-sm leading-6 text-foreground/80">仅用于沟通训练，不代表医生本人的观点、诊疗意见或产品推荐。</AlertDescription></Alert></header><LoadNotice state={doctors} retry={recheck} label="医生资料" />{!doctors.loading && !doctors.error && (doctors.data.length ? <div className="grid items-start gap-4 sm:grid-cols-2 sm:gap-6">{doctors.data.map(doctor => <Card key={doctor.id} className="gap-0 overflow-hidden py-0"><Button variant="ghost" className="h-auto min-h-28 w-full justify-between gap-3 rounded-xl px-4 py-5 text-left whitespace-normal sm:px-6" aria-label={`查看${doctorLabel(doctor.display_name || doctor.name)}的资料`} onClick={event => openDocument({ name: doctorLabel(doctor.display_name || doctor.name), content: '', doctor }, event.currentTarget)}><span className="min-w-0 space-y-2"><span className="block break-words text-base font-medium">{doctorLabel(doctor.display_name || doctor.name)}</span><span className="block text-sm leading-6 font-normal text-muted-foreground">{[doctor.hospital, doctor.specialty, doctor.professional_title].filter(Boolean).join(' · ')}</span></span><ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /></Button></Card>)}</div> : <p className="rounded-xl border px-5 py-8 text-sm text-muted-foreground">暂无已发布医生资料，请联系管理员。</p>)}</section></TabsContent>
    </Tabs>
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent fullscreen showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); openerRef.current?.focus({ preventScroll: true }) }} className="inset-0 left-0 top-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 ring-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[85svh] sm:w-full sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:ring-1">
        <DialogHeader className="shrink-0 border-b px-4 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-6 sm:pt-4">
          <DialogClose asChild><Button variant="ghost" className="-ml-2 min-h-11 self-start"><ArrowLeft aria-hidden="true" />{selected?.doctor ? '返回医生列表' : '返回资料'}</Button></DialogClose>
          <DialogTitle className="text-lg leading-7">{selected?.name}</DialogTitle>
          <DialogDescription className="leading-6">{selected?.doctor ? 'AI 模拟角色，非医生本人。仅用于沟通训练。' : '具体适用范围和风险请核对来源原文。'}</DialogDescription>
        </DialogHeader>
        {selected && <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:h-full sm:[&>[data-slot=scroll-area-viewport]]:max-h-[calc(85svh-12rem)]"><article aria-label={selected.doctor ? '医生详情正文' : '文档概述正文'} className="space-y-5 whitespace-pre-line px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] text-sm leading-7 sm:px-6">{selected.doctor ? <>
          <p className="text-muted-foreground">{[selected.doctor.hospital, selected.doctor.specialty, selected.doctor.professional_title].filter(Boolean).join(' · ')}</p>
          <section className="space-y-2"><h3 className="font-medium">{selected.doctor.background_type === 'public' ? '公开背景' : '虚构背景'}</h3><p>{selected.doctor.public_facts || '暂无公开背景。'}</p></section>
          <section className="space-y-2"><h3 className="font-medium">模拟训练设定</h3><p>{selected.doctor.training_style || '暂无'}</p></section>
          {!!selected.doctor.sources.length && <section className="space-y-2"><h3 className="font-medium">资料来源</h3><div className="flex flex-col items-start gap-2">{selected.doctor.sources.map((source, index) => publicLink(source) && <a key={source} className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4" href={publicLink(source)} target="_blank" rel="noreferrer">来源 {index + 1}<ExternalLink aria-hidden="true" className="size-4" /></a>)}</div></section>}
        </> : selected.content.split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}{selected.url && <a className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4" href={selected.url} target="_blank" rel="noreferrer">查看来源原文<ExternalLink aria-hidden="true" className="size-4" /></a>}</article></ScrollArea>}
      </DialogContent>
    </Dialog>
  </div>
})
