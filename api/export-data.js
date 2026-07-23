import { createClient } from '@supabase/supabase-js'
import { USER_TABLES, TWO_SIDED_TABLES, PROFILE_TABLE, twoSidedFilter } from './_userTables.js'

// URL несекретен, тот же безопасный fallback, что и в остальных функциях api/.
// SUPABASE_SERVICE_ROLE_KEY секретен, фолбэка для него нет намеренно — клиент
// создаём только внутри handler, после явной проверки, что ключ настроен.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Telegram-аккаунты заводятся с техническим email вида tg<ID>@telegram.fitpro
// (см. api/telegram-auth.js) — это запасной источник chat_id, если в метаданных
// пользователя telegram_id почему-то не оказалось (например, у аккаунтов,
// созданных до того, как метаданные начали заполняться).
const TG_EMAIL_RE = /^tg(\d+)@telegram\.fitpro$/i

// chat_id берём ТОЛЬКО из проверенного токеном пользователя, никогда из тела
// запроса: иначе кто угодно смог бы заказать отправку чужой выгрузки себе.
function telegramChatId(user) {
  const fromMeta = user?.user_metadata?.telegram_id
  if (fromMeta) return String(fromMeta)
  const m = TG_EMAIL_RE.exec(user?.email || '')
  return m ? m[1] : null
}

// Дата в имени файла — по местному времени сервера, формат ГГГГ-ММ-ДД.
function todayStamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }

  // Чьи данные отдавать — ИСКЛЮЧИТЕЛЬНО из подписанного токена. Любой id из
  // тела запроса игнорируется: иначе эндпоинт со service_role-ключом стал бы
  // способом выгрузить чужой профиль целиком.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !authData?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = authData.user.id

  const result = {
    exported_at: new Date().toISOString(),
    user_id: userId,
  }

  // Профиль — одним объектом, а не массивом. maybeSingle(): у пользователя
  // может не быть строки profiles (например, если её успели удалить) — это не
  // ошибка выгрузки, просто profile === null.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from(PROFILE_TABLE.table)
    .select('*')
    .eq(PROFILE_TABLE.column, userId)
    .maybeSingle()
  if (profileError) {
    console.error(`Выгрузка данных ${userId}: ошибка чтения профиля:`, profileError)
    return res.status(500).json({ error: 'Не удалось выгрузить профиль' })
  }
  result.profile = profile ?? null

  // Пустая выборка — законный результат (пользователь просто не вёл дневник),
  // поэтому пустой массив, а не пропуск ключа: в файле должно быть видно, что
  // таблицу проверили и данных в ней нет.
  for (const { table, column } of USER_TABLES) {
    const { data, error } = await supabaseAdmin.from(table).select('*').eq(column, userId)
    if (error) {
      console.error(`Выгрузка данных ${userId}: ошибка чтения ${table}.${column}:`, error)
      return res.status(500).json({ error: `Не удалось выгрузить данные (${table})` })
    }
    result[table] = data ?? []
  }

  for (const { table, columns } of TWO_SIDED_TABLES) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('*')
      .or(twoSidedFilter(columns, userId))
    if (error) {
      console.error(`Выгрузка данных ${userId}: ошибка чтения ${table}:`, error)
      return res.status(500).json({ error: `Не удалось выгрузить данные (${table})` })
    }
    result[table] = data ?? []
  }

  // Обычный браузер — отдаём JSON, файл соберёт и скачает фронт.
  if (req.body?.channel !== 'telegram') return res.status(200).json(result)

  // Telegram Mini App: скачивание Blob через <a download> в webview (особенно
  // на iOS) не срабатывает — вместо загрузки файла webview показывает его
  // содержимое прямо на экране, а инлайн-показ ломает кириллицу. Поэтому в
  // Telegram доставляем файл документом в чат с ботом.
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN не настроен — выгрузка в Telegram невозможна')
    return res.status(500).json({ error: 'Сервер не настроен для отправки в Telegram' })
  }

  const chatId = telegramChatId(authData.user)
  if (!chatId) {
    console.error(`Выгрузка данных ${userId}: не удалось определить telegram_id`)
    return res.status(500).json({ error: 'Не удалось определить твой Telegram — скачай файл из браузера' })
  }

  // Buffer.from(..., 'utf-8') + явный charset: именно это даёт корректную
  // кириллицу в файле. Без явной кодировки Telegram отдаёт документ, который
  // клиент открывает как cp1251, и «Максим» превращается в «РњР°РєСЃРёРј».
  const json = JSON.stringify(result, null, 2)
  const fileName = `fitpro-данные-${todayStamp()}.json`

  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('caption', 'Выгрузка твоих данных из FitPro')
  form.append(
    'document',
    new Blob([Buffer.from(json, 'utf-8')], { type: 'application/json;charset=utf-8' }),
    fileName,
  )

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form,
    })
    const tgBody = await tgRes.json().catch(() => ({}))
    if (!tgRes.ok || !tgBody?.ok) {
      console.error(`Выгрузка данных ${userId}: Telegram отклонил sendDocument:`, tgBody)
      return res.status(500).json({ error: 'Не удалось отправить файл в Telegram' })
    }
  } catch (e) {
    console.error(`Выгрузка данных ${userId}: сбой запроса к Telegram:`, e)
    return res.status(500).json({ error: 'Не удалось отправить файл в Telegram' })
  }

  res.status(200).json({ ok: true, delivered: 'telegram' })
}
