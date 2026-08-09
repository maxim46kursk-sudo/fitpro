// Проверка пункта «полное название со вкусом и весом».
//
// ЧЕСТНАЯ ОГОВОРКА: это НЕ фотография реальной пачки — её у меня нет. Playwright
// рисует лицевую сторону упаковки как картинку (марка, линейка, вид, вкус, вес,
// без таблицы КБЖУ) и отправляет её в боевой /api/chat. Проверяется ровно одно:
// оставляет ли модель вкус и вес в поле name или отрезает их, как раньше.
// Качество распознавания настоящего снимка этим не измеряется.
import { chromium } from 'playwright'
import { createUsers, deleteUserFully, ANON, QA_PASSWORD } from './admin.mjs'

const BASE = 'https://fitproapp.ru'
const SUPA = 'https://api.fitproapp.ru'

const PACKS = [
  {
    barcode: '00990031',
    brand: 'NEO botanica', line: 'VITAMIN', kind: 'ЗЕФИР',
    flavour: 'с кусочками брусники', weight: '255 г',
    ждём: ['брусник', '255'],
  },
  {
    barcode: '00990032',
    brand: 'NEO botanica', line: 'VITAMIN', kind: 'ЗЕФИР',
    flavour: 'с кусочками облепихи', weight: '255 г',
    ждём: ['облепих', '255'],
  },
]

const html = p => `<div style="width:600px;height:800px;background:#f3ede2;font-family:Georgia,serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:40px;box-sizing:border-box">
  <div style="font-size:34px;letter-spacing:3px;color:#4a5d3a">${p.brand}</div>
  <div style="font-size:22px;letter-spacing:8px;color:#8a9a72">${p.line}</div>
  <div style="font-size:64px;font-weight:700;color:#2f3a24">${p.kind}</div>
  <div style="font-size:34px;color:#2f3a24">${p.flavour}</div>
  <div style="font-size:28px;color:#6b7a55;margin-top:28px">${p.weight}</div>
</div>`

const signIn = async email => {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password: QA_PASSWORD }),
  })
  const j = await r.json()
  if (!j?.access_token) throw new Error(`не вошёл: ${JSON.stringify(j).slice(0, 200)}`)
  return j.access_token
}

const runId = `lbl${Date.now().toString(36)}`
let users = []
const browser = await chromium.launch()

try {
  users = await createUsers(runId, 1)
  const token = await signIn(users[0].email)
  const page = await (await browser.newContext({ viewport: { width: 600, height: 800 } })).newPage()

  for (const p of PACKS) {
    await page.setContent(html(p))
    const shot = await page.screenshot({ type: 'jpeg', quality: 85 })

    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'food_label', barcode: p.barcode, image: shot.toString('base64') }),
    })
    const j = await r.json().catch(() => null)
    const pr = j?.product

    console.log(`\n══ ${p.kind} ${p.flavour} ${p.weight} ══`)
    console.log(`HTTP ${r.status}`)
    console.log(`name:  ${pr?.name ?? '(нет)'}`)
    console.log(`brand: ${pr?.brand ?? '(нет)'}`)
    console.log(`basis: ${pr?.basis} | КБЖУ: ${pr?.kcal100}/${pr?.p100}/${pr?.c100}/${pr?.f100}`)

    const name = String(pr?.name || '').toLowerCase()
    const missing = p.ждём.filter(w => !name.includes(w.toLowerCase()))
    console.log(missing.length
      ? `✗ в названии нет: ${missing.join(', ')}`
      : '✓ вкус и вес попали в название')
  }
} finally {
  await browser.close()
  for (const u of users) await deleteUserFully(u).catch(() => {})
  console.log('\nтестовый пользователь удалён')
}
