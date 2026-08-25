#!/usr/bin/env node
/**
 * ВОРКЕР ПРОТИВ ГЛАВНОГО ПОТОКА — ПО ВСЕМУ ПОЛЮ, А НЕ ПО ПЯТНАДЦАТИ СЕССИЯМ.
 *
 * Откуда взялся вопрос. В журнале видно, что у части заходов инференс считается
 * не в воркере, а на главном потоке (воркер не поднялся и сработал резерв), и
 * что у этих заходов показатели ЛУЧШЕ. Это противоречит здравому смыслу —
 * воркер и заводили затем, чтобы не делить поток с отрисовкой, — а значит
 * должно быть либо доказано, либо опровергнуто числами, а не пересказом.
 *
 * ЧТО СЧИТАЕТСЯ. Каждый снимок (`[snapshot]`, раз в пять секунд) несёт `thread`,
 * `fps` и `latencyMs`. Их и раскладываем: по потоку, по браузеру, по системе.
 *
 * ЕДИНИЦА НАБЛЮДЕНИЯ — СНИМОК, НО СЕССИИ СЧИТАЮТСЯ ОТДЕЛЬНО. Один длинный
 * заход даёт сотню снимков и может перевесить десять коротких; поэтому рядом с
 * каждой цифрой стоит и число сессий, по которым она собрана.
 *
 * ПРОВЕРКА СМЕЩЕНИЯ. Главный вопрос не «где быстрее», а «не сравниваем ли мы
 * телефоны». Если воркер откатывается на сильных устройствах, а держится на
 * слабых, то «главный поток быстрее» означает всего лишь «сильные телефоны
 * быстрее». Поэтому те же числа разложены по системе и браузеру, а рядом —
 * доля откатов внутри каждой группы.
 *
 *   node tools/motion-persona/field-threads.mjs
 */
import { readFileSync, existsSync } from 'node:fs'

const SUPA = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

function loadEnv() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out
}
const SERVICE = loadEnv().SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY')

// ── Чтение журнала ─────────────────────────────────────────────────────────
async function читатьВсё() {
  const rows = []
  for (let from = 0; ; from += 500) {
    const r = await fetch(`${SUPA}/rest/v1/motion_log?select=session,user_id,at,payload&order=at.asc`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Range: `${from}-${from + 499}` },
    })
    if (!r.ok) throw new Error(`motion_log: ${r.status} ${await r.text()}`)
    const part = await r.json()
    rows.push(...part)
    if (part.length < 500) break
  }
  return rows
}

/** Строка журнала: «время [тег] {json}». */
const РАЗБОР = /^(\S+)\s+\[([^\]]+)\]\s*(.*)$/

/** Браузер и система из User-Agent — коротко и по делу. */
function устройство(ua) {
  const s = String(ua || '')
  if (!s) return { браузер: '—', система: '—' }
  let браузер = 'другой'
  if (/CriOS/.test(s)) браузер = 'Chrome на iOS'
  else if (/FxiOS/.test(s)) браузер = 'Firefox на iOS'
  else if (/EdgiOS/.test(s)) браузер = 'Edge на iOS'
  else if (/Chrome\/\d/.test(s) && !/Edg/.test(s)) браузер = 'Chrome'
  else if (/Edg\//.test(s)) браузер = 'Edge'
  else if (/Firefox\//.test(s)) браузер = 'Firefox'
  else if (/Safari\//.test(s)) браузер = 'Safari'

  let система = 'другая'
  const ios = /(?:iPhone|CPU) OS (\d+)[_.](\d+)/.exec(s)
  const android = /Android (\d+)/.exec(s)
  if (ios) система = `iOS ${ios[1]}.${ios[2]}`
  else if (android) система = `Android ${android[1]}`
  else if (/Windows NT/.test(s)) система = 'Windows'
  else if (/Mac OS X/.test(s)) система = 'macOS'
  return { браузер, система }
}

// ── Статистика ─────────────────────────────────────────────────────────────
const кв = (v, p) => {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))])
}

function свод(снимки) {
  const fps = снимки.map((s) => s.fps).filter((v) => Number.isFinite(v))
  const lat = снимки.map((s) => s.lat).filter((v) => Number.isFinite(v))
  return {
    сессий: new Set(снимки.map((s) => s.session)).size,
    людей: new Set(снимки.map((s) => s.user)).size,
    снимков: снимки.length,
    // Для частоты худшее — НИЗ, поэтому «худшие 10%» это 10-й процентиль.
    fpsМед: кв(fps, 0.5),
    fpsХудшие10: кв(fps, 0.1),
    задМед: кв(lat, 0.5),
    задP90: кв(lat, 0.9),
  }
}

const таблица = (строки, колонки) => {
  const шапка = colонкиИмена(колонки)
  const все = [шапка, ...строки.map((r) => колонки.map((c) => String(r[c] ?? '—')))]
  const ш = шапка.map((_, i) => Math.max(...все.map((s) => [...s[i]].length)))
  return все.map((s, i) => s.map((v, j) => (i === 0 || j === 0 ? v.padEnd(ш[j]) : v.padStart(ш[j]))).join('  ')).join('\n')
}
const colонкиИмена = (колонки) => колонки.map((c) => c)

// ── Разбор ─────────────────────────────────────────────────────────────────
const rows = await читатьВсё()
/** session -> {ua, браузер, система, user} */
const сессии = new Map()
/** плоский список снимков */
const снимки = []
/** откаты воркера: session -> причина */
const откаты = new Map()
/** session -> сколько ответов модели было на прошлом снимке */
const последниеResults = new Map()
/** сколько снимков отброшено как эхо остановленного конвейера */
let эхо = 0

for (const row of rows) {
  const lines = Array.isArray(row.payload?.lines) ? row.payload.lines : []
  for (const raw of lines) {
    const m = РАЗБОР.exec(raw)
    if (!m) continue
    const [, , тег, хвост] = m
    let data = null
    try { data = JSON.parse(хвост) } catch { data = null }
    if (!data) continue

    if (тег === 'session.start' && data.ua) {
      сессии.set(row.session, { ua: data.ua, ...устройство(data.ua), user: row.user_id, screen: data.screen })
    } else if (тег === 'worker.fallback') {
      if (!откаты.has(row.session)) откаты.set(row.session, String(data.why || '').slice(0, 120))
    } else if (тег === 'snapshot') {
      const fps = Number(data.fps)
      if (!(fps > 0)) continue                    // калибровка и паузы — не замер
      /**
       * СНИМОК, В КОТОРОМ КОНВЕЙЕР НЕ ДВИГАЛСЯ, — НЕ ЗАМЕР, А ЭХО.
       *
       * Снимки пишет таймер раз в пять секунд, а частоту считает окно внутри
       * цикла кадров. Свернул человек вкладку — цикл встал, окно не закрылось,
       * и `fps` с `latencyMs` продолжают показывать ПОСЛЕДНИЕ живые значения
       * сколько угодно долго. В сыром виде это дало сессию с двумя десятками
       * одинаковых строк «21 замер/с при задержке 119 мс» — числа, которые
       * вместе невозможны: при задержке 119 мс насос физически не отдаёт больше
       * девяти кадров в секунду, он ждёт ответа на предыдущий.
       *
       * Отличаем по `results` — накопительному счётчику ответов модели. Не
       * вырос с прошлого снимка, значит между ними не было ни одного кадра.
       */
      const results = Number(data.results)
      const было = последниеResults.get(row.session)
      последниеResults.set(row.session, results)
      if (Number.isFinite(было) && Number.isFinite(results) && results <= было) {
        эхо += 1
        continue
      }
      снимки.push({
        session: row.session,
        user: row.user_id,
        thread: data.thread === 'main' ? 'главный' : data.thread === 'worker' ? 'воркер' : '—',
        delegate: data.delegate || '—',
        fps,
        lat: Number(data.latencyMs),
        screen: String(data.screen || '').split(':')[1] || '—',
      })
    }
  }
}

const дом = (s) => сессии.get(s.session) || { браузер: '—', система: '—' }

console.log(`строк журнала: ${rows.length}, сессий с шапкой: ${сессии.size}, снимков с частотой > 0: ${снимки.length}`)
console.log(`откатов воркера в журнале: ${откаты.size} сессий`)
console.log(`отброшено снимков с остановленным конвейером: ${эхо}\n`)

console.log('══ ПО ПОТОКУ ══')
console.log(таблица(
  ['воркер', 'главный'].map((t) => ({ поток: t, ...свод(снимки.filter((s) => s.thread === t)) })),
  ['поток', 'сессий', 'людей', 'снимков', 'fpsМед', 'fpsХудшие10', 'задМед', 'задP90'],
))

console.log('\n══ ПО БРАУЗЕРУ И ПОТОКУ ══')
const пары = new Map()
for (const s of снимки) {
  const d = дом(s)
  const key = `${d.браузер}|${d.система}|${s.thread}`
  if (!пары.has(key)) пары.set(key, [])
  пары.get(key).push(s)
}
console.log(таблица(
  [...пары.entries()]
    .map(([key, list]) => {
      const [браузер, система, поток] = key.split('|')
      return { браузер, система, поток, ...свод(list) }
    })
    .sort((a, b) => b.снимков - a.снимков),
  ['браузер', 'система', 'поток', 'сессий', 'людей', 'снимков', 'fpsМед', 'fpsХудшие10', 'задМед', 'задP90'],
))

console.log('\n══ СМЕЩЕНИЕ ВЫБОРКИ: где воркер откатывается ══')
/** По сессиям: какой поток у неё был в итоге и на чём она шла. */
const поСессии = new Map()
for (const s of снимки) {
  const cur = поСессии.get(s.session) || { потоки: new Set(), n: 0 }
  cur.потоки.add(s.thread)
  cur.n += 1
  поСессии.set(s.session, cur)
}
const группы = new Map()
for (const [session, info] of поСессии) {
  const d = сессии.get(session) || { браузер: '—', система: '—' }
  const key = `${d.браузер}|${d.система}`
  const g = группы.get(key) || { всего: 0, главный: 0, воркер: 0, смешанных: 0 }
  g.всего += 1
  if (info.потоки.size > 1) g.смешанных += 1
  else if (info.потоки.has('главный')) g.главный += 1
  else if (info.потоки.has('воркер')) g.воркер += 1
  группы.set(key, g)
}
console.log(таблица(
  [...группы.entries()].map(([key, g]) => {
    const [браузер, система] = key.split('|')
    return {
      браузер, система, сессий: g.всего,
      'на воркере': g.воркер, 'на главном': g.главный, 'смешанных': g.смешанных,
      'доля откатов': g.всего ? `${Math.round((g.главный / g.всего) * 100)}%` : '—',
    }
  }).sort((a, b) => b.сессий - a.сессий),
  ['браузер', 'система', 'сессий', 'на воркере', 'на главном', 'смешанных', 'доля откатов'],
))

console.log('\n══ ПРИЧИНЫ ОТКАТА ══')
const причины = new Map()
for (const why of откаты.values()) причины.set(why, (причины.get(why) ?? 0) + 1)
for (const [why, n] of [...причины.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${why}`)

console.log('\n══ ТОЛЬКО БОЙ (screen=fight) ══')
const бой = снимки.filter((s) => s.screen === 'fight')
console.log(таблица(
  ['воркер', 'главный'].map((t) => ({ поток: t, ...свод(бой.filter((s) => s.thread === t)) })),
  ['поток', 'сессий', 'людей', 'снимков', 'fpsМед', 'fpsХудшие10', 'задМед', 'задP90'],
))
