import { lazy,StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './components/auth-gate.tsx'
import './styles/index.css'

const AdminApp = lazy(() => import('./admin-app').then(module => ({ default: module.AdminApp })))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate AppComponent={AdminApp} />
  </StrictMode>,
)
