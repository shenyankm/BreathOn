import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir:'./e2e',testMatch:'training-loop.spec.ts',workers:1,retries:0,
  timeout:30_000,expect:{timeout:10_000},
  use:{baseURL:'http://127.0.0.1:5197/_android/',channel:'chrome',screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'npm run dev -- --mode android --host 127.0.0.1 --port 5197',
    url:'http://127.0.0.1:5197/_android/',reuseExistingServer:false,
    env:{API_TARGET:'http://127.0.0.1:8197'}},
})
