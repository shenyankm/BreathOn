import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, sse } from './helpers.ts'
import { resource, pick } from '../src/core.ts'
import { parse } from '../src/validation.ts'
import { scenarioTemplates, doctorInstructions, prepareTraining } from '../src/training.ts'

const user = { id: 'local', workspace: 'local', role: 'admin' as const, team: '', authenticated: false }
test('all scenario schemas preserve the old types and accept every shared training template', () => {
  const keys = Object.keys(scenarioTemplates)
  assert.equal(keys.length, 12)
  assert.equal(new Set(Object.values(scenarioTemplates).map(template => template.group)).size, 4)
  for (const legacy of ['first_visit', 'follow_up', 'time_pressure', 'evidence_challenge']) assert(keys.includes(legacy))
  let enums = 0
  function check(value: any) {
    if (!value || typeof value !== 'object') return
    if (value.properties?.situation?.enum) {
      assert.deepEqual(value.properties.situation.enum, keys)
      enums++
    }
    Object.values(value).forEach(check)
  }
  check(resource('schemas'))
  assert(enums >= 6)
  for (const [situation, template] of Object.entries(scenarioTemplates)) {
    const scene = parse('platform.models.Scenario', {
      ...pick(template, ['objective', 'background', 'opening', 'objections', 'success_criteria', 'stages', 'duration_seconds', 'difficulty']),
      situation, title: template.label, product: '合成教学主题', disease: '软件测试', doctor_id: 'doctor', rubric_id: 'rubric', content_ids: [],
    })
    const instructions = doctorInstructions({ scenario: scene, doctor: { mood: 'neutral' }, stage: 'full' })
    assert(instructions.includes(template.doctor_rule))
    assert(template.success_criteria.length >= 3)
    assert(template.objections.length >= 2)
  }
})

test('generation uses selected focus stages, retains evidence checks, and exports the new situation', async () => {
  let generationInput: any
  const f = await fixture({ key: 'synthetic-key' }, async (_url, init) => {
    const messages = JSON.parse(String(init?.body)).messages
    const content = messages[1].content
    generationInput = JSON.parse(typeof content === 'string' ? content : content[0].text)
    const template = scenarioTemplates[generationInput.brief.situation]
    return sse({ ...pick(template, ['background', 'opening', 'objections', 'success_criteria']), title: template.label,
      citations: [{ source_id: generationInput.evidence[0].id, quote: generationInput.evidence[0].text.slice(0, 40) }] })
  })
  try {
    const bound = await f.store.transaction('local', async tx => {
      const doctor = await tx.create('local', 'doctor', { ...parse('platform.models.Doctor', { name: '虚构测试医生', specialty: '测试科室', population: '教学', focus: '证据边界', training_style: '克制交流', opening: '今天讨论什么问题？' }), status: 'published' })
      const rubric = await tx.create('local', 'rubric', { ...parse('platform.models.Rubric', { name: '测试量表', dimensions: [{ key: 'communication', label: '沟通', weight: 100, anchors: ['未观察', '待改进', '基本完成', '充分完成', '清晰完整'], requires_content: false }] }), status: 'published', calibration_status: 'uncalibrated' })
      const content = await tx.create('local', 'content', { ...parse('platform.models.Content', { title: '合成教学材料', version_label: '1', scope: '软件测试', pages: [{ number: 1, text: '这是用于软件测试的合成教学材料，不含真实医学结论。学员应确认问题、区分已有证据与未知信息，并约定资料核实与跟进。' }] }), status: 'approved' })
      return { doctor_id: doctor.id, rubric_id: rubric.id, content_ids: [content.id] }
    })
    for (const situation of ['population_fit', 'off_label_request', 'action_plan']) {
      const template = scenarioTemplates[situation]
      const response = await f.call('POST', '/api/scenarios/generate', { ...bound, situation, objective: template.objective, product: '合成主题', disease: '教学', difficulty: template.difficulty, duration_seconds: template.duration_seconds })
      assert.equal(response.statusCode, 201, response.body)
      const scene = response.json()
      assert.equal(scene.status, 'draft')
      assert.deepEqual(scene.stages, template.stages)
      assert.equal(generationInput.situation_rule, template.doctor_rule)
      assert.deepEqual(generationInput.training_focus.success_criteria, template.success_criteria)
      const preview = await prepareTraining(f.store, user, scene.id, 'full', true)
      assert.equal(preview.scenario.situation, situation)
      assert(doctorInstructions(preview).includes(template.doctor_rule))
      const exported = await f.call('GET', `/api/scenarios/${scene.id}/export`)
      assert.equal(exported.statusCode, 200, exported.body)
      const imported = await f.call('POST', '/api/scenarios/import', exported.json())
      assert.equal(imported.statusCode, 201, imported.body)
    }
  } finally { await f.close() }
})
