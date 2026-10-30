import assert from 'node:assert/strict'
import test from 'node:test'
import { filterPolicies, policyCategories, policyDocuments, policyLevels } from '../src/lib/policies.ts'

test('every policy has a declared level and topic without changing source order', () => {
  assert.ok(policyDocuments.length > 0)
  for (const document of policyDocuments) {
    assert.ok(policyLevels.includes(document.level))
    assert.ok(policyCategories.includes(document.category))
  }
  assert.deepEqual(filterPolicies('all', 'all'), policyDocuments)
})

test('level and topic filters intersect and empty combinations stay empty', () => {
  const municipalPayment = filterPolicies('市级', '医保与支付')
  assert.equal(municipalPayment.length, 2)
  assert.ok(municipalPayment.every(document => document.level === '市级' && document.category === '医保与支付'))
  assert.equal(filterPolicies('all', '医保与支付').length, municipalPayment.length)
  assert.equal(filterPolicies('国家级', 'all').length, 10)
  assert.deepEqual(filterPolicies('省级', '人工智能'), [])
  assert.deepEqual(filterPolicies('区县级', 'all'), [])
})

test('national policies reposted locally retain their issuing level and hospital rules stay separate', () => {
  const reposts = policyDocuments.filter(document => document.source.includes('转载'))
  assert.equal(reposts.length, 2)
  assert.ok(reposts.every(document => document.level === '国家级'))
  const hospital = policyDocuments.find(document => document.title.includes('接待医药代表管理制度'))
  assert.equal(hospital?.level, '机构制度')
  assert.equal(hospital?.category, '医药代表与拜访')
})
