import { useEffect, useRef, useState, type FormEvent, type ComponentType } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Brand } from './brand'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/form-field'
import { Alert, AlertDescription } from './ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

type Session = { enabled: boolean; authenticated: boolean; expires_at: number | null; username?: string | null; role?: 'admin' | 'representative' | null }
const signedOut: Session = { enabled: true, authenticated: false, expires_at: null }

async function readSession(response: Response): Promise<Session> {
  if (!response.ok) throw new Error()
  const data = await response.json()
  if (typeof data.enabled !== 'boolean' || typeof data.authenticated !== 'boolean' ||
      data.authenticated && (!data.enabled || !Number.isFinite(data.expires_at) ||
        typeof data.username !== 'string' || !data.username.trim() || data.username.length > 100 ||
        !['admin', 'representative'].includes(data.role))) throw new Error()
  if (data.authenticated && data.expires_at * 1000 <= Date.now()) return signedOut
  return data
}

type AppProps = {onLogout?:()=>void;username?:string;role?:'admin'|'representative'}
export function AuthGate({ AppComponent, target = 'admin' }: {AppComponent: ComponentType<AppProps>;target?:'admin'|'android'}) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(false)
  const [retry, setRetry] = useState(0)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const changing = useRef(false)
  const identity = useRef('')

  function updateSession(next: Session) {
    const nextIdentity = next.authenticated ? `${next.username}:${next.role}` : ''
    if (identity.current && identity.current !== nextIdentity) {
      try { localStorage.removeItem('medvisit.service-status') } catch { /* Storage may be unavailable in the WebView. */ }
    }
    identity.current = nextIdentity
    setSession(next)
  }

  useEffect(() => {
    function load(expired = false) {
      if (changing.current) return
      pending.current?.abort()
      const request = new AbortController()
      pending.current = request
      fetch('/api/auth/session', {
        credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      })
        .then(response => response.status === 401 ? signedOut : readSession(response))
        .then(data => {
          if (request.signal.aborted) return
          updateSession(data)
          setError(expired && !data.authenticated ? '登录已失效，请重新登录。' : '')
        })
        .catch(() => { if (!request.signal.aborted) setError('无法连接服务器，请重试。') })
        .finally(() => { if (pending.current === request) pending.current = null })
    }
    const focus = () => load()
    // Recheck the current cookie so a late request from an old account cannot end a new login.
    const unauthorized = () => load(true)
    load()
    window.addEventListener('focus', focus)
    window.addEventListener('medvisit:unauthorized', unauthorized)
    return () => {
      pending.current?.abort()
      window.removeEventListener('focus', focus)
      window.removeEventListener('medvisit:unauthorized', unauthorized)
    }
  }, [retry])

  useEffect(() => {
    if (!session?.authenticated || !session.expires_at) return
    const expires = session.expires_at * 1000
    const expire = () => {
      if (Date.now() >= expires) {
        updateSession(signedOut)
        setVisible(false)
        setError('登录已失效，请重新登录。')
      }
    }
    const timer = window.setTimeout(expire, Math.max(0, expires - Date.now()))
    window.addEventListener('focus', expire)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', expire) }
  }, [session])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (changing.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    changing.current = true
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      })
      if (request.signal.aborted) return
      if (!response.ok) {
        setError(response.status === 429 ? '登录尝试过多，请一分钟后重试。' : response.status === 401 ? '账号或密码不正确。' : '登录失败，请重试。')
        return
      }
      const result = await readSession(response)
      if (request.signal.aborted) return
      if (!result.authenticated) throw new Error()
      form.reset()
      setVisible(false)
      updateSession(result)
    } catch { if (!request.signal.aborted) setError('无法连接服务器，请重试。') }
    finally {
      if (pending.current === request) { pending.current = null; changing.current = false; setBusy(false) }
    }
  }

  async function logout() {
    if (changing.current) return
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    changing.current = true
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      })
      if (request.signal.aborted) return
      if (!response.ok && response.status !== 401) throw new Error()
      updateSession(signedOut)
      setVisible(false)
    } catch { if (!request.signal.aborted) setError('退出失败，请检查网络后重试。') }
    finally {
      if (pending.current === request) { pending.current = null; changing.current = false; setBusy(false) }
    }
  }

  const requestLogout = () => { if (!changing.current) setConfirmLogout(true) }
  const logoutConfirmation = <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
    <DialogContent role="alertdialog" showCloseButton={false}>
      <DialogHeader><DialogTitle>退出登录？</DialogTitle><DialogDescription>退出后需要重新登录才能继续使用。</DialogDescription></DialogHeader>
      <DialogFooter className="grid grid-cols-2 gap-3 sm:flex">
        <Button variant="outline" className="min-h-11" onClick={() => setConfirmLogout(false)}>取消</Button>
        <Button className="min-h-11" disabled={busy} onClick={() => { setConfirmLogout(false); return logout() }}>确认退出</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  const reconnect = () => { setError(''); setRetry(value => value + 1) }
  if (session && (session.authenticated || target === 'admin' && !session.enabled)) {
    if (target === 'admin' && session.enabled && session.role !== 'admin') return <><main className="flex min-h-svh flex-col items-center justify-center gap-5 p-6 text-center"><h1 className="text-2xl font-semibold">管理后台</h1><p role="alert" className="text-sm text-muted-foreground">当前账号无权使用管理后台，请使用 Android 客户端进行演练。</p>{error&&<Alert variant="destructive" className="max-w-sm"><AlertDescription>{error}</AlertDescription></Alert>}<Button className="h-11" variant="outline" disabled={busy} onClick={requestLogout}>退出登录</Button></main>{logoutConfirmation}</>
    return <>
      {logoutConfirmation}
      {error && <Alert variant="destructive" className="fixed inset-x-4 top-4 z-50 mx-auto max-w-lg"><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><p>{error}</p><Button variant="outline" className="h-11" disabled={busy} onClick={reconnect}>重新连接</Button></AlertDescription></Alert>}
      <AppComponent key={`${session.username ?? 'local'}:${session.role ?? 'admin'}`} onLogout={session.enabled ? requestLogout : undefined} username={session.username ?? undefined} role={session.enabled ? session.role ?? 'representative' : 'admin'} />
    </>
  }

  return <main className="flex min-h-svh items-center justify-center bg-muted/30 px-5 py-12">
    <section className="w-full max-w-sm" aria-labelledby="login-title">
      <a href={target === 'android' ? '#home' : '/admin'} className="mb-10 flex items-center gap-2.5 text-lg font-semibold"><Brand iconClassName="size-10" /></a>
      <h1 id="login-title" className="mb-6 text-2xl font-semibold">{target === 'admin' ? '登录管理后台' : '登录 BreathOn'}</h1>
      {error && <Alert variant="destructive" className="mb-5"><AlertDescription>{error}</AlertDescription></Alert>}
      {!session ? error ? <Button className="h-11 w-full" onClick={reconnect}>重新连接</Button> : <p role="status" className="text-sm text-muted-foreground">正在连接服务器…</p> : !session.enabled ? <div className="space-y-5"><Alert><AlertDescription>服务器尚未开启账号登录，请联系管理员。</AlertDescription></Alert><Button variant="outline" className="h-11 w-full" onClick={reconnect}>重新连接</Button></div> : <form onSubmit={login} className="space-y-5" aria-busy={busy}>
        <Field label="账号" htmlFor="username"><Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={100} className="h-11" disabled={busy} /></Field>
        <Field label="密码" htmlFor="password"><div className="relative"><Input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required maxLength={512} className="h-11 pr-12" disabled={busy} /><Button type="button" variant="ghost" size="icon" className="absolute inset-y-0 right-0 h-11 w-11" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} disabled={busy} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff /> : <Eye />}</Button></div></Field>
        <Button type="submit" className="h-11 w-full" disabled={busy}>{busy ? '正在登录…' : '登录'}</Button>
      </form>}
    </section>
  </main>
}
