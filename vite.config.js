import { defineConfig } from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin({ hot: process.env.NODE_ENV !== 'test' })],
  define: {
    __BUILD_DATE__: Date.now(),
  },
  base: process.env.VERCEL ? '/' : '/imageview/',
  build: {
    // Target modern browsers only - eliminates legacy polyfills (~44 KiB savings)
    // Removes unnecessary Array.prototype.at, Math.trunc, Array.from polyfills
    target: 'es2020',
    cssTarget: 'es2020',
    // Disable modulepreload polyfill (modern browsers support it natively)
    modulePreload: {
      polyfill: false,
    },
    // Enable CSS code splitting for non-blocking CSS
    cssCodeSplit: true,
    // Optimize chunk size
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/solid-js')) return 'solid'
          if (id.includes('node_modules/unzipit') || id.includes('node_modules/fflate'))
            return 'zip'
        },
      },
    },
  },
  optimizeDeps: {
    include: ['fflate'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
