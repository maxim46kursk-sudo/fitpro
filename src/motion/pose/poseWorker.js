/**
 * Web Worker с инференсом MediaPipe PoseLandmarker.
 *
 * Протокол:
 *   main -> worker : { type: 'init', wasmBase, modelAssetPath, delegate }
 *                    { type: 'frame', bitmap, timestamp, width, height }
 *                    { type: 'close' }
 *   worker -> main : { type: 'ready', delegate }
 *                    { type: 'result', landmarks, worldLandmarks, timestamp, inferenceMs }
 *                    { type: 'dropped', timestamp }
 *                    { type: 'error', code, message }
 *
 * Главный поток шлёт следующий кадр только получив ответ на предыдущий,
 * так что очередь здесь физически не может накопиться.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { loadFromSources, looksLikeLoader, looksLikeModel, looksLikeWasm } from './assets.js'

/**
 * Заглушка importScripts — обязана стоять ДО любого вызова MediaPipe.
 *
 * Загрузчик wasm у MediaPipe устроен так:
 *
 *   if (typeof importScripts != "function") { document.createElement("script") ... }
 *   try { importScripts(url) } catch (e) {
 *     if (!(e instanceof TypeError)) throw e
 *     await import(url)                     // <- рабочая ветка
 *   }
 *
 * В module-воркере Chromium importScripts объявлен и бросает TypeError, поэтому
 * MediaPipe штатно переходит на dynamic import(). В module-воркере WebKit
 * (Safari и ЛЮБОЙ браузер на iOS, включая Chrome — на iOS все браузеры обязаны
 * использовать движок Apple) importScripts не объявлен вовсе, MediaPipe уходит
 * в первую ветку, а document в воркере не существует. Отсюда на телефоне было
 * «Can't find variable: document» на всех попытках инициализации.
 *
 * Объявляем заглушку, которая бросает ровно TypeError, — и WebKit идёт тем же
 * путём, что и Chromium, через import(). Никаких внутренностей библиотеки
 * при этом не подменяется.
 */
function installImportScriptsShim() {
  if (typeof importScripts === 'function') return false
  const shim = () => {
    throw new TypeError('importScripts недоступен в module-воркере')
  }
  try {
    Object.defineProperty(self, 'importScripts', {
      value: shim,
      configurable: true,
      writable: true,
    })
  } catch {
    try {
      self.importScripts = shim
    } catch {
      return false
    }
  }
  return true
}

const importScriptsShimmed = installImportScriptsShim()

/**
 * ЗАГЛУШКА document — РОВНО ТО, ЧТО ТРОГАЕТ EMSCRIPTEN, И НИЧЕГО СВЕРХ.
 *
 * Откуда взялась. В поле у всех заходов с айфона воркер падает одинаково:
 * «Can't find variable: document», причём на ВСЕХ трёх попытках подряд —
 * GPU/буфер, CPU/буфер, CPU/путь. Раньше это списывали на ветку загрузчика
 * MediaPipe, где при отсутствии importScripts создаётся <script>. Но журнал
 * прода говорит другое: `importScripts: true` и `offscreen: true` — то есть обе
 * ветки, которые видно в коде MediaPipe, на этом устройстве не берутся.
 *
 * Остаётся третья, в сгенерированной Emscripten обвязке (vision_wasm_*.js),
 * в разделе «Canvas event setup»:
 *
 *     var canvas = Browser.getCanvas();
 *     if (canvas) {
 *       document.addEventListener("pointerlockchange", pointerLockChange, false);
 *
 * Ни `document`, ни весь этот блок ничем не защищены, а `Browser.getCanvas()`
 * отдаёт тот самый OffscreenCanvas, который MediaPipe завела для GL. Обвязка
 * писалась для страницы, и в воркере эта строка обязана падать.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ. Только поля, которые обвязка действительно читает: подписка
 * на события (пустая), createElement для canvas, пустые body и head,
 * pointerLockElement и fullscreenElement. Никакого DOM: если MediaPipe
 * когда-нибудь начнёт им пользоваться по-настоящему, она получит honest-пустоту
 * и упадёт заметно, а не поедет вкривь.
 *
 * ПОЧЕМУ ЭТО НЕ ЛОМАЕТ ВЕТКУ СО <script>. Та ветка берётся только когда
 * importScripts не объявлен, — а он либо объявлен движком, либо подставлен
 * заглушкой выше. То есть до `createElement('script')` дело не доходит ни на
 * одном движке; иначе заглушка вернула бы объект, у которого событие load не
 * наступит никогда, и загрузка молча повисла бы.
 *
 * ЖИВЁТ ТОЛЬКО В ВОРКЕРЕ. На главном потоке document настоящий, и заглушка,
 * увидев его, ничего не делает.
 */
function installDocumentShim() {
  if (typeof document !== 'undefined') return false
  const ничего = () => {}
  const элемент = (tag) => (String(tag).toLowerCase() === 'canvas' && typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(1, 1)
    : { style: {}, appendChild: ничего, setAttribute: ничего, addEventListener: ничего, removeEventListener: ничего })
  const stub = {
    createElement: элемент,
    addEventListener: ничего,
    removeEventListener: ничего,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    currentScript: null,
    pointerLockElement: null,
    fullscreenElement: null,
    body: { appendChild: ничего, removeChild: ничего },
    head: { appendChild: ничего, removeChild: ничего },
  }
  try {
    Object.defineProperty(self, 'document', { value: stub, configurable: true, writable: true })
  } catch {
    try { self.document = stub } catch { return false }
  }
  return true
}

const documentShimmed = installDocumentShim()

/**
 * Есть ли в воркере webgl2 поверх OffscreenCanvas. Спрашивается ОДИН РАЗ и
 * только на пути отказа: создание контекста стоит заметно, и звать это в
 * рабочем цикле было бы платой за диагностику из кармана человека.
 */
function hasWorkerWebgl2() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false
    return !!new OffscreenCanvas(4, 4).getContext('webgl2')
  } catch {
    return false
  }
}

let landmarker = null
let busy = false
let lastTimestamp = -1

/**
 * Локальная инициализация: компиляция wasm и подъём GL-контекста.
 * Сеть сюда НЕ входит — модель уже скачана в буфер.
 */
function createLandmarker(vision, baseOptions) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions,
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  })
}

/**
 * Таймаут ТОЛЬКО на локальную инициализацию.
 *
 * Раньше он оборачивал всё вместе со скачиванием 8.4 МБ (wasm 2.85 + модель 5.5).
 * На мобильной сети это легко больше 15 секунд, таймаут срабатывал — и стартовала
 * ВТОРАЯ инициализация параллельно первой. Две копии MediaPipe одновременно
 * поднимали wasm и переписывали globalThis.ModuleFactory, вторая падала,
 * и пользователь видел «Не удалось загрузить модель». На быстрой сети
 * 15 секунд хватало, поэтому на десктопе это не воспроизводилось.
 */
/**
 * Щедро: сюда может попасть повторное скачивание .wasm, если HTTP-кэш не
 * сохранил файл (приватный режим, вытеснение кэша). Таймаут здесь — страховка
 * от подвисшего WebGL, а не инструмент экономии времени: лучше подождать,
 * чем показать ложный отказ на медленной сети.
 */
const GL_INIT_TIMEOUT_MS = 60000
/** Сеть на телефоне бывает очень медленной — здесь запас большой. */
const FETCH_TIMEOUT_MS = 180000
const FETCH_ATTEMPTS = 3

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: превышено ожидание ${ms} мс`)), ms)
    }),
  ])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Скачивание своими руками: нужен прогресс, осмысленные повторы — и проверка
 * того, ЧТО пришло.
 *
 * @param {string} url
 * @param {string} stage
 * @param {(bytes: Uint8Array) => boolean} [verify] похоже ли это на то, что
 *   мы просили. Ответ бакета об отсутствии файла и страница-заглушка прокси
 *   приходят обычным успешным ответом, и без этой проверки они доехали бы до
 *   MediaPipe, где запасного пути уже нет.
 */
async function fetchBinary(url, stage, verify) {
  let lastError = null

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, `загрузка (${stage})`)
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        /**
         * ОТВЕТ «ТАКОГО НЕТ» ПОВТОРЯТЬ НЕЗАЧЕМ. 403 (сняли публичность бакета),
         * 404 (не залили файл), 400 (хранилище не знает такого объекта) — это не
         * сбой сети, а определённый ответ, и три попытки с паузами лишь
         * задерживают откат на запасной источник почти на три секунды. Ждать
         * стоит только того, что и правда бывает временным: перегрузки (429) и
         * таймаута шлюза (408, 5xx).
         */
        error.fatal = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)
        throw error
      }

      // content-length у сжатого ответа — это размер СЖАТЫХ данных, а читаем мы
      // распакованные. Без поправки прогресс убегает за 100% (видели 373%).
      const encoded = /\b(br|gzip|deflate|zstd)\b/i.test(
        response.headers.get('content-encoding') || '',
      )
      const declared = Number(response.headers.get('content-length')) || 0
      const total = encoded ? 0 : declared

      if (!response.body?.getReader) {
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (verify && !verify(buffer)) throw new Error(`не тот файл (${stage}, ${buffer.length} Б)`)
        self.postMessage({ type: 'progress', stage, loaded: buffer.length, total })
        return buffer
      }

      const reader = response.body.getReader()
      const chunks = []
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.length
        self.postMessage({ type: 'progress', stage, loaded, total: Math.max(total, loaded) })
      }

      const buffer = new Uint8Array(loaded)
      let offset = 0
      for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.length
      }
      if (verify && !verify(buffer)) throw new Error(`не тот файл (${stage}, ${buffer.length} Б)`)
      return buffer
    } catch (error) {
      lastError = error
      if (error?.fatal) break
      if (attempt < FETCH_ATTEMPTS) await sleep(800 * attempt)
    }
  }

  throw lastError || new Error(`не удалось скачать (${stage})`)
}

/**
 * СЕТЕВАЯ ЧАСТЬ ОДНОГО ИСТОЧНИКА: загрузчик, движок и модель.
 *
 * Всё, что может не доехать, собрано здесь — и только здесь имеет смысл
 * переключаться на запасной источник. Дальше идёт локальная инициализация, где
 * переключаться уже некуда: файлы скачаны, и если движок не поднялся, виноват
 * не источник, а устройство.
 *
 * ЗАГРУЗЧИК КАЧАЕТСЯ ЗАРАНЕЕ, хотя MediaPipe скачал бы его сам внутри
 * createFromOptions. Именно поэтому и заранее: скачанный там, он проверялся бы
 * уже за границей запасного пути, и бакет, отдавший вместо `.js` страницу с
 * ошибкой, ронял бы инициализацию без всякой возможности откатиться. Заодно
 * греется HTTP-кэш, и createFromOptions берёт оба файла из него мгновенно.
 */
async function loadFrom(source) {
  self.postMessage({ type: 'progress', stage: 'wasm' })

  const vision = await withTimeout(
    FilesetResolver.forVisionTasks(source.wasmBase, true),
    FETCH_TIMEOUT_MS,
    'загрузка wasm',
  )

  if (vision?.wasmLoaderPath) {
    const loader = await fetchBinary(vision.wasmLoaderPath, 'wasm', (bytes) =>
      looksLikeLoader(new TextDecoder().decode(bytes.subarray(0, 200))),
    )
    void loader
  }

  // .wasm MediaPipe качает ВНУТРИ createFromOptions. Если оставить это там, сеть
  // снова окажется под таймаутом локальной инициализации.
  if (vision?.wasmBinaryPath) await fetchBinary(vision.wasmBinaryPath, 'wasm', looksLikeWasm)

  const modelBuffer = await fetchBinary(source.modelUrl, 'model', looksLikeModel)
  return { vision, modelBuffer }
}

/**
 * @param {object} options
 * @param {Array<{name: string, wasmBase: string, modelUrl: string}>} options.sources
 *   источники по порядку: свой, потом прежний CDN (см. pose/assets.js)
 */
async function init({ sources = [], delegate = 'GPU' }) {
  let vision
  let modelBuffer
  let used = null

  try {
    const picked = await loadFromSources(sources, loadFrom, (info) =>
      self.postMessage({ type: 'assets', event: 'fallback', ...info }),
    )
    used = picked.source
    vision = picked.value.vision
    modelBuffer = picked.value.modelBuffer
  } catch (error) {
    self.postMessage({
      type: 'error',
      code: 'MODEL_NETWORK_FAILED',
      stage: 'wasm',
      message: String(error?.message || error),
    })
    return
  }

  self.postMessage({ type: 'assets', event: 'source', from: used.name })

  const modelAssetPath = used.modelUrl

  // --- локальная инициализация ---
  // Каждая попытка получает СВОЮ копию буфера: MediaPipe забирает его в кучу
  // wasm, и повторное использование того же Uint8Array во второй попытке —
  // отличный способ получить «движок не смог поднять файлы» ровно там, где
  // первая попытка не прошла. На десктопе GPU проходит с первого раза, поэтому
  // этот путь там никогда не исполнялся.
  self.postMessage({ type: 'progress', stage: 'init' })

  const attempts =
    delegate === 'GPU'
      ? [
          { delegate: 'GPU', source: 'buffer' },
          { delegate: 'CPU', source: 'buffer' },
          // последний шанс: файл уже в HTTP-кэше, отдаём путь вместо буфера
          { delegate: 'CPU', source: 'path' },
        ]
      : [{ delegate, source: 'buffer' }]

  const failures = []

  for (const attempt of attempts) {
    try {
      const options =
        attempt.source === 'path'
          ? { modelAssetPath, delegate: attempt.delegate }
          : { modelAssetBuffer: new Uint8Array(modelBuffer), delegate: attempt.delegate }

      landmarker = await withTimeout(
        createLandmarker(vision, options),
        GL_INIT_TIMEOUT_MS,
        `инициализация ${attempt.delegate}/${attempt.source}`,
      )
      self.postMessage({
        type: 'ready',
        delegate: attempt.delegate,
        importScriptsShimmed,
        documentShimmed,
      })
      return
    } catch (error) {
      failures.push(`${attempt.delegate}/${attempt.source}: ${String(error?.message || error)}`)
    }
  }

  /**
   * Все причины разом: по одной ошибке в поле не разобраться, какая попытка
   * на чём споткнулась.
   *
   * И СРАЗУ — ОБСТАНОВКА В ВОРКЕРЕ. Полевой разбор откатов упёрся ровно в её
   * отсутствие: шесть сессий из двенадцати ушли считать на главный поток с
   * одинаковым «Can't find variable: document» на всех трёх попытках, и по
   * журналу нельзя было сказать, ПОЧЕМУ MediaPipe вообще полез за документом.
   * Веток у него две, и они означают разное:
   *
   *   нет `importScripts` — не подхватился загрузчик wasm (тогда важно, встала
   *     ли наша заглушка, `shimmed`);
   *   нет `OffscreenCanvas` — не на чем поднять GL-контекст в воркере, и это
   *     совсем другой разговор: Safari умеет его с 16.4, а вот WKWebView
   *     (то есть любой сторонний браузер на iOS) — не всегда.
   *
   * Три флага и строка версии стоят одного сообщения раз в сессию, зато
   * следующий откат в поле читается по журналу, а не гаданием по исходникам
   * MediaPipe.
   */
  self.postMessage({
    type: 'error',
    code: 'MODEL_INIT_FAILED',
    stage: 'init',
    message: failures.join(' | '),
    env: {
      offscreen: typeof OffscreenCanvas !== 'undefined',
      importScripts: typeof importScripts === 'function',
      shimmed: importScriptsShimmed,
      docShim: documentShimmed,
      // без webgl2 в воркере разговор про делегат GPU вообще не имеет смысла
      webgl2: hasWorkerWebgl2(),
    },
  })
}

function handleFrame({ bitmap, timestamp }) {
  if (!landmarker || busy) {
    bitmap.close()
    self.postMessage({ type: 'dropped', timestamp })
    return
  }

  busy = true
  // MediaPipe требует строго возрастающий timestamp.
  const ts = timestamp > lastTimestamp ? timestamp : lastTimestamp + 1
  lastTimestamp = ts

  const startedAt = performance.now()
  try {
    const result = landmarker.detectForVideo(bitmap, ts)
    const landmarks = result?.landmarks?.[0] ?? null
    const worldLandmarks = result?.worldLandmarks?.[0] ?? null

    self.postMessage({
      type: 'result',
      timestamp,
      inferenceMs: performance.now() - startedAt,
      // Структуры простые ({x,y,z,visibility}), structured clone справляется.
      landmarks: landmarks ? landmarks.map(toPlain) : null,
      worldLandmarks: worldLandmarks ? worldLandmarks.map(toPlain) : null,
    })
  } catch (error) {
    self.postMessage({
      type: 'error',
      code: 'INFERENCE_FAILED',
      message: String(error?.message || error),
    })
  } finally {
    bitmap.close()
    busy = false
  }
}

function toPlain(p) {
  return { x: p.x, y: p.y, z: p.z, visibility: p.visibility }
}

self.onmessage = (event) => {
  const data = event.data
  switch (data.type) {
    case 'init':
      init(data)
      break
    case 'frame':
      handleFrame(data)
      break
    case 'close':
      landmarker?.close?.()
      landmarker = null
      break
    default:
      break
  }
}
