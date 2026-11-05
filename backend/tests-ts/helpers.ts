import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { settings, type Doc } from '../src/core.ts'

export const origin = 'http://127.0.0.1:5173'
export async function fixture(
  options: Doc = {},
  fetcher: typeof fetch = async () => {
    throw new Error('Unmocked provider call')
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'evispeak-test-')),
    config = { ...settings({}), records: join(root, 'sessions'), ...options },
    runtime = await createApp(config, fetcher)
  await runtime.app.ready()
  return {
    ...runtime,
    config,
    root,
    call: async (method: any, url: string, payload?: unknown, headers: Doc = {}) =>
      runtime.app.inject({
        method,
        url,
        headers: { Origin: origin, ...headers },
        ...(payload === undefined ? {} : { payload }),
      }),
    close: async () => {
      await runtime.app.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
export const coach = {
  focus: '确认交流需求',
  analysis: '围绕学员实际原话说明观察。',
  points: ['先核对问题再回应。'],
  risk: '',
  reply: '请问您最关注哪个问题？',
  delivery: {
    tone: '声音语调未评估。',
    fluency: '文字连贯。',
    logic: '围绕当前问题。',
    turn_taking: '未提供采集事件。',
  },
}
export function sse(content: Doc, usage = true) {
  const text = JSON.stringify(content),
    chunks = [
      {
        id: 'synthetic',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      },
      {
        id: 'synthetic',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(usage ? { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } } : {}),
      },
    ]
  return new Response(
    chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}
export function modelMock(handler?: (body: Doc) => Doc | Promise<Doc>): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    if (handler) return sse(await handler(body))
    const system = JSON.stringify(body.messages[0])
    return sse(
      system.includes('本次只扮演医生') ? { doctor_reply: '您准备依据哪份原文回应？' } : { coach },
    )
  }
}
