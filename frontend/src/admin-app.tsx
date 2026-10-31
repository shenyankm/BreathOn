import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowLeft, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AdminPage } from '@/pages/admin-page'
import { AdminHeader, adminWidth } from '@/components/admin-shell'
import { LoadingBlock } from '@/components/loading-block'

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
  return <div className="min-h-svh bg-muted/30"><AdminHeader><Button asChild variant="ghost"><a href="#admin"><ArrowLeft />返回管理后台</a></Button>{onLogout&&<Button variant="ghost" onClick={onLogout}><LogOut />退出登录</Button>}</AdminHeader><main className={`${adminWidth} py-6 sm:py-8`}><Suspense fallback={<LoadingBlock label="正在加载管理内容…" />}>{page==='workspace'?<PlatformPage />:<ServiceSettings />}</Suspense></main></div>
}
