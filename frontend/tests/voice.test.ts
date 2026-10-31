import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { decodePcm16, encodeAudio, BrowserAudio } from '../src/lib/audio/browser-audio.ts'
import { applyTranscript, type VoiceMessage } from '../src/lib/voice-events.ts'

test('PCM conversion preserves little endian signs and rejects odd payloads', () => {
  const bytes = new Uint8Array([0, 128, 0, 0, 255, 127])
  const values = decodePcm16(encodeAudio(bytes.buffer))
  assert.deepEqual([...values], [-1, 0, 32767 / 32768])
  assert.throws(() => decodePcm16('AA=='))
})

test('PCM decoder matches every signed 16-bit sample including byte boundaries', () => {
  const bytes = Buffer.alloc(65536 * 2)
  for (let i = 0; i < 65536; i++) bytes.writeInt16LE(i - 32768, i * 2)
  const samples = decodePcm16(bytes.toString('base64'))
  assert.equal(samples.length, 65536)
  for (let i = 0; i < samples.length; i++) assert.equal(samples[i], (i - 32768) / 32768)
  assert.equal(decodePcm16('').length, 0)
})

test('delta, corrected final, and ASR full snapshots never duplicate text', () => {
  let messages: VoiceMessage[] = []
  const event = { id: 'u1', role: 'trainee' as const, text: '玛仕', final: false }
  messages = applyTranscript(messages, event, '00:01')
  messages = applyTranscript(messages, { ...event, text: '度肽' }, '00:02')
  assert.equal(messages[0].text, '玛仕度肽')
  messages = applyTranscript(messages, { ...event, text: '玛仕度肽。', final: true }, '00:03')
  assert.equal(messages[0].text, '玛仕度肽。')
  assert.equal(messages[0].time, '00:01')
  messages = applyTranscript(messages, { ...event, text: '研究人群', replace: true }, '00:04')
  assert.equal(messages[0].text, '研究人群')
  assert.equal(messages[0].partial, true)
  messages = applyTranscript(messages, { ...event, text: '', final: true }, '00:05')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, '研究人群')
  assert.equal(messages[0].partial, false)
})

test('unchanged transcript snapshots reuse state while changes preserve message identity', () => {
  const first: VoiceMessage = { id: 'u1', role: 'trainee', text: '原话', time: '00:01', partial: false }
  const other: VoiceMessage = { id: 'd1', role: 'doctor', text: '追问', time: '00:02', partial: false }
  const messages = [first, other]
  assert.equal(applyTranscript(messages, { ...first, final: true }, '00:03'), messages)
  assert.equal(applyTranscript(messages, { ...first, text: '', final: true }, '00:03'), messages)
  const changed = applyTranscript(messages, { ...first, text: '修正原话', final: true }, '00:03')
  assert.notEqual(changed, messages)
  assert.equal(changed[1], other)
  assert.equal(changed[0].text, '修正原话')
  assert.equal(changed[0].time, '00:01')
  assert.equal(messages[0], first)
  assert.equal(first.text, '原话')
  assert.equal(applyTranscript(messages, { ...first, final: false, replace: true }, '00:03')[0].partial, true)
})

test('worklet carries 128-sample render blocks into exact 20ms frames', () => {
  const frames: ArrayBuffer[] = []
  let Processor: any
  vm.runInNewContext(readFileSync(new URL('../src/lib/audio/capture.worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (buffer: ArrayBuffer) => frames.push(buffer.slice(0)) } },
    registerProcessor: (_: string, constructor: any) => { Processor = constructor },
  })
  const processor = new Processor()
  for (let i = 0; i < 5; i++) processor.process([[Float32Array.from({ length: 128 }, (_, n) => n % 2 ? 2 : -2)]])
  assert.deepEqual(frames.map(frame => frame.byteLength), [640, 640])
  const samples = new DataView(frames[0])
  assert.equal(samples.getInt16(0, true), -32768)
  assert.equal(samples.getInt16(2, true), 32767)
  processor.process([])
  assert.equal(frames.length, 2)
})

test('browser audio schedules doctor PCM, cancels playback, keeps muted frames silent and cleans up device loss', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  const originalWorklet = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  let trackStopped = false, contextClosed = false, lost = false
  const track = { enabled: true, onended: null as null | (() => void), stop: () => { trackStopped = true } }
  const node = () => ({ connect(target: any) { return target }, disconnect() {} })
  const captures: any[] = []
  const gains: { value: number }[] = []
  const starts: number[] = []
  let sourceStops = 0
  class Context {
    sampleRate = 16000; state = 'running'; currentTime = 0; destination = {}; audioWorklet = { addModule: async () => {} }
    async resume() {}
    createMediaStreamSource() { return node() }
    createGain() { const gain = { value: 1 }; gains.push(gain); return { ...node(), gain } }
    createBuffer(channels: number, length: number, rate: number) {
      assert.equal(channels, 1); assert.equal(rate, 24000)
      return { duration: length / rate, copyToChannel(samples: Float32Array) { assert.equal(samples.length, length) } }
    }
    createBufferSource() { return { ...node(), buffer: null, onended: null, start(time: number) { starts.push(time) }, stop() { sourceStops++ } } }
    async close() { this.state = 'closed'; contextClosed = true }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } } })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class { port: any = {}; disconnect() {}; connect(target: any) { return target }; constructor() { captures.push(this) } } })
  try {
    const audio = new BrowserAudio()
    const frames: ArrayBuffer[] = []
    await audio.open(frame => frames.push(frame), () => { lost = true })
  audio.setOutputMuted(true)
  assert.equal(gains[0].value, 0)
  assert.equal(track.enabled, true)
  audio.setOutputMuted(false)
  assert.equal(gains[0].value, 1)
    const capture = captures[0]
    const encoded = encodeAudio(new ArrayBuffer(4800))
    audio.play(encoded); audio.play(encoded)
    assert.ok(audio.isPlaying)
    assert.deepEqual(starts, [0.03, 0.13])
    audio.interrupt()
    assert.equal(sourceStops, 2); assert.equal(audio.isPlaying, false)
    audio.play(encoded)
    assert.equal(starts[2], 0.03)
    audio.interrupt()
    for (let i = 0; i < 100; i++) audio.play(encoded)
    assert.ok(audio.isPlaying, 'ten seconds of burst audio must remain playable')
    assert.ok(Math.abs(starts.at(-1)! - 9.93) < 0.00001)
    assert.throws(() => audio.play(Buffer.alloc(51 * 24000 * 2).toString('base64')), /超过一分钟/)
    audio.interrupt()
    audio.play(encoded)
    assert.equal(starts.at(-1), 0.03, 'interrupt must discard the queued utterance')
    audio.setMuted(true)
    assert.equal(track.enabled, false)
    capture.port.onmessage({ data: new Uint8Array(640).fill(255).buffer })
    assert.deepEqual([...new Uint8Array(frames[0])], [...new Uint8Array(640)])
    track.onended?.()
    assert.ok(lost && trackStopped && contextClosed)
    capture.port.onmessage({ data: new ArrayBuffer(640) })
    assert.equal(frames.length, 1)
    audio.stop()
  } finally {
    for (const [name, descriptor] of [['navigator', originalNavigator], ['AudioContext', originalContext], ['AudioWorkletNode', originalWorklet]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test('microphone loss during worklet loading closes audio without starting capture', async t => {
  const originals = ['navigator', 'AudioContext', 'AudioWorkletNode'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  let finishModule!: () => void, moduleStarted!: () => void
  const loading = new Promise<void>(resolve => { moduleStarted = resolve })
  const module = new Promise<void>(resolve => { finishModule = resolve })
  let stopped = 0, closed = 0, lost = 0, captures = 0
  const track = { onended: null as null | (() => void), stop() { stopped++ } }
  const node = () => ({ connect(target: unknown) { return target }, disconnect() {} })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } } })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
    sampleRate = 16000; state = 'running'; destination = {}
    audioWorklet = { addModule: () => { moduleStarted(); return module } }
    async resume() {}
    createMediaStreamSource() { return node() }
    createGain() { return { ...node(), gain: { value: 1 } } }
    async close() { this.state = 'closed'; closed++ }
  } })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    port = {}; constructor() { captures++ }; disconnect() {}; connect(target: unknown) { return target }
  } })
  const audio = new BrowserAudio()
  const opening = audio.open(() => assert.fail('stopped capture emitted a frame'), () => { lost++ })
  await loading
  track.onended?.()
  finishModule()
  await opening
  assert.equal(lost, 1)
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
  assert.equal(captures, 0)
})

test('failed playback scheduling still releases the microphone and audio context', async t => {
  const originals = ['navigator', 'AudioContext', 'AudioWorkletNode'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  let stopped = false, closed = false, disconnected = false
  const track = { onended: null, stop() { stopped = true } }
  const node = () => ({ connect(target: unknown) { return target }, disconnect() {} })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } } })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
    sampleRate = 16000; state = 'running'; currentTime = 0; destination = {}
    audioWorklet = { addModule: async () => {} }
    async resume() {}
    createMediaStreamSource() { return node() }
    createGain() { return { ...node(), gain: { value: 1 } } }
    createBuffer() { return { duration: .1, copyToChannel() {} } }
    createBufferSource() { return { ...node(), buffer: null, onended: null,
      start() { throw new Error('playback scheduling failed') },
      stop() { throw new DOMException('Cannot stop a source that never started', 'InvalidStateError') },
      disconnect() { disconnected = true },
    } }
    async close() { this.state = 'closed'; closed = true }
  } })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    port = {}; disconnect() {}; connect(target: unknown) { return target }
  } })
  const audio = new BrowserAudio()
  await audio.open(() => {}, () => {})
  assert.throws(() => audio.play('AAA='), /playback scheduling failed/)
  assert.doesNotThrow(() => audio.stop())
  assert.ok(stopped && closed && disconnected)
  assert.equal(audio.isPlaying, false)
})
