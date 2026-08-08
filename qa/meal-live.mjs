// Живая проверка приёмов пищи на ПРОДЕ. После каждого шага печатаем содержимое
// food_diary из базы — проверяем факт, а не слова ассистента.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const OUT = 'qa-screens/_meal'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const srk = () => { for (const f of ['.env.local', '.env']) { if (!existsSync(f)) continue
  const m = readFileSync(f, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)$/m); if (m) return m[1].trim() } return null }
const KEY = srk()
const rows = async uid => (await (await fetch(
  `https://api.fitproapp.ru/rest/v1/food_diary?user_id=eq.${uid}&select=id,name,meal,kcal&order=id`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json())
const show = (title, r) => {
  console.log(`\n─── ${title} ───`)
  if (!r.length) { console.log('   (пусто)'); return }
  r.forEach(e => console.log(`   id=${e.id}  meal=${String(e.meal).padEnd(9)}  «${e.name}»  ${e.kcal} ккал`))
}
try {
  mkdirSync(OUT, { recursive: true })
  const [u] = await createUsers('ml' + String(Date.now()).slice(-4), 1)
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
  await sleep(2000)
  await p.locator('button:visible').first().click({ timeout: 8000 }).catch(()=>{}); await sleep(900)
  await p.locator('text=Настройки').first().click({ timeout: 10000 }); await sleep(1200)
  await p.locator(tid('settings-plans')).click({ timeout: 10000 })
  await p.waitForSelector(tid('trial-start'), { timeout: 30000 }).catch(()=>{})
  if (await p.locator(tid('trial-start')).count()) { await p.locator(tid('trial-start')).click(); await sleep(3500) }
  await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)

  // Кнопка ассистента теперь должна быть видна СРАЗУ на стартовом экране
  const screen = await p.getAttribute('[data-screen]', 'data-screen')
  const fabOnStart = await p.locator(tid('assistant-open')).count() > 0
  console.log(`\nстартовый экран: ${screen}, кнопка ассистента видна сразу: ${fabOnStart ? 'ДА' : 'НЕТ'}`)

  await p.locator(tid('assistant-open')).click({ timeout: 12000 })
  await p.waitForSelector(tid('assistant-input'), { timeout: 25000 })
  const say = async (text, wait = 30000) => {
    await p.locator(tid('assistant-input')).fill(text)
    await p.locator(tid('assistant-send')).click()
    await sleep(wait)
    return (await p.evaluate(() => {
      const inp = document.querySelector('[data-testid="assistant-input"]')
      let n = inp; for (let i = 0; i < 8 && n; i++) { n = n.parentElement; if (n && n.scrollHeight > 300) break }
      return (n?.innerText || '').replace(/\s+/g, ' ')
    })).slice(-320)
  }

  console.log('\n══ ШАГ 1: завтрак из трёх продуктов ══')
  console.log('ответ:', await say('Запиши мне на завтрак: овсянка 90 грамм, два яйца и кофе с молоком 200 мл.'))
  show('база после шага 1', await rows(u.id))

  console.log('\n══ ШАГ 2: обед без явного названия приёма ══')
  console.log('ответ:', await say('Пообедал курицей с рисом, 200 грамм курицы и 150 грамм риса.'))
  show('база после шага 2', await rows(u.id))

  console.log('\n══ ШАГ 3: без указания приёма — должен спросить ══')
  console.log('ответ:', await say('Съел банан.'))
  show('база после шага 3', await rows(u.id))

  console.log('\n══ ШАГ 4: удалить один продукт из трёх ══')
  console.log('ответ:', await say('Удали яйца из завтрака.'))
  show('база после шага 4', await rows(u.id))

  await p.screenshot({ path: `${OUT}/чат.png` })
  await p.locator(tid('tab-nutrition')).click({ timeout: 12000 }).catch(()=>{}); await sleep(2500)
  await p.screenshot({ path: `${OUT}/дневник.png`, fullPage: true })
  await b.close()
} catch (e) { console.error('УПАЛО:', e.message.slice(0,200)) }
finally { await cleanupAll().catch(()=>{}) }
