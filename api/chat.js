import { createClient } from '@supabase/supabase-js'

// Серверный клиент Supabase — только для проверки токена (auth.getUser),
// никаких данных отсюда не читаем/не пишем. Тот же env и те же безопасные
// fallback-значения (URL и publishable-ключ несекретны), что и у клиента
// (src/supabase.js) — без fallback createClient падает сразу при холодном
// старте, если переменная почему-то не долетела до серверной функции.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://kybazlnscyzfrrafggxe.supabase.co'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'sb_publishable_8E9Baxz1q-rKOiV8-jbXtw_DIGOztMg'
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

  // Тело клиента не прокидываем целиком — только system/messages, реально
  // нужные для ответа. model и max_tokens задаём/клампим сами (см. выше).
  const { system, messages } = req.body || {}
  const maxTokens = Math.min(Number(req.body?.max_tokens) || 2048, MAX_TOKENS_CEILING)

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.VITE_ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
  })
  const responseData = await response.json()
  res.status(response.status).json(responseData)
}
