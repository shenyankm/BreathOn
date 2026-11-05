import { mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { settings, assert } from './core.ts'
import { hashPassword } from './password.ts'

const directory = resolve(process.env.E2E_DATA_DIR ?? '')
assert(process.env.E2E_DATA_DIR, 500, 'E2E_DATA_DIR is required')
await mkdir(directory, { recursive: true })
assert(!(await readdir(directory)).length, 500, 'E2E_DATA_DIR must be a fresh empty directory')
const database = process.env.E2E_DATABASE_URL ?? ''
if (database) {
  const url = new URL(database)
  assert(
    ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.startsWith('/breathon_e2e'),
    500,
    'E2E database must be a dedicated local breathon_e2e database',
  )
}
const hash = await hashPassword('local-e2e-only-password'),
  config = settings(process.env.E2E_LIVE === '1' ? process.env : {}),
  users = Object.fromEntries(
    ['admin', 'medical', 'compliance', 'a', 'b'].map((name) => ['e2e-' + name, hash]),
  )
const { app } = await createApp({
  ...config,
  records: directory + '/sessions',
  database,
  auth: true,
  users,
  admins: ['e2e-admin', 'e2e-medical', 'e2e-compliance'],
  origins: ['http://127.0.0.1:5187'],
})
await app.listen({ host: '127.0.0.1', port: 8187 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.close())
