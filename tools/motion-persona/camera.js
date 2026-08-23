/**
 * ВИРТУАЛЬНАЯ КАМЕРА: холст, который приложение видит как <video> с камеры.
 *
 * ПОЧЕМУ НЕ `canvas.captureStream()`. Так было бы честнее всего — настоящий
 * MediaStream, настоящий `<video>`, ни одной подмены ниже getUserMedia. Но
 * WebKit его не умеет вовсе (проверено: `captureStream is not a function`), а
 * WebKit здесь не случайный выбор: оба браузера на iPhone — это он, и жалоба на
 * замедление пришла именно с телефона. Гонять прогон в Chromium ради красивой
 * подмены значило бы мерить не тот движок.
 *
 * ЧТО ПОДМЕНЯЕТСЯ И ГДЕ ПРОХОДИТ ГРАНИЦА. Подменяется РОВНО источник пикселей:
 *
 *   getUserMedia отдаёт заглушку потока (треки, getSettings, applyConstraints);
 *   элемент <video>, которому её присвоили, начинает отвечать размером кадра,
 *     readyState и requestVideoFrameCallback по нашим часам;
 *   createImageBitmap(video) и drawImage(video) читают наш холст.
 *
 * Всё остальное — настоящее и не тронуто: насос кадров, уменьшение до
 * INFERENCE_WIDTH, воркер, MediaPipe, кольцевой буфер кадров, синхронный показ,
 * судейство, мишени, отрисовка. Стадии grab/inference/judge/draw меряет сам
 * `debug/stageMeter.js`, и ни одна из них здесь не обходится.
 *
 * ЧЕСТНАЯ ОГОВОРКА ПРО `grab`. На телефоне эта стадия включает декодирование
 * кадра камеры, здесь — нет: пиксели уже лежат в холсте. Значит абсолютное
 * время `grab` в прогоне НИЖЕ, чем на телефоне. На вопрос «какая стадия растёт
 * по ходу сессии» это не влияет — рост ищется в наклоне, а не в уровне, — но
 * читать `grab` как «на телефоне будет столько же» нельзя.
 */
import { drawFigure, makeBackdrop } from './figure.js'

/** Кадр камеры. 640x480 — то, что отдаёт iPhone (полевой разбор 18 августа). */
const WIDTH = 640
const HEIGHT = 480
/** Частота камеры. Приложение просит `frameRate: {ideal: 30}` — столько и даём. */
const CAMERA_FPS = 30

/**
 * Заглушка видеотрека. Приложение спрашивает у него getSettings (пишет в
 * журнал разрешение и частоту), getCapabilities (сбрасывает зум) и stop.
 * Отвечать надо всем троим: `camera.degraded` пишется по ширине и частоте, и
 * молчащий трек попал бы в журнал как ослабленная камера.
 */
function makeTrack() {
  const listeners = new Set()
  return {
    kind: 'video',
    id: 'virtual-tester-video',
    label: 'virtual tester camera',
    enabled: true,
    muted: false,
    readyState: 'live',
    getSettings: () => ({
      width: WIDTH,
      height: HEIGHT,
      frameRate: CAMERA_FPS,
      facingMode: 'user',
      deviceId: 'virtual-tester',
    }),
    getCapabilities: () => ({ width: { max: WIDTH }, height: { max: HEIGHT } }),
    applyConstraints: async () => {},
    stop() {
      this.readyState = 'ended'
    },
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  }
}

function makeStream(track) {
  const stream = {
    id: 'virtual-tester-stream',
    active: true,
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track],
    addEventListener() {},
    removeEventListener() {},
  }
  // элемент <video> проверяет srcObject на instanceof MediaStream не везде, но
  // где проверяет — заглушка обязана его пройти
  if (typeof MediaStream === 'function') Object.setPrototypeOf(stream, MediaStream.prototype)
  return stream
}

/**
 * Поставить виртуальную камеру. Зовётся ДО того, как приложение смонтировано:
 * `useCamera` спрашивает getUserMedia в первом же эффекте.
 *
 * @param {object} options
 * @param {(nowMs: number) => number[]} options.poseAt откуда брать позу
 * @param {(pts: number[][], nowMs: number, w: number, h: number) => number[][]} [options.aim]
 *   поправка уже размещённых точек — дотягивание до мишени. Мишень приходит в
 *   нормированных координатах кадра, и перевести их в пиксели можно только
 *   здесь: рамку размещения человека знает камера, а не персонаж.
 * @param {(pts: number[][]) => void} [options.onFrame] отдать нарисованные точки наружу
 * @returns {{canvas: HTMLCanvasElement, stats: object}}
 */
export function installVirtualCamera({ poseAt, aim, onFrame }) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d', { alpha: false })
  const backdrop = makeBackdrop(WIDTH, HEIGHT)

  const stats = { frames: 0, startedAt: 0, lastAt: 0 }

  /**
   * РАЗМЕЩЕНИЕ ЧЕЛОВЕКА В КАДРЕ.
   *
   * Рост 78% высоты кадра — не произвольное число: `framingHint` требует
   * габарит тела выше 0.45 («подойди ближе»), а `coordOk` не прощает выход за
   * кадр больше чем на запас. Между этими двумя границами и стоит человек,
   * ближе к дальней: на телефоне люди отходят, чтобы влезть целиком.
   */
  const HEIGHT_FRAC = 0.78

  function toPixels(flat) {
    const pts = []
    for (let i = 0; i < 13; i += 1) pts.push([flat[i * 2], flat[i * 2 + 1]])
    let minY = Infinity
    let maxY = -Infinity
    for (const p of pts) {
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
    const span = maxY - minY || 1
    const scale = (HEIGHT * HEIGHT_FRAC) / span
    const midY = (minY + maxY) / 2
    return pts.map((p) => [WIDTH * 0.5 + p[0] * scale, HEIGHT * 0.52 + (p[1] - midY) * scale])
  }

  /** Часы кадров: свои, чтобы кадр рисовался ровно один раз на кадр камеры. */
  let raf = 0
  let nextFrameAt = 0
  const frameCallbacks = new Map()
  let cbSeq = 0

  const tick = () => {
    raf = requestAnimationFrame(tick)
    const now = performance.now()
    if (now < nextFrameAt) return
    // не догоняем пропущенные кадры: реальная камера их тоже не догоняет, она
    // просто отдаёт следующий. Догон превратил бы просадку в лавину рисования
    nextFrameAt = Math.max(now, nextFrameAt + 1000 / CAMERA_FPS)

    let pts = toPixels(poseAt(now))
    if (aim) pts = aim(pts, now, WIDTH, HEIGHT)
    drawFigure(ctx, pts, { backdrop, width: WIDTH, height: HEIGHT })
    stats.frames += 1
    if (!stats.startedAt) stats.startedAt = now
    stats.lastAt = now
    onFrame?.(pts)

    // те, кто ждал кадр видео, получают его здесь — как от настоящей камеры
    if (frameCallbacks.size) {
      const due = [...frameCallbacks.values()]
      frameCallbacks.clear()
      const meta = {
        presentationTime: now,
        expectedDisplayTime: now,
        width: WIDTH,
        height: HEIGHT,
        mediaTime: (now - stats.startedAt) / 1000,
        presentedFrames: stats.frames,
      }
      for (const fn of due) {
        try {
          fn(now, meta)
        } catch {
          // слушатель кадра упал — камера от этого останавливаться не должна
        }
      }
    }
  }
  raf = requestAnimationFrame(tick)

  const track = makeTrack()
  const stream = makeStream(track)

  // --- getUserMedia и список устройств ---
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
  }
  navigator.mediaDevices.getUserMedia = async () => stream
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'virtual-tester', label: 'virtual tester camera', groupId: 'vt' },
  ]

  /**
   * --- элемент <video>, которому отдали наш поток ---
   *
   * Помечаем сам элемент, а не подменяем его класс: приложение создаёт <video>
   * само, в своей вёрстке, со своими стилями и своим местом в дереве. Подмени
   * мы элемент — вместе с ним подменился бы и слой показа, то есть часть
   * стадии `draw`.
   */
  const MARK = Symbol.for('virtual-tester-video')
  const proto = HTMLVideoElement.prototype
  const srcObjectDesc =
    Object.getOwnPropertyDescriptor(proto, 'srcObject') ||
    Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')

  Object.defineProperty(proto, 'srcObject', {
    configurable: true,
    get() {
      return this[MARK] ? stream : srcObjectDesc?.get?.call(this)
    },
    set(value) {
      if (value === stream) {
        this[MARK] = true
        // событие метаданных приложение слушает, чтобы позвать play()
        setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0)
        return
      }
      this[MARK] = false
      srcObjectDesc?.set?.call(this, value)
    },
  })

  const define = (name, get) => {
    const original = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, {
      configurable: true,
      get() {
        return this[MARK] ? get() : original?.get?.call(this)
      },
    })
  }
  define('videoWidth', () => WIDTH)
  define('videoHeight', () => HEIGHT)
  // 4 = HAVE_ENOUGH_DATA: насос кадров требует readyState >= 2
  define('readyState', () => 4)

  const originalPlay = proto.play
  proto.play = function play() {
    if (this[MARK]) return Promise.resolve()
    return originalPlay.call(this)
  }

  const originalRvfc = proto.requestVideoFrameCallback
  proto.requestVideoFrameCallback = function rvfc(fn) {
    if (!this[MARK]) return originalRvfc?.call(this, fn)
    cbSeq += 1
    frameCallbacks.set(cbSeq, fn)
    return cbSeq
  }
  const originalCancel = proto.cancelVideoFrameCallback
  proto.cancelVideoFrameCallback = function cancel(handle) {
    if (!this[MARK]) return originalCancel?.call(this, handle)
    frameCallbacks.delete(handle)
    return undefined
  }

  /**
   * --- откуда берутся пиксели ---
   *
   * Обе точки, в которых приложение читает кадр: уменьшение перед инференсом
   * (`createImageBitmap`) и копия кадра в кольцевой буфер показа (`drawImage`).
   * Подменяется только ИСТОЧНИК; сама работа — масштабирование, декодирование в
   * bitmap, копия в холст — остаётся настоящей и по-прежнему попадает в стадию
   * `grab`.
   */
  const isFake = (src) => !!(src && src[MARK])

  const originalCIB = globalThis.createImageBitmap
  globalThis.createImageBitmap = function createImageBitmapPatched(source, ...rest) {
    return originalCIB.call(this, isFake(source) ? canvas : source, ...rest)
  }

  const originalDraw = CanvasRenderingContext2D.prototype.drawImage
  CanvasRenderingContext2D.prototype.drawImage = function drawImagePatched(source, ...rest) {
    return originalDraw.call(this, isFake(source) ? canvas : source, ...rest)
  }

  return {
    canvas,
    stats,
    stop() {
      cancelAnimationFrame(raf)
      frameCallbacks.clear()
    },
  }
}
