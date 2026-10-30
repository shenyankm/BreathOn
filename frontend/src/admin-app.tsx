import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowLeft, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AdminPage } from '@/pages/admin-page'

const PlatformPage = lazy(() => import('@/pages/platform-page').then(module => ({default:module.PlatformPage})))
const ServiceSettings = lazy(() => import('@/pages/service-settings').then(module => ({default:module.ServiceSettings})))

export function AdminApp({onLogout,username}:{onLogout?:()=>void;username?:string}) {
  const [page,setPage] = useState(()=>window.location.hash.startsWith('#workspace')?'workspace':window.location.hash==='#settings'?'settings':'admin')
  useEffect(()=>{
    function navigate(){setPage(window.location.hash.startsWith('#workspace')?'workspace':window.location.hash==='#settings'?'settings':'admin')}
    window.addEventListener('hashchange',navigate)
    return ()=>window.removeEventListener('hashchange',navigate)
  },[])
  if(page==='admin') return <AdminPage onLogout={onLogout} username={username} onSettings={()=>{window.location.hash='settings'}} onWorkspace={tab=>{window.location.hash=`workspace?tab=${encodeURIComponent(tab)}`}} />
  return <div className="min-h-svh bg-muted/30"><header className="border-b bg-background"><div className="mx-auto flex min-h-16 max-w-[1296px] items-center justify-between gap-4 px-4 sm:px-8"><Button asChild variant="ghost" className="h-11"><a href="#admin"><ArrowLeft />返回管理后台</a></Button>{onLogout&&<Button className="h-11" variant="ghost" onClick={onLogout}><LogOut />退出登录</Button>}</div></header><main className="mx-auto max-w-[1296px] px-4 py-6 sm:px-8 sm:py-8"><Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载管理内容…</p>}>{page==='workspace'?<PlatformPage />:<ServiceSettings />}</Suspense></main></div>
}
