// test-error-log.mjs — журнал ошибок и МГНОВЕННОЕ уведомление тренеру.
//
// Что здесь проверяется и почему именно это:
//
//  • ЗАЩИТА ОТ ШТОРМА. Массовый сбой — сотня записей в журнал за минуту, и
//    ровно столько же сообщений в личку, если не глушить. После такого
//    уведомления отключают вместе с полезными, и канал мёртв. Правило: одна
//    поломка (context) — одно сообщение в час. Строка в журнал при этом ложится
//    КАЖДАЯ: глушится сигнал, не запись.
//
//  • ЖУРНАЛ ВАЖНЕЕ СИГНАЛА. Telegram лёг, токена нет, тренер не найден — запись
//    всё равно обязана лечь. Обратный порядок («не смогли позвать — не пишем»)
//    терял бы ровно те данные, ради которых всё затевалось.
//
//  • ВЕТКА ?action=log-error БЕЗ ТОКЕНА НЕ ПИШЕТ НИЧЕГО. Иначе журнал
//    превращается в открытую свалку, куда любой желающий льёт что хочет, а
//    заодно будит тренера по своему усмотрению.
//
// Сеть подменена целиком: и PostgREST, и Telegram. Наружу тесты не ходят.
//
// Запуск: node test-error-log.mjs

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-bot-token'
// Тренера берём из переменной окружения: так не нужен запрос в profiles, и
// тест проверяет уведомление, а не поиск тренера.
process.env.TRAINER_USER_ID = '33333333-3333-4333-8333-333333333333'

const { logServerError } = await import('./api/_logError.js')
const { default: handler } = await import('./api/set-exercise.js')

const SUPA_HOST = new URL(process.env.VITE_SUPABASE_URL).host
const TRAINER = process.env.TRAINER_USER_ID
const USER = '11111111-1111-4111-8111-111111111111'
const REAL_FETCH = globalThis.fetch

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── Подменённый мир: журнал в памяти + Telegram-счётчик ────────────────────
//
// rows — то, что «уже лежит» в error_log. Именно по нему отвечает запрос
// «была ли такая ошибка за последний час», и именно им моделируется шторм.
function stub({ rows = [], tgFails = false, tgThrows = false, insertFails = false, noTrainerChat = false } = {}) {
  const st = { inserted: [], sent: [], quietQueries: [], motion: [] }
  let nextId = 1000

  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))

    // ── Telegram
    if (u.host === 'api.telegram.org') {
      if (tgThrows) throw new Error('сеть до Telegram отвалилась')
      st.sent.push(JSON.parse(opts.body))
      return tgFails ? json({ ok: false, description: 'chat not found' }, 400) : json({ ok: true })
    }

    if (u.host !== SUPA_HOST) throw new Error(`неожиданный хост: ${u.host}`)

    // ── auth: кто такой пользователь по токену
    if (u.pathname.startsWith('/auth/v1/admin/users/')) {
      const id = u.pathname.split('/').pop()
      if (id === TRAINER && noTrainerChat) return json({ user: { id, email: 'trainer@example.com' } })
      return json({ user: { id, email: `tg777000@telegram.fitpro` } })
    }
    if (u.pathname.startsWith('/auth/v1/user')) {
      const auth = opts.headers?.get?.('authorization') || opts.headers?.Authorization || ''
      if (!String(auth).includes('good-token')) return json({ msg: 'invalid token' }, 401)
      return json({ id: USER, aud: 'authenticated' })
    }

    // ── error_log
    if (u.pathname.startsWith('/rest/v1/error_log')) {
      if ((opts.method || 'GET') === 'POST') {
        if (insertFails) return json({ message: 'insert failed' }, 400)
        const body = JSON.parse(opts.body)
        const row = { id: nextId++, created_at: new Date().toISOString(), ...body }
        st.inserted.push(row)
        rows.push(row)
        return json([{ id: row.id }])
      }
      // GET — проверка «была ли такая ошибка за последний час».
      const ctx = (u.searchParams.get('context') || '').replace(/^eq\./, '')
      const since = (u.searchParams.get('created_at') || '').replace(/^gte\./, '')
      const notId = (u.searchParams.get('id') || '').replace(/^neq\./, '')
      st.quietQueries.push({ ctx, notId })
      const hit = rows.filter(r =>
        r.context === ctx
        && r.created_at >= since
        && (!notId || String(r.id) !== String(notId)))
      return json(hit.slice(0, 1).map(r => ({ id: r.id })))
    }

    // ── motion_log: приёмник телеметрии беты (ветка ?action=motion-log)
    if (u.pathname.startsWith('/rest/v1/motion_log')) {
      st.motion.push(JSON.parse(opts.body))
      return json([{ id: nextId++ }])
    }

    if (u.pathname.startsWith('/rest/v1/profiles')) return json([])
    throw new Error(`неожиданный путь: ${u.pathname}`)
  }
  return st
}
const restore = () => { globalThis.fetch = REAL_FETCH }

const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString()

// ══════════════════════════════════════════════════════════════════════════
// 1. Защита от шторма: одна поломка — одно сообщение в час
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Защита от шторма ───────────────────────────────────────────────')
{
  // Первая ошибка этого вида за час — журнал пуст, значит кричим.
  const st = stub()
  await logServerError('api:chat', { message: 'Anthropic 529' })
  restore()
  assertEqual('первая ошибка: строка легла в журнал', st.inserted.length, 1)
  assertEqual('первая ошибка: контекст записан', st.inserted[0]?.context, 'api:chat')
  assertEqual('первая ошибка: тренеру ушло сообщение', st.sent.length, 1)
  report('текст сообщения — контекст и суть', /api:chat/.test(st.sent[0]?.text) && /529/.test(st.sent[0]?.text), st.sent[0]?.text)
  report('в тексте есть значок тревоги', String(st.sent[0]?.text).startsWith('⚠'), st.sent[0]?.text)
}
{
  // ГЛАВНЫЙ ТЕСТ. Такая же ошибка 10 минут назад уже была — второго сообщения
  // быть не должно, а вот запись обязана лечь.
  const rows = [{ id: 1, created_at: hoursAgo(0.17), context: 'api:chat' }]
  const st = stub({ rows })
  await logServerError('api:chat', { message: 'Anthropic 529 снова' })
  restore()
  assertEqual('повтор за час: строка ВСЁ РАВНО легла', st.inserted.length, 1)
  assertEqual('повтор за час: ВТОРОГО сообщения нет', st.sent.length, 0)
}
{
  // Три подряд — журнал полон, сообщение одно (от первой).
  const st = stub()
  await logServerError('api:chat', { message: 'раз' })
  await logServerError('api:chat', { message: 'два' })
  await logServerError('api:chat', { message: 'три' })
  restore()
  assertEqual('три ошибки подряд: три строки в журнале', st.inserted.length, 3)
  assertEqual('три ошибки подряд: сообщение ОДНО', st.sent.length, 1)
}
{
  // Час прошёл — можно снова.
  const rows = [{ id: 1, created_at: hoursAgo(2), context: 'api:chat' }]
  const st = stub({ rows })
  await logServerError('api:chat', { message: 'спустя два часа' })
  restore()
  assertEqual('старше часа: сообщение уходит снова', st.sent.length, 1)
}
{
  // ДРУГОЙ КОНТЕКСТ — другая поломка, о ней надо знать отдельно.
  const rows = [{ id: 1, created_at: hoursAgo(0.1), context: 'api:chat' }]
  const st = stub({ rows })
  await logServerError('api:prodamus:grant', { message: 'пакет не начислен' })
  restore()
  assertEqual('другой контекст: сообщение ушло', st.sent.length, 1)
  report('и оно про свой контекст', /prodamus:grant/.test(st.sent[0]?.text), st.sent[0]?.text)
}
{
  // Тишина считается ПО КОНТЕКСТУ, а не по журналу целиком: две разные
  // поломки в одну минуту — два сообщения.
  const st = stub()
  await logServerError('api:chat', { message: 'раз' })
  await logServerError('api:telegram-auth', { message: 'два' })
  restore()
  assertEqual('две разные поломки: два сообщения', st.sent.length, 2)
}
{
  // Проверка «была ли такая» обязана исключать ТОЛЬКО ЧТО записанную строку.
  // Без этого своя же запись всегда находилась бы, и сигнал не ушёл бы НИ РАЗУ.
  const st = stub()
  await logServerError('api:chat', { message: 'первая в истории' })
  restore()
  assertEqual('запрос тишины исключает свою же строку', st.quietQueries[0]?.notId, String(st.inserted[0]?.id))
}

// ══════════════════════════════════════════════════════════════════════════
// 2. Журнал важнее сигнала
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Сбой уведомления не ломает запись ──────────────────────────────')
{
  const st = stub({ tgFails: true })
  await logServerError('api:chat', { message: 'Telegram ответит 400' })
  restore()
  assertEqual('Telegram вернул ошибку: строка в журнале есть', st.inserted.length, 1)
  report('попытка отправки всё же была', st.sent.length === 1)
}
{
  const st = stub({ tgThrows: true })
  await logServerError('api:chat', { message: 'сеть до Telegram легла' })
  restore()
  assertEqual('сеть до Telegram упала: строка в журнале есть', st.inserted.length, 1)
}
{
  // Токена бота нет вовсе — как на стенде.
  const saved = process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_BOT_TOKEN
  const st = stub()
  await logServerError('api:chat', { message: 'без токена бота' })
  restore()
  process.env.TELEGRAM_BOT_TOKEN = saved
  assertEqual('без токена бота: строка в журнале есть', st.inserted.length, 1)
  assertEqual('без токена бота: никуда не ходили', st.sent.length, 0)
}
{
  // У тренера нет chat_id — сообщать некуда, но записать надо.
  const st = stub({ noTrainerChat: true })
  await logServerError('api:chat', { message: 'тренер без телеграма' })
  restore()
  assertEqual('нет chat_id: строка в журнале есть', st.inserted.length, 1)
  assertEqual('нет chat_id: сообщение не ушло', st.sent.length, 0)
}
{
  // Сама вставка не удалась — уведомлять не о чем, и падать нельзя.
  const st = stub({ insertFails: true })
  let threw = false
  try { await logServerError('api:chat', { message: 'вставка не прошла' }) } catch { threw = true }
  restore()
  report('сбой вставки: функция не бросила', !threw)
  assertEqual('сбой вставки: сообщение не ушло', st.sent.length, 0)
}
{
  // Полное отсутствие сервисного ключа — ручка обязана работать дальше.
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  let threw = false
  const st = stub()
  try { await logServerError('api:chat', { message: 'без ключа' }) } catch { threw = true }
  restore()
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved
  report('без сервисного ключа: не бросили', !threw)
  assertEqual('без сервисного ключа: в базу не ходили', st.inserted.length, 0)
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Что попадает в журнал и в сообщение
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Содержимое записи ──────────────────────────────────────────────')
{
  const st = stub()
  await logServerError('api:chat', { message: 'x'.repeat(900), status: 503, userId: USER })
  restore()
  const row = st.inserted[0]
  assertEqual('длинный текст обрезан до 500', row?.message?.length, 500)
  assertEqual('статус записан числом', row?.status, 503)
  assertEqual('user_id записан', row?.user_id, USER)
  report('в Telegram ушёл ОБРЕЗАННЫЙ текст (200), а не весь',
    st.sent[0]?.text.length < 260, `длина ${st.sent[0]?.text.length}`)
}
{
  const st = stub()
  await logServerError('api:chat', { message: 'без пользователя' })
  restore()
  assertEqual('без userId пишем null, а не мусор', st.inserted[0]?.user_id, null)
}
{
  const st = stub()
  await logServerError('api:chat', { message: 'кривой userId', userId: 'не-uuid' })
  restore()
  assertEqual('не-UUID в userId отбрасывается', st.inserted[0]?.user_id, null)
}
{
  const st = stub()
  await logServerError('c'.repeat(300), { message: 'длинный контекст' })
  restore()
  assertEqual('контекст обрезан до 100', st.inserted[0]?.context?.length, 100)
}
{
  const st = stub()
  await logServerError('', { message: 'без контекста' })
  restore()
  assertEqual('пустой контекст → unknown', st.inserted[0]?.context, 'unknown')
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Ветка ?action=log-error
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Ветка ?action=log-error ────────────────────────────────────────')

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, ended: false }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.status = n => { r.statusCode = n; return r }
  r.json = b => { r.body = b; r.ended = true; return r }
  r.end = () => { r.ended = true; return r }
  return r
}
let ip = 0
const req = (body, { auth = 'Bearer good-token' } = {}) => ({
  method: 'POST',
  query: { action: 'log-error' },
  body,
  headers: { 'x-real-ip': `10.9.0.${++ip}`, ...(auth ? { authorization: auth } : {}) },
  socket: {},
})

{
  const st = stub()
  const res = mockRes()
  await handler(req({ context: 'ui:diary', message: 'не загрузился день', status: 500 }), res)
  restore()
  assertEqual('с токеном: 200', res.statusCode, 200)
  assertEqual('с токеном: строка записана', st.inserted.length, 1)
  assertEqual('с токеном: контекст клиента сохранён', st.inserted[0]?.context, 'ui:diary')
  assertEqual('с токеном: user_id взят ИЗ ТОКЕНА, а не из тела', st.inserted[0]?.user_id, USER)
  assertEqual('с токеном: тренеру ушло уведомление', st.sent.length, 1)
}
{
  // ГЛАВНОЕ ПРО ДОСТУП: без токена не пишем НИЧЕГО.
  const st = stub()
  const res = mockRes()
  await handler(req({ context: 'ui:diary', message: 'аноним' }, { auth: null }), res)
  restore()
  assertEqual('без токена → 401', res.statusCode, 401)
  assertEqual('без токена: в журнал НИЧЕГО не записано', st.inserted.length, 0)
  assertEqual('без токена: никого не разбудили', st.sent.length, 0)
}
{
  // Токен есть, но негодный.
  const st = stub()
  const res = mockRes()
  await handler(req({ context: 'ui:diary' }, { auth: 'Bearer bad-token' }), res)
  restore()
  assertEqual('негодный токен → 401', res.statusCode, 401)
  assertEqual('негодный токен: в журнал ничего не записано', st.inserted.length, 0)
}
{
  // Клиент не может подделать чужой user_id: он берётся из токена.
  const st = stub()
  const res = mockRes()
  await handler(req({ context: 'ui:x', user_id: TRAINER }), res)
  restore()
  assertEqual('user_id из тела игнорируется', st.inserted[0]?.user_id, USER)
}
{
  // Ветка тоже под защитой от шторма: клиент в цикле перерисовки не должен
  // будить тренера сотню раз.
  const rows = [{ id: 1, created_at: hoursAgo(0.1), context: 'ui:diary' }]
  const st = stub({ rows })
  const res = mockRes()
  await handler(req({ context: 'ui:diary', message: 'опять' }), res)
  restore()
  assertEqual('повтор из клиента: запись есть', st.inserted.length, 1)
  assertEqual('повтор из клиента: сообщения нет', st.sent.length, 0)
}
{
  // Пустой контекст от клиента не должен ронять ветку.
  const st = stub()
  const res = mockRes()
  await handler(req({ message: 'без контекста' }), res)
  restore()
  assertEqual('клиент без контекста: 200', res.statusCode, 200)
  assertEqual('клиент без контекста: подставлен ui:unknown', st.inserted[0]?.context, 'ui:unknown')
}
{
  // Сбой журнала не имеет права превращаться в 500 для клиента: он всё равно
  // ничего с этим не сделает, а лишний красный ответ в консоли браузера
  // выглядит как вторая поломка.
  const st = stub({ insertFails: true })
  const res = mockRes()
  await handler(req({ context: 'ui:diary' }), res)
  restore()
  assertEqual('сбой записи: клиенту всё равно 200', res.statusCode, 200)
  assertEqual('сбой записи: ничего не записано', st.inserted.length, 0)
}

// ══════════════════════════════════════════════════════════════════════════
// 5. ТРЕВОГА ПО БЕТЕ MOTION — свой бот, свой чат, своя тишина
//
// Отдельный канал от уведомлений тренеру: те про приложение целиком, эта про
// бету и адресована тому, кто её ведёт. Поводов два, и оба приезжают в эту же
// ручку — упавшее у человека приложение и нажатая им кнопка «Сообщить о
// проблеме».
//
// ГЛАВНОЕ, ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ: тревога не имеет права ни задержать ответ
// ручки, ни уронить его. Телефон, отправивший лог, не должен ждать Телеграм, а
// упавший Телеграм не должен ронять приём журнала.
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Тревога по бете Motion ─────────────────────────────────────────')

/** Отправка не ожидается вызовом — даём микрозадачам добежать. */
const догнать = () => new Promise((r) => setTimeout(r, 0))

const motionReq = (lines, { auth = 'Bearer good-token' } = {}) => ({
  method: 'POST',
  query: { action: 'motion-log' },
  body: { session: 'session-20260819-120000', lines },
  headers: { 'x-real-ip': `10.9.1.${++ip}`, ...(auth ? { authorization: auth } : {}) },
  socket: {},
})

const ЖАЛОБА = '2026-08-19T12:00:00.000Z [user.report] {"screen":"fight","fps":21,"cheap":true}'
const ОБЫЧНАЯ = '2026-08-19T12:00:01.000Z [snapshot] {"screen":"fight","fps":21}'

{
  // Без переменных окружения тревога молчит и ничего не ломает.
  delete process.env.TG_ALERT_TOKEN
  delete process.env.TG_ALERT_CHAT
  const st = stub()
  const res = mockRes()
  await handler(motionReq([ЖАЛОБА]), res)
  await догнать()
  restore()
  assertEqual('без TG_ALERT_*: ответ 200', res.statusCode, 200)
  assertEqual('без TG_ALERT_*: запись легла', st.motion.length, 1)
  assertEqual('без TG_ALERT_*: никуда не ходили', st.sent.length, 0)
}

process.env.TG_ALERT_TOKEN = 'alert-bot-token'
process.env.TG_ALERT_CHAT = '424242'

{
  // Жалоба человека — тревога уходит, и в ней сама строка снимка.
  const st = stub()
  const res = mockRes()
  await handler(motionReq([ОБЫЧНАЯ, ЖАЛОБА]), res)
  await догнать()
  restore()
  assertEqual('жалоба: ответ 200', res.statusCode, 200)
  assertEqual('жалоба: строки легли в motion_log', st.motion[0]?.payload?.lines?.length, 2)
  assertEqual('жалоба: тревога ушла', st.sent.length, 1)
  assertEqual('жалоба: в тот самый чат', st.sent[0]?.chat_id, '424242')
  report('жалоба: в тексте снимок состояния', /user\.report/.test(st.sent[0]?.text) && /fight/.test(st.sent[0]?.text), st.sent[0]?.text)
}
{
  // ГЛАВНЫЙ ТЕСТ ТИШИНЫ. Вторая жалоба сразу же — сообщения быть не должно, а
  // запись обязана лечь: глушится сигнал, не журнал.
  const st = stub()
  const res = mockRes()
  await handler(motionReq([ЖАЛОБА]), res)
  await догнать()
  restore()
  assertEqual('вторая жалоба подряд: запись ВСЁ РАВНО легла', st.motion.length, 1)
  assertEqual('вторая жалоба подряд: второго сообщения нет', st.sent.length, 0)
}
{
  // Лог без жалобы тревогу не поднимает вовсе — иначе кричали бы на каждый
  // снимок состояния, которых за сессию сотни.
  const st = stub()
  const res = mockRes()
  await handler(motionReq([ОБЫЧНАЯ]), res)
  await догнать()
  restore()
  assertEqual('лог без жалобы: запись есть', st.motion.length, 1)
  assertEqual('лог без жалобы: тревоги нет', st.sent.length, 0)
}
{
  // ОШИБКА — ДРУГОЙ ТИП, и своя тишина. Жалоба только что заглушила свой тип,
  // ошибка обязана пройти: это разные поломки, и знать о них надо по отдельности.
  const st = stub()
  const res = mockRes()
  await handler(req({ context: 'ui:motion', message: 'упало у человека' }), res)
  await догнать()
  restore()
  assertEqual('ошибка: ответ 200', res.statusCode, 200)
  // Первое сообщение — тренеру (_logError), второе — в канал беты.
  const беты = st.sent.filter((m) => String(m.chat_id) === '424242')
  assertEqual('ошибка: тревога по бете ушла', беты.length, 1)
  report('ошибка: в тексте контекст и суть', /ui:motion/.test(беты[0]?.text) && /упало/.test(беты[0]?.text), беты[0]?.text)
}
{
  // Повтор ошибки — тишина по своему типу.
  const st = stub()
  const res = mockRes()
  await handler(req({ context: 'ui:motion', message: 'опять упало' }), res)
  await догнать()
  restore()
  const беты = st.sent.filter((m) => String(m.chat_id) === '424242')
  assertEqual('повтор ошибки: второй тревоги по бете нет', беты.length, 0)
}
{
  // ТЕЛЕГРАМ ЛЁГ. Тишина по этому типу к этому моменту уже стоит, так что до
  // сети дело и не дойдёт, — но проверяется здесь не она, а то, что ответ
  // ручки остаётся прежним при любой поломке снаружи.
  const st = stub({ tgThrows: true })
  const res = mockRes()
  await handler(motionReq([ЖАЛОБА]), res)
  await догнать()
  restore()
  assertEqual('Телеграм недоступен: клиенту всё равно 200', res.statusCode, 200)
  assertEqual('Телеграм недоступен: запись легла', st.motion.length, 1)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(68))
console.log(`Итог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
