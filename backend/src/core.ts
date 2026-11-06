import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Doc = Record<string, any>
export type User = {
  id: string
  workspace: string
  team: string
  role: 'admin' | 'representative'
  authenticated: boolean
}
export const identity = new AsyncLocalStorage<User>()
export const now = () => new Date().toISOString()
export const uuid = () => randomUUID()
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const normalize = (value: string) => value.replace(/\s+/gu, '')
export const resource = (name: string) =>
  JSON.parse(readFileSync(new URL(`../resources/${name}.json`, import.meta.url), 'utf8')) as Doc
export const constants = resource('constants')
export const pick = (row: Doc, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))
export const unique = <T>(values: T[]) => [...new Set(values)]
export function assert(condition: unknown, status: number, detail: string): asserts condition {
  if (!condition) throw new HttpError(status, detail)
}
export class HttpError extends Error {
  statusCode: number
  constructor(status: number, message: string) {
    super(message)
    this.statusCode = status
  }
}
// Stored fingerprints use Python's JSON spacing and sorted keys; keep old records comparable.
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(', ')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${canonical(value[key])}`)
      .join(', ')}}`
  return JSON.stringify(value)
}
export class Semaphore {
  private active = 0
  private pending: (() => void)[] = []
  constructor(private limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.pending.push(resolve))
    else this.active++
    try {
      return await work()
    } finally {
      const next = this.pending.shift()
      if (next) next()
      else this.active--
    }
  }
}
export function settings(env: NodeJS.ProcessEnv = process.env): Doc {
  const number = (key: string, fallback: number, integer = false) => {
    const value = Number(env[key] ?? fallback)
    assert(
      Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value)),
      500,
      `Invalid ${key}`,
    )
    return value
  }
  const origins = (env.ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
  for (const origin of origins) {
    const url = new URL(origin)
    assert(
      ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.origin === origin &&
        !/[\s*\\%]/u.test(origin),
      500,
      'Invalid ALLOWED_ORIGINS',
    )
  }
  const auth = (env.AUTH_REQUIRED ?? 'false').toLowerCase() !== 'false'
  const users = JSON.parse(env.LOGIN_USERS_JSON ?? '{}')
  const admin = env.ADMIN_USERNAME || 'admin'
  if (auth && Object.keys(users).length === 0) users[admin] = env.ADMIN_PASSWORD_HASH ?? ''
  const admins = JSON.parse(env.ADMIN_USERS_JSON ?? '[]')
  if (!admins.length && users[admin]) admins.push(admin)
  if (auth) {
    assert(
      users && !Array.isArray(users) && Object.keys(users).length <= 32,
      500,
      'Invalid LOGIN_USERS_JSON',
    )
    for (const [name, hash] of Object.entries(users))
      assert(
        name.trim() &&
          name.length <= 100 &&
          typeof hash === 'string' &&
          /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/i.test(hash),
        500,
        'Invalid account/password hash',
      )
    assert(
      Array.isArray(admins) && admins.length > 0 && admins.every((name: string) => users[name]),
      500,
      'Invalid ADMIN_USERS_JSON',
    )
    assert(
      origins.every(
        (origin) =>
          origin.startsWith('https://') ||
          ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname),
      ),
      500,
      'Authentication requires HTTPS',
    )
  }
  const modelTimeout = number('DEEPSEEK_TIMEOUT_SECONDS', 20)
  const config = {
    auth,
    users,
    admins,
    admin,
    origins,
    records: resolve(env.RECORDS_DIR || new URL('../data/sessions', import.meta.url).pathname),
    database: env.DATABASE_URL || '',
    model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    reviewModel: env.DEEPSEEK_REVIEW_MODEL || '',
    key: env.DEEPSEEK_API_KEY || '',
    modelUrl: env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions',
    modelTimeout,
    summaryTimeout: number('SUMMARY_TIMEOUT_SECONDS', 30),
    temperature: Number(env.DOCTOR_TEMPERATURE ?? 0.3),
    search: (env.DEEPSEEK_SEARCH_ENABLED ?? 'true').toLowerCase() === 'true',
    modelConcurrency: number('DEEPSEEK_MAX_CONCURRENCY', 2500, true),
    searchQps: number('DEEPSEEK_SEARCH_QPS', 100, true),
    fetchQps: number('DEEPSEEK_FETCH_QPS', 25, true),
    researchConcurrency: number('RESEARCH_MAX_CONCURRENCY', 4, true),
    minSamples: number('CALIBRATION_MIN_SAMPLES', 5, true),
    repeats: Number(env.CALIBRATION_REPEATS ?? 0),
    voiceKey: env.DOUBAO_API_KEY || '',
    voice: env.DOUBAO_VOICE || 'zh_male_xiaotian_jupiter_bigtts',
    asrKey: env.SEEDASR_API_KEY || '',
    ttsKey: env.DOUBAO_TTS_API_KEY || '',
    ttsVoice: env.DOUBAO_TTS_VOICE || 'zh_male_m191_uranus_bigtts',
    maxSessions: number('VOICE_MAX_SESSIONS', 10, true),
    sessionSeconds: 600,
    handshakeSeconds: 15,
    port: number('PORT', 8000, true),
    host: env.HOST || '127.0.0.1',
  }
  assert(
    config.temperature >= 0 &&
      config.temperature <= 1 &&
      Number.isInteger(config.repeats) &&
      config.repeats >= 0 &&
      config.repeats <= 3,
    500,
    'Invalid model settings',
  )
  return config
}
