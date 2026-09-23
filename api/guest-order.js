import { createClient } from '@supabase/supabase-js'
import { rateLimit } from './_ratelimit.js'

// ── ВХОД ПОСЛЕ ОПЛАТЫ БЕЗ АККАУНТА (ZMClub, сент 2026) ─────────────────────
//
// Гость заплатил (api/create-payment.js выдал ему секретный номер заказа,
// вебхук завёл аккаунт по почте из кассы). Вернувшись в приложение, он
// присылает сюда номер заказа и получает одноразовый ключ входа — приложение
// тут же входит им в аккаунт, никаких паролей и писем.
//
// Ответы:
//   pending  — касса ещё не подтвердила оплату (приложение переспросит);
//   ok       — { token_hash, email }: войти через verifyOtp(type 'magiclink');
//   existing — почта уже была зарегистрирована: оплата зачислена на тот
//              аккаунт, но входить в него по заказу нельзя (иначе, заплатив с
//              чужой почтой, можно было бы открыть чужой аккаунт) — пусть
//              войдёт как обычно;
//   claimed  — ключ по этому заказу уже выдавали: войти как обычно;
//   unknown  — такого заказа нет.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const CLAIM_WINDOW_MS = 7 * 24 * 3600 * 1000

const mask = e => {
  const [u, d] = String(e || '').split('@')
  if (!d || d.endsWith('guest.fitproapp.ru')) return null
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'guest-order', limit: 60 })) return

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return res.status(500).json({ error: 'Сервер не настроен' })
  const db = createClient(SUPABASE_URL, key)

  const token = String(req.body?.order || '')
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return res.status(400).json({ status: 'unknown' })

  const { data: o } = await db.from('guest_orders')
    .select('token, email, user_id, new_account, paid_at, claimed_at, created_at').eq('token', token).maybeSingle()
  if (!o) return res.status(200).json({ status: 'unknown' })
  if (!o.paid_at || !o.user_id) return res.status(200).json({ status: 'pending' })
  if (!o.new_account) return res.status(200).json({ status: 'existing', email: mask(o.email) })
  if (o.claimed_at || Date.now() - new Date(o.paid_at).getTime() > CLAIM_WINDOW_MS) {
    return res.status(200).json({ status: 'claimed', email: mask(o.email) })
  }

  // Одноразовый ключ входа. Сначала помечаем заказ использованным (условно —
  // только если ещё не помечен), и лишь победитель гонки получает ключ.
  const { data: won } = await db.from('guest_orders')
    .update({ claimed_at: new Date().toISOString() }).eq('token', token).is('claimed_at', null).select('token')
  if (!won?.length) return res.status(200).json({ status: 'claimed', email: mask(o.email) })

  const { data: link, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: o.email })
  const hash = link?.properties?.hashed_token
  if (error || !hash) {
    await db.from('guest_orders').update({ claimed_at: null }).eq('token', token)
    console.error('guest-order: не удалось выписать ключ входа:', error)
    return res.status(500).json({ error: 'Не удалось войти, попробуй ещё раз' })
  }
  return res.status(200).json({ status: 'ok', token_hash: hash, email: o.email, synthetic: !mask(o.email) })
}
