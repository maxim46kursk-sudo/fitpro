import { useEffect, useRef } from 'react'
import { POSE_CONNECTIONS, MIN_VISIBILITY, visibilityOf } from '../pose/landmarks.js'
import { fitContain, projectX, projectY } from '../pose/viewport.js'
import { lerpPose, poseMix, poseMixAt } from '../pose/interpolate.js'
import {
  MODE,
  chooseSyncMode,
  createFrameBuffer,
  fallbackReason,
  isLiveCamForced,
  publishShownPose,
  smoothLatency,
  syncLag,
} from '../pose/frameSync.js'
import { pushLive } from '../debug/diagnostics.js'

/**
 * <video> с камерой + <canvas>, на котором живёт вся картинка.
 * Оба слоя лежат в общей обёртке с transform: scaleX(-1) — «зеркало»,
 * как в фитнес-приложениях: человек видит себя, а не свою инверсию.
 *
 * Рисование идёт в собственном rAF-цикле и читает latestRef напрямую,
 * поэтому ререндеров React на каждый кадр не происходит.
 *
 * ДВА РЕЖИМА ПОКАЗА.
 *
 *   СИНХРОННЫЙ (по умолчанию). <video> скрыт, но продолжает крутиться — он
 *     остаётся источником кадров для инференса. Кадры копятся в кольцевом
 *     буфере (pose/frameSync.js), и в каждом кадре экрана рисуется НЕ самый
 *     свежий кадр камеры, а тот, для которого уже посчитана поза. Картинка
 *     отстаёт от реальности на задержку инференса — этого не видно, сравнивать
 *     не с чем. А расхождение картинки со скелетом видно всегда, и здесь его
 *     нет по построению.
 *
 *   ЖИВОЙ (резерв). Прежнее поведение: <video> показывает камеру, скелет
 *     рисуется поверх с интерполяцией между результатами. Включается сам, если
 *     нет requestVideoFrameCallback или телефон не тянет копирование кадров, и
 *     руками — ключом `?livecam=1` для сравнения режимов в поле.
 *
 * Судейство не видит ни того, ни другого: сюда приходит тот же latestRef, что и
 * в детекторы, но менять его мы не можем и не пытаемся — и буфер кадров, и
 * промежуточные позы живут только в пикселях и дальше этого файла не уходят.
 */
export default function CameraView({
  videoRef,
  stream,
  latestRef,
  showSkeleton = true,
  accent = '#3ddc97',
  children,
}) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const showSkeletonRef = useRef(showSkeleton)
  const accentRef = useRef(accent)

  showSkeletonRef.current = showSkeleton
  accentRef.current = accent

  // Поток -> <video>
  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    video.srcObject = stream
    const play = () => video.play().catch(() => {})
    play()
    video.addEventListener('loadedmetadata', play)
    return () => video.removeEventListener('loadedmetadata', play)
  }, [stream, videoRef])

  // --- насос кадров камеры в буфер: только для синхронного показа ---
  const bufferRef = useRef(null)
  const modeRef = useRef(MODE.LIVE)
  /**
   * Как идут кадры камеры: сглаженный интервал между ними и время последнего.
   * По ним отрисовка решает, тянет ли телефон синхронный показ, — считает их
   * насос, а смотрит цикл отрисовки, отсюда и общая ссылка.
   */
  const frameStatsRef = useRef({ intervalMs: 0, lastAt: 0 })

  useEffect(() => {
    const video = videoRef.current
    const hasRvfc = typeof video?.requestVideoFrameCallback === 'function'
    const mode = chooseSyncMode({
      hasVideoFrameCallback: hasRvfc,
      forceLive: isLiveCamForced(globalThis.location?.search),
    })
    modeRef.current = mode
    pushLive({ videoSync: mode, videoSyncWhy: hasRvfc ? null : 'нет requestVideoFrameCallback' })

    if (mode !== MODE.SYNC || !video) return undefined

    const buffer = createFrameBuffer({ createCanvas: () => document.createElement('canvas') })
    bufferRef.current = buffer

    const stats = frameStatsRef.current
    stats.intervalMs = 0
    stats.lastAt = 0

    let handle = 0
    let stopped = false

    const onFrame = () => {
      // откатились на живое видео — копировать больше незачем, и цепочка
      // вызовов на этом обрывается: на слабом телефоне это как раз та работа,
      // из-за которой откат и случился
      if (stopped || modeRef.current !== MODE.SYNC) return
      handle = video.requestVideoFrameCallback(onFrame)

      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return

      const at = performance.now()
      // интервал сглаженный: одиночный пропуск кадра не должен считаться
      // «телефон не тянет», а стойкая просадка обязана
      if (stats.lastAt) stats.intervalMs = smoothLatency(stats.intervalMs, at - stats.lastAt, 0.3)
      stats.lastAt = at

      /**
       * Копия кадра в РОДНОМ разрешении видео и в переиспользуемый canvas:
       * новых аллокаций на кадр нет, а масштабирование под экран делает уже
       * отрисовка — там оно всё равно неизбежно.
       */
      const slot = buffer.acquire(at, w, h)
      try {
        const c2d = slot.ctx ?? (slot.ctx = slot.canvas.getContext('2d'))
        c2d.drawImage(video, 0, 0, w, h)
      } catch {
        // кадр мог не успеть отрисоваться — пропускаем, следующий придёт
      }
    }

    handle = video.requestVideoFrameCallback(onFrame)

    return () => {
      stopped = true
      try {
        video.cancelVideoFrameCallback?.(handle)
      } catch {
        // элемент уже мёртв
      }
      buffer.clear()
      bufferRef.current = null
    }
    // буфер заводится один раз на всё время жизни камеры: поток может смениться,
    // а элемент <video> и режим показа — нет
  }, [videoRef])

  // Цикл отрисовки
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return undefined

    const ctx = canvas.getContext('2d')
    let raf = 0
    let stopped = false
    // фактически применённый object-fit — в панель, чтобы кроп было видно сразу
    let reportedFit = null
    /** С какого момента от камеры ЖДУТ кадров: до этого молчание законно. */
    let awaitingSince = 0

    /**
     * Две последние позы. Хранится и время ПРИХОДА (для живого режима: там
     * отставание меряется по часам отрисовки), и время ЗАХВАТА кадра, по
     * которому поза посчитана, — оно приходит в самом результате и служит
     * опорой синхронному режиму.
     *
     * Новый результат узнаётся по смене объекта: хук заменяет latestRef.current
     * целиком, и сравнение по ссылке здесь надёжнее сравнения меток.
     */
    let prev = null
    let cur = null
    /** Сглаженная задержка «захват -> результат». */
    let latency = null

    const goLive = (why) => {
      if (modeRef.current !== MODE.SYNC) return
      modeRef.current = MODE.LIVE
      bufferRef.current?.clear()
      pushLive({ videoSync: MODE.LIVE, videoSyncWhy: why })
    }

    const draw = () => {
      if (stopped) return
      raf = requestAnimationFrame(draw)

      const dpr = window.devicePixelRatio || 1
      const cw = wrap.clientWidth
      const ch = wrap.clientHeight
      if (!cw || !ch) return

      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)

      const video = videoRef.current

      if (video) {
        const fitMode = getComputedStyle(video).objectFit
        if (fitMode !== reportedFit) {
          reportedFit = fitMode
          pushLive({ videoFit: fitMode })
        }
      }

      const sync = modeRef.current === MODE.SYNC
      const buffer = bufferRef.current

      const now = performance.now()
      const frame = latestRef?.current
      if (frame?.landmarks && frame !== cur?.frame) {
        const captureAt = frame.timestamp ?? now
        prev = cur
        cur = {
          frame,
          at: now,
          captureAt,
          /**
           * Время ПОКАЗАННОГО кадра, с которого эта поза посчитана: метку
           * результату ставит насос в момент захвата, а кадр к этому моменту
           * уже висел на экране. Обе величины — картинка и поза — должны
           * мериться одними часами, иначе скелет отстаёт на полкадра просто из
           * арифметики.
           */
          frameAt: buffer?.latestBefore(captureAt)?.at ?? captureAt,
        }
        // задержка «захват -> результат»: ровно то, на что обязан отстать показ
        latency = smoothLatency(latency, now - captureAt)
      }

      /**
       * ТОЧКА ПОКАЗА — время, которому соответствует и картинка, и скелет.
       * Отстаёт от «сейчас» на задержку инференса плюс интервал между
       * результатами (тогда она всё время лежит между двумя известными позами,
       * см. syncLag) и не дальше, чем хватает буфера: показать нечего — не
       * показываем, а не рисуем чёрный экран.
       */
      let shot = null
      let displayAt = now
      if (sync && buffer) {
        // интервал берётся по меткам ПОКАЗА кадров, а не прихода результатов:
        // точка показа живёт на той же шкале, что и буфер
        const span = prev && cur ? cur.frameAt - prev.frameAt : 0
        displayAt = now - syncLag(latency ?? 0, span)
        const oldest = buffer.oldestAt()
        if (oldest != null && displayAt < oldest) displayAt = oldest
        shot = buffer.nearest(displayAt)
        // скелет привязывается к ТОМУ ЖЕ кадру, который показан: разойтись они
        // не могут по построению, даже если буфер отдал соседний кадр
        if (shot) displayAt = shot.at

        /**
         * Кадров ждём только с того момента, как видео их отдаёт: пока камера
         * поднимается, молчание законно и откатываться не на что.
         */
        const playing = video?.readyState >= 2 && !video.paused
        if (!playing) awaitingSince = 0
        else if (!awaitingSince) awaitingSince = now

        const stats = frameStatsRef.current
        const why = awaitingSince
          ? fallbackReason({
              sinceLastFrameMs: now - (stats.lastAt || awaitingSince),
              frameIntervalMs: stats.intervalMs,
              frames: buffer.size,
            })
          : null
        if (why) goLive(why)
      }

      const fit = video?.videoWidth ? fitContain(video.videoWidth, video.videoHeight, cw, ch) : null

      /**
       * <video> прячется РОВНО ТОГДА, когда есть чем его заменить, — и только
       * видимостью: размонтируй его или сними с потока, и считать станет нечего,
       * он же источник кадров для инференса.
       *
       * Порядок именно такой (сначала кадр из буфера, потом решение) на случай,
       * когда синхронный режим выбран, а кадры так и не пошли: человек увидит
       * живую камеру, а не пустой экран.
       */
      if (video) {
        const hide = shot && fit ? 'hidden' : ''
        if (video.style.visibility !== hide) video.style.visibility = hide
      }

      if (shot && fit) {
        // поля вокруг кадра — чёрные: <video> со своим фоном скрыт, и под
        // canvas-ом просвечивал бы экран
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, cw, ch)
        ctx.drawImage(shot.canvas, fit.ox, fit.oy, fit.dw, fit.dh)
      }

      /**
       * Пока пришла одна поза, смешивать не с чем — рисуем её как есть. Так же
       * выглядит и первый кадр после потери человека: подмешивать к свежей позе
       * ту, что была до пропажи, нельзя — между ними человек мог переставить
       * ноги, и скелет проехал бы через полкадра.
       */
      let landmarks = cur?.frame?.landmarks ?? null
      if (prev && cur) {
        landmarks = sync
          ? /**
             * Синхронный режим: поза выравнивается на время ЗАХВАТА показанного
             * кадра. Поточечная скоростная логика тут выключена — она подтянула
             * бы быструю точку к свежей позе, то есть вперёд картинки.
             */
            lerpPose(
              prev.frame.landmarks,
              cur.frame.landmarks,
              poseMixAt(prev.frameAt, cur.frameAt, displayAt),
              { adaptive: false },
            )
          : lerpPose(prev.frame.landmarks, cur.frame.landmarks, poseMix(prev.at, cur.at, now))
      }

      /**
       * Показанная поза — наружу, тем, кто рисует поверх картинки: мишени боя
       * висят на теле, и тело им нужно то же самое, которое видит человек.
       * Публикуется ДО проверок отрисовки скелета: скелет можно и спрятать, а
       * мишени висят всегда.
       */
      publishShownPose({
        landmarks,
        at: sync ? displayAt : now,
        mode: sync ? MODE.SYNC : MODE.LIVE,
      })

      if (!showSkeletonRef.current || !landmarks || !fit) return

      // кадр вписан через object-fit: contain — повторяем ровно ту же
      // трансформацию для точек, иначе скелет уедет относительно тела.
      const toX = (x) => projectX(x, fit)
      const toY = (y) => projectY(y, fit)

      const color = accentRef.current

      ctx.lineWidth = 4
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = landmarks[a]
        const pb = landmarks[b]
        if (!pa || !pb) continue
        if (visibilityOf(pa) < MIN_VISIBILITY || visibilityOf(pb) < MIN_VISIBILITY) continue
        ctx.moveTo(toX(pa.x), toY(pa.y))
        ctx.lineTo(toX(pb.x), toY(pb.y))
      }
      ctx.stroke()

      ctx.globalAlpha = 1
      ctx.fillStyle = '#ffffff'
      for (const p of landmarks) {
        if (visibilityOf(p) < MIN_VISIBILITY) continue
        ctx.beginPath()
        ctx.arc(toX(p.x), toY(p.y), 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    raf = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      const video = videoRef.current
      if (video) video.style.visibility = ''
      // на экране больше ничего нашего нет: оверлеи вернутся к сырой позе, а не
      // застынут на последнем показанном кадре
      publishShownPose({})
    }
  }, [latestRef, videoRef])

  return (
    <div className="mt-stage">
      <div className="mt-mirror" ref={wrapRef}>
        <video ref={videoRef} className="mt-video" playsInline muted autoPlay />
        <canvas ref={canvasRef} className="mt-overlay" />
      </div>
      {children}
    </div>
  )
}
