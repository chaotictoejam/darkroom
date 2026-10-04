import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // All /api/* and /projects/* requests go to the FastAPI backend
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/projects': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // WebSocket proxy for progress streaming
      '/api/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Never inline scripts (e.g. the AudioWorklet) as data: URLs; the desktop
    // app's CSP only allows scripts from 'self'.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.js') ? false : undefined),
  },
})
