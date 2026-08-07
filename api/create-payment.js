import qs from 'qs'
import { createClient } from '@supabase/supabase-js'
import { createSignature, buildPaymentData } from './_prodamus.js'
import { rateLimit } from './_ratelimit.js'

// Статические ссылки Продамуса не могут нести наш идентификатор пользователя
// (Продамус подменяет order_id своим номером). Поэтому ссылку строим здесь:
// подписываем данными с userId в order_id и customer_extra тем же ключом и тем
// же алгоритмом, что уже принят на входящих уведомлениях (api/_prodamus.js).
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Домен платёжной формы. Тот же, что в уведомлениях (raw.domain).
const PAYFORM_BASE = 'https://maximathlete.payform.ru/'

// Адрес возврата после оплаты больше не константа — он зависит от того, откуда
// человек платит (см. returnUrlFor/buildPaymentData в _prodamus.js).

// БАЗА снята с продажи — ручка отказывает на прямой запрос plan:'base', иначе
// пакет остаётся покупаемым в обход спрятанной пилюли на экране Тарифов.
const PAID_PLANS = new Set(['profit', 'premium'])

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'create-payment', limit: 10 })) return

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const secret = process.env.PRODAMUS_SECRET_KEY
  if (!serviceRoleKey || !secret) {
    console.error('create-payment: не настроены SUPABASE_SERVICE_ROLE_KEY или PRODAMUS_SECRET_KEY')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }

  // Личность — исключительно из подписанного токена, не из тела: иначе можно
  // было бы выписать ссылку с чужим userId в customer_extra.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)
  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !authData?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = authData.user.id

  const plan = req.body?.plan
  if (!PAID_PLANS.has(plan)) return res.status(400).json({ error: 'Неизвестный пакет' })

  // Откуда платят — только метка, не адрес: 'web' даёт возврат в приложение,
  // всё остальное (в том числе отсутствие поля) — прежнее поведение, ссылку на
  // бота. Разбор и защита — в returnUrlFor, там же объяснено, почему URL из
  // тела принимать нельзя.
  const source = req.body?.source

  // Цену и адрес возврата подставляет buildPaymentData — на сервере, не из
  // тела: сумму доверять клиенту нельзя (по ней вебхук определяет пакет), а
  // адрес возврата тем более.
  const data = buildPaymentData({ userId, plan, source })

  // Подпись считается по данным, в которых адрес возврата УЖЕ подставлен —
  // иначе Продамус отклонит ссылку как неподписанную по этим полям.
  const signature = createSignature(data, secret)
  const url = PAYFORM_BASE + '?' + qs.stringify({ ...data, signature })

  return res.status(200).json({ url })
}
