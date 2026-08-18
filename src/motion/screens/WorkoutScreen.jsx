import { useEffect, useRef, useState } from 'react'
import RepCounter from '../components/RepCounter.jsx'
import Timer from '../components/Timer.jsx'
import { createSquatTracker } from '../exercises/squat.js'
import { getThresholds, subscribeThresholds } from '../exercises/thresholds.js'
import { MODE, QUALITY, REASON, REASON_TEXT } from '../pose/frameGate.js'
import {
  cueFrameLost,
  cueMilestone,
  cueRep,
  cueShallow,
  cueWarn,
} from '../feedback/audio.js'
import { pushLive, pushLogEntry } from '../debug/diagnostics.js'
import { logEvent } from '../debug/logShipper.js'
import { useWakeLock } from '../device/useWakeLock.js'

const DURATION_SEC = 60
/** Если результаты из воркера вообще перестали приходить — тоже пауза. */
const STALE_RESULT_MS = 1000
/** За сколько секунд до конца предупреждаем голосом. */
const WARN_AT_SEC = 10
/** Раз во столько неглубоких приседов подсказываем голосом. */
const SHALLOW_HINT_EVERY = 3

export default function WorkoutScreen({
  subscribe,
  onFinish,
  onCancel,
  duration = DURATION_SEC,
  blocked = false,
}) {
  const [reps, setReps] = useState(0)
  const [paused, setPaused] = useState(true)
  const [reason, setReason] = useState(REASON.OK)
  /** ok | low | none — «часть точек ненадёжна» это предупреждение, а не стоп. */
  const [quality, setQuality] = useState(QUALITY.OK)
  const [mode, setMode] = useState(MODE.KNEE)
  /** До первого кадра молчим: иначе сразу после «Начали!» летит «Встань в кадр». */
  const [gotFrame, setGotFrame] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(duration)

  const trackerRef = useRef(null)
  const configRef = useRef(getThresholds())
  /** Пока человека ни разу не увидели — таймер не стартует. */
  const seenRef = useRef(false)
  /**
   * Пауза по кадру ставится БЕЗ задержки: полевой тест показал, что даже
   * короткое «продолжаем считать, вдруг вернётся» превращается в тихий отказ.
   */
  const frameOkRef = useRef(false)
  const hasFrameRef = useRef(false)
  const reasonRef = useRef(REASON.NO_PERSON)
  const lastResultAtRef = useRef(performance.now())
  const remainingMsRef = useRef(duration * 1000)
  const finishedRef = useRef(false)
  const warnedRef = useRef(false)
  const shallowCountRef = useRef(0)
  const onFinishRef = useRef(onFinish)
  const blockedRef = useRef(blocked)

  onFinishRef.current = onFinish
  blockedRef.current = blocked
  if (!trackerRef.current) trackerRef.current = createSquatTracker(getThresholds())

  // Экран не должен гаснуть, пока человек приседает.
  useWakeLock(true)

  useEffect(
    () =>
      subscribeThresholds((t) => {
        configRef.current = t
        trackerRef.current.setConfig(t)
      }),
    [],
  )

  // --- приём кадров ---
  useEffect(() => {
    let lastReps = 0
    let lastReason = null
    let lastQuality = null
    let lastMode = null

    return subscribe(({ landmarks, worldLandmarks, timestamp }) => {
      lastResultAtRef.current = performance.now()
      if (!hasFrameRef.current) {
        hasFrameRef.current = true
        setGotFrame(true)
      }

      // Гейт со всей временной логикой живёт внутри трекера — один источник
      // правды. Экран только читает его вывод.
      const out = trackerRef.current.update(landmarks, timestamp, worldLandmarks)

      frameOkRef.current = !out.paused
      reasonRef.current = out.reason
      if (!out.paused) seenRef.current = true

      if (out.reason !== lastReason) {
        lastReason = out.reason
        setReason(out.reason)
      }
      if (out.quality !== lastQuality) {
        lastQuality = out.quality
        setQuality(out.quality)
      }
      if (out.mode !== lastMode) {
        lastMode = out.mode
        setMode(out.mode)
      }

      pushLive({
        screen: 'workout',
        angle: out.angle,
        rawAngle: out.rawAngle,
        state: out.state,
        zone: out.zone,
        reps: out.reps,
        outOfFrame: out.outOfFrame,
        missing: out.missing,
        minAngleInRep: out.minAngleInRep,
        frameReason: out.reason,
        points: out.points,
        mode: out.mode,
        lastReject: out.lastReject,
        thresholds: trackerRef.current.config,
      })
      if (out.event) {
        pushLogEntry(out.event)
        logEvent(`rep.${out.event.kind}`, {
          min: Math.round(out.event.minAngle),
          cycleMs: Math.round(out.event.durationMs),
          extrema: out.event.extrema,
          bottoms: out.event.bottomTouches,
          reason: out.event.reason,
        })
      }

      if (out.event?.kind === 'shallow') {
        cueShallow()
        shallowCountRef.current += 1
      }

      // Несколько заходов в нижнюю точку внутри одного цикла — человек
      // не разгибается до конца, и повторы слипаются. Молчать нельзя.

      if (out.reps !== lastReps) {
        lastReps = out.reps
        setReps(out.reps)
        cueRep()
        // каждый пятый — акцент, чтобы не терять счёт без голоса
        if (out.reps % 5 === 0) cueMilestone()
      }
    })
  }, [subscribe])

  // --- таймер: идёт только пока человек целиком в кадре ---
  useEffect(() => {
    let raf = 0
    let prev = performance.now()
    let stopped = false

    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)

      const now = performance.now()
      const dt = now - prev
      prev = now

      const stale = now - lastResultAtRef.current > STALE_RESULT_MS
      const isPaused = blockedRef.current || !seenRef.current || !frameOkRef.current || stale

      setPaused((p) => (p === isPaused ? p : isPaused))

      if (isPaused) {
        // голос, потому что человек в двух метрах и на экран не смотрит
        if (!blockedRef.current && hasFrameRef.current) {
          cueFrameLost()
        }
        return
      }

      remainingMsRef.current = Math.max(0, remainingMsRef.current - dt)
      const left = Math.ceil(remainingMsRef.current / 1000)
      setSecondsLeft((s) => (s === left ? s : left))

      if (!warnedRef.current && left <= WARN_AT_SEC && left > 0) {
        warnedRef.current = true
        cueWarn()
      }

      if (remainingMsRef.current <= 0 && !finishedRef.current) {
        finishedRef.current = true
        onFinishRef.current({
          ...trackerRef.current.getStats(),
          seconds: duration - Math.ceil(remainingMsRef.current / 1000),
        })
      }
    }

    raf = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [duration])

  const cancel = () => {
    if (finishedRef.current) return
    finishedRef.current = true
    onCancel?.()
  }

  return (
    <div className="mt-screen mt-screen--workout">
      <div className="mt-hud">
        <Timer secondsLeft={secondsLeft} total={duration} paused={paused} />
        <RepCounter reps={reps} />
      </div>

      {/* при ландшафте подсказку рисует MotionApp — здесь не дублируем */}
      {paused && !blocked && gotFrame && (
        <div className="mt-blocker mt-blocker--hard" data-testid="frame-blocker">
          <div className="mt-blocker__card">
            <div className="mt-blocker__title">
              {REASON_TEXT[reasonRef.current] || 'Встань в кадр'}
            </div>
            <div className="mt-blocker__text">
              Таймер стоит, повторы не считаются, пока не видно всё тело
            </div>
          </div>
        </div>
      )}

      {/* Мягкое предупреждение: повторы считаем, но точность ниже. Подход не рвём. */}
      {!paused && (quality === QUALITY.LOW || mode === MODE.HIP_FALLBACK) && (
        <div className="mt-softwarn" data-testid="soft-warning">
          {mode === MODE.HIP_FALLBACK
            ? 'Не вижу стопы — считаю глубину по тазу, точность ниже'
            : 'Часть точек видно неуверенно — считаю, но помечаю в логе'}
        </div>
      )}

      <button className="mt-corner mt-corner--left" onClick={cancel} aria-label="Отменить подход">
        ✕
      </button>
    </div>
  )
}
