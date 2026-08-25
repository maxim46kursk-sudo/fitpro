/**
 * ПРОГРЕСС ЖИВЁТ НА СЕРВЕРЕ, А НА УСТРОЙСТВЕ ЛЕЖИТ ЕГО КЭШ.
 *
 * Зачем. До сих пор весь челлендж — день, сданные дни, попытки, личные планки,
 * рекорд — жил только в localStorage браузера. Очищенный кэш, новый телефон,
 * другой браузер на том же телефоне — и тридцать дней работы человека исчезали
 * без следа. На кону деньги: челлендж платный.
 *
 * ПОЧЕМУ КЭШ ОСТАЁТСЯ, А НЕ ЗАМЕНЯЕТСЯ ЗАПРОСАМИ. Игра читает прогресс
 * СИНХРОННО и из горячих мест: ленивые инициализаторы useState, сборка сессии,
 * подсчёт попыток между кругами. Сделать эти чтения сетевыми — значит поставить
 * сеть между человеком и его тренировкой. Поэтому порядок такой: сервер
 * прочитан ОДИН раз до входа в раздел, положен в кэш, а дальше всё как было.
 *
 * ЗАПИСЬ НИКОГДА НЕ ЖДЁТ СЕТИ. Сначала кэш — синхронно, как сегодня, — и только
 * потом фоновая отправка с повторами. Тренировка не имеет права ни тормозить,
 * ни падать из-за сети: человек стоит перед камерой и работает.
 *
 * МОДУЛЬ НЕ ЗНАЕТ, ГДЕ БАЗА. Ни Supabase, ни ручек, ни адресов: хозяин передаёт
 * три функции (`configureSync`), и папку src/motion по-прежнему можно скопировать
 * целиком в любой проект.
 */

import { KEYS, SYNCED_KEYS, readJson, readRaw, writeJson, writeRaw, watchWrites, clearAll } from './storage.js'
import { logEvent } from './debug/logShipper.js'

/** Сколько ждём, прежде чем отправить накопленные правки. */
const PUSH_DEBOUNCE_MS = 1500
/** Паузы между повторами отправки: секунда, пять, полминуты. */
const RETRY_MS = [1000, 5000, 30000]

/**
 * Отметка времени последнего изменения прогресса НА ЭТОМ устройстве. Живёт
 * внутри самого payload, а не отдельным ключом: так она едет на сервер вместе с
 * данными и не может от них отстать.
 */
const STAMP = 'updatedAt'

/**
 * ЗДОРОВЬЕ ОБМЕНА — ОТДЕЛЬНО ОТ ДАННЫХ, И ЭТО ГЛАВНОЕ ЗДЕСЬ.
 *
 * Раздел переживает и неудачную загрузку, и неудачную отправку: кэш не пустой,
 * играть по нему можно, и молча падать в белый экран было бы хуже. Но у
 * челленджа на кону призы, и человек обязан ЗНАТЬ, что игра считает не по тем
 * данным, которые лежат на сервере: двадцать минут работы, которые потом не
 * сойдутся с общей таблицей, — это спор о деньгах, а не мелкое неудобство.
 *
 * Поэтому состояние обмена живёт здесь и рассылается наружу:
 *   `loaded` — прогресс с сервера прочитан. false — играем по последнему
 *     сохранённому на этом устройстве;
 *   `pushFailed` — результат не уехал наверх, все повторы кончились. Он не
 *     потерян (лежит в кэше и поедет со следующей записью), но пока его на
 *     сервере нет.
 */
const health = { loaded: true, pushFailed: false }
const healthWatchers = new Set()

/** Текущее состояние обмена. Копией: снаружи его менять некому. */
export const syncHealth = () => ({ ...health })

/** Подписаться на изменения состояния обмена. Возвращает отписку. */
export function onSyncHealth(fn) {
  healthWatchers.add(fn)
  return () => healthWatchers.delete(fn)
}

function setHealth(patch) {
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (health[key] !== value) {
      health[key] = value
      changed = true
    }
  }
  if (!changed) return
  const snapshot = syncHealth()
  // слушатель не имеет права уронить обмен: он всего лишь рисует полосу
  for (const fn of healthWatchers) {
    try { fn(snapshot) } catch { /* экран переживёт */ }
  }
}

/**
 * Загрузка не удалась ВНЕ hydrate — например, выбросом по дороге. Помечаем то
 * же самое состояние: человеку всё равно, на каком шаге оборвалось.
 */
export const noteLoadFailed = () => setHealth({ loaded: false })

let backend = null
let unwatch = null
let pushTimer = null
/**
 * ИДУЩАЯ ОТПРАВКА — обещанием, а не булевым флагом.
 *
 * Раньше здесь стоял `pushing = true/false`, и повторный вызов во время
 * отправки просто возвращал undefined: дождаться его было нельзя. Комнате
 * участника это стоило дорого — она читала таблицу потока РАНЬШЕ, чем заход
 * успевал уехать наверх, и человек видел у себя тысячу очков, а в таблице ноль.
 * Теперь тот, кто позвал push во время отправки, получает ту же самую отправку
 * и может её дождаться (см. flushPush ниже).
 */
let inflight = null
/** Попытки, про которые сервер уже знает: `${day}:${tier}:${no}`. */
const knownAttempts = new Set()

/**
 * Подключить хранилище хозяина.
 *
 * @param {object} api
 * @param {() => Promise<{progress: object|null, attempts: Array}|null>} api.load
 *   null — ОШИБКА загрузки, а не «данных нет». Разница принципиальная, см. hydrate.
 * @param {(payload: object) => Promise<void>} api.saveProgress
 * @param {(rows: Array) => Promise<void>} api.saveAttempts
 * @returns {() => void} отключить
 */
export function configureSync(api) {
  backend = api || null
  return () => {
    backend = null
  }
}

/** Собрать прогресс устройства в один объект — то, что уедет в базу. */
export function collectProgress() {
  return {
    /**
     * Отметки нет — значит она НЕИЗВЕСТНА, а не «сейчас».
     *
     * Подставь мы сюда текущее время, пустой кэш нового устройства оказывался бы
     * свежее сервера и побеждал бы в сравнении: человек заходил со второго
     * телефона и получал чистый лист вместо своего челленджа, а следующая
     * отправка уносила эту пустоту наверх. Именно так и вышло на прогоне.
     */
    [STAMP]: readRaw(`${KEYS.challenge}.stamp`) || null,
    challenge: readJson(KEYS.challenge),
    attempts: readJson(KEYS.challengeAttempts),
    unlocked: readRaw(KEYS.challengeUnlocked) === '1',
    best: Number(readRaw(KEYS.best)) || 0,
    personal: readJson(KEYS.personal),
    thresholds: readJson(KEYS.thresholds),
  }
}

/** Разложить прогресс с сервера по местам, откуда его читает игра. */
export function applyProgress(payload) {
  if (!payload || typeof payload !== 'object') return
  if (payload.challenge) writeJson(KEYS.challenge, payload.challenge)
  if (payload.attempts) writeJson(KEYS.challengeAttempts, payload.attempts)
  if (payload.unlocked) writeRaw(KEYS.challengeUnlocked, '1')
  if (payload.best > 0) writeRaw(KEYS.best, String(payload.best))
  if (payload.personal) writeJson(KEYS.personal, payload.personal)
  if (payload.thresholds) writeJson(KEYS.thresholds, payload.thresholds)
  writeRaw(`${KEYS.challenge}.stamp`, payload[STAMP] || new Date().toISOString())
}

/** Есть ли на устройстве хоть что-то, что стоит поднимать наверх. */
export function hasLocalProgress(p = collectProgress()) {
  const days = p.challenge?.done?.length || 0
  const attempts = Object.keys(p.attempts?.days || {}).length
  return days > 0 || attempts > 0 || p.best > 0 || !!p.personal || p.unlocked
}

/**
 * ЧЬИ ДАННЫЕ СВЕЖЕЕ. Сравниваются отметки времени: у прогресса она одна на
 * весь объект, потому что его правит один человек с одного телефона за раз.
 *
 * Попытки сюда не входят вовсе — они только добавляются и сливаются
 * объединением (см. mergeAttempts): затирать их «свежестью» нельзя, иначе
 * тренировка со второго телефона стёрла бы тренировку с первого.
 */
export function newerOf(local, remote) {
  const l = Date.parse(local?.[STAMP] || '') || 0
  const r = Date.parse(remote?.[STAMP] || '') || 0
  return r > l ? remote : local
}

/**
 * Слить попытки двух устройств. Только объединение, ничего не выбрасываем:
 * попытка — это будущий предмет спора о деньгах.
 *
 * СЧЁТЧИК ЗАХОДОВ (`started`) сливается максимумом. Он не данные, а номер
 * трассы: если взять меньший, человек на втором телефоне получил бы трассу,
 * которую уже проходил на первом, — то есть ровно ту беду, ради которой счётчик
 * и заведён.
 *
 * ЧЕРНОВИК НЕЗАКРЫТОЙ ПОПЫТКИ (`pending`) не сливается вовсе и наверх не едет:
 * это состояние ОДНОГО устройства, на котором прямо сейчас идёт заход.
 * Приехавший с сервера чужой черновик закрылся бы здесь чужой попыткой.
 */
/**
 * ЧТО ПРИШЛО С СЕРВЕРА — НЕ ОБЯЗАНО БЫТЬ ТЕМ, ЧТО МЫ ТУДА КЛАЛИ.
 *
 * `payload` в базе — свободный jsonb: его писали прошлые версии раздела, его
 * может испортить чужой клиент, и однажды испорченный он приезжает КАЖДЫЙ вход.
 * Слияние на таком спотыкалось (`(list || []).filter is not a function`), а
 * выброс отсюда до этой правки означал вечную заставку: раздел не открывался
 * больше никогда, и починить это человек не мог ничем.
 *
 * Поэтому не массив — это «попыток нет», а не повод падать. Потерять чужой
 * мусор не жалко; потерять доступ к разделу — нельзя.
 */
const asList = (v) => (Array.isArray(v) ? v : [])

export function mergeAttempts(a, b) {
  const days = {}
  for (const src of [a?.days, b?.days]) {
    for (const [day, tiers] of Object.entries(src || {})) {
      days[day] = days[day] || {}
      for (const [tier, list] of Object.entries(tiers || {})) {
        const have = asList(days[day][tier])
        const seen = new Set(have.map((x) => `${x?.at}|${x?.score}`))
        days[day][tier] = [
          ...have,
          ...asList(list).filter((x) => !seen.has(`${x?.at}|${x?.score}`)),
        ]
      }
    }
  }
  const started = {}
  for (const src of [a?.started, b?.started]) {
    for (const [day, tiers] of Object.entries(src || {})) {
      started[day] = started[day] || {}
      for (const [tier, n] of Object.entries(tiers || {})) {
        started[day][tier] = Math.max(Number(started[day][tier]) || 0, Number(n) || 0)
      }
    }
  }
  // счётчик не может отставать от того, что уже записано
  for (const [day, tiers] of Object.entries(days)) {
    for (const [tier, list] of Object.entries(tiers)) {
      started[day] = started[day] || {}
      started[day][tier] = Math.max(Number(started[day][tier]) || 0, asList(list).length)
    }
  }
  return { days, started }
}

/** Строки попыток для отдельной таблицы — из общего хранилища попыток. */
export function attemptRows(attempts) {
  const rows = []
  for (const [day, tiers] of Object.entries(attempts?.days || {})) {
    for (const [tier, list] of Object.entries(tiers || {})) {
      asList(list).forEach((a, i) => {
        rows.push({
          day: Number(day),
          tier,
          attempt_no: i + 1,
          score: a.score ?? 0,
          reps: a.reps ?? 0,
          hits: a.hits ?? 0,
          spawned: a.spawned ?? 0,
          react_ms: a.reactMs ?? 0,
          at: a.at || new Date().toISOString(),
        })
      })
    }
  }
  return rows
}

/**
 * ЗАГРУЗИТЬ ПРОГРЕСС ПЕРЕД ВХОДОМ В РАЗДЕЛ.
 *
 * @param {string|null} userId кому принадлежит кэш сейчас
 * @returns {Promise<{ok: boolean, why: string}>}
 */
export async function hydrate(userId) {
  /**
   * ЧУЖОЙ КЭШ СТИРАЕТСЯ ДО ВСЕГО ОСТАЛЬНОГО.
   *
   * Телефон бывает общим, а ключи Motion переживают выход из аккаунта: уборщик
   * FitPro фильтрует по `fitpro_` через подчёркивание, у нас префикс через
   * дефис. Без этой проверки второй человек увидел бы чужой день, чужие рекорды
   * и чужие попытки — и, что хуже, его собственная тренировка легла бы поверх
   * них и уехала на сервер уже под его именем.
   */
  const owner = readRaw(KEYS.owner)
  if (userId && owner && owner !== userId) {
    clearAll()
    logEvent('sync.owner-changed', {})
  }
  if (userId) writeRaw(KEYS.owner, userId)

  // без хранилища сверять не с чем: раздел работает как офлайн-игра, и
  // пугать человека полосой не за что
  if (!backend) {
    setHealth({ loaded: true, pushFailed: false })
    return { ok: true, why: 'без сервера' }
  }

  let remote
  try {
    remote = await backend.load()
  } catch {
    remote = null
  }

  /**
   * ОШИБКА ЗАГРУЗКИ — ЭТО НЕ «ДАННЫХ НЕТ».
   *
   * Разница стоит человеку его челленджа: подставь мы здесь пустой прогресс, он
   * лёг бы в кэш поверх настоящего, а следующая же запись уехала бы на сервер и
   * затёрла бы его и там. Поэтому при ошибке кэш остаётся как есть, а игра
   * открывается на нём — ровно так, как работала до переезда.
   */
  if (!remote) {
    logEvent('sync.load-failed', {})
    setHealth({ loaded: false })
    return { ok: false, why: 'сервер не ответил' }
  }

  const local = collectProgress()
  const localHas = hasLocalProgress(local)
  const remoteHas = remote.progress && Object.keys(remote.progress).length > 0

  if (!remoteHas && localHas) {
    /**
     * ПЕРЕНОС ТОГО, ЧТО УЖЕ ЕСТЬ. Человек играл до переезда, и его прогресс
     * лежит только здесь. Сервер пуст не потому, что играть не начинали, а
     * потому, что складывать было некуда.
     */
    logEvent('sync.migrate-up', { days: local.challenge?.done?.length || 0 })
    setHealth({ loaded: true })
    await push({ force: true })
    return { ok: true, why: 'локальный прогресс поднят наверх' }
  }

  if (remoteHas) {
    const merged = {
      ...newerOf(local, remote.progress),
      // попытки — всегда объединением, независимо от свежести остального
      attempts: mergeAttempts(local.attempts, remote.progress.attempts),
    }
    applyProgress(merged)
    for (const r of attemptRows(merged.attempts)) {
      knownAttempts.add(`${r.day}:${r.tier}:${r.attempt_no}`)
    }
    // то, что пришло с сервера, серверу возвращать незачем — но если слияние
    // добавило локальные попытки, они уедут наверх следующей же отправкой
    schedulePush()
  }

  logEvent('sync.ready', { remote: !!remoteHas, local: localHas })
  setHealth({ loaded: true })
  return { ok: true, why: 'прогресс загружен' }
}

/** Начать следить за записями игры и отправлять их наверх. */
export function startSync() {
  if (unwatch) return unwatch
  unwatch = watchWrites((key) => {
    if (SYNCED_KEYS.includes(key)) schedulePush()
  })
  return unwatch
}

/** Перестать следить и отдать накопленное. */
export async function stopSync() {
  unwatch?.()
  unwatch = null
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  await push()
}

function schedulePush() {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    push()
  }, PUSH_DEBOUNCE_MS)
}

/**
 * Отправить прогресс и новые попытки наверх.
 *
 * ПОВТОРЫ ЗДЕСЬ, А НЕ У ВЫЗЫВАЮЩЕГО: сеть на телефоне отваливается посреди
 * тренировки постоянно, и результат обязан доехать позже сам. Не доехал и за
 * три попытки — не беда: всё лежит в кэше, и следующая же запись или следующее
 * открытие раздела отправят его снова.
 */
export function push({ force = false } = {}) {
  if (!backend) return Promise.resolve()
  // отправка уже идёт — отдаём её же: два вызова не должны слать одно дважды
  if (inflight) return inflight
  inflight = doPush({ force }).finally(() => { inflight = null })
  return inflight
}

/**
 * ДОЖДАТЬСЯ, ЧТО НАИГРАННОЕ УЕХАЛО НАВЕРХ.
 *
 * Нужно ровно в одном месте и по одной причине: комната участника показывает
 * своё место в потоке, а место считает сервер по motion_attempts. Прочитай она
 * таблицу до того, как заход доехал, — человек увидит в комнате свою тысячу
 * очков, а в таблице ноль. Для призовых денег это недопустимо.
 *
 * Два вызова подряд, и оба нужны: первый присоединяется к идущей отправке (она
 * могла начаться до нас и не знать о последнем заходе), второй отправляет то,
 * что появилось, пока первая шла.
 */
export async function flushPush() {
  await push().catch(() => {})
  await push().catch(() => {})
}

async function doPush({ force = false } = {}) {
  /**
   * Адаптер берётся В ЛОКАЛЬНУЮ переменную и дальше используется только она.
   *
   * Отправка живёт дольше одного кадра: между `await` на попытках и записью
   * прогресса раздел успевает закрыться и отключить хранилище. Читай мы `backend`
   * после каждого ожидания — вторая половина отправки падала бы на пустом месте.
   * Ровно это и случилось: попытки уезжали, прогресс молча нет.
   */
  const api = backend
  if (!api) return
  try {
    const payload = { ...collectProgress(), [STAMP]: new Date().toISOString() }
    // Черновик незакрытой попытки — состояние этого устройства, серверу его
    // знать незачем: приехав на второй телефон, он закрылся бы там чужой
    // попыткой (см. mergeAttempts).
    if (payload.attempts?.pending) payload.attempts = { ...payload.attempts, pending: null }
    writeRaw(`${KEYS.challenge}.stamp`, payload[STAMP])

    const rows = attemptRows(payload.attempts).filter(
      (r) => force || !knownAttempts.has(`${r.day}:${r.tier}:${r.attempt_no}`),
    )

    /**
     * ПУСТОЙ КЭШ — НЕ КОМАНДА «СОТРИ ВСЁ».
     *
     * Отправлять его наверх нельзя ни при каких условиях. Пустым он бывает у
     * человека, который раздел ещё не открывал, у только что вошедшего на чужом
     * телефоне (кэш стёрт как чужой) и у того, чья загрузка не удалась. Во всех
     * трёх случаях на сервере может лежать настоящий прогресс, и запись поверх
     * него означает потерю тридцати дней.
     *
     * Ровно это и случилось на первом прогоне: попытка легла в базу, а через
     * двадцать секунд пустой payload со второго устройства затёр прогресс.
     * Затирать прогресс имеет право только сам прогресс.
     */
    const пусто = !hasLocalProgress(payload)
    if (пусто && !rows.length) return

    for (let attempt = 0; attempt <= RETRY_MS.length; attempt += 1) {
      try {
        if (rows.length) await api.saveAttempts(rows)
        if (!пусто) await api.saveProgress(payload)
        for (const r of rows) knownAttempts.add(`${r.day}:${r.tier}:${r.attempt_no}`)
        // доехало — снимаем отметку «не отправлено», в том числе поставленную
        // прошлым заходом: она про сейчас, а не про историю
        setHealth({ pushFailed: false })
        return
      } catch (error) {
        if (attempt === RETRY_MS.length) {
          logEvent('sync.push-failed', { reason: String(error?.message || error).slice(0, 120) })
          setHealth({ pushFailed: true })
          return
        }
        await new Promise((r) => setTimeout(r, RETRY_MS[attempt]))
      }
    }
  } finally {
    /* отметку о завершении снимает push(): она живёт в inflight */
  }
}

/** Забыть всё, что помнит сам модуль. Зовётся при закрытии раздела. */
export function resetSync() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  inflight = null
  knownAttempts.clear()
  /**
   * Состояние обмена сбрасывается тоже: оно про ТЕКУЩИЙ заход в раздел.
   * Оставь мы «не отправлено» с прошлого раза — человек увидел бы отметку о
   * беде, которой уже нет, и перестал бы верить ей вовсе.
   */
  setHealth({ loaded: true, pushFailed: false })
}
