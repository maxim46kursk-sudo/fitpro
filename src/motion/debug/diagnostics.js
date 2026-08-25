/**
 * Общая шина для диагностической панели.
 *
 * Экраны пишут сюда каждый кадр, панель читает по таймеру (10 Гц) —
 * так на телефоне не будет 30 ререндеров в секунду ради отладочных цифр.
 *
 * Временный инструмент калибровки: в проде вся папка debug/ удаляется.
 */

import { describeAspect, estimateMinDistance } from '../pose/viewport.js'
import { nameOf } from '../pose/landmarks.js'
import { getAudioState, isAudioEnabled, isAudioReady } from '../feedback/audio.js'
import { getThresholds } from '../exercises/thresholds.js'

const MAX_LOG = 200

/**
 * Пустое живое состояние.
 *
 * Функцией, а не константой: внутри массивы и объекты, и одна общая на всех
 * ссылка утекла бы из одного открытия раздела в другое — то есть ровно то, от
 * чего сброс и защищает.
 */
function emptyLive() {
  return {
    fps: 0,
    inferenceMs: 0,
    delegate: null,
    screen: 'calibration',
    angle: null,
    rawAngle: null,
    state: null,
    zone: null,
    reps: 0,
    outOfFrame: true,
    missing: [],
    minAngleInRep: null,
    thresholds: null,
    /** Параметры видеопотока и список камер — сюда смотрим при жалобах на «зум». */
    camera: null,
    devices: [],
    videoFit: null,
    /**
     * Режим показа: 'sync' — кадр и поза выходят вместе, 'live' — прежнее живое
     * видео со скелетом поверх. Вторым полем — почему откатились.
     */
    videoSync: null,
    videoSyncWhy: null,
    frameReason: null,
    zones: {},
    /** Телеметрия пайплайна за сессию — по ней разбираем «второй подход хуже». */
    perf: null,
    lastReject: null,
    /** Детализация по шести ключевым точкам: visibility и координата. */
    points: [],
    mode: 'knee',
    thread: 'worker',
    /** Экономный режим отрисовки боя: эффекты урезаны, свечение и тряска сняты. */
    cheap: false,
  }
}

const live = emptyLive()

/**
 * СНИМОК СОСТОЯНИЯ для лога — раз в пять секунд.
 *
 * Живёт здесь, а не в экране, по той же причине, что и вся эта шина: поля
 * приходят с разных экранов и из разных хуков, и собирать их должен тот, кто
 * их и хранит. Заодно снимок становится проверяемым тестом, а не только
 * глазами в полевом логе.
 *
 * ЧТО ДОБАВЛЕНО ПОСЛЕ 18 АВГУСТА. Жалобу «не видно эффекта попадания» нельзя
 * было разобрать: бой шёл в экономном режиме, а в логе этого не было вовсе.
 * Теперь снимок называет режим отрисовки и счётчики пайплайна — потерянные
 * кадры, зависания, ошибки захвата, худшую задержку и среднюю частоту. Все они
 * уже считались, просто никуда не писались.
 */
export function snapshotOf() {
  const l = live
  const perf = l.perf ?? {}
  const round1 = (v) => (v == null ? null : Math.round(v))
  return {
    screen: l.screen,
    fps: l.fps,
    thread: l.thread,
    delegate: l.delegate,
    reps: l.reps,
    angle: l.angle == null ? null : Math.round(l.angle),
    reason: l.frameReason,
    paused: l.outOfFrame,
    reject: l.lastReject,
    results: perf.results,
    grab: perf.grabMode,
    // показ: держится ли синхронный режим и на сколько отстаёт картинка
    videoSync: l.videoSync,
    /**
     * ПОЧЕМУ ПОКАЗ ЖИВОЙ, А НЕ СИНХРОННЫЙ — и это не мелочь для журнала.
     *
     * Синхронный режим существует ровно ради жалобы «мишень взрывается с
     * запаздыванием»: он придерживает КАРТИНКУ на задержку распознавания, и
     * рука на экране доходит до круга одновременно со взрывом. По журналу прода
     * видно, что в поле он не включается НИ РАЗУ — везде живое видео, — а
     * причин у этого две совершенно разные: у телефона нет
     * requestVideoFrameCallback (тогда режима нет вовсе) или камера отдаёт
     * кадры реже 12–13 в секунду и режим откатился сам (тёмная комната, где
     * экспозиция роняет частоту). Лечатся они по-разному, а в снимке до сих пор
     * лежал только итог — «живое», — по которому их не отличить.
     */
    videoSyncWhy: l.videoSyncWhy,
    latencyMs: round1(perf.latencyMs),
    /**
     * Режим отрисовки боя. Первое, что надо знать по жалобе на картинку:
     * в экономном режиме эффекты урезаны, а свечения и тряски нет вовсе.
     */
    cheap: !!l.cheap,
    // где пайплайн терял кадры и время: всё это уже считалось, но молчало
    dropped: perf.dropped,
    stalls: perf.stalls,
    grabErrors: perf.grabErrors,
    latencyMax: round1(perf.latencyMax),
    fpsAvg: round1(perf.fpsAvg),
    // без этого поля жалоба «не слышно отсчёта» неразличима: тумблер выключен
    // или контекст так и остался suspended
    audio: getAudioState(),
  }
}

/**
 * СКОЛЬКО ЗНАКОВ ЖАЛОБЫ ДОЕЗЖАЕТ. Пятьсот — это несколько фраз, то есть весь
 * реальный объём: жалобу пишут одной рукой, стоя в спортзале. Всё сверх —
 * либо вставленная простыня, либо сломанный клиент, и в журнале ему не место.
 */
export const NOTE_MAX = 500

/**
 * ТЕКСТ ЧЕЛОВЕКА, ГОДНЫЙ ДЛЯ ЖУРНАЛА.
 *
 * ПЕРЕВОД СТРОКИ — ЕДИНСТВЕННОЕ, ЧТО ОСТАЁТСЯ: им пользуются осмысленно, и
 * склеенная в одну строку жалоба читается хуже. Всё прочее управляющее, включая
 * табуляцию, вычищается — оно ничего не значит для читателя, зато ломает и
 * вывод в консоль, и сообщение в Телеграме, и разбор строки глазами.
 *
 * ТА ЖЕ ЧИСТКА СТОИТ В ПРИЁМНИКЕ (api/set-exercise.js, cleanNote) и по той же
 * причине, по какой там продублирована чистка метки камеры: сборка на телефоне
 * человека живёт своей жизнью, и приёмник обязан быть последним рубежом, а не
 * первым доверчивым.
 */
export function cleanNote(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NOTE_MAX)
}

/**
 * ТЕМП ЗАМЕРОВ ЗА ОТРЕЗОК — чтобы связь «частота ↔ зачёт» была видна в ОДНОМ
 * событии, а не сшивалась вручную из снимков состояния.
 *
 * Зачем понадобилось. Разбор жалобы «на третьем круге попадаю, а зачёта нет»
 * упёрся в то, что в game.end есть зачёты и промахи, но нет ни одного числа про
 * телефон. Частоту пришлось доставать из снимков, раскладывая их по времени
 * между боями. По записям вышло: бой 1 — 20 поз/с и 88% зачётов, бой 3 — 8 поз/с
 * и 68%, промахи все «не успел». Такое должно читаться сразу.
 *
 * Своего таймера здесь НЕТ намеренно: замеры складывает тот же интервал в
 * index.jsx, который и так раз в четверть секунды переносит счётчики инференса в
 * шину. Заводить ради диагностики второй таймер на экране, где мы боремся
 * ровно за скорость, было бы смешно.
 */
const темп = { fps: [], lat: [] }
/** Потолок выборки: 250 мс × 600 — это две с половиной минуты, длиннее боя. */
const RATE_MAX = 600

/** Отметить замер. Зовётся из общего интервала счётчиков. */
export function noteRate(fps, latencyMs) {
  const f = Number(fps)
  const l = Number(latencyMs)
  if (Number.isFinite(f) && f > 0) {
    темп.fps.push(f)
    if (темп.fps.length > RATE_MAX) темп.fps.shift()
  }
  if (Number.isFinite(l) && l >= 0) {
    темп.lat.push(l)
    if (темп.lat.length > RATE_MAX) темп.lat.shift()
  }
}

/** Забыть накопленное — зовётся в начале отрезка (боя). */
export function resetRate() {
  темп.fps.length = 0
  темп.lat.length = 0
}

const медиана = (list) => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/**
 * Медианы за отрезок. Медиана, а не среднее: один провал на разогреве не должен
 * решать за весь бой — а именно провалы и случаются, когда телефон уходит
 * думать над кадром.
 */
export function rateStats() {
  const fps = медиана(темп.fps)
  const lat = медиана(темп.lat)
  return {
    poseFps: fps == null ? null : Math.round(fps),
    latencyMs: lat == null ? null : Math.round(lat),
    rateSamples: темп.fps.length,
  }
}

/** Полный лог событий за сессию — уходит в буфер обмена по кнопке. */
const log = []
/**
 * Свой сквозной номер: id события приходит от трекера, а трекеров за сессию
 * несколько (калибровка, каждый подход), и их нумерация начинается заново.
 */
let seq = 0
/** Ноль общего времени лога — чтобы события калибровки и подхода лежали на одной шкале. */
const sessionStart = typeof performance !== 'undefined' ? performance.now() : 0

export function pushLive(patch) {
  Object.assign(live, patch)
}

export function getLive() {
  return live
}

export function pushLogEntry(entry) {
  seq += 1
  log.push({
    ...entry,
    key: seq,
    // tMs у трекера считается от его собственного старта, а трекер на каждом
    // экране свой — для лога нужна общая шкала и пометка, откуда событие.
    atMs: (typeof performance !== 'undefined' ? performance.now() : 0) - sessionStart,
    screen: live.screen,
  })
  if (log.length > MAX_LOG) log.shift()
}

export function getLog() {
  return log
}

export function clearLog() {
  log.length = 0
}

/**
 * Забыть всё накопленное при закрытии раздела.
 *
 * Шина модульная: и лог событий, и снимок живого состояния переживают
 * размонтирование. Без сброса второе открытие показало бы в панели fps и углы
 * от прошлой тренировки — то есть соврало бы ровно там, куда смотрят, когда
 * разбирают жалобу.
 */
export function resetDiagnostics() {
  log.length = 0
  seq = 0
  resetRate()
  Object.assign(live, emptyLive())
}

/** Последние n событий, свежие сверху. */
export function getRecentLog(n = 15) {
  return log.slice(-n).reverse()
}

const num = (v, digits = 0) => (v == null ? '—' : v.toFixed(digits))

/** Оценка минимальной дистанции — с явным указанием допущения про угол обзора. */
export function formatMinDistance(camera) {
  const est = camera && estimateMinDistance(camera.width, camera.height)
  if (!est) return '—'
  return `~${est.distanceM.toFixed(1)} м (верт. угол ~${Math.round(est.vfovDeg)}°, при допущении гор. ${est.hfovDeg}°)`
}

/** Одна строка лога в текстовом виде — и для панели, и для буфера обмена. */
export function formatLogEntry(e) {
  const t = `${((e.atMs ?? e.tMs) / 1000).toFixed(1)}s`
  const where = e.screen === 'workout' ? 'подход' : 'калибр'
  const depth = `${num(e.minAngle, 1)}°`
  const timing =
    e.downMs == null ? '' : ` вниз ${Math.round(e.downMs)}мс / вверх ${Math.round(e.upMs)}мс`
  const head = `${t} ${where}`

  if (e.kind === 'rep') return `${head}  #${e.index} засчитан  мин ${depth}${timing}`
  if (e.kind === 'too_fast') return `${head}  ОТКЛОНЁН  мин ${depth}${timing} — ${e.reason}`
  if (e.kind === 'shallow') return `${head}  НЕ ЗАСЧИТАН  мин ${depth} — ${e.reason}`
  return `${head}  ${e.kind}`
}

/** Весь лог сессии текстом — то, что кладётся в буфер обмена. */
export function buildLogText() {
  // Пороги берём из источника, а не из шины: шину наполняет экран подхода,
  // и до его открытия в логе стояли undefined по всем строкам — ровно там,
  // где нужнее всего понять, с какими значениями работает счётчик.
  const t = live.thresholds || getThresholds()
  const c = live.camera
  const header = [
    'FitPro Motion — лог сессии',
    `дата: ${new Date().toISOString()}`,
    `устройство: ${navigator.userAgent}`,
    `экран: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
    `камера: ${c ? `${c.label} — ${c.width}x${c.height} (${describeAspect(c.width, c.height)}), зум ${c.zoom ?? 'нет'}${c.zoomRange ? ` из ${c.zoomRange.min}–${c.zoomRange.max}` : ''}` : '—'}`,
    `звук: ${isAudioEnabled() ? 'вкл' : 'выкл'}${isAudioEnabled() && !isAudioReady() ? ' (ждёт касания экрана)' : ''}, речи нет — только сигналы`,
    `object-fit: ${live.videoFit || '—'}`,
    `мин. дистанция для роста 180 см: ${formatMinDistance(c)}`,
    `камер в системе: ${live.devices?.length || 0}${live.devices?.length ? ' — ' + live.devices.map((d) => d.label).join(' | ') : ''}`,
    `инференс: ${live.delegate || '—'}, ${live.fps} fps, ${Math.round(live.inferenceMs)} мс/кадр, поток ${live.thread === 'main' ? 'ГЛАВНЫЙ (резерв)' : 'воркер'}`,
    `fps за сессию: мин ${live.perf?.fpsMin ?? '—'} / сред ${live.perf?.fpsAvg == null ? '—' : live.perf.fpsAvg.toFixed(1)} / макс ${live.perf?.fpsMax ?? '—'}`,
    `инференс за сессию: сред ${live.perf?.inferenceAvg == null ? '—' : Math.round(live.perf.inferenceAvg)} / макс ${Math.round(live.perf?.inferenceMax ?? 0)} мс`,
    `задержка кадр->результат: ${Math.round(live.perf?.latencyMs ?? 0)} / макс ${Math.round(live.perf?.latencyMax ?? 0)} мс`,
    `дропнуто кадров: ${live.perf?.dropped ?? 0}, зависаний: ${live.perf?.stalls ?? 0}, смен делегата: ${live.perf?.delegateSwitches ?? 0}`,
    `режим глубины: ${live.mode === 'hip' ? 'резервный по тазу' : 'по углу в колене'}`,
    `захват кадра: ${live.perf?.grabMode || '—'}, ошибок ${live.perf?.grabErrors ?? 0}, результатов ${live.perf?.results ?? 0}`,
    `отклонён последний цикл: ${live.lastReject || 'нет'}`,
    `простой режим: ${live.thresholds?.simpleMode ? 'ВКЛ' : 'выкл'}`,
    `точки: ${live.points?.length ? live.points.map((p) => `${nameOf(p.index)} v=${p.visibility?.toFixed(2) ?? '—'}${p.ok ? '' : ' ✗'}`).join(', ') : '—'}`,
    `пороги: UP ${t.upAngle}° / DOWN ${t.downAngle}° / цикл>=${t.minCycleMs} мс / интервал ${t.minRepIntervalMs} мс`,
    `калибровка: ${t.autoCalibrate ? 'вкл' : 'выкл'}, стойка ${t.standAngle ?? 'не мерена'}°, запасы ${t.upMarginDeg}/${t.downMarginDeg}°`,
    `видимость: голеностоп ${t.visAnkle} / крупные ${t.visMajor}, запас за кадром ${t.coordMargin}, окно ${t.smoothingWindow}`,
    `итого повторов: ${live.reps}`,
    '',
    `события (${log.length}):`,
  ]

  const body = log.length ? log.map(formatLogEntry) : ['(пусто)']
  return [...header, ...body].join('\n')
}

/** Копирование с фолбэком: на http:// Clipboard API недоступен. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // упадём в фолбэк ниже
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
