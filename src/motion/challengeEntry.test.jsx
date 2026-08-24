// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import MotionApp from './index.jsx'

/**
 * ДВЕРЬ С ГЛАВНОЙ ВЕДЁТ СРАЗУ К ЧЕЛЛЕНДЖУ — И БЕЗ КАМЕРЫ.
 *
 * Человек нажал карточку «Челлендж 30 дней», чтобы узнать, что за поток и почём
 * место. Спросить у него в ответ разрешение на съёмку и восемь мегабайт модели
 * значит не ответить: до экрана он не дойдёт, а разрешение потом не переспросишь.
 * Поэтому здесь проверяется не разметка (её проверяет ChallengeScreen.test.jsx),
 * а сам вход: экран открылся, камера при этом не включалась.
 */

let cameraEnabled = null

vi.mock('./pose/useCamera.js', () => ({
  useCamera: (options) => {
    cameraEnabled = options?.enabled
    return {
      status: 'ready',
      stream: null,
      info: null,
      devices: [],
      errorCode: null,
      retry: () => {},
      selectDevice: () => {},
    }
  },
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

const SEASON = { id: 1, title: 'Поток 1', starts_on: null, price_rub: 2990, prize_pct: 50, prize_split: [50, 30, 20], status: 'open' }

/**
 * Сезон приезжает из базы — здесь её подменяем целиком. accepted решает, читал
 * ли человек правила ЭТОГО потока: ответ живёт на сервере, поэтому и в стенде
 * он приходит оттуда же, а не из хранилища.
 */
let accepted = null

let season = SEASON

vi.mock('../challengeSeason.js', () => ({
  CHALLENGE_PRICE: 2990,
  loadChallengeState: vi.fn(async ({ guest } = {}) =>
    guest ? null : (season ? { season, entry: null, rulesAcceptedAt: accepted } : null),
  ),
  buyTicket: vi.fn(async () => ({ ok: true })),
  acceptRules: vi.fn(async () => ({ ok: true })),
}))

beforeEach(() => {
  accepted = null
  season = SEASON
  globalThis.localStorage?.clear()
  // jsdom не знает matchMedia, а без него падает блокировка ландшафта
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  cameraEnabled = null
})

describe('вход в раздел сразу на экране челленджа', () => {
  it('экран открыт, камера не включена', async () => {
    accepted = '2026-08-24T10:00:00Z'
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.getByTestId('challenge-price').textContent).toContain('2990')
    expect(cameraEnabled).toBe(false)
    // ни калибровки, ни выбора уровня по дороге
    expect(screen.queryByTestId('level-pro')).toBeNull()
  })

  it('без стартового экрана раздел открывается как раньше — с камерой', () => {
    render(<MotionApp />)

    expect(screen.queryByTestId('challenge-screen')).toBeNull()
    expect(cameraEnabled).toBe(true)
  })

  it('гость на этом экране видит предложение аккаунта, а не оплату', async () => {
    const onGuestValue = vi.fn()
    render(<MotionApp startScreen="challenge" guest onGuestValue={onGuestValue} />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.getByTestId('challenge-signup')).toBeTruthy()
    expect(screen.queryByTestId('challenge-buy')).toBeNull()

    screen.getByTestId('challenge-signup').click()
    // предложение рисует хозяин, одно на всё приложение (OfferSheet в App.jsx)
    expect(onGuestValue).toHaveBeenCalledWith('challenge', 0)
  })
})

describe('дорога: правила первый раз, потом сразу поток', () => {
  it('не читал правил — с главной попадает на них, с воротами', async () => {
    accepted = null
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('rules-screen')).toBeTruthy())
    expect(screen.queryByTestId('challenge-screen')).toBeNull()
    // ворота на месте: на первом экране их ещё нет, на последнем появятся
    expect(screen.queryByTestId('rules-join')).toBeNull()
    expect(screen.getByTestId('rules-count').textContent).toContain('/ 12')
    // и камера ради чтения правил не включается
    expect(cameraEnabled).toBe(false)
  })

  it('уже согласился — правил больше не показывают, сразу поток', async () => {
    accepted = '2026-08-24T10:00:00Z'
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.queryByTestId('rules-screen')).toBeNull()
    // и покупка ему открыта напрямую, без повторного чтения
    expect(screen.getByTestId('challenge-buy')).toBeTruthy()
  })

  it('не согласившийся не может купить билет мимо правил', async () => {
    accepted = null
    render(<MotionApp startScreen="challenge" />)
    await waitFor(() => expect(screen.getByTestId('rules-screen')).toBeTruthy())

    // вышел из правил, не дочитав, — на экране потока вместо «Купить билет»
    // стоит дорога обратно в правила
    screen.getByLabelText('Закрыть правила').click()
    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.queryByTestId('challenge-buy')).toBeNull()
    expect(screen.getByTestId('challenge-join')).toBeTruthy()
  })

  it('правила можно перечитать свободно, без галочки', async () => {
    accepted = '2026-08-24T10:00:00Z'
    render(<MotionApp startScreen="challenge" />)
    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())

    screen.getByTestId('challenge-rules').click()
    await waitFor(() => expect(screen.getByTestId('rules-screen')).toBeTruthy())
    // долистать до конца — ворот всё равно нет
    for (let i = 1; i < 12; i += 1) act(() => screen.getByTestId('rules-next').click())
    expect(screen.queryByTestId('rules-gate')).toBeNull()
  })

  it('живого потока ещё нет — правила всё равно открываются С ВОРОТАМИ', async () => {
    /**
     * ИМЕННО ЭТО И СЛОМАЛОСЬ НА ПРОДЕ. Сезон лежал черновиком, участие
     * приходило пустым — и правила открывались в режиме свободного чтения: ни
     * галочки, ни кнопки, сколько ни листай. Правила читают ДО открытия
     * набора, и ворота зависят от того, читал ли человек, а не от того,
     * продаётся ли билет прямо сейчас.
     */
    season = null
    accepted = null
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('rules-screen')).toBeTruthy())
    for (let i = 1; i < 12; i += 1) act(() => screen.getByTestId('rules-next').click())
    await waitFor(() => expect(screen.getByTestId('rules-gate')).toBeTruthy())
    // и цена на кнопке объявленная, а не ноль
    expect(screen.getByTestId('rules-join').textContent).toContain('2990')
  })

  it('гостю правила показываются свободно — это витрина', async () => {
    render(<MotionApp startScreen="challenge" guest onGuestValue={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    screen.getByTestId('challenge-rules').click()
    await waitFor(() => expect(screen.getByTestId('rules-screen')).toBeTruthy())
    expect(screen.queryByTestId('rules-join')).toBeNull()
  })
})
