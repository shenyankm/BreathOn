import { ArrowLeft, AudioLines, BookOpen, ClipboardList, Menu, Package, Play, UserRound } from 'lucide-react'
import { Button } from './ui/button'
import { Brand } from './brand'
import { Avatar, AvatarFallback } from './ui/avatar'

export function AppHome({ inSession, username }: { inSession: boolean; username?: string }) {
  const main = [
    { label: '资料空间', icon: BookOpen, href: '#library' },
    { label: '公司产品', icon: Package, href: '#products' },
    { label: '开始练习', icon: Play, href: inSession ? '#start' : '#practice' },
  ]
  return <div className="flex min-h-[calc(100svh-7rem)] flex-col">
    <h1 className="sr-only">BreathOn 主页面</h1>
    <nav aria-label="主页面导航" className="space-y-3 pt-6">
      {main.map(item => <Button asChild key={item.href} variant="ghost" className="h-16 w-full justify-start gap-5 rounded-2xl px-5 text-lg font-normal"><a href={item.href}><item.icon aria-hidden="true" className="size-6" />{item.label}</a></Button>)}
    </nav>
    <nav aria-label="练习历史" className="mt-8 min-h-0 flex-1 border-t pt-6"><Button asChild variant="ghost" className="h-16 w-full justify-start gap-5 rounded-2xl px-5 text-lg font-normal"><a href="#records"><ClipboardList aria-hidden="true" className="size-6" />练习记录</a></Button></nav>
    <div className="flex justify-end pt-6"><Button asChild variant="ghost" className="size-16 rounded-full p-1" aria-label="进入我的"><a href="#me"><Avatar className="size-14"><AvatarFallback>{username?.slice(0, 1) || <UserRound aria-hidden="true" className="size-6" />}</AvatarFallback></Avatar></a></Button></div>
  </div>
}

export function AppNavigation({ page, inSession }: { page: string; inSession: boolean }) {
  const title = ({ practice: '开始练习', start: '拜访练习', library: '资料空间', products: '公司产品', me: '我的', records: '练习记录', visits: '拜访记录' } as Record<string, string>)[page] ?? '开始练习'
  return <header className="fixed inset-x-0 top-0 z-40 bg-background pt-[env(safe-area-inset-top)]">
    <div className="mx-auto flex h-16 max-w-[960px] items-center gap-3 px-4 sm:px-6">
      {page === 'home' ? <Brand /> : <><Button asChild variant="ghost" className="size-12 shrink-0 rounded-full" aria-label={page === 'me' ? '返回主页面' : '打开主页面'}><a href="#home">{page === 'me' ? <ArrowLeft aria-hidden="true" /> : <Menu aria-hidden="true" className="size-6" />}</a></Button><span className="min-w-0 flex-1 truncate text-base font-medium">{title}</span></>}
      {inSession && page !== 'start' && <Button asChild variant="ghost" className="ml-auto size-12 rounded-full" aria-label="返回演练"><a href="#start"><AudioLines aria-hidden="true" /></a></Button>}
    </div>
  </header>
}
