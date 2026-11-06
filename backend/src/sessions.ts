import type { FastifyInstance, FastifyRequest } from 'fastify'
import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type Doc, type User, assert, constants, pick, uuid, Semaphore, identity } from './core.ts'
import { Store, newRecord, privateWrite, activity, trainingFingerprint } from './store.ts'
import { Models } from './agents.ts'
import { Medical, validateSummary } from './medical.ts'
import { Dialogue } from './live.ts'
import { prepareTraining, prepareFree, snapshot, doctorInstructions, opening } from './training.ts'
import { prices } from './platform.ts'
import { Authentication } from './auth.ts'
import { route } from './http.ts'
import {
  Socket,
  ASR_URL,
  ASR_RESOURCE,
  DUPLEX_URL,
  DUPLEX_MODEL,
  BridgeError,
  parseClient,
  asrPacket,
  asrRequest,
  parseAsr,
  event,
  decode64,
  synthesize,
} from './voice-protocol.ts'

const summary = (record: Doc) => ({
  ...pick(record, ['id', 'experience', 'mode', 'started_at', 'ended_at', 'status']),
  message_count: record.messages.length,
  scenario_title: record.training?.scenario?.title ?? null,
})
export class Sessions {
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; owner: string }
  >()
  private finalizing = new Set<string>()
  private retryLock = new Semaphore(1)
  private pendingRecovery = new Set<string>()
  private checking?: Promise<Doc>
  private closing = false
  constructor(
    readonly store: Store,
    readonly models: Models,
    readonly medical: Medical,
    readonly auth: Authentication,
  ) {}
  async checkpoint(id: string, folder: 'checkpoints' | 'recovery' = 'checkpoints'): Promise<Doc | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    try {
      const data = JSON.parse(
        await readFile(join(this.store.config.records, folder, id + '.json'), 'utf8'),
      )
      return data?.id === id && Array.isArray(data.messages) ? data : null
    } catch (error: any) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }
  async restore(id: string, user?: User) {
    assert(!this.active.has(id) && !this.finalizing.has(id), 409, '练习仍在结束保存中，请稍后重试。')
    const existing = await this.store.record(id)
    let recovered = existing ?? (await this.checkpoint(id, 'recovery')) ?? (await this.checkpoint(id))
    assert(
      recovered &&
        typeof recovered.workspace === 'string' &&
        typeof recovered.owner_id === 'string' &&
        (!user || (recovered.workspace === user.workspace && recovered.owner_id === user.id)),
      404,
      '没有可恢复的记录，请保留当前对话并联系管理员。',
    )
    const owner: User = user ?? {
      id: recovered.owner_id,
      workspace: recovered.workspace,
      team: recovered.team ?? '',
      role: 'representative',
      authenticated: true,
    }
    if (!existing) {
      if (!recovered.ended_at) {
        const file = await stat(join(this.store.config.records, 'checkpoints', id + '.json'))
        recovered.ended_at = file.mtime.toISOString()
        recovered.status = recovered.capture_status = recovered.analysis_status = 'interrupted'
      }
      // A concurrent import of the complete record must win over this partial checkpoint.
      recovered = await this.store.saveRecord(recovered, recovered.status, true)
    }
    assert(recovered.workspace === owner.workspace && recovered.owner_id === owner.id, 404, '记录不属于当前账号。')
    await identity.run(owner, () => this.finishRemediation(owner, recovered))
    for (const folder of ['checkpoints', 'recovery'])
      await unlink(join(this.store.config.records, folder, id + '.json')).catch((error: any) => {
        if (error.code !== 'ENOENT') throw error
      })
    this.pendingRecovery.delete(id)
    return { session_id: id, saved: true }
  }
  async recover(includeSaved = false) {
    await this.retryLock.run(async () => {
      if (includeSaved)
        for (const record of await this.store.records(undefined, null)) {
          try {
            if (record.remediation_id && activity(record).valid) this.pendingRecovery.add(record.id)
          } catch {
            console.error(JSON.stringify({ event: 'session_recovery_invalid', session_id: record.id }))
          }
        }
      for (const folder of ['checkpoints', 'recovery']) {
        const files = await readdir(join(this.store.config.records, folder)).catch((error: any) => {
          if (error.code === 'ENOENT') return [] as string[]
          throw error
        })
        for (const file of files)
          if (/^[0-9a-f-]{36}\.json$/i.test(file)) this.pendingRecovery.add(file.slice(0, -5))
      }
      for (const id of this.pendingRecovery) {
        if (this.active.has(id) || this.finalizing.has(id)) continue
        try {
          await this.restore(id)
        } catch (error: any) {
          console.error(JSON.stringify({
            event: 'session_recovery_pending',
            session_id: id,
            error_type: error?.constructor?.name ?? 'Error',
          }))
        }
      }
    })
  }
  async own(u: User, id: string): Promise<Doc> {
    const record = (await this.store.record(id)) ?? (await this.checkpoint(id))
    assert(
      record &&
        (!u.authenticated || (record.owner_id === u.id && record.workspace === u.workspace)),
      404,
      '记录不存在。',
    )
    return record
  }
  async close() {
    this.closing = true
    const active = [...this.active.values()]
    for (const session of active) session.controller.abort()
    await Promise.allSettled(active.map((s) => s.promise))
    await this.checking?.catch(() => {})
  }
  register(app: FastifyInstance) {
    route(app, 'GET', '/api/sessions', undefined, async (u) => {
      const rows = await this.store.records(u),
        seen = new Set(rows.map((row) => row.id))
      let files: string[] = []
      try {
        files = await readdir(join(this.store.config.records, 'checkpoints'))
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error
      }
      for (const file of files)
        if (/^[0-9a-f-]{36}\.json$/i.test(file)) {
          const row = await this.checkpoint(file.slice(0, -5))
          if (
            row &&
            row.workspace === u.workspace &&
            (!u.authenticated || row.owner_id === u.id) &&
            !seen.has(row.id)
          )
            rows.push(row)
        }
      return rows
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, 50)
        .map(summary)
    })
    route(app, 'GET', '/api/sessions/{session_id}', undefined, (u, p) => this.own(u, p.session_id))
    route(app, 'GET', '/api/sessions/{session_id}/status', undefined, async (u, p) => {
      const record =
        (await this.store.record(p.session_id)) ?? (await this.checkpoint(p.session_id))
      assert(
        record &&
          record.workspace === u.workspace &&
          (!u.authenticated || u.role === 'admin' || record.owner_id === u.id),
        404,
        '记录不存在。',
      )
      if (u.role === 'admin' && record.owner_id !== u.id)
        await this.store.transaction(u.workspace, (tx) =>
          tx.audit(u, 'session.status', 'session', p.session_id),
        )
      return {
        session_id: p.session_id,
        state: this.finalizing.has(p.session_id)
          ? 'finalizing'
          : this.active.has(p.session_id)
            ? 'active'
            : record.ended_at
              ? 'saved'
              : 'interrupted',
        status: record.status,
      }
    })
    route(app, 'POST', '/api/sessions/{session_id}/retry-save', undefined, (u, p) =>
      this.retryLock.run(() => this.restore(p.session_id, u)),
    )
    route(app, 'POST', '/api/services/check', undefined, () => {
      if (!this.checking)
        this.checking = this.checkServices().finally(() => {
          this.checking = undefined
        })
      return this.checking
    })
    app.get('/api/realtime', { websocket: true }, (ws, request) => {
      const client = new Socket(ws)
      identity.run(request.user, () => {
        this.begin(client, request).catch(() => {
          ws.close(1011)
        })
      })
    })
  }
  async begin(client: Socket, request: FastifyRequest) {
    const user = request.user,
      query = request.query as Doc,
      config = this.store.config
    if (this.closing || !config.origins.includes(request.headers.origin)) {
      client.ws.close(1008)
      return
    }
    const experience = query.experience ?? 'combat'
    if (!['practice', 'combat'].includes(experience)) {
      client.ws.close(1008)
      return
    }
    let training: Doc | undefined, free: Doc | undefined, remediation: Doc | undefined
    try {
      assert(!query.assignment_id, 422, '课程任务功能已移除，请直接选择场景演练。')
      if (query.drug_id !== undefined || query.doctor_id !== undefined) {
        assert(
          !query.scenario_id && !query.remediation_id,
          422,
          '已发布场景和重练不能更换绑定的药品或医生。',
        )
        free = await prepareFree(this.store, user, query.drug_id, query.doctor_id, query.focus)
      }
      if (query.remediation_id) {
        remediation = await this.store.transaction(
          user.workspace,
          (tx) => tx.require(user.workspace, 'remediation', query.remediation_id),
          false,
        )
        assert(remediation.status === 'assigned', 403, '补练已关闭。')
        const parent = await this.store.ownRecord(user, remediation.parent_record_id)
        query.scenario_id = remediation.scenario_id
        query.stage = remediation.stage
        training = await prepareTraining(this.store, user, query.scenario_id, query.stage)
        const fingerprint = trainingFingerprint(parent.training)
        assert(
          fingerprint && fingerprint === trainingFingerprint(snapshot(training)),
          409,
          '医生、场景或资料版本已变化，不能启动同条件重练。',
        )
      }
      if (query.scenario_id && !training)
        training = await prepareTraining(this.store, user, query.scenario_id, query.stage ?? 'full')
    } catch (error: any) {
      await client
        .send({
          type: 'error',
          code: free ? 'invalid_practice' : 'invalid_scenario',
          message: error.statusCode ? error.message : '演练配置无效。',
        })
        .catch(() => {})
      client.ws.close(1008)
      return
    }
    const missing = [
      ...(!config.asrKey ? ['SEEDASR_API_KEY'] : []),
      ...(!config.key ? ['DEEPSEEK_API_KEY'] : []),
      ...(experience === 'combat' && !config.voiceKey ? ['DOUBAO_API_KEY'] : []),
      ...(experience === 'practice' && !config.ttsKey ? ['DOUBAO_TTS_API_KEY'] : []),
    ]
    if (missing.length) {
      await client.send({
        type: 'error',
        code: 'not_configured',
        message: '缺少服务配置：' + missing.join('、'),
      })
      client.ws.close(1013)
      return
    }
    if (
      this.active.size >= config.maxSessions ||
      [...this.active.values()].some((s) => s.owner === user.id)
    ) {
      await client.send({
        type: 'error',
        code: 'busy',
        message: '当前账号已有演练或连接已满，请稍后重试。',
      })
      client.ws.close(1013)
      return
    }
    const record = newRecord(user, experience, 'assisted')
    record.doctor = pick(constants.doctor.DOCTOR_PROFILE, ['id', 'version', 'display_name'])
    record.analysis_status = 'not_started'
    if (training) {
      if (remediation)
        training.focus_dimensions = remediation.focus_key ? [remediation.focus_key] : []
      record.training = snapshot(training)
      record.doctor = pick(training.doctor, ['id', 'version', 'display_name'])
    }
    if (free) {
      record.free_context = free
      record.doctor = pick(free.doctor, ['id', 'version', 'display_name'])
    }
    if (remediation) record.remediation_id = remediation.id
    const controller = new AbortController()
    const promise = Promise.resolve()
      .then(() => this.run(client, request, record, training, controller.signal))
      .finally(() => this.active.delete(record.id))
    this.active.set(record.id, { controller, promise, owner: user.id })
    await promise
  }
  async run(
    client: Socket,
    request: FastifyRequest,
    record: Doc,
    training: Doc | undefined,
    shutdown: AbortSignal,
  ) {
    const user = request.user,
      config = this.store.config,
      dialogue = new Dialogue(
        client,
        this.store,
        this.models,
        this.medical,
        user,
        record,
        training,
      ),
      signal = AbortSignal.any([
        shutdown,
        AbortSignal.timeout(
          Math.min(
            config.sessionSeconds,
            training?.scenario.duration_seconds ?? config.sessionSeconds,
          ) * 1000,
        ),
      ]),
      capture = new AbortController(),
      capturing = AbortSignal.any([signal, capture.signal]),
      sockets: Socket[] = [],
      workers: Promise<unknown>[] = [],
      abort = () => {
        for (const socket of sockets) socket.close()
      }
    let status = 'interrupted',
      stopped = false,
      frames = Buffer.alloc(0),
      audioBytes = 0
    signal.addEventListener('abort', abort, { once: true })
    const asrUsage = { provider: 'seedasr', model: ASR_RESOURCE, audio_seconds: 0 }
    record.usage.push(asrUsage)
    try {
      await dialogue.checkpoint()
      record.pricing = await prices(this.store, user)
      const start = JSON.parse(
        (await client.read(capturing, config.handshakeSeconds * 1000)).toString(),
      )
      assert(
        start?.type === 'start' && ['assisted', 'independent'].includes(start.mode),
        422,
        '请先发送有效的演练启动消息。',
      )
      record.mode = start.mode
      const asr = await Socket.connect(
        config.asrUrl ?? ASR_URL,
        {
          'X-Api-Key': config.asrKey,
          'X-Api-Resource-Id': ASR_RESOURCE,
          'X-Api-Connect-Id': record.id,
          'X-Api-Request-Id': record.id,
        },
        capturing,
      )
      sockets.push(asr)
      await asr.send(asrRequest(record.id), capturing)
      let duplex: Socket | undefined
      if (record.experience === 'combat') {
        duplex = await Socket.connect(
          config.voiceUrl ?? DUPLEX_URL,
          { 'X-Api-Key': config.voiceKey },
          capturing,
        )
        sockets.push(duplex)
        record.provider = 'seeduplex+seedasr'
        await duplex.send(
          event('session.create', {
            session: {
              id: record.id,
              model: DUPLEX_MODEL,
              instructions: doctorInstructions(training, record.free_context),
              audio: {
                input: { format: { type: 'pcm', rate: 16000 } },
                output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: config.voice },
              },
            },
          }),
          capturing,
        )
        for (;;) {
          const ack = JSON.parse(
            (await duplex.read(capturing, config.handshakeSeconds * 1000)).toString(),
          )
          if (ack.type === 'error')
            throw new BridgeError('provider_error', '豆包拒绝创建会话，请核对权限和音色。')
          if (ack.type === 'session.created') {
            record.provider_session_id = ack.session?.id
            break
          }
        }
      } else {
        record.provider = 'seedasr-streaming'
        record.speech_provider = 'doubao-tts-2.0'
        record.question = opening(training, record.free_context)
      }
      record.status = 'active'
      await client.send({
        type: 'ready',
        session_id: record.id,
        input_rate: 16000,
        output_rate: 24000,
        doctor: record.doctor,
        training: record.training ?? null,
        free_context: record.free_context ?? null,
        mode: record.mode,
      })
      await dialogue.open()
      if (duplex)
        await duplex.send(
          event('speech_text_buffer.commit', {
            speech_id: uuid(),
            text: training
              ? '你好，这是训练模拟。' + opening(training)
              : record.free_context
                ? opening(undefined, record.free_context)
                : constants.doctor.GREETING,
          }),
          capturing,
        )
      const recognition = (async () => {
        for (;;) {
          const { data, final } = parseAsr(await asr.read(capturing, config.sessionSeconds * 1000))
          const result = data.result ?? {}
          assert(
            result &&
              typeof result === 'object' &&
              typeof (result.text ?? '') === 'string' &&
              (result.text ?? '').length <= 100000,
            502,
            '无效 ASR 结果。',
          )
          await dialogue.observe(result, final)
          if (data.audio_info && typeof data.audio_info === 'object')
            record.audio_info = data.audio_info
          if (final) return 'completed'
        }
      })()
      recognition.catch(() => {})
      workers.push(recognition)
      const provider = duplex
        ? (async () => {
            for (;;) {
              const data = JSON.parse(
                  (await duplex!.read(capturing, config.sessionSeconds * 1000)).toString(),
                ),
                kind = data.type
              if (kind === 'error')
                throw new BridgeError(
                  'provider_error',
                  '豆包语音服务返回错误，请核对额度、权限或状态。',
                )
              if (kind === 'session.closed') return 'completed'
              if (kind === 'conversation.item.input_audio_transcription.started')
                await client.send({ type: 'user_started' })
              else if (['response.output_text.delta', 'response.output_text.done'].includes(kind)) {
                const id = data.response_id
                assert(typeof id === 'string' && id, 502, '语音事件缺少话轮标识。')
                const final = kind.endsWith('.done'),
                  previous = record.messages.find((m: Doc) => m.id === id)
                let text = final
                  ? data.transcript || data.text || previous?.text || ''
                  : (data.delta ?? '')
                assert(typeof text === 'string' && text.length <= 100000, 502, '无效语音转录。')
                if (text) {
                  if (previous) {
                    previous.text = final ? text : previous.text + text
                    previous.final = final
                  } else record.messages.push({ id, role: 'doctor', text, final })
                  if (final) await dialogue.checkpoint()
                  await client.send({ type: 'transcript', id, role: 'doctor', text, final })
                }
              } else if (kind === 'response.output_audio.delta') {
                const pcm = decode64(data.delta ?? '')
                assert(pcm.length % 2 === 0, 502, '回复音频必须是 PCM int16。')
                await client.send({
                  type: 'audio',
                  audio: data.delta,
                  response_id: data.response_id,
                })
              } else if (kind === 'response.output_audio.started')
                await client.send({ type: 'response_started', response_id: data.response_id })
              else if (kind === 'response.canceled')
                await client.send({ type: 'interrupted', response_id: data.response_id })
              else if (kind === 'conversation.item.input_audio_transcription.failed')
                await client.send({ type: 'notice', message: '本轮语音未识别成功，请重说。' })
              else if (kind === 'response.done') {
                const usage = data.usage ?? data.response?.usage
                if (usage && typeof usage === 'object')
                  record.usage.push({ ...usage, provider: 'doubao-duplex', model: DUPLEX_MODEL })
              }
            }
          })()
        : undefined
      provider?.catch(() => {})
      if (provider) workers.push(provider)
      const input = (async () => {
        let muted = false,
          audioBudget = 100,
          controlBudget = 20,
          lastAudio = Date.now(),
          lastControl = Date.now()
        for (;;) {
          const data = parseClient(await client.read(capturing, config.sessionSeconds * 1000))
          if (config.auth && !this.auth.session(request)) {
            client.ws.close(1008)
            throw new Error('Session expired')
          }
          const time = Date.now()
          if (data.type === 'audio') {
            audioBudget = Math.min(100, audioBudget + (time - lastAudio) / 20) - 1
            lastAudio = time
            if (audioBudget < 0)
              throw new BridgeError('audio_rate', '音频发送过快，请使用实时麦克风输入。')
            dialogue.speech.observe(data.pcm, data.playing, muted)
            frames = Buffer.concat([frames, muted ? Buffer.alloc(640) : data.pcm])
            if (frames.length >= 6400) {
              await asr.send(asrPacket(frames, true), capturing)
              audioBytes += frames.length
              asrUsage.audio_seconds = audioBytes / 32000
              frames = Buffer.alloc(0)
            }
            if (duplex && !muted)
              await duplex.send({ type: 'input_audio_buffer.append', audio: data.audio }, capturing)
          } else {
            controlBudget = Math.min(20, controlBudget + (time - lastControl) / 200) - 1
            lastControl = time
            if (controlBudget < 0) throw new BridgeError('control_rate', '操作过于频繁。')
            if (data.type === 'mute') {
              muted = data.muted
              if (duplex)
                await duplex.send(
                  event(muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit'),
                  capturing,
                )
              await client.send({ type: 'muted', muted })
            } else if (data.type === 'interrupt') {
              assert(duplex, 422, '练习模式不支持打断医生。')
              if (record.interaction_events.length < 1000)
                record.interaction_events.push({
                  type: 'manual_interrupt',
                  audio_ms: dialogue.speech.frames.length * 20,
                })
              await duplex.send(event('response.cancel'), capturing)
            } else if (data.type === 'retry') {
              assert(!duplex, 422, '实战模式仅在结束后整理分析。')
              dialogue.retry()
            } else if (data.type === 'retry_speech') {
              assert(!duplex, 422, '实战模式仅在结束后整理分析。')
              await dialogue.retrySpeech()
            } else if (data.type === 'stop') {
              stopped = true
              await dialogue.close()
              if (duplex) await duplex.send(event('session.close'), capturing)
              await asr.send(asrPacket(frames, true, true), capturing)
              audioBytes += frames.length
              asrUsage.audio_seconds = audioBytes / 32000
              frames = Buffer.alloc(0)
              return 'completed'
            }
          }
        }
      })()
      input.catch(() => {})
      workers.push(input)
      await Promise.race(workers)
      if (stopped) {
        const drained = await Promise.race([
          Promise.all([recognition, ...(provider ? [provider] : [])]),
          delay(3000).then(() => ['interrupted']),
        ])
        status = drained.every((value) => value === 'completed') ? 'completed' : 'interrupted'
      }
    } catch (error: any) {
      status =
        shutdown.aborted || client.ws.readyState > 1
          ? 'interrupted'
          : signal.aborted
            ? 'timeout'
            : 'error'
      await client
        .send({
          type: 'error',
          code:
            error instanceof BridgeError
              ? error.code
              : signal.aborted
                ? 'timeout'
                : error.statusCode
                  ? 'invalid_message'
                  : 'upstream_unavailable',
          message:
            error instanceof BridgeError
              ? error.message
              : signal.aborted
                ? '演练已达时限或服务正在停止。'
                : '语音连接或协议异常，已识别文字会继续保存。',
        })
        .catch(() => {})
    } finally {
      this.finalizing.add(record.id)
      capture.abort()
      abort()
      signal.removeEventListener('abort', abort)
      await Promise.allSettled(workers)
      await dialogue.close()
      record.capture_status = status
      try {
        await dialogue.checks.finish()
        if (
          !shutdown.aborted &&
          (training || record.free_context || record.experience === 'combat')
        ) {
          const coach = await dialogue.review(shutdown)
          if (coach) await client.send({ type: 'coaching', coach }).catch(() => {})
        } else if (shutdown.aborted) record.analysis_status = 'interrupted'
      } catch {
        record.analysis_status = shutdown.aborted ? 'interrupted' : 'error'
        await client
          .send({ type: 'notice', message: '复盘暂未完整完成，原话仍会保留。' })
          .catch(() => {})
      }
      try {
        const checks = await dialogue.checks.snapshot()
        let raw: Doc = {}
        if (
          !shutdown.aborted &&
          this.models.config.key &&
          record.messages.some((m: Doc) => m.role === 'trainee' && m.final)
        ) {
          try {
            const reply = await this.models.json(
              constants.summary.PROMPT +
                (record.free_context
                  ? '\n本次自由练习不评分，所有score只能为null。free_context不是医学证据。'
                  : ''),
              {
                transcript: record.messages.slice(-80).map((m: Doc) => ({
                  id: m.id,
                  speaker: m.role,
                  text: m.text.slice(0, 4000),
                  final: m.final,
                })),
                medical_checks: checks.slice(-30),
                ...(record.free_context ? { free_context: record.free_context } : {}),
              },
              { tokens: 3500, signal: shutdown },
            )
            record.usage.push({ ...reply.usage, purpose: 'visit_summary' })
            const current = structuredClone(checks)
            await this.medical.invalidate(user, current)
            assert(
              checks.every(
                (row, index) =>
                  !['supported', 'contradicted'].includes(row.status) ||
                  current[index].status === row.status,
              ),
              409,
              '审核依据已变更。',
            )
            raw = reply.data
          } catch {}
        }
        record.summary_card = validateSummary(
          raw,
          record,
          this.models.config.model,
          await dialogue.checks.snapshot(),
        )
        await client.send({ type: 'summary_card', card: record.summary_card }).catch(() => {})
      } catch {}
      let saved = false,
        recovery = false,
        finalized = false
      try {
        await this.store.saveRecord(record, status)
        saved = true
        await this.finishRemediation(user, record)
        finalized = true
      } catch {
        record.status = status
        record.ended_at ??= new Date().toISOString()
        try {
          await privateWrite(
            join(config.records, 'recovery', record.id + '.json'),
            JSON.stringify(record),
          )
          recovery = true
        } catch {}
        this.pendingRecovery.add(record.id)
      }
      if (finalized || recovery)
        await unlink(join(config.records, 'checkpoints', record.id + '.json')).catch(() => {})
      await client
        .send({
          type: 'ended',
          session_id: record.id,
          status,
          saved,
          recovery_saved: recovery,
          analysis_status: record.analysis_status,
        })
        .catch(() => {})
      client.close()
      this.finalizing.delete(record.id)
    }
  }
  async finishRemediation(u: User, record: Doc) {
    if (record.remediation_id && activity(record).valid)
      await this.store.transaction(u.workspace, async (tx) => {
        const item = await tx.require(u.workspace, 'remediation', record.remediation_id)
        assert(
          record.workspace === u.workspace && item.owner_id === record.owner_id && record.owner_id === u.id,
          404,
          '重练记录不属于当前账号。',
        )
        if (item.status !== 'assigned') return
        await tx.update(
          u.workspace,
          'remediation',
          item.id,
          { ...item, status: 'completed', completed_record_id: record.id },
          item.version,
        )
      })
  }
  async checkServices(): Promise<Doc> {
    const config = this.store.config,
      probe = async (required: boolean, work: (signal: AbortSignal) => Promise<unknown>) => {
        if (!required) return { ok: false, message: '缺少服务配置，请补齐后重启后端。' }
        try {
          await work(AbortSignal.timeout(20000))
          return { ok: true, message: '' }
        } catch {
          return { ok: false, message: '未收到有效服务结果，请检查网络、服务权限和额度。' }
        }
      }
    const [asr, tts, analysis, duplex] = await Promise.all([
      probe(!!config.asrKey, async (signal) => {
        const socket = await Socket.connect(
          config.asrUrl ?? ASR_URL,
          {
            'X-Api-Key': config.asrKey,
            'X-Api-Resource-Id': ASR_RESOURCE,
            'X-Api-Connect-Id': uuid(),
          },
          signal,
        )
        try {
          const audio = await readFile(new URL('../resources/service-check.pcm', import.meta.url))
          await socket.send(asrRequest(uuid()), signal)
          for (let i = 0; i < audio.length; i += 6400) {
            await socket.send(
              asrPacket(audio.subarray(i, i + 6400), true, i + 6400 >= audio.length),
              signal,
            )
            if (i + 6400 < audio.length) await delay(200, undefined, { signal })
          }
          for (;;) {
            const { data, final } = parseAsr(await socket.read(signal))
            if (final) {
              assert(data.result?.text?.trim(), 502, 'No speech')
              return
            }
          }
        } finally {
          socket.close()
        }
      }),
      probe(!!config.ttsKey && !!config.ttsVoice, (signal) =>
        synthesize(config, '你好', uuid(), async () => {}, '请用中文普通话朗读。', signal),
      ),
      probe(!!config.key && !!config.model, async (signal) => {
        const reply = await this.models.json(
          '服务检测。请只输出 JSON：{"status":"ok"}',
          {},
          { signal, tokens: 32, timeout: 15 },
        )
        assert(JSON.stringify(reply.data) === '{"status":"ok"}', 502, 'Invalid model result')
      }),
      probe(!!config.voiceKey, async (signal) => {
        const socket = await Socket.connect(
            config.voiceUrl ?? DUPLEX_URL,
            { 'X-Api-Key': config.voiceKey },
            signal,
          ),
          controller = new AbortController()
        let sending: Promise<void> | undefined
        try {
          await socket.send(
            event('session.create', {
              session: {
                id: uuid(),
                model: DUPLEX_MODEL,
                instructions: '你是服务检测助手。听到问候后只回复一句：你好。',
                audio: {
                  input: { format: { type: 'pcm', rate: 16000 } },
                  output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: config.voice },
                },
              },
            }),
            signal,
          )
          for (;;) {
            const data = JSON.parse((await socket.read(signal)).toString())
            if (data.type === 'error') throw new Error('Provider error')
            if (data.type === 'session.created') break
          }
          const audio = await readFile(new URL('../resources/service-check.pcm', import.meta.url)),
            combined = AbortSignal.any([signal, controller.signal])
          sending = (async () => {
            let offset = 0
            for (;;) {
              combined.throwIfAborted()
              const pcm = Buffer.alloc(640)
              audio.copy(pcm, 0, offset, offset + 640)
              offset += 640
              await socket.send(
                { type: 'input_audio_buffer.append', audio: pcm.toString('base64') },
                combined,
              )
              await delay(20, undefined, { signal: combined })
            }
          })()
          sending.catch(() => {})
          let bytes = 0
          for (;;) {
            const data = JSON.parse((await socket.read(signal)).toString())
            if (data.type === 'error') throw new Error('Provider error')
            if (data.type === 'response.output_audio.delta') {
              const pcm = decode64(data.delta)
              assert(pcm.length && pcm.length % 2 === 0, 502, 'Invalid audio')
              bytes += pcm.length
            }
            if (data.type === 'response.done') {
              assert(bytes > 0, 502, 'No duplex audio')
              return
            }
          }
        } finally {
          controller.abort()
          await sending?.catch(() => {})
          socket.close()
        }
      }),
    ])
    const combined = (pairs: [string, Doc][]) => {
      const errors = pairs
        .filter(([, r]) => !r.ok)
        .map(([name, r]) => name + '：' + r.message.replace(/。$/, ''))
      return { ok: !errors.length, message: errors.join('；') + (errors.length ? '。' : '') }
    }
    return {
      services: {
        asr: { ...asr, model: 'SeedASR · bigmodel' },
        tts: { ...tts, model: 'seed-tts-2.0' },
        analysis: { ...analysis, model: config.model || '未设置模型' },
        practice: {
          ...combined([
            ['语音识别', asr],
            ['医生朗读', tts],
            ['AI分析', analysis],
          ]),
          model: config.model || '未设置模型',
        },
        combat: {
          ...combined([
            ['实战语音', duplex],
            ['语音识别', asr],
            ['AI分析', analysis],
          ]),
          model: 'Seeduplex · ' + DUPLEX_MODEL,
        },
      },
    }
  }
}
