/**
 * Индексы точек MediaPipe Pose (33 landmark'а) и мелкие хелперы поверх них.
 * Файл намеренно без зависимостей — его можно импортировать и в воркере, и в тестах.
 */

export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
}

/** Шесть точек, на которых держится счётчик приседаний. */
export const SQUAT_POINTS = [
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
  LM.LEFT_ANKLE,
  LM.RIGHT_ANKLE,
]

/** Точки, по которым решаем, что человек целиком влез в кадр (экран калибровки). */
export const CALIBRATION_POINTS = [
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
  LM.LEFT_ANKLE,
  LM.RIGHT_ANKLE,
]

/** Пороговое значение visibility, ниже которого точке не верим. */
export const MIN_VISIBILITY = 0.5

/** Читаемые имена — нужны только диагностической панели. */
export const LM_NAMES = {
  [LM.LEFT_SHOULDER]: 'плечо L',
  [LM.RIGHT_SHOULDER]: 'плечо R',
  [LM.LEFT_HIP]: 'бедро L',
  [LM.RIGHT_HIP]: 'бедро R',
  [LM.LEFT_KNEE]: 'колено L',
  [LM.RIGHT_KNEE]: 'колено R',
  [LM.LEFT_ANKLE]: 'голень L',
  [LM.RIGHT_ANKLE]: 'голень R',
}

export function nameOf(index) {
  return LM_NAMES[index] || `#${index}`
}

/** Рёбра скелета для отрисовки оверлея. */
export const POSE_CONNECTIONS = [
  // лицо
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // руки
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // корпус
  [11, 12], [11, 23], [12, 24], [23, 24],
  // ноги
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
]

/**
 * visibility точки. MediaPipe иногда отдаёт undefined — считаем такую точку невидимой,
 * кроме случая, когда координаты есть (тогда 1): так тесты можно писать на голых {x,y}.
 */
export function visibilityOf(point) {
  if (!point) return 0
  if (typeof point.visibility === 'number') return point.visibility
  return 1
}

/** Все ли перечисленные точки видны уверенно. */
export function areVisible(landmarks, indices, threshold = MIN_VISIBILITY) {
  if (!landmarks || landmarks.length === 0) return false
  for (const i of indices) {
    if (visibilityOf(landmarks[i]) < threshold) return false
  }
  return true
}

/** Список индексов, которых не хватает — удобно для подсказок в UI. */
export function missingPoints(landmarks, indices, threshold = MIN_VISIBILITY) {
  if (!landmarks || landmarks.length === 0) return [...indices]
  return indices.filter((i) => visibilityOf(landmarks[i]) < threshold)
}
