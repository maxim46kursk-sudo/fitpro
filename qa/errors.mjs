// Журнал ошибок глазами: что и у кого падало за последние N дней.
//
// Зачем отдельный скрипт, когда есть сводка в Telegram: сводка кричит о том,
// что случилось ПРЯМО СЕЙЧАС, и намеренно коротка. Разбирать накопившееся —
// другая задача: нужны группировка, повторяемость и вся картина сразу.
//
// Доступ — как в qa/admin.mjs: сервисный ключ из .env/.env.local, прямые
// запросы к PostgREST. Читает и только читает: ни строки в базу.
//
// Использование:
//   node qa/errors.mjs            — за последние 3 дня
//   node qa/errors.mjs 7          — за 7 дней
//   node qa/errors.mjs 1 --list   — ещё и построчно, последние 40 записей

import { readFileSync, existsSync } from 'node:fs'

const SUPABASE_URL = 'https://api.fitproapp.ru'
const LIST_LIMIT = 40
// Потолок выборки. Журнал может распухнуть, а тянуть его целиком незачем:
// смысл разбора в том, ЧТО повторяется, и это видно и на нескольких тысячах.
const FETCH_LIMIT = 5000

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

const headers = { apikey: SRK, Authorization: `Bearer ${SRK}` }

const args = process.argv.slice(2)
const DAYS = Number(args.find(a => /^\d+$/.test(a)) || 3)
const LIST = args.includes('--list')

const since = new Date(Date.now() - DAYS * 86400000).toISOString()

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/error_log`
  + `?select=id,created_at,context,message,status,url,user_id`
  + `&created_at=gte.${since}&order=created_at.desc&limit=${FETCH_LIMIT}`,
  { headers },
)
if (!res.ok) {
  console.error(`Не прочитать журнал: ${res.status} ${(await res.text()).slice(0, 300)}`)
  process.exit(1)
}
const rows = await res.json()

if (!rows.length) {
  console.log(`За ${DAYS} дн. ошибок нет.`)
  process.exit(0)
}

// ── Группировка по context: что именно ломается и как часто.
// Внутри context держим и разные тексты сообщений: один и тот же context часто
// прикрывает несколько разных поломок, и без текстов не понять, одна это
// болезнь или три.
const byContext = new Map()
for (const r of rows) {
  const key = r.context || 'unknown'
  const g = byContext.get(key) || { n: 0, users: new Set(), messages: new Map(), first: r.created_at, last: r.created_at }
  g.n++
  if (r.user_id) g.users.add(r.user_id)
  const m = (r.message || '—').slice(0, 90)
  g.messages.set(m, (g.messages.get(m) || 0) + 1)
  if (r.created_at < g.first) g.first = r.created_at
  if (r.created_at > g.last) g.last = r.created_at
  byContext.set(key, g)
}

const when = iso => new Date(iso).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

console.log(`\nЖурнал ошибок за ${DAYS} дн.: ${rows.length} записей, ${byContext.size} видов\n`)
console.log('  ' + 'КОНТЕКСТ'.padEnd(30) + 'ВСЕГО'.padStart(6) + '  ЛЮДЕЙ  ПОСЛЕДНЯЯ')
console.log('  ' + '─'.repeat(66))

for (const [ctx, g] of [...byContext.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log('  ' + ctx.slice(0, 29).padEnd(30) + String(g.n).padStart(6) + String(g.users.size).padStart(7) + '  ' + when(g.last))
  // Топ-3 разных текста внутри контекста — по ним видно, одна это поломка
  // или несколько разных, слипшихся под общим именем.
  const top = [...g.messages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  for (const [m, n] of top) console.log(`      ${String(n).padStart(4)}×  ${m}`)
}

// Всплеск за последний час — то, что происходит прямо сейчас и о чём должно
// было прилететь уведомление в Telegram (api/_logError.js).
const hourAgo = new Date(Date.now() - 3600000).toISOString()
const recent = rows.filter(r => r.created_at >= hourAgo)
console.log(`\nЗа последний час: ${recent.length}`)
if (recent.length) {
  const ctxs = [...new Set(recent.map(r => r.context || 'unknown'))]
  console.log(`  контексты: ${ctxs.join(', ')}`)
  console.log(`  (о каждом должно было прийти по одному сообщению в Telegram, не больше)`)
}

if (LIST) {
  console.log(`\nПОСЛЕДНИЕ ${Math.min(LIST_LIMIT, rows.length)} ЗАПИСЕЙ:`)
  for (const r of rows.slice(0, LIST_LIMIT)) {
    console.log(`  ${when(r.created_at)}  ${String(r.context || '—').slice(0, 26).padEnd(28)}`
      + `${String(r.status ?? '—').padStart(4)}  ${String(r.message || '—').slice(0, 70)}`)
  }
}
