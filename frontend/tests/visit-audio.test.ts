import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audioContentType, validAudioDuration } from '../src/lib/visit-audio.ts'

test('visit audio is limited to supported files and thirty minutes', () => {
  assert.equal(audioContentType('visit.M4A', 100_000_000), 'audio/mp4')
  assert.equal(audioContentType('visit.mp3', 0), null)
  assert.equal(audioContentType('visit.wav', 100_000_001), null)
  assert.equal(audioContentType('visit.mp4', 1), null)
  assert.equal(validAudioDuration(1800), true)
  assert.equal(validAudioDuration(1800.1), false)
  assert.equal(validAudioDuration(Infinity), false)
  assert.equal(validAudioDuration(0), false)
})

test('audio metadata success, failure, and timeout always release the media source', async t => {
  const { readAudioDuration } = await import('../src/lib/visit-audio.ts')
  let audio: any, timeout: (() => void) | undefined, revoked = 0, cleaned = 0
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { return audio = { duration: 25, removeAttribute(name: string) { assert.equal(name, 'src'); cleaned++ }, load() {} } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  t.mock.method(URL, 'createObjectURL', () => 'blob:recording')
  t.mock.method(URL, 'revokeObjectURL', () => { revoked++ })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { timeout = callback; return 1 }) as any)
  t.mock.method(globalThis, 'clearTimeout', () => {})
  const success = readAudioDuration(new Blob(['audio']))
  audio.onloadedmetadata()
  assert.equal(await success, 25)
  const failed = readAudioDuration(new Blob(['audio']))
  audio.onerror()
  await assert.rejects(failed, /无法读取录音/)
  const stalled = readAudioDuration(new Blob(['audio']))
  timeout!()
  await assert.rejects(stalled, /超时/)
  assert.equal(audio.onloadedmetadata, null)
  assert.equal(audio.onerror, null)
  assert.equal(revoked, 3); assert.equal(cleaned, 3)
})
