import assert from 'node:assert/strict'
import test from 'node:test'
import { isNearBottom, restoreScrollPosition } from '../src/lib/scroll-position.ts'

test('transcript follows only readers near the latest message', () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true)
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 560 }), true)
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 200 }), false)
  assert.equal(isNearBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }), true)
})

test('saved scroll waits for lazy content and stops after restoration or user input', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  let resize = () => {}, connected = false, top = 0, maxTop = 100
  const events = new Map<string, () => void>()
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: () => void) { resize = callback }
    observe() { connected = true }
    disconnect() { connected = false }
  } })
  const viewport = {
    get scrollTop() { return top }, set scrollTop(value: number) { top = Math.min(value, maxTop) },
    addEventListener(name: string, callback: () => void) { events.set(name, callback) },
    removeEventListener(name: string) { events.delete(name) },
  } as unknown as HTMLElement
  try {
    const cleanup = restoreScrollPosition(viewport, {} as HTMLElement, 600)
    assert.equal(top, 100)
    assert.equal(connected, true)
    maxTop = 1000; resize()
    assert.equal(top, 600)
    assert.equal(connected, false)
    assert.equal(events.size, 0)
    cleanup()
    maxTop = 100
    restoreScrollPosition(viewport, {} as HTMLElement, 600)
    events.get('pointerdown')!()
    assert.equal(connected, false)
    assert.equal(events.size, 0)
  } finally {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original)
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
  }
})
