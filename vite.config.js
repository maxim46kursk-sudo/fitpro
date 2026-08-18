import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Локальный dev-сервер Vite не умеет исполнять serverless-функции из /api —
// это делает только Vercel в проде. Без этого плагина POST на /api/chat на
// localhost получал пустой 404 и падал в клиенте с "Unexpected end of JSON
// input" при попытке res.json() пустого ответа. Плагин повторяет ровно то же,
// что делает api/chat.js в проде (см. этот файл) — прокси к Anthropic с
// серверным API-ключом, — но исполняется прямо внутри dev-сервера.
// Ключ передаётся параметром (из loadEnv), а не читается через process.env
// внутри плагина — Vite НЕ прокидывает .env в process.env автоматически для
// конфига, из-за этого ключ на локалке оказался пустым при первой попытке.
function localApiChatPlugin(apiKey) {
  return {
    name: 'local-api-chat',
    configureServer(server) {
      server.middlewares.use('/api/chat', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (!apiKey) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'VITE_ANTHROPIC_KEY не найден в .env — локальный /api/chat не может обратиться к Anthropic' } }))
          return
        }
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const upstream = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
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

/**
 * ВИДНА ЛИ КАРТОЧКА «FITPRO MOTION» В «ТРЕНИРОВКАХ».
 *
 * Раздел новый и живёт первый день, поэтому в проде он ВЫКЛЮЧЕН, а на превью
 * включён: владелец смотрит его по ссылке ветки, и только после его «да» ветка
 * идёт в main. Если после выкатки что-то пойдёт не так — раздел гасится этим же
 * флагом, а приложение остаётся как было.
 *
 * Решается на СБОРКЕ, а не в панели Vercel, и это осознанно: переменные в панели
 * живут отдельно от репозитория, их легко забыть выставить на одном из окружений,
 * и цена забывчивости здесь — сырой раздел у живых людей. `VERCEL_ENV` Vercel
 * подставляет сам на каждой сборке ('production' | 'preview' | 'development'), и
 * забыть его нельзя.
 *
 * `VITE_MOTION=1` включает раздел где угодно — этим же ключом его включат в
 * проде, когда владелец скажет «да».
 */
function motionCardVisible(env) {
  if (env.VITE_MOTION === '1') return true
  if (env.VITE_MOTION === '0') return false
  // VERCEL_ENV приходит из окружения сборки; loadEnv с пустым префиксом отдаёт и
  // системные переменные, поэтому обращаться к process здесь не нужно
  const where = env.VERCEL_ENV || ''
  // на Vercel: везде кроме прода. Вне Vercel (локальная разработка) — тоже да
  return where !== 'production'
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    /**
     * Значение вклеивается в код на сборке.
     *
     * Имя обычное, а не `import.meta.env.VITE_MOTION_ON`, и это не вкусовщина:
     * Vite подставляет `import.meta.env.*` сам, из СВОЕГО набора переменных, и
     * перебивает define. Ключ, которого в .env нет, превращается в `undefined`
     * — то есть флаг молча оказывался выключен и на превью тоже. Проверено:
     * обе сборки давали `false`.
     */
    define: {
      __MOTION_ON__: JSON.stringify(motionCardVisible(env)),
    },
    plugins: [react(), localApiChatPlugin(env.VITE_ANTHROPIC_KEY)],
    server: {
      allowedHosts: true,
    },
    // Воркер MediaPipe (раздел Motion) — ТОЛЬКО ES-модуль. Дефолт Vite здесь
    // 'iife', а при нём динамический import() внутри воркера не работает; весь
    // шим в src/motion/pose/poseWorker.js построен именно на нём. Симптом
    // поломки — «Can't find variable: document» на iOS, ровно та ошибка, которую
    // в Motion однажды уже чинили.
    worker: {
      format: 'es',
    },
    build: {
      // Явный target вместо дефолтного 'modules': дефолт тянет esnext-синтаксис,
      // и на движке постарше модуль просто не парсится — страница остаётся
      // белой, а в поле это выглядит как «приложение не открывается».
      // Safari 14 / Chrome 87 покрывают всё, где вообще работает MediaPipe.
      target: ['es2019', 'safari14', 'chrome87', 'firefox78'],
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('react-dom') || id.includes('/react/')) return 'vendor'
            if (id.includes('@supabase/supabase-js')) return 'supabase'
          }
        }
      }
    },
    /**
     * Транспиляция исходников — тем же таргетом, что и итоговая сборка.
     *
     * В Motion это поле называлось `esbuild`, но Vite 8 собирает через Rolldown
     * и трансформирует через oxc: `esbuild` он принимает, но молча игнорирует,
     * прямо говоря об этом в предупреждении. Имя другое, смысл тот же.
     */
    oxc: {
      target: 'es2019',
    },
  }
})
