import { createClient } from '@supabase/supabase-js'
import { rateLimit } from './_ratelimit.js'
import { PROMO_KEY, promoActive, promoLeft } from './_promo.js'
import { promoFunnel } from './_promoFunnel.js'

/**
 * АКЦИЯ «SKODA OCTAVIA»: ручки для участника (окт 2026).
 *
 *   POST ?action=login  {token}  — вход по кнопке из письма → token_hash для
 *                                  supabase.auth.verifyOtp (как guest-order);
 *   POST ?action=me              — мои номера и анкета (нужен вход);
 *   POST ?action=save   {...}    — сохранить анкету (нужен вход и хоть один номер).
 *
 * Таблицы закрыты от клиента целиком (RLS + revoke), всё идёт через сервер:
 * здесь же проверяется возраст 18+ и телефон.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
// Совершеннолетие — на день подведения итогов.
const DRAW_DAY = '2026-11-12'
const ANKETA_ENDS_MS = Date.parse('2026-11-12T00:00:00+03:00')

function adult(birth) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birth || ''))
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  if (y < 1920 || mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const [dy, dm, dd] = DRAW_DAY.split('-').map(Number)
  const age = dy - y - ((dm < mo || (dm === mo && dd < d)) ? 1 : 0)
  return age >= 18
}

async function userFrom(req, db) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null
  const { data, error } = await db.auth.getUser(token)
  return error ? null : data?.user || null
}

const complete = p => !!(p && p.full_name && p.birth_date && p.phone && p.consent_at)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'promo-ip', limit: 60 })) return

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return res.status(500).json({ error: 'Сервер не настроен' })
  const db = createClient(SUPABASE_URL, key)
  const action = String(req.query?.action || '')

  // ── Сколько мест осталось (лендинг; без входа).
  // Точный остаток наружу НЕ отдаём: владелец не хочет публичного счётчика
  // мест (по нему видно, сколько продано). Только то, что нужно лендингу.
  if (action === 'status') {
    const closed = !promoActive()
    try {
      const left = await promoLeft(db)
      return res.status(200).json({ soldOut: !closed && left <= 0, club4Ok: closed || left >= 4, closed })
    } catch (e) {
      console.error('promo status:', e)
      return res.status(200).json({ soldOut: false, club4Ok: true, closed })
    }
  }

  // ── Вход по кнопке из письма.
  if (action === 'login') {
    const token = String(req.body?.token || '')
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(400).json({ error: 'Ссылка неверная' })
    const { data: p } = await db.from('promo_participants')
      .select('user_id, login_token_exp').eq('login_token', token).maybeSingle()
    if (!p || !p.login_token_exp || new Date(p.login_token_exp).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Ссылка устарела. Войди на сайте по своей почте.', reason: 'expired' })
    }
    const { data: u } = await db.auth.admin.getUserById(p.user_id)
    const email = u?.user?.email
    if (!email) return res.status(410).json({ error: 'Аккаунт не найден', reason: 'expired' })
    const { data: link, error } = await db.auth.admin.generateLink({ type: 'magiclink', email })
    const hash = link?.properties?.hashed_token
    if (error || !hash) {
      console.error('promo login: ключ входа не выписался:', error)
      return res.status(500).json({ error: 'Не удалось войти, попробуй ещё раз' })
    }
    return res.status(200).json({ token_hash: hash })
  }

  const user = await userFrom(req, db)
  if (!user) return res.status(401).json({ error: 'Требуется вход' })
  if (!rateLimit(req, res, { name: 'promo', limit: 30, subject: user.id })) return

  // ── Воронка акции — только владельцу (роль trainer).
  if (action === 'funnel') {
    const { data: me } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (me?.role !== 'trainer') return res.status(403).json({ error: 'Нет доступа' })
    const period = ['today', '7d', 'all'].includes(req.body?.period) ? req.body.period : 'today'
    try {
      return res.status(200).json(await promoFunnel(db, period))
    } catch (e) {
      console.error('promo funnel:', e)
      return res.status(500).json({ error: 'Воронка не собралась' })
    }
  }

  const { data: tickets } = await db.from('promo_tickets')
    .select('number, is_test').eq('user_id', user.id).eq('promo', PROMO_KEY).is('annulled_at', null).order('number')
  const { data: p } = await db.from('promo_participants')
    .select('full_name, birth_date, phone, email, consent_at').eq('user_id', user.id).maybeSingle()

  if (action === 'me') {
    return res.status(200).json({
      numbers: (tickets || []).map(t => t.number),
      test: (tickets || []).some(t => t.is_test),
      anketa: p ? { full_name: p.full_name || '', birth_date: p.birth_date || '', phone: p.phone || '', consent: !!p.consent_at } : null,
      complete: complete(p),
      anketaClosed: Date.now() >= ANKETA_ENDS_MS,
    })
  }

  if (action === 'save') {
    if (!tickets?.length) return res.status(403).json({ error: 'У тебя пока нет номера участника' })
    // Правила: анкета — до 23:59 МСК 11 ноября. Позже менять данные нельзя:
    // список на эфир собирается по анкетам на этот момент.
    if (Date.now() >= ANKETA_ENDS_MS) return res.status(403).json({ error: 'Приём анкет завершён 11 ноября в 23:59 (МСК)' })
    const full_name = String(req.body?.full_name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const birth_date = String(req.body?.birth_date || '').trim()
    const phoneRaw = String(req.body?.phone || '').replace(/[^\d+]/g, '')
    const consent = req.body?.consent === true
    if (full_name.split(' ').length < 2) return res.status(400).json({ error: 'Укажи фамилию и имя', field: 'full_name' })
    if (!adult(birth_date)) return res.status(400).json({ error: 'Участвовать можно с 18 лет — проверь дату рождения', field: 'birth_date' })
    const digits = phoneRaw.replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 15) return res.status(400).json({ error: 'Проверь номер телефона', field: 'phone' })
    if (!consent) return res.status(400).json({ error: 'Нужно согласие с правилами акции', field: 'consent' })
    const { error } = await db.from('promo_participants').upsert({
      user_id: user.id, promo: PROMO_KEY, full_name, birth_date, phone: phoneRaw.slice(0, 20),
      email: p?.email || user.email || null,
      consent_at: p?.consent_at || new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    if (error) {
      console.error('promo save:', error)
      return res.status(500).json({ error: 'Не удалось сохранить, попробуй ещё раз' })
    }
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'Неизвестное действие' })
}
