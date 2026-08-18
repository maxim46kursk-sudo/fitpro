import { describe, expect, it } from 'vitest'
import { HIT_POINTS, MILESTONE_EVERY, createScore } from './score.js'

const hits = (score, n) => {
  let last = null
  for (let i = 0; i < n; i += 1) last = score.hit()
  return last
}

/**
 * Очки. Главное правило одно: ЦЕНА ОДНА И ТА ЖЕ за любое засчитанное действие.
 *
 * Множитель за серию (×1 -> ×2 -> ×3) убран намеренно: с ним одно и то же
 * движение стоило то 200, то 600, и человек не мог сказать, откуда у него
 * столько очков, не пересчитав весь раунд. Серия осталась, но она теперь про
 * конфетти и звук, а не про счёт.
 */
describe('очки', () => {
  it('засчитанное действие стоит ровно цену уровня', () => {
    const score = createScore()
    expect(score.hit()).toMatchObject({ points: HIT_POINTS, total: 100 })
  })

  it('серия цену НЕ поднимает: десятое попадание стоит столько же, что и первое', () => {
    const score = createScore()

    expect(hits(score, 1)).toMatchObject({ points: HIT_POINTS, total: 100 })
    expect(hits(score, 4)).toMatchObject({ points: HIT_POINTS, total: 500 })
    // раньше здесь начинался ×2, и пятое попадание стоило вдвое
    expect(hits(score, 1)).toMatchObject({ points: HIT_POINTS, total: 600 })
    expect(hits(score, 5)).toMatchObject({ points: HIT_POINTS, total: 1100 })
  })

  it('счёт — это просто число попаданий на цену, и так на любой длине', () => {
    const score = createScore({ hitPoints: 150 })
    hits(score, 37)
    expect(score.getState().total).toBe(37 * 150)
  })

  it('каждый пятый зачёт подряд отмечается — но только конфетти и звуком', () => {
    const score = createScore()

    expect(hits(score, 4).milestone).toBe(false)
    const fifth = hits(score, 1)
    expect(fifth.milestone).toBe(true)
    // и очков за это не прибавилось
    expect(fifth.points).toBe(HIT_POINTS)
    expect(hits(score, MILESTONE_EVERY).milestone).toBe(true)
  })

  it('промах обрывает серию, но очки не отнимает', () => {
    const score = createScore()
    hits(score, 5)
    const totalBefore = score.getState().total

    expect(score.miss()).toMatchObject({ streak: 0, total: totalBefore, milestone: false })
    expect(score.hit()).toMatchObject({ points: HIT_POINTS, streak: 1 })
  })

  it('после промаха отметка серии считается заново', () => {
    const score = createScore()
    hits(score, 4)
    score.miss()

    expect(hits(score, 4).milestone).toBe(false)
    expect(hits(score, 1).milestone).toBe(true)
  })

  it('лучшая серия запоминается, даже если её сбили', () => {
    const score = createScore()
    hits(score, 7)
    score.miss()
    hits(score, 2)

    expect(score.getState()).toMatchObject({ streak: 2, bestStreak: 7, hits: 9, misses: 1 })
  })
})

describe('цену препятствия задаёт уровень', () => {
  it('без аргумента — прежняя сотня', () => {
    expect(createScore().hit()).toMatchObject({ points: HIT_POINTS, hitPoints: HIT_POINTS })
  })

  it('цена уровня идёт в каждое попадание', () => {
    // ОПЫТНЫЙ и ПРОФИ по таблице TIERS
    expect(createScore({ hitPoints: 150 }).hit()).toMatchObject({ points: 150, total: 150 })
    expect(hits(createScore({ hitPoints: 200 }), 3)).toMatchObject({ total: 600 })
  })

  it('комбо умножает именно цену уровня', () => {
    const score = createScore({ hitPoints: 200 })

    // все пять по 200, без всяких надбавок за серию
    expect(hits(score, 4)).toMatchObject({ points: 200, total: 800 })
    expect(hits(score, 1)).toMatchObject({ points: 200, total: 1000 })
    expect(hits(score, 5)).toMatchObject({ points: 200, total: 2000 })
  })

  it('дорогой уровень остаётся дороже на всей серии', () => {
    const cheap = hits(createScore({ hitPoints: 100 }), 12).total
    const rich = hits(createScore({ hitPoints: 200 }), 12).total
    expect(rich).toBe(cheap * 2)
  })

  it('мусор вместо цены не ломает счёт', () => {
    for (const bad of [0, -100, Number.NaN, 'дорого', undefined]) {
      expect(createScore({ hitPoints: bad }).hit()).toMatchObject({ points: HIT_POINTS })
    }
  })
})
