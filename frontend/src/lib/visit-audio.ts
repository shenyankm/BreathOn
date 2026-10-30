export function audioContentType(name: string, size: number): string | null {
  const types: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' }
  const extension = name.split('.').pop()?.toLowerCase() || ''
  return size > 0 && size <= 100_000_000 ? types[extension] || null : null
}

export function validAudioDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && duration <= 1800
}
