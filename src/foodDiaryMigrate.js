/**
 * ПЕРЕЕЗД ГОСТЕВОГО ДНЕВНИКА ПИТАНИЯ В АККАУНТ.
 *
 * Зачем. Гость ведёт дневник без регистрации — записи ложатся только в
 * `fitpro_food_diary` на устройстве. В момент, когда он заводит аккаунт, мы
 * обещали, что не потеряется ничего; вот это обещание и выполняется здесь.
 *
 * КАК ОТЛИЧИТЬ ГОСТЕВУЮ ЗАПИСЬ ОТ КЭША ОБЛАКА. По маркеру `local: true`,
 * который ставит `addFood` в ветке без `userId` (src/FoodDiary.jsx). В том же
 * кэше живут и записи, ПРОЧИТАННЫЕ из базы, — у них маркера нет, и переносить
 * их нельзя ни в коем случае: это не перенос, а дублирование съеденного.
 * Отличать «по числовому id» было бы гаданием: у гостевой записи id это
 * `Date.now()`, у облачной — bigint из базы, и оба числа.
 *
 * ПОЧЕМУ БАРЬЕР, А НЕ ПРОСТО ВЫЗОВ. Дневник грузится ЧЕТЫРЬМЯ эффектами сразу
 * (весь дневник, текущий день, видимый месяц, перечитывание после записи), и
 * стартуют они параллельно на одном и том же `userId`. Без общего барьера
 * каждый успел бы запустить свой перенос — и человек получил бы свой завтрак
 * четыре раза. Поэтому промис мемоизируется по `userId`: кто пришёл вторым,
 * дожидается первого, а не начинает заново.
 *
 * ПОЧЕМУ ЭТО ОБЯЗАНО СЛУЧИТЬСЯ ДО ЗАГРУЗКИ ИЗ ОБЛАКА. Каждый из тех эффектов
 * заканчивается записью результата в `fitpro_food_diary`. Приди ответ сервера
 * раньше переноса — он затрёт кэш, а вместе с ним и гостевые записи, которых в
 * базе ещё нет. Это ровно та потеря, ради исключения которой этап и делается.
 */
import { bump } from './funnel.js'

const CACHE_KEY = 'fitpro_food_diary'

/** userId -> промис переноса. Живёт столько же, сколько загруженная страница. */
const running = new Map()

function readCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // мусор в хранилище — переносить нечего, и ронять вход из-за этого нельзя
    return {}
  }
}

function writeCache(byDate) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(byDate))
  } catch {
    // приватный режим или переполненное хранилище: записи уже в базе, а кэш
    // перечитается из неё следующим же эффектом
  }
}

/**
 * Перенести гостевые записи дневника в аккаунт. Идемпотентна и безопасна к
 * повторному вызову: перенесённое теряет маркер и второй раз не поедет.
 *
 * @param {object} supabase клиент
 * @param {string} userId владелец, в чей аккаунт переносим
 * @returns {Promise<{moved: number, failed: number}>}
 */
export function ensureFoodDiaryMigrated(supabase, userId) {
  if (!userId) return Promise.resolve({ moved: 0, failed: 0 })
  const started = running.get(userId)
  if (started) return started

  const promise = migrate(supabase, userId)
  running.set(userId, promise)
  return promise
}

async function migrate(supabase, userId) {
  const byDate = readCache()
  /** [дата, позиция в списке этой даты] для каждой гостевой записи. */
  const pending = []
  for (const [date, list] of Object.entries(byDate)) {
    if (!Array.isArray(list)) continue
    list.forEach((entry, index) => {
      if (entry && entry.local === true) pending.push({ date, index })
    })
  }

  // Ничего гостевого — выходим, не потревожив ни сеть, ни хранилище. Это
  // обычный случай: так выглядит КАЖДЫЙ вход давно зарегистрированного
  // человека, и платить за него запросом было бы неправильно.
  if (!pending.length) return { moved: 0, failed: 0 }

  let moved = 0
  let failed = 0

  for (const { date, index } of pending) {
    const entry = byDate[date][index]
    try {
      const { data, error } = await supabase
        .from('food_diary')
        .insert({
          user_id: userId,
          date,
          name: entry.name,
          kcal: entry.kcal,
          p: entry.p,
          c: entry.c,
          f: entry.f,
          meal: entry.meal ?? null,
        })
        .select()
        .single()
      if (error || !data) throw error || new Error('пустой ответ вставки')

      /**
       * Маркер снимаем ТОЛЬКО после подтверждённой вставки, и id меняем на
       * облачный: с этого момента правка и удаление этой записи должны уходить
       * в базу, а не в пустоту.
       */
      const { local, ...rest } = entry
      void local
      byDate[date][index] = { ...rest, id: data.id }
      moved += 1
    } catch (e) {
      // Запись остаётся с маркером и переедет при следующем входе. Молчать
      // нельзя — иначе «часть еды не доехала» разбирается вслепую.
      console.error('Перенос дневника питания: запись не переехала:', e)
      failed += 1
    }
  }

  // Пишем один раз в конце: перезапись хранилища на каждую запись — это N
  // сериализаций всего дневника ради N строк.
  if (moved > 0) writeCache(byDate)
  if (moved > 0) bump('migrated')

  return { moved, failed }
}

/** Забыть барьер — для тестов и на случай смены человека без перезагрузки. */
export function resetFoodDiaryMigration() {
  running.clear()
}
