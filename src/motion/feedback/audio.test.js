// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Лог подменён: проверяется, ЧТО модуль о себе рассказывает, а не отправка. */
vi.mock('../debug/logShipper.js', () => ({ logEvent: vi.fn() }))

/**
 * Речи в модуле нет: Web Speech на целевом устройстве принимал фразы и молча
 * выбрасывал (лог с телефона — «попыток 43, озвучено 0, ошибок 0»).
 * Поэтому проверяем именно звуковой словарь.
 */

describe('звуковые сигналы', () => {
  let tones
  let state

  beforeEach(() => {
    vi.resetModules()
    tones = []
    state = 'running'

    class FakeParam {
      setValueAtTime(v) {
        this.value = v
        return this
      }
      linearRampToValueAtTime() {
        return this
      }
    }

    globalThis.AudioContext = class {
      constructor() {
        this.currentTime = 0
        this.destination = {}
      }
      get state() {
        return state
      }
      resume() {
        state = 'running'
        return Promise.resolve()
      }
      createOscillator() {
        const osc = {
          frequency: new FakeParam(),
          connect: () => ({ connect: () => {} }),
          start: (at) => {
            tones.push({ freq: osc.frequency.value, at })
          },
          stop: () => {},
        }
        return osc
      }
      createGain() {
        return { gain: new FakeParam(), connect: () => ({ connect: () => {} }) }
      }
    }
  })

  afterEach(() => {
    delete globalThis.AudioContext
    localStorage.clear()
  })

  it('повтор, неглубокий присед и акцент звучат разными тонами', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)

    audio.cueRep()
    expect(tones.map((t) => t.freq)).toEqual([800])

    tones.length = 0
    audio.cueShallow()
    expect(tones.map((t) => t.freq)).toEqual([300])

    tones.length = 0
    audio.cueMilestone()
    expect(tones.length).toBe(2)
    expect(tones[0].freq).toBeLessThan(tones[1].freq)
  })

  it('тик отсчёта — один тон, и ниже акцента последних секунд', async () => {
    /**
     * Стартовый отсчёт сессии длинный (десять секунд): отбей все десять
     * акцентом — и «пора» перестало бы значить «пора». Тик держит ритм, акцент
     * зовёт, и спутать их нельзя.
     */
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)

    audio.cueTick()
    expect(tones).toHaveLength(1)
    const tick = tones[0].freq

    tones.length = 0
    audio.cueCountdown(3)
    expect(tones[0].freq).toBeGreaterThan(tick)
  })

  it('отсчёт повышается к старту', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)

    for (const n of [5, 4, 3, 2, 1]) audio.cueCountdown(n)
    const freqs = tones.map((t) => t.freq)

    expect(freqs).toHaveLength(5)
    for (let i = 1; i < freqs.length; i += 1) {
      expect(freqs[i]).toBeGreaterThan(freqs[i - 1])
    }
  })

  it('старт восходящий, конец подхода нисходящий — их не спутать', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)

    audio.cueStart()
    const start = tones.map((t) => t.freq)
    expect(start).toEqual([...start].sort((a, b) => a - b))

    tones.length = 0
    audio.cueFinish()
    const finish = tones.map((t) => t.freq)
    expect(finish).toEqual([...finish].sort((a, b) => b - a))
  })

  it('шаги последовательности разнесены во времени, а не звучат аккордом', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)

    audio.cueStart()
    for (let i = 1; i < tones.length; i += 1) {
      expect(tones[i].at).toBeGreaterThan(tones[i - 1].at)
    }
  })

  it('сигнал о потерянном кадре не чаще раза в 4 секунды', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)
    audio.resetHintThrottle()

    const now = 100000
    expect(audio.cueFrameLost(now)).toBe(true)
    expect(audio.cueFrameLost(now + 1000)).toBe(false)
    expect(audio.cueFrameLost(now + audio.HINT_GAP_MS - 1)).toBe(false)
    expect(audio.cueFrameLost(now + audio.HINT_GAP_MS)).toBe(true)
  })

  it('тумблер выключает все сигналы', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(false)

    expect(audio.cueRep()).toBe(false)
    expect(audio.cueStart()).toBe(false)
    expect(audio.cueCountdown(3)).toBe(false)
    expect(audio.cueTick()).toBe(false)
    expect(audio.cueFrameLost(200000)).toBe(false)
    expect(tones).toEqual([])

    audio.setAudioEnabled(true)
    audio.cueRep()
    expect(tones).toHaveLength(1)
  })

  it('состояние тумблера переживает перезагрузку', async () => {
    const audio = await import('./audio.js')
    audio.setAudioEnabled(false)

    vi.resetModules()
    const again = await import('./audio.js')
    expect(again.isAudioEnabled()).toBe(false)
  })

  it('без Web Audio приложение не падает', async () => {
    delete globalThis.AudioContext
    vi.resetModules()
    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)

    expect(audio.cueRep()).toBe(false)
    expect(audio.isAudioReady()).toBe(false)
  })
})

describe('почему было тихо', () => {
  /**
   * Жалоба «не слышно» приходит уже после тренировки, и различить по ней
   * выключенный тумблер, незапущенный AudioContext и отсутствие Web Audio
   * нечем. Поэтому первый молчаливый сигнал каждой причины пишется в лог — и
   * ровно один раз: сигналов за сессию сотни.
   */
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('выключенный тумблер записывается один раз за сессию', async () => {
    const { logEvent } = await import('../debug/logShipper.js')
    logEvent.mockClear()
    const audio = await import('./audio.js')
    audio.setAudioEnabled(false)

    audio.cueRep()
    audio.cueTick()
    audio.cueStart()
    audio.cueCountdown(3)

    const blocked = logEvent.mock.calls.filter(([tag]) => tag === 'audio.blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0][1]).toMatchObject({ cause: 'off' })
  })

  it('незапущенный контекст — своя причина, и тоже одна строка', async () => {
    const { logEvent } = await import('../debug/logShipper.js')
    logEvent.mockClear()
    // контекст есть, но браузер держит его до касания экрана
    let state = 'suspended'
    globalThis.AudioContext = class {
      constructor() {
        this.currentTime = 0
        this.destination = {}
      }
      get state() {
        return state
      }
      resume() {
        return Promise.resolve()
      }
      createOscillator() {
        return {
          frequency: { setValueAtTime() {} },
          connect: () => ({ connect: () => {} }),
          start() {},
          stop() {},
        }
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
          connect: () => ({ connect: () => {} }),
        }
      }
    }

    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)
    audio.cueRep()
    audio.cueRep()
    audio.cueTick()

    const blocked = logEvent.mock.calls.filter(([tag]) => tag === 'audio.blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0][1]).toMatchObject({ cause: 'suspended', ctxState: 'suspended' })

    // контекст ожил — новых строк нет
    state = 'running'
    audio.cueRep()
    expect(logEvent.mock.calls.filter(([tag]) => tag === 'audio.blocked')).toHaveLength(1)
    delete globalThis.AudioContext
  })

  it('Web Audio нет вовсе — причина третья и отдельная', async () => {
    const { logEvent } = await import('../debug/logShipper.js')
    logEvent.mockClear()
    delete globalThis.AudioContext
    delete globalThis.webkitAudioContext

    const audio = await import('./audio.js')
    audio.setAudioEnabled(true)
    audio.cueRep()
    audio.cueRep()

    const blocked = logEvent.mock.calls.filter(([tag]) => tag === 'audio.blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0][1]).toMatchObject({ cause: 'no-context', ctxState: 'none' })
  })
})
