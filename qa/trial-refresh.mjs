// Вторая половина вопроса про пробный: данные он пишет правильно (проверено в
// trial-prod.mjs), но УЗНАЁТ ли об этом интерфейс СРАЗУ — или только после
// перезагрузки страницы.
//
// Подозрение из кода: PlansView.startTrial зовёт свой локальный loadProfile(),
// но НЕ зовёт onChanged() — а соседняя cancelSubscription зовёт (App.jsx:8373).
// access.level в App берётся из профиля App, и без onChanged он останется 0.
// Тогда человек нажал «Активировать», увидел «Пробный активирован» — и всё
// равно упирается в пейволл, пока не перезагрузит страницу.
//
// Проверяем ровно это: активируем ЧЕРЕЗ КНОПКУ и, НЕ перезагружая, идём в
// тренировку 5. Потом перезагружаем и идём туда же.

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const PROD = 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens/_trial'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const paywall = p => p.locator('text=/доступны в пакете/i').count().catch(() => 0)

const openWorkout5 = async page => {
  await page.locator('div:visible, button:visible').filter({ hasText: /^Тренировки$/ }).last().click().catch(() => {})
  await sleep(1500)
  await page.locator('text=Full Body').first().click({ timeout: 15000 }).catch(() => {}); await sleep(2000)
  await page.locator('text=Тренировка 5').first().click({ timeout: 15000 }).catch(() => {}); await sleep(2000)
  return await paywall(page) > 0
}

const R = {}
try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('tr' + String(Date.now()).slice(-4), 1)
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

  // Пейволл ДО активации — контрольная точка, что он вообще появляется.
  R.paywallBeforeTrial = await openWorkout5(page)
  await page.screenshot({ path: `${OUT}/ref-1-до-пробного.png` })
  for (const t of ['text=Закрыть', 'text=Отмена']) { const e = page.locator(t).first(); if (await e.count().catch(()=>0)) { await e.click().catch(()=>{}); break } }
  await sleep(800)

  // Активируем ЧЕРЕЗ ИНТЕРФЕЙС
  await page.goto(PROD, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)
  await page.locator('button:visible').first().click().catch(() => {}); await sleep(1000)
  await page.locator('text=Настройки').first().click({ timeout: 10000 }); await sleep(1200)
  await page.locator('text=Тарифы и подписка').first().click({ timeout: 10000 }); await sleep(2000)
  const btn = page.locator('button:visible').filter({ hasText: /Активировать пробный/ }).first()
  R.buttonFound = await btn.count().catch(() => 0) > 0
  if (R.buttonFound) { await btn.click({ timeout: 10000 }); await sleep(4000) }
  R.toast = await page.evaluate(() => document.body.innerText.match(/Пробный [^\n]{0,60}/)?.[0] || null).catch(() => null)
  await page.screenshot({ path: `${OUT}/ref-2-после-кнопки.png` })

  // БЕЗ перезагрузки — открывается ли тренировка 5
  R.paywallWithoutReload = await openWorkout5(page)
  await page.screenshot({ path: `${OUT}/ref-3-без-перезагрузки.png` })

  // С перезагрузкой
  await page.goto(PROD, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(3000)
  R.paywallAfterReload = await openWorkout5(page)
  await page.screenshot({ path: `${OUT}/ref-4-после-перезагрузки.png` })

  await browser.close()
} catch (e) { R.fatal = String(e.message).slice(0, 300); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/refresh-result.json`, JSON.stringify(R, null, 2), 'utf8')
  console.log('\n═══ УЗНАЁТ ЛИ ИНТЕРФЕЙС ОБ АКТИВАЦИИ СРАЗУ ═══')
  console.log('кнопка активации найдена       :', R.buttonFound)
  console.log('сообщение после нажатия        :', R.toast)
  console.log('пейволл ДО пробного            :', R.paywallBeforeTrial)
  console.log('пейволл БЕЗ перезагрузки       :', R.paywallWithoutReload)
  console.log('пейволл ПОСЛЕ перезагрузки     :', R.paywallAfterReload)
}
