/// <reference types="vitest/config" />
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
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // `npm run test:coverage` (and CI) fails below these. The global floor sits
    // just under today's numbers so coverage can only go up; raise it as tests
    // land. Pure timeline logic stays fully covered.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        statements: 9,
        branches: 7,
        functions: 7,
        lines: 8,
        'src/components/Timeline/*.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
})
