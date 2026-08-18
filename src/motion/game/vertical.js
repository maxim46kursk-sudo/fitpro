/**
 * Детекторы двух «вертикальных» движений из ТЗ: МАХ РУКОЙ ВВЕРХ и ПРЫЖОК.
 *
 * Все пороги здесь сняты с размеченной записи
 * `recordings/calibration-raise-jump-20260812.json` (1517 кадров, 20.7 fps,
 * 3 сегмента: мах правой 5, мах левой 5, прыжок 5) и проверены прогоном против
 * трёх старых записей — калибровки всех пяти движений, игрового раунда на
 * Android и синтетического образца. Менять их без нового прогона
 * `tools/replay-game.mjs` нельзя: именно так этот проект дважды терял по
 * несколько часов на правках «на глаз».
 *
 * МАХ. Мера — насколько запястье поднялось ВЫШЕ НОСА, в длинах корпуса:
 * (noseY - wristY) / |hipY - shoulderY|. Не угол в плече и не абсолютная
 * высота: угол на фронтальной камере почти не меняется, когда рука идёт вверх
 * вдоль тела, а абсолютная высота зависит от роста и расстояния до камеры.
 * Замер по записям: махи доходят до +0.72..0.83, а все остальные движения —
 * присед, шаг, наклон, удар, колено — не поднимаются выше -0.03.
 *
 * Второе условие — вторая рука НИЖЕ носа. Обе руки вверх — это потягивание или
 * человек тянется к телефону, а не мах.
 *
 * Третье — подтверждение временем: условие должно держаться подряд не меньше
 * holdMs. На игровом раунде Android удар дважды мелькал выше носа, и это ровно
 * тот случай, ради которого подтверждение и стоит.
 *
 * ПРЫЖОК. Один признак не работает: быстрый присед даёт такой же рывок таза
 * вверх, как прыжок (по записям до 3.2 корпуса/с против 2.4–4.5 у прыжков).
 * Отличает прыжок то, что в нём ОБЕ СТОПЫ УХОДЯТ ОТ ПОЛА, а в приседе они
 * стоят (подъём стоп ~0). Поэтому нужны оба признака в одном кадре — и
 * рывок таза, и обе стопы в воздухе. По записям это разошлось идеально: в
 * старых записях есть кадры с рывком 3.24 и есть кадры с подъёмом стоп 0.21,
 * но ни одного кадра, где оба признака сошлись бы вместе.
 *
 * Высота стоп меряется от их собственной медианы за последние footWindowMs, а
 * не от «пола»: пол в кадре не виден, а медиана за полторы секунды и есть
 * положение стопы на земле. В игру эти детекторы пока не подключены — сначала
 * записи и пороги, потом препятствия.
 */

import { LM } from '../pose/landmarks.js'

export const MIN_VISIBILITY = 0.5

export const SIDE = { LEFT: 'left', RIGHT: 'right' }

const WRIST = { left: LM.LEFT_WRIST, right: LM.RIGHT_WRIST }
const ANKLE = { left: LM.LEFT_ANKLE, right: LM.RIGHT_ANKLE }

export const DEFAULT_RAISE = {
  /**
   * Насколько выше носа должно уйти запястье, в длинах корпуса.
   *
   * Не 0.30, как казалось по одной записи махов: на игровом раунде Android
   * запястье дважды поднималось выше носа само — до 0.32 и до 0.44, причём
   * держалось 599 и 2501 мс, то есть подтверждение временем такие всплески НЕ
   * отсекает. Настоящие махи при этом идут 0.72–0.83. Порог поставлен в разрыв
   * между этими двумя множествами: 0.11 выше худшего ложного и 0.17 ниже самого
   * слабого настоящего.
   */
  enterK: 0.55,
  /**
   * Ниже этого мах считается законченным и разрешается следующий. Гистерезис
   * широкий: на границе сигнал дребезжит, и без него один мах на медленной
   * камере распадался бы на два-три события.
   */
  exitK: 0.15,
  /** Столько условие должно держаться подряд, чтобы это был мах, а не мелькание. */
  holdMs: 250,
  /** Выше этого вторая рука означает потягивание двумя руками, а не мах. */
  otherK: 0,
}

export const DEFAULT_JUMP = {
  /** Насколько каждая стопа должна уйти вверх от своей медианы, в корпусах. */
  footLiftK: 0.1,
  /** За сколько считается медиана «стопа на земле». */
  footWindowMs: 1500,
  /** Рывок таза вверх, в длинах корпуса в секунду. */
  hipSurgeK: 1.8,
  /** Рывок ищется в этом окне назад: в верхней точке прыжка таз уже не ускоряется. */
  surgeWindowMs: 250,
  /** Один прыжок — одно событие: пока не прошло столько, следующего нет. */
  refractoryMs: 500,
}

const visible = (point, minVisibility = MIN_VISIBILITY) => {
  if (!point || typeof point.y !== 'number') return false
  return point.visibility == null || point.visibility >= minVisibility
}

const otherSide = (side) => (side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT)

/**
 * Опора для всех мер: высота таза и длина корпуса в кадре. Длина корпуса — это
 * мера роста человека на картинке, и всё остальное делится на неё, чтобы
 * пороги не зависели ни от роста, ни от расстояния до камеры.
 */
export function torsoOf(landmarks, minVisibility = MIN_VISIBILITY) {
  if (!landmarks || landmarks.length < 33) return null
  const ls = landmarks[LM.LEFT_SHOULDER]
  const rs = landmarks[LM.RIGHT_SHOULDER]
  const lh = landmarks[LM.LEFT_HIP]
  const rh = landmarks[LM.RIGHT_HIP]
  if (![ls, rs, lh, rh].every((p) => visible(p, minVisibility))) return null

  const shoulderY = (ls.y + rs.y) / 2
  const hipY = (lh.y + rh.y) / 2
  const torso = Math.abs(hipY - shoulderY)
  return torso ? { hipY, shoulderY, torso } : null
}

/**
 * Насколько запястье выше носа, в длинах корпуса. Плюс — выше, минус — ниже.
 * null, если носа, запястья или корпуса не видно: неизвестное не превращаем в
 * ноль, иначе «человека не видно» стало бы «рука опущена».
 */
export function raiseMetric(landmarks, side, minVisibility = MIN_VISIBILITY) {
  const base = torsoOf(landmarks, minVisibility)
  if (!base) return null
  const nose = landmarks[LM.NOSE]
  const wrist = landmarks[WRIST[side]]
  if (!visible(nose, minVisibility) || !visible(wrist, minVisibility)) return null
  return (nose.y - wrist.y) / base.torso
}

/**
 * Мах рукой вверх — по одной руке. Автомат: вход по порогу с подтверждением
 * временем, одно событие на вход, выход по гистерезису.
 */
export function createRaiseWatcher(side, overrides = {}) {
  const config = { ...DEFAULT_RAISE, ...overrides }
  /** С какого момента условие держится подряд. */
  let since = null
  /** По этому входу событие уже отдано: второго не будет до выхода. */
  let fired = false
  let peak = null

  return {
    config,
    side,

    /**
     * @param {number} nowMs
     * @param {Array} landmarks точки кадра
     * @returns {{side: string, at: number, holdMs: number, value: number,
     *            peak: number}|null}
     */
    update(nowMs, landmarks) {
      const value = raiseMetric(landmarks, side, config.minVisibility)
      // руки не видно — судить нечего: подтверждение начинается заново, но
      // и законченным мах не считается, пока рука не опустится на глазах
      if (value == null) {
        since = null
        return null
      }

      if (value < config.exitK) {
        since = null
        fired = false
        peak = null
        return null
      }

      const other = raiseMetric(landmarks, otherSide(side), config.minVisibility)
      // обе руки вверх — потягивание, а не мах. Неизвестную вторую руку не
      // считаем помехой: чего не видно, тому и не мешаем
      const alone = other == null || other < config.otherK

      if (value < config.enterK || !alone) {
        since = null
        return null
      }

      if (since == null) {
        since = nowMs
        peak = value
      } else if (value > peak) {
        peak = value
      }

      const held = nowMs - since
      if (fired || held < config.holdMs) return null

      fired = true
      return { side, at: nowMs, holdMs: Math.round(held), value, peak }
    },

    reset() {
      since = null
      fired = false
      peak = null
    },
  }
}

/**
 * Всё, что нужно этим двум детекторам от кадра. Экран читает это один раз и
 * кладёт в позу раунда: движок судит по признакам, а не по сырым точкам — так
 * же, как он уже делает с углом колена и выносом руки.
 */
export function readVertical(landmarks, minVisibility = MIN_VISIBILITY) {
  const base = torsoOf(landmarks, minVisibility)
  const ankleY = { left: null, right: null }

  if (landmarks && landmarks.length >= 33) {
    for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
      const point = landmarks[ANKLE[side]]
      if (visible(point, minVisibility)) ankleY[side] = point.y
    }
  }

  return {
    raise: {
      left: raiseMetric(landmarks, SIDE.LEFT, minVisibility),
      right: raiseMetric(landmarks, SIDE.RIGHT, minVisibility),
    },
    ankleY,
    hipY: base?.hipY ?? null,
    torso: base?.torso ?? null,
  }
}

/** Медиана по списку. Именно она, а не среднее: один выброс её не сдвигает. */
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Прыжок: обе стопы в воздухе и рывок таза вверх в одном кадре. Ни один из
 * признаков сам по себе не годится — см. заголовок модуля.
 */
export function createJumpWatcher(overrides = {}) {
  const config = { ...DEFAULT_JUMP, ...overrides }
  /** Высоты стоп за окно: по ним считается «где земля». */
  const feet = []
  /** Высота таза за короткое окно: по ней считается рывок. */
  const hips = []
  let lastAt = null

  return {
    config,
    feetLift: null,
    hipSurge: null,

    /**
     * @param {number} nowMs
     * @param {Array|{ankleY: object, hipY: number|null, torso: number|null}} source
     *        точки кадра или уже прочитанные признаки (readVertical)
     * @returns {{at: number, lift: number, surge: number}|null}
     */
    update(nowMs, source) {
      this.feetLift = null
      this.hipSurge = null

      // разбор записей кормит детектор точками, игра — признаками из позы:
      // считать одно и то же дважды незачем, а расходиться им нельзя
      const frame = Array.isArray(source)
        ? readVertical(source, config.minVisibility)
        : source || {}
      const { hipY, torso } = frame
      if (hipY == null || !torso) return null

      hips.push({ t: nowMs, y: hipY, torso })
      while (hips.length && nowMs - hips[0].t > config.surgeWindowMs) hips.shift()

      const leftY = frame.ankleY?.left ?? null
      const rightY = frame.ankleY?.right ?? null
      feet.push({ t: nowMs, left: leftY, right: rightY, torso })
      while (feet.length && nowMs - feet[0].t > config.footWindowMs) feet.shift()

      // рывок таза вверх за короткое окно назад: в верхней точке прыжка таз
      // уже не ускоряется, а признак «стопы в воздухе» там как раз и виден
      let surge = 0
      for (const point of hips) {
        const dt = (nowMs - point.t) / 1000
        if (dt > 0) surge = Math.max(surge, (point.y - hipY) / torso / dt)
      }
      this.hipSurge = surge

      // обе стопы должны быть видны: по одной ноге прыжок не отличить от
      // подъёма колена, а именно колено и есть его главный сосед по ошибкам
      if (leftY == null || rightY == null) return null

      const groundLeft = median(feet.map((f) => f.left).filter((v) => v != null))
      const groundRight = median(feet.map((f) => f.right).filter((v) => v != null))
      if (groundLeft == null || groundRight == null) return null

      // подъём КАЖДОЙ стопы: берём меньший из двух, он и решает
      const lift = Math.min((groundLeft - leftY) / torso, (groundRight - rightY) / torso)
      this.feetLift = lift

      if (lift < config.footLiftK || surge < config.hipSurgeK) return null
      // один прыжок — одно событие: полёт длится несколько кадров
      if (lastAt != null && nowMs - lastAt < config.refractoryMs) return null

      lastAt = nowMs
      return { at: nowMs, lift, surge }
    },

    reset() {
      feet.length = 0
      hips.length = 0
      lastAt = null
    },
  }
}
