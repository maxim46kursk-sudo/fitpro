// Проверка новой навигации: стартовый экран клиента, состав вкладок,
// дневник питания на своём новом месте и переключатель разделов.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = process.env.QA_BASE || 'http://localhost:5199'
const OUT = 'qa-screens/_nav'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const R = {}
try {
  mkdirSync(OUT, { recursive: true })
  const [u] = await createUsers('nv' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({ headless: true })
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()
  await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await p.locator('text=Начать').first().click(); await sleep(700)
  await p.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(()=>{})
  await p.locator('input[type="email"]:visible').first().fill(u.email)
  await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await p.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await p.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
  if (await p.locator(tid('consent-accept')).count()) {
    await p.locator('text=Я даю согласие').first().click(); await sleep(300)
    await p.locator(tid('consent-accept')).click(); await p.waitForSelector('[data-screen]', { timeout: 45000 })
  }
  await sleep(2500)

  R.стартовыйЭкран = await p.getAttribute('[data-screen]', 'data-screen')
  R.подписиВкладок = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="tab-"]')].map(b => b.innerText.trim()))
  await p.screenshot({ path: `${OUT}/1-старт-${R.стартовыйЭкран}.png` })

  for (const [id, name] of [['workouts','Тренировки'],['nutrition','Питание'],['library','Упражнения'],['progress','Прогресс']]) {
    await p.locator(tid(`tab-${id}`)).click({ timeout: 12000 }); await sleep(1800)
    await p.screenshot({ path: `${OUT}/вкладка-${name}.png` })
    R[`вкладка-${name}`] = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g,' ').slice(0, 130)
  }
  // Дневник питания — главный экран «Питания»?
  await p.locator(tid('tab-nutrition')).click({ timeout: 12000 }); await sleep(2000)
  R.питаниеСразуДневник = await p.locator(tid('meal-breakfast')).count() > 0
  R.перекл_дневник = await p.locator(tid('nutrition-tab-diary')).count() > 0
  R.перекл_рационы = await p.locator(tid('nutrition-tab-plans')).count() > 0
  await p.locator(tid('nutrition-tab-plans')).click({ timeout: 8000 }); await sleep(1500)
  R.рационыОткрылись = /Рацион/.test(await p.evaluate(() => document.body.innerText))
  await p.screenshot({ path: `${OUT}/питание-рационы.png` })
  await p.locator(tid('nutrition-tab-diary')).click({ timeout: 8000 }); await sleep(1500)
  R.вернулисьВДневник = await p.locator(tid('meal-breakfast')).count() > 0
  // Питания в «Прогрессе» больше нет?
  await p.locator(tid('tab-progress')).click({ timeout: 12000 }); await sleep(1800)
  const prog = await p.evaluate(() => document.body.innerText)
  R.вПрогрессеНетПитания = !/Дневник питания · макросы/.test(prog)
  R.заголовокПрогресс = /Прогресс/.test(prog)
  await b.close()
} catch (e) { R.fatal = e.message.slice(0,200); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(()=>{})
  console.log('\n═══ НАВИГАЦИЯ ═══')
  for (const [k,v] of Object.entries(R)) console.log(`  ${k}: ${typeof v==='boolean'?(v?'ok':'НЕТ'):JSON.stringify(v)}`)
}
