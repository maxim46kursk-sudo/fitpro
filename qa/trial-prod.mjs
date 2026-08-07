// ОТКРЫВАЕТ ЛИ ПРОБНЫЙ ПЕРИОД ДОСТУП — проверка на ПРОДЕ.
//
// На локальном dev-сервере эту проверку сделать нельзя: Vite проксирует только
// /api/chat (см. vite.config.js), а /api/start-trial там отдаёт 404 — пробный
// молча не активируется, и любой вывод был бы про оснастку, а не про продукт.
//
// Три независимых замера, чтобы отделить «данные не пишутся» от «интерфейс не
// узнал» и от «гейт считает неправильно»:
//   A. серверный путь: POST /api/start-trial токеном пользователя → что в profiles;
//   B. арифметика доступа: effectiveAccess на этой строке — какой уровень;
//   C. интерфейс на проде со СВЕЖЕЙ загрузкой (пробный уже активен) — есть ли пейволл.
// Отдельно: чем пейволл закрывается и держит ли он экран.

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD, ANON } from './admin.mjs'
import { effectiveAccess } from '../src/plans.js'

const PROD = 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens/_trial'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const srk = () => {
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
const paywall = page => page.locator('text=/доступны в пакете|Доступно в пакете/i').count().catch(() => 0)

const R = {}
try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('tp' + String(Date.now()).slice(-4), 1)
  R.email = user.email

  // Сессия пользователя — тем же путём, что и приложение (одноразовый код).
  const link = await (await fetch('https://api.fitproapp.ru/auth/v1/admin/generate_link', {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: user.email }),
  })).json()
  const sess = await (await fetch('https://api.fitproapp.ru/auth/v1/verify', {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email: user.email, token: link.email_otp }),
  })).json()
  const token = sess.access_token

  // ── A. Серверный путь ──
  R.beforeDb = await dbProfile(user.id)
  R.beforeAccess = effectiveAccess(R.beforeDb)
  const trialRes = await fetch(`${PROD}/api/start-trial`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
  R.trialStatus = trialRes.status
  R.trialBody = await trialRes.json().catch(() => null)
  await sleep(1200)
  R.afterDb = await dbProfile(user.id)

  // ── B. Арифметика доступа ──
  R.afterAccess = effectiveAccess(R.afterDb)

  // ── C. Интерфейс на проде, СВЕЖАЯ загрузка (пробный уже активен) ──
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()
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
  await page.screenshot({ path: `${OUT}/prod-1-главный.png` })

  // Тренировка 5 — та, что на СТАРТ закрыта
  await page.locator('div:visible, button:visible').filter({ hasText: /^Тренировки$/ }).last().click().catch(() => {})
  await sleep(1500)
  await page.locator('text=Full Body').first().click({ timeout: 15000 }); await sleep(2000)
  await page.locator('text=Тренировка 5').first().click({ timeout: 15000 }).catch(() => {}); await sleep(2000)
  R.paywallOnFreshLoad = await paywall(page) > 0
  await page.screenshot({ path: `${OUT}/prod-2-тренировка5.png` })

  if (R.paywallOnFreshLoad) {
    R.paywallButtons = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null).map(b => (b.innerText || '').trim()).filter(Boolean))
    // Перекрывает ли нижнее меню: пробуем уйти на другую вкладку не закрывая
    let left = false
    try {
      await page.locator('div:visible, button:visible').filter({ hasText: /^Питание$/ }).last().click({ timeout: 4000 })
      await sleep(1200); left = await paywall(page) === 0
    } catch { left = false }
    R.canLeaveViaNav = left
  }

  // Дневник питания и ассистент — доступны ли на пробном
  await page.goto(PROD, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)
  await page.locator('div:visible, button:visible').filter({ hasText: /^Дневник$/ }).last().click().catch(() => {}); await sleep(1500)
  R.diaryReachable = await page.locator('text=Дневник питания').count().catch(() => 0) > 0
  R.exerciseProgressLocked = await page.locator('text=/Доступно в пакете/i').count().catch(() => 0) > 0
  await page.screenshot({ path: `${OUT}/prod-3-дневник.png` })

  await browser.close()
} catch (e) {
  R.fatal = String(e.message).slice(0, 300)
  console.error('УПАЛО:', R.fatal)
} finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/prod-result.json`, JSON.stringify(R, null, 2), 'utf8')
  console.log('\n═══════ ОТКРЫВАЕТ ЛИ ПРОБНЫЙ ДОСТУП (ПРОД) ═══════')
  console.log('A. POST /api/start-trial →', R.trialStatus, JSON.stringify(R.trialBody))
  console.log('   profiles ДО   :', JSON.stringify(R.beforeDb))
  console.log('   profiles ПОСЛЕ:', JSON.stringify(R.afterDb))
  console.log('B. effectiveAccess ДО   :', JSON.stringify(R.beforeAccess))
  console.log('   effectiveAccess ПОСЛЕ:', JSON.stringify(R.afterAccess))
  console.log('C. пейволл на тренировке 5 при свежей загрузке:', R.paywallOnFreshLoad)
  console.log('   кнопки пейволла :', JSON.stringify(R.paywallButtons))
  console.log('   уйти по меню    :', R.canLeaveViaNav)
  console.log('   дневник питания доступен :', R.diaryReachable)
  console.log('   «прогресс» заблокирован  :', R.exerciseProgressLocked)
}
