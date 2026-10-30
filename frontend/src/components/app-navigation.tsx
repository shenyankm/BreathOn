import { useState } from 'react'
import { AudioLines, BookOpen, ClipboardList, LogOut, Menu, Play, Settings, SlidersHorizontal } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'

export function AppNavigation({ page, inSession, onLogout, logoutDisabled = inSession }: { page: string; inSession: boolean; onLogout?: () => void; logoutDisabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const main = [
    { page: 'home', label: '开始演练', icon: Play, href: inSession ? '#start' : '#home' },
    { page: 'records', label: '复盘记录', icon: ClipboardList, href: '#records' },
    { page: 'library', label: '学习资料', icon: BookOpen, href: '#library' },
  ]
  const tools = [
    { page: 'workspace', label: '训练管理', icon: SlidersHorizontal, href: '#workspace' },
    { page: 'settings', label: '服务设置', icon: Settings, href: '#settings' },
  ]
  const active = page === 'start' ? 'home' : page
  const links = (items: typeof main) => items.map(item => <Button asChild key={item.page} variant={active === item.page ? 'secondary' : 'ghost'} className="h-11 w-full justify-start gap-3 px-3 font-normal"><a href={item.href} aria-current={active === item.page ? 'page' : undefined} onClick={() => setOpen(false)}><item.icon className="size-4" />{item.label}{item.page === 'home' && inSession && <span className="ml-auto text-xs">进行中</span>}</a></Button>)
  const content = <>
    <a href="#home" className="flex h-16 items-center gap-2.5 px-3 font-semibold" onClick={() => setOpen(false)}><AudioLines className="size-6" />医访练</a>
    <nav aria-label="主导航" className="space-y-1 pt-5">{links(main)}</nav>
    <nav aria-label="训练工具" className="mt-auto space-y-1 border-t pt-4">{links(tools)}{onLogout && <Button variant="ghost" className="h-11 w-full justify-start gap-3 px-3 font-normal" disabled={logoutDisabled} title={logoutDisabled ? '请先结束演练并确认保存' : undefined} onClick={onLogout}><LogOut className="size-4" />退出登录</Button>}</nav>
  </>
  return <>
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r bg-background px-3 pb-5 lg:flex">{content}</aside>
    <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between border-b bg-background px-4 lg:hidden"><a href="#home" className="flex items-center gap-2 font-semibold"><AudioLines className="size-5" />医访练</a><Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="ghost" className="h-11 px-3"><Menu />菜单</Button></DialogTrigger><DialogContent style={{maxHeight:'100svh'}} className="inset-y-0 left-0 flex h-svh w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col rounded-none p-4 sm:rounded-none"><DialogHeader className="sr-only"><DialogTitle>医访练导航</DialogTitle><DialogDescription>选择演练、复盘记录、学习资料或训练管理。</DialogDescription></DialogHeader>{content}</DialogContent></Dialog></header>
  </>
}
