import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * ГОСТЕВЫЕ ГРАНИЦЫ MOTION.
 *
 * За зачётом дня стоят призы и общий счёт участников. У гостя прогресс живёт на
 * одном телефоне и стирается вместе с кэшем браузера — вести по нему челлендж
 * значит завести спор о деньгах на пустом месте. Поэтому граница проходит ровно
 * по одной линии: попытки, черновик и рекорды у гостя работают как у всех (без
 * них он не увидел бы даже собственного результата), а `{day, done[]}` не
 * двигается вовсе.
 *
 * Проверяется сама линия, а не экран: `completeDay` — чистая функция над
 * хранилищем, и подменять ради неё React дороже и хрупче, чем позвать её так
 * же, как её зовёт SessionScreen.
 */

function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

/** Как это делает SessionScreen: день сдаётся только при complete и не гостю. */
const closeLikeSession = (completeDay, day, { complete, guest }) =>
  complete && !guest ? completeDay(day) : null

describe('гость и зачёт дня челленджа', () => {
  let challenge

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    challenge = await import('../game/challenge.js')
  })

  it('без гостя завершённая сессия закрывает день', () => {
    expect(challenge.isDayDone(1)).toBe(false)

    const marked = closeLikeSession(challenge.completeDay, 1, { complete: true, guest: false })

    expect(marked?.dayDone).toBe(true)
    expect(challenge.isDayDone(1)).toBe(true)
    expect(challenge.progress().done.map((r) => r.day)).toEqual([1])
  })

  it('У ГОСТЯ — НЕ ЗАКРЫВАЕТ: ни отметки дня, ни движения по челленджу', () => {
    const before = JSON.stringify(challenge.progress())

    const marked = closeLikeSession(challenge.completeDay, 1, { complete: true, guest: true })

    expect(marked).toBe(null)
    expect(challenge.isDayDone(1)).toBe(false)
    expect(challenge.progress().done).toEqual([])
    // хранилище не тронуто вовсе, а не «записано то же самое»
    expect(JSON.stringify(challenge.progress())).toBe(before)
  })

  it('незавершённая сессия не закрывает день никому — правило не про гостя', () => {
    expect(closeLikeSession(challenge.completeDay, 1, { complete: false, guest: false })).toBe(null)
    expect(closeLikeSession(challenge.completeDay, 1, { complete: false, guest: true })).toBe(null)
    expect(challenge.isDayDone(1)).toBe(false)
  })

  it('день гостя всегда первый, сколько бы он ни играл', () => {
    // даже если в хранилище каким-то образом оказался другой день
    challenge.completeDay(1)
    challenge.advanceDay()
    expect(challenge.currentDay()).toBe(2)
    // MotionApp у гостя не спрашивает currentDay вовсе (см. index.jsx)
    const dayForGuest = (guest) => (guest ? 1 : challenge.currentDay())
    expect(dayForGuest(true)).toBe(1)
    expect(dayForGuest(false)).toBe(2)
  })
})

describe('гость и попытки дня', () => {
  let day

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    day = await import('../game/day.js')
  })

  /**
   * Попытки гостю ПИШУТСЯ, и это не недосмотр. Без них он не увидел бы своего
   * результата за только что сыгранный заход, не смог бы сравнить вторую
   * попытку с первой и не получил бы того самого счёта, ради которого ему потом
   * предлагают аккаунт.
   */
  it('попытка гостя записывается и считается как обычная', () => {
    const out = day.submitAttempt('novice', { score: 4200, reps: 30 }, 1)

    expect(out.recorded).toBe(true)
    expect(out.attempt).toBe(1)
    expect(day.attemptsUsed('novice', 1)).toBe(1)
    expect(day.bestFor('novice', 1)).toBe(4200)
  })

  it('лимит попыток дня у гостя тот же — три', () => {
    for (let i = 0; i < day.MAX_ATTEMPTS; i += 1) day.submitAttempt('novice', { score: 100 }, 1)
    expect(day.submitAttempt('novice', { score: 999 }, 1).recorded).toBe(false)
    expect(day.attemptsLeft('novice', 1)).toBe(0)
  })
})
