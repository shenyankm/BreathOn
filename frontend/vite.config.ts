import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: process.env.API_TARGET || 'http://127.0.0.1:8000', ws: true } } },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
})
