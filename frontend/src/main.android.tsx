import { lazy,StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from './components/auth-gate'
import './styles/index.css'

const App = lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode><AuthGate AppComponent={App} target="android" /></StrictMode>,
)
