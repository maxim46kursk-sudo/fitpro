// Волновой движок прогрессии — второй, для программ опытных.
//
// Нынешний движок (workoutPrompt.js) считает вес от самочувствия: оценка
// последних рабочих подходов → процент роста 1ПМ (+5% на тройку и т.д.).
// Для новичка это верно, для опытного — нет: он упирается за три тренировки и
// дальше живёт в вечном откате. Здесь другое правило: вес задаёт НЕ прошлое
// самочувствие, а место в цикле — сколько повторений и с каким запасом
// назначено на сегодня.
//
// Методика (утверждена тренером):
//   1. Оценка 1-5 читается как запас повторений: 5 — ноль в запасе, 1 — четыре.
//   2. Максимум считается по Эпли с учётом запаса, то есть по тому, сколько
//      человек МОГ БЫ сделать, а не сколько сделал.
//   3. Максимум замеряется ТОЛЬКО на подходах до 10 повторений. Формула Эпли
//      врёт тем сильнее, чем длиннее подход (на 5 повторениях стандартная
//      ошибка уже ~10 кг), и сам человек на длинных подходах промахивается с
//      запасом в среднем на 5 повторений. Двадцатиповторный Объём вес из
//      максимума ПОЛУЧАЕТ, но сам максимум не двигает.
//   4. Рабочий максимум сглажен: лучший из трёх последних тренировок.
//   5. Рост максимума ограничен потолком за тренировку (см. GROWTH_CAP).
//      Вниз потолка нет — если человек реально слабее, идём за ним сразу.
//   6. Ступень цикла (лёгкая/средняя/тяжёлая) задаёт запас, с которым сегодня
//      работаем: 4 / 2 / 1. Ступень читается из САМОЙ программы — по сумме
//      повторений, тем же классификатором, что и в Конструкторе. Поэтому
//      правило «повторения всегда из шаблона» остаётся нетронутым, а любая
//      программа заезжает на этот движок без переписывания.
//
// Модуль ЧИСТЫЙ: ничего не читает и не пишет, состояния не держит, всё
// пересчитывается из переданной истории — как и остальная прогрессия.

import { oneRepMax, weightForReps, roundToPlate, plateStep } from './oneRepMax.js'
import { classifyStartPhaseAndStep } from './constructorPhases.js'

// Оценка последнего рабочего подхода → запас повторений (RIR).
export const RIR_BY_RATING = { 5: 0, 4: 1, 3: 2, 2: 3, 1: 4 }
// Нет оценки — считаем 3, как и в нынешнем движке.
export const DEFAULT_RATING = 3

// Запас, с которым работаем сегодня, по ступени цикла. Это запас РАБОЧИХ
// подходов; подводящие идут легче, см. rirRamp.
export const RIR_BY_STEP = { light: 4, medium: 2, heavy: 1 }

// Сколько последних подходов считаются рабочими. То же структурное правило,
// что и в buildExerciseAggregates нынешнего движка: подводящие впереди,
// рабочие в конце. Держим одно число на оба движка, чтобы не разъехались.
export const WORKING_SETS = 2

// На сколько каждый шаг назад от рабочих подходов добавляет запаса, и потолок
// добавки. Без этого все подходы получали бы один вес, и подводящий подход на
// десять повторений оказывался бы тяжелее, чем нужно, — это и показал теневой
// прогон на живой истории приседа.
export const RAMP_STEP = 1
export const RAMP_MAX = 3

// Выше этого числа повторений подход в замер максимума не идёт (п.3 методики).
export const MAX_REPS_FOR_MEASURE = 10

// Потолок роста рабочего максимума за ОДНУ тренировку, кг.
// Ключ приходит от вызывающего: он знает упражнение, модуль — нет.
export const GROWTH_CAP = { base: 2.5, upper: 1.25, isolation: 1 }
export const DEFAULT_GROWTH_CAP = GROWTH_CAP.upper

// Окно сглаживания: берём лучший максимум за столько последних тренировок.
export const MAX_WINDOW = 3

// Реактивный откат: сколько тренировок подряд надо не добрать заданные
// повторения, и насколько тогда опускается максимум.
export const MISS_STREAK = 2
export const MISS_DROP = 0.05

export function rirOfRating(rating) {
  const r = Number(rating)
  return RIR_BY_RATING[r] != null ? RIR_BY_RATING[r] : RIR_BY_RATING[DEFAULT_RATING]
}

// Максимум по одному подходу. Возвращает 0, если подход в замер не годится:
// нет веса, нет повторений или повторений больше порога.
// Ассист-тренажёры хранят вес отрицательным — они меряются по модулю, знак
// возвращается вызывающему отдельно (см. planSets).
export function maxFromSet(set) {
  if (!set) return 0
  const kg = Number(set.kg), reps = Number(set.reps)
  if (!kg || !reps || reps < 1) return 0
  if (reps > MAX_REPS_FOR_MEASURE) return 0
  return oneRepMax(Math.abs(kg), reps + rirOfRating(set.rating))
}

// Максимум по одной тренировке — лучший из её РАБОЧИХ подходов, годных к
// замеру. Подводящие в замер не идут: они делаются далеко от отказа, оценка
// на них если и стоит, то не про предел, и максимум по ним — выдумка.
export function maxFromSession(session) {
  const all = (session && session.sets) || []
  const working = all.length > WORKING_SETS ? all.slice(-WORKING_SETS) : all
  let best = 0
  for (const s of working) {
    const m = maxFromSet(s)
    if (m > best) best = m
  }
  return best
}

// Рабочий максимум по истории упражнения.
// sessions — от старых к новым, каждая { sets: [{kg, reps, rating}], missed? }.
// Возвращает 0, если замерить не с чего (холодный старт — вес берётся прямо
// из программы, как и сейчас).
export function workingMax(sessions, capKg = DEFAULT_GROWTH_CAP) {
  const cap = Number(capKg) > 0 ? Number(capKg) : DEFAULT_GROWTH_CAP
  let current = 0
  const trail = []
  for (const s of sessions || []) {
    const measured = maxFromSession(s)
    if (!measured) continue
    // Первый замер принимаем как есть, дальше рост ограничен потолком.
    // Вниз потолка нет: стал слабее — идём за ним сразу.
    current = !current ? measured : (measured > current ? Math.min(measured, current + cap) : measured)
    trail.push(current)
  }
  if (!trail.length) return 0
  return Math.max(...trail.slice(-MAX_WINDOW))
}

// Сколько последних тренировок подряд человек не добрал заданные повторения.
// Признак missed ставит вызывающий: только он знает, что было назначено.
export function missStreak(sessions) {
  let n = 0
  for (let i = (sessions || []).length - 1; i >= 0; i--) {
    if (!sessions[i] || !sessions[i].missed) break
    n++
  }
  return n
}

// Лестница подводящих подходов.
//
// Первая версия давала всем подходам один запас — и подводящий подход на
// десять повторений выходил почти как рабочий. Теневой прогон на живой истории
// приседа это и показал. Правило теперь другое: движок считает вес ТОЛЬКО для
// рабочих подходов, а лестницу подводящих берёт из самой программы — в каком
// соотношении их написал тренер, в таком и оставляет, целиком двигая вверх или
// вниз вместе с рабочим весом. «20-30-40-40» останется 20-30-40-40 по форме,
// даже когда сорок превратятся в пятьдесят.
//
// Запасной вариант rirRamp ниже нужен там, где у программы весов нет вообще
// (вес тела, резина): соотношение брать не из чего, поэтому лестница строится
// по запасу.
export function templateRatios(templateSets) {
  const tpl = templateSets || []
  if (!tpl.length) return null
  const last = Math.abs(Number(tpl[tpl.length - 1].templateKg))
  if (!last) return null
  const ratios = tpl.map(s => Math.abs(Number(s.templateKg)) / last)
  return ratios.every(r => r > 0 && Number.isFinite(r)) ? ratios : null
}

export function rirRamp(count, targetRir) {
  const n = Number(count) || 0
  if (n < 1) return []
  const firstWorking = Math.max(0, n - WORKING_SETS)
  return Array.from({ length: n }, (_, i) => {
    if (i >= firstWorking) return targetRir
    const back = firstWorking - i
    return targetRir + Math.min(RAMP_MAX, back * RAMP_STEP)
  })
}

// Ступень цикла из самой программы — по сумме повторений сегодняшней
// раскладки. Тот же классификатор, что в Конструкторе: 20-20-20-20 → лёгкий
// Объём, 10-8-6-6 → тяжёлая Сила.
export function stepFromTemplate(templateSets) {
  const sum = (templateSets || []).reduce((acc, s) => acc + (Number(s.reps) || 0), 0)
  if (!sum) return null
  return classifyStartPhaseAndStep(sum)
}

// Вес одного подхода: такой, чтобы заданные повторения делались с нужным
// запасом. Обратная формула Эпли, округление — тем же шагом, что и везде.
export function weightForSet(max, reps, rir, sign = 1) {
  if (!max || !reps) return null
  const raw = weightForReps(max, Number(reps) + Number(rir))
  if (!raw) return null
  return roundToPlate(raw, plateStep(raw)) * (sign < 0 ? -1 : 1)
}

// Раскладка на сегодня.
//
// templateSets — [{ reps, templateKg }] из шаблона программы (повторения
//   всегда отсюда, вес шаблона нужен только для холодного старта и знака).
// sessions     — история упражнения, от старых к новым.
// capKg        — потолок роста максимума за тренировку для этого упражнения.
//
// Возвращает { coldStart, phase, step, rir, max, isDeload, sets }.
// coldStart: true — истории нет, работаем по весам программы как есть.
export function buildWavePlan({ templateSets, sessions = [], capKg = DEFAULT_GROWTH_CAP }) {
  const tpl = (templateSets || []).filter(s => s && Number(s.reps) > 0)
  if (!tpl.length) return null

  const cls = stepFromTemplate(tpl)
  const step = (cls && cls.step) || 'medium'
  const phase = cls && cls.phase
  const rir = RIR_BY_STEP[step]

  let max = workingMax(sessions, capKg)
  const isDeload = missStreak(sessions) >= MISS_STREAK
  if (max && isDeload) max = max * (1 - MISS_DROP)

  if (!max) {
    return {
      coldStart: true, phase, step, rir, max: 0, isDeload: false,
      sets: tpl.map(s => ({ reps: Number(s.reps), kg: s.templateKg != null ? Number(s.templateKg) : null })),
    }
  }

  // Знак берём из шаблона: у ассист-тренажёров вес отрицательный.
  const negative = tpl.some(s => Number(s.templateKg) < 0)
  const sign = negative ? -1 : 1

  // Вес верхнего рабочего подхода — по его повторениям и запасу ступени.
  const topReps = Number(tpl[tpl.length - 1].reps)
  const topRaw = weightForReps(max, topReps + rir)
  const ratios = templateRatios(tpl)

  const sets = ratios
    ? tpl.map((s, i) => {
        const raw = topRaw * ratios[i]
        return { reps: Number(s.reps), rir: i >= tpl.length - WORKING_SETS ? rir : null,
                 kg: roundToPlate(raw, plateStep(raw)) * sign }
      })
    : (() => {
        const ramp = rirRamp(tpl.length, rir)
        return tpl.map((s, i) => ({ reps: Number(s.reps), rir: ramp[i], kg: weightForSet(max, s.reps, ramp[i], sign) }))
      })()

  return { coldStart: false, phase, step, rir, max, isDeload, sets }
}
