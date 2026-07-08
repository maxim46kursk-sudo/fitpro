import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Локальный dev-сервер Vite не умеет исполнять serverless-функции из /api —
// это делает только Vercel в проде. Без этого плагина POST на /api/chat на
// localhost получал пустой 404 и падал в клиенте с "Unexpected end of JSON
// input" при попытке res.json() пустого ответа. Плагин повторяет ровно то же,
// что делает api/chat.js в проде (см. этот файл) — прокси к Anthropic с
// серверным API-ключом, — но исполняется прямо внутри dev-сервера.
function localApiChatPlugin() {
  return {
    name: 'local-api-chat',
    configureServer(server) {
      server.middlewares.use('/api/chat', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const upstream = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.VITE_ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
              },
              body,
            })
            const data = await upstream.text()
            res.setHeader('Content-Type', 'application/json')
            res.statusCode = upstream.status
            res.end(data)
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: { message: e.message } }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localApiChatPlugin()],
  server: {
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('react-dom') || id.includes('/react/')) return 'vendor'
          if (id.includes('@supabase/supabase-js')) return 'supabase'
        }
      }
    }
  }
})
