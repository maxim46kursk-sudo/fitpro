// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildLogText, pushLive, snapshotOf } from './diagnostics.js'
import { DEFAULT_THRESHOLDS } from '../exercises/thresholds.js'

describe('лог сессии', () => {
  it('показывает реальные пороги ещё до открытия экрана подхода', () => {
    // Шину наполняет экран подхода. Раньше до его открытия в логе стояли
    // undefined по всем строкам — ровно там, где нужнее всего понять,
    // с какими значениями работает счётчик.
    const text = buildLogText()

    expect(text).not.toMatch(/undefined/)
    expect(text).toContain(`UP ${DEFAULT_THRESHOLDS.upAngle}°`)
    expect(text).toContain(`DOWN ${DEFAULT_THRESHOLDS.downAngle}°`)
    expect(text).toMatch(/калибровка: вкл/)
    expect(text).toContain(`окно ${DEFAULT_THRESHOLDS.smoothingWindow}`)
  })

  it('в заголовке есть устройство, экран и состояние звука', () => {
    const text = buildLogText()
    expect(text).toContain('устройство:')
    expect(text).toContain('экран:')
    expect(text).toContain('звук:')
    // речи в модуле больше нет — обратная связь только сигналами
    expect(text).toContain('только сигналы')
  })
})

describe('снимок состояния', () => {
  /**
   * Урок 18 августа: жалобу «не видно эффекта попадания» нельзя было разобрать
   * по логам — бой шёл в экономном режиме, а снимок об этом молчал. Молчал он и
   * про потерянные кадры, зависания насоса и худшую задержку, хотя всё это
   * давно считается.
   */
  it('называет режим отрисовки и счётчики пайплайна', () => {
    pushLive({
      screen: 'session:fight:круг3',
      cheap: true,
      videoSync: 'sync',
      perf: {
        dropped: 4,
        stalls: 1,
        grabErrors: 2,
        latencyMs: 187.4,
        latencyMax: 402.6,
        fpsAvg: 7.4,
        results: 300,
        grabMode: 'canvas',
      },
    })

    const snap = snapshotOf()
    expect(snap.screen).toBe('session:fight:круг3')
    expect(snap.cheap).toBe(true)
    expect(snap.dropped).toBe(4)
    expect(snap.stalls).toBe(1)
    expect(snap.grabErrors).toBe(2)
    expect(snap.latencyMax).toBe(403)
    expect(snap.fpsAvg).toBe(7)
    expect(snap.latencyMs).toBe(187)
    expect(snap.videoSync).toBe('sync')
    // и по-прежнему отвечает на «почему тихо»
    expect(snap.audio).toHaveProperty('ctxState')
  })

  it('пустой пайплайн не роняет снимок', () => {
    // первые пять секунд сессии счётчиков ещё нет вовсе
    pushLive({ perf: null, cheap: false })
    const snap = snapshotOf()
    expect(snap.cheap).toBe(false)
    expect(snap.dropped).toBeUndefined()
    expect(snap.latencyMax).toBeNull()
  })
})
