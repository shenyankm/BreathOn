import { AudienceMetrics } from '@/components/audience-metrics'
import { useEffect, useState, type FormEvent } from 'react'
import { BriefcaseBusiness, Stethoscope, HeartPulse } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/platform-api'

type AudienceType = 'representative' | 'doctor' | 'health'
type Audience = { id: string; version: number; name: string; audience_type: AudienceType; task: string; needs: string[]; metrics: string[]; updated_at: string }
const types = [
  { id: 'representative', title: '医药代表', icon: BriefcaseBusiness, note: '找到正确证据，适配医生的沟通需求，准备拜访与复盘。' },
  { id: 'doctor', title: '医生用户', icon: Stethoscope, note: '关注临床问题、证据来源、患者负担与实际可操作性。' },
  { id: 'health', title: '健康管理用户', icon: HeartPulse, note: '关注易懂的趋势解释、隐私与授权；不代表已接入健康数据。' },
] as const
export function AdminAudiences() {
  const [rows, setRows] = useState<Audience[]>([])
  const [category, setCategory] = useState<AudienceType>('representative')
  const [selected, setSelected] = useState<string>()
  const [editing, setEditing] = useState<Audience | null | undefined>()
  const [error, setError] = useState(''), [saveError, setSaveError] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api<Audience[]>('/catalog/audience', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setRows(data) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  const matches = rows.filter(row => row.audience_type === category)
  const detail = matches.find(row => row.id === selected) ?? matches[0]
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setSaveError('')
    const data = new FormData(event.currentTarget)
    const lines = (key: string) => String(data.get(key) ?? '').split('\n').map(value => value.trim()).filter(Boolean)
    const body = { name: data.get('name'), audience_type: data.get('audience_type'), task: data.get('task'), needs: lines('needs'), metrics: lines('metrics'), ...(editing ? { version: editing.version } : {}) }
    try {
      const saved = await api<Audience>(`/catalog/audience${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) })
      setRows(current => [saved, ...current.filter(row => row.id !== saved.id)]); setCategory(saved.audience_type); setSelected(saved.id); setEditing(undefined); setNotice('画像已保存。')
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : '保存失败，请重试。') }
    finally { setBusy(false) }
  }
  function edit(row: Audience | null) { setSaveError(''); setNotice(''); setEditing(row) }
  return <div className="space-y-6">
    <div className="admin-view-head"><div className="admin-heading"><h1>用户画像</h1><p>画像用于内容规划，不代表个人账号或实际测量结果。</p></div><div className="flex gap-2"><Button variant="outline" disabled={loading} onClick={() => { setLoading(true); setError(''); setRefresh(value => value + 1) }}>刷新</Button><Button disabled={loading || !!error} onClick={() => edit(null)}>创建画像</Button></div></div>
    {error && <p role="alert" className="admin-notice">无法读取用户画像：{error}。请刷新重试。</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="admin-audience-grid">{types.map(type => <button type="button" key={type.id} className="admin-panel admin-audience-card" aria-pressed={category === type.id} onClick={() => { setCategory(type.id); setSelected(undefined) }}><type.icon aria-hidden="true" /><h2 className="text-lg font-semibold">{type.title}</h2><p className="my-3 text-sm leading-7 text-muted-foreground">{type.note}</p><span className="text-xs font-medium">{loading ? '正在读取…' : error ? '数量未能读取' : `${rows.filter(row => row.audience_type === type.id).length} 个已保存画像`}</span></button>)}</div>
    <section className="admin-panel space-y-5" aria-label="用户画像详情" aria-busy={loading}>{loading ? <p role="status">正在读取画像…</p> : error ? <p>数据暂不可用，请刷新后查看。</p> : !detail ? <div className="py-8 text-center"><h2 className="font-semibold">暂无{types.find(type => type.id === category)?.title}画像</h2><p className="my-3 text-sm text-muted-foreground">创建后可维护核心任务、需求与评价指标。</p><Button variant="outline" onClick={() => edit(null)}>创建此类画像</Button></div> : <>
      {matches.length > 1 && <div className="flex flex-wrap gap-2" aria-label="选择画像">{matches.map(row => <Button key={row.id} variant={detail.id === row.id ? 'secondary' : 'outline'} aria-pressed={detail.id === row.id} onClick={() => setSelected(row.id)}>{row.name}</Button>)}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{detail.name}</h2><p className="mt-2 text-xs text-muted-foreground">最近更新：{new Date(detail.updated_at).toLocaleString('zh-CN')}</p></div><Button variant="outline" onClick={() => edit(detail)}>编辑画像</Button></div>
      <p className="whitespace-pre-wrap text-sm leading-7">{detail.task}</p><div className="admin-training-grid">{[{title:'核心需求', values:detail.needs}, {title:'评价指标（规划）', values:detail.metrics}].map(({title, values}) => <div key={title} className="rounded-xl bg-muted/60 p-5"><h3 className="mb-3 text-sm font-semibold">{title}</h3>{values.length ? <ul className="list-inside list-disc space-y-2 text-sm leading-7">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="text-sm text-muted-foreground">尚未设置</p>}</div>)}</div>
    </>}</section>
    <AudienceMetrics/>
    <Dialog open={editing !== undefined} onOpenChange={open => { if (!open && !busy) setEditing(undefined) }}><DialogContent showCloseButton={!busy} className="max-h-[90svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{editing ? '编辑用户画像' : '创建用户画像'}</DialogTitle><DialogDescription>描述目标人群与任务，请勿填写个人敏感信息。</DialogDescription></DialogHeader>
      <form key={editing?.id ?? 'new'} onSubmit={save} className="space-y-4"><fieldset disabled={busy} className="space-y-4">
        <Label className="grid gap-2">画像名称<Input name="name" defaultValue={editing?.name ?? ''} required maxLength={120} /></Label>
        <Label className="grid gap-2">用户类型<Select name="audience_type" defaultValue={editing?.audience_type ?? category}><SelectTrigger className="w-full" aria-label="用户类型"><SelectValue /></SelectTrigger><SelectContent>{types.map(type => <SelectItem key={type.id} value={type.id}>{type.title}</SelectItem>)}</SelectContent></Select></Label>
        <Label className="grid gap-2">核心任务<Textarea name="task" defaultValue={editing?.task ?? ''} required maxLength={2000} rows={3} /></Label>
        <Label className="grid gap-2">核心需求（每行一项，最多 20 项）<Textarea name="needs" defaultValue={editing?.needs.join('\n') ?? ''} required maxLength={4020} rows={3} /></Label>
        <Label className="grid gap-2">评价指标（每行一项，最多 20 项）<Textarea name="metrics" defaultValue={editing?.metrics.join('\n') ?? ''} maxLength={4020} rows={3} /></Label>
      </fieldset>{saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(undefined)}>取消</Button><Button type="submit" disabled={busy}>{busy ? '正在保存…' : '保存画像'}</Button></div></form>
    </DialogContent></Dialog>
  </div>
}
