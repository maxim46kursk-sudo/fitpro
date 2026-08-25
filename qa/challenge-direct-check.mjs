#!/usr/bin/env node
/**
 * ПРЯМОЙ АДРЕС ЧЕЛЛЕНДЖА — проверка обоих на проде, гостем и без кэша.
 *
 * Проверяется ровно то, ради чего адрес заводился: человек из поста попадает
 * СРАЗУ на продающую страницу, метка источника доезжает до воронки, а «назад»
 * уводит из приложения, а не показывает дневник питания.
 *
 *   node qa/challenge-direct-check.mjs
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const OUT = 'qa-screens/direct'
const tid = (t) => `[data-testid="${t}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function env() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(l)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out
}
const K = env().SUPABASE_SERVICE_ROLE_KEY

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ headless: true })

/** Один адрес: открыть с чистого листа и посмотреть, что вышло. */
async function проверить(имя, адрес) {
  // Новый контекст на каждый адрес: свой localStorage, то есть свой посетитель
  // и своя метка источника. Иначе второй прогон унаследовал бы метку первого.
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
  const page = await ctx.newPage()
  const r = { адрес }

  await page.goto(`${BASE}${адрес}`, { waitUntil: 'networkidle', timeout: 60000 })
  await sleep(3500)

  r.страницаЧелленджа = (await page.locator(tid('challenge-screen')).count()) > 0
  r.цена = await page.locator(tid('challenge-price')).innerText().catch(() => null)
  r.главныйЭкранНеПоказан = (await page.locator(tid('tab-workouts')).isVisible().catch(() => false)) === false
  r.источник = await page.evaluate(() => localStorage.getItem('fitpro.src.v1'))
  r.vid = await page.evaluate(() => localStorage.getItem('fitpro.vid.v1'))
  await page.screenshot({ path: `${OUT}/${имя}.png` })

  /**
   * «Назад» обязана увести ИЗ приложения. Проверяем по адресу: если раздел
   * положил свою запись в историю, назад вернёт нас на тот же адрес с закрытым
   * разделом — то есть на главный экран, чего человек не просил.
   */
  await page.goBack({ timeout: 15000 }).catch(() => {})
  await sleep(1500)
  r.послеНазад = page.url()
  r.ушёлИзПриложения = !r.послеНазад.startsWith(BASE)

  await ctx.close()
  return r
}

const итог = {}
итог.путь = await проверить('01-путь', '/challenge?utm_source=пост-проверка&utm_medium=прямой')
итог.параметр = await проверить('02-параметр', '/?challenge=1&utm_source=пост-параметр&utm_medium=прямой')
await b.close()

// журнал уходит пачкой раз в десять секунд — ждём и смотрим, что доехало
await sleep(13000)
const q = await fetch('https://api.fitproapp.ru/rest/v1/motion_log?select=payload&order=at.desc&limit=10', {
  headers: { apikey: K, Authorization: `Bearer ${K}` },
})
const rows = await q.json()
итог.вЖурнале = []
for (const row of rows) {
  for (const l of row.payload?.lines || []) {
    if (l.includes('[challenge.') && l.includes('проверка')) итог.вЖурнале.push(l.slice(0, 170))
  }
}
console.log(JSON.stringify(итог, null, 1))
console.log(`\nснимки: ${OUT}/`)
