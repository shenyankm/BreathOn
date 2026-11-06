import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { type Doc, settings, uuid, assert, constants, HttpError } from './core.ts'
import { Store } from './store.ts'
import { Authentication, adminPath } from './auth.ts'
import { Catalog } from './catalog.ts'
import { Models, counters } from './agents.ts'
import { Medical } from './medical.ts'
import { Research } from './research.ts'
import { Visits } from './visits.ts'
import { Sessions } from './sessions.ts'
import { Tasks } from './tasks.ts'
import { registerPlatform } from './platform.ts'
import { registerDocuments } from './documents.ts'
import { registerOperations } from './operations.ts'
import { DUPLEX_MODEL } from './voice-protocol.ts'

export async function createApp(config: Doc = settings(), fetcher: typeof fetch = fetch) {
  const app = Fastify({
    logger: false,
    bodyLimit: 8_000_000,
    requestTimeout: 900000,
    connectionTimeout: 60000,
    trustProxy: false,
    routerOptions: { maxParamLength: 200 },
  })
  const store = new Store(config),
    auth = new Authentication(config),
    models = new Models(config, fetcher),
    catalog = new Catalog(store),
    tasks = new Tasks(),
    medical = new Medical(store, models),
    research = new Research(store, models, tasks),
    visits = new Visits(store, tasks, fetcher),
    sessions = new Sessions(store, models, medical, auth)
  const publicPaths = new Set([
    '/api/live',
    '/api/ready',
    '/api/auth/session',
    '/api/auth/login',
    '/api/auth/logout',
  ])
  let ready = false,
    checking: Promise<void> | undefined,
    cleanup: Promise<void> | undefined,
    recovering: Promise<void> | undefined
  app.decorateRequest('user')
  await app.register(websocket, { options: { maxPayload: 4096, perMessageDeflate: false } })
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]
    reply
      .header('X-Request-ID', uuid().replaceAll('-', ''))
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
    request.user = auth.user(request, store.workspace)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      assert(config.origins.includes(request.headers.origin), 403, '请求来源未获授权。')
      const audio = /^\/api\/visits\/[^/]+\/audio$/.test(path),
        type = request.headers['content-type']?.split(';')[0]
      assert(
        !request.headers['transfer-encoding'] &&
          ((!audio && !['application/json', 'application/pdf'].includes(type ?? '')) ||
            request.headers['content-length'] !== undefined),
        411,
        '请使用包含 Content-Length 的请求。',
      )
      const size = Number(request.headers['content-length'] ?? 0),
        limit = audio
          ? 100_000_000
          : type === 'application/pdf' || path === '/api/research/policy-file'
            ? 20_000_000
            : 8_000_000
      assert(Number.isSafeInteger(size) && size >= 0, 400, '请求长度不明确。')
      assert(size <= limit, 413, '请求内容过大。')
    }
    if (
      config.auth &&
      !publicPaths.has(path) &&
      !(/^\/api\/visits\/[0-9a-f-]{36}\/provider-audio$/i.test(path) && request.method === 'GET')
    ) {
      assert(request.user.authenticated, 401, '请先登录。')
      if (request.user.role !== 'admin' && adminPath(path, request.method))
        assert(false, /^\/api\/sessions\/[^/]+\/reviews$/.test(path) ? 404 : 403, '无权访问。')
    }
  })
  app.addContentTypeParser(
    [
      'application/pdf',
      'application/octet-stream',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    { parseAs: 'buffer', bodyLimit: 20_000_000 },
    (_request, body, done) => done(null, body),
  )
  app.addContentTypeParser(
    /^audio\//,
    { parseAs: 'buffer', bodyLimit: 100_000_000 },
    (_request, body, done) => done(null, body),
  )
  app.setErrorHandler((error: any, _request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 503
    let message =
      status === 503 && !(error instanceof HttpError)
        ? '记录数据库或服务暂不可用，请稍后重试。'
        : error.message
    if (
      error.validation ||
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error instanceof SyntaxError
    )
      message = '输入格式无效，请检查字段与JSON格式。'
    if (!error.statusCode)
      console.error(
        JSON.stringify({ event: 'http_error', error_type: error.constructor?.name ?? 'Error' }),
      )
    reply.code(error instanceof SyntaxError ? 422 : status).send({ detail: message })
  })
  auth.register(app)
  app.get('/api/live', async () => ({ status: 'ok' }))
  app.get('/api/ready', async (_request, reply) => {
    if (!ready) return reply.code(503).send({ status: 'not_ready' })
    checking ??= store.check().finally(() => {
      checking = undefined
    })
    try {
      await Promise.race([
        checking,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Ready timeout')), 3000)
          timer.unref()
        }),
      ])
      return { status: 'ok' }
    } catch {
      return reply.code(503).send({ status: 'not_ready' })
    }
  })
  app.get('/api/health', async () => {
    await store.check()
    return {
      status: 'ok',
      storage: config.database ? 'postgresql' : 'json',
      agent_framework: 'pi',
      voice_configured: !!config.voiceKey,
      asr_configured: !!config.asrKey,
      tts_configured: !!config.ttsKey && !!config.ttsVoice,
      analysis_configured: !!config.key && !!config.model,
      practice_configured: !!config.asrKey && !!config.key && !!config.ttsKey,
      combat_configured: !!config.voiceKey && !!config.asrKey && !!config.key,
      analysis_model: config.model,
      model: DUPLEX_MODEL,
    }
  })
  const since = new Date().toISOString()
  app.get('/api/admin/agent-metrics', async () => ({
    scope: 'process',
    since,
    counters: { ...counters },
  }))
  app.get('/api/doctor', async () => constants.doctor.DOCTOR_PROFILE)
  registerPlatform(app, store, catalog)
  registerDocuments(app, store, catalog)
  const calibration = registerOperations(app, store, catalog, models, tasks)
  medical.register(app)
  research.register(app)
  visits.register(app)
  sessions.register(app)
  app.addHook('onReady', async () => {
    try {
      await store.open()
      await catalog.seed()
      await calibration.recover(true)
      await sessions.recover(true)
      await visits.cleanup()
      await visits.recover()
      await research.startScheduler()
      ready = true
    } catch (error) {
      await store.close().catch(() => {})
      throw error
    }
  })
  const timer = setInterval(() => {
    if (ready && !cleanup)
      cleanup = visits
        .cleanup()
        .catch(() => {
          console.error('visit_cleanup_failed')
        })
        .finally(() => {
          cleanup = undefined
        })
  }, 3600000)
  timer.unref()
  const recoveryTimer = setInterval(() => {
    if (ready && !recovering)
      recovering = (async () => {
        await sessions.recover()
        await calibration.recover()
      })().catch(() => {
        console.error('state_recovery_failed')
      }).finally(() => { recovering = undefined })
  }, 30000)
  recoveryTimer.unref()
  app.addHook('preClose', async () => {
    ready = false
    clearInterval(timer)
    clearInterval(recoveryTimer)
    await visits.close()
    await research.close()
    await sessions.close()
    await tasks.close()
    await recovering?.catch(() => {})
    await checking?.catch(() => {})
    await cleanup?.catch(() => {})
  })
  app.addHook('onClose', async () => store.close())
  return { app, store, models, medical, research, visits, sessions, tasks }
}
