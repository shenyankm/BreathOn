import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/cloud/openwook/medvisit/MainActivity.kt', import.meta.url), 'utf8')
const script = source.match(/APP_BACK_SCRIPT = """([\s\S]*?)"""/)![1]
function back(hash: string, { overlay = false, target = '' } = {}) {
  let destination = '', escaped = false
  const handled = vm.runInNewContext(script, {
    location: { hash, replace(value: string) { destination = value } },
    document: { querySelector: () => overlay, dispatchEvent: () => { escaped = true }, documentElement: { dataset: { bpBack: target } } },
    KeyboardEvent: class {},
  })
  return { destination, escaped, handled }
}

test('native back closes overlays before changing pages', () => {
  assert.deepEqual(back('#doctors', { overlay: true, target: '#level/L3' }), { destination: '', escaped: true, handled: true })
})
test('native back follows the target the app publishes for the current screen', () => {
  assert.deepEqual(back('#lesson/l1-01', { target: '#level/L1' }), { destination: '#level/L1', escaped: false, handled: true })
  assert.deepEqual(back('#brief/ip-blood', { target: '#pick' }), { destination: '#pick', escaped: false, handled: true })
})
test('native back leaves the app at the home screen where no target is published', () => {
  assert.equal(back('#home', { target: '' }).handled, false)
})
test('native back drops a query string before anything else', () => {
  assert.equal(back('#records?session=existing', { target: '#me' }).destination, '#records')
})
