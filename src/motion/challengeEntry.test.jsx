// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import MotionApp from './index.jsx'
import { moscowDate } from './game/challenge.js'

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
let entry = null

let season = SEASON

/**
 * Сервер таблицы потока: отвечает ТЕМ, что успело до него доехать. Первый ответ
 * — до захода (нули), дальше — то, что положили в `наСервере`.
 */
let таблица = []
let читалиТаблицу = 0
let отправлено = 0
/** Порядок событий: отправка обязана идти ПЕРЕД чтением таблицы. */
let порядок = []

vi.mock('../challengeSeason.js', () => ({
  CHALLENGE_PRICE: 2990,
  loadChallengeState: vi.fn(async ({ guest } = {}) =>
    guest ? null : (season ? { season, entry, rulesAcceptedAt: accepted } : null),
  ),
  buyTicket: vi.fn(async () => ({ ok: true })),
  acceptRules: vi.fn(async () => ({ ok: true })),
  hasNorm: vi.fn(() => true),
  freezeNorm: vi.fn(async () => 'already'),
  loadNutritionFacts: vi.fn(async () => []),
  loadStandings: vi.fn(async () => { читалиТаблицу += 1; порядок.push('таблица'); return таблица }),
}))

vi.mock('./sync.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    // отправка «доезжает» мгновенно и отмечается — на неё и смотрит проверка
    flushPush: vi.fn(async () => { отправлено += 1; порядок.push('отправка') }),
  }
})

/** Дата за N московских дней от сегодня: минус — прошлое. */
const сдвиг = (дней) => {
  const [y, m, d] = moscowDate().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + дней)).toISOString().slice(0, 10)
}

beforeEach(() => {
  accepted = null
  entry = null
  season = SEASON
  таблица = []
  читалиТаблицу = 0
  отправлено = 0
  порядок = []
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
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
    expect(cameraEnabled).toBe(false)
    // ни калибровки, ни выбора уровня по дороге
    expect(screen.queryByTestId('level-pro')).toBeNull()
  })

  it('без стартового экрана раздел открывается как раньше — с камерой', () => {
    render(<MotionApp />)

    expect(screen.queryByTestId('challenge-screen')).toBeNull()
    expect(cameraEnabled).toBe(true)
  })

  it('гость читает ту же страницу и видит ту же цену', async () => {
    // раньше вместо цены ему показывали «создать аккаунт» — то есть просили
    // плату вниманием раньше, чем он узнал, что предлагают
    render(<MotionApp startScreen="challenge" guest />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
    expect(screen.getByTestId('challenge-join').textContent).toContain('Участвовать')
    expect(screen.queryByTestId('challenge-signup')).toBeNull()
  })

  it('нажал «Участвовать» — предложение аккаунта рисует хозяин', async () => {
    const onGuestValue = vi.fn()
    render(<MotionApp startScreen="challenge" guest onGuestValue={onGuestValue} />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    act(() => screen.getByTestId('challenge-agree').click())
    act(() => screen.getByTestId('challenge-join').click())

    // предложение рисует хозяин, одно на всё приложение (OfferSheet в App.jsx)
    expect(onGuestValue).toHaveBeenCalledWith('challenge', 0)
  })
})

describe('дорога: карточка на главной ведёт на страницу челленджа', () => {
  it('не читал правил — открывается витрина, правила её раздел', async () => {
    accepted = null
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    // правила больше не отдельная карусель — они на этой же странице
    expect(screen.getByTestId('challenge-rules')).toBeTruthy()
    expect(screen.getByTestId('challenge-join')).toBeTruthy()
    expect(cameraEnabled).toBe(false)
  })

  it('живого потока ещё нет — витрина всё равно открывается', async () => {
    /**
     * ПРОД СЕЙЧАС ИМЕННО ТАКОЙ: сезон лежит черновиком. Страницу читают ДО
     * открытия набора — она и есть витрина, — поэтому пустое участие не должно
     * оставлять человека ни с чем.
     */
    season = null
    accepted = null
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
    expect(screen.getByTestId('challenge-join').disabled).toBe(true)
  })

  it('участник попадает сразу в комнату, минуя лендинг', async () => {
    season = { ...SEASON, starts_on: '2026-09-10' }
    accepted = '2026-08-24T10:00:00Z'
    entry = { id: 1, participant_no: 24, display_name: 'Пётр', paid_at: 'x' }
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('challenge-member')).toBeTruthy())
    expect(screen.getByTestId('challenge-number').textContent).toContain('24')
    // ни цены, ни кнопки покупки участнику не показывают
    expect(screen.queryByTestId('challenge-join')).toBeNull()
    expect(screen.queryByTestId('challenge-price')).toBeNull()
  })

  it('поток идёт — участник попадает в рабочую комнату дня', async () => {
    season = { ...SEASON, starts_on: сдвиг(-4) }
    accepted = '2026-08-24T10:00:00Z'
    entry = { id: 1, participant_no: 24, display_name: 'Пётр', paid_at: 'x' }
    render(<MotionApp startScreen="challenge" />)

    await waitFor(() => expect(screen.getByTestId('stream-room')).toBeTruthy())
    expect(screen.getByTestId('stream-day').textContent).toBe('День 5 из 30')
    expect(cameraEnabled).toBe(false)
  })

  it('гостю — та же кнопка и та же цена, аккаунт по нажатию', async () => {
    const onGuestValue = vi.fn()
    render(<MotionApp startScreen="challenge" guest onGuestValue={onGuestValue} />)

    await waitFor(() => expect(screen.getByTestId('challenge-screen')).toBeTruthy())
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')

    act(() => screen.getByTestId('challenge-agree').click())
    act(() => screen.getByTestId('challenge-join').click())
    expect(onGuestValue).toHaveBeenCalledWith('challenge', 0)
  })
})

/**
 * ВТОРОЙ КОМНАТЫ У УЧАСТНИКА НЕТ, И ДОРОГА ИЗ ИГРЫ ВЕДЁТ В ЕГО СОБСТВЕННУЮ.
 *
 * Внутри Motion жила «Моя комната» — со своим календарём тридцати дней, своими
 * очками и показателями. Рядом с комнатой участника она стала дублем: две
 * комнаты с одинаковыми цифрами в разных местах человек читает как «какая-то из
 * них врёт», и правильного ответа на это нет.
 *
 * Проверяется дорога целиком, а не наличие кнопки: участник входит в игру ИЗ
 * СВОЕЙ КОМНАТЫ и обязан вернуться в неё же. Высадить его на постановку в
 * кадр — значит увести из единственного места, где живёт его поток.
 */
describe('у участника комната одна', () => {
  const вКомнату = async () => {
    season = { ...SEASON, starts_on: сдвиг(-4) }
    accepted = '2026-08-24T10:00:00Z'
    entry = { id: 1, participant_no: 24, display_name: 'Пётр', paid_at: 'x' }
    render(<MotionApp startScreen="challenge" />)
    await waitFor(() => expect(screen.getByTestId('stream-room')).toBeTruthy())
  }

  it('из комнаты в игру и обратно — крестик возвращает в комнату', async () => {
    await вКомнату()

    act(() => screen.getByTestId('stream-start').click())
    await waitFor(() => expect(screen.getByTestId('level-novice')).toBeTruthy())
    expect(screen.getByTestId('challenge-day').textContent).toContain('День 5')

    // выхода во вторую комнату из игры нет
    expect(screen.queryByTestId('open-room')).toBeNull()
    expect(screen.queryByTestId('room-screen')).toBeNull()

    // крестик выбора уровня ведёт обратно в комнату участника, а не на
    // постановку в кадр
    act(() => document.querySelector('.mt-corner--left').click())
    await waitFor(() => expect(screen.getByTestId('stream-room')).toBeTruthy())
  })

  it('одиночке «Моя комната» остаётся: другой у него нет', async () => {
    season = null
    entry = null
    render(<MotionApp />)

    // одиночка входит в раздел на постановке в кадр — там его дверь в комнату
    await waitFor(() => expect(screen.getByTestId('calibration-room')).toBeTruthy())
    act(() => screen.getByTestId('calibration-room').click())
    expect(screen.getByTestId('room-screen')).toBeTruthy()
  })
})

/**
 * КОМНАТА И ТАБЛИЦА ОБЯЗАНЫ ГОВОРИТЬ ОДНО И ТО ЖЕ.
 *
 * ЖИВАЯ ПОЛОМКА (прод, 25.08): в комнате у человека тысяча очков за сегодня, а
 * в таблице потока у него же ноль. Причин было две, и обе про порядок:
 *
 *   1) комната читает УСТРОЙСТВО, таблица — СЕРВЕР. Заход попадает в кэш
 *      мгновенно, наверх уезжает отложенно. Спроси сервер раньше — он честно
 *      ответит ноль;
 *   2) таблица читалась ОДИН РАЗ за открытие раздела и дальше бралась из
 *      памяти: человек уходил играть и возвращался к снимку, сделанному ДО игры.
 *
 * Для призовых денег такое расхождение недопустимо, а «обнови страницу» — не
 * ответ. Поэтому здесь проверяется не арифметика, а ПОРЯДОК: на каждый вход в
 * комнату сперва дожидаемся отправки, потом спрашиваем таблицу.
 */
describe('комната и таблица потока не расходятся', () => {
  const вКомнату = async () => {
    season = { ...SEASON, starts_on: сдвиг(-4) }
    accepted = '2026-08-24T10:00:00Z'
    entry = { id: 1, participant_no: 24, display_name: 'Пётр', paid_at: 'x' }
    render(<MotionApp startScreen="challenge" />)
    await waitFor(() => expect(screen.getByTestId('stream-room')).toBeTruthy())
  }

  it('таблица спрашивается ПОСЛЕ того, как наигранное уехало наверх', async () => {
    await вКомнату()
    await waitFor(() => expect(читалиТаблицу).toBeGreaterThan(0))
    expect(отправлено).toBeGreaterThan(0)
    // порядок и есть суть правки: сперва отдать наигранное, потом спрашивать
    expect(порядок[0]).toBe('отправка')
    expect(порядок).toContain('таблица')
  })

  it('вернулся из игры — таблица перечитана, а не взята из памяти', async () => {
    await вКомнату()
    await waitFor(() => expect(читалиТаблицу).toBe(1))

    // ушёл играть
    act(() => screen.getByTestId('stream-start').click())
    await waitFor(() => expect(screen.getByTestId('level-novice')).toBeTruthy())

    // пока играл, на сервере появился его результат
    таблица = [{
      participant_no: 24, display_name: 'Пётр', is_me: true, days_done: 1,
      day: 5, best_score: 1000, kcal: 0, p: 0, f: 0, c: 0, meals: 0,
      norm_kcal: 2000, norm_p: 120, norm_f: 65, norm_c: 220,
    }]

    // вернулся в комнату
    act(() => document.querySelector('.mt-corner--left').click())
    await waitFor(() => expect(screen.getByTestId('stream-room')).toBeTruthy())

    await waitFor(() => expect(читалиТаблицу).toBe(2))
    await waitFor(() =>
      expect(screen.getByTestId('stream-place-value').textContent).toBe('1-й из 1'))
  })
})
