import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, CheckCircle2, ChevronRight, Mic, NotebookPen, Plus, RotateCcw, TriangleAlert } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/platform-api'
import { SelfReportRecorder } from '@/components/self-report-recorder'
import { audioContentType, validAudioDuration } from '@/lib/visit-audio'
import type { Doctor } from '@/lib/catalog-types'

type Speaker = { speaker_id: string; role: 'doctor' | 'representative' | 'other' | 'unknown' }
type Segment = { text: string; start_time: number | null; end_time: number | null; speaker_id: string }
type Visit = { private_audio?: boolean; review?: { decision: string; reason: string } | null; segments?: Segment[]; redaction_suggestion?: string; id: string; version: number; owner_id: string; source: 'self_report' | 'recording'; status: string; text: string; redacted_text: string; doctor_id: string; drug_id: string; visited_at: string; speakers: Speaker[]; audio_status: string; created_at: string }
type Drug = { id: string; name: string; brand?: string; status: string }
type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null }
type RecognitionWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }

const roles = { doctor: '医生', representative: '代表', other: '其他人员', unknown: '未知' } as const
function audioLabel(status: string) { return ({ none: '无录音', transcription_unavailable: '待启动转写', queued: '转写排队中', transcribing: '正在转写', transcribed: '转写完成，请核对', transcription_interrupted: '转写中断，可重试', uploaded: '已上传', deleted: '原音频已删除' } as Record<string, string>)[status] || status || '无录音' }
type VisitView = { kind: 'list' | 'new' } | { kind: 'detail'; id: string }
function readView(): VisitView {
  const params = new URLSearchParams(window.location.hash.split('?')[1])
  const id = params.get('visit')
  return id ? { kind: 'detail', id } : { kind: params.has('new') ? 'new' : 'list' }
}
function visitSpeakers(item: Visit): Speaker[] {
  return item.speakers?.length ? item.speakers : Array.from(new Set((item.segments || []).map(segment => segment.speaker_id).filter(id => id && id !== 'unknown'))).map(speaker_id => ({ speaker_id, role: 'unknown' }))
}
function message(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请重试。' }

export function VisitsPage() {
  const [today] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [view, setView] = useState<VisitView>(readView)
  const [draft, setDraft] = useState({ doctor_id: '', drug_id: '', visited_at: today, source: 'self_report', text: '' })
  const [rows, setRows] = useState<Visit[] | null>(null)
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [drugs, setDrugs] = useState<Drug[]>([])
  const [selected, setSelected] = useState<Visit | null>(null)
  const [text, setText] = useState('')
  const [redacted, setRedacted] = useState('')
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [recording, setRecording] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const reload = useCallback(async () => {
    const list = await api<Visit[]>('/visits')
    setRows(list)
    setError('')
    return list
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    api<Visit[]>('/visits', { signal: controller.signal }).then(setRows).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
    api<Doctor[]>('/catalog/doctor', { signal: controller.signal }).then(items => setDoctors(items.filter(item => item.status === 'published'))).catch(() => {})
    api<Drug[]>('/catalog/drug', { signal: controller.signal }).then(items => setDrugs(items.filter(item => item.status === 'published'))).catch(() => {})
    const onHidden = () => { if (document.visibilityState === 'hidden') recognition.current?.stop() }
    document.addEventListener('visibilitychange', onHidden)
    return () => { controller.abort(); document.removeEventListener('visibilitychange', onHidden); recognition.current?.stop() }
  }, [])
  function choose(item: Visit) {
    setSelected(item); setText(item.text || ''); setRedacted(item.redacted_text || ''); setSpeakers(visitSpeakers(item));  setConfirmed(false); setAuthorized(false); setError(''); setNotice('')
  }
  function navigate(next: VisitView) {
    setError('')
    recognition.current?.stop()
    window.location.hash = next.kind === 'detail' ? `visits?visit=${encodeURIComponent(next.id)}` : next.kind === 'new' ? 'visits?new=1' : 'visits'
    setView(next)
  }
  function returnToList() {
    recognition.current?.stop()
    window.history.replaceState(null, '', '#visits')
    setError('')
    setView({ kind: 'list' })
  }
  useEffect(() => {
    const change = () => { recognition.current?.stop(); setError(''); setView(readView()) }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const visitId = view.kind === 'detail' ? view.id : ''
  const selectedId = selected?.id
  const changed = selected && (text !== selected.text || redacted !== (selected.redacted_text || '') || JSON.stringify(speakers) !== JSON.stringify(visitSpeakers(selected)))
  const pendingVisit = visitId && selectedId && selectedId !== visitId && changed ? visitId : null
  useEffect(() => {
    if (!visitId || selectedId === visitId || pendingVisit) return
    const controller = new AbortController()
    api<Visit>(`/visits/${encodeURIComponent(visitId)}`, { signal: controller.signal }).then(item => { if (!controller.signal.aborted) choose(item) }).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
    return () => controller.abort()
  }, [visitId, selectedId, pendingVisit])
  useEffect(() => {
    if (!selected || !['queued', 'transcribing'].includes(selected.audio_status)) return
    let active = true
    const timer = window.setInterval(() => {
      api<Visit>(`/visits/${encodeURIComponent(selected.id)}`).then(item => {
        if (!active) return
        if (['queued', 'transcribing'].includes(item.audio_status)) setSelected(item)
        else { choose(item); setRows(current => [item, ...(current ?? []).filter(row => row.id !== item.id)]) }
      }).catch(e => { if (active) setError(message(e)) })
    }, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [selected])
  async function transcribe(cancel = false) {
    if (!selected) return
    setBusy(true); setError(''); setNotice('')
    try {
      const item = await api<Visit>(`/visits/${encodeURIComponent(selected.id)}/transcription${cancel ? '/cancel' : ''}`, { method: 'POST' })
      choose(item); setRows(current => [item, ...(current ?? []).filter(row => row.id !== item.id)])
      setNotice(cancel ? '转写已取消；已发出的供应商请求可能仍产生费用。' : '已提交转写，完成后请核对说话人和内容。')
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function selectVisit(id: string) {
    setError('')
    try { choose(await api<Visit>(`/visits/${encodeURIComponent(id)}`)) } catch (e) { setError(message(e)) }
  }
  async function suggestRedaction() {
    if (!selected || text !== selected.text) return
    try { const item = await api<Visit>(`/visits/${encodeURIComponent(selected.id)}`); setRedacted(item.redaction_suggestion || item.text || ''); setNotice('已填入脱敏建议，请逐字核对并删除遗漏的敏感内容。') } catch (e) { setError(message(e)) }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(''); setNotice('')
    try {
      const inputSource = String(form.get('source'))
      const item = await api<Visit>('/visits', { method: 'POST', body: JSON.stringify({ doctor_id: String(form.get('doctor_id')), drug_id: String(form.get('drug_id')), visited_at: String(form.get('visited_at')), source: inputSource === 'voice' ? 'self_report' : inputSource, private_audio: inputSource === 'voice', text: draft.text }) })
      choose(item); setRows(current => [item, ...(current ?? []).filter(row => row.id !== item.id)]); setDraft({ doctor_id: '', drug_id: '', visited_at: today, source: 'self_report', text: '' }); navigate({ kind: 'detail', id: item.id }); setNotice('已保存草稿。请核对内容并脱敏后提交审核。')
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function save() {
    if (!selected) return
    setBusy(true); setError(''); setNotice('')
    try {
      const item = await api<Visit>(`/visits/${selected.id}`, { method: 'PUT', body: JSON.stringify({ version: selected.version, doctor_id: selected.doctor_id, drug_id: selected.drug_id, visited_at: selected.visited_at, text }) })
      choose(item); setRows(current => [item, ...(current ?? []).filter(row => row.id !== item.id)]); setNotice('草稿已保存。')
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function confirm() {
    if (!selected || !confirmed || text !== selected.text) return
    setBusy(true); setError(''); setNotice('')
    try {
      const item = await api<Visit>(`/visits/${selected.id}/confirm`, { method: 'POST', body: JSON.stringify({ version: selected.version, redacted_text: redacted, redaction_confirmed: true, speakers }) })
      choose(item); setRows(current => [item, ...(current ?? []).filter(row => row.id !== item.id)]); setNotice('已提交审核；管理员审核后才能用于团队训练。')
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function upload(file: File | undefined) {
    if (!selected || !file) return
    if (!authorized) { setError('请先确认您有权导入和处理此录音。'); return }
    const type = audioContentType(file.name, file.size)
    if (!type) { setError('请选择不超过 100 MB 的 MP3、M4A 或 WAV 录音。'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const duration = await new Promise<number>((resolve, reject) => {
        const url = URL.createObjectURL(file); const audio = document.createElement('audio')
        audio.preload = 'metadata'
        audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(audio.duration) }
        audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取录音，请检查文件格式。')) }
        audio.src = url
      })
      if (!validAudioDuration(duration)) throw new Error('录音时长须大于 0 且不超过 30 分钟。')
      const item = await api<Visit>(`/visits/${selected.id}/audio`, { method: 'POST', body: file, headers: { 'Content-Type': type, 'X-Recording-Authorized': 'true' }, timeoutMs: 120000 })
      choose(item); setRows(current => [item, ...(current ?? []).filter(row => row.id !== item.id)]); setNotice('录音已上传，请主动启动转写。')
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  function dictate() {
    if (recording) { recognition.current?.stop(); return }
    const speech = window as RecognitionWindow
    const Speech = speech.SpeechRecognition || speech.webkitSpeechRecognition
    if (!Speech) { setError('当前设备不支持语音输入，请使用文字记录。'); return }
    const base = draft.text
    const instance = new Speech(); recognition.current = instance
    instance.lang = 'zh-CN'; instance.continuous = true; instance.interimResults = false
    instance.onresult = event => { const parts = Array.from(event.results).filter(row => row.isFinal).map(row => row[0].transcript); setDraft(current => ({ ...current, text: base + parts.join('') })) }
    instance.onerror = () => { setError('语音输入中断，请检查权限并核对文字。'); setRecording(false) }
    instance.onend = () => { setRecording(false); recognition.current = null }
    try { instance.start(); setRecording(true) } catch { setError('无法启动语音输入，请检查麦克风权限。') }
  }
  const feedback = <>
    {error && <Alert variant="destructive" role="alert"><TriangleAlert /><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <Alert role="status"><CheckCircle2 /><AlertTitle>日记状态已更新</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
  </>
  return <div className="mx-auto max-w-3xl space-y-5">
    <header className="space-y-4">
      <div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">拜访记录</h1></div><Button className="h-11 shrink-0" variant="ghost" aria-label="刷新日记列表" disabled={busy} onClick={() => void reload().catch(e => setError(message(e)))}><RotateCcw /></Button></div>
      <Button className="h-11 w-full sm:w-auto" disabled={busy || recording} onClick={() => navigate({ kind: 'new' })}><Plus />{draft.text || draft.doctor_id || draft.drug_id ? '继续未保存的日记' : '新建日记'}</Button>
    </header>
    {view.kind === 'list' && feedback}
    <section aria-label="我的拜访记录">
      {rows === null ? <p role="status" className="py-4 text-sm text-muted-foreground">正在加载日记…</p> : rows.length === 0 ? <div className="flex items-start gap-3 rounded-xl border bg-card p-5 text-sm leading-6 text-muted-foreground"><NotebookPen className="mt-0.5 size-5 shrink-0" /><p>暂无拜访日记</p></div> : <Card className="gap-0 py-0"><ul className="divide-y">{rows.map(row => <li key={row.id}><Button type="button" variant="ghost" disabled={busy || recording} className="h-auto min-h-20 w-full justify-between gap-3 rounded-none px-4 py-4 text-left font-normal" onClick={() => navigate({ kind: 'detail', id: row.id })}><span className="min-w-0 space-y-1"><span className="block font-medium tabular-nums">{row.visited_at}</span><span className="block text-xs text-muted-foreground">{row.source === 'recording' ? '真实拜访录音' : '访后自述'} · {row.status}</span><span className="block whitespace-normal text-xs leading-5 text-muted-foreground">{audioLabel(row.audio_status)}</span></span><ChevronRight className="shrink-0 text-muted-foreground" /></Button></li>)}</ul></Card>}
    </section>
    <Dialog open={view.kind !== 'list'} onOpenChange={open => { if (!open) returnToList() }}>
      <DialogContent fullscreen showCloseButton={false} className="inset-0 top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 gap-3 border-b bg-background px-4 py-4 sm:px-6">
          <Button className="-ml-3 h-11 self-start" variant="ghost" disabled={busy} onClick={returnToList}><ArrowLeft />返回日记列表</Button>
          <DialogTitle className="text-xl font-semibold">{view.kind === 'new' ? '新建日记' : '拜访记录'}</DialogTitle>
          <DialogDescription className="sr-only">{view.kind === 'new' ? '填写访后观察及拜访信息' : '查看原文、脱敏内容及审核状态'}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
          <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
            {feedback}
    {view.kind === 'new' && <Card className="min-w-0">
        <CardContent><form onSubmit={create} className="space-y-5">
          <Field label="访后观察" htmlFor="visit-observation"><Textarea id="visit-observation" className="min-h-36 leading-7" value={draft.text} disabled={recording} onChange={e => setDraft(current => ({ ...current, text: e.target.value }))} maxLength={20000} placeholder="记下拜访情境、医生关注的问题，以及下一步计划。不要填写患者身份或病历细节。" /></Field>
          <Button className="h-11" type="button" variant="outline" onClick={dictate}><Mic />{recording ? '停止语音输入' : '语音输入'}</Button>
          <div className="grid grid-cols-2 gap-3 border-t pt-5">
            <Field label="拜访医生" htmlFor="visit-doctor"><Select name="doctor_id" required value={draft.doctor_id} onValueChange={doctor_id => setDraft(current => ({ ...current, doctor_id }))}><SelectTrigger id="visit-doctor" className="w-full"><SelectValue placeholder="选择医生" /></SelectTrigger><SelectContent>{doctors.map(d => <SelectItem key={d.id} value={d.id}>{d.display_name || d.name}</SelectItem>)}</SelectContent></Select></Field>
            <Field label="相关药品" htmlFor="visit-drug"><Select name="drug_id" required value={draft.drug_id} onValueChange={drug_id => setDraft(current => ({ ...current, drug_id }))}><SelectTrigger id="visit-drug" className="w-full"><SelectValue placeholder="选择药品" /></SelectTrigger><SelectContent>{drugs.map(d => <SelectItem key={d.id} value={d.id}>{d.brand ? `${d.brand} · ` : ''}{d.name}</SelectItem>)}</SelectContent></Select></Field>
            <Field label="拜访日期" htmlFor="visit-date"><Input id="visit-date" className="h-11" type="date" name="visited_at" required value={draft.visited_at} onChange={e => setDraft(current => ({ ...current, visited_at: e.target.value }))} /></Field>
            <Field label="记录来源" htmlFor="visit-source"><Select name="source" value={draft.source} onValueChange={source => setDraft(current => ({ ...current, source }))}><SelectTrigger id="visit-source" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="self_report">访后文字</SelectItem><SelectItem value="voice">访后语音自述</SelectItem><SelectItem value="recording">真实拜访录音</SelectItem></SelectContent></Select></Field>
          </div>
          <div className="space-y-3 border-t pt-5"><Button className="h-11 w-full sm:w-auto" type="submit" disabled={busy || recording}>{busy ? '正在保存…' : '保存草稿'}</Button><p className="text-xs leading-6 text-muted-foreground">管理员可查看全部记录；只有经脱敏和审核的内容可用于团队训练。语音输入由设备或浏览器服务商处理，请核对文字。</p></div>
        </form></CardContent>
      </Card>}
    {view.kind === 'detail' && (selected?.id !== visitId ? !error && <p role="status" className="py-6 text-sm text-muted-foreground">正在读取拜访记录…</p> : <Card className="min-w-0">
        <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><CardTitle><h2>{selected.visited_at} · {selected.source === 'recording' ? '真实拜访录音' : '访后自述'}</h2></CardTitle><Badge variant="outline">{selected.status}</Badge></div><CardDescription>录音：{audioLabel(selected.audio_status)}</CardDescription></CardHeader>
        <CardContent className="space-y-6">
          {selected.review && <Alert><AlertTitle>审核结果：{({ scenario: '可作为训练情境', needs_evidence: '待补充依据', reject: '未采纳' } as Record<string, string>)[selected.review.decision] || selected.review.decision}</AlertTitle><AlertDescription>{selected.review.reason}</AlertDescription></Alert>}
          {selected.source === 'self_report' && selected.private_audio && selected.audio_status === 'none' && <SelfReportRecorder visitId={selected.id} onUploaded={() => void selectVisit(selected.id)}/>}
          {selected.source === 'self_report' && selected.private_audio && selected.audio_status !== 'none' && <div className="flex flex-wrap gap-3 rounded-lg bg-muted/40 p-4">{['transcription_unavailable', 'transcription_interrupted'].includes(selected.audio_status) && <Button className="h-11" variant="outline" disabled={busy} onClick={() => void transcribe()}>启动转写</Button>}{['queued', 'transcribing'].includes(selected.audio_status) && <Button className="h-11" variant="outline" disabled={busy} onClick={() => void transcribe(true)}>取消转写</Button>}{selected.audio_status !== 'deleted' && <Button asChild className="h-11" variant="link"><a href={`/api/visits/${encodeURIComponent(selected.id)}/audio`}>回听自述录音</a></Button>}</div>}
          {selected.source === 'recording' && <section className="space-y-4 rounded-lg bg-muted/40 p-4" aria-label="录音上传与转写"><p className="text-sm leading-6">录音将由第三方语音服务处理，管理员可查看原音频。首次确认转写后 7 天删除，最长保留至上传后 30 天。</p><label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6"><Checkbox className="mt-1 shrink-0" checked={authorized} onCheckedChange={value => setAuthorized(value === true)} /><span>我已取得录制及处理所需授权，了解处理方式和可见范围。</span></label><Field label="选择录音" htmlFor="visit-audio"><Input id="visit-audio" className="h-11" type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav" disabled={busy || !authorized || selected.audio_status !== 'none'} onChange={e => { void upload(e.target.files?.[0]); e.currentTarget.value = '' }} /></Field><div className="flex flex-wrap gap-3">{['transcription_unavailable', 'transcription_interrupted'].includes(selected.audio_status) && <Button className="h-11" variant="outline" disabled={busy} onClick={() => void transcribe()}>启动转写</Button>}{['queued', 'transcribing'].includes(selected.audio_status) && <Button className="h-11" variant="outline" disabled={busy} onClick={() => void transcribe(true)}>取消转写</Button>}{selected.audio_status && !['none', 'deleted'].includes(selected.audio_status) && <Button asChild className="h-11" variant="link"><a href={`/api/visits/${encodeURIComponent(selected.id)}/audio`}>回听原音频</a></Button>}</div></section>}
          {selected.segments && selected.segments.length > 0 && <section className="space-y-3"><h3 className="text-sm font-medium">转写片段</h3><ul className="max-h-80 space-y-3 overflow-auto">{selected.segments.map((segment, index) => <li key={index} className="rounded-lg bg-muted/30 p-3 text-sm leading-7"><span className="text-xs text-muted-foreground">{segment.speaker_id || '未知'} · {segment.start_time == null ? '时间未知' : `${Math.floor(segment.start_time / 1000)} 秒`}</span><p className="whitespace-pre-wrap break-words">{segment.text}</p></li>)}</ul></section>}
          <section className="space-y-3"><Field label="原始自述或转写" htmlFor="visit-original"><Textarea id="visit-original" className="min-h-40 leading-7" disabled={['queued', 'transcribing'].includes(selected.audio_status)} value={text} onChange={e => setText(e.target.value)} maxLength={20000} /></Field><Button className="h-11" variant="outline" onClick={() => void save()} disabled={busy || ['queued', 'transcribing'].includes(selected.audio_status)}>保存修改</Button></section>
          {speakers.length > 0 && <fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-medium">确认说话人</legend>{speakers.map((speaker, index) => <Field key={speaker.speaker_id} label={speaker.speaker_id} htmlFor={`visit-speaker-${index}`}><Select value={speaker.role} onValueChange={value => setSpeakers(current => current.map((row, i) => i === index ? { ...row, role: value as Speaker['role'] } : row))}><SelectTrigger id={`visit-speaker-${index}`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(roles).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select></Field>)}</fieldset>}
          <section className="space-y-4 border-t pt-6" aria-label="脱敏与提交"><Field label="脱敏后用于审核的文字" htmlFor="visit-redacted"><Textarea id="visit-redacted" className="min-h-40 leading-7" value={redacted} onChange={e => setRedacted(e.target.value)} maxLength={20000} placeholder="删除患者身份、病历细节和其他不应共享的信息后填写。" /></Field><Button className="h-11" variant="outline" onClick={() => void suggestRedaction()} disabled={busy || text !== selected.text}>填入脱敏建议</Button><label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6"><Checkbox className="mt-1 shrink-0" checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} /><span>我已核对转写、说话人及脱敏内容。</span></label>{text !== selected.text && <p className="text-sm text-muted-foreground">请先保存对原始内容的修改，再确认脱敏内容。</p>}<Button className="h-11 w-full sm:w-auto" onClick={() => void confirm()} disabled={busy || ['queued', 'transcribing'].includes(selected.audio_status) || !confirmed || !redacted.trim() || text !== selected.text}>{busy ? '正在提交…' : '提交审核'}</Button></section>
        </CardContent>
      </Card>)}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
    <Dialog open={pendingVisit !== null} onOpenChange={open => { if (!open) { if (selected) navigate({ kind: 'detail', id: selected.id }) } }}><DialogContent><DialogHeader><DialogTitle>当前记录有未保存的修改</DialogTitle><DialogDescription>切换记录会丢弃当前原文、脱敏内容或说话人的修改。可以先返回当前记录保存。</DialogDescription></DialogHeader><DialogFooter><Button className="h-11" variant="outline" onClick={() => { if (selected) navigate({ kind: 'detail', id: selected.id }) }}>返回当前记录</Button><Button className="h-11" variant="destructive" onClick={() => { setSelected(null) }}>丢弃修改并切换</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
