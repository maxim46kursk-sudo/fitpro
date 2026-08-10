// test-plan-test50.mjs — служебный тариф test50 (проверка живой оплаты, 50 ₽).
//
// СМЫСЛ ТАРИФА в том, что он идёт по ТЕМ ЖЕ рельсам, что боевые пакеты: та же
// ссылка Продамуса, та же подпись, тот же вебхук, то же начисление. Поэтому
// главное, что здесь проверяется, — не «работает ли test50», а «не завелось ли
// ради него обходного пути» и «не протёк ли он к клиентам».
//
// Три опасности, каждой посвящён свой раздел:
//   1. ТАРИФ ВИДЕН ЛИШНИМ. Скидка 2990 → 50 привлекательна ровно настолько,
//      чтобы её искали. Пилюля не должна появляться ни у обычного клиента, ни
//      у клиента тренера.
//   2. ТАРИФ КУПЛЕН ЛИШНИМ. Спрятанная пилюля от прямого POST не защищает:
//      ручка обязана отказать по РОЛИ ИЗ БАЗЫ.
//   3. ТАБЛИЦЫ РАЗЪЕХАЛИСЬ. Цена и срок продублированы между src/plans.js и
//      api/ (собираются раздельно). Копия, за которой никто не следит,
//      однажды разойдётся — здесь она сверяется поимённо.
//
// Запуск: node test-plan-test50.mjs

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'
process.env.PRODAMUS_SECRET_KEY = process.env.PRODAMUS_SECRET_KEY || 'test-secret-key'
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

const { PLANS, planByKey, visiblePlans, daysOfPlan, PLAN_DAYS_DEFAULT, effectiveAccess } = await import('./src/plans.js')
const { PLAN_PRICE, PLAN_NAME, STAFF_PLANS, buildPaymentData, createSignature } = await import('./api/_prodamus.js')
const { PLAN_DAYS_BY_KEY } = await import('./api/prodamus-webhook.js')
const { default: createPayment } = await import('./api/create-payment.js')
const { default: webhook } = await import('./api/prodamus-webhook.js')

const SUPA_HOST = new URL(process.env.VITE_SUPABASE_URL).host
const REAL_FETCH = globalThis.fetch
const TRAINER = '33333333-3333-4333-8333-333333333333'
const CLIENT = '11111111-1111-4111-8111-111111111111'

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

// ══════════════════════════════════════════════════════════════════════════
// 1. Кому тариф виден
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Видимость: только тренеру ──────────────────────────────────────')

const keysFor = role => visiblePlans(role).map(p => p.key)

assertEqual('обычный клиент (role=client) test50 НЕ видит', keysFor('client').includes('test50'), false)
assertEqual('клиент тренера — та же роль client, тоже не видит', keysFor('client'), ['start', 'profit', 'premium'])
assertEqual('аноним без роли не видит', keysFor(undefined).includes('test50'), false)
assertEqual('null-роль не видит', keysFor(null).includes('test50'), false)
// Роль подделать в браузере можно, поэтому это удобство, а не защита, — но
// список всё равно обязан быть правильным.
assertEqual('тренер видит', keysFor('trainer').includes('test50'), true)
assertEqual('у тренера порядок и состав пилюль', keysFor('trainer'), ['start', 'profit', 'premium', 'test50'])
// hidden и staff — разные признаки: снятый с продажи не показываем даже тренеру.
assertEqual('снятая с продажи БАЗА не видна и тренеру', keysFor('trainer').includes('base'), false)

console.log('\n── Карточка тарифа ────────────────────────────────────────────────')
const t50 = planByKey('test50')
assertEqual('цена 50 ₽', t50.price, 50)
assertEqual('уровень как у ПРОФИТ', t50.level, planByKey('profit').level)
assertEqual('срок 1 день', daysOfPlan('test50'), 1)
assertEqual('у боевых пакетов срок прежний', [daysOfPlan('profit'), daysOfPlan('premium')], [30, 30])
assertEqual('умолчание срока не тронуто', PLAN_DAYS_DEFAULT, 30)
report('подпись явно служебная', /[Сс]лужебн/.test(t50.tagline) && /50/.test(t50.tagline), t50.tagline)
assertEqual('помечен как служебный', t50.staff, true)
// Уровень должен ДЕЙСТВИТЕЛЬНО открываться, иначе проверять нечего.
{
  const until = new Date(Date.now() + 86400000).toISOString()
  const acc = effectiveAccess({ plan: 'test50', plan_until: until }, Date.now())
  assertEqual('оплаченный test50 даёт уровень 2', acc.level, 2)
  assertEqual('и подписан своим именем', acc.label, 'ТЕСТ 50')
}
{
  // Истёкший — как любой другой: доступа нет.
  const acc = effectiveAccess({ plan: 'test50', plan_until: new Date(Date.now() - 1000).toISOString() }, Date.now())
  assertEqual('истёкший test50 не даёт ничего', acc.level, 0)
}
// planByLevel(2) обязан отдавать ПРОФИТ, а не служебный: у них одинаковый
// уровень, и порядок в списке — единственное, что их различает.
assertEqual('на уровне 2 «главный» тариф — ПРОФИТ', PLANS.find(p => p.level === 2).key, 'profit')

// ══════════════════════════════════════════════════════════════════════════
// 2. Кому тариф продаётся
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── create-payment: служебный тариф только тренеру ─────────────────')

function stubPay({ role = 'client', uid = CLIENT } = {}) {
  const seen = { profileReads: 0 }
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.host !== SUPA_HOST) throw new Error(`неожиданный хост: ${u.host}`)
    if (u.pathname.startsWith('/auth/v1/user')) return json({ id: uid, aud: 'authenticated' })
    if (u.pathname.startsWith('/rest/v1/profiles')) { seen.profileReads++; return json([{ role }]) }
    throw new Error(`неожиданный путь: ${u.pathname}`)
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
  headers: { 'x-real-ip': `10.11.0.${++ip}`, ...(auth ? { authorization: auth } : {}) },
  socket: {},
})

{
  const seen = stubPay({ role: 'client' })
  const res = mockRes()
  await createPayment(payReq({ plan: 'test50' }), res)
  restore()
  assertEqual('клиент просит test50 → отказ 400', res.statusCode, 400)
  assertEqual('ответ не выдаёт существования тарифа', res.body?.error, 'Неизвестный пакет')
  report('ссылки на оплату не выдали', !res.body?.url)
  assertEqual('роль читалась ИЗ БАЗЫ, а не из тела', seen.profileReads, 1)
}
{
  // Клиент тренера — та же роль client, тот же отказ.
  const seen = stubPay({ role: 'client', uid: '22222222-2222-4222-8222-222222222222' })
  const res = mockRes()
  await createPayment(payReq({ plan: 'test50' }), res)
  restore()
  assertEqual('клиент тренера тоже получает отказ', res.statusCode, 400)
  assertEqual('и у него роль спрашивали в базе', seen.profileReads, 1)
}
{
  const res = mockRes()
  stubPay({ role: 'trainer', uid: TRAINER })
  await createPayment(payReq({ plan: 'test50' }), res)
  restore()
  assertEqual('тренер получает ссылку', res.statusCode, 200)
  report('в ссылке есть подпись и цена 50', /signature=/.test(res.body?.url || '') && /50/.test(res.body?.url || ''),
    String(res.body?.url).slice(0, 120))
  report('order_id содержит id тренера', String(res.body?.url).includes(`${TRAINER}__test50`))
}
{
  // Боевые пакеты роль не спрашивают — лишний запрос в профиль на каждой
  // покупке был бы платой за одну служебную кнопку.
  const seen = stubPay({ role: 'client' })
  const res = mockRes()
  await createPayment(payReq({ plan: 'profit' }), res)
  restore()
  assertEqual('обычная покупка проходит', res.statusCode, 200)
  assertEqual('за ролью в базу не ходили', seen.profileReads, 0)
}
{
  const res = mockRes()
  stubPay({ role: 'client' })
  await createPayment(payReq({ plan: 'base' }), res)
  restore()
  assertEqual('снятая с продажи БАЗА по-прежнему отвергается', res.statusCode, 400)
}
{
  const res = mockRes()
  stubPay({ role: 'trainer', uid: TRAINER })
  await createPayment(payReq({ plan: 'test50' }, null), res)
  restore()
  assertEqual('без токена → 401 даже тренеру', res.statusCode, 401)
}

console.log('\n── Ссылка на оплату строится общим кодом ──────────────────────────')
{
  const data = buildPaymentData({ userId: TRAINER, plan: 'test50', source: 'web' })
  assertEqual('цена в заказе — 50, из общей таблицы', data.products[0].price, '50')
  assertEqual('название заказа читаемое', data.products[0].name, 'Подписка FitPro — ТЕСТ 50')
  assertEqual('order_id по общему правилу', data.order_id, `${TRAINER}__test50`)
  assertEqual('адрес возврата тот же, что у боевых', data.urlSuccess,
    buildPaymentData({ userId: TRAINER, plan: 'profit', source: 'web' }).urlSuccess)
  report('подпись считается тем же кодом', typeof createSignature(data, 'k') === 'string')
  assertEqual('тариф числится служебным', STAFF_PLANS.has('test50'), true)
  assertEqual('боевые служебными не числятся', [STAFF_PLANS.has('profit'), STAFF_PLANS.has('premium')], [false, false])
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Начисление вебхуком
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Вебхук: 50 ₽ → сутки ───────────────────────────────────────────')

// Уведомление Продамуса приходит form-urlencoded и подписывается тем же
// алгоритмом, что и наша исходящая ссылка.
async function callWebhook({ sum, userId, currentUntil = null, coachId = null, role = 'client' }) {
  const body = {
    order_num: `ord-${sum}-${Math.floor(sum * 7)}`,
    sum: String(sum),
    payment_status: 'success',
    customer_extra: `${userId}__x`,
    date: '2026-08-10T12:00:00+03:00',
  }
  const { createSignature: sign } = await import('./api/_prodamus.js')
  const signature = sign(body, process.env.PRODAMUS_SECRET_KEY)
  const raw = new URLSearchParams(body).toString()

  const writes = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    if (u.pathname.startsWith('/rest/v1/profiles')) {
      if ((opts.method || 'GET') === 'GET') return json([{ id: userId, plan_until: currentUntil, coach_id: coachId, role }])
      writes.push(JSON.parse(opts.body))
      return json([{ id: userId, plan: JSON.parse(opts.body).plan, coach_id: coachId }])
    }
    if (u.pathname.startsWith('/rest/v1/payments')) { writes.push({ payments: JSON.parse(opts.body) }); return json([{}]) }
    if (u.pathname.startsWith('/auth/v1/')) return json({ user: { id: userId } })
    return json([])
  }

  const req = {
    method: 'POST',
    headers: { sign: signature, 'x-real-ip': `10.12.0.${++ip}` },
    socket: {},
    on: (ev, cb) => { if (ev === 'data') cb(raw); if (ev === 'end') cb() },
  }
  const res = mockRes()
  res.send = b => { res.body = b; return res }
  await webhook(req, res)
  restore()
  return { res, writes }
}

{
  const { res, writes } = await callWebhook({ sum: 50, userId: TRAINER })
  const upd = writes.find(w => w.plan)
  assertEqual('вебхук принял уведомление', res.statusCode, 200)
  assertEqual('начислен именно test50', upd?.plan, 'test50')
  const days = (new Date(upd.plan_until).getTime() - Date.now()) / 86400000
  report('срок — ОДИН день, а не 30', days > 0.9 && days < 1.1, `дней: ${days.toFixed(2)}`)
}
{
  // Продление: сутки прибавляются к текущему сроку, не затирают его. Правило
  // общее с боевыми пакетами — на нём и проверяем, что путь один.
  const until = new Date(Date.now() + 10 * 86400000).toISOString()
  const { writes } = await callWebhook({ sum: 50, userId: TRAINER, currentUntil: until })
  const upd = writes.find(w => w.plan)
  const days = (new Date(upd.plan_until).getTime() - Date.now()) / 86400000
  report('при активной подписке добавляет сутки к сроку', days > 10.9 && days < 11.1, `дней: ${days.toFixed(2)}`)
}
{
  // Боевой пакет обязан остаться тридцатидневным: таблица сроков не должна
  // задеть ничего, кроме служебного тарифа.
  const { writes } = await callWebhook({ sum: 2990, userId: CLIENT })
  const upd = writes.find(w => w.plan)
  assertEqual('2990 — по-прежнему profit', upd?.plan, 'profit')
  const days = (new Date(upd.plan_until).getTime() - Date.now()) / 86400000
  report('и по-прежнему 30 дней', days > 29.9 && days < 30.1, `дней: ${days.toFixed(2)}`)
}
{
  // Сумма, которой нет в таблице, по-прежнему ничего не начисляет.
  const { writes } = await callWebhook({ sum: 70, userId: CLIENT })
  assertEqual('70 ₽ ничего не начисляет', writes.filter(w => w.plan).length, 0)
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Копии таблиц не разъехались
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── src/plans.js и api/ говорят одно и то же ───────────────────────')

for (const key of Object.keys(PLAN_PRICE)) {
  assertEqual(`цена ${key} совпадает с src/plans.js`, PLAN_PRICE[key], planByKey(key).price)
}
for (const key of Object.keys(PLAN_NAME)) {
  assertEqual(`название ${key} совпадает с src/plans.js`, PLAN_NAME[key], planByKey(key).name)
}
for (const key of Object.keys(PLAN_DAYS_BY_KEY)) {
  assertEqual(`срок ${key} совпадает с src/plans.js`, PLAN_DAYS_BY_KEY[key], daysOfPlan(key))
}
// И обратно: у тарифа со своим сроком в src/ обязана быть строка в таблице
// вебхука, иначе он молча начислит 30 дней вместо своего срока.
for (const p of PLANS.filter(p => p.days)) {
  assertEqual(`у ${p.key} со своим сроком есть строка в вебхуке`, PLAN_DAYS_BY_KEY[p.key], p.days)
}

// ══════════════════════════════════════════════════════════════════════════
// 5. Ограничение базы знает все тарифы
// ══════════════════════════════════════════════════════════════════════════
//
// ЭТОТ РАЗДЕЛ ПОЯВИЛСЯ ПОСЛЕ ЖИВОГО СБОЯ. На profiles.plan висит CHECK со
// списком допустимых значений. Тариф test50 добавили в код, а в список — нет;
// оплата прошла, деньги списались, запись пакета упала на констрейнте. Деньги
// взяты, доступ не выдан — худший вид поломки.
//
// Заглушкой PostgREST это не ловится: она констрейнтов не проверяет. Поэтому
// читаем САМ ФАЙЛ МИГРАЦИИ и сверяем список значений с ключами тарифов.
// Добавили тариф и забыли про базу — падаем здесь, до того как кто-то заплатит.
console.log('\n── Ограничение базы знает все тарифы ──────────────────────────────')
{
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync('sql/2026-08-10_profiles_plan_test50.sql', 'utf8')
  const m = sql.match(/check \(plan = any \(array\[([^\]]+)\]\)\)/i)
  report('в миграции найден список допустимых планов', !!m)
  if (m) {
    const allowed = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    for (const p of PLANS) {
      assertEqual(`тариф ${p.key} разрешён в profiles_plan_check`, allowed.includes(p.key), true)
    }
    // И обратно: лишних значений в констрейнте быть не должно — иначе в plan
    // однажды ляжет ключ, которого нет в PLANS, и planByKey отдаст СТАРТ,
    // молча обнулив человеку доступ.
    for (const a of allowed) {
      assertEqual(`значение ${a} из констрейнта есть среди тарифов`, PLANS.some(p => p.key === a), true)
    }
  }
}

console.log('\n' + '─'.repeat(68))
console.log(`Итог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
