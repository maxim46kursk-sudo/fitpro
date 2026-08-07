// Экран «Тарифы и подписка» висит на «Загрузка...» — разбор.
//
// Это тот самый экран, на котором новичок впервые говорит «да»: активирует
// пробный период. Если он не загружается, обрывается вход в продукт целиком —
// человек не может ни начать пробный, ни купить.
//
// Замеряем: сколько висит, дожидается ли вообще, какие запросы уходят, что в
// консоли. Отдельно — что именно грузится (loadProfile в PlansView) и не
// падает ли этот запрос.

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const PROD = 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens/_plans'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const R = { net: [], console: [] }
try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('ps' + String(Date.now()).slice(-4), 1)
  R.userId = user.id
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()

  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') R.console.push({ t: m.type(), text: m.text().slice(0, 300) }) })
  page.on('pageerror', e => R.console.push({ t: 'pageerror', text: String(e.message).slice(0, 300) }))
  page.on('response', async r => {
    const u = r.url()
    if (!/rest\/v1|auth\/v1|\/api\//.test(u)) return
    R.net.push({ status: r.status(), url: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 130) })
  })

  await page.goto(PROD, { waitUntil: 'networkidle', timeout: 60000 })
  await page.locator('text=Попробовать бесплатно').first().click(); await sleep(700)
  await page.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await page.locator('input[type="email"]:visible').first().fill(user.email)
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await page.waitForFunction(() => /Поехали|Тренировки/.test(document.body.innerText), { timeout: 45000 })
  if (await page.locator('text=Поехали').count()) {
    await page.locator('text=Я даю согласие').first().click(); await sleep(300)
    await page.getByRole('button', { name: /Поехали/ }).first().click()
    await page.waitForFunction(() => /Тренировки|Питание/.test(document.body.innerText), { timeout: 45000 })
  }
  await sleep(2500)

  // Открываем Настройки → Тарифы
  await page.locator('button:visible').first().click().catch(() => {}); await sleep(1000)
  await page.locator('text=Настройки').first().click({ timeout: 10000 }); await sleep(1200)
  R.netBeforePlans = R.net.length
  const t0 = Date.now()
  await page.locator('[data-testid="settings-plans"]').click({ timeout: 10000 })

  // Ждём до 40 секунд появления кнопки пробного ЛИБО любого содержимого
  let loadedMs = null
  try {
    await page.waitForFunction(() => !/Загрузка[.…]/.test(document.body.innerText), { timeout: 40000 })
    loadedMs = Date.now() - t0
  } catch { loadedMs = null }
  R.plansLoadedMs = loadedMs
  R.stillLoading = /Загрузка[.…]/.test(await page.evaluate(()=>document.body.innerText))
  R.trialButton = await page.locator('[data-testid="trial-start"]').count().catch(() => 0) > 0
  R.screenText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300)
  await page.screenshot({ path: `${OUT}/1-тарифы.png` })
  R.netOnPlans = R.net.slice(R.netBeforePlans)

  await browser.close()
} catch (e) { R.fatal = String(e.message).slice(0, 300); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 2), 'utf8')
  console.log('\n═══ ЭКРАН «ТАРИФЫ И ПОДПИСКА» ═══')
  console.log('загрузился за          :', R.plansLoadedMs === null ? 'НЕ ЗАГРУЗИЛСЯ за 40 с' : R.plansLoadedMs + ' мс')
  console.log('всё ещё «Загрузка...»  :', R.stillLoading)
  console.log('кнопка пробного есть   :', R.trialButton)
  console.log('текст экрана           :', R.screenText)
  console.log('запросы на этом экране :', JSON.stringify(R.netOnPlans, null, 1))
  console.log('консоль                :', JSON.stringify(R.console.slice(0, 6), null, 1))
}
