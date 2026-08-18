import { useEffect, useRef, useState } from 'react'
import { createSquatTracker } from '../exercises/squat.js'
import { getThresholds } from '../exercises/thresholds.js'
import { readStance } from '../game/dodge.js'
import { readUpper } from '../game/strike.js'
import { readVertical } from '../game/vertical.js'
import { readLegs } from '../game/legs.js'
import {
  SETUP_MOVEMENTS,
  SETUP_NAME,
  SETUP_REPS,
  SETUP_SIDE,
  SETUP_TASK,
  createAmplitudeCounter,
  describeBar,
  globalBarOf,
} from '../game/amplitude.js'
import { observe, personalThreshold, readMaxes, resetPersonal } from '../game/personal.js'
import { DEFAULT_ROUND, LUNGE_DROP } from '../game/engine.js'
import DemoSkeleton from '../debug/DemoSkeleton.jsx'
import { logEvent } from '../debug/logShipper.js'

/**
 * «Калибровка» — знакомство с движениями перед челленджем и замер личной планки.
 *
 * Называется коротким словом не для красоты. «Настройка под себя» обещает
 * копание в настройках, и человек, увидевший её первым экраном, ждёт формы и
 * ползунки, а получает работу телом. «Калибровка» говорит ровно то, что здесь
 * происходит: прибор настраивается по человеку, а не человек по прибору.
 *
 * Экран решает две задачи одним проходом. Первая: человек видит все девять
 * движений и пробует их без спешки — до челленджа, а не в первом же раунде на
 * скорости. Вторая: игра узнаёт его личную амплитуду и дальше судит по ней
 * (personal.js), а не по среднему по больнице.
 *
 * ЗДЕСЬ НЕТ НИ ОЧКОВ, НИ ТАЙМЕРА, НИ СПЕШКИ. Это знакомство, а не зачёт: любая
 * гонка на этом экране прямо вредит его цели — человек начнёт частить и покажет
 * не свою амплитуду, а свою торопливость, и планка на всю неделю выйдет кривой.
 *
 * ЧЕЛОВЕК НЕ ДОЛЖЕН ЗАСТРЯТЬ. Движение может не засчитаться по любой причине —
 * тесная комната, слабая камера, непонятая инструкция. Поэтому через STUCK_MS
 * без единого повтора появляется крупная кнопка «Пропустить движение»: у
 * пропущенного останется общая планка, и настроить его можно потом. Экран, на
 * котором можно застрять перед платным челленджем, — это потерянный участник.
 *
 * Камера остаётся видна всё время: демо-фигурка живёт в своей плашке рядом с
 * подписью, а середина экрана отдана человеку. Тот же принцип, что и в
 * «Калибровке движений», и по той же причине — не видя себя, человек не
 * понимает, попадает ли он в кадр.
 */

/** Сколько ждём повтора, прежде чем предложить пропустить движение. */
export const STUCK_MS = 25000
/** Как часто тикает счётчик ожидания. */
const TICK_MS = 500

/** Если результаты из воркера перестали приходить — считаем, что кадров нет. */
const STALE_MS = 1500

export default function PersonalSetupScreen({ subscribe, onDone, onExit }) {
  const [thresholds] = useState(() => getThresholds())
  const [index, setIndex] = useState(0)
  /** Пики засчитанных повторов текущего движения. */
  const [reps, setReps] = useState([])
  /** Повторов нет слишком долго — предлагаем пропустить. */
  const [stuck, setStuck] = useState(false)
  /** Сводка в конце: движение -> планка. */
  const [summary, setSummary] = useState(null)

  const movement = SETUP_MOVEMENTS[index] ?? null
  const side = movement ? SETUP_SIDE[movement] ?? null : null

  const trackerRef = useRef(null)
  if (!trackerRef.current) trackerRef.current = createSquatTracker(getThresholds())
  const counterRef = useRef(null)
  /** Обработчик кадра держим в ref: подписка живёт дольше одного рендера. */
  const onFrameRef = useRef(null)
  const lastFrameAtRef = useRef(0)
  /**
   * Шаг уже закрыт. Между «набрал три повтора» и заменой счётчика проходит
   * рендер, и кадры в этот зазор успевают прийти — без флага они закрыли бы
   * шаг второй раз и перепрыгнули бы через движение.
   */
  const closedRef = useRef(false)

  // новое движение — новый счётчик и чистый шаг
  useEffect(() => {
    if (!movement) return
    counterRef.current = createAmplitudeCounter(movement, { thresholds })
    closedRef.current = false
    setReps([])
    setStuck(false)
  }, [movement, thresholds])

  /**
   * Сохранить планку движения и пойти дальше. Медиану считает счётчик: один
   * шумный повтор не должен задрать планку на всю неделю.
   */
  /**
   * Закрыть шаг. Планка пишется, ТОЛЬКО если набраны все повторы.
   *
   * Полевой тест 13 августа: человек сделал часть повторов удара, не смог
   * доделать и нажал «Пропустить» — и планка всё равно записалась, по одному
   * замеру вместо медианы трёх. То есть ровно та защита от выброса, ради
   * которой повторов три, не сработала, а лог при этом написал «reps 0,
   * skipped» и противоречил сам себе. Нажал «пропустить» — значит замер не
   * состоялся, и планка остаётся общей.
   */
  const finishStep = () => {
    if (closedRef.current) return
    closedRef.current = true

    const counter = counterRef.current
    const done = counter?.reps.length ?? 0
    const full = done >= SETUP_REPS
    const { value, drop } = full ? counter.result() : {}

    if (value != null) observe(movement, value)
    // у выпада мер две, и вторая обязана быть личной так же, как первая: иначе
    // человек настраивает ногу, а упирается в таз
    if (drop != null) observe(LUNGE_DROP, drop)
    logEvent('setup.move', {
      movement,
      // сколько повторов человек сделал на самом деле, а не сколько мы попросили
      reps: done,
      value: value == null ? null : Number(value.toFixed(2)),
      drop: drop == null ? undefined : Number(drop.toFixed(2)),
      skipped: !full,
    })

    if (index + 1 >= SETUP_MOVEMENTS.length) {
      const maxes = readMaxes()
      const barText = (id, global) =>
        describeBar(id, personalThreshold(id, global, maxes), thresholds)
      setSummary(
        SETUP_MOVEMENTS.map((id) => ({
          id,
          name: SETUP_NAME[id],
          own: maxes[id] != null,
          text: barText(id, globalBarOf(id, thresholds)),
          // у выпада планок две — показываем обе, иначе человек увидит только
          // половину того, что с него спросят
          extra:
            id === 'lunge' ? barText(LUNGE_DROP, DEFAULT_ROUND.lungeDropK) : null,
        })),
      )
      // считаем ДВИЖЕНИЯ, а не ключи: у выпада их два, и в поле это дало
      // «настроено 10» при девяти движениях на экране
      logEvent('setup.done', {
        movements: SETUP_MOVEMENTS.filter((id) => maxes[id] != null).length,
        total: SETUP_MOVEMENTS.length,
      })
      return
    }
    setIndex((n) => n + 1)
  }

  onFrameRef.current = ({ landmarks, worldLandmarks, timestamp }) => {
    lastFrameAtRef.current = Date.now()
    const counter = counterRef.current
    if (!counter || summary || closedRef.current) return

    const out = trackerRef.current.update(landmarks, timestamp, worldLandmarks)
    // поза собирается ровно так же, как для игры: судить настройку надо теми же
    // числами, которыми потом судится раунд
    const pose = {
      ...readStance(landmarks),
      ...readUpper(landmarks, worldLandmarks),
      ...readVertical(landmarks),
      ...pickFeet(readLegs(landmarks, worldLandmarks)),
      angle: out.paused ? null : out.angle,
    }

    const done = counter.update(timestamp, pose)
    if (!done) return

    setReps([...counter.reps])
    // шаг закрывается прямо здесь, а не эффектом на счётчике повторов: эффект
    // успевал сработать второй раз на старом состоянии и перепрыгивал движение
    if (counter.reps.length >= SETUP_REPS) finishStep()
  }

  useEffect(() => subscribe?.((frame) => onFrameRef.current?.(frame)), [subscribe])

  /**
   * Ожидание повтора. Считаем СВОИМИ тиками, а не часами: экран могли открыть и
   * уйти заваривать чай, и «прошло 25 секунд» должно означать «человек 25
   * секунд пробовал», а не «вкладка провисела полминуты».
   */
  useEffect(() => {
    if (!movement || summary || stuck) return undefined
    let waited = 0
    const id = setInterval(() => {
      // пока кадры не идут, время ожидания не течёт: человек не виноват
      if (Date.now() - lastFrameAtRef.current > STALE_MS) return
      waited += TICK_MS
      if (waited >= STUCK_MS) setStuck(true)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [movement, summary, stuck, reps.length])

  const restart = () => {
    resetPersonal()
    setSummary(null)
    setIndex(0)
    setReps([])
    setStuck(false)
  }

  if (summary) {
    return (
      <div className="mt-screen mt-setup mt-setup--summary" data-testid="personal-setup">
        <div className="mt-setup__kicker" data-testid="setup-title">
          Калибровка
        </div>
        <h1 className="mt-title">Твоя планка</h1>
        <div className="mt-setup__note">
          Дальше игра будет засчитывать движения по этим числам — они сняты с
          тебя, а не с кого-то другого.
        </div>

        <div className="mt-setup__list" data-testid="setup-summary">
          {summary.map((row) => (
            <div key={row.id} className="mt-setup__row" data-testid={`setup-row-${row.id}`}>
              <span className="mt-setup__rowName">{row.name}</span>
              <span className="mt-setup__rowBar">
                {row.text}
                {row.extra && <i className="mt-setup__extra"> {row.extra}</i>}
                {!row.own && <i className="mt-setup__common"> — общая</i>}
              </span>
            </div>
          ))}
        </div>

        <button className="mt-setup__go" data-testid="setup-done" onClick={() => onDone?.()}>
          Готово
        </button>
        <button className="mt-setup__again" data-testid="setup-restart" onClick={restart}>
          Пройти заново
        </button>
      </div>
    )
  }

  return (
    <div className="mt-screen mt-setup mt-setup--run" data-testid="personal-setup">
      {/* Плашка вверху, кнопки внизу, середина за камерой — как в калибровке
          движений. Фигурка стоит РЯДОМ с подписью, а не поверх видео. */}
      <div className="mt-setup__top" data-testid="setup-top">
        <DemoSkeleton movement={movement} side={side} />
        <div className="mt-setup__brief">
          {/* Экран называется на обоих своих видах — и во время работы, и в
              сводке: человек должен понимать, где он находится, не гадая */}
          <div className="mt-setup__kicker" data-testid="setup-title">
            Калибровка
          </div>
          <div className="mt-setup__step">
            {index + 1} из {SETUP_MOVEMENTS.length} · {SETUP_NAME[movement]}
          </div>
          <div className="mt-setup__task" data-testid="setup-task">
            {SETUP_TASK[movement]}
          </div>
          <div className="mt-setup__hint">Сделай {SETUP_REPS} раза во всю силу</div>
        </div>
      </div>

      <div className="mt-setup__count" data-testid="setup-count">
        {reps.length}/{SETUP_REPS}
      </div>

      <div className="mt-setup__bottom">
        {stuck ? (
          <>
            <div className="mt-setup__stuck" data-testid="setup-stuck">
              Не получается? Пропусти — настроим это движение позже, а пока оно
              будет засчитываться по общей планке.
            </div>
            <button className="mt-setup__skip" data-testid="setup-skip" onClick={finishStep}>
              Пропустить движение
            </button>
          </>
        ) : (
          <div className="mt-setup__calm">Не спеши — здесь нет ни очков, ни таймера</div>
        )}
      </div>

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Выйти">
        ✕
      </button>
    </div>
  )
}

/** Из признаков ног берём только то, чего нет в остальных читалках. */
function pickFeet(legs) {
  return { ankleDy: legs.ankleDy, ankleBack: legs.ankleBack }
}
