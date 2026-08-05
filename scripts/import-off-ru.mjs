// scripts/import-off-ru.mjs — разовый импорт российских продуктов из полного
// дампа Open Food Facts в наш справочник food_products.
//
// Зачем дамп, а не их API: текстовый поиск OFF отвечает 503 в двух случаях из
// трёх (проверено), и наполнять базу через него — значит зависеть от чужой
// нестабильной ручки. Дамп — статический файл, скачивается один раз и целиком.
//
// Почему CSV, а не Parquet+duckdb: CSV-дамп весит 1.2 ГБ против 11.7 ГБ у
// JSONL, читается потоком силами самого Node (gunzip + readline) и не требует
// ни duckdb, ни нативных зависимостей в репозитории. Для разового скрипта это
// решает.
//
// ГЛАВНОЕ: строки прогоняются через НАШ normalizeOffProduct из
// api/_foodProduct.js — тот же, что работает в ветке ?action=barcode. Пределы
// правдоподобия, приоритет product_name_ru и пересчёт из кДж не дублируются:
// разъедься они, и в базе оказались бы карточки, прошедшие импорт, но не
// прошедшие бы обычный скан.
//
// Данные в репозиторий НЕ кладём: и дамп, и результат живут во временной
// папке ОС, путь печатается в конце.
//
// Запуск:  node scripts/import-off-ru.mjs
//          node scripts/import-off-ru.mjs --limit 200000   (быстрая проба)
//          node scripts/import-off-ru.mjs --keep            (не удалять дамп)

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeOffProduct, isValidBarcode } from '../api/_foodProduct.js'

const DUMP_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'
const WORK_DIR = join(tmpdir(), 'fitpro-off')
const DUMP_PATH = join(WORK_DIR, 'off-products.csv.gz')
const OUT_PATH = join(WORK_DIR, 'off_ru_import.csv')

const args = process.argv.slice(2)
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? Number(args[i + 1]) : Infinity
})()

// Страна в дампе живёт тегом. Именно тег, а не свободное поле countries:
// там встречается и «Russia», и «Россия», и «RU» вперемешку, а тег
// нормализован самим OFF.
const RU_TAG = 'en:russia'

const log = (...a) => console.log(...a)
const pct = (n, total) => (total ? `${(n / total * 100).toFixed(1)}%` : '0%')

// ── Скачивание дампа ───────────────────────────────────────────────────────
async function ensureDump() {
  mkdirSync(WORK_DIR, { recursive: true })
  if (existsSync(DUMP_PATH)) {
    const mb = (statSync(DUMP_PATH).size / 1048576).toFixed(0)
    log(`Дамп уже скачан: ${DUMP_PATH} (${mb} МБ). Удали файл, чтобы перекачать.`)
    return
  }
  log(`Качаю дамп OFF (~1.2 ГБ) → ${DUMP_PATH}`)
  const res = await fetch(DUMP_URL, {
    headers: { 'User-Agent': 'FitPro/1.0 (fitpro-dun.vercel.app)' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`не удалось скачать дамп: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0, lastShown = 0
  const out = createWriteStream(DUMP_PATH)
  for await (const chunk of res.body) {
    got += chunk.length
    out.write(chunk)
    // Отчёт каждые 100 МБ: качать гигабайт молча — плохая идея, непонятно,
    // жив ли процесс.
    if (got - lastShown > 100 * 1048576) {
      lastShown = got
      log(`  ${(got / 1048576).toFixed(0)} МБ${total ? ` из ${(total / 1048576).toFixed(0)}` : ''}`)
    }
  }
  await new Promise((ok, err) => out.end(e => (e ? err(e) : ok())))
  log(`Скачано: ${(got / 1048576).toFixed(0)} МБ`)
}

// ── Разбор ─────────────────────────────────────────────────────────────────
// Дамп разделён ТАБАМИ, а не запятыми: в названиях продуктов запятых полно, а
// табов не бывает — поэтому колонки бьются простым split, без CSV-парсера.

// Индексы нужных колонок по строке заголовка дампа.
// nameRu может отсутствовать (в CSV-экспорте OFF нет колонок на каждый язык) —
// тогда остаётся product_name, который у российских товаров обычно и так
// русский. Остальные обязательны: без них импортировать нечего.
export function columnIndex(headerLine) {
  const cols = headerLine.split('\t')
  const at = n => cols.indexOf(n)
  const idx = {
    code: at('code'),
    name: at('product_name'),
    nameRu: at('product_name_ru'),
    brands: at('brands'),
    countries: at('countries_tags'),
    kcal: at('energy-kcal_100g'),
    kj: at('energy_100g'),
    p: at('proteins_100g'),
    c: at('carbohydrates_100g'),
    f: at('fat_100g'),
  }
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0 && k !== 'nameRu') throw new Error(`в дампе нет колонки для «${k}»`)
  }
  idx.__count = cols.length
  return idx
}

// Строка дампа → карточка либо причина отказа. Отдельной функцией, а НЕ внутри
// цикла: так её гоняет test-off-import.mjs на реальных строках формата, и
// правило отбора проверяется, не качая гигабайт.
//
// Возвращает { card } либо { skip: 'причина' }; причины совпадают с ключами
// статистики, которую печатает скрипт.
export function cardFromDumpRow(line, idx) {
  const f = line.split('\t')
  // Строка короче заголовка — битая, в дампе такие попадаются.
  if (f.length < idx.__count - 5) return { skip: 'broken' }

  if (!(f[idx.countries] || '').includes(RU_TAG)) return { skip: 'noRu' }

  const code = (f[idx.code] || '').trim()
  if (!isValidBarcode(code)) return { skip: 'badCode' }

  const nameRu = idx.nameRu >= 0 ? (f[idx.nameRu] || '') : ''
  const name = f[idx.name] || ''
  if (!nameRu.trim() && !name.trim()) return { skip: 'noName' }

  const kcal = f[idx.kcal] || ''
  const kj = f[idx.kj] || ''
  if (!kcal.trim() && !kj.trim()) return { skip: 'noEnergy' }

  // Собираем ровно ту форму, которую ждёт наш нормализатор, — и отдаём ему.
  const card = normalizeOffProduct(code, {
    product_name: name,
    product_name_ru: nameRu,
    brands: f[idx.brands] || '',
    nutriments: {
      'energy-kcal_100g': kcal,
      energy_100g: kj,
      proteins_100g: f[idx.p] || '',
      carbohydrates_100g: f[idx.c] || '',
      fat_100g: f[idx.f] || '',
    },
  })
  // Без калорийности карточка в дневнике бесполезна — то же правило, что и в
  // ветке поиска.
  if (!card || card.kcal100 === null) return { skip: 'normalize' }
  return { card }
}

const csvEscape = v => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function run() {
  await ensureDump()

  const stats = {
    total: 0,
    skipNoRu: 0,        // не российский товар
    skipBadCode: 0,     // штрих-код не 8–14 цифр
    skipNoName: 0,      // ни названия, ни русского названия
    skipNoEnergy: 0,    // нет ни ккал, ни кДж
    skipNormalize: 0,   // не прошёл наш нормализатор (мусорные значения)
    skipDupe: 0,        // штрих-код уже встречался в дампе
    kept: 0,
    full: 0,            // все четыре числа
    kcalOnly: 0,        // только калорийность
  }
  const brands = new Map()
  const sample = []
  const seen = new Set()

  const out = createWriteStream(OUT_PATH, { encoding: 'utf8' })
  out.write('barcode,name,brand,kcal100,p100,c100,f100\n')

  const rl = createInterface({
    input: createReadStream(DUMP_PATH).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  let cols = null
  let idx = null
  const t0 = Date.now()

  for await (const line of rl) {
    if (cols === null) {
      cols = line.split('\t')
      idx = columnIndex(line)
      log(`Колонок в дампе: ${cols.length}. product_name_ru ${idx.nameRu >= 0 ? 'ЕСТЬ' : 'нет — берём product_name'}`)
      continue
    }

    stats.total++
    if (stats.total > LIMIT) break
    if (stats.total % 500000 === 0) {
      log(`  прочитано ${(stats.total / 1e6).toFixed(1)} млн строк, отобрано ${stats.kept}`)
    }

    const { card, skip } = cardFromDumpRow(line, idx)
    if (skip === 'broken') continue
    if (skip === 'noRu') { stats.skipNoRu++; continue }
    if (skip === 'badCode') { stats.skipBadCode++; continue }
    if (skip === 'noName') { stats.skipNoName++; continue }
    if (skip === 'noEnergy') { stats.skipNoEnergy++; continue }
    if (skip === 'normalize') { stats.skipNormalize++; continue }
    // Дубль внутри дампа отсекаем здесь, а не в чистой функции: она не должна
    // помнить состояние между строками.
    if (seen.has(card.barcode)) { stats.skipDupe++; continue }

    seen.add(card.barcode)
    stats.kept++
    if (card.p100 !== null && card.c100 !== null && card.f100 !== null) stats.full++
    else stats.kcalOnly++
    if (card.brand) brands.set(card.brand, (brands.get(card.brand) || 0) + 1)
    // Резервуарная выборка: 10 случайных строк без хранения всего массива.
    if (sample.length < 10) sample.push(card)
    else {
      const j = Math.floor(Math.random() * stats.kept)
      if (j < 10) sample[j] = card
    }

    out.write([card.barcode, card.name, card.brand ?? '', card.kcal100,
      card.p100 ?? '', card.c100 ?? '', card.f100 ?? ''].map(csvEscape).join(',') + '\n')
  }

  await new Promise((ok, err) => out.end(e => (e ? err(e) : ok())))
  const secs = ((Date.now() - t0) / 1000).toFixed(0)

  // ── Отчёт
  log('\n' + '═'.repeat(70))
  log(`Прочитано строк дампа: ${stats.total.toLocaleString('ru')} за ${secs} с`)
  log(`\nОТСЕЯНО:`)
  log(`  не российские товары       ${stats.skipNoRu.toLocaleString('ru').padStart(10)}  ${pct(stats.skipNoRu, stats.total)}`)
  log(`  битый штрих-код            ${stats.skipBadCode.toLocaleString('ru').padStart(10)}`)
  log(`  дубль штрих-кода в дампе   ${stats.skipDupe.toLocaleString('ru').padStart(10)}`)
  log(`  нет названия               ${stats.skipNoName.toLocaleString('ru').padStart(10)}`)
  log(`  нет энергии                ${stats.skipNoEnergy.toLocaleString('ru').padStart(10)}`)
  log(`  не прошли нормализатор     ${stats.skipNormalize.toLocaleString('ru').padStart(10)}`)
  log(`\nОТОБРАНО К ИМПОРТУ: ${stats.kept.toLocaleString('ru')}`)
  log(`  с полным КБЖУ              ${stats.full.toLocaleString('ru').padStart(10)}  ${pct(stats.full, stats.kept)}`)
  log(`  только с калорийностью     ${stats.kcalOnly.toLocaleString('ru').padStart(10)}  ${pct(stats.kcalOnly, stats.kept)}`)

  log(`\nТОП-20 БРЕНДОВ:`)
  const top = [...brands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  top.forEach(([b, n], i) => log(`  ${String(i + 1).padStart(2)}. ${b.slice(0, 34).padEnd(36)} ${String(n).padStart(5)}`))

  log(`\n10 СЛУЧАЙНЫХ СТРОК (глазами: имена русские?):`)
  for (const c of sample) {
    log(`  ${c.barcode}  ${String(c.name).slice(0, 42).padEnd(44)} ${String(c.brand ?? '—').slice(0, 18).padEnd(20)} ${c.kcal100} ккал`)
  }

  log(`\nФайл для импорта: ${OUT_PATH}`)
  log(`Размер: ${(statSync(OUT_PATH).size / 1048576).toFixed(1)} МБ`)
  if (!args.includes('--keep')) log(`Дамп остался в ${DUMP_PATH} — удали вручную, если больше не нужен.`)
}

// Запускаем ТОЛЬКО когда файл вызван напрямую. Без этой проверки простой
// импорт модуля (а его импортирует test-off-import.mjs ради чистых функций)
// начинал качать гигабайтный дамп — то есть npm test лез бы в сеть.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch(e => { console.error('Импорт не удался:', e); process.exitCode = 1 })
}