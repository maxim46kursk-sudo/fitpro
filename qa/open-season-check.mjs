// ПРОДАЖИ ОТКРЫТЫ — ПРОВЕРКА ОБЫЧНЫМ ЧЕЛОВЕКОМ, А НЕ ТРЕНЕРОМ.
//
// Три вопроса, и все три про то, что человек видит СВОИМИ глазами:
//   1) цена, дата старта и доля фонда пришли ИЗ БАЗЫ, а не из запасных значений
//      в коде (в шапке обязано стоять «старт 10 сентября»);
//   2) кнопка «Участвовать — 2 990 ₽» живая и выписывает ссылку на оплату;
//   3) тренер по-прежнему видит СВОЙ тест-поток за 50 ₽, а не боевой.
//
// САМУ ОПЛАТУ НЕ ПРОВОДИМ. Проверяется, что ссылка выписана и на правильную
// сумму, — дальше деньги настоящие, и нажимать за человека нельзя.
//
// ЧЕЛОВЕК ЗАВОДИТСЯ НАСТОЯЩИЙ, с меткой qa-e2e- в почте, и удаляется в конце
// тем же способом, что и в остальных прогонах (qa/admin.mjs).
//
//   node qa/open-season-check.mjs
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const SUPA = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const OUT = 'qa-screens/open'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (t) => `[data-testid="${t}"]`
const R = {}

function loadEnv() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return out
}
const SERVICE = loadEnv().SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY')
const admin = (p, i) => fetch(`${SUPA}${p}`, {
  ...i,
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(i?.headers || {}) },
})

async function magicLink(email) {
  const b = await (await admin('/auth/v1/admin/generate_link', {
    method: 'POST', body: JSON.stringify({ type: 'magiclink', email, options: { redirect_to: BASE } }),
  })).json()
  const u = new URL(b?.action_link || b?.properties?.action_link)
  const s = new URL(SUPA); u.protocol = s.protocol; u.host = s.host
  return u.toString()
}

/** Экран согласия — слой ПОВЕРХ приложения, ждём именно его. */
async function пройтиСогласие(page, сек = 20) {
  for (let i = 0; i < сек * 2; i += 1) {
    if (await page.locator(tid('consent-accept')).count()) {
      const квадрат = await page.evaluate(() => {
        const span = [...document.querySelectorAll('span')]
          .find((e) => /^Я даю согласие на обработку/.test((e.textContent || '').trim()))
        const box = span?.parentElement?.children?.[0]?.getBoundingClientRect()
        return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null
      })
      if (квадрат) await page.mouse.click(квадрат.x, квадрат.y)
      await sleep(600)
      const btn = page.locator(tid('consent-accept'))
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click().catch(() => {})
        await page.waitForSelector('[data-screen]', { timeout: 60000 }).catch(() => {})
        return true
      }
    }
    await sleep(500)
  }
  return false
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
let shotNo = 0
const shot = async (page, name) => {
  shotNo += 1
  await page.screenshot({ path: `${OUT}/${String(shotNo).padStart(2, '0')}-${name}.png` })
}

// что в базе — чтобы сравнить с тем, что показали человеку
R.вБазе = await (await admin('/rest/v1/challenge_seasons?select=id,title,status,starts_on,price_rub,prize_pct&order=id')).json()

const b = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })

// ── ОБЫЧНЫЙ ЧЕЛОВЕК ────────────────────────────────────────────────────────
const email = `qa-e2e-open-${Date.now().toString().slice(-6)}@qa.fitproapp.ru`
let uid = null
try {
  const created = await (await admin('/auth/v1/admin/users', {
    method: 'POST', body: JSON.stringify({ email, password: 'QaE2E-passw0rd!', email_confirm: true }),
  })).json()
  uid = created?.id
  R.человек = email
  await admin('/rest/v1/profiles', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: uid, name: 'Обычный Человек' }),
  })

  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ru-RU', permissions: ['camera'] })).newPage()
  await page.goto(await magicLink(email), { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 60000 }).catch(() => {})
  // Ждём ЛЮБОЙ из двух: у нового человека первым встаёт согласие, у бывалого —
  // сразу приложение. Ждать только приложение значит ждать его из-под гейта.
  await page.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 60000 })
  await пройтиСогласие(page)
  await page.waitForSelector('[data-screen]', { timeout: 60000 })
  await sleep(2500)

  await page.locator(tid('tab-workouts')).click({ force: true })
  await sleep(2500)
  await page.locator(tid('program-folder-challenge')).click()
  await page.waitForSelector(tid('challenge-screen'), { timeout: 60000 })
  await sleep(3000)

  R.человекВидит = {
    шапка: await page.locator(tid('challenge-tag')).innerText().catch(() => null),
    цена: await page.locator(tid('challenge-price')).innerText().catch(() => null),
    доляФонда: await page.locator(tid('challenge-prize-pct')).innerText().catch(() => null),
    делёж: (await page.locator(tid('challenge-split')).innerText().catch(() => '')).replace(/\s+/g, ' '),
    кнопкаГероя: await page.locator(tid('challenge-hero-join')).innerText().catch(() => null),
  }
  await shot(page, 'обычный-шапка')

  // кнопка внизу: активна ли и выписывает ли ссылку
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="challenge-join"]')
    btn?.scrollIntoView({ block: 'center' })
  })
  await sleep(800)
  R.человекВидит.кнопкаОплаты = await page.locator(tid('challenge-join')).innerText().catch(() => null)
  // ДО галочки кнопка обязана быть выключена — «дочитал» и есть галочка.
  R.человекВидит.доГалочки = await page.locator(tid('challenge-join')).isEnabled().catch(() => null)
  await shot(page, 'обычный-кнопка')

  const ответ = page.waitForResponse((r) => r.url().includes('/api/create-payment'), { timeout: 40000 }).catch(() => null)
  await page.locator(tid('challenge-agree')).click()
  await sleep(400)
  R.человекВидит.послеГалочки = await page.locator(tid('challenge-join')).isEnabled().catch(() => null)
  await page.locator(tid('challenge-join')).click()
  const res = await ответ
  if (res) {
    const тело = await res.json().catch(() => ({}))
    const url = тело?.url ? new URL(тело.url) : null
    R.ссылкаНаОплату = {
      код: res.status(),
      сумма: url?.searchParams.get('products[0][price]') ?? null,
      товар: url?.searchParams.get('products[0][name]') ?? null,
      ярлык: url?.searchParams.get('order_id') ?? null,
      подписана: !!url?.searchParams.get('signature'),
      домен: url?.host ?? null,
    }
  } else {
    R.ссылкаНаОплату = 'ответа не было'
  }
  await sleep(1500)
  await shot(page, 'обычный-оплата')

  // согласие с правилами записалось в базу — это часть покупки
  R.согласиеВБазе = await (await admin(`/rest/v1/challenge_rules_consent?select=season_id&user_id=eq.${uid}`)).json()
} catch (e) {
  R.ошибкаЧеловек = e.message
}

// ── ТРЕНЕР: у него по-прежнему свой тест-поток ─────────────────────────────
try {
  const [trainer] = await (await admin('/rest/v1/profiles?select=id&role=eq.trainer&limit=1')).json()
  const user = await (await admin(`/auth/v1/admin/users/${trainer.id}`)).json()
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ru-RU', permissions: ['camera'] })).newPage()
  await page.goto(await magicLink(user.email), { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 60000 }).catch(() => {})
  await page.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 60000 })
  await пройтиСогласие(page)
  await page.waitForSelector('[data-screen]', { timeout: 60000 })
  await sleep(2500)
  await page.locator(tid('tab-workouts')).click({ force: true })
  await sleep(2500)
  await page.locator(tid('program-folder-challenge')).click()
  await page.waitForSelector(`${tid('stream-room')}, ${tid('challenge-screen')}`, { timeout: 60000 })
  await sleep(5000)

  R.тренерВидит = {
    комната: (await page.locator(tid('stream-room')).count()) > 0,
    день: await page.locator(tid('stream-day')).innerText().catch(() => null),
    номер: await page.locator(tid('stream-date')).innerText().catch(() => null),
    питание: (await page.locator(tid('stream-nutri-todo')).innerText().catch(() => '')).replace(/\s+/g, ' '),
  }
  await shot(page, 'тренер-комната')
} catch (e) {
  R.ошибкаТренер = e.message
}

await b.close()

// прибрать за собой
if (uid) {
  await admin(`/rest/v1/challenge_rules_consent?user_id=eq.${uid}`, { method: 'DELETE' }).catch(() => {})
  await admin(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' }).catch(() => {})
  R.человекУдалён = true
}

console.log(JSON.stringify(R, null, 2))
console.log(`\nснимки: ${OUT}/`)
