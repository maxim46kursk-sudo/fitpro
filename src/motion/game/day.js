/**
 * Попытки, зачёт и сид трассы — всё по ДНЮ ЧЕЛЛЕНДЖА.
 *
 * Правила владельца. На каждом уровне не больше ТРЁХ попыток за день челленджа.
 * В зачёт уровня идёт ЛУЧШАЯ попытка, а не последняя и не сумма: следующая
 * попытка — это шанс, а не штраф, и человек не должен бояться, что испортит уже
 * набранное. Итог дня — сумма лучших по трём уровням, поэтому играть все три
 * выгоднее, чем долбить один. Итог челленджа — сумма итогов всех дней.
 *
 * ПОЧЕМУ ДЕНЬ ЧЕЛЛЕНДЖА, А НЕ КАЛЕНДАРНАЯ ДАТА. Раньше попытки сбрасывал
 * календарь: наступила полночь — новый лист. Для челленджа это неверно в обе
 * стороны. Человек, начавший день в 23:50, получал бы шесть попыток вместо трёх.
 * А человек, пропустивший вторник, приходил бы в среду на свой недоигранный
 * день — и его три попытки оказывались бы уже потрачены вчера, на тот же самый
 * день челленджа. Тридцать дней — это тридцать ТРЕНИРОВОК, а не тридцать
 * позиций календаря, и попытки обязаны считаться там же, где считаются дни.
 *
 * ХРАНЯТСЯ ВСЕ ДНИ, а не только текущий. Прежняя запись держала один день и
 * стиралась следующим — этого хватало, пока итог был однодневным. Челлендж
 * складывает тридцать дней, и стёртое вчера в такую сумму уже не вернуть. Это
 * же и есть база будущего экрана «История»: попытка теперь не голое число, а
 * статистика захода (повторы, попадания, реакция, время).
 *
 * Хранилище — через src/motion/storage.js: там же и ответ на приватный режим
 * Safari, где localStorage бросает на запись. Учёт попыток — не повод ронять
 * игру: в худшем случае человек сыграет больше попыток, чем положено, и это
 * лучше, чем белый экран.
 *
 * Серверная часть (общий дашборд участников, аккаунты) будет поверх этого же
 * формата, когда игра переедет в FitPro. К платному запуску переезд обязателен:
 * очищенный кэш браузера сейчас стирает весь челлендж, а на кону деньги.
 */

import { KEYS, readJson, remove, writeJson } from '../storage.js'
import { TIERS, tierById } from './levels.js'
import { currentDay } from './challenge.js'

/** Столько попыток на уровень за день челленджа. */
export const MAX_ATTEMPTS = 3

/**
 * Новый ключ, а не новая версия старого. Прежняя запись хранила один день,
 * привязанный к дате, и перенести её в дни челленджа нечем: какому дню
 * принадлежал «2026-08-12», знает только сам человек. Старый ключ не читается
 * вовсе — он описывает мир до челленджа.
 */
const STORAGE_KEY = KEYS.challengeAttempts

/** Номер дня как ключ хранилища: 1..30, строкой — JSON других ключей не знает. */
const dayKey = (day) => String(Math.max(1, Math.round(Number(day)) || 1))

/**
 * Рядом с днями лежат ещё две вещи, и обе служебные.
 *
 * `started` — сколько ЗАХОДОВ на уровень человек начал за день. Не то же самое,
 * что записанные попытки: заход считается в момент старта, брошенный он или
 * доигранный. Нужен сиду трассы — иначе брошенная сессия не меняла бы трассу, и
 * человек, начавший день заново, получал бы ту же самую последовательность
 * мишеней (ровно это и было: в логе `attempt:1` у всех и всегда).
 *
 * `pending` — НЕЗАКРЫТАЯ ПОПЫТКА. Черновик текущего захода: обновляется по ходу
 * сессии и превращается в настоящую попытку ровно один раз (см. closePending).
 * Про то, зачем он вообще нужен, — там же.
 *
 * `resume` — ГДЕ ЧЕЛОВЕК ОСТАНОВИЛСЯ. Черновик отвечает «сколько он успел
 * набрать», и этого хватало, пока заход был всё-или-ничего. Но сессия идёт
 * двадцать минут, а люди выходят на третьем круге — и возвращаться им было
 * некуда: только начинать заново, тратя вторую попытку на то, что уже сделано.
 * Снимок хранит ПОЗИЦИЮ (день, уровень, номер попытки, круг) и накопленное,
 * чтобы продолжение было продолжением, а не новым заходом.
 */
function readAll() {
  // мусор в хранилище или приватный режим — начинаем с чистого листа
  const parsed = readJson(STORAGE_KEY)
  if (!parsed || typeof parsed.days !== 'object' || parsed.days === null) {
    return { days: {}, started: {}, pending: null, resume: null }
  }
  return {
    days: parsed.days,
    started: parsed.started && typeof parsed.started === 'object' ? parsed.started : {},
    pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : null,
    resume: parsed.resume && typeof parsed.resume === 'object' ? parsed.resume : null,
  }
}

function writeAll(store) {
  // не сохранилось — попытки доживут хотя бы до перезагрузки
  writeJson(STORAGE_KEY, store)
  return store
}

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

/**
 * Попытка к записи. Принимается и объект статистики, и голое число.
 *
 * Число — ради того, что уже зовёт submitAttempt со счётом: экран результата
 * одиночного раунда статистики боя не собирает. Считаем такую попытку заходом
 * с одним известным полем, а не отказываем ей: потерять счёт из-за формы
 * вызова было бы хуже, чем сохранить его без подробностей.
 */
function normalizeAttempt(input) {
  const raw = input != null && typeof input === 'object' ? input : { score: input }
  return {
    score: num(raw.score),
    /** Повторы силовых блоков за сессию. */
    reps: num(raw.reps),
    /** Попадания и всего мишеней в боях — по ним видно точность захода. */
    hits: num(raw.hits),
    spawned: num(raw.spawned),
    /** Средняя реакция, мс: главный признак прогресса, которого не видно в очках. */
    reactMs: num(raw.reactMs),
    at: typeof raw.at === 'string' && raw.at ? raw.at : new Date().toISOString(),
  }
}

/** Попытки уровня за день, в порядке игры. */
function attemptsOf(store, day, id) {
  const rows = store.days[dayKey(day)]?.[tierById(id).id]
  if (!Array.isArray(rows)) return []
  // в хранилище могло осесть что угодно; читаем только то, что похоже на попытку
  return rows
    .map((row) => (row != null && typeof row === 'object' ? row : { score: row }))
    .filter((row) => Number.isFinite(Number(row.score)))
    .map((row) => ({ ...row, score: num(row.score) }))
}

const bestOf = (list) => (list.length ? Math.max(...list.map((a) => a.score)) : 0)

/** Сколько попыток на уровне уже сыграно в этот день челленджа. */
export function attemptsUsed(id, day = currentDay()) {
  return attemptsOf(readAll(), day, id).length
}

/** Сколько попыток на уровне осталось в этот день. */
export function attemptsLeft(id, day = currentDay()) {
  return Math.max(0, MAX_ATTEMPTS - attemptsUsed(id, day))
}

/** Номер попытки, которая начнётся сейчас, считая с единицы. */
export function nextAttempt(id, day = currentDay()) {
  return attemptsUsed(id, day) + 1
}

/** Сколько заходов на уровень уже НАЧАТО за день — брошенные тоже. */
export function startedCount(id, day = currentDay()) {
  const store = readAll()
  const tier = tierById(id).id
  const было = Number(store.started?.[dayKey(day)]?.[tier]) || 0
  // записанных попыток не может быть больше, чем начатых заходов: если счётчик
  // потерялся (чужое устройство, чистка кэша), берём то, что заведомо было
  return Math.max(было, attemptsOf(store, day, tier).length)
}

/**
 * ОТМЕТИТЬ НАЧАЛО ЗАХОДА и вернуть его номер.
 *
 * Считается на СТАРТЕ, а не по записи результата. Прежде номер трассы брался из
 * «сколько попыток записано», а записывались они только после семи кругов
 * целиком — то есть никогда. Номер вечно оставался единицей, и трасса была одна
 * и та же у всех, каждый раз.
 *
 * Учёт попыток (их не больше трёх за день) на этот счётчик НЕ опирается: там
 * по-прежнему записанные попытки. Брошенный на первой минуте заход не должен
 * стоить человеку попытки — он должен стоить ему только новой трассы.
 */
export function startAttempt(id, day = currentDay()) {
  const store = readAll()
  const key = dayKey(day)
  const tier = tierById(id).id
  const было = Math.max(Number(store.started?.[key]?.[tier]) || 0, attemptsOf(store, day, tier).length)
  const стало = было + 1
  store.started = { ...(store.started ?? {}), [key]: { ...(store.started?.[key] ?? {}), [tier]: стало } }
  writeAll(store)
  return стало
}

/** Лучший балл на уровне за день. Не играл — ноль. */
export function bestFor(id, day = currentDay()) {
  return bestOf(attemptsOf(readAll(), day, id))
}

/** Итог дня: сумма лучших по трём уровням. */
export function dayTotal(day = currentDay()) {
  const store = readAll()
  return TIERS.reduce((sum, tier) => sum + bestOf(attemptsOf(store, day, tier.id)), 0)
}

/**
 * ИТОГ ЧЕЛЛЕНДЖА — сумма итогов всех записанных дней.
 *
 * Считается по хранилищу, а не по номеру текущего дня: дни, которые человек
 * открывал отладочным `?day=N`, тоже записаны, и складывать надо то, что
 * сыграно, а не то, что пройдено по прогрессу.
 */
export function challengeTotal() {
  const store = readAll()
  return Object.keys(store.days).reduce((sum, key) => sum + dayTotal(key), 0)
}

/**
 * Все попытки дня целиком — для будущего экрана «История».
 *
 * Возвращаются все три уровня всегда, даже несыгранные: пустой массив читается
 * однозначно, а отсутствующий ключ заставил бы экран истории гадать, «не играл»
 * это или «данные не доехали».
 */
export function attemptsFor(day = currentDay()) {
  const store = readAll()
  const tiers = {}
  for (const tier of TIERS) tiers[tier.id] = attemptsOf(store, day, tier.id)
  return { day: Number(dayKey(day)), tiers }
}

/** Полная картина дня — её показывает экран выбора уровня. */
export function daySummary(day = currentDay()) {
  const store = readAll()
  const tiers = TIERS.map((tier) => {
    const list = attemptsOf(store, day, tier.id)
    return {
      ...tier,
      used: list.length,
      left: Math.max(0, MAX_ATTEMPTS - list.length),
      best: bestOf(list),
      /** Уровень с исчерпанными попытками в этот день больше не играется. */
      locked: list.length >= MAX_ATTEMPTS,
    }
  })
  return { day: Number(dayKey(day)), tiers, total: tiers.reduce((sum, t) => sum + t.best, 0) }
}

/**
 * Записать результат попытки.
 *
 * Попытка сверх лимита не записывается: иначе четвёртый заход мог бы улучшить
 * зачёт, и правило трёх попыток перестало бы что-либо значить. Возвращаем при
 * этом честный отказ, а не молчание, — экран результата должен знать, что балл
 * не пошёл в зачёт.
 *
 * @param {string} id уровень
 * @param {object|number} stats статистика захода либо просто счёт
 * @param {number} [day] день челленджа
 */
export function submitAttempt(id, stats, day = currentDay()) {
  const tier = tierById(id)
  const store = readAll()
  const list = attemptsOf(store, day, tier.id)
  const attempt = normalizeAttempt(stats)

  if (list.length >= MAX_ATTEMPTS) {
    return {
      recorded: false,
      attempt: list.length,
      attemptsLeft: 0,
      score: attempt.score,
      best: bestOf(list),
      isBest: false,
      day: Number(dayKey(day)),
      dayTotal: dayTotal(day),
      challengeTotal: challengeTotal(),
    }
  }

  const previousBest = bestOf(list)
  const next = [...list, attempt]
  const key = dayKey(day)
  store.days[key] = { ...(store.days[key] ?? {}), [tier.id]: next }
  writeAll(store)

  return {
    recorded: true,
    attempt: next.length,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - next.length),
    score: attempt.score,
    best: bestOf(next),
    // строго больше: повтор того же балла рекордом дня не является
    isBest: attempt.score > previousBest,
    day: Number(key),
    dayTotal: dayTotal(day),
    challengeTotal: challengeTotal(),
  }
}

/**
 * ЧЕРНОВИК ТЕКУЩЕГО ЗАХОДА — и почему он вообще существует.
 *
 * Попытка обязана пережить ЛЮБОЙ уход: кнопку «Выйти», свайп, закрытую вкладку,
 * убитое из фона приложение. На iOS `pagehide` приходит не всегда, а
 * `visibilitychange` приходит — но он приходит и когда человек просто свернул
 * телефон на минуту и вернулся доигрывать. Записать попытку прямо на нём
 * означало бы закрыть заход, который на самом деле продолжается, и потерять всё,
 * что человек сделает дальше.
 *
 * Поэтому уход со страницы кладёт ЧЕРНОВИК, а не попытку: он переписывается
 * сколько угодно раз и ничего не расходует. Настоящей попыткой он становится
 * ровно один раз — когда заход действительно закончен (см. closePending), либо
 * при следующем открытии раздела, если приложение убили в фоне.
 */
export function holdAttempt(id, stats, day = currentDay()) {
  const store = readAll()
  store.pending = {
    day: Number(dayKey(day)),
    tier: tierById(id).id,
    stats: normalizeAttempt(stats),
  }
  writeAll(store)
}

/** Черновик, если он есть. */
export function pendingAttempt() {
  return readAll().pending
}

/** Забыть черновик, ничего не записав (заход отменён, а не завершён). */
export function dropPending() {
  const store = readAll()
  if (!store.pending) return
  store.pending = null
  writeAll(store)
}

/**
 * ЗАКРЫТЬ ЧЕРНОВИК — превратить его в попытку. Ровно один раз.
 *
 * Возвращает то же, что submitAttempt, или null, если закрывать нечего. Пустой
 * заход (ни очков, ни повторов, ни мишеней) попыткой не становится: открыл,
 * посмотрел и вышел — не повод сжечь одну из трёх попыток дня.
 */
export function closePending() {
  const store = readAll()
  const p = store.pending
  if (!p) return null
  // черновик снимается ДО записи: даже если запись не пройдёт, второй раз он
  // уже не закроется — попытка-дубль хуже потерянной
  store.pending = null
  writeAll(store)
  const st = p.stats ?? {}
  if (!(st.score > 0 || st.reps > 0 || st.spawned > 0)) return null
  return submitAttempt(p.tier, st, p.day)
}

/* ----------------------------------------- незавершённая сессия */

/**
 * СНИМОК НЕЗАВЕРШЁННОЙ СЕССИИ.
 *
 * Кладётся туда же и тогда же, когда черновик попытки: любой уход со страницы,
 * выход кнопкой, свёрнутое приложение. Разница между ними ровно в назначении —
 * черновик отвечает «что записать, если человек не вернётся», снимок отвечает
 * «куда его вернуть, если вернётся».
 *
 * ПУСТОЙ ЗАХОД СНИМКОМ НЕ СТАНОВИТСЯ, и правило то же, что у черновика: открыл,
 * посмотрел и вышел — не повод показывать ему завтра «у тебя начата сессия» и
 * предлагать продолжить ничто.
 *
 * @param {string} id уровень
 * @param {object} snapshot {cycle, index, totals, attempt, runs}
 * @param {number} [day] день челленджа
 */
export function holdSession(id, snapshot, day = currentDay()) {
  const st = snapshot?.totals ?? {}
  // тот же критерий пустоты, что и у closePending
  const empty = !(num(st.score) > 0 || num(st.hits) > 0 || num(st.spawned) > 0 || (Array.isArray(st.strength) && st.strength.length > 0))
  const store = readAll()
  if (empty) {
    if (!store.resume) return
    store.resume = null
    writeAll(store)
    return
  }
  store.resume = {
    day: Number(dayKey(day)),
    tier: tierById(id).id,
    /** Номер попытки: продолжение обязано идти ТОЙ ЖЕ, иначе поедет трасса. */
    attempt: Math.max(1, Math.round(Number(snapshot?.attempt)) || 1),
    /** Круг, на котором человек остановился (1..N). Продолжаем со следующего. */
    cycle: Math.max(1, Math.round(Number(snapshot?.cycle)) || 1),
    /** Заходов на этот день уже сделано — попадёт в зачёт дня. */
    runs: Math.max(1, Math.round(Number(snapshot?.runs)) || 1),
    totals: snapshot?.totals ?? null,
    at: new Date().toISOString(),
  }
  writeAll(store)
}

/**
 * Снимок, если он есть и он про этот день. Чужой день не отдаём: человек мог
 * бросить пятый день и перейти на шестой, и предлагать ему там продолжить
 * пятый — значит вернуть его назад по челленджу.
 */
export function sessionResume(day = currentDay()) {
  const r = readAll().resume
  if (!r) return null
  if (Number(r.day) !== Number(dayKey(day))) return null
  return r
}

/** Есть ли незавершённая сессия на этом дне — для отметки в календаре. */
export const hasSessionResume = (day = currentDay()) => !!sessionResume(day)

/** Забыть снимок: сессия либо продолжена, либо начата заново, либо дошла до конца. */
export function dropSession() {
  const store = readAll()
  if (!store.resume) return
  store.resume = null
  writeAll(store)
}

/**
 * Сид трассы: ДЕНЬ ЧЕЛЛЕНДЖА, уровень, номер попытки и НОМЕР КРУГА.
 *
 * Четыре составляющие дают четыре разных свойства сразу. День челленджа — одна
 * трасса у всех участников на этом дне, иначе сравнивать баллы бессмысленно; и
 * именно день, а не дата, потому что люди идут по челленджу вразнобой, и на
 * общей таблице десятого дня должны стоять одинаковые условия у того, кто дошёл
 * до него в среду, и у того, кто в пятницу. Уровень — свой набор препятствий на
 * каждом, иначе профи знал бы трассу новичка наизусть. Номер попытки — вторая
 * попытка не повторяет первую, иначе она превращалась бы в заучивание.
 *
 * НОМЕР КРУГА — четвёртая и добавлена последней. Без него все семь боёв внутри
 * одной сессии шли по одной трассе: полевой лог показал `elbow/l elbow/l foot/r
 * palm/l …` в первом, втором и третьем бою подряд, у всех людей и во все дни.
 * Тренировка превращалась в заучивание восьми движений вместо игры.
 *
 * Честность от этого не страдает ничуть: у всех на дне N, уровне T, попытке K и
 * круге C трасса по-прежнему одна и та же.
 *
 * FNV-1a: короткая, без зависимостей и одинаковая везде. Ноль в сид отдавать
 * нельзя — движок понимает его как «сид не задан».
 */
export function attemptSeed(id, attempt = 1, day = currentDay(), cycle = 0) {
  const круг = Math.max(0, Math.round(Number(cycle)) || 0)
  const source = `${dayKey(day)}|${tierById(id).id}|${Math.max(1, Math.round(Number(attempt)) || 1)}|${круг}`
  let hash = 2166136261
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) || 1
}

/** Начисто — нужно тестам и отладке. Стирает попытки ВСЕХ дней. */
export function resetDay() {
  remove(STORAGE_KEY)
}
