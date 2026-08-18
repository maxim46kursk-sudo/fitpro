// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  SETUP_MOVEMENTS,
  SETUP_REPS,
  createAmplitudeCounter,
  describeBar,
  globalBarOf,
  median,
  setupBarOf,
} from './amplitude.js'
import { DEFAULT_ROUND } from './engine.js'
import { FLOOR_SHARE, readMaxes, resetPersonal } from './personal.js'

/**
 * Замер личной амплитуды на экране «Настройка под себя».
 *
 * Главное здесь — два решения, а не арифметика: повтор засчитывается по ПОЛУ
 * (иначе негибкий человек застрянет на первом же движении и до челленджа не
 * доберётся), а планка считается по МЕДИАНЕ трёх повторов (иначе один шумный
 * кадр задерёт её на всю неделю).
 */

afterEach(() => resetPersonal())

/** Поза-заготовка: всё пусто, интересное дописывается сверху. */
const pose = (over = {}) => ({
  angle: 175,
  hipX: 0.5,
  shoulderX: 0.5,
  shoulderWidth: 0.2,
  kneeLift: { left: -1, right: -1 },
  raise: { left: -2, right: -2 },
  ankleDy: { left: 0, right: 0 },
  ankleBack: { left: 0, right: 0 },
  ankleY: { left: 0.95, right: 0.95 },
  hipY: 0.6,
  torso: 0.2,
  ...over,
})

/** Прогнать череду поз через счётчик и собрать закрытые повторы. */
function run(counter, poses, step = 100) {
  const done = []
  let t = 0
  for (const p of poses) {
    const rep = counter.update((t += step), p)
    if (rep) done.push(rep)
  }
  return done
}

/**
 * Один повтор колена высотой lift: поднял, подержал, опустил. Кадров по три в
 * каждую сторону — так это и выглядит на живой камере, где повтор занимает
 * около секунды, а не два кадра.
 */
const kneeRep = (lift) => [
  ...Array.from({ length: 3 }, () => pose({ kneeLift: { left: -1, right: lift } })),
  ...Array.from({ length: 3 }, () => pose()),
]

describe('планка настройки — половина общей', () => {
  it('повтор засчитывается вдвое ниже игрового порога', () => {
    // Иначе экран знакомства становится экзаменом: человек, которому и нужна
    // личная планка, не отметит ни одного повтора и застрянет.
    for (const movement of SETUP_MOVEMENTS) {
      expect(setupBarOf(movement)).toBeCloseTo(globalBarOf(movement) * FLOOR_SHARE, 6)
    }
    expect(createAmplitudeCounter('knee').bar).toBeCloseTo(DEFAULT_ROUND.kneeLiftK / 2, 6)
  })

  it('глубина приседа считается от калибровки стойки, а не от константы', () => {
    const bar = globalBarOf('barrier', { upAngle: 170, downAngle: 100 })
    expect(bar).toBe(170 - (100 + DEFAULT_ROUND.duckMarginDeg))
  })

  it('у всех девяти движений есть свой общий порог', () => {
    for (const movement of SETUP_MOVEMENTS) {
      expect({ движение: movement, порог: globalBarOf(movement) > 0 }).toEqual({
        движение: movement,
        порог: true,
      })
    }
  })
})

describe('три повтора дают медиану', () => {
  it('планка — середина трёх, а не лучший из них', () => {
    const counter = createAmplitudeCounter('knee')
    const done = run(counter, [...kneeRep(0.3), ...kneeRep(0.5), ...kneeRep(0.4)])

    expect(done.map((d) => d.rep)).toEqual([1, 2, 3])
    expect(counter.reps).toEqual([0.3, 0.5, 0.4])
    expect(counter.result().value).toBe(0.4)
  })

  it('шумный выброс медиану не двигает — ради этого она и взята', () => {
    // дёрнувшаяся точка трекинга задрала бы планку на всю неделю, и человек
    // потом не понял бы, почему игра перестала его засчитывать
    const counter = createAmplitudeCounter('knee')
    run(counter, [...kneeRep(0.3), ...kneeRep(9), ...kneeRep(0.35)])

    expect(counter.result().value).toBe(0.35)
    expect(Math.max(...counter.reps)).toBe(9)
  })

  it('пик повтора — самая высокая точка внутри него, а не последняя', () => {
    const counter = createAmplitudeCounter('knee')
    run(counter, [
      pose({ kneeLift: { left: -1, right: 0.2 } }),
      pose({ kneeLift: { left: -1, right: 0.62 } }),
      pose({ kneeLift: { left: -1, right: 0.3 } }),
      pose(),
    ])

    expect(counter.reps).toEqual([0.62])
  })

  it('повтор закрывается только на возврате: замер в позе не щёлкает счётчик', () => {
    const counter = createAmplitudeCounter('knee')
    const held = Array.from({ length: 12 }, () => pose({ kneeLift: { left: -1, right: 0.5 } }))

    expect(run(counter, held)).toEqual([])
    expect(counter.reps).toEqual([])
  })

  it('повторов не было вовсе — планки нет, а не ноль', () => {
    const counter = createAmplitudeCounter('knee')
    run(counter, [pose(), pose(), pose()])

    expect(counter.result().value).toBeNull()
    expect(median([])).toBeNull()
  })

  it('дребезг на границе не даёт трёх повторов разом', () => {
    const counter = createAmplitudeCounter('knee')
    const bar = counter.bar
    // значение прыгает вокруг планки на соседних кадрах
    const jitter = []
    for (let i = 0; i < 10; i += 1) {
      jitter.push(pose({ kneeLift: { left: -1, right: bar + 0.001 } }))
      jitter.push(pose({ kneeLift: { left: -1, right: bar - 0.001 } }))
    }

    // рефрактерный период 400 мс, кадры по 100 мс: повторов заметно меньше
    expect(run(counter, jitter).length).toBeLessThan(SETUP_REPS)
  })
})

describe('метрики движений', () => {
  it('присед меряется глубиной от стойки', () => {
    const counter = createAmplitudeCounter('barrier', {
      thresholds: { upAngle: 160, downAngle: 100 },
    })
    run(counter, [pose({ angle: 90 }), pose({ angle: 175 })])

    // 160 - 90 = 70 градусов глубины
    expect(counter.reps).toEqual([70])
  })

  it('шаг меряется от домашней позиции, а она — медиана таза', () => {
    const counter = createAmplitudeCounter('wall')
    // стоит на месте, потом уходит вбок и возвращается
    const home = Array.from({ length: 8 }, () => pose({ hipX: 0.5 }))
    run(counter, [...home, pose({ hipX: 0.58 }), pose({ hipX: 0.5 })])

    // 0.08 / 0.2 ширины плеч = 0.4
    expect(counter.reps[0]).toBeCloseTo(0.4, 5)
  })

  it('движение засчитывается любой стороной: левше не надо бить правой', () => {
    // сторона на экране только для показа — планка в personal.js общая
    const left = createAmplitudeCounter('knee')
    run(left, [pose({ kneeLift: { left: 0.5, right: -1 } }), pose()])
    expect(left.reps).toEqual([0.5])
  })

  it('прыжок меряется подъёмом обеих стоп от их медианы', () => {
    const counter = createAmplitudeCounter('pit')
    const ground = Array.from({ length: 12 }, () => pose())
    run(counter, [
      ...ground,
      pose({ ankleY: { left: 0.85, right: 0.85 }, hipY: 0.5 }),
      pose(),
    ])

    // (0.95 - 0.85) / 0.2 = 0.5 корпуса
    expect(counter.reps[0]).toBeCloseTo(0.5, 5)
  })

  it('у выпада замер парный: нога назад и просадка таза сразу', () => {
    /**
     * Обе меры обязательны в игре, значит обе должны быть личными. Иначе
     * человек настраивает ногу, получает мягкую планку по ней — и всё равно не
     * видит ни одного зачёта, потому что упирается в таз, которого настройка не
     * мерила.
     */
    const counter = createAmplitudeCounter('lunge')
    const stand = () => pose()
    const lunge = (back, hipY) =>
      pose({ ankleBack: { left: 0, right: back }, hipY })

    // три выпада с разной глубиной и разной просадкой
    const ground = Array.from({ length: 8 }, stand)
    run(counter, [
      ...ground,
      ...Array.from({ length: 3 }, () => lunge(0.8, 0.66)),
      ...Array.from({ length: 3 }, stand),
      ...Array.from({ length: 3 }, () => lunge(0.9, 0.68)),
      ...Array.from({ length: 3 }, stand),
      ...Array.from({ length: 3 }, () => lunge(0.7, 0.64)),
      ...Array.from({ length: 3 }, stand),
    ])

    expect(counter.reps).toHaveLength(3)
    const { value, drop } = counter.result()
    // медиана по ноге и медиана по тазу — обе, и обе свои
    expect(value).toBeCloseTo(0.8, 5)
    expect(drop).toBeCloseTo(0.3, 5)
  })

  it('выпад настраивается и без мировых точек — по укорочению голени', () => {
    // На телефоне без рабочей оценки глубины иначе не пройти настройку выпада
    // вовсе. Планка по ноге останется общей, а вот просадка таза станет личной.
    const counter = createAmplitudeCounter('lunge')
    // на таком телефоне глубины нет НИ В ОДНОМ кадре, в том числе в стойке
    const blind = { ankleBack: { left: null, right: null } }
    const stand = () => pose({ ...blind, shin: { left: 1, right: 1 } })
    const flat = (hipY) => pose({ ...blind, shin: { left: 1, right: 0.2 }, hipY })

    run(counter, [
      ...Array.from({ length: 8 }, stand),
      ...Array.from({ length: 3 }, () => flat(0.66)),
      ...Array.from({ length: 3 }, stand),
    ])

    expect(counter.reps).toHaveLength(1)
    const { value, drop } = counter.result()
    // глубину мерить было нечем — по ноге планка останется общей
    expect(value).toBeNull()
    // а просадка таза измерена и станет личной
    expect(drop).toBeCloseTo(0.3, 5)
  })

  it('человека не видно — счётчик молчит, а не считает нули', () => {
    const counter = createAmplitudeCounter('knee')
    const blind = pose({ kneeLift: { left: null, right: null } })
    run(counter, [blind, blind, blind])

    expect(counter.reps).toEqual([])
    // неизвестное так и остаётся неизвестным: нулём его считать нельзя
    expect(counter.value).toBeNull()
  })
})

describe('планка объясняется человеку', () => {
  it('каждое движение переводится в то, что можно представить', () => {
    expect(describeBar('barrier', 65, { upAngle: 160 })).toBe('до 95° в колене')
    expect(describeBar('wall', 0.6)).toBe('0.6 ширины плеч в сторону')
    expect(describeBar('lunge', 0.42)).toBe('нога назад на 42% длины ноги')
    expect(describeBar('knee', 0.35)).toBe('колено на 0.35 корпуса выше таза')
  })

  it('у всех девяти есть человеческое описание, и в нём нет NaN', () => {
    for (const movement of SETUP_MOVEMENTS) {
      const text = describeBar(movement, globalBarOf(movement))
      expect({ движение: movement, текст: text.includes('NaN') }).toEqual({
        движение: movement,
        текст: false,
      })
      expect(text.length).toBeGreaterThan(3)
    }
  })

  it('планки нет — так и говорим, а не показываем пустоту', () => {
    expect(describeBar('knee', null)).toBe('общая планка')
  })
})

describe('сброс счётчика', () => {
  it('reset забывает повторы и домашнюю позицию', () => {
    const counter = createAmplitudeCounter('knee')
    run(counter, kneeRep(0.5))
    expect(counter.reps).toHaveLength(1)

    counter.reset()
    expect(counter.reps).toEqual([])
    expect(counter.result().value).toBeNull()
    expect(readMaxes()).toEqual({})
  })
})
