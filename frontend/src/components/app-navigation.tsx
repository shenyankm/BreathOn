import { AudioLines, BookOpen, Play, UserRound } from 'lucide-react'
import { Button } from './ui/button'
import { Brand } from './brand'

export function AppNavigation({ page, inSession }: { page: string; inSession: boolean }) {
  const main = [
    { page: 'home', label: '练习', icon: Play, href: inSession ? '#start' : '#home' },
    { page: 'library', label: '学习', icon: BookOpen, href: '#library' },
    { page: 'me', label: '我的', icon: UserRound, href: '#me' },
  ]
  const active = page === 'start' ? 'home' : ['visits', 'records'].includes(page) ? 'me' : page
  const currentTitle = main.find(item => item.page === active)?.label ?? '练习'

  return <>
    <header className="fixed inset-x-0 top-0 z-40 border-b bg-background pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 max-w-[960px] items-center justify-between gap-4 px-4 sm:px-6">
        <a href={inSession ? '#start' : '#home'} aria-label="BreathOn 练习首页" className="flex min-h-11 items-center gap-2.5 font-semibold tracking-tight"><Brand /><span className="ml-3 hidden border-l pl-5 text-sm font-normal tracking-normal text-muted-foreground sm:block">{currentTitle}</span></a>
        <div className="flex items-center gap-2">
          {inSession && <Button asChild variant="secondary" size="sm" className="h-11"><a href="#start"><AudioLines aria-hidden="true" />返回演练</a></Button>}
        </div>
      </div>
    </header>
    <nav aria-label="底部标签栏" className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto grid h-16 max-w-2xl grid-cols-3 gap-1 px-2">
        {main.map(item => <Button asChild key={item.page} variant="ghost" className="h-full min-w-0 flex-col gap-1 rounded-none px-1 text-xs font-normal text-muted-foreground aria-[current=page]:text-foreground"><a href={item.href} aria-current={active === item.page ? 'page' : undefined}><span className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors ${active === item.page ? 'bg-secondary text-foreground' : ''}`}><item.icon aria-hidden="true" className="size-5" strokeWidth={active === item.page ? 2 : 1.7} /></span><span className={active === item.page ? 'font-semibold' : ''}>{item.label}</span></a></Button>)}
      </div>
    </nav>
  </>
}
