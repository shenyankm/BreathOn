import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const exports: any = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/bp/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports })
const { backTarget, tabOf } = exports
// Objects built inside the vm context have a foreign prototype; compare plain data so strict deepEqual is meaningful.
const parseRoute = (hash: string) => JSON.parse(JSON.stringify(exports.parseRoute(hash)))

test('plain pages and sub pages parse', () => {
  assert.deepEqual(parseRoute('#home'), { page: 'home' })
  assert.deepEqual(parseRoute('#level/L3'), { page: 'level', level: 'L3' })
  assert.deepEqual(parseRoute('#lesson/l4-02'), { page: 'lesson', id: 'l4-02' })
  assert.deepEqual(parseRoute('#brief/ip-blood'), { page: 'brief', id: 'ip-blood' })
  assert.deepEqual(parseRoute('#records?session=x'), { page: 'records' })
})
test('old hashes still open the right screen', () => {
  assert.deepEqual(parseRoute('#practice'), { page: 'coach' })
  assert.deepEqual(parseRoute('#scenarios'), { page: 'training' })
})
test('malformed or unknown routes fall back to home instead of rendering nothing', () => {
  for (const hash of ['', '#', '#nope', '#level/L9', '#lesson/../etc', '#brief/a b', '#lesson/', '#level']) assert.deepEqual(parseRoute(hash), { page: 'home' }, hash)
})
test('every screen has a back target that leads somewhere real, and home has none', () => {
  const hashes = ['#home', '#training', '#coach', '#me', '#level/L1', '#level/L3', '#lesson/l1-01', '#lesson/l4-03', '#doctors', '#pick', '#brief/ip-blood',
    '#workspace', '#products', '#audiences', '#policies', '#audit', '#settings', '#records', '#visits', '#library', '#start']
  for (const hash of hashes) {
    const target = backTarget(parseRoute(hash))
    if (hash === '#home') { assert.equal(target, null); continue }
    assert.ok(target, hash)
    assert.notEqual(parseRoute(target).page === 'home' && target !== '#home' ? 'bad' : 'ok', 'bad', `${hash} -> ${target}`)
  }
  assert.equal(backTarget(parseRoute('#lesson/l3-01')), '#level/L3')
  assert.equal(backTarget(parseRoute('#doctors')), '#level/L3')
  assert.equal(backTarget(parseRoute('#brief/ip-blood')), '#pick')
})
test('following back targets always ends at home without a loop', () => {
  for (const hash of ['#brief/ip-blood', '#lesson/l4-01', '#audit', '#visits', '#library', '#start', '#doctors']) {
    let current = hash
    const seen = new Set<string>()
    while (current !== '#home') {
      assert.ok(!seen.has(current), `loop at ${current} from ${hash}`)
      seen.add(current)
      const next = backTarget(parseRoute(current))
      assert.ok(next, `dead end at ${current} from ${hash}`)
      current = next
    }
  }
})
test('the bottom tab follows the section a screen belongs to', () => {
  assert.equal(tabOf(parseRoute('#lesson/l1-01')), 'training')
  assert.equal(tabOf(parseRoute('#doctors')), 'training')
  assert.equal(tabOf(parseRoute('#brief/ip-blood')), 'coach')
  assert.equal(tabOf(parseRoute('#audit')), 'me')
  assert.equal(tabOf(parseRoute('#records')), 'me')
})
