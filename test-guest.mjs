// test-guest.mjs — приложение целиком работает БЕЗ аккаунта, по основной ссылке.
//
// Зачем этот набор. Переходы из Инстаграма есть, регистраций почти нет: людей
// останавливает анкета на входе. Гостевой режим убирает её — но убирает и все
// гарантии, на которых держалось приложение: `user` перестаёт существовать, а
// на него завязаны и разметка (имя, аватар), и каждая запись в облако.
//
// Флага больше нет: гость — это просто «человека нет», и проверяется теперь
// сам корневой адрес. Ошибка здесь видна не части людей с флагом в ссылке, а
// каждому, кто открыл приложение.
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
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createRequestHandler } from './server.mjs'

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

/**
 * СТРАНИЦУ ОТДАЁТ ТОТ ЖЕ SERVER.MJS, ЧТО И ПРОД, — РАДИ CSP.
 *
 * Раньше здесь стоял свой маленький сервер на десять строк, и этого хватало,
 * пока ответы не несли заголовков. Теперь несут: строгая Content-Security-Policy
 * с хэшами встроенных скриптов index.html. Политика, которую не проверил
 * НАСТОЯЩИЙ браузер на НАСТОЯЩЕЙ странице, — это обещание, а не проверка:
 * сборка соберётся, тесты пройдут, а у человека молча не выполнится скрипт или
 * не поднимется воркер позы. Своим сервером такую беду не поймать по
 * построению — он про CSP не знает.
 *
 * Отсюда: сервер тот же, что в проде. Нарушения политики браузер пишет в
 * консоль, а консоль здесь уже собирается в pageErrors — то есть проверка
 * появляется бесплатно, вместе с остальными.
 *
 * apiDir — пустой временный каталог: маршруты /api/* в этом прогоне должны
 * честно отвечать 404, а не поднимать боевые функции без переменных окружения.
 */
const ПУСТОЙ_API = mkdtempSync(path.join(os.tmpdir(), 'fitpro-guest-noapi-'))
const server = createServer(createRequestHandler({ apiDir: ПУСТОЙ_API, distDir: DIST }))
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
  // Заведомо негодная ссылка доступа из раздела 8 — приложение о ней и должно
  // сообщать. Это проверяемое поведение, а не поломка страницы.
  if (/Вход по ссылке не удался/.test(t)) return
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

// ── 1. приложение открывается по основной ссылке, без всякого флага ────────
await open('')

report('по корневому адресу открывается приложение, а не форма регистрации',
  await page.evaluate(() => document.getElementById('root').childElementCount > 0)
  && await page.locator('[data-testid="guest-login"]').count() === 1)

// Лендинга самого по себе больше нет: форма входа существует только как окно
// поверх приложения, и без нажатия «Войти» её на экране быть не должно.
report('лендинг сам по себе не показывается',
  await page.locator('[data-testid="auth-back-to-app"]').count() === 0)

// ── 1б. приветствие: один раз на устройстве ────────────────────────────────
report('на первом заходе показано приветствие',
  await page.locator('[data-testid="welcome-sheet"]').count() === 1)

// Кнопка одна и она не про деньги: цены с приветствия убраны по полевому
// прогону — человек, который ещё ничего не попробовал, пакет не оценит.
report('в приветствии одна кнопка «Начать», ценами не встречаем',
  await page.locator('[data-testid="welcome-close"]').count() === 1
  && await page.locator('[data-testid="welcome-plans"]').count() === 0
  && (await page.locator('[data-testid="welcome-close"]').textContent()).trim() === 'Начать')

await page.locator('[data-testid="welcome-close"]').click()
await page.waitForTimeout(500)
report('«Начать» убирает приветствие',
  await page.locator('[data-testid="welcome-sheet"]').count() === 0)
// обещано «один раз на устройстве», а не «один раз за вкладку»
await open('')
report('и после перезагрузки оно не возвращается',
  await page.locator('[data-testid="welcome-sheet"]').count() === 0)

// ── 1в. тарифы гостю на чтение ─────────────────────────────────────────────
// Приветствие ценами больше не встречает, поэтому путь к ним обязан быть в
// самом приложении: на телефоне шторки профиля у гостя нет, и без кнопки в
// шапке тарифы были бы недостижимы иначе как упёршись в платное.
await page.locator('[data-testid="guest-plans"]').click()
await page.waitForTimeout(1300)
report('гость открывает тарифы из шапки, а не заставку загрузки',
  await page.locator('[data-testid="plans-buy-create-account"]').count() === 1)
report('у гостя нет ни покупки, ни пробного — только «Создать аккаунт»',
  await page.locator('[data-testid="trial-start"]').count() === 0
  && await page.locator('[data-testid="plans-create-account"]').count() === 1)

await page.locator('[data-testid="plans-buy-create-account"]').click()
await page.waitForTimeout(1000)
report('кнопка тарифа ведёт на форму регистрации',
  await page.locator('[data-testid="auth-back-to-app"]').count() === 1)
report('и помечает источник — по нему считается register_from_offer',
  await page.evaluate(() => sessionStorage.getItem('fitpro_offer_src')) === 'plans')

await page.locator('[data-testid="auth-back-to-app"]').click()
await page.waitForTimeout(800)
report('из формы гость возвращается в приложение',
  await page.locator('[data-testid="guest-login"]').count() === 1)

for (const tab of ['workouts', 'nutrition', 'library', 'progress']) {
  const btn = page.locator(`[data-testid="tab-${tab}"]`)
  const has = await btn.count()
  if (has) { await btn.click(); await page.waitForTimeout(900) }
  report(`вкладка «${tab}» открывается`, has === 1 && await page.evaluate(() => document.querySelector('.mobile-content')?.childElementCount > 0))
}

report('следа от прежнего флага не осталось ни в адресе, ни на диске',
  await page.evaluate(() => !localStorage.getItem('fitpro_guest')))

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
  await page.evaluate(() => ['fitpro_history', 'fitpro_food_diary', 'fitpro_guest_pending', 'fitpro_custom_ex', 'fitpro_slots_meta_v2']
    .every((k) => !localStorage.getItem(k))
    && !Object.keys(localStorage).some((k) => k.startsWith('fitpro-motion.'))),
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('fitpro')).join(', ')))

/**
 * СЛЕДА НЕ ДОЛЖНО БЫТЬ И ОТ ПРОСТОГО ОТКРЫТИЯ. `fitpro_slots_meta_v2` писался
 * не по действию человека, а по самой загрузке слотов — то есть от того, что
 * гость просто зашёл на «Тренировки» и ничего не сделал.
 */
await page.locator('[data-testid="tab-workouts"]').click()
await page.waitForTimeout(1200)
report('открытие «Тренировок» само по себе следа не оставляет',
  await page.evaluate(() => !localStorage.getItem('fitpro_slots_meta_v2')))

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

// ── 7. прежний флаг в ссылке просто ничего не значит ───────────────────────
await page.evaluate(() => localStorage.clear())
await open('?guest=1')
report('?guest=1 в адресе игнорируется — то же самое приложение',
  await page.locator('[data-testid="guest-login"]').count() === 1
  && await page.locator('[data-testid="tab-workouts"]').count() === 1)
report('и на диск он ничего не пишет',
  await page.evaluate(() => !localStorage.getItem('fitpro_guest')))

// ── 8. ссылка доступа тренера не перехвачена гостевым правилом ─────────────
// Токен заведомо негодный, и сеть в прогоне заглушена — важно ровно одно:
// человек НЕ проваливается молча в гостевой режим. Он должен увидеть форму
// входа с объяснением, иначе протухшая ссылка выглядит как «тренер пропал».
await page.evaluate(() => localStorage.clear())
await open('?access=nosuchtoken')
report('протухшая ссылка ?access= показывает форму входа, а не молчит',
  await page.locator('[data-testid="auth-back-to-app"]').count() === 1)
report('и приветствие поверх неё не лезет',
  await page.locator('[data-testid="welcome-sheet"]').count() === 0)
await page.locator('[data-testid="auth-back-to-app"]').click()
await page.waitForTimeout(800)
report('из неё можно уйти в приложение гостем',
  await page.locator('[data-testid="guest-login"]').count() === 1)

// ── 9. CSP не мешает приложению работать ───────────────────────────────────
// Отдельной строкой, а не внутри общей проверки ошибок: нарушение политики
// выглядит в консоли как обычная ошибка, и в общей куче его причина потерялась
// бы. Здесь же сразу видно, ЧТО именно политика не пустила, — а значит видно и
// куда это дописывать в buildCsp() в server.mjs.
const нарушенияCsp = [...new Set(pageErrors)].filter(t => /Content Security Policy|Refused to (load|execute|connect|frame)/i.test(t))
report('за весь прогон CSP ничего не заблокировала', нарушенияCsp.length === 0,
  нарушенияCsp.slice(0, 3).join(' | '))

// ── итог ───────────────────────────────────────────────────────────────────
report('ни одной ошибки на странице за весь прогон', pageErrors.length === 0,
  [...new Set(pageErrors)].slice(0, 3).join(' | '))

await browser.close()
server.close()

console.log(`\nИтог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
