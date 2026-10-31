import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invalidateMedicalCheck, updateMedicalChecks, type MedicalCheck } from '../src/lib/medical.ts'

test('ASR corrections remove stale medical judgments before a new result arrives', () => {
  const first: MedicalCheck = { message_id: 'u1', text: '旧转录', status: 'contradicted', preliminary: true,
    statements: [{ id: 's0', text: '旧转录', status: 'contradicted', reason: 'Synthetic', correction: '旧纠正', citations: [] }] }
  const other = { ...first, message_id: 'u2' }
  const corrected = invalidateMedicalCheck([first, other], 'u1', '修正转录')
  assert.equal(corrected[0].status, 'checking')
  assert.deepEqual(corrected[0].statements, [])
  assert.equal(corrected[1], other)
  const updated = updateMedicalChecks(corrected, { ...first, text: '修正转录', status: 'insufficient', statements: [] })
  assert.equal(updated.length, 2)
  assert.equal(updated[0].status, 'insufficient')
})

test('unchanged or unrelated transcripts reuse medical state', () => {
  const checks: MedicalCheck[] = [{ message_id: 'u1', text: 'unchanged', status: 'supported', preliminary: true, statements: [] }]
  assert.equal(invalidateMedicalCheck(checks, 'u1', 'unchanged'), checks)
  assert.equal(invalidateMedicalCheck(checks, 'u2', 'new'), checks)
})
