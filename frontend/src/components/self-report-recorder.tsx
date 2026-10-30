import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { api } from '@/lib/platform-api'

export function SelfReportRecorder({ visitId, onUploaded }: { visitId: string; onUploaded: () => void }) {
  const [consent, setConsent] = useState(false)
  const [recording, setRecording] = useState(false)
  const [audio, setAudio] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  const timer = useRef<number | undefined>(undefined)
  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    else stream.current?.getTracks().forEach(track => track.stop())
    window.clearTimeout(timer.current)
  }
  useEffect(() => {
    alive.current = true
    const hidden = () => { if (document.visibilityState === 'hidden') stop() }
    document.addEventListener('visibilitychange', hidden)
    return () => { alive.current = false; document.removeEventListener('visibilitychange', hidden); stop(); stream.current?.getTracks().forEach(track => track.stop()) }
  }, [])
  async function start() {
    setError('')
    if (!consent || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('请确认处理说明；若设备不支持录音，请使用文字记录。'); return }
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(value => MediaRecorder.isTypeSupported(value))
    if (!type) { setError('当前设备不支持所需录音格式，请使用文字记录。'); return }
    setBusy(true)
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!alive.current || document.visibilityState === 'hidden') { input.getTracks().forEach(track => track.stop()); return }
      stream.current = input
      const instance = new MediaRecorder(input, { mimeType: type })
      const chunks: Blob[] = []
      let failed = false
      recorder.current = instance
      instance.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      instance.onerror = () => { failed = true; if (instance.state !== 'inactive') instance.stop(); input.getTracks().forEach(track => track.stop()); if (alive.current) { setRecording(false); setError('录音失败，请重试。') } }
      instance.onstop = () => {
        input.getTracks().forEach(track => track.stop()); stream.current = null; recorder.current = null
        if (alive.current) { setRecording(false); if (!failed && chunks.length) setAudio(new Blob(chunks, { type: type.split(';')[0] })) }
      }
      setAudio(null); instance.start(); setRecording(true)
      timer.current = window.setTimeout(stop, 120000)
    } catch { stream.current?.getTracks().forEach(track => track.stop()); setError('无法使用麦克风，请检查系统权限后重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  async function upload() {
    if (!audio || !consent) return
    setBusy(true); setError('')
    try {
      await api(`/visits/${encodeURIComponent(visitId)}/audio`, { method: 'POST', body: audio, headers: { 'Content-Type': audio.type, 'X-Recording-Authorized': 'true' }, timeoutMs: 120000 })
      setAudio(null); onUploaded()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败，请重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="space-y-3 rounded-lg bg-muted/40 p-4"><h3 className="font-medium">录制访后自述</h3><p className="text-sm leading-6">请在拜访结束后口述，最长两分钟。录音会上传并由第三方语音服务转写，管理员可查看；首次确认转写后 7 天删除，最长保存 30 天。</p><label htmlFor={`self-report-consent-${visitId}`} className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6"><Checkbox id={`self-report-consent-${visitId}`} className="mt-1" checked={consent} disabled={recording || busy} onCheckedChange={value => setConsent(value === true)} /><span>我了解录音的处理方式与可见范围。</span></label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex flex-wrap gap-2"><Button className="h-11" type="button" variant="outline" disabled={busy || !consent} onClick={() => recording ? stop() : void start()}>{recording ? '停止录音' : audio ? '重新录音' : '开始录音'}</Button>{audio && <Button className="h-11" type="button" disabled={busy || recording || !consent} onClick={() => void upload()}>{busy ? '正在上传…' : '上传录音'}</Button>}</div>{audio && <p role="status" className="text-sm">录音暂存于当前页面，请在离开前上传，再启动转写。</p>}</div>
}
