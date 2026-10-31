import { memo } from 'react'
import { GraduationCap, House, Sparkles, Stethoscope, UserRound } from 'lucide-react'
import { Button } from './ui/button'

export const AppNavigation = memo(function AppNavigation({ page, inSession }: { page: string; inSession: boolean }) {
  if (page === 'start') return null
  const selected = ['library', 'products', 'training', 'scenarios'].includes(page) ? 'training' : ['me', 'records', 'visits'].includes(page) ? 'me' : page === 'practice' ? 'coach' : page
  const tabs = [
    { id: 'home', label: '首页', icon: House, href: '#home' },
    { id: 'doctors', label: '医生', icon: Stethoscope, href: '#doctors' },
    { id: 'training', label: '训练', icon: GraduationCap, href: '#training' },
    { id: 'coach', label: '教练', icon: Sparkles, href: inSession ? '#start' : '#practice' },
    { id: 'me', label: '我的', icon: UserRound, href: '#me' },
  ]
  return <nav aria-label="主导航" className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)]">
    <div className="mx-auto grid min-h-18 max-w-[960px] grid-cols-5 gap-1 px-2 py-2">
      {tabs.map(tab => <Button asChild key={tab.id} variant="ghost" className="h-auto min-h-14 min-w-0 flex-col gap-1 rounded-2xl px-1 py-2">
        <a href={tab.href} aria-label={tab.label} aria-current={selected === tab.id ? 'page' : undefined} className={selected === tab.id ? 'bg-accent text-primary' : 'text-muted-foreground'}>
          <tab.icon aria-hidden="true" className="size-5" /><span className="text-xs">{tab.label}</span>
        </a>
      </Button>)}
    </div>
  </nav>
})
