// Проверка того, что переезд не порвал: собственный стек «назад» дневника,
// событие fitpro:diary-update от ассистента и применение готового рациона.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = process.env.QA_BASE || 'http://localhost:5199'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const R = {}
try {
  mkdirSync('qa-screens/_nav', { recursive: true })
  const [u] = await createUsers('nd' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({ headless: true })
  const p = await (await b.newContext({ viewport:{width:390,height:844}, locale:'ru-RU' })).newPage()
  await p.goto(BASE, { waitUntil:'networkidle', timeout:60000 })
  await p.locator('text=Начать').first().click(); await sleep(700)
  await p.locator('button:visible').filter({ hasText:/^Войти$/ }).first().click().catch(()=>{})
  await p.locator('input[type="email"]:visible').first().fill(u.email)
  await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await p.locator('button:visible').filter({ hasText:/Войти →/ }).first().click()
  await p.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout:45000 })
  if (await p.locator(tid('consent-accept')).count()) {
    await p.locator('text=Я даю согласие').first().click(); await sleep(300)
    await p.locator(tid('consent-accept')).click(); await p.waitForSelector('[data-screen]',{timeout:45000})
  }
  await sleep(2000)
  await p.locator(tid('tab-nutrition')).click({timeout:12000}); await sleep(2000)

  // 1. Стек «назад»: на дне стека стрелки быть НЕ должно
  R.наДнеСтекаНетСтрелки = await p.locator('[data-back="1"]:visible').count() === 0

  // 2. День → добавление еды → назад в день
  await p.locator(tid('meal-add-breakfast')).click({timeout:12000})
  await p.waitForSelector(tid('food-search-input'), { timeout:20000 })
  R.открылосьДобавление = true
  await p.locator('[data-back="1"]:visible').first().click({timeout:8000}); await sleep(1200)
  R.назадИзДобавления = await p.locator(tid('meal-breakfast')).count() > 0

  // 3. День → сводка → назад в день (стек глубиной 2)
  const gear = p.locator('[aria-label="Настройки питания"]').first()
  if (await gear.count()) { await gear.click({timeout:8000}); await sleep(700)
    await p.locator(tid('food-summary')).click({timeout:8000}); await sleep(2000)
    R.открыласьСводка = /Сводка/.test(await p.evaluate(()=>document.body.innerText))
    await p.locator('[data-back="1"]:visible').first().click({timeout:8000}); await sleep(1200)
    R.назадИзСводки = await p.locator(tid('meal-breakfast')).count() > 0
  }

  // 4. Событие ассистента fitpro:diary-update — дневник обязан перечитаться
  R.событиеНеУронило = await p.evaluate(async () => {
    window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
    await new Promise(r=>setTimeout(r,1500))
    return !!document.querySelector('[data-testid="meal-breakfast"]')
  })

  // 5. Применение готового рациона из соседнего раздела
  await p.locator(tid('nutrition-tab-plans')).click({timeout:8000}); await sleep(1500)
  const plan = p.locator('text=/Рацион/').first()
  if (await plan.count()) {
    await plan.click({timeout:8000}); await sleep(1500)
    const day = p.locator('text=/День 1|Пн/').first()
    if (await day.count()) { await day.click({timeout:8000}); await sleep(1500) }
    const apply = p.locator(tid("plan-apply")).first()
    R.кнопкаПримененияЕсть = await apply.count() > 0
    if (R.кнопкаПримененияЕсть) {
      await apply.click({timeout:10000}); await sleep(1200)
      const conf = p.locator(tid("plan-apply-confirm")).first()
      if (await conf.count()) { await conf.click({timeout:10000}); await sleep(3000) }
      await p.locator(tid('nutrition-tab-diary')).click({timeout:8000}).catch(()=>{})
      await sleep(2000)
      R.рационДоехалВДневник = /ккал/.test(await p.locator(tid('meal-breakfast')).innerText().catch(()=>'')) ||
        (await p.evaluate(()=>document.body.innerText)).match(/Итого за день/) !== null
    }
  }
  await p.screenshot({ path:'qa-screens/_nav/после-рациона.png' })
  await b.close()
} catch(e){ R.fatal = e.message.slice(0,160); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(()=>{})
  console.log('\n═══ ЛОМКИЕ МЕСТА ═══')
  for (const [k,v] of Object.entries(R)) console.log(`  ${typeof v==='boolean'?(v?'ok ':'НЕТ'):'   '} ${k}${typeof v==='boolean'?'':': '+v}`)
}
