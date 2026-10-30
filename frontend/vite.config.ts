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
    generateBundle(_, bundle) {
      const root = path.resolve(import.meta.dirname, './src').replaceAll('\\', '/')
      const modules = new Set(Object.values(bundle).flatMap(output => output.type === 'chunk'
        ? output.moduleIds.map(id => id.split('?')[0].replaceAll('\\', '/')) : []))
      const contains = (file: string) => modules.has(`${root}/${file}.tsx`)
      const required = mode === 'android' ? 'App' : 'admin-app'
      const forbidden = mode === 'android'
        ? ['admin-app', 'pages/admin-page', 'pages/platform-page', 'pages/service-settings']
        : ['App', 'pages/practice-home', 'pages/me-page', 'pages/records-page', 'pages/visits-page', 'pages/library-page']
      const unexpected = forbidden.filter(contains)
      if (!contains(required) || unexpected.length) {
        this.error(`Invalid ${mode === 'android' ? 'Android' : 'Web'} module graph: require ${required}.tsx; unexpected modules: ${unexpected.join(', ') || 'none'}`)
      }
    },
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
