// Проверка воронки на проде: гость проходит четыре первые ступени.
import { chromium } from 'playwright'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'

const BASE = 'https://fitproapp.ru'
const OUT = 'qa-screens/funnel'
const tid = (t) => `[data-testid="${t}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const R = {}

function env() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(l)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out
}
const K = env().SUPABASE_SERVICE_ROLE_KEY

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
const page = await ctx.newPage()

await page.goto(`${BASE}/?utm_source=проверка-воронки&utm_medium=пост`, { waitUntil: 'networkidle', timeout: 60000 })
await sleep(1500)

// согласие: галочка — свой квадрат 24×24, по центру ссылка на политику
for (let i = 0; i < 20; i++) {
  if (await page.locator(tid('consent-accept')).count()) {
    const box = await page.locator(tid('consent-check')).boundingBox().catch(() => null)
    if (box) await page.mouse.click(box.x + 12, box.y + 12)
    await sleep(300)
    await page.locator(tid('consent-accept')).click({ force: true }).catch(() => {})
    await sleep(1200)
    break
  }
  await sleep(500)
}

await page.locator('text=Начать').first().click().catch(() => {})
await sleep(2500)
R.гостьВошёл = (await page.locator('[data-screen]').count()) > 0

await page.locator(tid('tab-workouts')).click({ force: true }).catch(() => {})
await sleep(2000)
await page.locator(tid('program-folder-challenge')).click().catch(() => {})
await sleep(3000)
R.страницаОткрылась = (await page.locator(tid('challenge-screen')).count()) > 0
await page.screenshot({ path: `${OUT}/01-лендинг.png` })

// долистать до цены — до самого низа
await page.evaluate(() => {
  const v = document.querySelector('.mt-ch__view')
  if (v) v.scrollTop = v.scrollHeight
})
await sleep(1500)
await page.screenshot({ path: `${OUT}/02-долистал.png` })

// галочка правил и «Участвовать»
await page.locator(tid('challenge-agree')).click({ force: true }).catch(() => {})
await sleep(500)
await page.locator(tid('challenge-join')).click({ force: true }).catch(() => {})
await sleep(2500)
R.послеНажатия = await page.evaluate(() => document.body.innerText.slice(0, 90).replace(/\s+/g, ' '))
await page.screenshot({ path: `${OUT}/03-после-нажатия.png` })

// журнал уходит пачкой раз в десять секунд — ждём его, не закрывая вкладку
await sleep(13000)
R.vid = await page.evaluate(() => localStorage.getItem('fitpro.vid.v1'))
R.источник = await page.evaluate(() => localStorage.getItem('fitpro.src.v1'))
await ctx.close()
await b.close()

// дать отправке журнала доехать
await sleep(4000)

const r = await fetch('https://api.fitproapp.ru/rest/v1/motion_log?select=user_id,session,at,payload&order=at.desc&limit=8', {
  headers: { apikey: K, Authorization: `Bearer ${K}` },
})
const rows = await r.json()
const строки = []
for (const row of rows) for (const l of row.payload?.lines || []) if (l.includes('[challenge.')) строки.push({ user: row.user_id, line: l.slice(0, 200) })
R.вБазе = строки

console.log(JSON.stringify(R, null, 1))
