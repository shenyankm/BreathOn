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
