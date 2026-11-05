import { createApp } from './app.ts'
import { settings } from './core.ts'

process.umask(0o077)
const config = settings(),
  { app } = await createApp(config)
try {
  await app.listen({ host: config.host, port: config.port })
  console.log(`EviSpeak TypeScript API listening on ${config.host}:${config.port}`)
} catch (error: any) {
  console.error(
    JSON.stringify({ event: 'startup_failed', error_type: error.constructor?.name ?? 'Error' }),
  )
  await app.close().catch(() => {})
  process.exitCode = 1
}
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (!closing) {
      closing = true
      app.close().catch(() => {
        process.exitCode = 1
      })
    }
  })
