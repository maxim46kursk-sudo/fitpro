import { useEffect, useRef, useState } from 'react'
import SessionProgress from '../components/SessionProgress.jsx'
import { createSquatTracker } from '../exercises/squat.js'
import { getThresholds, subscribeThresholds } from '../exercises/thresholds.js'
import { REASON, REASON_TEXT } from '../pose/frameGate.js'
import {
  cueCountdown,
  cueFrameLost,
  cueMilestone,
  cueRep,
  cueShallow,
  cueStart,
} from '../feedback/audio.js'
import { createRound } from '../game/engine.js'
import { createScore } from '../game/score.js'
import { submitScore } from '../game/record.js'
import { DEFAULT_TIER, configForTier, obstaclePointsFor, tierById } from '../game/levels.js'
import { attemptSeed, nextAttempt } from '../game/day.js'
import { readStance } from '../game/dodge.js'
import { readUpper } from '../game/strike.js'
import { readVertical } from '../game/vertical.js'
import { readLegs } from '../game/legs.js'
import { readMoves } from '../game/moves.js'
import { createTargets, readBody } from '../game/targets.js'
import { readMaxes } from '../game/personal.js'
import { fitContain } from '../pose/viewport.js'
import { MODE as SHOW_MODE, createShowQueue, getShownPose } from '../pose/frameSync.js'
import {
  burstForObstacle,
  createStarfield,
  drawScene,
  updateParticles,
  updateStarfield,
} from '../game/space.js'
import { getLive, pushLive, rateStats, resetRate } from '../debug/diagnostics.js'
import { domCounts, heapMb, noteCounts, noteFrame, noteStage, resetStages, stageReport } from '../debug/stageMeter.js'
import { HITS_TIMED, noteHit } from '../debug/hitLatency.js'
import { createTransitionLog, logEvent } from '../debug/logShipper.js'
import { TARGETS_LIVE, publishTargets } from '../debug/liveTargets.js'
import { useWakeLock } from '../device/useWakeLock.js'

/** Если результаты из воркера вообще перестали приходить — тоже пауза. */
const STALE_RESULT_MS = 1000

/**
 * СКОЛЬКО ЖДАТЬ, ПРЕЖДЕ ЧЕМ ПРИЗНАТЬ, ЧТО КАМЕРА ВСТАЛА.
 *
 * Секунды без результата (STALE_RESULT_MS) — обычное дело: телефон ушёл думать
 * над кадром, человек заслонил себя рукой. Три секунды — уже не заминка:
 * распознавание отдаёт десять-двадцать поз в секунду, и три секунды тишины
 * означают, что кадры не идут вовсе.
 *
 * Полевая механика бага, ради которого это писалось: камера встала (звонок,
 * свёрнутый Safari, перегрев), `stale` стал вечным, а блокер показывал ПОСЛЕДНЮЮ
 * причину из frameGate — «отойди дальше, не видно стоп». Человек отходил,
 * отходил ещё, и ничего не менялось: проблема была не в нём, а карточка не
 * давала ни правды, ни кнопок.
 */
const STALE_RECOVER_MS = 3000
/**
 * Как часто экономный режим вправе отметиться в логе. Порог с гистерезисом всё
 * равно оставляет дрожание на границе, а лог должен показывать, ЧТО телефон не
 * тянет, а не считать колебания.
 */
const CHEAP_LOG_GAP_MS = 5000
/** Сколько барьер ещё дорисовывается после пролёта, уходя за нижний край. */
const TAIL_MS = 400
/**
 * Экономный режим отрисовки включается, когда кадр стабильно длиннее этого, и
 * выключается, когда снова короче второго порога. Два порога, а не один, —
 * чтобы режим не мигал на границе. Полевой тест на слабом андроиде: картинка
 * дёргалась, «будто вот-вот зависнет».
 */
const CHEAP_ON_MS = 26
const CHEAP_OFF_MS = 19
const EMPTY_POSE = { angle: null, hipX: null, shoulderX: null, shoulderWidth: null }

/**
 * Команда на весь экран. Человек стоит в двух метрах от телефона: читается
 * только очень крупный текст в два-три слова, и только глагол — что делать.
 * Сторона всегда та, что свободна от препятствия.
 */
function commandFor(obstacle) {
  if (!obstacle) return null
  if (obstacle.type === 'barrier') return 'ПРИСЯДЬ'

  // от стены и балки уходят в свободную сторону, астероид и кольцо, наоборот,
  // достают той же рукой или ногой — отсюда две разные подписи
  const free = obstacle.side === 'left' ? 'ВПРАВО' : 'ВЛЕВО'
  const own = obstacle.side === 'left' ? 'ЛЕВУЮ' : 'ПРАВУЮ'
  if (obstacle.type === 'wall') return `ШАГНИ ${free}`
  if (obstacle.type === 'beam') return `НАКЛОНИСЬ ${free}`
  // «БЕЙ» человек читает как «замахнись», а нужен вынос руки в камеру
  if (obstacle.type === 'strike') return `${own} ВПЕРЁД`
  // птицу достают той же рукой, что и астероид, но ВВЕРХ, а не вперёд
  if (obstacle.type === 'bird') return 'ДОСТАНЬ ПТИЦУ'
  if (obstacle.type === 'pit') return 'ПРЫГНИ'
  // у волны и уголька сторона — рабочая нога, как у кольца: «этой ногой назад»
  // и «этой пяткой к ягодице»
  if (obstacle.type === 'lunge') {
    return obstacle.side === 'left' ? 'ВЫПАД ЛЕВОЙ' : 'ВЫПАД ПРАВОЙ'
  }
  if (obstacle.type === 'heel') {
    return obstacle.side === 'left' ? 'ПЯТКА ЛЕВОЙ' : 'ПЯТКА ПРАВОЙ'
  }

  /**
   * Девять новых движений. Команда называет то, ЧТО ДЕЛАТЬ, а не то, как
   * называется движение: «ДЖЕК» человек в двух метрах от телефона поймёт только
   * после разминки, а «НОГИ ВРОЗЬ» — сразу.
   *
   * Сторона у всех трёх парных — по РАБОЧЕЙ НОГЕ, как у кольца, волны и
   * уголька: у махов, бокового выпада и скручивания это нога, которая работает,
   * а не свободная сторона, куда уходят от стены.
   */
  if (obstacle.type === 'bend') return 'НАКЛОНИСЬ К ПОЛУ'
  if (obstacle.type === 'jumpsquat') return 'ПРИСЕД С ПРЫЖКОМ'
  if (obstacle.type === 'jack') return 'ДЖЕК'
  if (obstacle.type === 'hop') return 'НОГИ ВРОЗЬ'
  if (obstacle.type === 'wings') return 'РУКИ В СТОРОНЫ'
  if (obstacle.type === 'clap') return 'ХЛОПОК'
  if (obstacle.type === 'legside') {
    return obstacle.side === 'left' ? 'МАХ ЛЕВОЙ НОГОЙ' : 'МАХ ПРАВОЙ НОГОЙ'
  }
  if (obstacle.type === 'sidelunge') {
    return obstacle.side === 'left' ? 'ВЫПАД ВЛЕВО' : 'ВЫПАД ВПРАВО'
  }
  // Сторона — по ПОДНИМАЕМОМУ КОЛЕНУ, а тянется к нему противоположная рука.
  // Команда про локоть, а не про кисть, намеренно: «локоть к колену» заставляет
  // скручивать корпус, а «рукой к колену» человек делает одним махом руки
  // (судит камера при этом по кисти — почему, расписано в moves.js).
  if (obstacle.type === 'twistknee') {
    return obstacle.side === 'left' ? 'ЛОКОТЬ К ЛЕВОМУ КОЛЕНУ' : 'ЛОКОТЬ К ПРАВОМУ КОЛЕНУ'
  }

  return obstacle.side === 'left' ? 'КОЛЕНО ЛЕВОЕ' : 'КОЛЕНО ПРАВОЕ'
}

/**
 * Почему движение не засчиталось — теми же крупными буквами, что и команда.
 * Полевой тест: на незачёт не происходило ровным счётом ничего, и человек не
 * понимал, промахнулся он или игра его не увидела. Это не наказание, а ответ:
 * что именно поправить в следующий раз.
 */
const MISS_TEXT = {
  'not-low': 'ГЛУБЖЕ!',
  'no-step': 'ШИРЕ ШАГ!',
  'no-lean': 'СИЛЬНЕЕ НАКЛОН!',
  stepped: 'НЕ СХОДИ С МЕСТА!',
  'no-strike': 'РУКУ ВПЕРЁД!',
  // рывок был, но человек бил на ходу вниз-вверх: удар делают стоя
  'strike-hips': 'ЗАМРИ — И БЕЙ!',
  'no-knee': 'КОЛЕНО ВЫШЕ!',
  'no-raise': 'РУКУ ВВЕРХ!',
  'no-jump': 'ПРЫГАЙ!',
  // выпад мелкий: нога не ушла назад или человек не опустился
  'no-lunge': 'ДАЛЬШЕ НАЗАД!',
  'no-heel': 'ПЯТКУ ВЫШЕ!',
  /**
   * Девять новых. Каждая подсказка называет ГЛАВНЫЙ признак движения — тот
   * самый, по которому судит автомат и которым нарисована полоска: человек
   * должен поправить именно его, а не гадать, что из четырёх условий не сошлось.
   */
  'no-bend': 'РУКИ НИЖЕ КОЛЕН!',
  'no-jumpsquat': 'ГЛУБЖЕ И ВЫПРЫГНИ!',
  'no-jack': 'НОГИ ШИРЕ, РУКИ ВВЕРХ!',
  'no-hop': 'НОГИ ШИРЕ!',
  'no-legside': 'НОГУ ДАЛЬШЕ ВБОК!',
  'no-sidelunge': 'ГЛУБЖЕ НА НОГУ!',
  'no-wings': 'РУКИ ШИРЕ!',
  'no-clap': 'ХЛОПНИ НАД ГОЛОВОЙ!',
  'no-twistknee': 'ЛОКОТЬ К КОЛЕНУ!',
  sitting: 'НЕ ПРИСЕДАЙ!',
  'no-stand': 'ВСТАНЬ МЕЖДУ ДВИЖЕНИЯМИ!',
  'no-person': 'ВСТАНЬ В КАДР!',
  /**
   * У мишени ловца причина промаха ровно одна и другой быть не может: круг
   * висел, часть тела в него не вошла. Ни «глубже», ни «шире» тут сказать
   * нечего — человек видел, куда тянуться, и не успел.
   */
  'no-catch': 'НЕ УСПЕЛ!',
}
/** Сколько держится подсказка о незачёте. */
const MISS_HINT_MS = 1400

/**
 * Название движения одним словом. С двух метров читается только короткое и
 * крупное: «ШАГ», а не «шаг в сторону».
 */
const MOVEMENT_NAME = {
  barrier: 'ПРИСЕД',
  wall: 'ШАГ',
  beam: 'НАКЛОН',
  strike: 'УДАР',
  knee: 'КОЛЕНО',
  lunge: 'ВЫПАД',
  // имя называет ДВИЖЕНИЕ, а не фигуру, которой оно рисовалось: «птица», «яма»
  // и «пятка» были именами препятствий, и человек честно не понимал, что от
  // него хотят. Плита фигурой больше не притворяется — и словам можно вернуть
  // прямой смысл
  heel: 'ЗАХЛЁСТ',
  bird: 'МАХ РУКОЙ',
  pit: 'ПРЫЖОК',
  // «НАКЛОН» уже занят балкой, «ВЫПАД» — волной: у новых движений имена свои,
  // иначе на разминке человек увидит знакомое слово и сделает знакомое движение
  bend: 'К ПОЛУ',
  jumpsquat: 'ПРИСЕД-ПРЫЖОК',
  jack: 'ЗВЕЗДА',
  hop: 'НОГИ ВРОЗЬ',
  legside: 'МАХ НОГОЙ',
  sidelunge: 'ВЫПАД ВБОК',
  wings: 'РУКИ В СТОРОНЫ',
  clap: 'ХЛОПОК ВВЕРХ',
  twistknee: 'ЛОКОТЬ-КОЛЕНО',
}

/**
 * Сид трассы. Считает его день челленджа — из даты, уровня и номера попытки:
 * у всех участников в этот день одна трасса, а вторая попытка не повторяет
 * первую. Через ?seed= сид можно навязать: это отладочная лазейка, чтобы гонять
 * одну и ту же трассу при разборе записей.
 */
/** Ключ из адреса: `?имя=1`. Ни один из них в обычной игре не включён. */
function urlFlag(name) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(name) === '1'
  } catch {
    return false
  }
}

/**
 * Счётчик кадров отрисовки по ключу `?fps=1`. Полевая мерка: на телефоне не
 * видно, сколько кадров рисуется на самом деле, а от этого зависит и решение
 * снимать 3D-слой, и вообще весь разговор о плавности.
 */
const wantsFpsMeter = () => urlFlag('fps')

/**
 * 3D-СЛОЙ ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН, включается ключом `?3d=1`.
 *
 * Стеклянные предметы сделаны и работают (см. space3d.js), но внешний вид игры
 * возвращён к прежнему 2D: решение о смене картинки принимается по полю, а не
 * по тому, что новое готово. Флаг оставлен, чтобы 3D можно было показать и
 * замерить на телефоне, ничего не пересобирая, — вместе с `?fps=1` это и есть
 * весь инструмент такого замера.
 */
const wants3d = () => urlFlag('3d')

/**
 * ПРЕЖНИЙ ВИД ЦЕЛИКОМ по ключу `?classic=1`: летящие фигуры, плиты, кольцо
 * приёмника — всё, что рисует space.js. Ключ не украшение: формат «человек —
 * герой» перестраивает экран целиком, и если он в поле не полетит, возврат
 * должен быть на один параметр в адресе, а не на один релиз.
 */
const wantsClassic = () => urlFlag('classic')

/**
 * ПРЕЖНЯЯ РОТАЦИЯ ДВИЖЕНИЙ по ключу `?moves=1`: восемнадцать движений, разминка,
 * детекторы, личные планки — весь боевой раунд, каким он был до ловца мишеней.
 *
 * Ключ той же породы, что и `?classic=1`, и по той же причине: боевой раунд
 * перестроен целиком, а решение о том, какой из двух режимов остаётся, должно
 * приниматься по полю. Не полетит ловец — возврат стоит один параметр в адресе.
 */
const wantsMoves = () => urlFlag('moves')

function roundSeed(tierId, attempt, cycle) {
  try {
    const forced = new URLSearchParams(globalThis.location?.search || '').get('seed')
    if (forced && Number.isFinite(Number(forced))) return Number(forced) >>> 0
  } catch {
    // нет location — берём сид дня
  }
  return attemptSeed(tierId, attempt, undefined, cycle)
}

/**
 * Набор движений раунда из адреса: `?round=1&types=bend,clap`.
 *
 * Отладочная лазейка, и нужна она ровно затем же, зачем `?seed=`: движений в
 * игре восемнадцать, и разминка по два повтора на каждое — это тридцать шесть
 * подходов ДО зачётной части. Проверить одно новое движение в поле после такой
 * разминки невозможно; с этим ключом раунд собирается из трёх-четырёх.
 *
 * @returns {string[]|null} null — ключа нет, играем всем набором
 */
function forcedTypes() {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('types')
    if (!raw) return null
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return list.length ? list : null
  } catch {
    // нет location — играем всем набором
    return null
  }
}

/**
 * Игровой экран: раннер от первого лица, механика A «Уклонение» (ТЗ, раздел 3).
 * Летишь сквозь космос, барьеры идут навстречу — под каждый надо присесть.
 *
 * Присед считает тот же самый трекер, что и на обычном подходе: логика счёта не
 * тронута ни на строку. Отсюда в движок раунда каждый кадр уходит только один
 * его вывод — сглаженный угол в колене. Судит по этому углу движок, экран лишь
 * раскладывает его события на очки, звук и картинку.
 *
 * Часы раунда ведёт этот экран и останавливает их ровно там же, где встаёт
 * таймер подхода: человек вышел из кадра, телефон в ландшафте, кадры перестали
 * приходить. Барьер не должен пролетать, пока человек идёт обратно в кадр.
 */
export default function GameScreen({
  subscribe,
  videoRef = null,
  /**
   * Как этот экран называется в снимке состояния. Бой живёт и сам по себе
   * (`?round=1`), и фазой сессии — в логе это разные места, и разбор поломки
   * начинается с вопроса «где человек был».
   */
  screenName = 'game',
  onFinish,
  onCancel,
  blocked = false,
  config,
  tier = DEFAULT_TIER,
  /**
   * Очки, накопленные до этого боя. Внутри раунда счёт свой, а человеку на
   * табло нужен общий по сессии: иначе после третьего боя счёт на экране
   * начинается заново, и вся арифметика финального листа перестаёт сходиться
   * с тем, что он видел по дороге.
   */
  scoreBase = 0,
  /**
   * Рекорд дня подаётся ОДИН РАЗ ЗА ТРЕНИРОВКУ. Одиночный раунд — сам себе
   * тренировка и подаёт его сам; бой внутри сессии — только её седьмая часть,
   * и семь записей в таблицу рекордов за одну сессию сделали бы её бессмыслицей.
   * Итог сессии подаёт тот, кто её ведёт.
   */
  submitsRecord = true,
  /**
   * Круг сессии для общей полосы прогресса. Ноль — раунд играется сам по себе
   * (`?round=1`), кругов нет, и полосы тоже.
   */
  cycle = 0,
  cycles = 0,
  /**
   * Номер захода за день. Подаёт сессия: она считает его на СТАРТЕ, а не по
   * записи результата, иначе брошенная тренировка не меняла бы трассу. Ноль —
   * раунд играется сам по себе, и номер он берёт сам.
   */
  attempt = 0,
  /**
   * ПОДНЯТЬ КАМЕРУ ЗАНОВО. Даёт хозяин раздела — тот же переподъём, что стоит
   * за кнопкой на экране ошибки камеры. Не задан (тесты, отладочные входы) —
   * кнопка перезапуска не рисуется, остальное работает как есть.
   */
  onRestartCamera = null,
  /**
   * УБРАТЬ УГЛОВОЙ КРЕСТИК. Нужен бою внутри сессии, и по двум причинам сразу.
   *
   * Он лежал поверх блока очков в левом верхнем углу — то есть закрывал собой
   * ровно то число, ради которого человек и работает. И он же дублировал выход
   * из меню «⋯», причём дублировал плохо: крестик обрывает тренировку молча и
   * без спроса, а меню сначала ставит паузу и спрашивает. Двух дверей с разным
   * поведением на одном экране быть не должно — человек нажмёт ту, что ближе.
   *
   * В одиночном раунде (`?round=1`) меню нет вовсе, и крестик там единственный
   * выход: убрать его значило бы запереть человека в раунде до конца.
   */
  hideCancel = false,
}) {
  const roundRef = useRef(null)
  const scoreRef = useRef(null)
  /**
   * Уровень раунда. Выбирает его человек на предыдущем экране — автопрогрессия
   * отменена. Сложность — это только темп: отрезок общей шкалы, по которому
   * раунд разгоняется от начала к концу. Позы, пороги и длительность одни и те
   * же на всех уровнях.
   */
  const levelRef = useRef(null)
  if (!levelRef.current) {
    const row = tierById(tier)
    levelRef.current = {
      id: row.id,
      name: row.name,
      obstaclePoints: row.obstaclePoints,
      /**
       * Номер попытки нужен и сиду, и логу: без него две попытки в один день
       * неразличимы. Сессия подаёт его сама (она считает заход на старте, а не
       * по записи результата); одиночный бой по ?round=1 сессии не имеет и
       * считает сам.
       */
      attempt: Math.max(1, Math.round(Number(attempt)) || 0) || nextAttempt(row.id),
      /** Номер круга: без него семь боёв одной сессии шли по одной трассе. */
      cycle: Math.max(0, Math.round(Number(cycle)) || 0),
    }
  }
  if (!roundRef.current) {
    const t = getThresholds()
    roundRef.current = createRound({
      downAngle: t.downAngle,
      upAngle: t.upAngle,
      // темп уровня; позы, пороги и длительность раунда от уровня не зависят
      ...configForTier(levelRef.current.id),
      // ловец мишеней по умолчанию, прежняя ротация движений — по ?moves=1
      mode: wantsMoves() ? 'moves' : 'catch',
      // сид раунда рождается здесь, а не в движке: движок обязан быть
      // воспроизводимым, и трасса дня — одна на всех
      seed: roundSeed(levelRef.current.id, levelRef.current.attempt, levelRef.current.cycle),
      ...config,
      // набор движений из адреса перебивает всё: это отладочный ключ, и если
      // человек его написал, он хочет раунд именно из этих движений
      ...(forcedTypes() ? { types: forcedTypes() } : {}),
    })
  }
  // цена препятствия — от уровня: счётчик очков про уровни не знает
  if (!scoreRef.current) {
    scoreRef.current = createScore({ hitPoints: obstaclePointsFor(levelRef.current.id) })
  }

  const totalMs = roundRef.current.config.durationMs

  const emptyHud = {
    score: 0,
    secondsLeft: Math.ceil(totalMs / 1000),
    mustStand: false,
    /** Крупная команда на время разминки. */
    command: null,
    /** Крупный ответ на незачёт: что поправить. */
    missHint: null,
    /** Разминка: какое движение учим, сколько зачётов подряд уже есть. */
    practice: true,
    movement: null,
    done: 0,
    needed: roundRef.current.config.practiceNeeded,
    step: 1,
    total: 0,
    /** «Молодец» и отсчёт до зачётной части. */
    ready: false,
    readyLeft: 0,
    /**
     * Экономный режим. В разметке он нужен ровно одному месту — полосе
     * прогресса, которая на слабом телефоне остаётся голым текстом. Флаг живёт
     * в HUD, а не отдельным состоянием, чтобы не заводить второй источник
     * перерисовок: режим переключается редко, и лишний рендер тут один за раз.
     */
    cheap: false,
  }

  const [hud, setHud] = useState(emptyHud)
  const [paused, setPaused] = useState(true)
  const [gotFrame, setGotFrame] = useState(false)
  /**
   * КАМЕРА ВСТАЛА — отдельно от «человека не видно», и это главное различие.
   * Первое чинится нами, второе человеком, и путать их на карточке значит
   * гонять его по комнате от проблемы, к которой он не имеет отношения.
   */
  const [cameraStalled, setCameraStalled] = useState(false)
  /** Идёт автоматическая попытка поднять камеру. */
  const [restarting, setRestarting] = useState(false)
  const [hitFlash, setHitFlash] = useState(0)
  /** Что показывает счётчик по ?fps=1: кадры отрисовки и текущий слой. */
  const [meter, setMeter] = useState(null)

  const canvasRef = useRef(null)
  /** Холст 3D-слоя: лежит ПОД игровым 2D-канвасом и над видео. */
  const glRef = useRef(null)
  /**
   * Последние точки позы — для мишеней. Их же читают детекторы, но там из них
   * считаются признаки, а слою мишеней нужны сами точки: мишень висит на плече
   * и на колене, а не на «выносе руки».
   */
  const landmarksRef = useRef(null)
  const targetsRef = useRef(null)
  if (!targetsRef.current) targetsRef.current = createTargets()
  /** Личные амплитуды: по ним кольцо приседа встаёт на свою глубину. */
  const personalRef = useRef(null)
  if (!personalRef.current) personalRef.current = readMaxes()
  const trackerRef = useRef(null)
  const starsRef = useRef(createStarfield())
  const particlesRef = useRef([])
  /** Барьеры для отрисовки: движок отдаёт только летящие, а нам нужен и хвост. */
  const drawnRef = useRef([])
  /** Что показать после незачёта и до какого момента. */
  const missHintRef = useRef(null)
  /** Скользящее среднее длины кадра и текущий режим отрисовки. */
  const frameMsRef = useRef(16)
  const cheapRef = useRef(false)
  const hudRef = useRef(emptyHud)
  const clockRef = useRef(0)
  const poseRef = useRef(EMPTY_POSE)
  /**
   * Время ЗАХВАТА кадра, по которому посчитана поза в poseRef. По нему ответ на
   * движение дожидается своего кадра на экране (см. showFeedback ниже).
   */
  const poseAtRef = useRef(0)
  /**
   * Часы пути попадания — только под отладкой (debug/hitLatency.js). Когда
   * результат этого кадра вернулся и сколько прошло с предыдущего: по второму
   * видно, на сколько «размазано» начало отсчёта — рука вошла в круг где-то
   * между двумя замерами.
   */
  const poseGotAtRef = useRef(0)
  const poseGapRef = useRef(0)
  /** Экономный режим боя пишется в лог переходами, а не каждым кадром. */
  const noteCheapRef = useRef(null)
  if (!noteCheapRef.current) noteCheapRef.current = createTransitionLog(CHEAP_LOG_GAP_MS)
  /** Имя экрана читается из кадрового обработчика — держим его в ref. */
  const screenNameRef = useRef(screenName)
  screenNameRef.current = screenName
  /**
   * Очередь визуального ответа. Судейство идёт по сырой свежей позе, а на
   * экране в синхронном режиме поза постарше — на задержку показа. Без очереди
   * вспышка зачёта появлялась раньше, чем показанная рука доходила до мишени.
   */
  const showQueueRef = useRef(null)
  if (!showQueueRef.current) showQueueRef.current = createShowQueue()

  const seenRef = useRef(false)
  const frameOkRef = useRef(false)
  /** Видно таз и плечи — этого хватает, чтобы судить шаг в сторону. */
  const torsoOkRef = useRef(false)
  /**
   * Режим уворота: пока летит стена и виден корпус, потеря ног у края кадра —
   * норма, а не повод останавливать раунд.
   */
  const dodgeGraceRef = useRef(false)
  const hasFrameRef = useRef(false)
  const reasonRef = useRef(REASON.NO_PERSON)
  const lastResultAtRef = useRef(performance.now())
  /** Попытка перезапуска за одну остановку — ровно одна, дальше руками. */
  const restartTriedRef = useRef(false)
  /** Остановку в журнал пишем один раз, а не каждый кадр. */
  const stallLoggedRef = useRef(false)
  const onRestartCameraRef = useRef(onRestartCamera)
  onRestartCameraRef.current = onRestartCamera
  const finishedRef = useRef(false)
  /**
   * ВРЕМЯ РЕАКЦИИ ЗА БОЙ: сумма и число зачётов, из которых её считать.
   *
   * Копится сумма, а не среднее: среднее, пересчитываемое на каждом зачёте,
   * теряет точность и не складывается с другими боями — а попытку человек
   * играет из семи-восьми боёв, и средняя нужна за всю сессию.
   *
   * Ради этого числа статистика попытки и заводилась. Очки за месяц могут
   * стоять на месте: человек берёт те же мишени и получает те же баллы. Реакция
   * при этом уезжает на двести миллисекунд — и это единственное место, где
   * видно, что он стал быстрее. Живут рядом с остальным состоянием раунда и
   * сбрасываются вместе с ним: новый бой — новый экран.
   */
  const reactSumRef = useRef(0)
  const reactCountRef = useRef(0)
  const onFinishRef = useRef(onFinish)
  const blockedRef = useRef(blocked)

  onFinishRef.current = onFinish
  blockedRef.current = blocked
  if (!trackerRef.current) trackerRef.current = createSquatTracker(getThresholds())

  useWakeLock(true)

  // калибровка может подвинуть рабочую глубину прямо во время раунда
  useEffect(
    () =>
      subscribeThresholds((t) => {
        trackerRef.current.setConfig(t)
        roundRef.current.setThresholds({ downAngle: t.downAngle, upAngle: t.upAngle })
      }),
    [],
  )

  const finishRound = () => {
    if (finishedRef.current) return
    finishedRef.current = true

    const s = scoreRef.current.getState()
    const r = roundRef.current.getState()
    const record = submitsRecord ? submitScore(s.total) : { best: s.total, isRecord: false }
    const lvl = levelRef.current
    logEvent('game.end', {
      score: s.total,
      cleared: r.cleared,
      missed: r.missed,
      best: s.bestStreak,
      spawned: r.spawned,
      record: record.isRecord ? 'new' : record.best,
      // на каком уровне и какой попыткой играли: без этих полей доля зачищенных
      // в логе ни с чем не сравнима
      tier: lvl.id,
      attempt: lvl.attempt,
      cycle: lvl.cycle,
      points: lvl.obstaclePoints,
      /**
       * ПРИБОРЫ ТЕЛЕФОНА ЗА ЭТОТ БОЙ. Без них доля зачищенных ни о чём не
       * говорит: по записям 20 поз/с дают 88% зачётов, а 8 поз/с — 68%, при том
       * что все промахи «не успел». Раньше эти числа приходилось сшивать из
       * снимков состояния вручную, раскладывая их по времени между боями.
       */
      ...rateStats(),
      /**
       * РАЗБОР ПО СТАДИЯМ И ПО МИНУТАМ. Ради одного вопроса: какая именно стадия
       * растёт по ходу сессии. Средняя за бой его прячет — нужен наклон.
       */
      stages: stageReport(),
    })
    // трезвучие конца играет ResultScreen сразу при появлении — здесь его
    // дублировать нельзя, иначе оно звучит дважды подряд
    onFinishRef.current?.({
      ...trackerRef.current.getStats(),
      seconds: Math.round(r.elapsedMs / 1000),
      score: s.total,
      cleared: r.cleared,
      missed: r.missed,
      obstacles: r.spawned,
      bestStreak: s.bestStreak,
      best: record.best,
      isRecord: record.isRecord,
      /**
       * Реакция суммой и числом, а не средним: сессия складывает восемь боёв,
       * и средние по ним сложить нельзя — бой с тремя зачётами весил бы
       * столько же, сколько бой с восемьюдесятью.
       */
      reactSum: reactSumRef.current,
      reactCount: reactCountRef.current,
      /** Зачёт дня считает и сохраняет экран результата — ему нужны эти три. */
      tier: lvl.id,
      tierName: lvl.name,
      attempt: lvl.attempt,
    })
  }

  /** Отсчёт «3-2-1» озвучиваем теми же сигналами, что и запуск подхода. */
  const lastCountRef = useRef(null)

  /**
   * ОТВЕТ НА ДВИЖЕНИЕ — КОГДА ДО НЕГО ДОЕХАЛА КАРТИНКА.
   *
   * Судят сырую свежую позу, а на экране в синхронном режиме поза постарше — на
   * задержку показа (pose/frameSync.js). Вспышка зачёта и «+очки» появлялись
   * раньше, чем показанная рука доходила до мишени: человек видел ответ по
   * пустому месту. Здесь картинка ответа ждёт свой кадр — метка события — время
   * захвата той позы, по которой судили.
   *
   * ЖДЁТ ТОЛЬКО КАРТИНКА. Очки, статистика попытки, реакция и лог считаются в
   * момент судейства: задержи их — и reactMs перестал бы сравниваться между
   * телефонами, в него вошла бы задержка чужого экрана. Звук пока тоже идёт
   * сразу — проверяем на телефоне, режет ли слух опережение.
   *
   * В живом режиме очередь пропускает всё насквозь: там показ и судейство идут
   * по одной позе, и ждать нечего.
   */
  const showFeedback = (run) =>
    showQueueRef.current.push(poseAtRef.current, run, getShownPose(), performance.now())

  // --- события раунда: очки, звук, картинка ---
  const handleEventsRef = useRef(null)
  handleEventsRef.current = (events) => {
    for (const ev of events) {
      const canvas = canvasRef.current
      const w = canvas?.clientWidth || 0
      const h = canvas?.clientHeight || 0

      if (ev.type === 'obstacle.spawn') {
        drawnRef.current.push(ev.obstacle)
      } else if (ev.type === 'obstacle.clear') {
        // в разминке движение подтверждается тем же зелёным и звуком, но очки
        // за него не идут: это проба, а не результат
        const res = ev.practice ? null : scoreRef.current.hit()
        /**
         * Реакция копится только с зачётных мишеней. Разминочные идут по
         * другим правилам — человек их разучивает, а не ловит, — и мешать их
         * с боевыми значило бы мерить не то.
         */
        if (!ev.practice && Number.isFinite(ev.timing)) {
          reactSumRef.current += ev.timing
          reactCountRef.current += 1
        }
        /**
         * ЧАСЫ ПУТИ ПОПАДАНИЯ. Снимаются ЗДЕСЬ, а не внутри показа, и это не
         * стилистика: показ отложен на кадр-другой, а к тому времени ссылки
         * `poseAtRef`/`poseGotAtRef` уже указывают на СЛЕДУЮЩИЙ кадр — та же
         * запись получалась с чужим началом отсчёта и отрицательным судейством.
         */
        const часы = HITS_TIMED ? {
          poseAt: poseAtRef.current,
          gotAt: poseGotAtRef.current,
          judgeAt: performance.now(),
          gapMs: poseGapRef.current,
        } : null
        showFeedback(() => {
          if (часы) noteHit({ cycle, ...часы, shownAt: performance.now(), mode: getShownPose().mode })
          if (w && h) particlesRef.current.push(...burstForObstacle(w, h, ev.obstacle.id))
          // мишень взрывается ровно там, где висела: ответ приходит в ту точку,
          // куда человек тянулся. Судил при этом движок — слой мишеней только
          // показывает его решение
          targetsRef.current.clear(ev.obstacle.id, {
            points: res?.points ?? 0,
            cheap: cheapRef.current,
          })
          if (res) setHitFlash((n) => n + 1)
        })
        cueRep()
        // каждый пятый зачёт подряд — тот же акцент, что и в подходе. Очков он
        // не прибавляет: серия теперь только украшение (см. score.js)
        if (res?.milestone) cueMilestone()
        logEvent('game.clear', {
          id: ev.obstacle.id,
          kind: ev.obstacle.type,
          side: ev.side,
          /**
           * ЛОВЕЦ: какая часть тела была названа и с какого расстояния мишень
           * начиналась, в ширинах плеч. Без этой пары жалоба «мишень появилась
           * рядом со мной» по логу недоказуема — в нём не было ни части тела,
           * ни дистанции, и спорить приходилось на память.
           */
          part: ev.part ?? undefined,
          spawnGapK: ev.gap ?? undefined,
          // насколько близко часть подошла к центру: 1 — ровно по краю круга
          nearK: ev.near ?? undefined,
          // смещение со знаком в ширинах плеч: по нему сверяются обе стороны
          dodge: fmtDodge(ev.dodge),
          // с каким запасом успел: минус — раньше пролёта, плюс — позже
          timing: ev.timing,
          // фактические замеры движения — по ним калибруются пороги
          strikeMs: ev.strikeMs,
          elbow: ev.strikeFrom == null ? undefined : `${ev.strikeFrom}->${ev.strikeTo}`,
          // до чего дотянул вынос руки за окно: по нему и калибруем порог
          peak: ev.strikePeak ?? undefined,
          // насколько гулял таз и когда пришёл удар: по ним разводятся причины
          hip: ev.hip ?? undefined,
          punchAt: ev.punchAt ?? undefined,
          // птица: до какой высоты дотянулась рука; яма: был ли прыжок и когда
          raise: ev.raise ?? undefined,
          jumped: ev.jumped ?? undefined,
          jumpAt: ev.jumpAt ?? undefined,
          // волна и уголёк: оба признака выпада и высота стопы у захлёста, плюс
          // момент движения — по нему и снимутся настоящие окна зачёта
          back: ev.lungeBack ?? undefined,
          drop: ev.lungeDrop ?? undefined,
          heel: ev.heelLift ?? undefined,
          // три страховки захлёста: по ним видно, какая из них его зарезала
          heelKnee: ev.heelKnee ?? undefined,
          heelBack: ev.heelBack ?? undefined,
          heelDrop: ev.heelDrop ?? undefined,
          // девять новых: их собственные признаки за окно, по именам условий —
          // у скручивания это колено и встречная рука. Без них у девяти в логе
          // была одна планка, и промах не разбирался вовсе
          ...(ev.peaks ?? {}),
          moveAt: ev.moveAt ?? undefined,
          // сколько условие продержалось подряд и что мешало чаще прочих:
          // у движений с несколькими условиями без этой пары промах неразбираем
          held: ev.held ?? undefined,
          block: ev.block ?? undefined,
          legAt: ev.legAt ?? undefined,
          // по какой планке судили и что человек выдал: планка у каждого своя,
          // и без неё «не хватило 0.4» в логе ничего не значит
          bar: ev.bar ?? undefined,
          amp: ev.amp ?? undefined,
          lift: ev.lift == null ? undefined : Number(ev.lift.toFixed(2)),
          angle: ev.angle == null ? null : Math.round(ev.angle),
          practice: ev.practice || undefined,
          total: res?.total,
        })
      } else if (ev.type === 'obstacle.miss') {
        // промах не наказывается — ни жизней, ни счётчика неудач. Но он обязан
        // быть слышен и виден: молчание человек читает как «игра меня не
        // заметила», а не как «движение не засчитано»
        if (!ev.practice) scoreRef.current.miss()
        showFeedback(() => {
          targetsRef.current.miss(ev.obstacle.id)
          // подсказка живёт от МОМЕНТА ПОКАЗА, а не судейства: иначе в
          // синхронном режиме она успевала бы состариться, ещё не появившись
          missHintRef.current = {
            text: MISS_TEXT[ev.reason] || 'НЕ ЗАСЧИТАНО',
            until: performance.now() + MISS_HINT_MS,
          }
        })
        cueShallow()
        logEvent('game.miss', {
          id: ev.obstacle.id,
          kind: ev.obstacle.type,
          side: ev.side,
          // ловец: часть тела и дистанция до неё в момент появления мишени —
          // без них «мишень была рядом» проверить по логу нечем
          part: ev.part ?? undefined,
          spawnGapK: ev.gap ?? undefined,
          /**
           * НАСКОЛЬКО БЛИЗКО ЧАСТЬ ПОДХОДИЛА, в радиусах: 1 — ровно по краю
           * круга. Главное число промаха ловца: без него две совершенно разные
           * беды выглядят в логе одинаково — «не дотянулся» (2.4, виноват темп
           * или зона) и «был внутри, а зачёта нет» (0.8, виноват судья).
           */
          nearK: ev.near ?? undefined,
          dodge: fmtDodge(ev.dodge),
          // для балки: насколько уехал таз — по нему видно шаг вместо наклона
          drift: fmtDodge(ev.drift),
          strikeMs: ev.strikeMs,
          elbow: ev.strikeFrom == null ? undefined : `${ev.strikeFrom}->${ev.strikeTo}`,
          // до чего дотянул вынос руки за окно: по нему и калибруем порог
          peak: ev.strikePeak ?? undefined,
          // рывок был, но таз гулял — по этим двум числам видно, что срезало
          hip: ev.hip ?? undefined,
          punchAt: ev.punchAt ?? undefined,
          // по этим двум видно, чего не хватило птице и была ли попытка прыжка
          raise: ev.raise ?? undefined,
          jumped: ev.jumped ?? undefined,
          jumpAt: ev.jumpAt ?? undefined,
          // а по этим — чего не хватило выпаду: ноги назад или просадки таза.
          // Без пары чисел оба случая в логе выглядят одинаково
          back: ev.lungeBack ?? undefined,
          drop: ev.lungeDrop ?? undefined,
          heel: ev.heelLift ?? undefined,
          // три страховки захлёста: по ним видно, какая из них его зарезала
          heelKnee: ev.heelKnee ?? undefined,
          heelBack: ev.heelBack ?? undefined,
          heelDrop: ev.heelDrop ?? undefined,
          // девять новых: их собственные признаки за окно, по именам условий.
          // Складка 14 августа дала 2 зачёта из 13, и назвать причину было
          // нечем: в логе не было ни колена, ни положения рук
          ...(ev.peaks ?? {}),
          moveAt: ev.moveAt ?? undefined,
          // сколько условие продержалось подряд и что мешало чаще прочих:
          // у движений с несколькими условиями без этой пары промах неразбираем
          held: ev.held ?? undefined,
          block: ev.block ?? undefined,
          legAt: ev.legAt ?? undefined,
          // по какой планке судили и что человек выдал: планка у каждого своя,
          // и без неё «не хватило 0.4» в логе ничего не значит
          bar: ev.bar ?? undefined,
          amp: ev.amp ?? undefined,
          lift: ev.lift == null ? undefined : Number(ev.lift.toFixed(2)),
          practice: ev.practice || undefined,
          // чего именно не хватило: не присел, не шагнул, засиделся
          why: ev.reason,
          angle: ev.angle == null ? null : Math.round(ev.angle),
        })
      } else if (ev.type === 'practice.done') {
        logEvent('game.practice.done', { at: Math.round(ev.at) })
      } else if (ev.type === 'practice.move') {
        // по этой строке в полевом логе видно, какое движение даётся хуже всех
        logEvent('game.practice.move', {
          movement: ev.movement,
          learned: ev.learned,
          tries: ev.tries,
        })
      } else if (ev.type === 'round.start') {
        cueStart()
        // приборы считаем с начала боя, а не с открытия экрана: разогрев модели
        // и отсчёт до старта в темп самого боя не входят
        resetRate()
        resetStages()
        logEvent('game.round.start', { at: Math.round(ev.at) })
      } else if (ev.type === 'round.end') {
        finishRound()
      }
    }
  }

  // --- приём кадров: тот же трекер, что и на обычном подходе ---
  useEffect(() => {
    return subscribe(({ landmarks, worldLandmarks, timestamp }) => {
      lastResultAtRef.current = performance.now()
      if (HITS_TIMED) {
        const at = lastResultAtRef.current
        poseGapRef.current = poseGotAtRef.current ? at - poseGotAtRef.current : 0
        poseGotAtRef.current = at
      }
      if (!hasFrameRef.current) {
        hasFrameRef.current = true
        setGotFrame(true)
      }

      landmarksRef.current = landmarks
      // метка ЗАХВАТА этого кадра: по ней ответ на движение дожидается своего
      // кадра на экране. В зачёт она не идёт — там своё время
      poseAtRef.current = timestamp
      const out = trackerRef.current.update(landmarks, timestamp, worldLandmarks)

      frameOkRef.current = !out.paused
      reasonRef.current = out.reason
      if (!out.paused) seenRef.current = true

      // Корпус читаем всегда, даже когда гейт кадра забраковал кадр: во время
      // уворота ноги закономерно уходят за край, а таз и плечи остаются видны.
      const stance = readStance(landmarks)
      // руки и колени читаются тем же кадром: угол локтя — по мировым точкам,
      // высота колена — по кадру
      const upper = readUpper(landmarks, worldLandmarks)
      // мах руки и высота стоп: по ним судятся птица и яма
      const vertical = readVertical(landmarks)
      // ноги: высота стопы над второй и её уход назад по глубине — по ним
      // судятся волна и уголёк. Берём ровно две величины, а не весь readLegs:
      // hipY, torso и kneeLift уже пришли выше, и вторая копия только
      // перетирала бы их своей
      const legs = readLegs(landmarks, worldLandmarks)
      /**
       * Девять новых движений: сырые признаки кадра одним чтением. Кладём их
       * ОТДЕЛЬНЫМ полем, а не в общую россыпь позы: половина имён там уже
       * занята (hipX, kneeLift, raise), и второй набор молча перетирал бы
       * первый — причём в обе стороны, в зависимости от порядка слияния.
       */
      const moves = readMoves(landmarks)
      torsoOkRef.current = stance.hipX != null && stance.shoulderWidth != null

      // всё, что уходит в игру: сглаженный угол из трекера и положение в кадре.
      // Позу считаем отдельным сенсором — счётчик приседов не трогаем.
      /**
       * Сырые точки позы едут в движок отдельным полем: ловцу мишеней нужны
       * именно они. Он судит не признак движения, а место конкретной точки
       * тела — ладони, локтя, колена, стопы, — и никакая производная величина
       * этого не заменит.
       */
      const feet = { ankleDy: legs.ankleDy, ankleBack: legs.ankleBack, moves, landmarks }
      if (!out.paused) {
        poseRef.current = { ...stance, ...upper, ...vertical, ...feet, angle: out.angle }
      } else if (dodgeGraceRef.current) {
        // угол по обрезанным ногам недостоверен — не выдумываем его. Стене он
        // и не нужен: она судится шагом, а «не сидит» при неизвестном угле
        // считается выполненным
        poseRef.current = { ...stance, ...upper, ...vertical, ...feet, angle: null }
      } else {
        poseRef.current = EMPTY_POSE
      }

      pushLive({
        screen: screenNameRef.current,
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
        drawMs: Math.round(frameMsRef.current),
        cheap: cheapRef.current,
      })

      /**
       * СЧЁТЧИК ПРИСЕДОВ ЗДЕСЬ НИЧЕГО НЕ СУДИТ И НИЧЕГО НЕ ПИШЕТ В ЛОГ.
       *
       * Трекер в бою нужен ровно за одним — за сглаженным углом в колене, и
       * даже он идёт в дело только в режиме движений (ловец мишеней про углы не
       * знает вовсе). Собственные события трекера — «повтор», «мелкий подсед»,
       * «слишком быстро» — к бою отношения не имеют: приседов здесь никто не
       * считает, судит движок.
       *
       * Раньше они всё-таки писались в лог «на всякий случай». Полевой лог 16
       * августа показал цену: половина отклонённых циклов приседа пришлась на
       * боевой раунд, где человек приседал за низкими мишенями, и разбор
       * силового блока пришлось вести сквозь этот шум. Диагностике место там,
       * где движение и правда считают, — в силовом блоке (block.attempt).
       */
    })
  }, [subscribe])

  // --- часы раунда и отрисовка ---
  useEffect(() => {
    const canvas = canvasRef.current
    // в среде без canvas (jsdom) раунд всё равно идёт — просто без картинки
    const ctx = canvas?.getContext ? canvas.getContext('2d') : null

    let raf = 0
    let prev = performance.now()
    let stopped = false
    const noteCheap = noteCheapRef.current
    /** В экономном режиме кадр рисуется через раз: логика идёт своим ходом. */
    let drawEveryOther = false

    /**
     * 3D-СЛОЙ ПОДКЛЮЧАЕТСЯ ОТДЕЛЬНО И НЕОБЯЗАТЕЛЬНО.
     *
     * Модуль тянет за собой three, поэтому грузится динамически: телефон, на
     * котором 3D не заведётся, не должен платить за него ни байтом. Всё, что
     * слой умеет, — рисовать те же препятствия по тому же клоку; судейство,
     * очки, звук и детекторы его не касаются.
     *
     * Пока слой жив, 2D-канвас рисует всё СВОЁ, кроме препятствий: частицы,
     * очки и звёзды остаются на нём. Отказал — препятствия в тот же кадр
     * возвращаются на 2D, без паузы и без пустого экрана.
     */
    let layer = null
    let glSize = ''
    const glCanvas = wants3d() ? glRef.current : null
    if (glCanvas?.getContext) {
      import('../game/space3d.js')
        .then((mod) => {
          if (stopped) return
          const made = mod.createSpace3d({
            canvas: glCanvas,
            onNotice: (reason, detail) => {
              layer = null
              logEvent('game.3d.off', { reason, ...(detail ?? {}) })
            },
          })
          if (made.active) {
            layer = made
            logEvent('game.3d.on', {})
          }
        })
        .catch((error) => {
          logEvent('game.3d.off', { reason: 'no-module', message: String(error?.message ?? error) })
        })
    }

    const heroMode = !wantsClassic()
    const showMeter = wantsFpsMeter()
    let meterFrames = 0
    let meterSince = performance.now()
    /** Когда в последний раз считали живые объекты (раз в секунду). */
    let countsSince = performance.now()

    const syncCanvasSize = () => {
      // в экономном режиме рисуем в один пиксель устройства: вчетверо меньше
      // работы на телефоне с плотным экраном
      const dpr = cheapRef.current ? 1 : Math.min(2, globalThis.devicePixelRatio || 1)
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w
        canvas.height = h
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const syncHud = (round) => {
      const s = scoreRef.current.getState()
      const left = Math.ceil(round.remainingMs / 1000)
      // «Встань!» показываем только когда человека видно: иначе это упрёк пустоте
      const mustStand = round.mustStand && round.angle != null
      // Правило показываем ровно на обучающих препятствиях — по одному на тип.
      // Дальше человек уже знает все три, и текст только мешает смотреть вперёд.
      // команду показываем по ближайшему летящему препятствию разминки
      const teaching = round.incoming.find((o) => o.practice)
      // между разминочными препятствиями пусто, а человек должен видеть, что
      // именно сейчас разучивается — тогда держим на экране одно слово
      const command = round.practice
        ? commandFor(teaching) || MOVEMENT_NAME[round.practiceMovement] || null
        : null
      const readyLeft = Math.ceil(round.readyLeftMs / 1000)
      const hint = missHintRef.current
      const missHint = hint && performance.now() < hint.until ? hint.text : null

      const cur = hudRef.current
      if (
        cur.score === s.total &&
        cur.secondsLeft === left &&
        cur.mustStand === mustStand &&
        cur.command === command &&
        cur.missHint === missHint &&
        cur.practice === round.practice &&
        cur.movement === round.practiceMovement &&
        cur.done === round.practiceDone &&
        cur.step === round.practiceIndex + 1 &&
        cur.ready === round.ready &&
        cur.readyLeft === readyLeft &&
        cur.cheap === cheapRef.current
      ) {
        return
      }
      // отсчёт слышен так же, как перед обычным подходом
      if (round.ready && readyLeft > 0 && readyLeft !== lastCountRef.current) {
        lastCountRef.current = readyLeft
        cueCountdown(readyLeft)
      }
      if (!round.ready) lastCountRef.current = null

      hudRef.current = {
        score: s.total,
        secondsLeft: left,
        mustStand,
        command,
        missHint,
        practice: round.practice,
        movement: round.practiceMovement,
        done: round.practiceDone,
        needed: round.practiceNeeded,
        step: round.practiceIndex + 1,
        total: round.practiceTotal,
        ready: round.ready,
        readyLeft,
        cheap: cheapRef.current,
      }
      setHud(hudRef.current)
    }

    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)

      const now = performance.now()
      const dt = now - prev
      prev = now
      drawEveryOther = !drawEveryOther

      // как долго телефон рисует кадр: считаем сглаженно, иначе одиночная
      // задержка от инференса дёргала бы режим туда-сюда
      frameMsRef.current += (Math.min(dt, 200) - frameMsRef.current) * 0.05
      if (!cheapRef.current && frameMsRef.current > CHEAP_ON_MS) cheapRef.current = true
      else if (cheapRef.current && frameMsRef.current < CHEAP_OFF_MS) cheapRef.current = false
      /**
       * ЭКОНОМНЫЙ РЕЖИМ — В ЛОГ. Полевая жалоба «не видно эффекта попадания»
       * разбиралась вслепую: бой шёл в экономном режиме, эффекты в нём урезаны,
       * а в логе об этом не было ни строки. Пишется только ПЕРЕХОД и не чаще
       * раза в пять секунд — само состояние проверяется каждый кадр.
       */
      noteCheap('render.cheap', cheapRef.current, {
        on: cheapRef.current,
        frameMs: Math.round(frameMsRef.current),
      })

      const stale = now - lastResultAtRef.current > STALE_RESULT_MS
      /**
       * ДОЛГАЯ остановка — уже не заминка. Считаем её отдельно от `stale`:
       * секунда тишины бывает у всех, три секунды означают, что кадры не идут.
       */
      const silentMs = now - lastResultAtRef.current
      const dead = hasFrameRef.current && silentMs > STALE_RECOVER_MS
      setCameraStalled((v) => (v === dead ? v : dead))

      if (dead && !stallLoggedRef.current) {
        stallLoggedRef.current = true
        const темп = rateStats()
        logEvent('camera.stalled', {
          silentMs: Math.round(silentMs),
          // чем считали до остановки — по этому в поле отличают «умер воркер»
          // от «уснула камера»
          thread: getLive().thread ?? null,
          delegate: getLive().delegate ?? null,
          grab: getLive().perf?.grabMode ?? null,
          poseFps: темп.poseFps,
          latencyMs: темп.latencyMs,
          cycle,
        })
      }

      /**
       * ОДНА АВТОМАТИЧЕСКАЯ ПОПЫТКА. Не цикл: перезапуск гасит камеру на
       * секунду, и повторять его по кругу значило бы держать человека в
       * бесконечной перезагрузке вместо того, чтобы честно сказать, что не
       * вышло, и дать кнопку.
       */
      if (dead && !restartTriedRef.current && onRestartCameraRef.current) {
        restartTriedRef.current = true
        logEvent('camera.restart', { why: 'auto', silentMs: Math.round(silentMs) })
        setRestarting(true)
        onRestartCameraRef.current()
      }

      if (!dead && restartTriedRef.current) {
        // кадры вернулись — исход попытки в журнал и всё сбрасывается
        logEvent('camera.restart.ok', { silentMs: Math.round(silentMs) })
        restartTriedRef.current = false
        stallLoggedRef.current = false
        setRestarting(false)
      }
      dodgeGraceRef.current = torsoOkRef.current && roundRef.current.getState().wallIncoming
      // Пока стена летит, а корпус виден, гейт кадра не останавливает раунд:
      // иначе шаг в сторону сам себя и наказывает — человек уходит к краю,
      // теряются голеностопы, игра встаёт ровно в момент уворота.
      const isPaused =
        blockedRef.current ||
        !seenRef.current ||
        stale ||
        (!frameOkRef.current && !dodgeGraceRef.current)
      setPaused((p) => (p === isPaused ? p : isPaused))

      if (isPaused) {
        if (!blockedRef.current && hasFrameRef.current) cueFrameLost()
      } else if (!finishedRef.current) {
        clockRef.current += dt
        // стадия «судейство»: шаг движка и разбор его событий — вместе, потому
        // что разбор и есть вторая половина судейства (зачёты, промахи, звук)
        const judgeAt = performance.now()
        handleEventsRef.current(roundRef.current.update(clockRef.current, poseRef.current))
        noteStage('judge', performance.now() - judgeAt, judgeAt)
      }

      /**
       * Отложенные ответы — те, до которых доехала картинка. Разбирается очередь
       * КАЖДЫЙ кадр, в том числе на паузе: пауза останавливает раунд, а не
       * экран, и висеть в очереди ответу на уже сделанное движение незачем.
       */
      showQueueRef.current.drain(getShownPose(), now)

      // один снимок на кадр: и картинке, и HUD нужен один и тот же
      const round = roundRef.current.getState()

      /**
       * ЧТО ВИСИТ НА ЭКРАНЕ — наружу, и ТОЛЬКО при включённой отладке.
       *
       * Нужно виртуальному тестировщику: без этого он бьёт вслепую, зачётов
       * набирает 8% против 57% в поле, и сцена в бою стоит пустая — то есть
       * отрисовка и эффекты попадания прогоном не проверяются вовсе.
       *
       * `TARGETS_LIVE` — константа, посчитанная один раз при загрузке модуля.
       * В боевом заходе здесь остаётся ровно проверка булева значения: ни
       * вызова, ни выделений, ни чтения полей мишени (см. liveTargets.js и его
       * тест).
       */
      if (TARGETS_LIVE) publishTargets(clockRef.current, round.mode, round.incoming)

      // Разгон должен читаться глазами, а не только по расписанию: звёзды
      // ускоряются вместе с темпом раунда. На паузе полёт почти замирает.
      updateStarfield(starsRef.current, dt, isPaused ? 0.15 : 1 + round.tempo * 1.6)
      updateParticles(particlesRef.current, dt)

      const clock = clockRef.current
      // отсуженное препятствие ещё уходит из кадра — потом выбрасываем
      drawnRef.current = drawnRef.current.filter((o) => clock <= o.passAt + TAIL_MS)

      const drawAt = performance.now()
      if (ctx && !(cheapRef.current && drawEveryOther)) {
        syncCanvasSize()

        if (layer) {
          const width = canvas.clientWidth
          const height = canvas.clientHeight
          const dpr = cheapRef.current ? 1 : Math.min(2, globalThis.devicePixelRatio || 1)
          const size = `${width}x${height}@${dpr}`
          if (size !== glSize) {
            glSize = size
            layer.resize(width, height, dpr)
          }
          layer.render({
            clockMs: clock,
            obstacles: drawnRef.current,
            cheap: cheapRef.current,
          })
        }

        /**
         * ДВА ФОРМАТА ЭКРАНА, и решает один флаг.
         *
         * Обычный — «человек герой»: мишени висят на его теле, а прежний слой
         * рисует только звёзды. Частицы и всплывающие очки в этом формате свои,
         * привязанные к точке мишени, поэтому старые списки на холст не идут.
         *
         * `?classic=1` — прежний вид целиком, как было до этой правки.
         */
        drawScene(ctx, {
          width: canvas.clientWidth,
          height: canvas.clientHeight,
          clockMs: clock,
          stars: starsRef.current,
          obstacles: layer || heroMode ? [] : drawnRef.current,
          particles: heroMode ? [] : particlesRef.current,
          cheap: cheapRef.current,
        })

        if (heroMode) {
          const box = { width: canvas.clientWidth, height: canvas.clientHeight }
          const video = videoRef?.current
          // кадр вписан в экран по правилам object-fit: contain — те же поля,
          // что и у самого видео, иначе мишени разъедутся с телом
          const fit = fitContain(
            video?.videoWidth || 0,
            video?.videoHeight || 0,
            box.width,
            box.height,
          ) ?? { ox: 0, oy: 0, dw: box.width, dh: box.height, scale: 1 }
          /**
           * ТЕЛО ДЛЯ МИШЕНЕЙ — ТО, ЧТО НА ЭКРАНЕ, а не самое свежее.
           *
           * В синхронном режиме показа картинка идёт с задержкой инференса
           * (см. pose/frameSync.js), и сырая свежая поза описывает тело из
           * будущего относительно показанного кадра: мишень висела там, где
           * конечность ОКАЖЕТСЯ, и зачёт вспыхивал раньше, чем рука на экране
           * доходила. Здесь берётся ровно та поза, которой нарисован кадр.
           *
           * СУДЕЙСТВО ЭТОГО НЕ ВИДИТ: очки и зачёты считаются выше по сырым
           * результатам и по реальному времени. Сдвигается только картинка.
           *
           * В живом режиме показанная поза и есть самая свежая — поведение там
           * прежнее, до последнего пикселя.
           */
          const shown = getShownPose()
          const overlayPose =
            shown.mode === SHOW_MODE.SYNC && shown.landmarks ? shown.landmarks : landmarksRef.current

          targetsRef.current.draw(ctx, {
            width: box.width,
            height: box.height,
            clockMs: clock,
            obstacles: drawnRef.current,
            body: readBody(overlayPose, fit),
            // мишени ловца приходят в координатах кадра камеры: перевести их в
            // пиксели можно только этой же вписанной рамкой
            fit,
            personal: personalRef.current,
            // «человек внизу» — признак самого движка, а не своя проверка
            ducked: round.ducking,
            cheap: cheapRef.current,
          })
        } else {
          /**
           * ЧИСЛО «+ОЧКИ» — ОДНО НА ОБА ФОРМАТА.
           *
           * Раньше их было два: слой мишеней копил своё, а `space.js` — своё, и
           * рисовался ровно один из двух. В формате «человек герой» второй был
           * мёртвым кодом, который при этом исправно копил объекты; в
           * `?classic=1` наоборот — первый копил числа, которые никто не рисовал
           * и никто не убирал, потому что уборка живёт внутри `draw()`.
           *
           * Теперь число одно и то же, и здесь оно просто дорисовывается поверх
           * прежней картинки: `?classic=1` — путь отката, и цену действия он
           * обязан называть так же, как основной.
           */
          targetsRef.current.drawFloats(ctx, {
            width: canvas.clientWidth,
            height: canvas.clientHeight,
            clockMs: clock,
            cheap: cheapRef.current,
          })
        }

        if (showMeter) {
          meterFrames += 1
          const real = performance.now()
          if (real - meterSince >= 1000) {
            setMeter({
              fps: Math.round((meterFrames * 1000) / (real - meterSince)),
              layer: layer ? '3D' : '2D',
            })
            meterFrames = 0
            meterSince = real
          }
        }
      }
      // стадия «отрисовка» целиком: сцена, мишени, эффекты и слой стекла.
      // Кадр, пропущенный экономным режимом, тоже считается — иначе рост
      // прятался бы за тем, что рисовать стали через раз.
      noteStage('draw', performance.now() - drawAt, drawAt)
      noteFrame(now)

      /**
       * ЖИВЫЕ ОБЪЕКТЫ — раз в секунду, а не каждый кадр.
       *
       * Обход документа стоит заметно, и звать его чаще значило бы самому
       * создавать те тормоза, которые мы ищем. Раз в секунду достаточно: нас
       * интересует наклон за минуты, а не рябь внутри секунды.
       */
      if (now - countsSince >= 1000) {
        countsSince = now
        /**
         * ЭФФЕКТЫ ПОПАДАНИЯ СЧИТАЛИСЬ МИМО СТОЛБЦА «частицы» — и это была дыра
         * ровно там, где искали.
         *
         * В формате «человек герой» (он же основной) `particlesRef` не
         * используется вовсе: частицы, кольца, всплывающие очки, конфетти,
         * вспышки и следы зачёта живут внутри слоя мишеней. В таблице разбора
         * столбец стоял в нуле всю сессию — не потому, что объектов нет, а
         * потому, что считали не тот список. Подозрение «растёт число живых
         * объектов» этой таблицей было не проверяемо в принципе.
         *
         * Читается готовый геттер `effects` (он же в тестах слоя), раз в
         * секунду и только длины: обхода структур здесь нет.
         */
        const fx = targetsRef.current.effects
        noteCounts({
          // мишени/препятствия в полёте прямо сейчас (см. incoming в движке)
          targets: round.incoming?.length ?? 0,
          obstacles: drawnRef.current.length,
          particles:
            particlesRef.current.length +
            fx.parts.length +
            fx.rings.length +
            fx.floats.length +
            fx.confetti.length +
            fx.flashes.length +
            fx.hits.length,
          stars: starsRef.current.length,
          heapMb: heapMb(),
          ...domCounts(),
        }, now)
      }

      syncHud(round)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      layer?.dispose()
      layer = null
      stopped = true
      cancelAnimationFrame(raf)
      // экран уходит — отложенные ответы уходят с ним: показывать их некому, а
      // держать замыкания на снятый холст незачем
      showQueueRef.current.clear()
    }
  }, [])

  const cancel = () => {
    if (finishedRef.current) return
    finishedRef.current = true
    onCancel?.()
  }

  const elapsed = totalMs - hud.secondsLeft * 1000
  // холст 3D появляется в разметке только под флагом: без него экран ровно
  // такой же, каким был до всей этой истории со стеклом
  const show3d = wants3d()

  return (
    <div className={`mt-screen mt-screen--game ${cycles > 0 ? 'mt-screen--sprog' : ''}`}>
      {/* Затемнение и свечение горизонта — статичный слой CSS. Раньше это были
          два полноэкранных градиента в canvas на каждом кадре: самая дорогая
          операция всей отрисовки, и на слабом телефоне она съедала кадр. */}
      <div className="mt-game__sky" aria-hidden="true" />
      {/* Слои снизу вверх: видео -> 3D-препятствия (только под ?3d=1) -> 2D
          (частицы, очки, полоски). Порядок задан порядком в разметке, стиль у
          обоих холстов один и тот же. */}
      {show3d && <canvas className="mt-game__canvas" ref={glRef} data-testid="game-canvas-3d" />}
      <canvas className="mt-game__canvas" ref={canvasRef} data-testid="game-canvas" />

      {/* Полевая мерка по ?fps=1: кадры отрисовки и слой, который их рисует. */}
      {meter && (
        <div
          data-testid="fps-meter"
          style={{
            position: 'absolute',
            top: '6px',
            right: '8px',
            zIndex: 5,
            font: '600 12px ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#9ff0ff',
            background: 'rgba(6, 10, 18, 0.55)',
            padding: '2px 6px',
            borderRadius: '6px',
            pointerEvents: 'none',
          }}
        >
          {meter.fps} fps · {meter.layer}
        </div>
      )}

      <SessionProgress cycle={cycle} cycles={cycles} cheap={hud.cheap} />

      <div className="mt-game__hud">
        <div className="mt-game__score">
          <div className="mt-game__scoreValue" key={hitFlash} data-testid="game-score">
            {scoreBase + hud.score}
          </div>
          <div className="mt-game__scoreLabel">очки</div>
          {/* Уровень — рядом со счётом: человек должен видеть, на чём играет,
              иначе разгон внутри раунда читается как «игра сломалась». */}
          <div className="mt-game__level" data-testid="game-level">
            {levelRef.current.name}
          </div>
        </div>

        <div className={`mt-game__timer ${paused ? 'is-paused' : ''}`}>
          <div className="mt-game__timerValue" data-testid="game-clock">
            {formatClock(hud.secondsLeft)}
          </div>
          <div className="mt-game__timerBar">
            <div
              className="mt-game__timerFill"
              style={{ width: `${Math.max(0, Math.min(100, (elapsed / totalMs) * 100))}%` }}
            />
          </div>
        </div>
      </div>

      {/* Ответ на незачёт: что именно поправить. Держится секунду с небольшим
          и перекрывает команду — это сейчас важнее следующего препятствия. */}
      {!paused && hud.missHint && !hud.mustStand && (
        <div className="mt-game__command mt-game__command--miss" data-testid="miss-hint">
          {hud.missHint}
        </div>
      )}

      {/* Разминка: команда во весь экран. Мелкий текст с двух метров не
          читается вовсе — работает только глагол в две-три буквы высотой
          в десятую часть экрана. */}
      {!paused && hud.practice && hud.command && !hud.mustStand && !hud.missHint && (
        <div className="mt-game__command" data-testid="game-command">
          {hud.command}
        </div>
      )}

      {/* Разминка: только крупные слова и цифры. Длинные фразы с двух метров
          не читаются вовсе, а человеку нужно понимать ровно три вещи — что идёт
          разминка, какое движение и сколько раз оно уже вышло. */}
      {!paused && hud.practice && (
        <div className="mt-game__practice" data-testid="practice-badge">
          <div className="mt-game__practiceTitle">
            РАЗМИНКА {hud.step}/{hud.total}
          </div>
          <div className="mt-game__practiceCount">
            {hud.done} из {hud.needed}
          </div>
        </div>
      )}

      {/* Разминка пройдена: похвала и отсчёт до зачётной части. */}
      {!paused && hud.ready && (
        <div className="mt-game__ready" data-testid="ready-banner">
          <div className="mt-game__readyTitle">МОЛОДЕЦ!</div>
          <div className="mt-game__readyText">Начинаем тренировку</div>
          <div className="mt-game__readyCount">{hud.readyLeft}</div>
        </div>
      )}

      {/* «Встань!» важнее команды: пока человек сидит, ему ничего не
          засчитается, и он должен узнать об этом сразу. */}
      {!paused && hud.mustStand && (
        <div className="mt-game__command mt-game__command--warn" data-testid="stand-hint">
          ВСТАНЬ
        </div>
      )}

      {paused && !blocked && gotFrame && (
        <div className="mt-blocker mt-blocker--hard" data-testid="frame-blocker">
          <div className="mt-blocker__card">
            {/**
              * ДВА РАЗНЫХ СОСТОЯНИЯ, И ПУТАТЬ ИХ НЕЛЬЗЯ.
              *
              * «Не видно стоп» — про человека: он вышел из кадра, и вернуть его
              * может только он сам. «Камера остановилась» — про нас: кадры не
              * идут вовсе, и человек тут бессилен.
              *
              * Раньше показывалась только первая, ПОСЛЕДНЯЯ известная причина
              * из frameGate. Когда камера вставала, она застывала на экране
              * навсегда — и человек отходил от телефона, подходил, отходил
              * снова, потому что игра всё это время говорила ему, что дело в
              * нём. Причину из frameGate теперь не показываем вовсе, пока
              * кадры не идут: она устарела ровно в тот момент, когда они
              * перестали приходить.
              */}
            {cameraStalled ? (
              <>
                <div className="mt-blocker__title" data-testid="blocker-stalled">
                  Камера остановилась
                </div>
                <div className="mt-blocker__text">
                  {restarting
                    ? 'Пробуем поднять её заново…'
                    : 'Заход на паузе — камера перестала отдавать кадры'}
                </div>
              </>
            ) : (
              <>
                <div className="mt-blocker__title">
                  {REASON_TEXT[reasonRef.current] || 'Встань в кадр'}
                </div>
                <div className="mt-blocker__text">Полёт на паузе, пока тебя не видно</div>
              </>
            )}

            {/**
              * КНОПКИ БЫЛИ НУЖНЫ КАРТОЧКЕ С САМОГО НАЧАЛА. Без них человек,
              * у которого встала камера, оказывался заперт: тренировка на
              * паузе, текст врёт, выйти можно только закрыв вкладку — а вместе
              * с ней уходил и результат захода.
              */}
            <div className="mt-blocker__actions">
              {cameraStalled && onRestartCamera && (
                <button
                  type="button"
                  className="mt-blocker__btn"
                  data-testid="blocker-restart"
                  onClick={() => {
                    logEvent('camera.restart', { why: 'manual' })
                    setRestarting(true)
                    onRestartCamera()
                  }}
                >
                  Перезапустить камеру
                </button>
              )}
              <button
                type="button"
                className="mt-blocker__btn mt-blocker__btn--quiet"
                data-testid="blocker-exit"
                onClick={cancel}
              >
                Выйти из захода
              </button>
            </div>
          </div>
        </div>
      )}

      {!hideCancel && (
        <button
          className="mt-corner mt-corner--left"
          data-testid="game-cancel"
          onClick={cancel}
          aria-label="Прервать раунд"
        >
          ✕
        </button>
      )}
    </div>
  )
}

/** Смещение в ширинах плеч: плюс — ушёл от стены, минус — прижался к ней. */
function fmtDodge(k) {
  return k == null ? null : Number(k.toFixed(2))
}

function formatClock(totalSeconds) {
  const s = Math.max(0, totalSeconds)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
