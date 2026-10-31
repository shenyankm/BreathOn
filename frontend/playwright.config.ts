import { defineConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(import.meta.dirname, `../backend/data/validation/e2e/${Date.now()}`)
mkdirSync(dataDir, { recursive: true })
export default defineConfig({
  testDir: './e2e', globalSetup: './e2e/setup.ts', fullyParallel: false, workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5187', channel: 'chrome',
    screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 15_000 },
  webServer: [
    { command: 'uv run --directory ../backend --locked uvicorn tools.e2e_app:build --factory --host 127.0.0.1 --port 8187 --ws-max-size 4096 --ws-max-queue 16',
      url: 'http://127.0.0.1:8187/api/ready', timeout: 60_000, reuseExistingServer: false,
      env: { E2E_DATA_DIR: dataDir } },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5187', url: 'http://127.0.0.1:5187/admin',
      timeout: 60_000, reuseExistingServer: false, env: { API_TARGET: 'http://127.0.0.1:8187' } },
  ],
})
