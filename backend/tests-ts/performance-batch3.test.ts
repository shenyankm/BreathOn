import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pick, type Doc } from '../src/core.ts'
import { reviewedDimensions, observedTarget } from '../src/learning.ts'
import { skillNames, interactionSummary } from '../src/agents.ts'
import { validateSummary } from '../src/medical.ts'

test('field projection keeps falsy values, missing fields and prototype-named own properties', () => {
  const source = JSON.parse('{"__proto__":{"safe":true},"constructor":0,"empty":"","flag":false,"nil":null}')
  const keys = ['__proto__', 'constructor', 'empty', 'flag', 'nil', 'absent', '__proto__']
  const result = pick(source, keys)
  assert.deepEqual(result, Object.fromEntries(keys.map(key => [key, source[key] ?? null])))
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, '__proto__'), {
    value: { safe: true }, writable: true, enumerable: true, configurable: true,
  })
  assert.equal(Object.hasOwn(Object.prototype, 'safe'), false)
})

test('review indexing preserves newest override priority, first duplicate dimension and immutable inputs', () => {
  const record = { coaching: [{ final_report: true, assessment: { dimensions: [
    { key: 'needs', score: 1 }, { key: 'needs', score: 2 }, { key: 'safety', score: 4 },
  ] } }] }
  const reviews = [{ overrides: [{ key: 'needs', score: 3, reason: '较新复核' }] },
    { overrides: [{ key: 'missing', score: 0 }, { key: 'needs', score: 0, reason: '较旧复核' }] }]
  const initial = structuredClone({ record, reviews })
  assert.deepEqual(reviewedDimensions(record, reviews), [
    { key: 'needs', score: 3, reason: '较新复核' }, { key: 'needs', score: 2 }, { key: 'safety', score: 4 },
  ])
  assert.deepEqual({ record, reviews }, initial)
  reviews[0].overrides[0].score = 2
  assert.equal(reviewedDimensions(record, reviews)[0].score, 2)
})

test('observed targets require current final trainee text and reject stale or invented quotes', () => {
  const record: Doc = { status: 'completed', capture_status: 'completed', analysis_status: 'completed',
    messages: [{ id: 'u', role: 'trainee', final: true, text: '我先确认您的关注点，再核对下一步安排。' }],
    coaching: [{ final_report: true, based_on: 'u', assessment: { validation_errors: [], dimensions: [
      { key: 'needs', score: 3, utterances: [{ message_id: 'u', quote: '先确认 您的关注点' }] },
    ] } }] }
  assert.equal(observedTarget(record, 'needs'), true)
  record.messages[0].text = '本次仅讨论其他信息，没有确认目标。'
  assert.equal(observedTarget(record, 'needs'), false)
  record.messages[0].text = '我先确认您的关注点，再核对下一步安排。'
  record.messages[0].final = false
  assert.equal(observedTarget(record, 'needs'), false)
})

test('skill routing keeps only the latest message per role when speaking and retains full-history mode', () => {
  const messages = [{ role: 'trainee', text: '核对研究证据' }, { role: 'doctor', text: '红包回扣' },
    { role: 'trainee', text: '你好' }, { role: 'doctor', text: '您好' }]
  const original = structuredClone(messages)
  assert.deepEqual(skillNames(messages), ['medical-rep-academic-visit'])
  assert.ok(skillNames(messages, false).includes('medical-rep-evidence-communication'))
  assert.ok(skillNames(messages, false).includes('medical-rep-promotion-compliance'))
  assert.ok(skillNames([...messages, { role: 'observer', text: '核对研究原文' }]).includes('medical-rep-evidence-communication'))
  assert.deepEqual(messages, original)
  assert.deepEqual(skillNames(Array(150_000).fill({ role: 'trainee', text: '你好' }), false), ['medical-rep-academic-visit'])
})

test('interaction summary uses the latest capture ending and counts only explicit interruption events', () => {
  const events = [{ type: 'capture_end', status: 'interrupted' }, { type: 'manual_interrupt' },
    { type: 'manual_interrupt' }, { type: 'capture_end', status: 'completed' }]
  const original = structuredClone(events)
  assert.match(interactionSummary(events), /^记录了2次点击打断按钮。采集完整结束。/)
  assert.match(interactionSummary([]), /完整性未知/)
  assert.deepEqual(events, original)
})

test('summary quote caches are local and leave unused malformed text unnormalized', () => {
  const quote = '我先确认您的需求，再核对原文适用人群。'
  const record = { capture_status: 'completed', messages: [
    { id: 'u', role: 'trainee', final: true, text: quote }, { id: 'unused', role: 'trainee', final: true, text: null },
  ] }
  const raw = { dimensions: ['compliance', 'communication'].map(key => ({ key, score: 80, reason: '合成观察',
    quotes: Array.from({ length: 4 }, () => ({ message_id: 'u', quote })) })), edits: [] }
  const scores = () => validateSummary(raw, record, 'test', []).dimensions.slice(1).map((row: Doc) => row.score)
  assert.deepEqual(scores(), [80, 80])
  record.messages[0].text = '修改后的原话不包含旧引用。'
  assert.deepEqual(scores(), [null, null])
  record.messages[0].text = quote
  assert.deepEqual(scores(), [80, 80])
})
