import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/imageview/',
  optimizeDeps: {
    include: ['fflate']
  },
  worker: {
    format: 'es',
    plugins: () => [react()]
  }
})