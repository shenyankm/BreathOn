export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function api<T>(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 30000, ...request } = options
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const method = (request.method ?? 'GET').toUpperCase()
  const readable = method === 'GET' || method === 'HEAD'
  const headers = new Headers(options.headers)
  if (typeof options.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetch(`/api${path}`, { credentials: 'same-origin', ...request, signal, headers })
    } catch (cause) {
      signal.throwIfAborted()
      if (!readable && cause instanceof TypeError) throw new TypeError('网络中断，尚未确认操作结果。请刷新确认后再决定是否重试。', { cause })
      if (!readable || attempt || !(cause instanceof TypeError)) throw cause
      await waitForRetry(300 + Math.random() * 200, signal)
      continue
    }
    if (readable && attempt === 0 && [408, 429, 502, 503, 504].includes(response.status)) {
      const after = response.headers.get('Retry-After')
      const delay = after === null ? 300 + Math.random() * 200
        : /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()
      // Long server cooldowns stay manual rather than tying up the page or retrying early.
      if (Number.isFinite(delay) && delay <= 2000) {
        await response.body?.cancel()
        await waitForRetry(Math.max(0, delay), signal)
        continue
      }
    }
    if (!response.ok) {
      if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('medvisit:unauthorized'))
      const error = await response.json().catch(() => null)
      signal.throwIfAborted()
      const detail = error?.detail
      const message = typeof detail === 'string' ? detail : Array.isArray(detail)
        ? detail.map((item: { loc?: unknown; msg?: unknown } | null) => `${Array.isArray(item?.loc) ? item.loc.join('.') : ''} ${typeof item?.msg === 'string' ? item.msg : ''}`.trim()).filter(Boolean).join('；') : ''
      throw new ApiError(message || '操作未完成，请重试。', response.status)
    }
    if (response.status === 204 || method === 'HEAD') return undefined as T
    try { return await response.json() as T }
    catch (cause) {
      signal.throwIfAborted()
      if (!(cause instanceof SyntaxError)) throw cause
      throw new ApiError(readable ? '服务返回的数据不完整，请重新加载。' : '服务响应无法读取，请刷新确认操作结果后再决定是否重试。', response.status)
    }
  }
}
