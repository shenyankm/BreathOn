import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture, sse } from './helpers.ts'
import { validateResearch, researchConfig } from '../src/research.ts'

const candidates = [
  { name: '同名测试医生', hospital: '甲测试医院', department: '神经外科', source_url: 'https://example.org/doctor-a' },
  { name: '同名测试医生', hospital: '乙测试医院', department: '消化内科', source_url: 'https://example.org/doctor-b' },
]
const result = { findings: [], further_checks: ['候选来自搜索摘要，尚未核实。'], doctor_candidates: candidates }
const captured = { archives: [], queries: ['姓名 官网', '姓名 科室'], search_results: candidates.map(c => ({ url: c.source_url })), evidence_seen: {}, errors: [] }

test('unarchived doctor candidates require real search receipts and never become verified facts', async () => {
  const validate = (raw: unknown, profile = researchConfig.agents.doctor) => validateResearch(raw, profile, '/unused', captured)
  assert.deepEqual((await validate(result)).doctor_candidates, candidates)
  assert.equal((await validate({ ...result, doctor_candidates: [candidates[0]] })).doctor_candidates.length, 1)
  await assert.rejects(() => validate({ ...result, doctor_candidates: [candidates[0], candidates[0]] }))
  await assert.rejects(() => validate({ ...result, doctor_candidates: [candidates[0], { ...candidates[1], source_url: 'https://example.org/invented' }] }))
  await assert.rejects(() => validate({ ...result, doctor_candidates: [candidates[0], { ...candidates[1], source_url: 'javascript:alert(1)' }] }))
  await assert.rejects(() => validate(result, researchConfig.agents.drug))
  await assert.rejects(() => validate({ findings: [], further_checks: [] }))
  await assert.rejects(() => validate({ ...result, findings: [{ title: '不可混入事实', details: [{ label: '姓名', value: '同名测试医生', source_id: 'a'.repeat(24), evidence_id: 'E1-' + 'b'.repeat(12) }], caveats: [] }] }))
})

test('Pi research pauses for identity selection and continues with the selected hospital and department', async () => {
  let turns = 0
  let selectedInput: any
  const f = await fixture({ key: 'synthetic-key', search: true }, async (url, init) => {
    if (String(url).includes('/v1/tools/search'))
      return Response.json({ results: candidates.map(c => ({ url: c.source_url, title: `${c.name} ${c.hospital}`, summary: c.department })) })
    const body = JSON.parse(String(init?.body))
    const content = body.messages[1].content
    const input = JSON.parse(typeof content === 'string' ? content : content[0].text)
    assert(JSON.stringify(body.messages[0]).includes('doctor_candidates'))
    if (input.doctor_identity) {
      selectedInput = input
      return sse({ findings: [], further_checks: ['仅测试选择后的检索范围，未调用外部来源。'] })
    }
    if (!input.doctor_identity) assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['mcp__medvisit_research__search_public'])
    if (++turns <= 1) {
      const chunks = [
        { id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call${turns}`, type: 'function', function: { name: 'mcp__medvisit_research__search_public', arguments: JSON.stringify({ query: `同名测试医生 官网 科室 ${turns}` }) } }] }, finish_reason: null }] },
        { id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return sse(result)
  })
  const finished = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = (await f.call('GET', `/api/research/jobs/${id}`)).json()
      if (job.status !== 'running') return job
      await delay(10)
    }
    assert.fail('Research did not finish')
  }
  try {
    const started = await f.call('POST', '/api/research/jobs', { kind: 'doctor', query: '同名测试医生' })
    assert.equal(started.statusCode, 201)
    const job = await finished(started.json().id)
    assert.equal(job.status, 'needs_selection', JSON.stringify(job))
    assert.equal(job.source_ids.length, 0)
    assert.equal(job.doctor_draft, undefined)
    assert.equal(job.result.findings.length, 0)
    assert.deepEqual(job.result.doctor_candidates, candidates)
    assert.equal((await f.call('POST', `/api/research/jobs/${job.id}/doctor-draft`, { finding_index: 0, confirmed_identity: true, confirmed_name: candidates[0].name })).statusCode, 409)
    const { source_url, ...identity } = candidates[1]
    const next = await f.call('POST', '/api/research/doctor-jobs', identity)
    assert.equal(next.statusCode, 201)
    await finished(next.json().id)
    assert.deepEqual(selectedInput.doctor_identity, identity)
    assert.equal(selectedInput.query, '同名测试医生 乙测试医院 消化内科')
    assert.equal((await f.call('GET', `/api/research/jobs/${job.id}`)).json().status, 'needs_selection')
  } finally {
    await f.close()
  }
})
