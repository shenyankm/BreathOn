import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { formatTime } from '../src/lib/session.ts'
import { applyTranscript } from '../src/lib/voice-events.ts'
import { invalidateMedicalCheck, updateMedicalChecks } from '../src/lib/medical.ts'

function session(fetchHealth: () => Promise<Response> = async () => Response.json({
  asr_configured: true, voice_configured: true, analysis_configured: true, tts_configured: true,
})) {
  const slots: any[] = [], sockets: Socket[] = [], timers = new Map<number, () => void>()
  let cursor = 0, nextTimer = 0, audioOpened = 0
  const effects: (() => unknown)[] = [], listeners: Record<string, () => void> = {}
  const document = { visibilityState: 'visible', addEventListener: (name: string, listener: () => void) => { listeners[name] = listener }, removeEventListener: () => {} }
  class Audio {
    isPlaying = false
    muted = false
    async open() { audioOpened++ }
    stop() {}
    interrupt() {}
    setOutputMuted() {}
    setMuted(value: boolean) { this.muted = value }
    play() {}
  }
  class Socket {
    static OPEN = 1
    readyState = 0
    bufferedAmount = 0
    onopen?: () => void
    onclose?: () => void
    onerror?: () => void
    onmessage?: (event: { data: string }) => void
    sent: unknown[] = []
    url: string
    constructor(url: string) { this.url = url; sockets.push(this) }
    open() { this.readyState = 1; this.onopen?.() }
    receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
    send(value: string) { this.sent.push(JSON.parse(value)) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: unknown) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useCallback(callback: unknown) { return callback },
    useEffect(callback: () => unknown) { effects.push(callback) },
  }
  const imports: Record<string, unknown> = {
    react,
    '@/lib/audio/browser-audio': { BrowserAudio: Audio, encodeAudio: () => '' },
    '@/lib/session': { formatTime },
    '@/lib/voice-events': { applyTranscript },
    '@/lib/medical': { invalidateMedicalCheck, updateMedicalChecks },
  }
  const exports: { useVoiceSession?: () => any } = {}
  const source = readFileSync(new URL('../src/hooks/use-voice-session.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require: (name: string) => { assert.ok(name in imports, name); return imports[name] },
    fetch: fetchHealth, AbortSignal, DOMException, Error, Event, URL, performance, WebSocket: Socket, document,
    window: { location: { href: 'http://localhost/', protocol: 'http:' },
      addEventListener: (name: string, listener: () => void) => { listeners[name] = listener }, removeEventListener: () => {},
      dispatchEvent: (event: Event) => { listeners[event.type]?.(); return true },
      setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer },
      clearTimeout: (id: number) => timers.delete(id) },
  })
  return { Audio, sockets, timers, document, listeners, runEffects: () => effects.splice(0).forEach(effect => effect()), audioOpened: () => audioOpened,
    render: () => { cursor = 0; return exports.useVoiceSession!() } }
}

test('cancelling combat during health lookup leaves the session restartable', async () => {
  let resolve!: (response: Response) => void
  const app = session(() => new Promise<Response>(done => { resolve = done }))
  const opening = app.render().start('independent', 'combat')
  app.render().stop()
  assert.equal(app.render().status, 'ended')
  assert.notEqual(app.render().analysisStatus, 'thinking')
  resolve(Response.json({ asr_configured: true }))
  await opening
  assert.equal(app.sockets.length, 0)
  assert.equal(app.audioOpened(), 0)
})

test('expired server login is reported before microphone capture starts', async () => {
  const app = session(async () => Response.json({ detail: '请先登录' }, { status: 401 }))
  let expired = 0
  app.listeners['medvisit:unauthorized'] = () => { expired++ }
  await app.render().start('assisted', 'practice')
  assert.equal(expired, 1)
  assert.equal(app.audioOpened(), 0)
  assert.equal(app.sockets.length, 0)
  assert.equal(app.render().status, 'error')
})

test('medical checks follow corrected trainee text and unresolved checks never pass on end', async () => {
  const app = session()
  await app.render().start('independent', 'combat')
  const ws = app.sockets[0]
  ws.open(); ws.receive({ type: 'ready', session_id: 'one' })
  ws.receive({ type: 'transcript', id: 'u1', role: 'trainee', text: '旧转录', final: true })
  ws.receive({ type: 'medical_check', check: { message_id: 'u1', text: '旧转录', status: 'contradicted', statements: [] } })
  assert.equal(app.render().medicalChecks[0].status, 'contradicted')
  ws.receive({ type: 'transcript', id: 'u1', role: 'trainee', text: '修正转录', replace: true, final: true })
  ws.receive({ type: 'medical_check', check: { message_id: 'u1', text: '旧转录', status: 'supported', statements: [] } })
  assert.equal(app.render().medicalChecks[0].text, '修正转录')
  assert.equal(app.render().medicalChecks[0].status, 'checking')
  ws.receive({ type: 'ended', session_id: 'one', saved: true })
  assert.equal(app.render().medicalChecks[0].status, 'unavailable')
})

test('only confirmed high-risk pause rules mute capture until explicit continuation', async () => {
  const app = session()
  await app.render().start('assisted', 'combat')
  const ws = app.sockets[0]
  ws.open(); ws.receive({ type: 'ready', session_id: 'one' })
  ws.receive({ type: 'transcript', id: 'u1', role: 'trainee', text: '原话', final: true })
  ws.receive({type:'policy_check', message_id:'u1', text:'旧原话', findings:[{status:'risk', risk:'high', action:'pause'}]})
  assert.equal(app.render().policyPaused, false)
  ws.receive({type:'policy_check', message_id:'u1', text:'原话', findings:[{status:'uncertain', risk:'high', action:'pause'}]})
  assert.equal(app.render().policyPaused, false)
  ws.receive({type:'policy_check', message_id:'u1', text:'原话', findings:[{status:'risk', risk:'high', action:'pause'}]})
  assert.equal(app.render().policyPaused, true)
  assert.equal(app.render().muted, true)
  assert.ok(ws.sent.some((item: any) => item.type === 'mute' && item.muted === true))
  app.render().toggleMute()
  assert.equal(app.render().policyPaused, true)
  app.render().resumePolicy()
  assert.equal(app.render().policyPaused, false)
  assert.equal(app.render().muted, false)
  assert.ok(ws.sent.some((item: any) => item.type === 'mute' && item.muted === false))
  ws.receive({type:'policy_check', message_id:'u1', text:'原话', status:'unavailable', findings:[]})
  assert.equal(app.render().policyUnavailable.length, 1)
})

test('trained practice disconnect during final review clears waiting and keeps transcript', async () => {
  const app = session()
  await app.render().start('assisted', 'practice')
  const ws = app.sockets[0]
  ws.open()
  ws.receive({ type: 'ready', session_id: 'one', training: {} })
  ws.receive({ type: 'transcript', id: 'u1', role: 'trainee', text: '保留这段原话', final: true })
  app.render().stop()
  assert.equal(app.render().analysisStatus, 'thinking')
  ws.close()
  assert.equal(app.render().analysisStatus, 'error')
  assert.match(app.render().error, /保存/)
  assert.equal(app.render().messages[0].text, '保留这段原话')
  assert.equal(app.render().saved, false)
  assert.equal(app.timers.size, 0)
})

test('provider error waits for final persistence acknowledgement before closing', async () => {
  const app = session()
  await app.render().start('assisted', 'practice')
  const ws = app.sockets[0]
  ws.open()
  ws.receive({ type: 'ready', session_id: 'one' })
  ws.receive({ type: 'error', message: '服务暂时不可用' })
  assert.equal(ws.readyState, 1)
  assert.equal(app.render().status, 'error')
  assert.equal(app.timers.size, 1)
  ws.receive({ type: 'ended', session_id: 'one', saved: true, analysis_status: 'interrupted' })
  assert.equal(app.render().saved, true)
  assert.equal(app.render().error, '服务暂时不可用')
  assert.equal(app.timers.size, 0)
})

test('failed persistence reports retained recovery copy without hiding provider failure', async () => {
  const app = session()
  await app.render().start('assisted', 'practice')
  const ws = app.sockets[0]
  ws.open()
  ws.receive({ type: 'ready', session_id: 'one' })
  ws.receive({ type: 'error', message: '服务暂时不可用' })
  ws.receive({ type: 'ended', session_id: 'one', saved: false, recovery_saved: true })
  assert.equal(app.render().saved, false)
  assert.match(app.render().error, /服务暂时不可用/)
  assert.match(app.render().error, /恢复副本/)
})

test('missing final acknowledgement times out without leaving final review pending', async () => {
  const app = session()
  await app.render().start('assisted', 'practice')
  const ws = app.sockets[0]
  ws.open()
  ws.receive({ type: 'ready', session_id: 'one', training: {} })
  app.render().stop()
  ws.receive({ type: 'error', message: '服务暂时不可用' })
  assert.equal(app.timers.size, 1)
  app.timers.values().next().value!()
  assert.equal(app.render().analysisStatus, 'error')
  assert.equal(app.render().saved, false)
  assert.match(app.render().error, /服务暂时不可用/)
  assert.match(app.render().error, /保留当前页面的原话/)
  assert.equal(app.timers.size, 0)
  await app.render().start('assisted', 'practice')
  app.sockets[1].open()
  app.sockets[1].receive({ type: 'ready', session_id: 'two' })
  assert.equal(app.render().status, 'active')
  assert.equal(app.render().error, '')
})

test('failed persistence without a recovery copy warns to preserve the displayed transcript', async () => {
  const app = session()
  await app.render().start('assisted', 'practice')
  const ws = app.sockets[0]
  ws.open()
  ws.receive({ type: 'ready', session_id: 'one' })
  ws.receive({ type: 'ended', session_id: 'one', saved: false })
  assert.equal(app.render().status, 'error')
  assert.match(app.render().error, /保留当前页面的原话/)
  assert.doesNotMatch(app.render().error, /恢复副本/)
})


test('backgrounding and offline stop capture without resuming it silently', async () => {
  for (const reason of ['background', 'offline']) {
    const app = session()
    const voice = app.render()
    app.runEffects()
    await voice.start('independent', 'combat')
    const ws = app.sockets[0]
    ws.open(); ws.receive({ type: 'ready', session_id: reason })
    if (reason === 'background') { app.document.visibilityState = 'hidden'; app.listeners.visibilitychange() }
    else app.listeners.offline()
    assert.equal(app.render().status, 'ended')
    assert.equal((ws.sent.at(-1) as {type: string}).type, 'stop')
    assert.match(app.render().error, /录音已停止/)
    ws.receive({ type: 'ended', session_id: reason, saved: true })
    assert.equal(app.render().saved, true)
  }
})


test('free practice sends the selected pair and uses the confirmed snapshot without changing scored sessions', async () => {
  const app = session()
  await app.render().start('assisted', 'practice', {scenario_id:'',stage:'full',drug_id:'drug one',doctor_id:'doctor/two'})
  const ws = app.sockets[0]
  const url = new URL(ws.url)
  assert.equal(url.searchParams.get('drug_id'), 'drug one')
  assert.equal(url.searchParams.get('doctor_id'), 'doctor/two')
  assert.equal(url.searchParams.has('scenario_id'), false)
  const context = {drug:{id:'drug one',version:1,name:'训练药品',brand:'商品名'},doctor:{id:'doctor/two',display_name:'训练医生'}}
  ws.open(); ws.receive({type:'ready',session_id:'free-one',free_context:context})
  assert.equal(app.render().training, null)
  assert.equal(JSON.stringify(app.render().freeContext), JSON.stringify(context))
  app.render().stop()
  assert.equal(app.render().analysisStatus, 'thinking')
  ws.receive({type:'ended',session_id:'free-one',saved:true,analysis_status:'completed'})
  assert.equal(app.render().analysisStatus, 'completed')
  await app.render().start('assisted', 'practice', {scenario_id:'scene',stage:'full',drug_id:'stale-drug',doctor_id:'stale-doctor'})
  const sceneUrl = new URL(app.sockets[1].url)
  assert.equal(sceneUrl.searchParams.get('scenario_id'), 'scene')
  assert.equal(sceneUrl.searchParams.has('drug_id'), false)
  assert.equal(sceneUrl.searchParams.has('doctor_id'), false)
  assert.equal(app.render().freeContext, null)
  await app.render().start('independent', 'combat', {scenario_id:'',stage:'full',remediation_id:'remediation',drug_id:'stale-drug',doctor_id:'stale-doctor'})
  const retryUrl = new URL(app.sockets[2].url)
  assert.equal(retryUrl.searchParams.get('remediation_id'), 'remediation')
  assert.equal(retryUrl.searchParams.has('drug_id'), false)
  assert.equal(retryUrl.searchParams.has('doctor_id'), false)
})

test('doctor audio can be muted independently of microphone and resets on restart', async () => {
  const app = session()
  await app.render().start('assisted', 'practice')
  app.render().toggleOutputMute()
  assert.equal(app.render().outputMuted, true)
  assert.equal(app.render().muted, false)
  app.render().toggleOutputMute()
  assert.equal(app.render().outputMuted, false)
  app.render().toggleOutputMute()
  await app.render().start('independent', 'combat')
  assert.equal(app.render().outputMuted, false)
})

test('playback failures preserve the actionable audio error', async () => {
  const app = session()
  app.Audio.prototype.play = () => { throw new Error('待播放语音超过一分钟，请重新开始演练') }
  await app.render().start('independent', 'combat')
  const socket = app.sockets[0]
  socket.open()
  socket.receive({ type: 'ready', session_id: 'audio-failure' })
  socket.receive({ type: 'audio', response_id: 'greeting', audio: 'AAA=' })
  assert.equal(app.render().status, 'error')
  assert.match(app.render().error, /待播放语音超过一分钟/)
  assert.doesNotMatch(app.render().error, /语音事件或音频格式异常/)
  assert.equal(socket.readyState, 3)
})
