// Гипотеза: модель копирует ФОРМАТ старых записей из контекста.
// У нового пользователя дневник пуст, и ассистент пишет правильно. У живого
// там лежат записи старого вида («Завтрак: овсянка на воде 100г», meal=null),
// которые уходят в промпт как часть дневника — и модель их повторяет.
//
// Проверяем в лоб: заводим пользователя, ПОДСАЖИВАЕМ старую запись, просим
// записать завтрак и смотрим базу.
import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'
const BASE = 'https://fitproapp.ru'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const srk = () => { for (const f of ['.env.local', '.env']) { if (!existsSync(f)) continue
  const m = readFileSync(f, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)$/m); if (m) return m[1].trim() } return null }
const KEY = srk()
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const rows = async uid => (await (await fetch(
  `https://api.fitproapp.ru/rest/v1/food_diary?user_id=eq.${uid}&select=id,name,meal,kcal&order=id`, { headers: H })).json())
const today = () => { const d = new Date(); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}` }

try {
  const [u] = await createUsers('mm' + String(Date.now()).slice(-4), 1)
  // Старая запись — ровно того вида, что у тебя на скриншоте
  await fetch('https://api.fitproapp.ru/rest/v1/food_diary', { method: 'POST', headers: H,
    body: JSON.stringify({ user_id: u.id, date: today(), name: 'Завтрак: овсянка на воде 100г', kcal: 88, p: 3, c: 15, f: 2, meal: null }) })
  console.log('подсажена старая запись:', JSON.stringify(await rows(u.id)))

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

  await p.locator(tid('assistant-open')).click({ timeout: 12000 })
  await p.waitForSelector(tid('assistant-input'), { timeout: 25000 })
  await p.locator(tid('assistant-input')).fill('Запиши мне на завтрак овсянку 100 грамм и два яйца.')
  await p.locator(tid('assistant-send')).click()
  await sleep(30000)

  const r = await rows(u.id)
  console.log('\n═══ БАЗА ПОСЛЕ ЗАПРОСА ═══')
  r.forEach(e => console.log(`  meal=${String(e.meal).padEnd(9)} «${e.name}»`))
  const fresh = r.filter(e => e.name !== 'Завтрак: овсянка на воде 100г')
  console.log('\n  новых записей:', fresh.length)
  console.log('  из них с meal=null:', fresh.filter(e => e.meal === null).length)
  console.log('  из них с префиксом приёма:', fresh.filter(e => /^(Завтрак|Обед|Ужин|Перекус)\s*:/i.test(e.name)).length)
  console.log('  ВЕРДИКТ:', fresh.length && fresh.every(e => e.meal === 'breakfast') ? 'модель НЕ копирует старый формат' : 'модель КОПИРУЕТ старый формат')
  await b.close()
} catch (e) { console.error('УПАЛО:', e.message.slice(0,200)) }
finally { await cleanupAll().catch(()=>{}) }
