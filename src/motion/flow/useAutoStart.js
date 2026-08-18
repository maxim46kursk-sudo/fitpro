import { useEffect, useRef, useState } from 'react'
import { REASON, checkFrame, framingHint } from '../pose/frameGate.js'
import {
  applyPersonalCalibration,
  getThresholds,
  subscribeThresholds,
} from '../exercises/thresholds.js'
import { measureKneeAngle } from '../exercises/squat.js'
import { aspectOf } from '../pose/geometry.js'
import { cueCountdown, cueFrameLost, cueStart } from '../feedback/audio.js'
import { pushLive } from '../debug/diagnostics.js'
import { logEvent } from '../debug/logShipper.js'

/** Сколько человек должен простоять в кадре целиком, прежде чем пойдёт отсчёт. */
export const HOLD_MS = 2000
/** С какой цифры считаем. */
export const COUNTDOWN_FROM = 5

/**
 * Запуск подхода без единого касания экрана.
 *
 * Человек входит в кадр -> видно всё тело стабильно 2 секунды -> отсчёт 5..1
 * голосом и цифрами -> «Начали!» -> onStart(). Пропал из кадра на любом этапе —
 * отсчёт сбрасывается и начнётся заново, когда вернётся.
 *
 * Тот же хук используется на экране результата, поэтому повторный подход
 * начинается так же: встал в кадр и подождал.
 */
/**
 * @param {object} options
 * @param {number} [options.countdownFrom] С какой цифры считать. НОЛЬ — не
 *   считать вовсе и звать onStart сразу после удержания.
 *
 *   Это нужно игре. Порядок экранов там стал другим: камера увидела человека ->
 *   ВЫБОР УРОВНЯ -> отсчёт -> сессия. Раньше отсчёт шёл до выбора уровня, то
 *   есть игра считала «5, 4, 3, 2, 1» и приводила человека не к работе, а к
 *   экрану с кнопками — и он стоял перед ним, отдышавшись зря. Теперь отсчёт
 *   один и стоит там, где ему место: перед самой работой (его ведёт сессия).
 */
export function useAutoStart({
  subscribe,
  active = true,
  onStart,
  screen,
  countdownFrom = COUNTDOWN_FROM,
}) {
  const [countdown, setCountdown] = useState(null)
  const [reason, setReason] = useState(REASON.NO_PERSON)
  const [hint, setHint] = useState('Встань в кадр')
  const [zones, setZones] = useState({})
  const [holdProgress, setHoldProgress] = useState(0)

  const configRef = useRef(getThresholds())
  /**
   * Замеры угла в стойке за время удержания. Человек и так стоит эти 2 секунды —
   * бесплатная калибровка под его пропорции и ракурс камеры.
   */
  const standSamplesRef = useRef([])
  /**
   * Чем и по какому кадру мерили стойку: 'world' — по метрическим точкам,
   * 'frame' — по кадру с поправкой на его соотношение сторон.
   *
   * В лог это идёт не для красоты. Парный полевой тест 18 августа: один и тот
   * же стоящий человек намерен как 158.7° на портретном кадре Redmi и как 37.6°
   * на ландшафтном кадре iPhone, где к тому же не поднялся воркер и считал
   * резерв на главном потоке. Без этих двух полей отличить «врёт кадр» от
   * «врёт глубина» по логу нечем, а гадать вслепую мы уже пробовали.
   */
  const standSourceRef = useRef({ source: null, frameW: 0, frameH: 0 })
  const okSinceRef = useRef(null)
  const countdownRef = useRef(null)
  const nextTickAtRef = useRef(0)
  const startedRef = useRef(false)
  const onStartRef = useRef(onStart)
  const activeRef = useRef(active)

  onStartRef.current = onStart
  activeRef.current = active

  useEffect(() => subscribeThresholds((t) => (configRef.current = t)), [])

  // --- разбор каждого кадра ---
  useEffect(() => {
    if (!active) return undefined

    let lastReason = null
    let lastHint = null
    let lastZoneKey = null

    return subscribe(({ landmarks, worldLandmarks, frameW, frameH }) => {
      const check = checkFrame(landmarks, configRef.current)
      const framing = framingHint(landmarks, check, configRef.current)

      if (check.reason !== lastReason) {
        lastReason = check.reason
        setReason(check.reason)
      }
      if (framing.text !== lastHint) {
        lastHint = framing.text
        setHint(framing.text)
      }
      const zoneKey = Object.values(check.zones).join('')
      if (zoneKey !== lastZoneKey) {
        lastZoneKey = zoneKey
        setZones({ ...check.zones })
      }

      pushLive({
        screen,
        outOfFrame: !check.legsOk,
        missing: check.missing,
        frameReason: check.reason,
        zones: check.zones,
      })

      const now = performance.now()
      if (check.fullBodyOk) {
        if (okSinceRef.current == null) okSinceRef.current = now
        // копим угол в стойке, пока человек стоит ровно
        if (countdownRef.current == null) {
          /**
           * ПОПРАВКА НА СООТНОШЕНИЕ СТОРОН КАДРА обязательна: нормированные
           * точки лежат в [0..1] по каждой оси отдельно, и на неквадратном
           * кадре одна и та же величина по x и по y — разные расстояния. До
           * этого сюда уходила единица, то есть кадр молча считался квадратным.
           */
          standSourceRef.current = {
            source: Array.isArray(worldLandmarks) && worldLandmarks.length ? 'world' : 'frame',
            frameW: frameW ?? 0,
            frameH: frameH ?? 0,
          }
          const a = measureKneeAngle(landmarks, worldLandmarks, {
            ...configRef.current,
            aspect: aspectOf(frameW, frameH),
          })
          if (a != null) {
            const s = standSamplesRef.current
            s.push(a)
            if (s.length > 90) s.shift()
          }
        }
      } else {
        // потеряли человека — отсчёт начинается заново
        okSinceRef.current = null
        standSamplesRef.current = []
        if (countdownRef.current != null) {
          countdownRef.current = null
          setCountdown(null)
        }
        // подсказка голосом, не чаще раза в 4 секунды
        // сигнал вместо фразы, не чаще раза в 4 секунды
        cueFrameLost()
      }
    })
  }, [subscribe, active, screen])

  // --- удержание и отсчёт ---
  useEffect(() => {
    if (!active) return undefined

    startedRef.current = false
    let raf = 0
    let stopped = false
    const holdProgressRef = { current: 0 }

    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)

      const now = performance.now()
      const okSince = okSinceRef.current

      if (okSince == null) {
        if (holdProgressRef.current !== 0) {
          holdProgressRef.current = 0
          setHoldProgress(0)
        }
        return
      }

      if (countdownRef.current == null) {
        const held = now - okSince
        const progress = Math.min(1, held / HOLD_MS)
        if (Math.abs(progress - holdProgressRef.current) > 0.02) {
          holdProgressRef.current = progress
          setHoldProgress(progress)
        }

        if (held >= HOLD_MS) {
          // медиана устойчивее среднего: одиночный кривой кадр не сдвинет пороги
          const samples = [...standSamplesRef.current].sort((a, b) => a - b)
          if (samples.length >= 10) {
            const median = samples[Math.floor(samples.length / 2)]
            const applied = applyPersonalCalibration(median)
            const measured = standSourceRef.current
            if (applied?.rejected) {
              /**
               * Замер невозможен — пороги остались прежними. Это не мелочь и не
               * шум: под кривыми порогами присед не засчитывается вовсе, а на
               * кону деньги челленджа, поэтому отказ обязан быть в логе с тем
               * самым углом и с тем, чем и по какому кадру его меряли.
               */
              logEvent('calibration.reject', {
                stand: applied.standAngle,
                min: applied.min,
                max: applied.max,
                samples: samples.length,
                source: measured.source,
                frame: measured.frameW ? `${measured.frameW}x${measured.frameH}` : null,
              })
              console.warn(
                `[motion] калибровка отвергнута: стойка ${applied.standAngle}° вне ${applied.min}..${applied.max}°, пороги не тронуты`,
              )
            } else if (applied) {
              pushLive({ standAngle: applied.standAngle })
              logEvent('calibration', {
                stand: applied.standAngle,
                up: applied.upAngle,
                down: applied.downAngle,
                samples: samples.length,
                // чем и по какому кадру мерили: без этой пары разбор упирается
                // в «угол странный, а почему — неизвестно»
                source: measured.source,
                frame: measured.frameW ? `${measured.frameW}x${measured.frameH}` : null,
              })
              console.info(
                `[motion] калибровка: стойка ${applied.standAngle}° -> UP ${applied.upAngle}° / DOWN ${applied.downAngle}°`,
              )
            }
          }

          // отсчёта нет — человек постоял, и этого довольно: дальше его ведёт
          // следующий экран, а считать до работы будет он
          if (countdownFrom <= 0) {
            okSinceRef.current = null
            if (!startedRef.current) {
              startedRef.current = true
              logEvent('workout.start', { countdown: false })
              onStartRef.current?.()
            }
            return
          }

          countdownRef.current = countdownFrom
          nextTickAtRef.current = now + 1000
          setCountdown(countdownFrom)
          cueCountdown(countdownFrom)
        }
        return
      }

      if (now < nextTickAtRef.current) return

      const next = countdownRef.current - 1
      nextTickAtRef.current = now + 1000

      if (next > 0) {
        countdownRef.current = next
        setCountdown(next)
        cueCountdown(next)
        return
      }

      // ноль — поехали
      countdownRef.current = null
      setCountdown(null)
      okSinceRef.current = null
      if (!startedRef.current) {
        startedRef.current = true
        logEvent('workout.start', {})
        cueStart()
        onStartRef.current?.()
      }
    }

    raf = requestAnimationFrame(tick)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      countdownRef.current = null
      okSinceRef.current = null
    }
  }, [active, countdownFrom])

  return { countdown, reason, hint, zones, holdProgress }
}
