#!/usr/bin/env node
/**
 * CSP НА ЖИВОМ ПРОДЕ: обойти три раздела и послушать консоль.
 *
 * test-guest.mjs проходит то же самое, но по локальному серверу и по собранному
 * dist. Здесь важно другое: та же ли политика уехала людям и не режет ли она
 * что-нибудь ровно на боевых адресах — своём Supabase, зеркале движка Motion,
 * кассе. Одна заблокированная строка в консоли здесь стоит больше, чем сто
 * зелёных проверок на локальной сборке.
 *
 * Ловим ВСЁ, что браузер говорит про политику: и console-сообщения, и события
 * securitypolicyviolation — второе надёжнее, потому что не зависит от текста.
 *
 *   node qa/csp-live-check.mjs
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const OUT = 'qa-screens/csp'
const tid = (t) => `[data-testid="${t}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
/**
 * КАМЕРА-ЗАГЛУШКА, и без неё проверка стоила бы немного: без камеры Motion
 * останавливается на «камера не включилась» и до самого требовательного к
 * политике места — воркера, wasm и зеркала движка на api.fitproapp.ru — просто
 * не доходит. Пиксели тут не важны, важно, что конвейер запускается.
 */
const b = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
const page = await ctx.newPage()

const нарушения = []
const ошибки = []
page.on('console', (m) => {
  const t = m.text()
  if (/Content Security Policy|Refused to/i.test(t)) нарушения.push(`консоль: ${t.slice(0, 220)}`)
})
page.on('pageerror', (e) => ошибки.push(String(e.message).slice(0, 200)))

// Событие браузера — источник надёжнее текста в консоли.
await page.addInitScript(() => {
  window.__csp = []
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push(`${e.effectiveDirective} ← ${String(e.blockedURI).slice(0, 120)}`)
  })
})

const шаги = []
async function шаг(имя, действие) {
  const было = нарушения.length
  await действие()
  const свежие = (await page.evaluate(() => window.__csp || [])).length
  шаги.push({ шаг: имя, новыхСтрокВКонсоли: нарушения.length - было, всегоСобытийCSP: свежие })
  await page.screenshot({ path: `${OUT}/${имя}.png` })
}

await шаг('01-главная', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await sleep(2000)
  // согласие: галочка — свой квадрат, по центру ссылка на политику
  for (let i = 0; i < 12; i++) {
    if (await page.locator(tid('consent-accept')).count()) {
      const box = await page.locator(tid('consent-check')).boundingBox().catch(() => null)
      if (box) await page.mouse.click(box.x + 12, box.y + 12)
      await sleep(300)
      await page.locator(tid('consent-accept')).click({ force: true }).catch(() => {})
      await sleep(1000)
      break
    }
    await sleep(400)
  }
  await page.locator('text=Начать').first().click().catch(() => {})
  await sleep(2500)
})

await шаг('02-motion', async () => {
  await page.locator(tid('tab-workouts')).click({ force: true }).catch(() => {})
  await sleep(2000)
  // карточка Motion: раздел с камерой — самый требовательный к политике
  // (воркер, wasm, blob:, зеркало движка на api.fitproapp.ru)
  await page.locator('text=Motion').first().click({ force: true }).catch(() => {})
  await sleep(6000)
})

await шаг('03-дневник', async () => {
  // Motion — это слой ПОВЕРХ приложения: пока он открыт, нажатие по нижним
  // вкладкам до них не доходит. Первый прогон так и остался на загрузке
  // модели, а «дневник проверен» было бы неправдой.
  await page.locator('.mt-corner').first().click({ force: true }).catch(() => {})
  await sleep(1500)
  await page.locator(tid('tab-nutrition')).click({ force: true }).catch(() => {})
  await sleep(3000)
})

// Поднялся ли движок распознавания: это и есть проверка worker-src/connect-src.
const движок = await page.evaluate(() => {
  const src = performance.getEntriesByType('resource').map((e) => e.name)
  return {
    воркер: src.some((u) => /poseWorker/.test(u)),
    модель: src.some((u) => /pose_landmarker|\.task/.test(u)),
    wasm: src.some((u) => /vision_wasm|\.wasm/.test(u)),
  }
})

const событияCSP = await page.evaluate(() => window.__csp || [])
await ctx.close()
await b.close()

console.log(JSON.stringify({ шаги, движок, событияCSP, строкиКонсоли: нарушения, ошибкиСтраницы: ошибки }, null, 1))
console.log(событияCSP.length || нарушения.length ? '\nCSP ЧТО-ТО ЗАБЛОКИРОВАЛА' : '\nCSP не заблокировала ничего')
console.log(`снимки: ${OUT}/`)
