// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ResultScreen from './ResultScreen.jsx'
import { attemptsUsed, bestFor, dayTotal, submitAttempt } from '../game/day.js'

/**
 * Экран результата — единственное место, где попытка записывается в день.
 * Тесты day.js проверяют арифметику зачёта, а здесь — что экран её и правда
 * применяет: цифры на экране и запись на устройстве.
 */

/** Автозапуск подписывается на кадры — в тесте их просто нет. */
const subscribe = () => () => {}

const gameStats = (extra = {}) => ({
  reps: 0,
  seconds: 180,
  score: 5000,
  cleared: 18,
  obstacles: 20,
  best: 5000,
  tier: 'novice',
  tierName: 'НОВИЧОК',
  attempt: 1,
  ...extra,
})

const show = (stats) =>
  render(<ResultScreen stats={stats} subscribe={subscribe} onRestart={() => {}} onExit={() => {}} />)

beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)

describe('итог раунда: попытка уходит в зачёт дня', () => {
  it('первая попытка записывается и становится лучшей', () => {
    show(gameStats())

    expect(attemptsUsed('novice')).toBe(1)
    expect(bestFor('novice')).toBe(5000)
    expect(dayTotal()).toBe(5000)
    expect(screen.getByTestId('day-score').textContent).toContain('5000')
  })

  it('уровень и номер попытки видны на экране', () => {
    show(gameStats({ attempt: 2 }))

    const tier = screen.getByTestId('result-tier').textContent
    expect(tier).toContain('НОВИЧОК')
    expect(tier).toContain('попытка 2')
  })

  it('слабая вторая попытка зачёт не портит', () => {
    submitAttempt('novice', 5000)
    show(gameStats({ score: 900, attempt: 2 }))

    expect(bestFor('novice')).toBe(5000)
    expect(dayTotal()).toBe(5000)
  })

  it('сумма дня складывается по трём уровням', () => {
    submitAttempt('experienced', 2000)
    submitAttempt('pro', 3000)
    show(gameStats({ score: 1000 }))

    expect(screen.getByTestId('day-score').textContent).toContain('6000')
    expect(dayTotal()).toBe(6000)
  })

  it('попытка записывается ровно один раз, а не на каждую перерисовку', () => {
    const view = show(gameStats())
    view.rerender(
      <ResultScreen
        stats={gameStats()}
        subscribe={subscribe}
        onRestart={() => {}}
        onExit={() => {}}
      />,
    )

    expect(attemptsUsed('novice')).toBe(1)
  })

  it('сверх лимита балл в зачёт не идёт, и об этом сказано', () => {
    // лимит — три попытки на уровень за день челленджа (правила владельца)
    submitAttempt('pro', 4000)
    submitAttempt('pro', 4200)
    submitAttempt('pro', 3900)
    show(gameStats({ tier: 'pro', tierName: 'ПРОФИ', score: 9999, attempt: 4 }))

    expect(bestFor('pro')).toBe(4200)
    expect(screen.getByText(/Попытки на этом уровне сегодня кончились/)).toBeTruthy()
  })

  it('вердиктов автопрогрессии больше нет', () => {
    show(gameStats())
    expect(screen.queryByTestId('level-verdict')).toBeNull()
  })

  it('на обычном подходе про уровень ничего нет', () => {
    show({ reps: 12, seconds: 60 })

    expect(screen.queryByTestId('result-tier')).toBeNull()
    expect(screen.queryByTestId('day-score')).toBeNull()
    // и ничего не записано: день челленджа — только про игру
    expect(dayTotal()).toBe(0)
  })
})
