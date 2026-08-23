import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ПОПЫТКИ ГОСТЯ ПЕРЕЕЗЖАЮТ В АККАУНТ.
 *
 * Плашка на итоговом экране Motion говорит «Сохранить и участвовать в
 * челлендже?» — значит при регистрации результат обязан доехать, иначе это
 * враньё в самом чувствительном месте: за челленджем стоят призы.
 *
 * Здесь проверяется само правило слияния — то, что делает `MotionApp` после
 * загрузки прогресса. Правило чистое (хранилище плюс `submitAttempt`), и гонять
 * ради него React дороже и хрупче, чем позвать его так же, как зовёт раздел.
 */

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

/** Буфер гостя: две попытки дня 1 на разных уровнях. */
const buffered = () => ({
  day: 1,
  tiers: {
    novice: [{ score: 3200, reps: 24, hits: 40, spawned: 60, reactMs: 780, at: '2026-08-24T10:00:00.000Z' }],
    pro: [{ score: 5100, reps: 30, hits: 55, spawned: 70, reactMs: 690, at: '2026-08-24T10:30:00.000Z' }],
  },
})

describe('слияние попыток гостя с прогрессом аккаунта', () => {
  let day
  let challenge
  /** Ровно то, что делает MotionApp после hydrate. */
  let applied

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    day = await import('./day.js')
    challenge = await import('./challenge.js')

    applied = (payload) => {
      const пусто = day.challengeTotal() === 0 && challenge.progress().done.length === 0
      if (пусто) {
        for (const [tierId, list] of Object.entries(payload.tiers ?? {})) {
          for (const attempt of list) day.submitAttempt(tierId, attempt, payload.day ?? 1)
        }
      }
      return пусто
    }
  })

  it('в ЧИСТЫЙ аккаунт попытки переносятся как обычные, со всеми числами', () => {
    expect(applied(buffered())).toBe(true)

    expect(day.attemptsUsed('novice', 1)).toBe(1)
    expect(day.attemptsUsed('pro', 1)).toBe(1)
    expect(day.bestFor('pro', 1)).toBe(5100)
    // итог дня — сумма лучших по уровням, как у всех
    expect(day.dayTotal(1)).toBe(3200 + 5100)

    const проPro = day.attemptsFor(1).tiers.pro[0]
    expect(проPro).toMatchObject({ score: 5100, reps: 30, hits: 55, spawned: 70, reactMs: 690 })
  })

  /**
   * Человек входит в СТАРЫЙ аккаунт: он уже прошёл сколько-то дней, и его
   * челлендж — предмет спора о призах. Добавить туда попытки, сыгранные до
   * входа неизвестно кем на этом телефоне, нельзя ни при каких обстоятельствах.
   */
  it('в аккаунт С ПРОГРЕССОМ не подмешиваются вовсе', () => {
    day.submitAttempt('pro', { score: 9000, hits: 80, spawned: 90, reactMs: 600 }, 1)
    const былоДо = JSON.stringify(day.attemptsFor(1))

    expect(applied(buffered())).toBe(false)

    expect(day.attemptsUsed('pro', 1)).toBe(1)
    expect(day.attemptsUsed('novice', 1)).toBe(0)
    expect(day.bestFor('pro', 1)).toBe(9000)
    expect(JSON.stringify(day.attemptsFor(1))).toBe(былоДо)
  })

  it('сданный день тоже считается прогрессом, даже без попыток', () => {
    challenge.completeDay(1)

    expect(applied(buffered())).toBe(false)
    expect(day.attemptsUsed('pro', 1)).toBe(0)
  })

  /** День сдаётся только пройденной целиком сессией — перенос этого не меняет. */
  it('перенос НЕ засчитывает день челленджа', () => {
    applied(buffered())

    expect(challenge.isDayDone(1)).toBe(false)
    expect(challenge.progress().done).toEqual([])
    expect(challenge.currentDay()).toBe(1)
  })

  it('лимит трёх попыток соблюдается и при переносе', () => {
    const много = {
      day: 1,
      tiers: { pro: [{ score: 100 }, { score: 200 }, { score: 300 }, { score: 400 }] },
    }
    applied(много)

    expect(day.attemptsUsed('pro', 1)).toBe(day.MAX_ATTEMPTS)
    // четвёртая не записалась — правило трёх попыток не обходится переносом
    expect(day.bestFor('pro', 1)).toBe(300)
  })
})

describe('буфер переезда: часть Motion', () => {
  let pending

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    pending = await import('../../guestPending.js')
  })

  it('попытки кладутся и читаются', () => {
    expect(pending.saveGuestPending({ workouts: [], food: {}, custom: [], motion: buffered() })).toBe(true)

    const m = pending.guestPendingMotion()
    expect(m.day).toBe(1)
    expect(m.tiers.pro[0].score).toBe(5100)
  })

  it('после переноса забираются, а ключ исчезает вместе с последней частью', () => {
    pending.saveGuestPending({ workouts: [], food: {}, custom: [], motion: buffered() })

    pending.dropGuestPendingMotion()

    expect(pending.guestPendingMotion()).toBe(null)
    // больше в буфере ничего не было — ключу незачем лежать на устройстве
    expect(localStorage.getItem('fitpro_guest_pending')).toBe(null)
  })

  it('чужие части буфера перенос Motion не трогает', () => {
    pending.saveGuestPending({
      workouts: [{ name: 'Тренировка' }],
      food: {},
      custom: [{ n: 'Своё' }],
      motion: buffered(),
    })

    pending.dropGuestPendingMotion()

    expect(pending.guestPendingMotion()).toBe(null)
    expect(pending.guestPendingWorkouts()).toHaveLength(1)
    expect(pending.guestPendingCustom()).toHaveLength(1)
  })

  it('пустые попытки в буфер не кладутся', () => {
    expect(pending.guestPendingMotion()).toBe(null)
    pending.saveGuestPending({ workouts: [], food: {}, custom: [], motion: { day: 1, tiers: { pro: [] } } })
    expect(localStorage.getItem('fitpro_guest_pending')).toBe(null)
  })
})
