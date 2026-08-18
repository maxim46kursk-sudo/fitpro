/**
 * Резервный инференс на главном потоке.
 *
 * Зачем: в module-воркере WebKit (Safari и все браузеры на iOS) загрузчик wasm
 * у MediaPipe уходит в ветку с document.createElement, а document в воркере
 * не существует — «Can't find variable: document». Заглушка importScripts эту
 * ветку обходит, но на реальном устройстве всё равно не завелось, а отлаживать
 * внутренности чужой библиотеки вслепую можно бесконечно.
 *
 * На главном потоке document есть, и MediaPipe работает в своей штатной,
 * самой обкатанной конфигурации: обычная (не module) сборка wasm-лоадера
 * подключается тегом <script>. Цена — инференс делит поток с UI, поэтому
 * это именно резерв, а не замена воркеру.
 *
 * Объект намеренно повторяет интерфейс Worker (postMessage/terminate/onmessage),
 * чтобы вызывающий код не знал, где считается кадр.
 */

import { loadFromSources } from './assets.js'

export function createMainThreadRunner() {
  let landmarker = null
  let busy = false
  let lastTimestamp = -1
  let closed = false

  const runner = {
    onmessage: null,
    onerror: null,

    postMessage(message) {
      if (closed) return
      if (message?.type === 'init') void init(message)
      else if (message?.type === 'frame') handleFrame(message)
      else if (message?.type === 'close') close()
    },

    terminate() {
      close()
    },
  }

  const post = (data) => {
    if (!closed) runner.onmessage?.({ data })
  }

  function close() {
    closed = true
    try {
      landmarker?.close?.()
    } catch {
      // всё равно закрываемся
    }
    landmarker = null
  }

  /**
   * ИСТОЧНИКИ ПЕРЕБИРАЮТСЯ И ЗДЕСЬ — так же, как в воркере.
   *
   * Резерв на главном потоке поднимается тогда, когда воркер не завёлся вовсе,
   * и остаться при этом без запасного источника значило бы вот что: телефон, на
   * котором и воркер не работает, и свой бакет не ответил, не получил бы игру
   * совсем, хотя прежний CDN был доступен.
   *
   * Проверять содержимое здесь нечем: MediaPipe качает файлы сам, внутрь
   * createFromOptions не заглянуть. Поэтому за «отдал не то» тут отвечает
   * исключение из самого MediaPipe, а не наша проверка байтов, — на этом пути
   * это лучшее, что есть.
   */
  /**
   * ИСТОЧНИКИ ПЕРЕБИРАЮТСЯ И ЗДЕСЬ — тем же правилом, что в воркере
   * (loadFromSources в pose/assets.js).
   *
   * Резерв на главном потоке поднимается тогда, когда воркер не завёлся вовсе, и
   * остаться при этом без запасного источника значило бы вот что: телефон, на
   * котором и воркер не работает, и свой бакет не ответил, не получил бы игру
   * совсем, хотя прежний CDN был доступен.
   *
   * Проверять содержимое здесь нечем: MediaPipe качает файлы сам, внутрь
   * createFromOptions не заглянуть. Поэтому за «отдал не то» тут отвечает
   * исключение из самого MediaPipe, а не наша проверка байтов, — на этом пути
   * это лучшее, что есть.
   */
  async function init({ sources = [], delegate = 'GPU' }) {
    let vision
    let used = null

    post({ type: 'progress', stage: 'wasm' })
    // Динамический импорт: MediaPipe попадёт в отдельный чанк и скачается
    // только если резерв реально понадобился.
    const { FilesetResolver } = await import('@mediapipe/tasks-vision')

    try {
      const picked = await loadFromSources(
        sources,
        // БЕЗ второго аргумента: на главном потоке нужна обычная сборка лоадера,
        // её MediaPipe подключает тегом <script>. Module-вариант так подключить
        // нельзя — браузер споткнётся об export.
        (source) => FilesetResolver.forVisionTasks(source.wasmBase),
        (info) => post({ type: 'assets', event: 'fallback', ...info }),
      )
      used = picked.source
      vision = picked.value
    } catch (error) {
      post({
        type: 'error',
        code: 'MODEL_NETWORK_FAILED',
        stage: 'wasm',
        message: String(error?.message || error),
      })
      return
    }

    post({ type: 'assets', event: 'source', from: used.name })
    const modelAssetPath = used.modelUrl

    post({ type: 'progress', stage: 'init' })
    const { PoseLandmarker } = await import('@mediapipe/tasks-vision')
    const failures = []

    for (const current of delegate === 'GPU' ? ['GPU', 'CPU'] : [delegate]) {
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath, delegate: current },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        })
        post({ type: 'ready', delegate: current, thread: 'main' })
        return
      } catch (error) {
        failures.push(`${current}: ${String(error?.message || error)}`)
      }
    }

    post({
      type: 'error',
      code: 'MODEL_INIT_FAILED',
      stage: 'init',
      message: `главный поток — ${failures.join(' | ')}`,
    })
  }

  function handleFrame({ bitmap, timestamp }) {
    if (!landmarker || busy) {
      bitmap?.close?.()
      post({ type: 'dropped', timestamp })
      return
    }

    busy = true
    const ts = timestamp > lastTimestamp ? timestamp : lastTimestamp + 1
    lastTimestamp = ts

    const startedAt = performance.now()
    try {
      const result = landmarker.detectForVideo(bitmap, ts)
      const landmarks = result?.landmarks?.[0] ?? null
      const worldLandmarks = result?.worldLandmarks?.[0] ?? null
      post({
        type: 'result',
        timestamp,
        inferenceMs: performance.now() - startedAt,
        landmarks: landmarks ? landmarks.map(toPlain) : null,
        worldLandmarks: worldLandmarks ? worldLandmarks.map(toPlain) : null,
      })
    } catch (error) {
      post({
        type: 'error',
        code: 'INFERENCE_FAILED',
        message: String(error?.message || error),
      })
    } finally {
      bitmap?.close?.()
      busy = false
    }
  }

  return runner
}

function toPlain(p) {
  return { x: p.x, y: p.y, z: p.z, visibility: p.visibility }
}
