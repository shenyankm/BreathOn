import { AdminShell } from '@/components/admin-shell'
import { Item,ItemContent,ItemDescription } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { adminRoute } from '@/lib/admin-navigation'
import { AdminPage } from '@/pages/admin-page'
import { lazy,Suspense,useEffect,useRef,useState } from 'react'

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
  return <AdminShell hash={hash} username={username} onLogout={onLogout} mainRef={main}>
    <Suspense fallback={<Item role="status"><Spinner aria-hidden="true" /><ItemContent><ItemDescription>{"正在加载管理内容…"}</ItemDescription></ItemContent></Item>}>
      {route.page === 'workspace' ? <PlatformPage /> : route.page === 'settings' ? <ServiceSettings /> :
        <AdminPage key={route.section} section={route.section} onSettings={() => { window.location.hash = 'settings' }} onWorkspace={tab => { window.location.hash = `workspace?tab=${encodeURIComponent(tab)}` }} />}
    </Suspense>
  </AdminShell>
}
