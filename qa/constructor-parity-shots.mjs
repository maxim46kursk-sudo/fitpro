// Снимки «конструктор рядом с тренировкой по шаблону» — для сверки механики.
//
// Оба экрана снимаются в ОДНИХ И ТЕХ ЖЕ состояниях и одним и тем же
// устройством, чтобы разницу было видно глазами, а не по описанию:
//   1) пустой экран (упражнений ещё нет),
//   2) добавлено упражнение с полями подходов,
//   3) заполнено и выставлена оценка нагрузки.
// Складывается в reports/constructor-ui/parity/ парами constructor-*/template-*.
//
// Прогон по боевой базе, фронт локальный (vite dev) — как остальные живые
// прогоны. Тестовому аккаунту временно выдаётся role='trainer' (конструктор
// виден только тренеру); аккаунт удаляется в finally.
//
// Запуск: node qa/constructor-parity-shots.mjs

import { chromium, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const PORT = Number(process.env.PARITY_PORT || 5217)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'reports/constructor-ui/parity'
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
  vite.stdout.on('data', () => {}); vite.stderr.on('data', () => {})
  await waitForServer()

  const [u] = await createUsers('pr' + String(Date.now()).slice(-5), 1)
  const r = await rest(`/profiles?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'trainer' }) })
  if (!r.ok) throw new Error(`роль тренера не выдалась: ${r.status} ${await r.text()}`)

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
    const file = `${OUT}/${name}.png`
    await p.screenshot({ path: file })
    shots.push(file)
    console.log(`  снято: ${file}`)
  }
  // Шаблонная тренировка при первом запуске показывает несколько обучающих
  // окон подряд (подтверждение программы, «Откуда взялся этот вес», привет от
  // ассистента, предупреждение о повторениях). Для сверки экранов они шум —
  // закрываем всё, что подвернулось, пока окна не кончатся.
  const dismissModals = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      const btn = p.locator('button:visible').filter({ hasText: /^(Понятно!?|Да, буду тренироваться по этой программе)$/ }).first()
      if (!(await btn.count())) return
      await btn.tap().catch(() => {})
      await sleep(800)
    }
  }
  const fillSets = async (kgSel, repsSel) => {
    const kg = p.locator(kgSel), reps = p.locator(repsSel)
    const n = Math.min(await kg.count(), await reps.count())
    for (let i = 0; i < n; i++) {
      await kg.nth(i).fill(String(40 + i * 5))
      await reps.nth(i).fill(String(12 - i))
    }
    await sleep(400)
  }

  // ── Конструктор ────────────────────────────────────────────────────────
  await p.locator(tid('tab-workouts')).tap(); await sleep(1500)
  await p.locator(tid('constructor-open')).scrollIntoViewIfNeeded()
  await p.locator(tid('constructor-open')).tap(); await sleep(1800)
  await shot('constructor-1-пустой')

  await p.locator(tid('constructor-add')).tap(); await sleep(900)
  await p.locator(tid('constructor-search')).fill('Приседания'); await sleep(700)
  await p.locator(tid('constructor-cat-item')).first().tap()
  await p.locator(tid('constructor-ex-card')).first().waitFor({ state: 'visible', timeout: 30000 })
  await sleep(900)
  await shot('constructor-2-упражнение')

  await fillSets(tid('constructor-kg'), tid('constructor-reps'))
  const ratingCount = await p.locator(tid('constructor-rating-4')).count()
  for (let i = 0; i < ratingCount; i++) { await p.locator(tid('constructor-rating-4')).nth(i).tap(); await sleep(250) }
  await p.locator(tid('constructor-rating-4')).first().scrollIntoViewIfNeeded(); await sleep(500)
  await shot('constructor-3-оценка')

  // Выходим без сохранения — снимки не должны оставлять данных.
  await p.locator(tid('constructor-close')).tap(); await sleep(700)
  await p.locator(tid('constructor-exit-discard')).tap(); await sleep(1800)

  // ── Тренировка по шаблону ──────────────────────────────────────────────
  await p.locator(tid('tab-workouts')).tap(); await sleep(1200)
  await p.locator(tid('program-folder-Full Body')).tap(); await sleep(1200)
  await p.locator(tid('program-slot-1')).tap(); await sleep(1400)
  await p.locator(tid('workout-start')).tap(); await sleep(1800)
  // На первом запуске приложение спрашивает подтверждение программы —
  // без него до самой тренировки дело не доходит.
  await dismissModals()
  await p.locator(tid('set-kg')).first().waitFor({ state: 'visible', timeout: 30000 })
  await sleep(700)
  await shot('template-2-упражнение')

  // У шаблонной повторения приходят из программы — их не трогаем (правка
  // повторений вызывает отдельное предупреждение и к сверке отношения не
  // имеет), заполняем только вес.
  const tplKg = p.locator(tid('set-kg'))
  const tplKgN = await tplKg.count()
  for (let i = 0; i < tplKgN; i++) await tplKg.nth(i).fill(String(40 + i * 5))
  await sleep(500)
  await dismissModals()
  // Доводим до того же состояния, что и у конструктора: выставлена оценка
  // нагрузки на рабочем подходе.
  const tplRating = p.locator('button:visible').filter({ hasText: /^4$/ })
  if (await tplRating.count()) {
    await tplRating.first().scrollIntoViewIfNeeded()
    await tplRating.first().tap(); await sleep(600)
  }
  await shot('template-3-оценка')

  // Пустое состояние шаблонной — когда упражнений в тренировке нет; его
  // достигаем, убрав все упражнения, поэтому снимаем последним.
  for (let i = 0; i < 12; i++) {
    const del = p.locator('button:visible').filter({ hasText: '🗑' }).first()
    if (!(await del.count())) break
    await del.tap(); await sleep(500)
    const confirm = p.locator('button:visible').filter({ hasText: /^Убрать$/ }).first()
    if (await confirm.count()) { await confirm.tap(); await sleep(600) }
  }
  await sleep(600)
  await shot('template-1-пустой')

  console.log(`\nГотово: ${shots.length} снимков в ${OUT}`)
} catch (e) {
  console.error('СНИМКИ НЕ СНЯТЫ:', e?.stack || String(e))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (vite) { try { vite.kill('SIGTERM') } catch { /* уже мёртв */ } }
  try { await cleanupAll() } catch (e) { console.error('ЧИСТКА НЕ ПРОШЛА, разобрать руками:', e) }
}

process.exit(process.exitCode || 0)
