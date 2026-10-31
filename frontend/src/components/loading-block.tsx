import { Skeleton } from '@/components/ui/skeleton'

/** Shared loading state: status text plus skeleton rows, announced once. */
export function LoadingBlock({ label, rows = 2, className = '' }: { label: string; rows?: number; className?: string }) {
  return <div role="status" className={`space-y-3 ${className}`}>
    <p className="text-sm text-muted-foreground">{label}</p>
    <div aria-hidden="true" className="space-y-2">{Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
  </div>
}
