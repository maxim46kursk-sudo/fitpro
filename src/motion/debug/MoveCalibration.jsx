import { useEffect, useRef, useState } from 'react'
import {
  beginSegment,
  dropSegment,
  downloadRecording,
  endSegment,
  isFull,
  recordedCount,
  recordedSegments,
  sendRecording,
  startRecording,
  stopRecording,
} from './recorder.js'
import { getThresholds } from '../exercises/thresholds.js'
import { getLive } from './diagnostics.js'
import { setCalibrating } from './calibrationMode.js'
import DemoSkeleton from './DemoSkeleton.jsx'

/**
 * Пошаговая запись движений для настройки детекторов.
 *
 * Обычная запись в игре не годится: обучение уводит дальше после двух успехов,
 * человек не успевает набрать материал по движению, которое как раз и не
 * ловится. А по сплошной записи потом не разобрать, где он делал движение, а
 * где просто стоял, — и лишнее срабатывание неотличимо от честного.
 *
 * Здесь человек проходит по списку: экран говорит «сделай пять подъёмов
 * ПРАВОГО колена», он делает и жмёт «Дальше». Запись получается размеченной:
 * какое движение, какая сторона, с какой по какую секунду. Дубль можно
 * переписать кнопкой «Заново» — кадры останутся, но в разметку не попадут.
 *
 * Экран для человека в двух метрах: крупные буквы, две большие кнопки. Во
 * время самих шагов подложки нет вовсе — камера и скелет видны целиком:
 * человек должен видеть себя, иначе он не понимает, попадает ли в кадр, и
 * запись выходит бесполезной. Инструкция уходит плашкой вверх, кнопки — вниз,
 * середина остаётся свободной.
 */

/** Если кадры не идут дольше этого — камера не пишет, и об этом надо сказать. */
const STALE_MS = 2000

/** Сколько повторов просить в одном сегменте. */
const REPS = 5

/** Отправка на компьютер есть только у дев-сервера — на проде её нет. */
const DEV = (() => {
  try {
    return !!import.meta.env?.DEV
  } catch {
    return false
  }
})()

/**
 * Список движений экспортируется ради теста-стража: на каждое движение должна
 * найтись петля в demoLoops.json. Добавили движение, а демо под него не сняли —
 * тест скажет об этом сразу, а не человек в двух метрах от телефона.
 */
export const MOVES = [
  { id: 'barrier', name: 'Присед', sided: false, task: (n) => `Сделай ${n} приседаний` },
  {
    id: 'wall',
    name: 'Шаг в сторону',
    sided: true,
    task: (n, side) => `Сделай ${n} шагов ${side === 'left' ? 'ВЛЕВО' : 'ВПРАВО'}`,
  },
  {
    id: 'beam',
    name: 'Наклон',
    sided: true,
    task: (n, side) => `Сделай ${n} наклонов ${side === 'left' ? 'ВЛЕВО' : 'ВПРАВО'}`,
  },
  {
    id: 'strike',
    name: 'Удар рукой',
    sided: true,
    task: (n, side) => `Сделай ${n} ударов ${side === 'left' ? 'ЛЕВОЙ' : 'ПРАВОЙ'} рукой`,
  },
  {
    id: 'knee',
    name: 'Подъём колена',
    sided: true,
    task: (n, side) => `Сделай ${n} подъёмов ${side === 'left' ? 'ЛЕВОГО' : 'ПРАВОГО'} колена`,
  },
  /**
   * Мах рукой и прыжок — движения из ТЗ, которых в игре ещё нет. Порядок работы
   * тот же, что и со всеми остальными: сначала размеченная запись, потом
   * настройка порогов по ней офлайн, и только потом детектор и препятствие.
   * Инструкция здесь длиннее прочих намеренно: «мах» человек понимает
   * как угодно — от рывка перед собой до круга плечом, — и запись выйдет
   * бесполезной, если не сказать, через какую сторону и до какой точки.
   */
  {
    id: 'raise',
    name: 'Мах рукой вверх',
    sided: true,
    task: (n, side) =>
      `${n} махов ${side === 'left' ? 'ЛЕВОЙ' : 'ПРАВОЙ'} рукой: подними прямую руку` +
      ' через сторону вверх над головой и опусти',
  },
  {
    id: 'jump',
    name: 'Прыжок',
    sided: false,
    task: (n) => `${n} прыжков: подпрыгни на месте и мягко приземлись`,
  },
  /**
   * Выпад назад и захлёст голени — движения 3 и 5 из библиотеки ТЗ, детекторов у
   * них пока нет. Сторона у обоих — по РАБОТАЮЩЕЙ ноге, как у колена: правый
   * выпад значит «шагает назад правая», правый захлёст — «бьёт пяткой правая».
   *
   * В обеих инструкциях выделено то, что человек путает чаще всего: у выпада —
   * НАЗАД (вперёд шагают привычнее, и по записи это было бы другое движение), у
   * захлёста — сторона, потому что стоя на месте перепутать ногу проще всего.
   */
  {
    id: 'lunge',
    name: 'Выпад назад',
    sided: true,
    task: (n, side) =>
      `${n} выпадов НАЗАД ${side === 'left' ? 'левой' : 'правой'} ногой: шагни` +
      ` ${side === 'left' ? 'левой' : 'правой'} далеко назад, опустись, вернись в стойку`,
  },
  {
    id: 'heel',
    name: 'Захлёст голени',
    sided: true,
    task: (n, side) =>
      `${n} захлёстов ${side === 'left' ? 'ЛЕВОЙ' : 'ПРАВОЙ'}: стоя на месте,` +
      ' подбей пяткой к ягодице и опусти',
  },

  /**
   * Движения сверх ТЗ: Максим справедливо возразил, что девяти на тридцать дней
   * мало. Детекторов у них пока нет — сначала размеченная запись, потом пороги
   * по ней офлайн, и только потом детектор и препятствие.
   *
   * ЗАГЛАВНЫЕ БУКВЫ В ИНСТРУКЦИЯХ — НЕ УКРАШЕНИЕ. Это ровно те признаки,
   * которыми движения потом придётся разводить между собой, и если человек их
   * не выделит на записи, разводить будет нечем:
   *
   *   джек от прыжка ноги врозь отличается ТОЛЬКО положением рук;
   *   боковой выпад от шага в сторону — ТОЛЬКО просадкой таза;
   *   наклон вперёд от приседа — ТОЛЬКО прямыми коленями;
   *   скручивание от подъёма колена — ТОЛЬКО встречной рукой к колену.
   *
   * Записать их «примерно похоже» — значит получить две записи, по которым
   * детекторы неразличимы, и потерять день на попытку развести неразличимое.
   * На скручивании с коленом это и случилось: по записи оно вышло обычным
   * подъёмом колена, и движение пришлось отменить целиком.
   */
  {
    id: 'jumpsquat',
    name: 'Присед с прыжком',
    sided: false,
    task: (n) => `${n} приседаний с прыжком: присядь и выпрыгни вверх`,
  },
  {
    id: 'bend',
    name: 'Наклон вперёд',
    sided: false,
    task: (n) => `${n} наклонов вперёд: НЕ СГИБАЯ КОЛЕН достань руками до пола`,
  },
  {
    id: 'jack',
    name: 'Джампинг-джек',
    sided: false,
    task: (n) => `${n} джампинг-джеков: прыжком ноги в стороны и РУКИ НАД ГОЛОВОЙ`,
  },
  {
    id: 'hop',
    name: 'Прыжок ноги в стороны',
    sided: false,
    task: (n) => `${n} прыжков ноги врозь и обратно, РУКИ ВНИЗУ вдоль тела`,
  },
  {
    id: 'legside',
    name: 'Боковой мах ногой',
    sided: true,
    task: (n, side) =>
      `${n} махов ${side === 'left' ? 'ЛЕВОЙ' : 'ПРАВОЙ'} ногой` +
      ' в сторону: прямая нога вбок, таз на месте',
  },
  {
    id: 'sidelunge',
    name: 'Боковой выпад',
    sided: true,
    task: (n, side) =>
      `${n} боковых выпадов ${side === 'left' ? 'ВЛЕВО' : 'ВПРАВО'}:` +
      ` шагни ${side === 'left' ? 'левой' : 'правой'} вбок и ОПУСТИСЬ на неё,` +
      ' вторая нога прямая',
  },
  {
    id: 'wings',
    name: 'Разведение рук',
    sided: false,
    task: (n) => `${n} разведений: прямые руки в стороны ДО УРОВНЯ ПЛЕЧ и опусти`,
  },
  /**
   * Скручивание с коленом — на месте боковой складки, которую оно и заменило.
   * Складка упёрлась в 59% зачётов в поле, и упёрлась конструктивно: её колено
   * меряется от линии таза, а её же наклон эту линию заваливает (см. moves.js).
   *
   * ПРО ЛОКОТЬ В ЗАДАНИИ. Тянуться просят ЛОКТЕМ — только так человек
   * скручивает корпус; «дотянись рукой» он выполняет одним махом руки, и тогда
   * движение и правда неотличимо от подъёма колена. Судит камера при этом по
   * КИСТИ: локоть стоя до колена не достаёт вовсе и наполовину закрыт корпусом.
   *
   * ОГОВОРКА ПРО РУКИ ЗА ГОЛОВОЙ ОБЯЗАТЕЛЬНА. С ладонями за затылком кисть
   * остаётся у головы, и мерить нечего — ровно на этом первая запись
   * скручивания и умерла.
   *
   * Сторона — по ПОДНИМАЕМОМУ КОЛЕНУ, как у колена и захлёста.
   */
  {
    id: 'twistknee',
    name: 'Скручивание с коленом',
    sided: true,
    task: (n, side) =>
      `${n} скручиваний: подними` +
      ` ${side === 'left' ? 'ЛЕВОЕ' : 'ПРАВОЕ'} колено и тянись к нему ЛОКТЕМ` +
      ' противоположной руки. Руки за голову НЕ убирай',
  },
  {
    id: 'clap',
    name: 'Хлопок над головой',
    sided: false,
    task: (n) => `${n} хлопков: ОБЕ руки вверх над головой и хлопни`,
  },
]

/** «шаг / шага / шагов» — иначе кнопка читается как машинный перевод. */
function stepWord(n) {
  const ten = n % 100
  if (ten >= 11 && ten <= 14) return 'шагов'
  const one = n % 10
  if (one === 1) return 'шаг'
  if (one >= 2 && one <= 4) return 'шага'
  return 'шагов'
}

/** Как шаг называется в списке потерянных: «Удар рукой (правая)». */
function stepLabel(step) {
  if (!step.side) return step.name
  return `${step.name} (${step.side === 'left' ? 'левая' : 'правая'})`
}

/**
 * Шаги, которые человек прошёл, а в разметку они не попали. Переполненная
 * запись перестаёт принимать кадры молча: экран продолжает вести по списку, а
 * сегменты выходят пустыми и в файл не идут вовсе. Сказать надо не только
 * «переполнено», но и какие именно движения придётся переснимать.
 */
function missedSteps(steps) {
  const marked = new Set(recordedSegments().map((s) => `${s.movement}:${s.side}`))
  return steps.filter((s) => !marked.has(`${s.movement}:${s.side}`))
}

/** Из выбранных движений собираем шаги: у парных — по шагу на сторону. */
function buildSteps(selected) {
  const steps = []
  for (const move of MOVES) {
    if (!selected[move.id]) continue
    if (move.sided) {
      for (const side of ['right', 'left']) {
        steps.push({ movement: move.id, side, name: move.name, task: move.task(REPS, side) })
      }
    } else {
      steps.push({ movement: move.id, side: null, name: move.name, task: move.task(REPS) })
    }
  }
  return steps
}

export default function MoveCalibration({ onClose }) {
  const [selected, setSelected] = useState(() =>
    Object.fromEntries(MOVES.map((m) => [m.id, true])),
  )
  /** setup — выбор движений, run — запись по шагам, done — отправка. */
  const [phase, setPhase] = useState('setup')
  const [steps, setSteps] = useState([])
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  const [sent, setSent] = useState(null)
  /** Кадры перестали идти: человек вышел из кадра или камера встала. */
  const [stale, setStale] = useState(false)
  /** Запись упёрлась в потолок — дальше не пишется ничего. */
  const [full, setFull] = useState(false)
  const startedRef = useRef(false)
  const lastGrowthRef = useRef({ at: 0, count: 0 })

  // счётчик кадров: заодно видно, что запись действительно идёт, а не стоит
  useEffect(() => {
    if (phase !== 'run') return undefined
    lastGrowthRef.current = { at: Date.now(), count: recordedCount() }

    const id = setInterval(() => {
      const now = recordedCount()
      setCount(now)
      const seen = lastGrowthRef.current
      if (now !== seen.count) lastGrowthRef.current = { at: Date.now(), count: now }
      setStale(Date.now() - lastGrowthRef.current.at > STALE_MS)
      setFull(isFull())
    }, 300)
    return () => clearInterval(id)
  }, [phase])

  /**
   * Пока экран открыт, обычная логика модуля стоит: иначе автозапуск увидит
   * человека в кадре и запустит игру прямо посреди записи движений. Запись
   * тоже прекращается в любом случае, даже если экран закрыли на середине.
   */
  useEffect(() => {
    setCalibrating(true)
    return () => {
      setCalibrating(false)
      if (startedRef.current) stopRecording()
    }
  }, [])

  const start = () => {
    const list = buildSteps(selected)
    if (!list.length) return
    startRecording()
    startedRef.current = true
    setSteps(list)
    setIndex(0)
    setFull(false)
    setPhase('run')
    beginSegment({ movement: list[0].movement, side: list[0].side, reps: REPS })
  }

  const next = () => {
    endSegment()
    const nextIndex = index + 1
    if (nextIndex >= steps.length) {
      stopRecording()
      setPhase('done')
      return
    }
    setIndex(nextIndex)
    beginSegment({
      movement: steps[nextIndex].movement,
      side: steps[nextIndex].side,
      reps: REPS,
    })
  }

  const again = () => {
    // сегмент не засчитываем и начинаем его заново с текущего момента
    dropSegment()
    beginSegment({ movement: steps[index].movement, side: steps[index].side, reps: REPS })
  }

  const meta = () => ({
    kind: 'calibration',
    thresholds: getThresholds(),
    camera: getLive().camera,
    delegate: getLive().delegate,
    fps: getLive().fps,
    reps: REPS,
  })

  const send = async () => {
    setSent('отправляю…')
    const result = await sendRecording(meta())
    setSent(result.ok ? `на компьютере: ${result.file}` : `не ушло: ${result.error}`)
  }

  const restart = () => {
    setSent(null)
    setPhase('setup')
    setIndex(0)
    setCount(0)
  }

  const step = steps[index]
  /** Сколько шагов выйдет из выбранного: у парных движений их два. */
  const plannedSteps = buildSteps(selected).length
  const empty = phase === 'done' && recordedCount() === 0
  /**
   * На «Готово» смотрим прямо в рекордер, а не в опрашиваемое состояние: опрос
   * живёт только на шагах и до последнего кадра мог не успеть.
   */
  const truncated = phase === 'done' && isFull()
  const missed = truncated ? missedSteps(steps) : []
  // на шагах подложки нет: под оверлеем должно быть видно камеру
  const clear = phase === 'run'

  return (
    <div
      className={`mt-cal ${clear ? 'mt-cal--clear' : ''}`}
      data-testid="move-calibration"
      data-phase={phase}
    >
      <button className="mt-cal__close" onClick={onClose} aria-label="Закрыть калибровку">
        ✕
      </button>

      {phase === 'setup' && (
        <div className="mt-cal__setup">
          <div className="mt-cal__title">Калибровка движений</div>
          <div className="mt-cal__note">
            Запись пойдёт по шагам, размеченная: по ней настраиваются детекторы.
            По {REPS} повторов на каждое движение.
          </div>
          {/* Список прокручивается сам, а заголовок и «Начать» остаются на
              месте: движений уже под два десятка, в экран телефона они не влезают, и
              при прокрутке всей плашки кнопка уезжала бы за нижний край. */}
          <div className="mt-cal__list" data-testid="cal-list">
            {MOVES.map((move) => (
              <label key={move.id} className="mt-cal__check">
                <input
                  type="checkbox"
                  checked={!!selected[move.id]}
                  onChange={() => setSelected((s) => ({ ...s, [move.id]: !s[move.id] }))}
                />
                <span>
                  {move.name}
                  {move.sided ? ' (обе стороны)' : ''}
                </span>
              </label>
            ))}
          </div>
          {/* Сколько шагов человек берёт на себя: у парных движений их два, и
              при всех включённых галочках счёт доходит до трёх десятков —
              лучше увидеть это до начала, а не на десятом шаге */}
          <button
            className="mt-cal__go"
            data-testid="cal-start"
            disabled={!plannedSteps}
            onClick={start}
          >
            {plannedSteps ? `Начать — ${plannedSteps} ${stepWord(plannedSteps)}` : 'Выбери движения'}
          </button>
        </div>
      )}

      {phase === 'run' && step && (
        <>
          {/* Плашка вверху, кнопки внизу, середина свободна — там человек.
              Внутри плашки фигурка и текст стоят РЯДОМ, а не друг на друге:
              видео идёт с object-fit: contain, и наверху в портрете остаётся
              пустая полоса — плашка живёт ровно в ней, картинку не закрывая. */}
          <div className="mt-cal__top" data-testid="cal-top">
            {/* Показ главнее слов: движение словами не передаётся, а фигурка
                объясняет его за секунду и с двух метров */}
            <DemoSkeleton movement={step.movement} side={step.side} />
            <div className="mt-cal__brief">
              <div className="mt-cal__step">
                Шаг {index + 1} из {steps.length} · кадров {count}
              </div>
              <div className="mt-cal__task" data-testid="cal-task">
                {step.task}
              </div>
              <div className="mt-cal__hint">Сделай движение и нажми «Дальше»</div>
            </div>
          </div>

          {/* Переполнение важнее «камера не пишет» и показывается вместо него:
              кадры действительно перестали идти, но причина другая, и лечится
              она не «встань в кадр», а новой записью. */}
          {full ? (
            <div className="mt-cal__alarm" data-testid="cal-full">
              Запись переполнена, дальше не пишется — заверши и начни новую
            </div>
          ) : (
            stale && (
              <div className="mt-cal__alarm" data-testid="cal-stale">
                Камера не пишет — проверь, что ты в кадре
              </div>
            )
          )}

          <div className="mt-cal__bottom">
            <button className="mt-cal__again" data-testid="cal-again" onClick={again}>
              Заново
            </button>
            <button className="mt-cal__go" data-testid="cal-next" onClick={next}>
              Дальше
            </button>
          </div>
        </>
      )}

      {phase === 'done' && empty && (
        <div className="mt-cal__setup">
          <div className="mt-cal__title">Запись пустая</div>
          <div className="mt-cal__note" data-testid="cal-empty">
            Ни одного кадра: камера не отдавала точки. Проверь, что ты целиком в
            кадре и на экране видно скелет, и пройди заново.
          </div>
          <button className="mt-cal__go" data-testid="cal-restart" onClick={restart}>
            Пройти заново
          </button>
        </div>
      )}

      {phase === 'done' && !empty && (
        <div className="mt-cal__setup">
          <div className="mt-cal__title">Готово</div>
          <div className="mt-cal__note">
            Кадров {recordedCount()}, размечено сегментов {recordedSegments().length}.
          </div>
          {/* Запись оборвалась на потолке, а экран вёл человека дальше по
              списку — эти шаги он делал, но в файле их нет вовсе. Назвать их
              поимённо: переснимать придётся именно их. */}
          {truncated && (
            <div className="mt-cal__alarm" data-testid="cal-truncated">
              {missed.length
                ? `Запись переполнена — в неё не попало ${missed.length} ${stepWord(
                    missed.length,
                  )}: ${missed.map(stepLabel).join(', ')}. Их надо записать отдельно.`
                : 'Запись переполнена и оборвалась на потолке — остальные движения записывай отдельно.'}
            </div>
          )}
          {/* Приёмник живёт только на дев-сервере: на проде отправлять некуда */}
          {DEV && (
            <button className="mt-cal__go" data-testid="cal-send" onClick={send}>
              {sent || 'Отправить на компьютер'}
            </button>
          )}
          <button
            className={DEV ? 'mt-cal__again' : 'mt-cal__go'}
            data-testid="cal-download"
            onClick={() => downloadRecording(meta())}
          >
            Скачать файлом
          </button>
        </div>
      )}
    </div>
  )
}
