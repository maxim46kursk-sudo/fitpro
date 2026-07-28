import { supabase } from './supabase'

// Журнал ошибок приложения (таблица public.error_log, см.
// sql/2026-07-28_error_log.sql). Сбои у реальных пользователей иначе остаются
// только в их собственной консоли браузера, то есть не видны никому.
//
// ЧТО МОЖНО ПИСАТЬ: только техническую суть — контекст (где упало), текст
// ошибки, HTTP-статус, код ошибки Postgres, имя таблицы и действия.
//
// ЧЕГО ПИСАТЬ НЕЛЬЗЯ: содержимое переписки с ИИ, названия и состав еды, фото,
// имена, телефоны, e-mail и прочие персональные данные. Журнал технический;
// стоит один раз положить туда «что съел клиент» — и таблица логов становится
// вторым хранилищем персональных данных со всеми обязанностями по 152-ФЗ.
// Поэтому в вызовах передаём error.message и error.code, но НЕ error.details и
// НЕ пользовательский ввод: details у Postgres умеет содержать значения строки
// («Key (user_id, date)=(...) already exists»).
//
// ГЛАВНОЕ ПРО НАДЁЖНОСТЬ: журналирование не имеет права ломать интерфейс.
// Функция никогда не бросает, ничего не возвращает и не предназначена для
// await — вызывающий код продолжает работу немедленно, запись уходит фоном.
// Любой сбой самой записи (нет сети, RLS, таблицы ещё нет на этом стенде)
// глотается молча: показывать пользователю ошибку журнала ошибок абсурдно.

// Тексты режем — в базе они нужны для опознания сбоя, а не целиком.
const CONTEXT_MAX = 100
const MESSAGE_MAX = 500
const AGENT_MAX = 300

const cut = (v, max) => {
  if (v == null) return null
  const s = String(v)
  return s.length > max ? s.slice(0, max) : s
}

export function logError(context, { message, status, details } = {}) {
  try {
    // Асинхронную часть намеренно не возвращаем: вызывающий код не должен
    // иметь возможности случайно её дождаться (await в горячем месте) или
    // получить необработанный reject.
    ;(async () => {
      try {
        // Без сессии писать бессмысленно: RLS требует auth.uid() = user_id,
        // строка всё равно будет отклонена.
        const { data: { session } } = await supabase.auth.getSession()
        const userId = session?.user?.id
        if (!userId) return

        const statusNum = Number(status)
        await supabase.from('error_log').insert({
          user_id: userId,
          context: cut(context, CONTEXT_MAX) || 'unknown',
          message: cut(message, MESSAGE_MAX),
          status: Number.isFinite(statusNum) ? statusNum : null,
          details: details ?? null,
          // Только путь, без query-строки: в параметрах могут оказаться
          // идентификаторы и прочее лишнее для технического журнала.
          url: cut(window?.location?.pathname, MESSAGE_MAX),
          user_agent: cut(window?.navigator?.userAgent, AGENT_MAX),
        })
      } catch {
        // Молча: сбой журналирования не касается пользователя.
      }
    })()
  } catch {
    // Молча — на случай, если синхронно упало что-то совсем неожиданное.
  }
}
