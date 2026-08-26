// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import MotionApp from './index.jsx'
import { resetSync } from './sync.js'

/**
 * СИНХРОНИЗАЦИЯ ОБЯЗАНА БЫТЬ ВИДНА.
 *
 * Полевой отказ: за семь дней прода в журнале ноль событий `sync.*` — включая
 * штатное `sync.ready`, которое случается в КАЖДОЙ сессии по построению. Это
 * читалось как «потерь не было», а означало «сигнала нет»: доезжают ли очки
 * участника до сервера, узнать было неоткуда.
 *
 * Причина была в порядке. События `sync.*` пишутся, пока MotionApp читает
 * прогресс («Загружаю прогресс…»), а приёмник журнала и его сброс жили в
 * MotionAppInner, который до конца чтения не смонтирован. Строки ложились в
 * буфер без приёмника, а следом `resetLogShipper()` вычищал этот буфер начисто.
 *
 * Проверяется здесь не порядок вызовов, а исход: строка `sync.ready` ДОЕХАЛА до
 * приёмника. Проверка порядка сломалась бы от любой перестановки кода, ничего
 * не сказав о том, видно синхронизацию или нет.
 */

vi.mock('./pose/useCamera.js', () => ({
  useCamera: () => ({
    status: 'ready',
    stream: null,
    info: null,
    devices: [],
    errorCode: null,
    retry: () => {},
    selectDevice: () => {},
  }),
}))

vi.mock('./pose/usePoseLandmarker.js', () => ({
  usePoseLandmarker: () => ({
    status: 'ready',
    warm: true,
    errorCode: null,
    errorDetail: null,
    progress: null,
    delegate: 'GPU',
    thread: 'worker',
    latestRef: { current: null },
    fpsRef: { current: { value: 30, inferenceMs: 10 } },
  }),
}))

vi.mock('../challengeSeason.js', () => ({
  CHALLENGE_PRICE: 2990,
  loadChallengeState: vi.fn(async () => null),
  buyTicket: vi.fn(async () => ({ ok: true })),
  acceptRules: vi.fn(async () => ({ ok: true })),
  hasNorm: vi.fn(() => true),
  freezeNorm: vi.fn(async () => 'already'),
  loadNutritionFacts: vi.fn(async () => []),
  loadStandings: vi.fn(async () => []),
}))

/** Всё, что уехало приёмнику, — построчно. */
let отправлено = []

function приёмник() {
  return {
    endpoint: '/тест/журнал',
    token: async () => 'токен',
  }
}

const прогресс = { day: 1, done: [], attempts: { days: {} } }

beforeEach(() => {
  отправлено = []
  resetSync()
  // jsdom не умеет ни того, ни другого, а раздел зовёт оба на монтировании
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  globalThis.fetch = vi.fn(async (url, init) => {
    try {
      const body = JSON.parse(init?.body || '{}')
      for (const line of body.lines || []) отправлено.push(line)
    } catch { /* не наш запрос — не наше дело */ }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
})

afterEach(() => {
  cleanup()
  resetSync()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('журнал видит синхронизацию', () => {
  it('sync.ready доезжает до приёмника', async () => {
    const sync = {
      userId: 'u1',
      load: async () => ({ progress: прогресс }),
      saveProgress: async () => {},
      saveAttempts: async () => {},
    }

    render(<MotionApp log={приёмник()} sync={sync} onExit={() => {}} />)

    // дождаться, пока прогресс прочитается и раздел смонтируется
    await waitFor(() => expect(отправлено.length + 1).toBeGreaterThan(0))
    await act(async () => {})

    /**
     * Уход со страницы отдаёт накопленное немедленно — ждать десять секунд
     * штатного интервала в прогоне незачем.
     */
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })

    const всё = отправлено.join('\n')
    expect(всё).toContain('[sync.ready]')
    // и вместе с ней — обычная первая строка раздела: сброс её больше не съедает
    expect(всё).toContain('[session.start]')
  })

  it('сбой загрузки прогресса тоже виден, а не молчит', async () => {
    const sync = {
      userId: 'u1',
      load: async () => {
        throw new Error('сервер лёг')
      },
      saveProgress: async () => {},
      saveAttempts: async () => {},
    }

    render(<MotionApp log={приёмник()} sync={sync} onExit={() => {}} />)
    await waitFor(() => expect(отправлено.length + 1).toBeGreaterThan(0))
    await act(async () => {})
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })

    /**
     * Ошибку сервера ловит сама загрузка и называет её `sync.load-failed` — до
     * `sync.hydrate-failed` дело не доходит. Проверяем то имя, которое
     * действительно едет: тест обязан описывать поведение, а не пожелание.
     */
    expect(отправлено.join('\n')).toContain('[sync.load-failed]')
  })
})
