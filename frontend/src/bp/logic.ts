import type { DoctorRecord, Lesson, Level, ScenarioKey } from './types'

export const AREAS = ['全部', '肿瘤', '代谢', '综合慢病'] as const

/** IP roles only: the real public-background doctors have no ip_profile and stay in the library. */
export function ipDoctors(rows: DoctorRecord[]) {
  const order = ['blood', 'breast', 'endocrine', 'general', 'cardio', 'oncology', 'pediatrics']
  return rows.filter(row => row.status === 'published' && row.ip_profile)
    .sort((a, b) => order.indexOf(a.ip_profile!.ip_key) - order.indexOf(b.ip_profile!.ip_key))
}

export function filterByArea(rows: DoctorRecord[], area: string) {
  return area === '全部' ? rows : rows.filter(row => row.ip_profile?.area === area || areaGroup(row.ip_profile?.area) === area)
}

/** The prototype groups blood tumours under 肿瘤 for filtering while showing their own area tag. */
export function areaGroup(area?: string) {
  return area === '血液肿瘤' ? '肿瘤' : area
}

export function formatDate(now: Date) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index - 1)
    return { day: String(date.getDate()).padStart(2, '0'), week: index === 1 ? '今天' : days[date.getDay()], active: index === 1 }
  })
}

export function greeting(now: Date) {
  const hour = now.getHours()
  return hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
}

export function findLesson(levels: Level[], id: string): Lesson | undefined {
  for (const level of levels) {
    const lesson = level.lessons.find(lesson => lesson.id === id)
    if (lesson) return lesson
  }
}

export function lessonForIp(levels: Level[], ipKey: string) {
  const l3 = levels.find(level => level.level === 'L3')?.lessons[0]
  return ipKey && l3 ? l3 : undefined
}

export function scenarioStage(key: ScenarioKey) {
  return key === 'first' ? 'opening' : key === 'evidence' ? 'evidence' : 'closing'
}

export function levelTone(level: string) {
  return { L1: 'b1', L2: 'b2', L3: 'b3', L4: 'b4' }[level] ?? 'b1'
}

export function progressLine(level: { level: string; remaining: number; next_level: string | null; percent: number }) {
  if (!level.next_level && level.remaining === 0) return '四个等级的课程都已完成。'
  if (level.remaining === 0) return `${level.level} 已完成。`
  return level.next_level ? `再完成 ${level.remaining} 个课程，即可进入 ${level.next_level}。` : `再完成 ${level.remaining} 个课程，即可完成全部训练。`
}

export function scoreText(value: number | null, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`
}

export function deltaText(value: number | null) {
  if (value === null || value === undefined) return '暂无对比'
  return value === 0 ? '与上周持平' : `${value > 0 ? '↑' : '↓'} ${Math.abs(value)} 分 · ${value > 0 ? '高于' : '低于'}上周`
}
