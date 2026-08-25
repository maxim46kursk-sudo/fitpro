// Адрес возврата после оплаты и его участие в подписи — api/_prodamus.js.
//
// Что здесь защищается. Возврат после оплаты вёл В БОТА у всех, включая тех,
// кто платит из браузера и Telegram не пользуется: человек отдавал деньги и
// попадал в тупик ровно в тот момент, когда доверие к сервису максимально
// хрупкое. Теперь адрес зависит от источника платежа, и у этого две стороны,
// которые обе могут сломаться молча:
//   1) выбор адреса — 'web' обязан вести в приложение, ВСЁ остальное в бота;
//   2) подпись — адрес обязан попасть в подписанные данные, иначе Продамус
//      отклонит ссылку, и оплата не откроется вообще ни у кого.
//
// Отдельно проверяется, что адрес нельзя подсунуть из тела запроса: urlSuccess
// подписывается нашим ключом, и приём произвольного URL превратил бы ручку в
// открытый редирект с валидной подписью.

import { strict as assert } from 'node:assert'
import qs from 'qs'
import {
  returnUrlFor, buildPaymentData, createSignature, verifySignature,
  TELEGRAM_RETURN_URL, DEFAULT_APP_URL, PLAN_PRICE,
} from './api/_prodamus.js'

let passed = 0, failed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}
const quiet = fn => () => {
  const { error } = console
  console.error = () => {}
  try { return fn() } finally { console.error = error }
}

const WEB_URL = DEFAULT_APP_URL + '/?paid=1'
const SECRET = 'test-secret-key'
const USER = '6838d807-fb05-4c7d-af71-a13360373dcd'

console.log('\nprodamus: куда возвращаемся после оплаты')

test("source 'web' → возврат в приложение с ?paid=1", () => {
  assert.equal(returnUrlFor('web'), WEB_URL)
})

test("source 'telegram' → прежнее поведение, ссылка на бота", () => {
  assert.equal(returnUrlFor('telegram'), TELEGRAM_RETURN_URL)
})

test('source отсутствует → прежнее поведение (обратная совместимость)', () => {
  // Старый клиент, не знающий про source, обязан работать как раньше.
  assert.equal(returnUrlFor(undefined), TELEGRAM_RETURN_URL)
})

// Всё, что не ровно 'web', обязано вести в бота. Список — это перечень
// способов промахнуться мимо строгого сравнения.
for (const [label, value] of [
  ['null', null],
  ['пустая строка', ''],
  ['другой регистр WEB', 'WEB'],
  ['с пробелами', ' web '],
  ['неизвестное значение', 'desktop'],
  ['число', 1],
  ['объект', { source: 'web' }],
  ['массив', ['web']],
  ['true', true],
]) {
  test(`неизвестный source (${label}) → бот, а не приложение`, () => {
    assert.equal(returnUrlFor(value), TELEGRAM_RETURN_URL)
  })
}

console.log('\nprodamus: адрес нельзя подсунуть снаружи')

test('URL в поле source не становится адресом возврата', () => {
  // Самое опасное: подписанная нами ссылка, уводящая на чужой сайт.
  const evil = 'https://evil.example.com/phish'
  assert.equal(returnUrlFor(evil), TELEGRAM_RETURN_URL)
  const data = buildPaymentData({ userId: USER, plan: 'profit', source: evil })
  assert.equal(data.urlSuccess, TELEGRAM_RETURN_URL)
  assert.equal(data.urlReturn, TELEGRAM_RETURN_URL)
  assert.equal(JSON.stringify(data).includes('evil.example.com'), false, 'чужой домен не должен попасть в данные вообще')
})

test('APP_PUBLIC_URL уважается, хвостовой слэш не задваивается', () => {
  assert.equal(returnUrlFor('web', 'https://my.app'), 'https://my.app/?paid=1')
  assert.equal(returnUrlFor('web', 'https://my.app/'), 'https://my.app/?paid=1')
  assert.equal(returnUrlFor('web', 'https://my.app///'), 'https://my.app/?paid=1')
})

test('битый APP_PUBLIC_URL → откат на рабочий адрес, а не пустой возврат', quiet(() => {
  // Опечатка в переменной окружения не должна оставлять человека без возврата
  // после оплаты — это тот же тупик, только по другой причине.
  for (const bad of ['не адрес', 'http://insecure.example.com', '/relative', '']) {
    assert.equal(returnUrlFor('web', bad), WEB_URL, `битое значение ${JSON.stringify(bad)}`)
  }
}))

console.log('\nprodamus: подпись считается по данным С УЖЕ подставленным адресом')

test('подпись проходит проверку для веб-возврата', () => {
  const data = buildPaymentData({ userId: USER, plan: 'profit', source: 'web' })
  assert.equal(data.urlSuccess, WEB_URL)
  const signature = createSignature(data, SECRET)
  assert.equal(verifySignature(data, SECRET, signature), true)
})

test('подпись проходит проверку для телеграм-возврата', () => {
  const data = buildPaymentData({ userId: USER, plan: 'premium', source: 'telegram' })
  const signature = createSignature(data, SECRET)
  assert.equal(verifySignature(data, SECRET, signature), true)
})

test('адрес РЕАЛЬНО входит в подпись — разный source даёт разную подпись', () => {
  // Главная проверка файла. Если urlSuccess когда-нибудь начнут подставлять
  // ПОСЛЕ createSignature, подписи совпадут — и Продамус отклонит ссылку.
  const web = buildPaymentData({ userId: USER, plan: 'profit', source: 'web' })
  const tg  = buildPaymentData({ userId: USER, plan: 'profit', source: 'telegram' })
  const sigWeb = createSignature(web, SECRET)
  const sigTg  = createSignature(tg, SECRET)
  assert.notEqual(sigWeb, sigTg, 'подписи обязаны отличаться — иначе адрес в них не участвует')
  // И перекрёстно: подпись от одного адреса не годится для другого.
  assert.equal(verifySignature(web, SECRET, sigTg), false)
  assert.equal(verifySignature(tg, SECRET, sigWeb), false)
})

test('подмена адреса после подписи ломает проверку', () => {
  const data = buildPaymentData({ userId: USER, plan: 'profit', source: 'telegram' })
  const signature = createSignature(data, SECRET)
  const tampered = { ...data, urlSuccess: 'https://evil.example.com' }
  assert.equal(verifySignature(tampered, SECRET, signature), false)
})

console.log('\nprodamus: итоговая ссылка')

test('в собранной ссылке есть подписанный адрес возврата, и она проверяется', () => {
  // Повторяем ровно то, что делает api/create-payment.js.
  const data = buildPaymentData({ userId: USER, plan: 'profit', source: 'web' })
  const signature = createSignature(data, SECRET)
  const url = 'https://maximathlete.payform.ru/?' + qs.stringify({ ...data, signature })

  const parsed = qs.parse(url.split('?').slice(1).join('?'))
  assert.equal(parsed.urlSuccess, WEB_URL, 'адрес возврата обязан доехать до ссылки')
  assert.equal(parsed.urlReturn, WEB_URL)
  // Разбираем ссылку так же, как её увидит Продамус, и сверяем подпись.
  const { signature: fromUrl, ...dataFromUrl } = parsed
  assert.equal(verifySignature(dataFromUrl, SECRET, fromUrl), true, 'подпись из ссылки должна сходиться с её же данными')
})

test('сумма и состав заказа не зависят от source', () => {
  // Возврат — это только адрес. Если правка адреса когда-нибудь заденет цену,
  // вебхук определит не тот пакет (он опознаёт покупку по сумме).
  const web = buildPaymentData({ userId: USER, plan: 'profit', source: 'web' })
  const tg  = buildPaymentData({ userId: USER, plan: 'profit', source: 'telegram' })
  assert.equal(web.products[0].price, String(PLAN_PRICE.profit))
  assert.deepEqual(web.products, tg.products)
  assert.equal(web.order_id, tg.order_id)
  assert.equal(web.customer_extra, tg.customer_extra)
  assert.equal(web.order_id, `${USER}__profit`, 'userId в order_id — по нему вебхук находит плательщика')
})

// ══════════════════════════════════════════════════════════════════════════
// Билет челленджа: почему товар определяется не одной суммой
// ══════════════════════════════════════════════════════════════════════════
//
// Билет стоит те же 2990, что и ПРОФИТ. По старому правилу («сумма решает
// всё») его покупка начислила бы человеку ТАРИФ — не тот товар за те же
// деньги, причём молча и у каждого покупателя.
//
// Новое правило: ярлык платежа (часть после последнего '__') выбирает товар,
// но только если оплаченная сумма равна цене ИМЕННО ЭТОГО товара. Отсюда три
// вещи, которые обязаны быть верны одновременно и проверяются ниже:
//   1) 2990 с ярлыком '__challenge' → зачисление в поток и НИКАКОГО ПРОФИТА;
//   2) 2990 без нашего ярлыка → по-прежнему ПРОФИТ (старые ссылки и оплата
//      мимо приложения не должны сломаться);
//   3) ярлык без совпадения по сумме ничего не даёт — сумма осталась сторожем.
// И отдельно: повторное уведомление о том же платеже не создаёт второй записи
// в потоке — вебхук Продамуса умеет стучаться дважды.

process.env.PRODAMUS_SECRET_KEY = SECRET
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Динамический импорт — модуль читает адрес базы на загрузке, а переменные
// окружения выставлены строчкой выше.
const { default: webhook, resolveItem } = await import('./api/prodamus-webhook.js')
const REAL_FETCH = globalThis.fetch

const testAsync = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Мир одного сценария: состояние базы между вызовами вебхука. entries ведут
// себя как challenge_enroll в проде — идемпотентно по платежу и по человеку,
// номера подряд; payments — как UNIQUE(provider_order_num).
//
// СЕЗОНЫ ЛЕЖАТ ЗДЕСЬ ЦЕЛИКОМ, СО СТАТУСОМ И ЦЕНОЙ, и это не мелочь: цена билета
// приезжает из потока, а какой поток человеку — решает его роль. Мир отдаёт
// вебхуку ВСЕ строки, как отдал бы service_role-ключ (RLS его не касается), —
// значит выбор служебного потока проверяется именно здесь, в коде, а не в базе.
const OPEN_SEASON  = { id: 1, title: 'Поток 1',   status: 'open',  price_rub: 2990, starts_on: null }
const STAFF_SEASON = { id: 2, title: 'Тест-поток', status: 'staff', price_rub: 50,   starts_on: '2026-09-10' }

const makeWorld = (over = {}) => ({
  seasons: [{ ...OPEN_SEASON }],
  profileName: 'Пётр Петров',
  profileRole: null,  // 'trainer' — владелец; null — обычный участник
  entries: [],        // { paymentId, userId, no, name }
  payments: new Set(),
  paymentRows: [],
  planWrites: [],     // PATCH profiles — начисление тарифа
  enrollCalls: [],
  errors: [],
  ...over,
})

let payNo = 0
async function callWebhook(world, { sum, tag, userId = USER, orderId = null }) {
  // Ярлык живёт в customer_extra: наш order_id Продамус подменяет своим
  // номером платежа. tag === null — совсем без '__' (самые старые ссылки).
  const extra = tag === null ? userId : `${userId}__${tag}`
  const body = {
    order_num: extra,
    order_id: orderId !== null ? orderId : String(48000000 + (++payNo)),
    sum: String(sum),
    payment_status: 'success',
    customer_extra: extra,
    date: '2026-08-24T12:00:00+03:00',
  }
  const signature = createSignature(body, SECRET)
  const raw = new URLSearchParams(body).toString()

  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    const p = u.pathname
    const method = (opts.method || 'GET').toUpperCase()
    if (p.startsWith('/rest/v1/profiles')) {
      if (method === 'GET') return jsonResponse([{ id: userId, name: world.profileName, role: world.profileRole, plan_until: null, coach_id: null }])
      world.planWrites.push(JSON.parse(opts.body))
      return jsonResponse([{ id: userId, coach_id: null }])
    }
    if (p.startsWith('/rest/v1/challenge_seasons')) return jsonResponse(world.seasons)
    if (p.startsWith('/rest/v1/rpc/challenge_enroll')) {
      const args = JSON.parse(opts.body)
      world.enrollCalls.push(args)
      const byPayment = world.entries.find(e => e.paymentId === args.p_payment_id)
      if (byPayment) return jsonResponse(byPayment.no)
      const byUser = world.entries.find(e => e.userId === args.p_user_id)
      if (byUser) return jsonResponse(byUser.no)
      const row = { paymentId: args.p_payment_id, userId: args.p_user_id, no: world.entries.length + 1, name: args.p_display_name }
      world.entries.push(row)
      return jsonResponse(row.no)
    }
    if (p.startsWith('/rest/v1/payments')) {
      const row = JSON.parse(opts.body)
      if (world.payments.has(row.provider_order_num)) {
        return jsonResponse({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)
      }
      world.payments.add(row.provider_order_num)
      world.paymentRows.push(row)
      return jsonResponse([{}])
    }
    if (p.startsWith('/rest/v1/error_log')) { world.errors.push(JSON.parse(opts.body)); return jsonResponse([{ id: 1 }]) }
    if (p.startsWith('/auth/v1/')) return jsonResponse({ user: { id: userId } })
    return jsonResponse([])
  }

  const res = { statusCode: 200, body: undefined }
  res.status = n => { res.statusCode = n; return res }
  res.send = b => { res.body = b; return res }
  res.json = b => { res.body = b; return res }
  const req = {
    method: 'POST',
    headers: { sign: signature },
    socket: {},
    on: (ev, cb) => { if (ev === 'data') cb(raw); if (ev === 'end') cb() },
  }
  await webhook(req, res)
  // Журналирование ошибок намеренно не дожидаются (ручка обязана ответить
  // Продамусу сразу), поэтому даём такт, прежде чем вернуть сеть на место.
  await new Promise(r => setTimeout(r, 60))
  globalThis.fetch = REAL_FETCH
  return res
}

console.log('\nprodamus: товар определяется ярлыком, подтверждённым суммой')

test('ярлык + совпавшая цена → этот товар', () => {
  assert.equal(resolveItem('challenge', 2990, 2990), 'challenge')
  assert.equal(resolveItem('premium', 9990), 'premium')
})

test('ярлык без совпадения по сумме не действует', () => {
  // Главное про безопасность правила: подменивший ярлык не получит ничего
  // дороже оплаченного.
  assert.equal(resolveItem('premium', 2990), 'profit')
  assert.equal(resolveItem('premium', 50), 'test50')
})

test('незнакомый и пустой ярлык → прежний разбор по сумме', () => {
  assert.equal(resolveItem('x', 2990), 'profit')
  assert.equal(resolveItem(null, 2990), 'profit')
  assert.equal(resolveItem('constructor', 2990), 'profit', 'ключ из прототипа не должен считаться товаром')
})

// ── ЦЕНА БИЛЕТА — ИЗ ПОТОКА ─────────────────────────────────────────────────
// Ровно то место, где служебный поток за 50 ₽ сталкивается с тарифом ТЕСТ 50 за
// те же 50 ₽. Разводит их ярлык, но только вместе с ценой ТОГО потока, куда
// человека зачисляют: зашитая цена билета обе стороны развести не может.
test('50 ₽ с ярлыком билета — билет, если столько стоит поток человека', () => {
  assert.equal(resolveItem('challenge', 50, 50), 'challenge')
})

test('50 ₽ без ярлыка — по-прежнему тариф ТЕСТ 50, поток тут ни при чём', () => {
  assert.equal(resolveItem(null, 50, 50), 'test50')
  assert.equal(resolveItem(null, 50, 2990), 'test50')
  assert.equal(resolveItem('x', 50, 50), 'test50')
})

test('ярлык билета на чужую сумму не даёт НИЧЕГО — ни билета, ни тарифа', () => {
  // Прежде «__challenge на чужую сумму» откатывался к разбору по сумме, и это
  // было безобидно ровно пока цена билета была одна на все потоки. Теперь цены
  // может не быть вовсе (потока нет), и старый откат означал бы, что билет за
  // 2990 без открытого потока молча становится ПРОФИТом.
  //
  // Подменившему ярлык это ущерба не даёт и дать не может: он получает НЕ
  // БОЛЬШЕ оплаченного, а меньше.
  assert.equal(resolveItem('challenge', 50, 2990), undefined, 'билет чужого потока не покупается за 50')
  assert.equal(resolveItem('challenge', 2990, 50), undefined)
  assert.equal(resolveItem('challenge', 2990, undefined), undefined, 'потока нет — цены нет — товара нет')
  assert.equal(resolveItem('challenge', 777, 2990), undefined)
})

console.log('\nprodamus: вебхук — билет челленджа не превращается в ПРОФИТ')

await testAsync('2990 с ярлыком __challenge → зачисление в поток, тариф НЕ начислен', async () => {
  const world = makeWorld()
  const res = await callWebhook(world, { sum: 2990, tag: 'challenge' })
  assert.equal(res.statusCode, 200)
  assert.equal(world.enrollCalls.length, 1, 'зачисление обязано произойти')
  assert.equal(world.entries.length, 1)
  assert.equal(world.entries[0].no, 1, 'первый участник получает номер 1')
  assert.equal(world.entries[0].name, 'Пётр Петров', 'имя снимается в момент покупки')
  assert.equal(world.enrollCalls[0].p_season_id, 1, 'зачисляем в открытый сезон')
  assert.equal(world.planWrites.length, 0, 'ПРОФИТ по билету начисляться не должен')
  assert.equal(world.paymentRows[0].plan, 'challenge', 'в журнале платёж числится билетом')
})

await testAsync('2990 без нашего ярлыка → по-прежнему ПРОФИТ', async () => {
  // Оплата по старой ссылке и вообще любой платёж мимо приложения обязаны
  // работать ровно как раньше — правило только добавляет выбор, ничего не
  // отнимая.
  for (const tag of [null, 'x', 'profit']) {
    const world = makeWorld()
    await callWebhook(world, { sum: 2990, tag })
    assert.equal(world.planWrites.length, 1, `ярлык ${JSON.stringify(tag)}: тариф обязан начислиться`)
    assert.equal(world.planWrites[0].plan, 'profit', `ярлык ${JSON.stringify(tag)}: это ПРОФИТ`)
    assert.equal(world.enrollCalls.length, 0, `ярлык ${JSON.stringify(tag)}: в поток никого не зачисляем`)
  }
})

await testAsync('ярлык __challenge на чужую сумму билета не даёт и тарифа тоже', async () => {
  const world = makeWorld()
  await callWebhook(world, { sum: 50, tag: 'challenge' })
  assert.equal(world.enrollCalls.length, 0, 'сумма не сошлась с ценой потока — зачисления нет')
  assert.equal(world.planWrites.length, 0, 'и тарифом платёж, назвавшийся билетом, не становится')
  assert.equal(world.errors.length > 0, true, 'про деньги, за которые ничего не выдано, обязаны узнать сразу')
})

console.log('\nprodamus: служебный поток за 50 ₽ и тариф ТЕСТ 50 за те же 50 ₽')

await testAsync('тренер: 50 ₽ с ярлыком → билет в служебный поток, тариф НЕ начислен', async () => {
  // Тот самый путь, ради которого служебный поток и заведён: владелец платит
  // живые 50 ₽ и обязан получить МЕСТО В ПОТОКЕ, а не сутки ПРОФИТа.
  const world = makeWorld({ seasons: [{ ...OPEN_SEASON }, { ...STAFF_SEASON }], profileRole: 'trainer' })
  const res = await callWebhook(world, { sum: 50, tag: 'challenge' })

  assert.equal(res.statusCode, 200)
  assert.equal(world.enrollCalls.length, 1, 'зачисление обязано произойти')
  assert.equal(world.enrollCalls[0].p_season_id, 2, 'и именно в служебный поток, а не в открытый')
  assert.equal(world.entries[0].no, 1, 'первый участник получает номер 1')
  assert.equal(world.planWrites.length, 0, 'ТЕСТ 50 по билету начисляться не должен')
  assert.equal(world.paymentRows[0].plan, 'challenge', 'в журнале платёж числится билетом')
  assert.equal(world.paymentRows[0].status, 'success')
})

await testAsync('тренер: 50 ₽ БЕЗ ярлыка → тариф ТЕСТ 50, в поток никого', async () => {
  // Обратная половина того же правила. Служебный тариф остаётся покупаемым: он
  // проверяет начисление, а билет — участие, и путать их нельзя ни в одну
  // сторону.
  const world = makeWorld({ seasons: [{ ...OPEN_SEASON }, { ...STAFF_SEASON }], profileRole: 'trainer' })
  await callWebhook(world, { sum: 50, tag: null })

  assert.equal(world.planWrites.length, 1, 'тариф обязан начислиться')
  assert.equal(world.planWrites[0].plan, 'test50')
  assert.equal(world.enrollCalls.length, 0, 'в поток по такому платежу никого')
  assert.equal(world.paymentRows[0].plan, 'test50')
})

await testAsync('обычный участник: служебный поток ему не выбирается вовсе', async () => {
  // Прямой запрос в обход экрана. Служебный поток лежит в базе и service_role
  // его видит — отсекает его РОЛЬ, а не то, что строка не приехала. 50 ₽ с
  // ярлыком билета для постороннего не сходятся с ценой ЕГО потока (2990),
  // поэтому места в потоке он не получает.
  const world = makeWorld({ seasons: [{ ...OPEN_SEASON }, { ...STAFF_SEASON }], profileRole: null })
  await callWebhook(world, { sum: 50, tag: 'challenge' })

  assert.equal(world.enrollCalls.length, 0, 'в служебный поток посторонний не попадает')
  assert.equal(world.planWrites.length, 0, 'и тариф по ярлыку билета не начисляется')
})

await testAsync('обычный участник: 2990 с ярлыком → билет в открытый поток', async () => {
  // Появление служебного потока не должно менять ничего для людей.
  const world = makeWorld({ seasons: [{ ...OPEN_SEASON }, { ...STAFF_SEASON }], profileRole: null })
  await callWebhook(world, { sum: 2990, tag: 'challenge' })

  assert.equal(world.enrollCalls.length, 1)
  assert.equal(world.enrollCalls[0].p_season_id, 1, 'открытый поток, а не служебный')
  assert.equal(world.planWrites.length, 0)
})

await testAsync('тренер без служебного потока платит как все — 2990 в открытый', async () => {
  const world = makeWorld({ profileRole: 'trainer' })
  await callWebhook(world, { sum: 2990, tag: 'challenge' })

  assert.equal(world.enrollCalls.length, 1)
  assert.equal(world.enrollCalls[0].p_season_id, 1)
})

await testAsync('повторное уведомление с тем же order_id не создаёт второй записи', async () => {
  const world = makeWorld()
  const first = await callWebhook(world, { sum: 2990, tag: 'challenge', orderId: '48999001' })
  const again = await callWebhook(world, { sum: 2990, tag: 'challenge', orderId: '48999001' })
  assert.equal(first.statusCode, 200)
  assert.equal(again.statusCode, 200, 'на повтор отвечаем 200, иначе Продамус зациклит ретраи')
  assert.equal(world.entries.length, 1, 'участник по-прежнему один')
  assert.equal(world.enrollCalls.length, 1, 'до зачисления повтор даже не доходит — его ловит журнал платежей')
  assert.equal(world.paymentRows.length, 1, 'и вторая строка в журнале не появляется')
})

await testAsync('второй платёж того же человека новым номером не награждается', async () => {
  // Защита второго рубежа: журнал платежей повтор пропустил (номер платежа
  // другой), но challenge_enroll идемпотентна и по человеку.
  const world = makeWorld()
  await callWebhook(world, { sum: 2990, tag: 'challenge', orderId: '48999002' })
  await callWebhook(world, { sum: 2990, tag: 'challenge', orderId: '48999003' })
  assert.equal(world.enrollCalls.length, 2, 'оба платежа дошли до зачисления')
  assert.equal(world.entries.length, 1, 'а участник остался один')
})

await testAsync('билет без открытого сезона: платёж записан, тревога поднята', async () => {
  const world = makeWorld({ seasons: [] })
  const res = await callWebhook(world, { sum: 2990, tag: 'challenge' })
  assert.equal(res.statusCode, 200, 'Продамусу отвечаем 200 — деньги уже взяты')
  assert.equal(world.enrollCalls.length, 0)
  assert.equal(world.planWrites.length, 0, 'и уж точно не начисляем тариф')
  assert.equal(world.paymentRows[0].status, 'no_open_season', 'платёж виден в журнале')
  assert.equal(world.paymentRows[0].plan, 'challenge')
  assert.equal(world.errors.length > 0, true, 'про деньги, которые некуда зачислить, обязаны узнать сразу')
})

console.log(`\n${failed ? '✗' : '✓'} prodamus: ${passed} прошло, ${failed} упало\n`)
process.exit(failed ? 1 : 0)
