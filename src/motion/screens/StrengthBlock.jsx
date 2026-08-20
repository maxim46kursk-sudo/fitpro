import { useEffect, useRef, useState } from 'react'
import DemoSkeleton from '../debug/DemoSkeleton.jsx'
import SessionProgress from '../components/SessionProgress.jsx'
import { createScore } from '../game/score.js'
import { obstaclePointsFor, tierById } from '../game/levels.js'
import { createTargets, readBody } from '../game/targets.js'
import { fitContain } from '../pose/viewport.js'
import { cueMilestone, cueRep, cueStart } from '../feedback/audio.js'
import { logEvent } from '../debug/logShipper.js'
import { domCounts, heapMb, noteCounts, noteFrame, noteStage, resetStages, stageReport } from '../debug/stageMeter.js'
import { getThresholds } from '../exercises/thresholds.js'
import { pushLive } from '../debug/diagnostics.js'
import {
  BLOCK_MS,
  STRENGTH_ANCHOR,
  STRENGTH_LABEL,
  STRENGTH_LOOP,
  createRepCounter,
  tempoFor,
} from '../game/strength.js'

/**
 * СИЛОВОЙ БЛОК — тридцать секунд одного движения.
 *
 * Игра ловит движение на лету: препятствие пролетает, и надо успеть в окно.
 * Блок устроен наоборот — он про ОБЪЁМ: время на табло, одно движение и
 * столько повторов, сколько человек успеет. Ничего не летит, промахов нет,
 * торопиться некуда.
 *
 * ИНСТРУКТОР В УГЛУ вместо инструкции словами. Человек стоит в двух метрах от
 * телефона: прочитать он успевает два-три слова, а движение по этим словам
 * восстанавливает не всякий. Фигурка крутит ровно ту петлю, которую от него
 * ждут, и крутит В ТЕМПЕ УРОВНЯ — на профи быстрее, потому что там и делать
 * надо чаще. Угол выбран так, чтобы она не легла на самого человека: он в
 * середине кадра, она — сбоку сверху и в треть высоты.
 *
 * СЧИТАЮТ ПОВТОРЫ ТЕ ЖЕ ДЕТЕКТОРЫ, ЧТО СУДЯТ ИГРУ (см. strength.js). Своих
 * проверок здесь нет ни одной: разойдись счёт блока с судейством раунда, и в
 * одном приложении оказались бы две разные игры.
 */
export default function StrengthBlock({
  subscribe,
  movement,
  tier,
  onFinish,
  onExit,
  /** Очки, накопленные до этого блока: на табло идёт общий счёт сессии. */
  scoreBase = 0,
  /**
   * Источник повторов. Наружу вынесен ради тестов: гонять через экран целую
   * запись человека, чтобы проверить, что цифра растёт, — дороже самой цифры.
   */
  makeCounter = createRepCounter,
  /**
   * Множитель темпа инструктора от ДНЯ ЧЕЛЛЕНДЖА. Уровень задаёт базовый темп
   * (новичок 1.0, профи 1.4), день его масштабирует: на тяжёлом дне то же
   * движение делается чаще, и фигура обязана показывать тот темп, которого от
   * человека ждут.
   */
  tempoMult = 1,
  /**
   * Сколько идёт блок. По умолчанию тридцать секунд — базовый день; день
   * челленджа подставляет своё (до сорока пяти на тридцатом).
   */
  durationMs = BLOCK_MS,
  /** Круг сессии для общей полосы прогресса; ноль — блок открыт сам по себе. */
  cycle = 0,
  cycles = 0,
  /**
   * Как блок называется в снимке состояния. Сессия передаёт имя своей фазы;
   * открытый сам по себе блок называет движение — то же имя, что уходит в
   * отчёт об ошибке.
   */
  screenName = null,
}) {
  const level = tierById(tier)
  /**
   * Снимок состояния должен называть то место, где человек сейчас находится.
   * До этого поле screen писал только экран калибровки, и в логе всей
   * тренировки стояло "calibration".
   */
  useEffect(() => {
    pushLive({ screen: screenName ?? `block:${movement}` })
  }, [screenName, movement])

  const [reps, setReps] = useState(0)
  const [score, setScore] = useState(0)
  const [leftMs, setLeftMs] = useState(durationMs)

  const canvasRef = useRef(null)
  const videoRef = useRef(null)
  const scoreRef = useRef(null)
  const targetsRef = useRef(null)
  const counterRef = useRef(null)
  const landmarksRef = useRef(null)
  const startedAtRef = useRef(null)
  const doneRef = useRef(false)
  /** Когда в последний раз считали живые объекты: обход документа не бесплатный. */
  const countsSinceRef = useRef(0)
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish

  if (!scoreRef.current) scoreRef.current = createScore({ hitPoints: obstaclePointsFor(level.id) })
  if (!targetsRef.current) targetsRef.current = createTargets()
  /**
   * Счётчик заводится с ПОРОГАМИ КАЛИБРОВКИ — теми же, с которыми человек
   * прошёл настройку и с которыми играет раунд. Без них присед считался
   * заводскими UP 160 / DOWN 100, а у калиброванного человека стойка ниже
   * ста шестидесяти: цикл не закрывался ни разу, и блок отдавал ноль повторов
   * при честной работе.
   */
  if (!counterRef.current) counterRef.current = makeCounter(movement, getThresholds())

  /**
   * Потолок в 1.6 не украшение: быстрее фигурка перестаёт читаться как
   * движение и превращается в мельтешение — показывать такое хуже, чем не
   * показывать вовсе.
   */
  const instructorTempo = Math.min(1.6, tempoFor(level.id) * (tempoMult > 0 ? tempoMult : 1))

  // --- приём кадров: те же детекторы, что и в игре ---
  useEffect(() => {
    if (!subscribe) return undefined
    return subscribe(({ landmarks, worldLandmarks, timestamp }) => {
      if (doneRef.current) return
      landmarksRef.current = landmarks
      if (startedAtRef.current == null) {
        startedAtRef.current = timestamp
        // счёт стадий с начала блока, а не с монтирования: разогрев модели и
        // выход человека в кадр в темп самого блока не входят
        resetStages()
        cueStart()
      }

      // стадия «судейство» силового блока: счётчик повторов по кадру
      const judgeAt = performance.now()
      const gained = counterRef.current.update(timestamp, { landmarks, worldLandmarks }) ?? 0
      noteStage('judge', performance.now() - judgeAt, judgeAt)
      noteFrame(judgeAt)
      if (judgeAt - countsSinceRef.current >= 1000) {
        countsSinceRef.current = judgeAt
        noteCounts({ heapMb: heapMb(), ...domCounts() }, judgeAt)
      }
      /**
       * ПОПЫТКИ ЦИКЛА В ЛОГ — по одной строке на попытку, зачётную и нет.
       *
       * Без них блок с одним повтором из восьми неразбираем: в логе было только
       * итоговое число, и что именно не сошлось — глубина, темп или замер
       * поплыл, — приходилось угадывать. Теперь в каждой строке замер, планка,
       * размах и (у приседа) режим: по колену мерили или по тазу.
       */
      for (const attempt of counterRef.current.attempts?.() ?? []) {
        logEvent('block.attempt', { movement, ...attempt })
      }
      for (let i = 0; i < gained; i += 1) {
        const res = scoreRef.current.hit()
        setReps(res.hits)
        setScore(res.total)
        cueRep()
        // каждый пятый повтор подряд — тот же акцент, что и в игре
        if (res.milestone) cueMilestone()

        // вспышка из той точки тела, которая это движение и делает
        const canvas = canvasRef.current
        const box = { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 }
        const video = videoRef.current ?? document.querySelector('.mt-video')
        const fit =
          fitContain(video?.videoWidth || 0, video?.videoHeight || 0, box.width, box.height) ??
          (box.width ? { ox: 0, oy: 0, dw: box.width, dh: box.height, scale: 1 } : null)
        const body = fit ? readBody(landmarks, fit) : null
        const point = body?.[STRENGTH_ANCHOR[movement] ?? 'hip']
        if (point) targetsRef.current.burstAt(point.x, point.y, { points: res.points })
      }
    })
  }, [subscribe, movement])

  // --- часы блока и отрисовка эффектов ---
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext ? canvas.getContext('2d') : null
    let raf = 0
    let stopped = false
    const startedAt = performance.now()

    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)
      const left = Math.max(0, durationMs - (performance.now() - startedAt))
      setLeftMs(left)

      if (ctx) {
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
        const w = Math.round(canvas.clientWidth * dpr)
        const h = Math.round(canvas.clientHeight * dpr)
        if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
          canvas.width = w
          canvas.height = h
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
        // мишеней в блоке нет — рисуются только вспышки за повторы
        targetsRef.current.draw(ctx, {
          width: canvas.clientWidth,
          height: canvas.clientHeight,
          clockMs: performance.now(),
          obstacles: [],
          body: null,
        })
      }

      if (left <= 0 && !doneRef.current) {
        doneRef.current = true
        const state = scoreRef.current.getState()
        // недоделанная попытка тоже уходит в лог: блок, кончившийся на нуле,
        // обязан сказать, до чего человек за эти тридцать секунд дотянул
        for (const attempt of counterRef.current.flush?.() ?? []) {
          logEvent('block.attempt', { movement, ...attempt })
        }
        logEvent('block.end', {
          movement,
          tier: level.id,
          reps: state.hits,
          score: state.total,
          /**
           * Разбор по стадиям и минутам — тот же, что в бою. Силовой блок тут
           * не менее важен: по журналу он проседает с 20 поз/с на первом круге
           * до 8 на третьем, то есть замедляется вместе со всем остальным, а
           * рисует при этом несравнимо меньше.
           */
          stages: stageReport(),
        })
        // блок кончился — его причина отказа больше никого не описывает
        pushLive({ lastReject: null })
        onFinishRef.current?.({
          movement,
          reps: state.hits,
          score: state.total,
          bestStreak: state.bestStreak,
          tier: level.id,
          tierName: level.name,
        })
      }
    }
    raf = requestAnimationFrame(tick)
    logEvent('block.start', { movement, tier: level.id })
    /**
     * Причина последнего отказа — своя у каждого подхода, и висеть между ними
     * она не должна. В полевом логе снимок состояния таскал строку, оставшуюся
     * от предыдущего боя, и в блоке приседа выглядело так, будто отказ только
     * что случился. Чистим на обоих концах блока: на старте — чтобы не начать
     * с чужой, в конце — чтобы не унести свою в следующий.
     */
    pushLive({ lastReject: null })

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [movement, level.id, level.name, durationMs])

  const loop = STRENGTH_LOOP[movement] ?? { movement, side: null }
  const seconds = Math.ceil(leftMs / 1000)

  return (
    <div className={`mt-screen mt-screen--game mt-block ${cycles > 0 ? 'mt-screen--sprog' : ''}`}>
      <div className="mt-game__sky" aria-hidden="true" />
      <canvas className="mt-game__canvas" ref={canvasRef} data-testid="block-canvas" />
      {/* видео живёт в CameraView выше по дереву; ссылка нужна только затем,
          чтобы знать размер кадра и попасть вспышкой в тело */}
      <video ref={videoRef} className="mt-block__probe" muted playsInline />

      <SessionProgress cycle={cycle} cycles={cycles} />

      {/* инструктор: сбоку сверху, в треть высоты — на человека не ложится */}
      <div className="mt-block__coach" data-testid="block-coach">
        <DemoSkeleton
          movement={loop.movement}
          side={loop.side}
          width={140}
          height={220}
          tempo={instructorTempo}
        />
        <div className="mt-block__coachLabel">{STRENGTH_LABEL[movement] ?? movement}</div>
      </div>

      <div className="mt-block__head">
        <div className="mt-block__timer" data-testid="block-timer">
          {seconds}
        </div>
        <div className="mt-block__level">{level.name}</div>
      </div>

      <div className="mt-block__count" data-testid="block-reps">
        <div className="mt-block__countValue">{reps}</div>
        <div className="mt-block__countLabel">повторов</div>
        <div className="mt-block__score" data-testid="block-score">
          {scoreBase + score}
        </div>
      </div>

      <div className="mt-game__command" data-testid="block-command">
        {STRENGTH_LABEL[movement] ?? movement}
      </div>

      {onExit && (
        <button type="button" className="mt-block__exit" onClick={onExit}>
          Выйти
        </button>
      )}
    </div>
  )
}
