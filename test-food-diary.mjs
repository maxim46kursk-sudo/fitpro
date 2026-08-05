// test-food-diary.mjs — дневник питания по приёмам пищи.
//
// Что проверяем: чистую логику экрана дня (src/foodMeals.js) и склейку путей
// добавления (поиск / сканер / недавние → порция → запись в конкретный приём).
// Импортируются РЕАЛЬНЫЕ функции, ничего не переписывается на месте: то же,
// что вызывает src/FoodDiary.jsx, вызывают и тесты.
//
// Разметка и React сюда не входят — их проверять нечем без браузера, а вот вся
// арифметика и группировка живут отдельным модулем именно ради этого файла.
//
// Ветка поиска по справочнику (?action=food-search) проверяется в
// test-barcode.mjs — там уже стоит вся оснастка для handler'а set-exercise.
//
// Запуск: node test-food-diary.mjs. В сборку не входит.

const {
  MEALS, MEAL_KEYS, MEAL_ICONS, NO_MEAL, NO_MEAL_LABEL, mealLabel, entryMeal,
  groupByMeal, sumEntries, moveEntry, remainingOf, overBy, pctOf,
  recentProducts, shiftISO, scaleEntryByPortions, clampPortions,
} = await import('./src/foodMeals.js')
const { buildFoodEntry } = await import('./src/nutrition.js')

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Список приёмов
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Приёмы пищи ────────────────────────────────────────────────────')
assertEqual('четыре приёма в порядке дня', MEAL_KEYS, ['breakfast', 'lunch', 'dinner', 'snack'])
assertEqual('у каждого есть подпись', MEALS.map(m => m.label), ['Завтрак', 'Обед', 'Ужин', 'Перекус'])
report('у каждого приёма есть иконка', MEAL_KEYS.every(k => typeof MEAL_ICONS[k] === 'string' && MEAL_ICONS[k]))
assertEqual('служебный ключ не пересекается с приёмами', MEAL_KEYS.includes(NO_MEAL), false)
assertEqual('подпись известного приёма', mealLabel('lunch'), 'Обед')
assertEqual('подпись неизвестного — «Без категории»', mealLabel('supper'), NO_MEAL_LABEL)

assertEqual('приём записи читается', entryMeal({ meal: 'dinner' }), 'dinner')
// NULL у старых строк и мусор из будущей версии клиента одинаково не должны
// приводить к потере записи — обе попадают в «Без категории».
assertEqual('meal=null → без категории', entryMeal({ meal: null }), NO_MEAL)
assertEqual('meal отсутствует → без категории', entryMeal({}), NO_MEAL)
assertEqual('незнакомый meal → без категории', entryMeal({ meal: 'brunch' }), NO_MEAL)

// ══════════════════════════════════════════════════════════════════════════
// 2. Группировка дня и подытоги
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Группировка по приёмам ─────────────────────────────────────────')

const day = [
  { id: 1, name: 'Овсянка', kcal: '350', p: '12', c: '60', f: '6', meal: 'breakfast' },
  { id: 2, name: 'Кофе с молоком', kcal: '60', p: '3', c: '5', f: '3', meal: 'breakfast' },
  { id: 3, name: 'Борщ', kcal: '250', p: '10', c: '20', f: '12', meal: 'lunch' },
  { id: 4, name: 'Творог', kcal: '180', p: '25', c: '5', f: '5', meal: 'snack' },
  { id: 5, name: 'Старая запись', kcal: '100', p: '5', c: '10', f: '2', meal: null },
]
const g = groupByMeal(day)

assertEqual('завтрак собран', g.breakfast.map(e => e.id), [1, 2])
assertEqual('обед собран', g.lunch.map(e => e.id), [3])
assertEqual('ужин пуст, но ключ есть', g.dinner, [])
assertEqual('перекус собран', g.snack.map(e => e.id), [4])
assertEqual('запись с meal=NULL попала в «Без категории»', g[NO_MEAL].map(e => e.id), [5])
report('ключи есть у всех приёмов, даже пустых',
  [...MEAL_KEYS, NO_MEAL].every(k => Array.isArray(g[k])))
assertEqual('порядок внутри приёма сохранён (порядок добавления)',
  g.breakfast.map(e => e.name), ['Овсянка', 'Кофе с молоком'])
assertEqual('пустой день — все секции пустые',
  Object.values(groupByMeal([])).every(v => v.length === 0), true)
assertEqual('undefined вместо списка не роняет', groupByMeal(undefined)[NO_MEAL], [])

assertEqual('подытог завтрака', sumEntries(g.breakfast), { kcal: 410, p: 15, c: 65, f: 9 })
assertEqual('подытог обеда', sumEntries(g.lunch), { kcal: 250, p: 10, c: 20, f: 12 })
assertEqual('подытог пустой секции — нули', sumEntries(g.dinner), { kcal: 0, p: 0, c: 0, f: 0 })
// Числа в дневнике лежат строками (так их кладёт загрузка из Supabase) —
// суммирование обязано это переживать, а не склеивать строки.
assertEqual('строки складываются как числа, а не конкатенируются',
  sumEntries([{ kcal: '100' }, { kcal: '50' }]).kcal, 150)
assertEqual('пустые поля считаются нулями',
  sumEntries([{ kcal: '100' }, { kcal: '', p: null }]), { kcal: 100, p: 0, c: 0, f: 0 })
assertEqual('итог дня = сумма всех секций', sumEntries(day),
  { kcal: 940, p: 55, c: 100, f: 28 })

// ══════════════════════════════════════════════════════════════════════════
// 3. Остаток от нормы
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Остаток и перебор ──────────────────────────────────────────────')
assertEqual('обычный остаток', remainingOf(1400, 2000), 600)
assertEqual('норма выбрана ровно — остаток 0', remainingOf(2000, 2000), 0)
// Главное: «осталось −300» человеку показывать нельзя. Перебор — отдельная
// формулировка, а остаток обрезается нулём.
assertEqual('переедание → остаток 0, а не минус', remainingOf(2300, 2000), 0)
assertEqual('норма не задана → остатка нет', remainingOf(1400, 0), 0)
assertEqual('перебор считается', overBy(2300, 2000), 300)
assertEqual('до нормы не дошли → перебора нет', overBy(1400, 2000), 0)
assertEqual('ровно норма → перебора нет', overBy(2000, 2000), 0)
assertEqual('норма не задана → перебора нет', overBy(2300, 0), 0)
assertEqual('дробные значения округляются', remainingOf(1400.4, 2000), 600)
assertEqual('шкала: половина нормы', pctOf(1000, 2000), 50)
assertEqual('шкала не вылезает за 100 при переборе', pctOf(4000, 2000), 100)
assertEqual('шкала без нормы — 0', pctOf(1000, 0), 0)

// ══════════════════════════════════════════════════════════════════════════
// 4. Перенос записи между приёмами
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Перенос между приёмами ─────────────────────────────────────────')
{
  const moved = moveEntry(day, 3, 'dinner')
  const gm = groupByMeal(moved)
  assertEqual('запись ушла из обеда', gm.lunch.map(e => e.id), [])
  assertEqual('запись пришла в ужин', gm.dinner.map(e => e.id), [3])
  assertEqual('числа при переносе не изменились',
    gm.dinner[0], { id: 3, name: 'Борщ', kcal: '250', p: '10', c: '20', f: '12', meal: 'dinner' })
  assertEqual('итог дня после переноса тот же', sumEntries(moved), sumEntries(day))
  report('исходный массив не изменён (React-состояние менять на месте нельзя)',
    day[2].meal === 'lunch', `стало ${day[2].meal}`)
}
{
  // Старую NULL-запись можно разложить по приёмам — ради этого секция и видна.
  const moved = moveEntry(day, 5, 'breakfast')
  const gm = groupByMeal(moved)
  assertEqual('NULL-запись перенесена в завтрак', gm.breakfast.map(e => e.id), [1, 2, 5])
  assertEqual('«Без категории» опустела', gm[NO_MEAL], [])
}
{
  // Порядок внутри секции — исходный порядок дня, а не порядок переносов:
  // запись №1 добавлена раньше №5, поэтому она и выше.
  const back = moveEntry(day, 1, null)
  assertEqual('можно вернуть запись в «Без категории»', groupByMeal(back)[NO_MEAL].map(e => e.id), [1, 5])
}
assertEqual('перенос несуществующего id ничего не ломает',
  moveEntry(day, 999, 'lunch').length, day.length)

// ══════════════════════════════════════════════════════════════════════════
// 5. «Недавние»
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Недавние продукты ──────────────────────────────────────────────')
const TODAY = '2026-08-06'
const diary = {
  '2026-08-06': [
    { id: 1, name: 'Овсянка', kcal: '350', p: '12', c: '60', f: '6' },
    { id: 2, name: 'Кофе', kcal: '60', p: '3', c: '5', f: '3' },
  ],
  '2026-08-05': [
    { id: 3, name: 'Борщ', kcal: '250', p: '10', c: '20', f: '12' },
    { id: 4, name: 'овсянка', kcal: '999', p: '1', c: '1', f: '1' },   // тот же продукт другим регистром
  ],
  '2026-07-20': [{ id: 5, name: 'Плов', kcal: '400', p: '15', c: '45', f: '18' }],
  // За горизонтом 60 дней — не «недавнее».
  '2026-05-01': [{ id: 6, name: 'Старьё', kcal: '100', p: '1', c: '1', f: '1' }],
}

{
  const r = recentProducts(diary, { today: TODAY })
  assertEqual('порядок от новых к старым', r.map(x => x.name), ['Кофе', 'Овсянка', 'Борщ', 'Плов'])
  // Внутри даты — с конца списка: последнее съеденное ближе к началу.
  assertEqual('внутри даты — сначала добавленное позже', r[0].name, 'Кофе')
  assertEqual('дубль по названию без учёта регистра схлопнут', r.filter(x => x.name.toLowerCase() === 'овсянка').length, 1)
  assertEqual('побеждает САМАЯ СВЕЖАЯ запись, а не старая', r.find(x => x.name === 'Овсянка').kcal, 350)
  assertEqual('старше 60 дней не берём', r.some(x => x.name === 'Старьё'), false)
  assertEqual('числа приведены к числам', r[0], { name: 'Кофе', kcal: 60, p: 3, c: 5, f: 3, lastDate: '2026-08-06' })
}
{
  const many = {}
  for (let i = 0; i < 40; i++) many[shiftISO(TODAY, -i)] = [{ id: i, name: `Продукт ${i}`, kcal: '10' }]
  assertEqual('список ограничен 20 позициями', recentProducts(many, { today: TODAY }).length, 20)
  assertEqual('лимит настраивается', recentProducts(many, { today: TODAY, limit: 5 }).length, 5)
}
{
  // Человек мог полистать календарь вперёд и что-то записать — «недавним» это
  // не является.
  const withFuture = { ...diary, '2026-09-01': [{ id: 9, name: 'Из будущего', kcal: '1' }] }
  assertEqual('будущие даты не попадают в недавние',
    recentProducts(withFuture, { today: TODAY }).some(x => x.name === 'Из будущего'), false)
}
assertEqual('пустой дневник → пустой список', recentProducts({}, { today: TODAY }), [])
assertEqual('без даты → пустой список', recentProducts(diary, {}), [])
assertEqual('записи без названия пропускаются',
  recentProducts({ [TODAY]: [{ id: 1, name: '   ', kcal: '10' }, { id: 2, name: 'Хлеб', kcal: '80' }] }, { today: TODAY }).map(x => x.name),
  ['Хлеб'])
assertEqual('граница 60 дней включительно',
  recentProducts({ [shiftISO(TODAY, -60)]: [{ id: 1, name: 'Ровно 60', kcal: '10' }] }, { today: TODAY }).length, 1)
assertEqual('61 день назад — уже нет',
  recentProducts({ [shiftISO(TODAY, -61)]: [{ id: 1, name: 'Ровно 61', kcal: '10' }] }, { today: TODAY }).length, 0)

// ══════════════════════════════════════════════════════════════════════════
// 6. Повтор недавнего: порции
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Повтор недавнего продукта ──────────────────────────────────────')
const recent = { name: 'Борщ', kcal: 250, p: 10, c: 20, f: 12 }
assertEqual('одна порция — повтор как есть, без хвоста в названии',
  scaleEntryByPortions(recent, 1), { name: 'Борщ', kcal: 250, p: 10, c: 20, f: 12 })
assertEqual('две порции — числа ×2, множитель в названии',
  scaleEntryByPortions(recent, 2), { name: 'Борщ (×2)', kcal: 500, p: 20, c: 40, f: 24 })
assertEqual('половина порции', scaleEntryByPortions(recent, 0.5),
  { name: 'Борщ (×0.5)', kcal: 125, p: 5, c: 10, f: 6 })
assertEqual('множитель поджимается сверху', clampPortions('999'), 20)
assertEqual('множитель поджимается снизу', clampPortions('0'), 0.1)
assertEqual('запятая как разделитель', clampPortions('1,5'), 1.5)
assertEqual('мусор → null (кнопка гаснет)', clampPortions('две'), null)
assertEqual('пусто → null', clampPortions(''), null)

// ══════════════════════════════════════════════════════════════════════════
// 7. СКВОЗНЫЕ ПУТИ: добавление в конкретный приём
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Сквозные пути добавления ───────────────────────────────────────')

// Модель того, что делает addFood: приклеить meal и дописать в конец дня.
// Сохранение в Supabase здесь не участвует (оно в React-компоненте), но всё,
// что определяет РЕЗУЛЬТАТ для пользователя, — считается настоящими функциями.
const addTo = (entries, entry, meal) => [...entries, { id: entries.length + 100, ...entry, meal }]

{
  // Поиск → карточка из общей базы → порция 150 г → «Обед».
  const found = { barcode: '4600682000129', name: 'Творог 5%', brand: 'Простоквашино', kcal100: 121, p100: 16, c100: 3, f100: 5, source: 'ai_photo' }
  const entry = buildFoodEntry(found, 150)
  assertEqual('поиск: порция пересчитана', entry,
    { name: 'Простоквашино Творог 5% (150 г)', kcal: 181.5, p: 24, c: 4.5, f: 7.5 })
  const after = addTo(day, entry, 'lunch')
  const ga = groupByMeal(after)
  assertEqual('поиск: запись легла именно в «Обед»', ga.lunch.map(e => e.name), ['Борщ', 'Простоквашино Творог 5% (150 г)'])
  assertEqual('поиск: в другие приёмы ничего не попало', ga.breakfast.length, 2)
  assertEqual('поиск: подытог обеда вырос', Math.round(sumEntries(ga.lunch).kcal), 432)
}
{
  // Сканер, открытый из «Завтрака», → запись в «Завтрак».
  const scanned = { barcode: '3017620422003', name: 'Nutella', brand: 'Ferrero', kcal100: 539, p100: 6.3, c100: 57.5, f100: 30.9, source: 'off' }
  const entry = buildFoodEntry(scanned, 30)
  const after = addTo(day, entry, 'breakfast')
  const ga = groupByMeal(after)
  assertEqual('скан: запись легла в «Завтрак»', ga.breakfast.map(e => e.name).at(-1), 'Ferrero Nutella (30 г)')
  assertEqual('скан: обед не тронут', ga.lunch.length, 1)
  assertEqual('скан: подытог завтрака вырос на 161.7', Math.round(sumEntries(ga.breakfast).kcal * 10) / 10, 571.7)
}
{
  // Недавнее → две порции → «Ужин».
  const entry = scaleEntryByPortions(recent, 2)
  const ga = groupByMeal(addTo(day, entry, 'dinner'))
  assertEqual('недавнее: две порции легли в «Ужин»', ga.dinner.map(e => e.name), ['Борщ (×2)'])
  assertEqual('недавнее: подытог ужина', sumEntries(ga.dinner).kcal, 500)
}
{
  // Ручной ввод без приёма (например, из старого клиента) не теряется.
  const ga = groupByMeal(addTo(day, { name: 'Что-то', kcal: 50, p: 1, c: 2, f: 3 }, null))
  assertEqual('запись без приёма видна в «Без категории»', ga[NO_MEAL].map(e => e.name), ['Старая запись', 'Что-то'])
}
{
  // Старая NULL-запись редактируется как любая другая: правка меняет числа и
  // НЕ переносит её между приёмами.
  const edited = day.map(e => e.id === 5 ? { ...e, name: 'Поправленная', kcal: '150' } : e)
  const ge = groupByMeal(edited)
  assertEqual('старая запись после правки осталась без категории', ge[NO_MEAL].map(e => e.name), ['Поправленная'])
  assertEqual('правка изменила число', sumEntries(ge[NO_MEAL]).kcal, 150)
}

console.log(`\n${'─'.repeat(68)}\nИтог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
