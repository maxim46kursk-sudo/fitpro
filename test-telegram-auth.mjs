// Развилка входа через Telegram — api/telegram-auth.js, resolveTelegramAccount.
//
// Что здесь защищается. Вход перевели с синтетической почты
// tg<id>@telegram.fitpro на profiles.tg_id, и на момент правки в проде 41
// живой аккаунт. Цена ошибки — человек заходит и видит ПУСТОЙ аккаунт вместо
// своего (создался дубль) или, того хуже, ЧУЖОЙ. Оба сценария внешне выглядят
// как успешный вход, поэтому проверяются здесь явно, по одному.
//
// Настоящую базу не трогаем: подставляем фейковый admin-клиент с той же
// цепочкой вызовов, что у supabase-js, и смотрим не только на возвращённое
// значение, но и на ЗАПИСИ, которые функция пыталась сделать.

import { strict as assert } from 'node:assert'
import { resolveTelegramAccount } from './api/telegram-auth.js'
import { extractChatId } from './api/send-reminders.js'
import { telegramChatIdOf, realEmail, isSyntheticEmail } from './src/config.js'

let passed = 0, failed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// Логи функции в выводе теста только мешают — она пишет в console по делу,
// но здесь важен результат, а не её репортаж.
const quiet = fn => async () => {
  const { log, warn, error } = console
  console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { Object.assign(console, { log, warn, error }) }
}

// ── Фейковая база ───────────────────────────────────────────────────────────
// profiles — массив строк, authUsers — карта id → { id, email }.
// writes — журнал всех попыток записи: именно по нему проверяется «без
// перезаписи», потому что успешный отказ и молчаливая порча снаружи выглядят
// одинаково, если смотреть только на возвращённое значение.
// hideTgIdLookup — поиск по tg_id отвечает «не нашёл», хотя строка есть. Так
// воспроизводится ГОНКА: между веткой 1 и записью связи кто-то успел занять
// tg_id. Иначе до отказа по уникальному индексу не добраться — ветка 1
// перехватила бы такой случай раньше.
function makeAdmin({ profiles = [], authUsers = {}, failLookup = false, hideTgIdLookup = false } = {}) {
  const writes = []
  const state = { profiles, authUsers, writes }

  const profilesTable = () => {
    // Накапливаем фильтры и вид операции, выполняем в момент await —
    // так же, как это делает postgrest-js.
    const q = { op: 'select', filters: [], payload: null }
    const builder = {
      select(cols) { if (q.op === 'select') q.cols = cols; return builder },
      eq(col, val) { q.filters.push([col, 'eq', val]); return builder },
      is(col, val) { q.filters.push([col, 'is', val]); return builder },
      update(payload) { q.op = 'update'; q.payload = payload; return builder },
      upsert(payload, opts) { q.op = 'upsert'; q.payload = payload; q.opts = opts; return builder },
      maybeSingle() { return builder.then.call(builder, r => r, e => { throw e }, true) },
      then(onOk, onErr, asSingle) {
        const run = () => {
          if (q.op === 'select' && failLookup) return { data: null, error: { code: 'PGRST000', message: 'boom' } }

          const match = row => q.filters.every(([col, kind, val]) =>
            kind === 'is' ? (row[col] ?? null) === val : String(row[col] ?? '') === String(val))

          if (q.op === 'select') {
            const byTgId = q.filters.some(([col]) => col === 'tg_id')
            if (byTgId && hideTgIdLookup) return { data: asSingle ? null : [], error: null }
            const rows = state.profiles.filter(match)
            return { data: asSingle ? (rows[0] ?? null) : rows, error: null }
          }

          if (q.op === 'upsert') {
            writes.push({ kind: 'upsert', payload: q.payload })
            const exists = state.profiles.some(r => r.id === q.payload.id)
            // ignoreDuplicates — существующую строку не трогаем вовсе.
            if (!exists) state.profiles.push({ ...q.payload })
            return { data: null, error: null }
          }

          // update
          writes.push({ kind: 'update', payload: q.payload, filters: [...q.filters] })
          const rows = state.profiles.filter(match)
          // Уникальный индекс profiles_tg_id_key — воспроизводим его отказ.
          if ('tg_id' in q.payload && rows.length) {
            const owner = state.profiles.find(r => r.tg_id != null
              && String(r.tg_id) === String(q.payload.tg_id)
              && !rows.includes(r))
            if (owner) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_tg_id_key"' } }
          }
          for (const row of rows) Object.assign(row, q.payload)
          return { data: rows.map(r => ({ id: r.id })), error: null }
        }
        return Promise.resolve(run()).then(onOk, onErr)
      },
    }
    return builder
  }

  return {
    __state: state,
    from(table) {
      assert.equal(table, 'profiles', `неожиданная таблица: ${table}`)
      return profilesTable()
    },
    auth: {
      admin: {
        async getUserById(id) {
          const user = state.authUsers[id]
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'not found' } }
        },
        async createUser({ email }) {
          const exists = Object.values(state.authUsers).some(u => u.email === email)
          if (exists) return { data: null, error: { code: 'email_exists', message: 'already registered' } }
          const id = `new-${Object.keys(state.authUsers).length + 1}`
          state.authUsers[id] = { id, email }
          writes.push({ kind: 'createUser', email, id })
          return { data: { user: state.authUsers[id] }, error: null }
        },
        async generateLink({ email }) {
          const user = Object.values(state.authUsers).find(u => u.email === email)
          if (!user) return { data: null, error: { message: 'user not found' } }
          return { data: { properties: { email_otp: `otp-for-${user.id}` }, user }, error: null }
        },
      },
    },
  }
}

const TG = { id: 777001, first_name: 'Аня', username: 'anya' }

console.log('\ntelegram-auth: связь аккаунта с Telegram по profiles.tg_id')

// ── 1. Основной путь: аккаунт уже связан ────────────────────────────────────
await test('существующий пользователь входит по tg_id (почта аккаунта не при чём)', quiet(async () => {
  // Ключевая деталь: почта у аккаунта ОБЫЧНАЯ, не синтетическая. Если бы вход
  // по-прежнему держался на tg<id>@telegram.fitpro, такой пользователь сюда не
  // попал бы и получил бы дубль.
  const admin = makeAdmin({
    profiles: [{ id: 'u1', tg_id: 777001, tg_username: 'anya' }],
    authUsers: { u1: { id: 'u1', email: 'anya@mail.ru' } },
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, true, 'вход должен пройти')
  assert.equal(r.email, 'anya@mail.ru', 'сессия обязана выдаваться на НАСТОЯЩУЮ почту аккаунта')
  assert.equal(r.otp, 'otp-for-u1')
  assert.equal(admin.__state.writes.some(w => w.kind === 'createUser'), false, 'никаких новых аккаунтов заводиться не должно')
  assert.equal(admin.__state.profiles.length, 1, 'дубль профиля не создан')
}))

// ── 2. Legacy-путь: 41 существующий аккаунт ─────────────────────────────────
await test('legacy-аккаунт (tg_id пуст, есть синтетическая почта) входит и получает tg_id', quiet(async () => {
  // Ровно состояние прода ДО бэкфилла — и состояние любого аккаунта, который
  // бэкфилл почему-то пропустил. Дубля быть не должно ни в коем случае.
  const admin = makeAdmin({
    profiles: [{ id: 'u2', tg_id: null, name: 'Аня' }],
    authUsers: { u2: { id: 'u2', email: 'tg777001@telegram.fitpro' } },
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, true, 'старый пользователь обязан войти')
  assert.equal(r.email, 'tg777001@telegram.fitpro')
  assert.equal(r.otp, 'otp-for-u2', 'сессия выдана ТОМУ ЖЕ пользователю, а не новому')
  assert.equal(admin.__state.profiles.length, 1, 'дубль профиля не создан')
  assert.equal(admin.__state.profiles[0].tg_id, 777001, 'связь должна достроиться при первом же входе')
}))

await test('legacy-аккаунт при повторном входе идёт уже по tg_id, синтетическая почта не нужна', quiet(async () => {
  // Проверяем, что достроенная связь действительно работает: меняем почту
  // аккаунта на обычную — вход обязан продолжить работать.
  const admin = makeAdmin({
    profiles: [{ id: 'u2', tg_id: 777001 }],
    authUsers: { u2: { id: 'u2', email: 'anya-new@mail.ru' } },
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, true)
  assert.equal(r.email, 'anya-new@mail.ru', 'смена почты больше не рвёт вход через Telegram')
  assert.equal(admin.__state.writes.some(w => w.kind === 'createUser'), false)
}))

// ── 3. Новый пользователь ───────────────────────────────────────────────────
await test('новый пользователь: аккаунт создаётся, tg_id пишется сразу', quiet(async () => {
  const admin = makeAdmin()
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, true)
  assert.equal(r.email, 'tg777001@telegram.fitpro', 'новому аккаунту синтетическая почта нужна — иначе GoTrue его не заведёт')
  assert.equal(admin.__state.writes.filter(w => w.kind === 'createUser').length, 1)
  const profile = admin.__state.profiles[0]
  assert.ok(profile, 'строка профиля должна появиться')
  assert.equal(profile.tg_id, 777001, 'tg_id обязан проставиться сразу при создании, а не при следующем входе')
  assert.equal(profile.tg_username, 'anya')
}))

// ── 4. Занятый tg_id — внятный отказ БЕЗ перезаписи ─────────────────────────
await test('tg_id занят другим профилем (уникальный индекс) → отказ 409, чужая строка не тронута', quiet(async () => {
  // Гонка: ветка 1 связи не увидела, а к моменту записи tg_id уже принадлежит
  // профилю u3. База отвечает 23505. Логинить наугад нельзя — это тихий угон
  // аккаунта, поэтому единственный правильный исход — внятный отказ.
  const admin = makeAdmin({
    profiles: [
      { id: 'u3', tg_id: 777001, name: 'Владелец tg_id' },
      { id: 'u4', tg_id: null, name: 'Хозяин синтетической почты' },
    ],
    authUsers: { u4: { id: 'u4', email: 'tg777001@telegram.fitpro' } },
    hideTgIdLookup: true,
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, false, 'вход обязан быть отклонён')
  assert.equal(r.status, 409, 'конфликт связи — это 409, а не безликая 500')
  assert.ok(/уже привязан/i.test(r.error || ''), `отказ должен объяснять причину: ${r.error}`)
  assert.equal(admin.__state.profiles.find(p => p.id === 'u3').tg_id, 777001, 'ЧУЖОЙ tg_id перезаписан быть не должен')
  assert.equal(admin.__state.profiles.find(p => p.id === 'u4').tg_id ?? null, null, 'вторая строка тоже не должна получить чужой tg_id')
}))

await test('профиль с tg_id есть, а auth-пользователь пропал → внятный отказ, без создания дубля', quiet(async () => {
  // Рассинхрон: строка profiles пережила удаление аккаунта. Раньше такой случай
  // молча уводил бы в ветку создания — то есть плодил бы новый аккаунт поверх
  // мусора.
  const admin = makeAdmin({
    profiles: [{ id: 'ghost', tg_id: 777001 }],
    authUsers: {},
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, false)
  assert.equal(r.status, 500)
  assert.ok(/неисправном/i.test(r.error || ''), `ожидалось внятное объяснение, получено: ${r.error}`)
  assert.equal(admin.__state.writes.some(w => w.kind === 'createUser'), false, 'дубль аккаунта не создан')
}))

await test('у профиля уже стоит ДРУГОЙ tg_id → отказ, значение не перезаписано', quiet(async () => {
  // Обратная аномалия: синтетическая почта ведёт к аккаунту, который уже
  // связан с другим Telegram. Молча переписать связь — значит отдать аккаунт.
  const admin = makeAdmin({
    profiles: [{ id: 'u5', tg_id: 999999 }],
    authUsers: { u5: { id: 'u5', email: 'tg777001@telegram.fitpro' } },
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, false)
  assert.ok(/уже привязан/i.test(r.error || ''), `ожидался внятный отказ, получено: ${r.error}`)
  assert.equal(admin.__state.profiles[0].tg_id, 999999, 'существующая связь обязана остаться нетронутой')
}))

// ── 5. Сбой поиска не должен плодить дубли ──────────────────────────────────
await test('поиск по tg_id упал → отказ, а НЕ создание дубля', quiet(async () => {
  // Худший из тихих сценариев: сеть моргнула, ветка 1 не нашла аккаунт, и
  // человек с историей получил бы чистый новый профиль.
  const admin = makeAdmin({
    profiles: [{ id: 'u6', tg_id: 777001 }],
    authUsers: { u6: { id: 'u6', email: 'anya@mail.ru' } },
    failLookup: true,
  })
  const r = await resolveTelegramAccount(admin, TG)

  assert.equal(r.ok, false, 'при сбое поиска вход должен честно отказать')
  assert.equal(r.status, 500)
  assert.equal(admin.__state.writes.some(w => w.kind === 'createUser'), false, 'дубль аккаунта не создан')
}))

// ── 6. Мусорный id из initData ──────────────────────────────────────────────
await test('битый tgUser.id отклоняется до любых обращений к базе', quiet(async () => {
  const admin = makeAdmin()
  const r = await resolveTelegramAccount(admin, { id: 'не число', first_name: 'X' })

  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
  assert.equal(admin.__state.writes.length, 0, 'в базу не должно уйти ничего')
}))

// ── 7. Канал доставки: фронт и крон обязаны отвечать одинаково ─────────────
// Настройки пишут «Придут в Telegram» на основании telegramChatIdOf(), а
// реально отправляет крон по extractChatId(). Это две КОПИИ одной логики в
// разных файлах (общий модуль не завести: src/ уезжает в бандл Vite, api/
// исполняется на Vercel). Копии расходятся молча, поэтому сверяем их здесь.
console.log('\nканал напоминаний: src/config.js и api/send-reminders.js не должны разойтись')

const CHANNEL_CASES = [
  ['телеграм-аккаунт: id в метаданных', { user_metadata: { telegram_id: 12345 }, email: 'tg12345@telegram.fitpro' }],
  ['телеграм-аккаунт: только синтетическая почта', { user_metadata: {}, email: 'tg67890@telegram.fitpro' }],
  ['телеграм-аккаунт: id числом в метаданных, почта обычная', { user_metadata: { telegram_id: 555 }, email: 'anya@mail.ru' }],
  ['телеграм-аккаунт: id строкой', { user_metadata: { telegram_id: '555' }, email: 'anya@mail.ru' }],
  ['обычный email-аккаунт — канала НЕТ', { user_metadata: {}, email: 'ivan@example.com' }],
  ['клиент, заведённый тренером, — канала НЕТ', { user_metadata: {}, email: 'cabc123@clients.fitproapp.ru' }],
  ['пустые метаданные и похожая, но не та почта — канала НЕТ', { user_metadata: {}, email: 'tgabc@telegram.fitpro' }],
  ['telegram_id пустой строкой — канала НЕТ', { user_metadata: { telegram_id: '  ' }, email: 'ivan@example.com' }],
  ['пользователь null', null],
]

for (const [name, user] of CHANNEL_CASES) {
  await test(`совпадают: ${name}`, quiet(async () => {
    assert.equal(
      telegramChatIdOf(user), extractChatId(user),
      'фронт и крон разошлись — Настройки покажут не тот канал, что сработает на самом деле',
    )
  }))
}

await test('обычный email-пользователь: тумблер напоминаний обязан признать, что канала нет', quiet(async () => {
  // Это и есть тот случай, ради которого делался блок «подключите Telegram».
  assert.equal(telegramChatIdOf({ user_metadata: {}, email: 'ivan@example.com' }), null)
}))

// ── 8. Почта клиента у тренера: mailto: только на живой ящик ───────────────
// В profiles.email почта есть у ВСЕХ, но у телеграм-аккаунтов и у клиентов,
// заведённых тренером, она поддельная. Показать её тренеру как «почта клиента»
// со ссылкой mailto: — значит пообещать связь, которой нет.
console.log('\nпочта клиента: показываем только ту, на которую дойдёт письмо')

const EMAIL_CASES = [
  ['обычная почта', 'ivan@example.com', 'ivan@example.com'],
  ['почта с пробелами по краям', '  ivan@example.com  ', 'ivan@example.com'],
  ['синтетическая почта телеграм-аккаунта', 'tg12345@telegram.fitpro', null],
  ['синтетическая почта в другом регистре', 'TG12345@Telegram.Fitpro', null],
  ['клиент, заведённый тренером', 'cabc123@clients.fitproapp.ru', null],
  ['пусто', '', null],
  ['null', null, null],
]

for (const [name, input, expected] of EMAIL_CASES) {
  await test(`realEmail: ${name}`, quiet(async () => {
    assert.equal(realEmail(input), expected)
  }))
}

await test('обе технические почты опознаются как синтетические', quiet(async () => {
  assert.equal(isSyntheticEmail('tg1@telegram.fitpro'), true)
  assert.equal(isSyntheticEmail('c9f@clients.fitproapp.ru'), true)
  assert.equal(isSyntheticEmail('ivan@example.com'), false)
}))

console.log(`\n${failed ? '✗' : '✓'} telegram-auth: ${passed} прошло, ${failed} упало\n`)
process.exit(failed ? 1 : 0)
