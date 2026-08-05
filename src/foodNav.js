// Навигация внутри раздела «Питание»: явный стек экранов.
//
// Зачем стек, а не пара флагов. Раздел стал многоэкранным: день → сводка →
// месяц → день из календаря → назад. С флагами вида showGoals/showSummary
// кнопка «назад» превращается в набор догадок «если открыто это, то вернуть
// туда», и первый же новый путь их ломает. Стек отвечает на вопрос «куда
// назад» одним способом всегда: снять верхний экран.
//
// Отдельный модуль без React — это чистые функции над массивом, и их напрямую
// гоняет test-food-diary.mjs. В FoodDiary.jsx остаётся только состояние.

export const DAY = 'day'
export const GOALS = 'goals'
export const SUMMARY = 'summary'

// Экран дня всегда лежит в основании стека: раздел «Питание» открывается
// именно им, и уйти глубже, чем в день, некуда.
export const initialStack = date => [{ type: DAY, date }]

export const currentScreen = stack => stack[stack.length - 1]

// Дата, за которую показываем/грузим дневник. Берётся у БЛИЖАЙШЕГО СНИЗУ
// экрана дня, а не только у верхнего: стоя на «Норме» или «Сводке», мы всё
// ещё работаем с тем днём, из которого туда пришли, — и вернуться обязаны
// к нему же, а не к сегодняшнему.
export function currentDate(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].type === DAY) return stack[i].date
  }
  return null
}

// Месяц, который сейчас листают в «Сводке». null — сводка не открыта.
export function currentMonth(stack) {
  const top = currentScreen(stack)
  return top?.type === SUMMARY ? top.month : null
}

export const pushScreen = (stack, screen) => [...stack, screen]

// Замена верхнего экрана, а НЕ добавление нового. Так меняются стрелки даты,
// кнопка «Сегодня» и листание месяцев: это уточнение того же экрана, и
// накопление их в стеке означало бы, что после десяти нажатий «‹» надо десять
// раз нажать «назад», чтобы выйти.
export const replaceTop = (stack, patch) => [
  ...stack.slice(0, -1),
  { ...stack[stack.length - 1], ...patch },
]

// Снять верхний экран. Последний не снимаем — из основания стека выходят не
// «назад», а закрытием всего раздела (canGoBack об этом и говорит).
export const popScreen = stack => (stack.length > 1 ? stack.slice(0, -1) : stack)

export const canGoBack = stack => stack.length > 1

// ── Суммы калорий по дням месяца ─────────────────────────────────────────
// Для чисел под датами в календаре. Считается из уже загруженного дневника,
// без запросов.
//
// Дни без записей в результат НЕ попадают: в календаре у них не должно быть
// ни числа, ни подсветки, а ноль пришлось бы отличать от «не ел» отдельной
// проверкой на каждой клетке.
export function monthTotals(diaryByDate, y, m) {
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}-`
  const out = {}
  for (const [date, entries] of Object.entries(diaryByDate || {})) {
    // Строгое сравнение префикса: без него август 2026 подтянул бы данные
    // августа любого другого года.
    if (!date.startsWith(prefix)) continue
    const kcal = (entries || []).reduce((s, e) => s + (+e.kcal || 0), 0)
    if (kcal > 0) out[date] = Math.round(kcal)
  }
  return out
}
