/**
 * СКОЛЬКО СТОИТ КАЖДАЯ СТАДИЯ КОНВЕЙЕРА — ПО МИНУТАМ.
 *
 * Зачем понадобилось. За сессию частота замеров падает с 20 поз/с до 8, задержка
 * показа растёт с 35 мс до 135, и зачёты падают с 88% до 68% — все промахи «не
 * успел». Утечки исключены (подписки снимаются, структуры окнами, кадры
 * закрываются), перегрев владелец отверг. Значит замедляется КАКАЯ-ТО ОДНА
 * стадия, и вопрос ровно один: какая. Гадать больше не о чем — надо мерить.
 *
 * ПЯТЬ СТАДИЙ, на которые раскладывается цикл:
 *   grab      — захват кадра из видео (createImageBitmap и его запасные пути);
 *   inference — распознавание позы в воркере;
 *   judge     — судейство: шаг движка раунда и разбор его событий;
 *   draw      — отрисовка сцены, мишеней и эффектов;
 *   log       — журнал: складывание строк и вытеснение из буфера.
 *
 * ПРО `log` ОТДЕЛЬНО. Стадия была объявлена здесь с самого начала, но
 * `noteStage('log', ...)` не звался нигде: в таблице разбора она стояла пустой
 * всю сессию, и «журнал ничего не стоит» было не измерено, а предположено.
 * Теперь она меряется у источника — в `logEvent` (см. debug/logShipper.js).
 *
 * Её миллисекунды ПЕРЕСЕКАЮТСЯ с `judge`: зачёты и промахи пишутся внутри
 * разбора событий движка, то есть внутри судейства, и попадают в обе строки.
 * Так и задумано — `judge` отвечает на «сколько стоит судейство целиком»,
 * `log` на «сколько из этого журнал», — но вычитать одно из другого нельзя.
 *
 * И ЖИВЫЕ ОБЪЕКТЫ рядом с ними: мишени, препятствия, частицы, звёзды, узлы DOM
 * и холсты. Если растёт не время стадии, а число объектов на сцене, — видно
 * будет здесь же, в одной таблице, а не в двух разных догадках.
 *
 * ПО МИНУТАМ, А НЕ ОДНИМ ЧИСЛОМ ЗА БОЙ. Средняя за бой прячет именно то, что
 * ищем: стадия, выросшая втрое к седьмой минуте, в среднем по сессии выглядит
 * «чуть медленнее». Нужен наклон, а не итог.
 *
 * МЕДИАНА, А НЕ СРЕДНЕЕ — для ВРЕМЕНИ стадий. Один провал на разогреве не должен
 * решать за минуту, а провалы случаются, когда телефон уходит думать над кадром.
 *
 * ДЛЯ ЧИСЛА ОБЪЕКТОВ — ПИК, а не медиана: почему именно так, расписано у `peak`
 * ниже. Коротко: эффекты живут доли секунды, снимок берётся раз в секунду, и
 * медиана такого счётчика равна нулю независимо от того, сколько объектов
 * бывает на пике.
 *
 * ПАМЯТЬ ОГРАНИЧЕНА ЖЁСТКО. Кадров в минуте больше тысячи, и хранить их все,
 * чтобы посчитать медиану, значило бы лечить тормоза измерением тормозов.
 * Поэтому у каждой минуты своя выборка максимум в 240 значений: пока она не
 * полна — берём подряд, дальше прореживаем вдвое и берём каждое второе, потом
 * каждое четвёртое. Выборка остаётся равномерной по всей минуте, а расход —
 * постоянным.
 */

/** Стадии, которые меряем. Порядок — порядок конвейера. */
export const STAGES = ['grab', 'inference', 'judge', 'draw', 'log']

/** Что считаем на сцене. */
export const COUNTS = ['targets', 'obstacles', 'particles', 'stars', 'dom', 'canvas', 'heapMb']

/** Потолок выборки на одну минуту и одну стадию. */
const SAMPLE_MAX = 240
/** Сколько минут держим. Бой полторы минуты, сессия — пятнадцать. */
const MINUTES_MAX = 20

/** Одна прореживаемая выборка: расход постоянный, покрытие равномерное. */
function makeSample() {
  return { values: [], seen: 0, step: 1 }
}

function push(sample, value) {
  sample.seen += 1
  if (sample.seen % sample.step !== 0) return
  sample.values.push(value)
  if (sample.values.length <= SAMPLE_MAX) return
  // выборка заполнилась — прореживаем вдвое и дальше берём реже
  const тоньше = []
  for (let i = 0; i < sample.values.length; i += 2) тоньше.push(sample.values[i])
  sample.values = тоньше
  sample.step *= 2
}

const median = (values) => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/**
 * ЖИВЫЕ ОБЪЕКТЫ СЧИТАЮТСЯ ПИКОМ, А НЕ МЕДИАНОЙ — и это не мелочь.
 *
 * Время стадии медиана описывает правильно: провал на разогреве не должен
 * решать за минуту. С числом объектов ровно наоборот. Эффекты попадания —
 * кольца, частицы, всплывающие очки — живут доли секунды и появляются пачкой
 * на зачёт, а снимок берётся раз в секунду. При двадцати пяти зачётах за бой
 * снимок почти всегда попадает в пустую сцену, и МЕДИАНА ЧЕСТНО РАВНА НУЛЮ —
 * при любом числе объектов на пике.
 *
 * Полевой прогон это и показал: персонаж брал половину мишеней всю сессию,
 * эффекты рисовались, а столбец «частицы» стоял в нуле все двадцать минут. То
 * есть вопрос «не копятся ли объекты» этой таблицей был не проверяем в
 * принципе — она отвечала нулём и на «их нет», и на «их сотня раз в секунду».
 *
 * Пик отвечает на тот вопрос, ради которого столбец и заведён: сколько всего
 * оказывалось живо одновременно и растёт ли это к седьмому кругу.
 */
const peak = (values) => (values.length ? Math.max(...values) : null)

let startedAt = null
/** minute → {stages: {name: sample}, counts: {name: sample}, frames} */
const minutes = new Map()

function bucket(now) {
  if (startedAt == null) startedAt = now
  const m = Math.min(MINUTES_MAX - 1, Math.floor((now - startedAt) / 60000))
  let b = minutes.get(m)
  if (!b) {
    b = { stages: {}, counts: {}, frames: 0 }
    for (const s of STAGES) b.stages[s] = makeSample()
    for (const c of COUNTS) b.counts[c] = makeSample()
    minutes.set(m, b)
  }
  return b
}

/**
 * Отметить длительность стадии.
 *
 * @param {string} name одна из STAGES
 * @param {number} ms сколько заняла
 * @param {number} [now] метка времени; своих часов модуль не заводит
 */
export function noteStage(name, ms, now = perfNow()) {
  if (!STAGES.includes(name)) return
  const v = Number(ms)
  if (!Number.isFinite(v) || v < 0) return
  push(bucket(now).stages[name], v)
}

/** Отметить кадр целиком — чтобы знать, из скольких кадров сложилась минута. */
export function noteFrame(now = perfNow()) {
  bucket(now).frames += 1
}

/**
 * Отметить, сколько всего живо на сцене.
 *
 * Узлы DOM и холсты считаются ЗДЕСЬ, а не на каждом кадре: обход документа
 * стоит заметно, и звать его чаще раза в секунду — самому себе создавать те
 * тормоза, которые ищем. Зовущая сторона и решает, как часто.
 */
export function noteCounts(counts, now = perfNow()) {
  const b = bucket(now)
  for (const key of COUNTS) {
    const v = Number(counts?.[key])
    if (Number.isFinite(v)) push(b.counts[key], v)
  }
}

/** Куча, если браузер её показывает. В Safari нет — тогда null. */
export function heapMb() {
  const used = globalThis.performance?.memory?.usedJSHeapSize
  return Number.isFinite(used) ? Math.round(used / 1048576) : null
}

/** Сколько узлов и холстов сейчас в документе. */
export function domCounts() {
  try {
    return {
      dom: document.getElementsByTagName('*').length,
      canvas: document.getElementsByTagName('canvas').length,
    }
  } catch {
    return { dom: null, canvas: null }
  }
}

function perfNow() {
  return globalThis.performance?.now ? performance.now() : Date.now()
}

/** Начать отсчёт заново — зовётся в начале отрезка (боя, блока). */
export function resetStages(now = perfNow()) {
  startedAt = now
  minutes.clear()
}

/**
 * Таблица по минутам, готовая к отправке в журнал.
 *
 * Строка — одна минута: медианы стадий в миллисекундах, медианы живых объектов и
 * число кадров. Пустые стадии выпадают, чтобы строка не раздувалась нулями.
 *
 * @returns {{minutes: Array<object>}|null}
 */
export function stageReport() {
  if (!minutes.size) return null
  const rows = []
  for (const m of [...minutes.keys()].sort((a, b) => a - b)) {
    const b = minutes.get(m)
    const row = { min: m, frames: b.frames }
    for (const s of STAGES) {
      const v = median(b.stages[s].values)
      if (v != null) row[s] = Math.round(v * 100) / 100
    }
    for (const c of COUNTS) {
      const v = peak(b.counts[c].values)
      if (v != null) row[c] = Math.round(v)
    }
    rows.push(row)
  }
  return { minutes: rows }
}
