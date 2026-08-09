// ПОСТОЯННЫЙ тестовый аккаунт для прогонов.
//
// Зачем отдельный от одноразовых: часть проверок имеет смысл только на
// накопленной истории — повторный скан, «этот продукт я уже ел», лимиты за
// сутки. Каждый раз заводя чистого пользователя, мы проверяем только первый
// день жизни аккаунта и никогда — второй.
//
// Почта НЕ начинается с qa-e2e-, и это важно: cleanupAll() в admin.mjs сносит
// всех, у кого префикс qa-e2e- И домен qa.fitproapp.ru. Бот под эту метку не
// подпадает и переживает любую чистку одноразовых.
//
// Удалять у него после прогона надо ДАННЫЕ (записи дневника, заведённые им
// карточки продуктов), а не сам аккаунт.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))

export const SUPA = env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
export const ANON = env.VITE_SUPABASE_KEY
const SRK = env.SUPABASE_SERVICE_ROLE_KEY
if (!SRK) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY в .env')

export const BOT_EMAIL = 'fitpro-qa-bot@qa.fitproapp.ru'
export const BOT_PASSWORD = 'FitproQaBot-2026!'

const admin = (path, opts = {}) => fetch(`${SUPA}${path}`, {
  ...opts,
  headers: { 'Content-Type': 'application/json', apikey: SRK, Authorization: `Bearer ${SRK}`, ...(opts.headers || {}) },
})

// Заводит бота, если его ещё нет, и в любом случае выставляет платный уровень
// с далёким сроком. Идемпотентна: гонять можно сколько угодно.
export async function ensureBot() {
  let id = null
  for (let page = 1; page <= 50; page++) {
    const r = await admin(`/auth/v1/admin/users?page=${page}&per_page=200`)
    const list = (await r.json())?.users || []
    if (!list.length) break
    const hit = list.find(u => (u.email || '').toLowerCase() === BOT_EMAIL)
    if (hit) { id = hit.id; break }
    if (list.length < 200) break
  }

  if (!id) {
    const r = await admin('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: BOT_EMAIL, password: BOT_PASSWORD, email_confirm: true,
        user_metadata: { name: 'FitPro QA бот', qa_bot: true, note: 'постоянный тестовый аккаунт, не удалять' },
      }),
    })
    const b = await r.json()
    if (!b?.id) throw new Error(`не завёл бота: ${r.status} ${JSON.stringify(b).slice(0, 300)}`)
    id = b.id
    console.log(`  + заведён ${BOT_EMAIL} → ${id}`)
  } else {
    console.log(`  = бот уже есть: ${id}`)
  }

  // Платный уровень с далёким сроком. plan_until в 2099 — чтобы не протухал и
  // не приходилось чинить прогон из-за истёкшего пакета.
  const upd = await admin(`/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ plan: 'profit', plan_until: '2099-12-31T00:00:00Z' }),
  })
  const rows = await upd.json().catch(() => null)
  console.log(`  = пакет: ${rows?.[0]?.plan} до ${rows?.[0]?.plan_until}`)
  return id
}

export async function botToken() {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: BOT_EMAIL, password: BOT_PASSWORD }),
  })
  const j = await r.json()
  if (!j?.access_token) throw new Error(`бот не вошёл: ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.access_token
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const id = await ensureBot()
  const t = await botToken()
  console.log(`\nбот готов: ${BOT_EMAIL}\nid: ${id}\nтокен получен: ${t.slice(0, 12)}…`)
}
