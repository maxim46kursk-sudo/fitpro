import { describe, expect, it } from 'vitest'
import { LM } from './landmarks.js'
import {
  MODE,
  QUALITY,
  REASON,
  bodyBox,
  checkFrame,
  createGateState,
  framingHint,
  isPointOk,
} from './frameGate.js'
import { DEFAULT_THRESHOLDS } from '../exercises/thresholds.js'

/** Полностью корректный кадр. */
function fullBody(overrides = {}) {
  const lm = Array.from({ length: 33 }, (_, i) => ({
    x: 0.5,
    y: 0.1 + (i / 33) * 0.8,
    z: 0,
    visibility: 0.9,
  }))
  lm[LM.NOSE] = { x: 0.5, y: 0.08, z: 0, visibility: 0.9 }
  lm[LM.LEFT_SHOULDER] = { x: 0.44, y: 0.2, z: 0, visibility: 0.9 }
  lm[LM.RIGHT_SHOULDER] = { x: 0.56, y: 0.2, z: 0, visibility: 0.9 }
  lm[LM.LEFT_HIP] = { x: 0.46, y: 0.5, z: 0, visibility: 0.9 }
  lm[LM.RIGHT_HIP] = { x: 0.54, y: 0.5, z: 0, visibility: 0.9 }
  lm[LM.LEFT_KNEE] = { x: 0.46, y: 0.7, z: 0, visibility: 0.9 }
  lm[LM.RIGHT_KNEE] = { x: 0.54, y: 0.7, z: 0, visibility: 0.9 }
  lm[LM.LEFT_ANKLE] = { x: 0.46, y: 0.9, z: 0, visibility: 0.9 }
  lm[LM.RIGHT_ANKLE] = { x: 0.54, y: 0.9, z: 0, visibility: 0.9 }

  for (const [index, patch] of Object.entries(overrides)) {
    lm[index] = { ...lm[index], ...patch }
  }
  return lm
}

describe('isPointOk', () => {
  it('порог видимости у голеностопов мягче, чем у крупных точек', () => {
    // 0.35 — типичная visibility голеностопа при верной координате
    expect(isPointOk({ x: 0.5, y: 0.9, visibility: 0.35 }, LM.LEFT_ANKLE)).toBe(true)
    expect(isPointOk({ x: 0.5, y: 0.5, visibility: 0.35 }, LM.LEFT_HIP)).toBe(false)
    expect(isPointOk({ x: 0.5, y: 0.5, visibility: 0.55 }, LM.LEFT_HIP)).toBe(true)
  })

  it('небольшой выход за кадр допустим — модель там ещё считает', () => {
    expect(isPointOk({ x: 0.5, y: 1.02, visibility: 0.9 }, LM.LEFT_ANKLE)).toBe(true)
    expect(isPointOk({ x: -0.03, y: 0.5, visibility: 0.9 }, LM.LEFT_HIP)).toBe(true)
    // но не бесконечно
    expect(isPointOk({ x: 0.5, y: 1.2, visibility: 0.9 }, LM.LEFT_ANKLE)).toBe(false)
  })

  it('нет точки — не годится', () => {
    expect(isPointOk(null, LM.LEFT_ANKLE)).toBe(false)
  })
})

describe('checkFrame', () => {
  it('целый человек в кадре', () => {
    const c = checkFrame(fullBody())
    expect(c.legsOk).toBe(true)
    expect(c.fullBodyOk).toBe(true)
    expect(c.reason).toBe(REASON.OK)
    expect(c.quality).toBe(QUALITY.OK)
    expect(c.missing).toEqual([])
  })

  it('голеностоп с visibility 0.35 и координатой 1.02 — кадр годен', () => {
    const c = checkFrame(
      fullBody({
        [LM.LEFT_ANKLE]: { visibility: 0.35, y: 1.02 },
        [LM.RIGHT_ANKLE]: { visibility: 0.4, y: 1.01 },
      }),
    )
    expect(c.legsOk).toBe(true)
    expect(c.anklesOk).toBe(true)
    // но помечаем как низкоуверенный
    expect(c.quality).toBe(QUALITY.LOW)
    expect(c.lowConfidence.length).toBeGreaterThan(0)
  })

  it('голеностопы совсем потеряны — ноги не годятся, но бёдра и колени есть', () => {
    const c = checkFrame(
      fullBody({
        [LM.LEFT_ANKLE]: { visibility: 0.05 },
        [LM.RIGHT_ANKLE]: { visibility: 0.02 },
      }),
    )
    expect(c.anklesOk).toBe(false)
    expect(c.legsOk).toBe(false)
    expect(c.hipsKneesOk).toBe(true)
    expect(c.reason).toBe(REASON.ANKLES)
  })

  it('человека нет вовсе', () => {
    for (const empty of [null, undefined, []]) {
      const c = checkFrame(empty)
      expect(c.legsOk).toBe(false)
      expect(c.hipsKneesOk).toBe(false)
      expect(c.reason).toBe(REASON.NO_PERSON)
      expect(c.quality).toBe(QUALITY.NONE)
    }
  })

  it('отдаёт детализацию по шести точкам для панели', () => {
    const c = checkFrame(fullBody({ [LM.LEFT_ANKLE]: { visibility: 0.35 } }))
    expect(c.points).toHaveLength(6)
    const ankle = c.points.find((p) => p.index === LM.LEFT_ANKLE)
    expect(ankle.visibility).toBeCloseTo(0.35, 5)
    expect(ankle.threshold).toBe(DEFAULT_THRESHOLDS.visAnkle)
    expect(ankle.ok).toBe(true)
    expect(ankle.x).toBeCloseTo(0.46, 5)
  })

  it('пороги можно поменять на лету', () => {
    const lm = fullBody({ [LM.LEFT_ANKLE]: { visibility: 0.35 } })
    expect(checkFrame(lm, DEFAULT_THRESHOLDS).anklesOk).toBe(true)
    expect(checkFrame(lm, { ...DEFAULT_THRESHOLDS, visAnkle: 0.6 }).anklesOk).toBe(false)
  })
})

describe('createGateState — гистерезис по времени', () => {
  const good = () => checkFrame(fullBody())
  const bad = () =>
    checkFrame(fullBody({ [LM.LEFT_ANKLE]: { visibility: 0.02 }, [LM.RIGHT_ANKLE]: { visibility: 0.02 } }))
  const nobody = () => checkFrame([])

  it('одиночный плохой кадр паузу не включает', () => {
    const gate = createGateState()
    let t = 0
    gate.update(good(), (t += 40))
    gate.update(good(), (t += 40))
    const out = gate.update(bad(), (t += 40))
    expect(out.paused).toBe(false)
    expect(gate.update(good(), (t += 40)).paused).toBe(false)
  })

  it('плохие кадры 0.7 с подряд включают паузу', () => {
    const gate = createGateState()
    let t = 0
    gate.update(good(), (t += 40))

    let paused = false
    for (let i = 0; i < 20; i += 1) {
      paused = gate.update(bad(), (t += 40)).paused
      if (paused) break
    }
    expect(paused).toBe(true)
    expect(t).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.pauseAfterMs)
  })

  it('пауза снимается с первого же хорошего кадра', () => {
    const gate = createGateState()
    let t = 0
    gate.update(good(), (t += 40))
    for (let i = 0; i < 25; i += 1) gate.update(bad(), (t += 40))
    expect(gate.update(bad(), (t += 40)).paused).toBe(true)
    expect(gate.update(good(), (t += 40)).paused).toBe(false)
  })

  it('через 3 с без голеностопов включается резервный режим по тазу', () => {
    const gate = createGateState()
    let t = 0
    gate.update(good(), (t += 40))

    let out = null
    for (let i = 0; i < 100; i += 1) {
      out = gate.update(bad(), (t += 40))
      if (out.fallbackActive) break
    }
    expect(out.fallbackActive).toBe(true)
    expect(out.mode).toBe(MODE.HIP_FALLBACK)
    // подход не остановлен: бёдра и колени видны
    expect(out.paused).toBe(false)
    expect(out.usable).toBe(true)
  })

  it('если человека нет вовсе, резервный режим не спасает — это жёсткая пауза', () => {
    const gate = createGateState()
    let t = 0
    gate.update(good(), (t += 40))
    let out = null
    for (let i = 0; i < 120; i += 1) out = gate.update(nobody(), (t += 40))
    expect(out.paused).toBe(true)
    expect(out.fallbackActive).toBe(false)
  })
})

describe('framingHint', () => {
  const hintFor = (lm) => framingHint(lm, checkFrame(lm)).text

  it('нет человека → встань в кадр', () => {
    expect(hintFor([])).toBe('Встань в кадр')
  })

  it('голеностопы потеряны → отойди дальше, не видно ног', () => {
    expect(
      hintFor(fullBody({ [LM.LEFT_ANKLE]: { visibility: 0.02 }, [LM.RIGHT_ANKLE]: { visibility: 0.02 } })),
    ).toBe('Отойди дальше, не видно ног')
  })

  it('обрезана голова → отойди дальше', () => {
    expect(hintFor(fullBody({ [LM.NOSE]: { y: -0.4 } }))).toBe('Отойди дальше')
  })

  it('человек слишком мелкий → подойди ближе', () => {
    const lm = fullBody()
    for (const p of lm) p.y = 0.5 + (p.y - 0.5) * 0.3
    expect(hintFor(lm)).toBe('Подойди ближе')
  })

  it('смещение вбок → левее/правее, зеркально к превью', () => {
    const right = fullBody()
    for (const p of right) p.x += 0.25
    expect(hintFor(right)).toBe('Встань правее')

    const left = fullBody()
    for (const p of left) p.x -= 0.25
    expect(hintFor(left)).toBe('Встань левее')
  })

  it('всё хорошо → стой так', () => {
    expect(hintFor(fullBody())).toBe('Отлично, стой так')
  })
})

describe('bodyBox', () => {
  it('считает габариты по видимым точкам', () => {
    const box = bodyBox(fullBody())
    expect(box.minY).toBeCloseTo(0.08, 5)
    expect(box.centerX).toBeCloseTo(0.5, 2)
  })

  it('возвращает null, если точек почти нет', () => {
    expect(bodyBox([])).toBe(null)
    expect(bodyBox(null)).toBe(null)
  })
})
