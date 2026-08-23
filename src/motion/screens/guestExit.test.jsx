// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'

/**
 * ВЫХОД ГОСТЯ ИЗ ЗАХОДА.
 *
 * Гостю сохранять некуда: его заход живёт в памяти вкладки и умрёт с
 * перезагрузкой. Поэтому первая кнопка в вопросе о выходе у него называется
 * тем, что требуется на самом деле, — аккаунтом. Это то же предложение
 * сохранить, что и на итоговом экране, только застающее человека в другой
 * момент, и считается оно теми же тремя событиями воронки.
 *
 * Проверяется здесь ровно граница раздела: какие кнопки видит гость и что
 * уходит наружу. Что хозяин делает с этими событиями — дело App.jsx.
 */

import SessionScreen from './SessionScreen.jsx'
import { closePending, dropPending, dropSession } from '../game/day.js'

vi.mock('../game/day.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startAttempt: vi.fn(() => 1),
  holdAttempt: vi.fn(),
  closePending: vi.fn(() => ({ recorded: true, attempt: 1, attemptsLeft: 2, best: 10, dayTotal: 10 })),
  dropPending: vi.fn(),
  dropSession: vi.fn(),
}))

vi.mock('../feedback/audio.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cueCountdown: vi.fn(),
  cueStart: vi.fn(),
  cueTick: vi.fn(),
}))

const noopSubscribe = () => () => {}

/**
 * Смонтировать и забыть, что было при монтировании.
 *
 * Открытие сессии само зовёт `closePending` — так закрывается чужой черновик,
 * оставшийся от прошлого захода. Проверяем мы здесь только то, что делает
 * ВЫХОД, и без этой очистки каждый счёт был бы на единицу больше.
 */
const открыть = (props = {}) => {
  const r = render(<SessionScreen subscribe={noopSubscribe} tier="pro" {...props} />)
  closePending.mockClear()
  dropPending.mockClear()
  dropSession.mockClear()
  return r
}

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

/** Дойти до вопроса о выходе тем же путём, что и человек: меню → «Выйти». */
const спроситьВыход = () => {
  act(() => { screen.getByTestId('session-menu-button').click() })
  act(() => { screen.getByTestId('menu-exit').click() })
}

describe('гость выходит из захода', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage())
    closePending.mockClear()
    dropPending.mockClear()
    dropSession.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('вместо «сохранить и выйти» — «Создать аккаунт, чтобы сохранить»', () => {
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" guest />)
    спроситьВыход()

    expect(screen.getByTestId('exit-choice')).toBeTruthy()
    expect(screen.getByTestId('exit-save').textContent).toBe('Создать аккаунт, чтобы сохранить')
    // вторая кнопка та же, что у всех
    expect(screen.getByTestId('exit-discard').textContent).toBe('Выйти без сохранения')
  })

  it('вошедшему человеку — обычное «Сохранить и выйти»', () => {
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    спроситьВыход()

    expect(screen.getByTestId('exit-save').textContent).toBe('Сохранить и выйти')
  })

  /**
   * Само появление вопроса — это показанное предложение, и считать его надо
   * там же, где считаются остальные: иначе в воронке гостевой выход выглядел бы
   * как согласие из ниоткуда.
   */
  it('показ вопроса гостю — событие offer_shown_motion', () => {
    const onGuestOffer = vi.fn()
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" guest onGuestOffer={onGuestOffer} />)
    спроситьВыход()

    expect(onGuestOffer).toHaveBeenCalledWith('shown')
  })

  it('вошедшему человеку событий воронки не шлётся вовсе', () => {
    const onGuestOffer = vi.fn()
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" onGuestOffer={onGuestOffer} />)
    спроситьВыход()
    act(() => { screen.getByTestId('exit-discard').click() })

    expect(onGuestOffer).not.toHaveBeenCalled()
  })

  /**
   * ЗАХОД ЗАКРЫВАЕТСЯ ОБЫЧНЫМ ПУТЁМ. Только став попыткой, он попадёт в память
   * раздела, оттуда в буфер переезда и уже с ним в аккаунт — «вместе с
   * сыгранным». Отдельного пути для гостя здесь нет и не должно быть.
   */
  it('«создать аккаунт» закрывает попытку и зовёт согласие', () => {
    const onGuestOffer = vi.fn()
    const onExit = vi.fn()
    открыть({ guest: true, onGuestOffer, onExit })
    спроситьВыход()
    act(() => { screen.getByTestId('exit-save').click() })

    expect(closePending).toHaveBeenCalledTimes(1)
    expect(onGuestOffer).toHaveBeenCalledWith('accepted')
    expect(onExit).toHaveBeenCalled()
  })

  it('«выйти без сохранения» чистит память захода и считается отказом', () => {
    const onGuestOffer = vi.fn()
    const onExit = vi.fn()
    открыть({ guest: true, onGuestOffer, onExit })
    спроситьВыход()
    act(() => { screen.getByTestId('exit-discard').click() })

    // черновик стёрт, попытка не записана
    expect(dropPending).toHaveBeenCalledTimes(1)
    expect(closePending).not.toHaveBeenCalled()
    // продолжать нечего: снимок снят вместе с черновиком
    expect(dropSession).toHaveBeenCalled()
    expect(onGuestOffer).toHaveBeenCalledWith('closed')
    expect(onExit).toHaveBeenCalled()
  })

  /**
   * Согласие и отказ — разные события, и путать их нельзя: по ним считается,
   * работает ли предложение вообще.
   */
  it('отказ не считается согласием, и наоборот', () => {
    const onGuestOffer = vi.fn()
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" guest onGuestOffer={onGuestOffer} />)
    спроситьВыход()
    act(() => { screen.getByTestId('exit-discard').click() })

    const виды = onGuestOffer.mock.calls.map(([k]) => k)
    expect(виды).toEqual(['shown', 'closed'])
  })

  it('«отмена» ничего не считает и никуда не выводит', () => {
    const onGuestOffer = vi.fn()
    const onExit = vi.fn()
    открыть({ guest: true, onGuestOffer, onExit })
    спроситьВыход()
    act(() => { screen.getByTestId('exit-cancel').click() })

    expect(screen.queryByTestId('exit-choice')).toBeNull()
    expect(onExit).not.toHaveBeenCalled()
    expect(dropPending).not.toHaveBeenCalled()
    expect(closePending).not.toHaveBeenCalled()
    // показ уже посчитан, а отказа не было — человек остался в тренировке
    expect(onGuestOffer.mock.calls.map(([k]) => k)).toEqual(['shown'])
  })
})
