import { describe, expect, it } from 'vitest'
import { PLATE_TYPES, createStarfield, drawScene, plateArrow } from './space.js'

/**
 * Отрисовка падала молча, и это стоило целого полевого теста: у кольца
 * локальная переменная затеняла функцию мягкой тени, а подписи не получали
 * параметра экономного режима. Исключение внутри кадра съедало не только своё
 * препятствие, но и всё, что рисовалось после, — на телефоне это выглядело как
 * «фигуры нет, только слова».
 *
 * Здесь canvas подменяется счётчиком вызовов: важно не как нарисовано, а что
 * каждый тип вообще доходит до холста и ничего не бросает.
 *
 * ВТОРОЙ ХОЛСТ подделка тоже умеет отдавать. Он нужен был стене с вырезом, а
 * стену с поля сняли — и теперь этим же холстом проверяется обратное: что
 * оффскрин больше НЕ создаётся, то есть стены и правда не рисуются.
 */
function fakeCtx(ownerDocument = null) {
  const calls = []
  const sets = []
  const gradient = { addColorStop: () => {} }
  // размер холста вдвое больше кадра: так на телефоне и есть (dpr = 2)
  const canvas = { width: 800, height: 1600, ownerDocument }
  return new Proxy(
    { calls, sets, canvas },
    {
      get(target, key) {
        if (key === 'calls') return calls
        if (key === 'sets') return sets
        if (key === 'canvas') return canvas
        if (key === 'createRadialGradient' || key === 'createLinearGradient') {
          return () => gradient
        }
        return (...args) => {
          calls.push(key)
          return args[0]
        }
      },
      set(target, key, value) {
        sets.push([key, value])
        return true
      },
    },
  )
}

/** Документ, выдающий холсты, и память обо всех выданных. */
function fakeDoc() {
  const surfaces = []
  const doc = {
    surfaces,
    createElement: () => {
      const ctx = fakeCtx(doc)
      surfaces.push(ctx)
      return { width: 0, height: 0, ownerDocument: doc, getContext: () => ctx }
    },
  }
  return doc
}

const scene = (obstacles, extra = {}) => ({
  width: 400,
  height: 800,
  clockMs: 1000,
  stars: createStarfield(),
  obstacles,
  particles: [],
  ...extra,
})

const obstacleOf = (type, over = {}) => ({
  type,
  id: 1,
  side: 'left',
  spawnAt: 0,
  travelMs: 2000,
  status: 'incoming',
  progress: 0.3,
  ...over,
})

/**
 * Все типы препятствий до одного. Список умышленно полный: страж и существует
 * затем, чтобы новый тип не оказался невидимым, — а невидимая цель в этом
 * проекте уже была, человек бил в пустоту.
 */
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
  // девять новых движений
  ...PLATE_TYPES,
]

/** Тёмная краска стрелки: по ней в вызовах и видно, что стрелка нарисована. */
const ARROW_INK = 'rgba(8, 12, 24, 0.92)'
const inked = (ctx) => ctx.sets.some(([key, value]) => key === 'fillStyle' && value === ARROW_INK)

describe('отрисовка игрового слоя', () => {
  for (const type of TYPES) {
    it(`${type} доходит до холста и ничего не бросает`, () => {
      const ctx = fakeCtx(fakeDoc())
      expect(() => drawScene(ctx, scene([obstacleOf(type)]))).not.toThrow()
      expect(ctx.calls.length).toBeGreaterThan(10)
    })

    it(`${type} рисуется и в экономном режиме`, () => {
      const ctx = fakeCtx(fakeDoc())
      expect(() => drawScene(ctx, scene([obstacleOf(type)], { cheap: true }))).not.toThrow()
      expect(ctx.calls.length).toBeGreaterThan(5)
    })
  }

  it('все типы в одном кадре — каждый рисуется', () => {
    const ctx = fakeCtx(fakeDoc())
    const obstacles = TYPES.map((type, i) => obstacleOf(type, { spawnAt: i * 100 }))

    expect(() => drawScene(ctx, scene(obstacles))).not.toThrow()
    // если бы один тип падал, кадр обрывался бы на нём и вызовов было бы меньше
    const single = fakeCtx(fakeDoc())
    drawScene(single, scene([obstacleOf('barrier')]))
    expect(ctx.calls.length).toBeGreaterThan(single.calls.length)
  })

  it('движение без стороны рисуется так же, как парное', () => {
    // шесть из девяти новых движений идут во всю ширину, и side у них null:
    // умножение на «сторону» дало бы NaN в координате, а NaN в canvas — это
    // молча не нарисованная фигура
    const ctx = fakeCtx(fakeDoc())
    expect(() => drawScene(ctx, scene([obstacleOf('bend', { side: null })]))).not.toThrow()
    expect(ctx.calls.length).toBeGreaterThan(10)
  })

  it('зачтённое препятствие и частицы тоже не роняют кадр', () => {
    const ctx = fakeCtx(fakeDoc())
    const done = obstacleOf('knee', { status: 'cleared', progress: 1, judgedAt: 900 })

    // числа «+очки» этот слой больше не рисует: они живут в targets.js
    expect(() =>
      drawScene(ctx, scene([done], { particles: [{ x: 1, y: 2, life: 300, maxLife: 600 }] })),
    ).not.toThrow()
  })
})

/**
 * ЕДИНАЯ ПЛИТА. Два прежних подхода поле забраковало: восемнадцать своих фигур
 * человек не выучивал, а стена с вырезом требовала совпасть ТЕЛОМ, хотя
 * засчитывается движение. Теперь смысл несут стрелка, цвет зоны и подпись —
 * и проверять надо ровно это.
 */
describe('единая плита', () => {
  const paint = (obstacle, extra = {}) => {
    const doc = fakeDoc()
    const ctx = fakeCtx(doc)
    drawScene(ctx, scene([obstacle], extra))
    return { ctx, doc }
  }

  it('стены с вырезом больше нет: второй холст не создаётся вовсе', () => {
    const { ctx, doc } = paint(obstacleOf('barrier'))

    expect(doc.surfaces).toHaveLength(0)
    expect(ctx.calls).not.toContain('drawImage')
  })

  for (const type of TYPES) {
    it(`${type}: плита нарисована и на ней стрелка`, () => {
      const { ctx } = paint(obstacleOf(type))
      // тело плиты — заливка со скошенными углами, поверх неё тёмная стрелка
      expect(ctx.calls).toContain('fill')
      expect(inked(ctx)).toBe(true)
    })
  }

  /**
   * Стрелка на каждый тип своя, и таблица здесь повторена НАРОЧНО: это
   * договор с человеком, а не деталь реализации. Забытый тип означает не
   * поломку, а молча не ту подсказку — такое не ловится ничем, кроме списка.
   */
  const EXPECTED = {
    barrier: 'down',
    bend: 'down',
    jumpsquat: 'downUp',
    pit: 'downUp',
    knee: 'up',
    bird: 'up',
    clap: 'up',
    wall: 'side',
    // своей стрелки наклону вбок в грамматике не досталось — берёт боковую,
    // а от стены его отличают цвет корпуса и подпись
    beam: 'side',
    strike: 'side',
    legside: 'side',
    sidelunge: 'side',
    hop: 'bothSides',
    wings: 'bothSides',
    jack: 'bothSides',
    lunge: 'back',
    heel: 'back',
    twistknee: 'cross',
  }

  it('у всех восемнадцати типов стрелка назначена, и та самая', () => {
    for (const type of TYPES) {
      expect({ тип: type, стрелка: plateArrow(type, 'left').kind }).toEqual({
        тип: type,
        стрелка: EXPECTED[type],
      })
    }
  })

  it('боковая стрелка смотрит в сторону работающей руки или ноги', () => {
    // человек видит себя зеркально: его левая сторона — слева на экране
    expect(plateArrow('strike', 'left').dir).toBe(-1)
    expect(plateArrow('strike', 'right').dir).toBe(1)
    expect(plateArrow('legside', 'left').dir).toBe(-1)
    expect(plateArrow('sidelunge', 'right').dir).toBe(1)
  })

  it('у стены и балки стрелка смотрит НАОБОРОТ: от препятствия, а не на него', () => {
    // сторона у них говорит, где препятствие, а уходить надо в свободную —
    // подписи ровно об этом: «слева стена» значит «шагни вправо»
    expect(plateArrow('wall', 'left').dir).toBe(1)
    expect(plateArrow('wall', 'right').dir).toBe(-1)
    expect(plateArrow('beam', 'left').dir).toBe(1)
    expect(plateArrow('beam', 'right').dir).toBe(-1)
  })
})

/**
 * КОЛЬЦО-ПРИЁМНИК — единственный ответ на вопрос «когда». Без него момент
 * «пора» приходится угадывать по размеру плиты.
 */
describe('кольцо-приёмник', () => {
  const ringOf = (obstacles, extra = {}) => {
    const ctx = fakeCtx(fakeDoc())
    drawScene(ctx, scene(obstacles, extra))
    return ctx
  }

  it('рисуется всегда, даже когда лететь нечему', () => {
    const ctx = ringOf([])
    expect(ctx.calls).toContain('ellipse')
  })

  /**
   * Зачтённая плита и сама зеленеет, поэтому судить о кольце по цвету во всём
   * кадре нельзя. Берём момент, когда плита уже ушла из кадра (alpha 0), а
   * зачёт только что случился: рисуется одно кольцо, и спорить не с чем.
   */
  const goneButJustCleared = (judgedAt) =>
    obstacleOf('knee', { spawnAt: 0, travelMs: 500, status: 'cleared', judgedAt })

  it('на зачёте вспыхивает зелёным и даёт вторую волну', () => {
    const quiet = ringOf([obstacleOf('knee')])
    const clear = ringOf([goneButJustCleared(950)])

    const green = clear.sets.some(
      ([key, value]) => key === 'strokeStyle' && String(value).startsWith('hsla(145'),
    )
    expect(green).toBe(true)
    // вторая волна — ещё один эллипс сверх обычного кольца
    expect(clear.calls.filter((c) => c === 'ellipse').length).toBeGreaterThan(
      quiet.calls.filter((c) => c === 'ellipse').length,
    )
  })

  it('вспышка гаснет: зачёт секундной давности кольцо уже не красит', () => {
    const stale = ringOf([goneButJustCleared(0)])
    const green = stale.sets.some(
      ([key, value]) => key === 'strokeStyle' && String(value).startsWith('hsla(145'),
    )

    expect(green).toBe(false)
    // и второй волны тоже нет: кольцо снова одно
    expect(stale.calls.filter((c) => c === 'ellipse')).toHaveLength(1)
  })

  it('в экономном режиме кольцо без свечения', () => {
    const ctx = ringOf([obstacleOf('pit')], { cheap: true })
    const blurs = ctx.sets.filter(([key]) => key === 'shadowBlur').map(([, v]) => v)

    expect(blurs.length).toBeGreaterThan(0)
    expect(blurs.every((v) => v === 0)).toBe(true)
  })
})
