import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/form-field'
import { ResearchFindings, DoctorCandidates, type Job } from '@/components/research-panel'
import { api } from '@/lib/platform-api'
import type { DoctorDraft } from '@/lib/catalog-types'

export function DoctorGenerator({ onGenerated, onOpen }: { onGenerated: (id: string, draft: DoctorDraft) => void; onOpen: (id: string) => void }) {
  const [configured, setConfigured] = useState<boolean>()
  const [job, setJob] = useState<Job>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void api<{ configured: boolean; jobs: Job[] }>('/research', { signal: controller.signal }).then(state => {
      setConfigured(state.configured)
      setJob(state.jobs.find(item => item.doctor_identity))
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '检索配置暂不可读取。') })
    return () => { controller.abort(); request.current?.abort() }
  }, [refresh])

  useEffect(() => {
    if (job?.status !== 'running') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    async function load() {
      try {
        const next = await api<Job>(`/research/jobs/${job!.id}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        failures = 0; setError('')
        setJob(current => current?.id === next.id && current.status === 'running' ? next : current)
        if (next.status === 'running') timer = setTimeout(() => void load(), 2000)
      } catch (cause) {
        if (controller.signal.aborted) return
        failures += 1
        setError(`进度连接暂时中断，后台检索可能仍在继续。${failures <= 3 ? `正在重试（${failures}/3）…` : '自动重试已停止，请重新读取进度。'}${cause instanceof Error ? cause.message : ''}`)
        if (failures <= 3) timer = setTimeout(() => void load(), 2000 * failures)
      }
    }
    timer = setTimeout(() => void load(), 1000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [job?.id, job?.status, refresh])

  async function mutate(path: string, body?: object) {
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try {
      const next = await api<Job>(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal })
      if (!controller.signal.aborted) setJob(next)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '操作未完成，请重新读取进度后再试。')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function confirmCandidate(index: number, name: string) {
    if (!job || busy) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try {
      const draft = await api<{id:string}>(`/research/jobs/${job.id}/doctor-draft`, { method:'POST', body:JSON.stringify({finding_index:index, confirmed_identity:true, confirmed_name:name}), signal:controller.signal })
      if (!controller.signal.aborted) onOpen(draft.id)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '候选确认未完成，请重试。')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || job?.status === 'running' || !configured) return
    const data = new FormData(event.currentTarget)
    void mutate('/research/doctor-jobs', Object.fromEntries(['name', 'hospital', 'department'].map(key => [key, String(data.get(key) ?? '').trim()])))
  }
  const running = job?.status === 'running'

  return <section aria-labelledby="doctor-generator-title" className="space-y-5 rounded-xl border bg-background p-5">
    <div className="space-y-2"><h3 id="doctor-generator-title" className="text-base font-medium">联网生成医生画像草稿</h3><p className="text-sm leading-7 text-muted-foreground">输入身份信息，检索公开背景与来源。核对草稿后保存、发布，即可搭配已发布药品自由练习；评分练习还需创建并发布场景。</p></div>
    {configured === undefined && !error && <p role="status" className="text-sm text-muted-foreground">正在读取检索配置…</p>}
    {configured === false && <p role="status" className="text-sm leading-7">需配置 DeepSeek 并开启公开搜索。<a href="#settings" className="ml-2 underline underline-offset-4">查看服务设置</a></p>}
    <form onSubmit={generate}><fieldset disabled={busy || running || !configured} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3"><Field label="医生姓名" name="name" maxLength={60}/><Field label="医院" name="hospital" maxLength={80}/><Field label="科室" name="department" maxLength={50}/></div>
      <div className="flex flex-wrap items-center gap-4"><Button type="submit" className="h-11">{running ? '正在检索并生成…' : '联网检索并生成草稿'}</Button><p className="text-xs leading-6 text-muted-foreground">仅点击后发起检索，会产生模型与搜索用量。</p></div>
    </fieldset></form>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p className="text-destructive">{error}</p><Button variant="outline" className="h-11" onClick={() => { setConfigured(undefined); setError(''); setRefresh(value => value + 1) }}>重新读取进度</Button></div>}
    {job && <div className="space-y-4 border-t pt-5">
      <p className="text-sm leading-7">最近检索：{job.query}</p>
      {running ? <div className="flex flex-wrap items-center gap-4"><p role="status" className="text-sm leading-7">正在检索与归档原文，已搜索 {job.progress?.searches ?? 0} 次，已归档 {job.progress?.archives ?? 0} 份。</p><Button variant="outline" className="h-11" disabled={busy} onClick={() => void mutate(`/research/jobs/${job.id}/cancel`)}>停止检索</Button></div>
        : <p role="status" className="text-sm leading-7">{job.doctor_id ? '本次画像已保存为医生角色，可打开查看或继续编辑。' : job.doctor_draft ? '画像草稿已生成，待人工核对。' : job.status === 'interrupted' ? '检索已停止，已归档资料保留。' : '本次未自动生成画像草稿。若下方有候选，可核对身份后创建；否则请调整身份信息后重试。'}</p>}
      {job.error && <p className="text-sm leading-7 text-destructive">{job.error}</p>}
      {job.doctor_draft_error && <p role="alert" className="text-sm leading-7 text-destructive">{job.doctor_draft_error}</p>}
      {job.status === 'partial' && <p className="text-sm leading-7 text-muted-foreground">部分来源未完成核对，请先检查下方事实、原文与待核对项。</p>}
      {job.result && <details className="text-sm"><summary className="min-h-11 cursor-pointer font-medium leading-11">核对检索事实与原文</summary><div className="space-y-4 pt-3"><ResearchFindings job={job}/></div></details>}
      {Boolean(job.source_errors?.length) && <ul className="list-inside list-disc space-y-2 text-sm leading-7 text-muted-foreground">{job.source_errors!.map((failure, index) => <li key={index}>{failure.message}{failure.url && <a className="ml-2 break-all underline underline-offset-4" href={failure.url} target="_blank" rel="noreferrer">查看未完成的来源</a>}</li>)}</ul>}
      {!job.doctor_id && !job.doctor_draft && <DoctorCandidates job={job} busy={busy} onConfirm={(index, name) => void confirmCandidate(index, name)}/>}
      {job.doctor_id ? <Button variant="outline" className="h-11" onClick={() => onOpen(job.doctor_id!)}>查看已保存的医生角色</Button> : job.doctor_draft && <Button variant="outline" className="h-11" onClick={() => onGenerated(job.id, job.doctor_draft!)}>核对并编辑画像草稿</Button>}
    </div>}
  </section>
}
