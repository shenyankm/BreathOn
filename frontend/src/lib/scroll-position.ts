export function isNearBottom(viewport: Pick<HTMLElement, 'scrollHeight' | 'clientHeight' | 'scrollTop'>) {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48
}

// Lazy pages may not be tall enough to restore their saved position on first render.
export function restoreScrollPosition(viewport: HTMLElement, content: HTMLElement, top: number) {
  const stop = () => {
    observer.disconnect()
    viewport.removeEventListener('pointerdown', stop)
    viewport.removeEventListener('wheel', stop)
    viewport.removeEventListener('keydown', stop)
  }
  const restore = () => {
    viewport.scrollTop = top
    if (Math.abs(viewport.scrollTop - top) <= 1) stop()
  }
  const observer = new ResizeObserver(restore)
  observer.observe(content)
  viewport.addEventListener('pointerdown', stop, { passive: true })
  viewport.addEventListener('wheel', stop, { passive: true })
  viewport.addEventListener('keydown', stop)
  restore()
  return stop
}
