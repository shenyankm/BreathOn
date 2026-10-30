import { useRef, useState } from 'react'
import { BookOpen, GraduationCap, Hospital, Landmark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { drugs, drugCatalogueCheckedAt, drugCatalogueSource, type Drug } from '@/lib/drugs'
import { filterPolicies, policyCategories, policyDocuments, policyLevels } from '@/lib/policies'
import { MedicalLibrary } from '@/components/medical-library'

type LibraryDocument = { id: string; name: string; url: string; description: string; kind: 'text'; content: string; drug?: Drug }
const drugImages = import.meta.glob<string>('../assets/library/innovent/*.{jpg,png}', { eager: true, query: '?url', import: 'default' })
const skillDocuments: LibraryDocument[] = [{
  id: 'medical-representative-skills', kind: 'text', name: '优秀医药代表必备知识与技能',
  url: 'https://www.yutumed.com/a/21', description: '钰兔科技 · 2022-02-24 · 外部培训参考',
  content: '优秀医药代表必备知识与技能\n来源：钰兔科技 · 发布日期：2022-02-24\n\n知识准备：了解行业、疾病与药品，以及公司制度。\n\n技能训练：职业礼仪、时间安排、信息整理与专业拜访。\n\n阅读方向：从访前准备、倾听提问、回应问题，到访后复盘，梳理自己的练习目标。\n\n本页为阅读导览，完整内容请查看原文。外部培训资料不作为现行政策依据。',
}]
const modules = [
  { id: 'drugs', name: '药品文档', icon: BookOpen, count: drugs.length },
  { id: 'medical', name: '医学依据核验', icon: BookOpen, count: null },
  { id: 'skills', name: '医药代表技能', icon: GraduationCap, count: skillDocuments.length },
  { id: 'doctors', name: '医生医院文档', icon: Hospital, count: 0 },
  { id: 'policies', name: '政策文档', icon: Landmark, count: policyDocuments.length },
]

export function LibraryPage() {
  const [category, setCategory] = useState('drugs')
  const [policyLevel, setPolicyLevel] = useState('all')
  const [policyCategory, setPolicyCategory] = useState('all')
  const filteredPolicies = filterPolicies(policyLevel, policyCategory)
  const policiesFiltered = policyLevel !== 'all' || policyCategory !== 'all'
  // Retain the document while Radix plays its exit animation.
  const [selected, setSelected] = useState<LibraryDocument | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)

  function clearPolicyFilters() {
    setPolicyLevel('all')
    setPolicyCategory('all')
  }

  function openDocument(document: LibraryDocument, button: HTMLButtonElement) {
    openerRef.current = button
    setSelected(document)
    setPreviewOpen(true)
  }

  return <div className="space-y-6">
    <Tabs value={category} onValueChange={setCategory}>
      <div className="pb-4"><TabsList className="grid h-auto! w-full grid-cols-2 sm:flex sm:w-auto sm:flex-wrap" aria-label="文档分类">{modules.map(module => <TabsTrigger key={module.id} value={module.id} className="min-h-11 gap-2 px-3 sm:px-5"><module.icon />{module.name}{module.count !== null && <span className="ml-1 text-xs text-muted-foreground">{module.count}</span>}</TabsTrigger>)}</TabsList></div>
      {modules.map(module => <TabsContent key={module.id} value={module.id}>
        {module.id === 'medical' ? <MedicalLibrary/> : module.id === 'drugs' ? <section className="space-y-5"><header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">药品文档</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{drugCatalogueCheckedAt} 核对 · <a className="underline underline-offset-4" href={drugCatalogueSource} target="_blank" rel="noreferrer">官网产品清单</a></p></div><Button asChild variant="outline" className="h-11"><a href="#workspace?tab=research&agent=drug">查找同类药品</a></Button></header><div className="grid auto-rows-fr grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4" aria-label="药品列表">{drugs.map(drug => <Card key={drug.id} className="gap-0 overflow-hidden py-0">
          <div className="relative aspect-[4/3] w-full shrink-0 sm:aspect-[4/5]"><img src={drugImages[`../assets/library/innovent/${drug.image}`]} alt={`${drug.brand}${drug.name}${drug.imageLabel ?? '产品图'}`} loading="lazy" decoding="async" className="absolute inset-0 size-full object-contain p-4" />{drug.imageLabel && <span className="absolute right-3 bottom-3 rounded bg-background px-2 py-1 text-xs text-muted-foreground">{drug.imageLabel}</span>}</div>
          <CardContent className="flex flex-1 flex-col gap-4 border-t p-4"><div><CardTitle className="text-base leading-6"><h2>{drug.name}</h2></CardTitle><CardDescription className="mt-1.5">{drug.brand}</CardDescription></div><div className="mt-auto space-y-2"><p className="text-xs text-muted-foreground">{drug.document.label}</p><div className="grid grid-cols-2 gap-2"><Button variant="outline" size="sm" aria-label={`查看${drug.brand}概述`} onClick={event => openDocument({ id: `${drug.id}-overview`, kind: 'text', name: `${drug.name} · ${drug.brand}`, url: drugCatalogueSource, description: '官方公开资料摘编', content: `${drug.category} · ${drug.target}\n\n${drug.overview}`, drug }, event.currentTarget)}>概述</Button><Button asChild variant="outline" size="sm"><a href={drug.document.url} target="_blank" rel="noreferrer" aria-label={`查看${drug.brand}${drug.document.label}（在新标签页打开）`}>详细文档</a></Button></div></div></CardContent>
        </Card>)}</div></section> : module.id === 'skills' ? <section className="space-y-5" aria-label="医药代表技能资料">
          <h1 className="text-2xl font-semibold">医药代表技能</h1>
          <div className="grid items-start gap-6 sm:grid-cols-2 lg:grid-cols-4">{skillDocuments.map(document => <Card key={document.id}><CardContent className="space-y-4">
            <div><CardTitle className="text-base leading-7">{document.name}</CardTitle><CardDescription className="mt-2 leading-6">{document.description}</CardDescription></div>
            <p className="text-sm leading-7 text-muted-foreground">知识准备、职业礼仪、时间管理与专业拜访。</p>
            <div className="grid grid-cols-2 gap-2"><Button variant="outline" size="sm" onClick={event => openDocument(document, event.currentTarget)}>概述</Button><Button asChild variant="outline" size="sm"><a href={document.url} target="_blank" rel="noreferrer">详细文档</a></Button></div>
          </CardContent></Card>)}</div>
        </section> : module.id === 'policies' ? <section className="space-y-5" aria-label="政策文档资料">
          <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">政策文档</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">政策可能更新，实际适用请核对原文及目标机构的最新要求。</p></div><Button asChild variant="outline" className="h-11"><a href="#workspace?tab=research&agent=policy">检索与追踪政策</a></Button></header>
          <div className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2"><label htmlFor="policy-level" className="text-sm font-medium">发布层级</label><Select value={policyLevel} onValueChange={setPolicyLevel}><SelectTrigger id="policy-level" className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部层级（{filterPolicies('all', policyCategory).length}）</SelectItem>{policyLevels.map(level => <SelectItem key={level} value={level}>{level}（{filterPolicies(level, policyCategory).length}）</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><label htmlFor="policy-category" className="text-sm font-medium">政策分类</label><Select value={policyCategory} onValueChange={setPolicyCategory}><SelectTrigger id="policy-category" className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部分类（{filterPolicies(policyLevel, 'all').length}）</SelectItem>{policyCategories.map(topic => <SelectItem key={topic} value={topic}>{topic}（{filterPolicies(policyLevel, topic).length}）</SelectItem>)}</SelectContent></Select></div>
            </div>
            {policiesFiltered && <Button variant="outline" className="h-11 self-start sm:self-auto" onClick={clearPolicyFilters}>清除筛选</Button>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><p role="status" aria-live="polite">显示 {filteredPolicies.length} / {policyDocuments.length} 份文档</p></div>
          {filteredPolicies.length ? <div className="grid auto-rows-fr gap-4 lg:grid-cols-2">{filteredPolicies.map(document => <Card key={document.url}>
            <CardContent className="flex flex-1 flex-col items-start gap-4">
              <div><p className="mb-2 text-sm text-muted-foreground">{document.level} · {document.category}</p><CardTitle className="text-base leading-7"><h2>{document.title}</h2></CardTitle></div>
              <p className="text-sm leading-6 text-muted-foreground">{document.summary}</p>
              <dl className="space-y-1.5 text-sm leading-6"><div><dt className="inline font-medium">来源：</dt><dd className="inline">{document.source}</dd></div><div><dt className="inline font-medium">实施时间：</dt><dd className="inline">{document.effectiveDate}</dd></div><div><dt className="inline font-medium">适用范围：</dt><dd className="inline">{document.scope}</dd></div></dl>
              <Button asChild variant="outline" size="sm" className="mt-auto"><a href={document.url} target="_blank" rel="noreferrer" aria-label={`查看${document.title}原文（在新标签页打开）`}>查看原文</a></Button>
            </CardContent>
          </Card>)}</div> : <div className="space-y-3 rounded-xl border px-5 py-8"><h2 className="font-medium">当前筛选下暂无文档</h2><p className="text-sm leading-7 text-muted-foreground">可以更换层级或分类，或清除筛选查看全部资料。</p><Button variant="outline" onClick={clearPolicyFilters}>查看全部文档</Button></div>}
        </section> : <Card><CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 py-16 text-center"><module.icon className="mb-2 size-7 text-muted-foreground" /><h2 className="font-medium">暂无{module.name}</h2><Button asChild variant="outline" className="h-11"><a href="#workspace?tab=research&agent=doctor">查找医生公开资料</a></Button></CardContent></Card>}
      </TabsContent>)}
    </Tabs>
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); openerRef.current?.focus() }} aria-describedby={undefined} className="flex flex-col gap-0 p-6 pt-12 sm:max-w-3xl">
      <DialogTitle className={selected?.drug ? 'mb-4 text-xl leading-8' : 'sr-only'}>{selected?.name}</DialogTitle>
      {selected?.kind === 'text' ? <ScrollArea className="min-h-0 [&>[data-slot=scroll-area-viewport]]:max-h-[calc(88vh-4.5rem)]"><article aria-label="文档概述正文" className="space-y-5 pr-3 text-sm leading-7">{selected.content.trim().split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}{selected.drug && <footer className="space-y-2 border-t pt-4 text-muted-foreground"><p>公开资料摘编 · {drugCatalogueCheckedAt} 核对 · 待医学审核</p>{selected.drug.document.note && <p>{selected.drug.document.note}</p>}<p>具体适应症、用法与风险请核对原文。{selected.drug.document.label === '患者手册（非说明书）' && '当前详细文档为患者手册，不替代说明书。'}</p><div className="flex flex-wrap gap-x-5 gap-y-2"><a href={selected.drug.document.sourceUrl ?? drugCatalogueSource} target="_blank" rel="noreferrer" className="underline underline-offset-4">{selected.drug.document.sourceName ?? '信达生物官网'}</a><a href={selected.drug.document.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">查看{selected.drug.document.label}</a></div></footer>}</article></ScrollArea> : null}
    </DialogContent></Dialog>
  </div>
}
