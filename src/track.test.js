import { describe, it, expect } from 'vitest'
import { createTracker, sanitizeProps, isKnownEvent, setAuth, EVENT_NAMES, MAX_STR, MAX_BATCH } from './track.js'

// Фейки вместо браузера: память — обычные объекты, отправка — массив, время и
// таймеры — под нашим контролем. Модуль про поведение людей, а не про сеть,
// поэтому и проверяется без сети.
function harness(t0 = Date.parse('2026-08-29T10:00:00Z')) {
  const sent = []
  const mem = new Map(), ses = new Map()
  const timers = []
  let now = t0
  const tr = createTracker({
    post: b => sent.push(b),
    store: { get: k => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) },
    sess: { get: k => ses.get(k) ?? null, set: (k, v) => ses.set(k, v) },
    now: () => now,
    schedule: fn => { timers.push(fn); return () => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1) } },
  })
  return {
    tr, sent, mem, ses,
    tick: () => { const fns = timers.splice(0); fns.forEach(f => f()) },
    advanceDay: () => { now += 24 * 3600 * 1000 },
    all: () => sent.flatMap(b => b.events),
  }
}

describe('журнал событий: что вообще принимаем', () => {
  it('незнакомое имя не пишется', () => {
    const h = harness()
    expect(h.tr.track('program_open', { key: 'massa' })).toBe(true)
    expect(h.tr.track('нажал_кнопку')).toBe(false)
    expect(h.tr.track('drop_database')).toBe(false)
    expect(h.tr.pending()).toBe(1)
  })

  it('в списке событий нет повторов и все имена машинные', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length)
    for (const n of EVENT_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]{1,29}$/)
  })
})

describe('журнал событий: барьер на личные данные', () => {
  it('свободный текст обрезается', () => {
    const long = 'сегодня ел овсянку с бананом и думал про бывшую, это очень длинная строка'
    const out = sanitizeProps({ what: long })
    expect(out.what.length).toBe(MAX_STR)
  })

  it('пропускаются только короткие скаляры', () => {
    const out = sanitizeProps({
      key: 'massa-novichok', slot: 3, ok: true,
      nested: { a: 1 }, arr: [1, 2], fn: () => {}, empty: '', nul: null,
      'Плохой Ключ': 'x', UPPER: 'x',
    })
    expect(out).toEqual({ key: 'massa-novichok', slot: 3, ok: true })
  })

  it('больше восьми свойств не берём', () => {
    const many = {}
    for (let i = 0; i < 20; i++) many['k' + i] = i
    expect(Object.keys(sanitizeProps(many)).length).toBe(8)
  })

  it('пустые свойства дают null, а не пустой объект', () => {
    expect(sanitizeProps({})).toBe(null)
    expect(sanitizeProps(null)).toBe(null)
    expect(sanitizeProps('строка')).toBe(null)
    expect(sanitizeProps([1, 2])).toBe(null)
  })
})

describe('журнал событий: отправка', () => {
  it('копит и отправляет пачкой по таймеру, а не по одному', () => {
    const h = harness()
    h.tr.track('screen', { name: 'programs' })
    h.tr.track('programs_open')
    h.tr.track('program_open', { key: 'massa' })
    expect(h.sent.length).toBe(0)
    h.tick()
    expect(h.sent.length).toBe(1)
    expect(h.sent[0].events.length).toBe(3)
  })

  it('пачка уходит сама, когда набралась', () => {
    const h = harness()
    for (let i = 0; i < MAX_BATCH; i++) h.tr.track('screen', { name: 's' + i })
    expect(h.sent.length).toBe(1)
    expect(h.tr.pending()).toBe(0)
  })

  it('flush на пустой очереди ничего не шлёт', () => {
    const h = harness()
    h.tr.flush()
    expect(h.sent.length).toBe(0)
  })

  it('у всех событий одной вкладки один номер сессии', () => {
    const h = harness()
    h.tr.track('app_open')
    h.tr.track('programs_open')
    h.tick()
    const [a, b] = h.all()
    expect(a.sess).toBe(b.sess)
    expect(a.anon).toBe(b.anon)
    expect(a.anon).toBeTruthy()
  })
})

describe('журнал событий: заход считаем раз в сутки', () => {
  it('второй app_open за те же сутки не пишется', () => {
    const h = harness()
    expect(h.tr.track('app_open')).toBe(true)
    expect(h.tr.track('app_open')).toBe(false)
    expect(h.tr.track('app_open')).toBe(false)
    h.tick()
    expect(h.all().filter(e => e.name === 'app_open').length).toBe(1)
  })

  it('на следующие сутки считается снова', () => {
    const h = harness()
    h.tr.track('app_open')
    h.advanceDay()
    expect(h.tr.track('app_open')).toBe(true)
  })

  it('а нажатия считаются каждое', () => {
    const h = harness()
    h.tr.track('plan_click', { plan: 'profit' })
    h.tr.track('plan_click', { plan: 'premium' })
    h.tick()
    expect(h.all().filter(e => e.name === 'plan_click').length).toBe(2)
  })
})

describe('журнал событий: форма записи', () => {
  it('экран пишется и режется по длине', () => {
    const h = harness()
    h.tr.track('screen', { name: 'programs' }, 'x'.repeat(200))
    h.tick()
    expect(h.all()[0].path.length).toBe(60)
  })

  it('без экрана пишется null, а не мусор', () => {
    const h = harness()
    h.tr.track('app_open')
    h.tick()
    expect(h.all()[0].path).toBe(null)
    expect(h.all()[0].ts).toMatch(/^2026-08-29T/)
  })

  it('известность имени проверяется отдельной функцией', () => {
    expect(isKnownEvent('workout_finish')).toBe(true)
    expect(isKnownEvent('workout_finished')).toBe(false)
  })
})

describe('журнал событий: личность через заголовок, а не куку', () => {
  it('setAuth принимает функцию и молча игнорирует мусор', () => {
    expect(() => setAuth(() => 'tok')).not.toThrow()
    expect(() => setAuth('строка')).not.toThrow()
    expect(() => setAuth(null)).not.toThrow()
  })

  it('падение геттера токена не роняет отправку', () => {
    const h = harness()
    setAuth(() => { throw new Error('сессия протухла') })
    expect(() => { h.tr.track('app_open'); h.tick() }).not.toThrow()
    expect(h.all().length).toBe(1)
    setAuth(null)
  })

  it('в самом событии токена нет — личность ставит сервер', () => {
    const h = harness()
    h.tr.track('workout_start', { key: 'massa', slot: 1 })
    h.tick()
    const e = h.all()[0]
    expect(Object.keys(e)).toEqual(['name', 'ts', 'anon', 'sess', 'path', 'props'])
    expect(JSON.stringify(e)).not.toMatch(/token|Bearer|authorization/i)
  })
})
