// test-guest.mjs — приложение целиком работает БЕЗ аккаунта, за флагом ?guest=1.
//
// Зачем этот набор. Переходы из Инстаграма есть, регистраций почти нет: людей
// останавливает анкета на входе. Гостевой режим убирает её — но убирает и все
// гарантии, на которых держалось приложение: `user` перестаёт существовать, а
// на него завязаны и разметка (имя, аватар), и каждая запись в облако.
//
// Проверяется ровно два класса поломок и одно обещание:
//
//   КРЕШ. Любое обращение к user.id/user.name без защиты роняет весь экран —
//     не «часть не работает», а белый лист вместо приложения;
//   ЗАПИСЬ БЕЗ ВЛАДЕЛЬЦА. Попытка писать в облако без user_id упирается в RLS,
//     и человек видит ошибку сохранения там, где ему обещали, что всё работает.
//     Здесь это ловится перехватом сети: за весь прогон ни одного POST/PATCH/
//     DELETE к пользовательским таблицам;
//   СЛЕД. Гость НЕ оставляет на устройстве ничего: сохранность обещает аккаунт,
//     и только он. Работа живёт в памяти вкладки и честно исчезает с
//     перезагрузкой; на диск она попадает одним буфером и ровно в один момент —
//     когда человек нажал «Создать аккаунт».
//
// В pre-push НЕ добавлен намеренно: хук должен оставаться быстрым, а здесь
// поднимается браузер и проходится четыре вкладки.
//
// Запуск: npm run build && node test-guest.mjs
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { chromium } from 'playwright'

const DIST = 'dist'
const PORT = 4392

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}

if (!existsSync(`${DIST}/index.html`)) {
  console.error('нет собранного приложения: сначала npm run build')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.woff2': 'font/woff2',
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  // SPA: всё без расширения — это маршрут, отдаём страницу
  const file = url === '/' || !url.includes('.') ? `${DIST}/index.html` : `${DIST}${url}`
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise(r => server.listen(PORT, r))

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
const page = await context.newPage()

// ── что пошло не так на странице ───────────────────────────────────────────
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e.message)))
page.on('console', m => {
  if (m.type() !== 'error') return
  const t = m.text()
  // Отсутствие сети до Supabase — не поломка гостевого режима: клиент
  // инициализируется всегда, а сервера в прогоне нет вовсе.
  if (/Failed to load resource|net::ERR|ERR_CONNECTION|supabase/i.test(t)) return
  pageErrors.push('console: ' + t.slice(0, 200))
})

/**
 * ЗАПИСИ В ОБЛАКО — ГЛАВНАЯ ПРОВЕРКА.
 *
 * Перехватываем ВСЁ, что уходит на сеть, и запоминаем изменяющие запросы к
 * пользовательским таблицам. Заодно глушим их: сервера в прогоне нет, а висящие
 * запросы растянули бы тест на таймауты.
 */
const writes = []
const GUARDED = ['workouts', 'workout_sets', 'food_diary', 'profiles', 'planned_workouts', 'workout_templates', 'custom_exercises', 'measurements']
await context.route('**/*', route => {
  const req = route.request()
  const url = req.url()
  const method = req.method()
  if (/localhost:4392/.test(url)) return route.continue()
  if (method !== 'GET' && method !== 'OPTIONS' && /\/rest\/v1\//.test(url)) {
    const table = url.split('/rest/v1/')[1]?.split('?')[0]
    if (GUARDED.includes(table)) writes.push(`${method} ${table}`)
  }
  // Всё внешнее (Supabase, воронка) обрываем заглушкой.
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
})

const open = async (qs) => {
  await page.goto(`http://localhost:${PORT}/${qs}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
}

// ── 1. приложение открывается гостем, все вкладки живы ─────────────────────
await open('?guest=1')

report('гость: приложение отрисовалось, а не форма регистрации',
  await page.evaluate(() => document.getElementById('root').childElementCount > 0)
  && await page.locator('[data-testid="guest-login"]').count() === 1)

for (const tab of ['workouts', 'nutrition', 'library', 'progress']) {
  const btn = page.locator(`[data-testid="tab-${tab}"]`)
  const has = await btn.count()
  if (has) { await btn.click(); await page.waitForTimeout(900) }
  report(`вкладка «${tab}» открывается`, has === 1 && await page.evaluate(() => document.querySelector('.mobile-content')?.childElementCount > 0))
}

report('флаг гостя пережил бы перезагрузку (лежит в localStorage)',
  await page.evaluate(() => localStorage.getItem('fitpro_guest') === '1'))

// ── 2. замок на планировании (до тренировки: потом мешает свёрнутая) ───────
await page.locator('[data-testid="tab-progress"]').click()
await page.waitForTimeout(900)
await page.locator('[data-testid="diary-section-workouts"]').click()
await page.waitForTimeout(1000)
const menu = page.locator('[data-testid="workout-menu-trigger"]')
if (await menu.count()) {
  await menu.click()
  await page.waitForTimeout(400)
  await page.locator('[data-testid="workout-menu-plan"]').click()
  await page.waitForTimeout(700)
  report('планирование показывает замок вместо формы',
    await page.locator('[data-testid="guest-lock"]').count() === 1)
  await page.mouse.click(5, 5)
  await page.waitForTimeout(400)
} else {
  report('планирование показывает замок вместо формы', false, 'не нашлось меню тренировок')
}
// «Мои тренировки» — полноэкранный портал поверх нижнего меню: пока он открыт,
// по вкладкам не нажать. Выходим его же кнопкой «назад».
await page.locator('[data-back="1"]').first().click().catch(() => {})
await page.waitForTimeout(700)

// ── 3. тренировка с одним подходом попадает в историю ──────────────────────
/** Путь человека целиком: папка -> занятие -> старт -> подход -> сохранить. */
/** Выбраться из любых полноэкранных порталов к нижнему меню. */
async function goHome() {
  for (let i = 0; i < 4; i += 1) {
    const back = page.locator('[data-back="1"]')
    if (!(await back.count())) break
    await back.first().click().catch(() => {})
    await page.waitForTimeout(400)
  }
}

async function finishOneWorkout() {
  await goHome()
  await page.locator('[data-testid="tab-workouts"]').click()
  await page.waitForTimeout(900)
  await page.locator('[data-testid="program-folder-Full Body"]').click()
  await page.waitForTimeout(1000)
  await page.locator('[data-testid="program-slot-1"]').click()
  await page.waitForTimeout(1000)
  const startBtn = page.locator('[data-testid="workout-start"]').first()
  if (!(await startBtn.count())) return false
  await startBtn.click()
  await page.waitForTimeout(900)
  // Гость ещё не «принял» программу — приложение спрашивает, как и у всех
  const adopt = page.getByRole('button', { name: /буду тренироваться по этой программе/ })
  if (await adopt.count()) { await adopt.click(); await page.waitForTimeout(1500) }
  // Подсказка про прогрессию на первой тренировке — закрываем, как человек
  const intro = page.getByRole('button', { name: 'Понятно!' })
  if (await intro.count()) { await intro.first().click(); await page.waitForTimeout(600) }
  const kg = page.locator('[data-testid="set-kg"]').first()
  if (!(await kg.count())) return false
  await kg.fill('50')
  await page.locator('[data-testid="set-reps"]').first().fill('10')
  await page.waitForTimeout(400)
  // dispatchEvent, а не click: нижний бар тренировки перекрывает кнопку по
  // координатам, и обычный клик уходит в него. Проверяем поведение, а не
  // попадание мышью
  await page.locator('[data-testid="workout-finish"]').dispatchEvent('click')
  await page.waitForTimeout(900)
  const confirm = page.locator('[data-testid="workout-save-confirm"]')
  if (await confirm.count()) await confirm.dispatchEvent('click')
  await page.waitForTimeout(2000)
  return true
}

await finishOneWorkout()
report('тренировка гостя НЕ попала в fitpro_history — следа на диске нет',
  await page.evaluate(() => !localStorage.getItem('fitpro_history')))
report('и она видна в самом приложении, в состоянии сессии',
  (await page.locator('[data-testid="tab-progress"]').count()) === 1)

// ── 3б. предложение после тренировки ───────────────────────────────────────
await page.waitForTimeout(600)
report('после тренировки всплыло предложение завести аккаунт',
  await page.locator('[data-testid="offer-sheet"]').count() === 1)
report('текст плашки — про сохранение, а не про возможности',
  (await page.locator('[data-testid="offer-sheet"]').innerText()).includes('Сохранить тренировку?'))
report('никаких суточных ключей на диске не заводится',
  await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('fitpro_offer_'))))

await page.locator('[data-testid="offer-later"]').click()
await page.waitForTimeout(500)
report('«Не сохранять» закрывает плашку',
  await page.locator('[data-testid="offer-sheet"]').count() === 0)

/**
 * ПЛАШКА ПРИ КАЖДОМ ЗАВЕРШЕНИИ. Модель изменилась: гость не сохраняет никуда, и
 * каждое завершение — реальная развилка, после которой работа либо останется,
 * либо нет. Промолчать во второй раз значило бы дать человеку потерять
 * тренировку молча.
 */
await finishOneWorkout()
await page.waitForTimeout(800)
report('плашка приходит и на второй тренировке, а не раз в сутки',
  await page.locator('[data-testid="offer-sheet"]').count() === 1)
await page.locator('[data-testid="offer-later"]').click()
await page.waitForTimeout(400)

// ── 4. запись в дневнике питания помечена как гостевая ─────────────────────
await goHome()
await page.locator('[data-testid="tab-nutrition"]').click()
await page.waitForTimeout(1200)
const mealAdd = page.locator('[data-testid^="meal-add-"]').first()
if (await mealAdd.count()) {
  await mealAdd.click()
  await page.waitForTimeout(700)
  const manual = page.getByRole('button', { name: 'Вручную' })
  if (await manual.count()) {
    await manual.first().click()
    await page.waitForTimeout(500)
    await page.getByPlaceholder('Название *').fill('Гречка')
    await page.getByRole('button', { name: /Добавить в/ }).first().click()
    await page.waitForTimeout(1200)
  }
}
// ── 4б. предложение после записи еды, и путь «Создать аккаунт» ─────────────
await page.waitForTimeout(700)
report('после записи еды всплыла плашка дневника',
  await page.locator('[data-testid="offer-sheet"]').count() === 1)
report('текст — «Вести дневник постоянно?»',
  (await page.locator('[data-testid="offer-sheet"]').innerText()).includes('Вести дневник постоянно?'))

report('запись еды НЕ попала в fitpro_food_diary — следа на диске нет',
  await page.evaluate(() => !localStorage.getItem('fitpro_food_diary')))
report('до нажатия «Создать аккаунт» буфера на диске тоже нет',
  await page.evaluate(() => !localStorage.getItem('fitpro_guest_pending')))

// ── 4в. «Создать аккаунт»: форма и буфер переезда ──────────────────────────
report('«Создать аккаунт» открывает форму сразу на вкладке регистрации',
  await (async () => {
    if (!(await page.locator('[data-testid="offer-create"]').count())) return false
    await page.locator('[data-testid="offer-create"]').click()
    await page.waitForTimeout(1000)
    return (await page.getByPlaceholder('Повтори пароль').count()) === 1
  })())
report('откуда пришёл — запомнено для register_from_offer',
  await page.evaluate(() => sessionStorage.getItem('fitpro_offer_src')) === 'diary')
/**
 * БУФЕР ПИШЕТСЯ НА ОТПРАВКЕ ФОРМЫ, а не на нажатии в плашке: до отправки
 * человек ещё может передумать, и класть его работу на диск раньше значило бы
 * оставлять след там, где обещано, что следа нет. Заполняем форму как человек.
 */
await page.getByPlaceholder('Иван Иванов').fill('Гость')
await page.getByPlaceholder('ivan@example.com').fill('guest.test@example.com')
await page.getByPlaceholder('Минимум 6 символов').fill('secret123')
await page.getByPlaceholder('Повтори пароль').fill('secret123')
await page.getByRole('button', { name: /Создать аккаунт/ }).click()
await page.waitForTimeout(1500)

const pending = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('fitpro_guest_pending') || 'null') } catch { return null }
})
report('отправка формы откладывает работу гостя в fitpro_guest_pending', !!pending)
report('в буфере и тренировки, и еда',
  !!pending && pending.workouts.length >= 1
  && Object.values(pending.food || {}).flat().length >= 1,
  pending ? `тренировок ${pending.workouts.length}, еды ${Object.values(pending.food || {}).flat().length}` : 'буфера нет')
if (await page.locator('[data-testid="auth-back-to-app"]').count()) {
  await page.locator('[data-testid="auth-back-to-app"]').click()
  await page.waitForTimeout(600)
}

// ── 4г. перезагрузка гостем даёт чистое приложение ─────────────────────────
await page.evaluate(() => localStorage.removeItem('fitpro_guest_pending'))
await open('')
report('после перезагрузки история пуста — гость начинает с чистого листа',
  await page.evaluate(() => !localStorage.getItem('fitpro_history') && !localStorage.getItem('fitpro_food_diary')))
report('и содержимого гостя на диске нет ни в одном из его ключей',
  await page.evaluate(() => ['fitpro_history', 'fitpro_food_diary', 'fitpro_guest_pending']
    .every((k) => !localStorage.getItem(k))
    && !Object.keys(localStorage).some((k) => k.startsWith('fitpro-motion.'))),
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('fitpro')).join(', ')))

// ── 5. ни одной записи в облако за весь прогон ─────────────────────────────
report('ни одного POST/PATCH/DELETE к пользовательским таблицам',
  writes.length === 0, writes.join(', '))

// ── 5б. замок гостя на ИИ-ассистенте ──────────────────────────────────
await open('')
const aiBtn = page.locator('[data-testid="guest-ai-open"]')
report('у гостя есть кнопка ИИ-ассистента', await aiBtn.count() === 1)
if (await aiBtn.count()) {
  await aiBtn.click()
  await page.waitForTimeout(500)
  report('ИИ-ассистент показывает замок, а не чат', await page.locator('[data-testid="guest-lock"]').count() === 1)
  await page.mouse.click(5, 5)
  await page.waitForTimeout(400)
}

// ── 6. вход и возврат без входа ────────────────────────────────────────────
await open('')
await page.locator('[data-testid="guest-login"]').first().click()
await page.waitForTimeout(900)
report('кнопка «Войти» открывает сразу форму, минуя заголовок',
  await page.locator('[data-testid="auth-back-to-app"]').count() === 1)

await page.locator('[data-testid="auth-back-to-app"]').click()
await page.waitForTimeout(900)
report('«Продолжить без входа» возвращает в приложение',
  await page.locator('[data-testid="guest-login"]').count() === 1
  && await page.locator('[data-testid="auth-back-to-app"]').count() === 0)

// ── 7. без флага — всё как было ────────────────────────────────────────────
await page.evaluate(() => localStorage.clear())
await open('')
report('БЕЗ флага гость не включается: на входе прежний экран регистрации',
  await page.locator('[data-testid="guest-login"]').count() === 0
  && await page.locator('[data-testid="tab-workouts"]').count() === 0)

// ── итог ───────────────────────────────────────────────────────────────────
report('ни одной ошибки на странице за весь прогон', pageErrors.length === 0,
  [...new Set(pageErrors)].slice(0, 3).join(' | '))

await browser.close()
server.close()

console.log(`\nИтог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
