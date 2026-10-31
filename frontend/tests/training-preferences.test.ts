import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { presetFor } from '../src/lib/training-setup.ts'

function loadModule(file: string, modules: Record<string, unknown>) {
  const exports: Record<string, any> = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => modules[name] })
  return exports
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('SQLite IPC writes remain ordered, reads wait for writes, and failed writes can recover', async () => {
  const calls: any[] = []
  let finish!: () => void
  const storage = loadModule('../src/lib/training-preferences.ts', {
    '@tauri-apps/api/core': { invoke: async (command: string, args: any) => {
      calls.push([command, args.account, args.experience])
      if (args.experience === 'combat') await new Promise<void>(resolve => { finish = resolve })
      if (args.account === 'failed') throw new Error('disk full')
      return command.startsWith('load') ? 'practice' : undefined
    } },
  })
  const first = storage.saveTrainingPreference('a', 'combat')
  const second = storage.saveTrainingPreference('b', 'practice')
  const read = storage.loadTrainingPreference('b')
  await settle()
  assert.equal(calls.length, 1)
  finish()
  await Promise.all([first, second])
  assert.equal(await read, 'practice')
  assert.deepEqual(calls, [
    ['save_training_preference', 'a', 'combat'],
    ['save_training_preference', 'b', 'practice'],
    ['load_training_preference', 'b', undefined],
  ])
  await assert.rejects(storage.saveTrainingPreference('failed', 'practice'))
  await storage.saveTrainingPreference('a', 'practice')
})

test('malformed native values are rejected', async () => {
  const storage = loadModule('../src/lib/training-preferences.ts', {
    '@tauri-apps/api/core': { invoke: async () => ({ experience: 'combat' }) },
  })
  await assert.rejects(storage.loadTrainingPreference('a'), /Invalid training preference/)
})

function mount(storage: Record<string, unknown>, account = 'a') {
  const slots: any[] = []
  let cursor = 0, cleanup: (() => void) | undefined
  const react = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = value }]
    },
    useRef(initial: any) { return slots[cursor++] ??= { current: initial } },
    useEffect(callback: () => () => void) { if (!cleanup) cleanup = callback() },
  }
  const hook = loadModule('../src/hooks/use-training-preference.ts', {
    react, '../lib/training-preferences': storage, '../lib/training-setup': { presetFor },
  })
  return {
    render() { cursor = 0; return hook.useTrainingPreference(account) },
    unmount() { cleanup?.() },
  }
}

test('restores the account preference without writing defaults or exposing another account state', async () => {
  const saved: unknown[] = []
  const storage = {
    loadTrainingPreference: async (account: string) => account === 'a' ? 'combat' : null,
    saveTrainingPreference: async (...args: unknown[]) => { saved.push(args) },
  }
  const a = mount(storage)
  a.render(); await settle()
  assert.equal(a.render().preset.id, 'combat')
  a.unmount()
  const b = mount(storage, 'b')
  b.render(); await settle()
  assert.equal(b.render().preset.id, 'coached')
  assert.deepEqual(saved, [])
})

test('late native reads never overwrite a new selection or an unmounted account', async () => {
  let finish!: (value: string) => void
  const saved: unknown[] = []
  const app = mount({
    loadTrainingPreference: () => new Promise<string>(resolve => { finish = resolve }),
    saveTrainingPreference: async (...args: unknown[]) => { saved.push(args) },
  })
  app.render().selectPreset(presetFor('combat'))
  finish('practice'); await settle()
  assert.equal(app.render().preset.id, 'combat')
  assert.deepEqual(saved, [['a', 'combat']])
  const stale = mount({ loadTrainingPreference: () => new Promise<string>(resolve => { finish = resolve }) })
  stale.render(); stale.unmount()
  finish('combat'); await settle()
  assert.equal(stale.render().preset.id, 'coached')
})

test('storage failures keep practice usable and explain that persistence failed', async () => {
  const app = mount({
    loadTrainingPreference: async () => { throw new Error('unavailable') },
    saveTrainingPreference: async () => { throw new Error('disk full') },
  })
  app.render(); await settle()
  assert.match(app.render().storageError, /无法读取/)
  app.render().selectPreset(presetFor('combat'))
  await settle()
  assert.equal(app.render().preset.id, 'combat')
  assert.match(app.render().storageError, /未能保存/)
})
