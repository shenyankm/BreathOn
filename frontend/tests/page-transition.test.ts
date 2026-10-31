import assert from 'node:assert/strict'
import test from 'node:test'
import { animatePageTransition } from '../src/lib/page-transition.ts'

test('page motion is cancellable and respects reduced motion and missing browser support', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let reduced = false
  let started = 0
  let cancelled = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    matchMedia: (query: string) => {
      assert.equal(query, '(prefers-reduced-motion: reduce)')
      return { matches: reduced }
    },
  } })
  const element = { animate: (frames: Keyframe[]) => { assert.ok(frames.every(frame => !('transform' in frame))); started++; return { cancel: () => { cancelled++ } } } } as unknown as HTMLElement
  try {
    const cleanup = animatePageTransition(element)
    assert.equal(started, 1)
    cleanup?.()
    assert.equal(cancelled, 1)
    reduced = true
    assert.equal(animatePageTransition(element), undefined)
    assert.equal(started, 1)
    assert.equal(animatePageTransition(null), undefined)
    assert.equal(animatePageTransition({} as HTMLElement), undefined)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
