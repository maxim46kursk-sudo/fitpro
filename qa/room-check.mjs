// КОМНАТА УЧАСТНИКА НА ПРОДЕ, ПОД АККАУНТОМ ТРЕНЕРА — путь целиком.
//
// Тренировки → «Челлендж 30 дней» → комната → «Начать день N» → выбор уровня.
// Именно этот путь и был сломан: комната показывала квитанцию об оплате, а
// начать день из неё было нельзя вовсе.
//
// ВХОД — РАЗОВОЙ ССЫЛКОЙ, А НЕ ПАРОЛЕМ. Пароль владельца у прогона взяться
// неоткуда, а заводить второго тренера в боевой базе ради снимка — плохая цена
// за снимок. GoTrue умеет выписать одноразовую ссылку входа сервисным ключом
// (admin/generate_link): пароль она не меняет и живёт минуты.
//
//   node qa/room-check.mjs                # снимки в qa-screens/room/
//   node qa/room-check.mjs --headed       # смотреть глазами
//
// Ключ берётся из .env.local (гитигнорится). Наружу он не печатается.
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const SUPA = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const OUT = 'qa-screens/room'
const HEADED = process.argv.includes('--headed')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (t) => `[data-testid="${t}"]`
const R = {}

function loadEnv() {
  const out = {}
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return out
}

const env = loadEnv()
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY в .env / .env.local')

/** Почта владельца: ищем единственного тренера сервисным ключом. */
async function trainerEmail() {
  const res = await fetch(`${SUPA}/rest/v1/profiles?select=id&role=eq.trainer&limit=1`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })
  const [row] = await res.json()
  if (!row?.id) throw new Error('тренер не найден')
  const u = await fetch(`${SUPA}/auth/v1/admin/users/${row.id}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })
  const user = await u.json()
  if (!user?.email) throw new Error('у тренера нет почты')
  return user.email
}

/** Разовая ссылка входа. Пароль не трогается. */
async function magicLink(email) {
  const res = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email, options: { redirect_to: BASE } }),
  })
  const body = await res.json()
  const link = body?.action_link || body?.properties?.action_link
  if (!link) throw new Error(`generate_link: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  // ссылка выписана на SITE_URL — переставляем хост на тот, что проверяем
  const u = new URL(link)
  u.protocol = new URL(SUPA).protocol
  u.host = new URL(SUPA).host
  return u.toString()
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const page = await (await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: 'ru-RU',
  permissions: ['camera'],
})).newPage()

const shot = async (name, full = false) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full })
  return `${OUT}/${name}.png`
}

try {
  const email = await trainerEmail()
  R.вход = email.replace(/(.{2}).*(@.*)/, '$1***$2')

  await page.goto(await magicLink(email), { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 60000 }).catch(() => {})
  await page.waitForSelector('[data-screen]', { timeout: 60000 })
  await sleep(2500)

  // ── Тренировки → карточка челленджа ──────────────────────────────────────
  await page.locator(tid('tab-workouts')).click({ force: true })
  await sleep(2500)
  R.карточкаЧелленджа = (await page.locator(tid('program-folder-challenge')).count()) > 0
  await shot('01-workouts')

  await page.locator(tid('program-folder-challenge')).click()
  await page.waitForSelector(tid('challenge-screen'), { timeout: 60000 })
  await sleep(2500)

  // ── Комната ──────────────────────────────────────────────────────────────
  R.комнатаРабочая = (await page.locator(tid('stream-room')).count()) > 0
  R.квитанция = (await page.locator(tid('challenge-member')).count()) > 0
  R.кнопкаПонятно = (await page.locator(tid('challenge-room-exit')).count()) > 0
  R.деньВШапке = await page.locator(tid('stream-day')).innerText().catch(() => null)
  R.числоМесяца = await page.locator(tid('stream-date')).innerText().catch(() => null)
  R.состояниеДня = await page.locator(tid('stream-state')).innerText().catch(() => null)
  R.главнаяКнопка = await page.locator(tid('stream-start')).innerText().catch(() => null)
  R.кнопкаЖивая = await page.locator(tid('stream-start')).isEnabled().catch(() => null)
  R.заходы = await page.locator(tid('stream-runs')).innerText().catch(() => null)
  R.очкиСегодня = await page.locator(tid('stream-today-score')).innerText().catch(() => null)
  R.очкиЗаПоток = await page.locator(tid('stream-total')).innerText().catch(() => null)
  R.питаниеПроцент = await page.locator(tid('stream-nutri-pct')).innerText().catch(() => null)
  R.питаниеЧтоДелать = await page.locator(tid('stream-nutri-todo')).innerText().catch(() => null)
  R.остатокКкал = await page.locator(tid('stream-rest-kcal')).innerText().catch(() => null)
  R.место = await page.locator(tid('stream-place-value')).innerText().catch(() => null)
  R.правилаСсылка = (await page.locator(tid('stream-rules')).count()) > 0
  R.поздравление = await page.locator(tid('stream-greet')).innerText().catch(() => null)

  const текст = await page.locator(tid('stream-room')).innerText().catch(() => '')
  R.словаПроОплатуВЗаголовке = /Оплата прошла\. Дальше/.test(текст)
  R.естьПонятно = /Понятно/.test(текст)
  R.меньшеПриёмовНаружу = /меньше \d+ приёмов/.test(текст)

  await shot('02-room-top')
  /**
   * КОМНАТА ПРОКРУЧИВАЕТСЯ ВНУТРИ СЕБЯ, а не документом: раздел лежит поверх
   * приложения. Поэтому снимок «низа» берётся после прокрутки самого экрана —
   * fullPage тут снял бы страницу ПОД разделом и соврал бы про вёрстку.
   */
  R.высотаКомнаты = await page.evaluate(() => {
    const el = document.querySelector('.mt-stream')
    if (!el) return null
    el.scrollTop = el.scrollHeight
    return { видно: el.clientHeight, всего: el.scrollHeight, прокрутка: el.scrollTop }
  })
  await sleep(600)
  await shot('02-room-bottom')

  // календарь: сегодняшний, пропущенные, будущие
  R.календарь = await page.evaluate(() => {
    const out = {}
    for (const cell of document.querySelectorAll('[data-testid^="stream-cell-"]')) {
      const n = cell.getAttribute('data-testid').replace('stream-cell-', '')
      out[n] = { state: cell.dataset.state, text: cell.innerText.replace(/\s+/g, ' ').trim(), tag: cell.tagName }
    }
    return out
  })

  // ── Правила и обратно ────────────────────────────────────────────────────
  if (R.правилаСсылка) {
    await page.locator(tid('stream-rules')).click()
    await sleep(1200)
    R.правилаОткрылись = (await page.locator(tid('challenge-rules')).count()) > 0
    R.наПравилахЕстьПокупка = (await page.locator(tid('challenge-bar')).count()) > 0
      || (await page.locator(tid('challenge-hero-join')).count()) > 0
    await shot('03-rules')
    await page.locator(tid('challenge-rules-back')).click()
    await sleep(1200)
    R.вернулисьВКомнату = (await page.locator(tid('stream-room')).count()) > 0
  }

  // ── СТАРТ ДНЯ: главное, ради чего всё это ────────────────────────────────
  await page.locator(tid('stream-start')).click()
  await sleep(3000)
  R.послеСтартаЭкран = await page.evaluate(() => {
    const seen = ['mt-levels', 'mt-blocker', 'challenge-screen']
    return seen.filter((c) => document.querySelector(`.${c}, [data-testid="${c}"]`)).join(',') || '—'
  })
  // конвейер поднимается — ждём выбор уровня
  await page.waitForSelector(tid('level-novice'), { timeout: 90000 }).catch(() => {})
  R.выборУровняОткрылся = (await page.locator(tid('level-novice')).count()) > 0
  R.деньНаВыбореУровня = await page.locator(tid('challenge-day')).innerText().catch(() => null)
  R.заходыНаВыбореУровня = await page.locator(tid('runs-left')).innerText().catch(() => null)
  R.кнопкаПереходаКоДню = (await page.locator(tid('advance-day')).count()) > 0
  R.уровниДоступны = await page.evaluate(() =>
    ['novice', 'experienced', 'pro'].map((t) => {
      const el = document.querySelector(`[data-testid="level-${t}"]`)
      return el ? `${t}:${el.disabled ? 'закрыт' : 'открыт'}` : `${t}:нет`
    }).join(' '))

  /**
   * ВТОРОЙ КОМНАТЫ У УЧАСТНИКА БЫТЬ НЕ ДОЛЖНО. Кнопка «Моя комната» жила в трёх
   * местах игры; ищем её во всех сразу — и по имени тоже, чтобы не проверять
   * только те три, о которых мы помним.
   */
  R.кнопкаМояКомната = await page.evaluate(() => {
    const byId = ['open-room', 'calibration-room', 'boot-room']
      .filter((t) => document.querySelector(`[data-testid="${t}"]`))
    const byText = [...document.querySelectorAll('button')]
      .filter((b) => /Моя комната/i.test(b.innerText || '')).length
    return { поId: byId, поТексту: byText }
  })
  R.втораяКомнатаНаЭкране = (await page.locator(tid('room-screen')).count()) > 0
  await shot('04-levels')

  // ── ВОЗВРАТ: крестик выбора уровня ведёт в комнату участника ─────────────
  await page.locator('.mt-corner--left').first().click()
  await sleep(2500)
  R.послеКрестика = await page.evaluate(() => {
    if (document.querySelector('[data-testid="stream-room"]')) return 'комната участника'
    if (document.querySelector('[data-testid="room-screen"]')) return 'ВТОРАЯ КОМНАТА'
    if (document.querySelector('.mt-calib')) return 'постановка в кадр'
    return document.querySelector('[data-testid]')?.getAttribute('data-testid') || '—'
  })
  await shot('06-back-to-room')

  console.log(JSON.stringify(R, null, 2))
  console.log(`\nснимки: ${OUT}/`)
} catch (e) {
  console.error('ПРОГОН УПАЛ:', e.message)
  await shot('99-fail', true).catch(() => {})
  console.log(JSON.stringify(R, null, 2))
  process.exitCode = 1
} finally {
  await browser.close()
}
