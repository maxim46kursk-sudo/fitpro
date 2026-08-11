// test-mobile-menus.mjs — ЖИВОЙ прогон выпадающих меню пальцем на телефоне.
//
// ПОЧЕМУ НЕ jsdom. Баг, который здесь ловится, — не в логике React, а в
// hit-тесте браузера: прозрачный оверлей на весь экран (position:fixed внутри
// скролл-контейнера внутри портала) перехватывал касание ПОВЕРХ самого меню,
// и тап по пункту не доходил до кнопки. jsdom ничего не композитит и вызывает
// обработчик у того узла, которому его адресовали, — то есть проходит зелёным
// на заведомо сломанном коде. Поэтому тут настоящий Chromium, настоящий
// мобильный контекст (devices['iPhone 13'], hasTouch) и настоящие .tap().
//
// ЧТО ПРОВЕРЯЕТСЯ, для каждого из 7 меню приложения:
//   1) меню открывается тапом по своей кнопке;
//   2) КАЖДЫЙ пункт при тапе делает своё дело — проверяется наблюдаемым
//      следствием (открылась модалка, сменился экран, изменилось состояние,
//      появился диалог подтверждения), а НЕ тем, что меню закрылось: в
//      сломанной версии меню как раз закрывалось, а действие не выполнялось;
//   3) тап мимо меню — закрывает его.
// Плюс askConfirm: с Telegram.WebApp.showConfirm и без него.
//
// ПРОГОН ИДЁТ ПО БОЕВОЙ БАЗЕ — стенда нет (см. qa/run.mjs, тот же подход).
// Фронт при этом локальный (vite dev), потому что проверяются незапушенные
// правки. Тестовый пользователь заводится с меткой qa-e2e- и удаляется в
// finally, в том числе после падения.
//
// Запуск: node test-mobile-menus.mjs
// Требуется SUPABASE_SERVICE_ROLE_KEY в .env/.env.local (см. qa/admin.mjs).

import { chromium, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { createUsers, cleanupAll, QA_PASSWORD, ANON } from './qa/admin.mjs'

const PORT = Number(process.env.MENU_TEST_PORT || 5211)
const BASE = `http://127.0.0.1:${PORT}`
const SUPABASE_URL = 'https://api.fitproapp.ru'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

const rows = []
let passed = 0, failed = 0
const check = (section, name, ok, detail = '') => {
  rows.push({ section, name, ok, detail })
  if (ok) passed++; else failed++
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  [${section}] ${name}${!ok && detail ? `\n   → ${detail}` : ''}`)
}

// ── Служебное окружение прогона ──────────────────────────────────────────
function loadSrk() {
  // тот же способ, что в qa/admin.mjs — .env.local важнее .env
  const { readFileSync, existsSync } = require('node:fs')
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
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const SRK = loadSrk()

const srkHeaders = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' }
const rest = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, headers: { ...srkHeaders, Prefer: 'return=representation', ...(init.headers || {}) } })

// Пробный период — чтобы был открыт раздел «Прогресс по упражнениям»
// (accessLevel>=1). Сервисный ключ для guard_profile_privileged привилегирован.
async function grantTrial(userId) {
  const until = new Date(Date.now() + 7 * 86400000).toISOString()
  const r = await rest(`/profiles?id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify({ trial_until: until }) })
  if (!r.ok) throw new Error(`не удалось выдать пробный период: ${r.status} ${await r.text()}`)
}

// Одна завершённая тренировка в дневнике — без неё в «Моих тренировках» нет
// ни карточек, ни меню карточки, ни панели выбранной тренировки.
async function seedWorkout(userId) {
  const date = new Date().toISOString().slice(0, 10)
  const wr = await rest('/workouts', { method: 'POST', body: JSON.stringify({ user_id: userId, name: 'QA тренировка', color: '#7C7AF0', date, duration: 1800, comment: '' }) })
  if (!wr.ok) throw new Error(`не удалось создать тренировку: ${wr.status} ${await wr.text()}`)
  const workoutId = (await wr.json())[0].id
  const sets = [
    { user_id: userId, workout_id: workoutId, exercise: 'Приседания', date, kg: 40, reps: 12, rating: 3 },
    { user_id: userId, workout_id: workoutId, exercise: 'Приседания', date, kg: 45, reps: 10, rating: 4 },
  ]
  const sr = await rest('/workout_sets', { method: 'POST', body: JSON.stringify(sets) })
  if (!sr.ok) throw new Error(`не удалось создать подходы: ${sr.status} ${await sr.text()}`)
}

function startDevServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', d => process.env.MENU_TEST_VERBOSE && console.error('[vite]', String(d).trim()))
  return child
}

async function waitForServer(timeoutMs = 90000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) })
      if (r.ok) return true
    } catch { /* сервер ещё поднимается */ }
    await sleep(500)
  }
  throw new Error(`dev-сервер не поднялся на ${BASE} за ${timeoutMs} мс`)
}

// ── Помощники страницы ───────────────────────────────────────────────────
const visible = async (p, t) => await p.locator(tid(t)).isVisible().catch(() => false)

// Ловушка window.confirm/Telegram: приложение спрашивает подтверждение через
// askConfirm. В обычном браузере это window.confirm — Playwright отдаёт его
// событием dialog. Записываем текст и ВСЕГДА отклоняем: цель теста —
// доказать, что обработчик пункта дошёл до подтверждения, а не удалять данные.
function trapDialogs(page) {
  const seen = []
  page.on('dialog', async d => { seen.push(d.message()); await d.dismiss().catch(() => {}) })
  return seen
}

// Экраны второго уровня (тренировка программы, разделы Дневника) рисуются
// полноэкранными порталами поверх нижнего меню — пока такой портал открыт,
// таб-бар физически недоступен для тапа. Поэтому перед переходом по вкладке
// закрываем всё открытое кнопкой «назад», сколько бы уровней ни было.
async function closeOverlays(p, limit = 4) {
  for (let i = 0; i < limit; i++) {
    const bar = p.locator(tid('tab-workouts'))
    if (await bar.count() && await bar.isVisible().catch(() => false)) {
      const blocked = await bar.evaluate(el => {
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !el.contains(top)
      }).catch(() => true)
      if (!blocked) return
    }
    const back = p.locator('[data-back="1"]:visible').last()
    if (await back.count()) {
      await back.tap().catch(() => {})
      await sleep(700)
      continue
    }
    // Кнопки «назад» нет — сверху висит модалка. Такие в приложении
    // закрываются тапом по затемнённому фону.
    await p.touchscreen.tap(12, 12).catch(() => {})
    await sleep(600)
  }
}

async function openTab(p, tab) {
  await closeOverlays(p)
  await p.locator(tid(`tab-${tab}`)).tap()
  await sleep(1200)
}

async function gotoDiarySection(p, key) {
  await openTab(p, 'progress')
  // Внутри Дневника мог остаться открытым другой раздел — тоже портал.
  for (let i = 0; i < 3; i++) {
    if (await p.locator(tid(`diary-section-${key}`)).isVisible().catch(() => false)) break
    const back = p.locator('[data-back="1"]:visible').last()
    if (await back.count()) { await back.tap().catch(() => {}); await sleep(800) } else break
  }
  await p.locator(tid(`diary-section-${key}`)).tap()
  await sleep(1500)
}

// Тап «мимо меню» — в заведомо нейтральную точку верхнего левого угла.
async function tapOutside(p) {
  await p.touchscreen.tap(12, 12)
  await sleep(500)
}

// ── Прогон ───────────────────────────────────────────────────────────────
let vite = null, browser = null, users = []
const RUN = 'mm' + String(Date.now()).slice(-5)

try {
  if (!SRK) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY — см. qa/admin.mjs')
  console.log('Поднимаю dev-сервер…')
  vite = startDevServer()
  await waitForServer()
  console.log(`dev-сервер готов: ${BASE}`)

  users = await createUsers(RUN, 1)
  const u = users[0]
  await grantTrial(u.id)
  await seedWorkout(u.id)

  browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' })
  const p = await ctx.newPage()
  const dialogs = trapDialogs(p)

  // Вход
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await p.locator('text=Начать').first().click({ timeout: 30000 }); await sleep(700)
  await p.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await p.locator('input[type="email"]:visible').first().fill(u.email)
  await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await p.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await p.waitForSelector(`${tid('consent-accept')}, [data-screen], ${tid('screen-workouts')}`, { timeout: 60000 })
  if (await p.locator(tid('consent-accept')).count()) {
    await p.locator('text=Я даю согласие').first().click(); await sleep(300)
    await p.locator(tid('consent-accept')).click()
    await sleep(1500)
  }
  const loggedIn = await p.locator(tid('tab-workouts')).waitFor({ state: 'visible', timeout: 45000 }).then(() => true).catch(() => false)
  await sleep(2500)
  check('Вход', 'тестовый клиент вошёл в приложение', loggedIn)

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 1 — «⋯» в шапке тренировки программы (WorkoutsView)
  // ─────────────────────────────────────────────────────────────────────
  const S1 = 'Меню 1: шапка тренировки'
  await openTab(p, 'workouts')
  await p.locator(tid('program-folder-Full Body')).tap(); await sleep(1200)
  await p.locator(tid('program-slot-1')).tap(); await sleep(1200)

  await p.locator(tid('slot-header-menu-trigger')).tap(); await sleep(400)
  check(S1, 'меню открывается тапом по «⋯»', await visible(p, 'slot-header-menu'))

  await p.locator(tid('slot-header-menu-edit')).tap(); await sleep(700)
  const slotRenameOpen = await p.locator('text=Название тренировки').count() > 0
  check(S1, 'пункт «Редактировать» → открылась форма переименования', slotRenameOpen)
  if (slotRenameOpen) { await p.locator('button:visible').filter({ hasText: /^Отмена$/ }).first().tap(); await sleep(500) }

  const before1 = dialogs.length
  await p.locator(tid('slot-header-menu-trigger')).tap(); await sleep(400)
  await p.locator(tid('slot-header-menu-delete')).tap(); await sleep(900)
  check(S1, 'пункт «Удалить» → дошёл до подтверждения', dialogs.length > before1,
    `диалогов было ${before1}, стало ${dialogs.length}`)

  await p.locator(tid('slot-header-menu-trigger')).tap(); await sleep(400)
  await tapOutside(p)
  check(S1, 'тап мимо меню — закрывает', !(await visible(p, 'slot-header-menu')))

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 2 — «⋯» у упражнения внутри тренировки (WorkoutsView)
  // ─────────────────────────────────────────────────────────────────────
  const S2 = 'Меню 2: упражнение программы'
  const exTrigger = p.locator('[data-testid^="ex-menu-trigger-"]').first()
  await exTrigger.tap(); await sleep(400)
  check(S2, 'меню открывается тапом по «⋯»', await visible(p, 'ex-menu'))

  await p.locator(tid('ex-menu-edit')).tap(); await sleep(700)
  const exEditOpen = await p.locator('text=Редактировать упражнение').count() > 0
  check(S2, 'пункт «Редактировать» → открылась карточка упражнения', exEditOpen)
  if (exEditOpen) { await p.locator('button:visible').filter({ hasText: /^Отмена$/ }).first().tap(); await sleep(500) }

  const exCountBefore = await p.locator('[data-testid^="ex-menu-trigger-"]').count()
  await p.locator('[data-testid^="ex-menu-trigger-"]').first().tap(); await sleep(400)
  await p.locator(tid('ex-menu-delete')).tap(); await sleep(900)
  const exCountAfter = await p.locator('[data-testid^="ex-menu-trigger-"]').count()
  check(S2, 'пункт «Удалить» → упражнение исчезло из списка', exCountAfter === exCountBefore - 1,
    `было ${exCountBefore}, стало ${exCountAfter}`)

  await p.locator('[data-testid^="ex-menu-trigger-"]').first().tap(); await sleep(400)
  await tapOutside(p)
  check(S2, 'тап мимо меню — закрывает', !(await visible(p, 'ex-menu')))

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 3 — выбор периода в «Общем тоннаже» (DiaryView)
  // ─────────────────────────────────────────────────────────────────────
  const S3 = 'Меню 3: период тоннажа'
  await gotoDiarySection(p, 'tonnage')
  await p.locator(tid('ton-period-trigger')).tap(); await sleep(400)
  check(S3, 'меню открывается тапом по календарю', await visible(p, 'ton-period-menu'))

  const tonOptions = await p.locator('[data-testid^="ton-period-"]').evaluateAll(
    els => els.filter(e => e.dataset.testid !== 'ton-period-trigger' && e.dataset.testid !== 'ton-period-menu')
             .map(e => e.dataset.testid.replace('ton-period-', '')))
  check(S3, `пунктов периода найдено: ${tonOptions.length}`, tonOptions.length >= 2, tonOptions.join(', '))

  for (const k of tonOptions) {
    if (!(await visible(p, 'ton-period-menu'))) { await p.locator(tid('ton-period-trigger')).tap(); await sleep(400) }
    await p.locator(tid(`ton-period-${k}`)).tap(); await sleep(700)
    // Выбранный период подсвечивается в самом меню (жирный + акцентный цвет).
    await p.locator(tid('ton-period-trigger')).tap(); await sleep(400)
    const chosen = await p.locator(tid(`ton-period-${k}`)).evaluate(el => el.style.fontWeight)
    check(S3, `пункт «${k}» → период применился`, chosen === '600', `font-weight=${chosen || '(нет)'}`)
  }

  await tapOutside(p)
  check(S3, 'тап мимо меню — закрывает', !(await visible(p, 'ton-period-menu')))

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 4 — период в «Прогрессе по упражнениям» (DiaryView)
  // ─────────────────────────────────────────────────────────────────────
  const S4 = 'Меню 4: период упражнений'
  await gotoDiarySection(p, 'exercises')
  await p.locator(tid('ex-period-trigger')).tap(); await sleep(400)
  check(S4, 'меню открывается тапом по календарю', await visible(p, 'ex-period-menu'))

  const exOptions = await p.locator('[data-testid^="ex-period-"]').evaluateAll(
    els => els.filter(e => e.dataset.testid !== 'ex-period-trigger' && e.dataset.testid !== 'ex-period-menu')
             .map(e => e.dataset.testid.replace('ex-period-', '')))
  check(S4, `пунктов периода найдено: ${exOptions.length}`, exOptions.length >= 2, exOptions.join(', '))

  for (const k of exOptions) {
    if (!(await visible(p, 'ex-period-menu'))) { await p.locator(tid('ex-period-trigger')).tap(); await sleep(400) }
    await p.locator(tid(`ex-period-${k}`)).tap(); await sleep(700)
    await p.locator(tid('ex-period-trigger')).tap(); await sleep(400)
    const chosen = await p.locator(tid(`ex-period-${k}`)).evaluate(el => el.style.fontWeight)
    check(S4, `пункт «${k}» → период применился`, chosen === '600', `font-weight=${chosen || '(нет)'}`)
  }

  await tapOutside(p)
  check(S4, 'тап мимо меню — закрывает', !(await visible(p, 'ex-period-menu')))

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 5 — «+» в «Моих тренировках» (DiaryView)
  // ─────────────────────────────────────────────────────────────────────
  const S5 = 'Меню 5: «+» в тренировках'
  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('workout-menu-trigger')).tap(); await sleep(400)
  check(S5, 'меню открывается тапом по «+»', await visible(p, 'workout-menu'))

  await p.locator(tid('workout-menu-plan')).tap(); await sleep(800)
  const planFormOpen = await p.locator('text=Запланировать').count() > 0
  check(S5, 'пункт «Запланировать» → открылась форма', planFormOpen)
  if (planFormOpen) { await p.locator('button:visible').filter({ hasText: /^Отмена$/ }).first().tap().catch(() => {}); await sleep(600) }

  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('workout-menu-trigger')).tap(); await sleep(400)
  await p.locator(tid('workout-menu-template')).tap(); await sleep(900)
  check(S5, 'пункт «Шаблон тренировки» → открылся выбор шаблонов',
    await p.locator('text=Шаблоны тренировок').count() > 0)
  // Пикер шаблонов — модалка, закрывается тапом по фону (крестик — иконка без текста).
  await tapOutside(p); await sleep(600)

  for (const [item, label] of [['start', 'Начать тренировку'], ['done', 'Добавить выполненную']]) {
    await gotoDiarySection(p, 'workouts')
    await p.locator(tid('workout-menu-trigger')).tap(); await sleep(400)
    await p.locator(tid(`workout-menu-${item}`)).tap(); await sleep(1500)
    // onWorkoutAction уводит на вкладку «Тренировки» и открывает форму имени.
    const onWorkouts = await p.locator(tid('screen-workouts')).isVisible().catch(() => false)
    check(S5, `пункт «${label}» → приложение ушло на экран тренировки`, onWorkouts)
    const cancel = p.locator('button:visible').filter({ hasText: /^Отмена$/ }).first()
    if (await cancel.count()) { await cancel.tap(); await sleep(600) }
  }

  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('workout-menu-trigger')).tap(); await sleep(400)
  await tapOutside(p)
  check(S5, 'тап мимо меню — закрывает', !(await visible(p, 'workout-menu')))

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 6 — «⋯» на карточке тренировки (DiaryView)
  // ─────────────────────────────────────────────────────────────────────
  const S6 = 'Меню 6: карточка тренировки'
  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('card-menu-trigger-0')).tap(); await sleep(400)
  check(S6, 'меню открывается тапом по «⋯»', await visible(p, 'card-menu'))

  // «Сделать шаблон» проверяем по БАЗЕ, а не по всплывающей подсказке: подсказка
  // живёт 2.5 секунды, а строка в workout_templates — надёжное доказательство,
  // что обработчик отработал целиком.
  await p.locator(tid('card-menu-template')).tap()
  let tplRows = 0
  for (let i = 0; i < 12 && !tplRows; i++) {
    await sleep(600)
    const r = await rest(`/workout_templates?user_id=eq.${u.id}&select=id,name`)
    if (r.ok) tplRows = (await r.json()).length
  }
  check(S6, 'пункт «Сделать шаблон» → шаблон записан в базу', tplRows > 0, `строк в workout_templates: ${tplRows}`)

  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('card-menu-trigger-0')).tap(); await sleep(400)
  const beforeCardDel = dialogs.length
  await p.locator(tid('card-menu-delete')).tap(); await sleep(900)
  check(S6, 'пункт «Удалить» → дошёл до подтверждения', dialogs.length > beforeCardDel,
    `диалогов было ${beforeCardDel}, стало ${dialogs.length}`)

  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('card-menu-trigger-0')).tap(); await sleep(400)
  await p.locator(tid('card-menu-edit')).tap(); await sleep(1600)
  check(S6, 'пункт «Редактировать тренировку» → приложение ушло на экран тренировки',
    await p.locator(tid('screen-workouts')).isVisible().catch(() => false))
  const cancelEdit = p.locator('button:visible').filter({ hasText: /^Отмена$/ }).first()
  if (await cancelEdit.count()) { await cancelEdit.tap(); await sleep(700) }

  // «Копировать» никуда не уводит — оно дописывает копию в дневник (см.
  // handleCopyWorkout), поэтому и проверяется появлением новой карточки.
  await gotoDiarySection(p, 'workouts')
  const cardsBefore = await p.locator('[data-testid^="workout-card-"]').count()
  await p.locator(tid('card-menu-trigger-0')).tap(); await sleep(400)
  await p.locator(tid('card-menu-copy')).tap(); await sleep(2500)
  await gotoDiarySection(p, 'workouts')
  const cardsAfter = await p.locator('[data-testid^="workout-card-"]').count()
  const hasCopy = await p.locator('text=/\\(копия\\)/').count() > 0
  check(S6, 'пункт «Копировать тренировку» → в дневнике появилась копия',
    cardsAfter === cardsBefore + 1 && hasCopy, `карточек было ${cardsBefore}, стало ${cardsAfter}, «(копия)» найдена: ${hasCopy}`)

  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('card-menu-trigger-0')).tap(); await sleep(400)
  await tapOutside(p)
  check(S6, 'тап мимо меню — закрывает', !(await visible(p, 'card-menu')))

  // ─────────────────────────────────────────────────────────────────────
  // МЕНЮ 7 — «⋯» выбранной тренировки (DiaryView)
  // ─────────────────────────────────────────────────────────────────────
  // Это меню живёт не в «Моих тренировках», а в «Общем тоннаже»: панель
  // появляется, когда тапнешь столбец графика (selectedTonBar).
  const S7 = 'Меню 7: выбранная тренировка'
  // Столбец — переключатель: повторный тап по уже выбранному снимает выбор.
  // Состояние графика переживает уход из раздела, поэтому добиваемся именно
  // «панель открыта», а не «сделали один тап».
  const openSelectedWorkout = async () => {
    await gotoDiarySection(p, 'tonnage')
    for (let i = 0; i < 3; i++) {
      if (await p.locator(tid('selw-menu-trigger')).count()) return
      await p.locator(tid('ton-bar-0')).tap()
      await sleep(900)
    }
  }
  await openSelectedWorkout()
  const selwTriggerCount = await p.locator(tid('selw-menu-trigger')).count()
  check(S7, 'тап по столбцу графика раскрывает тренировку с «⋯»', selwTriggerCount > 0)

  if (selwTriggerCount > 0) {
    await p.locator(tid('selw-menu-trigger')).tap(); await sleep(400)
    check(S7, 'меню открывается тапом по «⋯»', await visible(p, 'selw-menu'))

    const beforeSelwDel = dialogs.length
    await p.locator(tid('selw-menu-delete')).tap(); await sleep(900)
    check(S7, 'пункт «Удалить» → дошёл до подтверждения', dialogs.length > beforeSelwDel,
      `диалогов было ${beforeSelwDel}, стало ${dialogs.length}`)

    await openSelectedWorkout()
    await p.locator(tid('selw-menu-trigger')).tap(); await sleep(400)
    await p.locator(tid('selw-menu-edit')).tap(); await sleep(1600)
    check(S7, 'пункт «Редактировать» → приложение ушло на экран тренировки',
      await p.locator(tid('screen-workouts')).isVisible().catch(() => false))
    const cancel = p.locator('button:visible').filter({ hasText: /^Отмена$/ }).first()
    if (await cancel.count()) { await cancel.tap(); await sleep(700) }

    await openSelectedWorkout()
    await p.locator(tid('selw-menu-trigger')).tap(); await sleep(400)
    await tapOutside(p)
    check(S7, 'тап мимо меню — закрывает', !(await visible(p, 'selw-menu')))
  }

  // ─────────────────────────────────────────────────────────────────────
  // Плёнок-перехватчиков в живом DOM больше нет
  // ─────────────────────────────────────────────────────────────────────
  const S8 = 'Оверлеи'
  await gotoDiarySection(p, 'workouts')
  await p.locator(tid('workout-menu-trigger')).tap(); await sleep(400)
  const overlayCount = await p.evaluate(() => [...document.querySelectorAll('div')].filter(d => {
    const s = getComputedStyle(d)
    return s.position === 'fixed' && d.getBoundingClientRect().width >= window.innerWidth &&
      d.getBoundingClientRect().height >= window.innerHeight &&
      (s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent') &&
      d.children.length === 0
  }).length)
  check(S8, 'при открытом меню нет прозрачной плёнки во весь экран', overlayCount === 0,
    `найдено плёнок: ${overlayCount}`)

  // Тап по пункту действительно достаётся кнопке, а не чему-то поверх неё.
  const hitTarget = await p.evaluate(() => {
    const item = document.querySelector('[data-testid="workout-menu-start"]')
    if (!item) return 'нет пункта'
    const r = item.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return item.contains(top) ? 'ok' : (top?.tagName + '.' + (top?.className || '')).slice(0, 80)
  })
  check(S8, 'в центре пункта меню лежит сам пункт, а не перехватчик', hitTarget === 'ok', hitTarget)

  // ─────────────────────────────────────────────────────────────────────
  // askConfirm — Telegram и обычный браузер
  // ─────────────────────────────────────────────────────────────────────
  const S9 = 'askConfirm'
  const tgResult = await p.evaluate(async () => {
    const mod = await import('/src/uiCompat.js')
    const calls = []
    window.Telegram = { WebApp: { showConfirm: (msg, cb) => { calls.push(msg); cb(true) } } }
    const yes = await mod.askConfirm('Удалить?')
    window.Telegram = { WebApp: { showConfirm: (msg, cb) => { calls.push(msg); cb(false) } } }
    const no = await mod.askConfirm('Удалить?')
    delete window.Telegram
    return { calls, yes, no }
  })
  check(S9, 'внутри Telegram спрашивает через WebApp.showConfirm, а не window.confirm',
    tgResult.calls.length === 2, JSON.stringify(tgResult.calls))
  check(S9, 'ответ «да» из Telegram приходит как true', tgResult.yes === true)
  check(S9, 'ответ «нет» из Telegram приходит как false', tgResult.no === false)

  const nativeResult = await p.evaluate(async () => {
    const mod = await import('/src/uiCompat.js')
    const asked = []
    const orig = window.confirm
    window.confirm = m => { asked.push(m); return true }
    const ok = await mod.askConfirm('Удалить?')
    window.confirm = orig
    return { asked, ok }
  })
  check(S9, 'вне Telegram остаётся обычный window.confirm', nativeResult.asked.length === 1 && nativeResult.ok === true,
    JSON.stringify(nativeResult))

  const brokenTg = await p.evaluate(async () => {
    const mod = await import('/src/uiCompat.js')
    const orig = window.confirm
    let fellBack = false
    window.confirm = () => { fellBack = true; return true }
    window.Telegram = { WebApp: { showConfirm: () => { throw new Error('WebAppMethodUnsupported') } } }
    const ok = await mod.askConfirm('Удалить?')
    delete window.Telegram
    window.confirm = orig
    return { fellBack, ok }
  })
  check(S9, 'старый клиент Telegram (showConfirm кидает) — откат на window.confirm, без падения',
    brokenTg.fellBack === true && brokenTg.ok === true, JSON.stringify(brokenTg))

  // ─────────────────────────────────────────────────────────────────────
  // Подтверждения вне App.jsx: чат-ассистент и экран тренерской сессии
  // ─────────────────────────────────────────────────────────────────────
  // ЧЕСТНО ПРО ГЛУБИНУ. Эти три подтверждения тапом в прогоне не достаются:
  // удаление и очистка дневника питания срабатывают только на маркеры
  // DEL/CLEAR от живой модели (реальный запрос в Anthropic, недетерминированный
  // ответ), а «Убрать из тренировки» — на экране тренерской сессии, для
  // которого нужны второй аккаунт-тренер, связка coach_id и заведённая
  // сессия. Поэтому здесь проверяется не тап, а КОД, который дев-сервер
  // реально отдаёт браузеру: что window.confirm оттуда ушёл, что askConfirm
  // импортирован и что вызовы идут через await. Сам механизм askConfirm выше
  // проверен живьём — он у всех этих мест общий.
  const S10 = 'Подтверждения вне App.jsx'
  // Берём код так, как его получает браузер: vite уже вырезал комментарии
  // (упоминание window.confirm в пояснении — не вызов) и переписал пути
  // импортов на абсолютные, поэтому и проверяем по абсолютному пути.
  // expect — сколько подтверждений в файле должно быть, чтобы новое место,
  // добавленное мимо askConfirm, не проехало незамеченным.
  const sources = [
    { label: 'AIAssistant.jsx', path: '/src/AIAssistant.jsx', expect: 2, what: 'удаление и очистка дневника питания' },
    { label: 'TrainerSession.jsx', path: '/src/TrainerSession.jsx', expect: 1, what: 'убрать упражнение из тренировки' },
  ]
  // Забираем модуль у дев-сервера из Node, а не из страницы: fetch внутри
  // page.evaluate иногда обрывается, если страница в этот момент занята
  // собственными запросами, — а проверять надо код, а не везение.
  const fetchModule = async (path) => {
    let last = null
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) })
        if (r.ok) return await r.text()
        last = `HTTP ${r.status}`
      } catch (e) { last = e.message }
      await sleep(500)
    }
    throw new Error(`не удалось получить ${path} у дев-сервера: ${last}`)
  }
  for (const { label, path, expect, what } of sources) {
    const code = await fetchModule(path)
    check(S10, `${label}: window.confirm больше не вызывается`, !/window\.confirm\s*\(/.test(code))
    check(S10, `${label}: askConfirm импортирован из uiCompat`, /from\s+["'][^"']*\/uiCompat\.js/.test(code))
    const awaited = (code.match(/await\s+askConfirm\s*\(/g) || []).length
    const total = (code.match(/askConfirm\s*\(/g) || []).length
    check(S10, `${label}: все вызовы askConfirm дождались ответа`, total > 0 && awaited === total,
      `с await ${awaited} из ${total}`)
    check(S10, `${label}: переведены все подтверждения (${what})`, total === expect,
      `ожидалось ${expect}, найдено ${total}`)
  }

  // Модули действительно грузятся браузером после правки — синтаксис цел, и
  // askConfirm в них тот же самый объект, что проверен живьём выше.
  const sameFn = await p.evaluate(async () => {
    const [ui, aia, ts] = await Promise.all([
      import('/src/uiCompat.js'), import('/src/AIAssistant.jsx'), import('/src/TrainerSession.jsx'),
    ])
    return { ok: typeof ui.askConfirm === 'function', aia: !!aia.default, ts: !!ts.default }
  })
  check(S10, 'оба модуля грузятся браузером после правки (синтаксис цел)',
    sameFn.ok && sameFn.aia && sameFn.ts, JSON.stringify(sameFn))

} catch (e) {
  check('Прогон', 'прогон дошёл до конца без исключения', false, e?.stack || String(e))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (vite) { try { vite.kill('SIGTERM') } catch { /* уже мёртв */ } }
  // Чистка боевой базы обязана отработать даже после падения — см. qa/admin.mjs.
  try { await cleanupAll() } catch (e) { console.error('ЧИСТКА НЕ ПРОШЛА, разобрать руками:', e) }
}

console.log('\n────────────────────────────────────────────────────────────────────')
const bySection = {}
for (const r of rows) { (bySection[r.section] ??= []).push(r) }
for (const [s, list] of Object.entries(bySection)) {
  console.log(`${s}: ${list.filter(r => r.ok).length}/${list.length}`)
}
console.log(`Итог: ${passed} пройдено, ${failed} провалено`)
process.exit(failed ? 1 : 0)
