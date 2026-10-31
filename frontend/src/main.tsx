import { lazy, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import './styles/admin.css'
import { AuthGate } from './components/auth-gate.tsx'

const AdminApp = lazy(() => import('./admin-app').then(module => ({ default: module.AdminApp })))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate AppComponent={AdminApp} />
  </StrictMode>,
)
