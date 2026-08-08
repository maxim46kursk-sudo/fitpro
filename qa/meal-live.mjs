// Живая проверка: ассистент записывает завтрак из трёх продуктов — в дневнике
// должно оказаться ТРИ записи в секции «Завтрак», а не одна в «Без категории».
// Проверяем базу, а не слова ассистента и не текст на странице.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = process.env.QA_BASE || 'http://localhost:5199'
const OUT = 'qa-screens/_meal'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const srk = () => { for (const f of ['.env.local', '.env']) { if (!existsSync(f)) continue
  const m = readFileSync(f, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)$/m); if (m) return m[1].trim() } return null }
const KEY = srk()
const rows = async uid => (await (await fetch(
  `https://api.fitproapp.ru/rest/v1/food_diary?user_id=eq.${uid}&select=id,name,meal,kcal&order=id`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json())
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
  // Ассистент за гейтом ПРОФИТ. На локальной сборке /api/start-trial нет
  // (vite.config.js проксирует только /api/chat), поэтому пробный выдаём
  // прямо в базу — проверяем запись еды, а не путь активации.
  await fetch(`https://api.fitproapp.ru/rest/v1/profiles?id=eq.${u.id}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trial_until: new Date(Date.now() + 5 * 864e5).toISOString(), trial_used: true }),
  })
  await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(3000)

  // На вкладке «Тренировки» кнопка ассистента скрыта намеренно
  // (hideButton={isWorkoutForeground}) — уходим на другую вкладку.
  await p.locator(tid('tab-progress')).click({ timeout: 12000 }).catch(()=>{}); await sleep(2000)
  await p.locator(tid('assistant-open')).click({ timeout: 12000 })
  await p.waitForSelector(tid('assistant-input'), { timeout: 25000 })
  await p.locator(tid('assistant-input')).fill('Запиши мне на завтрак: овсянка 90 грамм, два яйца и кофе с молоком 200 мл.')
  await p.locator(tid('assistant-send')).click()
  await sleep(25000)
  await p.screenshot({ path: `${OUT}/чат.png` })

  const r = await rows(u.id)
  console.log('\n═══ ЧТО В БАЗЕ ═══')
  r.forEach(e => console.log(`  meal=${String(e.meal)}  «${e.name}»  ${e.kcal} ккал`))
  console.log('\n  записей:', r.length)
  console.log('  все в breakfast:', r.length > 0 && r.every(e => e.meal === 'breakfast'))
  console.log('  в «Без категории» (null):', r.filter(e => e.meal === null).length)
  console.log('  с префиксом приёма в названии:', r.filter(e => /^(Завтрак|Обед|Ужин|Перекус)\s*:/i.test(e.name)).length)

  await p.locator(tid('tab-nutrition')).click({ timeout: 12000 }).catch(()=>{}); await sleep(2500)
  await p.screenshot({ path: `${OUT}/дневник.png`, fullPage: true })
  await b.close()
} catch (e) { console.error('УПАЛО:', e.message.slice(0,200)) }
finally { await cleanupAll().catch(()=>{}) }
