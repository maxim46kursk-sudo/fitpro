import { useEffect, useRef, useState } from 'react'
import GameScreen from './GameScreen.jsx'
import StrengthBlock from './StrengthBlock.jsx'
import RestScreen from './RestScreen.jsx'
import SessionResult from './SessionResult.jsx'
import SessionMenu from '../components/SessionMenu.jsx'
import { obstaclePointsFor, tierById } from '../game/levels.js'
import {
  COUNTDOWN_MS,
  FIGHT_TYPES,
  attemptStatsOf,
  buildDay,
  cycleOf,
  cyclesOf,
  nextLabelOf,
} from '../game/session.js'
import { cueCountdown, cueTick } from '../feedback/audio.js'
import { completeDay } from '../game/challenge.js'
import { submitAttempt } from '../game/day.js'
import { submitScore } from '../game/record.js'
import { flush, logEvent } from '../debug/logShipper.js'
import { cleanNote, pushLive, snapshotOf } from '../debug/diagnostics.js'
import { noteScreen } from '../debug/errorReporter.js'
import { useWakeLock } from '../device/useWakeLock.js'

/**
 * СЕССИЯ ЦЕЛИКОМ — семь кругов «сила -> отдых -> бой -> отдых» и финальный лист.
 *
 * Экран не считает ни повторов, ни зачётов: он только ведёт расписание и
 * складывает то, что вернули блоки. Считают всё те же автоматы, что и раньше, —
 * в силовом блоке счётчик повторов, в бою движок раунда.
 *
 * ПОЧЕМУ РАСПИСАНИЕ ВЕДЁТСЯ ПО СОБЫТИЯМ, А НЕ ПО ЧАСАМ. Силовой блок и бой
 * заканчиваются сами и в конце отдают итог: повторы, зачёты, очки. Если бы
 * сессия переключала фазы по собственным часам, она рано или поздно сняла бы
 * блок за миг до его отчёта — и круг ушёл бы в ноль при честной работе. Поэтому
 * блоки сменяются ПО ИХ СОБСТВЕННОМУ ЗАВЕРШЕНИЮ, а по часам идут только отдых и
 * отсчёт, где считать нечего.
 */
export default function SessionScreen({ subscribe, videoRef = null, tier, day = 1, onExit }) {
  /**
   * ЭКРАН НЕ ГАСНЕТ ВСЮ СЕССИЮ, а не только в бою.
   *
   * Лок брали GameScreen и WorkoutScreen — то есть бой брал, а силовой блок,
   * отдых и отсчёт между кругами нет. Ровно там человек и стоит неподвижно, не
   * касаясь экрана: телефон гасит его посреди приседа, дальше не идут ни кадры,
   * ни счёт, и человек рассказывает это как «игра зависла». По логу отличить
   * погасший экран от настоящего зависания нечем.
   *
   * Сессия — самый длинный путь в модуле, и держать лок должна она целиком.
   * Вложенный лок GameScreen при этом остаётся: бой открывается и отдельно, по
   * ?round=1, и своя страховка ему нужна независимо от того, кто его позвал.
   */
  useWakeLock(true)

  const level = tierById(tier)
  /**
   * ДЕНЬ ЧЕЛЛЕНДЖА СОБИРАЕТ СЕССИЮ. Уровень остаётся базой — точность круга,
   * его жизнь и пауза, — а день масштабирует: сколько кругов, как долго и
   * насколько плотно. Пересобирается только при смене дня или уровня: внутри
   * тренировки план не меняется, иначе круги поехали бы под ногами.
   */
  const plan = useRef(null)
  if (!plan.current || plan.current.plan.day !== day) plan.current = buildDay(day, level)

  const [index, setIndex] = useState(0)
  /**
   * Остаток берётся у ПЕРВОЙ ФАЗЫ, а не у константы отсчёта: часы заводятся
   * эффектом, то есть после первого кадра, и подставь сюда COUNTDOWN_MS —
   * стартовый отсчёт успел бы мигнуть «3» перед «10».
   */
  const [leftMs, setLeftMs] = useState(plan.current.phases[0].durationMs)
  /**
   * ПАУЗА ТРЕНИРОВКИ. Часы отдыха стоят, блоки и бои размонтируются целиком —
   * то есть кадры до детекторов не доходят вовсе, и ни одного повтора за время
   * паузы человеку не припишется и не потеряется.
   */
  const [paused, setPaused] = useState(false)
  /** Номер захода: меняется на «начать заново» и пересоздаёт всё под собой. */
  const [runId, setRunId] = useState(0)
  const totals = useRef({ score: 0, strength: [], fights: [], hits: 0, spawned: 0, reactSum: 0, reactCount: 0 })
  const submitted = useRef(false)
  /** Что ответил зачёт дня. Ref, а не состояние: пишется один раз, до отрисовки. */
  const attemptRef = useRef(null)
  const startedAt = useRef(null)

  const phases = plan.current.phases
  const phase = phases[Math.min(index, phases.length - 1)]

  /** КРУГ K ИЗ M для общей полосы прогресса — правило и счёт лежат в session.js. */
  const cycles = cyclesOf(phases)
  const cycle = cycleOf(phase)

  /** Начать тренировку заново тем же уровнем: счёт, круги и заход — с нуля. */
  const restart = () => {
    totals.current = { score: 0, strength: [], fights: [], hits: 0, spawned: 0, reactSum: 0, reactCount: 0 }
    submitted.current = false
    attemptRef.current = null
    setPaused(false)
    setIndex(0)
    setRunId((n) => n + 1)
    logEvent('session.restart', { tier: level.id })
  }

  /**
   * ЖАЛОБА ЧЕЛОВЕКА — тот же снимок состояния, что и в журнале отклонений.
   *
   * Ценность жалобы не в словах (их всё равно не напишут в спортзале), а в
   * МОМЕНТЕ: снимок снят тогда, когда человеку что-то не понравилось, а не
   * раз в пять секунд вслепую. Режим отрисовки, частота, задержка показа,
   * потерянные кадры, состояние звука — по ним видно и «не видно попаданий»,
   * и «не слышно отсчёта», и «всё тормозит».
   *
   * СЛОВА ЧЕЛОВЕКА — необязательные и первым полем. Снимок говорит, ЧТО
   * происходило с телефоном, слова — что человек при этом видел; порознь оба
   * толкуются гадательно, вместе разбираются за минуту. Поле необязательное
   * потому, что жалоба без слов всё равно ценнее ненажатой кнопки.
   *
   * Ничего личного сверх написанного самим человеком: снимок технический, поля
   * те же, что уходят каждые пять секунд. Ни имени, ни камеры, ни адреса.
   *
   * Отправка немедленная, а не через буфер: человек в этот момент смотрит на
   * экран и через минуту может закрыть вкладку.
   */
  const reportProblem = async (note) => {
    const текст = cleanNote(note)
    logEvent('user.report', {
      // note первым: и в строке лога, и в сообщении тревоги читают сверху
      ...(текст ? { note: текст } : {}),
      ...snapshotOf(),
      phase: phase.kind,
      tier: level.id,
    })
    await flush()
  }

  /** Меню одинаково на всех фазах — поэтому и собирается одним куском. */
  const menu = (
    <SessionMenu
      paused={paused}
      onPause={() => setPaused(true)}
      onResume={() => setPaused(false)}
      onRestart={restart}
      onExit={onExit}
      onReport={reportProblem}
    />
  )

  /** Следующая фаза нужна отдыху: он показывает, что будет дальше. */
  const advance = () => setIndex((i) => Math.min(i + 1, phases.length - 1))

  // --- часы: только для отдыха и отсчёта ---
  useEffect(() => {
    if (phase.kind !== 'rest' && phase.kind !== 'countdown') return undefined
    // на паузе часы отдыха стоят: иначе человек, отошедший к телефону, вернулся
    // бы прямо в начатый бой
    if (paused) return undefined
    startedAt.current = performance.now()
    setLeftMs(phase.durationMs)
    let raf = 0
    let stopped = false
    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)
      const left = Math.max(0, phase.durationMs - (performance.now() - startedAt.current))
      setLeftMs(left)
      if (left <= 0) {
        stopped = true
        cancelAnimationFrame(raf)
        advance()
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
    // фаза меняется — часы заводятся заново
  }, [index, phase.kind, phase.durationMs, paused])

  /**
   * ГДЕ ЧЕЛОВЕК НАХОДИТСЯ — одной строкой и в отчёт об ошибке, и в снимок
   * состояния.
   *
   * Ошибка внутри сессии обязана называть фазу, а не «workout»: блок, бой и
   * отдых — три разных набора кода, и знать, который из них упал, важнее, чем
   * знать, что человек был на тренировке.
   *
   * Снимок состояния до этого врал: поле screen писал только экран калибровки
   * (useAutoStart), и в логе всей тренировки стояло "calibration" — разбор
   * начинался с того, что читающий не верил собственному логу. Теперь фаза
   * называет себя сама, а блок и бой получают то же имя, чтобы их покадровая
   * запись не перетирала его обратно.
   */
  const screenName = `session:${phase.kind}:круг${cycle}`
  useEffect(() => {
    noteScreen(screenName)
    pushLive({ screen: screenName })
  }, [screenName])

  useEffect(() => {
    logEvent('session.start', {
      tier: level.id,
      // день челленджа в первой же строке лога: без него непонятно, какую
      // тренировку человек вообще делал — их тридцать разных
      day: plan.current.plan.day,
      intensity: plan.current.plan.intensity,
      deload: plan.current.plan.deload,
      cycles: phases.filter((p) => p.kind === 'strength').length,
    })
  }, [level.id, phases, day])

  const finishStrength = (result) => {
    totals.current.score += result.score
    totals.current.strength.push({
      cycle: phase.cycle,
      movement: phase.movement,
      reps: result.reps,
      score: result.score,
    })
    logEvent('session.strength', { movement: phase.movement, reps: result.reps, score: result.score })
    advance()
  }

  const finishFight = (result) => {
    totals.current.score += result.score ?? 0
    /**
     * Статистика попытки копится по боям, а не по сессии целиком: точность и
     * реакция — свойства боя, в силовом блоке ни мишеней, ни окна зачёта нет.
     * Реакция складывается СУММОЙ и числом зачётов — средние по восьми боям
     * сложить нельзя, бой с тремя зачётами весил бы столько же, сколько бой с
     * восемьюдесятью.
     */
    totals.current.hits += result.cleared ?? 0
    totals.current.spawned += result.obstacles ?? 0
    totals.current.reactSum += result.reactSum ?? 0
    totals.current.reactCount += result.reactCount ?? 0
    totals.current.fights.push({
      cycle: phase.cycle,
      cleared: result.cleared ?? 0,
      spawned: result.obstacles ?? 0,
      score: result.score ?? 0,
    })
    logEvent('session.fight', { cycle: phase.cycle, cleared: result.cleared, score: result.score })
    advance()
  }

  const countdown =
    phase.kind === 'countdown' || (phase.kind === 'rest' && leftMs <= COUNTDOWN_MS)
      ? Math.max(1, Math.ceil(leftMs / 1000))
      : null

  /**
   * ОТСЧЁТ СЛЫШНО, А НЕ ТОЛЬКО ВИДНО.
   *
   * Человек стоит в двух метрах от телефона и на отсчёте смотрит не в экран, а
   * туда, где сейчас будет работать: он отходит, разворачивается, встаёт в
   * стойку. Немые цифры он в этот момент пропускает и узнаёт о начале блока по
   * тому, что блок уже идёт.
   *
   * Рисунок тот же, что у отсчёта перед подходом (useAutoStart), — человеку не
   * надо учить второй язык: секунды тикают, последние три звучат акцентом.
   * Тумблер звука соблюдается сам: все cue молчат, когда он выключен.
   *
   * СИГНАЛА СТАРТА ЗДЕСЬ НЕТ. Его даёт сама работа: силовой блок на первом
   * кадре (StrengthBlock), бой — по round.start. Дай его ещё и отсчёт — и на
   * нуле звучали бы два трезвучия подряд, с разрывом в десяток миллисекунд,
   * то есть старт с эхом.
   */
  const soundedCountdown = useRef(null)
  useEffect(() => {
    // на паузе часы стоят, и цифра не меняется; проверка стоит явно, чтобы
    // тишина на паузе не зависела от того, как заведены часы
    if (paused) return
    if (countdown === soundedCountdown.current) return
    soundedCountdown.current = countdown
    if (countdown == null) return

    // последние секунды — тот же акцент, что и перед подходом
    if (countdown <= COUNTDOWN_MS / 1000) cueCountdown(countdown)
    else cueTick()
  }, [countdown, paused])

  if (phase.kind === 'done') {
    // рекорд дня — один на всю тренировку, и подаётся он здесь
    if (!submitted.current) {
      submitted.current = true
      const record = submitScore(totals.current.score)
      /**
       * ДЕНЬ ЗАСЧИТЫВАЕТСЯ ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ — на фазе done, то есть после
       * последнего круга. Не на старте, не в середине и не по выходу из меню:
       * на кону деньги, и «день сдан» обязано значить, что он пройден целиком.
       *
       * Указатель дня при этом НЕ ДВИГАЕТСЯ: сдача открывает дверь вперёд, а
       * входит в неё человек сам, кнопкой на выборе уровня. Иначе первая же
       * завершённая сессия сжигала бы оставшиеся попытки дня — и дошедший до
       * конца оказывался бы наказан за то, что дошёл.
       */
      const marked = completeDay(plan.current.plan.day)

      /**
       * ПОПЫТКА УХОДИТ В ЗАЧЁТ ДНЯ — здесь же, рядом с завершением дня, и по
       * той же причине: засчитывается пройденное целиком, а не начатое.
       *
       * Записывается статистика, а не один счёт. Очки за месяц могут стоять на
       * месте — человек берёт те же мишени и получает те же баллы, — а реакция
       * при этом уезжает на двести миллисекунд. Без неё прогресс просто нечем
       * показать, и человек, который стал заметно быстрее, видит ту же цифру,
       * что и в первый день.
       */
      attemptRef.current = submitAttempt(
        level.id,
        attemptStatsOf(totals.current, new Date().toISOString()),
        plan.current.plan.day,
      )

      logEvent('session.end', {
        tier: level.id,
        day: plan.current.plan.day,
        // день сдан; перешёл ли человек дальше — уже другое событие
        dayDone: marked.dayDone,
        score: totals.current.score,
        best: record.best,
        isRecord: record.isRecord,
        // зачёт дня: пошла ли попытка в счёт и что она изменила
        recorded: attemptRef.current.recorded,
        attempt: attemptRef.current.attempt,
        attemptsLeft: attemptRef.current.attemptsLeft,
        dayBest: attemptRef.current.best,
        isBest: attemptRef.current.isBest,
        dayTotal: attemptRef.current.dayTotal,
      })
    }
    return (
      <SessionResult
        result={{
          ...totals.current,
          level,
          hitPoints: obstaclePointsFor(level.id),
          day: plan.current.plan.day,
          days: 30,
          attempt: attemptRef.current,
        }}
        onExit={onExit}
        onRestart={restart}
      />
    )
  }

  /**
   * ПАУЗА СНИМАЕТ С ЭКРАНА ВСЁ, включая отдых: блок и бой размонтируются
   * целиком, а не «замирают». Так кадры до детекторов не доходят вовсе — за
   * время паузы человеку не припишется ни одного повтора и не спишется ни одной
   * мишени. Замри они на месте, счётчик повторов продолжал бы видеть позу и
   * считать: человек стоит у телефона, а игра пишет ему приседы.
   *
   * Проверка стоит ВЫШЕ всех фаз и ниже финала: на финальном листе паузе делать
   * нечего, тренировка уже кончилась.
   */
  if (paused) {
    return (
      <>
        <div className="mt-screen mt-screen--game mt-paused" data-testid="session-paused">
          <div className="mt-rest__veil" aria-hidden="true" />
          <div className="mt-paused__title">ПАУЗА</div>
          <div className="mt-paused__text">Тренировка ждёт — открой меню и продолжи</div>
        </div>
        {menu}
      </>
    )
  }

  if (phase.kind === 'countdown' || phase.kind === 'rest') {
    const next = phase.next
    return (
      <>
        <RestScreen
          leftMs={paused ? phase.durationMs : leftMs}
          countdown={paused ? null : countdown}
          nextLabel={nextLabelOf(phase)}
          nextMovement={next === 'fight' ? null : next}
          tier={level.id}
          cycle={cycle}
          cycles={cycles}
          // на отдыхе счёт наконец есть на что посмотреть: в блоке и в бою
          // человек занят, а здесь он как раз и спрашивает «сколько у меня?»
          score={totals.current.score}
        />
        {menu}
      </>
    )
  }

  if (phase.kind === 'strength') {
    return (
      <>
        <StrengthBlock
          key={`strength-${runId}-${index}`}
          subscribe={subscribe}
          screenName={screenName}
          movement={phase.movement}
          tier={level.id}
          durationMs={phase.durationMs}
          tempoMult={plan.current.tempoMult}
          scoreBase={totals.current.score}
          cycle={cycle}
          cycles={cycles}
          onFinish={finishStrength}
        />
        {menu}
      </>
    )
  }

  return (
    <>
      <GameScreen
        key={`fight-${runId}-${index}`}
        subscribe={subscribe}
        // бой пишет имя экрана каждым кадром — пусть пишет имя фазы сессии
        screenName={screenName}
        videoRef={videoRef}
        tier={level.id}
        scoreBase={totals.current.score}
        cycle={cycle}
        cycles={cycles}
        // выход из тренировки один — через меню: оно ставит паузу и спрашивает,
        // а угловой крестик обрывал молча и лежал поверх очков
        hideCancel
        /**
         * Бой — это ловец мишеней, полторы минуты (режим движка по умолчанию).
         * `types` здесь остаётся ради `?moves=1`: под этим ключом бой снова
         * становится потоком движений, и тогда силовые движения круга в него не
         * идут — человек их уже сделал. Ловец про наборы движений не знает вовсе.
         */
        config={{
          types: FIGHT_TYPES,
          durationMs: phase.durationMs,
          practiceNeeded: 0,
          // жизнь и пауза мишеней — уровень, умноженный на день
          ...plan.current.catcher,
        }}
        // рекорд дня подаёт сессия целиком, а не каждый из семи боёв
        submitsRecord={false}
        onFinish={finishFight}
        onCancel={onExit}
      />
      {menu}
    </>
  )
}
