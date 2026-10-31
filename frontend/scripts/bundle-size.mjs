// Run after a production build: node scripts/bundle-size.mjs dist [dist-android].
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

for (const directory of process.argv.slice(2)) {
  const root = path.resolve(directory)
  const html = readFileSync(path.join(root, 'index.html'), 'utf8')
  const initial = new Set()
  function visit(file) {
    if (initial.has(file)) return
    assert.ok(file.startsWith(root + path.sep), 'Build import escaped its output directory')
    initial.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:import|export)\s*(?:[^;"'()]*?\s*from\s*)?["']([^"']+)["']/g)) {
      if (match[1].startsWith('.')) visit(path.resolve(path.dirname(file), match[1]))
    }
  }
  for (const match of html.matchAll(/(?:src|href)="[^"]*\/assets\/([^"/]+\.js)"/g)) visit(path.join(root, 'assets', match[1]))
  assert.ok(initial.size > 0, 'No entry scripts found')
  function files(directory) {
    return readdirSync(directory).flatMap(name => {
      const file = path.join(directory, name)
      return statSync(file).isDirectory() ? files(file) : [file]
    })
  }
  const total = files(root)
  const bytes = list => list.reduce((sum, file) => sum + statSync(file).size, 0)
  console.log(JSON.stringify({ directory, initial_js_bytes: bytes([...initial]),
    initial_js_gzip_bytes: [...initial].reduce((sum, file) => sum + gzipSync(readFileSync(file)).length, 0),
    total_js_bytes: bytes(total.filter(file => file.endsWith('.js'))), total_bytes: bytes(total),
    initial_chunks: [...initial].map(file => path.basename(file)) }))
}
