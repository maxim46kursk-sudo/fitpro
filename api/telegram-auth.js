import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { rateLimit } from './_ratelimit.js'

// URL несекретен, тот же безопасный fallback, что и в api/chat.js.
// SUPABASE_SERVICE_ROLE_KEY (полный доступ, обходит RLS) — секретен,
// фолбэка для него нет намеренно. createClient(url, undefined) падает
// синхронно ("supabaseKey is required") — клиент поэтому не создаём на
// уровне модуля (это уронило бы холодный старт функции целиком), а только
// внутри handler, после явной проверки, что ключ вообще настроен.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Подписи Telegram initData старше суток не принимаем — даже валидная
// подпись не должна работать бесконечно (initData мог быть перехвачен/
// залогирован где-то по дороге).
const AUTH_DATE_MAX_AGE_SEC = 3600

// Официальный алгоритм проверки initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
// data_check_string — все пары "ключ=значение" КРОМЕ hash, отсортированные
// по ключу и склеенные через '\n' (значения — уже url-декодированные,
// URLSearchParams это делает сама). secret_key = HMAC_SHA256("WebAppData", bot_token),
// итоговый хэш = HMAC_SHA256(secret_key, data_check_string) в hex, должен
// совпасть с присланным hash. Возвращает распарсенного tg-пользователя или
// null — любая причина (нет hash, подпись не сошлась, auth_date протух,
// user не распарсился) трактуется одинаково: initData не валиден.
function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null
  params.delete('hash')

  const pairs = []
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`)
  pairs.sort()
  const dataCheckString = pairs.join('\n')

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  // Constant-time сравнение. Сначала проверяем непустоту и равную длину hex-строк
  // (timingSafeEqual бросает на разной длине буферов), затем сравниваем байты.
  if (!hash || calcHash.length !== hash.length) return null
  const calcBuf = Buffer.from(calcHash, 'hex')
  const hashBuf = Buffer.from(hash, 'hex')
  if (calcBuf.length !== hashBuf.length || !crypto.timingSafeEqual(calcBuf, hashBuf)) return null

  const authDate = Number(params.get('auth_date'))
  if (!authDate || Date.now() / 1000 - authDate > AUTH_DATE_MAX_AGE_SEC) return null

  const userRaw = params.get('user')
  if (!userRaw) return null
  try {
    return JSON.parse(userRaw)
  } catch {
    return null
  }
}

// Синтетическая почта телеграм-аккаунта. ВАЖНО, ЧЕМ ОНА СТАЛА: раньше это была
// идентичность пользователя, теперь — только техническое значение, нужное
// GoTrue при СОЗДАНИИ аккаунта (создать пользователя без email нельзя) и как
// запасной ключ поиска для аккаунтов, заведённых до появления profiles.tg_id.
// Опознаём пользователя по profiles.tg_id, см. resolveTelegramAccount ниже.
const syntheticEmail = tgId => `tg${tgId}@telegram.fitpro`

// Выдача одноразового кода входа для уже известной почты. Общий кусок обоих
// путей (и по tg_id, и по синтетической почте) — вынесен, чтобы формат ответа
// и обработка ошибки были в одном месте.
async function issueOtp(admin, email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data?.properties?.email_otp) {
    console.error('telegram-auth: ошибка выдачи одноразового кода:', error)
    return null
  }
  return { otp: data.properties.email_otp, userId: data?.user?.id || null }
}

// Ник в profiles освежаем при каждом входе — человек мог его сменить. Пустой
// НЕ пишем: у большинства ника нет, и он затёр бы уже сохранённое значение.
// Ошибку только логируем: авторизация из-за ника падать не должна.
async function refreshUsername(admin, userId, username) {
  if (!username) return
  const { error } = await admin.from('profiles').update({ tg_username: username }).eq('id', userId)
  if (error) console.error('telegram-auth: ошибка обновления tg_username:', error)
}

// ── Опознание телеграм-пользователя ─────────────────────────────────────────
// Экспортируется ради тестов (test-telegram-auth.mjs) — вся развилка входа
// живёт здесь, и проверять её надо именно как функцию, а не через HTTP.
//
// Возвращает { ok:true, email, otp } либо { ok:false, status, error }.
//
// Порядок веток — это и есть суть задачи:
//   1. profiles.tg_id — ОСНОВНОЙ и единственный настоящий ключ. Почта аккаунта
//      при этом может быть какой угодно, в том числе обычной пользовательской:
//      именно поэтому связь и вынесена в отдельную колонку.
//   2. Синтетическая почта — ТОЛЬКО совместимость со старыми аккаунтами
//      (заведёнными до tg_id) и создание новых. Найдя такой аккаунт, сразу
//      проставляем ему tg_id, чтобы в следующий раз он нашёлся по ветке 1.
//      Дубль при этом НЕ создаётся — это главное требование к совместимости.
export async function resolveTelegramAccount(admin, tgUser) {
  const tgId = Number(tgUser.id)
  if (!Number.isSafeInteger(tgId) || tgId <= 0) {
    console.error('telegram-auth: некорректный tgUser.id:', tgUser.id)
    return { ok: false, status: 401, error: 'Не удалось проверить подпись Telegram' }
  }

  // ── Ветка 1: поиск по tg_id ──
  const { data: byTgId, error: lookupErr } = await admin
    .from('profiles').select('id').eq('tg_id', tgId).maybeSingle()
  if (lookupErr) {
    // НЕ проваливаемся в ветку 2. Если поиск сломался, а аккаунт на самом деле
    // есть, ветка 2 завела бы дубль — то есть человек потерял бы свою историю
    // из-за сетевой ошибки. Лучше честно отказать: он повторит вход.
    console.error('telegram-auth: ошибка поиска профиля по tg_id:', lookupErr)
    return { ok: false, status: 500, error: 'Не удалось проверить аккаунт' }
  }

  if (byTgId?.id) {
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(byTgId.id)
    const email = userData?.user?.email
    if (userErr || !email) {
      // Профиль с таким tg_id есть, а auth-пользователя нет — рассинхрон
      // (например, аккаунт удалён, а строка profiles осталась). В ветку 2 не
      // идём: там сработает защита от занятого tg_id и мы получим невнятный
      // отказ. Говорим прямо, что состояние битое.
      console.error(`telegram-auth: профиль ${byTgId.id} с tg_id=${tgId} есть, а auth-пользователя нет:`, userErr)
      return { ok: false, status: 500, error: 'Аккаунт в неисправном состоянии, напишите в поддержку' }
    }
    const issued = await issueOtp(admin, email)
    if (!issued) return { ok: false, status: 500, error: 'Не удалось выдать сессию' }
    await refreshUsername(admin, byTgId.id, tgUser.username)
    console.log(`telegram-auth: вход по tg_id, пользователь ${byTgId.id}`)
    return { ok: true, email, otp: issued.otp }
  }

  // ── Ветка 2: синтетическая почта — старый аккаунт либо новый ──
  const email = syntheticEmail(tgId)

  const { error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      telegram_id: tgId,
      name: tgUser.first_name,
      telegram_username: tgUser.username,
      photo_url: tgUser.photo_url,
    },
  })
  // "Уже существует" — не ошибка, а ровно тот самый legacy-аккаунт: человек
  // заходил до появления tg_id. Ниже мы его найдём и достроим связь.
  const alreadyExists = createError && (createError.code === 'email_exists' || /already.*(registered|exists)/i.test(createError.message || ''))
  const isNewAccount = !createError
  if (createError && !alreadyExists) {
    console.error('telegram-auth: ошибка создания пользователя:', createError)
    return { ok: false, status: 500, error: 'Не удалось создать пользователя' }
  }

  const issued = await issueOtp(admin, email)
  if (!issued) return { ok: false, status: 500, error: 'Не удалось выдать сессию' }
  const userId = issued.userId
  if (!userId) {
    console.error('telegram-auth: generateLink не вернул пользователя — tg_id проставить некому')
    return { ok: false, status: 500, error: 'Не удалось выдать сессию' }
  }

  // Строка профиля: у телеграм-аккаунтов она заводилась не всегда. Для
  // существующего пользователя (например с уже выставленной role='trainer')
  // строку не трогаем — ON CONFLICT (id) DO NOTHING.
  const { error: profileError } = await admin
    .from('profiles')
    .upsert({ id: userId, name: tgUser.first_name, tg_username: tgUser.username }, { onConflict: 'id', ignoreDuplicates: true })
  if (profileError) console.error('telegram-auth: ошибка создания строки профиля:', profileError)

  // ── Фиксация связи. Пишем ТОЛЬКО в пустое поле (.is('tg_id', null)) ──
  // Ни одна ветка ниже не перезаписывает чужой или уже проставленный tg_id.
  const { data: claimed, error: claimErr } = await admin
    .from('profiles').update({ tg_id: tgId }).eq('id', userId).is('tg_id', null).select('id')

  if (claimErr) {
    // 23505 — уникальный индекс profiles_tg_id_key: этот tg_id уже принадлежит
    // ДРУГОМУ профилю. Состояние аномальное (иначе ветка 1 его бы нашла), и
    // молча логинить человека в аккаунт, который ему не принадлежит, нельзя.
    if (claimErr.code === '23505') {
      console.error(`telegram-auth: tg_id=${tgId} уже занят другим профилем, вход по ветке совместимости отклонён`)
      return { ok: false, status: 409, error: 'Этот Telegram уже привязан к другому аккаунту' }
    }
    console.error('telegram-auth: ошибка записи tg_id:', claimErr)
    return { ok: false, status: 500, error: 'Не удалось связать аккаунт с Telegram' }
  }

  if (!claimed?.length) {
    // Обновление никого не задело — значит tg_id у строки уже был. Проверяем,
    // НАШ ли он: чужой означает, что синтетическая почта и tg_id указывают на
    // разные аккаунты, и вход надо остановить, ничего не переписывая.
    const { data: existing, error: readErr } = await admin
      .from('profiles').select('tg_id').eq('id', userId).maybeSingle()
    if (readErr) {
      console.error('telegram-auth: не удалось перечитать tg_id:', readErr)
      return { ok: false, status: 500, error: 'Не удалось связать аккаунт с Telegram' }
    }
    if (existing?.tg_id != null && Number(existing.tg_id) !== tgId) {
      console.error(`telegram-auth: у профиля ${userId} чужой tg_id=${existing.tg_id}, ожидался ${tgId} — вход отклонён`)
      return { ok: false, status: 409, error: 'Этот аккаунт уже привязан к другому Telegram' }
    }
  }

  await refreshUsername(admin, userId, tgUser.username)
  console.log(`telegram-auth: ${isNewAccount ? 'создан новый аккаунт' : 'вход по синтетической почте, связь достроена'}, пользователь ${userId}, tg_id=${tgId}`)
  return { ok: true, email, otp: issued.otp }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'telegram-auth', limit: 20 })) return

  // ── Вход по ссылке доступа (клиент, которого завёл тренер сам — см.
  //    api/link-client.js, action='create_client'). Ветка идёт ПЕРВОЙ и не
  //    зависит от TELEGRAM_BOT_TOKEN: initData здесь не при чём, общее у двух
  //    веток только одно — обе выдают сессию без пароля. Отдельного эндпоинта
  //    нет из-за лимита 12 serverless-функций у Vercel Hobby. ──
  if (req.body?.action === 'redeem_access') {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — вход по ссылке невозможен')
      return res.status(500).json({ error: 'Сервер не настроен' })
    }
    // Один нейтральный текст на все причины отказа: по разнице ответов иначе
    // можно было бы отличить «токен есть, но протух» от «такого токена нет».
    const denied = { error: 'Ссылка недействительна или устарела' }

    const accessToken = req.body?.token != null ? String(req.body.token) : ''
    if (!accessToken) return res.status(401).json(denied)

    const admin = createClient(SUPABASE_URL, serviceKey)
    // В базе лежит только sha256-хэш. Сравнение обычное, по индексу: значения
    // случайные (32 байта), подбирать нечего, а rate-limit выше и так стоит.
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex')
    const { data: row, error: rowErr } = await admin
      .from('client_access_tokens')
      .select('id, user_id, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle()
    if (rowErr) {
      console.error('Ошибка поиска ссылки доступа:', rowErr)
      return res.status(500).json({ error: 'Не удалось проверить ссылку' })
    }
    if (!row) return res.status(401).json(denied)
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      console.log(`redeem_access: ссылка клиента ${row.user_id} просрочена`)
      return res.status(401).json(denied)
    }

    // Почту берём из auth.users по user_id — в теле запроса её нет и быть не
    // должно, иначе ссылка стала бы входом в произвольный аккаунт.
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(row.user_id)
    const clientEmail = userData?.user?.email
    if (userErr || !clientEmail) {
      console.error(`redeem_access: пользователь ${row.user_id} не найден:`, userErr)
      return res.status(401).json(denied)
    }

    // Сессию выдаём тем же способом, что и телеграм-вход ниже: одноразовый код
    // magiclink, клиент меняет его на сессию через verifyOtp.
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: clientEmail })
    if (linkErr || !link?.properties?.email_otp) {
      console.error('redeem_access: ошибка выдачи одноразового кода:', linkErr)
      return res.status(500).json({ error: 'Не удалось выдать сессию' })
    }

    // used_at — ТОЛЬКО отметка о первом использовании, не защёлка: ссылку
    // разрешаем открывать многократно до истечения срока. Мессенджеры открывают
    // ссылки во встроенном браузере, и одноразовая ссылка сгорела бы там же,
    // оставив клиента без доступа. Ошибку отметки только логируем — вход из-за
    // неё падать не должен.
    if (!row.used_at) {
      const { error: usedErr } = await admin
        .from('client_access_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', row.id)
      if (usedErr) console.error('redeem_access: не удалось отметить used_at:', usedErr)
    }

    console.log(`redeem_access: выдан вход клиенту ${row.user_id}`)
    return res.status(200).json({ email: clientEmail, otp: link.properties.email_otp })
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!botToken || !serviceRoleKey) {
    console.error('TELEGRAM_BOT_TOKEN или SUPABASE_SERVICE_ROLE_KEY не настроены')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }

  const { initData } = req.body || {}
  if (!initData) return res.status(401).json({ error: 'Нет initData' })

  const tgUser = verifyTelegramInitData(initData, botToken)
  if (!tgUser?.id) return res.status(401).json({ error: 'Не удалось проверить подпись Telegram' })

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  const result = await resolveTelegramAccount(supabaseAdmin, tgUser)
  if (!result.ok) return res.status(result.status).json({ error: result.error })

  res.status(200).json({ email: result.email, otp: result.otp })
}
