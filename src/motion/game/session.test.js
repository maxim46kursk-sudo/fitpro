import { describe, expect, it } from 'vitest'
import {
  COUNTDOWN_MS,
  CYCLES,
  FIGHT_TYPES,
  PHASE_MS,
  START_COUNTDOWN_MS,
  STRENGTH_ORDER,
  attemptStatsOf,
  buildDay,
  buildSession,
  createSession,
  nextLabelOf,
  sessionIsSane,
} from './session.js'
import { STRENGTH_TYPES } from './strength.js'

/**
 * Расписание сессии. Проверяется не «красиво ли», а то, из-за чего формат
 * рассыпается молча: порядок частей круга, длительность целиком и разделение
 * силовых с боевыми. Ошибись здесь — и человек либо получит присед в бою, либо
 * тренировку на сорок минут вместо двадцати.
 */

describe('расписание сессии', () => {
  const { phases, totalMs } = buildSession()

  it('семь кругов, и в каждом сила -> отдых -> бой -> отдых', () => {
    const cycles = phases.filter((p) => p.kind === 'strength')
    expect(cycles).toHaveLength(CYCLES)
    expect(CYCLES).toBe(7)

    // первый круг целиком, без отсчёта в начале
    const kinds = phases.slice(1, 5).map((p) => p.kind)
    expect(kinds).toEqual(['strength', 'rest', 'fight', 'rest'])
  })

  it('длительности те самые: 30 / 20 / 90 / 30', () => {
    const [strength, rest, fight, after] = phases.slice(1, 5)
    expect(strength.durationMs).toBe(PHASE_MS.strength)
    expect(rest.durationMs).toBe(PHASE_MS.restAfterStrength)
    expect(fight.durationMs).toBe(PHASE_MS.fight)
    expect(after.durationMs).toBe(PHASE_MS.restAfterFight)
  })

  it('вся сессия — около семнадцати минут', () => {
    /**
     * Было двадцать, и полминуты из каждого круга человек просто стоял: он и
     * так отдыхает в паузах между мишенями, а сплошная минута ожидания на круг
     * рвала тренировку на куски. Отдых укорочен вдвое (20 -> 10 после силовой,
     * 30 -> 20 после боя), работа не тронута ни на секунду.
     */
    const minutes = totalMs / 60000
    expect(minutes).toBeGreaterThan(16.5)
    expect(minutes).toBeLessThan(18)
  })

  it('укоротился только отдых — работы столько же', () => {
    const sum = (kind) =>
      phases.filter((p) => p.kind === kind).reduce((total, p) => total + p.durationMs, 0)
    expect(sum('strength')).toBe(7 * 30000)
    expect(sum('fight')).toBe(7 * 90000)
    // а ожидания стало вдвое меньше: 6 длинных отдыхов и 7 коротких
    expect(sum('rest')).toBe(7 * 10000 + 6 * 20000)
  })

  it('силовые идут в заданном порядке и все они силовые', () => {
    expect(phases.filter((p) => p.kind === 'strength').map((p) => p.movement)).toEqual(
      STRENGTH_ORDER,
    )
    for (const movement of STRENGTH_ORDER) expect(STRENGTH_TYPES).toContain(movement)
  })

  it('бой не встречает движений, которые человек уже сделал силовыми', () => {
    // иначе в бою прилетает присед сразу после тридцати секунд приседов
    for (const type of FIGHT_TYPES) expect(STRENGTH_TYPES).not.toContain(type)
    expect(FIGHT_TYPES).toHaveLength(10)
    expect(sessionIsSane()).toBe(true)
  })

  it('последняя фаза — финал, и он один', () => {
    expect(phases[phases.length - 1].kind).toBe('done')
    expect(phases.filter((p) => p.kind === 'done')).toHaveLength(1)
  })
})

describe('статистика попытки для зачёта дня', () => {
  const AT = '2026-08-17T10:00:00.000Z'

  it('складывает повторы всех силовых блоков и попадания всех боёв', () => {
    const stats = attemptStatsOf(
      {
        score: 134200,
        strength: [{ reps: 14 }, { reps: 16 }, { reps: 12 }],
        hits: 561,
        spawned: 600,
        reactSum: 0,
        reactCount: 0,
      },
      AT,
    )

    expect(stats).toEqual({
      score: 134200,
      reps: 42,
      hits: 561,
      spawned: 600,
      reactMs: 0,
      at: AT,
    })
  })

  it('реакция делится ОДИН раз в конце, а не усредняется по боям', () => {
    /**
     * Сложи восемь средних по боям — и бой с тремя зачётами весил бы столько
     * же, сколько бой с восемьюдесятью: неудачный круг с парой случайных
     * попаданий тянул бы среднюю на себя сильнее целой удачной минуты.
     *
     * Здесь: бой из 80 зачётов по 600 мс и бой из 4 по 1400. Правильная
     * средняя — 638; среднее двух средних дало бы 1000.
     */
    const stats = attemptStatsOf(
      { reactSum: 80 * 600 + 4 * 1400, reactCount: 84, strength: [] },
      AT,
    )
    expect(stats.reactMs).toBe(638)
  })

  it('ни одного зачёта за сессию — реакция ноль, а не деление на ноль', () => {
    const stats = attemptStatsOf({ reactSum: 0, reactCount: 0, strength: [] }, AT)
    expect(stats.reactMs).toBe(0)
    expect(Number.isNaN(stats.reactMs)).toBe(false)
  })

  it('пустая сессия даёт нули, а не поломку', () => {
    // бросили на первом круге, вышли через меню — записывать нечего, но и
    // падать не на чем
    expect(attemptStatsOf({}, AT)).toEqual({
      score: 0,
      reps: 0,
      hits: 0,
      spawned: 0,
      reactMs: 0,
      at: AT,
    })
  })
})

describe('часы сессии', () => {
  const session = createSession()

  it('перед первым блоком идёт отсчёт, а не сразу присед', () => {
    const at = session.at(0)
    expect(at.phase.kind).toBe('countdown')
    expect(at.countdown).toBe(10)
    expect(nextLabelOf(at.phase)).toBe('ПРИСЯДЬ')
  })

  it('первый отсчёт — десять секунд: человек стоит у телефона и должен отойти', () => {
    /**
     * Между блоками трёх секунд хватает — человек уже в кадре и разогрет. На
     * старте их не хватает ни на «отойти», ни на «встать в кадр целиком», и
     * первый блок начинался без человека.
     */
    const [first] = buildSession().phases
    expect(first.kind).toBe('countdown')
    expect(first.durationMs).toBe(START_COUNTDOWN_MS)
    expect(START_COUNTDOWN_MS).toBe(10000)
    // и он же считается по секундам до самого конца
    expect(session.at(first.endAt - 500).countdown).toBe(1)
  })

  it('отсчёт живёт в хвосте отдыха, там он прежние три секунды и расписание не сдвигает', () => {
    const { phases } = buildSession()
    const rest = phases.find((p) => p.kind === 'rest')
    // середина отдыха — просто отдых
    expect(session.at(rest.startAt + 1000).countdown).toBeNull()
    // удлинись он вместе со стартовым — отдыха в круге стало бы меньше на семь
    // секунд, а работы столько же
    expect(COUNTDOWN_MS).toBe(3000)
    expect(session.at(rest.endAt - COUNTDOWN_MS - 500).countdown).toBeNull()
    // последние три секунды — уже отсчёт, но фаза всё та же
    const late = session.at(rest.endAt - COUNTDOWN_MS + 500)
    expect(late.phase.kind).toBe('rest')
    expect(late.countdown).toBeGreaterThan(0)
  })

  it('отдых знает, что будет дальше', () => {
    const { phases } = buildSession()
    const afterStrength = phases.find((p) => p.kind === 'rest' && p.next === 'fight')
    const afterFight = phases.find((p) => p.kind === 'rest' && p.next !== 'fight')

    expect(nextLabelOf(afterStrength)).toBe('БОЙ')
    expect(nextLabelOf(afterFight)).toBe('ВЫПАД НАЗАД')
  })

  it('в конце сессии — финал, и дальше он никуда не уходит', () => {
    const fresh = createSession()
    expect(fresh.at(fresh.totalMs + 1).done).toBe(true)
    expect(fresh.at(fresh.totalMs + 600000).done).toBe(true)
  })

  it('фазы идут по порядку и без дыр во времени', () => {
    const { phases } = buildSession()
    for (let i = 1; i < phases.length; i += 1) {
      expect(phases[i].startAt).toBe(phases[i - 1].endAt)
    }
  })
})

/**
 * ПОЗДНИЕ КРУГИ НЕ ТЯЖЕЛЕЕ ПО ЗАМЫСЛУ.
 *
 * Проверка появилась из разбора жалобы «на третьем круге зачёта нет»: прежде чем
 * искать замедление в конвейере, надо было исключить, что игра просто становится
 * плотнее к концу сессии. Не становится — и это должно остаться так, иначе
 * следующий разбор снова начнётся с той же развилки.
 *
 * Живых мишеней у ловца всегда не больше одной по построению (catcher.js держит
 * одну переменную target), поэтому число одновременных мишеней расти не может в
 * принципе. Здесь закрыто остальное: длительность и настройки.
 */
describe('плотность сессии не растёт от круга к кругу', () => {
  const день = buildDay(1, { id: 'pro', targetLifeMs: 2800, targetGapMs: 210 })

  it('все бои одинаковой длины', () => {
    const бои = день.phases.filter((p) => p.kind === 'fight')
    expect(бои.length).toBeGreaterThan(1)
    expect(new Set(бои.map((p) => p.durationMs)).size).toBe(1)
  })

  it('все силовые блоки одинаковой длины', () => {
    const блоки = день.phases.filter((p) => p.kind === 'strength')
    expect(new Set(блоки.map((p) => p.durationMs)).size).toBe(1)
  })

  it('настройки мишеней одни на всю сессию, а не свои у каждого круга', () => {
    // жизнь и пауза мишени приходят одним объектом на день; круг их не трогает
    expect(день.catcher).toEqual({ targetLifeMs: expect.any(Number), targetGapMs: expect.any(Number) })
    expect(день.catcher.targetLifeMs).toBeGreaterThan(0)
    expect(день.catcher.targetGapMs).toBeGreaterThan(0)
  })

  it('отдых между кругами не сокращается к концу сессии', () => {
    const отдых = день.phases.filter((p) => p.kind === 'rest')
    // два вида отдыха (после силового и после боя), и внутри каждого — одна длина
    const после = new Set(отдых.filter((p) => p.next === 'fight').map((p) => p.durationMs))
    expect(после.size).toBe(1)
  })
})
