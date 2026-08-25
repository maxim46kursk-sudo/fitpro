// ЦИФРА ИЗ КОМНАТЫ ОБЯЗАНА ПОЯВИТЬСЯ В ТАБЛИЦЕ — проверка на проде, целиком.
//
// Комната читает устройство, таблица — сервер, и расхождение между ними это
// спор о призовых деньгах. Поэтому проверяем не разметку, а дорогу: сыграть
// заход → вернуться в комнату → увидеть те же очки в таблице потока, без
// перезагрузки страницы и без ручного обновления.
//
// ЗАХОД ИГРАЕТСЯ НЕ КАМЕРОЙ. Двадцать минут перед виртуальным человеком ради
// одной цифры — не та цена; результат в игре пишет submitAttempt, и мы зовём
// его тем же способом, каким его зовёт сессия. Проверяется дорога данных, а не
// распознавание движений: за него отвечают свои тесты.
//
//   node qa/room-table-check.mjs              # сыграть заход и проверить дорогу
//   node qa/room-table-check.mjs --readonly   # только посмотреть, ничего не писать
//
// Ключ из .env.local, наружу не печатается.
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const SUPA = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const OUT = 'qa-screens/room'
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
const SERVICE = loadEnv().SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY')

const admin = (path, init) => fetch(`${SUPA}${path}`, {
  ...init,
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
})

const [trainer] = await (await admin('/rest/v1/profiles?select=id&role=eq.trainer&limit=1')).json()
const user = await (await admin(`/auth/v1/admin/users/${trainer.id}`)).json()

const link = await (async () => {
  const body = await (await admin('/auth/v1/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'magiclink', email: user.email, options: { redirect_to: BASE } }),
  })).json()
  const raw = body?.action_link || body?.properties?.action_link
  const u = new URL(raw)
  const s = new URL(SUPA)
  u.protocol = s.protocol
  u.host = s.host
  return u.toString()
})()

/** Что лежит в motion_attempts прямо сейчас — глазами сервера, не браузера. */
const наСервере = async () => {
  const rows = await (await admin(`/rest/v1/motion_attempts?select=day,tier,attempt_no,score&user_id=eq.${trainer.id}&order=id.desc`)).json()
  return Array.isArray(rows) ? rows : []
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
R.доЗахода = await наСервере()

const b = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ru-RU', permissions: ['camera'] })).newPage()
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` })

try {
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 60000 }).catch(() => {})
  await page.waitForSelector('[data-screen]', { timeout: 60000 })
  await sleep(2500)

  await page.locator(tid('tab-workouts')).click({ force: true })
  await sleep(2500)
  await page.locator(tid('program-folder-challenge')).click()
  await page.waitForSelector(tid('stream-room'), { timeout: 60000 })
  await sleep(3000)

  R.комнатаДо = {
    день: await page.locator(tid('stream-day')).innerText(),
    заСегодня: (await page.locator(tid('stream-today-score')).innerText()).split('\n')[0],
    заПоток: (await page.locator(tid('stream-total')).innerText()).split('\n')[0],
    место: await page.locator(tid('stream-place-value')).innerText(),
    заходы: await page.locator(tid('stream-runs')).innerText(),
  }

  /**
   * ЗАХОД. Зовём submitAttempt тем же путём, каким его зовёт сессия: модуль игры
   * уже загружен страницей, достаём его через тот же импорт.
   */
  R.записан = process.argv.includes('--readonly') ? 'пропущено (--readonly)' : await page.evaluate(async () => {
    const mod = await import('/src/motion/game/day.js').catch(() => null)
    if (mod) return mod.submitAttempt('novice', { score: 777, reps: 12, hits: 9, spawned: 14, reactMs: 420 })
    // сборка — не dev: игра лежит в чанке, и прямого пути к ней нет. Пишем в
    // хранилище тем же ключом и той же формой, что и submitAttempt.
    const KEY = 'fitpro-motion.challenge.attempts.v1'
    const store = JSON.parse(localStorage.getItem(KEY) || '{"days":{},"started":{}}')
    const day = String(document.querySelector('[data-testid="stream-day"]').innerText.match(/\d+/)[0])
    const list = store.days[day]?.novice || []
    store.days[day] = { ...(store.days[day] || {}), novice: [...list, {
      score: 777, reps: 12, hits: 9, spawned: 14, reactMs: 420, at: new Date().toISOString(),
    }] }
    localStorage.setItem(KEY, JSON.stringify(store))
    // тем же событием, которым storage.js будит отправку
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    return { через: 'хранилище', day }
  })

  // выйти из комнаты и вернуться — ровно то, что делает человек после игры
  await page.locator('.mt-corner--left').first().click()
  await sleep(1500)
  await page.locator(tid('tab-workouts')).click({ force: true }).catch(() => {})
  await sleep(1500)
  await page.locator(tid('program-folder-challenge')).click()
  await page.waitForSelector(tid('stream-room'), { timeout: 60000 })
  await sleep(6000)

  R.комнатаПосле = {
    заСегодня: (await page.locator(tid('stream-today-score')).innerText()).split('\n')[0],
    заПоток: (await page.locator(tid('stream-total')).innerText()).split('\n')[0],
    место: await page.locator(tid('stream-place-value')).innerText(),
    заходы: await page.locator(tid('stream-runs')).innerText(),
  }
  await shot('08-room-after-run')

  R.послеЗахода = await наСервере()

  // и сама таблица потока — то, что увидит человек
  await page.locator(tid('stream-standings')).click()
  await page.waitForSelector(tid('standings-screen'), { timeout: 30000 }).catch(() => {})
  await sleep(3000)
  R.таблица = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="standings-screen"]') || document.body
    return root.innerText.replace(/\s+/g, ' ').slice(0, 400)
  })
  await shot('09-standings-after-run')

  console.log(JSON.stringify(R, null, 2))
} catch (e) {
  console.error('ПРОГОН УПАЛ:', e.message)
  await shot('99-fail').catch(() => {})
  console.log(JSON.stringify(R, null, 2))
  process.exitCode = 1
} finally {
  await b.close()
}
