import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserAudio, encodeAudio } from '@/lib/audio/browser-audio'
import { formatTime } from '@/lib/session'
import type { FreePracticeContext, TrainingSnapshot } from '@/lib/catalog-types'
import { applyTranscript, type VoiceMessage, type LiveCoach } from '@/lib/voice-events'
import type { TrainingChoice } from '@/components/scenario-picker'
import { invalidateMedicalCheck, updateMedicalChecks, type MedicalCheck } from '@/lib/medical'

type Status = 'idle' | 'connecting' | 'active' | 'ended' | 'error'
type PolicyCheck = { message_id: string; text: string; rule_id: string; quote: string; reason: string; risk: string; status: string; action: string; article: string; policy_quote: string; policy_title: string; source_url: string }
type Connection = { startup: AbortController; ws?: WebSocket; audio: BrowserAudio; closing: boolean; finished?: boolean; finishTimeout?: number; response?: string; responseMessage?: string; retired: Set<string>; started: number; experience: 'practice' | 'combat'; policyPaused?: boolean; resumeMuted?: boolean }

export function useVoiceSession() {
  const [status, setStatus] = useState<Status>('idle')
  const [mode, setMode] = useState('assisted')
  const [messages, setMessages] = useState<VoiceMessage[]>([])
  const [error, setError] = useState('')
  const [muted, setMuted] = useState(false)
  const [outputMuted, setOutputMuted] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [retryingSave, setRetryingSave] = useState(false)
  const saveRetry = useRef(false)
  const [seconds, setSeconds] = useState(0)
  const [coach, setCoach] = useState<LiveCoach | null>(null)
  const [medicalChecks, setMedicalChecks] = useState<MedicalCheck[]>([])
  const [policyChecks, setPolicyChecks] = useState<PolicyCheck[]>([])
  const [policyUnavailable, setPolicyUnavailable] = useState<{message_id:string;text:string}[]>([])
  const [policyPaused, setPolicyPaused] = useState(false)
  const medicalText = useRef(new Map<string, string>())
  const [practiceState, setPracticeState] = useState<'listening' | 'thinking' | 'error'>('listening')
  const [analysisStatus, setAnalysisStatus] = useState('not_started')
  const [speechState, setSpeechState] = useState('idle')
  const [training, setTraining] = useState<TrainingSnapshot | null>(null)
  const [freeContext, setFreeContext] = useState<FreePracticeContext | null>(null)
  const connection = useRef<Connection | null>(null)

  const stop = useCallback(() => {
    const current = connection.current
    if (!current || current.closing) return
    current.closing = true
    current.startup.abort()
    setSaving(!!current.started && current.ws?.readyState === WebSocket.OPEN)
    if (current.started && (current.experience === 'combat' || training || freeContext)) setAnalysisStatus('thinking')
    current.audio.stop()
    if (current.ws?.readyState === WebSocket.OPEN) {
      current.ws.send(JSON.stringify({ type: 'stop' }))
      current.finishTimeout = window.setTimeout(() => current.ws?.close(), 90000)
    } else current.ws?.close()
    setStatus(previous => previous === 'error' ? 'error' : 'ended')
  }, [training, freeContext])

  const start = useCallback(async (mode: string, experience: 'practice' | 'combat', selection?: TrainingChoice) => {
    const old = connection.current
    if (old) { old.startup.abort(); old.closing = true; old.audio.stop(); old.ws?.close() }
    const current: Connection = { startup: new AbortController(), audio: new BrowserAudio(), closing: false, retired: new Set(), started: 0, experience }
    connection.current = current
    setSaving(false); setStatus('connecting'); setMessages([]); setMedicalChecks([]); setPolicyChecks([]); setPolicyUnavailable([]); setPolicyPaused(false); setError(''); setMuted(false); setOutputMuted(false); setSessionId(''); setSaved(false); setSeconds(0); setCoach(null); setPracticeState('listening')
    medicalText.current.clear()
    setAnalysisStatus('not_started')
    setSpeechState('idle'); setTraining(null); setFreeContext(null); setMode(mode)
    function fail(message: string) {
      if (connection.current !== current || current.closing) return
      setError(message)
      setStatus('error')
      current.closing = true
      current.audio.stop()
      current.ws?.close()
    }
    function interruptPlayback() {
      const wasPlaying = current.audio.isPlaying
      current.audio.interrupt()
      if (current.response) {
        current.retired.add(current.response)
        setMessages(previous => previous.map(message => message.id === (current.responseMessage || current.response) && (wasPlaying || message.partial) ? { ...message, partial: false, interrupted: true } : message))
      }
    }
    try {
      const health = await fetch('/api/health', { signal: AbortSignal.any([current.startup.signal, AbortSignal.timeout(5000)]) })
      if (connection.current !== current || current.closing) return
      if (health.status === 401) window.dispatchEvent(new Event('medvisit:unauthorized'))
      if (!health.ok) throw new Error('服务暂时不可用，请稍后重试或联系管理员')
      const config = await health.json()
      if (!config.asr_configured) throw new Error('语音识别服务暂不可用，请联系管理员')
      if (experience === 'combat' && !config.voice_configured) throw new Error('实时语音服务暂不可用，请联系管理员')
      if (!config.analysis_configured) throw new Error('分析服务暂不可用，请联系管理员')
      if (experience === 'practice' && !config.tts_configured) throw new Error('医生语音服务暂不可用，请联系管理员')
      if (connection.current !== current || current.closing) return
      await current.audio.open(buffer => {
        if (connection.current !== current || current.closing || !current.started || current.ws?.readyState !== WebSocket.OPEN) return
        if (current.ws.bufferedAmount > 32000) { fail('上行音频积压，请检查网络后重试'); return }
        current.ws.send(JSON.stringify({ type: 'audio', audio: encodeAudio(buffer), playing: current.audio.isPlaying }))
      }, () => fail('麦克风已断开，请检查设备后重新开始'))
      if (connection.current !== current || current.closing) { current.audio.stop(); return }
      const url = new URL('/api/realtime', window.location.href)
      url.searchParams.set('experience', experience)
      if (selection?.scenario_id) { url.searchParams.set('scenario_id', selection.scenario_id); url.searchParams.set('stage', selection.stage) }
      if (selection?.remediation_id) url.searchParams.set('remediation_id', selection.remediation_id)
      if (!selection?.scenario_id && !selection?.remediation_id) {
        if (selection?.drug_id) url.searchParams.set('drug_id', selection.drug_id)
        if (selection?.doctor_id) url.searchParams.set('doctor_id', selection.doctor_id)
      }
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      current.ws = ws
      const handshake = window.setTimeout(() => fail('语音连接超时，请重试'), 20000)
      ws.onopen = () => { if (!current.closing) ws.send(JSON.stringify({ type: 'start', mode })) }
      ws.onmessage = ({ data }) => {
        if (connection.current !== current) return
        try {
          const event = JSON.parse(data)
          if (event.type === 'ready' && !current.closing) {
            window.clearTimeout(handshake)
            current.started = performance.now()
            setSessionId(event.session_id)
            setTraining(event.training ?? null)
            setFreeContext(event.free_context ?? null)
            if (['assisted','independent'].includes(event.mode)) setMode(event.mode)
            setStatus('active')
          } else if (event.type === 'error') {
            window.clearTimeout(handshake)
            setError(event.message || '语音服务异常')
            setStatus('error')
            current.closing = true
            current.audio.stop()
            // The server still needs to finish saving and send its ended acknowledgement.
            current.finishTimeout ??= window.setTimeout(() => ws.close(), 60000)
          } else if (event.type === 'ended') {
            current.policyPaused = false
            setPolicyPaused(false)
            setMedicalChecks(previous => previous.map(check => check.status === 'checking' ? { ...check, status: 'unavailable', reason: '结束时本句核验尚未完成，需进一步核实。' } : check))
            window.clearTimeout(handshake)
            window.clearTimeout(current.finishTimeout)
            current.finished = true
            setSaving(false)
            setSaved(event.saved === true)
            if (event.saved !== true) setError(previous => [previous, event.recovery_saved === true
              ? '记录库暂时不可用，本机已保留恢复副本。'
              : '对话尚未确认保存，请保留当前页面的原话后再重新开始。'].filter(Boolean).join(' '))
            setAnalysisStatus(event.analysis_status || 'not_started')
            setSessionId(event.session_id)
            current.audio.stop()
            current.closing = true
            setStatus(previous => previous === 'error' || event.saved !== true ? 'error' : 'ended')
          } else if (event.type === 'medical_check') {
            if (medicalText.current.get(event.check.message_id) === event.check.text) setMedicalChecks(previous => updateMedicalChecks(previous, event.check))
          } else if (event.type === 'policy_check') {
            if (medicalText.current.get(event.message_id) === event.text && Array.isArray(event.findings)) {
              setPolicyChecks(previous => [...previous.filter(check => check.message_id !== event.message_id), ...event.findings])
              setPolicyUnavailable(previous => [...previous.filter(check => check.message_id !== event.message_id), ...(event.status === 'unavailable' ? [{message_id:event.message_id, text:event.text}] : [])])
              if (!current.closing && !current.policyPaused && event.findings.some((item: PolicyCheck) => item.status === 'risk' && item.risk === 'high' && item.action === 'pause')) {
                current.resumeMuted = current.audio.muted
                current.policyPaused = true
                current.audio.setMuted(true)
                current.audio.interrupt()
                if (current.response) current.retired.add(current.response)
                ws.send(JSON.stringify({type:'mute', muted:true}))
                if (experience === 'combat') ws.send(JSON.stringify({type:'interrupt'}))
                setMuted(true); setPolicyPaused(true)
              }
            }
          } else if (event.type === 'coaching') {
            setCoach(event.coach)
            setAnalysisStatus('completed')
          } else if (event.type === 'practice_state') {
            setPracticeState(event.state)
            if (event.state === 'listening') setError('')
            if (experience === 'combat' && event.state === 'error') setAnalysisStatus('error')
          } else if (event.type === 'notice') {
            setError(event.message)
          } else if (event.type === 'tts_state') {
            setSpeechState(event.state)
          } else if (event.type === 'transcript') {
            if (event.role === 'doctor' && current.retired.has(event.id)) return
            if (event.role === 'doctor') { current.response = event.id; current.responseMessage = event.id }
            const time = formatTime(Math.max(0, Math.floor((performance.now() - current.started) / 1000)))
            setMessages(previous => applyTranscript(previous, event, time))
            if (event.role === 'trainee' && event.text && (event.replace || event.final)) {
              medicalText.current.set(event.id, event.text)
              setMedicalChecks(previous => invalidateMedicalCheck(previous, event.id, event.text))
              setPolicyChecks(previous => previous.filter(check => check.message_id !== event.id || check.text === event.text))
              setPolicyUnavailable(previous => previous.filter(check => check.message_id !== event.id || check.text === event.text))
            }
          } else if (!current.closing) {
            if (event.type === 'practice_turn') {
              const time = formatTime(Math.max(0, Math.floor((performance.now() - current.started) / 1000)))
              setMessages(previous => applyTranscript(previous, event.message, time))
              if (event.coach) setCoach(event.coach)
            } else if (event.type === 'response_started' && current.policyPaused) {
              current.retired.add(event.response_id)
            } else if (event.type === 'response_started' && !current.retired.has(event.response_id)) {
              current.response = event.response_id
              current.responseMessage = event.message_id || event.response_id
              if (event.message_id) setMessages(previous => previous.map(message => message.id === event.message_id ? { ...message, interrupted: false } : message))
            } else if (event.type === 'user_started' || (event.type === 'interrupted' && event.response_id === current.response)) {
              interruptPlayback()
              if (event.coaching_invalidated) setCoach(previous => previous ? { ...previous, superseded: true } : previous)
              if (experience === 'practice') setSpeechState('idle')
            } else if (event.type === 'audio' && !current.policyPaused && !current.retired.has(event.response_id)) {
              current.response = event.response_id || current.response
              try { current.audio.play(event.audio) }
              catch (cause) { fail(cause instanceof Error ? cause.message : '音频播放失败，请重新开始演练') }
            } else if (event.type === 'muted' && !current.policyPaused) setMuted(event.muted)
          }
        } catch { fail('语音事件或音频格式异常，请重新连接') }
      }
      ws.onerror = () => fail('无法连接语音后端，请检查服务状态')
      ws.onclose = () => {
        window.clearTimeout(handshake)
        window.clearTimeout(current.finishTimeout)
        current.audio.stop()
        if (connection.current !== current) return
        setSaving(false)
        setAnalysisStatus(previous => previous === 'thinking' ? 'error' : previous)
        if (!current.finished && current.started) {
          setError(previous => [previous, '语音连接已断开，尚未确认保存；请保留当前页面的原话后再重新开始。'].filter(Boolean).join(' '))
          setStatus('error')
        } else if (!current.closing) fail('语音连接已断开，请重新开始')
        current.closing = true
      }
    } catch (cause) {
      if (connection.current !== current || current.closing) return
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') fail('麦克风权限被拒绝，请在系统设置中允许麦克风后重试')
      else fail(cause instanceof Error ? cause.message : '无法启动语音演练')
    }
  }, [])

  function toggleMute() {
    const current = connection.current
    if (!current || current.closing || current.policyPaused || current.ws?.readyState !== WebSocket.OPEN) return
    const next = !muted
    current.audio.setMuted(next)
    current.ws.send(JSON.stringify({ type: 'mute', muted: next }))
    setMuted(next)
  }

  function resumePolicy() {
    const current = connection.current
    if (!current || current.closing || !current.policyPaused || current.ws?.readyState !== WebSocket.OPEN) return
    const next = current.resumeMuted === true
    current.policyPaused = false
    current.audio.setMuted(next)
    current.ws.send(JSON.stringify({type:'mute', muted:next}))
    setMuted(next); setPolicyPaused(false)
  }

  function retryReply() {
    const current = connection.current
    if (!current || current.closing || current.ws?.readyState !== WebSocket.OPEN) return
    current.ws.send(JSON.stringify({ type: 'retry' }))
    setError(''); setPracticeState('thinking')
  }

  function toggleOutputMute() {
    const current = connection.current
    if (!current || current.closing) return
    current.audio.setOutputMuted(!outputMuted)
    setOutputMuted(!outputMuted)
  }

  function retrySpeech() {
    const current = connection.current
    if (!current || current.closing || current.ws?.readyState !== WebSocket.OPEN) return
    current.ws.send(JSON.stringify({ type: 'retry_speech' }))
    setError(''); setSpeechState('speaking')
  }

  function interrupt() {
    const current = connection.current
    if (!current || current.closing || current.ws?.readyState !== WebSocket.OPEN) return
    current.audio.interrupt()
    if (current.response) current.retired.add(current.response)
    setMessages(previous => previous.map(message => message.id === current.response ? { ...message, partial: false, interrupted: true } : message))
    current.ws.send(JSON.stringify({ type: 'interrupt' }))
  }

  useEffect(() => {
    function onHidden() {
      if (document.visibilityState !== 'hidden' || !connection.current || connection.current.closing) return
      setError('应用进入后台，录音已停止。请返回查看保存结果。')
      stop()
    }
    function onOffline() {
      if (!connection.current || connection.current.closing) return
      setError('网络已断开，录音已停止。请返回查看保存结果。')
      stop()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('offline', onOffline)
    return () => { document.removeEventListener('visibilitychange', onHidden); window.removeEventListener('offline', onOffline) }
  }, [stop])

  useEffect(() => {
    if (status !== 'active') return
    const timer = window.setInterval(() => {
      const started = connection.current?.started
      if (started) setSeconds(Math.floor((performance.now() - started) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => () => {
    const current = connection.current
    connection.current = null
    if (current) { current.startup.abort(); current.closing = true; current.audio.stop(); current.ws?.close() }
  }, [])

  async function retrySave() {
    if (!sessionId || saved || saving || saveRetry.current || status === 'active' || status === 'connecting' || analysisStatus === 'thinking') return
    const current = connection.current
    saveRetry.current = true
    setRetryingSave(true)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/retry-save`, { method: 'POST', signal: AbortSignal.timeout(10000) })
      if (response.status === 401) window.dispatchEvent(new Event('medvisit:unauthorized'))
      if (!response.ok) throw new Error('保存未成功，请保留当前对话并稍后重试；持续失败请联系管理员。')
      const result = await response.json()
      if (result.saved !== true || result.session_id !== sessionId) throw new Error('尚未确认保存，请保留当前对话。')
      if (connection.current !== current) return
      setSaved(true)
      setStatus('ended')
      setError('')
    } catch (cause) {
      if (connection.current === current) setError(cause instanceof Error ? cause.message : '保存未成功，请稍后重试。')
    } finally {
      saveRetry.current = false
      setRetryingSave(false)
    }
  }

  return { saving, retrySave, retryingSave, outputMuted, toggleOutputMute, mode, training, freeContext, status, messages, medicalChecks, policyChecks, policyUnavailable, policyPaused, error, muted, seconds, sessionId, saved, coach, practiceState, analysisStatus, speechState, start, stop, toggleMute, resumePolicy, interrupt, retryReply, retrySpeech }
}
