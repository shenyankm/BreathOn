import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { type Doc, type User, assert, Semaphore, sha } from './core.ts'
import { parse } from './validation.ts'

const derive = (
  password: string,
  salt: Buffer,
  length: number,
  options: import('node:crypto').ScryptOptions,
) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key))),
  )
const cookie = 'medvisit_session',
  seconds = 28800
export class Authentication {
  private sessions = new Map<string, { username: string; expires: number }>()
  private attempts: number[] = []
  private verifying = new Semaphore(1)
  constructor(private config: Doc) {}
  token(request: FastifyRequest) {
    return (
      request.headers.cookie
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(cookie + '='))
        ?.slice(cookie.length + 1) ?? ''
    )
  }
  session(request: FastifyRequest) {
    const key = sha(this.token(request)),
      found = this.sessions.get(key)
    if (found && found.expires > Date.now() / 1000) return found
    this.sessions.delete(key)
    return undefined
  }
  user(request: FastifyRequest, workspace: string): User {
    const found = this.session(request)
    return {
      id: found?.username ?? 'local',
      workspace,
      team: '',
      role: found
        ? this.config.admins.includes(found.username)
          ? 'admin'
          : 'representative'
        : 'admin',
      authenticated: !!found,
    }
  }
  cookie(reply: FastifyReply, token = '', age = seconds) {
    reply.header(
      'Set-Cookie',
      `${cookie}=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${this.config.origins.every((s: string) => s.startsWith('https://')) ? '; Secure' : ''}`,
    )
  }
  register(app: FastifyInstance) {
    app.get('/api/auth/session', async (request) => {
      const found = this.session(request)
      return {
        enabled: this.config.auth,
        authenticated: !!found,
        username: found?.username ?? null,
        expires_at: found?.expires ?? null,
        role: found ? this.user(request, '').role : this.config.auth ? null : 'admin',
      }
    })
    app.post('/api/auth/login', async (request, reply) => {
      const body = parse('api.auth.Login', request.body)
      assert(this.config.auth, 400, '本地免登录模式未启用账号登录。')
      this.attempts = this.attempts.filter((t) => t > Date.now() - 60000)
      if (this.attempts.length >= 10) {
        reply.header('Retry-After', '60')
        assert(false, 429, '登录尝试过多，请一分钟后重试。')
      }
      this.attempts.push(Date.now())
      const encoded = this.config.users[body.username] ?? Object.values(this.config.users)[0]
      const [, salt, expected] = String(encoded).split(':')
      const actual = await this.verifying.run(
        () =>
          derive(body.password, Buffer.from(salt, 'hex'), 32, {
            N: 131072,
            r: 8,
            p: 1,
            maxmem: 256 * 1024 * 1024,
          }) as Promise<Buffer>,
      )
      assert(
        timingSafeEqual(actual, Buffer.from(expected, 'hex')) && this.config.users[body.username],
        401,
        '账号或密码不正确。',
      )
      const token = randomBytes(32).toString('base64url'),
        expires = Date.now() / 1000 + seconds
      for (const [key, value] of this.sessions)
        if (value.expires <= Date.now() / 1000) this.sessions.delete(key)
      if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!)
      this.sessions.set(sha(token), { username: body.username, expires })
      this.cookie(reply, token)
      return {
        enabled: true,
        authenticated: true,
        username: body.username,
        expires_at: expires,
        role: this.config.admins.includes(body.username) ? 'admin' : 'representative',
      }
    })
    app.post('/api/auth/logout', async (request, reply) => {
      this.sessions.delete(sha(this.token(request)))
      this.cookie(reply, '', 0)
      return { ok: true }
    })
  }
}
export function adminPath(path: string, method: string): boolean {
  return (
    path.startsWith('/api/admin/') ||
    /^\/api\/(research|calibration|rubrics\/)/.test(path) ||
    path === '/api/services/check' ||
    (path === '/api/usage/prices' && method !== 'GET') ||
    (path.startsWith('/api/catalog/') && !['GET', 'HEAD'].includes(method)) ||
    /^\/api\/scenarios\/.*\/export$/.test(path) ||
    [
      '/api/content/pdf',
      '/api/content/import',
      '/api/scenarios/import',
      '/api/scenarios/generate',
    ].includes(path) ||
    (/^\/api\/sessions\/[^/]+\/reviews$/.test(path) && method === 'POST')
  )
}
