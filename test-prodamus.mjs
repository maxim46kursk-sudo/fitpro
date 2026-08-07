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

console.log(`\n${failed ? '✗' : '✓'} prodamus: ${passed} прошло, ${failed} упало\n`)
process.exit(failed ? 1 : 0)
