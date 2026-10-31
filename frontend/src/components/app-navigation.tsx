import { BookOpen, Play, UserRound } from 'lucide-react'
import { Button } from './ui/button'

export function AppNavigation({ page, inSession }: { page: string; inSession: boolean }) {
  const title = ({ home: '练习', practice: '练习', start: '拜访练习', library: '资料库', products: '公司产品', me: '我的', records: '练习记录', visits: '拜访记录' } as Record<string, string>)[page] ?? '练习'
  const selected = ['library', 'products'].includes(page) ? 'library' : ['me', 'records', 'visits'].includes(page) ? 'me' : 'practice'
  const tabs = [
    { id: 'practice', label: '练习', icon: Play, href: inSession ? '#start' : '#practice' },
    { id: 'library', label: '资料库', icon: BookOpen, href: '#library' },
    { id: 'me', label: '我的', icon: UserRound, href: '#me' },
  ]
  return <>
    <header className="fixed inset-x-0 top-0 z-40 bg-background pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-16 max-w-[960px] items-center px-4 sm:px-6"><span className="truncate text-base font-medium">{title}</span></div>
    </header>
    <nav aria-label="主导航" className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto grid h-20 max-w-[960px] grid-cols-3 items-center gap-3 px-4 sm:px-6">
        {tabs.map(tab => <Button asChild key={tab.id} variant="ghost" className="group h-12 w-full rounded-2xl p-0 active:bg-muted motion-reduce:transition-none">
          <a href={tab.href} aria-label={tab.label} aria-current={selected === tab.id ? 'page' : undefined}>
            <span className={`flex h-12 w-16 items-center justify-center rounded-2xl transition-[background-color,color,transform] duration-200 ease-out group-active:scale-95 motion-reduce:transition-none motion-reduce:transform-none ${selected === tab.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}><tab.icon aria-hidden="true" className="size-6" /></span>
          </a>
        </Button>)}
      </div>
    </nav>
  </>
}
