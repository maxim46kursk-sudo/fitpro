// test-constructor.mjs — этап 1 разморозки Конструктора тренировок
// (docs/CONSTRUCTOR_FROZEN.md): экран вернулся в навигацию, но упражнение
// теперь можно только ВЫБРАТЬ из каталога EXERCISES, а не назвать словами.
//
// Проверяются ровно те три вещи, ради которых этап и делался:
//
//   1. ВХОД ЗАКРЫТ КЛИЕНТУ. Конструктор доступен только тренеру. Проверка не
//      функциональная, а по исходнику App.jsx — экран рисуется React'ом внутри
//      11k строк с Supabase и env, поднимать его в node дороже, чем он стоит.
//      Зато проверяются ОБА замка сразу: и кнопка входа, и сам case навигации
//      обязаны стоять под той же проверкой роли, что и тренерские экраны.
//   2. ТИП УПРАЖНЕНИЯ БЕРЁТСЯ ИЗ КАТАЛОГА. Именно его отсутствие и заморозило
//      Конструктор: у произвольного названия тип узнать неоткуда.
//   3. ОДНОСТОРОННЕЕ ПОЛУЧАЕТ СВОЮ СХЕМУ. Объём 15-12, Развитие 12-10,
//      Сила 10-8 (2 подхода вместо 4) — из документа.
//
// Отдельным разделом — что старые строки constructor_exercises со свободными
// названиями не сломались: они считаются по-прежнему, 4 подхода, нового типа
// им не приписывают. (В проде таких строк на 2026-08-10 нет вообще — обе
// таблицы конструктора пусты, — но код обязан их пережить.)
//
// Шаблонных программ этот тест не касается: programs.js/exerciseMeta.js здесь
// только читаются, а прогрессия шаблонов покрыта своими наборами
// (test-progression.mjs, test-progression-personas.js), которые обязаны
// оставаться зелёными БЕЗ правок — это и есть доказательство, что шаблоны не
// задеты.
//
// Запуск: node test-constructor.mjs

import { readFileSync } from 'node:fs'
import {
  getUpcomingScheme, classifyOneSidedStartPhase, buildConstructorSessions,
  exerciseProfile, filterCatalog, catalogGroups, findByCatalogName, baselineSetCount,
  catalogGroup, catalogExercise, hasHardStreak,
  ONE_SIDED_SCHEMES, PHASE_SCHEMES, PHASE_ORDER, CATALOG_OTHER_GROUP,
} from './src/constructorPhases.js'
import { EXERCISES, isOneSidedExercise } from './src/programs.js'
import { muscleGroup } from './src/exerciseMeta.js'

let passed = 0, failed = 0
const rows = []
const check = (section, name, ok, actual = '') => {
  rows.push({ section, name, ok, actual })
  if (ok) passed++; else failed++
}
const eq = (section, name, actual, expected) =>
  check(section, name, JSON.stringify(actual) === JSON.stringify(expected), `получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`)

// ─────────────────────────────────────────────────────────────────────────
// 1. Вход в Конструктор виден только тренеру
// ─────────────────────────────────────────────────────────────────────────
const S1 = 'Вход только тренеру'
const appSrc = readFileSync(new URL('./src/App.jsx', import.meta.url), 'utf8')

check(S1, 'ConstructorView импортирован в App.jsx (экран вернулся в навигацию)',
  /import\s+ConstructorView\s+from\s+'\.\/ConstructorView\.jsx'/.test(appSrc))

// Кнопка входа. Ищем её вместе с предшествующим условием: между `isTrainer&&`
// и самой кнопкой не должно быть закрывающей скобки условия — иначе кнопка
// стоит уже вне защиты.
const buttonMatch = appSrc.match(/\{isTrainer&&\(\s*<button data-testid="constructor-open"/)
check(S1, 'кнопка «Конструктор» стоит под isTrainer', Boolean(buttonMatch))

const buttonCount = (appSrc.match(/data-testid="constructor-open"/g) || []).length
check(S1, 'вход в Конструктор в интерфейсе ровно один (незащищённой копии нет)',
  buttonCount === 1, `найдено кнопок: ${buttonCount}`)

// Сам экран закрыт ролью независимо от кнопки.
const caseMatch = appSrc.match(/case 'constructor':\s*return userRole==='trainer'\s*\?\s*<ConstructorView[\s\S]*?\/>\s*:\s*null/)
check(S1, "case 'constructor' отдаёт экран только при userRole==='trainer', иначе null", Boolean(caseMatch))

// Роль берётся из профиля, как у остальных тренерских экранов (Dashboard).
check(S1, 'проверка роли — та же, что у тренерских экранов (userRole===\'trainer\')',
  /case 'dashboard': return userRole==='trainer'/.test(appSrc))

// Конструктора нет в меню-навигации: попасть в него мимо кнопки нельзя.
const navBlocks = appSrc.match(/const NAV(_MOBILE)?\s*=\s*\[[^\]]*\]/g) || []
check(S1, 'Конструктора нет в нижнем меню и в боковом (не вкладка, а отдельный экран)',
  navBlocks.length > 0 && !navBlocks.some(b => b.includes('constructor')),
  `разобрано блоков меню: ${navBlocks.length}`)

// Свободный ввод названия из конструктора убран совсем.
const viewSrc = readFileSync(new URL('./src/ConstructorView.jsx', import.meta.url), 'utf8')
check(S1, 'в конструкторе не осталось поля свободного ввода названия',
  !/Назови как удобно/.test(viewSrc) && !/setNewName/.test(viewSrc))
// fuzzyMatch.js из проекта не удалён (он выверен и покрыт своим набором в
// test-progression-personas.js) — проверяется именно то, что Конструктор его
// больше не импортирует и не вызывает. Упоминание в комментарии не в счёт.
check(S1, 'fuzzyMatch конструктором больше не импортируется',
  !/from\s+'\.\/fuzzyMatch\.js'/.test(viewSrc))
check(S1, 'нечёткое сравнение названий из конструктора убрано',
  !/findSimilarExercise\s*\(|normalizeExerciseName\s*\(/.test(viewSrc))

// ─────────────────────────────────────────────────────────────────────────
// 2. Выбор из каталога заводит упражнение с типом
// ─────────────────────────────────────────────────────────────────────────
const S2 = 'Каталог как источник типа'

const squat = exerciseProfile('Приседания')
check(S2, 'каталожное упражнение опознано как каталожное', squat.fromCatalog === true)
eq(S2, 'у каталожного упражнения известна группа мышц', squat.group, 'legs')
eq(S2, 'у каталожного упражнения известен снаряд', squat.equipment, 'Штанга')
check(S2, 'Приседания — не одностороннее', squat.oneSided === false)

const lunge = exerciseProfile('Болгарские выпады с гантелями')
check(S2, 'Болгарские выпады опознаны как одностороннее', lunge.oneSided === true)
check(S2, 'у одностороннего тоже есть группа и снаряд из каталога',
  lunge.group === 'legs' && lunge.equipment === 'Гантели')

const madeUp = exerciseProfile('Приседания с чем-то своим')
check(S2, 'название не из каталога — fromCatalog=false', madeUp.fromCatalog === false)
check(S2, 'название не из каталога — тип НЕ выдумывается (oneSided=false, группы нет)',
  madeUp.oneSided === false && madeUp.group === null)

// Тип у ВСЕХ каталожных упражнений известен — ровно то, чего не хватало
// свободному вводу и из-за чего конструктор был заморожен.
const typedAll = EXERCISES.every(e => {
  const p = exerciseProfile(e.n)
  return p.fromCatalog && p.group !== null && p.oneSided === isOneSidedExercise(e.n)
})
check(S2, `тип известен у всех ${EXERCISES.length} упражнений каталога`, typedAll)

// Каждое упражнение достижимо через фильтр: групп без подписи быть не должно.
const groups = catalogGroups()
const reachable = EXERCISES.every(e => groups.includes(catalogGroup(e.n)))
check(S2, 'каждое упражнение каталога попадает хотя бы в одну группу фильтра', reachable)
check(S2, `упражнения без группы у muscleGroup собраны в '${CATALOG_OTHER_GROUP}'`,
  EXERCISES.filter(e => !muscleGroup(e.n)).every(e => catalogGroup(e.n) === CATALOG_OTHER_GROUP),
  `таких упражнений: ${EXERCISES.filter(e => !muscleGroup(e.n)).length}`)

// Поиск по названию.
const found = filterCatalog('выпады')
check(S2, 'поиск «выпады» находит выпады и ничего лишнего',
  found.length > 0 && found.every(e => e.n.toLowerCase().includes('выпад')),
  `найдено ${found.length}`)
check(S2, 'поиск нечувствителен к регистру и ё/е',
  filterCatalog('ЖИМ ГАНТЕЛЕЙ ЛЁЖА').length === filterCatalog('жим гантелей лежа').length)
eq(S2, 'пустой запрос без фильтра отдаёт весь каталог', filterCatalog('').length, EXERCISES.length)

// Фильтр по группе мышц.
const legs = filterCatalog('', 'legs')
check(S2, 'фильтр по группе «Ноги» отдаёт только упражнения этой группы',
  legs.length > 0 && legs.every(e => catalogGroup(e.n) === 'legs'), `найдено ${legs.length}`)
const legsSearch = filterCatalog('присед', 'legs')
check(S2, 'поиск и фильтр работают вместе',
  legsSearch.length > 0 && legsSearch.every(e => catalogGroup(e.n) === 'legs' && e.n.toLowerCase().includes('присед')))
eq(S2, 'фильтр по группе, в которой ничего не нашлось запросом, отдаёт пусто',
  filterCatalog('присед', 'arms').length, 0)

// Дедуп вместо fuzzyMatch: упражнение либо УЖЕ в списке под каталожным
// названием, либо его там нет — третьего теперь не дано.
const myList = [{ id: 7, name: 'Приседания' }, { id: 9, name: 'Мой присед' }]
eq(S2, 'каталожное упражнение уже в списке → возвращается та же запись (история продолжится)',
  findByCatalogName('Приседания', myList)?.id, 7)
eq(S2, 'похожего названия мало — совпадение только точное по каталожному имени',
  findByCatalogName('Приседания с резиной', myList), null)
eq(S2, 'пустой личный список — совпадений нет', findByCatalogName('Приседания', []), null)

// Каталожное название и есть ссылка на каталог — колонок в таблице не
// прибавилось, значит запись обязана матчиться обратно один в один.
check(S2, 'по сохранённому названию упражнение находится в каталоге обратно',
  EXERCISES.every(e => catalogExercise(e.n)?.n === e.n))

// ─────────────────────────────────────────────────────────────────────────
// 3. Одностороннее получает свою схему повторов
// ─────────────────────────────────────────────────────────────────────────
const S3 = 'Схема односторонних'

eq(S3, 'Объём — 15-12 (из документа)', ONE_SIDED_SCHEMES.volume, [15, 12])
eq(S3, 'Развитие — 12-10 (из документа)', ONE_SIDED_SCHEMES.development, [12, 10])
eq(S3, 'Сила — 10-8 (из документа)', ONE_SIDED_SCHEMES.strength, [10, 8])
check(S3, 'у односторонних 2 подхода вместо обычных 4',
  PHASE_ORDER.every(p => ONE_SIDED_SCHEMES[p].length === 2) &&
  PHASE_ORDER.every(p => PHASE_SCHEMES[p].light.length === 4))
eq(S3, 'baseline-замер одностороннего — тоже 2 строки (сумма сравнима со схемами)',
  [baselineSetCount(true), baselineSetCount(false)], [2, 4])

// Сессии собираются существующим buildConstructorSessions — его не трогали.
let seq = 0
const session = (reps, rating, date = '2026-08-01') =>
  reps.map(r => ({ id: ++seq, date, created_at: `${date}T10:00:0${seq % 10}.000Z`, kg: 20, reps: r, rating }))
// Разные тренировки разводятся датой, как и раньше.
const sessionsOf = (...days) => buildConstructorSessions(days.flatMap((reps, i) =>
  session(reps, 3, `2026-08-0${i + 1}`)))

// Стартовая фаза одностороннего — по сумме 2 подходов (27/22/18), а не по
// коридорам четырёхподходных схем (там любая такая сумма была бы «Сила»).
eq(S3, 'замер 15+12=27 → стартовая фаза Объём', classifyOneSidedStartPhase(27), 'volume')
eq(S3, 'замер 12+10=22 → стартовая фаза Развитие', classifyOneSidedStartPhase(22), 'development')
eq(S3, 'замер 10+8=18 → стартовая фаза Сила', classifyOneSidedStartPhase(18), 'strength')
eq(S3, 'замер выше всех схем (40) → ближайшая, Объём', classifyOneSidedStartPhase(40), 'volume')
eq(S3, 'замер ниже всех схем (5) → ближайшая, Сила', classifyOneSidedStartPhase(5), 'strength')
eq(S3, 'замер между Объёмом и Развитием (24) → ближайшее Развитие', classifyOneSidedStartPhase(24), 'development')
eq(S3, 'замер ровно посередине Развития и Силы (20) → более лёгкая, Развитие',
  classifyOneSidedStartPhase(20), 'development')

// Одна проведённая тренировка (baseline) → схема на следующую.
const afterVolume = getUpcomingScheme(sessionsOf([15, 12]), { oneSided: true })
eq(S3, 'после замера 15/12 следующая тренировка — Развитие 12-10',
  [afterVolume.phase, afterVolume.reps], ['development', [12, 10]])
check(S3, 'схема помечена как односторонняя', afterVolume.oneSided === true)
eq(S3, 'ступени тяжести у односторонних нет — step=null, а не выдуманная «лёгкая»',
  afterVolume.step, null)

// Большой цикл — та же ротация фаз, что и у обычных упражнений (логику не
// переписывали, она общая).
const rot = [1, 2, 3, 4].map(n => getUpcomingScheme(sessionsOf(...Array(n).fill([15, 12])), { oneSided: true }))
eq(S3, 'фазы ротируются по кругу от стартовой: Развитие → Сила → Объём → Развитие',
  rot.map(r => r.phase), ['development', 'strength', 'volume', 'development'])
eq(S3, 'повторы каждой фазы — из односторонней таблицы, а не из 3×3',
  rot.map(r => r.reps), [[12, 10], [10, 8], [15, 12], [12, 10]])

// То же упражнение без флага одностороннего считается по-старому — значит
// флаг действительно единственное, что меняется.
const asRegular = getUpcomingScheme(sessionsOf([15, 12]))
eq(S3, 'без флага одностороннего — прежняя четырёхподходная схема',
  asRegular.reps.length, 4)
check(S3, 'без флага одностороннего ступень тяжести на месте',
  ['light', 'medium', 'heavy'].includes(asRegular.step))

// Первая тренировка упражнения — замер в любом случае.
check(S3, 'истории нет → baseline, схему не навязываем',
  getUpcomingScheme([], { oneSided: true }).isBaseline === true)

// Откат −15% общий, отдельной ветки для односторонних в нём нет.
const hardHistory = buildConstructorSessions([
  ...session([15, 12], 3, '2026-08-01'),
  ...session([12, 10], 5, '2026-08-03'),
  ...session([12, 10], 5, '2026-08-05'),
])
check(S3, 'две тяжёлые подряд на одностороннем — откат срабатывает так же',
  hasHardStreak(hardHistory) === true)

// ─────────────────────────────────────────────────────────────────────────
// 4. Старые строки со свободными названиями не сломаны
// ─────────────────────────────────────────────────────────────────────────
const S4 = 'Старые упражнения'

const legacySessions = sessionsOf([20, 20, 20, 20])
const legacyProfile = exerciseProfile('Присед в смите как у Кости')
const legacyScheme = getUpcomingScheme(legacySessions, { oneSided: legacyProfile.oneSided })
eq(S4, 'старое название считается как раньше — 4 подхода', legacyScheme.reps.length, 4)
check(S4, 'у старого названия остаётся ступень тяжести (прежняя логика целиком)',
  ['light', 'medium', 'heavy'].includes(legacyScheme.step))
check(S4, 'старому названию не приписывают тип «одностороннее»', legacyProfile.oneSided === false)

// Даже если в свободном названии есть слово «выпады» — оно НЕ из каталога,
// значит новую схему не получает: тип берётся только из каталога.
const legacyLunge = exerciseProfile('выпады мои домашние')
check(S4, 'слово «выпады» в свободном названии не включает новую схему само по себе',
  legacyLunge.fromCatalog === false && legacyLunge.oneSided === false)

// Старая запись видна в списке выбора отдельной секцией — её отбирают тем же
// признаком fromCatalog, что и здесь.
check(S4, 'конструктор показывает старые записи отдельным списком',
  /legacyMatches/.test(viewSrc) && /fromCatalog/.test(viewSrc))

// ─────────────────────────────────────────────────────────────────────────
// Итоги
// ─────────────────────────────────────────────────────────────────────────
let currentSection = null
for (const r of rows) {
  if (r.section !== currentSection) {
    currentSection = r.section
    console.log(`\n── ${currentSection} ${'─'.repeat(Math.max(0, 58 - currentSection.length))}`)
  }
  console.log(`${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}`)
  if (!r.ok && r.actual) console.log(`   → ${r.actual}`)
}
console.log('\n────────────────────────────────────────────────────────────────────')
console.log(`Итог: ${passed} пройдено, ${failed} провалено`)
process.exit(failed ? 1 : 0)
