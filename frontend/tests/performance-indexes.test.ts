import assert from 'node:assert/strict'
import test from 'node:test'
import { groupByMessage } from '../src/lib/voice-events.ts'
import { indexProductSources } from '../src/lib/medical.ts'
import { updateMedicalChecks, type MedicalCheck } from '../src/lib/medical.ts'

test('message index preserves all findings and their order without assigning unbound checks', () => {
  const rows = [{ message_id: 'a', value: 1 }, { message_id: 'b', value: 2 }, { message_id: 'a', value: 3 }, { value: 4 }]
  const index = groupByMessage(rows)
  assert.deepEqual(index.get('a'), [rows[0], rows[2]])
  assert.deepEqual(index.get('b'), [rows[1]])
  assert.equal(index.size, 2)
})

test('product source index preserves corpus order and omits missing or repeated references', () => {
  const sources = [{ id: 'b' }, { id: 'a' }, { id: 'c' }]
  const products = [{ id: 'one', sources: ['a', 'b', 'missing', 'a'] }, { id: 'two', sources: [] }]
  const index = indexProductSources(products, sources)
  for (const product of products) assert.deepEqual(index.get(product.id), sources.filter(source => product.sources.includes(source.id)))
  assert.equal(index.get('one')![0], sources[0])
})

test('check replacement preserves immutability, first-match behavior and append ordering', () => {
  const check: MedicalCheck = { message_id: 'u', text: '合成原话', status: 'checking', preliminary: true, statements: [] }
  const duplicate = { ...check }, other = { ...check, message_id: 'other' }
  const previous = [check, duplicate, other]
  const replacement = { ...check, status: 'supported' as const }
  const result = updateMedicalChecks(previous, replacement)
  assert.deepEqual(result, [replacement, duplicate, other])
  assert.equal(result[0], replacement)
  assert.equal(result[1], duplicate)
  assert.equal(previous[0], check)
  assert.notEqual(result, previous)
  const appended = { ...check, message_id: 'new' }
  assert.deepEqual(updateMedicalChecks(previous, appended), [...previous, appended])
})

test('source indexing retains last duplicate source and last duplicate product semantics', () => {
  const old = { id: 'a', text: '旧来源' }, latest = { id: 'a', text: '新来源' }, middle = { id: 'b', text: '其他来源' }
  const products = [{ id: 'p', sources: ['a'] }, { id: 'p', sources: ['a', 'missing', 'b', 'a'] }, { id: 'empty', sources: [] }]
  const index = indexProductSources(products, [old, middle, latest])
  assert.deepEqual(index.get('p'), [middle, latest])
  assert.deepEqual(index.get('empty'), [])
  assert.equal(index.get('p')![1], latest)
  assert.deepEqual(products[1].sources, ['a', 'missing', 'b', 'a'])
})
