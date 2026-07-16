// Формулы расчёта одноповторного максимума (1ПМ).
// Переиспользуется калькулятором на главной и (в будущем) логикой прогрессии AI-тренера.

export const ONE_RM_FORMULAS = {
  epley: 'Эпли',
  brzycki: 'Бржицки',
}

// 1ПМ по весу и числу повторений
export function oneRepMax(weight, reps, formula = 'epley') {
  const w = Number(weight), r = Number(reps)
  if (!w || !r || r < 1) return 0
  if (r === 1) return w
  if (formula === 'brzycki') {
    const denom = 1.0278 - 0.0278 * r
    if (denom <= 0) return 0
    return w / denom
  }
  return w * (1 + r / 30)
}

// Обратная формула: какой вес позволит сделать заданное число повторений при известном 1ПМ
export function weightForReps(oneRM, reps, formula = 'epley') {
  const m = Number(oneRM), r = Number(reps)
  if (!m || !r || r < 1) return 0
  if (r === 1) return m
  if (formula === 'brzycki') {
    return m * (1.0278 - 0.0278 * r)
  }
  return m / (1 + r / 30)
}

// Округление рабочего веса до шага блинов в зале (по умолчанию 2.5 кг)
export function roundToPlate(weight, step = 2.5) {
  if (!weight) return 0
  return Math.round(weight / step) * step
}

// Для лёгких весов (махи гантелями, изоляция и т.п.) шаг 2.5 кг — скачок
// 25-50% от рабочего веса. Ниже порога округляем мельче, до 1 кг.
export const LIGHT_WEIGHT_THRESHOLD = 10
export const PLATE_STEP_LIGHT = 1
export const PLATE_STEP_DEFAULT = 2.5

// Шаг округления рекомендованного веса прогрессии по величине веса
// (ассист-тренажёры хранят вес отрицательным — шаг берём по модулю).
export function plateStep(weight) {
  return Math.abs(weight) < LIGHT_WEIGHT_THRESHOLD ? PLATE_STEP_LIGHT : PLATE_STEP_DEFAULT
}

export const PERCENT_TABLE_REPS = [1, 3, 5, 8, 10, 12]

// Таблица рабочих весов на разное число повторений от заданного 1ПМ
export function percentTable(oneRM, formula = 'epley') {
  const m = Number(oneRM)
  if (!m) return []
  return PERCENT_TABLE_REPS.map(reps => {
    const raw = weightForReps(m, reps, formula)
    return { reps, weight: roundToPlate(raw), percent: Math.round((raw / m) * 100) }
  })
}
