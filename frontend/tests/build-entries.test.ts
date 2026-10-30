import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

type Bundle = Record<string, { type: string; moduleIds?: string[]; source?: string }>
type Context = { error(message: string): never }
type Plugin = { name: string; generateBundle?: (this: Context, options: unknown, bundle: Bundle) => void }
const configUrl = new URL('../vite.config.ts', import.meta.url)
const directory = path.dirname(fileURLToPath(configUrl))
const exports: { default?: (env: { mode: string }) => { plugins: Plugin[] } } = {}
const source = readFileSync(configUrl, 'utf8').replaceAll('import.meta.dirname', JSON.stringify(directory))
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, {
  exports, process: { env: {} },
  require(name: string) {
    if (name === 'node:path') return path
    if (name === 'vite') return { defineConfig: (config: unknown) => config }
    assert.ok(name === '@vitejs/plugin-react' || name === '@tailwindcss/vite', name)
    return () => ({ name })
  },
})

function check(mode: string, bundle: Bundle) {
  const plugin = exports.default!({ mode }).plugins.find(plugin => plugin.name === 'android-entry')
  assert.ok(plugin?.generateBundle)
  plugin.generateBundle.call({ error(message) { throw new Error(message) } }, {}, bundle)
}
const moduleId = (file: string) => path.resolve(directory, `src/${file}.tsx`)

for (const target of [
  { mode: 'production', label: 'Web', required: 'admin-app', forbidden: ['App', 'pages/practice-home', 'pages/me-page', 'pages/records-page', 'pages/visits-page', 'pages/library-page'] },
  { mode: 'android', label: 'Android', required: 'App', forbidden: ['admin-app', 'pages/admin-page', 'pages/platform-page', 'pages/service-settings'] },
]) {
  test(`${target.label} build checks actual module IDs across entry and lazy chunks`, () => {
    const valid: Bundle = {
      'entry.js': { type: 'chunk', moduleIds: [moduleId(target.required) + '?used', moduleId('components/research-panel')] },
      'shared.js': { type: 'chunk', moduleIds: [moduleId('components/ui/button')] },
      'names.txt': { type: 'asset', source: target.forbidden.map(moduleId).join('\n') },
    }
    assert.doesNotThrow(() => check(target.mode, valid))
    assert.throws(() => check(target.mode, { 'empty.js': { type: 'chunk', moduleIds: [] } }), /require/)
    for (const forbidden of target.forbidden) {
      assert.throws(() => check(target.mode, {
        ...valid, 'lazy.js': { type: 'chunk', moduleIds: [moduleId(forbidden)] },
      }), error => error instanceof Error && error.message.includes(`Invalid ${target.label} module graph`) && error.message.includes(forbidden))
    }
  })
}
