import { useEffect, useState, type FormEvent } from 'react'
import { AudioLines, Eye, EyeOff } from 'lucide-react'
import App from '../App'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/form-field'

type Session = { enabled: boolean; authenticated: boolean; expires_at: number | null }

async function readSession(response: Response): Promise<Session> {
  if (!response.ok) throw new Error()
  const data = await response.json()
  if (typeof data.enabled !== 'boolean' || typeof data.authenticated !== 'boolean' ||
      data.authenticated && (!Number.isFinite(data.expires_at) || data.expires_at * 1000 <= Date.now())) throw new Error()
  return data
}

export function AuthGate() {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/auth/session', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(readSession)
      .then(setSession)
      .catch(() => { if (!controller.signal.aborted) setError('无法连接服务，请稍后重试。') })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!session?.authenticated || !session.expires_at) return
    const expires = session.expires_at * 1000
    const expire = () => { if (Date.now() >= expires) setSession({ enabled: true, authenticated: false, expires_at: null }) }
    const timer = window.setTimeout(expire, Math.max(0, expires - Date.now()))
    window.addEventListener('focus', expire)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', expire) }
  }, [session])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        setError(response.status === 429 ? '登录尝试过多，请一分钟后重试。' : response.status === 401 ? '账号或密码不正确。' : '登录失败，请稍后重试。')
        return
      }
      const result = await readSession(response)
      if (!result.authenticated) throw new Error()
      form.reset()
      setSession(result)
    } catch { setError('无法连接服务，请稍后重试。') }
    finally { setBusy(false) }
  }

  async function logout() {
    setError('')
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error()
      setSession({ enabled: true, authenticated: false, expires_at: null })
      localStorage.removeItem('medvisit.service-status')
    } catch { setError('退出失败，请检查网络后重试。') }
  }

  if (session && (!session.enabled || session.authenticated)) return <>
    {error && <p role="alert" className="fixed bottom-4 right-4 z-50 rounded-lg border bg-background p-4 text-sm">{error}</p>}
    <App onLogout={session.enabled ? logout : undefined} />
  </>

  return <main className="flex min-h-svh items-center justify-center bg-muted/30 px-5 py-12">
    <section className="w-full max-w-sm" aria-labelledby="login-title">
      <a href="/" className="mb-10 flex items-center gap-2.5 text-lg font-semibold"><AudioLines className="size-6" />医访练</a>
      <h1 id="login-title" className="text-2xl font-semibold">登录医访练</h1>
      <p className="mb-8 mt-3 text-sm leading-7 text-muted-foreground">进入你的演练、资料与复盘记录。</p>
      {error && <p role="alert" className="mb-5 text-sm text-destructive">{error}</p>}
      {!session ? error ? <Button className="h-11 w-full" onClick={() => { setError(''); setRetry(value => value + 1) }}>重新连接</Button> : <p role="status" className="text-sm text-muted-foreground">正在确认登录状态…</p> : <form onSubmit={login} className="space-y-5" aria-busy={busy}>
        <Field label="账号" htmlFor="username"><Input id="username" name="username" autoComplete="username" required maxLength={100} className="h-11" disabled={busy} /></Field>
        <Field label="密码" htmlFor="password"><div className="relative"><Input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required maxLength={512} className="h-11 pr-12" disabled={busy} /><Button type="button" variant="ghost" size="icon" className="absolute inset-y-0 right-0 h-11 w-11" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff /> : <Eye />}</Button></div></Field>
        <Button type="submit" className="h-11 w-full" disabled={busy}>{busy ? '正在登录…' : '登录'}</Button>
      </form>}
      <p className="mt-8 text-xs leading-6 text-muted-foreground">仅限授权使用。请勿输入真实患者信息。</p>
    </section>
  </main>
}
