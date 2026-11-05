import { resolve } from 'node:path'
import { Store } from './store.ts'
import { settings, assert } from './core.ts'

assert(process.argv.length === 3, 400, 'Usage: npm run import:records -- <recovery-directory>')
const config = settings()
assert(config.database, 400, 'DATABASE_URL is required')
const store = new Store(config)
try {
  await store.open()
  const result = await store.importRecords(resolve(process.argv[2]))
  console.log(JSON.stringify(result))
} finally {
  await store.close()
}
