// Фазы Конструктора (ConstructorView) — вторая ось прогрессии поверх
// 1ПМ-движка (buildExerciseAggregates/computeTargetWeight в workoutPrompt.js,
// который здесь переиспользуется БЕЗ изменений). Чат и WorkoutsView этот файл
// не импортируют и о нём не знают — шаблонные программы живут своей жизнью.
//
// Единица — не тоннаж, а 1ПМ (Эпли, oneRepMax.js). Раскладка на 4 подхода —
// готовая схема повторов по фазе, вес каждого подхода — обратный расчёт от
// 1ПМ под повторы именно этого подхода (weightForReps).
//
// ── СХЕМЫ ПОВТОРОВ, редакция 11.08.2026 (решение владельца методики) ──────
// Ступени тяжести (лёгкая/средняя/тяжёлая) УПРАЗДНЕНЫ у обеих категорий: на
// фазу приходится ровно одна схема, малого цикла больше нет. Двусторонние
// идут РОВНО, без снижения внутри тренировки; односторонние — со снижением от
// подхода к подходу. Большой цикл (ротация фаз), рост по оценкам, откат −15% и
// группировка сессий не менялись.
import { oneRepMax, weightForReps, roundToPlate } from './oneRepMax.js'
import { EXERCISES, isOneSidedExercise } from './programs.js'
import { muscleGroup } from './exerciseMeta.js'

export const PHASE_ORDER = ['volume', 'development', 'strength']
export const PHASE_LABELS = { volume: 'Объём', development: 'Развитие', strength: 'Сила' }

// Двусторонние: ровная схема, все подходы одинаковые (Σ 96 / 80 / 64).
export const PHASE_SCHEMES = {
  volume: [24, 24, 24, 24],
  development: [20, 20, 20, 20],
  strength: [16, 16, 16, 16],
}

// Односторонние (выпады, работа одной ногой/рукой): столько же подходов, но со
// снижением повторов внутри тренировки (Σ 54 / 44 / 36).
export const ONE_SIDED_SCHEMES = {
  volume: [15, 14, 13, 12],
  development: [12, 11, 11, 10],
  strength: [10, 9, 9, 8],
}

const schemesFor = oneSided => (oneSided ? ONE_SIDED_SCHEMES : PHASE_SCHEMES)
const sumOf = reps => reps.reduce((a, b) => a + b, 0)
// Суммы фаз нигде не зашиты числами — считаются из самих схем, поэтому правка
// схемы автоматически двигает и классификацию замера.
export const phaseSum = (phase, oneSided = false) => sumOf(schemesFor(oneSided)[phase])

// Стартовая фаза по сумме повторов baseline-замера. Раньше у двусторонних были
// коридоры (три ступени — три суммы на фазу, между ними промежутки); теперь на
// фазу приходится ровно одно число, поэтому коридор вырождается в точку, и
// правило одно на обе категории: ближайшая по расстоянию сумма фазы. При
// равном расстоянии побеждает первая по PHASE_ORDER — то есть более объёмная,
// округление в сторону более лёгкой по весу схемы.
export function classifyStartPhase(sumReps, oneSided = false) {
  let best = null, bestDist = Infinity
  for (const phase of PHASE_ORDER) {
    const dist = Math.abs(phaseSum(phase, oneSided) - sumReps)
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

// Раскладка на СЛЕДУЮЩУЮ (ещё не проведённую) тренировку упражнения.
// sessions — результат buildConstructorSessions (index 0 — baseline, первая
// тренировка, которую клиент заполнил сам полностью вручную).
//
// oneSided — тип упражнения, приходит ИЗ КАТАЛОГА (см. exerciseProfile ниже),
// а не угадывается здесь. Отличается только таблица схем: ротация фаз, откат и
// всё остальное у обеих категорий общее.
//
// step — всегда null: ступеней тяжести в методике больше нет (редакция
// 11.08.2026). Поле оставлено в ответе, чтобы вызывающему не пришлось гадать,
// пропало оно или просто не посчиталось.
export function getUpcomingScheme(sessions, { oneSided = false } = {}) {
  if (!sessions || sessions.length === 0) return { isBaseline: true }
  const baseline = sessions[0]
  const sumReps = baseline.sets.reduce((sum, s) => sum + (Number(s.reps) || 0), 0)
  const i = sessions.length // индекс тренировки, которую сейчас собираем
  const startPhase = classifyStartPhase(sumReps, oneSided)
  const phase = phaseAt(startPhase, i)
  return { isBaseline: false, phase, step: null, reps: schemesFor(oneSided)[phase], oneSided }
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
  return schemesFor(oneSided).volume.length
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
