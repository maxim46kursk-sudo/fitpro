// Серверный близнец src/logError.js: журнал ошибок public.error_log
// (sql/2026-07-28_error_log.sql) — плюс МГНОВЕННОЕ уведомление тренеру в
// Telegram.
//
// Зачем серверный: клиентский logError видит только то, что сломалось в
// браузере. Ручка, упавшая на середине, оставляет след ровно в одном месте —
// в логах Vercel, куда никто не смотрит, и то 24 часа. Сбой у живого человека
// не должен зависеть от того, открыл ли кто-то дашборд хостера.
//
// ЧТО МОЖНО ПИСАТЬ: только техническую суть — контекст ('api:chat'), текст
// ошибки, HTTP-статус, код ошибки Postgres, имя таблицы и действия.
//
// ЧЕГО ПИСАТЬ НЕЛЬЗЯ: содержимое переписки с ИИ, названия и состав еды, фото,
// имена, телефоны, e-mail. Ровно то же ограничение, что в клиентском близнеце,
// и по той же причине: стоит один раз положить туда «что съел клиент» — и
// таблица технических логов становится вторым хранилищем персональных данных
// со всеми обязанностями по 152-ФЗ. Поэтому в вызовах передаём error.message и
// error.code, но НЕ error.details: details у Postgres умеет содержать значения
// строки («Key (user_id, date)=(...) already exists»).
//
// ГЛАВНОЕ ПРО НАДЁЖНОСТЬ: журналирование не имеет права ломать ручку. Функция
// никогда не бросает и не обязана дожидаться — вызывающий код продолжает
// работу немедленно. Любой сбой записи или отправки глотается молча: отвечать
// пользователю ошибкой журнала ошибок абсурдно.
//
// Имя файла с подчёркиванием — Vercel не делает из таких файлов эндпоинты
// (лимит 12 функций на Hobby выбран целиком), как у _ratelimit.js и соседей.

import { createClient } from '@supabase/supabase-js'
// Выход наружу: на своём сервере адреса Telegram и Anthropic переписываются
// на мост (см. api/_egress.js), на Vercel остаются как есть — там оба API
// доступны напрямую. Файл с подчёркиванием — не serverless-функция.
import { egressFetch } from './_egress.js'

// Те же пределы, что в src/logError.js: в базе тексты нужны для опознания
// сбоя, а не целиком.
const CONTEXT_MAX = 100
const MESSAGE_MAX = 500

// Сколько текста ошибки уходит в Telegram. Меньше, чем в базу: сообщение
// читают с телефона, и простыня стека там бесполезна — подробности в журнале.
const TG_MESSAGE_MAX = 200

// ТИШИНА ПОСЛЕ ПЕРВОГО КРИКА. Одна поломка — одно сообщение в час на context.
//
// Без этого любой массовый сбой превращается в пулемёт: ручка чата падает у
// сотни человек за минуту — сто сообщений в личку, после чего уведомления
// отключают вместе с полезными. Строка в журнал при этом ложится КАЖДАЯ:
// глушится только сигнал, не запись.
const ALERT_QUIET_MIN = 60

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const cut = (v, max) => {
  if (v == null) return null
  const s = String(v)
  return s.length > max ? s.slice(0, max) : s
}

// Тот же порядок, что в send-reminders.js и prodamus-webhook.js: сначала
// переменная окружения, иначе профиль с role='trainer'. Хелпер там не
// экспортирован, а импортировать сами ручки нельзя — вместе с ними приедет их
// `export const config` (пофункциональная настройка Vercel).
async function resolveTrainerId(admin) {
  const fromEnv = (process.env.TRAINER_USER_ID || '').trim()
  if (fromEnv && UUID_RE.test(fromEnv)) return fromEnv
  const { data } = await admin
    .from('profiles').select('id').eq('role', 'trainer').limit(1).maybeSingle()
  return data?.id || null
}

// Копия extractChatId из send-reminders.js — по той же причине, что и выше.
function extractChatId(user) {
  const fromMeta = user?.user_metadata?.telegram_id
  if (fromMeta != null && String(fromMeta).trim()) return String(fromMeta).trim()
  const email = user?.email || ''
  const m = email.match(/^tg(\d+)@telegram\.fitpro$/i)
  return m ? m[1] : null
}

// Была ли ошибка с тем же context недавно — кроме той, что мы только что
// записали. Именно «кроме»: своя же свежая строка иначе всегда находилась бы,
// и уведомление не ушло бы НИ РАЗУ. Исключаем по id, а не по времени: разница
// во времени между записью и этим запросом — миллисекунды, и любое сравнение
// «строго раньше» упиралось бы в точность часов.
async function seenRecently(admin, context, exceptId) {
  const since = new Date(Date.now() - ALERT_QUIET_MIN * 60 * 1000).toISOString()
  let q = admin
    .from('error_log')
    .select('id')
    .eq('context', context)
    .gte('created_at', since)
    .limit(1)
  if (exceptId != null) q = q.neq('id', exceptId)
  const { data, error } = await q
  // Не смогли проверить — молчим. Пропущенное уведомление хуже, чем шторм в
  // личку: журнал всё равно полон, а доверие к каналу теряется один раз.
  if (error) return true
  return (data?.length || 0) > 0
}

/**
 * ЧАТ ВЛАДЕЛЬЦА В TELEGRAM — один на все срочные сообщения сервера.
 *
 * Экспортируется, потому что тревоги — не единственное, о чём владелец обязан
 * узнать немедленно: оплаченный билет челленджа тоже (api/_challengeSale.js).
 * Копировать эту пару шагов третий раз незачем — обе половины (кто владелец и
 * где его чат) уже здесь, а этот файл, в отличие от ручек, импортируется
 * свободно: он с подчёркиванием и своего `export const config` не несёт.
 *
 * null — «отправить некуда»: тренер не определился или Telegram у него не
 * привязан. Это не ошибка и кричать о ней некуда, звать всё равно было бы
 * некого.
 */
export async function ownerChatId(admin) {
  const trainerId = await resolveTrainerId(admin)
  if (!trainerId) return null
  const { data: userData } = await admin.auth.admin.getUserById(trainerId)
  return extractChatId(userData?.user) || null
}

async function notifyTrainer(admin, { context, message, insertedId }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return false

  if (await seenRecently(admin, context, insertedId)) return false

  const chatId = await ownerChatId(admin)
  if (!chatId) return false

  // В сообщении только context и обрезанный message. Ни user_id, ни details,
  // ни пользовательского ввода: текст уходит во внешний сервис, и объём
  // утекающего ограничен тем, без чего нельзя понять, что сломалось.
  const text = `⚠ Ошибка: ${context}${message ? `, ${cut(message, TG_MESSAGE_MAX)}` : ''}`
  const res = await egressFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  return res.ok
}

// Записать ошибку. Не бросает никогда.
//
// Возвращает промис — но ЖДАТЬ ЕГО НЕ ОБЯЗАН НИКТО: вызов без await в горячем
// месте штатен, ручка отвечает пользователю, не дожидаясь ни базы, ни
// Telegram. Промис возвращается только ради тестов и редких мест, где хочется
// убедиться, что запись легла до завершения serverless-функции.
export async function logServerError(context, { message, status, userId } = {}) {
  try {
    const url = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    // Без сервисного ключа писать нечем: RLS на error_log требует
    // auth.uid() = user_id, а у ручки своей сессии нет.
    if (!key) return
    const admin = createClient(url, key)

    const ctx = cut(context, CONTEXT_MAX) || 'unknown'
    const statusNum = Number(status)
    const row = {
      // user_id nullable: серверная ошибка часто случается до опознания
      // пользователя (нет токена, упал разбор тела). Пишем, только когда
      // личность действительно известна и это UUID.
      user_id: userId && UUID_RE.test(String(userId)) ? String(userId) : null,
      context: ctx,
      message: cut(message, MESSAGE_MAX),
      status: Number.isFinite(statusNum) ? statusNum : null,
      // url и user_agent — поля браузерного близнеца, на сервере им нечего
      // положить, и придумывать нечего.
    }

    const { data, error } = await admin.from('error_log').insert(row).select('id').maybeSingle()
    if (error) return

    // Уведомление — ОТДЕЛЬНЫМ try: строка в журнале уже лежит, и падение
    // Telegram не должно выглядеть как несостоявшаяся запись.
    try {
      await notifyTrainer(admin, { context: ctx, message: row.message, insertedId: data?.id })
    } catch { /* Telegram недоступен — журнал важнее сигнала */ }
  } catch {
    // Молча: сбой журнала ошибок не касается ни пользователя, ни ручки.
  }
}

// Console.error И журнал одним вызовом. Console.error остаётся намеренно: в
// логах Vercel он нужен для разбора инцидента по горячим следам, со стеком и
// всем, чего в журнал класть нельзя.
export function reportError(context, consoleArgs, { message, status, userId } = {}) {
  console.error(...consoleArgs)
  // Без await: ручка обязана ответить пользователю, не дожидаясь журнала.
  // Промис ловим, иначе его reject всплывёт unhandled — хотя logServerError и
  // не бросает, страховка стоит одной строки.
  logServerError(context, { message, status, userId })?.catch?.(() => {})
}
