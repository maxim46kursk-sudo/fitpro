import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * ГЛАВНОЕ ЗДЕСЬ — ЦЕНА ПРИ ВЫКЛЮЧЕННОЙ ОТЛАДКЕ.
 *
 * Публикация мишеней стоит в горячем цикле боя, который крутится каждый кадр
 * на телефоне человека. Обещание было жёстким: при выключенном `?motion-debug`
 * в цикле не делается НИЧЕГО — ни выделений, ни копий, ни даже чтения полей
 * мишени. Обещание в комментарии не стоит ничего, поэтому оно проверяется.
 *
 * Проверяется через Proxy, который считает КАЖДОЕ обращение к списку: чтение
 * `length`, перебор итератором, доступ к любому индексу и к любому полю
 * мишени. Ноль обращений — значит функция вышла до того, как тронула аргумент,
 * и никакой работы в цикле не появилось.
 *
 * Флаг читается один раз при загрузке модуля, поэтому каждый заход тестa
 * подменяет адрес и импортирует модуль заново через vi.resetModules().
 */

/** Список, который жалуется на любое прикосновение. */
function spyList(items) {
  const touches = []
  const inner = items.map((o, i) =>
    new Proxy(o, {
      get(t, k) {
        touches.push(`target${i}.${String(k)}`)
        return Reflect.get(t, k)
      },
    }),
  )
  const proxy = new Proxy(inner, {
    get(t, k) {
      touches.push(String(k))
      return Reflect.get(t, k)
    },
  })
  return { proxy, touches }
}

const TARGET = {
  id: 7,
  type: 'catch',
  part: 'palm',
  side: 'left',
  spot: { x: 0.3, y: 0.4, rx: 0.08, ry: 0.08 },
  spawnAt: 1000,
  passAt: 3000,
  practice: false,
}

async function load(search) {
  vi.resetModules()
  vi.stubGlobal('location', { search, hash: '' })
  return import('./liveTargets.js')
}

describe('публикация летящих мишеней', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('без ?motion-debug выключена', async () => {
    const m = await load('')
    expect(m.TARGETS_LIVE).toBe(false)
  })

  it('?motion-debug=0 выключает явно', async () => {
    const m = await load('?motion-debug=0')
    expect(m.TARGETS_LIVE).toBe(false)
  })

  it('?motion-debug включает', async () => {
    const m = await load('?motion-debug=1')
    expect(m.TARGETS_LIVE).toBe(true)
  })

  it('ВЫКЛЮЧЕННАЯ не трогает список вообще: ни длины, ни перебора, ни полей', async () => {
    const m = await load('')
    const { proxy, touches } = spyList([TARGET, TARGET])

    for (let frame = 0; frame < 100; frame += 1) m.publishTargets(frame * 16, 'catch', proxy)

    expect(touches).toEqual([])
  })

  it('ВЫКЛЮЧЕННАЯ отдаёт один и тот же пустой снимок — нового объекта на кадр нет', async () => {
    const m = await load('')
    const before = m.readTargets()

    for (let frame = 0; frame < 100; frame += 1) m.publishTargets(frame * 16, 'catch', [TARGET])

    // именно тождество, а не равенство: новый объект на каждом кадре — это и
    // есть то выделение, которого быть не должно
    expect(m.readTargets()).toBe(before)
    expect(m.readTargets().targets).toHaveLength(0)
  })

  it('ВКЛЮЧЁННАЯ список читает — иначе проверка выше ничего не значила бы', async () => {
    const m = await load('?motion-debug=1')
    const { proxy, touches } = spyList([TARGET])

    m.publishTargets(1234, 'catch', proxy)

    expect(touches.length).toBeGreaterThan(0)
  })

  it('ВКЛЮЧЁННАЯ отдаёт копию, а не живой объект движка', async () => {
    const m = await load('?motion-debug=1')
    const live = { ...TARGET, spot: { ...TARGET.spot } }

    m.publishTargets(1234, 'catch', [live])
    const out = m.readTargets()

    expect(out.clockMs).toBe(1234)
    expect(out.mode).toBe('catch')
    expect(out.targets).toHaveLength(1)
    expect(out.targets[0]).not.toBe(live)
    expect(out.targets[0].spot).not.toBe(live.spot)
    expect(out.targets[0]).toMatchObject({ id: 7, part: 'palm', side: 'left', passAt: 3000 })
    expect(out.targets[0].spot).toEqual({ x: 0.3, y: 0.4, rx: 0.08, ry: 0.08 })

    // подвинули копию — движок этого не увидел
    out.targets[0].spot.x = 0.9
    expect(live.spot.x).toBe(0.3)
  })

  it('движения без ловца: части тела и места нет, и это не ошибка', async () => {
    const m = await load('?motion-debug=1')
    m.publishTargets(10, 'moves', [{ id: 1, type: 'strike', side: 'right', spawnAt: 0, passAt: 900 }])

    expect(m.readTargets().targets[0]).toMatchObject({ type: 'strike', part: null, spot: null })
  })

  it('сброс при закрытии раздела забывает мишени прошлого боя', async () => {
    const m = await load('?motion-debug=1')
    m.publishTargets(10, 'catch', [TARGET])
    expect(m.readTargets().targets).toHaveLength(1)

    m.resetLiveTargets()
    expect(m.readTargets().targets).toHaveLength(0)
    expect(m.readTargets().clockMs).toBe(0)
  })
})
