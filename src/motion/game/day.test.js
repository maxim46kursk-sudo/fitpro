// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPTS,
  attemptSeed,
  attemptsFor,
  attemptsLeft,
  attemptsUsed,
  bestFor,
  challengeTotal,
  dayTotal,
  daySummary,
  nextAttempt,
  resetDay,
  submitAttempt,
} from './day.js'

/**
 * Учёт попыток по правилам челленджа: три попытки на уровень за ДЕНЬ ЧЕЛЛЕНДЖА,
 * в зачёт лучшая, итог дня — сумма лучших, итог челленджа — сумма дней.
 *
 * Дни здесь называются номерами, а не датами, и это главная перемена: тридцать
 * дней челленджа — это тридцать тренировок, а не тридцать позиций календаря.
 */

const D1 = 1
const D2 = 2

beforeEach(() => {
  localStorage.clear()
})

describe('три попытки на уровень за день челленджа', () => {
  it('пока не играл — все три на месте', () => {
    expect(MAX_ATTEMPTS).toBe(3)
    expect(attemptsLeft('novice', D1)).toBe(3)
    expect(attemptsUsed('novice', D1)).toBe(0)
    expect(nextAttempt('novice', D1)).toBe(1)
  })

  it('каждая попытка уменьшает остаток', () => {
    submitAttempt('novice', { score: 1000 }, D1)
    expect(attemptsLeft('novice', D1)).toBe(2)
    expect(nextAttempt('novice', D1)).toBe(2)

    submitAttempt('novice', { score: 1200 }, D1)
    submitAttempt('novice', { score: 1100 }, D1)
    expect(attemptsLeft('novice', D1)).toBe(0)
    expect(nextAttempt('novice', D1)).toBe(4)
  })

  it('четвёртая попытка не записывается и зачёт не трогает', () => {
    submitAttempt('novice', { score: 1000 }, D1)
    submitAttempt('novice', { score: 1200 }, D1)
    submitAttempt('novice', { score: 900 }, D1)

    const fourth = submitAttempt('novice', { score: 9999 }, D1)

    expect(fourth.recorded).toBe(false)
    expect(fourth.isBest).toBe(false)
    // рекордный балл четвёртой попытки в зачёт не пошёл — иначе правило трёх
    // попыток ничего не значило бы
    expect(fourth.best).toBe(1200)
    expect(bestFor('novice', D1)).toBe(1200)
    expect(attemptsUsed('novice', D1)).toBe(3)
  })

  it('попытки уровней не мешают друг другу', () => {
    submitAttempt('novice', { score: 500 }, D1)
    submitAttempt('novice', { score: 600 }, D1)
    submitAttempt('novice', { score: 700 }, D1)

    expect(attemptsLeft('novice', D1)).toBe(0)
    expect(attemptsLeft('experienced', D1)).toBe(3)
    expect(attemptsLeft('pro', D1)).toBe(3)
  })
})

describe('в зачёт идёт лучшая попытка', () => {
  it('следующая хуже предыдущей — зачёт держит лучшую', () => {
    submitAttempt('pro', { score: 3000 }, D1)
    const second = submitAttempt('pro', { score: 900 }, D1)

    expect(second.recorded).toBe(true)
    expect(second.score).toBe(900)
    expect(second.isBest).toBe(false)
    expect(second.best).toBe(3000)
    expect(bestFor('pro', D1)).toBe(3000)
  })

  it('лучшая приходит третьей — зачёт переезжает на неё', () => {
    submitAttempt('pro', { score: 900 }, D1)
    submitAttempt('pro', { score: 1500 }, D1)
    const third = submitAttempt('pro', { score: 3000 }, D1)

    expect(third.isBest).toBe(true)
    expect(bestFor('pro', D1)).toBe(3000)
  })

  it('повтор того же балла рекордом дня не считается', () => {
    submitAttempt('novice', { score: 1500 }, D1)
    expect(submitAttempt('novice', { score: 1500 }, D1).isBest).toBe(false)
  })
})

describe('попытка — статистика захода, а не голое число', () => {
  it('хранит повторы, попадания, реакцию и время', () => {
    submitAttempt(
      'pro',
      { score: 4200, reps: 110, hits: 561, spawned: 600, reactMs: 640, at: '2026-08-17T10:00:00.000Z' },
      D1,
    )

    const [attempt] = attemptsFor(D1).tiers.pro
    expect(attempt).toEqual({
      score: 4200,
      reps: 110,
      hits: 561,
      spawned: 600,
      reactMs: 640,
      at: '2026-08-17T10:00:00.000Z',
    })
  })

  it('время проставляется само, если его не передали', () => {
    submitAttempt('novice', { score: 100 }, D1)
    const [attempt] = attemptsFor(D1).tiers.novice
    expect(Number.isNaN(Date.parse(attempt.at))).toBe(false)
  })

  it('голый счёт тоже принимается — как заход с одним известным полем', () => {
    /**
     * Экран результата одиночного раунда статистики боя не собирает. Потерять
     * счёт из-за формы вызова было бы хуже, чем сохранить его без подробностей.
     */
    const out = submitAttempt('experienced', 700, D1)
    expect(out.recorded).toBe(true)
    expect(out.score).toBe(700)
    expect(attemptsFor(D1).tiers.experienced[0]).toMatchObject({ score: 700, reps: 0, hits: 0 })
  })

  it('отрицательные и нечисловые поля превращаются в ноль', () => {
    const out = submitAttempt('novice', { score: -50, reps: Number.NaN, reactMs: 'быстро' }, D1)
    expect(out.score).toBe(0)
    expect(attemptsFor(D1).tiers.novice[0]).toMatchObject({ score: 0, reps: 0, reactMs: 0 })
  })

  it('история дня отдаёт все три уровня, даже несыгранные', () => {
    // пустой массив читается однозначно, а отсутствующий ключ заставил бы
    // экран истории гадать: «не играл» это или «данные не доехали»
    submitAttempt('pro', { score: 10 }, D1)
    const day = attemptsFor(D1)
    expect(Object.keys(day.tiers).sort()).toEqual(['experienced', 'novice', 'pro'])
    expect(day.tiers.novice).toEqual([])
    expect(day.day).toBe(1)
  })
})

describe('итог дня — сумма лучших по трём уровням', () => {
  it('складываются именно лучшие, а не все подряд', () => {
    submitAttempt('novice', { score: 1000 }, D1)
    submitAttempt('novice', { score: 1400 }, D1) // в зачёт 1400
    submitAttempt('experienced', { score: 2000 }, D1) // в зачёт 2000
    submitAttempt('pro', { score: 3300 }, D1)
    submitAttempt('pro', { score: 2100 }, D1) // в зачёт остаётся 3300

    expect(dayTotal(D1)).toBe(1400 + 2000 + 3300)
  })

  it('несыгранный уровень даёт ноль, а не ломает сумму', () => {
    submitAttempt('experienced', { score: 700 }, D1)
    expect(dayTotal(D1)).toBe(700)
    expect(bestFor('pro', D1)).toBe(0)
  })

  it('сводка дня показывает попытки, лучший балл и замок', () => {
    submitAttempt('novice', { score: 800 }, D1)
    submitAttempt('novice', { score: 900 }, D1)
    submitAttempt('novice', { score: 850 }, D1)
    submitAttempt('pro', { score: 2500 }, D1)

    const summary = daySummary(D1)
    const novice = summary.tiers.find((t) => t.id === 'novice')
    const pro = summary.tiers.find((t) => t.id === 'pro')
    const experienced = summary.tiers.find((t) => t.id === 'experienced')

    expect(novice).toMatchObject({ used: 3, left: 0, best: 900, locked: true })
    expect(pro).toMatchObject({ used: 1, left: 2, best: 2500, locked: false })
    expect(experienced).toMatchObject({ used: 0, left: 3, best: 0, locked: false })
    expect(summary.total).toBe(900 + 2500)
    // форма та же, что ест экран выбора уровня: tiers[] и total
    expect(summary.tiers).toHaveLength(3)
  })
})

describe('дни челленджа хранятся все', () => {
  it('новый день даёт чистый лист, а прошлый остаётся на месте', () => {
    submitAttempt('novice', { score: 1000 }, D1)
    submitAttempt('novice', { score: 1100 }, D1)
    submitAttempt('novice', { score: 1050 }, D1)
    expect(attemptsLeft('novice', D1)).toBe(0)

    expect(attemptsLeft('novice', D2)).toBe(3)
    expect(dayTotal(D2)).toBe(0)
    // и первый день никуда не делся — именно этого не умела запись по дате
    expect(dayTotal(D1)).toBe(1100)
  })

  it('запись второго дня не стирает первый', () => {
    submitAttempt('novice', { score: 1000 }, D1)
    submitAttempt('pro', { score: 5000 }, D1)

    submitAttempt('novice', { score: 200 }, D2)

    expect(dayTotal(D2)).toBe(200)
    expect(bestFor('pro', D2)).toBe(0)
    // прошлый день цел целиком, вместе с уровнем, который во втором не играли
    expect(bestFor('pro', D1)).toBe(5000)
    expect(dayTotal(D1)).toBe(6000)
  })

  it('итог челленджа — сумма итогов всех дней', () => {
    submitAttempt('novice', { score: 1000 }, 1)
    submitAttempt('pro', { score: 2000 }, 1) // день 1: 3000
    submitAttempt('pro', { score: 4000 }, 7)
    submitAttempt('pro', { score: 1000 }, 7) // день 7: лучшая 4000
    submitAttempt('experienced', { score: 500 }, 30) // день 30: 500

    expect(challengeTotal()).toBe(3000 + 4000 + 500)
  })

  it('без единой попытки итог челленджа — ноль, а не поломка', () => {
    expect(challengeTotal()).toBe(0)
  })

  it('пропущенный календарный день попыток не отнимает', () => {
    /**
     * Ради этого учёт и переехал с дат на дни. Человек пропустил вторник и
     * пришёл в среду на свой недоигранный день: попытки этого дня обязаны быть
     * при нём. Раньше их сбрасывал календарь — то есть отнимал у одного дня и
     * дарил другому.
     */
    submitAttempt('pro', { score: 1200 }, 5)
    expect(attemptsLeft('pro', 5)).toBe(2)
    expect(bestFor('pro', 5)).toBe(1200)
  })
})

describe('сид трассы: день челленджа, уровень, номер попытки', () => {
  it('один день, один уровень, одна попытка — одна трасса у всех', () => {
    expect(attemptSeed('novice', 1, D1)).toBe(attemptSeed('novice', 1, D1))
  })

  it('другой день — другая трасса', () => {
    expect(attemptSeed('novice', 1, D1)).not.toBe(attemptSeed('novice', 1, D2))
  })

  it('трасса не зависит от того, в какой календарный день человек играет', () => {
    /**
     * На общей таблице десятого дня обязаны стоять одинаковые условия у того,
     * кто дошёл до него в среду, и у того, кто в пятницу. Сид знает только
     * номер дня — календаря в нём нет вовсе.
     */
    expect(attemptSeed('pro', 1, 10)).toBe(attemptSeed('pro', 1, '10'))
  })

  it('другой уровень — другая трасса', () => {
    const seeds = new Set(['novice', 'experienced', 'pro'].map((t) => attemptSeed(t, 1, D1)))
    expect(seeds.size).toBe(3)
  })

  it('каждая из трёх попыток даёт свою трассу', () => {
    const seeds = new Set([1, 2, 3].map((n) => attemptSeed('pro', n, D1)))
    expect(seeds.size).toBe(3)
  })

  it('сид всегда положительное целое: ноль движок понимает как «не задан»', () => {
    for (const tier of ['novice', 'experienced', 'pro']) {
      for (const attempt of [1, 2, 3]) {
        for (const day of [1, 15, 30]) {
          const seed = attemptSeed(tier, attempt, day)
          expect(Number.isInteger(seed)).toBe(true)
          expect(seed).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('хранилище не роняет игру', () => {
  it('мусор читается как пустой челлендж', () => {
    localStorage.setItem('fitpro-motion.challenge.attempts.v1', 'не json')
    expect(attemptsLeft('novice', D1)).toBe(3)
    expect(dayTotal(D1)).toBe(0)
    expect(challengeTotal()).toBe(0)
  })

  it('старая запись по дате больше не читается', () => {
    // она описывает мир до челленджа: какому дню принадлежала её дата, знает
    // только сам человек, и перенести её нечем
    localStorage.setItem(
      'fitpro-motion.game.day.v1',
      JSON.stringify({ date: '2026-08-12', tiers: { pro: [9000, 9500] } }),
    )
    expect(attemptsLeft('pro', D1)).toBe(3)
    expect(bestFor('pro', D1)).toBe(0)
  })

  it('сброс очищает попытки всех дней', () => {
    submitAttempt('novice', { score: 1000 }, D1)
    submitAttempt('pro', { score: 2000 }, D2)
    resetDay()

    expect(attemptsLeft('novice', D1)).toBe(3)
    expect(challengeTotal()).toBe(0)
  })
})
