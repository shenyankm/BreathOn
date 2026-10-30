import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === 'android' ? '/_android/' : '/',
  build: { outDir: mode === 'android' ? 'dist-android' : 'dist' },
  plugins: [react(), tailwindcss(), {
    name: 'android-entry',
    configureServer(server) {
      if (mode === 'android') return
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? ''
        if (path === '/app' || path.startsWith('/app/') || path === '/preview-visit.html') {
          response.statusCode = 410
          response.end('User screens are available in the Android app only.')
        } else if (path === '/_android' || path.startsWith('/_android/')) {
          response.statusCode = 404
          response.end('Not Found')
        } else next()
      })
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return mode === 'android' ? html.replace('/src/main.tsx', '/src/main.android.tsx') : html
      },
    },
  }],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
    proxy: { '/api': { target: process.env.API_TARGET || 'http://127.0.0.1:8000', ws: true } },
  },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
}))
