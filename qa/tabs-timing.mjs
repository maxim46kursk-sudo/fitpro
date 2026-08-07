// Сколько НА САМОМ ДЕЛЕ занимает переключение вкладки.
//
// Прошлый отчёт называл 1241–1307 мс и делал вывод «не норма для SPA». Число
// оказалось артефактом ЗАМЕРА: внутри измеряемого шага стоял await sleep(1200),
// то есть мерилась пауза оснастки, а не приложение. Здесь пауз нет вовсе —
// засекаем от клика до момента, когда DOM показал новый раздел (data-screen),
// плюс отдельно считаем сетевые запросы на каждое переключение: если данные
// перезапрашиваются при каждом заходе, это видно по их числу.

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'http://localhost:5199'
const OUT = 'qa-screens/_tabs'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TABS = [['nutrition', 'Питание'], ['library', 'Упражнения'], ['progress', 'Дневник'], ['workouts', 'Тренировки']]

const R = { base: BASE, rounds: [] }
try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('tt' + String(Date.now()).slice(-4), 1)
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()

  const reqs = []
  page.on('request', r => reqs.push(r.url()))

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await page.locator('text=Начать бесплатно').first().click(); await sleep(700)
  await page.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await page.locator('input[type="email"]:visible').first().fill(user.email)
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await page.waitForSelector('[data-testid="consent-accept"], [data-screen]', { timeout: 45000 })
  if (await page.locator('[data-testid="consent-accept"]').count()) {
    await page.locator('text=Я даю согласие').first().click(); await sleep(300)
    await page.locator('[data-testid="consent-accept"]').click()
  }
  await page.waitForSelector('[data-screen]', { timeout: 45000 })
  await sleep(3000)   // даём догрузиться всему стартовому, чтобы не мерить его

  // Три круга по вкладкам. Первый заход на раздел может грузить данные, а
  // второй и третий — уже нет; разница между кругами и покажет, перезапрашивает
  // ли приложение то, что уже загружено.
  for (let round = 1; round <= 3; round++) {
    const row = { round, tabs: [] }
    for (const [id, name] of TABS) {
      reqs.length = 0
      const t0 = Date.now()
      await page.locator(`[data-testid="tab-${id}"]`).click({ timeout: 10000 })
      await page.waitForFunction(v => document.querySelector('[data-screen]')?.dataset.screen === v, id, { timeout: 15000 })
      const domMs = Date.now() - t0
      // Ждём чуть-чуть, чтобы поймать запросы, ушедшие после перерисовки.
      await sleep(900)
      const net = reqs.filter(u => /supabase|api\.fitproapp|\/rest\/v1|\/auth\/v1/.test(u))
      row.tabs.push({ tab: name, domMs, netCount: net.length, net: net.slice(0, 4).map(u => u.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)) })
    }
    R.rounds.push(row)
    console.log(`круг ${round}: ` + row.tabs.map(t => `${t.tab} ${t.domMs}мс/${t.netCount}зпр`).join('  '))
  }

  await browser.close()
} catch (e) { R.fatal = String(e.message).slice(0, 300); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 2), 'utf8')
  console.log('\n═══ ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК: ЧЕСТНЫЙ ЗАМЕР ═══')
  for (const r of R.rounds) for (const t of r.tabs) console.log(`  круг ${r.round}  ${t.tab.padEnd(12)} ${String(t.domMs).padStart(5)} мс   запросов: ${t.netCount}  ${t.net.join(' ')}`)
}
