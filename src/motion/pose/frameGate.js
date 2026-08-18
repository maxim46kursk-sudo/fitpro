/**
 * Проверка «человека видно достаточно, чтобы считать присед».
 *
 * История этого файла — история двух ошибок в разные стороны.
 * Сначала проверки не было вовсе: человек стоял в кадре по колено, система
 * молчала, восемь приседов ушли в ноль. Потом проверку сделали жёсткой
 * (visibility > 0.6 И координата внутри кадра с запасом 2%) — и попасть
 * в рабочую зону стало практически невозможно: шаг назад, и подход встаёт.
 *
 * Теперь компромисс:
 *  - порог видимости разный по точкам: голеностопы MediaPipe регулярно отдаёт
 *    с низкой visibility, хотя координата верная
 *  - небольшой выход за границы кадра допустим, модель там ещё экстраполирует
 *    адекватно
 *  - одиночные плохие кадры игнорируются: пауза включается только если плохо
 *    непрерывно 0.7 с, а снимается с первого хорошего кадра
 *  - «человека нет вообще» и «часть точек ненадёжна» — разные состояния:
 *    первое останавливает подход, второе только помечает повторы в логе
 */

import { LM, visibilityOf } from './landmarks.js'
import { DEFAULT_THRESHOLDS } from '../exercises/thresholds.js'

export const ANKLES = [LM.LEFT_ANKLE, LM.RIGHT_ANKLE]
export const KNEES = [LM.LEFT_KNEE, LM.RIGHT_KNEE]
export const HIPS = [LM.LEFT_HIP, LM.RIGHT_HIP]
export const SHOULDERS = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]

/** Шесть точек, по которым считается присед. */
export const SQUAT_REQUIRED = [...HIPS, ...KNEES, ...ANKLES]

/** Зоны тела — по ним раскрашивается силуэт на калибровке. */
export const ZONES = {
  head: [LM.NOSE],
  shoulders: SHOULDERS,
  hips: HIPS,
  knees: KNEES,
  ankles: ANKLES,
}

export const ZONE_ORDER = ['head', 'shoulders', 'hips', 'knees', 'ankles']

export const REASON = {
  OK: 'ok',
  NO_PERSON: 'no_person',
  ANKLES: 'ankles',
  UPPER: 'upper',
  OTHER: 'other',
}

export const QUALITY = {
  OK: 'ok',
  LOW: 'low',
  NONE: 'none',
}

/** Режим оценки глубины. */
export const MODE = {
  KNEE: 'knee',
  HIP_FALLBACK: 'hip',
}

export const REASON_SPEECH = {
  [REASON.NO_PERSON]: 'Встань в кадр',
  [REASON.ANKLES]: 'Отойди дальше, не видно ног',
  [REASON.UPPER]: 'Отойди дальше',
  [REASON.OTHER]: 'Отойди дальше',
}

export const REASON_TEXT = {
  [REASON.NO_PERSON]: 'Встань в кадр',
  [REASON.ANKLES]: 'Не видно стоп — отойди дальше',
  [REASON.UPPER]: 'Не видно верх — отойди дальше',
  [REASON.OTHER]: 'Видно не всё тело — отойди дальше',
}

/** Порог видимости для конкретной точки. */
export function visThresholdFor(index, config = DEFAULT_THRESHOLDS) {
  const ankle = config.visAnkle ?? DEFAULT_THRESHOLDS.visAnkle
  const major = config.visMajor ?? DEFAULT_THRESHOLDS.visMajor
  return ANKLES.includes(index) ? ankle : major
}

/** Координата внутри допустимого диапазона (с запасом ЗА кадр, а не внутрь). */
export function coordOk(point, margin) {
  return (
    point.x >= -margin && point.x <= 1 + margin && point.y >= -margin && point.y <= 1 + margin
  )
}

export function isPointOk(point, index, config = DEFAULT_THRESHOLDS) {
  if (!point) return false
  const margin = config.coordMargin ?? DEFAULT_THRESHOLDS.coordMargin
  if (!coordOk(point, margin)) return false
  return visibilityOf(point) >= visThresholdFor(index, config)
}

/**
 * Разбор кадра без учёта времени. Временной гистерезис — в createGateState().
 */
export function checkFrame(landmarks, config = DEFAULT_THRESHOLDS) {
  const hasPerson = Array.isArray(landmarks) && landmarks.length > 0
  const ok = (i) => hasPerson && isPointOk(landmarks[i], i, config)

  const zones = {}
  for (const name of ZONE_ORDER) zones[name] = ZONES[name].every(ok)

  const anklesOk = ANKLES.every(ok)
  const kneesOk = KNEES.every(ok)
  const hipsOk = HIPS.every(ok)
  const hipsKneesOk = kneesOk && hipsOk
  const legsOk = hipsKneesOk && anklesOk
  const fullBodyOk = legsOk && zones.shoulders && zones.head

  const missing = SQUAT_REQUIRED.filter((i) => !ok(i))

  // точки, которые прошли порог, но с запасом меньше 0.15 — повод пометить
  // повтор как низкоуверенный, но не повод останавливать подход
  const lowConfidence = hasPerson
    ? SQUAT_REQUIRED.filter((i) => {
        if (!ok(i)) return false
        return visibilityOf(landmarks[i]) < visThresholdFor(i, config) + 0.15
      })
    : []

  let quality = QUALITY.OK
  if (!hasPerson || !hipsKneesOk) quality = QUALITY.NONE
  else if (!legsOk || lowConfidence.length) quality = QUALITY.LOW

  let reason = REASON.OK
  if (!hasPerson || ZONE_ORDER.every((z) => !zones[z])) reason = REASON.NO_PERSON
  else if (!anklesOk) reason = REASON.ANKLES
  else if (!zones.shoulders || !zones.head) reason = REASON.UPPER
  else if (!legsOk) reason = REASON.OTHER

  return {
    hasPerson,
    zones,
    anklesOk,
    kneesOk,
    hipsOk,
    hipsKneesOk,
    legsOk,
    fullBodyOk,
    missing,
    lowConfidence,
    quality,
    reason,
    /** Детализация по шести точкам — для постоянной строки в панели. */
    points: SQUAT_REQUIRED.map((i) => {
      const p = hasPerson ? landmarks[i] : null
      return {
        index: i,
        visibility: p ? visibilityOf(p) : null,
        x: p?.x ?? null,
        y: p?.y ?? null,
        threshold: visThresholdFor(i, config),
        ok: ok(i),
      }
    }),
  }
}

/**
 * Временной гистерезис поверх checkFrame.
 *
 *  - пауза включается только после pauseAfterMs непрерывно плохих кадров
 *  - снимается мгновенно, на первом хорошем
 *  - если голеностопов нет дольше ankleFallbackMs, но бёдра и колени видны,
 *    подход не останавливается, а глубина начинает считаться по тазу
 */
export function createGateState(initialConfig = DEFAULT_THRESHOLDS) {
  let config = { ...DEFAULT_THRESHOLDS, ...initialConfig }
  let badSince = null
  let anklesLostSince = null
  let paused = true
  let mode = MODE.KNEE

  return {
    setConfig(patch) {
      config = { ...config, ...patch }
    },

    reset() {
      badSince = null
      anklesLostSince = null
      paused = true
      mode = MODE.KNEE
    },

    /**
     * @param {object} check результат checkFrame
     * @param {number} timestamp мс
     */
    update(check, timestamp) {
      // --- резервный режим по тазу ---
      if (check.anklesOk) {
        anklesLostSince = null
      } else if (check.hipsKneesOk) {
        if (anklesLostSince == null) anklesLostSince = timestamp
      } else {
        anklesLostSince = null
      }

      const ankleFallbackMs = config.ankleFallbackMs ?? DEFAULT_THRESHOLDS.ankleFallbackMs
      const fallbackActive =
        anklesLostSince != null && timestamp - anklesLostSince >= ankleFallbackMs
      mode = fallbackActive ? MODE.HIP_FALLBACK : MODE.KNEE

      // --- годен ли кадр для счёта ---
      const usable = fallbackActive ? check.hipsKneesOk : check.legsOk

      if (usable) {
        badSince = null
        paused = false // снятие паузы мгновенное
      } else {
        if (badSince == null) badSince = timestamp
        const pauseAfterMs = config.pauseAfterMs ?? DEFAULT_THRESHOLDS.pauseAfterMs
        if (timestamp - badSince >= pauseAfterMs) paused = true
      }

      return {
        paused,
        usable,
        mode,
        fallbackActive,
        reason: check.reason,
        quality: check.quality,
        lowConfidence: check.lowConfidence,
        badForMs: badSince == null ? 0 : timestamp - badSince,
        anklesLostForMs: anklesLostSince == null ? 0 : timestamp - anklesLostSince,
      }
    },
  }
}

/** Габариты видимой части тела в нормализованных координатах. */
export function bodyBox(landmarks, minVisibility = 0.5) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return null

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let count = 0

  for (const p of landmarks) {
    if (!p || visibilityOf(p) < minVisibility) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
    count += 1
  }

  if (count < 4) return null
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  }
}

const TOO_SMALL = 0.45
const OFF_CENTER = 0.17

export function framingHint(landmarks, check, config = DEFAULT_THRESHOLDS) {
  if (check.reason === REASON.NO_PERSON) return { text: 'Встань в кадр', kind: 'in-frame' }
  if (check.reason === REASON.ANKLES) return { text: 'Отойди дальше, не видно ног', kind: 'back' }
  if (check.reason === REASON.UPPER || check.reason === REASON.OTHER) {
    return { text: 'Отойди дальше', kind: 'back' }
  }

  const box = bodyBox(landmarks, config.visMajor ?? DEFAULT_THRESHOLDS.visMajor)
  if (box) {
    if (box.height < TOO_SMALL) return { text: 'Подойди ближе', kind: 'closer' }
    // x кадра растёт влево от человека, а превью зеркальное — знак не переворачиваем
    if (box.centerX > 0.5 + OFF_CENTER) return { text: 'Встань правее', kind: 'right' }
    if (box.centerX < 0.5 - OFF_CENTER) return { text: 'Встань левее', kind: 'left' }
  }

  return { text: 'Отлично, стой так', kind: 'ok' }
}
