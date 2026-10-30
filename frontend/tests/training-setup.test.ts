import assert from 'node:assert/strict'
import test from 'node:test'
import { presetFor, recommendedScenario } from '../src/lib/training-setup.ts'
import type { Scenario } from '../src/lib/catalog-types.ts'

const scene = (id: string, changes: Partial<Scenario> = {}) => ({ id, status: 'published', difficulty: 'basic', situation: 'first_visit', ...changes }) as Scenario

test('quick start prefers a published introductory scene and never promotes a draft', () => {
  const rows = [scene('draft', { status: 'draft' }), scene('advanced', { difficulty: 'advanced' }), scene('intro')]
  assert.equal(recommendedScenario(rows)?.id, 'intro')
  assert.deepEqual(rows.map(row => row.id), ['draft', 'advanced', 'intro'])
  assert.equal(recommendedScenario([rows[0]]), undefined)
  assert.equal(recommendedScenario([]), undefined)
})

test('quick start preserves a usable published alternative when no introductory scene exists', () => {
  assert.equal(recommendedScenario([scene('followup', { situation: 'follow_up' }), scene('retired', { status: 'retired' })])?.id, 'followup')
  assert.equal(recommendedScenario([scene('legacy', { situation: undefined })])?.id, 'legacy')
})

test('three presets cover supported combinations and combat always hides live coaching', () => {
  assert.equal(presetFor('practice', 'assisted').id, 'coached')
  assert.equal(presetFor('practice', 'independent').id, 'independent')
  for (const previousMode of ['assisted', 'independent', 'unknown']) {
    const preset = presetFor('combat', previousMode)
    assert.equal(preset.id, 'combat')
    assert.equal(preset.mode, 'independent')
  }
  assert.equal(presetFor('unknown', 'unknown').id, 'coached')
})
