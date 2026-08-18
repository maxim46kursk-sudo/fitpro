// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FLOOR_SHARE,
  PERSONAL_SHARE,
  observe,
  personalThreshold,
  readMaxes,
  needsPersonalSetup,
  resetPersonal,
  thresholdFrom,
} from './personal.js'

/**
 * Личная планка амплитуды. Правила Максима: 70% от личного максимума, максимум
 * растёт сам по игре и никогда не опускается.
 *
 * Проверять здесь надо прежде всего ГРАНИЦЫ, а не формулу: на кону деньги, и
 * ровно на границах живут обе попытки сжульничать — занизить калибровку, чтобы
 * собирать зачёты на шевелении, и наоборот, задрать планку так, что детектор
 * начнёт врать.
 */

afterEach(() => {
  resetPersonal()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetPersonal()
})

describe('порог по личному максимуму', () => {
  it('зачёт — 70% от того, что человек показал', () => {
    expect(PERSONAL_SHARE).toBe(0.7)
    // максимум 0.5 при общем пороге 0.45: планка опускается до 0.35
    expect(thresholdFrom(0.5, 0.45)).toBeCloseTo(0.35, 5)
  })

  it('ПОЛ: смехотворный максимум не роняет планку в ноль', () => {
    // человек весь раунд простоял столбом — максимум почти нулевой
    expect(thresholdFrom(0.01, 0.45)).toBeCloseTo(FLOOR_SHARE * 0.45, 5)
    expect(thresholdFrom(0.01, 0.45)).toBeCloseTo(0.225, 5)
    // ниже половины общего порога планка не опускается ни при каком максимуме
    for (const max of [0.001, 0.05, 0.2]) {
      expect(thresholdFrom(max, 0.45)).toBeGreaterThanOrEqual(0.45 * FLOOR_SHARE)
    }
  })

  it('ПОТОЛОК: огромный максимум не делает планку строже общей', () => {
    // 0.7 от 10 — это 7, но общие пороги проверены записями, и выше них
    // детектор ненадёжен: сильному человеку личная настройка ничего не меняет
    expect(thresholdFrom(10, 0.45)).toBe(0.45)
    expect(thresholdFrom(0.65, 0.45)).toBe(0.45)
    for (const max of [0.65, 1, 100]) {
      expect(thresholdFrom(max, 0.45)).toBeLessThanOrEqual(0.45)
    }
  })

  it('нет личных данных — общий порог без изменений', () => {
    // новый человек играет ровно так, как играли все до этого модуля
    for (const empty of [null, undefined, 0, -1, NaN]) {
      expect(thresholdFrom(empty, 0.45)).toBe(0.45)
    }
    expect(personalThreshold('knee', 0.2)).toBe(0.2)
  })

  it('личная планка ходит только между полом и потолком', () => {
    const global = 0.2
    for (let max = 0.01; max < 2; max += 0.01) {
      const bar = thresholdFrom(max, global)
      expect(bar).toBeGreaterThanOrEqual(global * FLOOR_SHARE)
      expect(bar).toBeLessThanOrEqual(global)
    }
  })
})

describe('личный максимум растёт и не опускается', () => {
  it('большее значение поднимает максимум', () => {
    expect(observe('knee', 0.4)).toBe(0.4)
    expect(observe('knee', 0.62)).toBe(0.62)
    expect(readMaxes().knee).toBe(0.62)
  })

  it('меньшее значение НЕ опускает: это защита от заниженной калибровки', () => {
    observe('knee', 0.62)
    // человек устал, отвлёкся или просто промахнулся — максимум описывает не
    // это, а то, на что он способен
    expect(observe('knee', 0.1)).toBe(0.62)
    expect(observe('knee', 0.61)).toBe(0.62)
    expect(readMaxes().knee).toBe(0.62)
  })

  it('ноль, минус и мусор максимум не трогают', () => {
    observe('knee', 0.5)
    for (const junk of [0, -1, NaN, Infinity, null, undefined, '0.9']) {
      observe('knee', junk)
    }
    expect(readMaxes().knee).toBe(0.5)
  })

  it('движения не мешают друг другу', () => {
    observe('knee', 0.6)
    observe('bird', 0.9)

    expect(readMaxes()).toEqual({ knee: 0.6, bird: 0.9 })
    expect(personalThreshold('knee', 0.2)).toBe(0.2) // потолок: 0.42 > 0.2
    expect(personalThreshold('bird', 0.55)).toBeCloseTo(0.63 > 0.55 ? 0.55 : 0.63, 5)
  })

  it('чужая версия и мусор в хранилище читаются как «нет данных»', () => {
    globalThis.localStorage.setItem('fitpro-motion.game.personal.v1', 'не json')
    expect(readMaxes()).toEqual({})

    globalThis.localStorage.setItem(
      'fitpro-motion.game.personal.v1',
      JSON.stringify({ version: 99, max: { knee: 0.9 } }),
    )
    expect(readMaxes()).toEqual({})
  })

  it('запись первой версии читается как «нет данных»: там метры', () => {
    /**
     * В версии 1 глубина выпада лежала в МЕТРАХ, а теперь она в долях
     * собственной ноги. Прочитать старое число как новое значило бы принять
     * полметра за «полноги» и на неделю выдать человеку кривую планку. Дешевле
     * попросить пройти «Настройку под себя» заново.
     */
    globalThis.localStorage.setItem(
      'fitpro-motion.game.personal.v1',
      JSON.stringify({ version: 1, max: { knee: 0.7, lunge: 0.52 } }),
    )

    expect(readMaxes()).toEqual({})
    // а раз данных нет — судим по общим порогам, как и нового человека
    expect(personalThreshold('lunge', 0.55)).toBe(0.55)
    expect(needsPersonalSetup()).toBe(true)
  })

  it('приватный Safari: хранилище бросает — игра не падает', () => {
    // localStorage бросает и на чтение, и на запись, а личная планка — не повод
    // ронять раунд: человек просто играет по общим порогам
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
      removeItem() {
        throw new Error('SecurityError')
      },
    })

    expect(() => observe('knee', 0.7)).not.toThrow()
    expect(readMaxes()).toEqual({})
    // а раз данных нет — судим по общему порогу, как и до всей этой затеи
    expect(personalThreshold('knee', 0.2)).toBe(0.2)
  })
})
