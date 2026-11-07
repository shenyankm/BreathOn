import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/platform-api'
import type { StartTraining } from './scenario-picker'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

type Challenge = { id: string; version: number; status: string; text: string; visited_at: string;
  review?: { decision: string; reason: string } | null; scenarios: { id: string; title: string }[] }
const labels: Record<string, string> = { draft: '草稿待提交', submitted: '等待培训师核对', reviewed: '培训师已反馈' }

export function FieldChallenge({ onStart }: { onStart: StartTraining }) {
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [confirmed, setConfirmed] = useState(false), [rows, setRows] = useState<Challenge[]>([])
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const draft = useRef<{ id: string; version: number } | null>(null), posting = useRef(false), requestId = useRef('')
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    api<Challenge[]>('/training/challenges', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setRows(data); setError('') } })
      .catch(() => { if (!controller.signal.aborted) setError('暂时无法读取难题进展，请刷新重试。') })
    return () => controller.abort()
  }, [open, refresh])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (posting.current || !confirmed || !text.trim()) return
    posting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const body = { visited_at: date, text: text.trim(), doctor_id: '', drug_id: '' }
      const saved = draft.current
        ? await api<{ id: string; version: number }>(`/visits/${draft.current.id}`, { method: 'PUT', body: JSON.stringify({ ...body, version: draft.current.version }) })
        : await api<{ id: string; version: number }>('/visits', { method: 'POST', body: JSON.stringify({ ...body, source: 'self_report', training_challenge: true, request_id: requestId.current ||= crypto.randomUUID() }) })
      draft.current = saved
      await api(`/visits/${saved.id}/confirm`, { method: 'POST', body: JSON.stringify({ version: saved.version, redacted_text: text.trim(), redaction_confirmed: true, speakers: [] }) })
      draft.current = null; requestId.current = ''; setText(''); setConfirmed(false); setRefresh(value => value + 1)
      setNotice('难题已提交。培训师确认后可用于新场景，发布后的练习入口会显示在下方。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交未完成，请重试。')
      // Reconcile uncertain writes before allowing another create.
      try {
        const saved = await api<Challenge[]>('/training/challenges')
        setRows(saved)
        const match = saved.find(row => row.text === text.trim() && row.visited_at === date)
        if (match?.status === 'draft') draft.current = match
        else if (match) { draft.current = null; requestId.current = ''; setText(''); setConfirmed(false); setError(''); setNotice('已找到提交结果，请查看下方进展。') }
      } catch { setNotice('请先刷新进展，确认是否已有草稿后再提交，避免重复记录。') }
    } finally { posting.current = false; setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" className="min-h-11">记录一个拜访难题</Button></DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto"><DialogHeader><DialogTitle>把拜访难题变成练习</DialogTitle><DialogDescription>记录一个需要练习的沟通问题，培训师核对后转成模拟情境。</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => void submit(event)}><fieldset disabled={busy} className="space-y-4">
        <Label className="grid gap-2">拜访日期<Input aria-label="拜访日期" type="date" required value={date} onChange={event => setDate(event.target.value)} /></Label>
        <Label className="grid gap-2">这次遇到什么沟通难题？<Textarea aria-label="拜访沟通难题" required maxLength={2000} value={text} onChange={event => { setText(event.target.value); setConfirmed(false) }} placeholder="例如：医生问研究人群与当前沟通对象是否一致，我没能先确认关注点。" /></Label>
        <Label className="flex min-h-11 items-start gap-3"><Checkbox className="mt-1" checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} /><span className="text-sm leading-6">我已去除姓名、联系方式和患者身份信息，确认将这段脱敏内容提交给培训师用于模拟训练。</span></Label>
        <Button className="min-h-11" disabled={busy || !confirmed || !text.trim()}>{busy ? '正在提交…' : '提交脱敏难题'}</Button>
      </fieldset></form>
      {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}{notice && <p role="status" className="text-sm leading-6">{notice}</p>}
      <section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">我的难题进展</h2><Button variant="ghost" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新进展</Button></div>
        {!rows.length && <p className="text-sm text-muted-foreground">还没有提交难题。只需记录一个具体问题。</p>}
        {rows.map(row => <article key={row.id} className="space-y-2 py-2"><p className="text-sm text-muted-foreground">{row.visited_at} · {labels[row.status] ?? row.status}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{row.text}</p>{row.review && <p className="text-sm leading-7">培训师反馈：{row.review.reason}</p>}
          {row.status === 'draft' && <Button variant="outline" disabled={busy} onClick={() => { draft.current = row; setText(row.text); setDate(row.visited_at); setConfirmed(false) }}>继续编辑草稿</Button>}
          {row.review?.decision === 'scenario' && !row.scenarios.length && <p className="text-sm text-muted-foreground">已采纳为训练情境，等待场景生成与发布。</p>}
          {row.scenarios.map(scene => <Button key={scene.id} variant="outline" className="h-auto min-h-11 whitespace-normal text-left" onClick={() => { setOpen(false); onStart({ scenario_id: scene.id, stage: 'full' }) }}>练习这个难题：{scene.title}</Button>)}
        </article>)}
      </section>
    </DialogContent>
  </Dialog>
}
