import type { FastifyInstance } from 'fastify'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, readdir, unlink, stat, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { type Doc, type User, assert, sha, canonical, now, uuid, Semaphore, unique } from './core.ts'
import { Store, Transaction, privateWrite } from './store.ts'
import { Tasks } from './tasks.ts'
import { usable, publicURL } from './validation.ts'
import { confined } from './archive.ts'
import { route } from './http.ts'

const execute = promisify(execFile),
  maxAudio = 100_000_000
const media: Doc = {
  'audio/mpeg': ['mp3'],
  'audio/mp4': ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
  'audio/x-m4a': ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/webm': ['matroska', 'webm'],
}
export const redact = (text: string) =>
  text.replace(
    /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[0-9Xx](?!\w)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
    '[已隐藏]',
  )
const privateText = (item: Doc) => item.source === 'recording' || item.private_audio
export function retentionExpired(item: Doc): boolean {
  if (!privateText(item)) return false
  const start = Date.parse(item.audio_uploaded_at ?? item.created_at)
  if (!Number.isFinite(start)) return false
  return (
    Date.now() >=
    Math.min(
      start + 30 * 86400000,
      item.confirmed_at ? Date.parse(item.confirmed_at) + 7 * 86400000 : Infinity,
    )
  )
}
export class Visits {
  readonly folder: string
  private slots = new Semaphore(1)
  private leased = new Set<string>()
  private closing = false
  constructor(
    readonly store: Store,
    readonly tasks: Tasks,
    readonly fetcher: typeof fetch = fetch,
  ) {
    this.folder = join(dirname(store.config.records), 'visit-audio')
  }
  async get(tx: Transaction, u: User, id: string): Promise<Doc> {
    const item = await tx.get(u.workspace, 'visit', id)
    assert(item && (u.role === 'admin' || item.owner_id === u.id), 404, '拜访记录不存在。')
    return item
  }
  async readPrivate(item: Doc): Promise<Doc> {
    if (!item.transcript_file) return {}
    assert(/^[a-f0-9]{32}\.transcript$/.test(item.transcript_file), 409, '录音转写文件不可读取。')
    try {
      const data = JSON.parse(
        await readFile(await confined(this.folder, item.transcript_file), 'utf8'),
      )
      assert(
        data && typeof data === 'object' && !Array.isArray(data),
        409,
        '录音转写文件不可读取。',
      )
      return data
    } catch {
      assert(false, 409, '录音转写文件不可读取。')
    }
  }
  async public(item: Doc): Promise<Doc> {
    const result = { ...item }
    for (const key of ['audio_path', 'provider_token_hash', 'transcript_file']) delete result[key]
    if (privateText(item)) {
      if (!retentionExpired(item)) Object.assign(result, await this.readPrivate(item))
      result.text ??= ''
      result.segments ??= []
    }
    return result
  }
  async writePrivate(data: Doc) {
    const name = uuid().replaceAll('-', '') + '.transcript'
    this.leased.add(name)
    await privateWrite(join(this.folder, name), JSON.stringify(data))
    return name
  }
  async discard(name: string, tenant = this.store.workspace) {
    if (!/^[a-f0-9]{32}(?:\.transcript)?$/.test(name)) return
    try {
      // Wait out an uncertain commit on this workspace before deciding a file is unreferenced.
      await this.store.transaction(tenant, async (tx) => {
        const references = await tx.all('visit')
        if (!references.some(({ item }) => [item.audio_path, item.transcript_file].includes(name)))
          await unlink(join(this.folder, name)).catch((error: any) => {
            if (error.code !== 'ENOENT') throw error
          })
      })
    } catch {
      console.error('visit_file_cleanup_failed')
    } finally {
      this.leased.delete(name)
    }
  }

  async cleanup() {
    const rows = await this.store.transaction('', (tx) => tx.all('visit'), false)
    for (const { tenant, item: captured } of rows)
      if (
        retentionExpired(captured) &&
        (captured.audio_status !== 'deleted' || captured.audio_path || captured.transcript_file)
      )
        await this.store.transaction(tenant, async (tx) => {
          const old = await tx.require(tenant, 'visit', captured.id)
          if (!retentionExpired(old)) return
          for (const name of [old.audio_path, old.transcript_file])
            if (/^[a-f0-9]{32}(?:\.transcript)?$/.test(name ?? ''))
              await unlink(join(this.folder, name)).catch((error: any) => {
                if (error.code !== 'ENOENT') throw error
              })
          const data = { ...old }
          for (const key of ['text', 'transcription_text', 'segments']) delete data[key]
          await tx.update(
            tenant,
            'visit',
            old.id,
            {
              ...data,
              audio_path: '',
              audio_status: 'deleted',
              transcript_file: '',
              provider_token_hash: '',
              provider_token_expires: null,
            },
            old.version,
          )
          await tx.audit(
            { id: 'system', workspace: tenant, team: '', role: 'admin', authenticated: false },
            'visit.audio_delete',
            'visit',
            old.id,
          )
        })
    const current = await this.store.transaction('', (tx) => tx.all('visit'), false),
      referenced = new Set(current.flatMap(({ item }) => [item.audio_path, item.transcript_file]))
    let files: string[] = []
    try {
      files = await readdir(this.folder)
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
    for (const name of files)
      if (
        !this.leased.has(name) &&
        !referenced.has(name) &&
        /^[a-f0-9]{32}(?:\.transcript|_[a-f0-9]{32}\.provider\.ogg)?$/.test(name)
      ) {
        const file = await stat(join(this.folder, name))
        if (file.mtimeMs < Date.now() - 3600000)
          await unlink(join(this.folder, name)).catch((error: any) => {
            if (error.code !== 'ENOENT') throw error
          })
      }
  }
  async recover() {
    await mkdir(this.folder, { recursive: true, mode: 0o700 })
    const rows = await this.store.transaction('', (tx) => tx.all('visit'), false)
    for (const { tenant, item } of rows) {
      const u: User = {
        id: item.owner_id,
        workspace: tenant,
        team: '',
        role: 'admin',
        authenticated: false,
      }
      if (
        privateText(item) &&
        ['text', 'transcription_text', 'segments'].some((key) => key in item)
      ) {
        let replacement = ''
        try {
          await this.store.transaction(tenant, async (tx) => {
            const old = await tx.require(tenant, 'visit', item.id),
              existing = await this.readPrivate(old),
              raw = {
                ...Object.fromEntries(
                  ['text', 'transcription_text', 'segments']
                    .filter((key) => key in old)
                    .map((key) => [key, old[key]]),
                ),
                ...existing,
              },
              clean = { ...old }
            for (const key of ['text', 'transcription_text', 'segments']) delete clean[key]
            replacement = await this.writePrivate(raw)
            await tx.update(
              tenant,
              'visit',
              old.id,
              { ...clean, transcript_file: replacement },
              old.version,
            )
          })
        } finally {
          await this.discard(replacement, u.workspace)
        }
      }
      if (item.audio_status === 'queued')
        await this.store.transaction(tenant, async (tx) => {
          const current = await tx.require(tenant, 'visit', item.id)
          await tx.update(
            tenant,
            'visit',
            item.id,
            {
              ...current,
              audio_status: 'transcription_interrupted',
              provider_token_hash: '',
              provider_token_expires: null,
            },
            current.version,
          )
        })
      else if (item.audio_status === 'transcribing')
        this.launch(u, item.id, item.transcription_job_id)
    }
  }
  async transcribe(
    u: User,
    id: string,
    jobId: string,
    token: string | undefined,
    signal: AbortSignal,
  ) {
    await this.slots.run(async () => {
      const read = () =>
        this.store.transaction(u.workspace, (tx) => tx.get(u.workspace, 'visit', id), false)
      const storage = async <T>(work: () => Promise<T>): Promise<T> => {
        for (;;) {
          signal.throwIfAborted()
          try {
            return await work()
          } catch (error: any) {
            if (
              error.statusCode ||
              !(
                /^08|^57P|^SQLITE_BUSY|^ECONN|^ETIMEDOUT/.test(error.code ?? '') ||
                /timeout|connection/i.test(error.message ?? '')
              )
            )
              throw error
            await delay(15000, undefined, { signal })
          }
        }
      }
      let item = await storage(read)
      signal.throwIfAborted()
      if (
        !item ||
        !['queued', 'transcribing'].includes(item.audio_status) ||
        item.transcription_job_id !== jobId
      )
        return
      const headers = {
        'X-Api-Key': this.store.config.asrKey,
        'X-Api-Resource-Id': 'volc.seedasr.auc',
        'X-Api-Request-Id': jobId,
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
      }
      if (token) {
        item = await storage(() =>
          this.store.transaction(u.workspace, async (tx) => {
            const old = await tx.require(u.workspace, 'visit', id)
            if (
              !['queued', 'transcribing'].includes(old.audio_status) ||
              old.transcription_job_id !== jobId
            )
              return null
            return tx.update(
              u.workspace,
              'visit',
              id,
              {
                ...old,
                audio_status: 'transcribing',
                provider_token_expires: new Date(Date.now() + 14400000).toISOString(),
              },
              old.version,
            )
          }),
        )
        if (!item) return
        const origin = this.store.config.origins.find((s: string) => s.startsWith('https://'))
        try {
          await this.fetcher('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              user: { uid: jobId },
              audio: {
                url: `${origin}/api/visits/${id}/provider-audio?token=${token}`,
                format: (
                  {
                    'audio/webm': 'ogg',
                    'audio/mpeg': 'mp3',
                    'audio/mp4': 'm4a',
                    'audio/x-m4a': 'm4a',
                    'audio/wav': 'wav',
                    'audio/x-wav': 'wav',
                  } as Doc
                )[item.audio_type],
                ...(item.audio_type === 'audio/webm' ? { codec: 'opus' } : {}),
              },
              request: {
                model_name: 'bigmodel',
                enable_speaker_info: true,
                show_utterances: true,
                ssd_version: '200',
                ssd_mode: item.audio_duration > 180 ? 1 : 0,
              },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            redirect: 'error',
          })
        } catch {
          signal.throwIfAborted()
        }
      }
      // A submit timeout may already have incurred a charge; only query this exact job ID.
      for (let attempt = 0; attempt < 720; attempt++) {
        signal.throwIfAborted()
        item = await storage(read)
        if (!item || item.audio_status !== 'transcribing' || item.transcription_job_id !== jobId)
          return
        try {
          const response = await this.fetcher(
              'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query',
              {
                method: 'POST',
                headers,
                body: '{}',
                signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                redirect: 'error',
              },
            ),
            code = response.headers.get('X-Api-Status-Code')
          if (['20000001', '20000002'].includes(code ?? '')) {
            await delay(15000, undefined, { signal })
            continue
          }
          if (code && code !== '20000000') {
            await storage(() => this.finish(u, id, jobId, 'transcription_failed'))
            return
          }
          const data = code === '20000000' ? ((await response.json()) as Doc) : null,
            result = data?.result,
            text = result?.text
          assert(
            typeof text === 'string' &&
              text.trim() &&
              text.length <= 30000 &&
              Array.isArray(result.utterances),
            502,
            '转写结果无效。',
          )
          const segments = result.utterances
            .slice(0, 1000)
            .filter((p: Doc) => p && typeof p.text === 'string')
            .map((p: Doc) => ({
              text: p.text.slice(0, 4000),
              start_time: p.start_time ?? null,
              end_time: p.end_time ?? null,
              speaker_id: String(p.additions?.speaker ?? 'unknown').slice(0, 100),
            }))
          let replacement = '',
            oldFile = ''
          try {
            await storage(() =>
              this.store.transaction(u.workspace, async (tx) => {
                const old = await tx.require(u.workspace, 'visit', id)
                if (old.audio_status !== 'transcribing' || old.transcription_job_id !== jobId)
                  return
                const raw = await this.readPrivate(old)
                oldFile = old.transcript_file
                replacement = await this.writePrivate({
                  text: raw.text || text,
                  transcription_text: text,
                  segments,
                })
                await tx.update(
                  u.workspace,
                  'visit',
                  id,
                  {
                    ...old,
                    audio_status: 'transcribed',
                    transcript_file: replacement,
                    provider_token_hash: '',
                    provider_token_expires: null,
                  },
                  old.version,
                )
              }),
            )
          } finally {
            await this.discard(replacement, u.workspace)
          }
          if (oldFile) await this.discard(oldFile, u.workspace)
          return
        } catch {
          signal.throwIfAborted()
          await delay(15000, undefined, { signal })
        }
      }
      await storage(() => this.finish(u, id, jobId, 'transcription_interrupted'))
    })
  }
  finish(u: User, id: string, jobId: string, status: string) {
    return this.store.transaction(u.workspace, async (tx) => {
      const item = await tx.get(u.workspace, 'visit', id)
      if (item && item.audio_status === 'transcribing' && item.transcription_job_id === jobId)
        await tx.update(
          u.workspace,
          'visit',
          id,
          { ...item, audio_status: status, provider_token_hash: '', provider_token_expires: null },
          item.version,
        )
    })
  }
  launch(u: User, id: string, jobId: string, token?: string) {
    this.tasks.start(jobId, u, (signal) => this.transcribe(u, id, jobId, token, signal))
  }
  async close() {
    this.closing = true
  }
  register(app: FastifyInstance) {
    route(app, 'GET', '/api/visits', undefined, (u) =>
      this.store.transaction(u.workspace, async (tx) => {
        const items = (await tx.list(u.workspace, 'visit')).filter(
          (row) => u.role === 'admin' || row.owner_id === u.id,
        )
        if (u.role === 'admin') await tx.audit(u, 'visit.list', 'visit', '*')
        return Promise.all(items.map((row) => this.public(row)))
      }),
    )
    route(
      app,
      'POST',
      '/api/visits',
      'visits.api.CreateVisit',
      async (u, _p, b) => {
        let replacement = ''
        try {
          return await this.store.transaction(u.workspace, async (tx) => {
            const data = { ...b }
            delete data.request_id
            const requestHash = sha(canonical(data)), id = b.request_id ?? uuid()
            const existing = await tx.get(u.workspace, 'visit', id)
            if (existing) {
              assert(existing.owner_id === u.id && existing.submission_hash === requestHash, 409, '此提交已保存，请打开已有草稿继续编辑。')
              return this.public(existing)
            }
            if (privateText(b)) {
              const text = data.text
              delete data.text
              if (text) replacement = await this.writePrivate({ text, segments: [] })
            }
            const item = await tx.create(u.workspace, 'visit', {
              ...data,
              transcript_file: replacement,
              owner_id: u.id,
              status: 'draft',
              redacted_text: '',
              speakers: [],
              audio_status: 'none',
              audio_path: '',
              audio_uploaded_at: null,
              confirmed_at: null,
              review: null,
              submission_hash: requestHash,
            }, id)
            await tx.audit(u, 'visit.create', 'visit', item.id)
            return this.public(item)
          })
        } finally {
          await this.discard(replacement, u.workspace)
        }
      },
      201,
    )
    route(app, 'GET', '/api/visits/{item_id}', undefined, (u, p) =>
      this.store.transaction(u.workspace, async (tx) => {
        const item = await this.get(tx, u, p.item_id)
        if (u.role === 'admin') await tx.audit(u, 'visit.read', 'visit', item.id)
        const response = await this.public(item)
        return { ...response, redaction_suggestion: redact(response.text ?? '') }
      }),
    )
    route(app, 'PUT', '/api/visits/{item_id}', 'visits.api.EditVisit', async (u, p, b) => {
      let replacement = '',
        oldFile = ''
      try {
        const response = await this.store.transaction(u.workspace, async (tx) => {
          const item = await this.get(tx, u, p.item_id)
          assert(item.owner_id === u.id, 403, '仅记录本人可修改原文。')
          const { version, ...data } = b
          if (privateText(item)) {
            assert(
              item.audio_status !== 'deleted' || !data.text,
              409,
              '原始转写已到期删除，请编辑脱敏内容。',
            )
            const raw = await this.readPrivate(item)
            oldFile = item.transcript_file
            if (data.text || Object.keys(raw).length)
              replacement = await this.writePrivate({ ...raw, text: data.text })
            delete data.text
            data.transcript_file = replacement
          }
          const updated = await tx.update(
            u.workspace,
            'visit',
            item.id,
            { ...item, ...data, status: 'draft', review: null },
            version,
          )
          await tx.audit(u, 'visit.edit', 'visit', item.id)
          return this.public(updated)
        })
        await this.discard(oldFile, u.workspace)
        return response
      } finally {
        await this.discard(replacement, u.workspace)
      }
    })
    route(app, 'POST', '/api/visits/{item_id}/confirm', 'visits.api.ConfirmVisit', (u, p, b) =>
      this.store.transaction(u.workspace, async (tx) => {
        assert(b.redacted_text.trim(), 422, '请填写确认后的脱敏文字。')
        const item = await this.get(tx, u, p.item_id)
        assert(item.owner_id === u.id, 403, '仅记录本人可确认转写。')
        const updated = await tx.update(
          u.workspace,
          'visit',
          item.id,
          {
            ...item,
            redacted_text: b.redacted_text,
            speakers: b.speakers,
            confirmed_at: item.confirmed_at ?? now(),
            status: 'submitted',
            review: null,
          },
          b.version,
        )
        await tx.audit(u, 'visit.confirm', 'visit', item.id)
        return this.public(updated)
      }),
    )
    route(app, 'POST', '/api/visits/{item_id}/review', 'visits.api.ReviewVisit', (u, p, b) =>
      this.store.transaction(u.workspace, async (tx) => {
        assert(u.role === 'admin', 403, '只有管理员可以审核。')
        const item = await this.get(tx, u, p.item_id)
        assert(item.status === 'submitted' && item.redacted_text, 409, '请先确认脱敏内容。')
        let caseId = null,
          doctorId = null
        if (b.decision === 'fact') {
          const doctor = await tx.require(u.workspace, 'doctor', item.doctor_id),
            content = await tx.require(u.workspace, 'content', b.content_id)
          assert(
            doctor.status === 'published' && !doctor.doctor_id,
            409,
            '请选择一位已发布的医生。',
          )
          assert(b.identity_confirmed, 422, '请确认公开资料与此医生身份一致。')
          assert(
            usable(content) && publicURL(content.source_url),
            422,
            '请选用已审核且有效的公开来源资料。',
          )
          const page = content.pages.find((p: Doc) => p.number === b.page),
            quote = b.quote.trim()
          assert(
            page && quote && quote.includes(doctor.name) && page.text.includes(quote),
            422,
            '引文须逐字来自所选页并包含医生姓名。',
          )
          const facts = ((doctor.public_facts ?? '').trimEnd() + '\n' + quote).trim(),
            sources = unique([...(doctor.sources ?? []), content.source_url])
          assert(facts.length <= 3000 && sources.length <= 8, 422, '画像事实或来源超出上限。')
          const data = { ...doctor }
          for (const key of [
            'id',
            'version',
            'created_at',
            'updated_at',
            'approved_by',
            'approved_at',
            'review_reason',
          ])
            delete data[key]
          const draft = await tx.create(u.workspace, 'doctor', {
            ...data,
            status: 'draft',
            created_by: u.id,
            previous_id: doctor.id,
            series_id: doctor.series_id ?? doctor.id,
            doctor_id: doctor.id,
            base_version: doctor.version,
            background_type: 'public',
            public_facts: facts,
            sources,
            fact_evidence: [
              ...(doctor.fact_evidence ?? []),
              {
                content_id: content.id,
                content_version: content.version,
                page: b.page,
                quote,
                source_url: content.source_url,
                identity_status: '待再次核对',
                reviewed_by: u.id,
              },
            ],
          })
          doctorId = draft.id
          await tx.audit(u, 'doctor.fact_draft', 'doctor', draft.id, {
            visit_id: item.id,
            content_id: content.id,
          })
        }
        if (b.decision === 'scenario') {
          const created = await tx.create(u.workspace, 'case', {
            title: '真实拜访沟通情境',
            situation: item.redacted_text.slice(0, 2000),
            approach: '根据该情境练习需求探询和专业沟通。',
            rationale: b.reason,
            limitations: '代表自述或转写仅用于模拟沟通，不作为医学事实或真人性格依据。',
            status: 'confirmed',
            created_by: u.id,
            confirmed_by: u.id,
            origin_visit_id: item.id,
            origin_verified: false,
            quotes: [],
            documents: [],
            citations: [],
          })
          caseId = created.id
        }
        const updated = await tx.update(
          u.workspace,
          'visit',
          item.id,
          {
            ...item,
            status: 'reviewed',
            review: {
              decision: b.decision,
              reason: b.reason,
              actor: u.id,
              time: now(),
              case_id: caseId,
              doctor_draft_id: doctorId,
            },
          },
          b.version,
        )
        await tx.audit(u, 'visit.review', 'visit', item.id, { decision: b.decision })
        return this.public(updated)
      }),
    )
    route(
      app,
      'POST',
      '/api/visits/{item_id}/audio',
      undefined,
      async (u, p, _b, _q, _reply, request) => {
        assert(
          request.headers['x-recording-authorized'] === 'true',
          422,
          '请先确认录音处理、管理员访问和第三方语音服务。',
        )
        const type = String(request.headers['content-type']).split(';')[0].toLowerCase()
        assert(media[type], 415, '请上传 MP3、M4A 或 WAV 音频。')
        const raw = request.body as Buffer
        assert(
          Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= maxAudio,
          422,
          '录音为空或超过100MB。',
        )
        const name = uuid().replaceAll('-', ''),
          path = join(this.folder, name)
        this.leased.add(name)
        try {
          await this.store.transaction(u.workspace, async (tx) => {
            const item = await this.get(tx, u, p.item_id)
            assert(item.owner_id === u.id, 403, '仅记录本人可上传录音。')
            assert(
              privateText(item) && item.audio_status === 'none' && !retentionExpired(item),
              409,
              '请新建未上传录音且在保留期限内的语音草稿。',
            )
            await privateWrite(path, raw)
          })
          let probe: Doc
          try {
            const result = await execute(
              'ffprobe',
              [
                '-v',
                'error',
                '-protocol_whitelist',
                'file,pipe',
                '-show_entries',
                'format=format_name,duration:stream=codec_type',
                '-of',
                'json',
                path,
              ],
              {
                timeout: 20000,
                maxBuffer: 1000000,
                env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
              },
            )
            probe = JSON.parse(result.stdout)
          } catch (error: any) {
            assert(
              false,
              error.code === 'ENOENT' ? 503 : 422,
              error.code === 'ENOENT' ? '音频校验服务未配置。' : '音频格式无效。',
            )
          }
          const duration = Number(probe.format?.duration)
          assert(
            Number.isFinite(duration) &&
              duration > 0 &&
              duration <= 1800 &&
              probe.format.format_name
                .split(',')
                .some((name: string) => media[type].includes(name)) &&
              probe.streams.some((s: Doc) => s.codec_type === 'audio'),
            422,
            '音频格式无效或时长超过30分钟。',
          )
          return await this.store.transaction(u.workspace, async (tx) => {
            const item = await this.get(tx, u, p.item_id)
            assert(
              item.audio_status === 'none' && !retentionExpired(item),
              409,
              '该记录已上传录音或超过保留期限。',
            )
            const updated = await tx.update(
              u.workspace,
              'visit',
              item.id,
              {
                ...item,
                audio_path: name,
                audio_type: type,
                audio_duration: duration,
                audio_uploaded_at: now(),
                audio_status: 'transcription_unavailable',
                recording_authorized: true,
              },
              item.version,
            )
            await tx.audit(u, 'visit.audio_upload', 'visit', item.id)
            return this.public(updated)
          })
        } finally {
          await this.discard(name, u.workspace)
        }
      },
      202,
    )
    route(app, 'GET', '/api/visits/{item_id}/audio', undefined, async (u, p, _b, _q, reply) =>
      this.store.transaction(u.workspace, async (tx) => {
        const item = await this.get(tx, u, p.item_id)
        assert(
          !retentionExpired(item) && /^[a-f0-9]{32}$/.test(item.audio_path),
          404,
          '录音不存在或已删除。',
        )
        const raw = await readFile(await confined(this.folder, item.audio_path))
        await tx.audit(u, 'visit.audio_read', 'visit', item.id)
        return reply.type(item.audio_type).send(raw)
      }),
    )
    route(
      app,
      'POST',
      '/api/visits/{item_id}/transcription',
      undefined,
      async (u, p) => {
        assert(!this.closing, 503, '服务正在停止。')
        assert(
          this.store.config.asrKey &&
            this.store.config.origins.some((s: string) => s.startsWith('https://')),
          503,
          '录音转写服务尚未配置可访问的 HTTPS 地址或凭据。',
        )
        const token = randomBytes(32).toString('base64url'),
          jobId = uuid(),
          item = await this.store.transaction(u.workspace, async (tx) => {
            const old = await this.get(tx, u, p.item_id)
            assert(old.owner_id === u.id, 403, '仅记录本人可发起转写。')
            assert(
              [
                'transcription_unavailable',
                'transcription_interrupted',
                'transcription_failed',
              ].includes(old.audio_status) &&
                old.audio_path &&
                !retentionExpired(old),
              409,
              '录音不存在、已到期或转写正在进行。',
            )
            const item = await tx.update(
              u.workspace,
              'visit',
              old.id,
              {
                ...old,
                audio_status: 'queued',
                transcription_job_id: jobId,
                provider_token_hash: sha(token),
                provider_token_expires: new Date(Date.now() + 14400000).toISOString(),
              },
              old.version,
            )
            await tx.audit(u, 'visit.transcription_start', 'visit', old.id)
            return item
          })
        this.launch(u, item.id, jobId, token)
        return this.public(item)
      },
      202,
    )
    route(app, 'POST', '/api/visits/{item_id}/transcription/cancel', undefined, async (u, p) => {
      const item = await this.store.transaction(u.workspace, async (tx) => {
        const old = await this.get(tx, u, p.item_id)
        assert(old.owner_id === u.id, 403, '仅记录本人可取消转写。')
        assert(['queued', 'transcribing'].includes(old.audio_status), 409, '当前没有进行中的转写。')
        const updated = await tx.update(
          u.workspace,
          'visit',
          old.id,
          {
            ...old,
            audio_status: 'transcription_interrupted',
            provider_token_hash: '',
            provider_token_expires: null,
          },
          old.version,
        )
        await tx.audit(u, 'visit.transcription_cancel', 'visit', old.id)
        return updated
      })
      await this.tasks.cancel(item.transcription_job_id)
      return this.public(item)
    })
    route(
      app,
      'GET',
      '/api/visits/{item_id}/provider-audio',
      undefined,
      async (u, p, _b, q, reply) => {
        const authorize = () =>
            this.store.transaction(
              u.workspace,
              async (tx) => {
                const item = await tx.get(u.workspace, 'visit', p.item_id),
                  digest = Buffer.from(sha(q.token ?? ''), 'hex'),
                  stored = Buffer.from(item?.provider_token_hash ?? '', 'hex')
                assert(
                  q.token?.length <= 100 &&
                    item &&
                    stored.length === digest.length &&
                    timingSafeEqual(stored, digest) &&
                    Date.parse(item.provider_token_expires) > Date.now() &&
                    item.audio_status === 'transcribing' &&
                    !retentionExpired(item) &&
                    /^[a-f0-9]{32}$/.test(item.audio_path),
                  404,
                  '录音不存在。',
                )
                return item
              },
              false,
            ),
          item = await authorize(),
          path = await confined(this.folder, item.audio_path)
        reply.header('Referrer-Policy', 'no-referrer')
        if (item.audio_type !== 'audio/webm')
          return reply.type(item.audio_type).send(await readFile(path))
        const name = item.audio_path + '_' + uuid().replaceAll('-', '') + '.provider.ogg',
          converted = join(this.folder, name)
        this.leased.add(name)
        try {
          await privateWrite(converted, Buffer.alloc(0))
          await execute(
            'ffmpeg',
            [
              '-nostdin',
              '-v',
              'error',
              '-protocol_whitelist',
              'file,pipe',
              '-i',
              path,
              '-map',
              '0:a:0',
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-c:a',
              'libopus',
              '-b:a',
              '32k',
              '-f',
              'ogg',
              '-y',
              converted,
            ],
            {
              timeout: 120000,
              maxBuffer: 1000000,
              env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
            },
          )
          await authorize()
          const raw = await readFile(converted)
          assert(raw.length && raw.length <= maxAudio, 503, '音频转码失败。')
          return reply.type('audio/ogg').send(raw)
        } finally {
          await unlink(converted).catch(() => {})
          this.leased.delete(name)
        }
      },
    )
  }
}
