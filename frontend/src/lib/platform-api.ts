export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function api<T>(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 30000, ...request } = options
  const deadline = AbortSignal.timeout(timeoutMs)
  const response = await fetch(`/api${path}`, {
    ...request, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = typeof error.detail === 'string' ? error.detail : Array.isArray(error.detail)
      ? error.detail.map((item: { loc?: string[]; msg?: string }) => `${item.loc?.join('.') ?? ''} ${item.msg ?? ''}`).join('；') : '操作未完成，请重试。'
    throw new ApiError(message, response.status)
  }
  return response.json() as Promise<T>
}

