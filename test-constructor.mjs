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
  getUpcomingScheme, classifyStartPhase, phaseSum, buildConstructorSessions,
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
const S3 = 'Схемы повторов'

// Редакция 11.08.2026 (решение владельца методики): ступеней тяжести больше
// нет ни у кого, на фазу приходится одна схема. Двусторонние идут ровно,
// односторонние — со снижением внутри тренировки.
eq(S3, 'двусторонние, Объём — ровные 24', PHASE_SCHEMES.volume, [24, 24, 24, 24])
eq(S3, 'двусторонние, Развитие — ровные 20', PHASE_SCHEMES.development, [20, 20, 20, 20])
eq(S3, 'двусторонние, Сила — ровные 16', PHASE_SCHEMES.strength, [16, 16, 16, 16])
check(S3, 'у двусторонних внутри тренировки снижения нет',
  PHASE_ORDER.every(p => new Set(PHASE_SCHEMES[p]).size === 1))

eq(S3, 'односторонние, Объём — 15·14·13·12', ONE_SIDED_SCHEMES.volume, [15, 14, 13, 12])
eq(S3, 'односторонние, Развитие — 12·11·11·10', ONE_SIDED_SCHEMES.development, [12, 11, 11, 10])
eq(S3, 'односторонние, Сила — 10·9·9·8', ONE_SIDED_SCHEMES.strength, [10, 9, 9, 8])
check(S3, 'у односторонних повторы к концу тренировки снижаются',
  PHASE_ORDER.every(p => ONE_SIDED_SCHEMES[p].every((r, i, a) => i === 0 || r <= a[i - 1])
    && ONE_SIDED_SCHEMES[p][0] > ONE_SIDED_SCHEMES[p][3]))

check(S3, 'подходов везде по 4 — и у двусторонних, и у односторонних',
  PHASE_ORDER.every(p => PHASE_SCHEMES[p].length === 4 && ONE_SIDED_SCHEMES[p].length === 4))
eq(S3, 'baseline-замер — 4 строки в обоих случаях',
  [baselineSetCount(true), baselineSetCount(false)], [4, 4])

// Суммы фаз считаются из самих схем, а не зашиты числами.
eq(S3, 'суммы двусторонних — 96 / 80 / 64',
  PHASE_ORDER.map(p => phaseSum(p)), [96, 80, 64])
eq(S3, 'суммы односторонних — 54 / 44 / 36',
  PHASE_ORDER.map(p => phaseSum(p, true)), [54, 44, 36])

// Сессии собираются существующим buildConstructorSessions — его не трогали.
let seq = 0
const session = (reps, rating, date = '2026-08-01') =>
  reps.map(r => ({ id: ++seq, date, created_at: `${date}T10:00:0${seq % 10}.000Z`, kg: 20, reps: r, rating }))
// Разные тренировки разводятся датой, как и раньше.
const sessionsOf = (...days) => buildConstructorSessions(days.flatMap((reps, i) =>
  session(reps, 3, `2026-08-0${i + 1}`)))

// Стартовая фаза — ближайшая сумма фазы. Коридоров больше нет: на фазу одно
// число, поэтому правило одно на обе категории.
eq(S3, 'двусторонний замер Σ96 → Объём', classifyStartPhase(96), 'volume')
eq(S3, 'двусторонний замер Σ80 → Развитие', classifyStartPhase(80), 'development')
eq(S3, 'двусторонний замер Σ64 → Сила', classifyStartPhase(64), 'strength')
eq(S3, 'двусторонний замер выше всех схем (150) → ближайший Объём', classifyStartPhase(150), 'volume')
eq(S3, 'двусторонний замер ниже всех схем (10) → ближайшая Сила', classifyStartPhase(10), 'strength')
eq(S3, 'двусторонний замер ровно между Объёмом и Развитием (88) → более объёмная',
  classifyStartPhase(88), 'volume')

eq(S3, 'односторонний замер Σ54 → Объём', classifyStartPhase(54, true), 'volume')
eq(S3, 'односторонний замер Σ44 → Развитие', classifyStartPhase(44, true), 'development')
eq(S3, 'односторонний замер Σ36 → Сила', classifyStartPhase(36, true), 'strength')
eq(S3, 'односторонний замер ровно между Развитием и Силой (40) → более объёмное',
  classifyStartPhase(40, true), 'development')
// Категории считаются по своим таблицам: одна и та же сумма даёт разные фазы.
eq(S3, 'сумма 54 у двустороннего — это уже Сила, а у одностороннего Объём',
  [classifyStartPhase(54), classifyStartPhase(54, true)], ['strength', 'volume'])

// Одна проведённая тренировка (baseline) → схема на следующую.
const afterVolume = getUpcomingScheme(sessionsOf([15, 14, 13, 12]), { oneSided: true })
eq(S3, 'после одностороннего замера Σ54 следующая тренировка — Развитие 12·11·11·10',
  [afterVolume.phase, afterVolume.reps], ['development', [12, 11, 11, 10]])
check(S3, 'схема помечена как односторонняя', afterVolume.oneSided === true)
eq(S3, 'ступени тяжести нет — step=null', afterVolume.step, null)

const afterTwoSided = getUpcomingScheme(sessionsOf([24, 24, 24, 24]))
eq(S3, 'после двустороннего замера Σ96 следующая тренировка — Развитие 20·20·20·20',
  [afterTwoSided.phase, afterTwoSided.reps], ['development', [20, 20, 20, 20]])
eq(S3, 'у двусторонних ступени тоже нет — step=null', afterTwoSided.step, null)

// Большой цикл — та же ротация фаз, её не меняли.
const rot = [1, 2, 3, 4].map(n => getUpcomingScheme(sessionsOf(...Array(n).fill([15, 14, 13, 12])), { oneSided: true }))
eq(S3, 'фазы ротируются по кругу от стартовой: Развитие → Сила → Объём → Развитие',
  rot.map(r => r.phase), ['development', 'strength', 'volume', 'development'])
eq(S3, 'повторы каждой фазы — из односторонней таблицы',
  rot.map(r => r.reps), [[12, 11, 11, 10], [10, 9, 9, 8], [15, 14, 13, 12], [12, 11, 11, 10]])

const rotTwo = [1, 2, 3, 4].map(n => getUpcomingScheme(sessionsOf(...Array(n).fill([24, 24, 24, 24]))))
eq(S3, 'у двусторонних ротация та же',
  rotTwo.map(r => r.phase), ['development', 'strength', 'volume', 'development'])
eq(S3, 'повторы каждой фазы — из двусторонней таблицы',
  rotTwo.map(r => r.reps), [[20, 20, 20, 20], [16, 16, 16, 16], [24, 24, 24, 24], [20, 20, 20, 20]])

// Флаг односторонности меняет ТОЛЬКО таблицу схем.
const asRegular = getUpcomingScheme(sessionsOf([15, 14, 13, 12]))
eq(S3, 'тот же замер без флага — двусторонняя схема', asRegular.reps.length, 4)
check(S3, 'и она ровная', new Set(asRegular.reps).size === 1)

// Первая тренировка упражнения — замер в любом случае.
check(S3, 'истории нет → baseline, схему не навязываем',
  getUpcomingScheme([], { oneSided: true }).isBaseline === true)

// Откат −15% общий, отдельной ветки для односторонних в нём нет.
const hardHistory = buildConstructorSessions([
  ...session([15, 14, 13, 12], 3, '2026-08-01'),
  ...session([12, 11, 11, 10], 5, '2026-08-03'),
  ...session([12, 11, 11, 10], 5, '2026-08-05'),
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
eq(S4, 'старое название считается как двустороннее — 4 подхода', legacyScheme.reps.length, 4)
check(S4, 'и получает ровную схему, как все двусторонние', new Set(legacyScheme.reps).size === 1)
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
