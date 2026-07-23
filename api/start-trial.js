import { createClient } from '@supabase/supabase-js'

// Должно совпадать с TRIAL_DAYS в src/plans.js. Держим локальной константой, а
// не импортом из src/: выход за пределы api/ рискует не разрешиться при сборке
// функции на Vercel, а сломанный деплой дороже дублирования одного числа.
const TRIAL_DAYS = 5

// URL несекретен, тот же безопасный fallback, что и в остальных функциях api/.
// SUPABASE_SERVICE_ROLE_KEY секретен, фолбэка нет намеренно — клиент создаём
// только внутри handler, после явной проверки, что ключ настроен.
//
// Пробный выдаётся ТОЛЬКО отсюда: триггер guard_profile_privileged в базе
// откатывает правки trial_until/trial_used для роли authenticated, так что
// клиент не может активировать пробный сам, минуя эту функцию.
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

  // Кому выдавать пробный — исключительно из подписанного токена. Любой id из
  // тела запроса игнорируется, иначе эндпоинт со service_role-ключом стал бы
  // способом выдать пробный (или сжечь его) любому пользователю.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !authData?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = authData.user.id

  const { data: profile, error: readError } = await supabaseAdmin
    .from('profiles')
    .select('trial_used')
    .eq('id', userId)
    .maybeSingle()
  if (readError) {
    console.error(`Пробный период ${userId}: ошибка чтения профиля:`, readError)
    return res.status(500).json({ error: 'Не удалось проверить статус пробного периода' })
  }
  if (!profile) {
    console.error(`Пробный период ${userId}: профиль не найден`)
    return res.status(500).json({ error: 'Профиль не найден' })
  }
  if (profile.trial_used) return res.status(200).json({ ok: false, reason: 'used' })

  const trialUntil = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // .select() обязателен: update по несуществующей строке вернул бы success с
  // нулём затронутых строк, и клиент показал бы «пробный активирован», хотя в
  // базе ничего не изменилось. Заодно убеждаемся, что триггер не откатил запись
  // (для service_role он этого делать не должен).
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ trial_until: trialUntil, trial_used: true })
    .eq('id', userId)
    .select('trial_until, trial_used')
  if (updateError) {
    console.error(`Пробный период ${userId}: ошибка записи:`, updateError)
    return res.status(500).json({ error: 'Не удалось активировать пробный период' })
  }
  if (!updated?.length) {
    console.error(`Пробный период ${userId}: обновление не затронуло ни одной строки`)
    return res.status(500).json({ error: 'Не удалось активировать пробный период' })
  }

  res.status(200).json({ ok: true, trial_until: updated[0].trial_until })
}
