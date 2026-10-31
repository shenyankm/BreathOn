import assert from 'node:assert/strict'
import test from 'node:test'
import { groupByMessage } from '../src/lib/voice-events.ts'
import { indexProductSources } from '../src/lib/medical.ts'

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
