// Проверка НАСТОЯЩЕЙ библиотеки, а не мока: поднимаем реальный supabase-js с
// подставным хранилищем и подставным fetch и смотрим, что он отдаёт наружу в
// двух ситуациях. Весь фикс тихого логаута держится на этом поведении, и мок
// его подтвердить не может — если supabase-js в следующей версии начнёт вести
// себя иначе, узнать об этом надо здесь, а не от пользователей.

import { strict as assert } from 'node:assert'
import { createClient } from '@supabase/supabase-js'
import { resolveAuthOutcome, AUTH_OUTCOME } from './src/authState.js'

const STORAGE_KEY = 'fitpro-auth'

let passed = 0, failed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// Просроченная сессия — ровно то состояние, в котором оказывается вкладка,
// поспавшая ночь: access_token истёк час назад, refresh_token на руках.
const expiredSession = () => ({
  access_token: 'expired.access.token',
  refresh_token: 'refresh-token-1',
  expires_at: Math.floor(Date.now() / 1000) - 3600,
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'u1', aud: 'authenticated', email: 'a@b.c', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
})

function makeClient(respond) {
  const store = new Map([[STORAGE_KEY, JSON.stringify(expiredSession())]])
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: k => { store.delete(k) },
  }
  const client = createClient('https://stub.local', 'anon-key', {
    auth: { storageKey: STORAGE_KEY, storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: respond },
  })
  return { client, store }
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

console.log('\nsupabase-js: что реально возвращает getSession() при сбое рефреша')

await test('GoTrue ответил 500 → session:null + error, а ТОКЕНЫ ОСТАЛИСЬ (это и есть тихий logout)', async () => {
  const { client, store } = makeClient(async () => jsonResponse(500, { code: 500, msg: 'Internal' }))
  const { data, error } = await client.auth.getSession()

  assert.equal(data.session, null, 'сессия должна прийти пустой')
  assert.ok(error, 'ошибка должна быть выставлена')
  assert.ok(store.has(STORAGE_KEY), 'токены обязаны остаться в хранилище — на этом стоит весь фикс')

  // А теперь то, ради чего всё: наш редьюсер НЕ должен разлогинивать.
  const outcome = resolveAuthOutcome({ session: data.session, error, hasStoredSession: store.has(STORAGE_KEY) })
  assert.equal(outcome, AUTH_OUTCOME.UNAVAILABLE)
  assert.notEqual(outcome, AUTH_OUTCOME.SIGNED_OUT)
})

await test('сеть недоступна (fetch бросил) → session:null + error, токены на месте', async () => {
  const { client, store } = makeClient(async () => { throw new TypeError('Failed to fetch') })
  const { data, error } = await client.auth.getSession()

  assert.equal(data.session, null)
  assert.ok(error)
  assert.ok(store.has(STORAGE_KEY), 'обрыв сети не должен стирать сессию')

  const outcome = resolveAuthOutcome({ session: data.session, error, hasStoredSession: store.has(STORAGE_KEY) })
  assert.equal(outcome, AUTH_OUTCOME.UNAVAILABLE)
})

await test('сервер отверг refresh token (400) → токены СТЁРТЫ, и это честный выход', async () => {
  // Тот же ответ, что прод отдаёт на битый токен:
  // {"code":400,"error_code":"validation_failed","msg":"Refresh token is not valid"}
  const { client, store } = makeClient(async () =>
    jsonResponse(400, { code: 400, error_code: 'validation_failed', msg: 'Refresh token is not valid' }))
  const { data, error } = await client.auth.getSession()

  assert.equal(data.session, null)
  assert.equal(store.has(STORAGE_KEY), false, 'supabase-js должен сам вычистить мёртвую сессию')

  // Ошибка тут тоже есть — и именно поэтому одного error было мало: без
  // hasStoredSession мы показали бы "нет связи" вместо формы входа.
  const outcome = resolveAuthOutcome({ session: data.session, error, hasStoredSession: store.has(STORAGE_KEY) })
  assert.equal(outcome, AUTH_OUTCOME.SIGNED_OUT, 'мёртвая сессия обязана вести на LandingPage')
})

await test('рефреш прошёл успешно → обычный вход', async () => {
  const { client, store } = makeClient(async () => jsonResponse(200, {
    access_token: 'new.access.token',
    refresh_token: 'refresh-token-2',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: expiredSession().user,
  }))
  const { data, error } = await client.auth.getSession()

  assert.equal(error, null)
  assert.ok(data.session, 'сессия должна прийти')
  assert.equal(data.session.access_token, 'new.access.token')
  assert.ok(store.has(STORAGE_KEY))

  const outcome = resolveAuthOutcome({ session: data.session, error, hasStoredSession: true })
  assert.equal(outcome, AUTH_OUTCOME.SESSION)
})

console.log(`\n${failed ? '✗' : '✓'} auth-session (реальный supabase-js): ${passed} прошло, ${failed} упало\n`)
process.exit(failed ? 1 : 0)
