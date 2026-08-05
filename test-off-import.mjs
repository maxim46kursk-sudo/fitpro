// test-off-import.mjs — разбор строк дампа Open Food Facts.
//
// Проверяет scripts/import-off-ru.mjs на строках РЕАЛЬНОГО формата дампа
// (табы, порядок колонок, пустые поля) — но без самого дампа: скачивать
// гигабайт ради теста нельзя, а правило отбора проверить надо.
//
// Главное, что здесь фиксируется: импорт НЕ имеет своей арифметики. Он
// собирает объект нужной формы и отдаёт его тому же normalizeOffProduct, что
// работает в ветке ?action=barcode, — поэтому карточка, прошедшая импорт,
// гарантированно прошла бы и обычный скан.
//
// Запуск: node test-off-import.mjs. В сборку не входит.

const { columnIndex, cardFromDumpRow } = await import('./scripts/import-off-ru.mjs')

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

const T = String.fromCharCode(9)   // таб-разделитель дампа

// Урезанный заголовок в порядке настоящего дампа. Скрипт ищет колонки по
// ИМЕНИ, а не по позиции, поэтому лишние колонки между нужными здесь как раз
// и проверяют, что поиск по имени работает.
const HEADER = [
  'code', 'url', 'creator', 'product_name', 'brands', 'categories',
  'countries_tags', 'ingredients_text', 'energy_100g', 'energy-kcal_100g',
  'fat_100g', 'carbohydrates_100g', 'proteins_100g', 'salt_100g',
].join(T)

const idx = columnIndex(HEADER)

// Хелпер: собирает строку дампа из значений по именам колонок.
const row = (vals) => {
  const cols = HEADER.split(T)
  return cols.map(c => vals[c] ?? '').join(T)
}

console.log('\n── Заголовок дампа ────────────────────────────────────────────────')
assertEqual('колонка code найдена по имени', idx.code, 0)
assertEqual('колонка product_name найдена', idx.name, 3)
assertEqual('колонка countries_tags найдена', idx.countries, 6)
assertEqual('колонка energy-kcal_100g найдена', idx.kcal, 9)
assertEqual('product_name_ru в CSV-дампе отсутствует', idx.nameRu, -1)
assertEqual('число колонок запомнено', idx.__count, 14)
report('заголовок без обязательной колонки — ошибка, а не тихий импорт мусора',
  (() => { try { columnIndex(['code', 'product_name'].join(T)); return false } catch { return true } })())

console.log('\n── Строки российских товаров ──────────────────────────────────────')
{
  // Полная строка: код, русское название, бренд, все четыре числа.
  const { card, skip } = cardFromDumpRow(row({
    code: '4607091389003',
    product_name: 'Молоко Домик в деревне 3,2%',
    brands: 'Домик в деревне',
    countries_tags: 'en:russia',
    'energy-kcal_100g': '60',
    proteins_100g: '2.9',
    carbohydrates_100g: '4.7',
    fat_100g: '3.2',
  }), idx)
  assertEqual('полная строка не отсеяна', skip, undefined)
  assertEqual('карточка собрана целиком', card, {
    barcode: '4607091389003',
    name: 'Молоко Домик в деревне 3,2%',
    brand: 'Домик в деревне',
    kcal100: 60, p100: 2.9, c100: 4.7, f100: 3.2,
    source: 'off',
  })
}
{
  // Только килоджоули — пересчёт делает НАШ нормализатор, не импорт.
  const { card } = cardFromDumpRow(row({
    code: '4600682000129',
    product_name: 'Творог 5%',
    brands: 'Простоквашино, Danone',
    countries_tags: 'en:russia,en:belarus',
    energy_100g: '506',
    proteins_100g: '17.2',
  }), idx)
  assertEqual('ккал пересчитаны из кДж (506/4.184)', card.kcal100, 120.9)
  assertEqual('бренд — первый до запятой', card.brand, 'Простоквашино')
  assertEqual('незаполненные макросы остались null', [card.c100, card.f100], [null, null])
  assertEqual('несколько стран в теге — товар всё равно наш', card.barcode, '4600682000129')
}
{
  // Страна тегом, а не свободным текстом: en:russian-federation тегом OFF не
  // бывает, а вот подстрока «russia» встречается в других тегах.
  const { skip } = cardFromDumpRow(row({
    code: '3017620422003', product_name: 'Nutella',
    countries_tags: 'en:france,en:germany', 'energy-kcal_100g': '539',
  }), idx)
  assertEqual('не российский товар отсеян', skip, 'noRu')
}

console.log('\n── Отсев ──────────────────────────────────────────────────────────')
const skipOf = v => cardFromDumpRow(row({ countries_tags: 'en:russia', ...v }), idx).skip

assertEqual('битый штрих-код', skipOf({ code: 'abc', product_name: 'X', 'energy-kcal_100g': '100' }), 'badCode')
assertEqual('короткий штрих-код', skipOf({ code: '123', product_name: 'X', 'energy-kcal_100g': '100' }), 'badCode')
assertEqual('пустой штрих-код', skipOf({ code: '', product_name: 'X', 'energy-kcal_100g': '100' }), 'badCode')
assertEqual('нет названия', skipOf({ code: '4600682000129', product_name: '', 'energy-kcal_100g': '100' }), 'noName')
assertEqual('название из пробелов', skipOf({ code: '4600682000129', product_name: '   ', 'energy-kcal_100g': '100' }), 'noName')
assertEqual('нет ни ккал, ни кДж', skipOf({ code: '4600682000129', product_name: 'X' }), 'noEnergy')
// Энергия есть, но мусорная — отсекает уже нормализатор, а не предфильтр.
assertEqual('абсурдная калорийность', skipOf({ code: '4600682000129', product_name: 'X', 'energy-kcal_100g': '99999' }), 'normalize')
assertEqual('отрицательная калорийность', skipOf({ code: '4600682000129', product_name: 'X', 'energy-kcal_100g': '-50' }), 'normalize')
assertEqual('нечисловая калорийность', skipOf({ code: '4600682000129', product_name: 'X', 'energy-kcal_100g': 'н/д' }), 'normalize')
{
  // Обрезанная строка (в дампе такие есть) — не роняем импорт.
  const short = ['4600682000129', 'url', 'creator'].join(T)
  assertEqual('обрезанная строка помечена broken', cardFromDumpRow(short, idx).skip, 'broken')
}

console.log('\n── Пределы у импорта те же, что у скана ───────────────────────────')
{
  // Ровно те же границы, что проверяет test-barcode.mjs для ветки barcode:
  // импорт не имеет собственных правил.
  const at = kcal => cardFromDumpRow(row({
    code: '4600682000129', product_name: 'X', countries_tags: 'en:russia', 'energy-kcal_100g': String(kcal),
  }), idx)
  assertEqual('1000 ккал проходит', at(1000).card.kcal100, 1000)
  assertEqual('1001 ккал отсеяны', at(1001).skip, 'normalize')
  const macro = p => cardFromDumpRow(row({
    code: '4600682000129', product_name: 'X', countries_tags: 'en:russia',
    'energy-kcal_100g': '100', proteins_100g: String(p),
  }), idx).card
  assertEqual('100 г белка проходит', macro(100).p100, 100)
  assertEqual('101 г белка → null', macro(101).p100, null)
}
{
  // Длинные поля режутся теми же лимитами.
  const { card } = cardFromDumpRow(row({
    code: '4600682000129', countries_tags: 'en:russia', 'energy-kcal_100g': '100',
    product_name: 'Н'.repeat(400), brands: 'Б'.repeat(300),
  }), idx)
  assertEqual('название обрезано до 200', card.name.length, 200)
  assertEqual('бренд обрезан до 100', card.brand.length, 100)
}

console.log(`\n${'─'.repeat(68)}\nИтог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
