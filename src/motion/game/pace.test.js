import { describe, expect, it } from 'vitest'
import { createPace } from './pace.js'

/**
 * ЗАПАС НА ДРОГНУВШИЙ ЗАМЕР МЕРЯЕТСЯ В ЗАМЕРАХ, А ЗАПИСАН ВО ВРЕМЕНИ.
 *
 * 120 мс покрывают почти три замера на iPhone (43 мс) и ни одного на Redmi
 * (143 мс) — одно и то же число означает у двух людей разную строгость судьи.
 * Здесь проверяется, что на быстрой съёмке не меняется ничего, а на медленной
 * запас дорастает до одного потерянного замера.
 */
const feed = (pace, step, count, from = 0) => {
  let last = pace.graceMs
  for (let i = 0; i < count; i++) last = pace.see(from + i * step)
  return last
}

describe('темп замеров', () => {
  it('быстрая съёмка: запас остаётся прежним', () => {
    // 23 поз/с — полтора замера это 65 мс, и базовые 120 мс их покрывают
    const pace = createPace(120)
    expect(feed(pace, 43, 20)).toBe(120)
    expect(pace.stepMs).toBe(43)
  })

  it('медленная съёмка: запас дорастает до одного потерянного замера', () => {
    // 7 поз/с — 143 мс на замер, полтора это 215
    const pace = createPace(120)
    expect(feed(pace, 143, 20)).toBe(215)
    expect(pace.stepMs).toBe(143)
  })

  it('пока замеров мало, живём на базовом запасе', () => {
    const pace = createPace(120)
    expect(feed(pace, 143, 3)).toBe(120)
    expect(pace.stepMs).toBeNull()
  })

  it('одиночный провал темпа не раздувает запас', () => {
    /**
     * Телефон уходит думать над кадром, и один промежуток выходит вчетверо
     * длиннее прочих. Среднее от такого поедет, медиана — нет, а запас,
     * раздутый одним провалом, начал бы прощать настоящие срывы движения.
     */
    const pace = createPace(120)
    feed(pace, 43, 20)
    pace.see(20 * 43 + 600)
    for (let i = 1; i <= 5; i++) pace.see(20 * 43 + 600 + i * 43)
    expect(pace.stepMs).toBe(43)
    expect(pace.graceMs).toBe(120)
  })

  it('темп меняется на ходу: телефон перегрелся и замедлился', () => {
    const pace = createPace(120)
    feed(pace, 43, 20)
    expect(pace.graceMs).toBe(120)
    feed(pace, 143, 20, 2000)
    expect(pace.graceMs).toBe(215)
  })

  it('сброс возвращает базовый запас', () => {
    const pace = createPace(120)
    feed(pace, 143, 20)
    pace.reset()
    expect(pace.stepMs).toBeNull()
    expect(pace.graceMs).toBe(120)
  })
})
