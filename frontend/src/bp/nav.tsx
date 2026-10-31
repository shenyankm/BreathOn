import { memo } from 'react'
import { House, BookOpen, AudioLines, UserRound } from 'lucide-react'
import { useBp } from './data'
import type { Route } from './route'
import { tabOf } from './route'

const tabs = [
  { id: 'home', label: '首页', icon: House, href: '#home' },
  { id: 'training', label: '训练', icon: BookOpen, href: '#training' },
  { id: 'coach', label: '教练', icon: AudioLines, href: '#coach' },
  { id: 'me', label: '我的', icon: UserRound, href: '#me' },
] as const

export const BpNav = memo(function BpNav({ route, sessionActive }: { route: Route; sessionActive: boolean }) {
  const { toast } = useBp()
  if (route.page === 'start') return null
  const selected = tabOf(route)
  return <>
    <div className={`bp-toast ${toast ? 'show' : ''}`} role="status" aria-live="polite">{toast}</div>
    <nav aria-label="主导航" className="bp-bottom">
      {tabs.map(tab => <a key={tab.id} className={`bp-nav ${selected === tab.id ? 'active' : ''}`} aria-current={selected === tab.id ? 'page' : undefined}
        href={tab.id === 'coach' && sessionActive ? '#start' : tab.href}><span className="ico" aria-hidden="true"><tab.icon size={22} strokeWidth={1.8} /></span>{tab.label}</a>)}
    </nav>
  </>
})
