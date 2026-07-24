import qs from 'qs'
import { createClient } from '@supabase/supabase-js'
import { verifySignature } from './_prodamus.js'

// Вебхук уведомлений Продамуса. Тело подписано, поэтому НЕ даём Vercel его
// разобрать — подпись считается по точной сырой форме, любой репарсинг
// (порядок ключей, типы) её ломает. Читаем поток сами и разбираем через qs,
// т.к. Продамус шлёт вложенные ключи products[0][name] — качественно их
// разворачивает именно qs, повторяя структуру, которую подписывал их PHP.
export const config = { api: { bodyParser: false } }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Сумма платежа → пакет. Определяем пакет ПО СУММЕ, а не по order_id: order_id
// приходит из ссылки и пользователь теоретически может его подменить, а сумму
// подтверждает подписанное уведомление. Карта покрывает и тестовые, и боевые
// цены (см. src/plans.js). Ключи — числа рублей.
const AMOUNT_TO_PLAN = {
  50: 'base',   60: 'profit',   70: 'premium',      // тестовые
  1000: 'base', 2990: 'profit', 9990: 'premium',    // боевые
}

const PLAN_DAYS = 30
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Подпись — общая с исходящей ссылкой (api/_prodamus.js): один алгоритм,
// уже принятый Продамусом на входящих уведомлениях.

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// id тренера, к которому привязываем покупателей ПРЕМИУМ. Приоритет у
// TRAINER_USER_ID: переменная однозначна и переживёт появление второго тренера
// в базе, тогда как поиск по роли в этом случае вернёт произвольного. Если
// тренера определить не удалось — возвращаем null, привязку просто пропускаем
// (начисление пакета от этого не зависит и падать не должно).
async function resolveTrainerId(supabaseAdmin) {
  const fromEnv = (process.env.TRAINER_USER_ID || '').trim()
  if (fromEnv) {
    if (UUID_RE.test(fromEnv)) return fromEnv
    console.warn('Prodamus webhook: TRAINER_USER_ID задан, но это не UUID — игнорируем')
  }
  const { data, error } = await supabaseAdmin
    .from('profiles').select('id').eq('role', 'trainer').limit(1).maybeSingle()
  if (error) {
    console.error('Prodamus webhook: ошибка поиска тренера:', error)
    return null
  }
  return data?.id || null
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')

  const secret = process.env.PRODAMUS_SECRET_KEY
  if (!secret) {
    console.error('PRODAMUS_SECRET_KEY не настроен — уведомление принять нельзя')
    return res.status(500).send('Server not configured')
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен')
    return res.status(500).send('Server not configured')
  }

  let raw
  try {
    raw = await readRawBody(req)
  } catch (e) {
    console.error('Prodamus webhook: не удалось прочитать тело:', e)
    return res.status(400).send('Bad request')
  }

  const data = qs.parse(raw)
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // ── Проверка подписи. Подпись — из заголовка sign, запасной вариант — поле
  // signature в теле. В лог — только факт отказа: ни секрет, ни ожидаемая
  // подпись, ни подписываемая строка наружу попадать не должны.
  const provided = (req.headers['sign'] || data.signature || '').toString()
  if (!verifySignature(data, secret, provided)) {
    console.error('Prodamus webhook: подпись не сошлась', { order_num: data.order_num ?? null })
    return res.status(400).send('Bad signature')
  }

  // Подпись верна — логируем только служебные поля, без персональных данных.
  console.log('Prodamus webhook: подтверждённое уведомление', {
    order_num: data.order_num ?? null,
    sum: data.sum ?? null,
    payment_status: data.payment_status ?? null,
  })

  const orderId = data.order_id != null ? String(data.order_id) : null
  const orderNum = data.order_num != null ? String(data.order_num) : null
  const paymentStatus = data.payment_status != null ? String(data.payment_status) : ''
  const sumNum = Number(data.sum)

  // userId — часть до последнего '__'. Берём из customer_extra: наш order_id
  // Продамус подменяет своим номером, а customer_extra возвращает эхом. Если
  // customer_extra пуст — запасной разбор order_id (на случай старых ссылок).
  // Пакет отсюда НЕ берём — только userId; пакет определяется суммой ниже.
  // Пишем в user_id только валидный uuid, иначе NULL (мусор не должен ронять
  // запись в журнал).
  const extractUserId = src => {
    if (!src) return null
    const cut = src.lastIndexOf('__')
    const candidate = cut > 0 ? src.slice(0, cut) : src
    return UUID_RE.test(candidate) ? candidate : null
  }
  const customerExtra = data.customer_extra != null ? String(data.customer_extra) : null
  const userId = extractUserId(customerExtra) || extractUserId(orderId)

  // Пакет по сумме. undefined → сумма незнакомая.
  const planFromAmount = Number.isFinite(sumNum) ? AMOUNT_TO_PLAN[sumNum] : undefined

  // Решаем статус для журнала и надо ли начислять. Начисляем только при
  // успешной оплате, известной сумме и реально существующем пользователе.
  let status
  let accruePlan = null
  if (paymentStatus !== 'success') {
    status = paymentStatus || 'unknown'
  } else if (!planFromAmount) {
    status = 'unknown_amount'
  } else if (!userId) {
    status = 'user_not_found'
  } else {
    // Пользователь существует?
    const { data: prof, error: profErr } = await supabaseAdmin
      .from('profiles').select('id, plan_until, coach_id').eq('id', userId).maybeSingle()
    if (profErr) {
      console.error(`Prodamus webhook: ошибка проверки пользователя ${userId}:`, profErr)
      // Отдаём 200, но НЕ начисляем и в журнал пишем как ошибку — Продамус
      // не должен зациклить ретраи из-за нашего сбоя чтения.
      status = 'user_check_failed'
    } else if (!prof) {
      status = 'user_not_found'
    } else {
      status = 'success'
      accruePlan = { plan: planFromAmount, currentUntil: prof.plan_until, coachId: prof.coach_id }
    }
  }

  // ── Идемпотентность + журнал. Одна вставка: она же защищает от повторов по
  // UNIQUE(provider_order_num). Повтор того же order_num → уведомление уже
  // обработано, второй раз НЕ начисляем.
  const { error: insErr } = await supabaseAdmin.from('payments').insert({
    provider_order_num: orderNum,
    order_id: orderId,
    user_id: userId,
    plan: accruePlan ? accruePlan.plan : (planFromAmount || null),
    amount: Number.isFinite(sumNum) ? sumNum : null,
    status,
    raw: data,
  })
  if (insErr) {
    if (insErr.code === '23505') {
      console.log(`Prodamus webhook: повторное уведомление order_num=${orderNum}, пропускаем`)
      return res.status(200).send('OK')
    }
    console.error('Prodamus webhook: ошибка записи в журнал платежей:', insErr)
    return res.status(500).send('Journal error')
  }

  // Не начисляем — но платёж уже в журнале, отвечаем 200.
  if (!accruePlan) {
    console.log(`Prodamus webhook: платёж записан со статусом '${status}', пакет не начислен`)
    return res.status(200).send('OK')
  }

  // ── Начисление: продлеваем от максимума (сейчас, текущий plan_until) на 30
  // дней, чтобы оплата во время активной подписки прибавляла срок, а не
  // затирала его. plan/plan_until пишет service_role — триггер это разрешает.
  const now = Date.now()
  const currentUntilMs = accruePlan.currentUntil ? new Date(accruePlan.currentUntil).getTime() : 0
  const baseMs = Math.max(now, Number.isFinite(currentUntilMs) ? currentUntilMs : 0)
  const newUntil = new Date(baseMs + PLAN_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const updateFields = { plan: accruePlan.plan, plan_until: newUntil }

  // ── Привязка к тренеру: покупка ПРЕМИУМ делает человека клиентом тренера.
  // Только при пустом coach_id — уже привязанного клиента не перетаскиваем к
  // другому тренеру. coach_id здесь НИКОГДА не очищается: истечение подписки
  // не отвязывает клиента, это осознанно. Не нашли тренера — начисляем пакет
  // как обычно, просто без привязки.
  if (accruePlan.plan === 'premium' && !accruePlan.coachId) {
    const trainerId = await resolveTrainerId(supabaseAdmin)
    if (!trainerId) {
      console.warn(`Prodamus webhook: тренер не найден, ПРЕМИУМ ${userId} начислен без привязки`)
    } else if (trainerId === userId) {
      // Тренер купил ПРЕМИУМ сам себе. У тренера coach_id пустой (см. App.jsx,
      // hasCoach) — ссылку на самого себя не ставим.
      console.log(`Prodamus webhook: ${userId} — сам тренер, привязка не нужна`)
    } else {
      updateFields.coach_id = trainerId
    }
  }

  // .select() возвращает строку ПОСЛЕ триггеров: если guard_profile_privileged
  // откатит coach_id, мы это увидим и не соврём в логе о привязке.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('profiles')
    .update(updateFields)
    .eq('id', userId)
    .select('coach_id')
    .maybeSingle()
  if (updErr) {
    // Платёж уже в журнале со статусом success — начисление можно будет
    // доиграть вручную по журналу. 200, чтобы Продамус не слал повторы.
    console.error(`Prodamus webhook: платёж ${orderNum} записан, но НЕ удалось начислить пакет пользователю ${userId}:`, updErr)
    return res.status(200).send('OK')
  }

  if (updateFields.coach_id) {
    if (updated?.coach_id === updateFields.coach_id) {
      console.log(`Prodamus webhook: ${userId} привязан к тренеру ${updateFields.coach_id}`)
    } else {
      // Пакет начислен, но привязка не легла — почти наверняка её срезал
      // триггер. Громко, чтобы не искать потом «почему клиент не появился».
      console.error(`Prodamus webhook: coach_id для ${userId} НЕ записан (в базе ${updated?.coach_id ?? 'null'}) — проверь guard_profile_privileged`)
    }
  }

  console.log(`Prodamus webhook: пользователю ${userId} начислен ${accruePlan.plan} до ${newUntil}`)
  return res.status(200).send('OK')
}
