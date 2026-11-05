export function appPage(hash: string) {
  const page = hash.slice(1).split('?')[0]
  return page === 'records' || page === 'me' || page === 'start' ? page : 'practice'
}
