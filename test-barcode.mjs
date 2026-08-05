// test-barcode.mjs — тесты сканера штрих-кода для дневника питания.
//
// ГДЕ ЖИВЁТ КОД: не в своей функции, а веткой внутри api/set-exercise.js —
// GET ?action=barcode&code=XXXX. Причина в лимите 12 serverless-функций на
// Vercel Hobby, подробности в шапке того файла. Поэтому тесты дёргают общий
// handler и заодно следят, что тренерские сценарии того же файла (POST без
// action=barcode) от соседства не пострадали.
//
// Что проверяем и чем:
//  1. ЮНИТ — чистые функции, без сети: разбор ответа Open Food Facts
//     (api/set-exercise.js, normalizeOffProduct/isValidBarcode) и арифметика
//     порции (src/nutrition.js). Импортируются РЕАЛЬНЫЕ функции, ничего не
//     переписывается на месте.
//  2. ИНТЕГРАЦИЯ — сам handler целиком, с подменённым globalThis.fetch.
//     Подмена — единственный способ детерминированно пройти ветки «источник
//     лёг», «таймаут» и «попадание в кэш»; сетевого доступа тесты при этом не
//     требуют. Сюда же входит регрессия тренерских веток set-exercise.
//  3. E2E — только по флагу `--e2e`: те же запросы к ЖИВОМУ Open Food Facts
//     через настоящий handler. Нужны сеть и доступ к world.openfoodfacts.org.
//
// Запуск:
//   node test-barcode.mjs          — юнит + интеграция (офлайн, детерминировано)
//   node test-barcode.mjs --e2e    — плюс живые запросы в OFF
//
// В сборку не входит.

// Ключ должен быть выставлен ДО импорта handler'а: без него handler намеренно
// работает без кэша, и ветку кэша было бы не проверить. Значение фиктивное —
// в интеграционных тестах наружу всё равно никто не ходит, PostgREST отвечает
// подменённым fetch.
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

const { default: handler, normalizeOffProduct, isValidBarcode } = await import('./api/set-exercise.js')
const {
  scalePer100, scaleProduct, clampGrams, parseGrams, buildEntryName, buildFoodEntry, round1,
} = await import('./src/nutrition.js')

const E2E = process.argv.includes('--e2e')
const REAL_FETCH = globalThis.fetch

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

// ══════════════════════════════════════════════════════════════════════════
// 1. ЮНИТ: валидация штрих-кода
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Валидация штрих-кода ───────────────────────────────────────────')
assertEqual('EAN-8 (8 цифр) валиден', isValidBarcode('40054009'), true)
assertEqual('UPC-A (12 цифр) валиден', isValidBarcode('012345678905'), true)
assertEqual('EAN-13 (13 цифр) валиден', isValidBarcode('4600682000129'), true)
assertEqual('ITF-14 (14 цифр) валиден', isValidBarcode('14600682000126'), true)
assertEqual('7 цифр — коротко', isValidBarcode('1234567'), false)
assertEqual('15 цифр — длинно', isValidBarcode('123456789012345'), false)
assertEqual('буквы не проходят', isValidBarcode('46006820001AB'), false)
assertEqual('пробелы не проходят', isValidBarcode('4600 68200012'), false)
assertEqual('дефисы не проходят', isValidBarcode('4600-682-00012'), false)
assertEqual('пустая строка', isValidBarcode(''), false)
assertEqual('не строка (число)', isValidBarcode(4600682000129), false)
assertEqual('null', isValidBarcode(null), false)
// Ведущий ноль обязан выживать — 0460068200012 и 460068200012 разные товары,
// поэтому код везде строка, а не число.
assertEqual('ведущий ноль сохраняется', isValidBarcode('0460068200012'), true)

// ══════════════════════════════════════════════════════════════════════════
// 2. ЮНИТ: нормализация ответа Open Food Facts
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Нормализация ответа OFF ────────────────────────────────────────')

assertEqual('полная карточка разбирается целиком',
  normalizeOffProduct('5449000000996', {
    product_name: 'Coca-Cola',
    brands: 'Coca-Cola',
    nutriments: { 'energy-kcal_100g': 42, proteins_100g: 0, carbohydrates_100g: 10.6, fat_100g: 0 },
  }),
  { barcode: '5449000000996', name: 'Coca-Cola', brand: 'Coca-Cola', kcal100: 42, p100: 0, c100: 10.6, f100: 0 })

// Русское название приоритетнее — в дневнике оно и должно оказаться.
assertEqual('product_name_ru важнее product_name',
  normalizeOffProduct('4600000000001', {
    product_name: 'Milk 3.2%', product_name_ru: 'Молоко 3.2%',
    brands: 'Простоквашино', nutriments: { 'energy-kcal_100g': 60 },
  }).name, 'Молоко 3.2%')
assertEqual('без product_name_ru берём product_name',
  normalizeOffProduct('4600000000001', {
    product_name: 'Milk 3.2%', nutriments: { 'energy-kcal_100g': 60 },
  }).name, 'Milk 3.2%')
assertEqual('пустой product_name_ru не перебивает product_name',
  normalizeOffProduct('4600000000001', {
    product_name: 'Milk', product_name_ru: '   ', nutriments: {},
  }).name, 'Milk')

// Килоджоули. 1000 кДж / 4.184 = 239.005… → 239
assertEqual('kcal из кДж, когда ккал не заполнены',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { energy_100g: 1000 } }).kcal100, 239)
assertEqual('готовое поле ккал важнее кДж (не пересчитываем поверх)',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { 'energy-kcal_100g': 239, energy_100g: 1000 } }).kcal100, 239)
assertEqual('нет ни ккал, ни кДж → null',
  normalizeOffProduct('1', { product_name: 'X', nutriments: {} }).kcal100, null)

// Отсутствующие поля — именно null, а не 0: «неизвестно» и «нуль грамм» это
// разные утверждения, и нуль в дневнике сложился бы с остальным как факт.
assertEqual('незаполненные макросы → null, а не 0',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5 } }),
  { barcode: '1', name: 'X', brand: null, kcal100: 100, p100: 5, c100: null, f100: null })
assertEqual('нутриентов нет вовсе — карточка всё равно разбирается',
  normalizeOffProduct('1', { product_name: 'X' }),
  { barcode: '1', name: 'X', brand: null, kcal100: null, p100: null, c100: null, f100: null })

// Абсурд из открытой базы.
assertEqual('ккал > 1000 на 100 г отбрасываются',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { 'energy-kcal_100g': 5400 } }).kcal100, null)
assertEqual('ровно 1000 ккал ещё проходят',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { 'energy-kcal_100g': 1000 } }).kcal100, 1000)
assertEqual('макрос > 100 г в 100 г отбрасывается',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { proteins_100g: 250 } }).p100, null)
assertEqual('ровно 100 г макроса проходит',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { fat_100g: 100 } }).f100, 100)
assertEqual('отрицательные отбрасываются, а не поджимаются к нулю',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { 'energy-kcal_100g': -50, proteins_100g: -1 } }),
  { barcode: '1', name: 'X', brand: null, kcal100: null, p100: null, c100: null, f100: null })
assertEqual('нечисловой мусор в поле → null',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { 'energy-kcal_100g': 'нет данных' } }).kcal100, null)
assertEqual('число строкой разбирается',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { proteins_100g: '3.2' } }).p100, 3.2)
assertEqual('число строкой с запятой разбирается',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { proteins_100g: '3,2' } }).p100, 3.2)
assertEqual('округление до одного знака',
  normalizeOffProduct('1', { product_name: 'X', nutriments: { proteins_100g: 3.26789 } }).p100, 3.3)

// Бренд.
assertEqual('бренд — первый до запятой',
  normalizeOffProduct('1', { product_name: 'X', brands: 'Nutella, Ferrero, Yum yum', nutriments: {} }).brand, 'Nutella')
assertEqual('пустой brands → null',
  normalizeOffProduct('1', { product_name: 'X', brands: '', nutriments: {} }).brand, null)
assertEqual('brands из пробелов → null',
  normalizeOffProduct('1', { product_name: 'X', brands: '   ,  ', nutriments: {} }).brand, null)
report('длинный brands обрезается до 100 символов',
  normalizeOffProduct('1', { product_name: 'X', brands: 'Б'.repeat(300), nutriments: {} }).brand.length === 100)
report('длинное название обрезается до 200 символов',
  normalizeOffProduct('1', { product_name: 'Н'.repeat(500), nutriments: {} }).name.length === 200)

// Пустышки.
assertEqual('карточка без названия → null (для нас это «не найден»)',
  normalizeOffProduct('1', { brands: 'Ferrero', nutriments: { 'energy-kcal_100g': 500 } }), null)
assertEqual('product отсутствует → null', normalizeOffProduct('1', undefined), null)
assertEqual('product не объект → null', normalizeOffProduct('1', 'мусор'), null)

// ══════════════════════════════════════════════════════════════════════════
// 3. ЮНИТ: пересчёт порции (src/nutrition.js)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Пересчёт порции ────────────────────────────────────────────────')

assertEqual('round1 округляет до одного знака', round1(3.26789), 3.3)
assertEqual('100 г — значение «на 100 г» не меняется', scalePer100(42, 100), 42)
assertEqual('250 г от 42 ккал/100 г = 105', scalePer100(42, 250), 105)
assertEqual('30 г от 539 ккал/100 г = 161.7', scalePer100(539, 30), 161.7)
assertEqual('1 г от 539 = 5.4 (округление до 0.1)', scalePer100(539, 1), 5.4)
assertEqual('null на входе остаётся null (неизвестно ≠ нуль)', scalePer100(null, 250), null)
assertEqual('undefined → null', scalePer100(undefined, 250), null)
assertEqual('вес не разобран → null', scalePer100(42, 'abc'), null)

assertEqual('parseGrams: запятая как разделитель', parseGrams('12,5'), 12.5)
assertEqual('parseGrams: пустая строка → null', parseGrams(''), null)
assertEqual('parseGrams: мусор → null', parseGrams('сто'), null)
assertEqual('clampGrams: ниже минимума поджимается к 1', clampGrams('0'), 1)
assertEqual('clampGrams: отрицательный поджимается к 1', clampGrams('-500'), 1)
assertEqual('clampGrams: выше максимума поджимается к 3000', clampGrams('99999'), 3000)
assertEqual('clampGrams: в пределах — как есть', clampGrams('250'), 250)
assertEqual('clampGrams: не разобрать → null (кнопка «Добавить» гаснет)', clampGrams(''), null)

const nutella = { name: 'Nutella', brand: 'Ferrero', kcal100: 539, p100: 6.3, c100: 57.5, f100: 30.9 }
assertEqual('порция 30 г: все четыре числа', scaleProduct(nutella, 30),
  { kcal: 161.7, p: 1.9, c: 17.3, f: 9.3 })
assertEqual('порция 100 г равна карточке', scaleProduct(nutella, 100),
  { kcal: 539, p: 6.3, c: 57.5, f: 30.9 })

const halfKnown = { name: 'X', brand: null, kcal100: 100, p100: null, c100: null, f100: null }
assertEqual('неизвестные макросы остаются null и после пересчёта', scaleProduct(halfKnown, 250),
  { kcal: 250, p: null, c: null, f: null })

assertEqual('название записи: бренд + название + граммы',
  buildEntryName(nutella, 30), 'Ferrero Nutella (30 г)')
assertEqual('без бренда — только название',
  buildEntryName({ name: 'Молоко 3.2%' }, 250), 'Молоко 3.2% (250 г)')
assertEqual('дробные граммы в названии с одним знаком',
  buildEntryName(nutella, 12.55), 'Ferrero Nutella (12.6 г)')
assertEqual('граммы в названии — уже поджатые',
  buildEntryName(nutella, 99999), 'Ferrero Nutella (3000 г)')

assertEqual('готовая запись дневника', buildFoodEntry(nutella, 30),
  { name: 'Ferrero Nutella (30 г)', kcal: 161.7, p: 1.9, c: 17.3, f: 9.3 })
// В дневнике хранятся числа, поэтому здесь «неизвестно» наконец становится 0.
assertEqual('неизвестные макросы уходят в дневник нулями', buildFoodEntry(halfKnown, 250),
  { name: 'X (250 г)', kcal: 250, p: 0, c: 0, f: 0 })
// Верхняя граница веса (3000 г) не даёт превысить CAL_MAX даже на самом
// калорийном продукте: 900 × 3000 / 100 = 27000 → клампится к 20000.
assertEqual('калории записи не превышают CAL_MAX',
  buildFoodEntry({ name: 'Масло', kcal100: 900, p100: 100, c100: 100, f100: 100 }, 3000),
  { name: 'Масло (3000 г)', kcal: 20000, p: 2000, c: 2000, f: 2000 })

// ══════════════════════════════════════════════════════════════════════════
// 4. ИНТЕГРАЦИЯ: сам handler с подменённым fetch
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Handler /api/set-exercise?action=barcode (fetch подменён) ──────')

const SUPA_HOST = new URL(process.env.VITE_SUPABASE_URL).host

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, ended: false }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.status = n => { r.statusCode = n; return r }
  r.json = o => { r.body = o; r.ended = true; return r }
  r.end = () => { r.ended = true; return r }
  return r
}
// Каждому тесту свой IP: rateLimit держит счётчики в памяти модуля и один на
// всех сорвал бы поздние тесты 429-м.
let ipSeq = 0
const ip = () => `10.0.0.${++ipSeq}`
// Запрос в ветку штрих-кода: action ТОЛЬКО в query, тела нет.
const mockReq = (code, method = 'GET') => ({
  method, query: { action: 'barcode', code }, headers: { 'x-real-ip': ip() }, socket: {},
})
// Запрос мимо ветки штрих-кода — для регрессии тренерской части файла.
const mockReqRaw = ({ method = 'POST', query = {}, headers = {}, body } = {}) => ({
  method, query, body, headers: { 'x-real-ip': ip(), ...headers }, socket: {},
})

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })

// Подмена сети. cache — что «лежит в базе» (barcode → строка), off — что
// отвечает Open Food Facts. writes копит upsert'ы, чтобы проверить, что в кэш
// уходит именно то и только то, что должно.
function stubFetch({ cache = {}, off = null, offFail = null }) {
  const writes = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    if (u.host === SUPA_HOST) {
      if ((opts.method || 'GET') === 'GET') {
        const eq = u.searchParams.get('barcode') || ''
        const code = eq.replace(/^eq\./, '')
        const row = cache[code]
        return json(row ? [row] : [])
      }
      writes.push(JSON.parse(opts.body))
      return new Response('', { status: 201 })
    }
    if (u.host === 'world.openfoodfacts.org') {
      if (offFail === 'network') throw new Error('getaddrinfo ENOTFOUND')
      if (offFail === 'timeout') {
        return new Promise((_, reject) => {
          opts.signal?.addEventListener('abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      }
      if (offFail === 'http500') return new Response('boom', { status: 500 })
      if (offFail === 'html') return new Response('<html>заглушка провайдера</html>', { status: 200 })
      if (off?.__status404) return new Response('', { status: 404 })
      return json(off)
    }
    throw new Error(`неожиданный запрос в тесте: ${url}`)
  }
  return writes
}
const restoreFetch = () => { globalThis.fetch = REAL_FETCH }

async function call(code, opts = {}, method = 'GET') {
  const writes = stubFetch(opts)
  const res = mockRes()
  await handler(mockReq(code, method), res)
  restoreFetch()
  return { res, writes }
}

const OFF_NUTELLA = {
  status: 1,
  product: {
    product_name: 'Nutella', brands: 'Ferrero, Yum yum',
    nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9 },
  },
}

// ── Валидация кода
{
  const { res } = await call('12345')
  assertEqual('короткий код → 400', res.statusCode, 400)
}
{
  const { res } = await call('46006820001AB')
  assertEqual('код с буквами → 400', res.statusCode, 400)
}
{
  const { res } = await call(undefined)
  assertEqual('код не передан → 400', res.statusCode, 400)
}
{
  // ?code=1&code=2 приезжает массивом — подбор формата, а не опечатка.
  const writes = stubFetch({})
  const res = mockRes()
  await handler({ method: 'GET', query: { action: 'barcode', code: ['4600682000129', '5449000000996'] }, headers: { 'x-real-ip': '10.9.9.9' }, socket: {} }, res)
  restoreFetch()
  assertEqual('code массивом → 400', res.statusCode, 400)
  assertEqual('в OFF при этом не ходили', writes.length, 0)
}
{
  const { res } = await call('4600682000129', {}, 'POST')
  assertEqual('POST в ветку barcode → 405', res.statusCode, 405)
}
{
  const { res } = await call('4600682000129', {}, 'OPTIONS')
  assertEqual('OPTIONS в ветку barcode → 200', res.statusCode, 200)
  assertEqual('OPTIONS: ветка объявляет GET, а не POST',
    res.headers['Access-Control-Allow-Methods'], 'GET, OPTIONS')
}

// ── Попадание в кэш
{
  const { res, writes } = await call('3017620422003', {
    cache: { '3017620422003': { barcode: '3017620422003', name: 'Nutella', brand: 'Ferrero', kcal100: 539, p100: 6.3, c100: 57.5, f100: 30.9 } },
  })
  assertEqual('кэш: статус 200', res.statusCode, 200)
  assertEqual('кэш: cached=true', res.body?.cached, true)
  assertEqual('кэш: продукт отдан целиком', res.body?.product,
    { barcode: '3017620422003', name: 'Nutella', brand: 'Ferrero', kcal100: 539, p100: 6.3, c100: 57.5, f100: 30.9 })
  assertEqual('кэш: повторной записи в базу не было', writes.length, 0)
}
{
  // numeric из PostgREST может приехать строкой — клиент не должен получить
  // "3.2" вместо 3.2, иначе пересчёт порции склеит строки.
  const { res } = await call('3017620422003', {
    cache: { '3017620422003': { barcode: '3017620422003', name: 'X', brand: null, kcal100: '539', p100: '6.3', c100: null, f100: null } },
  })
  assertEqual('кэш: numeric строкой приводится к числу',
    res.body?.product, { barcode: '3017620422003', name: 'X', brand: null, kcal100: 539, p100: 6.3, c100: null, f100: null })
}

// ── Промах кэша → OFF → запись в кэш
{
  const { res, writes } = await call('3017620422003', { off: OFF_NUTELLA })
  assertEqual('промах: статус 200', res.statusCode, 200)
  assertEqual('промах: found=true', res.body?.found, true)
  assertEqual('промах: cached=false', res.body?.cached, false)
  assertEqual('промах: продукт нормализован', res.body?.product,
    { barcode: '3017620422003', name: 'Nutella', brand: 'Ferrero', kcal100: 539, p100: 6.3, c100: 57.5, f100: 30.9 })
  assertEqual('промах: одна запись в кэш', writes.length, 1)
  assertEqual('промах: в кэш ушла та же карточка с source=off', writes[0],
    { barcode: '3017620422003', name: 'Nutella', brand: 'Ferrero', kcal100: 539, p100: 6.3, c100: 57.5, f100: 30.9, source: 'off' })
}
{
  // Карточка без ккал бесполезна для дневника, но кэшировать её нельзя:
  // это навсегда закрыло бы повторный поход в OFF за дозаполненными данными.
  const { res, writes } = await call('3017620422003', {
    off: { status: 1, product: { product_name: 'Пустая карточка', nutriments: {} } },
  })
  assertEqual('без ккал: продукт всё равно отдан', res.body?.found, true)
  assertEqual('без ккал: kcal100 = null', res.body?.product?.kcal100, null)
  assertEqual('без ккал: в кэш НЕ пишем', writes.length, 0)
}

// ── Не найден
{
  const { res, writes } = await call('4600682000129', { off: { status: 0, code: '4600682000129' } })
  assertEqual('status:0 → статус 200', res.statusCode, 200)
  assertEqual('status:0 → found=false', res.body, { found: false })
  assertEqual('status:0 → в кэш ничего не пишем', writes.length, 0)
}
{
  const { res } = await call('4600682000129', { off: { __status404: true } })
  assertEqual('HTTP 404 от OFF → found=false', res.body, { found: false })
}
{
  const { res } = await call('4600682000129', { off: { status: 1, product: { nutriments: { 'energy-kcal_100g': 100 } } } })
  assertEqual('карточка без названия → found=false', res.body, { found: false })
}

// ── Источник недоступен: 502, и это НЕ то же самое, что «не найден»
{
  const { res } = await call('3017620422003', { offFail: 'network' })
  assertEqual('сеть до OFF не поднялась → 502', res.statusCode, 502)
  assertEqual('сеть до OFF не поднялась → source_unavailable', res.body, { error: 'source_unavailable' })
}
{
  const { res } = await call('3017620422003', { offFail: 'http500' })
  assertEqual('OFF ответил 500 → 502 source_unavailable', res.body, { error: 'source_unavailable' })
  assertEqual('OFF ответил 500 → статус 502', res.statusCode, 502)
}
{
  const { res } = await call('3017620422003', { offFail: 'html' })
  assertEqual('вместо JSON пришёл HTML → 502 source_unavailable', res.body, { error: 'source_unavailable' })
}
{
  console.log('  (следующий тест ждёт срабатывания таймаута — 6 секунд)')
  const t0 = Date.now()
  const { res } = await call('3017620422003', { offFail: 'timeout' })
  const elapsed = Date.now() - t0
  assertEqual('таймаут OFF → 502 source_unavailable', res.body, { error: 'source_unavailable' })
  report(`таймаут сработал за ~6 с (факт ${(elapsed / 1000).toFixed(1)} с)`, elapsed >= 5500 && elapsed < 9000,
    `прошло ${elapsed} мс`)
}

// ── Кэш отвалился — не повод отказывать пользователю
{
  const writes = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    if (u.host === SUPA_HOST) {
      if ((opts.method || 'GET') === 'GET') return new Response('{"message":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } })
      writes.push(JSON.parse(opts.body))
      return new Response('', { status: 201 })
    }
    return json(OFF_NUTELLA)
  }
  const res = mockRes()
  await handler(mockReq('3017620422003'), res)
  restoreFetch()
  assertEqual('база не отвечает на чтение → идём в OFF и отдаём продукт', res.body?.found, true)
  assertEqual('база не отвечает на чтение → cached=false', res.body?.cached, false)
}

// ── Rate limit
{
  const writes = stubFetch({ off: OFF_NUTELLA })
  let last = null
  // 61-й запрос с одного IP в минуту должен упереться в лимит.
  for (let i = 0; i < 61; i++) {
    const res = mockRes()
    await handler({ method: 'GET', query: { action: 'barcode', code: '3017620422003' }, headers: { 'x-real-ip': '10.55.55.55' }, socket: {} }, res)
    last = res
  }
  restoreFetch()
  assertEqual('61-й запрос с одного IP → 429', last.statusCode, 429)
  report('в ответе 429 есть Retry-After', Boolean(last.headers['Retry-After']),
    `заголовки: ${JSON.stringify(last.headers)}`)
  void writes
}

// ══════════════════════════════════════════════════════════════════════════
// 5. РЕГРЕССИЯ: тренерские ветки того же файла не сломались
//
// Ветка штрих-кода въехала в api/set-exercise.js и отвечает ПЕРВОЙ. Здесь
// проверяем, что запросы БЕЗ ?action=barcode идут прежним путём: тот же
// метод, те же CORS-заголовки, та же ранняя проверка авторизации. Ветки, где
// нужен живой Supabase (сохранение упражнений и шаблонов), сюда не лезут —
// до них выполнение не доходит, и это ровно то, что нужно проверить.
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Регрессия: set-exercise без action=barcode ─────────────────────')

// В сеть тут не должны ходить вообще: все проверки ниже отрабатывают до
// первого обращения к Supabase. Ловим это подменой fetch, которая падает.
{
  let touchedNetwork = false
  globalThis.fetch = async () => { touchedNetwork = true; throw new Error('сети быть не должно') }

  {
    // Старое поведение: эндпоинт принимает только POST.
    const res = mockRes()
    await handler(mockReqRaw({ method: 'GET' }), res)
    assertEqual('GET без action → 405, как раньше', res.statusCode, 405)
    assertEqual('GET без action → прежнее тело ошибки', res.body, { error: 'Method not allowed' })
    assertEqual('GET без action → прежний CORS «POST, OPTIONS»',
      res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS')
  }
  {
    const res = mockRes()
    await handler(mockReqRaw({ method: 'OPTIONS' }), res)
    assertEqual('OPTIONS без action → 200, как раньше', res.statusCode, 200)
    assertEqual('OPTIONS без action → прежний CORS «POST, OPTIONS»',
      res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS')
  }
  {
    // Главная гарантия: тренерская часть по-прежнему закрыта авторизацией и
    // ветка штрих-кода (у которой авторизации нет) её не открыла.
    const res = mockRes()
    await handler(mockReqRaw({ method: 'POST', body: { action: 'save', name: 'Жим лёжа' } }), res)
    assertEqual('POST без токена → 401, как раньше', res.statusCode, 401)
    assertEqual('POST без токена → прежнее тело ошибки', res.body, { error: 'Требуется авторизация' })
  }
  {
    // action=barcode в ТЕЛЕ ничего не открывает: ветка смотрит только в query.
    const res = mockRes()
    await handler(mockReqRaw({ method: 'POST', body: { action: 'barcode', code: '3017620422003' } }), res)
    assertEqual('action=barcode в теле не подменяет ветку → 401', res.statusCode, 401)
  }
  {
    // Чужой action в query веткой штрих-кода не перехватывается.
    const res = mockRes()
    await handler(mockReqRaw({ method: 'GET', query: { action: 'save' } }), res)
    assertEqual('GET ?action=save → 405 старым путём', res.statusCode, 405)
    assertEqual('GET ?action=save → прежний CORS «POST, OPTIONS»',
      res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS')
  }

  restoreFetch()
  report('ни один из этих запросов не ходил в сеть', touchedNetwork === false)
}

// ══════════════════════════════════════════════════════════════════════════
// 6. E2E: живой Open Food Facts (только с --e2e)
// ══════════════════════════════════════════════════════════════════════════
if (!E2E) {
  console.log('\n── E2E пропущен. Живые запросы в OFF: node test-barcode.mjs --e2e ──')
} else {
  console.log('\n── E2E: живой Open Food Facts ─────────────────────────────────────')
  // Кэш в e2e отключаем намеренно: живой базы под рукой нет, а фиктивный
  // service-role-ключ отправил бы handler стучаться в настоящий PostgREST.
  // Ветка кэша полностью закрыта интеграционными тестами выше.
  // Повторный импорт не нужен: ключ читается внутри handler'а на каждом
  // запросе, а не запоминается при загрузке модуля.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY

  // Тот же путь, что у клиента: GET /api/set-exercise?action=barcode&code=…
  //
  // Эти тесты ходят в чужой живой сервис и потому НЕ детерминированы: OFF
  // иногда отвечает дольше боевого таймаута в 6 секунд, и тогда handler
  // честно отдаёт 502 source_unavailable — это его правильная работа, а не
  // поломка. Ловим такой случай отдельно и говорим прямо, чтобы сетевую
  // икоту не приняли за дефект кода.
  const liveCall = async (code) => {
    const res = mockRes()
    await handler(mockReq(code), res)
    if (res.body?.error === 'source_unavailable') {
      console.log(`    ⚠ OFF не ответил за ${6} с (код ${code}). Это сеть, а не код — повтори запуск.`)
    }
    return res
  }

  {
    // Nutella — карточка, которая в OFF заполнена целиком много лет.
    const res = await liveCall('3017620422003')
    assertEqual('живой OFF: 3017620422003 статус 200', res.statusCode, 200)
    assertEqual('живой OFF: found=true', res.body?.found, true)
    assertEqual('живой OFF: cached=false (кэш отключён)', res.body?.cached, false)
    report('живой OFF: название непустое', Boolean(res.body?.product?.name), JSON.stringify(res.body))
    report('живой OFF: ккал в разумных пределах',
      res.body?.product?.kcal100 > 400 && res.body?.product?.kcal100 < 700,
      `получено ${res.body?.product?.kcal100}`)
    console.log(`    → ${JSON.stringify(res.body?.product)}`)
  }
  {
    const res = await liveCall('5449000000996')
    report('живой OFF: 5449000000996 (Coca-Cola) найден', res.body?.found === true, JSON.stringify(res.body))
    console.log(`    → ${JSON.stringify(res.body?.product)}`)
  }
  {
    const res = await liveCall('4600682000129')
    assertEqual('живой OFF: несуществующий код → found=false', res.body, { found: false })
    assertEqual('живой OFF: несуществующий код → статус 200 (не ошибка)', res.statusCode, 200)
  }
  {
    const res = await liveCall('123')
    assertEqual('живой OFF: невалидный код → 400 без похода в сеть', res.statusCode, 400)
  }
}

console.log(`\n${'─'.repeat(68)}\nИтог: ${pass} пройдено, ${fail} провалено`)
// exitCode, а не process.exit(): принудительный выход посреди закрывающихся
// сокетов (после прерванного по таймауту запроса в OFF) роняет libuv на
// Windows ассертом, и настоящий код возврата теряется под этим падением.
// Здесь дать циклу событий доснуться дешевле, чем разбирать потом чужой креш.
process.exitCode = fail ? 1 : 0
