import assert from 'node:assert/strict'
import test from 'node:test'
import { practiceTask, voiceStatus } from '../src/lib/practice-experience.ts'
import type { FreePracticeContext, TrainingSnapshot } from '../src/lib/catalog-types.ts'

test('task follows the actual stage, objective and doctor instead of fixed evidence instructions', () => {
  const training = { stage: 'opening', scenario: { objective: '简洁介绍来意' } } as TrainingSnapshot
  assert.equal(practiceTask(training, null).objective, '简洁介绍来意')
  assert.equal(practiceTask(training, null).stage, '开场')
  const free = { drug: { name: '玛仕度肽' }, doctor: { focus: '长期管理', training_style: '每轮追问一个问题' } } as FreePracticeContext
  assert.equal(practiceTask(null, free).focus, '长期管理')
  assert.match(practiceTask(null, free).objective, /玛仕度肽/)
  assert.doesNotMatch(practiceTask(null, free).objective, /设计与终点/)
})

test('voice status distinguishes playback, generation, mute, pause and saving', () => {
  const state = { status: 'active', saving: false, analysisStatus: 'not_started', policyPaused: false, muted: false, playing: false, outputMuted: false, practiceState: 'listening', speechState: 'idle' }
  assert.equal(voiceStatus(state), '可以开始说话')
  assert.equal(voiceStatus({ ...state, playing: true, speechState: 'completed' }), '医生正在回应')
  assert.equal(voiceStatus({ ...state, practiceState: 'thinking' }), '已收到，正在整理回应')
  assert.equal(voiceStatus({ ...state, muted: true }), '麦克风已静音')
  assert.equal(voiceStatus({ ...state, playing: true, policyPaused: true }), '收音已暂停')
  assert.equal(voiceStatus({ ...state, saving: true, analysisStatus: 'thinking' }), '正在整理复盘…')
  assert.equal(voiceStatus({ ...state, status: 'ended' }), '已结束')
})
