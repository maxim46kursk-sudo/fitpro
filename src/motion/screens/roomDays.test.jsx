// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import RoomScreen, { readRoom } from './RoomScreen.jsx'
import { completeDay } from '../game/challenge.js'
import { holdAttempt, holdSession, submitAttempt } from '../game/day.js'

/**
 * ЖИВОЙ КАЛЕНДАРЬ КОМНАТЫ.
 *
 * Тридцать ячеек были картинкой: очки за день и всё. Точность, реакция и то,
 * что день собран за два захода, уже лежали в хранилище и никуда не
 * показывались, а незавершённую сессию из комнаты нельзя было ни увидеть, ни
 * продолжить — только вернуться на выбор уровня и найти её там.
 *
 * Проверяется состояние ячеек и то, что открывается по нажатию. Судейство,
 * зачёт и пороги не трогаются и не проверяются.
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

afterEach(cleanup)
beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
})

const stateOf = (day) => screen.getByTestId(`room-day-${day}`).getAttribute('data-state')

describe('состояние ячеек календаря', () => {
  it('сдан / сегодня / будущий — три разных состояния', () => {
    submitAttempt('pro', { score: 5000, hits: 40, spawned: 50, reactMs: 700 }, 1)
    completeDay(1)

    render(<RoomScreen day={2} />)

    expect(stateOf(1)).toBe('done')
    expect(stateOf(2)).toBe('now')
    expect(stateOf(3)).toBe('future')
    expect(stateOf(30)).toBe('future')
  })

  it('будущий день не нажимается — за ним ничего нет', () => {
    render(<RoomScreen day={2} />)
    // будущее рисуется div-ом, а не кнопкой: кнопка, которая ничего не делает,
    // хуже её отсутствия
    expect(screen.getByTestId('room-day-5').tagName).toBe('DIV')
  })

  it('начатая и не завершённая сессия — своё состояние и метка', () => {
    holdAttempt('pro', { score: 3000 }, 2)
    holdSession('pro', { cycle: 3, attempt: 1, runs: 1, totals: { score: 3000, hits: 20, spawned: 30 } }, 2)

    render(<RoomScreen day={2} />)

    expect(stateOf(2)).toBe('started')
    expect(screen.getByTestId('room-day-2').textContent).toContain('начата')
  })

  it('ГОСТЬ: открыт первый день, остальные — замок «С аккаунтом»', () => {
    render(<RoomScreen day={1} guest />)

    expect(stateOf(1)).not.toBe('locked')
    expect(stateOf(2)).toBe('locked')
    expect(stateOf(30)).toBe('locked')
    expect(screen.getByTestId('room-day-2').textContent).toContain('С аккаунтом')
  })

  /**
   * У гостя на устройстве мог остаться прогресс от заходов ДО появления
   * гостевого режима. Показать ему чужой накопленный челлендж значило бы
   * пообещать то, чего он не сможет ни продолжить, ни забрать с собой.
   */
  it('ГОСТЬ: старый локальный прогресс не показывается, день всегда первый', () => {
    completeDay(1)
    completeDay(2)
    completeDay(3)

    const room = readRoom(9, 30, { guest: true })

    expect(room.day).toBe(1)
    expect(room.doneCount).toBe(0)
    expect(room.rows[0].state).not.toBe('done')
    expect(room.rows[1].state).toBe('locked')
  })

  it('без гостя тот же прогресс виден как есть', () => {
    completeDay(1)
    completeDay(2)

    const room = readRoom(3, 30)

    expect(room.doneCount).toBe(2)
    expect(room.rows[0].state).toBe('done')
    expect(room.rows[2].state).toBe('now')
  })
})

describe('сводка пройденного дня', () => {
  it('нажатие на сданный день открывает очки, точность и реакцию', () => {
    submitAttempt('pro', { score: 5000, hits: 40, spawned: 50, reactMs: 700 }, 1)
    completeDay(1)

    render(<RoomScreen day={2} />)
    expect(screen.queryByTestId('room-day-summary')).toBeNull()

    fireEvent.click(screen.getByTestId('room-day-1'))

    expect(screen.getByTestId('room-day-summary')).toBeTruthy()
    expect(screen.getByTestId('room-day-score').textContent).toContain('5000')
    expect(screen.getByTestId('room-day-accuracy').textContent).toContain('80%')
    expect(screen.getByTestId('room-day-react').textContent).toContain('700 мс')
  })

  it('«за N заходов» — только когда их больше одного', () => {
    submitAttempt('pro', { score: 5000, hits: 40, spawned: 50, reactMs: 700 }, 1)
    completeDay(1, new Date(), 1)
    submitAttempt('pro', { score: 4000, hits: 30, spawned: 50, reactMs: 800 }, 2)
    completeDay(2, new Date(), 3)

    render(<RoomScreen day={4} />)

    fireEvent.click(screen.getByTestId('room-day-1'))
    expect(screen.queryByTestId('room-day-runs')).toBeNull()

    fireEvent.click(screen.getByTestId('room-day-2'))
    expect(screen.getByTestId('room-day-runs').textContent).toContain('3')
  })

  it('повторное нажатие закрывает сводку', () => {
    submitAttempt('pro', { score: 5000, hits: 40, spawned: 50, reactMs: 700 }, 1)
    completeDay(1)

    render(<RoomScreen day={2} />)
    fireEvent.click(screen.getByTestId('room-day-1'))
    expect(screen.getByTestId('room-day-summary')).toBeTruthy()

    fireEvent.click(screen.getByTestId('room-day-1'))
    expect(screen.queryByTestId('room-day-summary')).toBeNull()
  })

  it('день с незавершённой сессией открывает выбор, а не сводку', () => {
    holdAttempt('pro', { score: 3000 }, 2)
    holdSession('pro', { cycle: 3, attempt: 1, runs: 1, totals: { score: 3000, hits: 20, spawned: 30 } }, 2)
    const onResume = vi.fn()

    render(<RoomScreen day={2} onResume={onResume} />)
    fireEvent.click(screen.getByTestId('room-day-2'))

    expect(screen.queryByTestId('room-day-summary')).toBeNull()
    expect(screen.getByTestId('session-resume')).toBeTruthy()

    fireEvent.click(screen.getByTestId('session-resume-continue'))
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onResume.mock.calls[0][0]).toBe('pro')
    expect(onResume.mock.calls[0][1].resume.cycle).toBe(3)
  })

  it('«Начать заново» из комнаты закрывает заход попыткой и убирает метку', async () => {
    holdAttempt('pro', { score: 3000, hits: 20, spawned: 30 }, 2)
    holdSession('pro', { cycle: 3, attempt: 1, runs: 1, totals: { score: 3000, hits: 20, spawned: 30 } }, 2)

    render(<RoomScreen day={2} />)
    fireEvent.click(screen.getByTestId('room-day-2'))
    fireEvent.click(screen.getByTestId('session-resume-restart'))

    const { attemptsUsed } = await import('../game/day.js')
    expect(attemptsUsed('pro', 2)).toBe(1)
    expect(stateOf(2)).not.toBe('started')
  })
})
