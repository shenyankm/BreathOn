export type IpProfile = {
  ip_key: string; dept: string; style: string; area: string; role: string; tags: string[]
  entry: string; question: string; match: string; domain: string; modules: [string, string][]
}
export type DoctorRecord = {
  id: string; name: string; display_name: string; specialty: string; status: string
  background_type: string; hospital?: string; professional_title?: string; focus: string; ip_profile?: IpProfile | null
}
export type Lesson = {
  id: string; title: string; summary: string; tagline: string; status: string; owner: string
  sections: [string, string][]; level: string; state: 'none' | 'planned' | 'completed'
  unverified_figures?: boolean; action?: { kind: 'practice'; scenario: ScenarioKey; ip_id: string } | { kind: 'doctor_ips' }
}
export type Level = { level: string; title: string; subtitle: string; summary: string; lessons: Lesson[]; completed: number; total: number }
export type Curriculum = { levels: Level[]; plan: Lesson[] }
export type LevelStatus = { level: string; title: string; done: number; total: number; remaining: number; percent: number; next_level: string | null }
export type Home = {
  streak_days: number; practice_days: number; session_count: number; latest_score: number | null
  week_average: number | null; week_delta: number | null; mastery_percent: number; level: LevelStatus
  recent: { id: string; title: string; score: number; started_at: string }[]; tasks: Lesson[]
}
export type Settings = { training_reminder: boolean; save_dialogue: boolean; review_reminder: boolean; doctor_recommendation: boolean }
export type QueueItem = { id: string; kind: string; type: string; title: string; status: string; status_label: string; updated_at: string }
export type Queue = { pending: number; items: QueueItem[] }
export type ScenarioKey = 'first' | 'evidence' | 'next'
export const scenarios: Record<ScenarioKey, { label: string; desc: string; prompt: string }> = {
  first: { label: '首次拜访', desc: '练习开场、需求探索和疾病线匹配。', prompt: '您今天想解决我的哪个临床问题？' },
  evidence: { label: '质疑证据', desc: '练习回应主要终点、样本量、对照组和证据边界。', prompt: '这个结果的主要终点是什么？证据等级和临床可操作性如何？' },
  next: { label: '推进下一步', desc: '练习在合规前提下收束沟通并约定下一步。', prompt: '如果我想继续了解，您下一步能提供什么具体资料？' },
}
export const scenarioOrder: ScenarioKey[] = ['first', 'evidence', 'next']
