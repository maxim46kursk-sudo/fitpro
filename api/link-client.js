import { createClient } from '@supabase/supabase-js'

// Привязка клиента к тренеру по ссылке-приглашению: проставляет
// profiles.coach_id текущему пользователю. Кто привязывается — берём
// ИСКЛЮЧИТЕЛЬНО из подписанного токена, а не из тела запроса: иначе любой
// желающий назначал бы тренера чужому аккаунту.
//
// Тот же env и те же безопасные fallback-значения (URL и publishable-ключ
// несекретны), что и у остальных функций api/ — без fallback createClient
// падает сразу при холодном старте, если переменная не долетела до функции.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Тот же паттерн, что в api/prodamus-webhook.js: id из тела запроса до
// обращения к базе должен быть заведомо валидным uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Кого привязываем — только из подписанного токена (см. шапку файла).
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = data.user.id

  const trainerId = req.body?.trainerId != null ? String(req.body.trainerId) : ''
  if (!UUID_RE.test(trainerId)) return res.status(400).json({ error: 'Приглашение недействительно' })

  // Профили читаем и пишем service_role-ключом: под RLS клиент не увидит
  // строку тренера, а нам нужен гарантированный ответ по id из ссылки.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Fail closed: без ключа привязку не проверить, а верить телу запроса
    // нельзя. Ошибка громкая — чинится настройкой переменной.
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — привязка к тренеру невозможна')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Клиентом самого себя стать нельзя — иначе тренер, открывший собственную
  // ссылку, получил бы coach_id на себя же и попал в свой список клиентов.
  if (trainerId === userId) {
    return res.status(400).json({ error: 'Нельзя привязаться к самому себе' })
  }

  // Приглашение ведёт на реального тренера? Роль проверяем обязательно: uuid
  // из ссылки может указывать на любой профиль, в том числе на клиента.
  const { data: trainer, error: trainerErr } = await supabaseAdmin
    .from('profiles').select('id, name, role').eq('id', trainerId).maybeSingle()
  if (trainerErr) {
    console.error(`link-client: ошибка чтения тренера ${trainerId}:`, trainerErr)
    return res.status(500).json({ error: 'Не удалось проверить приглашение' })
  }
  if (!trainer || trainer.role !== 'trainer') {
    console.log(`link-client: ${userId} — приглашение на ${trainerId} отклонено (не тренер)`)
    return res.status(400).json({ error: 'Приглашение недействительно' })
  }
  const trainerName = trainer.name || null

  // Профиль самого клиента: его роль и текущая привязка.
  const { data: me, error: meErr } = await supabaseAdmin
    .from('profiles').select('role, coach_id').eq('id', userId).maybeSingle()
  if (meErr) {
    console.error(`link-client: ошибка чтения профиля ${userId}:`, meErr)
    return res.status(500).json({ error: 'Не удалось проверить профиль' })
  }
  if (!me) {
    console.error(`link-client: профиль ${userId} не найден`)
    return res.status(400).json({ error: 'Профиль не найден' })
  }
  if (me.role === 'trainer') {
    return res.status(400).json({ error: 'Тренер не может стать клиентом' })
  }

  // Идемпотентность. Повторный переход по той же ссылке — не ошибка, просто
  // сообщаем, что привязка уже есть. Чужую привязку тоже НЕ переписываем:
  // сменить тренера втихую по ссылке нельзя, это отдельное решение клиента.
  if (me.coach_id) {
    console.log(`link-client: ${userId} уже привязан (coach_id задан), привязка не менялась`)
    return res.status(200).json({ ok: true, already: true, trainer_name: trainerName })
  }

  // .select() возвращает строку ПОСЛЕ триггеров: guard_profile_privileged
  // умеет срезать coach_id молча, без ошибки, — поэтому проверяем фактом.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('profiles')
    .update({ coach_id: trainerId })
    .eq('id', userId)
    .select('coach_id')
    .maybeSingle()
  if (updErr) {
    console.error(`link-client: ошибка привязки ${userId} к ${trainerId}:`, updErr)
    return res.status(500).json({ error: 'Не удалось привязать к тренеру' })
  }
  if (updated?.coach_id !== trainerId) {
    console.error(`link-client: coach_id для ${userId} НЕ записан (в базе ${updated?.coach_id ?? 'null'}) — проверь guard_profile_privileged`)
    return res.status(500).json({ error: 'Не удалось привязать к тренеру' })
  }

  console.log(`link-client: ${userId} привязан к тренеру ${trainerId}`)
  return res.status(200).json({ ok: true, trainer_name: trainerName })
}
