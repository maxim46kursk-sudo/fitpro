import { createClient } from '@supabase/supabase-js'
import { rateLimit } from './_ratelimit.js'
import { reportError } from './_logError.js'
import { siteSubmit, siteStatus, PayError } from './_botPay.js'

/**
 * ОПЛАТА ПЕРЕВОДОМ НА САЙТЕ (окт 2026) — страница src/PayTransfer.jsx.
 *
 *   POST ?action=submit — чек + анкета. Тело JSON:
 *     { plan, name, birth (ГГГГ-ММ-ДД), phone, email, consent: true,
 *       file: { mime, data (base64) } }
 *     Bearer-токен необязателен: вошедшему заказ привязывается к аккаунту.
 *     Ответ: { token, id, working, hoursFrom, hoursTo }.
 *   POST ?action=status — { token } → статус заказа, номера, ссылка входа.
 *
 * Логика заказа — api/_botPay.js (siteSubmit/siteStatus), подтверждает
 * владелец в Telegram.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const MAX_FILE = 7 * 1024 * 1024
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
const DRAW_DAY = [2026, 11, 12]

function adult(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (y < 1920 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false
  const [dy, dm, dd] = DRAW_DAY
  return dy - y - ((dm < mo || (dm === mo && dd < d)) ? 1 : 0) >= 18
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return res.status(500).json({ error: 'Сервер не настроен' })
  const db = createClient(SUPABASE_URL, key)
  const action = req.query?.action
  const b = req.body || {}

  if (action === 'status') {
    if (!rateLimit(req, res, { name: 'pay-transfer-status', limit: 60 })) return
    const token = String(b.token || '')
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return res.status(400).json({ error: 'Неверный заказ' })
    const st = await siteStatus(db, token)
    if (!st) return res.status(404).json({ error: 'Заказ не найден' })
    return res.status(200).json(st)
  }

  if (action === 'submit') {
    if (!rateLimit(req, res, { name: 'pay-transfer-submit', limit: 8 })) return
    const plan = b.plan === 'club4' ? 'club4' : b.plan === 'club' ? 'club' : null
    if (!plan) return res.status(400).json({ error: 'Выбери пакет' })
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (name.split(' ').length < 2 || /\d/.test(name)) return res.status(400).json({ error: 'Укажи фамилию и имя', field: 'name' })
    const birth = String(b.birth || '').trim()
    if (!adult(birth)) return res.status(400).json({ error: 'Участвовать можно с 18 лет — проверь дату рождения', field: 'birth' })
    const phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20)
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 15) return res.status(400).json({ error: 'Проверь номер телефона', field: 'phone' })
    const email = String(b.email || '').trim().toLowerCase().slice(0, 120)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Проверь почту — на неё придёт номер участника', field: 'email' })
    if (b.consent !== true) return res.status(400).json({ error: 'Нужно согласие с правилами акции', field: 'consent' })
    const mime = String(b.file?.mime || '')
    if (!MIMES.has(mime)) return res.status(400).json({ error: 'Прикрепи чек: скриншот (JPG, PNG) или PDF', field: 'file' })
    let buf
    try { buf = Buffer.from(String(b.file?.data || ''), 'base64') } catch { buf = null }
    if (!buf?.length) return res.status(400).json({ error: 'Прикрепи чек', field: 'file' })
    if (buf.length > MAX_FILE) return res.status(400).json({ error: 'Файл слишком большой — сделай скриншот чека', field: 'file' })

    // Вошедший — заказ на его аккаунт.
    let userId = null
    const auth = req.headers.authorization || ''
    if (auth.startsWith('Bearer ')) {
      const { data } = await db.auth.getUser(auth.slice(7))
      userId = data?.user?.id || null
    }
    try {
      const r = await siteSubmit(db, { plan, userId, email, phone: phone.startsWith('+') ? phone : '+' + phone, name, birth, file: { mime, buf } })
      return res.status(200).json(r)
    } catch (e) {
      if (e instanceof PayError) return res.status(e.status).json({ error: e.message })
      reportError('api:pay-transfer', ['заказ с сайта не принят:', e], { message: e?.message, status: 500 })
      return res.status(500).json({ error: 'Не удалось отправить, попробуй ещё раз' })
    }
  }

  return res.status(404).json({ error: 'Not Found' })
}
