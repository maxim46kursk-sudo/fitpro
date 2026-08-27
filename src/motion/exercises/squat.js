/**
 * Счётчик приседаний. Никакого React внутри — чистая логика,
 * чтобы её можно было покрыть тестами и переиспользовать под другие упражнения.
 *
 *   const tracker = createSquatTracker()
 *   const out = tracker.update(landmarks, timestampMs, worldLandmarks)
 *
 * Повтор засчитывается НЕ по факту пересечения порога, а по завершённому циклу
 * правильной формы. Прошлая версия считала так: «угол ушёл ниже DOWN» + «угол
 * вернулся выше UP» = повтор. На быстром темпе ноги рассинхронизируются,
 * усреднённый сигнал получает лишние горбы, и один физический присед
 * распадался на два зачёта.
 *
 * Теперь цикл — это отрезок от «сигнал ушёл ниже UP» до «сигнал вернулся выше
 * UP», и он проверяется целиком:
 *   1. внутри цикла достигнут минимум ниже DOWN
 *   2. цикл длится не меньше minCycleMs
 *   3. от предыдущего засчитанного повтора прошло не меньше minRepIntervalMs
 *   4. отскоки внутри спуска до noiseToleranceDeg — это шум того же повтора,
 *      цикл они не разрывают, но считаются и пишутся в лог
 *   5. новый цикл не может начаться, не поднявшись выше UP
 */

import { createMovingAverage } from '../pose/geometry.js'
import { angleAt2D, angleAt3D } from '../pose/geometry.js'
import { LM } from '../pose/landmarks.js'
import { MODE, checkFrame, createGateState } from '../pose/frameGate.js'
import { DEFAULT_THRESHOLDS } from './thresholds.js'

export const SQUAT_CONFIG = {
  ...DEFAULT_THRESHOLDS,
  /** width / height кадра — нужно только если worldLandmarks недоступны. */
  aspect: 1,
}

export const STATE = {
  UP: 'UP',
  DOWN: 'DOWN',
}

export const ZONE = {
  UP: 'up',
  DOWN: 'down',
  DEAD: 'dead',
}

const MAX_EVENTS = 40

/** Глубина отскока, ниже которой движение считается попыткой приседа (для лога). */
const SHALLOW_ATTEMPT_MARGIN = 20

/**
 * РЕЗЕРВНЫЙ РЕЖИМ ПО ТАЗУ И ЕГО ШКАЛА — здесь была самая дорогая ошибка модуля.
 *
 * Было так: просадка таза переводилась в псевдоугол по НЕПОДВИЖНОЙ шкале
 * «стоя = 175°, таз опустился на длину бедра = 80°». А пороги при этом
 * считаются от СТОЙКИ КОНКРЕТНОГО ЧЕЛОВЕКА (см. applyPersonalCalibration): у
 * человека с фронтальной камеры стойка читается как 155°, и DOWN выходит 93°.
 *
 * Две разные шкалы и один порог на них. На шкале порогов «присесть» означало
 * 62° сгиба от своей стойки; на шкале резервного режима тот же порог 93°
 * означал «опусти таз на 0.86 длины бедра», то есть заметно ниже параллели.
 * Полевой лог 16 августа: двенадцать циклов подряд отклонены с минимумами
 * 104.7–120.6° — это ровно просадки 0.57–0.74 бедра, то есть честные приседы,
 * которым не хватило до чужого порога.
 *
 * Стало: шкала резервного режима СТРОИТСЯ ОТ ТЕХ ЖЕ ПОРОГОВ. Стойка читается
 * чуть выше UP (иначе стоящий человек не считался бы выпрямившимся), а
 * просадка в HIP_DEEP_RATIO бедра даёт ровно DOWN. Одна шкала на оба режима:
 * порог теперь значит одно и то же, видны голеностопы или нет.
 */
const HIP_STAND_HEADROOM = 8

/**
 * Замер угла в колене вне трекера — нужен калибровке, которая измеряет стойку
 * до старта подхода. Логика та же, что внутри: две ноги, объединение по config.
 */
export function measureKneeAngle(landmarks, worldLandmarks, overrides = {}) {
  const config = { ...SQUAT_CONFIG, ...overrides }
  const useWorld = Array.isArray(worldLandmarks) && worldLandmarks.length > 0
  const src = useWorld ? worldLandmarks : landmarks
  if (!src) return null

  const one = (hip, knee, ankle) =>
    useWorld
      ? angleAt3D(src[hip], src[knee], src[ankle])
      : angleAt2D(src[hip], src[knee], src[ankle], config.aspect)

  const left = one(LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE)
  const right = one(LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE)
  if (left == null && right == null) return null
  if (left == null) return right
  if (right == null) return left
  return config.legCombine === 'mean' ? (left + right) / 2 : Math.min(left, right)
}

export function createSquatTracker(overrides = {}) {
  let config = { ...SQUAT_CONFIG, ...overrides }
  let smoother = createMovingAverage(config.smoothingWindow)
  const gate = createGateState(config)

  let state = STATE.UP
  let reps = 0
  let angle = null
  let rawAngle = null
  let outOfFrame = true
  let missing = []
  let lastRepAt = -Infinity
  let lastRepDepth = null
  let startedAt = null
  let eventSeq = 0
  let mode = MODE.KNEE
  let lastCheck = null
  let lastGate = null

  // --- текущий цикл ---
  let inCycle = false
  let cycleStartedAt = null
  let minAngle = null
  let minAngleAt = null
  let reachedBottom = false
  let extrema = 0
  let swingDir = -1
  let swingExtreme = null
  let cycleLowConfidence = false
  let cycleFallback = false
  /**
   * Сколько раз внутри одного цикла сигнал опускался ниже DOWN.
   * Больше одного — человек не разогнулся до порога UP между приседами,
   * и несколько физических повторов слиплись в один цикл. Сам по себе
   * зачёт от этого не меняется (цикл один — повтор один), но молчать
   * об этом нельзя: в логе видно, в панели видно, голос подсказывает.
   */
  let bottomTouches = 0
  /**
   * СКОЛЬКО НАСТОЯЩИХ ИЗМЕРЕНИЙ ЛЕГЛО В ЭТОТ ПОВТОР.
   *
   * Защиты цикла у нас только временные: minCycleMs и minRepIntervalMs. На
   * пяти кадрах в секунду два кадра дают 400 мс и проходят обе — то есть
   * повтор может собраться из двух точек, между которыми полсекунды пустоты.
   * Отбраковывать по этому числу НЕЛЬЗЯ, пока не видно, сколько таких повторов
   * в поле: сперва считаем и пишем, решаем потом.
   */
  let cycleSamples = 0
  let belowBottom = false

  // --- база для резервного режима по тазу ---
  let standingHipY = null
  let standingThigh = null

  const depths = []
  const events = []
  let needsResync = true
  /** Почему последний закрытый цикл не стал повтором. Для панели. */
  let lastReject = null

  function pushEvent(event) {
    eventSeq += 1
    const full = { id: eventSeq, ...event }
    events.push(full)
    if (events.length > MAX_EVENTS) events.shift()
    return full
  }

  function zoneOf(value) {
    if (value == null) return null
    if (value > config.upAngle) return ZONE.UP
    if (value < config.downAngle) return ZONE.DOWN
    return ZONE.DEAD
  }

  function snapshot(extra = {}) {
    return {
      state,
      zone: zoneOf(angle),
      angle,
      rawAngle,
      reps,
      outOfFrame,
      missing,
      minAngleInRep: inCycle ? minAngle : null,
      lastRepDepth,
      mode,
      paused: lastGate?.paused ?? true,
      quality: lastCheck?.quality ?? 'none',
      reason: lastCheck?.reason ?? 'no_person',
      lowConfidence: lastCheck?.lowConfidence ?? [],
      points: lastCheck?.points ?? [],
      lastReject,
      simpleMode: !!config.simpleMode,
      repCompleted: false,
      event: null,
      ...extra,
    }
  }

  /** Угол в колене для одной ноги. */
  function legAngle(landmarks, worldLandmarks, hip, knee, ankle) {
    const useWorld = Array.isArray(worldLandmarks) && worldLandmarks.length > 0
    const src = useWorld ? worldLandmarks : landmarks
    return useWorld
      ? angleAt3D(src[hip], src[knee], src[ankle])
      : angleAt2D(src[hip], src[knee], src[ankle], config.aspect)
  }

  /**
   * Объединение двух ног. 'min' берёт глубже согнутую ногу: так асимметричный
   * присед засчитывается, а рассинхрон не создаёт лишних горбов в сигнале.
   */
  function kneeAngle(landmarks, worldLandmarks) {
    const left = legAngle(landmarks, worldLandmarks, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE)
    const right = legAngle(landmarks, worldLandmarks, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE)

    if (left == null && right == null) return null
    if (left == null) return right
    if (right == null) return left
    return config.legCombine === 'mean' ? (left + right) / 2 : Math.min(left, right)
  }

  /** Запомнить стойку — база для резервной оценки глубины по тазу. */
  function captureStanding(landmarks, value) {
    if (!landmarks || value == null || value < config.upAngle) return
    const hipY = (landmarks[LM.LEFT_HIP].y + landmarks[LM.RIGHT_HIP].y) / 2
    const kneeY = (landmarks[LM.LEFT_KNEE].y + landmarks[LM.RIGHT_KNEE].y) / 2
    const thigh = Math.abs(kneeY - hipY)
    if (thigh < 0.02) return
    standingHipY = hipY
    standingThigh = thigh
  }

  /**
   * Резервная глубина: вертикальная просадка таза относительно стойки,
   * нормированная на длину бедра, — и сразу в шкале рабочих порогов (см.
   * HIP_STAND_HEADROOM). Точность ниже, чем по углу в колене, но лучше, чем
   * полная остановка подхода.
   */
  function hipFallbackAngle(landmarks) {
    if (standingHipY == null || !standingThigh || !landmarks) return null
    const hipY = (landmarks[LM.LEFT_HIP].y + landmarks[LM.RIGHT_HIP].y) / 2
    const dropRatio = (hipY - standingHipY) / standingThigh
    const stand = config.upAngle + HIP_STAND_HEADROOM
    const deep = config.hipDeepRatio > 0 ? config.hipDeepRatio : DEFAULT_THRESHOLDS.hipDeepRatio
    // просадка ровно в deep бёдер = ровно порог DOWN, каким бы он ни был
    const value = stand - (dropRatio / deep) * (stand - config.downAngle)
    return Math.max(30, Math.min(180, value))
  }

  function resetCycle() {
    inCycle = false
    cycleStartedAt = null
    minAngle = null
    minAngleAt = null
    reachedBottom = false
    extrema = 0
    swingDir = -1
    swingExtreme = null
    cycleLowConfidence = false
    cycleFallback = false
    bottomTouches = 0
    belowBottom = false
    cycleSamples = 0
  }

  function dropFrame(missingPoints, timestamp) {
    outOfFrame = true
    needsResync = true
    smoother.reset()
    angle = null
    rawAngle = null
    missing = missingPoints
    resetCycle()
    if (startedAt == null) startedAt = timestamp
    return snapshot()
  }

  return {
    update(landmarks, timestamp, worldLandmarks) {
      if (startedAt == null) startedAt = timestamp

      const check = checkFrame(landmarks, config)
      const g = gate.update(check, timestamp)
      lastCheck = check
      lastGate = g
      mode = g.mode

      // Пауза — полный сброс: человек ушёл, накопленное состояние неактуально.
      if (g.paused) return dropFrame(check.missing, timestamp)

      // Кадр негоден, но пауза ещё не включилась. Ради этого и нужен гистерезис:
      // кадр пропускаем, но цикл, буфер сглаживания и счёт не трогаем — иначе
      // одиночный плохой кадр посреди приседа отменял бы весь повтор.
      if (!g.usable) {
        missing = check.missing
        return snapshot()
      }

      const raw =
        g.mode === MODE.HIP_FALLBACK
          ? hipFallbackAngle(landmarks)
          : kneeAngle(landmarks, worldLandmarks)

      if (raw == null) return dropFrame(check.missing, timestamp)

      outOfFrame = false
      missing = check.missing
      rawAngle = raw
      angle = smoother.push(raw)
      // кадр годен и измерен — он и есть «настоящее измерение» этого повтора
      if (inCycle) cycleSamples += 1

      if (g.mode === MODE.KNEE) captureStanding(landmarks, angle)

      // после разрыва состояние подстраивается молча, без зачёта
      if (needsResync) {
        needsResync = false
        state = angle > config.upAngle ? STATE.UP : STATE.DOWN
        resetCycle()
        return snapshot()
      }

      let repCompleted = false
      let event = null

      // ---------------- аварийный простой режим ----------------
      // Старая примитивная логика: просто пересечение порогов с интервалом.
      // Нужна как страховка — если проверка формы цикла в поле не работает,
      // на неё можно откатиться тумблером в панели, не пересобирая проект.
      if (config.simpleMode) {
        if (state === STATE.UP) {
          if (angle < config.downAngle) {
            state = STATE.DOWN
            minAngle = angle
            minAngleAt = timestamp
            cycleStartedAt = timestamp
            inCycle = true
          }
        } else {
          if (angle < minAngle) {
            minAngle = angle
            minAngleAt = timestamp
          }
          if (angle > config.upAngle) {
            const base = {
              tMs: timestamp - startedAt,
              minAngle,
              downMs: minAngleAt - cycleStartedAt,
              upMs: timestamp - minAngleAt,
              durationMs: timestamp - cycleStartedAt,
              extrema: 0,
              bottomTouches: 1,
              lowConfidence: cycleLowConfidence,
              fallback: cycleFallback,
              simple: true,
            }
            if (timestamp - lastRepAt >= config.minRepIntervalMs) {
              reps += 1
              lastRepDepth = minAngle
              depths.push(minAngle)
              lastRepAt = timestamp
              repCompleted = true
              lastReject = null
              event = pushEvent({ ...base, kind: 'rep', index: reps, reason: null })
            } else {
              lastReject = `интервал < ${config.minRepIntervalMs} мс`
              event = pushEvent({ ...base, kind: 'too_fast', reason: lastReject })
            }
            state = STATE.UP
            resetCycle()
          }
        }
        return snapshot({ repCompleted, event })
      }

      // ---------------- отслеживание цикла ----------------
      if (!inCycle) {
        // новый цикл начинается только сверху: пункт 5 требований
        if (angle < config.upAngle) {
          inCycle = true
          cycleStartedAt = timestamp
          minAngle = angle
          minAngleAt = timestamp
          reachedBottom = angle < config.downAngle
          belowBottom = reachedBottom
          bottomTouches = reachedBottom ? 1 : 0
          extrema = 0
          swingDir = -1
          swingExtreme = angle
          cycleSamples = 1
          cycleLowConfidence = check.lowConfidence.length > 0
          cycleFallback = g.mode === MODE.HIP_FALLBACK
          state = STATE.DOWN
        }
      } else {
        if (angle < minAngle) {
          minAngle = angle
          minAngleAt = timestamp
        }
        if (angle < config.downAngle) reachedBottom = true

        // отдельные заходы в нижнюю точку внутри одного цикла
        if (!belowBottom && angle < config.downAngle) {
          belowBottom = true
          bottomTouches += 1
        } else if (belowBottom && angle > config.downAngle + config.noiseToleranceDeg) {
          belowBottom = false
        }

        if (check.lowConfidence.length) cycleLowConfidence = true
        if (g.mode === MODE.HIP_FALLBACK) cycleFallback = true
        state = angle > config.upAngle ? STATE.UP : STATE.DOWN

        // подсчёт значимых разворотов: отскок внутри спуска — шум, а не повтор
        if (swingDir === -1) {
          if (angle < swingExtreme) swingExtreme = angle
          else if (angle - swingExtreme > config.noiseToleranceDeg) {
            swingDir = 1
            swingExtreme = angle
            extrema += 1
          }
        } else {
          if (angle > swingExtreme) swingExtreme = angle
          else if (swingExtreme - angle > config.noiseToleranceDeg) {
            swingDir = -1
            swingExtreme = angle
            extrema += 1
          }
        }

        // ---------------- цикл закрылся ----------------
        if (angle > config.upAngle) {
          const durationMs = timestamp - cycleStartedAt
          const downMs = minAngleAt - cycleStartedAt
          const upMs = timestamp - minAngleAt
          const base = {
            tMs: timestamp - startedAt,
            minAngle,
            /**
             * По какой планке судили и с каким размахом человек до неё шёл.
             * Пара, без которой полевой лог нечитаем: «минимум 112°» ничего не
             * значит, пока неизвестно, что порог был 93, а стойка 155. И третье
             * — в каком режиме мерили: по колену или по тазу.
             */
            bar: config.downAngle,
            stand: config.upAngle,
            amplitude: Math.round((config.upAngle - minAngle) * 10) / 10,
            downMs,
            upMs,
            durationMs,
            extrema,
            bottomTouches,
            /**
             * СКОЛЬКО ИЗМЕРЕНИЙ ВНУТРИ ПОВТОРА И КАКАЯ ПРИ ЭТОМ БЫЛА ЧАСТОТА.
             *
             * Пара, без которой не разобрать «повтор из двух кадров»: 2 при
             * 5 кадрах в секунду и 14 при 30 — это разного качества зачёты, а
             * в журнале они до сих пор выглядели одинаково.
             *
             * Частота считается ПО САМОМУ ПОВТОРУ, а не берётся общая по
             * сессии: судили этот повтор ровно те кадры, что в него попали.
             * Один кадр в цикле частоты не даёт — тогда null, а не выдуманное
             * число.
             */
            samples: cycleSamples,
            fps:
              cycleSamples > 1 && durationMs > 0
                ? Math.round(((cycleSamples - 1) / durationMs) * 1000)
                : null,
            lowConfidence: cycleLowConfidence,
            fallback: cycleFallback,
          }

          if (!reachedBottom) {
            lastReject = `не достиг DOWN: минимум ${minAngle.toFixed(0)}° при пороге ${config.downAngle}°`
            if (config.upAngle - minAngle >= SHALLOW_ATTEMPT_MARGIN) {
              event = pushEvent({ ...base, kind: 'shallow', reason: lastReject })
            }
          } else if (durationMs < config.minCycleMs) {
            lastReject = `цикл ${Math.round(durationMs)} мс короче ${config.minCycleMs} мс`
            event = pushEvent({ ...base, kind: 'too_fast', reason: lastReject })
          } else if (timestamp - lastRepAt < config.minRepIntervalMs) {
            lastReject = `быстрее ${config.minRepIntervalMs} мс после предыдущего`
            event = pushEvent({ ...base, kind: 'too_fast', reason: lastReject })
          } else {
            lastReject = null
            reps += 1
            lastRepDepth = minAngle
            depths.push(minAngle)
            lastRepAt = timestamp
            repCompleted = true
            event = pushEvent({ ...base, kind: 'rep', index: reps, reason: null })
          }

          resetCycle()
          state = STATE.UP
        }
      }

      return snapshot({ repCompleted, event })
    },

    setConfig(patch) {
      const prevWindow = config.smoothingWindow
      config = { ...config, ...patch }
      gate.setConfig(config)
      if (config.smoothingWindow !== prevWindow) {
        smoother = createMovingAverage(config.smoothingWindow)
        needsResync = true
      }
      return { ...config }
    },

    reset() {
      smoother = createMovingAverage(config.smoothingWindow)
      gate.reset()
      state = STATE.UP
      reps = 0
      angle = null
      rawAngle = null
      outOfFrame = true
      missing = []
      lastRepAt = -Infinity
      lastRepDepth = null
      startedAt = null
      eventSeq = 0
      lastReject = null
      mode = MODE.KNEE
      lastCheck = null
      lastGate = null
      standingHipY = null
      standingThigh = null
      resetCycle()
      depths.length = 0
      events.length = 0
      needsResync = true
    },

    getEvents() {
      return [...events]
    },

    getStats() {
      const avgDepth = depths.length
        ? depths.reduce((sum, d) => sum + d, 0) / depths.length
        : null
      const bestDepth = depths.length ? Math.min(...depths) : null
      return { reps, depths: [...depths], avgDepth, bestDepth }
    },

    get config() {
      return { ...config }
    },
  }
}
