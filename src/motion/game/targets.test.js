import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CONFETTI_EVERY,
  MAX_PARTICLES,
  PART_ZONE,
  TYPE_LABEL,
  ZONE_COLOR,
  beatAt,
  catchLayout,
  catchLife,
  catchUrgent,
  createTargets,
  kickAt,
  layoutFor,
  popAt,
  pullAt,
  readBody,
  screenDir,
  spinAt,
} from './targets.js'
import { PART_LABEL } from './catcher.js'
import { dodgeDistance, leanDistance } from './dodge.js'
import { SHOW_WAIT_MAX_MS } from '../pose/frameSync.js'

/**
 * Мишени на теле. Главное, что здесь проверяется, — что мишень ЕСТЬ и стоит от
 * тела, а не от угла экрана: раскладка, оторвавшаяся от точек позы, выглядит
 * как игра, в которую невозможно попасть.
 *
 * И ещё одно, ради чего этот файл написан: слой НЕ СУДИТ. Ни одна проверка
 * попадания здесь не живёт — зачёт и промах приходят снаружи, от движка, а
 * мишень только показывает его решение.
 */

/** Точки позы: человек стоит по центру кадра, руки вдоль тела. */
function pose(over = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }))
  const put = (index, x, y) => {
    points[index] = { x, y }
  }
  put(0, 0.5, 0.2) // нос
  put(11, 0.58, 0.32) // плечи
  put(12, 0.42, 0.32)
  put(15, 0.6, 0.6) // кисти
  put(16, 0.4, 0.6)
  put(23, 0.56, 0.55) // таз
  put(24, 0.44, 0.55)
  put(25, 0.56, 0.72) // колени
  put(26, 0.44, 0.72)
  put(27, 0.56, 0.9) // стопы
  put(28, 0.44, 0.9)
  for (const [index, [x, y]] of Object.entries(over)) put(Number(index), x, y)
  return points
}

/** Кадр вписан один в один: так проще проверять числа. */
const FIT = { ox: 0, oy: 0, dw: 400, dh: 800, scale: 1 }

const TYPES = [
  'barrier',
  'wall',
  'beam',
  'strike',
  'knee',
  'bird',
  'pit',
  'lunge',
  'heel',
  'bend',
  'jumpsquat',
  'jack',
  'hop',
  'legside',
  'sidelunge',
  'wings',
  'clap',
  'twistknee',
]

/** Холст-счётчик: важно не как нарисовано, а что дошло до холста. */
function fakeCtx() {
  const calls = []
  const sets = []
  /** Что и каким кеглем написано на холсте: по этому проверяется счётчик серии. */
  const texts = []
  let font = ''
  return new Proxy(
    { calls, sets, texts },
    {
      get(target, key) {
        if (key === 'calls') return calls
        if (key === 'sets') return sets
        if (key === 'texts') return texts
        if (key === 'canvas') return { width: 400, height: 800 }
        if (key === 'fillText') {
          return (...args) => {
            calls.push(key)
            texts.push({ text: String(args[0]), size: Number(/(\d+)px/.exec(font)?.[1] ?? 0) })
          }
        }
        // настоящий холст отдаёт градиент объектом — заглушка обязана тоже,
        // иначе виньетка падает на addColorStop, которого нет у числа
        if (key === 'createLinearGradient' || key === 'createRadialGradient') {
          return (...args) => {
            calls.push(key)
            void args
            return { addColorStop() {} }
          }
        }
        return (...args) => {
          calls.push(key)
          return args[0]
        }
      },
      set(target, key, value) {
        sets.push([key, value])
        if (key === 'font') font = String(value)
        return true
      },
    },
  )
}

const obstacleOf = (type, over = {}) => ({
  id: 1,
  type,
  side: 'left',
  spawnAt: 0,
  travelMs: 2000,
  status: 'incoming',
  ...over,
})

const frameOf = (obstacles, over = {}) => ({
  width: 400,
  height: 800,
  clockMs: 1000,
  obstacles,
  body: readBody(pose(), FIT),
  cheap: false,
  ...over,
})

describe('тело читается из точек позы', () => {
  it('опоры считаются в пикселях экрана и зеркально', () => {
    const body = readBody(pose(), FIT)

    expect(body).toBeTruthy()
    // x зеркальный: своя левая сторона человека лежит слева на экране
    expect(body.shoulderL.x).toBeLessThan(body.shoulderR.x)
    expect(body.shoulder.y).toBeLessThan(body.hip.y)
    expect(body.width).toBeGreaterThan(0)
    expect(body.torso).toBeGreaterThan(0)
  })

  it('без позы раскладки нет вовсе — мишень не вешают в пустоту', () => {
    expect(readBody(null, FIT)).toBeNull()
    expect(readBody(pose(), null)).toBeNull()
    expect(layoutFor('strike', 'left', null)).toBeNull()
  })

  it('потерянные колени и стопы подменяются продолжением корпуса', () => {
    // ноги уходят из кадра на каждом шаге вбок: раскладка обязана пережить это
    const half = pose()
    for (const index of [25, 26, 27, 28]) half[index] = null

    const body = readBody(half, FIT)
    expect(body.knee.y).toBeGreaterThan(body.hip.y)
    expect(body.ankle.y).toBeGreaterThan(body.knee.y)
  })
})

describe('раскладка всех восемнадцати', () => {
  const body = readBody(pose(), FIT)

  for (const type of TYPES) {
    it(`${type}: мишень есть, стоит от тела и подписана`, () => {
      const layout = layoutFor(type, 'left', body)

      expect(layout).toBeTruthy()
      expect(layout.spots.length).toBeGreaterThan(0)
      expect(layout.label).toBe(TYPE_LABEL[type])
      expect(ZONE_COLOR[layout.zone]).toBeTruthy()
      for (const spot of layout.spots) {
        expect(Number.isFinite(spot.x)).toBe(true)
        expect(Number.isFinite(spot.y)).toBe(true)
        expect(spot.r).toBeGreaterThan(0)
      }
    })
  }

  it('парные движения дают по две мишени, звезда — четыре', () => {
    expect(layoutFor('wings', null, body).spots).toHaveLength(2)
    expect(layoutFor('clap', null, body).spots).toHaveLength(2)
    expect(layoutFor('hop', null, body).spots).toHaveLength(2)
    expect(layoutFor('jack', null, body).spots).toHaveLength(4)
  })

  it('крест звезды: две мишени над головой, две у пола', () => {
    const spots = layoutFor('jack', null, body).spots
    const above = spots.filter((s) => s.y < body.nose.y)
    const below = spots.filter((s) => s.y > body.hip.y)

    expect(above).toHaveLength(2)
    expect(below).toHaveLength(2)
    // и разнесены по сторонам, а не свалены в одну точку
    expect(above[0].x).not.toBeCloseTo(above[1].x, 0)
  })

  /**
   * СТОРОНА МИШЕНИ ПРОТИВ СТОРОНЫ ДЕТЕКТОРА — самая дорогая ошибка этого слоя.
   *
   * Полевой лог: 16 промахов no-step подряд при амплитуде шага до 1.7 ширины
   * плеч. Человек шагал честно и бодро — но в кольцо, а кольцо висело на
   * стороне стены, тогда как зачёт даётся за уход в противоположную. Один
   * зачёт за весь заход случился ровно тогда, когда он шагнул МИМО мишени.
   *
   * Поэтому проверка идёт не «слева ли кольцо», а против самих детекторов:
   * шагни к мишени — и dodgeDistance обязан дать плюс. Разъедься знак снова —
   * тест назовёт это раньше, чем полевой лог.
   */
  describe('картинка и детектор согласны о стороне', () => {
    /** Экранная координата 0..1 из пикселя: та же система, что у детекторов. */
    const norm = (px) => (px - FIT.ox) / FIT.dw
    const STEP = 0.15

    for (const side of ['left', 'right']) {
      it(`шаг в сторону, side ${side}: шаг К кольцу даёт детектору плюс`, () => {
        const ring = layoutFor('wall', side, body).spots[0]
        const base = norm(body.hip.x)
        // человек идёт туда, куда зовёт мишень
        const stepped = base + Math.sign(ring.x - body.hip.x) * STEP

        expect(dodgeDistance(stepped, base, side)).toBeGreaterThan(0)
        // и обратное: шаг в другую сторону детектор считает движением к стене
        expect(dodgeDistance(base - Math.sign(ring.x - body.hip.x) * STEP, base, side)).toBeLessThan(0)
      })

      it(`наклон вбок, side ${side}: наклон К кольцу даёт детектору плюс`, () => {
        const ring = layoutFor('beam', side, body).spots[0]
        const hip = norm(body.hip.x)
        const shoulders = hip + Math.sign(ring.x - body.hip.x) * STEP

        expect(leanDistance(shoulders, hip, side)).toBeGreaterThan(0)
      })
    }

    /**
     * У остальных боковых сторона — это рабочая конечность, и мишень обязана
     * висеть с её стороны экрана. Зеркало уже учтено в readBody: своя левая
     * рука лежит слева.
     */
    const LIMB = {
      strike: 'wristL',
      bird: 'wristL',
      knee: 'hipL',
      legside: 'hipL',
      heel: 'hipL',
      sidelunge: 'hipL',
      twistknee: 'hipL',
    }

    for (const [type, anchor] of Object.entries(LIMB)) {
      it(`${type}: мишень с той же стороны, что и рабочая конечность`, () => {
        const own = Math.sign(body[anchor].x - body.hip.x)
        const left = layoutFor(type, 'left', body).spots[0]
        const right = layoutFor(type, 'right', body).spots[0]

        expect(Math.sign(left.x - body.hip.x)).toBe(own)
        expect(Math.sign(right.x - body.hip.x)).toBe(-own)
      })
    }

    it('знак считает одна общая функция, и все боковые типы ходят через неё', () => {
      const SIDED = [
        'wall',
        'strike',
        'knee',
        'bird',
        'legside',
        'heel',
        'sidelunge',
        'beam',
        'twistknee',
      ]
      for (const type of SIDED) {
        for (const side of ['left', 'right']) {
          const spot = layoutFor(type, side, body).spots[0]
          expect({ тип: type, сторона: side, знак: Math.sign(spot.x - body.hip.x) }).toEqual({
            тип: type,
            сторона: side,
            знак: screenDir(type, side),
          })
        }
      }
    })

    it('у стены и балки знак перевёрнут, у конечностей — нет', () => {
      // сторона стены говорит, ГДЕ она; мишень зовёт в свободную сторону
      expect(screenDir('wall', 'left')).toBe(1)
      expect(screenDir('beam', 'left')).toBe(1)
      expect(screenDir('strike', 'left')).toBe(-1)
      expect(screenDir('sidelunge', 'left')).toBe(-1)
    })
  })

  it('сторона движения двигает мишень, а не только красит', () => {
    const left = layoutFor('strike', 'left', body).spots[0]
    const right = layoutFor('strike', 'right', body).spots[0]

    expect(left.x).toBeLessThan(body.shoulder.x)
    expect(right.x).toBeGreaterThan(body.shoulder.x)
  })

  it('кольцо приседа висит между тазом и коленями', () => {
    const ring = layoutFor('barrier', null, body).spots[0]

    expect(ring.kind).toBe('ring')
    expect(ring.y).toBeGreaterThan(body.hip.y)
    expect(ring.y).toBeLessThan(body.knee.y)
  })

  it('личная амплитуда приседа опускает кольцо, а не переносит его', () => {
    const shallow = layoutFor('barrier', null, body, { personal: { barrier: 32 } }).spots[0]
    const deep = layoutFor('barrier', null, body, { personal: { barrier: 78 } }).spots[0]

    expect(deep.y).toBeGreaterThan(shallow.y)
    expect(deep.y).toBeLessThan(body.knee.y)
  })

  it('кольцо выпада выше кольца приседа', () => {
    const lunge = layoutFor('lunge', 'left', body).spots[0]
    const squat = layoutFor('barrier', null, body).spots[0]

    expect(lunge.y).toBeLessThan(squat.y)
  })

  it('присед с прыжком переключает кольцо на звезду по признаку движка', () => {
    const before = layoutFor('jumpsquat', null, body, { ducked: false })
    const after = layoutFor('jumpsquat', null, body, { ducked: true })

    expect(before.spots[0].kind).toBe('ring')
    expect(after.spots[0].kind).toBe('star')
    // звезда над головой: за ней и тянутся вверх
    expect(after.spots[0].y).toBeLessThan(body.nose.y)
  })
})

describe('мишени живут своей жизнью только на экране', () => {
  it('мишень появляется на спавне и исчезает вместе с препятствием', () => {
    const targets = createTargets()
    const ctx = fakeCtx()

    targets.draw(ctx, frameOf([obstacleOf('knee')]))
    expect(targets.live.size).toBe(1)

    targets.draw(ctx, frameOf([]))
    expect(targets.live.size).toBe(0)
  })

  it('мишень под конечность идёт за телом, а кольцо приседа прибито к месту', () => {
    /**
     * Кольцо, привязанное к тазу, уезжает вниз ровно с той же скоростью, с
     * какой человек приседает: дотянуться до него нельзя никогда. Это та самая
     * ошибка, из-за которой не полетела стена с вырезом.
     */
    const targets = createTargets()
    const ctx = fakeCtx()
    const moved = readBody(
      pose({ 23: [0.56, 0.7], 24: [0.44, 0.7], 25: [0.56, 0.85], 26: [0.44, 0.85] }),
      FIT,
    )

    targets.draw(ctx, frameOf([obstacleOf('knee'), obstacleOf('barrier', { id: 2 })]))
    const kneeBefore = targets.live.get(1).spots[0].y
    const ringBefore = targets.live.get(2).spots[0].y

    for (let i = 0; i < 8; i += 1) {
      targets.draw(ctx, frameOf([obstacleOf('knee'), obstacleOf('barrier', { id: 2 })], { body: moved }))
    }

    expect(targets.live.get(1).spots[0].y).toBeGreaterThan(kneeBefore)
    expect(targets.live.get(2).spots[0].y).toBe(ringBefore)
  })

  it('зачёт от движка взрывает мишень в её точке и даёт очки', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([obstacleOf('strike')]))
    const spot = { ...targets.live.get(1).spots[0] }

    targets.clear(1, { points: 300 })

    const { parts, rings, floats } = targets.effects
    expect(parts.length).toBeGreaterThan(10)
    expect(rings).toHaveLength(1)
    expect(rings[0].x).toBeCloseTo(spot.x, 0)
    expect(floats[0].text).toBe('+300')
    // мишень с экрана уходит: она своё дело сделала
    expect(targets.live.size).toBe(0)
  })

  /**
   * ПОЛЕВАЯ ЖАЛОБА (Redmi, сессия день 1): «числа +очки не видно в бою».
   *
   * Причина — гонка, которую видно только на телефоне с синхронным показом.
   * Движок судит зачёт и СРАЗУ ставит препятствию status='cleared'. Картинка
   * ответа при этом уходит в очередь показа (frameSync) и ждёт свой кадр — до
   * задержки инференса, а в худшем случае до SHOW_WAIT_MAX_MS. Отрисовка тем
   * временем пропускает всё, что 'cleared', не заносит мишень в seen — и
   * забывает её. Очередь наконец отдаёт ответ, а мишени уже нет: clear() выходил
   * первой же строкой, и не было ни числа, ни взрыва, ни следа.
   *
   * Синхронный показ включается сам везде, где есть requestVideoFrameCallback,
   * то есть на любом Android-хроме. Поэтому в живом режиме и в прежних тестах
   * всё работало, а на живом телефоне ответа на зачёт не было вовсе.
   */
  it('отложенный ответ доходит до мишени, которую отрисовка уже забыла', () => {
    const targets = createTargets()
    const ctx = fakeCtx()

    targets.draw(ctx, frameOf([obstacleOf('strike')]))
    const spot = { ...targets.live.get(1).spots[0] }

    // движок отсудил: препятствие стало cleared, кадр отрисовался, мишень забыта
    targets.draw(ctx, frameOf([obstacleOf('strike', { status: 'cleared' })], { clockMs: 1100 }))
    expect(targets.live.size).toBe(0)

    // и только теперь очередь показа отдаёт ответ
    targets.clear(1, { points: 150 })

    const { floats, parts, hits } = targets.effects
    expect(floats.map((f) => f.text)).toEqual(['+150'])
    // и число приходит В ТУ ЖЕ ТОЧКУ, где мишень висела, а не в середину экрана
    expect(floats[0].x).toBeCloseTo(spot.x, 0)
    expect(floats[0].y).toBeCloseTo(spot.y, 0)
    expect(parts.length).toBeGreaterThan(10)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('память о снятой мишени живёт дольше окна ожидания очереди, но не вечно', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([obstacleOf('strike')]))
    const spot = { ...targets.live.get(1).spots[0] }
    targets.draw(ctx, frameOf([], { clockMs: 1100 }))

    // очередь показа держит ответ не дольше SHOW_WAIT_MAX_MS — столько мишень и
    // обязана помниться, чтобы ответ пришёл в ЕЁ точку
    targets.draw(ctx, frameOf([], { clockMs: 1100 + SHOW_WAIT_MAX_MS }))
    targets.clear(1, { points: 100 })
    expect(targets.effects.floats[0].x).toBeCloseTo(spot.x, 0)
    expect(targets.effects.parts.length).toBeGreaterThan(0)

    /**
     * Дальше память чистится: держать её вечно значит копить все мишени раунда.
     * Теряется при этом ТОЧКА, а не число — «+100» посреди экрана лучше
     * молчания, а взрыву без точки случиться негде.
     */
    const late = createTargets()
    late.draw(ctx, frameOf([obstacleOf('strike')]))
    late.draw(ctx, frameOf([], { clockMs: 1100 }))
    late.draw(ctx, frameOf([], { clockMs: 1100 + SHOW_WAIT_MAX_MS + 5000 }))
    late.clear(1, { points: 100 })

    expect(late.effects.floats).toHaveLength(1)
    expect(late.effects.floats[0].x).toBe(200)
    expect(late.effects.parts).toHaveLength(0)
  })

  it('отложенный промах тоже доходит: мишень гаснет красным, а не молчит', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([obstacleOf('bird')]))
    targets.draw(ctx, frameOf([obstacleOf('bird', { status: 'hit' })], { clockMs: 1100 }))

    expect(() => targets.miss(1)).not.toThrow()
    expect(targets.streak).toBe(0)
  })

  /**
   * ЧИСЛО ЖИВЁТ ПО ЧАСАМ, А НЕ ПО КАДРАМ.
   *
   * Раньше оно гасло долей за нарисованный кадр (`life -= 0.02`). На слабом
   * телефоне кадр длится около 140 мс И рисуется через раз (drawEveryOther), так
   * что одни и те же пятьдесят шагов затухания растягивались на три с лишним
   * секунды, а на быстром телефоне укладывались в восемьсот миллисекунд. Число —
   * единственное место, где игра называет цену действия вслух, и жить оно обязано
   * одинаково у всех.
   */
  it('число не зависит от того, сколько кадров успел нарисовать телефон', () => {
    const fast = createTargets()
    const slow = createTargets()

    for (const targets of [fast, slow]) {
      targets.draw(fakeCtx(), frameOf([obstacleOf('strike')]))
      targets.clear(1, { points: 100 })
    }

    // быстрый телефон: двадцать кадров по 16 мс — прошло 320 мс
    for (let i = 1; i <= 20; i += 1) {
      fast.draw(fakeCtx(), frameOf([], { clockMs: 1000 + i * 16 }))
    }
    // слабый: два нарисованных кадра по 160 мс — прошло столько же
    for (let i = 1; i <= 2; i += 1) {
      slow.draw(fakeCtx(), frameOf([], { clockMs: 1000 + i * 160 }))
    }

    // на обоих телефонах число ещё на экране: прошло одинаковое ВРЕМЯ
    expect(fast.effects.floats).toHaveLength(1)
    expect(slow.effects.floats).toHaveLength(1)

    // и уходит оно тоже по времени, а не по числу кадров
    fast.draw(fakeCtx(), frameOf([], { clockMs: 3000 }))
    slow.draw(fakeCtx(), frameOf([], { clockMs: 3000 }))
    expect(fast.effects.floats).toHaveLength(0)
    expect(slow.effects.floats).toHaveLength(0)
  })

  it('число видно в экономном режиме и переживает пропущенный кадр', () => {
    const targets = createTargets()
    targets.draw(fakeCtx(), frameOf([obstacleOf('strike')], { cheap: true }))
    targets.clear(1, { points: 150, cheap: true })

    /**
     * Экономный режим рисует через раз (drawEveryOther в GameScreen): между двумя
     * НАРИСОВАННЫМИ кадрами проходит до трёхсот миллисекунд. Число обязано
     * пережить такой промежуток — иначе оно целиком укладывается в пропущенный
     * кадр и не показывается ни разу.
     */
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([], { clockMs: 1300, cheap: true }))

    const drawn = ctx.texts.filter((t) => t.text === '+150')
    expect(drawn).toHaveLength(1)
    // и кегль у него крупный: мелкое число на записи не читается
    expect(drawn[0].size).toBeGreaterThan(30)
  })

  it('число доходит и без мишени: в ?classic=1 живых мишеней не бывает вовсе', () => {
    /**
     * Прежний вид по `?classic=1` рисует космос из space.js и кадр мишеней НЕ
     * зовёт — значит и живых мишеней у слоя нет по построению. Число при этом
     * обязано быть: это путь отката, и цену действия он называет так же, как
     * основной.
     *
     * Взрыв и след в этом случае пропускаются намеренно: им нужна точка, где
     * мишень висела, и без неё им негде случиться. Числу точка желательна, но не
     * обязательна — «+150» посреди экрана лучше молчания.
     */
    const targets = createTargets()
    targets.clear(1, { points: 150 })

    const { floats, parts } = targets.effects
    expect(floats.map((f) => f.text)).toEqual(['+150'])
    expect(parts).toHaveLength(0)

    // и оно рисуется: слой чисел зовётся отдельным проходом
    const ctx = fakeCtx()
    targets.drawFloats(ctx, { width: 400, height: 800, clockMs: 10 })
    expect(ctx.texts.map((t) => t.text)).toContain('+150')
  })

  it('промах от движка красит мишень красным, а не убирает', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([obstacleOf('bird')]))

    targets.miss(1)
    const after = fakeCtx()
    targets.draw(after, frameOf([obstacleOf('bird')]))

    expect(targets.live.size).toBe(1)
    const red = after.sets.some(([key, value]) => key === 'strokeStyle' && value === '#ff5a5a')
    expect(red).toBe(true)
  })

  it('конфетти — на каждый пятый зачёт подряд, промах серию рвёт', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    const hit = (id) => {
      targets.draw(ctx, frameOf([obstacleOf('knee', { id })]))
      targets.clear(id, { points: 100 })
    }

    for (let i = 1; i <= 4; i += 1) hit(i)
    expect(targets.effects.confetti).toHaveLength(0)
    hit(5)
    expect(targets.effects.confetti.length).toBeGreaterThan(0)

    targets.miss(99)
    expect(targets.streak).toBe(0)
  })

  it('экономный режим: без шлейфов, без конфетти и вдвое меньше частиц', () => {
    const rich = createTargets()
    const poor = createTargets()
    const richCtx = fakeCtx()
    const poorCtx = fakeCtx()

    // шлейф рисуется поверх обычного кадра: в экономном режиме его нет вовсе
    for (let i = 0; i < 4; i += 1) {
      rich.draw(richCtx, frameOf([obstacleOf('strike')]))
      poor.draw(poorCtx, frameOf([obstacleOf('strike')], { cheap: true }))
    }
    expect(richCtx.calls.filter((c) => c === 'stroke').length).toBeGreaterThan(
      poorCtx.calls.filter((c) => c === 'stroke').length,
    )

    rich.clear(1, { points: 100, cheap: false })
    poor.clear(1, { points: 100, cheap: true })
    expect(poor.effects.parts.length).toBeLessThan(rich.effects.parts.length)
    expect(poor.effects.shake).toBe(0)

    for (let i = 2; i <= 5; i += 1) {
      poor.draw(poorCtx, frameOf([obstacleOf('knee', { id: i })], { cheap: true }))
      poor.clear(i, { points: 100, cheap: true })
    }
    expect(poor.effects.confetti).toHaveLength(0)
  })

  it('зачёт видно и на слабом телефоне: яркий след живёт почти полсекунды', () => {
    /**
     * Полевая жалоба: промах видно (мишень краснеет), зачёт слышно — а видно
     * почти никак. В экономном режиме от взрыва остаётся тринадцать частиц без
     * свечения, и на семи кадрах в секунду глаз их не ловит.
     *
     * След обязан пережить пропущенный кадр: на слабом телефоне кадр длится
     * около 140 мс и рисуется через раз, то есть промежуток между двумя
     * НАРИСОВАННЫМИ кадрами доходит до 300 мс.
     */
    const targets = createTargets()
    const ctx = fakeCtx()
    const at = (clockMs, over = {}) =>
      targets.draw(ctx, frameOf([obstacleOf('knee')], { cheap: true, clockMs, ...over }))

    at(1000)
    targets.clear(1, { points: 100, cheap: true })

    const mark = targets.effects.hits[0]
    expect(mark).toBeTruthy()
    expect(mark.color).toBe(ZONE_COLOR.legs)
    expect(mark.r).toBeGreaterThan(0)

    // мишени на экране уже нет, а след есть — и через 400 мс тоже
    at(1200, { obstacles: [] })
    expect(targets.effects.hits).toHaveLength(1)
    at(1400, { obstacles: [] })
    expect(targets.effects.hits).toHaveLength(1)

    // и только потом гаснет
    at(1460, { obstacles: [] })
    expect(targets.effects.hits).toHaveLength(0)
  })

  it('след живёт по часам, а не по кадрам: пропущенные кадры его не съедают', () => {
    // частицы и волны гаснут долей ЗА КАДР, и на слабом телефоне это вдвое
    // быстрее по времени — ровно там, где зачёт надо показать подольше
    const targets = createTargets()
    const ctx = fakeCtx()

    targets.draw(ctx, frameOf([obstacleOf('knee')], { cheap: true, clockMs: 1000 }))
    targets.clear(1, { points: 100, cheap: true })

    // ни одного кадра между зачётом и этим — след всё равно на месте
    targets.draw(ctx, frameOf([], { cheap: true, clockMs: 1300 }))
    expect(targets.effects.hits).toHaveLength(1)
    expect(ctx.calls).toContain('stroke')
  })

  it('тот же след — в силовом блоке, где мишеней нет вовсе', () => {
    // одно и то же засчитанное движение обязано отзываться одинаково
    const targets = createTargets()
    targets.burstAt(100, 200, { points: 50, cheap: true })
    expect(targets.effects.hits).toHaveLength(1)
    expect(targets.effects.hits[0].r).toBeGreaterThanOrEqual(24)
  })

  it('без позы кадр не падает: мишеней просто нет', () => {
    const targets = createTargets()
    const ctx = fakeCtx()

    expect(() =>
      targets.draw(ctx, frameOf([obstacleOf('barrier')], { body: null })),
    ).not.toThrow()
    expect(targets.live.size).toBe(0)
  })
})

describe('мишень ловца: только картинка', () => {
  /**
   * У ловца слой не решает НИЧЕГО про место: точку и радиус выбрал catcher.js в
   * нормированных координатах и приколотил их. Здесь проверяется ровно перевод
   * в пиксели — и то, что он не спорит с судьёй.
   */
  const catchOf = (over = {}) => ({
    id: 7,
    type: 'catch',
    part: 'knee',
    side: 'left',
    spawnAt: 0,
    travelMs: 3000,
    lifeMs: 3000,
    status: 'incoming',
    spot: { x: 0.7, y: 0.6, rx: 0.09, ry: 0.045 },
    ...over,
  })

  it('место переводится в пиксели с одним-единственным зеркалом', () => {
    const target = catchOf()
    const spot = catchLayout(target, FIT).spots[0]

    // x экрана = 1 - x точки: та самая строка, ошибка в знаке которой стоила
    // шестнадцати промахов подряд у прежнего слоя
    expect(spot.x).toBeCloseTo(FIT.ox + (1 - 0.7) * FIT.dw, 6)
    expect(spot.y).toBeCloseTo(FIT.oy + 0.6 * FIT.dh, 6)
    // левая сторона человека лежит СЛЕВА на экране
    expect(spot.x).toBeLessThan(FIT.ox + FIT.dw / 2)
  })

  it('радиус берётся МЕНЬШИЙ из двух — круг лежит внутри судейской области', () => {
    /**
     * Судья меряет двумя единицами, своей по горизонтали и своей по вертикали,
     * поэтому его область на экране — почти круг, но эллипс. «Почти» надо
     * разрешать в правильную сторону: нарисованный круг обязан лежать ВНУТРИ,
     * иначе человек попадёт в мишень и не получит зачёта.
     */
    const target = catchOf({ spot: { x: 0.5, y: 0.5, rx: 0.09, ry: 0.02 } })
    const spot = catchLayout(target, FIT).spots[0]
    expect(spot.r).toBe(Math.min(0.09 * FIT.dw, 0.02 * FIT.dh))
    expect(spot.r).toBeLessThanOrEqual(0.09 * FIT.dw)
    expect(spot.r).toBeLessThanOrEqual(0.02 * FIT.dh)
  })

  it('подпись — слово части тела из того же файла, что и судья', () => {
    for (const [part, word] of Object.entries(PART_LABEL)) {
      expect(catchLayout(catchOf({ part }), FIT).label).toBe(word)
    }
  })

  it('кольцо-таймер показывает остаток жизни, а не пройденное время', () => {
    const target = catchOf({ lifeMs: 3000 })
    expect(catchLife(target, 0)).toBe(1)
    expect(catchLife(target, 1500)).toBeCloseTo(0.5, 6)
    expect(catchLife(target, 4000)).toBe(0)
    expect(catchLayout(target, FIT, { life: catchLife(target, 1500) }).spots[0].life).toBeCloseTo(
      0.5,
      6,
    )
  })

  it('мишень приколочена: тело двигается, а круг стоит', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    const target = catchOf()

    targets.draw(ctx, frameOf([target], { fit: FIT }))
    const first = { ...targets.live.get(7).spots[0] }

    // человек ушёл в сторону — мишень не следует за ним ни на пиксель
    const moved = readBody(pose({ 23: [0.8, 0.55], 24: [0.7, 0.55] }), FIT)
    targets.draw(ctx, frameOf([target], { fit: FIT, body: moved, clockMs: 1500 }))
    const second = targets.live.get(7).spots[0]
    expect(second.x).toBe(first.x)
    expect(second.y).toBe(first.y)
    expect(second.r).toBe(first.r)
    // а вот таймер за это время убыл
    expect(second.life).toBeLessThan(first.life)
  })

  it('мишень ловца рисуется без тела: место она знает и без него', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    expect(() =>
      targets.draw(ctx, frameOf([catchOf()], { fit: FIT, body: null })),
    ).not.toThrow()
    expect(targets.live.size).toBe(1)
  })

  it('без рамки кадра мишень не строится — гадать о пикселях слой не берётся', () => {
    expect(catchLayout(catchOf(), null)).toBeNull()
    expect(catchLayout({ type: 'catch' }, FIT)).toBeNull()
  })

  it('зачёт взрывает мишень там, где она висела', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([catchOf()], { fit: FIT }))
    const spot = { ...targets.live.get(7).spots[0] }

    targets.clear(7, { points: 200 })
    expect(targets.live.has(7)).toBe(false)
    const ring = targets.effects.rings[0]
    expect(ring.x).toBeCloseTo(spot.x, 6)
    expect(ring.y).toBeCloseTo(spot.y, 6)
    expect(targets.effects.floats[0].text).toBe('+200')
  })

  it('ни одной проверки попадания здесь по-прежнему нет', () => {
    /**
     * Железное правило файла. Заведись здесь своя проверка — и в игре появятся
     * два судьи с разными мнениями, а человек начнёт видеть попадание там, где
     * ему не засчитали.
     */
    const source = readFileSync(new URL('./targets.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/partSpots|createCatcher|readCatchBody|holdFrames/)
  })
})

describe('эффектность мишени ловца', () => {
  /**
   * Проверяется КАРТИНКА, а не судейство: слой по-прежнему ничего не решает.
   * Все три числа — цвет части, близость конечности и доля прожитой жизни —
   * приходят готовыми из движка, и здесь их только показывают.
   */
  const catchOf = (over = {}) => ({
    id: 7,
    type: 'catch',
    part: 'knee',
    side: 'left',
    spawnAt: 0,
    travelMs: 3000,
    lifeMs: 3000,
    status: 'incoming',
    spot: { x: 0.7, y: 0.6, rx: 0.09, ry: 0.045 },
    near: null,
    aged: 0,
    ...over,
  })

  /** Что дошло до холста за один кадр: значения свойств по имени. */
  function paint(targets, ctx, obstacle, over = {}) {
    const before = ctx.sets.length
    targets.draw(ctx, frameOf([obstacle], { fit: FIT, ...over }))
    const sets = ctx.sets.slice(before)
    return { sets, all: (key) => sets.filter(([k]) => k === key).map(([, v]) => v) }
  }

  it('у каждой части тела свой цвет, и он берётся из общего языка зон', () => {
    // четыре части и четыре зоны: делить цвет соседкам больше не приходится
    expect(PART_ZONE).toEqual({ palm: 'arms', elbow: 'core', knee: 'legs', foot: 'full' })
    expect(ZONE_COLOR[PART_ZONE.palm]).toBe('#ffc24c')
    expect(ZONE_COLOR[PART_ZONE.elbow]).toBe('#59f0a8')
    expect(ZONE_COLOR[PART_ZONE.knee]).toBe('#4ce0ff')
    expect(ZONE_COLOR[PART_ZONE.foot]).toBe('#c78bff')
    expect(new Set(Object.values(PART_ZONE)).size).toBe(4)
  })

  it('подпись, круг, взрыв и «+очки» — все в цвете части', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    const own = ZONE_COLOR.full
    const { all } = paint(targets, ctx, catchOf({ part: 'foot' }))

    expect(all('strokeStyle')).toContain(own)
    expect(all('fillStyle')).toContain(own)

    targets.clear(7, { points: 200 })
    expect(targets.effects.floats[0].color).toBe(own)
    expect(targets.effects.rings.every((ring) => ring.color === own)).toBe(true)
    expect(targets.effects.parts.some((part) => part.color === own)).toBe(true)
  })

  it('появление: круг выпрыгивает 0 -> 1.15 -> 1.0 за четверть секунды', () => {
    expect(popAt(0)).toBeCloseTo(0, 6)
    expect(popAt(250)).toBeCloseTo(1, 6)
    expect(popAt(4000)).toBeCloseTo(1, 6)
    const peak = Math.max(...Array.from({ length: 251 }, (_, ms) => popAt(ms)))
    expect(peak).toBeGreaterThan(1.14)
    expect(peak).toBeLessThan(1.16)

    // и прыжок правда доезжает до холста: в первый кадр круга ещё нет
    const targets = createTargets()
    const ctx = fakeCtx()
    const thin = Math.max(...paint(targets, ctx, catchOf(), { clockMs: 0 }).all('lineWidth'))
    const full = Math.max(...paint(targets, ctx, catchOf(), { clockMs: 250 }).all('lineWidth'))
    expect(thin).toBeLessThan(full)
  })

  it('появление даёт одну волну — и только в момент появления', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    const target = catchOf()

    paint(targets, ctx, target)
    expect(targets.effects.rings).toHaveLength(1)
    paint(targets, ctx, target, { clockMs: 1200 })
    expect(targets.effects.rings).toHaveLength(1)
  })

  it('магнит: чем ближе конечность, тем ярче круг', () => {
    const bright = (near) => {
      const targets = createTargets()
      const ctx = fakeCtx()
      return Math.max(...paint(targets, ctx, catchOf({ near })).all('shadowBlur'))
    }

    // дальше двух радиусов — обычное свечение, ровно как было
    expect(bright(4)).toBe(bright(2))
    expect(bright(1.5)).toBeGreaterThan(bright(2))
    expect(bright(1)).toBeGreaterThan(bright(1.5))
    // внутри круга ярче некуда
    expect(bright(0.2)).toBe(bright(1))

    expect(pullAt(2)).toBe(0)
    expect(pullAt(1)).toBe(1)
    expect(pullAt(0.1)).toBe(1)
    // конечности не видно — магнита нет вовсе
    expect(pullAt(null)).toBe(0)
  })

  it('в дешёвом режиме магнит виден толщиной обводки, а не свечением', () => {
    const poor = (near) => {
      const targets = createTargets()
      const ctx = fakeCtx()
      const { all } = paint(targets, ctx, catchOf({ near }), { cheap: true })
      return { blur: Math.max(...all('shadowBlur')), width: Math.max(...all('lineWidth')) }
    }
    // свечения на слабом телефоне нет ни при каком приближении
    expect(poor(4).blur).toBe(0)
    expect(poor(1).blur).toBe(0)
    expect(poor(1).width).toBeGreaterThan(poor(4).width)
  })

  it('в дешёвом режиме волна и вспышка остаются: они стоят одну дугу', () => {
    /**
     * Экономный режим делит эффекты по ЦЕНЕ, а не по новизне. Волна и вспышка —
     * это одна дуга на кадр; выключать их значит убрать ответ на зачёт с того
     * самого телефона, ради которого игра и делается: на двадцати кадрах в
     * секунду экономный режим включён постоянно.
     */
    const targets = createTargets()
    const ctx = fakeCtx()
    paint(targets, ctx, catchOf(), { cheap: true })
    expect(targets.effects.rings).toHaveLength(1)

    targets.clear(7, { points: 200, cheap: true })
    expect(targets.effects.flashes).toHaveLength(1)
    // а дорогое осталось выключенным: взрыв половинный, тряски нет
    expect(targets.effects.parts.length).toBeGreaterThan(0)
    expect(targets.effects.shake).toBe(0)
  })

  it('последняя треть жизни: пульс вдвое чаще, кольцо-таймер краснеет', () => {
    expect(catchUrgent(catchOf({ aged: 0.5 }), 0)).toBe(false)
    expect(catchUrgent(catchOf({ aged: 0.7 }), 0)).toBe(true)

    /** Сколько раз круг прошёл через свой обычный размер за окно времени. */
    const swings = (from, to) => {
      let turns = 0
      let last = null
      for (let t = from; t <= to; t += 5) {
        const value = beatAt(t, 0, 3000, 0.5) - 1
        if (last != null && Math.sign(value) !== Math.sign(last)) turns += 1
        last = value
      }
      return turns
    }
    // тревога начинается на 2000 мс из 3000: до неё и после — равные окна
    expect(swings(2200, 3200)).toBeGreaterThan(swings(800, 1800) * 1.8)

    const targets = createTargets()
    const ctx = fakeCtx()
    const { all } = paint(targets, ctx, catchOf({ aged: 0.8 }), { clockMs: 2400 })
    expect(all('strokeStyle')).toContain('#ff5a5a')
  })

  it('пульс не рвётся в тот момент, когда учащается', () => {
    // фаза копится, а не пересчитывается: скачок читался бы как сбой картинки
    const at = (t) => beatAt(t, 0, 3000, 0.66)
    expect(Math.abs(at(2001) - at(1999))).toBeLessThan(0.01)
  })

  it('зачёт: белая вспышка на три кадра и вторая волна через восемьдесят мс', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    paint(targets, ctx, catchOf())
    const spot = { ...targets.live.get(7).spots[0] }
    const spawnWaves = targets.effects.rings.length

    targets.clear(7, { points: 200 })
    expect(targets.effects.flashes).toHaveLength(1)
    expect(targets.effects.flashes[0].x).toBeCloseTo(spot.x, 6)

    // волн стало на две больше: взрыв и отложенное эхо
    expect(targets.effects.rings).toHaveLength(spawnWaves + 2)
    const echo = targets.effects.rings[targets.effects.rings.length - 1]
    expect(echo.at).toBe(1000 + 80)

    // эхо стоит на месте, пока не подошёл его час
    const radius = echo.r
    targets.draw(ctx, frameOf([], { fit: FIT, clockMs: 1050 }))
    expect(echo.r).toBe(radius)
    targets.draw(ctx, frameOf([], { fit: FIT, clockMs: 1100 }))
    expect(echo.r).toBeGreaterThan(radius)

    // вспышка гаснет за три кадра
    for (let i = 0; i < 2; i += 1) targets.draw(ctx, frameOf([], { fit: FIT, clockMs: 1100 }))
    expect(targets.effects.flashes).toHaveLength(0)
  })

  it('промах остался прежним: красное затухание и никакого магнита', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    paint(targets, ctx, catchOf({ near: 1.05 }))

    targets.miss(7)
    const { all } = paint(targets, ctx, catchOf({ near: 1.05 }), { clockMs: 1100 })
    // цвет промаха, а не части тела
    expect(all('strokeStyle')).toContain('#ff5a5a')
    // и упущенная мишень на подводимую руку больше не отзывается
    expect(Math.max(...all('shadowBlur'))).toBe(26)
    expect(targets.live.get(7).dead).toBeLessThan(1)
  })

  it('вся картинка считается от часов и сида — ни одного Math.random', () => {
    /**
     * То же правило, что и у движка: кадр по одним и тем же числам обязан
     * повторяться. Иначе ни разобрать запись, ни сравнить два прогона.
     */
    const source = readFileSync(new URL('./targets.js', import.meta.url), 'utf8')
    // ищем ВЫЗОВЫ: слово «Math.random» в комментарии как раз объясняет, почему
    // его здесь нет, и запрещать сам разговор о нём было бы глупо
    expect(source).not.toMatch(/Math\.random\(|setTimeout\(|setInterval\(|Date\.now\(/)
  })
})

describe('бой напоказ: серия, орбита, виньетка', () => {
  const catchOf = (over = {}) => ({
    id: 7,
    type: 'catch',
    part: 'knee',
    side: 'left',
    spawnAt: 0,
    travelMs: 3000,
    lifeMs: 3000,
    status: 'incoming',
    spot: { x: 0.7, y: 0.6, rx: 0.09, ry: 0.045 },
    near: null,
    aged: 0,
    ...over,
  })

  const paint = (targets, ctx, obstacles, over = {}) => {
    const sets = ctx.sets.length
    const calls = ctx.calls.length
    const texts = ctx.texts.length
    targets.draw(ctx, frameOf(obstacles, { fit: FIT, ...over }))
    const written = ctx.texts.slice(texts)
    return {
      all: (key) =>
        ctx.sets
          .slice(sets)
          .filter(([k]) => k === key)
          .map(([, v]) => v),
      calls: ctx.calls.slice(calls),
      /** Счётчик серии на этом кадре: его текст и кегль. */
      streak: written.find((t) => t.text.startsWith('×')) ?? null,
      points: written.find((t) => t.text.startsWith('+')) ?? null,
    }
  }

  /** Довести серию до n зачётов подряд. */
  function runStreak(targets, ctx, n, part = 'knee') {
    for (let i = 1; i <= n; i += 1) {
      targets.draw(ctx, frameOf([catchOf({ id: i, part })], { fit: FIT, clockMs: i * 100 }))
      targets.clear(i, { points: 200 })
    }
  }

  it('счётчик серии появляется с двойки, а не с первого зачёта', () => {
    // «×1» — это не серия, а просто зачёт: показывать его значит обесценить счёт
    const targets = createTargets()
    const ctx = fakeCtx()

    runStreak(targets, ctx, 1)
    expect(paint(targets, ctx, []).streak).toBeNull()

    runStreak(targets, ctx, 1)
    expect(targets.streak).toBe(2)
    expect(paint(targets, ctx, []).streak.text).toBe('×2')
  })

  it('счётчик красится частью тела последней мишени', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    runStreak(targets, ctx, 2, 'knee')
    expect(paint(targets, ctx, []).all('fillStyle')).toContain(ZONE_COLOR.legs)

    // следующая мишень другой части — и число меняет цвет вместе с работой
    runStreak(targets, ctx, 1, 'foot')
    const frame = paint(targets, ctx, [])
    expect(frame.streak.text).toBe('×3')
    expect(frame.all('fillStyle')).toContain(ZONE_COLOR.full)
  })

  it('каждый зачёт даёт счётчику скачок масштаба', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    runStreak(targets, ctx, 3)
    // сразу после зачёта число крупнее, чем спустя полсекунды
    const hot = paint(targets, ctx, [], { clockMs: 300 }).streak
    const cold = paint(targets, ctx, [], { clockMs: 900 }).streak
    expect(hot.text).toBe('×3')
    expect(hot.size).toBeGreaterThan(cold.size)
    // и рывок конечен: он затухает, а не растёт бесконечно
    expect(kickAt(0, 260, 0.5)).toBeCloseTo(1.5, 6)
    expect(kickAt(260, 260, 0.5)).toBeCloseTo(1, 6)
  })

  it('промах разрывает серию: она разлетается осколками и гаснет', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    runStreak(targets, ctx, 4)
    expect(targets.streak).toBe(4)

    targets.draw(ctx, frameOf([catchOf({ id: 9 })], { fit: FIT, clockMs: 500 }))
    const before = targets.effects.parts.length
    targets.miss(9)
    expect(targets.streak).toBe(0)

    // оборванная четвёрка ещё видна и разлетается осколками — но один раз
    const broke = paint(targets, ctx, [], { clockMs: 520 })
    expect(broke.streak.text).toBe('×4')
    const after = targets.effects.parts.length
    expect(after).toBeGreaterThan(before)
    paint(targets, ctx, [], { clockMs: 560 })
    expect(targets.effects.parts.length).toBeLessThanOrEqual(after)

    // и через полсекунды от обрыва на экране не остаётся ничего
    expect(paint(targets, ctx, [], { clockMs: 1100 }).streak).toBeNull()
  })

  it('орбита крутится и разгоняется на последней трети жизни', () => {
    /** Скорость — производная фазы по времени. */
    const speed = (at) => spinAt(at + 10, 0, 3000) - spinAt(at, 0, 3000)
    expect(speed(500)).toBeGreaterThan(0)
    // тревога начинается на 2000 мс из 3000
    expect(speed(2500)).toBeGreaterThan(speed(500) * 1.3)
    // фаза не рвётся в момент разгона: иначе кольцо дёрнется
    expect(Math.abs(spinAt(2001, 0, 3000) - spinAt(1999, 0, 3000))).toBeLessThan(0.02)
  })

  it('у живой мишени орбита есть, у погасшей нет', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    const dashed = (over) => paint(targets, ctx, [catchOf(over)], { clockMs: 800 }).calls
    expect(dashed({}).filter((c) => c === 'setLineDash').length).toBeGreaterThan(0)

    targets.miss(7)
    expect(dashed({}).filter((c) => c === 'setLineDash')).toHaveLength(0)
  })

  it('зачёт зажигает края экрана в цвете части и гаснет за 150 мс', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([catchOf({ part: 'palm' })], { fit: FIT, clockMs: 1000 }))
    targets.clear(7, { points: 200 })

    // четыре полосы по краям — по градиенту на каждую, и ни одного прохода
    // по всему холсту: полноэкранный градиент стоит дороже всего остального
    const lit = paint(targets, ctx, [], { clockMs: 1050 }).calls
    expect(lit.filter((c) => c === 'createLinearGradient')).toHaveLength(4)

    const gone = paint(targets, ctx, [], { clockMs: 1200 }).calls
    expect(gone.filter((c) => c === 'createLinearGradient')).toHaveLength(0)
  })

  it('каждый пятый зачёт добавляет волну во весь экран от самой мишени', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    runStreak(targets, ctx, 4)
    const before = targets.effects.rings.filter((r) => r.width > 1)
    expect(before).toHaveLength(0)

    runStreak(targets, ctx, 1)
    const wide = targets.effects.rings.filter((r) => r.width > 1)
    expect(wide).toHaveLength(1)
    // расходится она до края экрана, а не на радиус мишени
    expect(wide[0].v).toBeGreaterThan(Math.max(400, 800) / 20)
    expect(targets.effects.confetti.length).toBeGreaterThan(0)
  })

  it('всплывающие очки крупные, в цвете части и с рывком', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([catchOf({ part: 'elbow' })], { fit: FIT, clockMs: 1000 }))
    targets.clear(7, { points: 200 })
    expect(targets.effects.floats[0].color).toBe(ZONE_COLOR.core)

    const hot = paint(targets, ctx, [], { clockMs: 1000 }).points
    const cold = paint(targets, ctx, [], { clockMs: 1400 }).points
    expect(hot.text).toBe('+200')
    expect(hot.size).toBeGreaterThan(cold.size)
    // прежний кегль был 0.075 от меньшей стороны — стало заметно крупнее
    expect(cold.size).toBeGreaterThan(Math.min(400, 800) * 0.1)
  })
})

describe('бюджет частиц', () => {
  const catchOf = (id) => ({
    id,
    type: 'catch',
    part: 'knee',
    side: 'left',
    spawnAt: 0,
    travelMs: 3000,
    lifeMs: 3000,
    status: 'incoming',
    spot: { x: 0.7, y: 0.6, rx: 0.09, ry: 0.045 },
    near: null,
    aged: 0,
  })

  it('общий потолок на взрывы и конфетти вместе — новые сверх него не создаются', () => {
    /**
     * Телефон рисует игру на главном потоке и выдаёт двадцать кадров в секунду:
     * потолок здесь не пожелание, а физика. Считаем ОБА списка разом — иначе
     * юбилейное конфетти пробивает лимит именно в тот момент, ради которого всё
     * и затевалось.
     */
    const targets = createTargets()
    const ctx = fakeCtx()
    for (let i = 1; i <= 40; i += 1) {
      targets.draw(ctx, frameOf([catchOf(i)], { fit: FIT, clockMs: i * 20 }))
      targets.clear(i, { points: 200 })
      const { parts, confetti } = targets.effects
      expect(parts.length + confetti.length).toBeLessThanOrEqual(MAX_PARTICLES)
    }
  })

  it('живые частицы дорисовываются, а не выкидываются ради новых', () => {
    // выкинь старые — и взрыв гаснет на полпути, что выглядит поломкой
    const targets = createTargets()
    const ctx = fakeCtx()
    for (let i = 1; i <= 20; i += 1) {
      targets.draw(ctx, frameOf([catchOf(i)], { fit: FIT, clockMs: i * 20 }))
      targets.clear(i, { points: 200 })
    }
    const full = targets.effects.parts.length
    targets.draw(ctx, frameOf([], { fit: FIT, clockMs: 1000 }))
    // за кадр список только тает — по своему затуханию, а не по чужому месту
    expect(targets.effects.parts.length).toBeLessThanOrEqual(full)
  })

  it('в дешёвом режиме за кадр нет ни одного shadowBlur больше нуля', () => {
    /**
     * ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛЕНИЯ. shadowBlur — самая дорогая операция
     * Canvas2D на телефоне, и она единственная, из-за которой экономный режим
     * вообще существует. Всё остальное новое стоит O(1) и остаётся включённым;
     * а вот свечения не должно быть ни в одном вызове, включая магнит, подпись,
     * кольцо-таймер и счётчик серии.
     */
    const targets = createTargets()
    const ctx = fakeCtx()
    // серия, зачёт, виньетка, юбилей — самый насыщенный кадр, какой бывает
    for (let i = 1; i <= 5; i += 1) {
      targets.draw(ctx, frameOf([catchOf(i)], { fit: FIT, clockMs: i * 100, cheap: true }))
      targets.clear(i, { points: 200, cheap: true })
    }
    targets.miss(99)

    const before = ctx.sets.length
    targets.draw(
      ctx,
      frameOf([{ ...catchOf(9), near: 1.05, aged: 0.8 }], {
        fit: FIT,
        clockMs: 600,
        cheap: true,
      }),
    )
    const blur = ctx.sets
      .slice(before)
      .filter(([k]) => k === 'shadowBlur')
      .map(([, v]) => v)

    expect(blur.length).toBeGreaterThan(0)
    expect(blur.filter((v) => v > 0)).toEqual([])
  })

  it('в дешёвом режиме юбилей серии не добавляет ни одной частицы', () => {
    // волна во весь экран остаётся — она одна дуга; конфетти это шестьдесят
    // объектов разом, и добавлять их в самый горячий момент нельзя
    const targets = createTargets()
    const ctx = fakeCtx()
    let before = 0
    for (let i = 1; i <= 5; i += 1) {
      targets.draw(ctx, frameOf([catchOf(i)], { fit: FIT, clockMs: i * 100, cheap: true }))
      if (i === CONFETTI_EVERY) before = targets.effects.parts.length + targets.effects.confetti.length
      targets.clear(i, { points: 200, cheap: true })
    }
    expect(targets.streak).toBe(CONFETTI_EVERY)
    const after = targets.effects.parts.length + targets.effects.confetti.length
    expect(targets.effects.confetti).toHaveLength(0)
    // прирост юбилейного кадра — только обычный половинный взрыв, и ничего сверх
    expect(after - before).toBeLessThanOrEqual(13)
    // а сама волна на месте
    expect(targets.effects.rings.filter((r) => r.width > 1)).toHaveLength(1)
  })

  it('в дешёвом режиме дорогое остаётся выключенным', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    const rich = createTargets()
    const richCtx = fakeCtx()

    const frame = (cheap) => frameOf([catchOf(1)], { fit: FIT, clockMs: 500, cheap })
    targets.draw(ctx, frame(true))
    rich.draw(richCtx, frame(false))
    targets.clear(1, { points: 200, cheap: true })
    rich.clear(1, { points: 200, cheap: false })

    // взрыв половинный, тряски нет, конфетти нет
    expect(targets.effects.parts.length).toBeLessThan(rich.effects.parts.length)
    expect(targets.effects.shake).toBe(0)
    expect(rich.effects.shake).toBe(1)

    // а дешёвое — на месте: орбита и виньетка рисуются и там и там
    const cheapCalls = ctx.calls
    expect(cheapCalls.filter((c) => c === 'setLineDash').length).toBeGreaterThan(0)
    targets.draw(ctx, frameOf([], { fit: FIT, clockMs: 520, cheap: true }))
    expect(ctx.calls.filter((c) => c === 'createLinearGradient').length).toBe(4)
  })
})
