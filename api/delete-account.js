import { createClient } from '@supabase/supabase-js'
import { USER_TABLES, TWO_SIDED_TABLES, PROFILE_TABLE, twoSidedFilter } from './_userTables.js'

// URL несекретен, тот же безопасный fallback, что и в api/chat.js и
// api/telegram-auth.js. SUPABASE_SERVICE_ROLE_KEY (полный доступ, обходит RLS)
// секретен, фолбэка для него нет намеренно — клиент создаём только внутри
// handler, после явной проверки, что ключ вообще настроен.
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

  // Кого удалять — берём ИСКЛЮЧИТЕЛЬНО из подписанного токена. Любой id из
  // тела запроса игнорируется: иначе эндпоинт со service_role-ключом стал бы
  // кнопкой «удалить произвольного пользователя» для кого угодно.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !authData?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = authData.user.id

  // Каждый шаг проверяем отдельно и прерываемся на первой же ошибке. Идти
  // дальше вслепую нельзя: deleteUser() всё равно упадёт на внешнем ключе, а
  // пользователь получил бы «аккаунт удалён» при живом аккаунте и частично
  // стёртых данных.
  for (const { table, column } of USER_TABLES) {
    const { error } = await supabaseAdmin.from(table).delete().eq(column, userId)
    if (error) {
      console.error(`Удаление аккаунта ${userId}: ошибка очистки ${table}.${column}:`, error)
      return res.status(500).json({ error: `Не удалось удалить данные (${table})` })
    }
  }

  // Таблицы, где пользователь может стоять с двух сторон (и как клиент, и как
  // тренер): обе стороны ссылаются на auth.users, обе должны уйти.
  for (const { table, columns } of TWO_SIDED_TABLES) {
    const { error } = await supabaseAdmin.from(table).delete().or(twoSidedFilter(columns, userId))
    if (error) {
      console.error(`Удаление аккаунта ${userId}: ошибка очистки ${table}:`, error)
      return res.status(500).json({ error: `Не удалось удалить данные (${table})` })
    }
  }

  // Чужие профили, у которых удаляемый был тренером: обнуляем coach_id, иначе
  // внешний ключ profiles.coach_id → auth.users не даст удалить аккаунт, а у
  // клиентов осталась бы ссылка в никуда.
  const { error: coachError } = await supabaseAdmin
    .from(PROFILE_TABLE.table)
    .update({ coach_id: null })
    .eq('coach_id', userId)
  if (coachError) {
    console.error(`Удаление аккаунта ${userId}: ошибка обнуления coach_id у клиентов:`, coachError)
    return res.status(500).json({ error: 'Не удалось отвязать клиентов' })
  }

  // profiles — последней среди public: на неё уже ничто не ссылается.
  const { error: profileError } = await supabaseAdmin
    .from(PROFILE_TABLE.table)
    .delete()
    .eq(PROFILE_TABLE.column, userId)
  if (profileError) {
    console.error(`Удаление аккаунта ${userId}: ошибка удаления профиля:`, profileError)
    return res.status(500).json({ error: 'Не удалось удалить профиль' })
  }

  // Сам аккаунт: auth.users + identities + сессии.
  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (deleteUserError) {
    console.error(`Удаление аккаунта ${userId}: ошибка удаления auth-пользователя:`, deleteUserError)
    return res.status(500).json({ error: 'Данные удалены, но не удалось удалить сам аккаунт' })
  }

  res.status(200).json({ ok: true })
}
