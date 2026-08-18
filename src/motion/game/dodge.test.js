import { describe, expect, it } from 'vitest'
import {
  SIDE,
  dodgeDistance,
  freeSideOf,
  leanDistance,
  readStance,
  toScreenX,
} from './dodge.js'
import { LM } from '../pose/landmarks.js'

/** Кадр с человеком: таз по центру hip, плечи шириной width. */
function frame({ hip = 0.5, width = 0.2, lean = 0, visibility = 1 } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  const shoulder = hip + lean
  pts[LM.LEFT_HIP] = { x: hip - 0.03, y: 0.6, z: 0, visibility }
  pts[LM.RIGHT_HIP] = { x: hip + 0.03, y: 0.6, z: 0, visibility }
  pts[LM.LEFT_SHOULDER] = { x: shoulder - width / 2, y: 0.35, z: 0, visibility }
  pts[LM.RIGHT_SHOULDER] = { x: shoulder + width / 2, y: 0.35, z: 0, visibility }
  return pts
}

const NOTHING = { hipX: null, shoulderX: null, shoulderWidth: null }

describe('детектор шага в сторону', () => {
  it('центр таза и ширина плеч читаются из кадра', () => {
    const stance = readStance(frame({ hip: 0.5, width: 0.24 }))

    expect(stance.hipX).toBeCloseTo(0.5, 5)
    expect(stance.shoulderWidth).toBeCloseTo(0.24, 5)
  })

  it('координата зеркальная: шаг вправо для игрока увеличивает экранный X', () => {
    // человек лицом к фронталке: шагнул в свою правую сторону -> x в кадре упал
    const before = readStance(frame({ hip: 0.5 }))
    const after = readStance(frame({ hip: 0.3 }))

    expect(after.hipX).toBeGreaterThan(before.hipX)
    expect(toScreenX(0.3)).toBeCloseTo(0.7, 5)
  })

  it('ширина плеч не зависит от зеркала', () => {
    expect(readStance(frame({ hip: 0.2, width: 0.2 })).shoulderWidth).toBeCloseTo(
      readStance(frame({ hip: 0.8, width: 0.2 })).shoulderWidth,
      5,
    )
  })

  it('точки не видно — ничего не выдумываем', () => {
    expect(readStance(frame({ visibility: 0.1 }))).toEqual(NOTHING)
    expect(readStance(null)).toEqual(NOTHING)
    expect(readStance([])).toEqual(NOTHING)
  })

  it('смещение считается в сторону, свободную от стены', () => {
    // стена слева на экране — уходим вправо, в больший X
    expect(dodgeDistance(0.7, 0.5, SIDE.LEFT)).toBeCloseTo(0.2, 5)
    expect(dodgeDistance(0.3, 0.5, SIDE.LEFT)).toBeCloseTo(-0.2, 5)

    // стена справа — наоборот
    expect(dodgeDistance(0.3, 0.5, SIDE.RIGHT)).toBeCloseTo(0.2, 5)
    expect(dodgeDistance(0.7, 0.5, SIDE.RIGHT)).toBeCloseTo(-0.2, 5)

    expect(dodgeDistance(null, 0.5, SIDE.LEFT)).toBeNull()
  })

  it('свободная сторона — противоположная стене', () => {
    expect(freeSideOf(SIDE.LEFT)).toBe(SIDE.RIGHT)
    expect(freeSideOf(SIDE.RIGHT)).toBe(SIDE.LEFT)
  })
})

describe('детектор наклона корпуса', () => {
  it('центр плеч читается отдельно от таза и тоже зеркальный', () => {
    // стоит прямо: плечи над тазом
    const straight = readStance(frame({ hip: 0.5 }))
    expect(straight.shoulderX).toBeCloseTo(straight.hipX, 5)

    // наклон корпуса в кадре влево -> на экране плечи ушли вправо от таза
    const leaned = readStance(frame({ hip: 0.5, lean: -0.08 }))
    expect(leaned.hipX).toBeCloseTo(0.5, 5)
    expect(leaned.shoulderX).toBeCloseTo(0.58, 5)
  })

  it('наклон считается от собственного таза, а не от базовой точки', () => {
    // тот же наклон, но человек стоит у края кадра — величина не меняется
    const center = readStance(frame({ hip: 0.5, lean: -0.08 }))
    const edge = readStance(frame({ hip: 0.3, lean: -0.08 }))

    expect(leanDistance(center.shoulderX, center.hipX, SIDE.LEFT)).toBeCloseTo(
      leanDistance(edge.shoulderX, edge.hipX, SIDE.LEFT),
      5,
    )
  })

  it('наклон считается в сторону, свободную от балки', () => {
    // балка слева на экране — уводим плечи вправо
    expect(leanDistance(0.6, 0.5, SIDE.LEFT)).toBeCloseTo(0.1, 5)
    expect(leanDistance(0.4, 0.5, SIDE.LEFT)).toBeCloseTo(-0.1, 5)

    // балка справа — наоборот
    expect(leanDistance(0.4, 0.5, SIDE.RIGHT)).toBeCloseTo(0.1, 5)
    expect(leanDistance(0.6, 0.5, SIDE.RIGHT)).toBeCloseTo(-0.1, 5)

    expect(leanDistance(null, 0.5, SIDE.LEFT)).toBeNull()
    expect(leanDistance(0.6, null, SIDE.LEFT)).toBeNull()
  })

  it('шаг всем телом наклоном не считается: плечи и таз едут вместе', () => {
    const stepped = readStance(frame({ hip: 0.3 }))
    expect(leanDistance(stepped.shoulderX, stepped.hipX, SIDE.LEFT)).toBeCloseTo(0, 5)
  })
})
