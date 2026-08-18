import { describe, expect, it } from 'vitest'
import { DEFAULT_HEEL, DEFAULT_LUNGE, createLegWatchers, readLegs } from './legs.js'
import { LM } from '../pose/landmarks.js'

/**
 * Юнит-проверки выпада назад и захлёста голени на синтетике. Пороги сняты с
 * живой записи и проверены прогоном (см. legs.replay-часть в
 * segments.replay.test.js) — здесь закрепляется ЛОГИКА, то есть ровно те
 * четыре случая, на которых эти два движения путаются между собой и с
 * соседями:
 *
 *   выпад <-> присед        — колени сгибаются одинаково, различает глубина;
 *   захлёст <-> подъём колена — стопа высоко в обоих, различает колено;
 *   захлёст <-> начало выпада — стопа мелькает высоко, различает выдержка;
 *   выпад без мировых точек  — глубины нет, и выпада не должно быть вовсе.
 */

/** Кадр: корпус ровно 0.2 высоты кадра, всё остальное задаётся сверху. */
function pose({
  shoulder = 0.4,
  hip = 0.6,
  kneeLeft = 0.8,
  kneeRight = 0.8,
  ankleLeft = 0.95,
  ankleRight = 0.95,
  visibility = 1,
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  const at = (index, y, x = 0.5) => {
    points[index] = { x, y, z: 0, visibility }
  }
  at(LM.LEFT_SHOULDER, shoulder, 0.45)
  at(LM.RIGHT_SHOULDER, shoulder, 0.55)
  at(LM.LEFT_HIP, hip, 0.47)
  at(LM.RIGHT_HIP, hip, 0.53)
  at(LM.LEFT_KNEE, kneeLeft, 0.47)
  at(LM.RIGHT_KNEE, kneeRight, 0.53)
  at(LM.LEFT_ANKLE, ankleLeft, 0.47)
  at(LM.RIGHT_ANKLE, ankleRight, 0.53)
  return points
}

/**
 * Мировые точки. Важны две вещи: z стоп (больше — дальше от камеры) и ДЛИНА
 * НОГИ, на которую эта глубина делится. Нога собирается из бедра и голени,
 * поэтому в кадре нужны таз, колени и стопы.
 *
 * `leg` — длина ноги в метрах: ею проверяется, что один и тот же выпад у
 * длинноногого и у коротконогого даёт одно и то же число.
 */
function world({ left = 0, right = 0, leg = 1 } = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }))
  const half = leg / 2
  points[LM.LEFT_HIP] = { x: -0.1, y: 0, z: 0 }
  points[LM.RIGHT_HIP] = { x: 0.1, y: 0, z: 0 }
  points[LM.LEFT_KNEE] = { x: -0.1, y: half, z: 0 }
  points[LM.RIGHT_KNEE] = { x: 0.1, y: half, z: 0 }
  points[LM.LEFT_ANKLE] = { x: -0.1, y: leg, z: left * leg }
  points[LM.RIGHT_ANKLE] = { x: 0.1, y: leg, z: right * leg }
  return points
}

/** Стойка: таз на месте, стопы рядом, обе на одной глубине. */
const STAND = { lm: pose(), world: world() }

/**
 * Выпад правой: тело опустилось на 0.35 корпуса (плечи и таз вместе, чтобы
 * корпус остался мерой роста), правая стопа ушла назад на 0.7 длины ноги.
 */
const LUNGE_RIGHT = {
  lm: pose({ shoulder: 0.47, hip: 0.67, kneeLeft: 0.85, kneeRight: 0.87 }),
  world: world({ right: 0.7 }),
}

/**
 * Тот же выпад, но снятый без мировых точек: ногу назад видно только по
 * укорочению голени в кадре — правая голень втрое короче левой.
 */
const LUNGE_FLAT = {
  lm: pose({ shoulder: 0.47, hip: 0.67, kneeLeft: 0.85, kneeRight: 0.87, ankleRight: 0.89 }),
  world: null,
}

/** Захлёст левой: левая стопа на 0.5 корпуса выше правой, таз и колено на месте. */
const HEEL_LEFT = { lm: pose({ ankleLeft: 0.85 }), world: world() }

/** Прогон кадров с шагом 50 мс: так же густо, как живая запись на 20 fps. */
function feed(watcher, frame, { from, to, step = 50 }) {
  const events = []
  for (let t = from; t <= to; t += step) {
    events.push(...watcher.update(t, frame.lm, frame.world))
  }
  return events
}

/** Полторы секунды обычной стойки: по ним детектор узнаёт, где таз в покое. */
function ground(watcher, { from = 0, until = 1500 } = {}) {
  expect(feed(watcher, STAND, { from, to: until })).toEqual([])
  return until
}

describe('признаки кадра', () => {
  it('высота стопы меряется от второй стопы, а глубина — только по миру', () => {
    const legs = readLegs(HEEL_LEFT.lm, HEEL_LEFT.world)

    expect(legs.torso).toBeCloseTo(0.2, 5)
    // (0.95 - 0.85) / 0.2: левая выше правой на полкорпуса
    expect(legs.ankleDy.left).toBeCloseTo(0.5, 5)
    expect(legs.ankleDy.right).toBeCloseTo(-0.5, 5)
    // колено на 0.8 при тазе 0.6 — целый корпус ниже линии таза
    expect(legs.kneeLift.left).toBeCloseTo(-1, 5)
    expect(legs.ankleBack.left).toBe(0)
    // Голень в кадре укорачивается и от захлёста тоже — поднятая стопа идёт к
    // колену. Ровно поэтому укорочение НЕ отличает выпад от захлёста, и их
    // по-прежнему разводит только просадка таза.
    expect(legs.shin.left).toBeLessThan(1)
    // а в обычной стойке голени одинаковы
    expect(readLegs(pose(), world()).shin.left).toBeCloseTo(1, 5)
  })

  it('глубина меряется в долях ноги: длинная и короткая дают одно число', () => {
    // В метрах один и тот же выпад у высокого и у низкого давал разные числа, и
    // общий порог оказывался одному лёгким, а другому недостижимым. Здесь одна
    // и та же поза снята с ногой длиной метр и ногой в 60 сантиметров.
    const longLeg = readLegs(LUNGE_RIGHT.lm, world({ right: 0.7, leg: 1 }))
    const shortLeg = readLegs(LUNGE_RIGHT.lm, world({ right: 0.7, leg: 0.6 }))

    expect(shortLeg.ankleBack.right).toBeCloseTo(longLeg.ankleBack.right, 5)
    // и это число проходит порог: выпад засчитается обоим одинаково
    expect(longLeg.ankleBack.right).toBeGreaterThan(DEFAULT_LUNGE.backK)
  })

  it('укорочение голени видно без всякого 3D — это запасной путь выпада', () => {
    const legs = readLegs(LUNGE_FLAT.lm, null)

    // правая голень 0.02 при левой 0.10 — нога направлена в камеру
    expect(legs.shin.right).toBeCloseTo(0.2, 5)
    expect(legs.shin.right).toBeLessThan(DEFAULT_LUNGE.shinK)
    // и никакой глубины при этом нет вовсе
    expect(legs.ankleBack.right).toBeNull()
  })

  it('нет мировых точек — глубина неизвестна, а не ноль', () => {
    const legs = readLegs(LUNGE_RIGHT.lm, null)

    expect(legs.ankleBack).toEqual({ left: null, right: null })
    // всё остальное по кадру читается как обычно
    expect(legs.torso).toBeCloseTo(0.2, 5)
  })

  it('нет плеч или таза — судить не по чему, все признаки неизвестны', () => {
    const legs = readLegs(pose({ visibility: 0.2 }), world())

    expect(legs.torso).toBeNull()
    expect(legs.hipY).toBeNull()
    expect(legs.ankleDy).toEqual({ left: null, right: null })
  })
})

describe('выпад назад', () => {
  it('нога назад плюс опускание таза с выдержкой — выпад', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // выдержка ещё не набрана: выпад это положение, а не проход мимо
    expect(watcher.update((t += 50), LUNGE_RIGHT.lm, LUNGE_RIGHT.world)).toEqual([])
    expect(watcher.update((t += 50), LUNGE_RIGHT.lm, LUNGE_RIGHT.world)).toEqual([])
    expect(watcher.update((t += 50), LUNGE_RIGHT.lm, LUNGE_RIGHT.world)).toEqual([])

    const [event] = watcher.update((t += 50), LUNGE_RIGHT.lm, LUNGE_RIGHT.world)
    expect(event).toMatchObject({ movement: 'lunge', side: 'right', at: t })
    expect(event.holdMs).toBe(DEFAULT_LUNGE.holdMs)
    expect(event.back).toBeGreaterThan(DEFAULT_LUNGE.backK)
    expect(event.drop).toBeCloseTo(0.35, 5)

    // человек так и стоит в выпаде — второго события нет
    expect(feed(watcher, LUNGE_RIGHT, { from: t + 50, to: t + 500 })).toEqual([])
  })

  it('присед не проходит НИ ОДНИМ из двух путей', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)
    // то же опускание, что и в выпаде, но ноги стоят рядом: обе на одной
    // глубине и обе голени одной длины
    const squat = { lm: LUNGE_RIGHT.lm, world: world() }

    expect(feed(watcher, squat, { from: (t += 50), to: t + 1000 })).toEqual([])
    // таз при этом ушёл вниз даже глубже, чем нужно выпаду: спасают признаки ноги
    expect(watcher.drop).toBeGreaterThanOrEqual(DEFAULT_LUNGE.dropK)

    // и то же самое без мировых точек: голени одинаковы — укорочения нет
    const flat = readLegs(squat.lm, null)
    expect(flat.shin.right).toBeGreaterThan(DEFAULT_LUNGE.shinK)
    const blind = createLegWatchers()
    let b = ground(blind)
    expect(feed(blind, { lm: squat.lm, world: null }, { from: (b += 50), to: b + 1000 })).toEqual(
      [],
    )
  })

  it('нет мировых точек — выпад идёт запасным путём, по укорочению голени', () => {
    // Фронтальная камера глубину не измеряет, а лишь оценивает, и на слабом
    // устройстве оценки может не быть вовсе. Тогда ногу назад видно по тому,
    // что её голень направлена в камеру и на плоской картинке коротка.
    const watcher = createLegWatchers()
    let t = ground(watcher)

    expect(watcher.update((t += 50), LUNGE_FLAT.lm, null)).toEqual([])
    expect(watcher.update((t += 50), LUNGE_FLAT.lm, null)).toEqual([])
    expect(watcher.update((t += 50), LUNGE_FLAT.lm, null)).toEqual([])

    const [event] = watcher.update((t += 50), LUNGE_FLAT.lm, null)
    expect(event).toMatchObject({ movement: 'lunge', side: 'right' })
    // глубины не было вовсе — судили по кадру
    expect(event.back).toBeNull()
    expect(event.shin).toBeLessThan(DEFAULT_LUNGE.shinK)

    // и второго события на том же выпаде нет: флаг снимается только когда ни
    // один из путей больше выпада не видит
    expect(feed(watcher, LUNGE_FLAT, { from: t + 50, to: t + 2000 })).toEqual([])
  })
})

describe('захлёст голени', () => {
  it('стопа вверх при опущенном колене и стоящем тазе — захлёст', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // 350 мс выдержки: семь кадров подряд на 20 fps, и только восьмой считается
    for (let i = 0; i < 7; i += 1) {
      expect(watcher.update((t += 50), HEEL_LEFT.lm, HEEL_LEFT.world)).toEqual([])
    }

    const [event] = watcher.update((t += 50), HEEL_LEFT.lm, HEEL_LEFT.world)
    expect(event).toMatchObject({ movement: 'heel', side: 'left', at: t })
    expect(event.holdMs).toBe(DEFAULT_HEEL.holdMs)
    expect(event.lift).toBeCloseTo(0.5, 5)
    expect(event.kneeLift).toBeCloseTo(-1, 5)
  })

  /**
   * ЗАЩИТА ОТ ВЫПАДА ДЕРЖИТСЯ НА ТАЗЕ, А НЕ НА ГЛУБИНЕ. Полевой лог 14 августа:
   * у промахов захлёста глубина 0.43–0.56 при тогдашнем ограничителе 0.38 —
   * запрет «стопа не ушла назад» резал само движение, потому что стопа, идущая
   * к ягодице, уезжает от камеры и без всякого выпада. Эти два случая и есть
   * новая развилка: глубина большая, но таз стоит — захлёст; таз просел —
   * выпад, сколько бы стопа ни поднялась.
   */
  it('стопа ушла назад по глубине, но таз стоит — это всё ещё захлёст', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // глубина 0.55 доли ноги — прежний ограничитель 0.38 зарезал бы это
    // движение; таз при этом просел всего на 0.03 корпуса, то есть стоит.
    // z здесь 0.635, а не 0.55: глубина делится на длину ноги, а та сама
    // растёт от уехавшей стопы — см. legLengthOf
    const deep = {
      lm: pose({ ankleLeft: 0.85, shoulder: 0.406, hip: 0.606 }),
      world: world({ left: 0.635 }),
    }
    const legs = readLegs(deep.lm, deep.world)
    expect(legs.ankleBack.left).toBeCloseTo(0.55, 2)

    const [event] = feed(watcher, deep, { from: (t += 50), to: (t += 400) })
    expect(event).toMatchObject({ movement: 'heel', side: 'left' })
  })

  it('таз просел на 0.30 — это выпад, и захлёстом он не считается', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // стопа поднята ровно как в захлёсте, но человек ОПУСТИЛСЯ: в захлёсте
    // работает одна голень, а таз не трогается вовсе
    const sank = { lm: pose({ ankleLeft: 0.85, shoulder: 0.46, hip: 0.66 }), world: world({ left: 0.55 }) }

    const events = feed(watcher, sank, { from: (t += 50), to: (t += 1000) })
    expect(events.filter((e) => e.movement === 'heel')).toEqual([])
    expect(watcher.drop).toBeCloseTo(0.3, 2)
    expect(watcher.heel.left.block).toBe('drop')
  })

  it('подъём колена — не захлёст: стопа так же высоко, но колено ушло вверх', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)
    // колено выше линии таза — по нему эти два движения и различаются
    const kneeUp = { lm: pose({ ankleLeft: 0.85, kneeLeft: 0.55 }), world: world() }

    expect(feed(watcher, kneeUp, { from: (t += 50), to: t + 1500 })).toEqual([])
    expect(readLegs(kneeUp.lm, kneeUp.world).kneeLift.left).toBeGreaterThan(DEFAULT_HEEL.kneeMaxK)
  })

  it('начало выпада — не захлёст: стопа мелькает высоко, но всего 200 мс', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // пять кадров = 200 мс, меньше выдержки в 350: так выглядит нога на проходе
    // в выпад, пока она ещё не ушла назад и глубина её не выдаёт
    for (let i = 0; i < 5; i += 1) {
      expect(watcher.update((t += 50), HEEL_LEFT.lm, HEEL_LEFT.world)).toEqual([])
    }
    // нога пошла дальше — выдержка обнуляется и заново с прошлого раза не идёт
    expect(feed(watcher, STAND, { from: (t += 50), to: t + 200 })).toEqual([])
    t += 200
    for (let i = 0; i < 5; i += 1) {
      expect(watcher.update((t += 50), HEEL_LEFT.lm, HEEL_LEFT.world)).toEqual([])
    }
  })
})

/**
 * Один потерянный кадр не должен убивать зачёт. В поле 14 августа захлёст
 * проходил с выдержкой 350 и 351 мс при пороге 350, то есть с запасом ровно в
 * один кадр: любое дрожание признака между кадрами обнуляло накопленное.
 * Проверяется здесь именно граница — короткий срыв выдержку сохраняет, долгий
 * по-прежнему обнуляет.
 */
describe('срыв на один кадр выдержку не обнуляет', () => {
  it('200 мс, провал на кадр, ещё 200 — захлёст засчитан', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // держится 200 мс — до порога в 350 ещё далеко
    expect(feed(watcher, HEEL_LEFT, { from: (t += 50), to: (t += 200) })).toEqual([])

    // один-единственный кадр мимо: стопа дрогнула вниз, как в живой записи
    expect(watcher.update((t += 50), STAND.lm, STAND.world)).toEqual([])
    expect(watcher.heel.left.block).toBe('foot')

    // и снова держится: накопленное не потеряно, порог взят
    const events = feed(watcher, HEEL_LEFT, { from: (t += 50), to: (t += 200) })
    expect(events).toMatchObject([{ movement: 'heel', side: 'left' }])
    // одно событие, а не два: снятого флага «выстрелил» за провал не было
    expect(events).toHaveLength(1)
  })

  it('провал на 300 мс — это конец движения, и выдержка идёт заново', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    expect(feed(watcher, HEEL_LEFT, { from: (t += 50), to: (t += 200) })).toEqual([])
    // 300 мс мимо — дольше форы: столько дырок подряд камера не даёт
    expect(feed(watcher, STAND, { from: (t += 50), to: (t += 300) })).toEqual([])
    // те же 200 мс после — до 350 не хватает, и события нет
    expect(feed(watcher, HEEL_LEFT, { from: (t += 50), to: (t += 200) })).toEqual([])
  })

  it('фора не заменяет саму выдержку: 350 мс подряд всё так же нужны', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // 250 мс с провалом посередине — накопленного всё ещё мало
    expect(feed(watcher, HEEL_LEFT, { from: (t += 50), to: (t += 100) })).toEqual([])
    expect(watcher.update((t += 50), STAND.lm, STAND.world)).toEqual([])
    expect(feed(watcher, HEEL_LEFT, { from: (t += 50), to: (t += 100) })).toEqual([])
  })
})

/**
 * Диагностика автомата. Захлёст требует ЧЕТЫРЁХ условий сразу и подряд 350 мс,
 * и в поле 13 августа он не засчитался ни разу при подъёме стопы втрое выше
 * планки. По пикам каждого признака за окно этого не понять: все четыре могут
 * побывать в норме порознь и ни разу не сойтись в один кадр. Поэтому автомат
 * отдаёт наружу выдержку и то, что мешает прямо сейчас.
 */
describe('выдержка и помеха наружу', () => {
  /** Захлёст левой: стопа поднята, колено внизу, таз на месте, глубины нет. */
  const heelPose = (over = {}) => ({
    lm: pose({ ankleLeft: 0.85, ...over }),
    world: world(),
  })

  it('условие держалось 200 мс и оборвалось — видно и время, и причина', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // пять кадров по 50 мс: выдержка растёт от нуля до 200
    const seen = []
    for (let i = 0; i < 5; i += 1) {
      watcher.update((t += 50), heelPose().lm, heelPose().world)
      seen.push(watcher.heel.left.heldMs)
    }
    expect(seen).toEqual([0, 50, 100, 150, 200])
    // пока держится — мешать нечему
    expect(watcher.heel.left.block).toBeNull()

    // человек поднял колено, и захлёст оборвался, не дотянув до 350
    watcher.update((t += 50), heelPose({ kneeLeft: 0.55 }).lm, heelPose().world)

    expect(watcher.heel.left.heldMs).toBe(0)
    expect(watcher.heel.left.block).toBe('knee')
  })

  it('каждое из четырёх условий называет себя', () => {
    const watcher = createLegWatchers()
    ground(watcher)
    let t = 1500

    const blockOf = (frame) => {
      watcher.update((t += 50), frame.lm, frame.world)
      return watcher.heel.left.block
    }

    // стопа опущена — дело в ней, а не в остальном
    expect(blockOf({ lm: pose(), world: world() })).toBe('foot')
    // стопа поднята, но поднялось и колено
    expect(blockOf(heelPose({ kneeLeft: 0.55 }))).toBe('knee')
    // колено внизу, но человек присел
    expect(blockOf({ lm: pose({ ankleLeft: 0.75, shoulder: 0.5, hip: 0.7 }), world: world() })).toBe(
      'drop',
    )
    // всё на месте, но нога ушла назад по глубине СИЛЬНО — это выпад, а не
    // захлёст. Планка здесь грубая (0.65): сам захлёст доходит до 0.48, и
    // разводит эти два движения таз, а не глубина
    expect(blockOf({ lm: heelPose().lm, world: world({ left: 0.85 }) })).toBe('back')
  })

  it('у выпада помеха называется своими двумя именами', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    // стоит ровно: ногу назад не уносил
    watcher.update((t += 50), STAND.lm, STAND.world)
    expect(watcher.lunge.right.block).toBe('depth')

    // нога назад есть, а просадки таза нет
    watcher.update((t += 50), pose(), world({ right: 0.7 }))
    expect(watcher.lunge.right.block).toBe('drop')

    // и полный выпад — мешать нечему
    watcher.update((t += 50), LUNGE_RIGHT.lm, LUNGE_RIGHT.world)
    expect(watcher.lunge.right.block).toBeNull()
  })

  it('судить не по чему — так и сказано, а не молчанием', () => {
    const watcher = createLegWatchers()
    watcher.update(100, pose({ visibility: 0.2 }), world())

    expect(watcher.heel.left.block).toBe('pose')
    expect(watcher.heel.left.heldMs).toBe(0)
  })
})

describe('рефрактерный период', () => {
  it('второй выпад не приходит раньше, чем пройдёт рефрактерный период', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)

    const [first] = feed(watcher, LUNGE_RIGHT, { from: (t += 50), to: (t += 150) })
    expect(first).toMatchObject({ movement: 'lunge', side: 'right' })

    // вернулся в стойку — флаг «выстрелил» снят, вход разрешён снова
    feed(watcher, STAND, { from: (t += 50), to: (t += 50) })

    // и снова в выпад: выдержка набирается, но события нет — рано
    const early = feed(watcher, LUNGE_RIGHT, {
      from: (t += 50),
      to: first.at + DEFAULT_LUNGE.refractoryMs - 50,
    })
    expect(early).toEqual([])

    const [second] = feed(watcher, LUNGE_RIGHT, {
      from: first.at + DEFAULT_LUNGE.refractoryMs,
      to: first.at + DEFAULT_LUNGE.refractoryMs + 100,
    })
    expect(second).toMatchObject({ movement: 'lunge', side: 'right' })
    expect(second.at - first.at).toBeGreaterThanOrEqual(DEFAULT_LUNGE.refractoryMs)
  })

  it('reset забывает и стойку, и всё, что уже сработало', () => {
    const watcher = createLegWatchers()
    let t = ground(watcher)
    expect(feed(watcher, LUNGE_RIGHT, { from: (t += 50), to: (t += 150) })).toHaveLength(1)

    watcher.reset()
    expect(watcher.drop).toBeNull()

    // после сброса медиана таза набирается заново: первый же кадр выпада
    // становится «домом», и опускания относительно него нет
    ground(watcher, { from: (t += 50), until: (t += 1500) })
    expect(feed(watcher, LUNGE_RIGHT, { from: (t += 50), to: (t += 150) })).toHaveLength(1)
  })
})
