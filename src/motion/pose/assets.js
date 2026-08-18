/**
 * ОТКУДА БЕРЁТСЯ ДВИЖОК РАСПОЗНАВАНИЯ — одно место на весь модуль.
 *
 * Зачем это вообще понадобилось. Первый запуск качает около 8.8 МБ: движок wasm
 * с `cdn.jsdelivr.net` и модель с `storage.googleapis.com`. Оба адреса — чужие,
 * оба за границей, и jsdelivr к тому же живёт за Cloudflare, которую в России
 * режут. Отвалится любой из двух — Motion не стартует НИ У КОГО и никогда: без
 * модели распознавать нечем, и экран честно скажет «не скачалась модель», но
 * легче от этого не станет. Плюс это трафик за границу на каждом первом запуске
 * каждого участника челленджа.
 *
 * Поэтому файлы переезжают на наш сервер — в публичный бакет того же
 * self-hosted Supabase, который раздаёт видео упражнений в FitPro.
 *
 * ЗАПАСНОЙ ПУТЬ ОСТАЁТСЯ, и это не перестраховка. Свой сервер — одна машина, и
 * упасть она может ровно так же, как чужой CDN; разница в том, что чужой CDN
 * чинится без нас, а свой сервер — нами и не мгновенно. Пока оба источника несут
 * одни и те же файлы одной и той же версии, выбор между ними ничего не стоит и
 * ничем не рискует. Порядок один: сначала свой, потом чужой.
 *
 * ЧТО ЗНАЧИТ «ИСТОЧНИК НЕ ОТВЕТИЛ». Не только сеть. Бакет, из которого файл
 * удалили, отвечает JSON-ошибкой с кодом 400; прокси, севший на обслуживание,
 * отдаёт HTML страницы-заглушки — и то и другое приходит как совершенно
 * успешный ответ с телом, которое не является ни wasm, ни моделью. Дальше
 * MediaPipe падает уже на инициализации, где запасного пути нет и быть не может.
 * Поэтому источник проверяется ПО СОДЕРЖИМОМУ, а не по коду ответа.
 */

/**
 * Версия обязана совпадать с @mediapipe/tasks-vision в package.json, и там она
 * запинена точно (0.10.35 без «^»).
 *
 * Версия входит и в адрес нашего бакета: файлы там лежат по версиям, потому что
 * движок и пакет обязаны совпадать до цифры. Обновление пакета — это заливка
 * нового каталога рядом, а не подмена старого: сборка, которая уже уехала к
 * людям, продолжает брать свою версию.
 */
export const TASKS_VISION_VERSION = '0.10.35'

/** Файл модели. Имя то же, что у Google, — чтобы его было видно в бакете. */
export const MODEL_FILE = 'pose_landmarker_lite.task'

/**
 * НАШ БАКЕТ ПО УМОЛЧАНИЮ. Тот же механизм, что раздаёт видео упражнений в
 * FitPro: публичный бакет self-hosted Supabase, адрес
 * `<хост>/storage/v1/object/public/<бакет>/<путь>`.
 *
 * Значение можно переопределить на сборке (VITE_MOTION_ASSETS_BASE) — так
 * проверяют другой бакет или другой хост, ничего не трогая в коде. Пустая строка
 * означает «своего источника нет», и тогда остаётся один CDN: это нужно, чтобы
 * можно было собрать заведомо прежний вариант и сравнить.
 */
const OWN_BASE_DEFAULT = 'https://api.fitproapp.ru/storage/v1/object/public/motion-assets'

/** Прежние адреса. Они же — запасной путь. */
export const CDN_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
export const CDN_MODEL_URL = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/${MODEL_FILE}`

/**
 * Настройка сборки. Обёрнуто: `import.meta.env` есть не в каждой среде — в
 * воркере при некоторых сборках его нет вовсе, и обращение к нему бросает.
 */
function fromEnv(name) {
  try {
    const value = import.meta.env?.[name]
    return value == null ? null : String(value)
  } catch {
    return null
  }
}

/** Адрес нашего бакета без завершающих слэшей. */
export function ownBase(env = fromEnv('VITE_MOTION_ASSETS_BASE')) {
  const raw = env == null ? OWN_BASE_DEFAULT : env
  return String(raw).trim().replace(/\/+$/, '')
}

/**
 * ГДЕ ЛЕЖАТ ФАЙЛЫ В НАШЕМ БАКЕТЕ.
 *
 * Каталог wasm переносится ЦЕЛИКОМ, а не одним `.wasm`: FilesetResolver сам
 * выбирает сборку под устройство (simd / без simd, module / обычная) и ждёт
 * рядом свои `.js`-загрузчики. Положи мы один файл — на половине телефонов
 * движок не поднялся бы, и выглядело бы это как «на этом телефоне не работает».
 */
export const ownWasmBase = (base = ownBase()) => `${base}/tasks-vision/${TASKS_VISION_VERSION}/wasm`
export const ownModelUrl = (base = ownBase()) => `${base}/models/${MODEL_FILE}`

/**
 * Источники по порядку: свой, потом чужой.
 *
 * @param {object} [options]
 * @param {string} [options.base] адрес своего бакета; пустой — своего нет
 * @param {boolean} [options.cdn] оставлять ли запасной путь
 * @returns {Array<{name: string, wasmBase: string, modelUrl: string}>}
 */
export function assetSources({ base = ownBase(), cdn = true } = {}) {
  const sources = []
  if (base) {
    sources.push({ name: 'own', wasmBase: ownWasmBase(base), modelUrl: ownModelUrl(base) })
  }
  if (cdn || !sources.length) {
    /**
     * Последняя строка условия — не мелочь: без своего бакета и без запасного
     * пути список оказался бы пустым, и модуль не смог бы даже объяснить, что
     * случилось. Пустой источник — это ошибка настройки сборки, а не режим
     * работы, и вести она должна к прежнему CDN, а не к белому экрану.
     */
    sources.push({ name: 'cdn', wasmBase: CDN_WASM_BASE, modelUrl: CDN_MODEL_URL })
  }
  return sources
}

/**
 * ПОХОЖЕ ЛИ НА WASM. Первые четыре байта модуля WebAssembly — `\0asm`, это
 * часть формата, а не соглашение.
 */
export function looksLikeWasm(bytes) {
  if (!bytes || bytes.length < 8) return false
  return bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
}

/**
 * ПОХОЖЕ ЛИ НА МОДЕЛЬ. Файл `.task` — это zip-архив с двухбайтовым префиксом,
 * то есть сигнатура `PK\3\4` стоит не с самого начала. Ищем её в первых
 * шестнадцати байтах: точное смещение — деталь формата, на которую опираться
 * незачем, а вот HTML-заглушка или JSON с ошибкой сюда не попадут никогда.
 */
export function looksLikeModel(bytes) {
  if (!bytes || bytes.length < 8) return false
  const limit = Math.min(16, bytes.length - 4)
  for (let i = 0; i <= limit; i += 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      return true
    }
  }
  return false
}

/**
 * ПОХОЖЕ ЛИ НА ЗАГРУЗЧИК. Проверка нарочно грубая: это обычный JavaScript, и
 * опознавать его по содержимому надёжно нельзя. Зато можно уверенно опознать то,
 * чем он ТОЧНО не является, — страницу с ошибкой и ответ хранилища об отсутствии
 * файла. Ровно они и приходят, когда бакет отдал не то.
 */
export function looksLikeLoader(text) {
  const head = String(text ?? '').trimStart().slice(0, 200)
  if (!head) return false
  if (head.startsWith('<')) return false
  if (head.startsWith('{') && /"(error|statusCode|message)"/.test(head)) return false
  return true
}

/**
 * ПЕРЕБОР ИСТОЧНИКОВ ПО ПОРЯДКУ — общий и для воркера, и для резерва на главном
 * потоке.
 *
 * Здесь нет ни сети, ни MediaPipe: что значит «загрузить», решает вызывающая
 * сторона, и обе стороны решают по-разному (воркер качает файлы сам и проверяет
 * байты, резерв отдаёт загрузку MediaPipe). Общее у них ровно одно — правило
 * отката, и оно живёт в одном месте, потому что разойдись эти два правила, и
 * телефон, у которого не завёлся воркер, откатывался бы иначе, чем все
 * остальные.
 *
 * @param {Array<{name: string}>} sources источники по порядку
 * @param {(source: object) => Promise<any>} load как загрузить с источника
 * @param {(info: {from: string, to: string, reason: string}) => void} [onFallback]
 *   зовётся ТОЛЬКО когда есть куда откатываться: последний неудавшийся источник —
 *   это уже не «переключились», а «не смогли», и о нём говорит исключение.
 * @returns {Promise<{source: object, value: any}>}
 */
export async function loadFromSources(sources, load, onFallback) {
  const list = Array.isArray(sources) ? sources : []
  const problems = []

  for (let i = 0; i < list.length; i += 1) {
    const source = list[i]
    try {
      return { source, value: await load(source) }
    } catch (error) {
      const reason = String(error?.message || error)
      problems.push(`${source?.name ?? '?'}: ${reason}`)
      const next = list[i + 1]
      if (next) onFallback?.({ from: source?.name, to: next.name, reason })
    }
  }

  throw new Error(problems.join(' | ') || 'источников не задано')
}
