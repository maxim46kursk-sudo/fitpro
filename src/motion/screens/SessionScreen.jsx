import { useEffect, useRef, useState } from 'react'
import GameScreen from './GameScreen.jsx'
import StrengthBlock from './StrengthBlock.jsx'
import RestScreen from './RestScreen.jsx'
import SessionResult from './SessionResult.jsx'
import ExitChoice from '../components/ExitChoice.jsx'
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
import { closePending, dropPending, dropSession, holdAttempt, holdSession, startAttempt } from '../game/day.js'
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
/**
 * @param {object} [props.resume] снимок незавершённой сессии (см. game/day.js).
 *   Задан — продолжаем ТУ ЖЕ попытку с накопленным счётом; не задан — новый
 *   заход с новой попыткой.
 */
/**
 * @param {boolean} [props.scored] идёт ли заход в зачёт. false — СВОБОДНАЯ
 *   ТРЕНИРОВКА: тело работает так же, но не записывается ничего — ни попытка,
 *   ни черновик, ни снимок, ни сданный день. Так бывает ровно в одном случае:
 *   прогресс участника не прочитался с сервера, и записать заход означало бы
 *   разойтись с общей таблицей, по которой считаются призы (см. index.jsx).
 */
export default function SessionScreen({ subscribe, videoRef = null, tier, day = 1, onExit, guest = false, onGuestValue = null, onGuestOffer = null, onGuestProgress = null, resume = null, onRestartCamera = null, scored = true, onRound = null }) {
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

  /**
   * ПРОДОЛЖЕНИЕ НАЧИНАЕТСЯ СО СЛЕДУЮЩЕГО КРУГА, а не с того, на котором вышли.
   * Круг, брошенный на середине, доигранным не считается и переигрывать его
   * человек не обязан: он уже потратил на него силы, а счёт за него в снимке.
   *
   * Индекс ищется по расписанию, а не считается арифметикой: длина круга
   * зависит от плана дня (разгрузка, восьмой круг на тяжёлых днях), и «плюс
   * четыре фазы» разошлось бы с расписанием на первом же таком дне.
   */
  const startIndexOf = (cycleLeftOn) => {
    const list = plan.current.phases
    const target = list.findIndex((p) => p.kind === 'strength' && (p.cycle ?? 0) + 1 === cycleLeftOn + 1)
    return target >= 0 ? target : 0
  }

  const [index, setIndex] = useState(() => (resume ? startIndexOf(resume.cycle) : 0))
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
  /** Открыт ли вопрос «сохранить или нет» — единственная дверь наружу. */
  const [exiting, setExiting] = useState(false)
  /** Номер захода: меняется на «начать заново» и пересоздаёт всё под собой. */
  const [runId, setRunId] = useState(0)
  const totals = useRef(
    resume?.totals
      ? { score: 0, strength: [], fights: [], hits: 0, spawned: 0, reactSum: 0, reactCount: 0, ...resume.totals }
      : { score: 0, strength: [], fights: [], hits: 0, spawned: 0, reactSum: 0, reactCount: 0 },
  )
  /**
   * СКОЛЬКО ЗАХОДОВ УШЛО НА ЭТОТ ДЕНЬ. Считается здесь и уезжает в зачёт дня:
   * для судейства призов «прошёл целиком за раз» и «дособирал третьим заходом»
   * — разные вещи, а по одной дате завершения их не различить.
   */
  const runs = useRef(resume ? Math.max(1, Number(resume.runs) || 1) + 1 : 1)
  const submitted = useRef(false)
  /**
   * КОГДА ЗАХОД НАЧАЛСЯ. Нужно ровно одному потребителю — экрану выхода из
   * пробной игры, который показывает человеку его время («47 мишеней · 6
   * минут»). Часы стенные (Date.now), а не performance: заход переживает уход
   * со страницы и возврат, а performance.now в фоне на телефоне идёт не так,
   * как идёт время у человека.
   */
  const открытоВ = useRef(Date.now())
  /** Что ответил зачёт дня. Ref, а не состояние: пишется один раз, до отрисовки. */
  const attemptRef = useRef(null)
  const startedAt = useRef(null)

  /**
   * НОМЕР ЗАХОДА — берётся на старте сессии, а не по её завершении.
   *
   * От него зависит трасса (см. attemptSeed). Прежде номер считался из
   * записанных попыток, а записывались они только после семи кругов целиком —
   * то есть никогда: в полевом логе у всех и всегда стояло `attempt:1`, и трасса
   * была одна и та же. Заход считается начатым в момент, когда человек в него
   * вошёл; брошенный он или доигранный — на трассу следующего влияет одинаково.
   *
   * Заодно здесь закрывается ЧУЖОЙ НЕЗАКРЫТЫЙ ЧЕРНОВИК: если прошлую сессию
   * убили из фона, её результат дописывается сейчас — до того, как начнётся эта.
   */
  const attemptNo = useRef(null)
  if (attemptNo.current == null) {
    if (resume) {
      /**
       * ПРОДОЛЖЕНИЕ НЕ ТРАТИТ ПОПЫТКУ. Это тот же заход, просто разорванный
       * во времени; засчитать за него вторую попытку значило бы наказать
       * человека за то, что он вышел из двадцатиминутной сессии.
       *
       * Черновик при этом НЕ закрывается: он и есть незакрытая попытка этого
       * захода, и закрыть его сейчас — записать половину сессии как отдельный
       * результат, а вторую половину как ещё один.
       */
      attemptNo.current = Math.max(1, Number(resume.attempt) || 1)
    } else if (scored) {
      closePending()
      attemptNo.current = startAttempt(level.id, plan.current.plan.day)
    } else {
      // тренировка без зачёта не трогает хранилище вовсе: ни счётчик заходов,
      // ни чужой черновик — её как будто не было
      attemptNo.current = 1
    }
  }

  const phases = plan.current.phases
  const phase = phases[Math.min(index, phases.length - 1)]

  /** КРУГ K ИЗ M для общей полосы прогресса — правило и счёт лежат в session.js. */
  const cycles = cyclesOf(phases)
  const cycle = cycleOf(phase)

  /**
   * ЧЕРНОВИК ПОПЫТКИ — обновляется по ходу сессии и переживает что угодно.
   *
   * Зачем вообще черновик, а не сразу попытка. Уход со страницы на iOS надёжно
   * виден только через visibilitychange, а он приходит и тогда, когда человек
   * свернул телефон на минуту и вернулся доигрывать. Записав на нём попытку, мы
   * закрыли бы заход, который продолжается, и потеряли бы всё остальное.
   * Черновик же переписывается сколько угодно раз и ничего не расходует.
   */
  const holdNow = () => {
    // без зачёта нечего и держать: записывать эту сессию мы не будем ни при
    // каком исходе, а снимок предложил бы человеку продолжить то, чего нет
    if (!scored) return
    holdAttempt(level.id, attemptStatsOf(totals.current, new Date().toISOString()), plan.current.plan.day)
    // и позиция — тем же движением: черновик отвечает «что записать, если не
    // вернётся», снимок — «куда вернуть, если вернётся»
    holdSession(
      level.id,
      { cycle, attempt: attemptNo.current, runs: runs.current, totals: totals.current },
      plan.current.plan.day,
    )
  }

  /**
   * ЗАКРЫТЬ ЗАХОД. Один раз и при любом исходе — кнопкой «Выйти», уходом со
   * страницы, перезапуском или дойдя до конца.
   *
   * ДЕНЬ СДАЁТСЯ ТОЛЬКО ПРИ complete. Это разные вещи, и до сих пор они были
   * склеены в одной строке: попытка записывалась там же, где засчитывался день,
   * то есть после семи кругов. До семи не доходил никто — и прогресс людей
   * оставался пустым, при сотне взятых мишеней за сессию. Теперь результат
   * человека сохраняется всегда, а «день сдан» по-прежнему значит «пройден
   * целиком»: на кону деньги, и этот смысл не меняется.
   *
   * Пустой заход попыткой не становится (см. closePending): открыл, посмотрел и
   * вышел — не повод сжечь одну из трёх попыток дня.
   */
  const closeAttempt = (why, { complete = false } = {}) => {
    if (submitted.current) return null
    submitted.current = true
    holdNow()
    const record = submitScore(totals.current.score)
    /**
     * ДЕНЬ ЧЕЛЛЕНДЖА ГОСТЮ НЕ ЗАСЧИТЫВАЕТСЯ. За зачётом стоят призы и общий
     * счёт участников, и вести его на устройстве, которое чистится вместе с
     * кэшем браузера, нельзя — это спор о деньгах на пустом месте. Сам
     * `completeDay` не трогаем: он про призы, и менять его смысл ради гостя
     * значило бы менять правила для всех.
     *
     * Попытка при этом записывается как у всех (`closePending` ниже): без неё
     * гость не увидел бы даже собственного результата за только что сыгранный
     * заход.
     */
    const marked = complete && !guest && scored ? completeDay(plan.current.plan.day, new Date(), runs.current) : null
    /**
     * ЗАХОД ЗАКОНЧЕН — ПРОДОЛЖАТЬ НЕЧЕГО. Снимок снимается при любом исходе, а
     * не только при полном прохождении: после выхода кнопкой человек получает
     * записанную попытку, и предлагать ему вдобавок «продолжить» ту же сессию
     * значило бы позволить дважды сдать один заход.
     *
     * Единственный путь, где снимок ОСТАЁТСЯ, — уход со страницы: там
     * `closeAttempt` не зовётся вовсе, работает только `holdNow`.
     */
    if (scored) dropSession()
    attemptRef.current = scored ? closePending() : null
    // попытка закрыта — отдаём набранное наружу: у гостя оно нигде не
    // сохранено, и буфер переезда собирается именно из этого
    if (guest) onGuestProgress?.()
    logEvent('session.end', {
      tier: level.id,
      day: plan.current.plan.day,
      // без зачёта — свободная тренировка: в базе от неё не останется ничего
      scored,
      // чем закончился заход и был ли он пройден целиком
      why,
      complete,
      // день сдан; перешёл ли человек дальше — уже другое событие
      dayDone: marked ? marked.dayDone : false,
      cycle,
      score: totals.current.score,
      best: record.best,
      isRecord: record.isRecord,
      // зачёт дня: пошла ли попытка в счёт и что она изменила
      recorded: attemptRef.current?.recorded ?? false,
      attempt: attemptRef.current?.attempt ?? attemptNo.current,
      attemptsLeft: attemptRef.current?.attemptsLeft ?? null,
      dayBest: attemptRef.current?.best ?? null,
      isBest: attemptRef.current?.isBest ?? false,
      dayTotal: attemptRef.current?.dayTotal ?? null,
    })
    return attemptRef.current
  }

  /** Начать тренировку заново тем же уровнем: счёт, круги и заход — с нуля. */
  const restart = () => {
    // прошлый заход закрывается своей попыткой, а не растворяется в новом
    closeAttempt('restart')
    totals.current = { score: 0, strength: [], fights: [], hits: 0, spawned: 0, reactSum: 0, reactCount: 0 }
    submitted.current = false
    attemptRef.current = null
    // «Начать заново» — это НОВЫЙ заход по этому дню, а не продолжение старого
    runs.current = 1
    attemptNo.current = startAttempt(level.id, plan.current.plan.day)
    setPaused(false)
    setIndex(0)
    setRunId((n) => n + 1)
    logEvent('session.restart', { tier: level.id, attempt: attemptNo.current })
  }

  /**
   * УХОД СО СТРАНИЦЫ. Черновик кладётся синхронно — до всякой сети: и pagehide,
   * и visibilitychange умеют быть последним, что вообще случится с вкладкой.
   * Оба слушателя, а не один: pagehide на iOS приходит не всегда, а
   * visibilitychange приходит.
   *
   * Черновик, а не попытка, — потому что свёрнутый на минуту телефон это не
   * конец захода. Настоящей попыткой черновик станет при выходе, при завершении
   * или при следующем открытии раздела, если приложение убьют из фона.
   */
  const holdRef = useRef(holdNow)
  holdRef.current = holdNow
  useEffect(() => {
    const save = () => { if (!submitted.current) holdRef.current() }
    const onVis = () => { if (document.visibilityState === 'hidden') save() }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  /**
   * ЧТО ЧЕЛОВЕК НАБРАЛ — наружу, вместе с выходом.
   *
   * Прежде `onExit` звался пустым, и снаружи о заходе не было известно ничего:
   * экран выхода из пробной игры показал бы нули вместо результата, то есть
   * сказал бы только что двигавшемуся человеку «ты ничего не сделал». Числа
   * берутся из тех же `totals`, что уходят в зачёт, — разойтись им нечем.
   *
   * Прежние вызывающие аргумент просто игнорируют.
   */
  const итог = () => ({
    score: totals.current.score,
    hits: totals.current.hits,
    seconds: Math.max(0, Math.round((Date.now() - открытоВ.current) / 1000)),
  })

  /** Выход из тренировки любым путём: попытка закрывается, потом уходим. */
  const exitSession = () => {
    const снимок = итог()
    closeAttempt('exit')
    onExit?.(снимок)
  }

  /**
   * ВЫЙТИ, НИЧЕГО НЕ ЗАПИСАВ. Зеркало `exitSession` и ровно его противоположность:
   * там черновик становится попыткой, здесь — стирается.
   *
   * `submitted` взводится первым делом. Без него черновик вернулся бы через
   * заднюю дверь: слушатели ухода со страницы зовут `holdNow`, и заход,
   * выброшенный человеком, воскрес бы при следующем открытии раздела как
   * незакрытая попытка.
   *
   * Снимок сессии снимается тем же движением: продолжать нечего, а предложить
   * «продолжить» выброшенный заход значило бы вернуть его вопреки решению.
   */
  const discardSession = () => {
    if (submitted.current) return
    const снимок = итог()
    submitted.current = true
    dropPending()
    dropSession()
    logEvent('session.discard', {
      tier: level.id,
      day: plan.current.plan.day,
      cycle,
      // что именно человек отказался записывать — по этому видно, бросают ли
      // заходы пустыми (взял не тот уровень) или уже набранными
      score: totals.current.score,
      guest,
    })
    /**
     * Итог отдаётся и здесь, хотя запись выброшена: человек отказался
     * СОХРАНЯТЬ заход, а не отказался его делать. Показать ему на выходе его
     * же цифры — не то же самое, что записать их себе.
     */
    onExit?.(снимок)
  }

  /**
   * ГОСТЬ ВЫБРАЛ АККАУНТ. Заход закрывается ОБЫЧНЫМ путём — тем же, что у
   * всех: только став попыткой, он попадёт в память раздела, оттуда в буфер
   * переезда и уже с ним в аккаунт. Форму открывает хозяин, он же считает
   * согласие.
   */
  const saveByRegistering = () => {
    exitSession()
    onGuestOffer?.('accepted')
  }

  /**
   * СПРОСИТЬ ПЕРЕД ВЫХОДОМ. Пауза ставится вместе с вопросом: человек в этот
   * момент стоит у телефона и читает, а не тренируется, — и списывать ему
   * время и мишени за чтение нельзя.
   */
  const askExit = () => {
    if (exiting) return
    setPaused(true)
    setExiting(true)
    // Гостю этот вопрос — предложение завести аккаунт, и считается он так же,
    // как остальные предложения сохранить.
    if (guest) onGuestOffer?.('shown')
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

  /**
   * Меню одинаково на всех фазах — поэтому и собирается одним куском. Вместе с
   * ним и крестик: они живут в одном ряду и появляться должны там же, где он.
   *
   * КРЕСТИК — КОРОТКИЙ ПУТЬ К ВЫХОДУ, А НЕ ЗАМЕНА МЕНЮ.
   *
   * Выйти посреди захода можно было только через «⋯» -> «Выйти», то есть двумя
   * нажатиями. Человек, которому позвонили на третьем круге, ищет выход не
   * листая меню — он ищет крестик, потому что крестик значит «выйти» везде.
   * Двух лишних действий в этот момент достаточно, чтобы вместо выхода закрыть
   * вкладку — а это потерянный заход и незакрытая попытка.
   *
   * Ведёт РОВНО туда же, куда пункт «Выйти» в меню: тот же `askExit`, тот же
   * вопрос «сохранить или нет», та же ветка для гостя. Никакой своей развилки
   * у него нет и быть не должно — иначе два выхода начнут расходиться.
   *
   * Слева, зеркально «⋯»: место под него в полосе круга уже было пустым
   * (padding 56px с обеих сторон), поэтому «КРУГ N из 7» не сдвигается.
   */
  const menu = (
    <>
      <button
        type="button"
        className="mt-exit__button"
        onClick={askExit}
        aria-label="Выйти из тренировки"
        data-testid="session-exit-button"
      >
        <span aria-hidden="true">✕</span>
      </button>
      <SessionMenu
        paused={paused}
        onPause={() => setPaused(true)}
        onResume={() => setPaused(false)}
        onRestart={restart}
        onExit={askExit}
        onReport={reportProblem}
      />
    </>
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
   * НАЧАЛСЯ БОЙ — ступень воронки пробной игры.
   *
   * Отдельным эффектом, а не внутри отрисовки: фаза «бой» держится минуту и
   * перерисовывается каждый кадр вместе с очками, и отметка из тела рендера
   * ушла бы шестьдесят раз в секунду. Дедуп воронки её бы съел, но платить за
   * это чтением sessionStorage на каждом кадре незачем.
   */
  useEffect(() => {
    if (phase.kind === 'fight') onRound?.('start')
    // намеренно только по смене фазы: onRound снаружи стабилен
  }, [index, phase.kind, onRound])

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
    // Круг доигран до конца — ступень воронки пробной игры (см. index.jsx).
    onRound?.('end')
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
    /**
     * ДЕНЬ ЗАСЧИТЫВАЕТСЯ ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ — на фазе done, то есть после
     * последнего круга. Не на старте, не в середине и не по выходу из меню: на
     * кону деньги, и «день сдан» обязано значить, что он пройден целиком.
     *
     * Указатель дня при этом НЕ ДВИГАЕТСЯ: сдача открывает дверь вперёд, а
     * входит в неё человек сам, кнопкой на выборе уровня. Иначе первая же
     * завершённая сессия сжигала бы оставшиеся попытки дня — и дошедший до
     * конца оказывался бы наказан за то, что дошёл.
     *
     * Сама попытка записывается тем же closeAttempt, что и при выходе на
     * середине: отличие полного прохождения ровно одно — complete.
     */
    closeAttempt('done', { complete: true })
    // Человек видит свой счёт — момент, ради которого стоит предложить аккаунт.
    // Решение о показе принимает хозяин раздела, здесь только факт и счёт.
    if (guest) onGuestValue?.(totals.current.score)
    return (
      <SessionResult
        result={{
          ...totals.current,
          level,
          hitPoints: obstaclePointsFor(level.id),
          day: plan.current.plan.day,
          days: 30,
          /**
           * ВЕРДИКТ ЗАЧЁТА — только тому, у кого зачёт есть. Гостю строка
           * «попытка 2 из 3» обещала бы ограничение, которого для него нет, а
           * на четвёртом заходе он прочёл бы «попытки кончились» — и это было
           * бы прямой неправдой: играть ему никто не мешает, просто его
           * результат никуда не идёт, пока нет аккаунта.
           */
          attempt: guest ? null : attemptRef.current,
          scored,
        }}
        onExit={exitSession}
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
  /**
   * ВОПРОС О ВЫХОДЕ ПЕРЕКРЫВАЕТ ВСЁ, включая паузу: пока человек его читает,
   * никакая фаза не должна оставаться на экране и получать кадры. Ниже финала
   * он не нужен — там заход уже закрыт, и спрашивать не о чем.
   */
  if (exiting) {
    return (
      <>
        <div className="mt-screen mt-screen--game mt-paused" data-testid="session-paused">
          <div className="mt-rest__veil" aria-hidden="true" />
        </div>
        <ExitChoice
          guest={guest}
          onSave={guest ? saveByRegistering : exitSession}
          onDiscard={() => {
            if (guest) onGuestOffer?.('closed')
            discardSession()
          }}
          onCancel={() => setExiting(false)}
        />
      </>
    )
  }

  if (paused) {
    return (
      <>
        <div className="mt-screen mt-screen--game mt-paused" data-testid="session-paused">
          <div className="mt-rest__veil" aria-hidden="true" />
          <div className="mt-paused__title">ПАУЗА</div>
          {/**
            * КНОПКИ, А НЕ ОТСЫЛКА К МЕНЮ. Экран говорил «открой меню и
            * продолжи» — то есть отправлял человека искать кнопку с тремя
            * точками в углу, стоя в двух метрах от телефона. Оба решения,
            * которые он здесь принимает, теперь названы прямо.
            */}
          <div className="mt-paused__actions">
            <button
              type="button"
              className="mt-menu__item mt-menu__item--main"
              onClick={() => setPaused(false)}
              data-testid="paused-resume"
            >
              Продолжить
            </button>
            <button
              type="button"
              className="mt-menu__item"
              onClick={askExit}
              data-testid="paused-exit"
            >
              Выйти
            </button>
          </div>
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
        // номер захода: вместе с днём, уровнем и уже переданным номером круга
        // он и составляет сид трассы (см. attemptSeed)
        attempt={attemptNo.current}
        onRestartCamera={onRestartCamera}
        onFinish={finishFight}
        onCancel={askExit}
      />
      {menu}
    </>
  )
}
