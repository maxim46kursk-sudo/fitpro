// Скриншоты всех экранов клиента и тренера на 390 и 320 px.
// Отдельно проверяет горизонтальную прокрутку — правка #root затрагивает
// ширину и границы, и уехавший вбок макет должен быть виден числом, а не на глаз.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const TAG = process.env.QA_TAG || 'до'
const OUT = `qa-screens/_ui/${TAG}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const overflow = []

const shoot = async (p, w, name) => {
  await sleep(1200)
  await p.screenshot({ path: `${OUT}/${w}-${name}.png`, fullPage: true })
  const bad = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
  if (bad) overflow.push(`${w}px ${name}`)
}

try {
  mkdirSync(OUT, { recursive: true })
  const [u] = await createUsers('ui' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({ headless: true })
  for (const w of [390, 320]) {
    const p = await (await b.newContext({ viewport: { width: w, height: 844 }, locale: 'ru-RU' })).newPage()
    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
    await shoot(p, w, '01-лендинг')
    await p.locator('text=Начать').first().click(); await sleep(700)
    await p.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(()=>{})
    await shoot(p, w, '02-форма-входа')
    await p.locator('input[type="email"]:visible').first().fill(u.email)
    await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
    await p.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
    await p.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
    if (await p.locator(tid('consent-accept')).count()) {
      await shoot(p, w, '03-согласие')
      await p.locator('text=Я даю согласие').first().click(); await sleep(300)
      await p.locator(tid('consent-accept')).click()
      await p.waitForSelector('[data-screen]', { timeout: 45000 })
    }
    await sleep(2000)
    for (const [id, name] of [['workouts','04-тренировки'],['nutrition','05-питание'],['library','06-упражнения'],['progress','07-прогресс']]) {
      await p.locator(tid(`tab-${id}`)).click({ timeout: 12000 }).catch(()=>{})
      await shoot(p, w, name)
    }
    // Профиль — там жаловались на «выступ» справа
    await p.locator('button:visible').first().click({ timeout: 8000 }).catch(()=>{}); await sleep(900)
    await shoot(p, w, '08-шторка-профиля')
    await p.locator('text=Мои данные').first().click({ timeout: 8000 }).catch(()=>{}); await sleep(1200)
    await shoot(p, w, '09-профиль')
    // Настройки
    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2000)
    await p.locator('button:visible').first().click({ timeout: 8000 }).catch(()=>{}); await sleep(900)
    await p.locator('text=Настройки').first().click({ timeout: 8000 }).catch(()=>{}); await sleep(1200)
    await shoot(p, w, '10-настройки')
    // Тренер
    await p.goto(BASE + '/?trainer=1', { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)
    await shoot(p, w, '11-тренер-главная')
    await p.locator(tid('tab-clients')).click({ timeout: 10000 }).catch(()=>{}); await sleep(1500)
    await shoot(p, w, '12-тренер-клиенты')
    await p.close()
  }
  await b.close()
} catch (e) { console.error('УПАЛО:', e.message.slice(0,200)) }
finally {
  await cleanupAll().catch(()=>{})
  console.log(`\n[${TAG}] горизонтальная прокрутка: ${overflow.length ? 'ЕСТЬ на ' + overflow.join(', ') : 'нигде нет'}`)
}
