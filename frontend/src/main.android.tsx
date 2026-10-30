import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App'
import { AuthGate } from './components/auth-gate'

createRoot(document.getElementById('root')!).render(
  <StrictMode><AuthGate AppComponent={App} target="android" /></StrictMode>,
)
