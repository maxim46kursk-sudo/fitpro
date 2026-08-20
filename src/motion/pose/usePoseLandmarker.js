import { useCallback, useEffect, useRef, useState } from 'react'
import { createMainThreadRunner } from './mainThreadRunner.js'
import { logEvent } from '../debug/logShipper.js'
import { noteStage } from '../debug/stageMeter.js'
import { assetSources } from './assets.js'

/**
 * Инициализация PoseLandmarker в воркере + прокачка кадров из <video>.
 *
 * Главный поток не делает инференс вообще: он только режет кадр в ImageBitmap
 * и отдаёт его воркеру. Следующий кадр уходит лишь после ответа на предыдущий —
 * так очередь не растёт, а лишние кадры просто пропускаются.
 */

/**
 * ГДЕ ЛЕЖИТ ДВИЖОК И МОДЕЛЬ — решает pose/assets.js. Там же и запасной путь на
 * прежний CDN, и настройка сборки, которой источник переопределяют.
 *
 * Список источников берётся ОДИН РАЗ на всё время жизни хука: он не должен
 * меняться под ногами у уже начавшейся загрузки, а перечитывать настройку
 * сборки в рантайме всё равно неоткуда.
 */

/** Целевая частота инференса. Быстрее модель всё равно не успевает, а батарею жрёт. */
const TARGET_FPS = 30
const MIN_FRAME_INTERVAL_MS = 1000 / TARGET_FPS
/** Кадр перед инференсом ужимаем: модели хватает, CPU/GPU экономится заметно. */
const INFERENCE_WIDTH = 480
/** Если ответа на кадр нет дольше этого — считаем кадр потерянным и идём дальше. */
const STALL_TIMEOUT_MS = 2000
/**
 * Первый detectForVideo компилирует шейдеры и легально занимает секунды
 * (замер на headless-GPU: 5.8 с). До первого результата сторож должен молчать,
 * иначе он засчитывает прогрев как зависание.
 */
const COLD_STALL_TIMEOUT_MS = 30000

/**
 * Захват кадра из <video> с даунскейлом.
 *
 * WebKit (Safari, любой браузер на iOS) не поддерживает опции ресайза
 * в createImageBitmap — вызов бросает TypeError. Раньше это ловил catch,
 * кадр молча пропускался, и в воркер не уходило НИ ОДНОГО кадра: приложение
 * открывалось, но не считало ничего. Поэтому здесь честный фолбэк через canvas,
 * а выбранный способ виден в диагностической панели.
 *
 * @param {{mode: 'auto'|'bitmap'|'canvas', canvas: HTMLCanvasElement|null}} state
 */
async function grabFrame(video, width, height, state) {
  if (state.mode !== 'canvas') {
    try {
      const bitmap = await createImageBitmap(video, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'low',
      })
      state.mode = 'bitmap'
      return bitmap
    } catch {
      state.mode = 'canvas'
    }
  }

  if (!state.canvas) state.canvas = document.createElement('canvas')
  const canvas = state.canvas
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0, width, height)
  return createImageBitmap(canvas)
}

export function usePoseLandmarker({ videoRef, active = true, onResult }) {
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [errorCode, setErrorCode] = useState(null)
  /** Техническая причина — показываем мелким шрифтом, чтобы её можно было переслать. */
  const [errorDetail, setErrorDetail] = useState(null)
  const [delegate, setDelegate] = useState(null)
  /** Первый detectForVideo прогревает шейдеры и занимает секунды — до него UI врёт. */
  const [warm, setWarm] = useState(false)
  /** Прогресс загрузки: на медленной сети 8.4 МБ качаются заметно долго. */
  const [progress, setProgress] = useState({ stage: 'wasm', loaded: 0, total: 0 })
  /** Где считается кадр: 'worker' или 'main' (резерв для WebKit). */
  const [thread, setThread] = useState('worker')
  /**
   * Счётчик попыток поднять движок. До сих пор попытка была одна, а «попробовать
   * снова» на экране ошибки означало `location.reload()` — внутри FitPro это
   * перезагрузка чужого приложения. Пересобирать надо движок: файлы после
   * неудачной попытки уже в HTTP-кэше, и повтор обходится дёшево.
   */
  const [attempt, setAttempt] = useState(0)
  const warmRef = useRef(false)

  const retry = useCallback(() => {
    setErrorCode(null)
    setErrorDetail(null)
    setStatus('loading')
    setWarm(false)
    warmRef.current = false
    setProgress({ stage: 'wasm', loaded: 0, total: 0 })
    setAttempt((n) => n + 1)
  }, [])

  /** Источники движка и модели: свой бакет, потом прежний CDN. */
  const sourcesRef = useRef(null)
  if (!sourcesRef.current) sourcesRef.current = assetSources()

  const workerRef = useRef(null)
  const readyRef = useRef(false)
  const pendingRef = useRef(false)
  const rafRef = useRef(0)
  const lastSentAtRef = useRef(0)
  const pendingSinceRef = useRef(0)
  /** Способ захвата кадра: bitmap (быстрый) или canvas (фолбэк для WebKit). */
  const grabRef = useRef({ mode: 'auto', canvas: null })
  const onResultRef = useRef(onResult)

  /** Последний результат — читается напрямую из canvas-цикла, без ререндера React. */
  const latestRef = useRef({
    landmarks: null,
    worldLandmarks: null,
    timestamp: 0,
    frameW: 0,
    frameH: 0,
  })
  /**
   * РАЗМЕР КАДРА, УШЕДШЕГО В ИНФЕРЕНС, — едет вместе с результатом.
   *
   * Нормированные точки без него неполны: на неквадратном кадре одна и та же
   * нормированная величина по x и по y — это разные расстояния в пикселях, и
   * угол, посчитанный по кадру, без поправки врёт (aspectOf в pose/geometry.js).
   * Полевой разбор 18 августа: iPhone отдаёт ландшафтные 640x480, Redmi —
   * портретные 480x640, и поправки у них обратные друг другу.
   *
   * В полёте всегда ровно один кадр (pendingRef), поэтому размер, записанный
   * при отправке, и есть размер того кадра, на который придёт ответ.
   */
  const sentSizeRef = useRef({ w: 0, h: 0 })
  /**
   * Телеметрия пайплайна. Нужна, чтобы разбирать жалобы вида «на втором подходе
   * считает хуже»: видно, просел ли fps (троттлинг), выросло ли время инференса,
   * растёт ли задержка «кадр камеры -> результат», не ушёл ли делегат на CPU.
   */
  const fpsRef = useRef({
    value: 0,
    frames: 0,
    windowStartedAt: 0,
    inferenceMs: 0,
    // за сессию
    fpsMin: null,
    fpsMax: null,
    fpsSum: 0,
    fpsWindows: 0,
    inferenceMax: 0,
    inferenceSum: 0,
    inferenceCount: 0,
    latencyMs: 0,
    latencyMax: 0,
    dropped: 0,
    stalls: 0,
    grabErrors: 0,
    results: 0,
    grabMode: 'auto',
    delegate: null,
    delegateSwitches: 0,
  })

  onResultRef.current = onResult

  // --- движок инференса живёт один раз на всё время жизни модуля ---
  useEffect(() => {
    let disposed = false
    /** Резерв запускается только один раз, иначе можно уйти в цикл. */
    let fellBack = false

    const spawnWorker = () => {
      const w = new Worker(new URL('./poseWorker.js', import.meta.url), {
        type: 'module',
        name: 'pose-landmarker',
      })
      w.onmessage = handleMessage
      w.onerror = handleWorkerError
      return w
    }

    /**
     * Воркер не поднялся — переключаемся на главный поток.
     * Сеть к этому моменту отработала, файлы в HTTP-кэше, поэтому повторная
     * инициализация обходится дёшево.
     */
    const fallbackToMainThread = (why) => {
      if (fellBack || disposed) return
      fellBack = true
      console.warn('[motion] воркер не поднялся, считаем на главном потоке:', why)
      logEvent('worker.fallback', { why: String(why).slice(0, 300) })

      try {
        workerRef.current?.terminate?.()
      } catch {
        // уже мёртв
      }

      const runner = createMainThreadRunner()
      runner.onmessage = handleMessage
      workerRef.current = runner
      readyRef.current = false
      pendingRef.current = false
      setThread('main')
      setStatus('loading')
      setErrorCode(null)
      runner.postMessage({ type: 'init', sources: sourcesRef.current, delegate: 'GPU' })
    }

    const handleWorkerError = (e) => {
      fallbackToMainThread(e?.message || 'ошибка воркера')
    }

    const handleMessage = (event) => {
      const data = event.data

      if (data.type === 'progress') {
        setProgress({ stage: data.stage, loaded: data.loaded || 0, total: data.total || 0 })
        return
      }

      /**
       * ОТКУДА ВЗЯЛИСЬ ФАЙЛЫ — в лог, обеими строками.
       *
       * `assets.source` пишется всегда: без него по логу не отличить телефон,
       * который взял всё со своего сервера, от телефона, который тихо ушёл на
       * прежний CDN, — а это ровно тот вопрос, ради которого переезд и делался.
       *
       * `assets.fallback` — отклонение: свой источник не ответил или отдал не то.
       * Одна такая строка в поле означает, что бакет лёг, и узнать об этом надо
       * не от человека, у которого «долго грузится».
       */
      if (data.type === 'assets') {
        if (data.event === 'fallback') {
          logEvent('assets.fallback', { from: data.from, to: data.to, reason: data.reason })
        } else {
          logEvent('assets.source', { from: data.from })
        }
        return
      }

      if (data.type === 'ready') {
        logEvent('model.ready', { delegate: data.delegate, thread: data.thread || 'worker' })
        readyRef.current = true
        const counter = fpsRef.current
        if (counter.delegate && counter.delegate !== data.delegate) counter.delegateSwitches += 1
        counter.delegate = data.delegate
        setDelegate(data.delegate)
        setStatus('ready')
        return
      }

      if (data.type === 'result') {
        pendingRef.current = false
        warmRef.current = true
        setWarm(true)
        latestRef.current = {
          landmarks: data.landmarks,
          worldLandmarks: data.worldLandmarks,
          timestamp: data.timestamp,
          // размер кадра, по которому эти точки посчитаны: без него угол,
          // считаемый по кадру, не с чем соотнести
          frameW: sentSizeRef.current.w,
          frameH: sentSizeRef.current.h,
        }

        const counter = fpsRef.current
        counter.frames += 1
        counter.results += 1
        // стадия «инференс»: воркер меряет её сам и присылает с ответом
        noteStage('inference', data.inferenceMs)
        counter.inferenceMs = data.inferenceMs
        counter.inferenceSum += data.inferenceMs
        counter.inferenceCount += 1
        if (data.inferenceMs > counter.inferenceMax) counter.inferenceMax = data.inferenceMs

        const now = performance.now()
        // задержка «кадр захвачен -> результат пришёл»: если очередь копится,
        // она растёт, даже когда сам инференс быстрый
        const latency = now - data.timestamp
        counter.latencyMs = latency
        if (latency > counter.latencyMax) counter.latencyMax = latency

        if (now - counter.windowStartedAt >= 1000) {
          counter.value = Math.round((counter.frames * 1000) / (now - counter.windowStartedAt))
          counter.frames = 0
          counter.windowStartedAt = now
          // первое окно после старта считаем прогревочным и в статистику не берём
          if (counter.fpsWindows > 0 || counter.value > 0) {
            counter.fpsWindows += 1
            counter.fpsSum += counter.value
            if (counter.fpsMin == null || counter.value < counter.fpsMin) counter.fpsMin = counter.value
            if (counter.fpsMax == null || counter.value > counter.fpsMax) counter.fpsMax = counter.value
          }
        }

        onResultRef.current?.(latestRef.current)
        return
      }

      if (data.type === 'dropped') {
        pendingRef.current = false
        fpsRef.current.dropped += 1
        return
      }

      if (data.type === 'error') {
        pendingRef.current = false
        // Пользователю показываем человеческий текст, в консоль — техническую причину.
        console.error('[motion]', data.code, data.stage || '', data.message)
        logEvent('model.error', { code: data.code, stage: data.stage, message: data.message })
        if (data.code === 'MODEL_INIT_FAILED' && !fellBack) {
          // движок не поднялся в воркере — это ещё не приговор
          fallbackToMainThread(data.message)
          return
        }
        if (data.code !== 'INFERENCE_FAILED') {
          readyRef.current = false
          setStatus('error')
          setErrorCode(data.code)
          setErrorDetail(data.message || null)
        }
      }
    }

    const worker = spawnWorker()
    workerRef.current = worker

    worker.postMessage({ type: 'init', sources: sourcesRef.current, delegate: 'GPU' })

    return () => {
      disposed = true
      try {
        workerRef.current?.postMessage({ type: 'close' })
        workerRef.current?.terminate?.()
      } catch {
        // уже закрыт
      }
      workerRef.current = null
      readyRef.current = false
    }
  }, [attempt])

  // --- насос кадров ---
  useEffect(() => {
    if (!active) return undefined

    let stopped = false

    const pump = async () => {
      if (stopped) return
      rafRef.current = requestAnimationFrame(pump)

      const video = videoRef.current
      const worker = workerRef.current
      if (!worker || !readyRef.current) return

      const now = performance.now()

      // Сторож зависшего кадра: если ответ на предыдущий кадр потерялся,
      // насос встал бы навсегда и приложение молча перестало бы считать.
      if (pendingRef.current) {
        const limit = warmRef.current ? STALL_TIMEOUT_MS : COLD_STALL_TIMEOUT_MS
        if (now - pendingSinceRef.current <= limit) return
        pendingRef.current = false
        fpsRef.current.stalls += 1
      }

      if (!video || video.readyState < 2 || !video.videoWidth) return
      if (now - lastSentAtRef.current < MIN_FRAME_INTERVAL_MS) return
      lastSentAtRef.current = now

      pendingRef.current = true
      pendingSinceRef.current = now
      try {
        // В воркер уходит ВЕСЬ кадр: кадр не обрезается, обе стороны
        // уменьшаются одним коэффициентом. object-fit: contain влияет только
        // на отображение — модель видит полное поле зрения камеры.
        const scale = Math.min(1, INFERENCE_WIDTH / video.videoWidth)
        const width = Math.round(video.videoWidth * scale)
        const height = Math.round(video.videoHeight * scale)
        // размер запоминается ДО отправки: с ним результат и вернётся
        sentSizeRef.current = { w: width, h: height }
        // стадия «захват»: сколько стоит вынуть кадр из видео
        const grabAt = performance.now()
        const bitmap = await grabFrame(video, width, height, grabRef.current)
        noteStage('grab', performance.now() - grabAt, grabAt)
        fpsRef.current.grabMode = grabRef.current.mode
        if (stopped) {
          bitmap.close()
          return
        }
        worker.postMessage({ type: 'frame', bitmap, timestamp: Math.round(now) }, [bitmap])
      } catch (error) {
        // Кадр мог не успеть отрисоваться — пропускаем. Но считаем: если
        // захват падает КАЖДЫЙ раз, приложение молча перестаёт видеть человека,
        // и это должно быть видно в панели, а не выясняться в поле.
        pendingRef.current = false
        const c = fpsRef.current
        c.grabErrors += 1
        if (c.grabErrors === 1) {
          console.error('[motion] не удалось захватить кадр:', error)
          logEvent('frame.grabError', { message: String(error?.message || error) })
        }
      }
    }

    rafRef.current = requestAnimationFrame(pump)

    return () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      pendingRef.current = false
    }
  }, [active, videoRef])

  return {
    status,
    errorCode,
    errorDetail,
    progress,
    delegate,
    thread,
    warm,
    latestRef,
    fpsRef,
    retry,
  }
}
