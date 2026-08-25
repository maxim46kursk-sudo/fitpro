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
import SyncBanner from './components/SyncBanner.jsx'
import PersonalSetupScreen from './screens/PersonalSetupScreen.jsx'
import ResultScreen from './screens/ResultScreen.jsx'
import { DEFAULT_TIER } from './game/levels.js'
import { needsPersonalSetup } from './game/personal.js'
import { DAYS, currentDay, forcedDay, setStreamStart, streamPhase } from './game/challenge.js'
import ChallengeScreen from './screens/ChallengeScreen.jsx'
import StandingsScreen from './screens/StandingsScreen.jsx'
import {
  CHALLENGE_PRICE,
  acceptRules,
  buyTicket,
  freezeNorm,
  hasNorm,
  loadChallengeState,
  loadNutritionFacts,
  loadStandings,
} from '../challengeSeason.js'
import { useCamera } from './pose/useCamera.js'
import { usePoseLandmarker } from './pose/usePoseLandmarker.js'
import { useLandscapeBlock } from './device/useOrientation.js'
import AudioToggle from './components/AudioToggle.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { isAudioEnabled, isAudioReady, unlockAudio } from './feedback/audio.js'
import DebugPanel from './debug/DebugPanel.jsx'
import { noteRate, pushLive, snapshotOf } from './debug/diagnostics.js'
import { flush, isShipping, logEvent, logSessionId } from './debug/logShipper.js'
import { noteScreen } from './debug/errorReporter.js'
import { recordFrame } from './debug/recorder.js'
import { isCalibrating, subscribeCalibration } from './debug/calibrationMode.js'
import { openMotion } from './lifecycle.js'
import { configureLogShipper } from './debug/logShipper.js'
import { configureSync, hydrate, noteLoadFailed, onSyncHealth, push, resetSync, startSync, stopSync, syncHealth } from './sync.js'
import { KEYS, readRaw, useMemoryStorage, writeRaw } from './storage.js'
import { attemptsFor, challengeTotal, submitAttempt } from './game/day.js'
import { progress } from './game/challenge.js'
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
 * @param {{userId: string, load: Function, saveProgress: Function, saveAttempts: Function}} [props.sync]
 *   где хранится прогресс. Не задан — прогресс живёт только на устройстве, как
 *   до переезда.
 * @param {boolean} [props.guest] ГОСТЬ БЕЗ АККАУНТА. Играет всегда первый день,
 *   и челлендж ему не засчитывается: `completeDay` не зовётся вовсе, `{day,
 *   done[]}` не двигается. Всё остальное — попытки дня, черновик, рекорды —
 *   работает как у всех: без них он не смог бы даже доиграть заход.
 * @param {(section: string, score: number) => void} [props.onGuestValue] заход
 *   гостя закончился и он видит свой счёт — момент, ради которого стоит
 *   предложить аккаунт. Зовётся ОДИН раз за открытие раздела; решение о показе
 *   принимает хозяин.
 * @param {(payload: {day: number, tiers: object}) => void} [props.onGuestProgress]
 *   попытки гостя за день 1 — после каждой закрытой. Раздел живёт в своей папке
 *   и про буфер переезда ничего не знает: он лишь отдаёт наружу то, что набрал.
 * @param {{day: number, tiers: object}|null} [props.guestMotion] попытки,
 *   отложенные гостем до регистрации. Применяются один раз, при первом входе, и
 *   только если у аккаунта своего прогресса Motion ещё нет.
 * @param {() => void} [props.onGuestMotionApplied] применили — хозяин может
 *   убрать их из буфера.
 * @param {'challenge'|null} [props.startScreen] С КАКОГО ЭКРАНА ОТКРЫТЬ РАЗДЕЛ.
 *   Карточка челленджа на главной ведёт человека не «в Motion вообще», а к
 *   вполне определённому разговору — про поток, билет и номер участника. Всё
 *   остальное (камера, калибровка, уровни) на этом пути не нужно и не должно
 *   стоять между ним и ответом.
 */
export default function MotionApp({ onExit, day, tier, paused = false, log = null, sync = null, guest = false, onGuestValue = null, onGuestOffer = null, onGuestProgress = null, guestMotion = null, onGuestMotionApplied = null, startScreen = null, onFillNorm = null, onOpenDiary = null } = {}) {
  /**
   * ГОСТЬ ПИШЕТ В ПАМЯТЬ, А НЕ НА УСТРОЙСТВО — и решается это здесь, раньше
   * всего остального.
   *
   * Раньше всего потому, что день челленджа, попытки и пороги читаются
   * СИНХРОННО и прямо в ленивых инициализаторах `useState` внутри. Переключи мы
   * режим эффектом — первый же такой инициализатор успел бы прочитать чужой
   * прогресс с диска, и гость увидел бы его как свой.
   *
   * Вызов идемпотентен (см. storage.js): он лишь сверяет режим, а не заводит
   * память заново на каждый рендер.
   */
  useMemoryStorage(guest)

  /**
   * Ключ перезапуска после падения. ErrorBoundary раньше предлагал
   * `location.reload()` — внутри FitPro это перезагрузка ВСЕГО приложения и
   * потеря его состояния, включая незавершённый обмен ссылки доступа. Упасть
   * должен модуль, а не хозяин, поэтому «начать заново» пересобирает поддерево
   * Motion и ничего больше.
   */
  const [attempt, setAttempt] = useState(0)

  /**
   * ПРОГРЕСС ЧИТАЕТСЯ С СЕРВЕРА ДО ВХОДА В ИГРУ, и до этого момента раздел не
   * монтируется вовсе.
   *
   * Иначе никак: день челленджа, попытки и личные планки игра берёт СИНХРОННО и
   * прямо в ленивых инициализаторах useState. Смонтируй мы её раньше загрузки —
   * человек увидел бы первый день и нулевые рекорды, а через секунду всё
   * поменялось бы под ним; хуже того, начатая на пустом месте тренировка легла
   * бы поверх настоящего прогресса.
   *
   * Заставка короткая: это один запрос, а не восемь мегабайт модели.
   */
  const [ready, setReady] = useState(!sync)


  useEffect(() => {
    if (!sync) return undefined
    let alive = true
    const unconfigure = configureSync(sync)

    /**
     * ЗАСТАВКА ОБЯЗАНА УЙТИ. ЧТО БЫ НИ СЛУЧИЛОСЬ.
     *
     * Полевой отказ: человек играл гостем, зарегистрировался — и раздел
     * навсегда повис на «Загружаю прогресс…». Причина была структурной: у всей
     * цепочки не было ни одного `catch`, и любой выброс по дороге оставлял
     * `setReady` непозванным. С заставки не выйти ничем — ни кнопки, ни
     * сообщения, только закрыть вкладку.
     *
     * Теперь `ready` ставится в `finally`, то есть при любом исходе. Раздел
     * открывается на локальном кэше — та же деградация, что при
     * `sync.load-failed`, и она давно описана как правильная: кэш не пустой, а
     * прошлый, и играть по нему можно.
     */
    const finish = () => {
      if (!alive) return
      try {
        // следить за записями начинаем ПОСЛЕ загрузки: иначе её собственные
        // записи в кэш тут же поехали бы обратно на сервер
        startSync()
      } catch (error) {
        logEvent('sync.start-failed', { reason: String(error?.message || error).slice(0, 200) })
      }
      setReady(true)
    }

    hydrate(sync.userId)
      .catch((error) => {
        // загрузка не удалась — играем по локальному кэшу, а не запираем человека,
        // но человек об этом узнаёт: полоса висит, пока не починится
        logEvent('sync.hydrate-failed', { reason: String(error?.message || error).slice(0, 200) })
        noteLoadFailed()
      })
      .then(() => {
        if (!alive) return
        /**
         * ПОПЫТКИ ГОСТЯ — ПОСЛЕ ЗАГРУЗКИ, НО ДО НАБЛЮДЕНИЯ ЗА ЗАПИСЯМИ.
         *
         * После загрузки — иначе мы решали бы «пуст ли аккаунт» по ещё не
         * прочитанному прогрессу и подмешали бы гостевое поверх настоящего. До
         * `startSync` — наоборот, чтобы записанное тут же уехало на сервер, а
         * не осталось лежать на одном устройстве.
         *
         * ПОДМЕШИВАЕМ ТОЛЬКО В ЧИСТЫЙ АККАУНТ. Человек, входящий в старый, уже
         * прошёл сколько-то дней; его челлендж — предмет спора о призах, и
         * добавлять туда попытки, сыгранные до входа неизвестно кем на этом
         * телефоне, нельзя. Такие попытки просто отбрасываются.
         *
         * `completeDay` не зовётся ни при каких условиях: день сдаётся только
         * пройденной целиком сессией, и перенос этого смысла не меняет.
         */
        if (!guestMotion) return
        try {
          const пусто = challengeTotal() === 0 && progress().done.length === 0
          if (пусто) {
            for (const [tierId, list] of Object.entries(guestMotion.tiers ?? {})) {
              for (const attempt of Array.isArray(list) ? list : []) {
                submitAttempt(tierId, attempt, guestMotion.day ?? 1)
              }
            }
          }
          /**
           * Буфер отдаём ТОЛЬКО при удачном применении. Упало — оставляем как
           * есть: данные человека дороже чистоты хранилища, а разобраться по
           * журналу можно и потом. Второй заход попробует снова.
           */
          onGuestMotionApplied?.()
        } catch (error) {
          logEvent('sync.guest-apply-failed', {
            reason: String(error?.message || error).slice(0, 200),
          })
        }
      })
      .finally(finish)

    return () => {
      alive = false
      /**
       * Отдать накопленное на выходе: человек закрыл раздел сразу после круга,
       * и ждать следующего открытия его результату незачем.
       *
       * Хранилище отключается ПОСЛЕ отправки, а не рядом с ней. Отправка живёт
       * дольше одного кадра, и снятое сразу оно обрывало её на середине: попытки
       * уезжали, а прогресс — уже нет.
       */
      stopSync().finally(() => {
        resetSync()
        unconfigure()
      })
    }
  }, [sync])

  if (!ready) {
    return (
      <div className="mt-root">
        <div className="mt-blocker mt-blocker--solid">
          <div className="mt-blocker__card">
            <div className="mt-spinner" />
            <div className="mt-blocker__text">Загружаю прогресс…</div>
          </div>
        </div>
      </div>
    )
  }

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
        sync={sync}
        dayOverride={day}
        tierOverride={tier}
        paused={paused}
        guest={guest}
        onGuestValue={onGuestValue}
        onGuestOffer={onGuestOffer}
        onGuestProgress={onGuestProgress}
        guestMotion={guestMotion}
        onGuestMotionApplied={onGuestMotionApplied}
        startScreen={startScreen}
        onFillNorm={onFillNorm}
        onOpenDiary={onOpenDiary}
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

function MotionAppInner({ onExit, dayOverride, tierOverride, paused, log, sync, guest = false, onGuestValue = null, onGuestOffer = null, onGuestProgress = null, guestMotion = null, onGuestMotionApplied = null, startScreen = null, onFillNorm = null, onOpenDiary = null }) {
  // calibration | setup | levels | room | challenge | workout | result
  // выбор уровня и настройка под себя — только в игре
  const [screen, setScreen] = useState(startScreen === 'challenge' ? 'challenge' : 'calibration')
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
  const [day, setDay] = useState(() => {
    /**
     * У ГОСТЯ ВСЕГДА ПЕРВЫЙ ДЕНЬ. Челлендж — это тридцать дней подряд с
     * призами на кону, и продвижение по нему требует аккаунта: без него
     * прогресс живёт на одном телефоне и стирается очисткой кэша. Первый день
     * при этом отдан целиком — попробовать надо на настоящей тренировке, а не
     * на демонстрационной.
     */
    if (guest) return 1
    return dayOverride ?? forcedDay() ?? currentDay()
  })

  /**
   * ЗДОРОВЬЕ ОБМЕНА — то, что человек обязан видеть.
   *
   * `loaded: false` — прогресс с сервера не прочитан, играем по кэшу устройства.
   * `pushFailed` — результат не уехал наверх после всех повторов. Оба состояния
   * приходят из sync.js подпиской: отправка живёт дольше любого экрана и
   * ломается уже после того, как человек ушёл с результата.
   */
  const [health, setHealth] = useState(syncHealth)
  const [retrying, setRetrying] = useState(false)
  useEffect(() => onSyncHealth(setHealth), [])

  /**
   * ПОПРОБОВАТЬ СНОВА — единственное действие, доступное человеку самому.
   * Читаем прогресс заново и тем же движением отдаём то, что не уехало: обе
   * беды лечатся одной вернувшейся связью.
   */
  const retrySync = useCallback(async () => {
    if (!sync) return
    setRetrying(true)
    try {
      await hydrate(sync.userId)
    } catch (error) {
      logEvent('sync.hydrate-failed', { reason: String(error?.message || error).slice(0, 200) })
      noteLoadFailed()
    }
    setRetrying(false)
    push()
  }, [sync])

  /**
   * УЧАСТИЕ В ЖИВОМ ПОТОКЕ — один запрос на вход в раздел (src/challengeSeason.js).
   *
   * От него зависит ровно две вещи: открыты ли дни после пятого и видит ли
   * человек правила зачёта. Обе — вопросы к серверу, а не к устройству, поэтому
   * ответ приезжает сюда, а игра остаётся чистой и получает его параметром.
   *
   * ПОКА ОТВЕТА НЕТ — НЕ УЧАСТНИК. Пустить в челлендж «пока грузится» значит
   * пустить туда всех, у кого сеть медленнее экрана; обратный порядок (сперва
   * пять дней, потом открылось) человек видит как «загрузилось», а не как отказ.
   */
  const [membership, setMembership] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadChallengeState({ guest }).then((value) => {
      if (!alive) return
      setMembership(value)
      /**
       * ДЕНЬ УЧАСТНИКА СЧИТАЕТ КАЛЕНДАРЬ, и узнаём мы об этом только здесь:
       * дата старта живёт в сезоне, а сезон — на сервере. Отдаём её игре
       * (game/challenge.js) и тут же пересчитываем день, потому что первый
       * снимок брался до ответа и показывал прогресс одиночки.
       *
       * Заданный снаружи день и отладочный `?day=` по-прежнему сильнее: они
       * показывают то, что попросили. Сыграть чужой день это всё равно не
       * даёт — играбельность считает dayPlayable, и у участника она сходится
       * ровно на сегодняшнем дне потока.
       */
      const started = value?.entry ? value?.season?.starts_on ?? null : null
      setStreamStart(started)
      if (!guest) setDay(dayOverride ?? forcedDay() ?? currentDay())
    })
    return () => { alive = false }
  }, [guest, startScreen])
  const member = !!membership?.entry

  /**
   * ПИТАНИЕ УЧАСТНИКА. Сырьё за поток приезжает отдельным запросом и только
   * участнику: не участнику показывать нечего, а лишний запрос на каждый заход
   * в раздел он бы всё равно сделал.
   *
   * Тем же заходом просим базу заморозить норму: пора ли снимать второй слепок,
   * решает она сама по дате старта (sql/2026-08-25_challenge_nutrition.sql), —
   * приложение только даёт ей повод посмотреть.
   */
  const [nutrition, setNutrition] = useState(null)
  useEffect(() => {
    const seasonId = membership?.season?.id
    if (!seasonId || !membership?.entry) return undefined
    let alive = true
    freezeNorm(seasonId)
      .then(() => loadNutritionFacts(seasonId))
      .then((rows) => { if (alive) setNutrition(rows) })
    return () => { alive = false }
  }, [membership?.season?.id, membership?.entry])

  /**
   * ТАБЛИЦА ПОТОКА. Читается по требованию, а не вместе с разделом: строк в ней
   * участники × тридцать дней, и тащить их каждому, кто просто зашёл в
   * челлендж, незачем.
   */
  const [standingsRows, setStandingsRows] = useState(null)
  const [standingsBusy, setStandingsBusy] = useState(false)

  /**
   * МЕСТО В ПОТОКЕ КОМНАТА ПОКАЗЫВАЕТ СРАЗУ, поэтому таблица читается вместе с
   * разделом, а не только по кнопке. Прежний довод («строк участники × тридцать
   * дней, незачем тащить каждому») остаётся верным для того, кто просто зашёл
   * посмотреть на челлендж, — поэтому запрос уходит только у УЧАСТНИКА ИДУЩЕГО
   * потока: у него это и есть один из вопросов, ради которых он сюда пришёл.
   *
   * Прочитанное кладётся в тот же standingsRows, что и раньше, — экран таблицы
   * подхватывает готовое и не спрашивает второй раз.
   */
  useEffect(() => {
    const seasonId = membership?.season?.id
    if (!seasonId || !membership?.entry || standingsRows) return undefined
    if (streamPhase(membership?.season?.starts_on) !== 'running') return undefined
    let alive = true
    loadStandings(seasonId).then((rows) => { if (alive) setStandingsRows(rows) })
    return () => { alive = false }
  }, [membership?.season?.id, membership?.entry, membership?.season?.starts_on, standingsRows])

  const openStandings = async () => {
    setScreen('standings')
    const seasonId = membership?.season?.id
    if (!seasonId || standingsRows) return
    setStandingsBusy(true)
    const rows = await loadStandings(seasonId)
    setStandingsRows(rows)
    setStandingsBusy(false)
  }

  /**
   * ПОЗДРАВЛЕНИЕ С ПОКУПКОЙ — ОДИН РАЗ ЗА ПОТОК.
   *
   * Раньше «оплата прошла» было заголовком комнаты и висело все тридцать дней:
   * человек с идущим потоком каждый день читал новость про деньги вместо
   * своего дня. Теперь это полоса внутри комнаты, и живёт она до первого
   * закрытия — отметка пишется на устройство под id потока (storage.js).
   *
   * Состоянием, а не чтением хранилища по месту: полоса обязана исчезнуть
   * сразу по нажатию, а не после следующего открытия раздела.
   */
  const seasonId = membership?.season?.id ?? null
  const [greetSeen, setGreetSeen] = useState(() => readRaw(KEYS.challengeGreeted))
  const greet = !!membership?.entry && seasonId != null && String(greetSeen) !== String(seasonId)
  const markGreetSeen = useCallback(() => {
    if (seasonId == null) return
    writeRaw(KEYS.challengeGreeted, String(seasonId))
    setGreetSeen(String(seasonId))
  }, [seasonId])

  /** Перечитать участие после покупки: до неё не участник, после — участник. */
  const refreshMembership = useCallback(() => {
    loadChallengeState({ guest, force: true }).then(setMembership)
  }, [guest])

  const [stats, setStats] = useState(null)
  /**
   * Снимок незавершённой сессии, с которым стартует следующая. Живёт в
   * состоянии, а не читается сессией самостоятельно: решение продолжать
   * принимает человек на выборе уровня, и сессия обязана делать то, что ей
   * сказали, а не то, что она нашла в хранилище.
   */
  const [resume, setResume] = useState(null)
  /**
   * ПРЕДЛОЖЕНИЕ АККАУНТА — ОДИН РАЗ ЗА ОТКРЫТИЕ РАЗДЕЛА.
   *
   * Заход кончается двумя разными путями (итог одиночного раунда и итог полной
   * сессии), и оба ведут к экрану, где человек видит свой счёт. Оба зовут одно
   * и то же, а ref не даёт позвать дважды: человек, сыгравший три захода
   * подряд, получил бы три предложения — то есть помеху, которую закрывают не
   * глядя.
   */
  const offeredRef = useRef(false)
  /**
   * ОТДАТЬ НАБРАННОЕ НАРУЖУ. Зовётся после каждой закрытой попытки: гость может
   * сыграть три захода, а нажать «Создать аккаунт» — не выходя из раздела, и
   * отчёт только на размонтировании потерял бы всё сыгранное.
   */
  const reportGuestProgress = () => {
    if (!guest) return
    onGuestProgress?.(attemptsFor(1))
  }

  const offerGuestValue = (score) => {
    if (!guest || offeredRef.current) return
    offeredRef.current = true
    const value = Math.max(0, Math.round(Number(score) || 0))
    /**
     * ОТЛОЖЕННО, а не прямо сейчас. Оба итоговых экрана зовут это в момент
     * отрисовки — так же, как там уже закрывается попытка. Хозяин в ответ
     * ставит своё состояние, и синхронный вызов означал бы «меняем чужой
     * компонент, пока рисуется этот»: React такое ругает по делу.
     */
    setTimeout(() => onGuestValue?.('motion', value), 0)
  }
  const [runId, setRunId] = useState(0)

  /**
   * ЗАПУСК СЕССИИ — одной функцией на оба входа: выбор уровня и ячейка дня в
   * комнате. Продолжение незавершённой отличается от нового захода ровно
   * снимком, и разъедься эти два пути, из комнаты человек попадал бы в сессию с
   * нуля, теряя накопленное.
   */
  const startSession = useCallback((id, opts) => {
    setTier(id)
    setResume(opts?.resume ?? null)
    setRunId((n) => n + 1)
    setScreen('workout')
  }, [])
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
  /**
   * То же и для экрана челленджа. Открыть его можно с двух сторон: с границы
   * бесплатных дней и снаружи, прямо с главной (startScreen). Во втором случае
   * возвращаться внутри раздела некуда — человек шёл не в игру, — и крестик
   * закрывает раздел целиком.
   */
  const challengeBack = useRef(startScreen === 'challenge' ? null : 'levels')
  const openChallenge = (from) => {
    challengeBack.current = from
    setScreen('challenge')
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
  /**
   * КАМЕРА НЕ ВКЛЮЧАЕТСЯ РАДИ ЭКРАНА ЧЕЛЛЕНДЖА. С главной на него приходят
   * узнать, что за поток и почём место; спросить у человека разрешение на
   * съёмку в ответ на такой вопрос значит спросить не то и не вовремя.
   * Уйдёт с экрана в игру — камера поднимется как обычно.
   */
  const camera = useCamera({ enabled: !paused && screen !== 'challenge' && screen !== 'standings' })
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

  /**
   * ЗАСТАВКА НЕ ИМЕЕТ ПРАВА СНЕСТИ ИДУЩИЙ ЗАХОД.
   *
   * `booting` гасит все экраны, пока конвейер не поднялся, — и это правильно на
   * первом старте: экран калибровки иначе успевает соврать «отойди дальше»,
   * пока модель прогревается.
   *
   * Но у перезапуска камеры посреди захода (см. `restartPipeline` ниже) камера
   * на секунду уходит из `ready`, и по прежнему правилу это размонтировало бы
   * бой целиком: человек, у которого просто встала камера, терял бы заход
   * вместо того, чтобы дождаться её возвращения. Поэтому во время тренировки, и
   * только если конвейер УЖЕ был живым, заставка не показывается: боем в этот
   * момент управляет его собственный блокер, который честно говорит, что
   * камера остановилась, и даёт кнопки.
   *
   * Настоящая поломка камеры сюда не попадает — она приходит `blockingError`ом
   * и показывает свой экран, как и раньше.
   */
  const wasLiveRef = useRef(false)
  if (!blockingError && camera.status === 'ready' && pose.status === 'ready' && pose.warm) {
    wasLiveRef.current = true
  }
  const booting =
    !blockingError &&
    (camera.status !== 'ready' || pose.status !== 'ready' || !pose.warm) &&
    !(wasLiveRef.current && screen === 'workout')

  /**
   * ПОДНЯТЬ КОНВЕЙЕР ЗАНОВО — одной кнопкой и одним способом.
   *
   * Переподъём уже умеет `useCamera`: он заново спрашивает getUserMedia и
   * отдаёт свежий поток. Насос кадров при этом перезапускается сам —
   * `usePoseLandmarker` держит его на `active: camera.status === 'ready'`, и
   * уход камеры из `ready` снимает старый цикл, а возврат заводит новый.
   *
   * Движок распознавания НЕ пересобираем. Его собственный сторож уже вытаскивает
   * потерянный ответ воркера (STALL_TIMEOUT_MS), а полная пересборка стоит
   * секунд и выбросила бы прогрев — ради случая, который сторож и так закрывает.
   */
  const restartPipeline = useCallback(() => {
    camera.retry()
  }, [camera.retry])

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
      // тем же замером кормим счётчик темпа за бой (см. rateStats): своего
      // таймера он не заводит
      noteRate(c.value, c.latencyMs)
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
  /**
   * ЭКРАН ЧЕЛЛЕНДЖА ОТКРЫВАЕТСЯ БЕЗ КАМЕРЫ — по той же причине, что и
   * комната: он читает сезон и рассказывает про поток, а кадры ему не нужны
   * вовсе. Человек, пришедший с главной по карточке челленджа, спрашивает
   * «что это и почём», и заставлять его ради ответа дать доступ к камере и
   * дождаться восьми мегабайт модели значит не ответить.
   */
  /**
   * ЗАХОД В ЗАЧЁТ ЗАКРЫТ, ПОКА ПРОГРЕСС НЕ ПРОЧИТАН — но только участнику
   * сезона. Двадцать минут работы, которые потом не сойдутся с общей таблицей,
   * хуже честного отказа на входе: у него на кону деньги. Тренироваться при
   * этом можно — заход просто не записывается никуда.
   *
   * Одиночки это не касается: их прогресс и так живёт на устройстве, и
   * запрещать им играть по собственному кэшу не за что.
   */
  const challengeBlocked = member && !health.loaded

  const inChallenge = screen === 'challenge' && !calibrating && !blockMovement
  /** Таблица потока — такой же текстовый экран без камеры, как и челлендж. */
  const inStandings = screen === 'standings' && !calibrating && !blockMovement

  return (
    <div className="mt-root">
      <CameraView
        videoRef={videoRef}
        stream={camera.stream}
        latestRef={pose.latestRef}
        showSkeleton={!blockingError}
      />

      {blockingError && !inRoom && !inChallenge && !inStandings && (
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

      {!blockingError && booting && !inRoom && !inChallenge && !inStandings && (
        <BootOverlay
          cameraReady={camera.status === 'ready'}
          modelReady={pose.status === 'ready'}
          progress={pose.progress}
          // пока грузится модель, смотреть свою статистику уже можно
          onRoom={gameMode ? () => openRoom('calibration') : null}
        />
      )}

      {inRoom && (
        <RoomScreen
          key={`room-${runId}`}
          day={day}
          guest={guest}
          /** Результат не уехал наверх — комната обязана об этом сказать. */
          pushFailed={health.pushFailed}
          onResume={startSession}
          onExit={() => setScreen(roomBack.current)}
        />
      )}

      {inStandings && (
        <StandingsScreen
          rows={standingsRows}
          loading={standingsBusy}
          startsOn={membership?.season?.starts_on}
          title={membership?.season?.title ? `${membership.season.title} — таблица` : 'Таблица потока'}
          onExit={() => setScreen('challenge')}
        />
      )}

      {inChallenge && (
        <ChallengeScreen
          state={membership}
          loading={membership === undefined}
          fallbackPrice={CHALLENGE_PRICE}
          guest={guest}
          hasNorm={hasNorm(membership)}
          nutrition={nutrition}
          /**
           * НОРМУ ЗАПОЛНЯЮТ НЕ ЗДЕСЬ. Дневник питания живёт в хозяине, и раздел
           * своей формы для него не рисует — он лишь просит увести человека
           * туда, где норма уже считается.
           */
          onFillNorm={() => onFillNorm?.()}
          onStandings={openStandings}
          /** Сырьё таблицы — комната показывает место, не открывая таблицу. */
          standingsRows={standingsRows}
          /** Прогресс не прочитан — заход участника в зачёт не идёт. */
          syncBroken={challengeBlocked}
          greet={greet}
          onGreetSeen={markGreetSeen}
          /**
           * НАЧАТЬ ДЕНЬ ИЗ КОМНАТЫ. Ведёт на выбор уровня — тот самый экран, с
           * которого сессия и запускается: уровень человек выбирает каждый день
           * заново, и подставить его за него нельзя, разница между НОВИЧКОМ и
           * ПРОФИ — это очки за препятствие, то есть место в таблице.
           *
           * Камера до этой секунды не поднималась (она выключена на экранах
           * челленджа), поэтому дальше человек увидит обычную заставку
           * конвейера — ту же, что при входе в раздел.
           */
          onStartDay={() => setScreen('levels')}
          /**
           * ПРОДОЛЖИТЬ НЕЗАКРЫТЫЙ ЗАХОД — сразу в сессию, минуя выбор уровня:
           * уровень у начатой сессии уже есть, и спрашивать его заново значило
           * бы дать сменить его в середине дня.
           */
          onResume={startSession}
          onOpenDiary={() => onOpenDiary?.()}
          /**
           * ВСТУПЛЕНИЕ ОДНОЙ ДОРОГОЙ: сперва фиксируем согласие В БАЗЕ, и
           * только если оно записалось — открываем оплату. Обратный порядок
           * оставил бы оплаченный билет без ответа на «я не знал правил», то
           * есть ровно без того, ради чего согласие и берётся.
           */
          onJoin={async () => {
            // Набор ещё не открыт — говорим прямо и денег не трогаем: платёж,
            // которому не нашлось потока, вебхук примет и поднимет тревогу, но
            // человеку от этого не легче.
            if (!membership?.season?.id) {
              return { error: 'Набор в поток пока закрыт — откроем и объявим' }
            }
            const consent = await acceptRules(membership.season.id)
            if (consent?.error) return consent
            const result = await buyTicket()
            const fresh = await loadChallengeState({ guest, force: true })
            setMembership(fresh)
            return result
          }}
          onRefresh={refreshMembership}
          /**
           * ГОСТЮ — ТО ЖЕ ПРЕДЛОЖЕНИЕ АККАУНТА, ЧТО И ВЕЗДЕ. Раздел своей формы
           * регистрации не рисует и рисовать не должен: аккаунт заводит хозяин,
           * и предложение у него одно на всё приложение.
           */
          onCreateAccount={() => onGuestValue?.('challenge', 0)}
          onExit={() => (challengeBack.current ? setScreen(challengeBack.current) : onExit?.())}
        />
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
          /** Дата старта потока: с ней день идёт по календарю, без неё — по кнопке. */
          challengeStart={member ? membership?.season?.starts_on ?? null : null}
          /** Прогресс не прочитан — заход участника в зачёт не идёт (см. выше). */
          syncBroken={challengeBlocked}
          /**
           * УЧАСТНИК ЧЕЛЛЕНДЖА — тот, чьи заходы вообще идут в зачёт. Граница
           * проходит по аккаунту: у вошедшего человека попытка записывается,
           * день сдаётся и сумма растёт, у гостя не происходит ничего из
           * этого — его результат живёт в памяти вкладки и до челленджа
           * доберётся только вместе с регистрацией.
           *
           * Поэтому гостю не показываются ни счётчик попыток, ни правило трёх:
           * это правила зачёта, а он вне зачёта. Ограничивать его игру нечем —
           * и незачем: сам зачёт от этого не меняется, лимит по-прежнему
           * применяется при записи (`submitAttempt`), в том числе когда
           * сыгранное переезжает в новый аккаунт.
           */
          challengeMember={member}
          // человек перешёл к следующему дню — сессия обязана собраться по
          // нему, иначе переход был бы обманом
          onAdvance={(next) => setDay(next)}
          onPick={startSession}
          onSetup={() => {
            setRunId((n) => n + 1)
            setScreen('setup')
          }}
          onRoom={() => openRoom('levels')}
          onChallenge={() => openChallenge('levels')}
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
            guest={guest}
            /** Не прочитанный прогресс — тренировка без записи, а не заход. */
            scored={!challengeBlocked}
            onGuestValue={offerGuestValue}
            onGuestOffer={onGuestOffer}
            onGuestProgress={reportGuestProgress}
            resume={resume}
            onRestartCamera={restartPipeline}
            onExit={() => {
              setResume(null)
              setRunId((n) => n + 1)
              // день мог только что закрыться завершённой сессией — перечитываем
              // прогресс, но заданный снаружи день и отладочный ?day= уважаем:
              // они показывают то, что попросили, и прогресса не касаются.
              //
              // Здесь же ловится полночь: сессия, начатая в 23:50, идёт со
              // СВОИМ днём до конца — заход принадлежит тому дню, в котором
              // начался, — а на выходе номер пересчитывается, и участник видит
              // уже наступивший день потока. Ровно один раз, ровно на границе.
              if (!guest) setDay(dayOverride ?? forcedDay() ?? currentDay())
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
          onRestartCamera={restartPipeline}
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
          guest={guest}
          onGuestValue={offerGuestValue}
          onGuestProgress={reportGuestProgress}
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

      {/* Тумблер звука на правилах не нужен и мешает: он живёт в том же нижнем
          углу, что и главная кнопка, и накрывает её собой. Читают правила без
          звука — прятать его тут ничего не стоит. */}
      {!inChallenge && !inStandings && <AudioToggle />}

      {/**
        * ПОЛОСА ЧЕСТНОСТИ. Висит поверх любого экрана раздела и не уходит,
        * пока прогресс не прочитается: человек играет по кэшу устройства, и
        * знать об этом он должен всё время, а не одну секунду всплывашки.
        */}
      {sync && !health.loaded && (
        <SyncBanner kind="load" busy={retrying} onRetry={retrySync} />
      )}
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
