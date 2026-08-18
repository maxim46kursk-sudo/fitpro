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

let backend = null
let unwatch = null
let pushTimer = null
let pushing = false
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
    [STAMP]: readRaw(`${KEYS.challenge}.stamp`) || new Date().toISOString(),
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
 */
export function mergeAttempts(a, b) {
  const days = {}
  for (const src of [a?.days, b?.days]) {
    for (const [day, tiers] of Object.entries(src || {})) {
      days[day] = days[day] || {}
      for (const [tier, list] of Object.entries(tiers || {})) {
        const have = days[day][tier] || []
        const seen = new Set(have.map((x) => `${x.at}|${x.score}`))
        days[day][tier] = [...have, ...(list || []).filter((x) => !seen.has(`${x.at}|${x.score}`))]
      }
    }
  }
  return { days }
}

/** Строки попыток для отдельной таблицы — из общего хранилища попыток. */
export function attemptRows(attempts) {
  const rows = []
  for (const [day, tiers] of Object.entries(attempts?.days || {})) {
    for (const [tier, list] of Object.entries(tiers || {})) {
      ;(list || []).forEach((a, i) => {
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

  if (!backend) return { ok: true, why: 'без сервера' }

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
export async function push({ force = false } = {}) {
  /**
   * Адаптер берётся В ЛОКАЛЬНУЮ переменную и дальше используется только она.
   *
   * Отправка живёт дольше одного кадра: между `await` на попытках и записью
   * прогресса раздел успевает закрыться и отключить хранилище. Читай мы `backend`
   * после каждого ожидания — вторая половина отправки падала бы на пустом месте.
   * Ровно это и случилось: попытки уезжали, прогресс молча нет.
   */
  const api = backend
  if (!api || pushing) return
  pushing = true
  try {
    const payload = { ...collectProgress(), [STAMP]: new Date().toISOString() }
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
        return
      } catch (error) {
        if (attempt === RETRY_MS.length) {
          logEvent('sync.push-failed', { reason: String(error?.message || error).slice(0, 120) })
          return
        }
        await new Promise((r) => setTimeout(r, RETRY_MS[attempt]))
      }
    }
  } finally {
    pushing = false
  }
}

/** Забыть всё, что помнит сам модуль. Зовётся при закрытии раздела. */
export function resetSync() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  knownAttempts.clear()
}
