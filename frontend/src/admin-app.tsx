import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AdminPage } from '@/pages/admin-page'
import { AdminShell } from '@/components/admin-shell'
import { LoadingBlock } from '@/components/loading-block'
import { adminRoute } from '@/lib/admin-navigation'

const PlatformPage = lazy(() => import('@/pages/platform-page').then(module => ({ default: module.PlatformPage })))
const ServiceSettings = lazy(() => import('@/pages/service-settings').then(module => ({ default: module.ServiceSettings })))

export function AdminApp({ onLogout, username }: { onLogout?: () => void; username?: string }) {
  const [hash, setHash] = useState(() => window.location.hash)
  const main = useRef<HTMLElement>(null)
  const route = adminRoute(hash)
  useEffect(() => {
    function navigate() { setHash(window.location.hash); main.current?.focus(); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  return <AdminShell section={route.section} username={username} onLogout={onLogout} mainRef={main}>
    <Suspense fallback={<LoadingBlock label="正在加载管理内容…" />}>
      {route.page === 'workspace' ? <PlatformPage /> : route.page === 'settings' ? <ServiceSettings /> :
        <AdminPage key={route.section} section={route.section} onSettings={() => { window.location.hash = 'settings' }} onWorkspace={tab => { window.location.hash = `workspace?tab=${encodeURIComponent(tab)}` }} />}
    </Suspense>
  </AdminShell>
}
