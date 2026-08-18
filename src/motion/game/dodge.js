/**
 * Детектор шага в сторону — сенсор для механики уклонения от стен.
 *
 * ГЛАВНОЕ ЗДЕСЬ — ЗЕРКАЛО. Видео на экране отражено (.mt-mirror, scaleX(-1)),
 * а точки от модели приходят в координатах кадра, без отражения. Человек лицом
 * к фронтальной камере: он шагает в свою правую сторону — в кадре его x
 * уменьшается, а на экране отражение едет вправо. Поэтому всё, что уходит в
 * игру, сразу переводится в экранные координаты: screenX = 1 - x. Дальше и
 * движок, и отрисовка живут в одной системе с тем, что видит игрок: стена
 * слева на экране — уходить в сторону большего screenX.
 *
 * Ширина плеч — мера расстояния, а не пикселей: человек может стоять ближе или
 * дальше, и порог смещения обязан ехать вместе с ним.
 */

import { LM } from '../pose/landmarks.js'

/** Ниже этой уверенности точка считается невидимой. */
export const MIN_VISIBILITY = 0.5

export const SIDE = { LEFT: 'left', RIGHT: 'right' }

/** Кадр -> экран. Единственное место, где живёт зеркало. */
export const toScreenX = (x) => 1 - x

const EMPTY = { hipX: null, shoulderX: null, shoulderWidth: null }

function visible(point, minVisibility) {
  if (!point) return false
  if (typeof point.x !== 'number') return false
  return point.visibility == null || point.visibility >= minVisibility
}

/**
 * Где игрок стоит, куда наклонён и какой он «ширины».
 * @returns {{hipX: number|null, shoulderX: number|null, shoulderWidth: number|null}}
 *          всё в экранных координатах
 */
export function readStance(landmarks, minVisibility = MIN_VISIBILITY) {
  if (!landmarks || landmarks.length < 33) return EMPTY

  const leftHip = landmarks[LM.LEFT_HIP]
  const rightHip = landmarks[LM.RIGHT_HIP]
  const leftShoulder = landmarks[LM.LEFT_SHOULDER]
  const rightShoulder = landmarks[LM.RIGHT_SHOULDER]

  const hipsOk = visible(leftHip, minVisibility) && visible(rightHip, minVisibility)
  const shouldersOk = visible(leftShoulder, minVisibility) && visible(rightShoulder, minVisibility)

  return {
    hipX: hipsOk ? toScreenX((leftHip.x + rightHip.x) / 2) : null,
    shoulderX: shouldersOk ? toScreenX((leftShoulder.x + rightShoulder.x) / 2) : null,
    // модуль: отражение на ширину не влияет
    shoulderWidth: shouldersOk ? Math.abs(leftShoulder.x - rightShoulder.x) : null,
  }
}

/**
 * Насколько игрок ушёл в сторону, свободную от стены. Положительное — уходит
 * правильно, отрицательное — жмётся к стене.
 */
export function dodgeDistance(hipX, baseX, side) {
  if (hipX == null || baseX == null) return null
  // стена слева на экране — уходим вправо, туда, где screenX больше
  return side === SIDE.LEFT ? hipX - baseX : baseX - hipX
}

/**
 * Наклон корпуса: насколько плечи ушли от таза в свободную сторону.
 * Мера сама по себе относительная — считается от собственного таза, а не от
 * базовой точки, поэтому наклон читается одинаково, где бы человек ни стоял.
 * Плюс — наклонился от препятствия, минус — в его сторону.
 */
export function leanDistance(shoulderX, hipX, side) {
  if (shoulderX == null || hipX == null) return null
  return side === SIDE.LEFT ? shoulderX - hipX : hipX - shoulderX
}

/** Куда шагать, если стена с этой стороны. */
export function freeSideOf(side) {
  return side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT
}
