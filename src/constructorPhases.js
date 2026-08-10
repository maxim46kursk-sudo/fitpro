// Фазы/ступени тяжести для Конструктора (ConstructorView в App.jsx) — вторая
// ось прогрессии поверх 1ПМ-движка (buildExerciseAggregates/computeTargetWeight
// в workoutPrompt.js, который здесь переиспользуется БЕЗ изменений). Чат и
// WorkoutsView этот файл не импортируют и о нём не знают.
//
// Единица — не тоннаж, а 1ПМ (Эпли, oneRepMax.js). Раскладка на 4 подхода —
// готовые схемы повторов по фазе/ступени, вес каждого подхода — обратный
// расчёт от 1ПМ под повторы именно этого подхода (weightForReps).
import { oneRepMax, weightForReps, roundToPlate } from './oneRepMax.js'
import { EXERCISES, isOneSidedExercise } from './programs.js'
import { muscleGroup } from './exerciseMeta.js'

export const PHASE_ORDER = ['volume', 'development', 'strength']
export const STEP_ORDER = ['light', 'medium', 'heavy']

export const PHASE_LABELS = { volume: 'Объём', development: 'Развитие', strength: 'Сила' }
export const STEP_LABELS = { light: 'лёгкая', medium: 'средняя', heavy: 'тяжёлая' }

// Готовые раскладки 4 подходов по фазе/ступени.
export const PHASE_SCHEMES = {
  volume:      { light: [20, 20, 20, 20], medium: [20, 20, 15, 15], heavy: [20, 15, 15, 15] },
  development: { light: [15, 12, 12, 12], medium: [15, 12, 12, 10], heavy: [15, 12, 10, 10] },
  strength:    { light: [12, 10, 8, 6],   medium: [10, 8, 8, 8],    heavy: [10, 8, 6, 6] },
}

// Раскладка для ОДНОСТОРОННИХ упражнений (выпады, работа одной ногой/рукой) —
// одна схема на фазу вместо 3×3 выше, ровно как записано в
// docs/CONSTRUCTOR_FROZEN.md: «Объём 15-12, Развитие 12-10, Сила 10-8, вместо
// обычных 4 подходов». Дефис там — разделитель ПОДХОДОВ (та же нотация, что
// «20-20-20-20» в таблице фаз), поэтому одностороннее упражнение идёт в 2
// подхода: клиент делает каждый на обе стороны.
//
// Ступени тяжести (малый цикл) для односторонних НЕ определены — методика даёт
// по одной схеме на фазу. Поэтому у односторонних работает только большой цикл
// (ротация фаз), а step возвращается null: возвращать «лёгкую/среднюю/тяжёлую»,
// которая ни на что не влияет, значило бы врать вызывающему. Сама ротация фаз,
// группировка сессий и откат −15% — общие с обычными упражнениями, ни одна
// строка той логики ниже не меняется.
export const ONE_SIDED_SCHEMES = {
  volume: [15, 12],
  development: [12, 10],
  strength: [10, 8],
}

const schemeSum = (phase, step) => PHASE_SCHEMES[phase][step].reduce((a, b) => a + b, 0)
const oneSidedSum = phase => ONE_SIDED_SCHEMES[phase].reduce((a, b) => a + b, 0)

// Коридоры суммы 4 повторов по фазам — не пересекаются (Сила 30-36, Развитие
// 47-51, Объём 65-80). Ниже/выше/в зазоре между коридорами — ближайший край.
const PHASE_CORRIDORS = { volume: [65, 80], development: [47, 51], strength: [30, 36] }

function classifyPhaseFromSum(sumReps) {
  for (const phase of PHASE_ORDER) {
    const [lo, hi] = PHASE_CORRIDORS[phase]
    if (sumReps >= lo && sumReps <= hi) return phase
  }
  // За пределами всех коридоров (или в зазоре между ними) — ближайший по
  // расстоянию до края. На точном равенстве расстояний (возможно только при
  // сумме=58, ровно между Объёмом и Развитием) побеждает первый проверенный
  // по PHASE_ORDER — Объём; выбор произвольный, реальный ввод так точно
  // никогда не ляжет.
  let best = null, bestDist = Infinity
  for (const phase of PHASE_ORDER) {
    const [lo, hi] = PHASE_CORRIDORS[phase]
    const dist = sumReps < lo ? lo - sumReps : sumReps - hi
    if (dist < bestDist) { bestDist = dist; best = phase }
  }
  return best
}

// Ступень внутри фазы — наименьшая схема-сумма, которая ещё >= фактической
// суммы (это одно правило разом даёт «округление вверх к более лёгкой» на
// 48→49, «выше лёгкой→лёгкая» и «ниже тяжёлой→тяжёлая» без отдельных веток).
function classifyStepFromSum(phase, sumReps) {
  let bestStep = null, bestSum = Infinity
  for (const step of STEP_ORDER) {
    const sum = schemeSum(phase, step)
    if (sum >= sumReps && sum < bestSum) { bestSum = sum; bestStep = step }
  }
  return bestStep || 'light'
}

export function classifyStartPhaseAndStep(sumReps) {
  const phase = classifyPhaseFromSum(sumReps)
  const step = classifyStepFromSum(phase, sumReps)
  return { phase, step }
}

// Стартовая фаза одностороннего упражнения. Коридоры сумм выше (Объём 65-80 и
// т.д.) посчитаны для 4 подходов и к 2-подходной раскладке неприменимы: любой
// реальный замер односторонних (сумма ~18-27) провалился бы в Силу. Здесь тот
// же принцип «ближайший край», но по суммам самих односторонних схем
// (Объём 27, Развитие 22, Сила 18) — ступеней у них нет, значит и коридоров
// внутри фазы тоже, сравнивать не с чем, кроме единственной суммы фазы.
// Единственное равное расстояние на целых суммах — 20 (ровно между Развитием
// 22 и Силой 18); там, как и в classifyPhaseFromSum, побеждает первая по
// PHASE_ORDER, то есть Развитие — округление в сторону более лёгкой схемы.
export function classifyOneSidedStartPhase(sumReps) {
  let best = null, bestDist = Infinity
  for (const phase of PHASE_ORDER) {
    const dist = Math.abs(oneSidedSum(phase) - sumReps)
    if (dist < bestDist) { bestDist = dist; best = phase }
  }
  return best
}

// Группировка сырых строк constructor_sets в отдельные тренировки.
// Правило: каждое нажатие "Завершить" — это ОТДЕЛЬНАЯ законченная тренировка,
// независимо от того, сколько реального времени прошло с предыдущей (секунда
// или сутки) — "продолжить" ту же тренировку клиент делает через
// "Редактировать" в дневнике, а не повторным "Начать". Раньше границей
// служила ТОЛЬКО дата — из-за этого две настоящие тренировки одного
// упражнения в один день (утро/вечер, докачка, да и просто быстрый повторный
// клик "Начать") схлопывались движком в ОДНУ сессию: ротация фаз пропускала
// шаг, счётчик отката терял тренировку. В таблице нет отдельного id сессии,
// поэтому граница определяется по факту записи: один клик "Завершить" пишет
// все подходы упражнения пачкой за доли секунды (created_at отличается на
// миллисекунды), а между ДВУМЯ разными кликами — сколько угодно UI-действий
// (закрыть карточку, выбрать/добавить упражнение, вписать вес, поставить
// оценку), физически не меньше нескольких секунд даже при самом быстром
// тестировании. SESSION_GAP_MS ловит именно этот разрыв, а не "человеческую"
// паузу между тренировками.
const SESSION_GAP_MS = 10 * 1000 // 10 секунд

export function buildConstructorSessions(history) {
  if (!history || !history.length) return []
  const sorted = history.slice().sort((a, b) => a.id - b.id)
  const groups = []
  let current = []
  let prevTime = null
  for (const row of sorted) {
    const t = new Date(row.created_at).getTime()
    const hasGap = prevTime != null && !Number.isNaN(t) && (t - prevTime) > SESSION_GAP_MS
    const isNewDate = current.length > 0 && row.date !== current[current.length - 1].date
    if (current.length === 0 || isNewDate || hasGap) {
      if (current.length) groups.push(current)
      current = []
    }
    current.push(row)
    if (!Number.isNaN(t)) prevTime = t
  }
  if (current.length) groups.push(current)

  return groups.map(daySets => {
    const workingCount = Math.min(2, daySets.length)
    const workingSets = daySets.slice(daySets.length - workingCount)
    const effRatings = workingSets.map(s => s.rating ?? 3)
    return { date: daySets[0].date, sets: daySets, workingSets, effRatings }
  })
}

// Большой цикл — фиксированная ротация от стартовой фазы (не обязательно
// Объём: если первая тренировка попала в Развитие, дальше идёт Развитие →
// Сила → Объём → Развитие…).
function phaseAt(startPhase, i) {
  const startIdx = PHASE_ORDER.indexOf(startPhase)
  return PHASE_ORDER[(startIdx + i) % 3]
}

// Сколько раз конкретная фаза уже встретилась в тренировках 0..i включительно.
function occurrenceNum(startPhase, phase, i) {
  let count = 0
  for (let j = 0; j <= i; j++) if (phaseAt(startPhase, j) === phase) count++
  return count
}

// Малый цикл — своя ступень на фазу, растёт при каждом появлении фазы
// (лёгкая→средняя→тяжёлая→снова лёгкая). У стартовой фазы 1-е появление —
// это сама baseline-тренировка (index 0), её ступень уже известна из суммы.
// У остальных двух фаз 1-е появление всегда лёгкая (истории ещё нет).
function stepAtOccurrence(startStep, isStartPhase, occurrence) {
  const baseIdx = isStartPhase ? STEP_ORDER.indexOf(startStep) : 0
  return STEP_ORDER[(baseIdx + occurrence - 1) % 3]
}

// Раскладка на СЛЕДУЮЩУЮ (ещё не проведённую) тренировку упражнения.
// sessions — результат buildConstructorSessions (index 0 — baseline, первая
// тренировка, которую клиент заполнил сам полностью вручную).
//
// oneSided — тип упражнения, приходит ИЗ КАТАЛОГА (см. exerciseProfile ниже),
// а не угадывается здесь. Умолчание false — ровно прежнее поведение, поэтому
// все старые вызовы (и старые строки constructor_exercises со свободными
// названиями, которых каталог не знает) считаются как раньше, 4 подхода.
export function getUpcomingScheme(sessions, { oneSided = false } = {}) {
  if (!sessions || sessions.length === 0) return { isBaseline: true }
  const baseline = sessions[0]
  const sumReps = baseline.sets.reduce((sum, s) => sum + (Number(s.reps) || 0), 0)
  const i = sessions.length // индекс тренировки, которую сейчас собираем
  if (oneSided) {
    const startPhase = classifyOneSidedStartPhase(sumReps)
    const phase = phaseAt(startPhase, i)
    return { isBaseline: false, phase, step: null, reps: ONE_SIDED_SCHEMES[phase], oneSided: true }
  }
  const { phase: startPhase, step: startStep } = classifyStartPhaseAndStep(sumReps)
  const phase = phaseAt(startPhase, i)
  const isStartPhase = phase === startPhase
  const occurrence = occurrenceNum(startPhase, phase, i)
  const step = stepAtOccurrence(startStep, isStartPhase, occurrence)
  return { isBaseline: false, phase, step, reps: PHASE_SCHEMES[phase][step] }
}

// Откат −15% one-shot (только Конструктор — buildDeload в workoutPrompt.js,
// которым пользуется чат, НЕ трогаем и не переиспользуем).
//
// Триггер: два тяжёлых (оценка >=4) подряд на упражнении → следующая
// тренировка получает 1ПМ текущего анкера ×0.85 вместо обычного роста по
// таблице оценок. Разовый: как только откат применился, счётчик подряд
// тяжёлых обнуляется — следующий откат возможен только после ДВУХ НОВЫХ
// тяжёлых тренировок, случившихся ПОСЛЕ этого отката (не считая ни саму
// тренировку с откатом, ни то, что было до него). Без этого сброса пара,
// которая уже вызвала откат, при сдвиге окна на одну тренировку вперёд
// повторно засчиталась бы во вторую тяжёлую пару подряд — залипание.
//
// Пересчитывается заново из истории constructor_sets при каждом обращении,
// никакого отдельного состояния/флага в БД не хранится.
export function hasHardStreak(sessions) {
  if (!sessions || sessions.length < 2) return false
  const realSessions = sessions.slice(1) // без baseline — она не оценивается на рост/откат
  let streak = 0
  for (const s of realSessions) {
    if (streak >= 2) streak = 0 // эта тренировка уже получила откат — счётчик с неё стартует заново
    const rating = s.effRatings.length ? s.effRatings[s.effRatings.length - 1] : 3
    streak = rating >= 4 ? streak + 1 : 0
  }
  return streak >= 2
}

// Вес подхода при сработавшем откате — то же обратное масштабирование от
// 1ПМ, что и в computeTargetWeight (workoutPrompt.js), но без таблицы
// процентов роста: фиксированные −15% от текущего анкера. Знак якоря
// (ассист-тренажёры хранят вес отрицательным) обрабатывается тем же
// способом, что и в оригинале — "легче" для ассист-упражнения означает
// больше помощи, то есть более отрицательное число.
export function computeHardStreakTarget(anchorSet, targetReps) {
  if (!targetReps || !anchorSet || !anchorSet.kg || !anchorSet.reps) return null
  const anchorKg = Number(anchorSet.kg)
  const isAssisted = anchorKg < 0
  const anchorRM = oneRepMax(anchorKg, Number(anchorSet.reps))
  if (!anchorRM) return null
  const factor = isAssisted ? 1.15 : 0.85
  const reducedRM = anchorRM * factor
  const rawKg = weightForReps(reducedRM, targetReps)
  return { kg: roundToPlate(rawKg), rawKg, isDeload: true, appliedPct: -15 }
}

// ─────────────────────────────────────────────────────────────────────────
// Источник истины о типе упражнения — КАТАЛОГ (EXERCISES в programs.js)
// ─────────────────────────────────────────────────────────────────────────
// Именно отсутствие такого источника и заморозило Конструктор (см.
// docs/CONSTRUCTOR_FROZEN.md): клиент вводил название руками, и понять,
// одностороннее упражнение или нет, было неоткуда. Теперь упражнение можно
// только ВЫБРАТЬ из каталога, а связь с каталогом — само название: в
// constructor_exercises хранится ровно EXERCISES[].n, колонок в таблице не
// прибавилось. Отсюда же берётся группа мышц для фильтра.
//
// programs.js и exerciseMeta.js здесь только читаются и вызываются — шаблонные
// программы этот файл не импортируют и о нём не знают, как и раньше.

const CATALOG_BY_NAME = new Map(EXERCISES.map(e => [e.n, e]))

// Группа мышц для фильтра — muscleGroup (exerciseMeta.js) по названию.
// У 15 из 76 каталожных упражнений эвристика ответа не даёт (отведения бёдер,
// Фроги, Спайдер, Трастеры и т.п.) — они собираются в 'other', иначе фильтр
// делал бы их недостижимыми.
export const CATALOG_OTHER_GROUP = 'other'
export function catalogGroup(name) {
  return muscleGroup(name) || CATALOG_OTHER_GROUP
}

// Все группы, реально представленные в каталоге, в порядке первого появления —
// чтобы UI не рисовал фильтр по пустой группе.
export function catalogGroups() {
  const seen = []
  for (const e of EXERCISES) { const g = catalogGroup(e.n); if (!seen.includes(g)) seen.push(g) }
  return seen
}

// Запись каталога по названию или null, если названия там нет — это и есть
// признак «старое упражнение со свободным названием».
export function catalogExercise(name) {
  return CATALOG_BY_NAME.get(name) || null
}

// Всё, что Конструктору нужно знать об упражнении. fromCatalog=false — старая
// строка constructor_exercises со свободным названием: показываем как есть,
// прогрессию считаем по-старому (4 подхода), тип не выдумываем.
export function exerciseProfile(name) {
  const entry = catalogExercise(name)
  if (!entry) return { name, fromCatalog: false, oneSided: false, group: null, muscle: '', equipment: '' }
  return {
    name: entry.n,
    fromCatalog: true,
    oneSided: isOneSidedExercise(entry.n),
    group: catalogGroup(entry.n),
    muscle: entry.m,
    equipment: entry.eq,
  }
}

// Сколько строк вес/повторы показать на baseline-замере. У односторонних их
// 2 (см. ONE_SIDED_SCHEMES): классификация стартовой фазы считает СУММУ
// повторов замера, и замер обязан быть той же длины, что и схемы, с которыми
// его сравнивают.
export function baselineSetCount(oneSided) {
  return oneSided ? ONE_SIDED_SCHEMES.volume.length : PHASE_SCHEMES.volume.light.length
}

const normalizeQuery = s => (s || '').toLowerCase().replace(/ё/g, 'е').trim()

// Поиск по каталогу: подстрока в названии + фильтр по группе мышц. Оба
// параметра необязательны; пустой запрос без группы отдаёт весь каталог.
export function filterCatalog(query = '', group = null) {
  const q = normalizeQuery(query)
  return EXERCISES.filter(e => {
    if (group && catalogGroup(e.n) !== group) return false
    return !q || normalizeQuery(e.n).includes(q)
  })
}

// Замена fuzzyMatch (findSimilarExercise) при добавлении упражнения. Нечёткое
// сравнение названий было нужно, пока клиент вводил название руками и мог
// написать «присед» вместо «Приседания»; выбор из каталога делает вопрос
// точным — упражнение либо УЖЕ есть в личном списке под тем же каталожным
// названием, либо его там нет. fuzzyMatch.js остаётся в проекте (он выверен и
// покрыт тестами), но Конструктор его больше не вызывает.
export function findByCatalogName(name, list) {
  return (list || []).find(ex => ex.name === name) || null
}
