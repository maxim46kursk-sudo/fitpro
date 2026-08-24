// Выход наружу — api/_egress.js.
//
// Что здесь защищается. С нашего сервера api.telegram.org и api.anthropic.com
// недостижимы, и вызовы к ним идут через мост. Помощник решает это ОДИН раз за
// все семь точек вызова, и у него ровно два способа сломаться — оба тихие:
//
//   1) НЕ ПЕРЕПИСАТЬ, когда мост настроен. Тогда на своём сервере молча
//      отвалятся ИИ-ассистент, вход через Telegram, напоминания, тревоги и
//      выгрузка данных — ровно то, ради чего мост и заводился.
//   2) ПЕРЕПИСАТЬ, когда моста нет. Это страшнее: на Vercel переменных нет, и
//      боевое приложение обязано вести себя байт в байт как раньше. Лишний
//      заголовок или подменённый адрес там означают поломку БОЯ во время
//      переезда — то есть худшее, что может случиться с этой затеей.
//
// Поэтому проверяется симметрично: с окружением и без него.

import { strict as assert } from 'node:assert'

const ЧИСТО = { EGRESS_URL: undefined, EGRESS_KEY: undefined }
const МОСТ = { EGRESS_URL: 'https://fitpro-egress.example.workers.dev', EGRESS_KEY: 'test-relay-key' }

function окружение(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const { egressUrl, egressHeaders, egressFetch, RELAY_HEADER } = await import('./api/_egress.js')

let passed = 0, failed = 0
const beda = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; beda.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

console.log('\nВыход наружу (api/_egress.js)\n')

// ── БЕЗ МОСТА: ничего не меняется ───────────────────────────────────────────
console.log(' без EGRESS_URL/EGRESS_KEY — поведение Vercel')

await test('адрес Telegram остаётся прежним', () => {
  окружение(ЧИСТО)
  const адрес = 'https://api.telegram.org/bot123:ABC/sendMessage'
  assert.equal(egressUrl(адрес), адрес)
})

await test('адрес Anthropic остаётся прежним', () => {
  окружение(ЧИСТО)
  const адрес = 'https://api.anthropic.com/v1/messages'
  assert.equal(egressUrl(адрес), адрес)
})

await test('заголовки возвращаются ТЕМ ЖЕ объектом, без единой добавки', () => {
  окружение(ЧИСТО)
  const было = { 'Content-Type': 'application/json', 'x-api-key': 'k' }
  const стало = egressHeaders(было)
  assert.equal(стало, было, 'на Vercel заголовки не должны даже копироваться')
  assert.deepEqual(Object.keys(стало), ['Content-Type', 'x-api-key'])
})

await test('egressFetch зовёт fetch по исходному адресу и с исходными опциями', async () => {
  окружение(ЧИСТО)
  const звонки = []
  const настоящий = globalThis.fetch
  globalThis.fetch = (u, o) => { звонки.push({ u, o }); return Promise.resolve({ ok: true }) }
  try {
    const опции = { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{}' }
    await egressFetch('https://api.anthropic.com/v1/messages', опции)
    assert.equal(звонки[0].u, 'https://api.anthropic.com/v1/messages')
    assert.equal(звонки[0].o, опции, 'опции должны уйти тем же объектом')
    assert.equal(звонки[0].o.headers[RELAY_HEADER], undefined, 'ключа моста на Vercel быть не должно')
  } finally { globalThis.fetch = настоящий }
})

// ── С МОСТОМ: адреса переписаны, ключ добавлен ──────────────────────────────
console.log('\n с EGRESS_URL/EGRESS_KEY — поведение своего сервера')

await test('Telegram уходит на /tg/, хвост пути сохраняется целиком', () => {
  окружение(МОСТ)
  assert.equal(
    egressUrl('https://api.telegram.org/bot123:ABC/sendMessage'),
    'https://fitpro-egress.example.workers.dev/tg/bot123:ABC/sendMessage',
  )
})

await test('Anthropic уходит на /ai/', () => {
  окружение(МОСТ)
  assert.equal(
    egressUrl('https://api.anthropic.com/v1/messages'),
    'https://fitpro-egress.example.workers.dev/ai/v1/messages',
  )
})

await test('к заголовкам добавляется ключ моста, остальные на месте', () => {
  окружение(МОСТ)
  const стало = egressHeaders({ 'Content-Type': 'application/json' })
  assert.equal(стало[RELAY_HEADER], 'test-relay-key')
  assert.equal(стало['Content-Type'], 'application/json')
})

await test('egressFetch переписывает адрес и подставляет ключ', async () => {
  окружение(МОСТ)
  const звонки = []
  const настоящий = globalThis.fetch
  globalThis.fetch = (u, o) => { звонки.push({ u, o }); return Promise.resolve({ ok: true }) }
  try {
    await egressFetch('https://api.telegram.org/bot9:X/sendDocument', { method: 'POST', body: 'form' })
    assert.equal(звонки[0].u, 'https://fitpro-egress.example.workers.dev/tg/bot9:X/sendDocument')
    assert.equal(звонки[0].o.headers[RELAY_HEADER], 'test-relay-key')
    assert.equal(звонки[0].o.body, 'form', 'тело трогать нельзя — им едет multipart выгрузки')
    assert.equal(звонки[0].o.method, 'POST')
  } finally { globalThis.fetch = настоящий }
})

await test('чужой хост не переписывается и ключ ему не показывается', async () => {
  окружение(МОСТ)
  const звонки = []
  const настоящий = globalThis.fetch
  globalThis.fetch = (u, o) => { звонки.push({ u, o }); return Promise.resolve({ ok: true }) }
  try {
    await egressFetch('https://api.github.com/meta', { headers: {} })
    assert.equal(звонки[0].u, 'https://api.github.com/meta')
    assert.equal(звонки[0].o.headers[RELAY_HEADER], undefined,
      'ключ моста не должен уезжать никому, кроме самого моста')
  } finally { globalThis.fetch = настоящий }
})

await test('половина настройки — то же, что её отсутствие', () => {
  окружение({ EGRESS_URL: МОСТ.EGRESS_URL, EGRESS_KEY: undefined })
  const адрес = 'https://api.telegram.org/bot1:2/getMe'
  assert.equal(egressUrl(адрес), адрес, 'адрес без ключа дал бы молчаливый 404 от моста')
  окружение({ EGRESS_URL: undefined, EGRESS_KEY: МОСТ.EGRESS_KEY })
  assert.equal(egressUrl(адрес), адрес)
})

await test('лишний слэш в конце EGRESS_URL не даёт двойного слэша', () => {
  окружение({ ...МОСТ, EGRESS_URL: МОСТ.EGRESS_URL + '/' })
  assert.equal(
    egressUrl('https://api.telegram.org/bot1:2/getMe'),
    'https://fitpro-egress.example.workers.dev/tg/bot1:2/getMe',
  )
})

окружение(ЧИСТО)

console.log(`\n${passed} прошло, ${failed} упало`)
if (failed) {
  for (const [name, e] of beda) console.log(`\n— ${name}\n${e.stack}`)
  process.exit(1)
}
