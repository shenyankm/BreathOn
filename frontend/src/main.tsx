import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import './styles/admin.css'
import { AdminApp } from './admin-app'
import { AuthGate } from './components/auth-gate.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate AppComponent={AdminApp} />
  </StrictMode>,
)
