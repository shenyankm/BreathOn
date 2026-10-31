import type { ReactNode } from 'react'

/** Shared page title row: one heading style for app and web screens. */
export function PageHeader({ title, description, actions, hideTitle = false }: {
  title: string; description?: ReactNode; actions?: ReactNode; hideTitle?: boolean
}) {
  if (hideTitle) return <h1 className="sr-only">{title}</h1>
  return <header data-slot="page-header" className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0 flex-1 basis-48">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
  </header>
}
