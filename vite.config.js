import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
  },
  define: {
    'import.meta.env.VITE_ANTHROPIC_KEY': JSON.stringify(process.env.VITE_ANTHROPIC_KEY)
  }
})
