// ОДИН ВОПРОС: открывает ли пробный период доступ на самом деле.
//
// Подозрение из кода: api/start-trial.js честно пишет trial_until, а
// effectiveAccess честно считает по нему TRIAL_LEVEL=2 (ПРОФИТ) — то есть
// ДАННЫЕ правильные. Но PlansView после активации зовёт только свой локальный
// loadProfile() и НЕ зовёт onChanged() (в соседней функции отмены подписки —
// зовёт). Если так, App не перечитает профиль, access.level останется 0, и
// пейволлы продолжат висеть до перезагрузки страницы.
//
// Проверяем в три замера, чтобы отделить «данные не записались» от
// «интерфейс не узнал»:
//   1) что в profiles сразу после активации;
//   2) что показывает интерфейс БЕЗ перезагрузки;
//   3) что показывает интерфейс ПОСЛЕ перезагрузки.
// Разный ответ во 2 и 3 = данные в порядке, не обновляется интерфейс.

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
import { effectiveAccess } from '../src/plans.js'
import { readFileSync, existsSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'http://localhost:5199'
const OUT = 'qa-screens/_trial'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function srk() {
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue
    const m = readFileSync(f, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)$/m)
    if (m) return m[1].trim()
  }
  return null
}
const KEY = srk()
const dbProfile = async id => {
  const r = await fetch(`https://api.fitproapp.ru/rest/v1/profiles?id=eq.${id}&select=plan,plan_until,trial_until,trial_used,role`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  return (await r.json())[0] || null
}
// Виден ли пейволл прямо сейчас
const paywall = page => page.locator('text=/доступны в пакете|Доступно в пакете/i').count().catch(() => 0)

const result = { steps: [] }
try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('trial' + String(Date.now()).slice(-4), 1)
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await page.locator('text=Попробовать бесплатно').first().click(); await sleep(700)
  await page.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await page.locator('input[type="email"]:visible').first().fill(user.email)
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await page.waitForSelector('[data-testid="consent-accept"], [data-screen]', { timeout: 45000 })
  if (await page.locator('[data-testid="consent-accept"]').count()) {
    await page.locator('text=Я даю согласие').first().click(); await sleep(300)
    await page.locator('[data-testid="consent-accept"]').click()
  }
  await page.waitForSelector('[data-screen]', { timeout: 45000 }); await sleep(2000)

  // ── ДО активации ──
  result.before = { db: await dbProfile(user.id) }
  result.before.access = effectiveAccess(result.before.db)
  await page.screenshot({ path: `${OUT}/1-до.png` })

  // ── Активация пробного ──
  await page.locator('button:visible').first().click().catch(() => {}); await sleep(900)
  await page.locator('text=Настройки').first().click({ timeout: 10000 }); await sleep(1200)
  await page.locator('[data-testid="settings-plans"]').click({ timeout: 10000 }); await sleep(1800)
  await page.screenshot({ path: `${OUT}/2-тарифы.png` })
  const btn = page.locator('[data-testid="trial-start"]')
  result.trialButtonFound = await btn.count().catch(() => 0) > 0
  if (result.trialButtonFound) { await btn.click({ timeout: 10000 }); await sleep(4000) }
  await page.screenshot({ path: `${OUT}/3-после-активации.png` })

  // ── 1) Что в базе ──
  result.afterDb = await dbProfile(user.id)
  result.afterAccess = effectiveAccess(result.afterDb)

  // ── 2) Что видит интерфейс БЕЗ перезагрузки ──
  await page.locator('[data-testid="tab-workouts"]').click({ timeout: 10000 }); await sleep(1500)
  await page.locator('text=Full Body').first().click({ timeout: 10000 }); await sleep(1800)
  await page.locator('text=Тренировка 5').first().click({ timeout: 10000 }).catch(() => {})
  await sleep(1800)
  result.paywallWithoutReload = await paywall(page) > 0
  await page.screenshot({ path: `${OUT}/4-без-перезагрузки.png` })
  // Чем закрывается пейволл и перекрывает ли нижнее меню
  if (result.paywallWithoutReload) {
    result.paywallButtons = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null).map(b => (b.innerText || '').trim()).filter(Boolean))
    result.navClickableUnderPaywall = await page.locator('[data-testid="tab-nutrition"]').isEnabled().catch(() => null)
    // Пытаемся уйти по нижнему меню, не закрывая плашку
    let escaped = false
    try { await page.locator('[data-testid="tab-nutrition"]').click({ timeout: 4000 }); await sleep(1200); escaped = await paywall(page) === 0 } catch { escaped = false }
    result.canLeavePaywallViaNav = escaped
  }

  // ── 3) Что видит интерфейс ПОСЛЕ перезагрузки ──
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(3000)
  await page.locator('[data-testid="tab-workouts"]').click({ timeout: 10000 }).catch(() => {}); await sleep(1500)
  await page.locator('text=Full Body').first().click({ timeout: 10000 }).catch(() => {}); await sleep(1800)
  await page.locator('text=Тренировка 5').first().click({ timeout: 10000 }).catch(() => {})
  await sleep(1800)
  result.paywallAfterReload = await paywall(page) > 0
  await page.screenshot({ path: `${OUT}/5-после-перезагрузки.png` })

  await browser.close()
} catch (e) {
  result.fatal = String(e.message).slice(0, 300)
  console.error('УПАЛО:', result.fatal)
} finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2), 'utf8')
  console.log('\n════════ ОТКРЫВАЕТ ЛИ ПРОБНЫЙ ДОСТУП ════════')
  console.log('в базе ДО   :', JSON.stringify(result.before?.db))
  console.log('access ДО   :', JSON.stringify(result.before?.access))
  console.log('кнопка есть :', result.trialButtonFound)
  console.log('в базе ПОСЛЕ:', JSON.stringify(result.afterDb))
  console.log('access ПОСЛЕ:', JSON.stringify(result.afterAccess))
  console.log('пейволл БЕЗ перезагрузки :', result.paywallWithoutReload)
  console.log('пейволл ПОСЛЕ перезагрузки:', result.paywallAfterReload)
  console.log('кнопки на пейволле:', JSON.stringify(result.paywallButtons))
  console.log('нижнее меню кликабельно под пейволлом:', result.navClickableUnderPaywall)
  console.log('можно уйти с пейволла по меню       :', result.canLeavePaywallViaNav)
}
