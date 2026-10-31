import { lazy, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import './styles/breathon.css'
import './styles/bp.css'
import { AuthGate } from './components/auth-gate'

const App = lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode><AuthGate AppComponent={App} target="android" /></StrictMode>,
)
