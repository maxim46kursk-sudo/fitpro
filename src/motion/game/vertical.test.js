import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JUMP,
  DEFAULT_RAISE,
  createJumpWatcher,
  createRaiseWatcher,
  raiseMetric,
} from './vertical.js'
import { LM } from '../pose/landmarks.js'

/**
 * Юнит-проверки двух новых детекторов на синтетике. Пороги сняты с живой записи
 * и проверены прогоном (см. vertical.replay.test.js) — здесь закрепляется
 * ЛОГИКА: что мах требует одной руки и времени, а прыжок — обоих признаков
 * сразу. Именно эти два случая и путались на записях: потягивание двумя руками
 * похоже на мах, а быстрый присед даёт такой же рывок таза, как прыжок.
 */

/** Кадр: корпус ровно 0.2 высоты кадра, всё остальное задаётся сверху. */
function pose({
  nose = 0.2,
  shoulder = 0.4,
  hip = 0.6,
  wristLeft = 0.75,
  wristRight = 0.75,
  ankleLeft = 0.95,
  ankleRight = 0.95,
  visibility = 1,
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  const at = (index, y, x = 0.5) => {
    points[index] = { x, y, z: 0, visibility }
  }
  at(LM.NOSE, nose)
  at(LM.LEFT_SHOULDER, shoulder, 0.45)
  at(LM.RIGHT_SHOULDER, shoulder, 0.55)
  at(LM.LEFT_HIP, hip, 0.47)
  at(LM.RIGHT_HIP, hip, 0.53)
  at(LM.LEFT_WRIST, wristLeft, 0.4)
  at(LM.RIGHT_WRIST, wristRight, 0.6)
  at(LM.LEFT_ANKLE, ankleLeft, 0.47)
  at(LM.RIGHT_ANKLE, ankleRight, 0.53)
  return points
}

/** Рука над головой: метрика ~0.75, как у настоящих махов по записи. */
const UP = 0.05
/** Рука вдоль тела. */
const DOWN = 0.75

describe('мах рукой вверх', () => {
  it('мера — насколько запястье выше носа, в длинах корпуса', () => {
    // корпус 0.2, нос 0.2: рука на 0.05 даёт (0.2 - 0.05) / 0.2
    expect(raiseMetric(pose({ wristLeft: UP }), 'left')).toBeCloseTo(0.75, 5)
    expect(raiseMetric(pose(), 'left')).toBeCloseTo(-2.75, 5)
    // по записям настоящие махи дают 0.72–0.83 — синтетика в том же диапазоне
    expect(raiseMetric(pose({ wristLeft: UP }), 'left')).toBeGreaterThan(DEFAULT_RAISE.enterK)
  })

  it('одна рука вверх с выдержкой — один мах', () => {
    const watcher = createRaiseWatcher('left')
    const up = pose({ wristLeft: UP })

    // до выдержки события нет: мах не мелькание
    expect(watcher.update(0, up)).toBeNull()
    expect(watcher.update(200, up)).toBeNull()

    const event = watcher.update(300, up)
    expect(event).toMatchObject({ side: 'left', at: 300 })
    expect(event.holdMs).toBe(300)
    expect(event.peak).toBeCloseTo(0.75, 5)

    // рука так и висит вверху — второго события нет: мах это переход
    expect(watcher.update(400, up)).toBeNull()
    expect(watcher.update(2000, up)).toBeNull()
  })

  it('потягивание двумя руками — не мах', () => {
    const watcher = createRaiseWatcher('left')
    const both = pose({ wristLeft: UP, wristRight: UP })

    // обе руки над головой: человек потянулся или тянется к телефону
    for (const t of [0, 200, 400, 800, 1600]) expect(watcher.update(t, both)).toBeNull()

    // опустил вторую руку — и это уже мах
    expect(watcher.update(1700, pose({ wristLeft: UP }))).toBeNull()
    expect(watcher.update(2000, pose({ wristLeft: UP }))).toMatchObject({ side: 'left' })
  })

  it('мелькание короче выдержки не считается: так режутся удары выше носа', () => {
    const watcher = createRaiseWatcher('left')
    const up = pose({ wristLeft: UP })

    expect(watcher.update(0, up)).toBeNull()
    // 200 мс — меньше выдержки, и рука уже пошла вниз
    expect(watcher.update(200, up)).toBeNull()
    expect(watcher.update(300, pose())).toBeNull()
    // выдержка считается заново, а не продолжается с прошлого раза
    expect(watcher.update(400, up)).toBeNull()
    expect(watcher.update(500, up)).toBeNull()
    expect(watcher.update(700, up)).toMatchObject({ side: 'left' })
  })

  it('второй мах засчитывается только после того, как рука опустилась', () => {
    const watcher = createRaiseWatcher('left')
    const up = pose({ wristLeft: UP })
    watcher.update(0, up)
    expect(watcher.update(300, up)).toMatchObject({ at: 300 })

    // полпути вниз — гистерезис: это ещё тот же мах, а не новый
    for (const t of [400, 500, 600]) {
      expect(watcher.update(t, pose({ wristLeft: 0.22 }))).toBeNull()
    }
    // рука вдоль тела — мах закончен
    watcher.update(700, pose())
    watcher.update(800, up)
    expect(watcher.update(1100, up)).toMatchObject({ at: 1100 })
  })

  it('своя рука, а не любая: мах правой не засчитывается левой', () => {
    const watcher = createRaiseWatcher('left')
    const rightUp = pose({ wristRight: UP })
    for (const t of [0, 300, 600, 900]) expect(watcher.update(t, rightUp)).toBeNull()
  })

  it('носа или запястья не видно — судить нечего', () => {
    const watcher = createRaiseWatcher('left')
    const blind = pose({ wristLeft: UP, visibility: 0.2 })
    for (const t of [0, 300, 600, 900]) expect(watcher.update(t, blind)).toBeNull()
    expect(raiseMetric(blind, 'left')).toBeNull()
  })
})

describe('прыжок', () => {
  /** Полторы секунды на земле: по ним детектор и узнаёт, где пол. */
  function ground(watcher, { from = 0, until = 1500, step = 50 } = {}) {
    for (let t = from; t <= until; t += step) watcher.update(t, pose())
    return until
  }

  it('обе стопы в воздухе плюс рывок таза — прыжок', () => {
    const watcher = createJumpWatcher()
    const t = ground(watcher)

    // тело целиком уходит вверх: и таз, и плечи, и обе стопы
    const event = watcher.update(t + 50, pose({ shoulder: 0.35, hip: 0.55, ankleLeft: 0.9, ankleRight: 0.9 }))

    expect(event).toMatchObject({ at: t + 50 })
    expect(event.lift).toBeGreaterThan(DEFAULT_JUMP.footLiftK)
    expect(event.surge).toBeGreaterThan(DEFAULT_JUMP.hipSurgeK)
  })

  it('быстрый присед — не прыжок: рывок есть, стопы стоят', () => {
    const watcher = createJumpWatcher()
    let t = ground(watcher)

    // ушёл вниз и резко вернулся: по тазу это неотличимо от прыжка
    watcher.update((t += 50), pose({ shoulder: 0.5, hip: 0.7 }))
    const back = watcher.update((t += 50), pose())

    expect(back).toBeNull()
    // рывок таза при этом даже больше, чем нужно прыжку — спасают только стопы
    expect(watcher.hipSurge).toBeGreaterThan(DEFAULT_JUMP.hipSurgeK)
    expect(watcher.feetLift).toBeLessThan(DEFAULT_JUMP.footLiftK)
  })

  it('одной стопы в воздухе мало: это подъём колена', () => {
    const watcher = createJumpWatcher()
    const t = ground(watcher)

    const event = watcher.update(
      t + 50,
      pose({ shoulder: 0.35, hip: 0.55, ankleLeft: 0.9, ankleRight: 0.95 }),
    )

    expect(event).toBeNull()
    expect(watcher.feetLift).toBeLessThan(DEFAULT_JUMP.footLiftK)
  })

  it('стопы в воздухе без рывка таза — не прыжок', () => {
    const watcher = createJumpWatcher()
    let t = ground(watcher)

    // стопы поджаты медленно, таз стоит на месте — так висят, а не прыгают
    for (const ankle of [0.93, 0.9, 0.9]) {
      const event = watcher.update((t += 300), pose({ ankleLeft: ankle, ankleRight: ankle }))
      expect(event).toBeNull()
    }
    expect(watcher.feetLift).toBeGreaterThan(DEFAULT_JUMP.footLiftK)
    expect(watcher.hipSurge).toBeLessThan(DEFAULT_JUMP.hipSurgeK)
  })

  it('один прыжок — одно событие: полёт длится несколько кадров', () => {
    const watcher = createJumpWatcher()
    let t = ground(watcher)
    const air = pose({ shoulder: 0.35, hip: 0.55, ankleLeft: 0.9, ankleRight: 0.9 })

    const event = watcher.update((t += 50), air)
    expect(event).toBeTruthy()

    // следующие кадры полёта — тот же прыжок, пока идёт рефрактерный период
    expect(watcher.update((t += 50), air)).toBeNull()
    expect(watcher.update((t += 100), air)).toBeNull()
    expect(t - event.at).toBeLessThan(DEFAULT_JUMP.refractoryMs)
  })
})
