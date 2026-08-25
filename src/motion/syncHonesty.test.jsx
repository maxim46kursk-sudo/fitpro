// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import MotionApp from './index.jsx'
import { resetSync } from './sync.js'
import { LM } from './pose/landmarks.js'

/**
 * ЧЕСТНОСТЬ ПРОГРЕССА. Раздел переживает неудачную загрузку и открывается на
 * кэше устройства — но человек обязан об этом ЗНАТЬ, а участник сезона обязан
 * не начать заход, который потом не сойдётся с общей таблицей: двадцать минут
 * работы впустую хуже честного отказа на входе.
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

let onResult = null

vi.mock('./pose/usePoseLandmarker.js', () => ({
  usePoseLandmarker: (options) => {
    onResult = options.onResult
    return {
    status: 'ready',
    warm: true,
    errorCode: null,
    errorDetail: null,
    progress: null,
    delegate: 'GPU',
    thread: 'worker',
      latestRef: { current: null },
      fpsRef: { current: { value: 30, inferenceMs: 10 } },
    }
  },
}))

/**
 * Постоять в кадре — единственная дорога от постановки к выбору уровня, и
 * пройти её приходится по-настоящему: экран выбора и есть то место, где
 * человеку отказывают в зачёте.
 */
let now = 0
let rafQueue = []

function pushFrame(timestamp) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  points[LM.LEFT_SHOULDER] = { x: 0.4, y: 0.3, z: 0, visibility: 1 }
  points[LM.RIGHT_SHOULDER] = { x: 0.6, y: 0.3, z: 0, visibility: 1 }
  points[LM.LEFT_HIP] = { x: 0.45, y: 0.55, z: 0, visibility: 1 }
  points[LM.RIGHT_HIP] = { x: 0.55, y: 0.55, z: 0, visibility: 1 }
  points[LM.LEFT_KNEE] = { x: 0.45, y: 0.72, z: 0, visibility: 1 }
  points[LM.RIGHT_KNEE] = { x: 0.55, y: 0.72, z: 0, visibility: 1 }
  points[LM.LEFT_ANKLE] = { x: 0.45, y: 0.9, z: 0, visibility: 1 }
  points[LM.RIGHT_ANKLE] = { x: 0.55, y: 0.9, z: 0, visibility: 1 }
  points[LM.NOSE] = { x: 0.5, y: 0.2, z: 0, visibility: 1 }
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
  act(() => {
    onResult?.({ landmarks: points, worldLandmarks: world, timestamp })
  })
}

/**
 * ПОЧЕМУ ЗДЕСЬ ВЕЗДЕ `waitFor`, А НЕ ПРОСТОЙ `getByTestId`.
 *
 * Прогон крутит кадры руками (см. ниже) и замораживает `performance.now`, но
 * React всё равно раскладывает состояние по своим тактам, а не по нашим. Узел
 * вроде «заход в зачёт закрыт» появляется на такт-другой позже последнего
 * кадра, и спрошенный мгновенно он то есть, то нет — в зависимости от того,
 * насколько занята машина.
 *
 * Так этот файл и падал: раз в несколько прогонов, каждый раз на другом тесте,
 * и никогда в одиночку на свободной машине. `waitFor` ждёт появления и падает,
 * если узел не пришёл вовсе, — то есть проверяет ровно то же, но не зависит от
 * того, сколько ядер сейчас свободно.
 */
function stayInFrame(seconds) {
  for (let i = 0; i < seconds * 30; i += 1) {
    now += 33
    pushFrame(now)
    act(() => {
      const callbacks = rafQueue
      rafQueue = []
      callbacks.forEach((cb) => cb(now))
    })
  }
}

/**
 * СТОЯТЬ В КАДРЕ, ПОКА НЕ ПОЯВИТСЯ НУЖНЫЙ ЭКРАН, а не «четыре секунды и будь
 * что будет».
 *
 * Постановка требует простоять в кадре несколько секунд, и прогон отсчитывает
 * их сам, синтетическими кадрами. Но сколько именно кадров нужно, зависит от
 * того, на каком из них раздел успел подписаться на результаты позы, — а это
 * решают такты React, то есть занятость машины. Фиксированные сто двадцать
 * кадров то доводили до экрана выбора, то не доводили, и тест падал «узла нет»
 * раз в несколько прогонов, каждый раз на другом месте.
 *
 * Здесь кадры идут порциями, пока узел не появится, с потолком: не появился за
 * пятнадцать секунд синтетического времени — значит его и правда нет, и тест
 * обязан упасть.
 */
async function достоятьДо(testId, потолокСекунд = 15) {
  for (let прошло = 0; прошло < потолокСекунд; прошло += 1) {
    if (screen.queryByTestId(testId)) return
    stayInFrame(1)
    // дать React разложить состояние между порциями
    await act(async () => {})
  }
  await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy())
}

const SEASON = { id: 1, title: 'Поток 1', starts_on: null, price_rub: 2990, prize_pct: 50, prize_split: [50, 30, 20], status: 'open' }
/** Участник сезона: у него на кону призы, ради него всё это и сделано. */
let entry = { id: 7, participant_no: 12, display_name: 'Пётр Петров', paid_at: '2026-08-20T10:00:00Z' }

vi.mock('../challengeSeason.js', () => ({
  CHALLENGE_PRICE: 2990,
  loadChallengeState: vi.fn(async ({ guest } = {}) => (guest ? null : { season: SEASON, entry, rulesAcceptedAt: '2026-08-20T09:00:00Z' })),
  buyTicket: vi.fn(async () => ({ ok: true })),
  acceptRules: vi.fn(async () => ({ ok: true })),
  hasNorm: vi.fn(() => true),
  freezeNorm: vi.fn(async () => 'already'),
  loadNutritionFacts: vi.fn(async () => []),
  loadStandings: vi.fn(async () => []),
}))

/** Сервер, который сегодня не отвечает, а завтра отвечает. */
function backend({ ok = false } = {}) {
  const state = { ok }
  return {
    api: {
      userId: 'u1',
      load: async () => (state.ok ? { progress: { day: 1, done: [], attempts: { days: {} } } } : null),
      saveProgress: async () => {},
      saveAttempts: async () => {},
    },
    fix: () => { state.ok = true },
  }
}

beforeEach(() => {
  entry = { id: 7, participant_no: 12, display_name: 'Пётр Петров', paid_at: '2026-08-20T10:00:00Z' }
  globalThis.localStorage?.clear()
  resetSync()
  // человек уже настроен под себя — иначе раздел встретит его калибровкой
  globalThis.localStorage.setItem('fitpro-motion.game.personal.v1', JSON.stringify({ version: 2, max: { knee: 0.7 } }))
  now = 0
  rafQueue = []
  onResult = null
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb) => rafQueue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetSync()
})

describe('прогресс не загрузился', () => {
  it('участник видит полосу, заход в зачёт закрыт, тренироваться можно', async () => {
    const { api } = backend()
    render(<MotionApp sync={api} />)
    await waitFor(() => expect(screen.getByTestId('sync-warn')).toBeTruthy())
    await достоятьДо('unscored-note')

    // полоса — не всплывашка: она висит и предлагает единственное действие
    await waitFor(() => expect(screen.getByTestId('sync-warn')).toBeTruthy())
    expect(screen.getByTestId('sync-warn').textContent).toContain('по последнему сохранённому на этом устройстве')
    expect(screen.getByTestId('sync-retry')).toBeTruthy()

    // отказ в зачёте стоит ДО тренировки, а не в отчёте после неё
    await waitFor(() => expect(screen.getByTestId('unscored-note')).toBeTruthy())
    expect(screen.getByTestId('unscored-note').textContent).toContain('заход в зачёт сейчас невозможен')
    // счётчик заходов дня молчит: тратить их сейчас нечем
    expect(screen.queryByTestId('runs-left')).toBeNull()

    // но тренироваться можно: уровни на месте и нажимаются
    await waitFor(() => expect(screen.getByTestId('level-novice')).toBeTruthy())
    expect(screen.getByTestId('level-novice').disabled).toBe(false)
  })

  it('после удачного повтора полоса уходит и заход открывается', async () => {
    const { api, fix } = backend()
    render(<MotionApp sync={api} />)
    await waitFor(() => expect(screen.getByTestId('sync-warn')).toBeTruthy())
    await достоятьДо('unscored-note')

    fix()
    await act(async () => {
      screen.getByTestId('sync-retry').click()
    })

    await waitFor(() => expect(screen.queryByTestId('sync-warn')).toBeNull())
    await waitFor(() => expect(screen.queryByTestId('unscored-note')).toBeNull())
    // зачёт вернулся: снова видно, сколько заходов осталось на день
    await waitFor(() => expect(screen.getByTestId('runs-left')).toBeTruthy())
  })

  it('не участнику играть по своему кэшу никто не мешает', async () => {
    // его прогресс и так живёт на устройстве — запрещать нечего, но сказать надо
    entry = null
    const { api } = backend()
    render(<MotionApp sync={api} />)
    await waitFor(() => expect(screen.getByTestId('sync-warn')).toBeTruthy())
    await достоятьДо('level-novice')

    // сперва дожидаемся экрана выбора, и только потом спрашиваем, чего на нём
    // НЕТ: «отказа не видно» на ещё не отрисованном экране — не проверка
    await waitFor(() => expect(screen.getByTestId('level-novice')).toBeTruthy())
    expect(screen.queryByTestId('unscored-note')).toBeNull()
  })

  it('сервер ответил — полосы нет вовсе', async () => {
    const { api } = backend({ ok: true })
    render(<MotionApp sync={api} />)
    await waitFor(() => expect(screen.getByTestId('calibration-room')).toBeTruthy())
    await достоятьДо('level-novice')
    expect(screen.queryByTestId('sync-warn')).toBeNull()
    expect(screen.queryByTestId('unscored-note')).toBeNull()
  })
})
