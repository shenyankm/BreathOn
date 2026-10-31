/** Hash routes. Plain pages: #home #training #coach #me; sub pages carry an argument after a slash. */
export type Route =
  | { page: 'home' } | { page: 'training' } | { page: 'coach' } | { page: 'me' }
  | { page: 'level'; level: string } | { page: 'lesson'; id: string }
  | { page: 'doctors' } | { page: 'pick' } | { page: 'brief'; id: string }
  | { page: 'workspace' } | { page: 'products' } | { page: 'audiences' } | { page: 'policies' } | { page: 'audit' } | { page: 'settings' }
  | { page: 'records' } | { page: 'visits' } | { page: 'start' } | { page: 'library' }

const plain = ['home', 'training', 'coach', 'me', 'doctors', 'pick', 'workspace', 'products', 'audiences', 'policies', 'audit', 'settings', 'records', 'visits', 'start', 'library'] as const
// Old hashes keep working: #practice was the coach page, #scenarios the scenario list.
const aliases: Record<string, Route> = { practice: { page: 'coach' }, scenarios: { page: 'training' } }

export function parseRoute(hash: string): Route {
  const [path] = hash.replace(/^#/, '').split('?')
  const [head, arg = ''] = path.split('/')
  if (head === 'level' && /^L[1-4]$/.test(arg)) return { page: 'level', level: arg }
  if (head === 'lesson' && /^[a-z0-9-]{3,30}$/.test(arg)) return { page: 'lesson', id: arg }
  if (head === 'brief' && /^[A-Za-z0-9._-]{1,80}$/.test(arg)) return { page: 'brief', id: arg }
  if (aliases[head]) return aliases[head]
  return (plain as readonly string[]).includes(head) ? { page: head } as Route : { page: 'home' }
}

/** Where the Android back key goes from here; null means "let the app move to the background". */
export function backTarget(route: Route): string | null {
  switch (route.page) {
    case 'lesson': return `#level/L${/^l([1-4])-/.exec(route.id)?.[1] ?? '1'}`
    case 'level': return '#training'
    case 'brief': return '#pick'
    case 'pick': return '#coach'
    case 'doctors': return '#level/L3'
    case 'workspace': return '#me'
    case 'products': case 'audiences': case 'policies': case 'audit': case 'settings': return '#workspace'
    case 'records': case 'visits': return '#me'
    case 'library': return '#products'
    case 'start': return '#coach'
    case 'training': case 'coach': case 'me': return '#home'
    default: return null
  }
}

export function tabOf(route: Route): 'home' | 'training' | 'coach' | 'me' {
  switch (route.page) {
    case 'home': return 'home'
    case 'training': case 'level': case 'lesson': case 'doctors': return 'training'
    case 'coach': case 'pick': case 'brief': case 'start': return 'coach'
    default: return 'me'
  }
}
