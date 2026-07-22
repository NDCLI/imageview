import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
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
        manualChunks: {
          // Separate vendor chunks for better caching
          'solid': ['solid-js', 'solid-js/web'],
          'zip': ['unzipit', 'fflate'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['fflate']
  },
  worker: {
    format: 'es',
    plugins: () => [solidPlugin()]
  }
})