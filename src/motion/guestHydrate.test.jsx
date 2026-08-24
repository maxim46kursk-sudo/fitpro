// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * РАЗДЕЛ ОБЯЗАН ОТКРЫТЬСЯ. ВСЕГДА.
 *
 * Полевой отказ: человек играл гостем, зарегистрировался — и Motion навсегда
 * повис на «Загружаю прогресс…». Причина структурная, а не в одной строке: у
 * цепочки `hydrate().then(...)` не было `catch`, и ЛЮБОЙ выброс внутри неё
 * оставлял `setReady` непозванным. Заставка при этом вечная: выйти из раздела
 * с неё нечем.
 *
 * Поэтому проверяется не «конкретная ошибка больше не случается», а правило:
 * что бы ни упало по дороге — загрузка прогресса, применение гостевого буфера,
 * — раздел открывается. Данные при этом не выбрасываются: буфер остаётся на
 * месте, разберёмся по журналу.
 */

const SPLASH = /Загружаю прогресс/i

/** Буфер ровно той формы, что пишет guestPending.js. */
const guestMotionPayload = () => ({
  day: 1,
  tiers: {
    novice: [{ score: 3200, reps: 24, hits: 40, spawned: 60, reactMs: 780, at: '2026-08-24T10:00:00.000Z' }],
    pro: [{ score: 5100, reps: 30, hits: 55, spawned: 70, reactMs: 690, at: '2026-08-24T10:30:00.000Z' }],
  },
})

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

/**
 * Внутренность раздела не монтируем: она тянет камеру, воркер и MediaPipe, а
 * проверяется здесь ровно заставка и то, что она уходит.
 */
vi.mock('./index.jsx', async (orig) => orig())

const hydrateMock = vi.fn()
vi.mock('./sync.js', () => ({
  configureSync: () => () => {},
  hydrate: (...a) => hydrateMock(...a),
  startSync: () => {},
  stopSync: () => Promise.resolve(),
  resetSync: () => {},
  // здоровье обмена: раздел спрашивает его, чтобы честно сказать человеку,
  // что играет он по кэшу устройства
  syncHealth: () => ({ loaded: true, pushFailed: false }),
  onSyncHealth: () => () => {},
  noteLoadFailed: () => {},
  push: () => Promise.resolve(),
}))

const logged = []
vi.mock('./debug/logShipper.js', async (orig) => {
  const real = await orig()
  return {
    ...real,
    logEvent: (tag, data) => { logged.push({ tag, data }); return real.logEvent(tag, data) },
  }
})

let MotionApp
let day
let challenge

beforeEach(async () => {
  vi.resetModules()
  logged.length = 0
  hydrateMock.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('localStorage', makeStorage())
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;({ default: MotionApp } = await import('./index.jsx'))
  day = await import('./game/day.js')
  challenge = await import('./game/challenge.js')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sync = { userId: 'u1', load: async () => ({}), saveProgress: async () => {}, saveAttempts: async () => {} }

/** Дать промису hydrate прокрутиться. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe('загрузка прогресса при входе', () => {
  it('нормальный буфер: попытки дня 1 в чистом аккаунте, буфер отдан', async () => {
    const applied = vi.fn()
    render(<MotionApp sync={sync} guestMotion={guestMotionPayload()} onGuestMotionApplied={applied} />)
    await settle()

    expect(day.attemptsUsed('novice', 1)).toBe(1)
    expect(day.attemptsUsed('pro', 1)).toBe(1)
    expect(day.bestFor('pro', 1)).toBe(5100)
    // день челленджа переносом НЕ сдаётся
    expect(challenge.isDayDone(1)).toBe(false)
    expect(applied).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(SPLASH)).toBeNull()
  })

  it('ЗАГРУЗКА УПАЛА — раздел всё равно открывается', async () => {
    hydrateMock.mockRejectedValue(new Error('сети нет'))

    render(<MotionApp sync={sync} />)
    await settle()

    expect(screen.queryByText(SPLASH)).toBeNull()
    expect(logged.some((e) => e.tag === 'sync.hydrate-failed')).toBe(true)
  })

  it('ПРИМЕНЕНИЕ БУФЕРА УПАЛО — раздел открывается, буфер цел', async () => {
    const applied = vi.fn()
    /**
     * Ронять применение НАРОЧНО, а не подбирать «плохие данные». Проверяется
     * правило «что бы тут ни упало, раздел открывается», а не устойчивость к
     * одной конкретной форме мусора: мусор в буфере может быть любым, и
     * перечислять его виды в тесте — гнаться за тем, что уже не важно.
     */
    const битый = { day: 1, get tiers() { throw new Error('битый буфер') } }

    render(<MotionApp sync={sync} guestMotion={битый} onGuestMotionApplied={applied} />)
    await settle()

    expect(screen.queryByText(SPLASH)).toBeNull()
    // буфер НЕ отдан: данные человека не выбрасываем, разберёмся по журналу
    expect(applied).not.toHaveBeenCalled()
    expect(logged.some((e) => e.tag === 'sync.guest-apply-failed')).toBe(true)
  })

  /**
   * Единственная форма, на которой слияние спотыкалось по-настоящему: `days` не
   * карта массивов. Такое приезжает из `motion_progress.payload` — свободного
   * jsonb, который писали прошлые версии. Испорченный однажды, он приходил бы
   * КАЖДЫЙ вход, и раздел не открывался бы больше никогда.
   */
  it('битый прогресс с сервера не запирает раздел', async () => {
    const sync2 = {
      ...sync,
      load: async () => ({ progress: { challenge: { day: 1, done: [] }, attempts: { days: 'ой' } }, attempts: [] }),
    }
    // именно importActual: `./sync.js` в этом файле замокан, и обычный импорт
    // вернул бы ту же заглушку — hydrate позвал бы сам себя
    const real = await vi.importActual('./sync.js')
    // здесь нужен НАСТОЯЩИЙ hydrate: проверяется его устойчивость
    hydrateMock.mockImplementation((id) => {
      real.configureSync(sync2)
      return real.hydrate(id)
    })

    render(<MotionApp sync={sync2} />)
    await settle()

    expect(screen.queryByText(SPLASH)).toBeNull()
  })

  it('буфера нет вовсе — обычный вход, заставка уходит', async () => {
    render(<MotionApp sync={sync} />)
    await settle()
    expect(screen.queryByText(SPLASH)).toBeNull()
  })

  it('без sync заставки не бывает: прогресс живёт на устройстве', () => {
    render(<MotionApp />)
    expect(screen.queryByText(SPLASH)).toBeNull()
  })
})
