// Регрессия формы входа после переделки стартового экрана. Её логику не
// трогали, но кнопки, которые в неё ведут, поменялись — проверяем оба входа.
import { chromium } from 'playwright'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = process.env.QA_BASE || 'http://localhost:5199'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const R = {}
try {
  const [u] = await createUsers('la' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({ headless: true })
  for (const w of [320, 390]) {
    const p = await (await b.newContext({ viewport: { width: w, height: 844 }, locale: 'ru-RU' })).newPage()
    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })

    // 1. «Войти» в шапке → форма входа
    await p.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click({ timeout: 10000 })
    await sleep(900)
    R[`${w}-шапка-Войти`] = await p.locator('input[type="email"]:visible').count() > 0

    // 2. «Назад» возвращает на стартовый
    await p.locator('[data-back="1"]:visible').first().click({ timeout: 8000 }); await sleep(800)
    R[`${w}-назад`] = await p.locator('text=Начать бесплатно').count() > 0

    // 3. «Начать бесплатно» → форма регистрации
    await p.locator('text=Начать бесплатно').first().click({ timeout: 10000 }); await sleep(900)
    R[`${w}-регистрация`] = await p.locator('text=Подтверди пароль').count() > 0

    // 4. Ссылка «Войти» в строке под кнопкой → форма входа
    await p.locator('[data-back="1"]:visible').first().click({ timeout: 8000 }); await sleep(800)
    await p.locator('text=Уже есть аккаунт').locator('button').first().click({ timeout: 8000 }); await sleep(900)
    R[`${w}-строка-Войти`] = await p.locator('input[type="email"]:visible').count() > 0 && await p.locator('text=Подтверди пароль').count() === 0

    // 5. Настоящий вход
    await p.locator('input[type="email"]:visible').first().fill(u.email)
    await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
    await p.locator('button:visible').filter({ hasText: /Войти →/ }).first().click({ timeout: 10000 })
    R[`${w}-ВХОД`] = await p.waitForSelector('[data-testid="consent-accept"], [data-screen]', { timeout: 45000 }).then(() => true).catch(() => false)
    await p.close()
  }
  await b.close()
} catch (e) { R.fatal = e.message.slice(0, 200); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(() => {})
  console.log('\n═══ ФОРМА ВХОДА ПОСЛЕ ПЕРЕДЕЛКИ ═══')
  for (const [k, v] of Object.entries(R)) console.log(`  ${v === true ? 'ok ' : 'НЕТ'} ${k}`)
}
