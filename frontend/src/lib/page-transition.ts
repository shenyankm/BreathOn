export function animatePageTransition(element: HTMLElement | null) {
  if (!element?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const animation = element.animate(
    [{ opacity: 0.4 }, { opacity: 1 }],
    { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  )
  return () => animation.cancel()
}
