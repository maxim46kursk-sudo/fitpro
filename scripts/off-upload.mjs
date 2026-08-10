// scripts/off-upload.mjs — загрузка отобранных карточек Open Food Facts в
// боевой справочник food_products. Второй шаг после scripts/import-off-ru.mjs,
// который читает дамп и складывает отобранное в CSV.
//
// РАЗДЕЛЕНИЕ НА ДВА ШАГА НАМЕРЕННОЕ: первый ничего не пишет и его результат
// можно рассмотреть глазами, второй пишет в прод и потому обязан быть
// откатываемым. Смешай их — и решение «грузить ли это» пришлось бы принимать
// вслепую, уже после записи.
//
// Доступ к базе — как в qa/admin.mjs: сервисный ключ из .env/.env.local, прямые
// запросы к PostgREST. Не через supabase-js: скрипт разовый, а зависимость от
// клиента тянула бы за собой его версию и поведение.
//
// ПРАВИЛО ЗАПИСИ ТО ЖЕ, ЧТО В КЭШЕ ПОИСКА (cacheOffCards в api/set-exercise.js):
//   кода нет в базе                  → insert с source:'off';
//   код есть, source ai_estimate/ai_web → перезаписать (OFF точнее прикидки);
//   код есть, source off/ai_photo    → НЕ ТРОГАТЬ.
// Список вытесняемых источников берётся из weakerSources — той же функции, что
// работает в проде. Дублировать его здесь значило бы однажды разъехаться с ней.
//
// Запуск:
//   node scripts/off-upload.mjs --dry-run    — посчитать и показать, НЕ писать
//   node scripts/off-upload.mjs              — загрузить
//   node scripts/off-upload.mjs --rollback   — откатить по манифесту

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasUsableMacros, checkMacros, weakerSources, SOURCE_OFF } from '../api/_foodProduct.js'

const SUPABASE_URL = 'https://api.fitproapp.ru'
const CSV_PATH = process.env.OFF_CSV || join(tmpdir(), 'fitpro-off', 'off_ru_import.csv')
const MANIFEST_PATH = 'scripts/off-import-manifest.json'
const BATCH = 500
// Чтение существующих идёт через ?barcode=in.(...) — это URL, и он не резиновый.
// 200 кодов по 13 символов дают ~3 КБ строки запроса, что заведомо в пределах.
const READ_CHUNK = 200

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const ROLLBACK = args.includes('--rollback')

// ── Доступ ─────────────────────────────────────────────────────────────────
// .env.local кладёт человек (он гитигнорится), .env лежит в проекте.
// Читаем оба, .env.local в приоритете. Копия из qa/admin.mjs — тот файл
// экспортирует не loadEnv, а уже готовые значения для своих нужд.
function loadEnv() {
  const out = {}
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out
}

const env = loadEnv()
const SRK = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SRK) {
  console.error(`
Нет SUPABASE_SERVICE_ROLE_KEY.

Положи его в .env.local (файл под гитигнором):
  SUPABASE_SERVICE_ROLE_KEY=<ключ>

Достать с сервера (там переменная называется SERVICE_ROLE_KEY):
  ssh fitpro "grep -m1 '^SERVICE_ROLE_KEY=' /root/supabase/.env | cut -d= -f2-"
`)
  process.exit(1)
}

const headers = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' }

async function api(path, init = {}) {
  const res = await fetch(SUPABASE_URL + path, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { ok: res.ok, status: res.status, body }
}

// ── Чтение CSV ─────────────────────────────────────────────────────────────
// Поля экранированы по правилам CSV (кавычки удвоены), простым split(',') не
// обойтись: запятых в названиях продуктов полно.
function parseCsvLine(line) {
  const out = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

async function readCsv(path) {
  if (!existsSync(path)) throw new Error(`нет входного файла: ${path}\nСначала прогони node scripts/import-off-ru.mjs`)
  const rows = []
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  let header = null
  for await (const line of rl) {
    if (header === null) { header = line; continue }
    if (!line.trim()) continue
    const [barcode, name, brand, kcal100, p100, c100, f100] = parseCsvLine(line)
    const num = v => (String(v ?? '').trim() === '' ? null : Number(v))
    rows.push({
      barcode: barcode.trim(),
      name,
      brand: brand.trim() || null,
      kcal100: num(kcal100), p100: num(p100), c100: num(c100), f100: num(f100),
    })
  }
  return rows
}

// ── Сведение брендов ───────────────────────────────────────────────────────
// «Вкусвилл», «ВкусВилл» и «VkusVill» — один магазин, но три разных значения в
// колонке brand: в поиске они разъедутся на три группы, а в отчётах будут
// тремя строками.
//
// Правило автоматическое ровно одно и намеренно узкое: написания,
// РАЗЛИЧАЮЩИЕСЯ ТОЛЬКО РЕГИСТРОМ, сводятся к самому частому варианту. Частота,
// а не «первое встреченное» и не «с заглавной»: как марку пишет большинство
// карточек, так её и увидит человек.
//
// Транслитерации автоматике не поддаются — «VkusVill» и «ВкусВилл» отличаются
// не регистром, а алфавитом, и угадывать такие пары значило бы однажды слить
// две РАЗНЫЕ марки. Поэтому они перечислены явным списком.
//
// В списке ОБА написания одной марки, латинское и кириллическое. Одного
// латинского мало, и это выяснилось на сухом прогоне: кириллическая группа
// сводится по частоте к «Вкусвилл» (56 против 24), латинская — правилом к
// «ВкусВилл», и семейство остаётся разорванным на две марки. То есть явное
// правило обязано задавать написание для ВСЕГО семейства, а не только для
// чужого алфавита.
export const BRAND_ALIASES = new Map([
  ['vkusvill', 'ВкусВилл'],
  ['вкусвилл', 'ВкусВилл'],
])

export function buildBrandMap(rows) {
  // lowercase → { вариант → сколько раз встретился }
  const groups = new Map()
  for (const r of rows) {
    const b = (r.brand || '').trim()
    if (!b) continue
    const key = b.toLowerCase()
    if (!groups.has(key)) groups.set(key, new Map())
    const g = groups.get(key)
    g.set(b, (g.get(b) || 0) + 1)
  }

  // Марка начинается с заглавной? Название бренда — имя собственное, и при
  // РАВНОЙ частоте «Бабаевский» правильнее «бабаевского». Без этого признака
  // ничья разрешалась бы через localeCompare, а он для кириллицы ставит
  // строчную букву перед заглавной — и в справочник уезжали бы «экомилк»,
  // «домик в деревне», «alpro». Заглавных букв в марке нет вовсе (её пишут
  // строчными нарочно, как rich) — признак ни на что не влияет, обе стороны
  // ничьей одинаковы.
  const looksProper = v => v !== v.toLowerCase()

  const map = new Map()
  for (const [key, variants] of groups) {
    if (BRAND_ALIASES.has(key)) { map.set(key, BRAND_ALIASES.get(key)); continue }
    // Порядок предпочтения: чаще встречается → начинается с заглавной →
    // лексикографически. Последнее только ради устойчивости: результат не
    // должен зависеть от порядка строк в файле.
    const best = [...variants.entries()].sort((a, b) =>
      b[1] - a[1]
      || (looksProper(b[0]) ? 1 : 0) - (looksProper(a[0]) ? 1 : 0)
      || a[0].localeCompare(b[0]))[0][0]
    map.set(key, best)
  }
  return map
}

// ── Отбор ──────────────────────────────────────────────────────────────────
export function selectRows(rows) {
  const brandMap = buildBrandMap(rows)
  const kept = []
  const droppedNoMacros = []
  const droppedMacroIssue = []

  for (const r of rows) {
    if (!hasUsableMacros(r)) { droppedNoMacros.push(r); continue }
    const check = checkMacros(r)
    if (!check.ok) { droppedMacroIssue.push({ ...r, kind: check.kind, expected: check.expected }); continue }
    const key = (r.brand || '').trim().toLowerCase()
    const brand = key ? (brandMap.get(key) ?? r.brand) : null
    kept.push({ barcode: r.barcode, name: r.name, brand, kcal100: r.kcal100, p100: r.p100, c100: r.c100, f100: r.f100, source: SOURCE_OFF })
  }
  return { kept, droppedNoMacros, droppedMacroIssue, brandMap }
}

// ── Что уже есть в базе ────────────────────────────────────────────────────
async function readExisting(codes, select) {
  const found = new Map()
  for (let i = 0; i < codes.length; i += READ_CHUNK) {
    const chunk = codes.slice(i, i + READ_CHUNK)
    const list = chunk.map(c => `"${c}"`).join(',')
    const r = await api(`/rest/v1/food_products?select=${select}&barcode=in.(${list})`)
    if (!r.ok) throw new Error(`чтение существующих карточек: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
    for (const row of r.body || []) found.set(row.barcode, row)
  }
  return found
}

const countRows = async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/food_products?select=barcode`, {
    headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
  })
  const cr = res.headers.get('content-range') || ''
  return Number(cr.split('/')[1] || 0)
}

// ── Откат ──────────────────────────────────────────────────────────────────
// Вставленное удаляем, перезаписанное возвращаем ЦЕЛИКОМ из манифеста — там
// лежат полные прежние строки, а не только изменённые поля.
async function rollback() {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`нет манифеста ${MANIFEST_PATH} — откатывать нечего`)
  const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  console.log(`Манифест от ${m.startedAt}: вставлено ${m.inserted.length}, перезаписано ${m.overwritten.length}`)

  let removed = 0
  for (let i = 0; i < m.inserted.length; i += READ_CHUNK) {
    const chunk = m.inserted.slice(i, i + READ_CHUNK)
    const list = chunk.map(c => `"${c}"`).join(',')
    const r = await api(`/rest/v1/food_products?barcode=in.(${list})`, {
      method: 'DELETE', headers: { Prefer: 'return=minimal' },
    })
    if (!r.ok) throw new Error(`удаление вставленных: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
    removed += chunk.length
    console.log(`  удалено ${removed}/${m.inserted.length}`)
  }

  let restored = 0
  for (let i = 0; i < m.overwritten.length; i += BATCH) {
    const chunk = m.overwritten.slice(i, i + BATCH)
    const r = await api('/rest/v1/food_products', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    })
    if (!r.ok) throw new Error(`возврат перезаписанных: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
    restored += chunk.length
    console.log(`  возвращено ${restored}/${m.overwritten.length}`)
  }
  console.log(`\nОткат завершён. Удалено ${removed}, возвращено ${restored}.`)
  console.log(`Строк в food_products сейчас: ${(await countRows()).toLocaleString('ru')}`)
}

// ── Загрузка ───────────────────────────────────────────────────────────────
async function run() {
  console.log(`Вход: ${CSV_PATH}`)
  const rows = await readCsv(CSV_PATH)
  console.log(`Строк в файле: ${rows.length.toLocaleString('ru')}`)

  const { kept, droppedNoMacros, droppedMacroIssue, brandMap } = selectRows(rows)

  console.log(`\nОТСЕЯНО ДО ЗАПИСИ:`)
  console.log(`  без полного КБЖУ           ${String(droppedNoMacros.length).padStart(6)}`)
  console.log(`  не сходится по Атвотеру    ${String(droppedMacroIssue.length).padStart(6)}`)
  if (droppedMacroIssue.length) {
    console.log(`\n  Не сходятся (kind → заявлено против расчётного):`)
    for (const d of droppedMacroIssue) {
      console.log(`    ${d.barcode}  ${String(d.name).slice(0, 40).padEnd(42)} ${String(d.kind).padEnd(9)} ${d.kcal100} против ${Number(d.expected).toFixed(0)}`)
    }
  }

  // Сведённые бренды показываем: это единственная правка ДАННЫХ, которую
  // делает скрипт, и она должна быть видна, а не случиться молча.
  const merged = []
  const byLower = new Map()
  for (const r of rows) {
    const b = (r.brand || '').trim()
    if (!b) continue
    const key = b.toLowerCase()
    if (!byLower.has(key)) byLower.set(key, new Set())
    byLower.get(key).add(b)
  }
  for (const [key, variants] of byLower) {
    if (variants.size > 1 || (BRAND_ALIASES.has(key) && [...variants][0] !== BRAND_ALIASES.get(key))) {
      merged.push(`${[...variants].join(' / ')} → ${brandMap.get(key)}`)
    }
  }
  console.log(`\nСВЕДЕНО БРЕНДОВ: ${merged.length}`)
  merged.forEach(m => console.log(`  ${m}`))

  console.log(`\nК ЗАГРУЗКЕ ПОСЛЕ ФИЛЬТРОВ: ${kept.length.toLocaleString('ru')}`)

  // ── Что из этого уже есть
  const codes = kept.map(c => c.barcode)
  const existingSource = await readExisting(codes, 'barcode,source')
  const displaced = weakerSources(SOURCE_OFF)   // ['ai_web','ai_estimate']

  const toInsert = [], toOverwrite = [], skippedExact = []
  for (const c of kept) {
    const cur = existingSource.get(c.barcode)
    if (!cur) { toInsert.push(c); continue }
    if (displaced.includes(cur.source)) { toOverwrite.push(c); continue }
    skippedExact.push({ ...c, was: cur.source })
  }

  console.log(`\nПО СОСТОЯНИЮ БАЗЫ:`)
  console.log(`  вставить (кода нет)        ${String(toInsert.length).padStart(6)}`)
  console.log(`  перезаписать (${displaced.join('/')})  ${String(toOverwrite.length).padStart(6)}`)
  console.log(`  не трогать (off/ai_photo)  ${String(skippedExact.length).padStart(6)}`)
  console.log(`\nСтрок в food_products сейчас: ${(await countRows()).toLocaleString('ru')}`)

  if (DRY) {
    console.log('\n--dry-run: ничего не записано.')
    return
  }

  // ── СТРАХОВКА ОТКАТА. Пишется ДО первой записи в базу.
  // Полные прежние строки, а не только source: вернуть надо ровно то, что
  // было, включая barcodes[] и created_at, — иначе откат «вернёт» карточку,
  // потеряв привязанные к ней дополнительные коды.
  const prevRows = toOverwrite.length
    ? await readExisting(toOverwrite.map(c => c.barcode), '*')
    : new Map()
  const manifest = {
    startedAt: new Date().toISOString(),
    source: CSV_PATH,
    supabaseUrl: SUPABASE_URL,
    rollback: {
      command: 'node scripts/off-upload.mjs --rollback',
      does: 'удаляет коды из inserted и возвращает целиком строки из overwritten',
    },
    inserted: toInsert.map(c => c.barcode),
    overwritten: [...prevRows.values()],
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1), 'utf8')
  console.log(`\nМанифест отката: ${MANIFEST_PATH} (вставляемых ${manifest.inserted.length}, прежних строк ${manifest.overwritten.length})`)
  if (toOverwrite.length && prevRows.size !== toOverwrite.length) {
    throw new Error(`манифест неполон: перезаписать собираемся ${toOverwrite.length}, прежних строк прочитано ${prevRows.size}. Не пишу.`)
  }

  // ── Запись пакетами
  const write = async (list, what) => {
    let done = 0
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH)
      const r = await api('/rest/v1/food_products', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk),
      })
      if (!r.ok) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`)
      done += chunk.length
      console.log(`  ${what}: ${done}/${list.length}`)
    }
  }

  console.log('')
  if (toInsert.length) await write(toInsert, 'вставка')
  if (toOverwrite.length) await write(toOverwrite, 'перезапись')

  console.log(`\nГОТОВО. Вставлено ${toInsert.length}, перезаписано ${toOverwrite.length}, пропущено ${skippedExact.length}.`)
  console.log(`Строк в food_products стало: ${(await countRows()).toLocaleString('ru')}`)
  console.log(`Откат: node scripts/off-upload.mjs --rollback`)
}

const main = ROLLBACK ? rollback : run
main().catch(e => {
  console.error('\nНе удалось:', e?.message || e)
  process.exitCode = 1
})
