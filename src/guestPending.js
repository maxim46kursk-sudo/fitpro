/**
 * БУФЕР ПЕРЕЕЗДА — единственное, что гость оставляет на диске.
 *
 * Пишется ровно в один момент: человек нажал «Создать аккаунт». До этого его
 * работа живёт в памяти вкладки (guestStore.js) и исчезает с перезагрузкой —
 * так и задумано. Но регистрация уводит на форму, потом на подтверждение
 * почты, потом иногда на перезагрузку страницы; продержаться через всё это
 * память вкладки не может, а обещание «ничего не потеряется» дано.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ КЛЮЧ, А НЕ ПРЕЖНИЕ `fitpro_history` / `fitpro_food_diary`.
 * Те принадлежат ВОШЕДШЕМУ человеку и читаются как его данные — приложение
 * показывает их сразу, до ответа сервера. Положи мы туда гостевое, и на общем
 * телефоне следующий человек увидел бы чужую еду как свою. Буфер же нигде не
 * показывается: он существует только для переноса и умирает сразу после него.
 *
 * ПОЧЕМУ ПО ЧАСТЯМ. Переносов два — тренировки и дневник, — и падают они
 * независимо: сеть может отвалиться между ними. Каждый забирает СВОЮ часть и
 * возвращает буфер без неё; ключ исчезает, когда забрано всё. Не доехавшая
 * часть остаётся и переедет при следующем входе.
 */

const KEY = 'fitpro_guest_pending'

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // мусор или приватный режим — переносить нечего
    return null
  }
}

function write(value) {
  try {
    // не осталось ни одной части — ключу больше незачем лежать на устройстве
    if (!value || (!value.workouts?.length && !hasFood(value.food))) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // приватный режим: перенос не состоится, данные останутся в памяти вкладки
  }
}

const hasFood = (food) =>
  !!food && Object.values(food).some((list) => Array.isArray(list) && list.length > 0)

/**
 * Отложить работу гостя до регистрации.
 *
 * @param {{workouts: object[], food: object}|null} data из guestStore
 * @returns {boolean} легло ли что-нибудь
 */
export function saveGuestPending(data) {
  if (!data) return false
  const value = {
    workouts: Array.isArray(data.workouts) ? data.workouts : [],
    food: data.food && typeof data.food === 'object' ? data.food : {},
    at: new Date().toISOString(),
  }
  if (!value.workouts.length && !hasFood(value.food)) return false
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Что лежит в буфере. Только для чтения — забирают функциями ниже. */
export function readGuestPending() {
  return read()
}

/** Тренировки из буфера. Пусто — их там нет или уже забрали. */
export function guestPendingWorkouts() {
  const p = read()
  return Array.isArray(p?.workouts) ? p.workouts : []
}

/** Дневник из буфера. */
export function guestPendingFood() {
  const p = read()
  return p?.food && typeof p.food === 'object' ? p.food : {}
}

/**
 * Тренировки переехали — забрать их из буфера.
 *
 * Зовётся ТОЛЬКО после подтверждённой записи в базу: забрав их раньше, мы
 * потеряли бы их при первом же обрыве сети.
 */
export function dropGuestPendingWorkouts() {
  const p = read()
  if (!p) return
  write({ ...p, workouts: [] })
}

/** Дневник переехал — забрать его из буфера. */
export function dropGuestPendingFood() {
  const p = read()
  if (!p) return
  write({ ...p, food: {} })
}

/** Забыть буфер целиком — на выходе из аккаунта и в тестах. */
export function clearGuestPending() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // нечего чистить
  }
}
