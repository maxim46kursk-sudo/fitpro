/**
 * Запись реальных landmark'ов с камеры в файл.
 *
 * Синтетика проходит тесты, а живой человек считается плохо — значит синтетика
 * не воспроизводит реальный сигнал. Подбирать пороги вслепую по описанию
 * «считает не идеально» бессмысленно: нужна запись, которую можно прогнать
 * через трекер офлайн столько раз, сколько нужно.
 *
 * Формат намеренно простой и компактный: точки как [x, y, z, visibility],
 * округлённые до 4 знаков. Прогоняется скриптом tools/replay.mjs.
 *
 * Запись умеет размечаться на сегменты: «здесь пять подъёмов правого колена,
 * с 12.4 по 19.8 секунду». Без разметки настройка детекторов превращается в
 * гадание — по сплошной записи не видно, где человек делал движение, а где
 * просто стоял, и «лишнее срабатывание» неотличимо от честного.
 */

/**
 * Потолок записи. 9000 кадров при 20 в секунду — 7.5 минуты: хватает на
 * двенадцать шагов калибровки по пять повторов. Прежние 3000 обрывали запись
 * на середине списка движений, и человек узнавал об этом только по файлу.
 */
const MAX_FRAMES = 9000

let recording = false
let frames = []
let startedAt = null
/** Запись упёрлась в потолок: часть движений в неё не попала. */
let truncated = false
/** Размеченные куски записи: что именно человек делал и когда. */
let segments = []
let openSegment = null
/** Кадров в записи на момент открытия сегмента — по нему видно, шли ли кадры. */
let openSegmentAt = 0
const subscribers = new Set()

const round4 = (n) => (typeof n === 'number' ? Math.round(n * 10000) / 10000 : 0)
const packPoint = (p) => [round4(p.x), round4(p.y), round4(p.z), round4(p.visibility ?? 1)]
const packList = (list) => (Array.isArray(list) ? list.map(packPoint) : null)

function notify() {
  for (const fn of subscribers) fn({ recording, count: frames.length })
}

export function subscribeRecorder(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function isRecording() {
  return recording
}

export function recordedCount() {
  return frames.length
}

/**
 * Запись переполнена и кадры больше не принимаются. Молчаливое переполнение —
 * худшее, что здесь может случиться: человек продолжает проходить шаги, а в
 * файл не попадает ничего, и по нему потом не понять, что он их вообще делал.
 */
export function isFull() {
  return truncated
}

export function startRecording() {
  frames = []
  startedAt = null
  truncated = false
  segments = []
  openSegment = null
  openSegmentAt = 0
  recording = true
  notify()
}

/** Время последнего записанного кадра — от него и отсчитываются сегменты. */
export function recordedTime() {
  return frames.length ? frames[frames.length - 1].t : 0
}

/**
 * Начать сегмент: с этого момента человек делает названное движение.
 * @param {{movement: string, side?: string|null, reps?: number}} meta
 */
export function beginSegment(meta) {
  openSegment = { ...meta, side: meta.side ?? null, from: recordedTime() }
  openSegmentAt = frames.length
  return openSegment
}

/**
 * Закрыть сегмент и оставить его в записи.
 *
 * Сегмент, за время которого не пришло ни одного кадра, в разметку не идёт
 * вовсе. Так выглядит шаг, пройденный после переполнения: у него from === to,
 * а разбор требует to > from — одна такая запись в recordings/ валит весь
 * прогон segments.replay. Пустого сегмента лучше нет: по нему всё равно не
 * видно ничего, кроме того, что запись оборвана, а это говорит truncated.
 */
export function endSegment() {
  if (!openSegment) return null
  const segment = { ...openSegment, to: recordedTime() }
  openSegment = null
  // кадров не было — или все они уместились в одну метку времени, что для
  // разбора то же самое: границы сегмента совпали, и брать из него нечего
  if (frames.length === openSegmentAt || segment.to <= segment.from) return null
  segments.push(segment)
  return segment
}

/**
 * Отменить текущий сегмент — «Заново». Кадры остаются в записи, но в разметку
 * не попадают: разбор смотрит только на размеченные куски, поэтому неудачный
 * дубль просто не учитывается.
 */
export function dropSegment() {
  openSegment = null
}

export function recordedSegments() {
  return segments.map((s) => ({ ...s }))
}

export function stopRecording() {
  recording = false
  notify()
}

export function toggleRecording() {
  if (recording) stopRecording()
  else startRecording()
  return recording
}

/**
 * Забыть запись при закрытии раздела.
 *
 * До девяти тысяч кадров (MAX_FRAMES) плюс размеченные отрезки лежат в модульных
 * переменных, а recordFrame зовётся на КАЖДОМ кадре. Включённая и не выключенная
 * запись держала эту память до перезагрузки вкладки — а внутри FitPro
 * перезагрузки не будет, и телефон человека унёс бы её через все остальные
 * разделы приложения.
 *
 * Подписчиков не трогаем: их снимает панель в своём cleanup.
 */
export function resetRecorder() {
  recording = false
  frames = []
  startedAt = null
  truncated = false
  segments = []
  openSegment = null
  openSegmentAt = 0
}

/** Вызывается на каждом кадре. Дёшево: только упаковка чисел. */
export function recordFrame({ landmarks, worldLandmarks, timestamp }) {
  if (!recording || frames.length >= MAX_FRAMES) return
  // именно null: нулевая метка времени — законная, а с проверкой на ноль
  // следующий кадр сдвигал бы точку отсчёта, и метки сегментов уезжали
  if (startedAt == null) startedAt = timestamp
  frames.push({
    t: Math.round(timestamp - startedAt),
    lm: packList(landmarks),
    world: packList(worldLandmarks),
  })
  if (frames.length % 15 === 0) notify()
  if (frames.length >= MAX_FRAMES) {
    recording = false
    truncated = true
    notify()
  }
}

/** @param {object} meta пороги, камера, устройство — чтобы запись была самодостаточной */
export function buildRecording(meta = {}) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    note: 'Точки: [x, y, z, visibility]. lm — нормализованные, world — метрические.',
    ...meta,
    frameCount: frames.length,
    // по файлу должно быть видно, что запись оборвана на потолке, а не что
    // человек прошёл ровно столько шагов, сколько в ней размечено
    truncated,
    maxFrames: MAX_FRAMES,
    durationMs: frames.length ? frames[frames.length - 1].t : 0,
    // сегменты идут перед кадрами: файл читается глазами с начала
    segments: segments.map((s) => ({ ...s })),
    frames,
  }
}

/**
 * Отправка записи прямо в recordings/ на компьютере — тем же путём, что и лог.
 *
 * Скачивание файлом на телефоне заканчивается тем, что файл остаётся в телефоне:
 * его надо оттуда доставать и переносить, и запись до разбора не доезжает.
 * Дев-сервер принимает её сам, и она сразу попадает под тест-регрессию.
 *
 * @returns {Promise<{ok: boolean, file?: string, error?: string}>}
 */
export async function sendRecording(meta = {}) {
  const data = buildRecording(meta)
  try {
    const response = await fetch('/__recording', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) return { ok: false, error: `сервер ответил ${response.status}` }
    const result = await response.json().catch(() => ({}))
    return { ok: true, file: result.file, frames: data.frameCount }
  } catch (error) {
    // на проде такого эндпоинта нет — там остаётся скачивание файлом
    return { ok: false, error: String(error).slice(0, 120) }
  }
}

/** Скачивание файлом: буфер обмена такой объём не переживёт. */
export function downloadRecording(meta = {}) {
  const data = buildRecording(meta)
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `motion-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return data.frameCount
}
