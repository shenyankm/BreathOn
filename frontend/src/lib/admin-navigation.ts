export const adminSections = [
  { id: 'overview', label: '总览' }, { id: 'drug', label: '药品' },
  { id: 'doctor', label: '医生 IP' }, { id: 'audiences', label: '用户画像' },
  { id: 'policy', label: '政策' }, { id: 'training', label: '训练内容' },
  { id: 'review', label: '审核队列' }, { id: 'records', label: '代表记录' },
  { id: 'settings', label: '系统设置' },
] as const
export type AdminSection = typeof adminSections[number]['id']
export function adminRoute(hash: string): { page: 'admin' | 'workspace' | 'settings'; section: AdminSection } {
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query)
  if (path === '#settings') return { page: 'settings', section: 'settings' }
  if (path === '#workspace') {
    const tab = params.get('tab')
    return { page: 'workspace', section: tab === 'doctor' || tab === 'research' ? 'doctor' : tab === 'pricing' ? 'settings' : 'training' }
  }
  const section = params.get('section')
  return { page: 'admin', section: adminSections.find(item => item.id === section)?.id ?? 'overview' }
}
export const adminHref = (section: AdminSection) => `#admin?section=${section}`

export const adminGroups = [
  { id: 'overview', label: '总览', items: [{ label: '总览', href: adminHref('overview') }] },
  { id: 'library', label: '资料库', items: [
    { label: '药品', href: adminHref('drug') }, { label: '医生', href: adminHref('doctor') },
    { label: '训练资料', href: '#workspace?tab=content' }, { label: '政策', href: adminHref('policy') },
    { label: '资料检索', href: '#workspace?tab=research' },
  ] },
  { id: 'training', label: '训练管理', items: [
    { label: '课程', href: adminHref('training') }, { label: '训练场景', href: '#workspace?tab=scenario' },
    { label: '评分标准', href: '#workspace?tab=rubric' }, { label: '经验案例', href: '#workspace?tab=cases' },
    { label: '用户画像', href: adminHref('audiences') },
  ] },
  { id: 'review', label: '审核与记录', items: [
    { label: '审核队列', href: adminHref('review') }, { label: '演练记录', href: adminHref('records') },
  ] },
  { id: 'settings', label: '设置', items: [
    { label: '系统设置', href: adminHref('settings') }, { label: '服务状态', href: '#settings' },
    { label: '用量计价', href: '#workspace?tab=pricing' },
  ] },
]

export function adminNavigation(hash: string) {
  const route = adminRoute(hash)
  const requested = new URLSearchParams(hash.split('?')[1]).get('tab')
  const tab = ['scenario','doctor','content','rubric','cases','pricing','research'].includes(requested ?? '') ? requested! : 'scenario'
  const href = route.page === 'settings' ? '#settings' : route.page === 'workspace'
    ? tab === 'doctor' ? adminHref('doctor') : `#workspace?tab=${tab}`
    : adminHref(route.section)
  const group = adminGroups.find(group => group.items.some(item => item.href === href)) ?? adminGroups[0]
  const item = group.items.find(item => item.href === href) ?? group.items[0]
  return { group, item }
}
