/**
 * ПАМЯТЬ ГОСТЯ. Живёт ровно столько, сколько открыта вкладка.
 *
 * Модель гостя изменилась: он пробует всё, но следа не остаётся. Раньше его
 * тренировки и еда ложились в те же ключи localStorage, что и у вошедшего
 * человека, — и на общем телефоне следующий гость открывал чужие данные, а сам
 * человек видел «сохранённое», которое на деле держалось на одном браузере и
 * умирало от очистки кэша. Обещание сохранности даёт аккаунт, и только он.
 *
 * ПОЧЕМУ МОДУЛЬ, А НЕ СОСТОЯНИЕ ЭКРАНА. Дневник питания смонтирован только на
 * своей вкладке: уйди человек на «Тренировки» и вернись — состояние
 * компонента уже уничтожено, и записи пропали бы посреди сессии. Здесь они
 * переживают переходы между вкладками и не переживают перезагрузку — ровно то
 * поведение, которое обещано.
 *
 * НА ДИСК ОТСЮДА УХОДИТ РОВНО ОДНА ВЕЩЬ и ровно один раз: буфер переезда,
 * который собирается в момент нажатия «Создать аккаунт» (см. guestPending.js).
 * До этого нажатия гость не оставляет на устройстве ничего.
 */

/** Тренировки гостя за эту вкладку. */
let workouts = []
/** Дневник питания гостя: {дата: [записи]}. */
let food = {}
/** Свои упражнения, заведённые гостем. */
let custom = []
/**
 * Попытки Motion за день 1: `{day, tiers: {уровень: [попытки]}}`.
 *
 * Приходят из самого раздела: он живёт в своей папке и про этот модуль не
 * знает, поэтому отдаёт их наружу колбэком, а складывает сюда хозяин.
 */
let motion = null

export function setGuestWorkouts(list) {
  workouts = Array.isArray(list) ? list : []
}

export function getGuestWorkouts() {
  return workouts
}

export function setGuestFood(byDate) {
  food = byDate && typeof byDate === 'object' ? byDate : {}
}

export function getGuestFood() {
  return food
}

export function setGuestCustom(list) {
  custom = Array.isArray(list) ? list : []
}

export function getGuestCustom() {
  return custom
}

export function setGuestMotion(payload) {
  motion = payload ?? null
}

export function getGuestMotion() {
  return motion
}

/** Есть ли в попытках Motion хоть одна запись. */
const hasMotion = (m) =>
  !!m && Object.values(m.tiers ?? {}).some((list) => Array.isArray(list) && list.length > 0)

/**
 * Что гость наработал за эту вкладку. Пусто — значит переносить нечего и
 * буфер заводить незачем.
 *
 * @returns {{workouts: object[], food: object, custom: object[], motion: object|null}|null}
 */
export function collectGuestData() {
  const hasFood = Object.values(food).some((list) => Array.isArray(list) && list.length > 0)
  if (!workouts.length && !hasFood && !custom.length && !hasMotion(motion)) return null
  return { workouts, food, custom, motion }
}

/** Забыть всё — при выходе из аккаунта и в тестах. */
export function resetGuestStore() {
  workouts = []
  food = {}
  custom = []
  motion = null
}
