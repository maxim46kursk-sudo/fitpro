import qs from 'qs'
import { createClient } from '@supabase/supabase-js'
import { createSignature, buildPaymentData, STAFF_PLANS, CHALLENGE_ITEM } from './_prodamus.js'
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
//
// test50 — служебный тариф проверки оплаты. В списке покупаемых он есть, но
// ниже стоит проверка роли: спрятанная пилюля на экране Тарифов от прямого
// POST не защищает, а 50 ₽ за сутки ПРОФИТ — слишком дешёвый способ обойти
// прайс. Отсюда правило: скрытие в интерфейсе — удобство, отказ здесь — защита.
const PAID_PLANS = new Set(['profit', 'premium', 'test50'])

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
  // Билет челленджа — не тариф: уровня доступа он не даёт и в PAID_PLANS его
  // нет. Покупает кто угодно из вошедших, роль не проверяется.
  const isChallenge = plan === CHALLENGE_ITEM
  if (!isChallenge && !PAID_PLANS.has(plan)) return res.status(400).json({ error: 'Неизвестный пакет' })

  // Второй билет в тот же поток — это деньги, за которые человек ничего не
  // получит: challenge_enroll идемпотентна по user_id и вернёт ему прежний
  // номер, а оплата останется. Поэтому отказываем ДО выписки ссылки, пока
  // платить ещё не начали.
  //
  // Открытых сезонов нет — ссылку всё равно выписываем: набор объявляется
  // раньше, чем сезон переводят в 'open', и запирать продажу здесь значило бы
  // ронять покупку по состоянию, которое меняется одной правкой в базе.
  // Платёж, которому не нашлось сезона, вебхук запишет в журнал и поднимет
  // тревогу — деньги не потеряются.
  if (isChallenge) {
    const { data: openSeasons, error: seasonErr } = await supabaseAdmin
      .from('challenge_seasons').select('id').eq('status', 'open')
    if (seasonErr) {
      console.error('create-payment: ошибка чтения сезонов челленджа:', seasonErr)
      return res.status(500).json({ error: 'Не удалось проверить участие' })
    }
    const openIds = (openSeasons || []).map(s => s.id)
    if (openIds.length) {
      const { data: mine, error: entryErr } = await supabaseAdmin
        .from('challenge_entries').select('id').eq('user_id', userId).in('season_id', openIds).limit(1)
      if (entryErr) {
        console.error(`create-payment: ошибка проверки участия ${userId}:`, entryErr)
        return res.status(500).json({ error: 'Не удалось проверить участие' })
      }
      if (mine?.length) {
        console.warn(`create-payment: ${userId} уже в открытом потоке, второй билет не выписываем`)
        return res.status(409).json({ error: 'Вы уже участвуете в этом потоке — второй билет покупать не нужно' })
      }
    }
  }

  // Служебный тариф — только тренеру. Роль читаем ИЗ БАЗЫ service_role-ключом,
  // а не из тела и не из метаданных токена: и то и другое клиент подставляет
  // сам. Ответ намеренно тот же, что на несуществующий пакет, — знать о
  // служебном тарифе постороннему незачем.
  if (STAFF_PLANS.has(plan)) {
    const { data: me, error: roleErr } = await supabaseAdmin
      .from('profiles').select('role').eq('id', userId).maybeSingle()
    if (roleErr) {
      console.error(`create-payment: ошибка чтения роли ${userId}:`, roleErr)
      return res.status(500).json({ error: 'Не удалось проверить доступ' })
    }
    if (me?.role !== 'trainer') {
      console.warn(`create-payment: ${userId} просит служебный тариф ${plan}, но он не тренер`)
      return res.status(400).json({ error: 'Неизвестный пакет' })
    }
  }

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
