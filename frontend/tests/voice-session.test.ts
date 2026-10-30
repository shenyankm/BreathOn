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
  class Audio {
    isPlaying = false
    async open() { audioOpened++ }
    stop() {}
    interrupt() {}
    setMuted() {}
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
    constructor() { sockets.push(this) }
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
    useEffect() {},
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
    fetch: fetchHealth, AbortSignal, DOMException, URL, performance, WebSocket: Socket,
    window: { location: { href: 'http://localhost/', protocol: 'http:' },
      setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer },
      clearTimeout: (id: number) => timers.delete(id) },
  })
  return { sockets, timers, audioOpened: () => audioOpened,
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
