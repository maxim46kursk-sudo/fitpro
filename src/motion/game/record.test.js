// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBest, resetBest, submitScore } from './record.js'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('рекорд', () => {
  it('на чистом устройстве рекорда нет', () => {
    expect(readBest()).toBe(0)
  })

  it('первый же результат становится рекордом', () => {
    expect(submitScore(1200)).toEqual({ best: 1200, isRecord: true })
    expect(readBest()).toBe(1200)
  })

  it('рекорд переживает перезагрузку страницы', () => {
    submitScore(800)
    // модуль ничего не держит в памяти — читает хранилище заново
    expect(readBest()).toBe(800)
  })

  it('слабый результат рекорд не трогает', () => {
    submitScore(1000)

    expect(submitScore(999)).toEqual({ best: 1000, isRecord: false })
    // ровно столько же — тоже не рекорд
    expect(submitScore(1000)).toEqual({ best: 1000, isRecord: false })
    expect(readBest()).toBe(1000)
  })

  it('мусор в хранилище не ломает игру', () => {
    localStorage.setItem('fitpro-motion.game.best.v1', 'не число')
    expect(readBest()).toBe(0)

    expect(submitScore(Number.NaN)).toEqual({ best: 0, isRecord: false })
  })

  it('запись запрещена — игра всё равно доигрывает раунд', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    // приватный режим Safari: сохранить не вышло, но рекорд этой сессии показываем
    expect(submitScore(500)).toEqual({ best: 500, isRecord: true })
  })

  it('сброс очищает рекорд', () => {
    submitScore(700)
    resetBest()
    expect(readBest()).toBe(0)
  })
})
