// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  STAND_ANGLE_MAX,
  STAND_ANGLE_MIN,
  applyPersonalCalibration,
  getThresholds,
  isDefaultThresholds,
  resetThresholds,
  setThresholds,
  subscribeThresholds,
} from './thresholds.js'

afterEach(() => {
  resetThresholds()
})

describe('пороги', () => {
  it('по умолчанию совпадают с DEFAULT_THRESHOLDS', () => {
    expect(getThresholds()).toEqual(DEFAULT_THRESHOLDS)
    expect(isDefaultThresholds()).toBe(true)
  })

  it('setThresholds меняет значение и пишет в localStorage', () => {
    setThresholds({ upAngle: 150 })
    expect(getThresholds().upAngle).toBe(150)
    expect(isDefaultThresholds()).toBe(false)

    const raw = JSON.parse(localStorage.getItem('fitpro-motion.thresholds.v2'))
    expect(raw.upAngle).toBe(150)
  })

  it('не даёт порогам схлопнуться — гистерезис сохраняется', () => {
    setThresholds({ downAngle: 175 })
    const t = getThresholds()
    expect(t.upAngle - t.downAngle).toBeGreaterThanOrEqual(10)
  })

  it('уведомляет подписчиков', () => {
    const spy = vi.fn()
    const off = subscribeThresholds(spy)

    setThresholds({ downAngle: 95 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].downAngle).toBe(95)

    off()
    setThresholds({ downAngle: 90 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('reset возвращает значения по умолчанию', () => {
    setThresholds({ upAngle: 140, downAngle: 60 })
    resetThresholds()
    expect(getThresholds()).toEqual(DEFAULT_THRESHOLDS)
  })
})

describe('калибровка по стойке', () => {
  /**
   * Пороги отсчитываются от угла в стойке. Значит, кривой замер — это не
   * «чуть хуже считает», а судейство, в котором присед не засчитывается
   * никогда: на кону деньги челленджа.
   */

  it('нормальная стойка двигает пороги от неё', () => {
    const applied = applyPersonalCalibration(158.7)
    expect(applied.rejected).toBeUndefined()
    expect(applied.standAngle).toBe(158.7)
    expect(applied.upAngle).toBe(147)
    expect(applied.downAngle).toBe(97)
  })

  it('невозможная стойка отвергается, а пороги остаются прежними', () => {
    /**
     * Полевой случай 18 августа: на iPhone стойка намерилась как 37.6°, и
     * пороги встали в UP 110 / DOWN 40 — приседать под такими можно весь день
     * и не получить ни одного зачёта.
     */
    const before = getThresholds()

    const applied = applyPersonalCalibration(37.6)
    expect(applied).toMatchObject({ rejected: true, standAngle: 37.6 })
    expect(applied.min).toBe(STAND_ANGLE_MIN)
    expect(applied.max).toBe(STAND_ANGLE_MAX)
    // ничего не поменялось: ни порогов, ни записанной стойки
    expect(getThresholds()).toEqual(before)
    expect(getThresholds().standAngle).toBeNull()
  })

  it('колено назад не гнётся — переразгиб тоже отвергается', () => {
    expect(applyPersonalCalibration(200).rejected).toBe(true)
    expect(applyPersonalCalibration(STAND_ANGLE_MAX + 0.1).rejected).toBe(true)
  })

  it('границы включительно: край диапазона — ещё рабочая стойка', () => {
    // человек, который заметно не дораспрямляет колено, судейства не теряет
    expect(applyPersonalCalibration(STAND_ANGLE_MIN).rejected).toBeUndefined()
    resetThresholds()
    expect(applyPersonalCalibration(STAND_ANGLE_MAX).rejected).toBeUndefined()
  })

  it('отвергнутый замер не трогает даже уже настроенные пороги', () => {
    applyPersonalCalibration(160)
    const good = getThresholds()

    applyPersonalCalibration(20)
    expect(getThresholds()).toEqual(good)
  })

  it('без числа калибровать нечего', () => {
    expect(applyPersonalCalibration(null)).toBeNull()
    expect(applyPersonalCalibration(NaN)).toBeNull()
  })

  it('выключенная автокалибровка ничего не считает и не отвергает', () => {
    setThresholds({ autoCalibrate: false })
    expect(applyPersonalCalibration(37.6)).toBeNull()
  })
})
