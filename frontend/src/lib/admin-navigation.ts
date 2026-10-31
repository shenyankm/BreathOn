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
