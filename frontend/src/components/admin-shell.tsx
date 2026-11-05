import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select'
import { adminHref,adminSections,type AdminSection } from '@/lib/admin-navigation'
import type { ReactNode,Ref } from 'react'

export const adminWidth = 'mx-auto w-full max-w-[1440px] px-4 sm:px-6'
export function AdminHeader({ children }: { children: ReactNode }) {
  return <header ><div className={`${adminWidth} flex min-h-16 flex-wrap items-center justify-between gap-3 py-3`}>{children}</div></header>
}
export function AdminShell({ section, username, onLogout, mainRef, children }: {
  section: AdminSection; username?: string; onLogout?: () => void; mainRef?: Ref<HTMLElement>; children: ReactNode
}) {
  return <div className="min-h-svh">
    <a href="#admin-main" onClick={event => { event.preventDefault(); document.getElementById('admin-main')?.focus() }} className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3">跳到主要内容</a>
    <AdminHeader><a href={adminHref('overview')} className="inline-flex min-h-11 items-center"><Brand /><span className="ml-3 pl-3 text-sm text-muted-foreground">管理后台</span></a><div className="flex items-center gap-4">{username && <span className="max-w-40 truncate text-sm text-muted-foreground">{username}</span>}{onLogout && <Button variant="outline" onClick={onLogout}>退出登录</Button>}</div></AdminHeader>
    <div className={`${adminWidth} grid gap-6 py-4 sm:py-6 lg:grid-cols-[190px_minmax(0,1fr)]`}><aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
      <div className="lg:hidden"><Label htmlFor="admin-section" className="mb-2 block">管理内容</Label><Select value={section} onValueChange={value => { window.location.hash = adminHref(value as AdminSection) }}><SelectTrigger id="admin-section" className="w-full min-h-11"><SelectValue /></SelectTrigger><SelectContent>{adminSections.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
      <nav aria-label="后台导航" className="hidden flex-col gap-1 lg:flex">{adminSections.map(item => <Button asChild key={item.id} variant={section === item.id ? 'secondary' : 'ghost'} className="justify-start min-h-11"><a href={adminHref(item.id)} aria-current={section === item.id ? 'page' : undefined}>{item.label}</a></Button>)}</nav></aside>
      <main ref={mainRef} tabIndex={-1} id="admin-main" className="min-w-0 p-4 outline-none sm:p-6">{children}</main>
    </div>
  </div>
}
