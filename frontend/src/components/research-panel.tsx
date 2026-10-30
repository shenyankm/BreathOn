import { useEffect, useState } from 'react'
import { Clock3, ExternalLink, Search, Square } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { api } from '@/lib/platform-api'

type Kind = 'policy' | 'doctor' | 'drug'
type Profile = { kind: Kind; label: string; description: string }
type Version = { raw_sha256: string; retrieved_at: string; kind: 'html' | 'pdf' | 'doc' | 'docx' }
type Source = { id: string; title: string; url: string; latest: Version; versions: Version[]; last_checked_at: string; last_check_error: string }
type Detail = { label: string; value: string; source_id: string; source_version?: string; quote: string }
type Job = { id: string; kind: Kind; query: string; status: string; created_at: string; finished_at?: string; error: string; source_ids: string[];
  progress?: { searches: number; archives: number }; search_queries?: string[]; currency_notice?: string;
  source_errors?: { operation: string; url?: string; message: string }[];
  changes: { source_id: string; status: string; version: string }[];
  result: { findings: { title: string; details: Detail[]; caveats: string[] }[]; further_checks: string[] } | null }
type Watch = { id: string; kind: Kind; query: string; enabled: boolean; source_ids: string[]; next_check_at: string; last_job_id: string; last_error?: string }
type ResearchState = { profiles: Profile[]; jobs: Job[]; sources: Source[]; watches: Watch[]; configured: boolean }
const statuses: Record<string, string> = { running: '正在检索', completed: '已整理，待专业核对', partial: '部分完成，仍有待核对项', failed: '未完成', interrupted: '已停止' }
const changes: Record<string, string> = { first_archive: '首次归档', unchanged: '原件未变', page_changed: '页面变更，文字未变', content_changed: '原文文字有变化，需核对' }
const examples: Record<Kind, string> = { policy: '例如：医药代表管理办法 江苏 苏州 最新修订与废止文件', doctor: '例如：上海 内分泌科 李小英 医院官方公开背景', drug: '例如：玛仕度肽 中国 成人体重管理 同类药品及当前说明书' }
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const archiveUrl = (id: string, version: string, format = 'html') => `/api/research/sources/${id}/${version}/${format}`

export function ResearchPanel() {
  const initial = new URLSearchParams(location.hash.split('?')[1]).get('agent')
  const [kind, setKind] = useState<Kind>(initial === 'doctor' || initial === 'drug' ? initial : 'policy')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<ResearchState>()
  const [selected, setSelected] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const state = await api<ResearchState>('/research', { signal: controller.signal })
        setData(state)
        if (state.jobs.some(job => job.status === 'running')) timer = setTimeout(() => void load(), 2000)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '检索记录暂不可读取。')
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh])
  const running = data?.jobs.find(job => job.status === 'running')
  const job = data?.jobs.find(job => job.id === selected) ?? data?.jobs[0]
  const profile = data?.profiles.find(profile => profile.kind === kind)
  const watch = data?.watches.find(watch => watch.kind === job?.kind && watch.query === job?.query)

  async function mutate(path: string, body?: object, method = 'POST') {
    setBusy(true); setError('')
    try {
      const result = await api<Job>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (path === '/research/jobs') setSelected(result.id)
      setRefresh(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。') }
    finally { setBusy(false) }
  }

  return <div className="space-y-6">
    <header><h2 className="text-lg font-medium">资料检索与追踪</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">检索结果需核对后用于训练。</p></header>
    <form className="space-y-4 rounded-xl border bg-background p-5" onSubmit={event => { event.preventDefault(); if (!busy && !running && query.trim()) void mutate('/research/jobs', { kind, query }) }}>
      <div className="max-w-sm space-y-2"><label htmlFor="research-kind" className="text-sm font-medium">查找什么</label><Select value={kind} onValueChange={value => setKind(value as Kind)}><SelectTrigger id="research-kind" className="w-full"><SelectValue/></SelectTrigger><SelectContent>{(data?.profiles ?? [{kind:'policy',label:'政策检索与追踪'},{kind:'doctor',label:'医生公开资料检索'},{kind:'drug',label:'同类药品检索'}]).map(profile => <SelectItem key={profile.kind} value={profile.kind}>{profile.label}</SelectItem>)}</SelectContent></Select></div>
      {profile && <p className="text-sm leading-7 text-muted-foreground">{profile.description}</p>}
      <div className="space-y-2"><label htmlFor="research-query" className="text-sm font-medium">检索主题</label><Textarea id="research-query" rows={2} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder={examples[kind]} required minLength={2}/></div>
      <div className="flex flex-wrap items-center gap-4"><Button type="submit" className="h-11" disabled={busy || Boolean(running) || !data?.configured || query.trim().length < 2}><Search/>{running ? '检索进行中' : '开始检索并归档'}</Button><p className="text-sm leading-6 text-muted-foreground">仅检索公开资料，会产生模型与搜索用量。</p></div>
      {data && !data.configured && <p className="text-sm leading-7 text-muted-foreground">请配置 DeepSeek 并开启公开搜索，再开始检索。<a href="#settings" className="ml-2 underline underline-offset-4">查看服务设置</a></p>}
    </form>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-destructive">{error}</p><Button variant="outline" className="h-11" onClick={() => { setError(''); setRefresh(value => value + 1) }}>重新读取</Button></div>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">正在读取检索记录…</p>}
    {job ? <section className="space-y-5" aria-label="检索结果">
      <div className="space-y-2"><label htmlFor="research-history" className="text-sm font-medium">最近 20 次检索</label><Select value={job.id} onValueChange={setSelected}><SelectTrigger id="research-history" className="min-h-11 w-full"><SelectValue/></SelectTrigger><SelectContent>{data?.jobs.map(item => <SelectItem key={item.id} value={item.id}>{item.query} · {statuses[item.status]} · {date(item.created_at)}</SelectItem>)}</SelectContent></Select></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">{job.query}</h3><p className="mt-2 text-sm text-muted-foreground" role="status">{statuses[job.status]}{job.finished_at ? ` · 核验时间 ${date(job.finished_at)}` : ` · 已搜索 ${job.progress?.searches ?? 0} 次，已归档 ${job.progress?.archives ?? 0} 份`}</p></div>{job.status === 'running' ? <Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${job.id}/cancel`)}><Square/>停止检索</Button> : job.source_ids.length > 0 && ['completed','partial'].includes(job.status) && <Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${job.id}/watch`, {enabled:!watch?.enabled}, 'PUT')}><Clock3/>{watch?.enabled ? '暂停每日追踪' : '开启每日追踪'}</Button>}</div>
      {job.source_ids.length > 0 && ['completed','partial'].includes(job.status) && <p className="text-sm leading-7 text-muted-foreground">每日重搜并复查最多 5 份来源；需本机后端运行，会产生模型与搜索用量。</p>}
      {job.error && <p role="alert" className="text-sm leading-7 text-destructive">{job.error}</p>}
      {job.result?.findings.map((finding, index) => <article className="space-y-4 rounded-xl border bg-background p-5" key={index}><h4 className="text-base font-medium">{finding.title}</h4><dl className="space-y-3 text-sm leading-7">{finding.details.map((detail, i) => <div key={i} className="grid gap-1 sm:grid-cols-[140px_minmax(0,1fr)]"><dt className="text-muted-foreground">{detail.label}</dt><dd className="break-words">{detail.value}</dd></div>)}</dl>{finding.caveats.length > 0 && <ul className="list-inside list-disc space-y-2 text-sm leading-7 text-muted-foreground">{finding.caveats.map((text, i) => <li key={i}>{text}</li>)}</ul>}<details className="border-t pt-4 text-sm"><summary className="cursor-pointer font-medium">查看原文引文</summary><div className="mt-4 space-y-4">{finding.details.map((detail, i) => { const change = job.changes.find(change => change.source_id === detail.source_id); return <blockquote className="border-l-2 pl-3 leading-7" key={i}><p className="whitespace-pre-wrap">{detail.quote}</p>{change && <a className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4" href={archiveUrl(detail.source_id, detail.source_version ?? change.version)} target="_blank" rel="noreferrer">{detail.label} · 查看归档原文</a>}</blockquote> })}</div></details></article>)}
      {job.result && job.result.further_checks.length > 0 && <section><h4 className="text-sm font-medium">还需核对</h4><ul className="mt-2 list-inside list-disc space-y-2 text-sm leading-7 text-muted-foreground">{job.result.further_checks.map((text, i) => <li key={i}>{text}</li>)}</ul></section>}
      {job.source_ids.length > 0 && <section className="space-y-3"><h4 className="text-sm font-medium">已归档原文</h4>{job.source_ids.map(id => { const source = data?.sources.find(source => source.id === id); const change = job.changes.find(change => change.source_id === id); if (!source || !change) return null; return <article className="min-w-0 space-y-3 rounded-xl border p-4" key={id}><h5 className="break-words text-sm font-medium">{source.title}</h5><p className="text-sm text-muted-foreground">{changes[change.status]} · 保留 {source.versions.length} 个版本</p><div className="flex flex-wrap gap-3"><Button asChild variant="outline" className="h-11"><a href={archiveUrl(id, change.version)} target="_blank" rel="noreferrer">阅读 HTML</a></Button><Button asChild variant="outline" className="h-11"><a href={archiveUrl(id, change.version, 'original')}>下载原件</a></Button><Button asChild variant="ghost" className="h-11"><a href={source.url} target="_blank" rel="noreferrer"><ExternalLink/>来源网页</a></Button></div>{source.last_check_error && <p className="text-sm leading-7 text-destructive">最近复查未完成：{source.last_check_error}，上次成功副本保留。</p>}{source.versions.length > 1 && <details className="text-sm"><summary className="cursor-pointer">历史原文版本</summary><ul className="mt-2 space-y-2">{source.versions.map(version => <li key={version.raw_sha256}><a className="inline-flex min-h-11 items-center underline underline-offset-4" href={archiveUrl(id, version.raw_sha256)} target="_blank" rel="noreferrer">{date(version.retrieved_at)}</a></li>)}</ul></details>}</article> })}</section>}
      {job.source_errors && job.source_errors.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium">未完成的来源检查（{job.source_errors.length}）</summary><ul className="mt-3 space-y-3">{job.source_errors.map((failure, i) => <li className="break-words leading-7" key={i}>{failure.message}{failure.url && <a className="ml-2 underline underline-offset-4" href={failure.url} target="_blank" rel="noreferrer">查看来源</a>}</li>)}</ul></details>}
      {job.currency_notice && <p className="text-sm leading-7 text-muted-foreground">{job.currency_notice}</p>}
    </section> : data && <p className="text-sm leading-7 text-muted-foreground">暂无检索记录</p>}
    {data && data.watches.length > 0 && <details className="border-t pt-5"><summary className="cursor-pointer text-sm font-medium">追踪主题（{data.watches.filter(watch => watch.enabled).length} 个已开启）</summary><p className="mt-3 text-sm leading-7 text-muted-foreground">每日重搜并复查最多 5 份来源；需本机后端运行，会产生模型与搜索用量。</p><ul className="mt-4 divide-y">{data.watches.map(watch => <li key={watch.id} className="space-y-2 py-4 text-sm"><p className="font-medium">{watch.query} · {watch.enabled ? '追踪中' : '已暂停'}</p><p className="leading-7 text-muted-foreground">{watch.source_ids.length} 份原始来源{watch.enabled && ` · 下次检查 ${date(watch.next_check_at)}`}</p>{watch.last_error && <p className="leading-7 text-destructive">{watch.last_error}</p>}<Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${watch.last_job_id}/watch`, {enabled:!watch.enabled}, 'PUT')}>{watch.enabled ? '暂停追踪' : '恢复追踪'}</Button></li>)}</ul></details>}
  </div>
}
