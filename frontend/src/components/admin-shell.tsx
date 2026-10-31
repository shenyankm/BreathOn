import type { ReactNode } from 'react'

/** Web admin width and gutters. Every admin screen uses these so pages do not shift sideways. */
export const adminWidth = 'mx-auto w-full max-w-[1440px] px-4 sm:px-6'

export function AdminHeader({ children }: { children: ReactNode }) {
  return <header className="border-b bg-background"><div className={`${adminWidth} flex min-h-16 items-center justify-between gap-4`}>{children}</div></header>
}
