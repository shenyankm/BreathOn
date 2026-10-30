export const serviceChecks = [
  { key: 'asr', label: '语音识别' },
  { key: 'practice', label: '练习对话' },
  { key: 'tts', label: '医生朗读' },
  { key: 'combat', label: '实战对话' },
  { key: 'analysis', label: 'AI 分析' },
] as const

export type ServiceStatus = Record<typeof serviceChecks[number]['key'], { ok: boolean; message: string; model: string }>
const STORAGE_KEY = 'medvisit.service-status'

function parseServiceStatus(data: unknown): ServiceStatus {
  if (typeof data !== 'object' || data === null) throw new Error('服务检测返回格式无效。')
  const services = (data as { services?: unknown }).services
  if (typeof services !== 'object' || services === null) throw new Error('服务检测返回不完整。')
  const statuses = services as Record<string, unknown>
  if (serviceChecks.some(({ key }) => {
    const item = statuses[key]
    if (typeof item !== 'object' || item === null) return true
    const result = item as Record<string, unknown>
    return typeof result.ok !== 'boolean' || typeof result.message !== 'string' || typeof result.model !== 'string' || !result.model.trim()
  })) {
    throw new Error('服务检测返回不完整。')
  }
  return statuses as ServiceStatus
}

export function loadServiceStatus(): ServiceStatus | null {
  try {
    const cached = localStorage.getItem(STORAGE_KEY)
    return cached ? parseServiceStatus(JSON.parse(cached)) : null
  } catch {
    return null
  }
}

export function saveServiceStatus(services: ServiceStatus) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ services }))
  } catch {
    // Storage may be disabled or full; the current page can still display the result.
  }
}

export async function readServiceStatus(signal: AbortSignal): Promise<ServiceStatus> {
  const response = await fetch('/api/services/check', {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  })
  if (!response.ok) throw new Error('服务状态检查失败。')
  return parseServiceStatus(await response.json())
}
