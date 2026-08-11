import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { sites } from './build/sites-vite-plugin'

export default defineConfig(async () => {
  const e2eStaticPreview = process.env.PVSTUDIO_E2E_STATIC_PREVIEW === 'true'
  const workerPlugins = process.env.VITEST || e2eStaticPreview
    ? []
    : (await import('@cloudflare/vite-plugin')).cloudflare({
        viteEnvironment: { name: 'server' },
        configPath: './wrangler.jsonc',
      })

  return {
    plugins: [react(), ...(e2eStaticPreview ? [] : [sites()]), ...workerPlugins],
    build: {
      sourcemap: true,
      // Three/R3F are intentionally isolated for cacheability; the current
      // measured manual chunk is ~1,077 kB minified (the rest stays below the
      // application budget), so keep the warning just above that known chunk.
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          manualChunks: { three: ['three', '@react-three/fiber', '@react-three/drei'] },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: true,
      clearMocks: true,
      restoreMocks: true,
      unstubGlobals: true,
      include: ['src/**/*.{test,spec}.{ts,tsx}', 'worker/**/*.test.ts', 'build/**/*.test.ts'],
    },
  }
})
