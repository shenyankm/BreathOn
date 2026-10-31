import type { ReactNode } from 'react'

export function Back({ label, href }: { label: string; href: string }) {
  return <a className="mobile-back" href={href}><b aria-hidden="true">‹</b>{label}</a>
}

export function Topline({ eyebrow, tag, tone = 'teal' }: { eyebrow: string; tag?: string; tone?: 'teal' | 'orange' | 'lilac' | '' }) {
  return <div className="topline"><span className="eyebrow">{eyebrow}</span>{tag && <span className={`tag ${tone}`}>{tag}</span>}</div>
}

export function Row({ index, title, note, href, onClick }: { index?: string; title: string; note?: string; href?: string; onClick?: () => void }) {
  const body = <>
    {index && <span className="row-icon">{index}</span>}
    <span className="row-copy"><strong>{title}</strong>{note && <small>{note}</small>}</span>
    <span className="row-end" aria-hidden="true">›</span>
  </>
  return href ? <a className="mobile-row" href={href}>{body}</a> : <button type="button" className="mobile-row" onClick={onClick}>{body}</button>
}

export function Switch({ on, label, onToggle, busy }: { on: boolean; label: string; onToggle: () => void; busy?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} className={`switch ${on ? 'on' : ''}`} onClick={onToggle} />
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="soft-card" style={{ marginTop: 14 }}><p className="sub">{children}</p></div>
}

export function Status({ loading, error, retry, children }: { loading: boolean; error: string; retry: () => void; children: ReactNode }) {
  if (loading) return <p role="status" className="sub" style={{ margin: '18px 0' }}>正在加载…</p>
  if (error) return <div className="soft-card" role="alert" style={{ marginTop: 14 }}><p className="sub">{error}</p><button type="button" className="mini-btn soft" style={{ marginTop: 10 }} onClick={retry}>重新加载</button></div>
  return <>{children}</>
}
