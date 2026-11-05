import { setTimeout as delay } from 'node:timers/promises'
import { type Doc, type User, uuid, assert, constants, Semaphore } from './core.ts'
import { Store, privateWrite } from './store.ts'
import { Models, generateReply } from './agents.ts'
import { Medical } from './medical.ts'
import { policyUsable } from './validation.ts'
import { workspaceSettings } from './catalog.ts'
import { checkMaterials, speechInstructions, opening } from './training.ts'
import { SpeechEvidence, Socket, synthesize } from './voice-protocol.ts'
import { join } from 'node:path'

type Pending = { controller: AbortController; promise: Promise<void> }
export async function assessPolicy(
  models: Models,
  store: Store,
  u: User,
  text: string,
  ids: string[],
  context = '',
  signal?: AbortSignal,
): Promise<Doc> {
  const load = () =>
    store.transaction(
      u.workspace,
      async (tx) => {
        const rows: Doc[] = []
        for (const rule of await tx.list(u.workspace, 'policy_rule')) {
          if (
            rule.status !== 'published' ||
            rule.runtime_enforced !== true ||
            !ids.includes(rule.policy_id)
          )
            continue
          const policy = await tx.get(u.workspace, 'policy', rule.policy_id)
          if (
            policyUsable(policy) &&
            policy!.version === rule.policy_version &&
            policy!.pages.some((p: Doc) => p.text.includes(rule.quote))
          )
            rows.push({ ...rule, policy_title: policy!.title, source_url: policy!.source_url })
          if (rows.length === 20) break
        }
        return rows
      },
      false,
    )
  const rules = await load()
  if (!text.trim() || !rules.length) return { status: 'skipped', findings: [] }
  if (!models.config.key || text.length > 4000) return { status: 'unavailable', findings: [] }
  try {
    const { data, usage } = await models.json(
        constants.compliance.PROMPT,
        {
          text,
          context: context.slice(-2000),
          rules: rules.map((rule) =>
            Object.fromEntries(
              ['id', 'name', 'article', 'quote', 'scope', 'risk', 'examples'].map((key) => [
                key,
                rule[key],
              ]),
            ),
          ),
        },
        { signal, timeout: 15, tokens: 1500 },
      ),
      seen = new Set<string>(),
      findings: Doc[] = []
    assert(Array.isArray(data.findings), 502, '无效合规判断。')
    for (const row of data.findings) {
      const rule = rules.find((rule) => rule.id === row?.rule_id)
      if (
        !rule ||
        seen.has(rule.id) ||
        row.status !== 'risk' ||
        typeof row.quote !== 'string' ||
        !row.quote.trim() ||
        !text.includes(row.quote) ||
        typeof row.reason !== 'string' ||
        !row.reason.trim() ||
        row.reason.length > 500
      )
        continue
      seen.add(rule.id)
      findings.push({
        rule_id: rule.id,
        status: 'risk',
        quote: row.quote,
        reason: row.reason,
        risk: rule.risk,
        action: rule.risk === 'high' && rule.action === 'pause' ? 'pause' : 'warn',
        article: rule.article,
        policy_quote: rule.quote,
        policy_id: rule.policy_id,
        policy_version: rule.policy_version,
        policy_title: rule.policy_title,
        source_url: rule.source_url,
      })
    }
    const current = await load()
    return {
      status:
        JSON.stringify(current.map((r) => [r.id, r.version, r.policy_version])) ===
        JSON.stringify(rules.map((r) => [r.id, r.version, r.policy_version]))
          ? 'complete'
          : 'unavailable',
      findings: JSON.stringify(current) === JSON.stringify(rules) ? findings : [],
      usage: { ...usage, purpose: 'policy_check' },
    }
  } catch {
    return { status: 'unavailable', findings: [] }
  }
}
export class LiveChecks {
  private rows = new Map<string, Doc>()
  private queue: Doc[] = []
  private worker?: Promise<void>
  private controller = new AbortController()
  private closed = false
  constructor(
    readonly medical: Medical,
    readonly u: User,
    readonly record: Doc,
    readonly send: (data: Doc) => Promise<void>,
  ) {
    record.medical_checks = []
  }
  observe(id: string, text: string, final: boolean) {
    if (this.closed) return
    const old = this.rows.get(id)
    if (old?.text === text && old.final === final) return
    const row = {
      message_id: id,
      text,
      status: 'checking',
      statements: [],
      preliminary: true,
      final,
    }
    this.rows.set(id, row)
    this.record.medical_checks = [...this.rows.values()]
    if (!final) return
    if (this.queue.length >= 32) {
      Object.assign(row, {
        status: 'unavailable',
        reason: '核验队列已满，本句尚未核实，不能视为准确。',
      })
      return
    }
    this.queue.push(row)
    if (!this.worker)
      this.worker = this.run().finally(() => {
        this.worker = undefined
      })
  }
  async run() {
    while (this.queue.length && !this.controller.signal.aborted) {
      const row = this.queue.shift()!
      if (this.rows.get(row.message_id) !== row) continue
      await this.send({ type: 'medical_check', check: row }).catch(() => {})
      try {
        const result = await this.medical.check(
            this.u,
            row.text,
            this.record.messages
              .slice(-8)
              .map((m: Doc) => m.text)
              .join('\n'),
            this.controller.signal,
          ),
          { usage, ...visible } = result
        if (usage) this.record.usage.push(usage)
        if (this.rows.get(row.message_id) === row) {
          Object.assign(row, visible)
          await this.send({ type: 'medical_check', check: row }).catch(() => {})
        }
      } catch {
        Object.assign(row, {
          status: 'unavailable',
          reason: '核验未完成，不能据此认定原话准确。',
          statements: [],
        })
      }
    }
  }
  async finish() {
    this.closed = true
    if (this.worker) {
      const timer = setTimeout(() => this.controller.abort(), 18000)
      try {
        await this.worker
      } finally {
        clearTimeout(timer)
      }
    }
    for (const row of this.rows.values())
      if (row.status === 'checking')
        Object.assign(row, {
          status: 'unavailable',
          reason: '结束时本句核验尚未完成，需进一步核实。',
          statements: [],
        })
    await this.medical.invalidate(this.u, [...this.rows.values()])
  }
  async snapshot(): Promise<Doc[]> {
    const checks = structuredClone(this.record.medical_checks)
    await this.medical.invalidate(this.u, checks)
    return checks
  }
}
export class Dialogue {
  readonly speech = new SpeechEvidence()
  readonly checks: LiveChecks
  private pending?: Pending
  private voice?: Pending
  private policies = new Map<string, Pending>()
  private responded = new Set<string>()
  private revision = 0
  private stopping = false
  private segmented = false
  private voiceFailed = false
  private lastRequest = 0
  private checkpointLock = new Semaphore(1)
  constructor(
    readonly client: Socket,
    readonly store: Store,
    readonly models: Models,
    readonly medical: Medical,
    readonly user: User,
    readonly record: Doc,
    readonly training?: Doc,
  ) {
    record.coaching = []
    record.policy_checks = []
    record.interaction_events = []
    this.checks = new LiveChecks(medical, user, record, (data) => this.send(data))
  }
  send(data: Doc) {
    return this.client.send(data)
  }
  checkpoint() {
    return this.checkpointLock.run(async () => {
      const data = Object.fromEntries(
        [
          'id',
          'mode',
          'experience',
          'started_at',
          'workspace',
          'owner_id',
          'team',
          'doctor',
          'training',
          'free_context',
        ].map((key) => [key, this.record[key] ?? null]),
      )
      Object.assign(data, {
        status: 'interrupted',
        capture_status: 'interrupted',
        ended_at: null,
        messages: this.record.messages.filter((m: Doc) => m.final),
        coaching: [],
        usage: [],
      })
      await privateWrite(
        join(this.store.config.records, 'checkpoints', this.record.id + '.json'),
        JSON.stringify(data),
      )
    })
  }
  async validate() {
    await checkMaterials(this.store, this.user, this.training, this.record.free_context)
  }
  async open() {
    if (this.record.experience === 'combat') return
    const text = opening(this.training, this.record.free_context),
      id = 'practice-opening'
    this.record.messages.push({ id, role: 'doctor', text, final: true })
    await this.checkpoint()
    await this.send({ type: 'transcript', id, role: 'doctor', text, final: true })
    this.startSpeech(text, id)
  }
  startSpeech(text: string, id: string) {
    this.voiceFailed = false
    const controller = new AbortController()
    this.voice = { controller, promise: this.speak(text, id, controller.signal).catch(() => {}) }
  }
  async speak(text: string, id: string, signal: AbortSignal) {
    const responseId = 'tts-' + uuid(),
      message = this.record.messages.find((m: Doc) => m.id === id)
    message.speech_status = 'speaking'
    try {
      await this.send({ type: 'response_started', response_id: responseId, message_id: id })
      await this.send({ type: 'tts_state', state: 'speaking' })
      const context =
          this.training ??
          (this.record.free_context ? { doctor: this.record.free_context.doctor } : undefined),
        usage = await synthesize(
          this.store.config,
          text,
          this.record.id,
          async (pcm) => {
            if (!this.stopping)
              await this.send({
                type: 'audio',
                response_id: responseId,
                audio: pcm.toString('base64'),
              })
          },
          speechInstructions(context),
          signal,
        )
      message.speech_status = 'completed'
      this.record.usage.push({ provider: 'doubao-tts', ...usage })
      await this.send({ type: 'tts_state', state: 'done' })
    } catch {
      message.speech_status = signal.aborted ? 'interrupted' : 'error'
      await this.send({ type: 'interrupted', response_id: responseId }).catch(() => {})
      if (!signal.aborted) {
        this.voiceFailed = true
        await this.send({ type: 'tts_state', state: 'error' }).catch(() => {})
        await this.send({
          type: 'notice',
          message: '医生朗读暂时失败，文字已保留。可重试朗读或继续练习；请核对语音合成权限和额度。',
        }).catch(() => {})
      }
    }
  }
  async cancelVoice() {
    const voice = this.voice
    this.voice = undefined
    voice?.controller.abort()
    await voice?.promise
  }
  async cancelPending() {
    const pending = this.pending
    this.pending = undefined
    pending?.controller.abort()
    await pending?.promise
  }
  async observe(result: Doc, final: boolean) {
    let utterances = result.utterances
    if (Array.isArray(utterances) && utterances.length) this.segmented = true
    if (utterances === undefined)
      utterances = this.segmented
        ? []
        : [{ start_time: 'fallback', text: result.text ?? '', definite: final }]
    assert(Array.isArray(utterances) && utterances.length <= 2000, 502, '无效 ASR 分句。')
    let changed = false,
      corrected = false,
      invalidated = false,
      latest: Doc | undefined
    for (let index = 0; index < utterances.length; index++) {
      const part = utterances[index],
        text = part?.text ?? ''
      assert(part && typeof text === 'string' && text.length <= 100000, 502, '无效 ASR 分句内容。')
      if (!text.trim()) continue
      const id = `${this.record.experience === 'combat' ? 'combat' : 'practice'}-u-${index}`,
        complete = part.definite === true || final,
        previous = this.record.messages.find((m: Doc) => m.id === id),
        wasFinal = previous?.final
      latest = { id, role: 'trainee', text, final: complete }
      if (previous?.text === text && previous.final === complete) continue
      if (
        previous &&
        previous.text !== text &&
        this.record.experience !== 'combat' &&
        !invalidated
      ) {
        invalidated = true
        const affected = Array.from(
          { length: utterances.length - index },
          (_, i) => `practice-u-${i + index}`,
        )
        for (const coach of this.record.coaching)
          if (affected.includes(coach.based_on)) {
            coach.superseded = true
            corrected = true
          }
        for (const key of affected) this.responded.delete(key)
      }
      if (!changed) this.revision++
      changed = true
      const stored = previous ?? { ...latest }
      if (previous) Object.assign(previous, latest)
      else this.record.messages.push(stored)
      const start = part.start_time ?? part.words?.[0]?.start_time
      stored.speech = this.speech.describe(start, part.end_time)
      if (Number.isInteger(start) && Number.isInteger(part.end_time))
        Object.assign(stored.speech, { start_ms: start, end_ms: part.end_time })
      if (complete || wasFinal) await this.checkpoint()
      await this.send({ type: 'transcript', ...latest, replace: true })
      this.scheduleChecks(id, text, complete)
    }
    if (final)
      for (const message of this.record.messages)
        if (message.role === 'trainee' && !message.final) {
          message.final = true
          if (!changed) this.revision++
          changed = true
          latest = message
          await this.checkpoint()
          await this.send({ type: 'transcript', ...message, replace: true })
          this.scheduleChecks(message.id, message.text, true)
        }
    if (changed && latest?.final && this.record.free_context) await this.validate()
    if (changed && this.record.experience !== 'combat') {
      await this.cancelVoice()
      this.voiceFailed = false
      await this.send({ type: 'user_started', coaching_invalidated: corrected })
      await this.cancelPending()
      if (
        !this.stopping &&
        latest?.final &&
        !this.responded.has(latest.id) &&
        this.record.messages.filter((m: Doc) => m.role === 'trainee').every((m: Doc) => m.final)
      )
        this.startResponse(latest.id)
      else await this.send({ type: 'practice_state', state: 'listening' })
    }
  }
  scheduleChecks(id: string, text: string, final: boolean) {
    this.checks.observe(id, text, final)
    this.policies.get(id)?.controller.abort()
    this.record.policy_checks = this.record.policy_checks.filter(
      (row: Doc) => row.message_id !== id,
    )
    if (!final || !this.training?.policies.length) return
    const controller = new AbortController(),
      promise = assessPolicy(
        this.models,
        this.store,
        this.user,
        text,
        this.training.policies.map((p: Doc) => p.id),
        this.record.messages
          .slice(-8)
          .map((m: Doc) => m.text)
          .join('\n'),
        controller.signal,
      )
        .then(async (result) => {
          if (result.usage) this.record.usage.push(result.usage)
          const message = this.record.messages.find((m: Doc) => m.id === id)
          if (controller.signal.aborted || message?.text !== text || !message.final) return
          const findings = result.findings.map((finding: Doc) => ({
            ...finding,
            message_id: id,
            text,
          }))
          this.record.policy_checks = [
            ...this.record.policy_checks.filter((row: Doc) => row.message_id !== id),
            ...findings,
          ]
          await this.send({
            type: 'policy_check',
            message_id: id,
            text,
            status: result.status,
            findings,
          })
        })
        .catch(() => {})
    this.policies.set(id, { controller, promise })
  }
  startResponse(id: string) {
    const controller = new AbortController(),
      revision = this.revision
    const pending = {
      controller,
      promise: this.respond(revision, id, controller.signal)
        .catch(() => {})
        .finally(() => {
          if (this.pending === pending) this.pending = undefined
        }),
    }
    this.pending = pending
  }
  async respond(revision: number, basedOn: string, signal: AbortSignal) {
    await delay(Math.max(400, 3000 - (Date.now() - this.lastRequest)), undefined, { signal })
    if (this.stopping) return
    await this.send({ type: 'practice_state', state: 'thinking' })
    this.lastRequest = Date.now()
    let itemId = '',
      earlyUsage: Doc | undefined
    try {
      const history = structuredClone(this.record.messages.filter((m: Doc) => m.final)),
        checks = await this.checks.snapshot(),
        reference = this.record.free_context
          ? await this.medical.reference(
              this.user,
              this.record.free_context.drug,
              history
                .slice(-4)
                .map((m: Doc) => m.text)
                .join('\n'),
            )
          : undefined
      await this.validate()
      const scoring = await this.store.transaction(
        this.user.workspace,
        async (tx) => (await workspaceSettings(tx, this.user.workspace)).training_scoring,
        false,
      )
      const validate = async (withReference: boolean) => {
        await this.validate()
        const current = structuredClone(checks)
        await this.medical.invalidate(this.user, current)
        assert(
          checks.every(
            (before, index) =>
              !['supported', 'contradicted'].includes(before.status) ||
              current[index].status === before.status,
          ),
          409,
          '医学审核依据已变更，请重新核验。',
        )
        if (withReference && reference)
          assert(
            await this.medical.validReference(this.user, reference),
            409,
            '教练参考资料已变更，请重新生成。',
          )
      }
      const { result, usage } = await generateReply(this.models, history, {
        training: this.training,
        free_context: this.record.free_context,
        medical_checks: checks,
        reference_context: reference,
        interactions: this.record.interaction_events,
        scoring,
        signal,
        onDoctor: async (text: string, usage: Doc) => {
          earlyUsage = {
            provider: 'deepseek',
            model: this.models.config.model,
            ...usage,
            incomplete: true,
          }
          this.record.usage.push(earlyUsage)
          await validate(false)
          if (revision !== this.revision || this.stopping || signal.aborted) return
          itemId = 'practice-d-' + uuid()
          this.record.messages.push({ id: itemId, role: 'doctor', text, final: true })
          await this.send({
            type: 'practice_turn',
            message: { id: itemId, role: 'doctor', text, final: true },
            coach: null,
          })
          if (revision === this.revision && !this.stopping && !signal.aborted)
            this.startSpeech(text, itemId)
          await this.checkpoint()
        },
      })
      if (earlyUsage) {
        delete earlyUsage.incomplete
        Object.assign(earlyUsage, usage)
      } else this.record.usage.push({ provider: 'deepseek', ...usage })
      await validate(true)
      signal.throwIfAborted()
      if (revision !== this.revision || this.stopping) return
      for (const message of history) if (message.role === 'trainee') this.responded.add(message.id)
      if (
        !(await this.store.transaction(
          this.user.workspace,
          async (tx) => (await workspaceSettings(tx, this.user.workspace)).training_scoring,
          false,
        ))
      )
        delete result.coach.assessment
      const coach = {
        based_on: basedOn,
        doctor_id: itemId,
        ...result.coach,
        ...(reference ? { reference_context: reference } : {}),
      }
      this.record.coaching.push(coach)
      if (this.record.mode === 'assisted') await this.send({ type: 'coaching', coach })
      await this.checkpoint()
      await this.send({ type: 'practice_state', state: 'listening' })
    } catch (error: any) {
      if (signal.aborted) return
      if (itemId) await this.cancelVoice()
      if (revision === this.revision && !this.stopping) {
        await this.send({ type: 'practice_state', state: 'error' })
        await this.send({
          type: 'notice',
          message:
            error.statusCode === 409
              ? error.message
              : 'AI分析暂未完成；已识别文字仍会保留，可重试或继续发言。',
        })
      }
    }
  }
  retry() {
    const latest = [...this.record.messages].reverse().find((m: Doc) => m.role === 'trainee')
    if (
      !this.stopping &&
      latest?.final &&
      !this.responded.has(latest.id) &&
      this.record.messages.filter((m: Doc) => m.role === 'trainee').every((m: Doc) => m.final) &&
      !this.pending
    )
      this.startResponse(latest.id)
  }
  async retrySpeech() {
    if (this.stopping || this.record.experience === 'combat' || !this.voiceFailed || this.pending)
      return
    const latest = [...this.record.messages].reverse().find((m: Doc) => m.role === 'doctor')
    if (latest) {
      await this.cancelVoice()
      this.startSpeech(latest.text, latest.id)
    }
  }
  async close() {
    this.stopping = true
    await this.cancelPending()
    await this.cancelVoice()
    for (const task of this.policies.values()) task.controller.abort()
    await Promise.allSettled([...this.policies.values()].map((task) => task.promise))
  }
  async review(signal?: AbortSignal): Promise<Doc | undefined> {
    const enabled = () =>
      this.store.transaction(
        this.user.workspace,
        async (tx) => (await workspaceSettings(tx, this.user.workspace)).training_scoring,
        false,
      )
    if (!(await enabled())) {
      this.record.analysis_status = 'disabled'
      return
    }
    const history = structuredClone(this.record.messages),
      latest = [...history].reverse().find((m: Doc) => m.role === 'trainee' && m.text.trim())
    if (!latest) {
      this.record.analysis_status = 'no_speech'
      return
    }
    this.record.analysis_status = 'thinking'
    this.record.interaction_events.push({
      type: 'capture_end',
      status: this.record.capture_status ?? 'interrupted',
    })
    await this.validate()
    const checks = await this.checks.snapshot(),
      reference = this.record.free_context
        ? await this.medical.reference(
            this.user,
            this.record.free_context.drug,
            history
              .slice(-4)
              .map((m: Doc) => m.text)
              .join('\n'),
          )
        : undefined
    const { result, usage } = await generateReply(this.models, history, {
      training: this.training,
      speak: false,
      interactions: this.record.interaction_events,
      medical_checks: checks,
      free_context: this.record.free_context,
      reference_context: reference,
      signal,
    })
    this.record.usage.push({ provider: 'deepseek', ...usage })
    await this.validate()
    const current = structuredClone(checks)
    await this.medical.invalidate(this.user, current)
    assert(
      checks.every(
        (row, index) =>
          !['supported', 'contradicted'].includes(row.status) ||
          current[index].status === row.status,
      ),
      409,
      '医学审核依据已变更，请重新核验。',
    )
    if (reference)
      assert(
        await this.medical.validReference(this.user, reference),
        409,
        '教练参考资料已变更，请重新生成。',
      )
    if (!(await enabled())) {
      this.record.analysis_status = 'disabled'
      return
    }
    const incomplete =
        this.record.capture_status !== 'completed' ||
        history.some((m: Doc) => !m.final || m.text.length > 4000) ||
        history.reduce((n: number, m: Doc) => n + m.text.length, 0) > 64000,
      coach = {
        ...result.coach,
        based_on: latest.id,
        doctor_id: '',
        final_report: !!this.training || !!this.record.free_context,
        incomplete,
        ...(reference ? { reference_context: reference } : {}),
      }
    if (incomplete && coach.assessment)
      Object.assign(coach.assessment, { total: null, status: 'partial' })
    this.record.coaching.push(coach)
    this.record.analysis_status = 'completed'
    return coach
  }
}
