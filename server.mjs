/**
 * СВОЙ СЕРВЕР ВМЕСТО VERCEL.
 *
 * Зачем: Vercel в России блокируется, и приложение переезжает на собственный
 * сервер. Двенадцать функций в api/ написаны под serverless-соглашение Vercel
 * (`export default handler(req, res)`, `req.query`, разобранный `req.body`,
 * `res.status().json()`), и переписывать их ради переезда нельзя: это боевой
 * код, работающий с деньгами и прод-базой. Поэтому здесь — обёртка, которая
 * даёт функциям ровно ту среду, к которой они привыкли, а сама живёт снаружи.
 *
 * Что делает:
 *   /api/<имя>                → api/<имя>.js, вызванный по-верселевски;
 *   /api/motion-health/<ключ> → реврайт в set-exercise?action=motion-health;
 *   /api/tg/<секрет>          → реврайт в set-exercise?action=tg (команды бота);
 *   всё остальное             → статика из dist/ с заголовками кэша.
 *
 * Чего НЕ делает: не сжимает (это Caddy), не занимается TLS (это Caddy), не
 * читает .env (это systemd через EnvironmentFile).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import qs from 'qs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * ПОТОЛОК ВРЕМЕНИ ОТВЕТА — 75 секунд.
 *
 * Считается от самой долгой функции: у chat.js `maxDuration = 60` (потолок
 * плана Hobby, под который её и писали), а внутри свой таймаут к Anthropic на
 * 55 секунд, чтобы успеть отдать осмысленный 503. Порежь сокет раньше — и
 * длинный ответ модели оборвётся ровно так, как он обрывался на Vercel без
 * maxDuration, только чинить будет нечего: платформы больше нет.
 *
 * 75 = 60 потолка функции + запас на сеть. То же число стоит в Caddyfile
 * (`transport http { read_timeout 75s }`) — прокси не должен сдаваться раньше
 * того, кого он проксирует.
 */
const REQUEST_TIMEOUT_MS = 75_000

/**
 * ПОТОЛОК РАЗМЕРА ТЕЛА — 10 МБ.
 *
 * У Vercel это 4.5 МБ и всё, что сейчас работает в проде, в них укладывается,
 * так что запас взят с той стороны, где ошибиться безопаснее. Тело сюда
 * приходит большим только из chat.js — распознавание этикетки шлёт картинку
 * в base64.
 */
const MAX_BODY_BYTES = 10 * 1024 * 1024

/**
 * ИМЯ ФУНКЦИИ — только строчные буквы, цифры и дефис.
 *
 * Подчёркивание в начале у Vercel означает «это не эндпоинт, это общий модуль»
 * (api/_prodamus.js, api/_logError.js и ещё четыре). Соглашение держалось на
 * самой платформе, и вместе с ней исчезает — поэтому оно повторено здесь явно.
 * Без этой строки `/api/_logError` стал бы публичной ручкой, а `..` в имени —
 * чтением любого файла на диске.
 */
const FUNCTION_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}
const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'

// ══════════════════════════════════════════════════════════════════════════
// ВЕРСЕЛЕВСКАЯ СЕМАНТИКА req/res
// ══════════════════════════════════════════════════════════════════════════

/**
 * `req.query` как у Vercel: значения строками, повторяющийся ключ — массивом.
 *
 * Второй аргумент — параметры, добытые реврайтом из пути (см. motion-health).
 * Они кладутся первыми и могут быть перекрыты настоящей строкой запроса, ровно
 * как у Vercel, где реврайт лишь достраивает адрес.
 */
function buildQuery(url, fromRewrite = {}) {
  const query = { ...fromRewrite }
  for (const [key, value] of url.searchParams) {
    if (key in query && !(key in fromRewrite)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value]
    } else {
      query[key] = value
    }
  }
  return query
}

/** Читает поток целиком, обрываясь на потолке размера. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Тело запроса больше потолка')
        err.code = 'BODY_TOO_LARGE'
        req.destroy(err)
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * `req.body` как у Vercel: разбор по Content-Type.
 *
 * json → объект, form-urlencoded → объект (через qs, как и в вебхуке), text/*
 * → строка, всё прочее → Buffer, пустое тело → undefined. Битый JSON у Vercel
 * даёт 400 ещё до функции — здесь так же, иначе функция получит undefined и
 * ответит невнятной ошибкой доступа вместо внятной ошибки разбора.
 */
function parseBody(raw, contentType) {
  if (!raw.length) return undefined
  const type = (contentType || '').split(';')[0].trim().toLowerCase()
  if (type === 'application/json') {
    const text = raw.toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      const err = new Error('Invalid JSON')
      err.code = 'BAD_JSON'
      throw err
    }
  }
  if (type === 'application/x-www-form-urlencoded') return qs.parse(raw.toString('utf8'))
  if (type.startsWith('text/')) return raw.toString('utf8')
  return raw
}

/**
 * Дополняет ServerResponse тем, чем его дополнял Vercel.
 *
 * Во всех двенадцати функциях используются ровно `res.status(N).json(...)`,
 * `.send(...)`, `.end()` и `res.setHeader` — поверхность маленькая, и повторить
 * её целиком дешевле, чем тащить Express ради трёх методов.
 */
function decorateResponse(res) {
  res.status = code => { res.statusCode = code; return res }
  res.json = payload => {
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(payload))
    return res
  }
  res.send = payload => {
    if (payload == null) { res.end(); return res }
    if (Buffer.isBuffer(payload)) {
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream')
      res.end(payload)
      return res
    }
    if (typeof payload === 'object') return res.json(payload)
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(String(payload))
    return res
  }
  return res
}

// ══════════════════════════════════════════════════════════════════════════
// ЗАГРУЗКА ФУНКЦИЙ
// ══════════════════════════════════════════════════════════════════════════

/**
 * Кэш загруженных модулей.
 *
 * У Vercel каждая функция — отдельный процесс с холодным стартом; здесь они
 * живут в одном и импортируются один раз. Для функций это незаметно (состояния
 * на уровне модуля у них нет, кроме счётчика rateLimit в _ratelimit.js — и ему
 * общий процесс идёт только на пользу: на Vercel счётчик разъезжался по
 * инстансам, здесь он наконец один).
 */
const moduleCache = new Map()

async function loadFunction(apiDir, name) {
  if (moduleCache.has(name)) return moduleCache.get(name)
  const file = path.join(apiDir, `${name}.js`)
  let loaded = null
  if (fs.existsSync(file)) {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.default === 'function') {
      loaded = {
        handler: mod.default,
        // `export const config = { api: { bodyParser: false } }` — единственный
        // способ, которым функция на Vercel просила не трогать её тело. Флаг
        // читается у модуля, а не сверяется со списком имён: так новый вебхук
        // получит сырое тело сам, без правки обёртки.
        rawBody: mod.config?.api?.bodyParser === false,
      }
    }
  }
  moduleCache.set(name, loaded)
  return loaded
}

// ══════════════════════════════════════════════════════════════════════════
// СТАТИКА
// ══════════════════════════════════════════════════════════════════════════

/**
 * Заголовки кэша — копия headers из vercel.json.
 *
 * `/assets/*` — год и immutable: имена файлов там с хэшем содержимого, меняется
 * содержимое — меняется имя. Страница — no-store: иначе человек после выката
 * остаётся на старом index.html, который ссылается на уже несуществующие
 * хэшированные файлы, и приложение просто не открывается.
 *
 * Продублировано в Caddyfile. Не «на всякий случай»: в Caddyfile оно потому,
 * что так было в vercel.json и там его будут искать, а здесь — потому, что
 * раздаёт файлы этот сервер, и правило не должно зависеть от того, кто стоит
 * перед ним.
 */
function cacheHeaderFor(urlPath) {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (urlPath === '/' || urlPath === '/index.html') return 'no-store, must-revalidate'
  return null
}

// ══════════════════════════════════════════════════════════════════════════
// ЗАГОЛОВКИ БЕЗОПАСНОСТИ
// ══════════════════════════════════════════════════════════════════════════

/**
 * Стоят ЗДЕСЬ, а не в Caddyfile, по той же причине, что и заголовки кэша:
 * раздаёт файлы этот сервер, и защита не должна зависеть от того, кто стоит
 * перед ним и не потеряется ли она при следующем переезде. Caddy их не
 * перетирает — он проксирует ответ как есть.
 */
const BASE_SECURITY_HEADERS = {
  // Браузер не имеет права угадывать тип: .json, отданный как текст, не должен
  // выполниться скриптом только потому, что похож на него.
  'X-Content-Type-Options': 'nosniff',
  // На чужой домен уходит только схема+хост, без пути. Пути здесь говорящие
  // (/trainer/<id>), и отдавать их наружу незачем.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  /**
   * КАМЕРА РАЗРЕШЕНА — НА НЕЙ ДЕРЖИТСЯ MOTION.
   *
   * `camera=(self)` даёт её своим страницам и запрещает любому встроенному
   * фрейму. Всё остальное выключено: приложение этого не просит, а выключенное
   * разрешение не может быть выпрошено чужим кодом, если он сюда попадёт.
   */
  'Permissions-Policy':
    'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=()',
}

/** Внешние адреса, без которых приложение не работает. */
const CDN = 'https://cdn.jsdelivr.net' // wasm MediaPipe, запасной источник
const MODELS = 'https://storage.googleapis.com' // модель позы, запасной источник
const API = 'https://api.fitproapp.ru' // Supabase: база, storage, видео
const PAY = 'https://maximathlete.payform.ru' // Продамус: страница оплаты

/**
 * ХЭШИ ВСТРОЕННЫХ СКРИПТОВ СЧИТАЮТСЯ ИЗ ФАЙЛА, А НЕ ПИШУТСЯ РУКАМИ.
 *
 * В index.html три инлайновых <script> — метки загрузки, страховка от чёрного
 * экрана и сторож. Все три обязаны выполняться раньше бандла, вынести их
 * наружу нельзя (в этом весь их смысл), а `'unsafe-inline'` обесценил бы CSP
 * целиком. Остаются хэши — и единственный способ, которым они не разъедутся с
 * файлом, это считать их из того же файла при отдаче.
 *
 * Кэш по mtime: заново считается только после выкладки нового index.html.
 */
let cspCache = { mtimeMs: -1, value: '' }

function inlineScriptHashes(html) {
  const out = []
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    out.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`)
  }
  return out
}

/**
 * Экспортируется ради tools/csp-check.mjs: сторож сборки обязан читать ТУ ЖЕ
 * политику, что уходит в ответ. Свою копию списка адресов он бы однажды не
 * обновил — и пропустил ровно то, ради чего заведён.
 */
export function buildCsp(html) {
  const scripts = ["'self'", "'wasm-unsafe-eval'", CDN, ...inlineScriptHashes(html)].join(' ')
  return [
    `default-src 'self'`,
    `base-uri 'none'`,
    `object-src 'none'`,
    // Вместо X-Frame-Options: DENY здесь не годится — SDK Telegram в head
    // остался, и возможность открыться внутри Telegram терять не за чем.
    `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org`,
    `form-action 'self' ${PAY}`,
    `frame-src 'self' ${PAY}`,
    `script-src ${scripts}`,
    // Воркер позы собирается Vite и может уехать в blob: — это свой же код.
    `worker-src 'self' blob:`,
    `child-src 'self' blob:`,
    // Стили пишутся в style={{...}} по всему приложению — это инлайн по
    // построению. В отличие от скриптов, дыры это не открывает.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${API}`,
    `media-src 'self' data: blob: ${API}`,
    `font-src 'self' data:`,
    // base — свой сервер и Supabase; остальные два — запасные источники wasm и
    // модели, когда своё зеркало недоступно (src/motion/pose/assets.js).
    `connect-src 'self' ${API} ${CDN} ${MODELS} blob: data:`,
    `manifest-src 'self'`,
  ].join('; ')
}

async function cspFor(indexFile) {
  const stat = await fsp.stat(indexFile).catch(() => null)
  if (!stat) return null
  if (cspCache.mtimeMs !== stat.mtimeMs) {
    cspCache = { mtimeMs: stat.mtimeMs, value: buildCsp(await fsp.readFile(indexFile, 'utf8')) }
  }
  return cspCache.value
}

/**
 * РЫЧАГ ОТКАТА. `CSP_REPORT_ONLY=1` в EnvironmentFile переводит политику в
 * режим наблюдения: браузер ругается в консоль, но ничего не блокирует.
 * Нужен ровно один раз — если после выкладки что-то отвалится, это способ
 * вернуть работу за перезапуск сервиса, не откатывая выкладку целиком.
 */
const CSP_HEADER =
  process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'

async function serveStatic(req, res, distDir, urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const target = path.resolve(distDir, relative)

  // Выход за пределы dist/ — единственная дыра, которую статика умеет открыть.
  if (target !== distDir && !target.startsWith(distDir + path.sep)) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  let file = target
  let stat = await fsp.stat(file).catch(() => null)

  /**
   * SPA-fallback: адрес без расширения — это маршрут приложения, а не файл.
   *
   * `/motion`, `/trainer/42` и прочее рисует React на клиенте, сервер о них не
   * знает и знать не должен. С расширением — честный 404: промахнувшийся
   * `<script src>` обязан выглядеть промахом, а не молча получать html.
   */
  if ((!stat || stat.isDirectory()) && !path.extname(relative)) {
    file = path.join(distDir, 'index.html')
    stat = await fsp.stat(file).catch(() => null)
    urlPath = '/index.html'
  }

  if (!stat || !stat.isFile()) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Not Found')
    return
  }

  const cache = cacheHeaderFor(urlPath)
  const type = mimeOf(file)
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Length', stat.size)
  if (cache) res.setHeader('Cache-Control', cache)

  // CSP имеет смысл только на документе: она управляет тем, что этому документу
  // позволено грузить и выполнять. Вешать её на картинку — лишние байты в каждом
  // ответе и ноль защиты.
  if (type.startsWith('text/html')) {
    const csp = await cspFor(file)
    if (csp) res.setHeader(CSP_HEADER, csp)
  }

  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file).pipe(res)
}

// ══════════════════════════════════════════════════════════════════════════
// МАРШРУТИЗАЦИЯ
// ══════════════════════════════════════════════════════════════════════════

/**
 * Реврайт из vercel.json: /api/motion-health/<ключ>.
 *
 * Ключ наблюдателя едет путём, а не строкой запроса, потому что клиент
 * наблюдателя строку запроса не доносит — «?» уезжает в путь закодированным.
 * Ветка в set-exercise.js о реврайте не знает: ей всё приходит как обычные
 * ?action=motion-health&key=..., и так должно остаться.
 */
function matchRewrite(pathname) {
  const m = /^\/api\/motion-health\/(.+)$/.exec(pathname)
  if (m) return { name: 'set-exercise', query: { action: 'motion-health', key: decodeURIComponent(m[1]) } }
  /**
   * Маячок невзлетевшей загрузки. Адрес без строки запроса намеренно: его шлёт
   * sendBeacon со страницы, у которой не поднялось НИЧЕГО, и чем короче и
   * неизменнее адрес, тем меньше поводов маячку не доехать. Ветка в
   * set-exercise.js о реврайте не знает — ей приходит обычный ?action=boot.
   */
  if (pathname === '/api/boot') return { name: 'set-exercise', query: { action: 'boot' } }
  /**
   * Вебхук Телеграм-бота: /api/tg/<секрет>.
   *
   * Секрет едет ПУТЁМ, а не строкой запроса, по той же причине, что и у
   * наблюдателя: адрес вебхука прописывается у Телеграма один раз через
   * setWebhook, и чем он короче и неизменнее, тем меньше поводов сломаться.
   * Ветка в set-exercise.js о реврайте не знает — ей приходит обычный
   * ?action=tg&key=...
   */
  const tg = /^\/api\/tg\/(.+)$/.exec(pathname)
  if (tg) return { name: 'set-exercise', query: { action: 'tg', key: decodeURIComponent(tg[1]) } }
  return null
}

export function createRequestHandler({ apiDir, distDir }) {
  const resolvedApi = path.resolve(apiDir)
  const resolvedDist = path.resolve(distDir)

  return async function handleRequest(req, res) {
    decorateResponse(res)
    // До всякой маршрутизации: эти три заголовка нужны и статике, и ответам
    // api/, и странице 404 — то есть всему, что уходит из процесса.
    for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(name, value)
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname

    if (!pathname.startsWith('/api/')) {
      try {
        await serveStatic(req, res, resolvedDist, pathname)
      } catch (e) {
        console.error('статика:', e)
        if (!res.headersSent) res.status(500).send('Internal Server Error')
      }
      return
    }

    const rewrite = matchRewrite(pathname)
    const name = rewrite ? rewrite.name : pathname.slice('/api/'.length)

    if (!FUNCTION_NAME_RE.test(name)) {
      res.status(404).json({ error: 'Not Found' })
      return
    }

    let fn
    try {
      fn = await loadFunction(resolvedApi, name)
    } catch (e) {
      console.error(`не удалось загрузить api/${name}.js:`, e)
      res.status(500).json({ error: 'Internal Server Error' })
      return
    }
    if (!fn) {
      res.status(404).json({ error: 'Not Found' })
      return
    }

    req.query = buildQuery(url, rewrite?.query)

    /**
     * СЫРОЕ ТЕЛО ДЛЯ ВЕБХУКА ПРОДАМУСА.
     *
     * Здесь поток НЕ ЧИТАЕТСЯ ВОВСЕ — req уходит в функцию нетронутым, и она
     * сама собирает его через req.on('data'). Прочитай мы тело хоть однажды —
     * подпись перестанет сходиться: она считается по точной сырой форме, и
     * любой репарсинг (порядок ключей, типы, повторная сборка строки) её ломает.
     * Цена ошибки — молча отвергаемые уведомления об оплате, то есть списанные
     * деньги без начисленного пакета.
     */
    if (!fn.rawBody) {
      try {
        req.body = parseBody(await readBody(req), req.headers['content-type'])
      } catch (e) {
        if (e.code === 'BAD_JSON') { res.status(400).json({ error: 'Invalid JSON' }); return }
        if (e.code === 'BODY_TOO_LARGE') { res.status(413).json({ error: 'Payload Too Large' }); return }
        console.error('чтение тела:', e)
        if (!res.headersSent) res.status(400).json({ error: 'Bad Request' })
        return
      }
    }

    // Столько же, сколько у самой долгой функции (chat), плюс запас на сеть.
    req.setTimeout(REQUEST_TIMEOUT_MS)
    res.setTimeout(REQUEST_TIMEOUT_MS)

    try {
      await fn.handler(req, res)
    } catch (e) {
      console.error(`api/${name}:`, e)
      if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' })
      else res.end()
    }
  }
}

export function createServer({ apiDir = path.join(HERE, 'api'), distDir = path.join(HERE, 'dist') } = {}) {
  const server = http.createServer(createRequestHandler({ apiDir, distDir }))
  // Ни одна из этих величин не должна оказаться меньше потолка функции: сокет,
  // закрытый платформой посреди ответа, — ровно та беда, от которой в chat.js
  // заведён свой таймаут на 55 секунд.
  server.requestTimeout = 0
  server.headersTimeout = REQUEST_TIMEOUT_MS + 5_000
  server.keepAliveTimeout = REQUEST_TIMEOUT_MS
  return server
}

// Запуск только при прямом вызове: тесты импортируют createServer сами.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT) || 3000
  const host = process.env.HOST || '127.0.0.1'
  createServer().listen(port, host, () => {
    console.log(`fitpro-app слушает http://${host}:${port}`)
  })
}
