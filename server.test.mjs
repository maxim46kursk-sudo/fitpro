// Обёртка под serverless-функции Vercel — server.mjs.
//
// Что здесь защищается. Переезд с Vercel означает, что среду для двенадцати
// боевых функций теперь делаем мы сами, а сами функции не трогаем. Ошибка в
// обёртке выглядит не как поломка обёртки, а как поломка функции — и ломается
// при этом самое дорогое:
//
//   1) СЫРОЕ ТЕЛО ВЕБХУКА. Подпись Продамуса считается по точной сырой форме
//      тела. Прочитай обёртка поток хоть однажды — подпись перестаёт сходиться,
//      уведомления об оплате молча отвергаются, деньги списаны, пакет не
//      начислен. Это уже случалось в проде по другой причине (ключ
//      идемпотентности), и стоило двух оплат.
//   2) ОБЫЧНЫЙ JSON-РОУТ. `req.query` и разобранный `req.body` — то, на чём
//      стоят все остальные одиннадцать функций.
//   3) СТАТИКА И ЗАГОЛОВКИ КЭША. Страница, закэшированная навсегда, ссылается
//      на хэшированные файлы, которых после выката больше нет: приложение не
//      открывается вообще, и у человека нет способа это починить.
//
// Тесты не ходят в сеть и не пишут в базу: настоящий вебхук вызывается только
// с ЗАВЕДОМО НЕВЕРНОЙ подписью, то есть отвечает 400 до единого обращения к
// Supabase. Прод-база у этого приложения общая с боевым, и тест, который в неё
// пишет, — это тест, который однажды спишет чьи-то деньги.

import { strict as assert } from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import qs from 'qs'
import { createSignature } from './api/_prodamus.js'

// Секрет и ключи — заведомо фиктивные: настоящие в тест не попадают, а с этими
// подпись боевого вебхука не сойдётся ни при каком стечении обстоятельств.
process.env.PRODAMUS_SECRET_KEY = 'test-secret-not-a-real-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-not-a-real-key'

const { createServer } = await import('./server.mjs')

let passed = 0, failed = 0
const results = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; results.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// ── Песочница: своя api/ и своя dist/ на диске ──────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fitpro-server-test-'))
const sandboxApi = path.join(sandbox, 'api')
const sandboxDist = path.join(sandbox, 'dist')
fs.mkdirSync(sandboxApi)
fs.mkdirSync(path.join(sandboxDist, 'assets'), { recursive: true })

// Путь к настоящему api/_prodamus.js — песочница лежит во временной папке, и
// относительный импорт оттуда до репозитория не дотянется.
const prodamusUrl = new URL('./api/_prodamus.js', import.meta.url).href
// qs — тоже абсолютным адресом: из временной папки обычный `import qs from 'qs'`
// не найдёт node_modules репозитория.
const qsUrl = import.meta.resolve('qs')

// Обработчик с сырым телом: то же соглашение, что у настоящего вебхука
// (`config.api.bodyParser === false`), и та же настоящая проверка подписи.
fs.writeFileSync(path.join(sandboxApi, 'raw-hook.js'), `
import qs from ${JSON.stringify(qsUrl)}
import { verifySignature } from ${JSON.stringify(prodamusUrl)}

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  const raw = await new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
  const data = qs.parse(raw)
  const provided = (req.headers['sign'] || data.signature || '').toString()
  if (!verifySignature(data, process.env.PRODAMUS_SECRET_KEY, provided)) {
    return res.status(400).send('Bad signature')
  }
  return res.status(200).json({ ok: true, order_num: data.order_num, rawLength: raw.length })
}
`)

// Обычная функция: query + разобранный JSON body + res.status().json().
fs.writeFileSync(path.join(sandboxApi, 'echo.js'), `
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  res.setHeader('X-From-Handler', 'yes')
  return res.status(201).json({ method: req.method, query: req.query, body: req.body })
}
`)

// Подставная set-exercise — на неё смотрит реврайт motion-health.
fs.writeFileSync(path.join(sandboxApi, 'set-exercise.js'), `
export default async function handler(req, res) {
  return res.status(200).json({ query: req.query })
}
`)

// Общий модуль с подчёркиванием: наружу его пускать нельзя.
fs.writeFileSync(path.join(sandboxApi, '_secret.js'), `
export default async function handler(req, res) { return res.status(200).send('LEAKED') }
`)

// Встроенный <script> здесь не для красоты: в боевом index.html их три, и
// именно их хэши CSP обязана посчитать сама. Без такого скрипта в песочнице
// проверка хэшей проверяла бы пустоту.
const ВСТРОЕННЫЙ = 'window.__boot = { stage: "html" }'
const ХЭШ_ВСТРОЕННОГО = crypto.createHash('sha256').update(ВСТРОЕННЫЙ, 'utf8').digest('base64')
fs.writeFileSync(
  path.join(sandboxDist, 'index.html'),
  `<!doctype html><title>FitPro</title><script>${ВСТРОЕННЫЙ}</script><div id=root></div>`,
)
fs.writeFileSync(path.join(sandboxDist, 'assets', 'index-abc123.js'), 'console.log("app")')

// ── Поднимаем сервер на свободном порту ─────────────────────────────────────
const server = createServer({ apiDir: sandboxApi, distDir: sandboxDist })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// Настоящий вебхук — отдельный сервер поверх настоящей api/ репозитория.
const realServer = createServer({
  apiDir: new URL('./api', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  distDir: sandboxDist,
})
await new Promise(resolve => realServer.listen(0, '127.0.0.1', resolve))
const realBase = `http://127.0.0.1:${realServer.address().port}`

console.log('\nОбёртка server.mjs\n')

// ══════════════════════════════════════════════════════════════════════════
// 1. ПОДПИСЬ ПРОДАМУСА НА СЫРОМ ТЕЛЕ
// ══════════════════════════════════════════════════════════════════════════

// Тело в той форме, в какой его шлёт Продамус: form-urlencoded с вложенными
// ключами products[0][name] — именно на них ломается наивный разбор.
const payload = {
  date: '2026-08-24T10:00:00+03:00',
  order_id: '47568192',
  order_num: '11111111-2222-3333-4444-555555555555__profit',
  sum: '2990.00',
  customer_phone: '+70000000000',
  payment_status: 'success',
  products: [{ name: 'ПРОФИТ', price: '2990.00', quantity: '1', sum: '2990.00' }],
}
const signature = createSignature(payload, process.env.PRODAMUS_SECRET_KEY)
const rawForm = qs.stringify(payload)

await test('подпись сходится: тело доходит до функции сырым, байт в байт', async () => {
  const res = await fetch(`${base}/api/raw-hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', sign: signature },
    body: rawForm,
  })
  const body = await res.json().catch(() => null)
  assert.equal(res.status, 200, `ожидали 200, получили ${res.status} — обёртка тронула тело, подпись не сошлась`)
  assert.equal(body.ok, true)
  assert.equal(body.order_num, payload.order_num)
  assert.equal(body.rawLength, Buffer.byteLength(rawForm), 'до функции доехало не всё тело')
})

await test('подпись в поле signature внутри тела — тоже сходится', async () => {
  const withField = { ...payload, signature }
  const res = await fetch(`${base}/api/raw-hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qs.stringify(withField),
  })
  assert.equal(res.status, 200, 'signature из тела должна проверяться так же, как заголовок sign')
})

await test('подделанное тело подпись не проходит', async () => {
  const tampered = qs.stringify({ ...payload, sum: '1.00' })
  const res = await fetch(`${base}/api/raw-hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', sign: signature },
    body: tampered,
  })
  assert.equal(res.status, 400)
})

await test('настоящий api/prodamus-webhook.js получает тело через обёртку', async () => {
  // Подпись заведомо неверная: функция обязана дойти до проверки и отказать
  // ИМЕННО на подписи. Ответ «Bad signature» доказывает, что тело прочиталось
  // и разобралось; 400 «Bad request» означал бы, что поток до неё не доехал.
  const res = await fetch(`${realBase}/api/prodamus-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', sign: 'deadbeef' },
    body: rawForm,
  })
  const text = await res.text()
  assert.equal(res.status, 400)
  assert.equal(text, 'Bad signature', `тело до функции не доехало: ответ «${text}»`)
})

await test('настоящий вебхук объявлен как принимающий сырое тело', async () => {
  const mod = await import('./api/prodamus-webhook.js')
  assert.equal(mod.config?.api?.bodyParser, false,
    'обёртка узнаёт сырое тело по этому флагу — исчезнет флаг, сломается подпись')
})

// ══════════════════════════════════════════════════════════════════════════
// 2. ОБЫЧНЫЙ JSON-РОУТ
// ══════════════════════════════════════════════════════════════════════════

await test('JSON-роут: разобранное тело, query и статус', async () => {
  const res = await fetch(`${base}/api/echo?action=save&n=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exercise: 'приседания', reps: 12 }),
  })
  const body = await res.json()
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('x-from-handler'), 'yes')
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(body.method, 'POST')
  assert.deepEqual(body.query, { action: 'save', n: '1' })
  assert.deepEqual(body.body, { exercise: 'приседания', reps: 12 })
})

await test('повторяющийся параметр приходит массивом, как у Vercel', async () => {
  const res = await fetch(`${base}/api/echo?id=1&id=2`)
  const body = await res.json()
  assert.deepEqual(body.query.id, ['1', '2'])
})

await test('пустое тело — undefined, а не падение', async () => {
  const res = await fetch(`${base}/api/echo`, { method: 'POST' })
  const body = await res.json()
  assert.equal(res.status, 201)
  assert.equal(body.body, undefined)
})

await test('битый JSON — 400, а не невнятная ошибка внутри функции', async () => {
  const res = await fetch(`${base}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{не json',
  })
  assert.equal(res.status, 400)
})

await test('OPTIONS доходит до функции: res.status(200).end()', async () => {
  const res = await fetch(`${base}/api/echo`, { method: 'OPTIONS' })
  assert.equal(res.status, 200)
})

await test('несуществующая функция — 404', async () => {
  const res = await fetch(`${base}/api/log`)
  assert.equal(res.status, 404)
})

await test('общий модуль с подчёркиванием наружу не отдаётся', async () => {
  const res = await fetch(`${base}/api/_secret`)
  assert.equal(res.status, 404, 'api/_secret.js — не эндпоинт, у Vercel это гарантировала платформа')
  assert.notEqual(await res.text(), 'LEAKED')
})

await test('реврайт /api/motion-health/<ключ> разворачивается в query', async () => {
  const res = await fetch(`${base}/api/motion-health/secret-key-123`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.deepEqual(body.query, { action: 'motion-health', key: 'secret-key-123' })
})

// ══════════════════════════════════════════════════════════════════════════
// 3. СТАТИКА И ЗАГОЛОВКИ КЭША
// ══════════════════════════════════════════════════════════════════════════

await test('корень отдаёт index.html и не кэшируется', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate')
  assert.match(await res.text(), /<div id=root>/)
})

await test('/index.html — те же заголовки, что у корня', async () => {
  const res = await fetch(`${base}/index.html`)
  assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate')
})

await test('/assets/* — год и immutable', async () => {
  const res = await fetch(`${base}/assets/index-abc123.js`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.match(res.headers.get('content-type'), /text\/javascript/)
})

await test('маршрут приложения отдаёт index.html (SPA)', async () => {
  const res = await fetch(`${base}/trainer/42`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate')
})

await test('промахнувшийся файл с расширением — честный 404', async () => {
  const res = await fetch(`${base}/assets/nope-00000000.js`)
  assert.equal(res.status, 404, 'иначе битый <script src> молча получает html')
})

await test('выход за пределы dist/ закрыт', async () => {
  const res = await fetch(`${base}/../server.mjs`)
  assert.ok(res.status === 403 || res.status === 404, `ожидали отказ, получили ${res.status}`)
  assert.doesNotMatch(await res.text(), /createRequestHandler/)
})

// ══════════════════════════════════════════════════════════════════════════
// 4. ЗАГОЛОВКИ БЕЗОПАСНОСТИ
// ══════════════════════════════════════════════════════════════════════════

await test('базовые заголовки стоят на статике и на api/', async () => {
  for (const адрес of [`${base}/`, `${base}/assets/index-abc123.js`, `${base}/api/echo?a=1`]) {
    const res = await fetch(адрес)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', адрес)
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', адрес)
    assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/, адрес)
  }
})

await test('CSP есть на документе и считает хэш встроенного скрипта', async () => {
  const res = await fetch(`${base}/`)
  const csp = res.headers.get('content-security-policy')
  assert.ok(csp, 'CSP на index.html обязана быть')
  assert.ok(
    csp.includes(`'sha256-${ХЭШ_ВСТРОЕННОГО}'`),
    'хэш не совпал — встроенные скрипты index.html будут заблокированы',
  )
  const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src'))
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, 'unsafe-inline в script-src обесценил бы всю политику')
  assert.match(scriptSrc, /'wasm-unsafe-eval'/, 'без этого не поднимется wasm MediaPipe')
  assert.match(csp, /connect-src[^;]*api\.fitproapp\.ru/, 'без этого приложение не достучится до базы')
  assert.match(csp, /worker-src[^;]*blob:/, 'без этого не запустится воркер позы')
})

await test('фреймить страницу может только Telegram', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy')
  assert.match(csp, /frame-ancestors 'self' https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/)
})

await test('CSP не вешается на картинки и скрипты', async () => {
  const res = await fetch(`${base}/assets/index-abc123.js`)
  assert.equal(res.headers.get('content-security-policy'), null)
})

// ── Итог ────────────────────────────────────────────────────────────────────
await new Promise(r => server.close(r))
await new Promise(r => realServer.close(r))
fs.rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${passed} прошло, ${failed} упало`)
if (failed) {
  console.log('\nПодробности:')
  for (const [name, e] of results) console.log(`\n— ${name}\n${e.stack}`)
  process.exit(1)
}
