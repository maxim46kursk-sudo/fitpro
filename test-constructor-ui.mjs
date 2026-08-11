// test-constructor-ui.mjs — живой прогон экрана Конструктора пальцем.
//
// Тот же подход, что в test-mobile-menus.mjs: настоящий Chromium, мобильный
// контекст с тачем (iPhone 13), реальные .tap() против локального vite dev и
// боевого бэкенда. Перекраска экрана — работа над вёрсткой, и именно вёрстка
// ломает нажатия незаметно для юнит-тестов: элемент может уехать под другой
// слой, потерять размер или перестать попадать в палец. Поэтому проверяем не
// «правильные ли цвета», а что после перекраски ВСЁ ЕЩЁ НАЖИМАЕТСЯ и делает
// своё дело.
//
// Конструктор виден только тренеру, поэтому тестовому аккаунту временно
// выставляется role='trainer' (сервисный ключ привилегирован для
// guard_profile_privileged). Аккаунт удаляется в finally.
//
// Запуск: node test-constructor-ui.mjs

import { chromium, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './qa/admin.mjs'

const PORT = Number(process.env.CONSTRUCTOR_TEST_PORT || 5215)
const BASE = `http://127.0.0.1:${PORT}`
const SUPABASE_URL = 'https://api.fitproapp.ru'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

let passed = 0, failed = 0
const rows = []
const check = (section, name, ok, detail = '') => {
  rows.push({ section, ok })
  if (ok) passed++; else failed++
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  [${section}] ${name}${!ok && detail ? `\n   → ${detail}` : ''}`)
}

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

let vite = null, browser = null, u = null
try {
  if (!SRK) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY — см. qa/admin.mjs')
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stdout.on('data', () => {}); vite.stderr.on('data', () => {})
  await waitForServer()

  ;[u] = await createUsers('cu' + String(Date.now()).slice(-5), 1)
  const r = await rest(`/profiles?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'trainer' }) })
  if (!r.ok) throw new Error(`роль тренера не выдалась: ${r.status} ${await r.text()}`)

  browser = await chromium.launch({ headless: true })
  const p = await (await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' })).newPage()

  // Вход
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

  // ── Вход в конструктор ─────────────────────────────────────────────────
  const S1 = 'Вход'
  await p.locator(tid('tab-workouts')).tap(); await sleep(1500)
  await p.locator(tid('constructor-open')).scrollIntoViewIfNeeded()
  await p.locator(tid('constructor-open')).tap(); await sleep(1800)
  check(S1, 'кнопка «Конструктор» открывает экран', await p.locator(tid('constructor-screen')).isVisible())
  check(S1, 'на пустом экране кнопка «Завершить» заблокирована',
    await p.locator(tid('constructor-finish')).isDisabled())

  // Экран больше не портал — нижнее меню приложения на нём видно, как и на
  // тренировке по шаблону.
  check(S1, 'нижнее меню приложения остаётся видимым',
    await p.locator(tid('tab-workouts')).isVisible().catch(() => false))
  // Время сессии в шапке — идёт с момента открытия.
  await sleep(2200)
  const sessionTimer = await p.locator(tid('constructor-session-timer')).innerText()
  check(S1, 'в шапке идёт время сессии', /⏱ 00:00:0[1-9]/.test(sessionTimer), sessionTimer)
  // Шапка не должна уезжать под общий хедер приложения: в конструктор входят
  // кнопкой в самом низу промотанного списка, и без флага полноэкранного
  // режима заголовок оказывался за верхней границей (см. workoutFullscreen).
  const headTop = (await p.locator(tid('constructor-session-timer')).boundingBox())?.y ?? -1
  check(S1, 'шапка целиком на экране, не уехала под хедер приложения', headTop > 0, `y=${headTop}`)
  const headerCovered = await p.locator(tid('constructor-session-timer')).evaluate(el => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + 5, r.top + r.height / 2)
    return !el.contains(top) && top !== el
  })
  check(S1, 'шапку ничем не перекрывает', headerCovered === false)

  // ── Секундомер (компактная строка, зелёный «Старт») ────────────────────
  const S2 = 'Секундомер'
  const swBtn = p.locator(tid('constructor-sw-toggle'))
  const swBg = await swBtn.evaluate(el => getComputedStyle(el).backgroundColor)
  check(S2, '«Старт» зелёный, как на тренировке по шаблону', swBg === 'rgb(48, 209, 88)', swBg)
  await swBtn.tap(); await sleep(1200)
  check(S2, 'старт запускает отсчёт', /Стоп/.test(await swBtn.innerText()))
  // Перерисовка раз в секунду и не выровнена с моментом нажатия (та же модель,
  // что в эталоне), поэтому ждём появления ненулевого времени, а не спим
  // фиксированно.
  let ticked = ''
  for (let i = 0; i < 8; i++) {
    ticked = await p.locator(tid('constructor-sw-time')).innerText()
    if (/⏱ 00:00:0[1-9]/.test(ticked)) break
    await sleep(500)
  }
  check(S2, 'секундомер отсчитал время', /⏱ 00:00:0[1-9]/.test(ticked), ticked)
  await swBtn.tap(); await sleep(400)
  await p.locator(tid('constructor-sw-reset')).tap(); await sleep(400)
  check(S2, 'сброс возвращает 00:00:00', (await p.locator(tid('constructor-sw-time')).innerText()).includes('00:00:00'))

  // ── Каталог: поиск и фильтр ────────────────────────────────────────────
  const S3 = 'Каталог'
  await p.locator(tid('constructor-add')).tap(); await sleep(900)
  check(S3, '«+» открывает каталог', await p.locator(tid('constructor-picker')).isVisible())
  const allCount = await p.locator(tid('constructor-cat-item')).count()
  check(S3, 'каталог показан целиком при пустом запросе', allCount > 50, `упражнений: ${allCount}`)

  await p.locator(tid('constructor-search')).fill('присед'); await sleep(700)
  const searched = await p.locator(tid('constructor-cat-item')).allInnerTexts()
  check(S3, 'поиск по названию сузил список',
    searched.length > 0 && searched.length < allCount && searched.every(t => /присед/i.test(t)),
    `найдено ${searched.length}: ${searched.slice(0, 3).join(' | ')}`)

  await p.locator(tid('constructor-search')).fill(''); await sleep(600)
  await p.locator(tid('constructor-group-legs')).tap(); await sleep(700)
  const legsCount = await p.locator(tid('constructor-cat-item')).count()
  check(S3, 'фильтр по группе мышц сузил список', legsCount > 0 && legsCount < allCount,
    `в группе «Ноги»: ${legsCount}`)
  await p.locator(tid('constructor-group-all')).tap(); await sleep(600)
  check(S3, 'фильтр «Все» возвращает полный каталог',
    await p.locator(tid('constructor-cat-item')).count() === allCount)

  // ── Добавление упражнения ──────────────────────────────────────────────
  const S4 = 'Упражнение'
  // Выбор упражнения — это поход в сеть (завести личную запись + прочитать её
  // историю), поэтому ждём появления карточки, а не фиксированную паузу:
  // против боевого бэкенда пауза то хватает, то нет.
  await p.locator(tid('constructor-search')).fill('Приседания'); await sleep(700)
  await p.locator(tid('constructor-cat-item')).first().tap()
  const cardAppeared = await p.locator(tid('constructor-ex-card')).first()
    .waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
  check(S4, 'выбор из каталога добавляет упражнение в сессию',
    cardAppeared && await p.locator(tid('constructor-ex-card')).count() === 1)
  check(S4, 'каталог закрылся после выбора', !(await p.locator(tid('constructor-picker')).isVisible().catch(() => false)))
  const cardText = await p.locator(tid('constructor-ex-card')).first().innerText()
  check(S4, 'в карточке показан тип из каталога', /Ноги/.test(cardText) && /Штанга/.test(cardText),
    cardText.replace(/\s+/g, ' ').slice(0, 90))

  // ── Подходы ────────────────────────────────────────────────────────────
  const S5 = 'Подходы'
  const setsBefore = await p.locator(tid('constructor-kg')).count()
  check(S5, 'у нового упражнения 4 строки замера', setsBefore === 4, `строк: ${setsBefore}`)

  await p.locator(tid('constructor-add-set')).tap(); await sleep(600)
  check(S5, '«+ Подход» добавляет строку', await p.locator(tid('constructor-kg')).count() === setsBefore + 1)

  await p.locator(tid('constructor-set-remove')).last().tap(); await sleep(600)
  check(S5, 'крестик удаляет строку', await p.locator(tid('constructor-kg')).count() === setsBefore)

  // Ввод веса и повторов — поля должны принимать значение с тача.
  const kg = p.locator(tid('constructor-kg'))
  const reps = p.locator(tid('constructor-reps'))
  for (let i = 0; i < setsBefore; i++) {
    await kg.nth(i).tap(); await kg.nth(i).fill(String(40 + i * 5))
    await reps.nth(i).tap(); await reps.nth(i).fill(String(20 - i * 2))
  }
  await sleep(400)
  check(S5, 'поля веса/повторов принимают ввод',
    (await kg.first().inputValue()) === '40' && (await reps.first().inputValue()) === '20')

  // ── Оценка нагрузки: на подход, квадраты 44×44, подписи ────────────────
  const S6 = 'Оценка нагрузки'
  // Блок оценки — только под рабочими подходами (последние два), как в эталоне.
  const ratingRows = await p.locator(tid('constructor-rating-1')).count()
  check(S6, 'оценка стоит под рабочими подходами, а не одна на упражнение',
    ratingRows === 2, `блоков оценки: ${ratingRows}`)
  const box = await p.locator(tid('constructor-rating-1')).first().boundingBox()
  check(S6, 'кнопки-квадраты 44×44', Math.round(box.width) === 44 && Math.round(box.height) === 44,
    `${box && Math.round(box.width)}×${box && Math.round(box.height)}`)
  const captions = await p.locator(tid('constructor-ex-card')).first().innerText()
  check(S6, 'подписи «легко» и «на пределе» на месте',
    /легко/.test(captions) && /на пределе/.test(captions))

  await p.locator(tid('constructor-finish')).tap(); await sleep(900)
  check(S6, 'без оценки «Завершить» не сохраняет и не показывает выбор даты',
    !(await p.locator(tid('constructor-save-date')).isVisible().catch(() => false)))

  // Проставляем оценку каждому рабочему подходу.
  for (let i = 0; i < ratingRows; i++) { await p.locator(tid('constructor-rating-4')).nth(i).tap(); await sleep(300) }
  const chosenBg = await p.locator(tid('constructor-rating-4')).first().evaluate(el => getComputedStyle(el).backgroundColor)
  check(S6, 'выбранная оценка подсвечена акцентом', chosenBg === 'rgb(124, 122, 240)', chosenBg)

  // ── Завершить упражнение и вернуть в правку ────────────────────────────
  const S6b = 'Завершение упражнения'
  await p.locator(tid('constructor-ex-done')).tap(); await sleep(700)
  const doneText = await p.locator(tid('constructor-ex-card')).first().innerText()
  check(S6b, '«Завершить упражнение» сворачивает карточку в сводку с тоннажем',
    /Выполнено/.test(doneText) && /Тоннаж/.test(doneText), doneText.replace(/\s+/g, ' ').slice(0, 80))
  check(S6b, 'в свёрнутой карточке полей ввода нет', await p.locator(tid('constructor-kg')).count() === 0)
  await p.locator(tid('constructor-ex-edit')).tap(); await sleep(700)
  check(S6b, '«↩ Редактировать» возвращает поля', await p.locator(tid('constructor-kg')).count() === setsBefore)

  // ── Комментарий к тренировке ───────────────────────────────────────────
  const S6c = 'Комментарий'
  await p.locator(tid('constructor-comment')).fill('Проверка механики')
  check(S6c, 'комментарий к тренировке вводится',
    (await p.locator(tid('constructor-comment')).inputValue()) === 'Проверка механики')

  // ── Завершение: сначала выбор даты, как в эталоне ──────────────────────
  const S7 = 'Завершение'
  await p.locator(tid('constructor-finish')).tap(); await sleep(800)
  check(S7, '«Завершить» спрашивает дату сохранения',
    await p.locator(tid('constructor-save-date')).isVisible())
  await p.locator(tid('constructor-save-confirm')).tap()
  // commitSession пишет подходы ПО ОДНОМУ (см. ConstructorView), поэтому
  // читать базу на первом же ненулевом ответе нельзя — поймаешь середину
  // записи. Ждём именно ожидаемого числа строк.
  let sets = 0
  for (let i = 0; i < 25 && sets !== setsBefore; i++) {
    await sleep(700)
    const rr = await rest(`/constructor_sets?user_id=eq.${u.id}&select=id,kg,reps,rating`)
    if (rr.ok) sets = (await rr.json()).length
  }
  check(S7, 'подходы записались в constructor_sets', sets === setsBefore,
    `строк в базе ${sets}, ожидалось ${setsBefore}`)
  const closed = await p.locator(tid('constructor-screen'))
    .waitFor({ state: 'hidden', timeout: 20000 }).then(() => true).catch(() => false)
  check(S7, 'экран конструктора закрылся после сохранения', closed)
  await sleep(1200)

  // ── Повторный вход: упражнение уже в личном списке ─────────────────────
  const S8 = 'Повторный вход'
  await p.locator(tid('tab-workouts')).tap(); await sleep(1500)
  await p.locator(tid('constructor-open')).scrollIntoViewIfNeeded()
  await p.locator(tid('constructor-open')).tap(); await sleep(1800)
  await p.locator(tid('constructor-add')).tap(); await sleep(900)
  await p.locator(tid('constructor-search')).fill('Приседания'); await sleep(700)
  await p.locator(tid('constructor-cat-item')).first().tap()
  await p.locator(tid('constructor-ex-card')).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  await sleep(800)
  const secondCard = await p.locator(tid('constructor-ex-card')).first().innerText()
  check(S8, 'второй раз упражнение приходит уже с рекомендацией, а не как первый замер',
    !/Первый замер/.test(secondCard), secondCard.replace(/\s+/g, ' ').slice(0, 90))
  check(S8, 'у упражнения с историей появился сброс «↺»',
    await p.locator(tid('constructor-ex-reset')).count() === 1)
  // Рекомендация показана ОТДЕЛЬНОЙ подписью под подходом, а не только числом
  // в поле — как «реком. X кг» на тренировке по шаблону.
  const recCount = await p.locator(tid('constructor-rec')).count()
  check(S8, 'под подходами стоит подпись «реком. X кг»', recCount > 0, `подписей: ${recCount}`)
  check(S8, 'подпись совпадает с числом, подставленным в поле веса',
    (await p.locator(tid('constructor-rec')).first().innerText()).includes(await p.locator(tid('constructor-kg')).first().inputValue()))

  // ── Закрытие экрана ────────────────────────────────────────────────────
  const S9 = 'Закрытие'
  await p.locator(tid('constructor-close')).tap(); await sleep(800)
  check(S9, 'стрелка «назад» спрашивает подтверждение',
    await p.locator(tid('constructor-exit-discard')).isVisible())
  await p.locator(tid('constructor-exit-cancel')).tap(); await sleep(600)
  check(S9, '«Отмена» оставляет на экране', await p.locator(tid('constructor-screen')).isVisible())
  await p.locator(tid('constructor-close')).tap(); await sleep(600)
  await p.locator(tid('constructor-exit-discard')).tap(); await sleep(1500)
  check(S9, '«Выйти без сохранения» закрывает конструктор',
    !(await p.locator(tid('constructor-screen')).isVisible().catch(() => false)))
  check(S9, 'после выхода приложение на экране тренировок',
    await p.locator(tid('screen-workouts')).isVisible().catch(() => false))

} catch (e) {
  check('Прогон', 'прогон дошёл до конца без исключения', false, e?.stack || String(e))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (vite) { try { vite.kill('SIGTERM') } catch { /* уже мёртв */ } }
  try { await cleanupAll() } catch (e) { console.error('ЧИСТКА НЕ ПРОШЛА, разобрать руками:', e) }
}

console.log('\n────────────────────────────────────────────────────────────────────')
const bySection = {}
for (const r of rows) { (bySection[r.section] ??= []).push(r) }
for (const [s, list] of Object.entries(bySection)) console.log(`${s}: ${list.filter(r => r.ok).length}/${list.length}`)
console.log(`Итог: ${passed} пройдено, ${failed} провалено`)
// Явный выход: vite запущен через оболочку и держит event loop открытым.
process.exit(failed ? 1 : 0)
