import type { ReactNode, Ref } from 'react'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { adminSections, adminHref, type AdminSection } from '@/lib/admin-navigation'

export const adminWidth = 'mx-auto w-full max-w-[1600px] px-4 sm:px-6'
export function AdminHeader({ children }: { children: ReactNode }) {
  return <header className="admin-topbar"><div className={`${adminWidth} flex min-h-[74px] flex-wrap items-center justify-between gap-3 py-3`}>{children}</div></header>
}
export function AdminShell({ section, username, onLogout, mainRef, children }: {
  section: AdminSection; username?: string; onLogout?: () => void; mainRef?: Ref<HTMLElement>; children: ReactNode
}) {
  return <div className="admin-app">
    <a href="#admin-main" onClick={event => { event.preventDefault(); document.getElementById('admin-main')?.focus() }} className="admin-skip">跳到主要内容</a>
    <AdminHeader><a href={adminHref('overview')} className="inline-flex min-h-11 items-center"><Brand /><span className="ml-3 border-l pl-3 text-sm text-muted-foreground">管理后台</span></a><div className="flex items-center gap-4">{username && <span className="max-w-40 truncate text-sm text-muted-foreground">{username}</span>}{onLogout && <Button variant="outline" onClick={onLogout}>退出登录</Button>}</div></AdminHeader>
    <div className="admin-layout"><aside className="admin-sidebar"><p className="admin-sidebar-title">管理后台</p><nav aria-label="后台导航">{adminSections.map(item => <a key={item.id} href={adminHref(item.id)} aria-current={section === item.id ? 'page' : undefined}><span className="admin-nav-dot" aria-hidden="true" />{item.label}</a>)}</nav><p className="admin-sidebar-note">灵息 BREATHON<br />内容与训练工作台</p></aside>
      <main ref={mainRef} tabIndex={-1} id="admin-main" className="admin-main">{children}</main>
    </div>
  </div>
}
