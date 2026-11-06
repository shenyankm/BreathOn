import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select,SelectContent,SelectGroup,SelectItem,SelectLabel,SelectTrigger,SelectValue } from '@/components/ui/select'
import { adminHref,adminGroups,adminNavigation } from '@/lib/admin-navigation'
import { ChevronDown,ChevronRight } from 'lucide-react'
import { useState,type ReactNode,type Ref } from 'react'

export const adminWidth = 'mx-auto w-full max-w-[1440px] px-4 sm:px-6'
export function AdminHeader({ children }: { children: ReactNode }) {
  return <header ><div className={`${adminWidth} flex min-h-14 flex-wrap items-center justify-between gap-3 py-2`}>{children}</div></header>
}
export function AdminShell({ hash, username, onLogout, mainRef, children }: {
  hash: string; username?: string; onLogout?: () => void; mainRef?: Ref<HTMLElement>; children: ReactNode
}) {
  const active = adminNavigation(hash)
  const [disclosure,setDisclosure] = useState<{href:string;group:string|null}>({href:active.item.href,group:active.group.items.length>1?active.group.id:null})
  const openGroup = disclosure.href===active.item.href?disclosure.group:active.group.items.length>1?active.group.id:null
  return <div className="min-h-svh bg-background">
    <a href="#admin-main" onClick={event => { event.preventDefault(); document.getElementById('admin-main')?.focus() }} className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3">跳到主要内容</a>
    <AdminHeader><a href={adminHref('overview')} className="inline-flex min-h-11 items-center"><Brand /></a><div className="flex items-center gap-4">{username && <span className="max-w-40 truncate text-sm text-muted-foreground">{username}</span>}{onLogout && <Button variant="outline" onClick={onLogout}>退出登录</Button>}</div></AdminHeader>
    <div className={`${adminWidth} grid gap-4 py-3 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-6 lg:py-4`}><aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
      <div className="lg:hidden"><Label htmlFor="admin-section" className="sr-only">管理内容</Label><Select value={active.item.href} onValueChange={value => { window.location.hash = value }}><SelectTrigger id="admin-section" className="w-full min-h-11"><SelectValue /></SelectTrigger><SelectContent>{adminGroups.map(group=><SelectGroup key={group.id}><SelectLabel>{group.label}</SelectLabel>{group.items.map(item=><SelectItem key={item.href} value={item.href}>{item.label}</SelectItem>)}</SelectGroup>)}</SelectContent></Select></div>
      <nav aria-label="后台导航" className="hidden flex-col gap-2 lg:flex">{adminGroups.map(group=><div key={group.id}>
        {group.items.length===1?<Button asChild variant={active.group.id===group.id?'secondary':'ghost'} className="min-h-11 w-full justify-start"><a href={group.items[0].href} aria-current={active.group.id===group.id?'page':undefined}>{group.label}</a></Button>:<Button type="button" variant={active.group.id===group.id?'secondary':'ghost'} className="min-h-11 w-full justify-between" aria-expanded={openGroup===group.id} aria-controls={`admin-group-${group.id}`} onClick={()=>setDisclosure({href:active.item.href,group:openGroup===group.id?null:group.id})}>{group.label}{openGroup===group.id?<ChevronDown aria-hidden="true"/>:<ChevronRight aria-hidden="true"/>}</Button>}
        {group.items.length>1&&<ul id={`admin-group-${group.id}`} hidden={openGroup!==group.id} className="ml-3 mt-1 space-y-1 border-l pl-2">{group.items.map(item=><li key={item.href}><Button asChild variant="ghost" className={`min-h-11 w-full justify-start ${active.item.href===item.href?'font-semibold text-foreground':'text-muted-foreground'}`}><a href={item.href} aria-current={active.item.href===item.href?'page':undefined}>{item.label}</a></Button></li>)}</ul>}
      </div>)}</nav></aside>
      <main ref={mainRef} tabIndex={-1} id="admin-main" className="min-w-0 outline-none lg:p-6 lg:min-h-[calc(100svh-6rem)]">{children}</main>
    </div>
  </div>
}
