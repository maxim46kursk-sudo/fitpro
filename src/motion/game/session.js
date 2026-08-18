/**
 * СЕССИЯ «ИГРА-ТРЕНИРОВКА» — семь кругов силы и боя, двадцать минут.
 *
 * До этого в игре был один трёхминутный раунд: поток препятствий и всё. Тренировки
 * из него не выходило — нагрузка шла рывками, а половина движений (присед,
 * выпад, звезда) в потоке читалась как реакция, а не как работа.
 *
 * Формат собран из двух разных вещей, и это сознательно:
 *
 *   СИЛА — тридцать секунд одного движения по таймеру. Ничего не летит, спешить
 *     некуда, считается объём. Инструктор в углу показывает, что делать.
 *   БОЙ — полторы минуты потока мишеней. Здесь наоборот: реакция, разные
 *     движения вперемешку и окно зачёта.
 *
 * Между ними отдых: двадцать секунд после силы (она короткая, но плотная) и
 * тридцать после боя. За три секунды до конца отдыха идёт отсчёт — человек
 * должен встать в кадр заранее, а не увидеть первое препятствие и заметаться.
 * Перед самым первым блоком отсчёт длиннее (десять секунд): там человек ещё
 * стоит у телефона и ему надо отойти.
 *
 * ЗДЕСЬ ТОЛЬКО РАСПИСАНИЕ. Ни детекторов, ни очков, ни отрисовки: экран берёт
 * отсюда «что сейчас идёт и сколько осталось», а считают повторы и зачёты те же
 * автоматы, что и раньше.
 */

import { STRENGTH_LABEL, STRENGTH_TYPES } from './strength.js'
import { dayPlan } from './challenge.js'

/**
 * Сколько идёт каждая часть круга.
 *
 * ОТДЫХ УКОРОЧЕН ВДВОЕ по полевому прогону: 20 -> 10 с после силовой и 30 -> 20
 * после боя. Прежние полминуты после боя человек просто стоял — он и так
 * отдыхает в паузах между мишенями, а сплошная минута ожидания на круг рвала
 * тренировку на куски и растягивала сессию до двадцати минут ни за чем.
 *
 * Десять секунд после силовой — это ровно отдышаться; три из них занимает
 * отсчёт, так что пустого ожидания там семь.
 */
export const PHASE_MS = {
  strength: 30000,
  restAfterStrength: 10000,
  fight: 90000,
  restAfterFight: 20000,
}

/** Отсчёт перед блоком: он живёт в хвосте отдыха и время круга не меняет. */
export const COUNTDOWN_MS = 3000

/**
 * ПЕРВЫЙ ОТСЧЁТ — ДЕСЯТЬ СЕКУНД, а не три.
 *
 * Три секунды хватает между блоками: человек уже в кадре, разогрет и знает, что
 * будет дальше. А на старте он только что нажал кнопку и стоит у телефона — за
 * три секунды он не успевает ни отойти на нужное расстояние, ни встать в кадр
 * целиком, и первый блок начинается без него. Десять — это ровно «отойти,
 * встать, увидеть себя на экране».
 *
 * Отсчёт в хвосте отдыха (COUNTDOWN_MS) при этом НЕ ТРОГАЕТСЯ: он живёт внутри
 * отдыха, и удлини его — круг стал бы короче на семь секунд отдыха.
 */
export const START_COUNTDOWN_MS = 10000

/**
 * Силовые по кругам. Порядок не случайный: тяжёлое ногами (присед, выпад) идёт
 * раньше, чем прыжковое (присед с прыжком, прыжок), а между ними вклиниваются
 * движения на другую зону — иначе к пятому кругу ноги отказывают, и человек
 * доигрывает сессию руками.
 */
export const STRENGTH_ORDER = [
  'barrier',
  'lunge',
  'jack',
  'sidelunge',
  'jumpsquat',
  'twistknee',
  'pit',
]

/**
 * Движения боя. Ровно те, что НЕ ушли в силовые блоки: в бою остаётся то, что
 * делается реакцией на летящее, а не повторами на месте.
 */
export const FIGHT_TYPES = [
  'strike',
  'bird',
  'clap',
  'wings',
  'knee',
  'legside',
  'bend',
  'beam',
  'hop',
  'wall',
]

export const CYCLES = STRENGTH_ORDER.length

/**
 * Расписание сессии: плоский список фаз с длительностями.
 *
 * Первый отсчёт стоит отдельной фазой — перед самым первым блоком отдыха ещё
 * не было, а выйти на присед без предупреждения человек не должен. Он же и
 * единственное место, где живёт START_COUNTDOWN_MS: все дни челленджа идут
 * через эту сборку, и десять секунд на «отойти и встать в кадр» человек
 * получает в любом из них.
 */
/**
 * @param {object} options
 * @param {string[]} [options.strengthOrder] Движения по кругам. С появлением
 *   челленджа их задаёт ПЛАН ДНЯ (challenge.js): порядок сдвигается день ото
 *   дня, в разгрузку ударные движения заменяются, а на тяжёлых днях кругов
 *   восемь, и восьмой повторяет движение дня.
 * @param {object} [options.durations] Длительности в миллисекундах — тоже из
 *   плана дня. Константы PHASE_MS остались значением ПО УМОЛЧАНИЮ, то есть
 *   базовым днём: сессия без плана идёт ровно так, как шла до челленджа.
 */
export function buildSession({ strengthOrder = STRENGTH_ORDER, durations = {} } = {}) {
  const at = { ...PHASE_MS, ...durations }
  const phases = [{ kind: 'countdown', durationMs: START_COUNTDOWN_MS, next: strengthOrder[0] }]

  strengthOrder.forEach((movement, cycle) => {
    phases.push({ kind: 'strength', movement, cycle, durationMs: at.strength })
    phases.push({
      kind: 'rest',
      durationMs: at.restAfterStrength,
      cycle,
      next: 'fight',
    })
    phases.push({ kind: 'fight', cycle, durationMs: at.fight })
    const last = cycle === strengthOrder.length - 1
    phases.push({
      kind: last ? 'done' : 'rest',
      durationMs: last ? 0 : at.restAfterFight,
      cycle,
      next: last ? null : strengthOrder[cycle + 1],
    })
  })

  let clock = 0
  for (const phase of phases) {
    phase.startAt = clock
    phase.endAt = clock + phase.durationMs
    clock = phase.endAt
  }
  return { phases, totalMs: clock }
}

/**
 * НА КАКОМ ЧЕЛОВЕК КРУГЕ, считая с единицы, — для полосы прогресса.
 *
 * Внутри расписания круги нумеруются с нуля, а человеку нужен счёт с единицы:
 * «круг 0 из 7» не значит ничего. Самый первый отсчёт своего круга не имеет
 * вовсе — он стоит до первого блока, и человек на нём уже на первом круге.
 *
 * Правило живёт здесь, а не в экране, потому что проверять его надо на всём
 * расписании сразу: экран показывает по одной фазе за раз, и промах на единицу
 * виден только тогда, когда фазы выложены в ряд.
 */
export const cycleOf = (phase) => (phase?.cycle ?? 0) + 1

/**
 * Сколько кругов в этой сессии. Считается по САМОМУ расписанию, а не по плану
 * дня: показанное человеку обязано сходиться с тем, что он на самом деле
 * пройдёт, даже если план однажды разойдётся со сборкой.
 */
export const cyclesOf = (phases) => phases.filter((p) => p.kind === 'strength').length

/**
 * СТАТИСТИКА ПОПЫТКИ из накопленного за сессию — то, что уходит в зачёт дня.
 *
 * Живёт здесь, а не в экране, потому что весь риск тут в арифметике: реакция
 * копится по боям СУММОЙ и числом зачётов, а не средним, и делить её надо один
 * раз в самом конце. Сложи экран восемь средних по боям — и бой с тремя
 * зачётами весил бы столько же, сколько бой с восемьюдесятью, то есть неудачный
 * круг с парой случайных попаданий тянул бы среднюю на себя сильнее, чем целая
 * удачная минута.
 *
 * @param {object} totals накопленное сессией
 * @param {string} at ISO-время окончания
 */
export function attemptStatsOf(totals, at) {
  const t = totals ?? {}
  const count = t.reactCount ?? 0
  return {
    score: t.score ?? 0,
    reps: (t.strength ?? []).reduce((sum, row) => sum + (row.reps ?? 0), 0),
    hits: t.hits ?? 0,
    spawned: t.spawned ?? 0,
    // ни одного зачёта за сессию — реакции нет вовсе; ноль честнее выдуманного
    // числа, и день.js понимает его так же
    reactMs: count > 0 ? Math.round((t.reactSum ?? 0) / count) : 0,
    at,
  }
}

/** Команда, которую увидит человек на следующем блоке. */
export const nextLabelOf = (phase) => {
  if (!phase?.next) return null
  if (phase.next === 'fight') return 'БОЙ'
  return STRENGTH_LABEL[phase.next] ?? phase.next
}

/**
 * Часы сессии: по времени отдаёт текущую фазу, остаток и отсчёт.
 *
 * Время сюда приходит снаружи, своих таймеров модуль не заводит: так его можно
 * прогнать целиком за миллисекунды в тесте и в автопрогоне.
 */
export function createSession(options = {}) {
  const { phases, totalMs } = buildSession(options)
  let index = 0

  return {
    phases,
    totalMs,
    get index() {
      return index
    },

    /**
     * @param {number} clockMs время от начала сессии
     * @returns {{phase: object, leftMs: number, countdown: number|null, done: boolean}}
     */
    at(clockMs) {
      while (index < phases.length - 1 && clockMs >= phases[index].endAt) index += 1
      const phase = phases[index]
      const leftMs = Math.max(0, phase.endAt - clockMs)
      // отсчёт живёт в хвосте отдыха и в отдельной фазе перед самым первым
      // блоком: секунды показываются крупно, а расписание от этого не едет
      const counting = phase.kind === 'countdown' || (phase.kind === 'rest' && leftMs <= COUNTDOWN_MS)
      return {
        phase,
        leftMs,
        countdown: counting ? Math.max(1, Math.ceil(leftMs / 1000)) : null,
        done: phase.kind === 'done',
      }
    },
  }
}

/** Проверка на этапе сборки: силовые сессии обязаны быть силовыми движениями. */
export const sessionIsSane = () =>
  STRENGTH_ORDER.every((type) => STRENGTH_TYPES.includes(type)) &&
  FIGHT_TYPES.every((type) => !STRENGTH_TYPES.includes(type))

/**
 * СЕССИЯ ПО ПЛАНУ ДНЯ — единственное место, где план превращается в расписание.
 *
 * Уровень при этом не трогается: он остаётся базой (точность круга, время его
 * жизни, пауза), а день лишь масштабирует её множителями. Отсюда и раздельные
 * возвраты: `session` — что показывать по часам, `catcher` — что подкрутить в
 * мишенях, `tempoMult` — насколько быстрее крутить инструктора.
 *
 * @param {number} day 1..30
 * @param {object} tier строка уровня из TIERS (levels.js)
 */
export function buildDay(day, tier) {
  const plan = dayPlan(day)
  const session = buildSession({
    strengthOrder: plan.movements,
    durations: {
      strength: plan.strengthSec * 1000,
      restAfterStrength: plan.restStrengthSec * 1000,
      fight: plan.fightSec * 1000,
      restAfterFight: plan.restFightSec * 1000,
    },
  })

  return {
    plan,
    ...session,
    /**
     * Мишени: жизнь и пауза берутся у уровня и умножаются на день. Радиус
     * НЕ ТРОГАЕТСЯ — он и есть точность, а точность это свойство уровня, а не
     * дня: иначе двадцатый день новичка судился бы строже первого дня профи, и
     * результаты людей перестали бы сравниваться.
     */
    catcher: {
      targetLifeMs: Math.round((tier?.targetLifeMs ?? 0) * plan.lifeMult),
      targetGapMs: Math.round((tier?.targetGapMs ?? 0) * plan.gapMult),
    },
    /** Инструктор крутится быстрее — но не быстрее, чем его видно. */
    tempoMult: plan.tempoMult,
  }
}
