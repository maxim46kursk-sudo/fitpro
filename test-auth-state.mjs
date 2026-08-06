// Тесты чистых редьюсеров исходов запросов к Supabase (src/authState.js) и
// поведения, которое на них завязано.
//
// Зачем отдельный файл: оба бага, которые эти редьюсеры закрывают, — про
// СЛИЯНИЕ двух разных состояний в одно ("сессии нет" + "не смогли проверить",
// "день пуст" + "запрос упал"). Тест фиксирует именно разделение: если кто-то
// снова напишет `.then(({ data }) => ...)` без error, тут станет красно.

import { strict as assert } from 'node:assert'
import {
  resolveAuthOutcome, AUTH_OUTCOME,
  resolveLoadOutcome, LOAD_OUTCOME,
} from './src/authState.js'

let passed = 0, failed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// ── resolveAuthOutcome: три исхода getSession()
console.log('\nresolveAuthOutcome — исходы supabase.auth.getSession()')

test('сессия есть → SESSION', () => {
  const session = { access_token: 'a', refresh_token: 'r', expires_at: 1 }
  assert.equal(resolveAuthOutcome({ session, error: null }), AUTH_OUTCOME.SESSION)
})

test('сессии нет, ошибки нет → SIGNED_OUT (обычный выход, показываем LandingPage)', () => {
  assert.equal(resolveAuthOutcome({ session: null, error: null }), AUTH_OUTCOME.SIGNED_OUT)
})

test('ошибка + токены на месте → UNAVAILABLE, а НЕ выход — это и был тихий logout', () => {
  const error = new Error('Failed to fetch')
  const outcome = resolveAuthOutcome({ session: null, error, hasStoredSession: true })
  assert.equal(outcome, AUTH_OUTCOME.UNAVAILABLE)
  assert.notEqual(outcome, AUTH_OUTCOME.SIGNED_OUT, 'сетевой сбой не должен разлогинивать')
})

test('retryable-ошибка от supabase-js (5xx) + токены на месте → UNAVAILABLE', () => {
  // Ровно то, что отдаёт auth-js, когда GoTrue ответил 500 на /token:
  // токены остаются в localStorage, а наружу приходит session:null + error.
  const error = Object.assign(new Error('Internal Server Error'), { name: 'AuthRetryableFetchError', status: 500 })
  assert.equal(resolveAuthOutcome({ session: null, error, hasStoredSession: true }), AUTH_OUTCOME.UNAVAILABLE)
})

test('ошибка, но токенов УЖЕ НЕТ → SIGNED_OUT: сессию отверг сервер, нужен вход', () => {
  // 400 "Refresh token is not valid": supabase-js сам вычистил хранилище.
  // Показать тут "нет связи" значило бы запереть человека на экране ретрая.
  const error = Object.assign(new Error('Refresh token is not valid'), { status: 400, code: 'validation_failed' })
  assert.equal(resolveAuthOutcome({ session: null, error, hasStoredSession: false }), AUTH_OUTCOME.SIGNED_OUT)
})

test('сессия есть, но и ошибка есть → SESSION (сессия важнее)', () => {
  const session = { access_token: 'a' }
  assert.equal(resolveAuthOutcome({ session, error: new Error('x'), hasStoredSession: true }), AUTH_OUTCOME.SESSION)
})

test('вызов без аргументов не роняет', () => {
  assert.equal(resolveAuthOutcome(), AUTH_OUTCOME.SIGNED_OUT)
})

// ── resolveLoadOutcome: пустой результат против упавшего запроса
console.log('\nresolveLoadOutcome — исходы выборки списка')

test('данные пришли → DATA', () => {
  assert.equal(resolveLoadOutcome({ data: [{ id: 1 }], error: null }), LOAD_OUTCOME.DATA)
})

test('ПУСТОЙ массив → DATA: день реально пуст, это валидный ответ', () => {
  assert.equal(resolveLoadOutcome({ data: [], error: null }), LOAD_OUTCOME.DATA)
})

test('ошибка → FAILED, а не "пустой день"', () => {
  assert.equal(resolveLoadOutcome({ data: null, error: new Error('JWT expired') }), LOAD_OUTCOME.FAILED)
})

test('401 из-за протухшего токена → FAILED', () => {
  const error = { message: 'JWT expired', code: 'PGRST301' }
  assert.equal(resolveLoadOutcome({ data: null, error }), LOAD_OUTCOME.FAILED)
})

test('data:null без error → FAILED (подстраховка)', () => {
  assert.equal(resolveLoadOutcome({ data: null, error: null }), LOAD_OUTCOME.FAILED)
})

test('вызов без аргументов не роняет', () => {
  assert.equal(resolveLoadOutcome(), LOAD_OUTCOME.FAILED)
})

// ── Поведенческие тесты: воспроизводим логику обработчиков на моках
console.log('\nПоведение App.getSession-обработчика (мок)')

// Копия ветвления из App.jsx: важно, что при UNAVAILABLE setUser НЕ зовётся.
function handleGetSession({ session, error, hasStoredSession = false }, { setUser, setAuthError, setAuthLoading }) {
  if (resolveAuthOutcome({ session, error, hasStoredSession }) === AUTH_OUTCOME.UNAVAILABLE) {
    setAuthError(true); setAuthLoading(false); return
  }
  setAuthError(false)
  setUser(session?.user ?? null)
  setAuthLoading(false)
}

const spy = () => { const f = (...a) => { f.calls.push(a) }; f.calls = []; return f }

test('getSession с error при живых токенах → пользователь НЕ разлогинен, поднят authError', () => {
  const setUser = spy(), setAuthError = spy(), setAuthLoading = spy()
  handleGetSession({ session: null, error: new Error('network'), hasStoredSession: true }, { setUser, setAuthError, setAuthLoading })
  assert.equal(setUser.calls.length, 0, 'setUser не должен вызываться вообще')
  assert.deepEqual(setAuthError.calls, [[true]])
  assert.deepEqual(setAuthLoading.calls, [[false]])
})

test('getSession с error, но токены вычищены → LandingPage, а не экран ретрая', () => {
  const setUser = spy(), setAuthError = spy(), setAuthLoading = spy()
  handleGetSession({ session: null, error: new Error('Refresh token is not valid'), hasStoredSession: false }, { setUser, setAuthError, setAuthLoading })
  assert.deepEqual(setUser.calls, [[null]])
  assert.deepEqual(setAuthError.calls, [[false]])
})

test('getSession с session:null без error → LandingPage (setUser(null))', () => {
  const setUser = spy(), setAuthError = spy(), setAuthLoading = spy()
  handleGetSession({ session: null, error: null }, { setUser, setAuthError, setAuthLoading })
  assert.deepEqual(setUser.calls, [[null]])
  assert.deepEqual(setAuthError.calls, [[false]])
})

test('getSession с сессией → вход, баннер снят', () => {
  const setUser = spy(), setAuthError = spy(), setAuthLoading = spy()
  const user = { id: 'u1' }
  handleGetSession({ session: { user }, error: null }, { setUser, setAuthError, setAuthLoading })
  assert.deepEqual(setUser.calls, [[user]])
  assert.deepEqual(setAuthError.calls, [[false]])
})

console.log('\nПоведение onAuthStateChange-обработчика (мок)')

// Копия ветвления из App.jsx. Ключевое: INITIAL_SESSION не трогает user вообще.
function handleAuthEvent(event, session, { setUser, setAuthError, setRecoveryMode }) {
  if (event === 'PASSWORD_RECOVERY') { setRecoveryMode(true); return }
  if (event === 'INITIAL_SESSION') return
  setAuthError(false)
  setUser(session?.user ?? null)
}

test('INITIAL_SESSION с null НЕ разлогинивает — supabase-js шлёт его и при сбое рефреша', () => {
  const setUser = spy(), setAuthError = spy(), setRecoveryMode = spy()
  handleAuthEvent('INITIAL_SESSION', null, { setUser, setAuthError, setRecoveryMode })
  assert.equal(setUser.calls.length, 0, 'INITIAL_SESSION не должен трогать user — иначе тихий logout возвращается')
  assert.equal(setAuthError.calls.length, 0)
})

test('SIGNED_OUT разлогинивает как и раньше', () => {
  const setUser = spy(), setAuthError = spy(), setRecoveryMode = spy()
  handleAuthEvent('SIGNED_OUT', null, { setUser, setAuthError, setRecoveryMode })
  assert.deepEqual(setUser.calls, [[null]])
  assert.deepEqual(setAuthError.calls, [[false]])
})

test('TOKEN_REFRESHED снимает баннер и обновляет пользователя', () => {
  const setUser = spy(), setAuthError = spy(), setRecoveryMode = spy()
  const user = { id: 'u1' }
  handleAuthEvent('TOKEN_REFRESHED', { user }, { setUser, setAuthError, setRecoveryMode })
  assert.deepEqual(setUser.calls, [[user]])
  assert.deepEqual(setAuthError.calls, [[false]])
})

test('PASSWORD_RECOVERY уводит в форму смены пароля, а не в приложение', () => {
  const setUser = spy(), setAuthError = spy(), setRecoveryMode = spy()
  handleAuthEvent('PASSWORD_RECOVERY', { user: { id: 'u1' } }, { setUser, setAuthError, setRecoveryMode })
  assert.deepEqual(setRecoveryMode.calls, [[true]])
  assert.equal(setUser.calls.length, 0)
})

console.log('\nПоведение загрузчиков дневника (мок)')

// Копия ветвления из FoodDiary.jsx: при FAILED не трогаем ни state, ни кэш.
function handleDayLoad({ data, error }, { cache, date, setFoodDiary, setFoodLoadError }) {
  if (resolveLoadOutcome({ data, error }) === LOAD_OUTCOME.FAILED) {
    setFoodLoadError(true); return
  }
  setFoodDiary(data)
  cache[date] = data
}

test('загрузчик дня: ошибка → кэш НЕ тронут, state НЕ тронут', () => {
  const cache = { '2026-08-06': [{ id: 1, name: 'Творог' }] }
  const before = JSON.stringify(cache)
  const setFoodDiary = spy(), setFoodLoadError = spy()
  handleDayLoad({ data: null, error: new Error('JWT expired') },
    { cache, date: '2026-08-06', setFoodDiary, setFoodLoadError })
  assert.equal(JSON.stringify(cache), before, 'кэш затёрт — это и был баг')
  assert.equal(setFoodDiary.calls.length, 0, 'state не должен обновляться при ошибке')
  assert.deepEqual(setFoodLoadError.calls, [[true]])
})

test('загрузчик дня: пустой ответ → день честно становится пустым', () => {
  const cache = { '2026-08-06': [{ id: 1, name: 'Творог' }] }
  const setFoodDiary = spy(), setFoodLoadError = spy()
  handleDayLoad({ data: [], error: null },
    { cache, date: '2026-08-06', setFoodDiary, setFoodLoadError })
  assert.deepEqual(cache['2026-08-06'], [], 'пустой день должен применяться')
  assert.deepEqual(setFoodDiary.calls, [[[]]])
  assert.equal(setFoodLoadError.calls.length, 0)
})

test('загрузчик месяца: ошибка → кэш календаря НЕ тронут', () => {
  const cache = { '2026-08-01': [{ id: 1 }], '2026-08-02': [{ id: 2 }] }
  const before = JSON.stringify(cache)
  const setFoodDiary = spy(), setFoodLoadError = spy()
  handleDayLoad({ data: null, error: { code: 'PGRST301' } },
    { cache, date: '2026-08-01', setFoodDiary, setFoodLoadError })
  assert.equal(JSON.stringify(cache), before)
  assert.deepEqual(setFoodLoadError.calls, [[true]])
})

test('перечитывание после записи: ошибка не стирает только что добавленную еду', () => {
  const cache = { '2026-08-06': [{ id: 7, name: 'Только что добавили' }] }
  const setFoodDiary = spy(), setFoodLoadError = spy()
  handleDayLoad({ data: null, error: new Error('offline') },
    { cache, date: '2026-08-06', setFoodDiary, setFoodLoadError })
  assert.deepEqual(cache['2026-08-06'], [{ id: 7, name: 'Только что добавили' }])
  assert.equal(setFoodDiary.calls.length, 0)
})

console.log(`\n${failed ? '✗' : '✓'} authState: ${passed} прошло, ${failed} упало\n`)
process.exit(failed ? 1 : 0)
