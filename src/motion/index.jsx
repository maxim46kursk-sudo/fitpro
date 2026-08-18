import { useCallback, useEffect, useRef, useState } from 'react'
import CameraView from './components/CameraView.jsx'
import CalibrationScreen from './screens/CalibrationScreen.jsx'
import WorkoutScreen from './screens/WorkoutScreen.jsx'
import GameScreen from './screens/GameScreen.jsx'
import StrengthBlock from './screens/StrengthBlock.jsx'
import SessionScreen from './screens/SessionScreen.jsx'
import { isStrength } from './game/strength.js'
import LevelSelectScreen from './screens/LevelSelectScreen.jsx'
import RoomScreen from './screens/RoomScreen.jsx'
import PersonalSetupScreen from './screens/PersonalSetupScreen.jsx'
import ResultScreen from './screens/ResultScreen.jsx'
import { DEFAULT_TIER } from './game/levels.js'
import { needsPersonalSetup } from './game/personal.js'
import { DAYS, currentDay, forcedDay, unlockFromUrl } from './game/challenge.js'
import { useCamera } from './pose/useCamera.js'
import { usePoseLandmarker } from './pose/usePoseLandmarker.js'
import { useLandscapeBlock } from './device/useOrientation.js'
import AudioToggle from './components/AudioToggle.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { isAudioEnabled, isAudioReady, unlockAudio } from './feedback/audio.js'
import DebugPanel from './debug/DebugPanel.jsx'
import { pushLive, snapshotOf } from './debug/diagnostics.js'
import { flush, isShipping, logEvent, logSessionId } from './debug/logShipper.js'
import { noteScreen } from './debug/errorReporter.js'
import { recordFrame } from './debug/recorder.js'
import { isCalibrating, subscribeCalibration } from './debug/calibrationMode.js'
import { openMotion } from './lifecycle.js'
import { configureLogShipper } from './debug/logShipper.js'
import './motion.css'

/**
 * ЕДИНСТВЕННЫЙ ЭКСПОРТ МОДУЛЯ НАРУЖУ. Всё, что нужно модулю, лежит внутри
 * src/motion/ — папку можно целиком скопировать в FitPro и подключить как
 * <MotionApp />.
 *
 * ПОЧЕМУ У НЕГО ВООБЩЕ ПОЯВИЛИСЬ ПРОПСЫ. До сих пор их не было ни одного:
 * настройка приходила из адресной строки, а закрыть модуль снаружи было нечем
 * вовсе. Пока Motion — всё приложение, это честно: адрес принадлежит ему, и
 * уходить некуда. Внутри FitPro адрес чужой (хозяин переписывает его на старте
 * четырьмя эффектами подряд), а уходить есть куда — и без onExit раздел стал бы
 * ловушкой, из которой человек выбирается только перезагрузкой.
 *
 * @param {object} props
 * @param {() => void} [props.onExit] выйти из раздела. Есть — Motion рисует
 *   кнопку выхода на входном экране; нет — модуль ведёт себя как раньше, то есть
 *   как отдельное приложение, из которого выходить некуда.
 * @param {number} [props.day] день челленджа. Задан — он и играется, и прогресс
 *   его не двигает: хозяин знает про своего человека больше, чем localStorage.
 * @param {string} [props.tier] уровень по умолчанию вместо DEFAULT_TIER.
 * @param {boolean} [props.paused] отпустить камеру, не размонтируя раздел.
 * @param {{endpoint: string, token: () => Promise<string|null>}} [props.log]
 *   куда слать журнал и как получить токен. Не задан — журнал ведёт себя как в
 *   своём проекте: модуль про хозяина ничего не знает (см. logShipper).
 */
export default function MotionApp({ onExit, day, tier, paused = false, log = null } = {}) {
  /**
   * Ключ перезапуска после падения. ErrorBoundary раньше предлагал
   * `location.reload()` — внутри FitPro это перезагрузка ВСЕГО приложения и
   * потеря его состояния, включая незавершённый обмен ссылки доступа. Упасть
   * должен модуль, а не хозяин, поэтому «начать заново» пересобирает поддерево
   * Motion и ничего больше.
   */
  const [attempt, setAttempt] = useState(0)

  return (
    <ErrorBoundary
      key={attempt}
      onRestart={() => setAttempt((n) => n + 1)}
      onExit={onExit}
    >
      <MotionAppInner
        key={attempt}
        onExit={onExit}
        log={log}
        dayOverride={day}
        tierOverride={tier}
        paused={paused}
      />
    </ErrorBoundary>
  )
}

/**
 * ИГРОВАЯ СЕССИЯ — ВХОД ПО УМОЛЧАНИЮ. Чистый адрес открывает продукт: камера,
 * выбор уровня, круги силы и боя, инструктор, день челленджа.
 *
 * Раньше без `?game=1` открывался простой подход, и человек, пришедший по
 * ссылке из оплаченного челленджа, попадал не в тренировку, а в отладочный
 * прошлый режим — без инструктора, без дня, без счёта. Ключ был страховкой на
 * время обкатки, но страховка, стоящая на входе, отменяет продукт.
 *
 * Простой подход никуда не делся — он живёт по `?plain=1`. Это по-прежнему
 * самый короткий способ посмотреть на счётчик повторов без всей обвязки, и
 * запасной путь, если сессия в поле сломается.
 */
function readGameMode() {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('plain') !== '1'
  } catch {
    // адреса нет вовсе (сервер, тест) — значит и отказываться не от чего
    return true
  }
}

/**
 * Отладочный вход в ОДИН силовой блок: `?block=barrier`.
 *
 * Полевая проверка блока не должна стоить целой сессии: чтобы посмотреть на
 * инструктора и счёт повторов, незачем проходить калибровку, выбор уровня и
 * трёхминутный раунд. Ключ ведёт сразу в тридцатисекундный блок названного
 * движения; неизвестное или неси́ловое имя игнорируется, и приложение
 * открывается как обычно.
 */
/**
 * СТАРЫЙ ЗАЧЁТНЫЙ РАУНД по ключу `?round=1`.
 *
 * Формат тренировки теперь — целая сессия из кругов силы и боя, и она же идёт
 * по умолчанию. Прежний трёхминутный раунд не удалён и не сломан: он остаётся
 * и для полевых замеров одного потока мишеней, и на случай, если сессия в поле
 * не полетит.
 */
function readRoundMode() {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('round') === '1'
  } catch {
    return false
  }
}

function readBlockMode() {
  try {
    const value = new URLSearchParams(globalThis.location?.search || '').get('block')
    return value && isStrength(value) ? value : null
  } catch {
    return null
  }
}

function MotionAppInner({ onExit, dayOverride, tierOverride, paused, log }) {
  // calibration | setup | levels | room | workout | result
  // выбор уровня и настройка под себя — только в игре
  const [screen, setScreen] = useState('calibration')
  const [gameMode] = useState(readGameMode)
  /** Силовой блок из адреса: он открывается сразу, минуя всё остальное. */
  const [blockMovement] = useState(readBlockMode)
  /** Прежний одиночный раунд — только по ключу; иначе идёт полная сессия. */
  const [roundOnly] = useState(readRoundMode)
  /** Уровень выбирает человек перед каждым раундом — автопрогрессии больше нет. */
  const [tier, setTier] = useState(() => tierOverride ?? DEFAULT_TIER)
  /**
   * ДЕНЬ ЧЕЛЛЕНДЖА. По умолчанию свой прогресс; `?day=N` открывает любой день и
   * прогресса НЕ трогает — посмотреть двадцатый должно быть можно, не сдав
   * девятнадцать предыдущих.
   *
   * Снимок берётся один раз: день меняется только по завершении сессии, а
   * пересчитывать его на каждом ререндере значило бы менять тренировку под
   * ногами у человека, который её уже начал.
   */
  /**
   * Код активации из адреса разбирается ДО первого дня: человек переходит по
   * ссылке от тренера, и челлендж обязан открыться в тот же заход, а не со
   * следующего запуска.
   */
  const [day, setDay] = useState(() => {
    unlockFromUrl()
    return dayOverride ?? forcedDay() ?? currentDay()
  })
  const [stats, setStats] = useState(null)
  const [runId, setRunId] = useState(0)
  /**
   * Откуда пришли в комнату — туда и вернёмся. Заходов теперь два: с выбора
   * уровня и с постановки в кадр, и высадить человека не там, откуда он
   * пришёл, значит потерять его: с постановки он вернулся бы на выбор уровня,
   * ни разу не встав в кадр.
   */
  const roomBack = useRef('levels')
  const openRoom = (from) => {
    roomBack.current = from
    setScreen('room')
  }
  const [needsTap, setNeedsTap] = useState(false)

  /**
   * Калибровка движений останавливает всё остальное: экраны размонтируются,
   * кадры до них не доходят, автозапуск не работает. Работают только камера,
   * скелет и запись сырых точек — ради них калибровку и открывают.
   */
  const [calibrating, setCalibratingState] = useState(isCalibrating)
  const calibratingRef = useRef(calibrating)
  calibratingRef.current = calibrating

  const videoRef = useRef(null)
  /** Текущий экран для слушателей, живущих дольше одного рендера. */
  const screenRef = useRef(screen)
  screenRef.current = screen
  const subscribersRef = useRef(new Set())

  /** Экраны подписываются на кадры сами — так ререндеры не идут через MotionApp. */
  const subscribe = useCallback((fn) => {
    subscribersRef.current.add(fn)
    return () => subscribersRef.current.delete(fn)
  }, [])

  const handleResult = useCallback((frame) => {
    // запись сырых точек для офлайн-разбора (tools/replay.mjs)
    recordFrame(frame)
    // на калибровке кадры дальше не идут: ни счёт, ни отсчёт, ни звуки
    if (calibratingRef.current) return
    for (const fn of subscribersRef.current) fn(frame)
  }, [])

  /**
   * КАМЕРА ОТПУСКАЕТСЯ ПО ПРОСЬБЕ ХОЗЯИНА. Раньше здесь стояло жёсткое
   * `enabled: true`: паузы не существовало, и единственным способом погасить
   * камеру было размонтирование. Внутри FitPro у камеры есть второй хозяин —
   * сканер штрихкода, — и без паузы одновременное открытие даёт CAMERA_FAILED.
   */
  const camera = useCamera({ enabled: !paused })
  const pose = usePoseLandmarker({
    videoRef,
    // Инференс нужен на всех экранах: с экрана результата подход
    // перезапускается тем же способом — по появлению человека в кадре.
    active: camera.status === 'ready',
    onResult: handleResult,
  })
  const landscapeBlocked = useLandscapeBlock()

  const cameraError = camera.errorCode
  const poseError = pose.status === 'error' ? pose.errorCode : null
  const blockingError = cameraError || poseError
  // Держим заставку до первого распознанного кадра: иначе экран калибровки
  // успевает соврать «отойди дальше», пока модель ещё прогревается.
  const booting =
    !blockingError && (camera.status !== 'ready' || pose.status !== 'ready' || !pose.warm)

  /**
   * ОТКРЫТИЕ РАЗДЕЛА — раньше всего остального.
   *
   * Здесь и перехват ошибок (до сих пор упавшее приложение видел только человек
   * с телефоном, и до разбора не доезжало ничего), и сброс всего, что пережило
   * прошлое закрытие. Обе половины лежат в одном месте — см. lifecycle.js:
   * порознь они расходятся молча.
   */
  useEffect(() => {
    // Приёмник настраивается до открытия: сама настройка и включает отправку
    // (см. configureLogShipper), а сброс состояния на открытии её уважает.
    const unconfigure = log ? configureLogShipper(log) : null
    const close = openMotion()
    return () => {
      close()
      unconfigure?.()
    }
    // журнал задаётся хозяином один раз на всё время жизни раздела
  }, [])

  /**
   * Экран запоминается для строки ошибки. Сообщение вроде «t is undefined» без
   * него не сужает поиск вообще — экранов восемь, и падать может любой.
   */
  useEffect(() => {
    noteScreen(calibrating ? 'calibration-mode' : blockMovement ? `block:${blockMovement}` : screen)
  }, [screen, calibrating, blockMovement])

  // Звук нельзя запустить без жеста пользователя, а кнопок в сценарии нет —
  // ловим первое касание где угодно и разблокируем аудио им.
  useEffect(() => {
    const unlock = () => {
      unlockAudio()
      setNeedsTap(!isAudioReady() && isAudioEnabled())
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    // iOS уводит контекст в interrupted, а потом в suspended посреди сессии —
    // в логе с телефона звук так и умер на середине и сам не вернулся. Касаний
    // в сценарии нет, поэтому поднимаем контекст сами, как только он упал.
    document.addEventListener('visibilitychange', unlock)
    unlock()
    const id = setInterval(unlock, 1000)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      document.removeEventListener('visibilitychange', unlock)
      clearInterval(id)
    }
  }, [])

  // Выход из калибровки возвращает модуль к началу: экраны монтируются заново,
  // поэтому состояние у них чистое, как при первом открытии приложения.
  useEffect(
    () =>
      subscribeCalibration((active) => {
        setCalibratingState(active)
        if (active) return
        setScreen('calibration')
        setStats(null)
        setRunId((n) => n + 1)
      }),
    [],
  )

  // Первая запись в лог: по ней сразу видно устройство и экран.
  useEffect(() => {
    logEvent('session.start', {
      ua: navigator.userAgent,
      screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      secure: window.isSecureContext,
      shipping: isShipping(),
    })
    // раз в 5 секунд — снимок состояния, чтобы в логе была динамика, а не
    // только события. Собирает его диагностическая шина: поля приходят с
    // разных экранов, и знает их та сторона, которая их хранит (см. snapshotOf)
    const id = setInterval(() => logEvent('snapshot', snapshotOf()), 5000)

    /**
     * УХОД СО СТРАНИЦЫ ВО ВРЕМЯ ТРЕНИРОВКИ — отклонение, которое объясняет
     * сразу многое: кадры не идут, инференс встаёт, круг проваливается. Человек
     * этого не рассказывает («я ничего не делал»), потому что для него это
     * звонок или уведомление, а не событие игры.
     *
     * Пишется только на тренировке: на выборе уровня и в комнате уход со
     * страницы — обычное дело и в логе ничего не объясняет.
     */
    const onVisibility = () => {
      if (screenRef.current !== 'workout') return
      const hidden = document.visibilityState === 'hidden'
      logEvent(hidden ? 'page.hidden' : 'page.visible', { screen: screenRef.current })
      // уходя, отдаём накопленное: вернуться человек может и через час
      if (hidden) flush()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [])

  // Счётчики инференса в диагностическую шину — экраны про них не знают.
  useEffect(() => {
    const id = setInterval(() => {
      const c = pose.fpsRef.current
      pushLive({
        fps: c.value,
        inferenceMs: c.inferenceMs,
        delegate: pose.delegate,
        thread: pose.thread,
        perf: {
          fpsMin: c.fpsMin,
          fpsMax: c.fpsMax,
          fpsAvg: c.fpsWindows ? c.fpsSum / c.fpsWindows : null,
          inferenceAvg: c.inferenceCount ? c.inferenceSum / c.inferenceCount : null,
          inferenceMax: c.inferenceMax,
          latencyMs: c.latencyMs,
          latencyMax: c.latencyMax,
          dropped: c.dropped,
          stalls: c.stalls,
          grabErrors: c.grabErrors,
          results: c.results,
          grabMode: c.grabMode,
          delegateSwitches: c.delegateSwitches,
        },
      })
    }, 250)
    return () => clearInterval(id)
  }, [pose.fpsRef, pose.delegate, pose.thread])

  // Параметры потока и список камер — по ним разбираем жалобы на «зум» и кроп.
  useEffect(() => {
    pushLive({ camera: camera.info, devices: camera.devices })
  }, [camera.info, camera.devices])

  /**
   * КОМНАТА ОТКРЫВАЕТСЯ БЕЗ КАМЕРЫ. Она читает только localStorage — ни кадров,
   * ни модели, ни разрешения на съёмку ей не нужно, — а до сих пор лежала за
   * двумя воротами сразу: за загрузкой модели и за постановкой в кадр. Человек
   * в поезде, захотевший взглянуть на свой счёт, восемь мегабайт ждал зря, а
   * человек с занятой камерой не попадал туда вовсе.
   *
   * Поэтому комната стоит ВЫШЕ заставки загрузки и выше сообщения об ошибке
   * камеры: они закрывают собой то, чему камера нужна, а комнате она не нужна.
   * Выйдешь из комнаты — увидишь их снова, и это правильно: тренироваться без
   * камеры всё-таки нельзя.
   */
  const inRoom = screen === 'room' && !calibrating && !blockMovement

  return (
    <div className="mt-root">
      <CameraView
        videoRef={videoRef}
        stream={camera.stream}
        latestRef={pose.latestRef}
        showSkeleton={!blockingError}
      />

      {blockingError && !inRoom && (
        <ErrorOverlay
          code={blockingError}
          detail={poseError ? pose.errorDetail : null}
          /**
           * Раньше ошибка модели чинилась `location.reload()`. Внутри FitPro это
           * перезагружает ВСЁ приложение: человек теряет своё состояние, а
           * незавершённый обмен ссылки доступа (токен уже вырезан из адреса и
           * живёт только в памяти) погибает вместе с ним. Пересобрать надо
           * движок инференса, а не страницу вокруг него.
           */
          onRetry={poseError ? pose.retry : camera.retry}
        />
      )}

      {!blockingError && booting && !inRoom && (
        <BootOverlay
          cameraReady={camera.status === 'ready'}
          modelReady={pose.status === 'ready'}
          progress={pose.progress}
          // пока грузится модель, смотреть свою статистику уже можно
          onRoom={gameMode ? () => openRoom('calibration') : null}
        />
      )}

      {inRoom && (
        <RoomScreen key={`room-${runId}`} day={day} onExit={() => setScreen(roomBack.current)} />
      )}

      {!blockingError && !booting && !calibrating && blockMovement && (
        <StrengthBlock
          key={`block-${runId}`}
          subscribe={subscribe}
          movement={blockMovement}
          tier={tier}
          onFinish={(result) => {
            setStats(result)
            setRunId((n) => n + 1)
          }}
        />
      )}

      {!blockingError && !booting && !calibrating && !blockMovement && screen === 'calibration' && (
        <CalibrationScreen
          subscribe={subscribe}
          /**
           * В ИГРЕ ЭТОТ ЭКРАН НЕ ОТСЧИТЫВАЕТ. Порядок стал такой: камера увидела
           * человека -> выбор уровня -> отсчёт -> сессия. Прежний отсчёт стоял
           * ДО выбора уровня и приводил человека не к работе, а к экрану с
           * кнопками: он собрался под «5, 4, 3, 2, 1» и остался стоять
           * выбирать. Отсчёт в игре теперь один, и он там, где ему место, —
           * перед самой работой (его ведёт сессия). На обычном подходе всё как
           * было: за этим экраном сразу работа, и отсчёт нужен.
           */
          instant={gameMode}
          // единственный вход в комнату, не требующий встать перед камерой
          onRoom={gameMode ? () => openRoom('calibration') : null}
          onStart={() => {
            setRunId((n) => n + 1)
            // Самый первый раз — «Настройка под себя»: игра должна узнать личную
            // амплитуду ДО челленджа, а не в первом же раунде на скорости.
            // Дальше человека сюда не перехватывают, кнопка есть на выборе уровня.
            if (!gameMode) return setScreen('workout')
            setScreen(needsPersonalSetup() ? 'setup' : 'levels')
          }}
        />
      )}

      {!blockingError && !booting && !calibrating && !blockMovement && screen === 'setup' && (
        <PersonalSetupScreen
          key={`setup-${runId}`}
          subscribe={subscribe}
          onDone={() => {
            setRunId((n) => n + 1)
            setScreen('levels')
          }}
          onExit={() => setScreen('levels')}
        />
      )}

      {!blockingError && !booting && !calibrating && !blockMovement && screen === 'levels' && (
        <LevelSelectScreen
          key={`levels-${runId}`}
          challengeDay={day}
          challengeDays={DAYS}
          // человек перешёл к следующему дню — сессия обязана собраться по
          // нему, иначе переход был бы обманом
          onAdvance={(next) => setDay(next)}
          onPick={(id) => {
            setTier(id)
            setRunId((n) => n + 1)
            setScreen('workout')
          }}
          onSetup={() => {
            setRunId((n) => n + 1)
            setScreen('setup')
          }}
          onRoom={() => openRoom('levels')}
          onExit={() => setScreen('calibration')}
        />
      )}

      {!blockingError && !booting && !calibrating && !blockMovement && screen === 'workout' && !gameMode && (
        <WorkoutScreen
          key={runId}
          subscribe={subscribe}
          blocked={landscapeBlocked}
          onFinish={(result) => {
            setStats(result)
            setScreen('result')
          }}
          onCancel={() => setScreen('calibration')}
        />
      )}

      {/* полная сессия: то, ради чего формат и собирался */}
      {!blockingError &&
        !booting &&
        !calibrating &&
        !blockMovement &&
        screen === 'workout' &&
        gameMode &&
        !roundOnly && (
          <SessionScreen
            key={`session-${runId}`}
            subscribe={subscribe}
            videoRef={videoRef}
            tier={tier}
            day={day}
            onExit={() => {
              setRunId((n) => n + 1)
              // день мог только что закрыться завершённой сессией — перечитываем
              // прогресс, но заданный снаружи день и отладочный ?day= уважаем:
              // они показывают то, что попросили, и прогресса не касаются
              setDay(dayOverride ?? forcedDay() ?? currentDay())
              setScreen('levels')
            }}
          />
        )}

      {!blockingError && !booting && !calibrating && !blockMovement && roundOnly && screen === 'workout' && gameMode && (
        /* videoRef — мишеням: они висят на теле, а тело живёт в кадре видео,
           и без размера этого кадра их не во что вписать */
        <GameScreen
          key={`game-${runId}`}
          subscribe={subscribe}
          tier={tier}
          videoRef={videoRef}
          blocked={landscapeBlocked}
          onFinish={(result) => {
            setStats(result)
            setScreen('result')
          }}
          onCancel={() => setScreen('calibration')}
        />
      )}

      {!blockingError && !booting && !calibrating && !blockMovement && screen === 'result' && (
        <ResultScreen
          key={`result-${runId}`}
          stats={stats}
          subscribe={subscribe}
          onRestart={() => {
            setRunId((n) => n + 1)
            setStats(null)
            // после игрового раунда — снова к выбору: попыток стало меньше, и
            // уровень человек выбирает заново
            setScreen(gameMode ? 'levels' : 'workout')
          }}
          onExit={() => {
            setStats(null)
            setScreen('calibration')
          }}
        />
      )}

      {/**
       * ВЫХОД ИЗ РАЗДЕЛА. Рисуется только когда хозяин дал onExit: без него
       * Motion остаётся отдельным приложением, из которого выходить некуда.
       *
       * ГДЕ ОН СТОИТ И ПОЧЕМУ ИМЕННО ТАМ. Левый верхний угол на всех остальных
       * экранах занят их собственным «назад», и второй кнопки там быть не может.
       * Свободен он ровно на входном экране — том, с которого назад ведёт уже
       * наружу, — и на двух слоях, которые входной экран собой закрывают:
       * заставке загрузки и ошибке камеры. Последнее и есть главное: у человека
       * с занятой камерой или без сети раздел иначе становится тупиком, из
       * которого он выбирается закрытием всего приложения.
       *
       * Посреди тренировки выхода в один тап нет намеренно: из сессии человек
       * возвращается своей цепочкой экранов, и случайно оборвать круг ладонью по
       * углу он не должен.
       */}
      {onExit && !inRoom && !calibrating && !blockMovement && (screen === 'calibration' || booting || blockingError) && (
        <button
          type="button"
          className="mt-corner mt-corner--left"
          onClick={onExit}
          aria-label="Выйти из тренировки"
          data-testid="motion-exit"
        >
          ✕
        </button>
      )}

      {landscapeBlocked && <RotateOverlay />}

      {!blockingError && !booting && !calibrating && needsTap && (
        <div className="mt-tap-hint" data-testid="tap-hint">
          Коснись экрана — включится звук
        </div>
      )}

      <AudioToggle />
      <DebugPanel onSelectCamera={camera.selectDevice} />
    </div>
  )
}

const ERROR_TEXT = {
  PERMISSION_DENIED: {
    title: 'Нужен доступ к камере',
    text: 'Разреши доступ к камере — без неё я не смогу считать повторы.',
    retry: 'Попробовать снова',
  },
  NO_CAMERA: {
    title: 'Камера не найдена',
    text: 'Не нашёл камеру на этом устройстве.',
    retry: 'Проверить ещё раз',
  },
  CAMERA_FAILED: {
    title: 'Камера не включилась',
    text: 'Похоже, камеру занимает другое приложение. Закрой его и попробуй снова.',
    retry: 'Попробовать снова',
  },
  INSECURE_CONTEXT: {
    title: 'Небезопасное соединение',
    text: 'Камера работает только по защищённому соединению (https) или на localhost. Открой страницу по https.',
    retry: null,
  },
  MODEL_NETWORK_FAILED: {
    title: 'Не скачалась модель',
    text: 'Нужен интернет: при первом запуске качается около 8 МБ. На медленной сети это может занять минуту — попробуй ещё раз или подключись к Wi-Fi.',
    retry: 'Попробовать снова',
  },
  MODEL_INIT_FAILED: {
    title: 'Модель не запустилась',
    text: 'Файлы скачались, но движок не смог их поднять на этом устройстве.',
    retry: 'Попробовать снова',
  },
  MODEL_LOAD_FAILED: {
    title: 'Не удалось загрузить модель',
    text: 'Проверь интернет и попробуй ещё раз.',
    retry: 'Попробовать снова',
  },
}

/**
 * Экран блокирующей ошибки.
 *
 * Кнопки без обработчика здесь больше нет. Раньше её запасным действием был
 * `location.reload()`, то есть модуль чинил себя перезагрузкой хозяина; теперь
 * нечего предложить — значит кнопки нет, и это честнее неработающей.
 */
function ErrorOverlay({ code, detail, onRetry }) {
  const info = ERROR_TEXT[code] || {
    title: 'Что-то пошло не так',
    text: 'Попробуй ещё раз или вернись позже.',
    retry: null,
  }

  return (
    <div className="mt-blocker mt-blocker--solid">
      <div className="mt-blocker__card">
        <div className="mt-blocker__title">{info.title}</div>
        <div className="mt-blocker__text">{info.text}</div>
        {detail && <div className="mt-blocker__detail">{detail}</div>}
        {info.retry && onRetry && (
          <button className="mt-button" onClick={onRetry}>
            {info.retry}
          </button>
        )}
      </div>
    </div>
  )
}

function BootOverlay({ cameraReady, modelReady, progress, onRoom }) {
  // при сжатом ответе общий размер неизвестен — показываем мегабайты без процентов
  const pct =
    progress?.total > 0 && progress.loaded < progress.total
      ? Math.round((progress.loaded / progress.total) * 100)
      : null
  const mb = (n) => (n / 1024 / 1024).toFixed(1)

  let text
  if (!cameraReady) text = 'Включаю камеру…'
  else if (modelReady) text = 'Настраиваю распознавание…'
  else if (progress?.stage === 'init') text = 'Запускаю движок…'
  else if (progress?.stage === 'model' || progress?.stage === 'wasm') {
    const what = progress.stage === 'wasm' ? 'Загружаю движок' : 'Загружаю модель'
    text =
      pct != null
        ? `${what} ${pct}% (${mb(progress.loaded)} из ${mb(progress.total)} МБ)`
        : `${what}… ${mb(progress.loaded)} МБ`
  } else text = 'Загружаю модель…'

  return (
    <div className="mt-blocker mt-blocker--solid">
      <div className="mt-blocker__card">
        <div className="mt-spinner" />
        <div className="mt-blocker__text">{text}</div>
        {pct != null && !modelReady && (
          <div className="mt-boot-bar">
            <div className="mt-boot-bar__fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="mt-blocker__detail">
          При первом запуске качается ~8 МБ, потом берётся из кэша
        </div>
        {/* Восемь мегабайт — это долго на плохой сети, а комната готова сразу:
            она читает хранилище, и ждать модель ей незачем */}
        {onRoom && (
          <button
            type="button"
            className="mt-boot__room"
            data-testid="boot-room"
            onClick={onRoom}
          >
            Моя комната
          </button>
        )}
      </div>
    </div>
  )
}

/** Ландшафт на телефоне: подход на паузе, пока не вернут вертикаль. */
function RotateOverlay() {
  return (
    <div className="mt-blocker mt-blocker--solid mt-blocker--rotate" data-testid="rotate-overlay">
      <div className="mt-blocker__card">
        <svg className="mt-rotate-icon" viewBox="0 0 64 64" aria-hidden="true">
          <rect x="14" y="4" width="36" height="56" rx="6" fill="none" strokeWidth="3" />
          <path d="M26 52h12" strokeWidth="3" strokeLinecap="round" />
          <path d="M52 26a22 22 0 0 1-8 14" fill="none" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="mt-blocker__title">Поверни телефон вертикально</div>
        <div className="mt-blocker__text">
          Подход на паузе. В горизонте не видно тебя целиком.
        </div>
      </div>
    </div>
  )
}
