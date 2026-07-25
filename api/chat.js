import { createClient } from '@supabase/supabase-js'
import { effectiveLevel, AI_MIN_LEVEL } from './_access.js'

// Серверный клиент Supabase — проверка токена (auth.getUser) и, ниже, чтение
// пакета пользователя service_role-ключом. Тот же env и те же безопасные
// fallback-значения (URL и publishable-ключ несекретны), что и у клиента
// (src/supabase.js) — без fallback createClient падает сразу при холодном
// старте, если переменная почему-то не долетела до серверной функции.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Модель и потолок длины ответа задаём здесь, а не берём из тела запроса —
// иначе анонимный клиент мог бы заказать любую доступную по ключу модель
// или огромный max_tokens за наш счёт. 4096 — с запасом над тем, что реально
// шлёт клиент (3000 для тренировок, 1000 для питания, см. AIAssistant.jsx).
const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS_CEILING = 4096

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Без валидного Supabase-токена — эндпоинт был открытым анонимным прокси
  // к Anthropic на нашем ключе (любой посторонний мог гонять запросы за наш
  // счёт). Авторизация обязательна ДО обращения к Anthropic.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })

  // ── Гейт по пакету. Клиентской блокировки (AIAssistant.jsx) недостаточно:
  // без этой проверки любой авторизованный пользователь дёргает /api/chat
  // напрямую и гоняет Anthropic за наш счёт в обход тарифа.
  //
  // Профиль читаем service_role-ключом: под RLS анонимный клиент чужую строку
  // не увидит, а нам нужен гарантированный ответ по id из токена.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Fail closed: без ключа уровень не проверить, а пускать всех к платной
    // функции нельзя. Ошибка громкая — чинится настройкой переменной.
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — проверка пакета невозможна')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('plan, plan_until, trial_until, role')
    .eq('id', data.user.id)
    .maybeSingle()
  if (profileError) {
    console.error(`ИИ-ассистент ${data.user.id}: ошибка чтения пакета:`, profileError)
    return res.status(500).json({ error: 'Не удалось проверить доступ' })
  }
  if (effectiveLevel(profile) < AI_MIN_LEVEL) {
    return res.status(403).json({ error: 'ИИ-ассистент доступен в пакете ПРОФИТ' })
  }

  // ── Анти-абьюз: ручку нельзя использовать как безлимитный LLM-прокси.
  // 1) Ограничение размера входа: суммарная длина content всех messages.
  const msgsForSize = Array.isArray(req.body?.messages) ? req.body.messages : []
  const inputChars = msgsForSize.reduce((sum, m) => {
    const c = m?.content
    if (typeof c === 'string') return sum + c.length
    if (Array.isArray(c)) return sum + c.reduce((s, b) => s + (typeof b?.text === 'string' ? b.text.length : 0), 0)
    return sum
  }, 0)
  if (inputChars > 16000) return res.status(400).json({ error: 'Слишком длинный запрос' })

  // 2) Пер-юзер дневной лимит по дате МСК (UTC+3). Инкремент атомарный через
  // security-definer RPC; считаем и отклонённые лимитом попытки.
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  const today = `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}-${pad(msk.getUTCDate())}`
  const { data: usageCount, error: usageError } = await supabaseAdmin.rpc('incr_ai_usage', { uid: data.user.id, d: today })
  if (usageError) {
    console.error(`ИИ-ассистент ${data.user.id}: ошибка учёта лимита:`, usageError)
    return res.status(500).json({ error: 'Не удалось проверить лимит' })
  }
  if (usageCount > 40) {
    return res.status(429).json({ error: 'Достигнут дневной лимит запросов к ассистенту, попробуйте завтра' })
  }

  // Тело клиента не прокидываем целиком — только system/messages, реально
  // нужные для ответа. model и max_tokens задаём/клампим сами (см. выше).
  const { system, messages } = req.body || {}
  const maxTokens = Math.min(Number(req.body?.max_tokens) || 2048, MAX_TOKENS_CEILING)

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
  })
  const responseData = await response.json()
  res.status(response.status).json(responseData)
}
