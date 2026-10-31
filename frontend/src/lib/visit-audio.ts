export function audioContentType(name: string, size: number): string | null {
  const types: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' }
  const extension = name.split('.').pop()?.toLowerCase() || ''
  return size > 0 && size <= 100_000_000 ? types[extension] || null : null
}

export function validAudioDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && duration <= 1800
}

export function readAudioDuration(file: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const audio = document.createElement('audio')
    const finish = (error?: Error) => {
      clearTimeout(timer)
      const duration = audio.duration
      audio.onloadedmetadata = null
      audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      if (error) reject(error)
      else resolve(duration)
    }
    const timer = setTimeout(() => finish(new Error('读取录音超时，请重新选择文件。')), 10000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => finish()
    audio.onerror = () => finish(new Error('无法读取录音，请检查文件格式。'))
    audio.src = url
  })
}
