import { useEffect } from 'react'
import { backTarget, type Route } from './route'

/** Publishes the in-app back target so the Android back handler and tests share one table. */
export function BpBack({ route }: { route: Route }) {
  const target = backTarget(route)
  useEffect(() => {
    document.documentElement.dataset.bpBack = target ?? ''
    return () => { delete document.documentElement.dataset.bpBack }
  }, [target])
  return null
}
