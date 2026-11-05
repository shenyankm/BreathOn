import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Models, generateReply, counters, verifyCoachQuotes, WebSearch } from '../src/agents.ts'
import { settings, type Doc, constants } from '../src/core.ts'
import { validateAssessment, applyApplicability } from '../src/training.ts'
import { validateMedical, validateSummary } from '../src/medical.ts'
import { publicURL, publicIP } from '../src/validation.ts'
import { coach, modelMock, sse } from './helpers.ts'

const history = [
  { id: 'd', role: 'doctor', text: '你准备依据哪项研究回应？', final: true },
  { id: 'u', role: 'trainee', text: '我会先核对原始研究的人群与终点。', final: true },
]
test('real Pi runtime isolates doctor and coach inputs, embeds skills, and accounts for both calls', async () => {
  const requests: Doc[] = [],
    models = new Models(
      { ...settings({}), key: 'synthetic-key', search: false },
      modelMock((body) => {
        requests.push(body)
        return JSON.stringify(body.messages[0]).includes('本次只扮演医生')
          ? { doctor_reply: '准备如何核对研究原文？' }
          : { coach }
      }),
    ),
    reply = await generateReply(models, history, {
      reference_context: { evidence: [{ id: 'reference-only', text: '仅教练可见资料' }] },
    })
  assert.equal(reply.result.doctor_reply, '准备如何核对研究原文？')
  assert.equal(requests.length, 2)
  assert.equal(reply.usage.total_tokens, 40)
  const doctor = requests.find((row) =>
      JSON.stringify(row.messages[0]).includes('本次只扮演医生'),
    )!,
    teacher = requests.find((row) => row !== doctor)!
  assert(!JSON.stringify(doctor).includes('仅教练可见资料'))
  assert(JSON.stringify(teacher).includes('仅教练可见资料'))
  assert.equal(doctor.temperature, 0.3)
  assert.equal(teacher.temperature, 0)
  assert.equal(teacher.thinking.type, 'disabled')
  assert.equal(teacher.response_format.type, 'json_object')
  assert.equal(teacher.max_tokens, 2000)
  assert(!teacher.tools?.length)
  assert(JSON.stringify(teacher).includes('medical-rep-evidence-communication'))
  assert(JSON.stringify(teacher).includes('我会先核对原始研究的人群与终点。'))
})

test('doctor is published before the coach, and cancellation drains the pending provider call', async () => {
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve
    })
  let delivered = false,
    aborted = false
  const models = new Models(
    { ...settings({}), key: 'synthetic-key', search: false },
    async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      if (JSON.stringify(body.messages[0]).includes('本次只扮演医生'))
        return sse({ doctor_reply: '你准备怎样核对原文？' })
      started()
      await Promise.race([
        gate,
        new Promise((_, reject) =>
          init!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(init!.signal!.reason)
            },
            { once: true },
          ),
        ),
      ])
      return sse({ coach })
    },
  )
  const controller = new AbortController(),
    running = generateReply(models, history, {
      signal: controller.signal,
      onDoctor: async () => {
        delivered = true
      },
    })
  await entered
  for (let i = 0; i < 100 && !delivered; i++) await delay(10)
  assert(delivered)
  controller.abort()
  await assert.rejects(running)
  assert(aborted)
  release()
})

test('provider retries remain bounded and an invalid coach cannot discard a valid doctor', async () => {
  let calls = 0
  const models = new Models(
    { ...settings({}), key: 'synthetic-key', search: false },
    async (_input, init) => {
      calls++
      if (calls === 1) return new Response('{}', { status: 503 })
      const body = JSON.parse(String(init?.body))
      return sse(
        JSON.stringify(body.messages[0]).includes('本次只扮演医生')
          ? { doctor_reply: '请确认原文范围。' }
          : { coach: { focus: '' } },
      )
    },
  )
  const reply = await generateReply(models, history)
  assert.equal(calls, 3)
  assert.equal(reply.result.doctor_reply, '请确认原文范围。')
  assert(reply.result.coach.degraded)
  assert(counters['retry.agent_call'] >= 1)
  let unauthorized = 0
  const rejected = new Models(
    { ...settings({}), key: 'synthetic-key', search: false },
    async () => {
      unauthorized++
      return new Response('{}', { status: 401 })
    },
  )
  await assert.rejects(() => generateReply(rejected, history))
  assert.equal(unauthorized, 2)
})

test('Pi executes actual bounded tools and never runs a tool that was not registered', async () => {
  let turns = 0,
    executed = 0
  const models = new Models({ ...settings({}), key: 'synthetic-key' }, async () => {
    turns++
    if (turns === 1)
      return new Response(
        'data: ' +
          JSON.stringify({
            id: 'tool',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call1',
                      type: 'function',
                      function: { name: 'public_lookup', arguments: '{"query":"公开资料"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            id: 'tool',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    return sse({ answer: '有工具返回的原文' })
  })
  const agent = models.agent('仅使用公开资料。', {
    iterations: 2,
    tools: [
      {
        name: 'public_lookup',
        label: 'lookup',
        description: '公开查询',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async () => {
          executed++
          return { content: [{ type: 'text', text: '原文' }], details: {} }
        },
      },
    ],
  })
  const reply = await agent.reply('核对公开资料')
  assert.equal(executed, 1)
  assert.equal(turns, 2)
  assert.equal(JSON.parse(reply.text).answer, '有工具返回的原文')
})

test('quoted evidence, medical coverage and source applicability fail closed', () => {
  const training = {
      rubric: {
        id: 'r',
        name: '量表',
        calibration_status: 'uncalibrated',
        dimensions: [
          {
            key: 'accuracy',
            label: '准确性',
            weight: 100,
            requires_content: true,
            anchors: ['错', '弱', '中', '好', '全'],
          },
        ],
      },
      evidence: [
        {
          id: 'D1',
          text: '原始材料只覆盖成人研究人群，不包含其他人群。',
          document_id: 'doc',
          document_version: 1,
          page: 1,
        },
      ],
    },
    transcript = [{ id: 'u', speaker: 'trainee', text: '成人研究需要核对原文。', final: true }],
    raw = {
      dimensions: [
        {
          key: 'accuracy',
          score: 4,
          reason: '可核对',
          utterances: [{ message_id: 'u', quote: '成人研究' }],
          citations: [{ source_id: 'D1', quote: '原始材料只覆盖成人研究人群' }],
        },
      ],
    }
  const assessment = validateAssessment(raw, training, transcript, 'mock')
  assert.equal(assessment.total, 100)
  assert.equal(
    applyApplicability(assessment, { dimensions: [{ key: 'accuracy', admissible: false }] }, [
      'accuracy',
    ]).total,
    null,
  )
  const bad = structuredClone(raw)
  bad.dimensions[0].utterances[0].quote = '从未说过的原话'
  assert.equal(validateAssessment(bad, training, transcript, 'mock').total, null)
  const prose = structuredClone(coach)
  prose.analysis = '学员说“从未说过的原话”。'
  assert.equal(verifyCoachQuotes(prose, transcript), 1)
  assert(prose.analysis.includes('已省略'))
  assert.throws(() => validateMedical({ statements: [] }, '第一句。第二句。', []))
  const card = validateSummary(
    {
      dimensions: [
        {
          key: 'communication',
          score: 100,
          reason: '猜测',
          quotes: [{ message_id: 'u', quote: '从未说过' }],
        },
      ],
    },
    { messages: history, capture_status: 'completed', free_context: {} },
    'mock',
    [],
  )
  assert.equal(card.total, null)
  assert(card.dimensions.every((d: Doc) => d.score === null))
})

test('search privacy filters and SSRF boundaries reject unsafe inputs before network access', async () => {
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'https://example.org/?token=secret',
    'https://user:password@example.org/',
  ])
    assert.equal(publicURL(url), false, url)
  assert(!publicIP('10.0.0.1'))
  assert(!publicIP('198.18.0.1'))
  for (const address of [
    '192.0.2.1',
    '203.0.113.1',
    '100.64.0.1',
    '224.0.0.1',
    '::ffff:10.0.0.1',
    'fe80::1',
    'fc00::1',
  ])
    assert(!publicIP(address), address)
  let calls = 0
  const web = new WebSearch(
    new Models({ ...settings({}), key: 'synthetic-key' }, async () => {
      calls++
      throw new Error('Network forbidden')
    }),
  )
  assert((await web.search('手机号13812345678')).error)
  for (const query of [
    '手机号 138 1234 5678',
    '患者张某的具体病情',
    '住院号 AB12345',
    '男性45岁',
    '联系人 test@example.org',
  ])
    assert((await web.search(query)).error, query)
  assert((await web.search('synthetic-key')).error)
  assert((await web.fetch('http://localhost/')).error)
  assert.equal(calls, 0)
})
