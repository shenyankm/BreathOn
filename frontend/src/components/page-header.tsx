import type { ReactNode } from 'react'

/** Shared page title row: one heading style for app and web screens. */
export function PageHeader({ title, description, actions, hideTitle = false }: {
  title: string; description?: ReactNode; actions?: ReactNode; hideTitle?: boolean
}) {
  if (hideTitle) return <h1 className="sr-only">{title}</h1>
  return <header data-slot="page-header" className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-2 text-sm leading-7 text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </header>
}
