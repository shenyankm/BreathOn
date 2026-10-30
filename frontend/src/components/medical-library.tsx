import { useEffect, useState } from 'react'
import { AlertCircle, Download, ExternalLink, LoaderCircle, Search } from 'lucide-react'
import { api } from '@/lib/platform-api'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { MedicalCheckView } from './medical-check'
import type { MedicalCheck } from '@/lib/medical'

type Corpus = { built_at: string | null; version: string; error?: string; compiled?: Record<string, {facts:{claim:string;source_id:string;page:number;quote:string}[];gaps:string[]}>; products: { id: string; name: string; brand: string; sources: string[]; gaps: string[] }[]; sources: { id: string; title: string; kind: string; quality: string; product_ids: string[]; published_at: string | null }[] }
const kinds: Record<string, string> = { label: '说明书', patient_guide: '患者手册', trial: '研究摘要', guideline: '指南', reimbursement: '医保目录', policy: '实施政策' }

export function MedicalLibrary() {
  const [corpus, setCorpus] = useState<Corpus | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState<MedicalCheck | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api<Corpus>('/medical', { signal: controller.signal }).then(setCorpus).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [])
  async function check() {
    setChecking(true); setError(''); setResult(null)
    try { setResult(await api<MedicalCheck>('/medical/check', { method: 'POST', body: JSON.stringify({ text }) })) }
    catch (e) { setError(e instanceof Error ? e.message : '核验暂未完成。') }
    finally { setChecking(false) }
  }
  const products = corpus?.products.filter(product => `${product.name} ${product.brand} ${corpus.sources.filter(s => product.sources.includes(s.id)).map(s => s.title).join(' ')}`.toLowerCase().includes(filter.toLowerCase())) ?? []

  return <section className="min-w-0 space-y-4 sm:space-y-6" aria-label="医学依据核验">
    <header className="space-y-1.5">
      <h2 className="sr-only sm:not-sr-only sm:text-lg sm:font-semibold">医学依据</h2>
      <p className="text-sm leading-6 text-muted-foreground">{corpus ? `${corpus.products.length} 个产品 · ${corpus.sources.length} 份可读取依据` : error ? '资料读取未完成' : '正在读取资料覆盖情况…'}{corpus?.built_at && ` · ${new Date(corpus.built_at).toLocaleDateString('zh-CN')} 导入`}</p>
      <p className="text-sm leading-6 text-muted-foreground">自动归档不等于医学审核通过。</p>
    </header>
    {(error || corpus?.error) && <Alert variant="destructive"><AlertCircle aria-hidden="true" /><AlertTitle>医学依据读取或核验未完成</AlertTitle><AlertDescription className="break-words">{error || corpus?.error}</AlertDescription></Alert>}
    <div className="grid items-start gap-4 sm:gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Accordion type="single" collapsible className="bg-card"><AccordionItem value="check-statement"><AccordionTrigger className="min-h-11 px-4 py-3">核验一句产品表述</AccordionTrigger><AccordionContent className="space-y-4">
          <div className="space-y-4" aria-busy={checking}>
            <label className="sr-only" htmlFor="medical-sentence">需要核验的产品表述</label>
            <Textarea id="medical-sentence" className="min-h-28 leading-7" value={text} disabled={checking} onChange={e => setText(e.target.value)} maxLength={6000} placeholder="输入药品、研究名称及需要核实的完整表述；请勿输入患者身份信息。" />
            <Button className="min-h-11 w-full" disabled={checking || !text.trim() || !corpus?.sources.length} onClick={() => void check()}>{checking ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Search aria-hidden="true" />}{checking ? '正在核验…' : '查找依据并核验'}</Button>
          </div>
          {!!corpus?.sources.length && <Button asChild variant="outline" className="min-h-11"><a href="/api/medical/wiki.zip"><Download aria-hidden="true" />导出知识库原文与 Wiki</a></Button>}
        </AccordionContent></AccordionItem></Accordion>
        {checking && <p role="status" className="text-sm text-muted-foreground">正在查找依据并核验表述…</p>}
        {result && <MedicalCheckView check={result} />}
      </div>
      <section className="min-w-0 space-y-4" aria-label="已归档产品依据">
        <div className="space-y-2"><label className="sr-only" htmlFor="medical-filter">筛选产品或研究</label><div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="medical-filter" className="h-11 pl-9" value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索产品、商品名或研究" /></div></div>
        {!corpus && !error && <div role="status" className="space-y-3"><span className="sr-only">正在读取产品依据…</span>{[0, 1, 2].map(index => <Skeleton aria-hidden="true" key={index} className="h-20 rounded-xl" />)}</div>}
        {corpus && <><p role="status" className="text-sm tabular-nums text-muted-foreground">显示 {products.length} / {corpus.products.length} 个产品</p>
          {products.length ? <Accordion type="multiple" className="bg-card">
            {products.map(product => <AccordionItem key={product.id} value={product.id}>
              <AccordionTrigger className="min-h-16 items-center px-4 py-3 hover:no-underline sm:px-5 sm:py-4"><span className="min-w-0 space-y-1"><span className="block break-words font-medium">{product.brand} / {product.name}</span><span className="block text-xs font-normal leading-5 text-muted-foreground">{product.sources.length} 份依据{product.gaps.length ? ' · 有待补齐项' : ''}</span></span></AccordionTrigger>
              <AccordionContent className="space-y-4 px-1">
                {!!product.gaps.length && <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">{product.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}
                {!!corpus.compiled?.[product.id]?.facts.length && <section className="space-y-3"><h3 className="text-sm font-medium">编译的产品要点 · 待医学复核</h3><ul className="list-disc space-y-3 pl-5 text-sm leading-7">{corpus.compiled[product.id].facts.map((fact,index) => <li key={index}>{fact.claim}<a className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4" target="_blank" rel="noreferrer" href={`/api/medical/sources/${encodeURIComponent(fact.source_id)}#p${fact.page}`}>依据原文</a></li>)}</ul></section>}
                <ul className="divide-y text-sm leading-6">{corpus.sources.filter(source => product.sources.includes(source.id)).map(source => <li key={source.id} className="py-3 first:pt-0 last:pb-0"><p className="mb-1 text-xs text-muted-foreground">{kinds[source.kind] || source.kind} · {source.published_at || '版本日期待核对'}</p><a className="inline-flex min-h-11 items-center gap-2 break-words underline underline-offset-4" target="_blank" rel="noreferrer" href={`/api/medical/sources/${encodeURIComponent(source.id)}`}>{source.title}<ExternalLink aria-hidden="true" className="size-3.5 shrink-0" /></a></li>)}</ul>
              </AccordionContent>
            </AccordionItem>)}
          </Accordion> : <Card><CardContent className="py-4 text-sm leading-7 text-muted-foreground">{corpus.products.length ? '没有匹配的产品或研究，请调整搜索内容。' : '暂无已归档的产品依据。'}</CardContent></Card>}
        </>}
      </section>
    </div>
  </section>
}
