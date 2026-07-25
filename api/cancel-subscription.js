import { createClient } from '@supabase/supabase-js'

// Отмена подписки: сбрасывает ЭТОГО пользователя на СТАРТ (plan='start',
// plan_until=null). Автосписаний нет — оплата разовая на 30 дней, поэтому
// «отмена» = немедленное прекращение платного доступа. Кого отменяем — из
// подписанного токена, не из тела. plan/plan_until пишет service_role
// (триггер guard_profile_privileged это разрешает).
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — отмена подписки невозможна')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Идемпотентность: если активной платной подписки нет (plan_until пуст или
  // уже в прошлом), отменять нечего — не трогаем базу.
  const { data: prof, error: readErr } = await supabaseAdmin
    .from('profiles').select('plan, plan_until').eq('id', userId).maybeSingle()
  if (readErr) {
    console.error(`cancel-subscription: ошибка чтения ${userId}:`, readErr)
    return res.status(500).json({ error: 'Не удалось отменить подписку' })
  }
  const until = prof?.plan_until ? Date.parse(prof.plan_until) : NaN
  if (!Number.isFinite(until) || until <= Date.now()) {
    console.log(`cancel-subscription: ${userId} — активной подписки нет, пропуск`)
    return res.status(200).json({ ok: true, already: true })
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ plan: 'start', plan_until: null })
    .eq('id', userId)
  if (error) {
    console.error(`cancel-subscription: ошибка сброса ${userId}:`, error)
    return res.status(500).json({ error: 'Не удалось отменить подписку' })
  }
  console.log(`cancel-subscription: ${userId} сброшен на СТАРТ`)
  return res.status(200).json({ ok: true })
}
