import { useEffect, useId, useState } from 'react'
import { Clock3, ExternalLink, Search, Square } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { api } from '@/lib/platform-api'
import type { DoctorDraft } from '@/lib/catalog-types'

type Kind = 'doctor' | 'drug'
type Profile = { kind: Kind; label: string; description: string }
type Version = { raw_sha256: string; retrieved_at: string; kind: 'html' | 'pdf' | 'doc' | 'docx' }
type Source = { id: string; title: string; url: string; latest: Version; versions: Version[]; last_checked_at: string; last_check_error: string }
type Detail = { label: string; value: string; source_id: string; source_version?: string; quote: string }
export type Job = { id: string; kind: Kind | 'policy'; query: string; status: string; created_at: string; finished_at?: string; error: string; source_ids: string[];
  doctor_identity?: { name: string; hospital: string; department: string }; doctor_draft?: DoctorDraft; doctor_draft_error?: string; doctor_id?: string;
  source_metadata?: { id: string; raw_sha256: string; url: string; resolved_url: string; title: string; kind: string; retrieved_at: string }[];
  progress?: { searches: number; archives: number }; search_queries?: string[]; currency_notice?: string;
  source_errors?: { operation: string; url?: string; message: string }[];
  changes: { source_id: string; status: string; version: string }[];
  result: { findings: { title: string; details: Detail[]; caveats: string[] }[]; further_checks: string[] } | null }
type Watch = { id: string; kind: Kind | 'policy'; query: string; enabled: boolean; source_ids: string[]; next_check_at: string; last_job_id: string; last_error?: string }
type ResearchState = { profiles: Profile[]; jobs: Job[]; sources: Source[]; watches: Watch[]; configured: boolean }
const statuses: Record<string, string> = { running: '正在检索', completed: '已整理，待专业核对', partial: '部分完成，仍有待核对项', failed: '未完成', interrupted: '已停止' }
const changes: Record<string, string> = { first_archive: '首次归档', unchanged: '原件未变', page_changed: '页面变更，文字未变', content_changed: '原文文字有变化，需核对' }
const examples: Record<Kind, string> = { doctor: '例如：上海 内分泌科 李小英 医院官方公开背景', drug: '例如：玛仕度肽 中国 成人体重管理 同类药品及当前说明书' }
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const archiveUrl = (id: string, version: string, format = 'html') => `/api/research/sources/${id}/${version}/${format}`

export function ResearchFindings({ job }: { job: Job }) {
  return <>
    <p className="text-sm leading-7 text-muted-foreground">归档仅证明原文已读取，不代表原文支持结论。请逐项核对身份、机构来源与时效；抓取时间不是发布日期。</p>
    {job.result?.findings.map((finding, index) => <article className="space-y-4 rounded-xl border bg-background p-5" key={index}>
      <h4 className="text-base font-medium">{finding.title}</h4>
      {finding.caveats.length > 0 && <div role="note" className="rounded-lg border p-3 text-sm"><p className="font-medium">身份、来源与时效待核对</p><ul className="list-inside list-disc">{finding.caveats.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
      {finding.details.map((detail, i) => {
        const version = detail.source_version ?? job.changes.find(change => change.source_id === detail.source_id)?.version
        const source = job.source_metadata?.find(source => source.id === detail.source_id && source.raw_sha256 === version)
        return <div key={i} className="grid gap-4 border-t pt-4 text-sm leading-7 md:grid-cols-2">
          <div><p className="font-medium">{detail.label}{detail.label === '同名或时效疑点' && ' · 需确认'}</p><p className="whitespace-pre-wrap break-words">{detail.value}</p></div>
          <blockquote className="min-w-0 border-l-2 pl-3"><p className="whitespace-pre-wrap break-words">{detail.quote}</p>
            <p className="text-muted-foreground">{source ? `原件类型：${source.kind.toUpperCase()} · 抓取于 ${date(source.retrieved_at)}` : '来源日期与类型待核对'} · 发布日期待核对 · 机构属性需人工确认</p>
            {source && <a className="block break-all underline" href={source.resolved_url || source.url} target="_blank" rel="noreferrer">{source.title} · {source.resolved_url || source.url}</a>}
            {version && <a className="inline-flex min-h-11 items-center underline" href={archiveUrl(detail.source_id, version)} target="_blank" rel="noreferrer">查看归档原文</a>}
          </blockquote>
        </div>
      })}
    </article>)}
    {job.result && job.result.further_checks.length > 0 && <section><h4 className="text-sm font-medium">还需核对</h4><ul className="mt-2 list-inside list-disc space-y-2 text-sm leading-7 text-muted-foreground">{job.result.further_checks.map((text, i) => <li key={i}>{text}</li>)}</ul></section>}
  </>
}

export function DoctorCandidates({ job, busy, onConfirm }: { job: Job; busy: boolean; onConfirm: (index: number, name: string) => void }) {
  const prefix = useId()
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  if (job.kind !== 'doctor' || !['completed', 'partial'].includes(job.status)) return null
  return <>{job.result?.findings.map((finding, index) => {
    const fields = ['姓名', '医院', '科室'].map(label => [...new Set(finding.details.filter(detail => detail.label === label).map(detail => detail.value.trim()).filter(Boolean))])
    const key = `${job.id}:${index}`
    if (fields.some(values => values.length !== 1)) return <p key={key} className="text-sm">“{finding.title}”的姓名、医院或科室缺失或存在冲突，请补充检索后核对。</p>
    const [name, hospital, department] = fields.map(values => values[0])
    return <section key={key} className="space-y-3 rounded-xl border p-4">
      <p className="text-sm font-medium">确认候选：{name} · {hospital} · {department}</p>
      {job.doctor_identity && <p className="text-sm text-muted-foreground">检索时填写：{job.doctor_identity.name} · {job.doctor_identity.hospital} · {job.doctor_identity.department}。简称、更名或任职差异需依据原文确认。</p>}
      <div className="flex min-h-11 items-center gap-3 text-sm"><Checkbox id={`${prefix}-${key}`} checked={Boolean(confirmed[key])} onCheckedChange={checked => setConfirmed(value => ({...value, [key]:checked === true}))}/><label htmlFor={`${prefix}-${key}`} className="flex min-h-11 cursor-pointer items-center leading-6">我已核对该候选的姓名、医院、科室、来源及待核对项</label></div>
      <Button className="h-11" variant="outline" disabled={busy || !confirmed[key]} onClick={() => onConfirm(index, name)}>创建待审核医生草稿</Button>
    </section>
  })}</>
}

export function ResearchPanel({ initialKind }: { initialKind?: Kind } = {}) {
  const initial = new URLSearchParams(location.hash.split('?')[1]).get('agent')
  const [kind, setKind] = useState<Kind>(initialKind ?? (initial === 'doctor' || initial === 'drug' ? initial : 'doctor'))
  const [query, setQuery] = useState('')
  const [data, setData] = useState<ResearchState>()
  const [selected, setSelected] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('job') ?? '')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    async function load() {
      try {
        const state = await api<ResearchState>('/research', { signal: controller.signal })
        if (selected && !state.jobs.some(job => job.id === selected)) {
          const sourceJob = await api<Job>(`/research/jobs/${encodeURIComponent(selected)}`, { signal: controller.signal })
          state.jobs = [sourceJob, ...state.jobs]
        }
        if (controller.signal.aborted) return
        failures = 0; setError('')
        setData(state)
        if (state.jobs.some(job => job.status === 'running')) timer = setTimeout(() => void load(), 2000)
      } catch (cause) {
        if (controller.signal.aborted) return
        failures += 1
        setError(`进度连接暂时中断，后台任务仍会保留。${failures <= 3 ? `正在重试（${failures}/3）…` : '自动重试已停止，请重新读取。'}${cause instanceof Error ? cause.message : ''}`)
        if (failures <= 3) timer = setTimeout(() => void load(), 2000 * failures)
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh, selected])
  const running = data?.jobs.find(job => job.status === 'running')
  const job = data?.jobs.find(job => job.id === selected) ?? data?.jobs[0]
  const profile = data?.profiles.find(profile => profile.kind === kind)
  const watch = data?.watches.find(watch => watch.kind === job?.kind && watch.query === job?.query)

  async function mutate(path: string, body?: object, method = 'POST') {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api<Job>(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (path === '/research/jobs') setSelected(result.id)
      if (path.endsWith('/doctor-draft')) setNotice('医生草稿已创建，请在医生管理中核对并发布。')
      if (path.endsWith('/policy-draft')) setNotice('政策原文已导入草稿，请在政策管理中核对、提交审核。')
      setRefresh(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。') }
    finally { setBusy(false) }
  }

  return <div className="space-y-6">
    <header><h2 className="text-lg font-medium">资料检索与追踪</h2></header>
    <form className="space-y-4 rounded-xl border bg-background p-5" onSubmit={event => { event.preventDefault(); if (!busy && !running && query.trim()) void mutate('/research/jobs', { kind, query }) }}>
      <div className="max-w-sm space-y-2"><label htmlFor="research-kind" className="text-sm font-medium">查找什么</label><Select value={kind} onValueChange={value => setKind(value as Kind)}><SelectTrigger id="research-kind" className="min-h-11 w-full"><SelectValue/></SelectTrigger><SelectContent>{(data?.profiles ?? [{kind:'doctor',label:'医生公开资料检索'},{kind:'drug',label:'同类药品检索'}]).map(profile => <SelectItem key={profile.kind} value={profile.kind}>{profile.label}</SelectItem>)}</SelectContent></Select></div>
      {profile && <p className="text-sm leading-7 text-muted-foreground">{profile.description}</p>}
      <div className="space-y-2"><label htmlFor="research-query" className="text-sm font-medium">检索主题</label><Textarea id="research-query" rows={2} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder={examples[kind]} required minLength={2}/></div>
      <div className="flex flex-wrap items-center gap-4"><Button type="submit" className="h-11" disabled={busy || Boolean(running) || !data?.configured || query.trim().length < 2}><Search/>{running ? '检索进行中' : '开始检索并归档'}</Button><p className="text-sm leading-6 text-muted-foreground">仅检索公开资料，会产生模型与搜索用量。</p></div>
      {data && !data.configured && <p className="text-sm leading-7 text-muted-foreground">请配置 DeepSeek 并开启公开搜索，再开始检索。<a href="#settings" className="ml-2 underline underline-offset-4">查看服务设置</a></p>}
    </form>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-destructive">{error}</p><Button variant="outline" className="h-11" onClick={() => { setError(''); setRefresh(value => value + 1) }}>重新读取</Button></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">正在读取检索记录…</p>}
    {job ? <section className="space-y-5" aria-label="检索结果">
      <div className="space-y-2"><label htmlFor="research-history" className="text-sm font-medium">检索记录（最近 20 次及当前来源）</label><Select value={job.id} onValueChange={setSelected}><SelectTrigger id="research-history" className="min-h-11 w-full"><SelectValue/></SelectTrigger><SelectContent>{data?.jobs.map(item => <SelectItem key={item.id} value={item.id}>{item.query} · {statuses[item.status]} · {date(item.created_at)}</SelectItem>)}</SelectContent></Select></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">{job.query}</h3><p className="mt-2 text-sm text-muted-foreground" role="status">{statuses[job.status]}{job.finished_at ? ` · 核验时间 ${date(job.finished_at)}` : ` · 已搜索 ${job.progress?.searches ?? 0} 次，已归档 ${job.progress?.archives ?? 0} 份`}</p></div>{job.status === 'running' ? <Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${job.id}/cancel`)}><Square/>停止检索</Button> : job.source_ids.length > 0 && ['completed','partial'].includes(job.status) && (job.kind !== 'policy' || watch?.enabled) && <Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${job.id}/watch`, {enabled:!watch?.enabled}, 'PUT')}><Clock3/>{watch?.enabled ? '暂停每日追踪' : '开启每日追踪'}</Button>}</div>
      {job.kind !== 'policy' && job.source_ids.length > 0 && ['completed','partial'].includes(job.status) && <p className="text-sm leading-7 text-muted-foreground">每日重搜并复查最多 5 份来源；需本机后端运行，会产生模型与搜索用量。</p>}
      {job.error && <p role="alert" className="text-sm leading-7 text-destructive">{job.error}</p>}
      <ResearchFindings job={job}/>
      <DoctorCandidates job={job} busy={busy} onConfirm={(index, name) => void mutate(`/research/jobs/${job.id}/doctor-draft`, {finding_index:index, confirmed_identity:true, confirmed_name:name})}/>
      {job.kind === 'policy' && job.source_ids.length > 0 && <section className="space-y-2 rounded-xl border p-4"><h4 className="text-sm font-medium">导入官方原文</h4><p className="text-sm text-muted-foreground">将归档正文导入待审核草稿；文件效力和适用范围需人工核对。</p>{job.source_ids.map(id => { const source = data?.sources.find(item => item.id === id); const change = job.changes.find(item => item.source_id === id); return source && change ? <div key={id} className="flex flex-wrap items-center gap-3"><span className="text-sm">{source.title}</span><Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${job.id}/policy-draft`, {source_id:id, source_version:change.version})}>创建政策草稿</Button></div> : null })}</section>}
      {job.source_ids.length > 0 && <section className="space-y-3"><h4 className="text-sm font-medium">已归档原文</h4>{job.source_ids.map(id => { const source = data?.sources.find(source => source.id === id); const change = job.changes.find(change => change.source_id === id); if (!source || !change) return null; return <article className="min-w-0 space-y-3 rounded-xl border p-4" key={id}><h5 className="break-words text-sm font-medium">{source.title}</h5><p className="text-sm text-muted-foreground">{changes[change.status]} · 保留 {source.versions.length} 个版本</p><div className="flex flex-wrap gap-3"><Button asChild variant="outline" className="h-11"><a href={archiveUrl(id, change.version)} target="_blank" rel="noreferrer">阅读 HTML</a></Button><Button asChild variant="outline" className="h-11"><a href={archiveUrl(id, change.version, 'original')}>下载原件</a></Button><Button asChild variant="ghost" className="h-11"><a href={source.url} target="_blank" rel="noreferrer"><ExternalLink/>来源网页</a></Button></div>{source.last_check_error && <p className="text-sm leading-7 text-destructive">最近复查未完成：{source.last_check_error}，上次成功副本保留。</p>}{source.versions.length > 1 && <Accordion type="single" collapsible className="rounded-none border-0 border-t"><AccordionItem value="versions"><AccordionTrigger className="min-h-11 px-0 py-3">历史原文版本</AccordionTrigger><AccordionContent><ul className="space-y-2">{source.versions.map(version => <li key={version.raw_sha256}><a className="inline-flex min-h-11 items-center underline underline-offset-4" href={archiveUrl(id, version.raw_sha256)} target="_blank" rel="noreferrer">{date(version.retrieved_at)}</a></li>)}</ul></AccordionContent></AccordionItem></Accordion>}</article> })}</section>}
      {job.source_errors && job.source_errors.length > 0 && <Accordion type="single" collapsible className="bg-background"><AccordionItem value="source-errors"><AccordionTrigger className="min-h-11">未完成的来源检查（{job.source_errors.length}）</AccordionTrigger><AccordionContent><ul className="space-y-3">{job.source_errors.map((failure, i) => <li className="break-words leading-7" key={i}>{failure.message}{failure.url && <a className="ml-2 underline underline-offset-4" href={failure.url} target="_blank" rel="noreferrer">查看来源</a>}</li>)}</ul></AccordionContent></AccordionItem></Accordion>}
      {job.currency_notice && <p className="text-sm leading-7 text-muted-foreground">{job.currency_notice}</p>}
    </section> : data && <p className="text-sm leading-7 text-muted-foreground">暂无检索记录</p>}
    {data && data.watches.length > 0 && <Accordion type="single" collapsible className="bg-background"><AccordionItem value="watches"><AccordionTrigger className="min-h-11">追踪主题（{data.watches.filter(watch => watch.enabled && watch.kind !== 'policy').length} 个已开启）</AccordionTrigger><AccordionContent><p className="text-sm leading-7 text-muted-foreground">每日重搜并复查最多 5 份来源；需本机后端运行，会产生模型与搜索用量。</p><ul className="mt-4 divide-y">{data.watches.map(watch => <li key={watch.id} className="space-y-2 py-4 text-sm"><p className="font-medium">{watch.query} · {watch.kind === 'policy' ? '助手已停用' : watch.enabled ? '追踪中' : '已暂停'}</p><p className="leading-7 text-muted-foreground">{watch.source_ids.length} 份原始来源{watch.enabled && watch.kind !== 'policy' && ` · 下次检查 ${date(watch.next_check_at)}`}</p>{watch.last_error && <p className="leading-7 text-destructive">{watch.last_error}</p>}{(watch.kind !== 'policy' || watch.enabled) && <Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${watch.last_job_id}/watch`, {enabled:!watch.enabled}, 'PUT')}>{watch.enabled ? '暂停追踪' : '恢复追踪'}</Button>}</li>)}</ul></AccordionContent></AccordionItem></Accordion>}
  </div>
}

export function PolicyImports() {
  const [expanded, setExpanded] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  async function upload() {
    if (!file || !title.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const type = file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
      const result = await api<{research_upload_id:string}>(`/research/policy-file?title=${encodeURIComponent(title.trim())}`, {
        method:'POST', body:file, headers:{'Content-Type':type}, timeoutMs:60000,
      })
      setNotice(result.research_upload_id); setFile(null); setTitle('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入未完成，请核对原文。') }
    finally { setBusy(false) }
  }
  return <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded} className="bg-background"><AccordionItem value="policy-import"><AccordionTrigger className="min-h-11">导入政策原文</AccordionTrigger><AccordionContent forceMount hidden={expanded !== 'policy-import'} className="space-y-4">
    <p className="text-sm leading-6 text-muted-foreground">导入 PDF、DOC 或 DOCX 原件并创建待审核草稿。Word 正文按单段展示，不能作为原件页码；不支持扫描件自动识别。</p>
    <label className="grid gap-2 text-sm">文件名称<Input className="min-h-11" value={title} maxLength={180} onChange={event=>setTitle(event.target.value)}/></label>
    <label className="grid gap-2 text-sm">选择原件<Input className="min-h-11 cursor-pointer" type="file" accept=".pdf,.doc,.docx" onChange={event=>setFile(event.target.files?.[0] ?? null)}/></label>
    <Button className="h-11" disabled={busy || !file || !title.trim()} onClick={()=>void upload()}>{busy?'正在导入…':'创建政策草稿'}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">政策草稿已创建，刷新政策列表后核对。<a className="ml-2 underline" href={`/api/research/policy-file/${notice}/original`}>下载原件</a></p>}
  </AccordionContent></AccordionItem></Accordion>
}
