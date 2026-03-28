import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_DATE__: Date.now(),
  },
  base: '/imageview/',
  optimizeDeps: {
    include: ['fflate']
  },
  worker: {
    format: 'es',
    plugins: () => [react()]
  }
})