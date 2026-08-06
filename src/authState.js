// Чистые редьюсеры исходов запросов к Supabase. Вынесены из App.jsx/FoodDiary.jsx
// отдельным модулем без JSX намеренно: тесты гоняются обычным `node test-*.mjs`,
// без сборки, и импортировать из них App.jsx невозможно.

// ── Исход supabase.auth.getSession()
//
// Раньше App.jsx деструктурировал только { data: { session } } и любой пустой
// session трактовал как "пользователь вышел". Это неверно: supabase-js при
// RETRYABLE-ошибке рефреша (сеть отвалилась, GoTrue ответил 5xx) НАМЕРЕННО
// оставляет токены в localStorage (_removeSession не вызывается), но наружу
// отдаёт { session: null, error }. То есть "session пуст" означает одно из двух
// принципиально разных состояний, и различить их можно только по error:
//
//   session есть                        → SESSION
//   session нет, error нет              → SIGNED_OUT  — сессии нет, на вход
//   session нет, error есть, токены ЕСТЬ → UNAVAILABLE — временный сбой,
//                                          разлогинивать НЕЛЬЗЯ, нужен ретрай
//   session нет, error есть, токенов нет → SIGNED_OUT
//
// Про hasStoredSession отдельно. Одного error мало: при НЕретраебельной ошибке
// (протухший refresh token, 400 "Refresh token is not valid") supabase-js сам
// вычищает хранилище — сессия мертва по-настоящему, и человеку нужна форма
// входа, а не "нет связи". Отличает эти два случая ровно наличие токенов в
// localStorage после запроса: сбой сети/5xx их сохраняет, отказ сервера — нет.
// Это же и есть исходный симптом бага ("токены есть, а юзер разлогинен").
export const AUTH_OUTCOME = {
  SESSION: 'session',
  SIGNED_OUT: 'signed-out',
  UNAVAILABLE: 'unavailable',
}

export function resolveAuthOutcome({ session, error, hasStoredSession = false } = {}) {
  if (session) return AUTH_OUTCOME.SESSION
  if (error && hasStoredSession) return AUTH_OUTCOME.UNAVAILABLE
  return AUTH_OUTCOME.SIGNED_OUT
}

// ── Исход выборки списка из Supabase (дневник питания и т.п.)
//
// Та же болезнь на путях загрузки: `.then(({ data }) => ...)` без error
// превращал упавший запрос в `(data || [])` → пустой массив → день выглядел
// пустым, И эта пустота уезжала в localStorage, затирая кэш. Пустой день и
// неудачный запрос должны различаться:
//
//   error есть      → FAILED — не трогать ни state, ни кэш, показать баннер
//   data == null    → FAILED — подстраховка: без error, но и без данных
//   data = []       → DATA   — день ДЕЙСТВИТЕЛЬНО пуст, это валидный результат
export const LOAD_OUTCOME = {
  DATA: 'data',
  FAILED: 'failed',
}

export function resolveLoadOutcome({ data, error } = {}) {
  if (error) return LOAD_OUTCOME.FAILED
  if (data == null) return LOAD_OUTCOME.FAILED
  return LOAD_OUTCOME.DATA
}
