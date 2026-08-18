/**
 * Детекторы для удара рукой и подъёма колена — движения 9 и 4 из ТЗ (раздел 2.1).
 *
 * СТОРОНА ЗДЕСЬ РАБОТАЕТ НЕ ТАК, как у стены и балки. От стены уходят в
 * свободную сторону, а астероид и кольцо надо, наоборот, достать: препятствие
 * справа на экране бьётся правой рукой, слева — левой. В зеркальном видео
 * собственная правая рука человека и видна справа, поэтому анатомическая
 * сторона точки совпадает с экранной, и переводить ничего не нужно.
 *
 * Удар меряется ВЫНОСОМ ЗАПЯСТЬЯ ВПЕРЁД, а не только углом локтя. Полевой тест:
 * «так я и не понял, как делать удар». Причина была в детекторе — он ждал
 * перехода «рука согнута -> рука выпрямлена», а человек стоит с опущенными
 * руками, то есть УЖЕ выпрямленными. Выбрасывает руку вперёд — угол в локте не
 * меняется, перехода нет, зачёта нет. ТЗ говорит про удар точнее: «выпрямление
 * локтя + вынос запястья вперёд», и вторая половина как раз и отличает удар от
 * стойки. Вынос берётся из мировых точек (метры, три измерения) и делится на
 * длину руки — тогда он не зависит ни от роста, ни от расстояния до камеры.
 *
 * Одного выноса по z мало: глубину слабые устройства оценивают грубо. Поэтому
 * считается ещё и УКОРОЧЕНИЕ РУКИ В КАДРЕ: рука, направленная в камеру, на
 * плоской картинке короче, чем на самом деле.
 *
 * Сравнивать её при этом надо с собственной длиной, а не с длиной корпуса.
 * Полевой лог показал, чем плоха вторая мера: согнутая рука тоже даёт короткое
 * расстояние от плеча до запястья, и значение постоянно держалось на 0.7–0.9,
 * никакого рывка на его фоне видно не было. Теперь плоская длина делится на
 * настоящую, взятую из мировых точек и переведённую в масштаб кадра по ширине
 * плеч: согнутая рука даёт ноль, а рука в камеру — большое укорочение.
 *
 * Угол локтя остаётся: по нему работает запасной путь, если нет ни мировых
 * точек, ни корпуса, и он пишется в лог для калибровки.
 *
 * Высота колена читается по кадру: это вертикальное отношение, и в долях длины
 * корпуса оно тоже не зависит от того, как далеко человек стоит.
 */

import { LM } from '../pose/landmarks.js'

export const MIN_VISIBILITY = 0.5

export const ARM = { LEFT: 'left', RIGHT: 'right' }

const ELBOW = {
  left: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST],
  right: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
}
const KNEE = { left: LM.LEFT_KNEE, right: LM.RIGHT_KNEE }
const ANKLE = { left: LM.LEFT_ANKLE, right: LM.RIGHT_ANKLE }

const EMPTY = {
  elbow: { left: null, right: null },
  reach: { left: null, right: null },
  foreshorten: { left: null, right: null },
  armDown: { left: null, right: null },
  kneeLift: { left: null, right: null },
  footLift: { left: null, right: null },
  hipY: null,
  torso: null,
}

function visible(point, minVisibility) {
  if (!point || typeof point.x !== 'number') return false
  return point.visibility == null || point.visibility >= minVisibility
}

/** Угол в точке b между лучами b->a и b->c. Работает и в 2D, и в 3D. */
function angleAt(a, b, c) {
  const ax = a.x - b.x
  const ay = a.y - b.y
  const az = (a.z ?? 0) - (b.z ?? 0)
  const cx = c.x - b.x
  const cy = c.y - b.y
  const cz = (c.z ?? 0) - (b.z ?? 0)

  const dot = ax * cx + ay * cy + az * cz
  const la = Math.hypot(ax, ay, az)
  const lc = Math.hypot(cx, cy, cz)
  if (!la || !lc) return null

  const cos = Math.min(1, Math.max(-1, dot / (la * lc)))
  return (Math.acos(cos) * 180) / Math.PI
}

/**
 * Всё, что нужно для двух новых типов: углы локтей, опущены ли руки и насколько
 * поднято каждое колено (в долях длины корпуса, плюс — выше линии таза).
 */
export function readUpper(landmarks, worldLandmarks, minVisibility = MIN_VISIBILITY) {
  if (!landmarks || landmarks.length < 33) return EMPTY

  const leftHip = landmarks[LM.LEFT_HIP]
  const rightHip = landmarks[LM.RIGHT_HIP]
  const leftShoulder = landmarks[LM.LEFT_SHOULDER]
  const rightShoulder = landmarks[LM.RIGHT_SHOULDER]

  const hipsOk = visible(leftHip, minVisibility) && visible(rightHip, minVisibility)
  const shouldersOk =
    visible(leftShoulder, minVisibility) && visible(rightShoulder, minVisibility)

  const hipY = hipsOk ? (leftHip.y + rightHip.y) / 2 : null
  const shoulderY = shouldersOk ? (leftShoulder.y + rightShoulder.y) / 2 : null
  // длина корпуса — мера роста в кадре: по ней высота колена перестаёт зависеть
  // от того, на двух метрах человек стоит или на трёх
  const torso = hipY != null && shoulderY != null ? Math.abs(hipY - shoulderY) : null

  const elbow = { left: null, right: null }
  const reach = { left: null, right: null }
  const foreshorten = { left: null, right: null }

  // масштаб «мир -> кадр» по ширине плеч: он один для всей фигуры
  const world = worldLandmarks?.length >= 33 ? worldLandmarks : null
  let scale = null
  if (world && shouldersOk) {
    const flat = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
    const wl = world[LM.LEFT_SHOULDER]
    const wr = world[LM.RIGHT_SHOULDER]
    const real = Math.hypot(wl.x - wr.x, wl.y - wr.y, (wl.z ?? 0) - (wr.z ?? 0))
    if (real > 0 && flat > 0) scale = flat / real
  }
  const armDown = { left: null, right: null }
  const kneeLift = { left: null, right: null }
  const footLift = { left: null, right: null }

  for (const side of [ARM.LEFT, ARM.RIGHT]) {
    const [shoulderIdx, elbowIdx, wristIdx] = ELBOW[side]
    const points = [landmarks[shoulderIdx], landmarks[elbowIdx], landmarks[wristIdx]]

    if (points.every((p) => visible(p, minVisibility))) {
      elbow[side] = world
        ? angleAt(world[shoulderIdx], world[elbowIdx], world[wristIdx])
        : angleAt(points[0], points[1], points[2])

      if (world) {
        const shoulder = world[shoulderIdx]
        const elbowPt = world[elbowIdx]
        const wrist = world[wristIdx]
        // длина руки как мера: удар засчитывается одинаково и высокому, и низкому
        const armLength =
          Math.hypot(shoulder.x - elbowPt.x, shoulder.y - elbowPt.y, (shoulder.z ?? 0) - (elbowPt.z ?? 0)) +
          Math.hypot(elbowPt.x - wrist.x, elbowPt.y - wrist.y, (elbowPt.z ?? 0) - (wrist.z ?? 0))
        // z тем меньше, чем ближе точка к камере: удар в камеру уводит запястье
        // вперёд относительно плеча
        if (armLength > 0) {
          reach[side] = ((shoulder.z ?? 0) - (wrist.z ?? 0)) / armLength
        }
      }

      // насколько рука коротка в кадре по сравнению с собой настоящей:
      // согнутая рука коротка и в мире, поэтому даёт ноль, а рука в камеру —
      // коротка только на картинке
      if (scale) {
        const flatArm = Math.hypot(points[0].x - points[2].x, points[0].y - points[2].y)
        const ws = world[shoulderIdx]
        const ww = world[wristIdx]
        const realArm = Math.hypot(ws.x - ww.x, ws.y - ww.y, (ws.z ?? 0) - (ww.z ?? 0))
        const expected = realArm * scale
        if (expected > 0) foreshorten[side] = 1 - flatArm / expected
      }

      // рука опущена, если запястье ниже середины между плечом и тазом
      if (hipY != null) {
        const shoulder = points[0]
        armDown[side] = points[2].y > (shoulder.y + hipY) / 2
      }
    }

    const knee = landmarks[KNEE[side]]
    if (visible(knee, minVisibility) && hipY != null && torso) {
      // плюс — колено выше линии таза
      kneeLift[side] = (hipY - knee.y) / torso
    }
  }

  // Стопа над полом: полом считается та стопа, что ниже. Признак простой и
  // честный — при шаге обе стопы на земле, при подъёме колена одна в воздухе,
  // причём видно это и тогда, когда колено уже пошло вниз, а таз ещё смещён.
  if (torso) {
    const left = landmarks[ANKLE.left]
    const right = landmarks[ANKLE.right]
    if (visible(left, minVisibility) && visible(right, minVisibility)) {
      const floor = Math.max(left.y, right.y)
      footLift.left = (floor - left.y) / torso
      footLift.right = (floor - right.y) / torso
    }
  }

  return { elbow, reach, foreshorten, armDown, kneeLift, footLift, hipY, torso }
}

export const DEFAULT_PUNCH = {
  /**
   * Насколько должно вырасти значение от своего минимума за окно памяти.
   * Полевой лог со слабого андроида: в покое вынос уже 0.19–0.23, то есть
   * вплотную к прежнему порогу «рука убрана» 0.25 — взвод почти никогда не
   * срабатывал, и одиннадцать ударов подряд не дали даже замера. Абсолютные
   * пороги для этого движения не годятся, работает только рост.
   */
  riseK: 0.25,
  /** И при этом рука должна оказаться заметно вынесенной — от махов вдоль тела. */
  outK: 0.45,
  /**
   * Насколько бьющая рука должна опережать вторую. Разбор записи: в приседе
   * человек выносит вперёд ОБЕ руки, и по одной руке это неотличимо от удара —
   * причём в начале приседа колено ещё прямое, так что «человек в приседе»
   * тоже не спасает. Удар всегда асимметричен, присед — нет.
   */
  sideK: 0.3,
  /** Окно памяти: рост должен уложиться в него, иначе это не удар, а вытягивание. */
  maxMs: 900,
}

/**
 * Насколько рука «выброшена», числом 0..1. Меры две: вынос запястья вперёд по
 * глубине и укорочение руки в кадре. Берётся большее — так удар виден и там,
 * где устройство плохо считает глубину. Если нет ни того, ни другого, остаётся
 * запасной путь по углу локтя.
 */
export function punchValue(
  { reach, foreshorten, elbow },
  { bentAngle = 100, extendedAngle = 150 } = {},
) {
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const parts = []

  if (reach != null) parts.push(clamp(reach))
  if (foreshorten != null) parts.push(clamp(foreshorten))

  if (parts.length) return Math.max(...parts)

  if (elbow == null) return null
  const span = extendedAngle - bentAngle
  if (span <= 0) return null
  return clamp((elbow - bentAngle) / span)
}

/**
 * Удар — это не поза и не абсолютный порог, а РЫВОК: значение резко выросло
 * относительно того, каким оно было мгновение назад. Детектор помнит значения
 * за окно и сравнивает текущее с минимумом за это окно.
 *
 * Так удар засчитывается из любой стойки — и от опущенной руки, и от рук у
 * груди, — а держать руку вытянутой по-прежнему бесполезно: роста нет.
 */
export function createPunchWatcher(overrides = {}) {
  const config = { ...DEFAULT_PUNCH, ...overrides }
  /** Значения за последнее окно: по ним ищется, откуда начался рывок. */
  let history = []

  return {
    config,
    /**
     * @param {number} nowMs
     * @param {number|null} value      насколько вынесена эта рука
     * @param {number|null} rivalValue то же самое для второй руки
     */
    update(nowMs, value, rivalValue = null) {
      if (value == null) return null

      history.push({ at: nowMs, value })
      while (history.length && nowMs - history[0].at > config.maxMs) history.shift()

      let from = value
      let fromAt = nowMs
      for (const point of history) {
        if (point.value < from) {
          from = point.value
          fromAt = point.at
        }
      }

      if (value < config.outK || value - from < config.riseK) return null
      // обе руки вперёд — это присед или потягивание, а не удар
      if (rivalValue != null && value - rivalValue < config.sideK) return null

      // удар засчитан: следующий потребует нового рывка, а не удержания руки
      history = [{ at: nowMs, value }]
      return {
        at: nowMs,
        durationMs: nowMs - fromAt,
        fromValue: from,
        toValue: value,
      }
    },
    reset() {
      history = []
    },
  }
}
