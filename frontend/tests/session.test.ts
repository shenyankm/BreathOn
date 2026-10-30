import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTime } from '../src/lib/session.ts'

test('call duration keeps minute boundaries and hours readable', () => {
  for (const [seconds, expected] of [[0, '00:00'], [59, '00:59'], [60, '01:00'], [3599, '59:59'], [3600, '60:00']] as const) {
    assert.equal(formatTime(seconds), expected)
  }
})

