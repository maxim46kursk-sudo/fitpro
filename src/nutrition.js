// Числовая арифметика дневника питания — пределы полей, кламп и пересчёт
// КБЖУ «на 100 г» на вес порции.
//
// Почему отдельный модуль, а не внутри App.jsx: те же пределы теперь нужны
// сканеру штрих-кода (src/BarcodeScanner.jsx), который считает порцию сам, а
// импортировать их из App.jsx он не может — App.jsx подгружает сам сканер
// (React.lazy), получилась бы кольцевая зависимость. Дублировать четыре
// константы в двух файлах — верный способ однажды поправить только одну.
// Заодно всё здесь — чистые функции без React, поэтому их напрямую гоняет
// test-barcode.mjs.

// Жёсткие пределы числовых полей питания — без них отрицательные или
// гигантские значения (ккал −9999 или 1e9) ломают суммы дня, графики и расчёт
// нормы КБЖУ (calcMacroGoals, aiPrompt.js). Клампим ПРИ СОХРАНЕНИИ (жёстко, в
// коде) — HTML min/max на инпутах это только подсказка браузеру, её легко
// обойти (вставка, автозаполнение, DevTools).
export const CAL_MIN = 0, CAL_MAX = 20000
export const MACRO_MIN = 0, MACRO_MAX = 2000

export const clampNum = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0))

// Вес порции. Верхняя граница 3 кг — это уже не порция, а закупка; нижняя 1 г
// нужна, чтобы поле нельзя было увести в ноль и получить запись «0 ккал»,
// которая выглядит как сохранённая, но ничего не значит.
export const GRAMS_MIN = 1, GRAMS_MAX = 3000
export const GRAMS_DEFAULT = 100

// Округление до одного знака — единый шаг для всего, что считает порция.
// Больше знаков в дневнике питания бессмысленны: исходные данные с упаковки
// сами по себе округлены, а «117.43 ккал» создаёт ложное ощущение точности.
export const round1 = n => Math.round(n * 10) / 10

// Разбор веса порции из поля ввода. Возвращает null, а не подставляет дефолт,
// когда разобрать нечего: пустое поле во время набора должно показывать «—»,
// а не пересчёт для внезапных 100 г, которых пользователь не вводил.
// Запятая как разделитель — обычный ввод с русской раскладки.
export function parseGrams(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const s = String(raw ?? '').replace(',', '.').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function clampGrams(raw) {
  const n = parseGrams(raw)
  if (n === null) return null
  return Math.min(GRAMS_MAX, Math.max(GRAMS_MIN, n))
}

// Пересчёт величины «на 100 г» на фактический вес порции.
// null на входе (в справочнике поле не заполнено) остаётся null на выходе —
// «неизвестно» не должно превращаться в ноль по дороге. Ноль в дневнике
// читается как факт «жиров нет», а это разные утверждения.
export function scalePer100(per100, grams) {
  if (per100 === null || per100 === undefined || per100 === '') return null
  const v = Number(per100)
  const g = parseGrams(grams)
  if (!Number.isFinite(v) || g === null) return null
  return round1((v * g) / 100)
}

// Полный пересчёт карточки продукта на порцию. Всё ещё «неизвестно=null» —
// клампом и заменой на ноль занимается уже buildFoodEntry, на самом последнем
// шаге, когда значения уходят в дневник.
export function scaleProduct(product, grams) {
  return {
    kcal: scalePer100(product?.kcal100, grams),
    p: scalePer100(product?.p100, grams),
    c: scalePer100(product?.c100, grams),
    f: scalePer100(product?.f100, grams),
  }
}

// Вес в названии записи: целое число без хвоста, дробное — с одним знаком.
const formatGrams = g => (Number.isInteger(g) ? String(g) : String(round1(g)))

// Название записи дневника: "Бренд Название (150 г)".
// Бренд впереди, потому что в OFF название часто родовое («Молоко 3.2%») и без
// бренда две записи в дневнике не отличить. Вес в скобках — чтобы позже, при
// правке записи руками, было видно, из какой порции сложились эти числа: сами
// граммы в food_diary не хранятся, там только итог.
export function buildEntryName(product, grams) {
  const brand = String(product?.brand || '').trim()
  const name = String(product?.name || '').trim()
  const title = [brand, name].filter(Boolean).join(' ').trim()
  const g = clampGrams(grams)
  return g === null ? title : `${title} (${formatGrams(g)} г)`
}

// Готовая запись для дневника питания: имя + четыре числа, уже приведённые к
// допустимым пределам. Здесь «неизвестно» наконец становится нулём — food_diary
// хранит числа, а не отсутствие данных, и пользователь дополнит их правкой
// записи обычным способом.
export function buildFoodEntry(product, grams) {
  const s = scaleProduct(product, grams)
  return {
    name: buildEntryName(product, grams),
    kcal: clampNum(s.kcal, CAL_MIN, CAL_MAX),
    p: clampNum(s.p, MACRO_MIN, MACRO_MAX),
    c: clampNum(s.c, MACRO_MIN, MACRO_MAX),
    f: clampNum(s.f, MACRO_MIN, MACRO_MAX),
  }
}
