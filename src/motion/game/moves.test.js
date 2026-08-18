import { describe, expect, it } from 'vitest'
import { READABLE_FOLD, createMoveWatchers, readMoves } from './moves.js'
import { LM } from '../pose/landmarks.js'

/**
 * Девять движений сверх ТЗ. Проверять здесь надо не «сработало ли вообще» —
 * это видно и по записи, — а РАЗВЕДЕНИЕ СОСЕДЕЙ: каждое из девяти живёт рядом с
 * движением, от которого его отличает ровно одно число, и вся ценность
 * детектора в этом одном числе.
 *
 * Записать соседей «примерно похоже» и не развести их — самая дорогая ошибка в
 * этом проекте: две записи, по которым детекторы неразличимы, и день на попытку
 * развести неразличимое.
 *
 * Кормим автомат ПРИЗНАКАМИ, а не точками: те же числа, что он получает от игры
 * (см. readMoves), но видно, какое из них проверяется.
 */

/**
 * Спокойная стойка. Числители здесь в единицах кадра, как их и отдаёт
 * readMoves: на рост (медиану длины корпуса) их делит уже автомат.
 */
const stand = (over = {}) => ({
  hipX: 0.5,
  hipY: 0.6,
  torso: 0.2,
  shW: 0.2,
  // стопы под тазом, руки опущены, колени внизу
  ankleOut: { left: 0.1, right: 0.1 },
  wristOut: { left: 0.2, right: 0.2 },
  wristGap: 1.4,
  kneeUp: { left: -0.2, right: -0.2 },
  wristUp: { left: -0.3, right: -0.3 },
  wristDown: { left: -0.02, right: -0.02 },
  // встречная рука далеко от колена: 0.3 кадра при росте 0.2 — это полтора
  // роста, втрое дальше зачётных 0.50 у кисти и 0.65 у локтя
  wristKnee: { left: 0.3, right: 0.3 },
  elbowKnee: { left: 0.3, right: 0.3 },
  ankleY: { left: 0.95, right: 0.95 },
  ...over,
})

const bySide = (side, own, other) =>
  side === 'left' ? { left: own, right: other } : { left: other, right: own }

/**
 * Прогнать позу столько-то миллисекунд. Кадры идут по 50 мс: автомат судит по
 * ВЫДЕРЖКЕ, и одним снимком его не проверить — ровно как в жизни.
 */
function hold(watcher, pose, ms, from = 0, step = 50) {
  const events = []
  for (let t = from; t <= from + ms; t += step) events.push(...watcher.update(t, pose))
  return events
}

/** Постоять четыре секунды: столько автомату нужно на опору (рост, дом, наклон). */
function settled(over = {}) {
  const watcher = createMoveWatchers(over)
  hold(watcher, stand(), 4000)
  return watcher
}

const names = (events) => events.map((e) => `${e.movement}${e.side ? ':' + e.side : ''}`)

describe('опора кадра', () => {
  it('рост берётся медианой, и короткое движение её не утаскивает', () => {
    const watcher = settled()

    // сложился вперёд: корпус в кадре стал втрое короче
    hold(watcher, stand({ torso: 0.06 }), 300, 4100)

    // рост остался прежним — иначе всё, что на него делится, поехало бы
    expect(watcher.ref).toBeCloseTo(0.2, 2)
    expect(watcher.fold).toBeCloseTo(0.3, 2)
    expect(watcher.fold).toBeLessThan(READABLE_FOLD)
  })

  it('в спокойной стойке не срабатывает ни одно из девяти', () => {
    const watcher = createMoveWatchers()
    expect(names(hold(watcher, stand(), 6000))).toEqual([])
  })

  /**
   * ПОТЕРЯННЫЙ КАДР — ЭТО ПОТЕРЯННЫЙ КАДР, даже если потеряна вся поза.
   *
   * Правка по полевому логу 15 августа: у наклона к полу промахи с выдержкой
   * 194 и 157 мс при пороге 200 — человек держал позу, а она на кадр
   * переставала читаться. В глубоком наклоне это норма: плечи уходят к линии
   * таза, корпус в кадре схлопывается, и модель теряет то плечо, то таз.
   * Прежде такой кадр обнулял всё накопленное, и наклон было не взять.
   */
  it('поза пропала на кадр — выдержка переживает это, как и любой сбой', () => {
    const watcher = settled()
    const bend = stand({ torso: 0.05, wristDown: { left: 0.12, right: 0.12 } })
    hold(watcher, bend, 100, 4100)
    // ...и на один кадр человека не видно
    watcher.update(4250, {})
    expect(watcher.fold).toBeNull()

    // накопленное не потеряно: 100 до пропажи и 100 после дают зачётные 200
    expect(names(hold(watcher, bend, 100, 4300))).toEqual(['bend'])
  })

  it('пропал надолго — это конец движения, и выдержка идёт с нуля', () => {
    const watcher = settled()
    const bend = stand({ torso: 0.05, wristDown: { left: 0.12, right: 0.12 } })
    hold(watcher, bend, 100, 4100)
    // 300 мс без позы — дольше форы: столько дырок подряд камера не даёт
    for (let t = 4250; t <= 4550; t += 50) watcher.update(t, {})

    expect(names(hold(watcher, bend, 100, 4600))).toEqual([])
  })
})

describe('наклон вперёд и присед', () => {
  /** Сложенный корпус и руки НИЖЕ КОЛЕН — оба признака сразу. */
  const bend = () => stand({ torso: 0.05, wristDown: { left: 0.12, right: 0.12 } })

  it('корпус сложен и руки ниже колен — это наклон', () => {
    const watcher = settled()
    expect(names(hold(watcher, bend(), 300, 4100))).toEqual(['bend'])
  })

  it('глубокий присед наклоном не считается: руки к полу не идут', () => {
    const watcher = settled()
    // таз ушёл вниз на полкорпуса, корпус кое-как сложился — но руки на месте
    const squat = stand({ hipY: 0.7, torso: 0.05 })
    expect(names(hold(watcher, squat, 600, 4100))).toEqual([])
  })

  it('один наклон — одно событие, сколько его ни держи', () => {
    const watcher = settled()
    expect(names(hold(watcher, bend(), 700, 4100))).toEqual(['bend'])
  })
})

describe('присед с прыжком: сначала просадка, потом отрыв', () => {
  /** Просадка на 0.6 роста: таз ушёл вниз, корпус стоит. */
  const squat = () => stand({ hipY: 0.72 })
  /** Обе стопы над своей землёй: полёт. */
  const air = () => stand({ ankleY: { left: 0.91, right: 0.91 } })

  it('присед, а следом отрыв обеих стоп — засчитано', () => {
    const watcher = settled()
    hold(watcher, squat(), 250, 4100)
    expect(names(hold(watcher, air(), 100, 4400))).toEqual(['jumpsquat'])
  })

  it('один присед без отрыва приседом с прыжком не становится', () => {
    const watcher = settled()
    expect(names(hold(watcher, squat(), 1000, 4100))).toEqual([])
  })

  it('отрыв без приседа — тоже нет: это просто прыжок', () => {
    const watcher = settled()
    expect(names(hold(watcher, air(), 300, 4100))).toEqual([])
  })

  it('после приседа на отрыв даётся полторы секунды, а не сколько угодно', () => {
    const watcher = settled()
    hold(watcher, squat(), 250, 4100)
    // встал, постоял две секунды и только потом подпрыгнул — это два движения
    hold(watcher, stand(), 2000, 4400)
    expect(names(hold(watcher, air(), 100, 6500))).toEqual([])
  })

  it('наклон вперёд ложного приседа с прыжком не даёт', () => {
    /**
     * Ровно то, ради чего у обеих половин движения стоит условие по корпусу. В
     * наклоне длина корпуса в кадре падает почти до нуля, и просадка таза,
     * делённая на неё, взрывается: на записи это дало 10 ложных ПРЫЖКОВ, то
     * есть наклоном можно было бы бесплатно проходить ямы.
     */
    const watcher = settled()
    const folded = stand({ torso: 0.05, hipY: 0.64, ankleY: { left: 0.91, right: 0.91 } })
    expect(names(hold(watcher, folded, 1000, 4100))).toEqual([])
  })
})

describe('джек и прыжок ноги врозь: разводят только руки', () => {
  /** Ноги врозь — общее у обоих движений. */
  const wide = (over = {}) => stand({ ankleOut: { left: 0.9, right: 0.9 }, ...over })

  it('ноги врозь и руки НАД ГОЛОВОЙ — это джек', () => {
    const watcher = settled()
    const jack = wide({ wristUp: { left: 0.08, right: 0.08 } })
    expect(names(hold(watcher, jack, 300, 4100))).toEqual(['jack'])
  })

  it('джек засчитывается ОДНИМ замером на вершине', () => {
    /**
     * ПОЛЕ. Redmi отдаёт 7 поз/с, iPhone 23, и выдержка holdMs набирается только
     * по замерам: 200 мс на шаге 143 мс — это ТРИ замера подряд, то есть вершина
     * длиной 286–429 мс, против 218 мс на быстрой съёмке. Вершина живого джека
     * держится 260–400 мс (замерено по записи calibration-new9), и она ровно в
     * этой щели: 10 повторов на Redmi против 17 на iPhone у одного человека.
     *
     * Джек судится пересечением порогов: важно, что вершина БЫЛА.
     */
    const watcher = settled()
    const jack = wide({ wristUp: { left: 0.08, right: 0.08 } })
    // один-единственный замер наверху, дальше человек уже вернулся в стойку
    expect(names(watcher.update(4100, jack))).toEqual(['jack'])
  })

  it('второй джек не засчитается, пока ноги не сошлись обратно', () => {
    // от двойного счёта защищает возврат в стойку, а не рефрактерный период:
    // возврат не зависит от частоты замеров вовсе
    const watcher = settled()
    const jack = wide({ wristUp: { left: 0.08, right: 0.08 } })
    expect(names(watcher.update(4100, jack))).toEqual(['jack'])
    expect(names(hold(watcher, jack, 3000, 4150))).toEqual([])
    // сошлись — и следующий считается
    hold(watcher, stand(), 400, 7200)
    expect(names(watcher.update(7700, jack))).toEqual(['jack'])
  })

  it('ноги врозь и руки вверх ПОРОЗНЬ джеком не считаются', () => {
    // руки подняли, опустили, и только потом развели ноги — это не джек
    const watcher = settled()
    hold(watcher, stand({ wristUp: { left: 0.08, right: 0.08 } }), 200, 4100)
    hold(watcher, stand(), 600, 4350)
    expect(names(hold(watcher, wide(), 300, 5000))).toEqual(['hop'])
  })

  it('рассыпавшийся трекинг джеком не считается', () => {
    /**
     * Одного замера теперь достаточно, значит одного мусорного тоже. Живой
     * случай из записи: человек уходит из кадра, видимость стоп падает, и ноги
     * «разъезжаются» на 1.74 ширины плеч каждая. Так они не разводятся.
     */
    const watcher = settled()
    const мусор = stand({ ankleOut: { left: 1.74, right: 1.74 }, wristUp: { left: 0.08, right: 0.08 } })
    expect(names(hold(watcher, мусор, 300, 4100))).toEqual([])
  })

  it('те же ноги, но руки ВНИЗУ — это прыжок ноги врозь', () => {
    const watcher = settled()
    expect(names(hold(watcher, wide(), 300, 4100))).toEqual(['hop'])
  })

  it('прыжок врозь с приседанием не засчитывается: там ноги врозь от приседа', () => {
    const watcher = settled()
    // ноги врозь, руки внизу — но человек ещё и присел на полкорпуса
    expect(names(hold(watcher, wide({ hipY: 0.72 }), 300, 4100))).toEqual([])
  })
})

describe('боковой мах ногой и подъём колена', () => {
  it('стопа далеко вбок при ПРЯМОЙ ноге — это мах', () => {
    const watcher = settled()
    const swing = stand({ ankleOut: bySide('left', 2.4, 0.1) })
    expect(names(hold(watcher, swing, 300, 4100))).toEqual(['legside:left'])
  })

  it('та же стопа, но с поднятым коленом, махом не считается', () => {
    const watcher = settled()
    const bent = stand({
      ankleOut: bySide('left', 2.4, 0.1),
      kneeUp: bySide('left', 0.08, -0.2),
    })
    expect(names(hold(watcher, bent, 300, 4100))).toEqual([])
  })
})

describe('боковой выпад и шаг в сторону: разводит только просадка', () => {
  /** Таз уехал в свою сторону на 0.6 ширины плеч. */
  const shifted = (over = {}) => stand({ hipX: 0.38, ...over })

  it('таз уехал вбок И человек опустился — это выпад', () => {
    const watcher = settled()
    // в кадре своя правая сторона — меньшие x, поэтому таз слева от дома
    const lunge = shifted({ hipY: 0.665 })
    expect(names(hold(watcher, lunge, 300, 4100))).toEqual(['sidelunge:right'])
  })

  it('тот же уход таза без просадки — это шаг, а не выпад', () => {
    const watcher = settled()
    expect(names(hold(watcher, shifted(), 400, 4100))).toEqual([])
  })
})

describe('руки в стороны и хлопок', () => {
  it('кисти разведены и обе ниже носа — руки в стороны', () => {
    const watcher = settled()
    const wings = stand({ wristOut: { left: 1.3, right: 1.3 } })
    expect(names(hold(watcher, wings, 500, 4100))).toEqual(['wings'])
  })

  it('короткий замах разведением рук не считается: выдержка вдвое длиннее общей', () => {
    /**
     * Замах к хлопку проходит ровно через положение «руки в стороны», и с общей
     * выдержкой в 200 мс он засчитывался разведением рук. Отсюда 400 мс.
     */
    const watcher = settled()
    const wings = stand({ wristOut: { left: 1.3, right: 1.3 } })
    expect(names(hold(watcher, wings, 250, 4100))).toEqual([])
  })

  it('кисти сошлись НАД ГОЛОВОЙ — это хлопок', () => {
    const watcher = settled()
    const clap = stand({ wristGap: 0.4, wristUp: { left: 0.1, right: 0.1 } })
    expect(names(hold(watcher, clap, 300, 4100))).toEqual(['clap'])
  })

  it('те же сведённые кисти внизу хлопком не считаются', () => {
    const watcher = settled()
    expect(names(hold(watcher, stand({ wristGap: 0.4 }), 400, 4100))).toEqual([])
  })
})

describe('скручивание и подъём колена: разводит встречная рука', () => {
  /**
   * Колено в скручивании поднимается ровно так же, как в подъёме колена, и всё
   * отличие — во ВСТРЕЧНОЙ РУКЕ: локоть или кисть противоположной руки приходит
   * к этому колену. Сторона — по колену.
   *
   * ЗАМЕРОВ ДВА, И ЭТО ГЛАВНОЕ, ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Люди тянутся двумя
   * манерами, и по записям видно: у тянущегося кистью локоть не подходит ближе
   * 0.80 (по одному локтю — 0 повторов из 10), у тянущегося локтем кисть уходит
   * мимо колена (по одной кисти — 6 из 10). Поэтому хватать должно ЛЮБОГО из
   * двух, и обе манеры проверяются порознь.
   */
  const twist = (side, over = {}) =>
    stand({
      kneeUp: bySide(side, 0.08, -0.2),
      ...over,
    })

  /** Тянется КИСТЬЮ: кисть у колена (0.30 роста), локоть далеко (1.5). */
  const byWrist = (side) => twist(side, { wristKnee: bySide(side, 0.06, 0.3) })
  /** Тянется ЛОКТЕМ: локоть у колена (0.30), кисть ушла мимо (1.5). */
  const byElbow = (side) => twist(side, { elbowKnee: bySide(side, 0.06, 0.3) })

  it('дотянулся КИСТЬЮ — это скручивание', () => {
    const watcher = settled()
    expect(names(hold(watcher, byWrist('left'), 200, 4100))).toEqual(['twistknee:left'])
  })

  it('дотянулся ЛОКТЕМ, а кисть ушла мимо — это тоже скручивание', () => {
    const watcher = settled()
    expect(names(hold(watcher, byElbow('left'), 200, 4100))).toEqual(['twistknee:left'])
  })

  it('то же колено без руки — обычный подъём колена, а не скручивание', () => {
    const watcher = settled()
    expect(names(hold(watcher, twist('left'), 400, 4100))).toEqual([])
  })

  it('рука у колена, но колено внизу — тоже нет: так выглядит присед', () => {
    /**
     * Не выдумка: на calibration-full в сегменте приседа локоть подходит к
     * колену на 0.55, а кисть на 0.45 — обе планки взяты. Не пускает туда
     * детектор только поднятое колено.
     */
    const watcher = settled()
    const squat = stand({
      wristKnee: { left: 0.06, right: 0.06 },
      elbowKnee: { left: 0.06, right: 0.06 },
    })
    expect(names(hold(watcher, squat, 400, 4100))).toEqual([])
  })

  it('сторона — по поднимаемому колену, а не по тянущейся руке', () => {
    const watcher = settled()
    expect(names(hold(watcher, byElbow('right'), 200, 4100))).toEqual(['twistknee:right'])
  })

  /**
   * Планка локтя устойчива: 0.60, 0.65 и 0.70 дают на записях один и тот же
   * результат. Здесь проверены оба края разрыва, в котором она стоит.
   */
  it('запас по локтю: 0.30 засчитывается, 0.90 нет', () => {
    const near = settled()
    expect(names(hold(near, byElbow('left'), 200, 4100))).toEqual(['twistknee:left'])

    const far = settled()
    const away = twist('left', { elbowKnee: bySide('left', 0.18, 0.3) })
    expect(names(hold(far, away, 400, 4100))).toEqual([])
  })
})

/**
 * Один потерянный кадр не должен убивать зачёт. У этих девяти условий по
 * два-четыре, и сойтись они должны одновременно — дырка вероятнее, чем у
 * старых движений, у которых это уже стоило зачётов в поле.
 *
 * Проверяется на разведении рук: у него выдержка 400 мс, то есть длиннее двух
 * кусков по 200 — и видно, что событие даёт именно склеенная выдержка.
 */
describe('срыв на один кадр выдержку не обнуляет', () => {
  const wings = (over = {}) => stand({ wristOut: { left: 1.3, right: 1.3 }, ...over })

  it('200 мс, провал на кадр, ещё 200 — движение засчитано', () => {
    const watcher = settled()

    expect(names(hold(watcher, wings(), 200, 4100))).toEqual([])
    // один кадр мимо: кисти дрогнули к телу, как это делает живая камера
    expect(names(watcher.update(4350, stand()))).toEqual([])
    expect(watcher.probes.wings.none.block).toBe('wristOut')

    const events = hold(watcher, wings(), 200, 4400)
    expect(names(events)).toEqual(['wings'])
    // одно событие, а не два: снятого флага «выстрелил» за провал не было
    expect(events).toHaveLength(1)
  })

  it('провал на 300 мс — это конец движения, и выдержка идёт заново', () => {
    const watcher = settled()

    expect(names(hold(watcher, wings(), 200, 4100))).toEqual([])
    expect(names(hold(watcher, stand(), 300, 4350))).toEqual([])
    expect(names(hold(watcher, wings(), 200, 4700))).toEqual([])
  })
})

/**
 * Выдержка и помеха наружу — то же, что уже есть у выпада с захлёстом. В поле
 * 14 августа складка дала 2 зачёта из 13, и причину назвать было нечем: условий
 * у неё несколько, и по пикам порознь не видно, сошлись ли они в один кадр.
 */
describe('выдержка и помеха по каждому движению', () => {
  const twist = (over = {}) =>
    stand({
      kneeUp: bySide('left', 0.08, -0.2),
      wristKnee: bySide('left', 0.06, 0.3),
      ...over,
    })
  const armAway = { wristKnee: { left: 0.3, right: 0.3 }, elbowKnee: { left: 0.3, right: 0.3 } }

  it('пока условия держатся, выдержка растёт и мешать нечему', () => {
    const watcher = settled()
    const seen = []
    for (let t = 4100; t <= 4250; t += 50) {
      watcher.update(t, twist())
      seen.push(watcher.probes.twistknee.left.heldMs)
    }

    expect(seen).toEqual([0, 50, 100, 150])
    expect(watcher.probes.twistknee.left.block).toBeNull()
  })

  it('оба условия скручивания называют себя', () => {
    const watcher = settled()
    let t = 4100
    const blockOf = (pose) => {
      watcher.update((t += 50), pose)
      return watcher.probes.twistknee.left.block
    }

    // колено внизу — дело в нём, а не в руке
    expect(blockOf(twist({ kneeUp: bySide('left', -0.2, -0.2) }))).toBe('kneeLift')
    // колено вверху, но рука осталась при себе — ни локтем, ни кистью:
    // это обычный подъём колена
    expect(blockOf(twist(armAway))).toBe('cross')
    // всё сошлось — мешать нечему
    expect(blockOf(twist())).toBeNull()
  })

  it('у приседа с прыжком помеха называет ту половину, до которой не дошли', () => {
    const watcher = settled()

    // человек стоит: не было ещё и приседа
    watcher.update(4100, stand())
    expect(watcher.probes.jumpsquat.none.block).toBe('drop')

    // присел и держит — теперь дело за отрывом
    hold(watcher, stand({ hipY: 0.72 }), 250, 4150)
    expect(watcher.probes.jumpsquat.none.block).toBe('feetLift')
    expect(watcher.probes.jumpsquat.none.heldMs).toBeGreaterThanOrEqual(200)

    // и отрыв случился
    watcher.update(4450, stand({ ankleY: { left: 0.91, right: 0.91 } }))
    expect(watcher.probes.jumpsquat.none.block).toBeNull()
  })

  it('судить не по чему — так и сказано, а не молчанием', () => {
    const watcher = settled()
    hold(watcher, twist(), 100, 4100)
    watcher.update(4300, {})

    expect(watcher.probes.twistknee.left.block).toBe('pose')
    expect(watcher.probes.twistknee.left.heldMs).toBe(0)
  })
})

describe('чтение кадра', () => {
  /** Точки одного кадра: человек стоит лицом к камере, своя правая — в меньших x. */
  function frame(over = {}) {
    const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
    const put = (index, x, y) => {
      points[index] = { x, y, z: 0, visibility: 1 }
    }
    put(LM.NOSE, 0.5, 0.28)
    put(LM.LEFT_SHOULDER, 0.6, 0.4)
    put(LM.RIGHT_SHOULDER, 0.4, 0.4)
    put(LM.LEFT_HIP, 0.56, 0.6)
    put(LM.RIGHT_HIP, 0.44, 0.6)
    put(LM.LEFT_KNEE, 0.56, 0.78)
    put(LM.RIGHT_KNEE, 0.44, 0.78)
    put(LM.LEFT_ANKLE, 0.56, 0.95)
    put(LM.RIGHT_ANKLE, 0.44, 0.95)
    put(LM.LEFT_WRIST, 0.64, 0.7)
    put(LM.RIGHT_WRIST, 0.36, 0.7)
    for (const [index, [x, y]] of Object.entries(over)) put(Number(index), x, y)
    return points
  }

  it('меры нормированы на человека, а не на пиксели', () => {
    const out = readMoves(frame())

    expect(out.torso).toBeCloseTo(0.2, 2)
    expect(out.shW).toBeCloseTo(0.2, 2)
    expect(out.hipX).toBeCloseTo(0.5, 2)
    // стопы под тазом: вынос вбок почти нулевой
    expect(out.ankleOut.left).toBeCloseTo(0.3, 1)
    // кисти ниже носа — значит подъём отрицательный
    expect(out.wristUp.left).toBeLessThan(0)
    // и ниже колен они тоже не ушли
    expect(out.wristDown.left).toBeLessThan(0)
  })

  it('встречная рука меряется от ЧУЖИХ локтя и кисти до СВОЕГО колена', () => {
    // в стойке руки висят у бёдер, и до чужого колена им далеко
    expect(readMoves(frame()).wristKnee.left).toBeGreaterThan(0.2)
    expect(readMoves(frame()).elbowKnee.left).toBeGreaterThan(0.2)

    // правая кисть пришла к левому колену — считается это левой стороне,
    // потому что сторона у скручивания по КОЛЕНУ
    const twisted = readMoves(frame({ [LM.RIGHT_WRIST]: [0.56, 0.78] }))
    expect(twisted.wristKnee.left).toBeCloseTo(0, 2)
    // а правому колену эта же кисть ничего не даёт: к нему идёт левая
    expect(twisted.wristKnee.right).toBeGreaterThan(0.2)

    // и то же самое отдельно по локтю: замера два, и они независимы
    const elbowIn = readMoves(frame({ [LM.RIGHT_ELBOW]: [0.56, 0.78] }))
    expect(elbowIn.elbowKnee.left).toBeCloseTo(0, 2)
    expect(elbowIn.wristKnee.left).toBeGreaterThan(0.2)
  })

  it('без плеч и таза кадр не читается вовсе: неизвестное не становится нулём', () => {
    const blind = frame()
    blind[LM.LEFT_HIP] = { x: 0.56, y: 0.6, z: 0, visibility: 0.1 }

    const out = readMoves(blind)
    expect(out.torso).toBeNull()
    expect(out.hipX).toBeNull()
    expect(out.ankleOut.left).toBeNull()
  })
})
