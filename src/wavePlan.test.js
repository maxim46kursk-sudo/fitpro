import { describe, it, expect } from 'vitest'
import {
  buildWavePlan, workingMax, maxFromSet, rirOfRating, stepFromTemplate,
  RIR_BY_STEP, MAX_REPS_FOR_MEASURE,
} from './wavePlan.js'

// Числа здесь — те же, что в утверждённой методике: жим с максимумом 120 кг
// на тяжёлой Силе даёт 87.5 / 92.5 / 97.5 / 97.5, а на лёгком Объёме — 67.5.
// Если раскладка поедет, эти два теста поймают первыми.

const heavySet = { kg: 97.5, reps: 6, rating: 4 } // ≈ 120 кг максимума
const histOf = (...sets) => sets.map(s => ({ sets: [s] }))

describe('волновой движок: оценка и замер', () => {
  it('оценка читается как запас повторений', () => {
    expect(rirOfRating(5)).toBe(0)
    expect(rirOfRating(3)).toBe(2)
    expect(rirOfRating(1)).toBe(4)
    expect(rirOfRating(undefined)).toBe(2) // нет оценки — считаем тройкой
  })

  it('подход длиннее порога в замер максимума не идёт', () => {
    expect(maxFromSet({ kg: 100, reps: 5, rating: 3 })).toBeGreaterThan(0)
    expect(maxFromSet({ kg: 100, reps: MAX_REPS_FOR_MEASURE, rating: 3 })).toBeGreaterThan(0)
    expect(maxFromSet({ kg: 60, reps: 20, rating: 3 })).toBe(0)
  })

  it('запас поднимает замер: лёгкая оценка даёт максимум выше тяжёлой', () => {
    const easy = maxFromSet({ kg: 100, reps: 5, rating: 1 })
    const hard = maxFromSet({ kg: 100, reps: 5, rating: 5 })
    expect(easy).toBeGreaterThan(hard)
    // на пятёрке запас ноль — это чистая Эпли по факту
    expect(Math.round(hard)).toBe(Math.round(100 * (1 + 5 / 30)))
  })
})

describe('волновой движок: рабочий максимум', () => {
  it('потолок ограничивает рост', () => {
    const hist = histOf(
      { kg: 100, reps: 5, rating: 3 },
      { kg: 120, reps: 5, rating: 3 },
      { kg: 140, reps: 5, rating: 3 },
    )
    const capped = workingMax(hist, 2.5)
    const uncapped = workingMax(hist, 1e6)
    expect(capped).toBeLessThan(uncapped)
    expect(capped).toBeLessThanOrEqual(maxFromSet({ kg: 100, reps: 5, rating: 3 }) + 5 + 0.001)
  })

  it('вниз потолка нет', () => {
    const hist = histOf({ kg: 100, reps: 5, rating: 3 }, { kg: 70, reps: 5, rating: 3 })
    expect(workingMax(hist, 2.5)).toBeLessThanOrEqual(maxFromSet({ kg: 100, reps: 5, rating: 3 }) + 0.001)
  })

  it('без годных подходов максимума нет', () => {
    expect(workingMax(histOf({ kg: 60, reps: 20, rating: 3 }))).toBe(0)
  })
})

describe('волновой движок: ступень из шаблона', () => {
  it('20-20-20-20 это лёгкий Объём, 10-8-6-6 — тяжёлая Сила', () => {
    expect(stepFromTemplate([{ reps: 20 }, { reps: 20 }, { reps: 20 }, { reps: 20 }]))
      .toEqual({ phase: 'volume', step: 'light' })
    expect(stepFromTemplate([{ reps: 10 }, { reps: 8 }, { reps: 6 }, { reps: 6 }]))
      .toEqual({ phase: 'strength', step: 'heavy' })
  })
})

describe('волновой движок: раскладка на сегодня', () => {
  it('холодный старт отдаёт веса программы как есть', () => {
    const p = buildWavePlan({ templateSets: [{ reps: 12, templateKg: 40 }, { reps: 10, templateKg: 45 }], sessions: [] })
    expect(p.coldStart).toBe(true)
    expect(p.sets.map(s => s.kg)).toEqual([40, 45])
  })

  it('тяжёлая Сила при максимуме 120 даёт раскладку из методики', () => {
    const hist = histOf(heavySet)
    expect(Math.round(workingMax(hist, 1.25))).toBe(120)
    const p = buildWavePlan({ templateSets: [{ reps: 10 }, { reps: 8 }, { reps: 6 }, { reps: 6 }], sessions: hist, capKg: 1.25 })
    expect(p.step).toBe('heavy')
    expect(p.rir).toBe(RIR_BY_STEP.heavy)
    expect(p.sets.map(s => s.kg)).toEqual([87.5, 92.5, 97.5, 97.5])
  })

  it('лёгкий Объём от того же максимума даёт низ волны', () => {
    const p = buildWavePlan({ templateSets: [{ reps: 20 }, { reps: 20 }, { reps: 20 }, { reps: 20 }], sessions: histOf(heavySet), capKg: 1.25 })
    expect(p.step).toBe('light')
    expect(p.rir).toBe(4)
    expect(p.sets.map(s => s.kg)).toEqual([67.5, 67.5, 67.5, 67.5])
  })

  it('повторения всегда из шаблона, не из истории', () => {
    const p = buildWavePlan({ templateSets: [{ reps: 12 }, { reps: 12 }, { reps: 10 }], sessions: histOf({ kg: 100, reps: 5, rating: 3 }) })
    expect(p.sets.map(s => s.reps)).toEqual([12, 12, 10])
  })

  it('два недобора подряд снимают 5% с максимума', () => {
    const base = { sets: [heavySet] }
    const good = buildWavePlan({ templateSets: [{ reps: 6 }], sessions: [base], capKg: 1.25 })
    const bad = buildWavePlan({
      templateSets: [{ reps: 6 }],
      sessions: [base,
        { sets: [{ kg: 97.5, reps: 5, rating: 5 }], missed: true },
        { sets: [{ kg: 97.5, reps: 4, rating: 5 }], missed: true }],
      capKg: 1.25,
    })
    expect(bad.isDeload).toBe(true)
    expect(bad.sets[0].kg).toBeLessThan(good.sets[0].kg)
  })

  it('один недобор откат не включает', () => {
    const p = buildWavePlan({
      templateSets: [{ reps: 6 }],
      sessions: [{ sets: [heavySet] }, { sets: [{ kg: 97.5, reps: 5, rating: 5 }], missed: true }],
      capKg: 1.25,
    })
    expect(p.isDeload).toBe(false)
  })

  it('ассист-тренажёр остаётся отрицательным', () => {
    const p = buildWavePlan({
      templateSets: [{ reps: 8, templateKg: -30 }],
      sessions: histOf({ kg: -30, reps: 8, rating: 3 }),
      capKg: 1.25,
    })
    expect(p.sets[0].kg).toBeLessThan(0)
  })

  it('пустой шаблон не ломает', () => {
    expect(buildWavePlan({ templateSets: [], sessions: [] })).toBe(null)
  })
})
