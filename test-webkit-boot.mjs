/**
 * ПРИЛОЖЕНИЕ ОБЯЗАНО ОТКРЫВАТЬСЯ В WEBKIT — и обязано оживать после выкладки.
 *
 * Оба браузера на iPhone — Chrome и Safari — это WebKit, и до сих пор ни один
 * прогон его не трогал: все проверки ходили через chromium. Полевая жалоба
 * «прод не открывается на iPhone, белый экран в одном браузере и чёрный в
 * другом, на десктопе работает» проверять было нечем.
 *
 * ПРОВЕРЯЕТСЯ ДВА ЗАХОДА, и второй важнее первого.
 *
 *   1. Чистый заход: собранное приложение поднимается в WebKit без ошибок.
 *
 *   2. Заход с УСТАРЕВШЕЙ СТРАНИЦЕЙ В КЭШЕ. Имена файлов сборки содержат хэш и
 *      после каждой выкладки меняются, а старые с боевого адреса пропадают —
 *      отвечают 404 (проверено на fitproapp.ru). Телефон, у которого в кэше
 *      лежит вчерашняя страница, просит вчерашний файл и остаётся ни с чем:
 *      разметка пустая, стиль загрузился, человек видит ровно фон приложения.
 *      Тёмный в Safari — «чёрный экран»; со своим состоянием кэша в другом
 *      браузере — белый. Ни ошибки, ни объяснения.
 *
 *      Внутри приложения это не чинится: приложение в таком заходе НЕ
 *      ЗАПУСКАЕТСЯ вовсе. Страховка живёт в index.html, и здесь проверяется,
 *      что она срабатывает: один перезаход за свежей страницей — и приложение
 *      поднялось. А если и свежая не поднялась, человек видит текст, а не
 *      бесконечную перезагрузку.
 *
 * Запуск: npm run build && node test-webkit-boot.mjs
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { webkit, devices } from 'playwright'

const DIST = 'dist'
const PORT = 4191
const ждать = (ms) => new Promise((r) => setTimeout(r, ms))
const провалы = []

if (!existsSync(`${DIST}/index.html`)) {
  console.error('нет собранного приложения: сначала npm run build')
  process.exit(1)
}

const html = readFileSync(`${DIST}/index.html`, 'utf8')
/** Имя входного файла текущей сборки — его и «протухаем». */
const входной = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1]
if (!входной) {
  console.error('в собранной странице не нашёлся входной файл — проверка не построится')
  process.exit(1)
}

const ТИПЫ = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

/**
 * Сервер отдаёт устаревшую страницу столько раз, сколько сказано, а дальше —
 * настоящую. Один раз — это «страница из кэша, сервер уже обновился»; много —
 * «обновиться неоткуда».
 */
function поднять(устаревшихОтдач, { задержкаВходногоМс = 0 } = {}) {
  let отдано = 0
  const счёт = { страниц: 0 }
  const srv = createServer(async (req, res) => {
    const url = req.url.split('?')[0]
    if (url === '/' || url === '/index.html') счёт.страниц += 1
    if (задержкаВходногоМс && url.includes(входной)) await ждать(задержкаВходногоМс)
    if (url === '/' || url === '/index.html') {
      const протухшая = отдано < устаревшихОтдач
      отдано += 1
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(протухшая ? html.replaceAll(входной, 'index-СГИНУЛ0.js') : html)
      return
    }
    const file = DIST + url
    if (!existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const ext = url.slice(url.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': ТИПЫ[ext] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  srv.счёт = счёт
  return new Promise((r) => srv.listen(PORT, () => r(srv)))
}

async function заход(браузер, { ждатьМс }) {
  const ctx = await браузер.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' })
  const p = await ctx.newPage()
  const ошибки = []
  p.on('pageerror', (e) => ошибки.push(String(e.message)))
  await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 })
  await ждать(ждатьМс)
  const вид = await p.evaluate(() => ({
    узлов: document.getElementById('root')?.childElementCount ?? -1,
    текст: document.body.innerText.replace(/\s+/g, ' ').slice(0, 60),
  }))
  await ctx.close()
  return { ...вид, ошибки }
}

const браузер = await webkit.launch()

// ── 1. чистый заход ─────────────────────────────────────────────────────────
let srv = await поднять(0)
const чистый = await заход(браузер, { ждатьМс: 4000 })
srv.close()
console.log('чистый заход:', JSON.stringify(чистый))
if (чистый.узлов < 1) провалы.push('приложение не отрисовалось в WebKit')
if (чистый.ошибки.length) провалы.push('ошибки на чистом заходе: ' + чистый.ошибки.join(' | '))

// ── 2. устаревшая страница, сервер уже обновился ────────────────────────────
srv = await поднять(1)
// ждать дольше страховки в index.html: шесть секунд до перезахода плюс запуск
const после = await заход(браузер, { ждатьМс: 12000 })
srv.close()
console.log('устаревшая страница, сервер обновился:', JSON.stringify(после))
if (после.узлов < 1) провалы.push('после устаревшей страницы приложение не поднялось')

// ── 3. обновиться неоткуда: человек обязан увидеть текст, а не чёрный экран ──
srv = await поднять(99)
const безнадёжный = await заход(браузер, { ждатьМс: 16000 })
srv.close()
console.log('обновиться неоткуда:', JSON.stringify(безнадёжный))
if (!/обновилось/i.test(безнадёжный.текст)) {
  провалы.push('в безнадёжном случае вместо объяснения пустой экран: ' + безнадёжный.текст)
}

// ── 4. медленная связь: пусто долго, но файлы приехали — перезахода быть не должно ──
/**
 * Обратная опасность. Если чинить по признаку «через шесть секунд пусто», то на
 * плохой связи страховка начнёт перезагружать заход, который и так еле идёт, —
 * и человек не откроет приложение уже никогда. Повод для перезахода один:
 * файл НЕ ПРИЕХАЛ.
 */
srv = await поднять(0, { задержкаВходногоМс: 8000 })
const медленный = await заход(браузер, { ждатьМс: 14000 })
const страниц = srv.счёт.страниц
srv.close()
console.log('медленная связь:', JSON.stringify(медленный), '| запросов страницы:', страниц)
if (страниц !== 1) провалы.push(`на медленной связи страховка перезагрузила заход (${страниц} запроса страницы)`)
if (медленный.узлов < 1) провалы.push('на медленной связи приложение так и не поднялось')

await браузер.close()

if (провалы.length) {
  console.error('\nWEBKIT: ПРОВАЛ')
  provalsPrint()
  process.exit(1)
}
function provalsPrint() {
  for (const п of провалы) console.error('  - ' + п)
}
console.log('\nWEBKIT: приложение открывается и переживает выкладку')
