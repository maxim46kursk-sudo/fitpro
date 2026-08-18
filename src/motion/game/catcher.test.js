import { describe, expect, it } from 'vitest'
import {
  BAG,
  axisGapK,
  DEFAULT_CATCH,
  PART,
  PART_LABEL,
  PART_EXTRA_POINTS,
  PART_POINTS,
  TORSO_K,
  createBag,
  createCatcher,
  createSides,
  distanceK,
  partSpots,
  placeSpot,
  pointsOf,
  poseDir,
  readCatchBody,
  safeGapK,
  sampleSpot,
} from './catcher.js'

/**
 * ЛОВЕЦ МИШЕНЕЙ. Проверяется то, ради чего он и написан, и в таком порядке:
 *
 *   мишень СТАВИТСЯ там, куда человек дотянется, и не там, где нужная часть
 *     тела и так стоит (иначе игра засчитывала бы стояние столбом);
 *   мишень СУДИТСЯ в нормированных координатах, без зеркала и без пикселей;
 *   мишень ЖИВЁТ ровно свой срок, а следующая приходит через паузу;
 *   поток мишеней держит состав мешка и не валит подряд с одной стороны.
 *
 * Тело здесь синтетическое, и это осознанно: живые записи гоняет автопрогон
 * (tools/full-round.mjs), а тут нужны точные числа, которые можно посчитать
 * руками.
 */

/**
 * Кадр 3:4 в портрете, человек стоит по центру. Пропорции взяты с живых
 * записей: корпус — полторы ширины плеч, колено ниже таза на 1.11, стопа на
 * 2.07. Нормированные координаты анизотропны, поэтому по вертикали одна ширина
 * плеч короче, чем по горизонтали, — ровно в отношении сторон кадра.
 */
const W = 0.24
const ASPECT = 4 / 3
/** Одна ширина плеч по y: то же расстояние, но поделённое на высоту кадра. */
const VY = W / ASPECT

function pose(over = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }))
  const put = (index, x, y) => {
    points[index] = { x, y }
  }
  const shoulderY = 0.3
  const hipY = shoulderY + TORSO_K * VY
  // левая половина человека лежит в БОЛЬШИХ x: камера отдаёт кадр незеркальным
  put(0, 0.5, shoulderY - 0.6 * VY) // нос
  put(11, 0.5 + W / 2, shoulderY) // плечи
  put(12, 0.5 - W / 2, shoulderY)
  put(13, 0.5 + 0.45 * W, shoulderY + 0.78 * VY) // локти
  put(14, 0.5 - 0.45 * W, shoulderY + 0.78 * VY)
  put(15, 0.5 + 0.4 * W, shoulderY + 1.45 * VY) // кисти
  put(16, 0.5 - 0.4 * W, shoulderY + 1.45 * VY)
  put(23, 0.5 + 0.29 * W, hipY) // таз
  put(24, 0.5 - 0.29 * W, hipY)
  put(25, 0.5 + 0.29 * W, hipY + 1.11 * VY) // колени
  put(26, 0.5 - 0.29 * W, hipY + 1.11 * VY)
  put(27, 0.5 + 0.29 * W, hipY + 2.07 * VY) // голеностопы
  put(28, 0.5 - 0.29 * W, hipY + 2.07 * VY)
  // носки: ниже голеностопа и чуть вперёд — той же стороной, что и он
  put(31, 0.5 + 0.31 * W, hipY + 2.32 * VY)
  put(32, 0.5 - 0.31 * W, hipY + 2.32 * VY)
  for (const [index, [x, y]] of Object.entries(over)) put(Number(index), x, y)
  return points
}

/** Бросок-заглушка: выдаёт заданные числа по кругу. Раунд обязан быть счётным. */
const rngOf = (...values) => {
  let i = 0
  return () => values[i++ % values.length]
}

/** Кадр, в котором названная точка стоит ровно в центре мишени. */
function reaching(target, side = target.side) {
  const points = pose()
  points[PART_POINTS[target.part][side]] = { x: target.x, y: target.y }
  return points
}

const catcherOf = (over = {}) =>
  createCatcher({ rng: rngOf(0.5, 0.31, 0.72, 0.13, 0.86, 0.44, 0.97, 0.05), ...over })

describe('тело в нормированных координатах', () => {
  it('две единицы длины: своя по горизонтали и своя по вертикали', () => {
    /**
     * Главная мысль всего файла. Нормированные координаты анизотропны: x поделён
     * на ширину кадра, y — на высоту. Мерь расстояние обычным hypot — и на
     * портретном кадре вертикаль окажется короче своей истинной длины на треть,
     * а мишень под колено начнёт «ловиться» стоящей ногой.
     */
    const body = readCatchBody(pose())
    expect(body.ux).toBeCloseTo(W, 5)
    expect(body.uy).toBeCloseTo(VY, 5)
    expect(body.ux / body.uy).toBeCloseTo(ASPECT, 3)
  })

  it('колено, стопа и таз меряются от тела, а не берутся из таблицы', () => {
    const body = readCatchBody(pose())
    expect(body.kneeDropK).toBeCloseTo(1.11, 2)
    expect(body.ankleDropK).toBeCloseTo(2.07, 2)
    expect(body.hipHalfK).toBeCloseTo(0.29, 2)
  })

  it('потерянные колени и стопы подменяются пропорциями, а не нулём', () => {
    // ноги теряются чаще всего, а зона спавна без них не строится вовсе
    const points = pose()
    for (const index of [25, 26, 27, 28]) points[index] = { x: NaN, y: NaN }
    const body = readCatchBody(points)
    expect(body.kneeDropK).toBeGreaterThan(0.5)
    expect(body.ankleDropK).toBeGreaterThan(1.5)
  })

  it('без плеч или таза тела нет вовсе', () => {
    const points = pose()
    points[23] = { x: NaN, y: NaN }
    expect(readCatchBody(points)).toBeNull()
    expect(readCatchBody(null)).toBeNull()
  })

  it('сложенный корпус зоны спавна строить не даёт', () => {
    // плечи ушли к тазу: корпус в кадре стал четвертью себя, вертикальная
    // единица выродилась вместе с ним, и зоны спавна превратились в чепуху
    const deep = 0.3 + TORSO_K * VY * 0.75
    const folded = pose({ 11: [0.5 + W / 2, deep], 12: [0.5 - W / 2, deep] })
    expect(readCatchBody(folded).upright).toBe(false)
    expect(readCatchBody(pose()).upright).toBe(true)
  })
})

describe('стороны и зеркало', () => {
  it('левая сторона человека лежит в больших x — зеркала в судье нет', () => {
    /**
     * Зеркало живёт ровно в одном месте — в отрисовке (см. targets.js).
     * Заведись оно ещё и здесь, и все мишени встали бы не с той стороны.
     */
    expect(poseDir('left')).toBe(1)
    expect(poseDir('right')).toBe(-1)
    const points = pose()
    expect(points[11].x).toBeGreaterThan(points[12].x)
  })

  it('мишень встаёт со своей стороны от опоры части тела', () => {
    const body = readCatchBody(pose())
    const rng = rngOf(0.2, 0.6, 0.9, 0.35, 0.77, 0.44)
    for (const part of Object.values(PART)) {
      for (const side of ['left', 'right']) {
        const origin = part === PART.KNEE || part === PART.FOOT ? body.hip : body.shoulder
        const spot = sampleSpot(body, part, side, rng)
        expect(Math.sign(spot.x - origin.x)).toBe(poseDir(side))
      }
    }
  })
})

describe('зоны спавна', () => {
  const body = readCatchBody(pose())
  /** Пройтись по всей зоне, а не по одной точке: границы важнее середины. */
  const sweep = (part, side) => {
    const out = []
    for (let a = 0; a <= 1.0001; a += 0.1) {
      for (let b = 0; b <= 1.0001; b += 0.1) {
        out.push(sampleSpot(body, part, side, rngOf(a, b)))
      }
    }
    return out
  }
  /** Смещение точки от опоры в ширинах плеч: вниз — плюс. */
  const offset = (spot, origin) => ({
    du: (spot.x - origin.x) / body.ux,
    dv: (spot.y - origin.y) / body.uy,
  })

  it('ладонь — дуга вокруг плеч: от над головой до уровня таза, 1.5–2.2 вбок', () => {
    for (const side of ['left', 'right']) {
      for (const spot of sweep(PART.PALM, side)) {
        const { du, dv } = offset(spot, body.shoulder)
        // 1.96 — предел вытянутой руки: ближний край почти на нём, дальний за ним
        expect(Math.abs(du)).toBeLessThanOrEqual(2.2 + 1e-6)
        // выше головы, но не выше поднятой руки; ниже — не глубже линии таза
        expect(dv).toBeGreaterThanOrEqual(-1.1 - 1e-6)
        expect(dv).toBeLessThanOrEqual(TORSO_K + 1e-6)
      }
    }
  })

  it('локоть — 1.8–2.2 от центра плеч, между плечами и тазом', () => {
    /**
     * Локоть висит в 0.87 ширины плеч от центра плеч. Пока зона была ближней
     * (0.5–0.8), мишени появлялись там, где он болтается собственной походкой,
     * и засчитывались без движения вовсе. Теперь до неё не дотянуться, не унеся
     * вместе с локтем плечо, — то есть не шагнув и не наклонившись.
     */
    for (const side of ['left', 'right']) {
      for (const spot of sweep(PART.ELBOW, side)) {
        const { du, dv } = offset(spot, body.shoulder)
        expect(Math.hypot(du, dv)).toBeGreaterThanOrEqual(1.8 - 1e-6)
        expect(Math.hypot(du, dv)).toBeLessThanOrEqual(2.2 + 1e-6)
        expect(dv).toBeGreaterThanOrEqual(-1e-6)
        expect(dv).toBeLessThanOrEqual(TORSO_K + 1e-6)
      }
    }
  })

  it('колено — 1.3–1.7 вбок от таза, по высоте не ниже середины бедра', () => {
    for (const side of ['left', 'right']) {
      for (const spot of sweep(PART.KNEE, side)) {
        const { du, dv } = offset(spot, body.hip)
        // колено мало поднять — его надо ещё и увести, а это перенос веса
        expect(Math.abs(du)).toBeGreaterThanOrEqual(1.3 - 1e-6)
        expect(Math.abs(du)).toBeLessThanOrEqual(1.7 + 1e-6)
        // колено надо ПОДНЯТЬ: ниже середины бедра мишени не бывает
        expect(dv).toBeGreaterThanOrEqual(-1e-6)
        expect(dv).toBeLessThanOrEqual(body.kneeDropK / 2 + 1e-6)
      }
    }
  })

  it('стопа — 1.5–2.1 вбок от таза, и тем выше, чем дальше вбок', () => {
    for (const side of ['left', 'right']) {
      let previous = null
      for (const spot of sweep(PART.FOOT, side)) {
        const { du, dv } = offset(spot, body.hip)
        expect(Math.abs(du)).toBeGreaterThanOrEqual(1.5 - 1e-6)
        expect(Math.abs(du)).toBeLessThanOrEqual(2.1 + 1e-6)
        // нога у человека одной длины: чем дальше стопа вбок, тем она выше
        if (previous && Math.abs(du) > previous.du) expect(dv).toBeLessThan(previous.dv + 1e-6)
        previous = { du: Math.abs(du), dv }
      }
    }
  })

  it('до любой мишени дотягивается своя конечность — но только со шагом', () => {
    /**
     * Мишень, до которой не дотянуться, — гарантированный промах, то есть
     * наказание ни за что. Но человек в бою НЕ ПРИБИТ К ПОЛУ: шаг, выпад или
     * наклон добавляют ему примерно 0.7 ширины плеч в любую сторону, и зоны
     * построены ровно с этим запасом. Меряем так же — иначе тест требовал бы
     * мишеней, которые достаются стоя, а это и есть та беда, от которой зоны
     * отодвинули.
     *
     * Длины конечностей взяты с живых записей: рука от плеча 1.45 ширины плеч,
     * плечо до локтя 0.78, бедро 1.11, нога от таза 2.07.
     */
    /**
     * У ЛОКТЯ ЗАПАС БОЛЬШЕ ВСЕХ, и это замысел, а не поблажка: его зона (1.8–2.2
     * от центра плеч) вынесена туда, куда локоть не попадает НИКАК, пока человек
     * стоит — плечо от сустава всего 0.78, и остаток пути обязан пройти он сам.
     * Те же числа, что и в автопрогоне (tools/full-round.mjs).
     */
    const STEP = { [PART.ELBOW]: 1.5 }
    const stepOf = (part) => STEP[part] ?? 0.9
    const reach = {
      [PART.PALM]: { joint: 11, limb: 1.45 },
      [PART.ELBOW]: { joint: 11, limb: 0.78 },
      [PART.KNEE]: { joint: 23, limb: 1.11 },
      [PART.FOOT]: { joint: 23, limb: 2.07 },
    }
    const points = pose()
    for (const [part, rule] of Object.entries(reach)) {
      for (const side of ['left', 'right']) {
        const joint = points[side === 'left' ? rule.joint : rule.joint + 1]
        for (const spot of sweep(part, side)) {
          expect(distanceK(body, spot, joint)).toBeLessThanOrEqual(
            rule.limb + DEFAULT_CATCH.radiusK + stepOf(part) + 1e-6,
          )
        }
      }
    }
  })

  it('у руки дальний край зоны стоя уже не достать — за ним надо идти', () => {
    /**
     * Обратная сторона того же: если бы вся зона доставалась с места, полевая
     * беда вернулась бы целиком. У ладони и локтя это видно прямо по длине
     * руки — в зоне есть точки за её пределом.
     *
     * Ноги здесь нет намеренно, и это не поблажка. Мишень под колено лежит
     * внутри окружности бедра, потому что колено ходит по ней ВСЕГДА: работа
     * там не в дальности, а в подъёме, и плоское расстояние её не выражает.
     * Ногу сторожит другое правило — запас в 0.77 ширины плеч от стоящей
     * конечности (см. «мишень не даётся даром»), и пройти его стоя нельзя.
     */
    const reach = {
      [PART.PALM]: { joint: 11, limb: 1.45 },
      [PART.ELBOW]: { joint: 11, limb: 0.78 },
    }
    const points = pose()
    for (const [part, rule] of Object.entries(reach)) {
      const joint = points[rule.joint]
      const far = sweep(part, 'left').filter(
        (spot) => distanceK(body, spot, joint) > rule.limb + DEFAULT_CATCH.radiusK,
      )
      expect({ часть: part, естьДальние: far.length > 0 }).toEqual({
        часть: part,
        естьДальние: true,
      })
    }
  })
})

describe('мишень не даётся даром', () => {
  it('место не ближе 2.2 радиуса к обеим точкам нужной части', () => {
    /**
     * 2.2 радиуса это около 0.8 ширины плеч — столько часть тела обязана
     * пройти, прежде чем окажется хотя бы у края круга. Полевой лог первой
     * версии (запас был полтора радиуса): ладонь ловилась не сходя с места.
     */
    const points = pose()
    const body = readCatchBody(points)
    const rng = rngOf(0.13, 0.47, 0.82, 0.29, 0.66, 0.05, 0.91, 0.38)
    expect(safeGapK(PART.PALM)).toBeGreaterThan(0.75)

    for (const part of Object.values(PART)) {
      for (const side of ['left', 'right']) {
        const spot = placeSpot(body, points, part, side, rng, DEFAULT_CATCH)
        for (const index of Object.values(PART_POINTS[part])) {
          expect(distanceK(body, spot, points[index])).toBeGreaterThanOrEqual(safeGapK(part))
        }
      }
    }
  })

  it('путь до мишени меряется ТЕЛОМ, а не радиусами зачёта', () => {
    /**
     * Полевой лог сессии: у локтя почти все пути легли в 0.77–0.90, ровно на
     * нижнюю границу прежнего запаса, — и достаются они не сходя с места.
     * Причина была в мере: запас считался в РАДИУСАХ, а радиус на уровнях
     * разный (0.42 у новичка, 0.30 у профи). Одно и то же правило означало бы
     * на них разную работу, а работа одна.
     */
    for (const part of Object.values(PART)) {
      expect(safeGapK(part)).toBe(DEFAULT_CATCH.limbGapK)
    }
    expect(DEFAULT_CATCH.safeK).toBeUndefined()
    expect(DEFAULT_CATCH.safeElbowK).toBeUndefined()
    // и от радиуса он не зависит: мельче круг — путь тот же
    expect(safeGapK(PART.PALM, { ...DEFAULT_CATCH, radiusK: 0.3 })).toBe(DEFAULT_CATCH.limbGapK)
  })

  it('прижатую к краю мишень видно по ней самой', () => {
    // по доле прижатых судят, не великоват ли дальний край зоны для кадра
    const points = pose()
    const body = readCatchBody(points)
    // колено: его зона в кадр помещается целиком даже у стоящего по центру
    const rng = rngOf(0.5, 0.5, 0.5, 0.5)
    expect(placeSpot(body, points, PART.KNEE, 'left', rng, DEFAULT_CATCH).edged).toBe(false)
  })

  /**
   * ЖЁСТКИЙ ИНВАРИАНТ: НИ ОДНОЙ МИШЕНИ РЯДОМ С ТЕЛОМ. Решение владельца, и оно
   * про суть игры: каждая мишень обязана требовать шага, выпада или наклона.
   *
   * Правило одно на все четыре части и перекрывает зоны. Зоны говорят, где
   * примерно висит мишень своей части; ось говорит, где ей нельзя быть никогда.
   * Раньше такого правила не было, и ближний край каждой части сторожил себя
   * сам — за три захода выяснилось, что забывают подвинуть ровно тот край, на
   * который в поле и жалуются.
   */
  it('центр мишени не ближе 1.1 ширины плеч к оси тела — все четыре части', () => {
    const points = pose()
    const body = readCatchBody(points)
    const rng = (() => {
      let s = 5
      return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    })()

    for (const part of Object.values(PART)) {
      for (const side of ['left', 'right']) {
        for (let i = 0; i < 60; i += 1) {
          const spot = placeSpot(body, points, part, side, rng, DEFAULT_CATCH)
          if (!spot) continue
          expect({ часть: part, ось: axisGapK(body, spot) >= 1.1 }).toEqual({
            часть: part,
            ось: true,
          })
          // и то же число, посчитанное самой мишенью
          expect(spot.axisK).toBeGreaterThanOrEqual(1.1)
        }
      }
    }
  })

  it('ось считается по ТЕЛУ, а не по вертикали кадра', () => {
    /**
     * Человек наклонился: плечи ушли вбок от таза. Мишень, отмеренная от
     * вертикали кадра, оказалась бы у самого его плеча — а отмеренная от оси
     * тела уходит вместе с ним.
     */
    const leaning = pose()
    for (const index of [0, 11, 12, 13, 14, 15, 16]) {
      leaning[index] = { x: leaning[index].x + 0.5 * W, y: leaning[index].y }
    }
    const body = readCatchBody(leaning)
    // точка ровно над тазом теперь далека от вертикали кадра, но лежит НА оси
    const onAxis = { x: (body.shoulder.x + body.hip.x) / 2, y: (body.shoulder.y + body.hip.y) / 2 }
    expect(axisGapK(body, onAxis)).toBeCloseTo(0, 6)
    // а вертикаль кадра через таз от оси уже отстоит
    expect(axisGapK(body, { x: body.hip.x, y: body.shoulder.y })).toBeGreaterThan(0.2)
  })

  /** Тот же человек, сдвинутый к краю кадра на долю ширины кадра. */
  const shifted = (by) => {
    const points = pose()
    for (const index of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      points[index] = { x: points[index].x - by, y: points[index].y }
    }
    return points
  }

  it('человек у края кадра — мишень прижимается, а не уезжает за него', () => {
    /**
     * Стопа висит почти в двух ширинах плеч вбок, и у края кадра её мишень
     * оказывается за границей. Прижатие сторону не меняет: край кадра дальше от
     * человека, чем он сам от своего центра.
     */
    const points = shifted(0.1)
    const body = readCatchBody(points)
    const rng = rngOf(0.05, 0.95, 0.5, 0.2, 0.8, 0.35)
    const spot = placeSpot(body, points, PART.FOOT, 'right', rng, DEFAULT_CATCH)
    expect(spot.edged).toBe(true)
    expect(spot.x - spot.rx).toBeGreaterThanOrEqual(0)
    // сторона сохранилась: правая сторона человека — это меньшие x
    expect(spot.x).toBeLessThan(body.hip.x)
    // и прижатие не затащило мишень обратно к телу
    expect(spot.axisK).toBeGreaterThanOrEqual(1.1)
  })

  it('вплотную к краю места нет вовсе — и мишень туда не ставится', () => {
    /**
     * Инвариант оси и граница кадра требуют несовместимого: человек стоит так,
     * что за 1.1 ширины плеч от его оси с этой стороны кадра уже нет. Прежде
     * мишень всё равно вставала — прижатой к самому краю и вплотную к телу.
     * Теперь не ставится ни одна: ждать честнее, чем врать.
     */
    const points = shifted(0.3)
    const body = readCatchBody(points)
    const rng = rngOf(0.05, 0.95, 0.5, 0.2, 0.8, 0.35)
    expect(placeSpot(body, points, PART.FOOT, 'right', rng, DEFAULT_CATCH)).toBeNull()
    // а с другой стороны место есть, и ловец туда и перекинет (см. createCatcher)
    expect(placeSpot(body, points, PART.FOOT, 'left', rng, DEFAULT_CATCH)).not.toBeNull()
  })

  it('невозможная сторона не вешает бой: ловец перекидывает мишень', () => {
    // жёсткие правила — инвариант и «экран не пуст»; чередование сторон мягкое
    const points = shifted(0.3)
    const catcher = createCatcher({ rng: rngOf(0.05, 0.95, 0.5, 0.2, 0.8, 0.35) })
    let spawn = null
    for (let t = 0; t <= 4000 && !spawn; t += 50) {
      for (const event of catcher.update(t, points)) {
        if (event.kind === 'spawn') spawn = event
      }
    }
    expect(spawn).not.toBeNull()
    expect(spawn.at).toBeLessThanOrEqual(DEFAULT_CATCH.giveUpMs + 100)
  })

  it('место целиком помещается в кадр — мишени за краем не бывает', () => {
    const points = pose()
    const body = readCatchBody(points)
    const rng = rngOf(0.21, 0.74, 0.33, 0.58, 0.9, 0.11)
    for (const part of Object.values(PART)) {
      const spot = placeSpot(body, points, part, 'left', rng, DEFAULT_CATCH)
      expect(spot.x - spot.rx).toBeGreaterThanOrEqual(0)
      expect(spot.x + spot.rx).toBeLessThanOrEqual(1)
      expect(spot.y - spot.ry).toBeGreaterThanOrEqual(0)
      expect(spot.y + spot.ry).toBeLessThanOrEqual(1)
    }
  })

  it('радиус зачёта — 0.35 ширины плеч, и он заморожен при появлении', () => {
    const catcher = catcherOf()
    catcher.update(0, pose())
    const target = catcher.target
    expect(target.rx / W).toBeCloseTo(DEFAULT_CATCH.radiusK, 5)
    expect(target.ry / VY).toBeCloseTo(DEFAULT_CATCH.radiusK, 5)

    // человек шагнул к камере, тело выросло — мишень своего размера не меняет
    const bigger = pose({ 11: [0.5 + W, 0.3], 12: [0.5 - W, 0.3] })
    catcher.update(50, bigger)
    expect(catcher.target.rx).toBe(target.rx)
    expect(catcher.target.x).toBe(target.x)
  })
})

describe('зачёт и промах', () => {
  it('зачёт даёт любая из двух точек части, а не только своя сторона', () => {
    for (const hand of ['left', 'right']) {
      const catcher = catcherOf()
      const [spawn] = catcher.update(0, pose())
      expect(spawn.kind).toBe('spawn')
      const frame = reaching(spawn.target, hand)
      catcher.update(50, frame)
      const [event] = catcher.update(100, frame)
      expect(event.kind).toBe('clear')
    }
  })

  it('одного кадра внутри круга мало', () => {
    /**
     * Один дрогнувший кадр трекинга не должен давать зачёта: точки позы иногда
     * прыгают на полкорпуса и возвращаются обратно.
     */
    const catcher = catcherOf()
    const [spawn] = catcher.update(0, pose())
    expect(catcher.update(50, reaching(spawn.target))).toEqual([])
    // и одного попадания в окне так и остаётся мало, сколько ни жди
    expect(catcher.update(100, pose())).toEqual([])
    expect(catcher.update(150, pose())).toEqual([])
    expect(catcher.update(200, pose())).toEqual([])
  })

  it('два попадания подряд — зачёт', () => {
    const catcher = catcherOf()
    const [spawn] = catcher.update(0, pose())
    expect(catcher.update(50, reaching(spawn.target))).toEqual([])
    const [event] = catcher.update(100, reaching(spawn.target))
    expect(event.kind).toBe('clear')
  })

  it('сбойный кадр посреди касания его больше не отменяет', () => {
    /**
     * ГЛАВНАЯ ПРАВКА СУДЕЙСТВА. Было «два кадра ПОДРЯД», и это требовало, чтобы
     * трекинг не дрогнул ни разу: один потерянный кадр посреди честного касания
     * сбрасывал счёт до нуля, и на двадцати кадрах в секунду это стоило
     * человеку всего касания. Полевой лог профи — 14 промахов из 52.
     *
     * Стало «два попадания из трёх последних кадров»: от одиночного дрожания
     * оно защищает ровно так же, а честное касание сквозь сбой переживает.
     */
    const catcher = catcherOf()
    const [spawn] = catcher.update(0, pose())
    catcher.update(50, reaching(spawn.target))
    // кадр мимо — рука на месте, а трекинг моргнул
    expect(catcher.update(100, pose())).toEqual([])
    const [event] = catcher.update(150, reaching(spawn.target))
    expect(event.kind).toBe('clear')
  })

  it('тела не видно — кадр считается промахом, но касание не стирается', () => {
    const catcher = catcherOf()
    const [spawn] = catcher.update(0, pose())
    catcher.update(50, reaching(spawn.target))
    catcher.update(100, null)
    const [event] = catcher.update(150, reaching(spawn.target))
    expect(event.kind).toBe('clear')
  })

  it('два попадания ВРАЗБРОС зачёта не дают: окно всего три кадра', () => {
    // иначе «касанием» стали бы два случайных прохода руки за всю жизнь мишени
    const catcher = catcherOf()
    const [spawn] = catcher.update(0, pose())
    catcher.update(50, reaching(spawn.target))
    for (const t of [100, 150, 200]) expect(catcher.update(t, pose())).toEqual([])
    expect(catcher.update(250, reaching(spawn.target))).toEqual([])
  })

  it('мишень живёт свой срок, и просрочка — промах', () => {
    const catcher = catcherOf({ lifeMs: 2500 })
    const [spawn] = catcher.update(0, pose())
    expect(spawn.target.lifeMs).toBe(2500)
    expect(catcher.update(2450, pose())).toEqual([])
    const [event] = catcher.update(2500, pose())
    expect(event.kind).toBe('miss')
  })

  it('в промахе видно, насколько близко часть подходила', () => {
    // единственное число, по которому разбирается промах ловца: 1 — край круга
    const catcher = catcherOf({ lifeMs: 1000 })
    const [spawn] = catcher.update(0, pose())
    catcher.update(500, reaching(spawn.target))
    const [event] = catcher.update(1000, pose())
    expect(event.kind).toBe('miss')
    expect(event.target.nearK).toBeLessThan(0.01)
  })

  it('следующая мишень приходит через паузу — и после зачёта, и после промаха', () => {
    for (const catchIt of [true, false]) {
      const catcher = catcherOf({ lifeMs: 1000, gapMs: 400 })
      const [spawn] = catcher.update(0, pose())
      let judgedAt = null
      for (let t = 50; t <= 1000 && judgedAt == null; t += 50) {
        const frame = catchIt ? reaching(spawn.target) : pose()
        for (const event of catcher.update(t, frame)) {
          if (event.kind !== 'spawn') judgedAt = t
        }
      }
      expect(judgedAt).not.toBeNull()
      expect(catcher.update(judgedAt + 350, pose())).toEqual([])
      const [next] = catcher.update(judgedAt + 400, pose())
      expect(next.kind).toBe('spawn')
    }
  })

  it('мишень на экране всегда одна', () => {
    const catcher = createCatcher({ rng: Math.random, lifeMs: 800, gapMs: 400 })
    let live = 0
    for (let t = 0; t <= 20000; t += 50) {
      for (const event of catcher.update(t, pose())) {
        live += event.kind === 'spawn' ? 1 : -1
        expect(live).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('поток мишеней', () => {
  it('мешок: четыре ладони, два колена, две стопы, два локтя', () => {
    const bag = createBag(Math.random)
    const seen = {}
    for (let i = 0; i < BAG.length; i += 1) {
      const part = bag()
      seen[part] = (seen[part] ?? 0) + 1
    }
    expect(seen).toEqual({ palm: 4, knee: 2, foot: 2, elbow: 2 })
  })

  it('за два мешка состав повторяется ровно вдвое, а порядок — нет', () => {
    const rng = (() => {
      let s = 7
      return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    })()
    const bag = createBag(rng)
    const first = Array.from({ length: BAG.length }, bag)
    const second = Array.from({ length: BAG.length }, bag)
    expect([...first].sort()).toEqual([...second].sort())
    expect(first.join()).not.toBe(second.join())
  })

  it('сторона чередуется, но пары «дважды подряд» — обычное дело', () => {
    /**
     * Полевой лог: при прежней вероятности смены раунд читался почти строгим
     * лево-право, и человек переносил вес ДО того, как увидел мишень, — то есть
     * готовился к расписанию, а не к движению. Чередование осталось основным
     * рисунком, но пары стали частыми настолько, что очередь не угадывается.
     */
    const rng = (() => {
      let s = 3
      return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    })()
    const next = createSides(rng)
    const sides = Array.from({ length: 800 }, next)
    let run = 0
    let last = null
    let repeats = 0
    for (const side of sides) {
      run = side === last ? run + 1 : 1
      if (side === last) repeats += 1
      last = side
      // больше двух подряд не бывает: это уже перекос, а не непредсказуемость
      expect(run).toBeLessThanOrEqual(2)
    }
    // повторов заметно много, но чередование всё ещё преобладает
    expect(repeats / sides.length).toBeGreaterThan(0.22)
    expect(repeats / sides.length).toBeLessThan(0.45)
  })

  it('один сид — один и тот же поток мишеней, кадр в кадр', () => {
    /** Без этого ни тест, ни разбор полевого лога невозможны. */
    const run = () => {
      const seeded = (() => {
        let s = 11
        return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
      })()
      const catcher = createCatcher({ rng: seeded, lifeMs: 1200 })
      const out = []
      for (let t = 0; t <= 30000; t += 50) {
        for (const event of catcher.update(t, pose())) {
          out.push(`${event.kind}:${event.target.part}:${event.target.side}:${event.at}`)
        }
      }
      return out
    }
    expect(run()).toEqual(run())
    expect(run().length).toBeGreaterThan(20)
  })

  it('за девяносто секунд боя проходит весь мешок и не по разу', () => {
    const catcher = createCatcher({ rng: Math.random, lifeMs: 2500, gapMs: 400 })
    const parts = new Set()
    let spawned = 0
    for (let t = 0; t <= 90000; t += 50) {
      for (const event of catcher.update(t, pose())) {
        if (event.kind !== 'spawn') continue
        spawned += 1
        parts.add(event.target.part)
      }
    }
    // человек стоит столбом: мишени истекают, и всё равно их успевает выйти
    // больше трёх десятков, а все четыре части — не по одному разу
    expect(spawned).toBeGreaterThan(30)
    expect([...parts].sort()).toEqual(['elbow', 'foot', 'knee', 'palm'])
  })
})

describe('подписи', () => {
  it('у каждой части одно слово, и оно есть', () => {
    for (const part of Object.values(PART)) {
      expect(PART_LABEL[part]).toMatch(/^[А-ЯЁ]+$/)
    }
    expect(Object.keys(PART_LABEL).sort()).toEqual(Object.values(PART).sort())
  })

  it('у каждой части — свои две точки позы, левая и правая', () => {
    expect(PART_POINTS[PART.PALM]).toEqual({ left: 15, right: 16 })
    expect(PART_POINTS[PART.ELBOW]).toEqual({ left: 13, right: 14 })
    expect(PART_POINTS[PART.KNEE]).toEqual({ left: 25, right: 26 })
    expect(PART_POINTS[PART.FOOT]).toEqual({ left: 27, right: 28 })
  })
})

describe('стопа судится по четырём точкам: голеностопы и носки', () => {
  /**
   * Полевой лог профи: 14 промахов из 52, почти все — стопа с локтем. Разбор
   * показал, чем стопа отличается: к мишени человек тянется НОСКОМ, а судья
   * мерил голеностоп. Между ними четверть ширины плеч — больше половины
   * радиуса зачёта на профи. «Стопа в мишени, а зачёта нет»: она там и была,
   * просто не той своей точкой.
   */
  it('у стопы четыре точки, у остальных частей по две', () => {
    expect(PART_EXTRA_POINTS[PART.FOOT]).toEqual({ left: 31, right: 32 })
    expect(pointsOf(PART.FOOT, 'left')).toEqual([27, 31])
    expect(pointsOf(PART.FOOT, 'right')).toEqual([28, 32])
    for (const part of [PART.PALM, PART.ELBOW, PART.KNEE]) {
      expect(pointsOf(part, 'left')).toHaveLength(1)
      expect(pointsOf(part, 'right')).toHaveLength(1)
    }
    // и все четыре доходят до судьи
    expect(partSpots(pose(), PART.FOOT)).toHaveLength(4)
  })

  it('зачёт даёт НОСОК, а не только голеностоп', () => {
    /**
     * Ровно та жалоба из поля: «стопа в мишени, а зачёта нет». Она там и была —
     * носком, которым человек к мишени и тянется.
     */
    const catcher = createCatcher({ rng: Math.random, lifeMs: 4000 })
    let target = null
    for (let t = 0; t <= 60000 && !target; t += 50) {
      for (const event of catcher.update(t, pose())) {
        if (event.kind === 'spawn' && event.target.part === PART.FOOT) target = event.target
      }
    }
    expect(target).not.toBeNull()

    // тянемся НОСКОМ той стороны, что назвала мишень; голеностоп стоит на месте
    const toe = pose()
    toe[PART_EXTRA_POINTS[PART.FOOT][target.side]] = { x: target.x, y: target.y }
    const at = target.spawnAt
    catcher.update(at + 50, toe)
    const [event] = catcher.update(at + 100, toe)
    expect(event?.kind).toBe('clear')
  })

  it('носок не ловит мишень стоя: он уходит от неё в ту же сторону, что и пятка', () => {
    /**
     * Обратная сторона той же правки. Носок стоит НИЖЕ и чуть вперёд
     * голеностопа, а мишень под стопу висит в полутора ширинах плеч ВБОК —
     * значит добавленная точка не приближает мишень к стоящему человеку.
     *
     * На живых записях это проверено полностью: 4320 проверок «точка × мишень»
     * по всем стоячим кадрам, ноль попаданий, ближайший подход 1.84 радиуса
     * (см. отчёт к правке). Здесь — то же правило на счётном теле.
     */
    const points = pose()
    const body = readCatchBody(points)
    const rng = (() => {
      let s = 21
      return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    })()

    for (let i = 0; i < 80; i += 1) {
      for (const side of ['left', 'right']) {
        const spot = placeSpot(body, points, PART.FOOT, side, rng, DEFAULT_CATCH)
        if (!spot) continue
        for (const p of partSpots(points, PART.FOOT)) {
          // в радиусах: 1.0 — край круга, и до него должно быть далеко
          const near = Math.hypot((p.x - spot.x) / spot.rx, (p.y - spot.y) / spot.ry)
          expect(near).toBeGreaterThan(1.5)
        }
      }
    }
  })
})
