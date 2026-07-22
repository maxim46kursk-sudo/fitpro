import { createClient } from '@supabase/supabase-js'
import { USER_TABLES, TWO_SIDED_TABLES, PROFILE_TABLE, twoSidedFilter } from './_userTables.js'

// URL несекретен, тот же безопасный fallback, что и в остальных функциях api/.
// SUPABASE_SERVICE_ROLE_KEY секретен, фолбэка для него нет намеренно — клиент
// создаём только внутри handler, после явной проверки, что ключ настроен.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

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

  res.status(200).json(result)
}
