#!/usr/bin/env node
/**
 * ПОЧЕМУ ВОРКЕР НЕ ПОДНИМАЕТСЯ НА WEBKIT — короткая проверка, без сессии.
 *
 * В поле у всех заходов с айфона воркер падает одинаково: «Can't find variable:
 * document», три попытки подряд (GPU/буфер, CPU/буфер, CPU/путь), после чего
 * работает резерв на главном потоке. Разбирать это полной сессией — восемнадцать
 * минут ради первых трёх секунд.
 *
 * Здесь поднимается ТОЛЬКО модель: страница прогона открывается в WebKit
 * (движок Safari и всех браузеров на iOS) с ключом `?motion-thread=worker`,
 * который запрещает откат на главный поток, — и мы смотрим, чем именно
 * закончилась инициализация и что воркер сообщил о своей обстановке.
 *
 * ПОРТ ЗАШИТ, как и в полном прогоне: адрес движка подставляется в сборку
 * (`VITE_MOTION_ASSETS_BASE`), то есть вмуровывается в файлы. Отсюда следствие —
 * эту проверку нельзя запускать одновременно с сессией: порт один.
 *
 *   node tools/motion-persona/worker-webkit.mjs             — webkit
 *   node tools/motion-persona/worker-webkit.mjs --engine chromium
 *   node tools/motion-persona/worker-webkit.mjs --no-build
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { extname, normalize } from 'node:path'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const ROOT = here('../../')
const DIST = here('../.cache/harness-dist')
const ASSETS = here('../.cache/motion-assets')
const WASM_DIR = `${ROOT}node_modules/@mediapipe/tasks-vision/wasm`
const PORT = 4194

const ENGINE = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : 'webkit'
const NO_BUILD = process.argv.includes('--no-build')

if (!NO_BUILD || !existsSync(`${DIST}/harness.html`)) {
  console.log('собираю страницу прогона…')
  const r = spawnSync('npx', ['vite', 'build', '--config', here('./vite.harness.config.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: true,
    env: { ...process.env, VITE_MOTION_ASSETS_BASE: `http://localhost:${PORT}/motion-assets` },
  })
  if (r.status !== 0) throw new Error('сборка страницы не удалась')
}

const ТИПЫ = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.task': 'application/octet-stream', '.map': 'application/json',
}

/** Ровно те же пути, что в run.mjs: страница собрана под них. */
function resolve(url) {
  if (url === '/' || url === '/harness.html') return `${DIST}/harness.html`
  const wasm = url.match(/^\/motion-assets\/tasks-vision\/[^/]+\/wasm\/(.+)$/)
  if (wasm) return `${WASM_DIR}/${normalize(wasm[1])}`
  const model = url.match(/^\/motion-assets\/models\/(.+)$/)
  if (model) return `${ASSETS}/models/${normalize(model[1])}`
  return `${DIST}${normalize(url)}`
}

const server = createServer((req, res) => {
  const file = resolve(req.url.split('?')[0])
  if (!existsSync(file) || !file.includes('.')) { res.writeHead(404); res.end('нет'); return }
  res.writeHead(200, { 'Content-Type': ТИПЫ[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r, rej) => { server.once('error', rej); server.listen(PORT, r) })

const pw = await import('playwright')
const browser = await pw[ENGINE].launch({ headless: true })
const page = await browser.newPage()

const события = []
page.on('console', (m) => {
  const t = m.text()
  if (/motion|worker|document|mediapipe|importScripts/i.test(t)) события.push(`консоль: ${t.slice(0, 300)}`)
})
page.on('pageerror', (e) => события.push(`ошибка страницы: ${String(e.message).slice(0, 300)}`))

await page.goto(`http://localhost:${PORT}/harness.html?motion-debug=1&motion-thread=worker&vt-seed=7`, {
  waitUntil: 'domcontentloaded',
})

/** Ждём первого из трёх: движок поднялся, отказал или отказ был подавлен. */
const итог = await page.waitForFunction(() => {
  const текст = window.__vt?.log?.() || ''
  const m = /\[(model\.ready|model\.error|worker\.fallback\.skipped)\]\s*(\{.*\})/.exec(текст)
  return m ? { тег: m[1], данные: m[2] } : null
}, null, { timeout: 120000, polling: 500 }).then((h) => h.jsonValue()).catch(() => null)

const весьЛог = await page.evaluate(() => window.__vt?.log?.() || '')
await browser.close()
server.close()

console.log(`\nдвижок браузера: ${ENGINE}`)
if (!итог) {
  console.log('за две минуты не дождались ни ready, ни error. Журнал:')
  console.log(весьЛог.split('\n').slice(0, 25).join('\n'))
} else {
  console.log(`итог: [${итог.тег}]`)
  try { console.log(JSON.stringify(JSON.parse(итог.данные), null, 1)) } catch { console.log(итог.данные) }
}
const важное = весьЛог.split('\n').filter((l) => /model\.|worker\.|assets\./.test(l))
if (важное.length) { console.log('\nстроки журнала:'); важное.slice(0, 12).forEach((l) => console.log('  ' + l.slice(0, 300))) }
if (события.length) { console.log('\nконсоль и ошибки:'); события.slice(0, 8).forEach((l) => console.log('  ' + l)) }
