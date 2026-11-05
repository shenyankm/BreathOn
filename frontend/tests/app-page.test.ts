import assert from 'node:assert/strict'
import test from 'node:test'
import { appPage } from '../src/lib/app-page.ts'

test('practice is the default, including old app links', () => {
  for (const hash of ['', '#practice', '#home', '#coach', '#doctors', '#training', '#lesson/l2-01', '#library', '#visits', '#unknown']) {
    assert.equal(appPage(hash), 'practice')
  }
})

test('records, settings and active sessions remain reachable', () => {
  assert.equal(appPage('#records?session=existing'), 'records')
  assert.equal(appPage('#me'), 'me')
  assert.equal(appPage('#start'), 'start')
})
