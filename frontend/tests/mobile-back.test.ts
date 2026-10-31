import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/cloud/openwook/medvisit/MainActivity.kt', import.meta.url), 'utf8')
const script = source.match(/APP_BACK_SCRIPT = """([\s\S]*?)"""/)![1]
function back(hash: string, overlay = false) {
  let destination = '', escaped = false
  const handled = vm.runInNewContext(script, {
    location: { hash, replace(value: string) { destination = value } },
    document: { querySelector: () => overlay, dispatchEvent: () => { escaped = true } },
    KeyboardEvent: class {},
  })
  return { destination, escaped, handled }
}

test('native back closes overlays before changing pages', () => {
  assert.deepEqual(back('#doctors', true), { destination: '', escaped: true, handled: true })
})
test('native back preserves each new page parent and the existing record parents', () => {
  for (const [page, parent] of Object.entries({ doctors:'home', training:'home', practice:'home', me:'home', library:'training', products:'training', scenarios:'training', records:'me', visits:'me', start:'practice' })) {
    assert.deepEqual(back(`#${page}`), { destination:`#${parent}`, escaped:false, handled:true })
  }
  assert.equal(back('#home').handled, false)
  assert.equal(back('#records?session=existing').destination, '#records')
})
