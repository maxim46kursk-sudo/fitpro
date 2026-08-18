import { describe, expect, it } from 'vitest'
import { createPunchWatcher, punchValue, readUpper } from './strike.js'
import { LM } from '../pose/landmarks.js'

/**
 * Поза строится в мире, а кадр получается его проекцией — как у настоящей
 * камеры. Раньше кадр и мир задавались порознь, и тесты меряли не позу, а
 * расхождение двух фикстур.
 *
 * armDir — направление руки от плеча: {y: 1} вниз вдоль тела, {z: -1} прямо
 * в камеру. kneeUp — насколько поднято колено, wristY — принудительная высота
 * запястья в кадре (для проверки «рука опущена»).
 */
function pose({
  armDir = { left: { y: 1, z: 0 }, right: { y: 1, z: 0 } },
  kneeUp = { left: 0, right: 0 },
  visibility = 1,
} = {}) {
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }))
  // мировые координаты в метрах: плечи 0.4 шириной, корпус 0.5, рука 0.6
  world[LM.LEFT_SHOULDER] = { x: -0.2, y: -0.5, z: 0, visibility }
  world[LM.RIGHT_SHOULDER] = { x: 0.2, y: -0.5, z: 0, visibility }
  world[LM.LEFT_HIP] = { x: -0.12, y: 0, z: 0, visibility }
  world[LM.RIGHT_HIP] = { x: 0.12, y: 0, z: 0, visibility }

  for (const [side, shoulderIdx, elbowIdx, wristIdx, kneeIdx] of [
    ['left', LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, LM.LEFT_KNEE],
    ['right', LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, LM.RIGHT_KNEE],
  ]) {
    const shoulder = world[shoulderIdx]
    const d = armDir[side]
    const len = Math.hypot(d.x ?? 0, d.y ?? 0, d.z ?? 0) || 1
    const unit = { x: (d.x ?? 0) / len, y: (d.y ?? 0) / len, z: (d.z ?? 0) / len }

    world[elbowIdx] = {
      x: shoulder.x + unit.x * 0.3,
      y: shoulder.y + unit.y * 0.3,
      z: unit.z * 0.3,
      visibility,
    }
    world[wristIdx] = {
      x: shoulder.x + unit.x * 0.6,
      y: shoulder.y + unit.y * 0.6,
      z: unit.z * 0.6,
      visibility,
    }
    // колено: 0.5 ниже таза, при подъёме идёт вверх
    world[kneeIdx] = { x: shoulder.x, y: 0.5 - kneeUp[side] * 0.5, z: 0, visibility }
  }

  // кадр — ортографическая проекция мира: x и y, глубина не видна
  const SCALE = 0.5
  const CENTER = { x: 0.5, y: 0.5 }
  const frame = world.map((p) => ({
    x: CENTER.x + p.x * SCALE,
    y: CENTER.y + p.y * SCALE,
    z: 0,
    visibility,
  }))

  return { frame, world }
}

/** Рука согнута: локоть на месте, запястье поднято к плечу. */
function bentArm(side, out = {}) {
  const p = pose(out)
  const [shoulderIdx, elbowIdx, wristIdx] =
    side === 'left'
      ? [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST]
      : [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST]

  // запястье возвращается к плечу — рука сложена вдвое, и в кадре, и в мире
  for (const points of [p.world, p.frame]) {
    points[wristIdx] = { ...points[shoulderIdx], visibility: 1 }
  }
  void elbowIdx
  return p
}

describe('чтение рук и колен', () => {
  const read = (p) => readUpper(p.frame, p.world)

  it('согнутая рука укорочением не считается: она коротка и в мире тоже', () => {
    const bent = read(bentArm('left'))

    // это главная ошибка прошлой версии: согнутая рука давала 0.7–0.9
    expect(bent.foreshorten.left).toBeCloseTo(0, 2)
  })

  it('рука в камеру: в кадре коротка, в мире длинная — это и есть удар', () => {
    const punch = read(pose({ armDir: { left: { z: -1 }, right: { y: 1 } } }))

    expect(punch.foreshorten.left).toBeGreaterThan(0.9)
    // вторая рука висит вдоль тела и укорочения не даёт
    expect(punch.foreshorten.right).toBeCloseTo(0, 2)
  })

  it('вынос по глубине читается отдельно от укорочения', () => {
    const rest = read(pose())
    const punch = read(pose({ armDir: { left: { z: -1 }, right: { y: 1 } } }))

    expect(rest.reach.left).toBeCloseTo(0, 2)
    expect(punch.reach.left).toBeCloseTo(1, 1)
  })

  it('поднятое колено даёт положительную высоту, опущенное — отрицательную', () => {
    const upper = read(pose({ kneeUp: { left: 1.2, right: 0 } }))

    expect(upper.kneeLift.left).toBeGreaterThan(0)
    expect(upper.kneeLift.right).toBeLessThan(0)
  })

  it('угол локтя читается по мировым точкам', () => {
    const straight = read(pose())
    expect(straight.elbow.left).toBeCloseTo(180, 0)
  })

  it('точек не видно — ничего не выдумываем', () => {
    const blind = read(pose({ visibility: 0.1 }))

    expect(blind.elbow).toEqual({ left: null, right: null })
    expect(blind.kneeLift).toEqual({ left: null, right: null })
    expect(readUpper(null, null).elbow.left).toBeNull()
  })

  it('без мировых точек мера берётся по углу локтя', () => {
    expect(punchValue({ reach: null, foreshorten: null, elbow: 60 })).toBe(0)
    expect(punchValue({ reach: null, foreshorten: null, elbow: 175 })).toBe(1)
    expect(punchValue({ reach: null, foreshorten: null, elbow: null })).toBeNull()
  })

  it('удар из опущенной руки виден, хотя локоть и не менялся', () => {
    const rest = read(pose())
    const punch = read(pose({ armDir: { left: { z: -1 }, right: { y: 1 } } }))

    const before = punchValue({ reach: rest.reach.left, foreshorten: rest.foreshorten.left })
    const after = punchValue({ reach: punch.reach.left, foreshorten: punch.foreshorten.left })

    // локоть в обоих случаях прямой — раньше на этом всё и ломалось
    expect(rest.elbow.left).toBeCloseTo(punch.elbow.left, 0)
    expect(before).toBeLessThan(0.1)
    expect(after).toBeGreaterThan(0.8)
  })
})

describe('детектор удара', () => {
  const watcher = () => createPunchWatcher({ riseK: 0.25, outK: 0.45, maxMs: 900 })

  it('рывок руки вперёд — удар', () => {
    const punch = watcher()

    expect(punch.update(0, 0.1)).toBeNull()
    const hit = punch.update(300, 0.9)

    expect(hit).toMatchObject({ durationMs: 300, fromValue: 0.1, toValue: 0.9 })
  })

  it('удар засчитывается и из стойки с поднятыми руками', () => {
    const punch = watcher()

    // руки у груди: значение и в покое немаленькое, абсолютный порог тут не помог бы
    punch.update(0, 0.35)
    punch.update(100, 0.34)

    expect(punch.update(300, 0.68)).toMatchObject({ fromValue: 0.34 })
  })

  it('цифры из полевого лога: покой 0.21, удар 0.63 — засчитано', () => {
    const punch = watcher()

    punch.update(0, 0.21)
    punch.update(110, 0.2)
    expect(punch.update(260, 0.63)).toMatchObject({ durationMs: 150 })
  })

  it('медленное вытягивание руки ударом не считается', () => {
    const punch = watcher()

    // рука ползёт вперёд дольше окна памяти: рывка нет
    for (let t = 0; t <= 2000; t += 100) punch.update(t, 0.1 + (t / 2000) * 0.8)

    // за последнее окно рост меньше порога, сколько бы рука ни вытягивалась
    expect(punch.update(2100, 0.92)).toBeNull()
  })

  it('просто вытянутая рука без рывка — не удар', () => {
    const punch = watcher()

    expect(punch.update(0, 0.9)).toBeNull()
    expect(punch.update(200, 0.95)).toBeNull()
  })

  it('удар считается один раз: держать руку вытянутой бесполезно', () => {
    const punch = watcher()

    punch.update(0, 0.1)
    expect(punch.update(200, 0.9)).toBeTruthy()
    expect(punch.update(400, 0.95)).toBeNull()

    // убрал руку и ударил снова — снова засчитано
    punch.update(600, 0.1)
    expect(punch.update(800, 0.8)).toBeTruthy()
  })

  it('время считается от начала рывка', () => {
    const punch = watcher()

    punch.update(0, 0.15)
    punch.update(400, 0.1) // рука ещё убрана, минимум здесь
    const hit = punch.update(600, 0.9)

    expect(hit.durationMs).toBe(200)
  })

  it('удар в один кадр засчитывается: на 9 fps их и бывает один-два', () => {
    const punch = watcher()

    // кадры приходят каждые 110 мс — весь удар умещается между двумя
    punch.update(0, 0.2)
    const hit = punch.update(110, 0.85)

    expect(hit).toMatchObject({ durationMs: 110 })
  })

  it('время меряется по меткам кадров, а не по их числу', () => {
    const fast = watcher()
    fast.update(0, 0.1)
    const a = fast.update(110, 0.9)

    const slow = watcher()
    slow.update(0, 0.1)
    const b = slow.update(880, 0.9)

    // одинаковое число кадров, разное время — и это видно в замере
    expect(a.durationMs).toBe(110)
    expect(b.durationMs).toBe(880)
  })

  it('без значения детектор молчит', () => {
    const punch = watcher()
    expect(punch.update(0, null)).toBeNull()
  })
})
