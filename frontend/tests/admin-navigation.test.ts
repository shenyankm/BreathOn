import assert from 'node:assert/strict'
import test from 'node:test'
import { adminHref, adminRoute, adminSections } from '../src/lib/admin-navigation.ts'
import { overviewSummary, overviewSources, pendingReview } from '../src/lib/admin-overview.ts'

test('admin sections deep link and old workspace URLs retain the matching sidebar', () => {
  for (const item of adminSections) assert.deepEqual(adminRoute(adminHref(item.id)), {page:'admin',section:item.id})
  assert.equal(adminRoute('#admin').section, 'overview')
  assert.equal(adminRoute('#admin?section=unknown').section, 'overview')
  assert.deepEqual(adminRoute('#workspace?tab=doctor&doctor=real-id'), {page:'workspace',section:'doctor'})
  assert.equal(adminRoute('#workspace?tab=content').section, 'training')
  assert.equal(adminRoute('#workspace?tab=pricing').section, 'settings')
  assert.equal(adminRoute('#settings').page, 'settings')
})
test('overview counts reviewable states and sorts valid timestamps without fabricated activity', () => {
  const groups = Object.fromEntries(overviewSources.map(source => [source.key, [] as any[]]))
  groups.drug = [{id:'a',status:'draft',updated_at:'2026-10-30'}, {id:'b',status:'published',updated_at:'2026-10-31'}]
  groups.policy = [{id:'c',status:'draft'}, {id:'d',status:'submitted',updated_at:'invalid'}]
  groups.visits = [{id:'e',status:'submitted',updated_at:'2026-11-01'}]
  assert.equal(overviewSummary(groups).pending, 3)
  assert.deepEqual(overviewSummary(groups).recent.map(item => item.id), ['b','a'])
  delete groups.policy
  assert.equal(overviewSummary(groups).pending, null)
  assert.equal(pendingReview('scenario','draft'), true)
  assert.equal(pendingReview('content','approved'), false)
})

test('overview parses timestamps once and preserves stable ties across sources', () => {
  const parse = Date.parse
  let calls = 0
  Date.parse = value => { calls++; return parse(value) }
  try {
    const groups = { drug: Array.from({ length: 100 }, (_, i) => ({ id: String(i), status: 'draft', updated_at: '2026-10-31' })) }
    assert.deepEqual(overviewSummary(groups).recent.map(row => row.id), ['0','1','2','3','4','5'])
    assert.equal(calls, 100)
  } finally { Date.parse = parse }
})
