export type SummaryItem = { id: string; name?: string; title?: string; display_name?: string; status: string; updated_at?: string }
export const overviewSources = [
  { key: 'drug', label: '药品', path: '/catalog/drug', href: '#admin?section=drug' },
  { key: 'doctor', label: '医生 IP', path: '/catalog/doctor', href: '#admin?section=doctor' },
  { key: 'lesson', label: '学习课程', path: '/catalog/lesson', href: '#admin?section=training' },
  { key: 'health', label: '健康观察', path: '/admin/health/observations', href: '#admin?section=review' },
  { key: 'scenario', label: '训练场景', path: '/catalog/scenario', href: '#workspace?tab=scenario' },
  { key: 'policy', label: '政策', path: '/catalog/policy', href: '#admin?section=policy' },
  { key: 'policy_rule', label: '政策规则', path: '/catalog/policy_rule', href: '#admin?section=policy' },
  { key: 'content', label: '训练资料', path: '/catalog/content', href: '#workspace?tab=content' },
  { key: 'visits', label: '拜访经验', path: '/visits', href: '#admin?section=review' },
] as const
export function pendingReview(kind: string, status: string) {
  return ['content', 'policy', 'visits', 'health'].includes(kind) ? status === 'submitted' : ['doctor', 'drug', 'policy_rule', 'scenario', 'lesson'].includes(kind) && status === 'draft'
}
export function overviewSummary(groups: Record<string, SummaryItem[]>) {
  const complete = overviewSources.every(source => groups[source.key] !== undefined)
  const pending = complete ? overviewSources.reduce((sum, source) => sum + groups[source.key].filter(item => pendingReview(source.key, item.status)).length, 0) : null
  const recent = overviewSources.filter(source => source.key !== 'visits' && source.key !== 'health').flatMap(source => (groups[source.key] ?? [])
    .filter(item => item.updated_at && Number.isFinite(Date.parse(item.updated_at)))
    .map(item => ({ ...item, kind: source.key, label: source.label, href: source.href })))
    .sort((a, b) => Date.parse(b.updated_at!) - Date.parse(a.updated_at!)).slice(0, 6)
  return { pending, recent }
}
