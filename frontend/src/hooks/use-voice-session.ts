import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserAudio, encodeAudio } from '@/lib/audio/browser-audio'
import { formatTime } from '@/lib/session'
import type { TrainingSnapshot } from '@/lib/catalog-types'
import { applyTranscript, type VoiceMessage, type LiveCoach } from '@/lib/voice-events'
import { invalidateMedicalCheck, updateMedicalChecks, type MedicalCheck } from '@/lib/medical'

type Status = 'idle' | 'connecting' | 'active' | 'ended' | 'error'
type Connection = { ws?: WebSocket; audio: BrowserAudio; closing: boolean; finished?: boolean; finishTimeout?: number; response?: string; responseMessage?: string; retired: Set<string>; started: number; experience: 'practice' | 'combat' }

export function useVoiceSession() {
  const [status, setStatus] = useState<Status>('idle')
  const [mode, setMode] = useState('assisted')
  const [messages, setMessages] = useState<VoiceMessage[]>([])
  const [error, setError] = useState('')
  const [muted, setMuted] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [saved, setSaved] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [coach, setCoach] = useState<LiveCoach | null>(null)
  const [medicalChecks, setMedicalChecks] = useState<MedicalCheck[]>([])
  const medicalText = useRef(new Map<string, string>())
  const [practiceState, setPracticeState] = useState<'listening' | 'thinking' | 'error'>('listening')
  const [analysisStatus, setAnalysisStatus] = useState('not_started')
  const [speechState, setSpeechState] = useState('idle')
  const [training, setTraining] = useState<TrainingSnapshot | null>(null)
  const connection = useRef<Connection | null>(null)

  const stop = useCallback(() => {
    const current = connection.current
    if (!current || current.closing) return
    current.closing = true
    if (current.started && (current.experience === 'combat' || training)) setAnalysisStatus('thinking')
    current.audio.stop()
    if (current.ws?.readyState === WebSocket.OPEN) {
      current.ws.send(JSON.stringify({ type: 'stop' }))
      current.finishTimeout = window.setTimeout(() => current.ws?.close(), 90000)
    } else current.ws?.close()
    setStatus(previous => previous === 'error' ? 'error' : 'ended')
  }, [training])

  const start = useCallback(async (mode: string, experience: 'practice' | 'combat', selection?: {scenario_id:string;stage:string;remediation_id?:string}) => {
    const old = connection.current
    if (old) { old.closing = true; old.audio.stop(); old.ws?.close() }
    const current: Connection = { audio: new BrowserAudio(), closing: false, retired: new Set(), started: 0, experience }
    connection.current = current
    setStatus('connecting'); setMessages([]); setMedicalChecks([]); setError(''); setMuted(false); setSessionId(''); setSaved(false); setSeconds(0); setCoach(null); setPracticeState('listening')
    medicalText.current.clear()
    setAnalysisStatus('not_started')
    setSpeechState('idle'); setTraining(null); setMode(mode)
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
      const health = await fetch('/api/health', { signal: AbortSignal.timeout(5000) })
      if (connection.current !== current || current.closing) return
      if (!health.ok) throw new Error('后端服务未启动，请先运行 npm run dev:api')
      const config = await health.json()
      if (!config.asr_configured) throw new Error('请先在 backend/.env 配置 SEEDASR_API_KEY 并重启后端')
      if (experience === 'combat' && !config.voice_configured) throw new Error('请先在 backend/.env 配置 DOUBAO_API_KEY 并重启后端')
      if (!config.analysis_configured) throw new Error('请在 backend/.env 配置 DEEPSEEK_API_KEY 和 DEEPSEEK_MODEL，启用 AI 分析')
      if (experience === 'practice' && !config.tts_configured) throw new Error('请在 backend/.env 配置 DOUBAO_TTS_API_KEY，启用医生语音朗读')
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
            setMedicalChecks(previous => previous.map(check => check.status === 'checking' ? { ...check, status: 'unavailable', reason: '结束时本句核验尚未完成，需进一步核实。' } : check))
            window.clearTimeout(handshake)
            window.clearTimeout(current.finishTimeout)
            current.finished = true
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
            }
          } else if (!current.closing) {
            if (event.type === 'practice_turn') {
              const time = formatTime(Math.max(0, Math.floor((performance.now() - current.started) / 1000)))
              setMessages(previous => applyTranscript(previous, event.message, time))
              if (event.coach) setCoach(event.coach)
            } else if (event.type === 'response_started' && !current.retired.has(event.response_id)) {
              current.response = event.response_id
              current.responseMessage = event.message_id || event.response_id
              if (event.message_id) setMessages(previous => previous.map(message => message.id === event.message_id ? { ...message, interrupted: false } : message))
            } else if (event.type === 'user_started' || (event.type === 'interrupted' && event.response_id === current.response)) {
              interruptPlayback()
              if (event.coaching_invalidated) setCoach(previous => previous ? { ...previous, superseded: true } : previous)
              if (experience === 'practice') setSpeechState('idle')
            } else if (event.type === 'audio' && !current.retired.has(event.response_id)) {
              current.response = event.response_id || current.response
              current.audio.play(event.audio)
            } else if (event.type === 'muted') setMuted(event.muted)
          }
        } catch { fail('语音事件或音频格式异常，请重新连接') }
      }
      ws.onerror = () => fail('无法连接语音后端，请检查服务状态')
      ws.onclose = () => {
        window.clearTimeout(handshake)
        window.clearTimeout(current.finishTimeout)
        current.audio.stop()
        if (connection.current !== current) return
        setAnalysisStatus(previous => previous === 'thinking' ? 'error' : previous)
        if (!current.finished && current.started) {
          setError(previous => [previous, '语音连接已断开，尚未确认保存；请保留当前页面的原话后再重新开始。'].filter(Boolean).join(' '))
          setStatus('error')
        } else if (!current.closing) fail('语音连接已断开，请重新开始')
        current.closing = true
      }
    } catch (cause) {
      if (connection.current !== current || current.closing) return
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') fail('麦克风权限被拒绝，请在浏览器中允许麦克风')
      else fail(cause instanceof Error ? cause.message : '无法启动语音演练')
    }
  }, [])

  function toggleMute() {
    const current = connection.current
    if (!current || current.closing || current.ws?.readyState !== WebSocket.OPEN) return
    const next = !muted
    current.audio.setMuted(next)
    current.ws.send(JSON.stringify({ type: 'mute', muted: next }))
    setMuted(next)
  }

  function retryReply() {
    const current = connection.current
    if (!current || current.closing || current.ws?.readyState !== WebSocket.OPEN) return
    current.ws.send(JSON.stringify({ type: 'retry' }))
    setError(''); setPracticeState('thinking')
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
    if (current) { current.closing = true; current.audio.stop(); current.ws?.close() }
  }, [])

  return { mode, training, status, messages, medicalChecks, error, muted, seconds, sessionId, saved, coach, practiceState, analysisStatus, speechState, start, stop, toggleMute, interrupt, retryReply, retrySpeech }
}
