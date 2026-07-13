import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  define: {
    __BUILD_DATE__: Date.now(),
  },
  base: process.env.VERCEL ? '/' : '/imageview/',
  optimizeDeps: {
    include: ['fflate']
  },
  worker: {
    format: 'es',
    plugins: () => [solidPlugin()]
  }
})