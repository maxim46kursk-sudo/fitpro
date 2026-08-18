import { describe, expect, it } from 'vitest'
import {
  FRAME_BUFFER_MS,
  MAX_FRAMES,
  MODE,
  SYNC_LAG_MAX_MS,
  SYNC_MAX_INTERVAL_MS,
  SYNC_STALL_MS,
  SHOW_WAIT_MAX_MS,
  SYNC_WARMUP_FRAMES,
  chooseSyncMode,
  createFrameBuffer,
  createShowQueue,
  fallbackReason,
  getShownPose,
  isLiveCamForced,
  publishShownPose,
  smoothLatency,
  syncLag,
} from './frameSync.js'
import { poseMixAt } from './interpolate.js'

/**
 * Синхронный показ: кадр выходит на экран вместе с посчитанной ПО НЕМУ позой.
 *
 * Проверяется то, из-за чего режим разваливается молча: выбор кадра по времени
 * показа, арифметика задержки и откат на живое видео там, где телефон не тянет.
 * Само рисование живёт в CameraView и здесь не проверяется — здесь только то,
 * что можно посчитать без экрана.
 */

/** Слот буфера без DOM: буферу от canvas нужны только размеры. */
const fakeCanvas = () => ({ width: 0, height: 0 })

/** Буфер, набитый кадрами через равные промежутки. */
function filled(times, { bufferMs = FRAME_BUFFER_MS, maxFrames = MAX_FRAMES } = {}) {
  const buffer = createFrameBuffer({ createCanvas: fakeCanvas, bufferMs, maxFrames })
  for (const at of times) buffer.acquire(at, 480, 640)
  return buffer
}

describe('кадр по времени показа', () => {
  it('берётся ближайший к запрошенному времени', () => {
    const buffer = filled([0, 33, 66, 99])

    expect(buffer.nearest(60).at).toBe(66)
    expect(buffer.nearest(70).at).toBe(66)
    expect(buffer.nearest(84).at).toBe(99)
    expect(buffer.nearest(33).at).toBe(33)
  })

  it('на равном расстоянии выигрывает кадр постарше', () => {
    // для него поза заведомо уже посчитана, а для младшего может и не быть
    const buffer = filled([0, 100])
    expect(buffer.nearest(50).at).toBe(0)
  })

  it('за краями буфера отдаётся крайний кадр, а не пустота', () => {
    /**
     * Показать соседний кадр лучше, чем чёрный экран: точка показа всё равно
     * приклеивается к отданному кадру, и скелет от картинки не уедет.
     */
    const buffer = filled([100, 133, 166])

    expect(buffer.nearest(-1000).at).toBe(100)
    expect(buffer.nearest(1e6).at).toBe(166)
  })

  it('пустой буфер честно отдаёт ничего', () => {
    const buffer = filled([])
    expect(buffer.nearest(100)).toBeNull()
    expect(buffer.oldestAt()).toBeNull()
    expect(buffer.newestAt()).toBeNull()
  })

  it('кадр, показанный к моменту захвата, — последний не позже него', () => {
    /**
     * Метку результату ставит насос в момент захвата, а кадр к этому моменту
     * уже висел на экране. Без этой привязки скелет отставал бы от картинки на
     * полкадра просто из арифметики.
     */
    const buffer = filled([0, 33, 66, 99])

    expect(buffer.latestBefore(70).at).toBe(66)
    expect(buffer.latestBefore(66).at).toBe(66)
    expect(buffer.latestBefore(200).at).toBe(99)
    // до первого кадра — ничего: привязывать не к чему
    expect(buffer.latestBefore(-1)).toBeNull()
  })
})

describe('кольцевой буфер не растёт и не аллоцирует', () => {
  it('кадры старше окна возвращаются в пул', () => {
    const buffer = createFrameBuffer({ createCanvas: fakeCanvas, bufferMs: 400 })
    for (let at = 0; at <= 1000; at += 100) buffer.acquire(at, 480, 640)

    // в буфере только окно, всё остальное лежит в пуле и ждёт следующего кадра
    expect(buffer.newestAt() - buffer.oldestAt()).toBeLessThanOrEqual(400)
    expect(buffer.size + buffer.pooled).toBeLessThanOrEqual(6)
  })

  it('число слотов упирается в потолок даже на частых кадрах', () => {
    // 240 кадров в секунду — столько не бывает, но память не должна зависеть от
    // того, что отдаст телефон
    const times = Array.from({ length: 200 }, (_, i) => i * 4)
    const buffer = filled(times, { maxFrames: 8 })

    expect(buffer.size).toBeLessThanOrEqual(8)
    expect(buffer.size + buffer.pooled).toBeLessThanOrEqual(9)
  })

  it('слоты переиспользуются, а не заводятся на каждый кадр', () => {
    let created = 0
    const buffer = createFrameBuffer({
      createCanvas: () => {
        created += 1
        return fakeCanvas()
      },
      bufferMs: 100,
    })

    for (let at = 0; at <= 2000; at += 20) buffer.acquire(at, 480, 640)
    // окно 100 мс при кадре в 20 мс — это шесть слотов, и больше их взяться
    // неоткуда: сто кадров прошли через те же самые
    expect(created).toBeLessThanOrEqual(7)
  })

  it('слот приходит нужного размера — кадр копируется в родном разрешении', () => {
    const buffer = filled([])
    const slot = buffer.acquire(0, 480, 640)
    expect(slot.canvas.width).toBe(480)
    expect(slot.canvas.height).toBe(640)

    // камера сменила разрешение — слот подстраивается, а не заводится заново
    const next = buffer.acquire(500, 720, 1280)
    expect(next.canvas.width).toBe(720)
    expect(next.canvas.height).toBe(1280)
  })
})

describe('на сколько отстаёт показ', () => {
  it('задержка инференса плюс ПОЛНЫЙ интервал между результатами', () => {
    expect(syncLag(120, 110)).toBe(230)
    expect(syncLag(60, 33)).toBe(93)
  })

  it('точка показа всё время лежит между двумя известными позами', () => {
    /**
     * Главное свойство полного интервала, ради которого он и взят. Слабый
     * телефон: 7 результатов в секунду, инференс 140 мс. В момент прихода
     * свежей позы точка показа стоит на РАННЕЙ, к приходу следующей доезжает до
     * свежей — доля пути идёт 0 -> 1 и никогда не упирается в единицу.
     *
     * С половиной интервала точка показа стартовала бы с середины отрезка и
     * вторую половину стояла на свежей позе, пока картинка едет: расхождение
     * росло бы до 70 мс и рвалось с каждым результатом.
     */
    const latency = 140
    const span = 140
    // метки показа кадров, с которых посчитаны две последние позы
    const prevAt = 1000
    const curAt = prevAt + span
    // свежая поза пришла: захват был latency назад
    const arrived = curAt + latency

    const displayAt = (now) => now - syncLag(latency, span)

    expect(poseMixAt(prevAt, curAt, displayAt(arrived))).toBe(0)
    expect(poseMixAt(prevAt, curAt, displayAt(arrived + span / 2))).toBeCloseTo(0.5, 6)
    // следующий результат приходит ровно тогда, когда доехали до свежей позы
    expect(poseMixAt(prevAt, curAt, displayAt(arrived + span))).toBe(1)
  })

  it('быстрый телефон почти ничего не ждёт', () => {
    // 50 мс инференса при 30 результатах в секунду — незаметно глазом
    expect(syncLag(50, 33)).toBeLessThan(90)
  })

  it('сверху кламп: зеркало не превращается в видеозвонок', () => {
    expect(syncLag(2000, 500)).toBe(SYNC_LAG_MAX_MS)
    expect(syncLag(300, 60)).toBe(SYNC_LAG_MAX_MS)
  })

  it('мусор на входе не уводит показ в будущее', () => {
    expect(syncLag(-100, -100)).toBe(0)
    expect(syncLag(undefined, undefined)).toBe(0)
  })

  it('задержка сглаживается: одиночный тяжёлый кадр не дёргает картинку', () => {
    let lag = smoothLatency(null, 100)
    expect(lag).toBe(100)

    lag = smoothLatency(lag, 400)
    // подъехали в сторону выброса, но не прыгнули на него
    expect(lag).toBeGreaterThan(100)
    expect(lag).toBeLessThan(200)

    for (let i = 0; i < 40; i += 1) lag = smoothLatency(lag, 100)
    expect(lag).toBeCloseTo(100, 1)
  })
})

describe('показанная поза — для тех, кто рисует поверх', () => {
  /**
   * Мишени боя висят на теле, и тело им нужно ТО, КОТОРОЕ НА ЭКРАНЕ. Сырая
   * свежая поза в синхронном режиме описывает тело из будущего относительно
   * показанного кадра: мишень висела бы там, где конечность окажется.
   */

  it('отдаётся то, что положили: поза, её время и режим показа', () => {
    const landmarks = [{ x: 0.5, y: 0.5 }]
    publishShownPose({ landmarks, at: 1234, mode: MODE.SYNC })

    expect(getShownPose()).toMatchObject({ landmarks, at: 1234, mode: MODE.SYNC })
  })

  it('запись одна и та же — на кадр отрисовки мусора не создаётся', () => {
    const first = publishShownPose({ landmarks: [], at: 1, mode: MODE.SYNC })
    const second = publishShownPose({ landmarks: [], at: 2, mode: MODE.SYNC })
    expect(first).toBe(second)
    expect(getShownPose()).toBe(first)
  })

  it('пустой вызов сбрасывает в живой режим', () => {
    // камера ушла с экрана: оверлеи возвращаются к сырой позе, а не застывают
    // на последнем показанном кадре
    publishShownPose({ landmarks: [{ x: 1, y: 1 }], at: 5, mode: MODE.SYNC })
    publishShownPose({})

    expect(getShownPose().landmarks).toBeNull()
    expect(getShownPose().mode).toBe(MODE.LIVE)
  })
})

describe('очередь визуального ответа', () => {
  /**
   * Судят сырую свежую позу, а на экране поза постарше — на задержку показа.
   * Без очереди вспышка зачёта появлялась раньше, чем показанная рука доходила
   * до мишени: человек видел ответ по пустому месту.
   */

  const sync = (at) => ({ mode: MODE.SYNC, at })
  const live = (at = 0) => ({ mode: MODE.LIVE, at })

  it('ответ ждёт свой кадр и раньше времени не показывается', () => {
    const shown = []
    const queue = createShowQueue()

    // событие принято по кадру, снятому в 1100; на экране пока 1000
    expect(queue.push(1100, () => shown.push('вспышка'), sync(1000), 0)).toBe(true)
    queue.drain(sync(1000), 10)
    expect(shown).toEqual([])
    expect(queue.size).toBe(1)

    // картинка почти дошла — всё ещё рано
    queue.drain(sync(1099), 20)
    expect(shown).toEqual([])

    // кадр на экране: вот теперь
    queue.drain(sync(1100), 30)
    expect(shown).toEqual(['вспышка'])
    expect(queue.size).toBe(0)
  })

  it('в живом режиме показывается сразу, минуя очередь', () => {
    // там показ и судейство идут по одной позе, ждать нечего
    const shown = []
    const queue = createShowQueue()

    expect(queue.push(1100, () => shown.push('вспышка'), live(), 0)).toBe(false)
    expect(shown).toEqual(['вспышка'])
    expect(queue.size).toBe(0)
  })

  it('режим упал на живой с непустой очередью — ответы не теряются', () => {
    const shown = []
    const queue = createShowQueue()
    queue.push(5000, () => shown.push('вспышка'), sync(1000), 0)

    queue.drain(live(), 10)
    expect(shown).toEqual(['вспышка'])
  })

  it('порядок сохраняется: ответы показываются в том же порядке, что и приняты', () => {
    const shown = []
    const queue = createShowQueue()
    queue.push(100, () => shown.push('первый'), sync(0), 0)
    queue.push(200, () => shown.push('второй'), sync(0), 0)
    queue.push(300, () => shown.push('третий'), sync(0), 0)

    queue.drain(sync(200), 10)
    expect(shown).toEqual(['первый', 'второй'])
    queue.drain(sync(300), 20)
    expect(shown).toEqual(['первый', 'второй', 'третий'])
  })

  it('точка показа встала — ответ всё равно прозвучит', () => {
    /**
     * Камера отвалилась, телефон ушёл в себя. Молча проглотить ответ на
     * движение нельзя: человек прочитает молчание как «игра меня не увидела».
     */
    const shown = []
    const queue = createShowQueue()
    queue.push(9999, () => shown.push('вспышка'), sync(1000), 1000)

    queue.drain(sync(1000), 1000 + SHOW_WAIT_MAX_MS - 1)
    expect(shown).toEqual([])

    queue.drain(sync(1000), 1000 + SHOW_WAIT_MAX_MS)
    expect(shown).toEqual(['вспышка'])
  })

  it('очередь не течёт: снятый экран уносит её с собой', () => {
    const shown = []
    const queue = createShowQueue()
    queue.push(1100, () => shown.push('вспышка'), sync(1000), 0)
    queue.push(1200, () => shown.push('вторая'), sync(1000), 0)

    queue.clear()
    expect(queue.size).toBe(0)
    // и разбор пустой очереди ничего не показывает и не падает
    queue.drain(sync(9999), 10)
    expect(shown).toEqual([])
  })

  it('ответ, поставленный из обработчика, ждёт следующего разбора', () => {
    // иначе очередь разбиралась бы сама в себя и могла уйти в бесконечный круг
    const shown = []
    const queue = createShowQueue()
    queue.push(
      100,
      () => {
        shown.push('первый')
        queue.push(100, () => shown.push('вложенный'), sync(1000), 10)
      },
      sync(0),
      0,
    )

    queue.drain(sync(1000), 10)
    expect(shown).toEqual(['первый'])
    expect(queue.size).toBe(1)
  })

  it('без метки времени ждать нечего — показывается сразу', () => {
    // поза ещё ни разу не приходила: отложить такое событие значило бы потерять
    const shown = []
    const queue = createShowQueue()
    expect(queue.push(undefined, () => shown.push('вспышка'), sync(1000), 0)).toBe(false)
    expect(shown).toEqual(['вспышка'])
  })
})

describe('откат на живое видео', () => {
  it('без requestVideoFrameCallback синхронного показа нет вовсе', () => {
    // копировать было бы нечего: rAF срабатывает чаще кадров камеры, и буфер
    // наполнялся бы копиями одного и того же
    expect(chooseSyncMode({ hasVideoFrameCallback: false })).toBe(MODE.LIVE)
    expect(chooseSyncMode({ hasVideoFrameCallback: true })).toBe(MODE.SYNC)
  })

  it('ключ ?livecam=1 возвращает прежний режим для сравнения в поле', () => {
    expect(isLiveCamForced('?livecam=1')).toBe(true)
    expect(isLiveCamForced('?day=3&livecam=1')).toBe(true)
    expect(isLiveCamForced('?livecam=0')).toBe(false)
    expect(isLiveCamForced('')).toBe(false)
    expect(isLiveCamForced(undefined)).toBe(false)

    expect(chooseSyncMode({ hasVideoFrameCallback: true, forceLive: true })).toBe(MODE.LIVE)
  })

  it('кадры кончились — уходим на живое видео', () => {
    expect(fallbackReason({ sinceLastFrameMs: SYNC_STALL_MS + 1, frameIntervalMs: 33, frames: 12 }))
      .toBe('stalled')
    expect(fallbackReason({ sinceLastFrameMs: 100, frameIntervalMs: 33, frames: 12 })).toBeNull()
  })

  it('телефон не тянет копирование — тоже уходим', () => {
    // реже 12–13 кадров в секунду картинка рвётся сама по себе, и синхронность
    // её уже не спасает
    const slow = { sinceLastFrameMs: 100, frameIntervalMs: SYNC_MAX_INTERVAL_MS + 1, frames: 12 }
    expect(fallbackReason(slow)).toBe('slow')
  })

  it('первые кадры всегда рваные — по ним не судим', () => {
    const warmup = {
      sinceLastFrameMs: 100,
      frameIntervalMs: SYNC_MAX_INTERVAL_MS + 100,
      frames: SYNC_WARMUP_FRAMES - 1,
    }
    expect(fallbackReason(warmup)).toBeNull()
  })
})
