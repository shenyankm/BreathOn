import WebSocket from 'ws'
import { gzipSync, gunzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { type Doc, assert, uuid } from './core.ts'

export const ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
export const TTS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
export const DUPLEX_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
export const DUPLEX_MODEL = '1.2.6.1',
  ASR_RESOURCE = 'volc.seedasr.sauc.duration',
  TTS_RESOURCE = 'seed-tts-2.0'
export const event = (type: string, fields: Doc = {}) => ({ type, event_id: uuid(), ...fields })
const u32 = (value: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function decode64(value: unknown): Buffer {
  assert(
    typeof value === 'string' &&
      value.length % 4 === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    422,
    '无效音频编码。',
  )
  return Buffer.from(value, 'base64')
}
export function parseClient(raw: Buffer | string): Doc {
  assert(Buffer.byteLength(raw) <= 4096, 422, '消息过大。')
  const data = JSON.parse(raw.toString())
  assert(data && typeof data === 'object' && !Array.isArray(data), 422, '消息必须为对象。')
  if (data.type === 'audio') {
    const pcm = decode64(data.audio)
    assert(pcm.length === 640, 422, '音频必须是20ms / 640字节PCM帧。')
    assert(data.playing === undefined || typeof data.playing === 'boolean', 422, '无效播放状态。')
    return {
      type: 'audio',
      pcm,
      audio: data.audio,
      ...(data.playing !== undefined ? { playing: data.playing } : {}),
    }
  }
  if (data.type === 'mute') {
    assert(typeof data.muted === 'boolean', 422, '无效静音状态。')
    return { type: 'mute', muted: data.muted }
  }
  assert(
    ['interrupt', 'stop', 'retry', 'retry_speech'].includes(data.type),
    422,
    '不支持的消息类型。',
  )
  return { type: data.type }
}
export function asrPacket(payload: Buffer, audio = false, final = false): Buffer {
  const body = gzipSync(payload)
  return Buffer.concat([
    Buffer.from([0x11, (audio ? 0x20 : 0x10) | (final ? 2 : 0), audio ? 1 : 0x11, 0]),
    u32(body.length),
    body,
  ])
}
export const asrRequest = (id: string) =>
  asrPacket(
    Buffer.from(
      JSON.stringify({
        user: { uid: id },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          enable_nonstream: true,
          result_type: 'full',
          show_utterances: true,
          end_window_size: 1500,
        },
      }),
    ),
  )
export function parseAsr(raw: Buffer): { data: Doc; final: boolean } {
  assert(raw.length >= 8 && raw[0] >> 4 === 1, 502, '无效 ASR 协议头。')
  let offset = (raw[0] & 15) * 4
  const kind = raw[1] >> 4,
    flags = raw[1] & 15
  assert(offset >= 4 && [9, 15].includes(kind) && flags <= 3, 502, '无效 ASR 消息类型。')
  if (kind === 15)
    throw new BridgeError('asr_provider_error', 'SeedASR 返回错误，请核对权限和额度。')
  if (flags & 1) offset += 4
  assert(raw.length >= offset + 4, 502, 'ASR 消息不完整。')
  const size = raw.readUInt32BE(offset)
  let payload = raw.subarray(offset + 4)
  assert(
    size === payload.length && raw[2] >> 4 === 1 && [0, 1].includes(raw[2] & 15),
    502,
    '无效 ASR 负载。',
  )
  if (raw[2] & 15) payload = gunzipSync(payload, { maxOutputLength: 2 ** 20 })
  assert(payload.length <= 2 ** 20, 502, 'ASR 结果过大。')
  const data = JSON.parse(payload.toString())
  assert(data && typeof data === 'object' && !Array.isArray(data), 502, 'ASR 结果须为对象。')
  if (![0, 20000000].includes(data.code ?? 20000000))
    throw new BridgeError('asr_provider_error', 'SeedASR 识别失败，请核对服务状态。')
  return { data, final: !!(flags & 2) }
}
export function ttsRequest(event: number, payload: Doc = {}, id = ''): Buffer {
  const data = Buffer.from(JSON.stringify(payload)),
    identity = Buffer.from(id)
  return Buffer.concat([
    Buffer.from('11141000', 'hex'),
    u32(event),
    ...([1, 2].includes(event) ? [] : [u32(identity.length), identity]),
    u32(data.length),
    data,
  ])
}
export function parseTts(raw: Buffer): {
  kind: number
  event: number
  id: string
  payload: Buffer
} {
  assert(
    raw.length >= 12 && raw.length <= 2 ** 20 && raw[0] === 0x11 && [0, 0x10].includes(raw[2]),
    502,
    '无效语音合成协议头。',
  )
  const kind = raw[1] >> 4,
    flags = raw[1] & 15
  if (kind === 15)
    throw new BridgeError('tts_provider_error', '豆包语音合成失败，请核对权限和额度。')
  assert([9, 11].includes(kind) && flags === 4, 502, '无效语音合成事件。')
  const event = raw.readUInt32BE(4),
    size = raw.readUInt32BE(8)
  assert(size <= 256 && raw.length >= 16 + size, 502, '无效语音合成会话。')
  const id = raw.subarray(12, 12 + size).toString(),
    length = raw.readUInt32BE(12 + size),
    payload = raw.subarray(16 + size)
  assert(payload.length === length, 502, '语音合成负载不完整。')
  if ([51, 153].includes(event))
    throw new BridgeError('tts_provider_error', '豆包语音合成失败，请核对权限和额度。')
  return { kind, event, id, payload }
}
export class Socket {
  private queue: Buffer[] = []
  private waiters: { resolve: (value: Buffer) => void; reject: (reason: Error) => void }[] = []
  private error?: Error
  constructor(
    readonly ws: WebSocket,
    readonly limit = 16,
  ) {
    ws.on('message', (raw) => {
      const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(body)
      else if (this.queue.length >= this.limit) {
        this.fail(new Error('Socket receive queue overflow'))
        ws.terminate()
      } else this.queue.push(body)
    })
    ws.on('error', (error) => this.fail(error))
    ws.on('close', () => this.fail(new Error('Socket closed')))
  }
  private fail(error: Error) {
    this.error = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
  async read(signal?: AbortSignal, timeout = 15000): Promise<Buffer> {
    signal?.throwIfAborted()
    const value = this.queue.shift()
    if (value) return value
    if (this.error) throw this.error
    return new Promise((resolve, reject) => {
      const pending = {
          resolve: (data: Buffer) => {
            cleanup()
            resolve(data)
          },
          reject: (error: Error) => {
            cleanup()
            reject(error)
          },
        },
        abort = () => pending.reject(signal?.reason ?? new Error('Aborted')),
        timer = setTimeout(() => pending.reject(new Error('Socket timeout')), timeout),
        cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          const index = this.waiters.indexOf(pending)
          if (index !== -1) this.waiters.splice(index, 1)
        }
      this.waiters.push(pending)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  async send(value: Doc | Buffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const data = Buffer.isBuffer(value) ? value : JSON.stringify(value)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket write timeout')), 5000)
      this.ws.send(data, (error) => {
        clearTimeout(timer)
        error ? reject(error) : resolve()
      })
    })
  }
  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close()
    else this.ws.terminate()
    this.fail(new Error('Socket closed'))
  }
  static async connect(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Socket> {
    signal?.throwIfAborted()
    const ws = new WebSocket(url, {
        headers,
        maxPayload: 2 ** 20,
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      }),
      socket = new Socket(ws),
      abort = () => socket.close()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
        ws.once('close', () => reject(new Error('Socket closed during handshake')))
      })
      signal?.throwIfAborted()
      return socket
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
}
export async function synthesize(
  config: Doc,
  text: string,
  section: string,
  send: (audio: Buffer) => Promise<void>,
  instruction: string,
  signal?: AbortSignal,
): Promise<Doc> {
  assert(
    typeof text === 'string' &&
      text.trim() &&
      text.length <= 1200 &&
      instruction.trim() &&
      instruction.length <= 500,
    422,
    '无效医生朗读文字或指令。',
  )
  const combined = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
    upstream = await Socket.connect(
      config.ttsUrl ?? TTS_URL,
      {
        'X-Api-Key': config.ttsKey,
        'X-Api-Resource-Id': TTS_RESOURCE,
        'X-Api-Connect-Id': uuid(),
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      combined,
    ),
    abort = () => upstream.close()
  combined.addEventListener('abort', abort, { once: true })
  const id = uuid()
  const write = (event: number, payload: Doc = {}, identity = '') =>
      upstream.send(ttsRequest(event, payload, identity), combined),
    read = async () => parseTts(await upstream.read(combined, 10000)),
    expect = async (event: number, identity?: string) => {
      const row = await read()
      assert(
        row.kind === 9 && row.event === event && (identity === undefined || row.id === identity),
        502,
        '语音合成事件顺序异常。',
      )
      return row.payload
    }
  try {
    await write(1)
    await expect(50)
    const params = {
      speaker: config.ttsVoice,
      audio_params: { format: 'pcm', sample_rate: 24000 },
      additions: JSON.stringify({ section_id: section, context_texts: [instruction] }),
    }
    await write(100, { event: 100, req_params: params }, id)
    await expect(150, id)
    await write(200, { event: 200, req_params: { ...params, text } }, id)
    await write(102, {}, id)
    let bytes = 0,
      started = 0,
      usage: Doc = {}
    for (;;) {
      const row = await read()
      assert(row.id === id, 502, '语音合成会话不匹配。')
      if (row.kind === 11 && row.event === 352) {
        assert(
          row.payload.length &&
            row.payload.length % 2 === 0 &&
            bytes + row.payload.length <= 48000 * 60,
          502,
          '无效合成音频。',
        )
        started ||= Date.now()
        for (let offset = 0; offset < row.payload.length; offset += 9600) {
          const chunk = row.payload.subarray(offset, offset + 9600)
          await delay(Math.max(0, bytes / 48 - (Date.now() - started) - 500), undefined, {
            signal: combined,
          })
          await send(chunk)
          bytes += chunk.length
        }
      } else if (row.kind === 9 && row.event === 152) {
        const data = JSON.parse(row.payload.toString())
        assert(data && typeof data === 'object' && !Array.isArray(data), 502, '无效语音结束事件。')
        usage = data.usage ?? {}
        break
      } else assert(row.kind === 9 && [350, 351, 364].includes(row.event), 502, '无效语音响应。')
    }
    assert(bytes, 502, '语音合成未返回音频。')
    await write(2)
    await expect(52)
    return {
      ...usage,
      model: TTS_RESOURCE,
      submitted_characters: text.length,
      output_audio_seconds: Math.round(bytes / 48) / 1000,
    }
  } finally {
    combined.removeEventListener('abort', abort)
    upstream.close()
  }
}
export class SpeechEvidence {
  frames: { power: number; playing?: boolean; muted: boolean }[] = []
  observe(pcm: Buffer, playing?: boolean, muted = false) {
    let power = 0
    for (let i = 0; i < 320; i++) {
      const sample = pcm.readInt16LE(i * 2)
      power += sample * sample
    }
    this.frames.push({ power: power / 320, playing, muted })
  }
  describe(start: unknown, end: unknown): Doc {
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= end ||
      end > this.frames.length * 20 + 200
    )
      return { available: false }
    const frames = this.frames.slice(Math.floor(start / 20), Math.ceil(end / 20)),
      audible = frames.filter((f) => !f.muted)
    if (!audible.length) return { available: false }
    const db = (power: number) => Math.round(100 * Math.log10(Math.max(power, 1) / 32768 ** 2)) / 10
    return {
      available: true,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      rms_dbfs: db(audible.reduce((n, f) => n + f.power, 0) / audible.length),
      peak_frame_dbfs: db(Math.max(...audible.map((f) => f.power))),
      playback_overlap_ms: frames.filter((f) => f.playing && !f.muted).length * 20,
      playback_observed: frames.some((f) => f.playing !== undefined),
      tone_audio_assessed: false,
    }
  }
}
