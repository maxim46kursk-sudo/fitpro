// test-challenge-staff.mjs — служебный поток челленджа (тест-поток, 50 ₽).
//
// СМЫСЛ ПОТОКА тот же, что у служебного тарифа ТЕСТ 50: владелец обязан пройти
// весь путь покупки живыми деньгами — ссылка, подпись, вебхук, зачисление,
// номер участника, комната с отсчётом, — не открывая продажу людям. Значит и
// проверять надо не «работает ли тест-поток», а три опасности:
//
//   1. ПОТОК ВИДЕН ЛИШНИМ. Билет за 50 ₽ вместо 2990 привлекателен ровно
//      настолько, чтобы его искали. Отсекает его RLS в базе, а не экран,
//      поэтому сюда попадает и проверка самой миграции.
//   2. ПОТОК КУПЛЕН ЛИШНИМ. Скрытие в интерфейсе от прямого POST не защищает:
//      ручка обязана выбрать поток ПО РОЛИ ИЗ БАЗЫ, и цену подставить из
//      выбранного потока, а не из тела запроса.
//   3. БИЛЕТ И ТАРИФ СПУТАНЫ. 50 ₽ уже занято тарифом ТЕСТ 50. Разводит их
//      ярлык платежа вместе с ценой потока — это проверяется в
//      test-prodamus.mjs, здесь же проверяется вход в то правило: какая цена
//      попадёт в ссылку.
//
// Запуск: node test-challenge-staff.mjs

import { readFileSync } from 'node:fs'

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'
process.env.PRODAMUS_SECRET_KEY = process.env.PRODAMUS_SECRET_KEY || 'test-secret-key'
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

const { pickSeason, LIVE_STATUSES, STAFF_STATUS, seesStaffSeason } = await import('./api/_challengeSeason.js')
const { default: createPayment } = await import('./api/create-payment.js')

const SUPA_HOST = new URL(process.env.VITE_SUPABASE_URL).host
const REAL_FETCH = globalThis.fetch
const TRAINER = '33333333-3333-4333-8333-333333333333'
const CLIENT = '11111111-1111-4111-8111-111111111111'
const MIGRATION = 'sql/2026-08-25_challenge_staff_season.sql'

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const OPEN = { id: 1, title: 'Поток 1', status: 'open', price_rub: 2990, starts_on: null }
const STAFF = { id: 2, title: 'Тест-поток', status: 'staff', price_rub: 50, starts_on: '2026-09-10' }
const RUNNING = { id: 3, title: 'Поток 0', status: 'running', price_rub: 2990, starts_on: '2026-08-01' }
const DRAFT = { id: 4, title: 'Поток 2', status: 'draft', price_rub: 2990, starts_on: null }

// ══════════════════════════════════════════════════════════════════════════
// 1. Правило выбора потока — одно на клиент, обе ручки и тесты
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Какой поток человеку ───────────────────────────────────────────')

const forTrainer = rows => pickSeason(rows, { staffAllowed: seesStaffSeason('trainer') })
const forClient = rows => pickSeason(rows, { staffAllowed: seesStaffSeason('client') })

assertEqual('тренер: есть служебный — берётся он', forTrainer([OPEN, STAFF])?.id, STAFF.id)
assertEqual('тренер: служебного нет — берётся открытый', forTrainer([OPEN])?.id, OPEN.id)
assertEqual('тренер: порядок строк роли не играет', forTrainer([STAFF, OPEN])?.id, STAFF.id)
assertEqual('участник: служебный не выбирается никогда', forClient([OPEN, STAFF])?.id, OPEN.id)
assertEqual('участник: кроме служебного ничего нет — потока нет вовсе', forClient([STAFF]), null)
assertEqual('роль без имени (гость, пустой профиль) — как участник', pickSeason([OPEN, STAFF], {})?.id, OPEN.id)

// Черновик не живой ни для кого: в нём обкатывают цену и условия.
assertEqual('черновик не берётся и тренеру', forTrainer([DRAFT]), null)
assertEqual('черновик не берётся и участнику', forClient([DRAFT, OPEN])?.id, OPEN.id)
assertEqual('идущий поток берётся, когда открытого набора нет', forClient([RUNNING])?.id, RUNNING.id)
assertEqual('открытый важнее идущего — покупать можно только в него', forClient([RUNNING, OPEN])?.id, OPEN.id)
assertEqual('пусто → потока нет', [forClient([]), forClient(null), forClient(undefined)], [null, null, null])

// Свой поток важнее любого другого: пока идёт мой поток, набор в следующий
// может быть уже открыт, и показать мне цену нового билета вместо собственного
// номера было бы обманом.
{
  const mine = { ...RUNNING, challenge_entries: [{ id: 7 }] }
  const hasEntry = row => !!row.challenge_entries?.length
  assertEqual('свой поток важнее открытого',
    pickSeason([mine, OPEN], { staffAllowed: false, hasEntry })?.id, mine.id)
  assertEqual('и важнее служебного — тренер, уже купивший билет в боевой',
    pickSeason([mine, STAFF], { staffAllowed: true, hasEntry })?.id, mine.id)
}

assertEqual('живыми считаются ровно три состояния', [...LIVE_STATUSES].sort(), ['open', 'running', 'staff'])
assertEqual('служебное состояние названо одним словом', STAFF_STATUS, 'staff')
assertEqual('служебный поток существует только для тренера',
  ['trainer', 'client', null, undefined, 'admin'].map(seesStaffSeason),
  [true, false, false, false, false])

// ══════════════════════════════════════════════════════════════════════════
// 2. create-payment: цена в ссылке — из выбранного потока
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── create-payment: ссылка выписывается на цену потока ──────────────')

/**
 * База глазами ручки: она ходит service_role-ключом, значит RLS её не касается
 * и сезоны ей приезжают ВСЕ. Отсекает служебный поток именно код, и проверять
 * это надо на мире, где строка есть.
 */
function stubPay({ role = 'client', uid = CLIENT, seasons = [OPEN, STAFF], entries = [], kcal = 2000 } = {}) {
  const seen = { seasonQueries: [], entryQueries: [] }
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.host !== SUPA_HOST) throw new Error(`неожиданный хост: ${u.host}`)
    const path = u.pathname
    if (path.startsWith('/auth/v1/user')) return json({ id: uid, aud: 'authenticated' })
    if (path.startsWith('/rest/v1/profiles')) return json([{ role }])
    if (path.startsWith('/rest/v1/food_goals')) return json([{ kcal, p: 120, c: 220, f: 65 }])
    if (path.startsWith('/rest/v1/challenge_seasons')) {
      seen.seasonQueries.push(u.search)
      return json(seasons)
    }
    if (path.startsWith('/rest/v1/challenge_entries')) {
      seen.entryQueries.push(u.search)
      return json(entries)
    }
    throw new Error(`неожиданный путь: ${path}`)
  }
  return seen
}
const restore = () => { globalThis.fetch = REAL_FETCH }

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: undefined }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.status = n => { r.statusCode = n; return r }
  r.json = b => { r.body = b; return r }
  r.end = () => r
  return r
}
let ip = 0
const payReq = (body, auth = 'Bearer t') => ({
  method: 'POST', body,
  headers: { 'x-real-ip': `10.13.0.${++ip}`, ...(auth ? { authorization: auth } : {}) },
  socket: {},
})
// Цена в ссылке лежит в products[0][price], разобранном qs при подписи.
const priceInUrl = url => new URL(String(url)).searchParams.get('products[0][price]')

{
  const res = mockRes()
  stubPay({ role: 'trainer', uid: TRAINER })
  await createPayment(payReq({ plan: 'challenge', source: 'web' }), res)
  restore()
  assertEqual('тренер получает ссылку', res.statusCode, 200)
  assertEqual('и она выписана на 50 ₽ — цену тест-потока', priceInUrl(res.body?.url), '50')
  report('ссылка подписана', /signature=/.test(res.body?.url || ''))
  report('ярлык платежа называет билет, а не тариф',
    String(res.body?.url).includes(`${TRAINER}__challenge`))
}
{
  // Тот же прямой запрос от постороннего. Служебный поток в базе есть, но ему
  // не выбирается — и цену 50 он получить не может ничем.
  const res = mockRes()
  stubPay({ role: 'client', uid: CLIENT })
  await createPayment(payReq({ plan: 'challenge', source: 'web' }), res)
  restore()
  assertEqual('участник получает ссылку в открытый поток', res.statusCode, 200)
  assertEqual('и она выписана на боевые 2990', priceInUrl(res.body?.url), '2990')
}
{
  // Живого потока для человека нет вовсе: служебный есть, но не для него.
  const res = mockRes()
  stubPay({ role: 'client', uid: CLIENT, seasons: [STAFF] })
  await createPayment(payReq({ plan: 'challenge', source: 'web' }), res)
  restore()
  assertEqual('посторонний не купит тест-поток прямым запросом', res.statusCode, 409)
  assertEqual('и это отказ, а не «ты уже участник»', res.body?.reason, 'no_season')
  report('ссылки на оплату не выдали', !res.body?.url)
  report('и о существовании тест-потока ответ не проговаривается',
    !/50|служеб|тест-поток/i.test(String(res.body?.error)), String(res.body?.error))
}
{
  // Потока нет ни у кого. Раньше ссылку выписывали по зашитой цене; теперь
  // цену объявляет поток, и без потока её неоткуда взять.
  const res = mockRes()
  stubPay({ role: 'trainer', uid: TRAINER, seasons: [] })
  await createPayment(payReq({ plan: 'challenge', source: 'web' }), res)
  restore()
  assertEqual('без живого потока билет не продаётся', res.statusCode, 409)
  report('ссылки на оплату не выдали', !res.body?.url)
}
{
  // Второй билет в свой же поток — деньги, за которые человек ничего не
  // получит. Проверка идёт по ТОМУ потоку, который человеку выбран.
  const res = mockRes()
  const seen = stubPay({ role: 'trainer', uid: TRAINER, entries: [{ id: 5 }] })
  await createPayment(payReq({ plan: 'challenge', source: 'web' }), res)
  restore()
  assertEqual('второй билет не выписывается', res.statusCode, 409)
  assertEqual('и это единственный 409, который значит «всё в порядке»', res.body?.reason, 'already')
  report('участие проверялось именно в выбранном потоке',
    seen.entryQueries.some(q => q.includes('season_id=eq.2')), seen.entryQueries.join(' | '))
}
{
  // АНКЕТЫ ПЕРЕД ДЕНЬГАМИ БОЛЬШЕ НЕТ. Здесь стоял отказ 409 тому, у кого не
  // заполнена дневная норма. Довод был верный — питание половина зачёта, — а
  // цена неверная: форма между человеком и кнопкой оплаты убивает продажу
  // вернее любой цены. Правило переехало в комнату (данные спрашивают после
  // оплаты), а дни без нормы честно считаются нулём.
  const res = mockRes()
  stubPay({ role: 'trainer', uid: TRAINER, kcal: 0 })
  await createPayment(payReq({ plan: 'challenge', source: 'web' }), res)
  restore()
  assertEqual('без нормы билет ВЫПИСЫВАЕТСЯ: анкеты перед кассой нет', res.statusCode, 200)
  report('и ссылка настоящая, на цену потока', priceInUrl(res.body?.url) === '50', String(res.body?.url).slice(0, 90))
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Миграция: кого база пускает к служебному потоку
// ══════════════════════════════════════════════════════════════════════════
//
// Скрытие в интерфейсе — удобство; отказ базы — защита. Клиент читает сезоны
// напрямую своим ключом (src/challengeSeason.js), поэтому «обычный участник его
// не видит вовсе» — это утверждение не про экран, а про RLS. Проверяем текст
// миграции: живой базы у теста нет, а разъехаться политика и код могут молча.
console.log('\n── Миграция: RLS отдаёт служебный поток только тренеру ─────────────')

const sql = readFileSync(MIGRATION, 'utf8')

report('состояние staff разрешено ограничением',
  /check \(status in \([^)]*'staff'[^)]*\)\)/.test(sql))
report('политика чтения пересоздаётся', /create policy challenge_seasons_read/.test(sql))

// Политика: открытые/идущие/завершённые — всем вошедшим; staff — по роли.
const policy = sql.slice(sql.indexOf('create policy challenge_seasons_read'))
  .slice(0, sql.slice(sql.indexOf('create policy challenge_seasons_read')).indexOf(';') + 1)
report('всем вошедшим — только не-служебные состояния',
  /status in \('open', 'running', 'finished'\)/.test(policy), policy)
report('служебный — под условием роли тренера',
  /status = 'staff'/.test(policy) && /public\.is_trainer\(\)/.test(policy), policy)
// is_trainer() берёт роль из profiles по auth.uid(), то есть из подписанного
// токена. Отдельной проверки роли в политике быть не должно: второй ответ на
// тот же вопрос однажды разойдётся с первым.
report('роль спрашивается общей функцией, а не своим подзапросом',
  !/from public\.profiles/.test(policy), policy)
report("прежнее правило «всё кроме черновика» убрано — оно пустило бы staff всем",
  !/status <> 'draft'/.test(sql))
report('политика меняется ДО вставки строки',
  sql.indexOf('create policy challenge_seasons_read') < sql.indexOf('insert into public.challenge_seasons'))

// Условия потока — боевые: путь покупки обязан быть неотличим от настоящего.
const seed = sql.slice(sql.indexOf('insert into public.challenge_seasons'))
report('заводится один поток, служебный', /'staff'/.test(seed) && /'Тест-поток'/.test(seed), seed.slice(0, 200))
report('цена 50 ₽', /\b50\b/.test(seed))
report('старт 10 сентября 2026', /2026-09-10/.test(seed))
report('призовой фонд боевой — половина сборов, делёж 50/30/20',
  /\{50,30,20\}/.test(seed) && /, 50, 50, /.test(seed), seed.slice(seed.indexOf('select'), seed.indexOf('where')))
report('повторный прогон не заводит второй тест-поток', /where not exists/.test(seed))
report('«Поток 1» миграция не трогает', !/Поток 1/.test(sql))

console.log('\n────────────────────────────────────────────────────────────────────')
console.log(`Итог: ${pass} пройдено, ${fail} провалено`)
process.exit(fail ? 1 : 0)
