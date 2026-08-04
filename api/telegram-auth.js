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
  const email = `tg${tgUser.id}@telegram.fitpro`

  const { error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      telegram_id: tgUser.id,
      name: tgUser.first_name,
      telegram_username: tgUser.username,
      photo_url: tgUser.photo_url,
    },
  })
  // "Уже существует" — не ошибка, пользователь просто уже заходил раньше.
  const alreadyExists = createError && (createError.code === 'email_exists' || /already.*(registered|exists)/i.test(createError.message || ''))
  if (createError && !alreadyExists) {
    console.error('Ошибка создания пользователя по Telegram:', createError)
    return res.status(500).json({ error: 'Не удалось создать пользователя' })
  }

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkError || !linkData?.properties?.email_otp) {
    console.error('Ошибка выдачи одноразового кода:', linkError)
    return res.status(500).json({ error: 'Не удалось выдать сессию' })
  }

  // Гарантируем строку профиля — у Telegram-аккаунтов её раньше не заводилось
  // автоматически (в отличие от email-регистрации, где это делает триггер
  // on_auth_user_created). ignoreDuplicates: у СУЩЕСТВУЮЩЕГО пользователя
  // (например с уже выставленной role='trainer') строку не трогаем вообще —
  // только insert для новых, ON CONFLICT (id) DO NOTHING.
  const telegramUserId = linkData?.user?.id
  if (telegramUserId) {
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: telegramUserId, name: tgUser.first_name, tg_username: tgUser.username }, { onConflict: 'id', ignoreDuplicates: true })
    if (profileError) console.error('Ошибка создания строки профиля для Telegram-пользователя:', profileError)

    // Upsert выше для существующей строки — DO NOTHING, поэтому ник при
    // повторных входах освежаем отдельным узким апдейтом (только это поле,
    // чтобы не задеть name/role). Пустой username не пишем: у большинства
    // пользователей он не задан, и затирать им уже сохранённое значение
    // нельзя. Ошибку только логируем — авторизация из-за ника не падает.
    if (tgUser.username) {
      const { error: usernameError } = await supabaseAdmin
        .from('profiles')
        .update({ tg_username: tgUser.username })
        .eq('id', telegramUserId)
      if (usernameError) console.error('Ошибка обновления tg_username:', usernameError)
    }
  }

  res.status(200).json({ email, otp: linkData.properties.email_otp })
}
