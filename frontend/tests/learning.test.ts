import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextAction, learningLabels } from '../src/lib/learning.ts'
import type { LiveCoach } from '../src/lib/voice-events.ts'

const text = '我先确认本次交流的目标，再约定下一步。'
const record = { messages: [{ id: 'u', role: 'trainee', text, final: true }], coaching: [{
  final_report: true, focus: '沟通', points: ['先复述关注点，再确认目标。'], assessment: { calibration_status: 'uncalibrated', dimensions: [
    { key: 'evidence', label: '证据', score: 4, reason: '完整', utterances: [] },
    { key: 'needs', label: '需求确认', score: 2, reason: '应先明确本次目标', utterances: [{ message_id: 'u', quote: '先确认本次交流的目标' }] },
  ] },
}] as unknown as LiveCoach[] }

test('review action selects the weakest observed dimension and keeps the original rubric order', () => {
  const action = nextAction(record)
  assert.equal(action.focus, '需求确认'); assert.equal(action.quote, '先确认本次交流的目标')
  assert.equal(action.action, '先复述关注点，再确认目标。'); assert.equal(action.calibrated, false)
  assert.equal(record.coaching[0].assessment!.dimensions[0].key, 'evidence')
})

test('review action discards obsolete feedback and never displays invented or unfinished trainee quotes', () => {
  const changed = structuredClone(record)
  changed.coaching[0].assessment!.dimensions[1].utterances[0].quote = '没有出现在记录中的引用'
  assert.equal(nextAction(changed).quote, undefined)
  changed.coaching[0].assessment!.dimensions[1].utterances[0].quote = text
  changed.messages[0].final = false
  assert.equal(nextAction(changed).quote, undefined)
  changed.coaching[0].superseded = true
  assert.equal(nextAction(changed).focus, '回应结构')
  assert.equal(nextAction({ messages: [] }).quote, undefined)
  assert.equal(learningLabels.verified, '本次迁移表现已复核')
})

test('an invalid latest report never falls back to an obsolete score or accepts out-of-range grades', () => {
  const changed=structuredClone(record)
  changed.coaching.push({...changed.coaching[0],superseded:true})
  assert.equal(nextAction(changed).scorable,false)
  assert.equal(nextAction(changed).focus,'回应结构')
  const invalid=structuredClone(record)
  invalid.coaching[0].assessment!.dimensions.forEach(dimension=>{dimension.score=99})
  assert.equal(nextAction(invalid).scorable,false)
})

test('quote normalization follows corrected text, checks all matching messages and preserves equal-score order', () => {
  const changed = structuredClone(record)
  const dimensions = changed.coaching[0].assessment!.dimensions
  dimensions[0] = { ...dimensions[1], key: 'first', label: '首个同分维度' }
  dimensions[0].utterances[0].quote = '先 确认本次交流的目标'
  changed.messages.unshift({ ...changed.messages[0], final: false })
  assert.equal(nextAction(changed).focus, '首个同分维度')
  assert.equal(nextAction(changed).quote, '先 确认本次交流的目标')
  changed.messages.forEach(message => { message.text = '这次的实际原话已经修改。' })
  assert.equal(nextAction(changed).quote, undefined)
})
