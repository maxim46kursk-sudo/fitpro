// Приёмы пищи в дневнике питания: список, группировка, подытоги, «недавние».
//
// Отдельный модуль без React — по той же причине, что и src/nutrition.js:
// это чистые функции, которые напрямую гоняет test-food-diary.mjs, а
// src/FoodDiary.jsx их только отрисовывает. Заодно список приёмов оказывается
// в одном месте, а не размазан по разметке.

// Порядок здесь — порядок секций на экране. Он же порядок дня, а не алфавит:
// человек листает сверху вниз ровно в том порядке, в котором ест.
//
// Ключи совпадают со значениями CHECK-ограничения food_diary.meal
// (sql/2026-08-06_food_diary_meals.sql). Добавить приём = дописать строку сюда
// И расширить CHECK — иначе база отвергнет запись, а клиент этого не ждёт.
export const MEALS = [
  { key: 'breakfast', label: 'Завтрак' },
  { key: 'lunch', label: 'Обед' },
  { key: 'dinner', label: 'Ужин' },
  { key: 'snack', label: 'Перекус' },
]

export const MEAL_KEYS = MEALS.map(m => m.key)

// Иконки GlassIcon по приёмам. Взяты из существующего набора (src/glassIcons.jsx),
// новых не рисуем: sunrise — утро, plate — основной приём, moon — вечер,
// grain — что-то небольшое между делом.
export const MEAL_ICONS = {
  breakfast: 'sunrise',
  lunch: 'plate',
  dinner: 'moon',
  snack: 'grain',
}

// Пятая, служебная секция: записи, сделанные до появления приёмов (meal IS
// NULL), и всё, у чего приём почему-то не проставился. Ключ не пересекается со
// значениями CHECK и в базу никогда не пишется — он живёт только на клиенте.
export const NO_MEAL = 'none'
export const NO_MEAL_LABEL = 'Без категории'

export const mealLabel = key => MEALS.find(m => m.key === key)?.label || NO_MEAL_LABEL

// Приём записи. Всё, что не входит в известный список (NULL у старых строк,
// мусор из будущей версии клиента), сваливается в «Без категории» — потерять
// запись из-за незнакомого значения нельзя.
export const entryMeal = e => (MEAL_KEYS.includes(e?.meal) ? e.meal : NO_MEAL)

// Записи дня → { breakfast: [...], lunch: [...], dinner: [...], snack: [...],
// none: [...] }. Порядок внутри секции сохраняется (он же порядок добавления).
// Ключи есть ВСЕГДА, даже пустые: секция приёма рисуется и пустой, с кнопкой
// «+ Добавить», иначе в неё нечем положить первую запись.
export function groupByMeal(entries) {
  const out = { [NO_MEAL]: [] }
  for (const k of MEAL_KEYS) out[k] = []
  for (const e of entries || []) out[entryMeal(e)].push(e)
  return out
}

// Перенос записи в другой приём. Возвращает НОВЫЙ массив (React-состояние
// менять на месте нельзя), меняя ровно одно поле у одной записи: числа и
// название остаются как были — перенос это перекладывание, а не правка.
// meal=null возвращает запись в «Без категории».
export function moveEntry(entries, id, meal) {
  return (entries || []).map(e => (e.id === id ? { ...e, meal } : e))
}

// Сумма КБЖУ по списку записей. Числа в дневнике хранятся строками (так их
// кладёт загрузка из Supabase), поэтому каждое поле прогоняем через унарный
// плюс с запасным нулём.
export function sumEntries(entries) {
  return (entries || []).reduce(
    (a, e) => ({ kcal: a.kcal + (+e.kcal || 0), p: a.p + (+e.p || 0), c: a.c + (+e.c || 0), f: a.f + (+e.f || 0) }),
    { kcal: 0, p: 0, c: 0, f: 0 },
  )
}

// Остаток до нормы. Ниже нуля не опускается: «осталось −300 ккал» — это не то,
// что человек хочет прочитать, перебор показывается отдельной формулировкой
// (overBy ниже). Норма не задана (0) → остатка нет.
export const remainingOf = (total, goal) => (goal > 0 ? Math.max(0, Math.round(goal - total)) : 0)

// Перебор сверх нормы. Ноль, если нормы нет или до неё не дошли.
export const overBy = (total, goal) => (goal > 0 ? Math.max(0, Math.round(total - goal)) : 0)

// Процент заполнения шкалы. Клампится сотней: полоса не должна вылезать за
// свои границы, а фактический перебор показывается числом рядом.
export const pctOf = (total, goal) => (goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0)

// ── Повтор недавнего продукта ─────────────────────────────────────────────
// У записи дневника нет КБЖУ «на 100 г» — там только итог того раза. Значит,
// спрашивать граммы для повтора нечестно: пересчитать не из чего. Вместо этого
// прошлая запись считается одной порцией, а человек указывает, сколько таких
// порций съел сейчас.
export const PORTIONS_MIN = 0.1, PORTIONS_MAX = 20, PORTIONS_DEFAULT = 1

export function clampPortions(raw) {
  if (typeof raw !== 'number') {
    // Пустое поле — это НЕ ноль порций: Number('') даёт 0, и без этой проверки
    // очищенное поле молча превращалось бы в минимальные 0.1 порции вместо
    // того, чтобы погасить кнопку «Добавить».
    const s = String(raw ?? '').replace(',', '.').trim()
    if (!s) return null
    raw = Number(s)
  }
  if (!Number.isFinite(raw)) return null
  return Math.min(PORTIONS_MAX, Math.max(PORTIONS_MIN, raw))
}

const round1 = n => Math.round(n * 10) / 10

// Недавняя запись × число порций → готовая запись дневника.
// Множитель попадает в название («Творог 5% (×2)»), иначе в списке дня две
// одинаковые строки различались бы только числами, и было бы непонятно, откуда
// они взялись. При одной порции хвост не дописываем — это обычный повтор.
export function scaleEntryByPortions(entry, portions) {
  const n = clampPortions(portions)
  const k = n === null ? 1 : n
  const name = String(entry?.name || '').trim()
  return {
    name: k === 1 ? name : `${name} (×${round1(k)})`,
    kcal: round1((+entry?.kcal || 0) * k),
    p: round1((+entry?.p || 0) * k),
    c: round1((+entry?.c || 0) * k),
    f: round1((+entry?.f || 0) * k),
  }
}

// Сдвиг даты 'YYYY-MM-DD' на N дней. Через UTC-полдень, а не local-полночь:
// иначе в дни перевода часов сдвиг на сутки иногда даёт ту же дату.
export function shiftISO(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number)
  const t = Date.UTC(y, m - 1, d, 12) + days * 86400000
  const dt = new Date(t)
  const p = n => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`
}

// «Недавние» — то, что человек уже ел, чтобы добавить это в один тап, не
// вводя заново. Считается из УЖЕ загруженного дневника, без похода в сеть.
//
// Уникальность по названию (без учёта регистра): один и тот же творог,
// съеденный десять раз, должен занять одну строку списка, а не десять.
// Побеждает самая свежая запись — у неё актуальные граммы и КБЖУ.
//
// Порядок — от новых к старым: сначала более поздние даты, внутри даты —
// с конца списка (порядок в массиве совпадает с порядком добавления).
export function recentProducts(diaryByDate, { today, days = 60, limit = 20 } = {}) {
  if (!diaryByDate || !today) return []
  const from = shiftISO(today, -days)
  // Будущие даты отсекаем: человек мог полистать календарь вперёд и что-то
  // туда записать, но «недавним» это не является.
  const dates = Object.keys(diaryByDate).filter(d => d >= from && d <= today).sort().reverse()

  const seen = new Set()
  const out = []
  for (const date of dates) {
    const list = diaryByDate[date] || []
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      const name = String(e?.name || '').trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name,
        kcal: +e.kcal || 0,
        p: +e.p || 0,
        c: +e.c || 0,
        f: +e.f || 0,
        lastDate: date,
      })
      if (out.length >= limit) return out
    }
  }
  return out
}
