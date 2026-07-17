import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// URL несекретен, тот же безопасный fallback, что и в api/chat.js.
// SUPABASE_SERVICE_ROLE_KEY (полный доступ, обходит RLS) — секретен,
// фолбэка для него нет намеренно. createClient(url, undefined) падает
// синхронно ("supabaseKey is required") — клиент поэтому не создаём на
// уровне модуля (это уронило бы холодный старт функции целиком), а только
// внутри handler, после явной проверки, что ключ вообще настроен.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://kybazlnscyzfrrafggxe.supabase.co'

// Подписи Telegram initData старше суток не принимаем — даже валидная
// подпись не должна работать бесконечно (initData мог быть перехвачен/
// залогирован где-то по дороге).
const AUTH_DATE_MAX_AGE_SEC = 86400

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
  if (calcHash !== hash) return null

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

  res.status(200).json({ email, otp: linkData.properties.email_otp })
}
