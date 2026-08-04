import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { rateLimit } from './_ratelimit.js'

// Привязка клиента к тренеру по ссылке-приглашению: проставляет
// profiles.coach_id текущему пользователю. Кто привязывается — берём
// ИСКЛЮЧИТЕЛЬНО из подписанного токена, а не из тела запроса: иначе любой
// желающий назначал бы тренера чужому аккаунту.
//
// Здесь же живут ТРЕНЕРСКИЕ действия по клиентам без регистрации (action):
// 'create_client'   — тренер заводит клиента сам и получает ссылку доступа;
// 'reissue_access'  — тренер выпускает своему клиенту новую ссылку.
// Отдельных эндпоинтов под них нет намеренно: у Vercel Hobby лимит 12
// serverless-функций и он выбран целиком, поэтому разделяем по полю action —
// тот же приём, что в api/set-exercise.js.
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

// Сколько живёт ссылка доступа клиента. Неделя — компромисс: тренер успевает
// передать ссылку, а забытая в переписке ссылка не остаётся ключом навсегда.
// Просроченную ссылку тренер перевыпускает действием 'reissue_access'.
const ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Выпуск ссылки доступа. В базу кладём ТОЛЬКО sha256-хэш: открытое значение
// возвращается вызывающему ровно один раз и больше нигде не хранится и не
// логируется (утечка дампа таблицы не даёт войти ни за кого). 32 случайных
// байта — угадать нельзя, поэтому и поиск по хэшу обычным сравнением по
// индексу безопасен, подбирать нечего.
async function issueAccessToken(supabaseAdmin, userId, trainerId) {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const { error } = await supabaseAdmin.from('client_access_tokens').insert({
    user_id: userId,
    trainer_id: trainerId,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
  })
  if (error) return { error }
  return { token }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'link-client', limit: 10 })) return

  // Кого привязываем — только из подписанного токена (см. шапку файла).
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = data.user.id

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

  const action = req.body?.action

  // ── Клиенты без регистрации. Обе ветки доступны ТОЛЬКО тренеру, поэтому
  //    роль читаем из базы service_role-ключом (в теле запроса её подделать
  //    можно, в базе — нет), ровно как в api/set-exercise.js. ──
  if (action === 'create_client' || action === 'reissue_access') {
    const { data: caller, error: callerErr } = await supabaseAdmin
      .from('profiles').select('role').eq('id', userId).maybeSingle()
    if (callerErr) {
      console.error(`link-client: ошибка чтения профиля ${userId}:`, callerErr)
      return res.status(500).json({ error: 'Не удалось проверить доступ' })
    }
    if (caller?.role !== 'trainer') return res.status(403).json({ error: 'Доступно только тренеру' })

    // Перевыпуск ссылки СВОЕМУ клиенту. Чужого клиента тронуть нельзя: иначе
    // любой тренер выписывал бы себе доступ в чужой аккаунт.
    if (action === 'reissue_access') {
      const clientId = req.body?.clientId != null ? String(req.body.clientId) : ''
      if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Клиент не найден' })

      const { data: client, error: clientErr } = await supabaseAdmin
        .from('profiles').select('coach_id').eq('id', clientId).maybeSingle()
      if (clientErr) {
        console.error(`link-client: ошибка чтения клиента ${clientId}:`, clientErr)
        return res.status(500).json({ error: 'Не удалось проверить клиента' })
      }
      if (!client || client.coach_id !== userId) {
        console.log(`link-client: тренер ${userId} запросил перевыпуск чужому клиенту ${clientId} — отказано`)
        return res.status(403).json({ error: 'Это не ваш клиент' })
      }

      // Старые ссылки гасим ДО выпуска новой (иначе погасили бы и её):
      // перевыпуск обязан обесценить всё, что было роздано раньше.
      const { error: expireErr } = await supabaseAdmin
        .from('client_access_tokens')
        .update({ expires_at: new Date().toISOString() })
        .eq('user_id', clientId)
      if (expireErr) {
        console.error(`link-client: ошибка гашения старых ссылок клиента ${clientId}:`, expireErr)
        return res.status(500).json({ error: 'Не удалось перевыпустить ссылку' })
      }

      const { token, error: issueErr } = await issueAccessToken(supabaseAdmin, clientId, userId)
      if (issueErr) {
        console.error(`link-client: ошибка выпуска ссылки клиенту ${clientId}:`, issueErr)
        return res.status(500).json({ error: 'Не удалось перевыпустить ссылку' })
      }
      console.log(`link-client: тренер ${userId} перевыпустил ссылку клиенту ${clientId}`)
      return res.status(200).json({ ok: true, user_id: clientId, token })
    }

    // create_client: тренер заводит клиента сам, клиент ничего не регистрирует.
    const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 100) : ''
    if (!name) return res.status(400).json({ error: 'Не указано имя клиента' })

    // Цель — необязательное поле формы (список на клиенте: «Похудение», «Набор
    // массы» и т.д.). Список НЕ проверяем: profiles.goal — свободный текст,
    // который сам клиент потом правит у себя в профиле. Пустое после trim → null,
    // чтобы в базе не заводить строку-пустышку.
    const goal = req.body?.goal != null ? (String(req.body.goal).trim().slice(0, 50) || null) : null

    // Почта техническая и не используется для писем — вход только по ссылке.
    // Случайная локальная часть, чтобы адрес нельзя было угадать по имени.
    // email_confirm: true — тот же приём, что в api/telegram-auth.js: без
    // подтверждения GoTrue не выдаст сессию.
    const email = `c${crypto.randomBytes(12).toString('hex')}@clients.fitproapp.ru`
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { name },
    })
    const newUserId = created?.user?.id
    if (createErr || !newUserId) {
      console.error(`link-client: ошибка создания клиента тренером ${userId}:`, createErr)
      return res.status(500).json({ error: 'Не удалось создать клиента' })
    }

    // Откат: до выдачи ссылки клиент бесполезен, а мусорный аккаунт остаётся
    // навсегда. profiles удаляем первым — внешний ключ profiles.id → auth.users
    // объявлен без ON DELETE, как и в api/delete-account.js.
    const rollback = async () => {
      await supabaseAdmin.from('profiles').delete().eq('id', newUserId)
      const { error } = await supabaseAdmin.auth.admin.deleteUser(newUserId)
      if (error) console.error(`link-client: не удалось откатить создание клиента ${newUserId}:`, error)
    }

    // Строку profiles уже завёл триггер on_auth_user_created (id, name, email),
    // поэтому не insert, а upsert: дописываем coach_id и цель. Роль не задаём —
    // в базе умолчание 'client'.
    //
    // .select() возвращает строку ПОСЛЕ триггеров: guard_profile_privileged
    // умеет срезать coach_id молча, без ошибки, — поэтому проверяем фактом
    // (тот же приём, что при обычной привязке ниже).
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: newUserId, name, goal, coach_id: userId }, { onConflict: 'id' })
      .select('coach_id')
      .maybeSingle()
    if (profileErr || profile?.coach_id !== userId) {
      console.error(`link-client: coach_id для нового клиента ${newUserId} НЕ записан (в базе ${profile?.coach_id ?? 'null'}) — проверь guard_profile_privileged:`, profileErr)
      await rollback()
      return res.status(500).json({ error: 'Не удалось создать клиента' })
    }

    const { token, error: issueErr } = await issueAccessToken(supabaseAdmin, newUserId, userId)
    if (issueErr) {
      console.error(`link-client: ошибка выпуска ссылки новому клиенту ${newUserId}:`, issueErr)
      await rollback()
      return res.status(500).json({ error: 'Не удалось создать клиента' })
    }

    // Сам токен в лог НЕ пишем — он равносилен паролю клиента.
    console.log(`link-client: тренер ${userId} завёл клиента ${newUserId}`)
    return res.status(201).json({ ok: true, user_id: newUserId, token })
  }

  const trainerId = req.body?.trainerId != null ? String(req.body.trainerId) : ''
  if (!UUID_RE.test(trainerId)) return res.status(400).json({ error: 'Приглашение недействительно' })

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
