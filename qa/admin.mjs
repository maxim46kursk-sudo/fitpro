// Заведение и удаление тестовых пользователей для сквозного прогона по ПРОДУ.
//
// Стенда нет, поэтому весь прогон идёт по боевой базе — и главное требование к
// этому файлу не «уметь создавать», а УМЕТЬ УДАЛЯТЬ. Удаление обязано
// отрабатывать в том числе после упавшего прогона, поэтому оно оформлено
// отдельной командой и ищет пользователей по метке в почте, а не по списку,
// который прогон мог не успеть сохранить.
//
// Список таблиц НЕ дублируется — импортируется из api/_userTables.js, того же
// самого, которым пользуется настоящее удаление аккаунта (api/delete-account.js).
// Иначе новая таблица с данными пользователя появилась бы в приложении, а
// чистилка о ней не знала бы и оставляла мусор в проде.
//
// Использование:
//   node qa/admin.mjs create 5      — завести пользователей, вывести JSON
//   node qa/admin.mjs cleanup       — удалить ВСЕХ с меткой qa-e2e-
//   node qa/admin.mjs list          — показать, кто сейчас заведён

import { readFileSync, existsSync } from 'node:fs'
import { USER_TABLES, TWO_SIDED_TABLES, PROFILE_TABLE, twoSidedFilter } from '../api/_userTables.js'

// ── Метка тестовых аккаунтов ────────────────────────────────────────────────
// Почта устроена так, чтобы её нельзя было принять за живого человека ни
// глазами в списке пользователей, ни регуляркой при чистке. Домен qa. —
// служебный поддомен, писем на него никто не ждёт; аккаунты заводятся с
// email_confirm:true, поэтому письма и не отправляются.
export const QA_PREFIX = 'qa-e2e-'
export const QA_DOMAIN = 'qa.fitproapp.ru'
export const qaEmail = (runId, n) => `${QA_PREFIX}${runId}-u${n}@${QA_DOMAIN}`
// Пароль общий на прогон — аккаунты живут минуты и удаляются в конце.
export const QA_PASSWORD = 'QaE2E-passw0rd!'

const SUPABASE_URL = 'https://api.fitproapp.ru'

// .env.local кладёт человек (он гитигнорится), .env лежит в проекте.
// Читаем оба, .env.local в приоритете.
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
export const ANON = env.VITE_SUPABASE_KEY || process.env.VITE_SUPABASE_KEY

if (!SRK) {
  console.error(`
Нет SUPABASE_SERVICE_ROLE_KEY.

Положи его в .env.local (файл под гитигнором):
  SUPABASE_SERVICE_ROLE_KEY=<ключ>

Достать с сервера (там переменная называется SERVICE_ROLE_KEY):
  ssh fitpro "grep -m1 '^SERVICE_ROLE_KEY=' /root/supabase/.env | cut -d= -f2-"

Префикс VITE_ этой переменной давать НЕЛЬЗЯ: Vite подставляет все VITE_* в
клиентский бандл, и сервисный ключ уехал бы в браузер каждому пользователю.
`)
  process.exit(1)
}

const adminHeaders = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' }

async function api(path, init = {}) {
  const res = await fetch(SUPABASE_URL + path, { ...init, headers: { ...adminHeaders, ...(init.headers || {}) } })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { ok: res.ok, status: res.status, body }
}

// ── Создание ────────────────────────────────────────────────────────────────
// email_confirm:true — аккаунт сразу подтверждён, письмо не уходит. Это прямое
// требование прогона: боевой SMTP дёргать ради тестов незачем.
export async function createUsers(runId, count) {
  const users = []
  for (let n = 1; n <= count; n++) {
    const email = qaEmail(runId, n)
    const r = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: QA_PASSWORD,
        email_confirm: true,
        user_metadata: { name: `QA Тестовый ${n}`, qa_e2e: true, qa_run: runId },
      }),
    })
    if (!r.ok || !r.body?.id) throw new Error(`не удалось завести ${email}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
    users.push({ n, id: r.body.id, email, password: QA_PASSWORD })
    console.log(`  + ${email} → ${r.body.id}`)
  }
  return users
}

// ── Поиск тестовых ──────────────────────────────────────────────────────────
// Идём по страницам admin API и отбираем по метке. Именно так чистилка
// находит мусор от упавшего прогона, о котором ей никто не рассказал.
export async function findQaUsers() {
  const found = []
  for (let page = 1; page <= 50; page++) {
    const r = await api(`/auth/v1/admin/users?page=${page}&per_page=200`)
    if (!r.ok) throw new Error(`список пользователей: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
    const list = r.body?.users || []
    if (!list.length) break
    for (const u of list) {
      const mail = (u.email || '').toLowerCase()
      // Двойное условие: и префикс, и домен. Одного префикса мало — почту с
      // таким началом теоретически может завести и человек.
      if (mail.startsWith(QA_PREFIX) && mail.endsWith('@' + QA_DOMAIN)) found.push({ id: u.id, email: u.email })
    }
    if (list.length < 200) break
  }
  return found
}

// ── Удаление одного ─────────────────────────────────────────────────────────
// Порядок как в api/delete-account.js: сначала все таблицы данных (внешние
// ключи на auth.users объявлены NO ACTION — auth-пользователь не удалится,
// пока в public осталась хоть одна его строка), потом profiles, потом сам
// пользователь. Ошибки отдельных таблиц не прерывают чистку: лучше вычистить
// девять таблиц из десяти и сказать про десятую, чем бросить всё.
export async function deleteUserFully(user) {
  const problems = []
  const del = async (table, query) => {
    const r = await api(`/rest/v1/${table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
    if (!r.ok) problems.push(`${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`)
  }

  for (const { table, column } of USER_TABLES) await del(table, `${column}=eq.${user.id}`)
  for (const { table, columns } of TWO_SIDED_TABLES) {
    await del(table, `or=(${twoSidedFilter(columns, user.id)})`)
  }
  await del(PROFILE_TABLE.table, `${PROFILE_TABLE.column}=eq.${user.id}`)

  const r = await api(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' })
  if (!r.ok) problems.push(`auth.users: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
  return problems
}

export async function cleanupAll() {
  const users = await findQaUsers()
  if (!users.length) { console.log('Тестовых пользователей не найдено — чистить нечего.'); return { deleted: 0, problems: [] } }
  console.log(`Найдено тестовых аккаунтов: ${users.length}`)
  let deleted = 0
  const allProblems = []
  for (const u of users) {
    const problems = await deleteUserFully(u)
    if (problems.length) {
      console.log(`  ! ${u.email} — с замечаниями:`)
      problems.forEach(p => console.log(`      ${p}`))
      allProblems.push({ email: u.email, problems })
    } else {
      console.log(`  − ${u.email} удалён полностью`)
    }
    deleted++
  }
  // Контрольная проверка: не осталось ли чего. Молча доверять циклу нельзя —
  // это прод.
  const left = await findQaUsers()
  if (left.length) {
    console.log(`\n!!! ОСТАЛОСЬ ${left.length} — разобрать руками:`)
    left.forEach(u => console.log(`      ${u.email} ${u.id}`))
  } else {
    console.log('\nПроверка: тестовых аккаунтов в базе не осталось.')
  }
  return { deleted, problems: allProblems, left }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const cmd = process.argv[2]
if (cmd === 'cleanup') {
  const r = await cleanupAll()
  process.exit(r.left?.length ? 1 : 0)
} else if (cmd === 'list') {
  const users = await findQaUsers()
  console.log(users.length ? users.map(u => `${u.email}  ${u.id}`).join('\n') : 'пусто')
} else if (cmd === 'create') {
  const runId = process.argv[4] || String(Date.now()).slice(-6)
  const users = await createUsers(runId, Number(process.argv[3] || 5))
  console.log(JSON.stringify({ runId, users }, null, 2))
}
