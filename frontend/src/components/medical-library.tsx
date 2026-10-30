import { useEffect, useState } from 'react'
import { api } from '@/lib/platform-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  return <section className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">医学依据</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{corpus ? `${corpus.products.length} 个产品 · ${corpus.sources.length} 份可读取依据` : '正在读取资料覆盖情况…'}{corpus?.built_at && ` · ${new Date(corpus.built_at).toLocaleDateString('zh-CN')} 导入`}</p></div>{!!corpus?.sources.length && <Button asChild variant="outline"><a href="/api/medical/wiki.zip">导出知识库原文与 Wiki</a></Button>}</header>
    <p className="text-sm leading-7 text-muted-foreground">演练中每个完成识别的句子都会核验，发现有依据的冲突立即显示纠正。说明书、研究、指南和医保限制分别取证；缺失资料会标注待核实。自动归档不等于医学审核通过。</p>
    {(error || corpus?.error) && <p role="alert" className="text-sm text-destructive">{error || corpus?.error}</p>}
    <div className="space-y-3 rounded-xl border p-5"><label className="block text-sm font-medium" htmlFor="medical-sentence">核验一句产品表述</label><Textarea id="medical-sentence" value={text} onChange={e => setText(e.target.value)} maxLength={6000} placeholder="输入药品、研究名称及需要核实的完整表述；请勿输入患者身份信息。"/><Button disabled={checking || !text.trim() || !corpus?.sources.length} onClick={() => void check()}>{checking ? '正在核验…' : '查找依据并核验'}</Button>{result && <MedicalCheckView check={result}/>}</div>
    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="medical-filter">筛选产品或研究</label><Input id="medical-filter" value={filter} onChange={e => setFilter(e.target.value)} placeholder="药品名称、商品名或研究名称"/></div>
    <div className="divide-y rounded-xl border">{corpus?.products.filter(product => `${product.name} ${product.brand} ${corpus.sources.filter(s => product.sources.includes(s.id)).map(s => s.title).join(' ')}`.toLowerCase().includes(filter.toLowerCase())).map(product => <details key={product.id} className="px-5 py-4">
      <summary className="cursor-pointer"><span className="font-medium">{product.brand} / {product.name}</span><span className="ml-3 text-sm text-muted-foreground">{product.sources.length} 份依据{product.gaps.length ? ' · 有待补齐项' : ''}</span></summary>
      {!!product.gaps.length && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{product.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>}
      {!!corpus.compiled?.[product.id]?.facts.length && <section className="mt-4 space-y-3"><h2 className="text-sm font-medium">编译的产品要点 · 待医学复核</h2><ul className="list-disc space-y-3 pl-5 text-sm leading-7">{corpus.compiled[product.id].facts.map((fact,index) => <li key={index}>{fact.claim}<a className="ml-2 underline underline-offset-4" target="_blank" rel="noreferrer" href={`/api/medical/sources/${encodeURIComponent(fact.source_id)}#p${fact.page}`}>依据原文</a></li>)}</ul></section>}
      <ul className="mt-4 space-y-3 text-sm leading-6">{corpus.sources.filter(source => product.sources.includes(source.id)).map(source => <li key={source.id}><span className="mr-2 text-muted-foreground">{kinds[source.kind] || source.kind}</span><a className="underline underline-offset-4" target="_blank" rel="noreferrer" href={`/api/medical/sources/${encodeURIComponent(source.id)}`}>{source.title}</a><span className="ml-2 text-muted-foreground">{source.published_at || '版本日期待核对'}</span></li>)}</ul>
    </details>)}</div>
  </section>
}
