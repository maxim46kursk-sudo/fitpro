import { createClient } from '@supabase/supabase-js'

// Назначение/снятие видео упражнению — ТОЛЬКО для роли trainer. Кто действует,
// берём из подписанного токена; роль проверяем service_role-ключом (клиент под
// RLS свою роль подделать в теле запроса не может). URL при назначении обязаны
// указывать на наши публичные бакеты — защита от подстановки чужих ссылок.
//
// Тот же env и безопасные fallback (URL и publishable-ключ несекретны), что и
// у остальных функций api/.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Разрешённые префиксы: только наши публичные бакеты на этом сервере.
const VIDEO_PREFIX = 'https://api.fitproapp.ru/storage/v1/object/public/exercise-videos/'
const POSTER_PREFIX = 'https://api.fitproapp.ru/storage/v1/object/public/exercise-posters/'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Личность — только из подписанного токена.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = data.user.id

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Fail closed: без ключа ни роль проверить, ни записать. Ошибка громкая.
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — назначение видео невозможно')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Только тренер. Роль читаем из базы service_role-ключом, а не из тела.
  const { data: me, error: meErr } = await supabaseAdmin
    .from('profiles').select('role').eq('id', userId).maybeSingle()
  if (meErr) {
    console.error(`set-exercise-video: ошибка чтения профиля ${userId}:`, meErr)
    return res.status(500).json({ error: 'Не удалось проверить доступ' })
  }
  if (me?.role !== 'trainer') return res.status(403).json({ error: 'Доступно только тренеру' })

  const exerciseName = req.body?.exercise_name != null ? String(req.body.exercise_name).trim() : ''
  const action = req.body?.action
  if (!exerciseName) return res.status(400).json({ error: 'Не указано упражнение' })

  if (action === 'clear') {
    const { error } = await supabaseAdmin.from('exercise_videos').delete().eq('exercise_name', exerciseName)
    if (error) {
      console.error(`set-exercise-video: ошибка снятия видео (${exerciseName}):`, error)
      return res.status(500).json({ error: 'Не удалось снять видео' })
    }
    console.log(`set-exercise-video: тренер ${userId} снял видео с «${exerciseName}»`)
    return res.status(200).json({ ok: true })
  }

  if (action === 'assign') {
    const videoUrl = req.body?.video_url != null ? String(req.body.video_url) : ''
    const posterUrl = req.body?.poster_url != null ? String(req.body.poster_url) : ''
    // Ссылки обязаны указывать на наши публичные бакеты — иначе тренер (или
    // подделанный запрос) мог бы привязать к упражнению произвольный внешний URL.
    if (!videoUrl.startsWith(VIDEO_PREFIX)) return res.status(400).json({ error: 'Недопустимый video_url' })
    if (posterUrl && !posterUrl.startsWith(POSTER_PREFIX)) return res.status(400).json({ error: 'Недопустимый poster_url' })

    const { error } = await supabaseAdmin.from('exercise_videos').upsert({
      exercise_name: exerciseName,
      video_url: videoUrl,
      poster_url: posterUrl || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'exercise_name' })
    if (error) {
      console.error(`set-exercise-video: ошибка назначения видео (${exerciseName}):`, error)
      return res.status(500).json({ error: 'Не удалось назначить видео' })
    }
    console.log(`set-exercise-video: тренер ${userId} назначил видео «${exerciseName}»`)
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'Неизвестное действие' })
}
