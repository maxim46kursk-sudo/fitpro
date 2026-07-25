import { createClient } from '@supabase/supabase-js'

// Загрузка видео тренером с устройства: выдаём подписанный URL в приватный
// бакет raw-videos и ставим задачу на серверное сжатие (transcode_jobs).
// ТОЛЬКО роль trainer. Кто действует — из подписанного токена; роль проверяем
// service_role-ключом (клиент под RLS свою роль в теле подделать не может).
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// raw_key должен совпадать ровно с форматом, который генерирует ветка 'sign':
// slugify(name) + '-' + Date.now() + '.mp4'. Строгая проверка не даёт воркеру
// качать по подставленному произвольному ключу.
const RAW_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{13}\.mp4$/

const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }
function slugify(s) {
  const lat = (s || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
  return lat.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-') || 'exercise'
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = data.user.id

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — загрузка видео невозможна')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Только тренер. Роль читаем из базы, а не из тела.
  const { data: me, error: meErr } = await supabaseAdmin
    .from('profiles').select('role').eq('id', userId).maybeSingle()
  if (meErr) {
    console.error(`create-video-upload: ошибка чтения профиля ${userId}:`, meErr)
    return res.status(500).json({ error: 'Не удалось проверить доступ' })
  }
  if (me?.role !== 'trainer') return res.status(403).json({ error: 'Доступно только тренеру' })

  const exerciseName = req.body?.exercise_name != null ? String(req.body.exercise_name).trim().slice(0, 100) : ''
  const action = req.body?.action
  if (!exerciseName) return res.status(400).json({ error: 'Не указано упражнение' })

  if (action === 'sign') {
    // Уникальный ключ сырья: slug имени + timestamp. Подписанный URL позволяет
    // клиенту залить файл напрямую в приватный бакет без service_role на фронте.
    const rawKey = `${slugify(exerciseName)}-${Date.now()}.mp4`
    const { data: signed, error } = await supabaseAdmin.storage.from('raw-videos').createSignedUploadUrl(rawKey)
    if (error || !signed) {
      console.error(`create-video-upload: ошибка подписи (${exerciseName}):`, error)
      return res.status(500).json({ error: 'Не удалось подготовить загрузку' })
    }
    return res.status(200).json({ path: signed.path, token: signed.token, raw_key: rawKey })
  }

  if (action === 'enqueue') {
    const rawKey = req.body?.raw_key != null ? String(req.body.raw_key).trim() : ''
    if (!rawKey) return res.status(400).json({ error: 'Не указан raw_key' })
    if (!RAW_KEY_RE.test(rawKey)) return res.status(400).json({ error: 'Недопустимый raw_key' })
    const { error } = await supabaseAdmin.from('transcode_jobs')
      .insert({ exercise_name: exerciseName, raw_key: rawKey, status: 'pending' })
    if (error) {
      console.error(`create-video-upload: ошибка постановки задачи (${exerciseName}):`, error)
      return res.status(500).json({ error: 'Не удалось поставить задачу' })
    }
    console.log(`create-video-upload: тренер ${userId} загрузил видео для «${exerciseName}» (${rawKey})`)
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'Неизвестное действие' })
}
