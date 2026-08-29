// Журнал событий приложения — своя продуктовая аналитика, без чужих сервисов.
//
// Зачем. До сих пор про поведение людей известно ровно ничего: src/funnel.js
// считает одиннадцать анонимных счётчиков по челленджу и не знает, кто что
// сделал, а серверные логи одностраничного приложения не видят ни экранов, ни
// нажатий. Отсюда невозможно ответить на главный вопрос: люди заходят — и где
// именно уходят.
//
// Что уходит наружу: НИЧЕГО. Приёмник — своя же ручка, база своя.
//
// Что кладём в событие: имя из списка ниже, экран и маленький набор коротких
// значений (ключ программы, номер тренировки, название тарифа). Свободного
// текста человека здесь быть не должно никогда — ни еды из дневника, ни
// сообщений ассистенту, ни имён. За этим следит sanitizeProps, и такой же
// барьер стоит на сервере: клиенту тут не доверяем.
//
// Как отправляем: пачкой и «бросил-забыл». Ни одно событие не имеет права
// задержать экран или сломать заход — человек пришёл тренироваться, а не
// помогать нам считать.

/** Адрес приёмника — ветка существующей ручки, новых файлов в api/ не заводим. */
export const ENDPOINT = '/api/set-exercise?action=events'

/**
 * Полный список событий. Незнакомое имя приёмник молча отбросит — список
 * держим здесь, чтобы он был виден в одном месте и не расползался по коду.
 *
 * Порядок — как в пути человека, от захода до оплаты.
 */
export const EVENT_NAMES = [
  // заход
  'app_open',          // приложение открыто (раз в сутки на человека)
  'app_open_guest',    // то же, но гостем
  'screen',            // смена экрана; props: { name }
  // программы
  'programs_open',     // открыт список программ
  'program_open',      // открыта программа; props: { key }
  'program_pick',      // программа выбрана себе; props: { key }
  'slot_open',         // открыта карточка тренировки; props: { key, slot }
  'slot_locked',       // упёрся в закрытую тренировку; props: { key, slot }
  // тренировка
  'workout_start',     // нажал «начать»; props: { key, slot }
  'workout_finish',    // завершил; props: { key, slot, sets }
  'workout_quit',      // ушёл, не завершив; props: { key, slot }
  'rating_set',        // поставил оценку нагрузки; props: { value }
  'video_play',        // включил ролик упражнения
  // деньги
  'paywall',           // показана стена оплаты; props: { where }
  'plans_open',        // открыт экран тарифов
  'plan_click',        // выбрал тариф; props: { plan }
  'pay_start',         // ушёл на оплату; props: { plan }
  'pay_done',          // оплата подтверждена; props: { plan }
  // что сломалось
  'load_fail',         // что-то не загрузилось; props: { what }
  'error_shown',       // человеку показана ошибка; props: { kind }
]

const KNOWN = new Set(EVENT_NAMES)

/** События, которые считаем раз в сутки на человека, а не на каждый показ. */
export const DAILY = new Set(['app_open', 'app_open_guest'])

/** Ограничения на свойства события. Всё, что не влезло, отбрасываем молча. */
export const MAX_PROPS = 8
export const MAX_STR = 40
export const MAX_BATCH = 40
export const FLUSH_MS = 4000

/**
 * Оставляет только короткие скаляры. Строку длиннее MAX_STR режем — это не
 * забота о месте, а барьер: свободный текст человека в аналитику не попадает
 * даже по ошибке разработчика.
 */
export function sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null
  const out = {}
  let n = 0
  for (const k of Object.keys(props)) {
    if (n >= MAX_PROPS) break
    if (!/^[a-z][a-z0-9_]{0,19}$/.test(k)) continue
    const v = props[k]
    if (v == null) continue
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; n++; continue }
    if (typeof v === 'boolean') { out[k] = v; n++; continue }
    if (typeof v === 'string') {
      const s = v.trim()
      if (!s) continue
      out[k] = s.length > MAX_STR ? s.slice(0, MAX_STR) : s
      n++
    }
  }
  return n ? out : null
}

export function isKnownEvent(name) {
  return KNOWN.has(name)
}

const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * Собирает трекер. Все зависимости — снаружи, поэтому модуль проверяется
 * тестами без браузера и без сети.
 *
 * post(body)  — отправка; должна сама глушить ошибки
 * store       — долгая память (localStorage): { get, set }
 * sess        — память вкладки (sessionStorage): { get, set }
 * now()       — время в мс
 * schedule(fn, ms) → отменяющая функция
 */
export function createTracker({ post, store, sess, now = Date.now, schedule }) {
  let queue = []
  let cancel = null

  const day = () => new Date(now()).toISOString().slice(0, 10)

  const anonId = () => {
    let id = store.get('fitpro_anon')
    if (!id) { id = rid(); store.set('fitpro_anon', id) }
    return id
  }
  const sessionId = () => {
    let id = sess.get('fitpro_sess')
    if (!id) { id = rid(); sess.set('fitpro_sess', id) }
    return id
  }

  function flush() {
    if (cancel) { cancel(); cancel = null }
    if (!queue.length) return
    const batch = queue
    queue = []
    post({ events: batch })
  }

  function track(name, props, path) {
    if (!isKnownEvent(name)) return false
    if (DAILY.has(name)) {
      const key = `fitpro_ev_${name}_${day()}`
      if (store.get(key)) return false
      store.set(key, '1')
    }
    queue.push({
      name,
      ts: new Date(now()).toISOString(),
      anon: anonId(),
      sess: sessionId(),
      path: typeof path === 'string' ? path.slice(0, 60) : null,
      props: sanitizeProps(props),
    })
    if (queue.length >= MAX_BATCH) { flush(); return true }
    if (!cancel) cancel = schedule(flush, FLUSH_MS)
    return true
  }

  return { track, flush, pending: () => queue.length }
}

/**
 * Как приложение сообщает журналу, кто сейчас вошёл.
 *
 * Токен НЕ хранится здесь и не кладётся ни в какую cookie: cookie
 * прикладывалась бы браузером ко всем запросам к /api и стала бы постоянным
 * носителем доступа там, где его раньше не было. Ради счётчика посещений это
 * плохой размен. Вместо неё — обычный заголовок и fetch с keepalive: он, как и
 * sendBeacon, переживает уход со страницы (ограничение там 64 КБ на тело, у
 * нас пачка в пару килобайт), но заголовки умеет.
 *
 * Передаётся функция, а не строка: токен меняется при входе и выходе, и
 * журнал должен видеть текущий, а не тот, что был на момент загрузки.
 */
let authGetter = null
export function setAuth(fn) { authGetter = typeof fn === 'function' ? fn : null }

/** Ленивый одиночка на браузерных глобалях. Всё в try — счётчик не имеет права уронить приложение. */
let singleton = null
function browserTracker() {
  if (singleton) return singleton
  const safe = obj => ({
    get: k => { try { return obj.getItem(k) } catch { return null } },
    set: (k, v) => { try { obj.setItem(k, v) } catch { /* приватный режим */ } },
  })
  singleton = createTracker({
    store: safe(globalThis.localStorage || {}),
    sess: safe(globalThis.sessionStorage || {}),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    post: body => {
      try {
        const headers = { 'Content-Type': 'application/json' }
        let token = null
        try { token = authGetter ? authGetter() : null } catch { token = null }
        if (token) headers.Authorization = `Bearer ${token}`
        fetch(ENDPOINT, {
          method: 'POST', headers,
          body: JSON.stringify(body),
          keepalive: true,
          // Журнал не читает ответ и не должен таскать никаких кук
          credentials: 'omit',
        }).catch(() => {})
      } catch { /* молчим */ }
    },
  })
  return singleton
}

/** Отметить событие. Никогда не бросает и ничего не ждёт. */
export function track(name, props, path) {
  try { return browserTracker().track(name, props, path) } catch { return false }
}

/** Досрочно отправить накопленное — вешается на уход со страницы. */
export function flush() {
  try { browserTracker().flush() } catch { /* молчим */ }
}
