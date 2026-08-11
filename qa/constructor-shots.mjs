// Снимки экрана Конструктора для сравнения «до/после» перекраски.
//
// Селекторы намеренно текстовые и структурные (кнопка «+», название
// упражнения), а НЕ data-testid: скрипт должен одинаково отработать и на
// старой версии экрана, и на новой, иначе снимки будут несопоставимы.
//
// Прогон по боевой базе, фронт локальный (vite dev) — как test-mobile-menus.mjs.
// Конструктор виден только тренеру, поэтому тестовому аккаунту временно
// выставляется role='trainer' (сервисный ключ для guard_profile_privileged
// привилегирован). Аккаунт удаляется в finally.
//
// Запуск: node qa/constructor-shots.mjs before
//         node qa/constructor-shots.mjs after

import { chromium, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const STAGE = process.argv[2] === 'after' ? 'after' : 'before'
const PORT = Number(process.env.SHOTS_PORT || 5213)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'reports/constructor-ui'
const SUPABASE_URL = 'https://api.fitproapp.ru'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

function loadSrk() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
}
const SRK = loadSrk()
const rest = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1${path}`, {
  ...init,
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
})

async function makeTrainer(userId) {
  const r = await rest(`/profiles?id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify({ role: 'trainer' }) })
  if (!r.ok) throw new Error(`не удалось выдать роль тренера: ${r.status} ${await r.text()}`)
}

async function waitForServer(timeoutMs = 90000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(BASE, { signal: AbortSignal.timeout(3000) })).ok) return } catch { /* поднимается */ }
    await sleep(500)
  }
  throw new Error(`dev-сервер не поднялся на ${BASE}`)
}

let vite = null, browser = null
const shots = []
try {
  if (!SRK) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY — см. qa/admin.mjs')
  mkdirSync(OUT, { recursive: true })
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stdout.on('data', () => {})
  vite.stderr.on('data', () => {})
  await waitForServer()

  const [u] = await createUsers('cs' + String(Date.now()).slice(-5), 1)
  await makeTrainer(u.id)

  browser = await chromium.launch({ headless: true })
  const p = await (await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' })).newPage()

  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await p.locator('text=Начать').first().click({ timeout: 30000 }); await sleep(700)
  await p.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await p.locator('input[type="email"]:visible').first().fill(u.email)
  await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await p.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await p.waitForSelector(`${tid('consent-accept')}, ${tid('tab-workouts')}`, { timeout: 60000 })
  if (await p.locator(tid('consent-accept')).count()) {
    await p.locator('text=Я даю согласие').first().click(); await sleep(300)
    await p.locator(tid('consent-accept')).click(); await sleep(1500)
  }
  await p.locator(tid('tab-workouts')).waitFor({ state: 'visible', timeout: 45000 })
  await sleep(2500)

  const shot = async (name) => {
    const file = `${OUT}/${STAGE}-${name}.png`
    await p.screenshot({ path: file })
    shots.push(file)
    console.log(`  снято: ${file}`)
  }

  // Вход в Конструктор — кнопка внизу списка программ, только у тренера.
  await p.locator(tid('tab-workouts')).tap(); await sleep(1500)
  await p.locator(tid('constructor-open')).scrollIntoViewIfNeeded()
  await shot('01-кнопка-входа')
  await p.locator(tid('constructor-open')).tap(); await sleep(1800)
  await shot('02-пустой-экран')

  // Каталог: «+» в нижней панели — единственная кнопка ровно с этим текстом.
  await p.locator('button').filter({ hasText: /^\+$/ }).first().tap(); await sleep(1000)
  await shot('03-каталог')

  // Поиск по названию.
  await p.locator('input[placeholder*="оиск"]').first().fill('присед'); await sleep(900)
  await shot('04-каталог-поиск')
  await p.locator('input[placeholder*="оиск"]').first().fill(''); await sleep(700)

  // Упражнение в сессии: baseline-карточка с полями веса/повторов.
  await p.locator('button:has-text("Приседания")').first().tap(); await sleep(2000)
  await shot('05-упражнение')

  // Заполненная карточка + оценка усилия.
  const kg = p.locator('input[inputmode="decimal"]')
  const reps = p.locator('input[inputmode="numeric"]')
  const n = Math.min(await kg.count(), await reps.count())
  for (let i = 0; i < n; i++) {
    await kg.nth(i).fill(String(40 + i * 5))
    await reps.nth(i).fill(String(12 - i))
  }
  await sleep(400)
  await p.locator('button').filter({ hasText: /^4$/ }).first().tap().catch(() => {})
  await sleep(600)
  await shot('06-заполнено')

  // Информационная плашка «как это работает».
  await p.locator('button[title="Как это работает"]').first().tap().catch(() => {})
  await sleep(900)
  await shot('07-справка')

  console.log(`\nГотово: ${shots.length} снимков со стадии «${STAGE}»`)
} catch (e) {
  console.error('СНИМКИ НЕ СНЯТЫ:', e?.stack || String(e))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (vite) { try { vite.kill('SIGTERM') } catch { /* уже мёртв */ } }
  try { await cleanupAll() } catch (e) { console.error('ЧИСТКА НЕ ПРОШЛА, разобрать руками:', e) }
}

// Явный выход обязателен: vite запущен через оболочку, её потоки держат
// event loop открытым и без этого процесс висит после последнего снимка.
process.exit(process.exitCode || 0)
