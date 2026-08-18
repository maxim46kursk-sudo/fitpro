// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SessionProgress from './SessionProgress.jsx'

/**
 * Полоса прогресса сессии. Проверяется ровно то, ради чего она заведена:
 * человек в любой момент видит, на каком он круге и сколько всего, — и видит
 * это на слабом телефоне тоже.
 */

afterEach(cleanup)

describe('полоса прогресса', () => {
  it('называет круг и общее число кругов словами, а не дробью', () => {
    render(<SessionProgress cycle={3} cycles={7} />)
    expect(screen.getByTestId('session-cycle').textContent).toBe('КРУГ 3 из 7')
  })

  it('сегментов ровно столько, сколько кругов сегодня', () => {
    /**
     * Число кругов зависит от дня челленджа: на тяжёлых их восемь. Полоса
     * обязана показывать сегодняшнее расписание, а не «примерно столько».
     */
    const { container } = render(<SessionProgress cycle={2} cycles={8} />)
    expect(container.querySelectorAll('.mt-sprog__seg')).toHaveLength(8)
    // пройденные, текущий и будущие — три разных состояния
    expect(container.querySelectorAll('.mt-sprog__seg.is-done')).toHaveLength(1)
    expect(container.querySelectorAll('.mt-sprog__seg.is-now')).toHaveLength(1)
  })

  it('в экономном режиме остаётся только текст', () => {
    /**
     * Знание, на каком ты круге, — не украшение, и терять его из-за слабого
     * телефона нельзя. Теряются сегменты и свечение, текст остаётся.
     */
    const { container } = render(<SessionProgress cycle={4} cycles={7} cheap />)
    expect(screen.getByTestId('session-cycle').textContent).toBe('КРУГ 4 из 7')
    expect(container.querySelectorAll('.mt-sprog__seg')).toHaveLength(0)
  })

  it('вне сессии полосы нет вовсе', () => {
    // одиночный раунд по ?round=1 кругов не знает — и врать про них не должен
    const { container } = render(<SessionProgress cycle={1} cycles={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('круг не вылезает за расписание, чем бы его ни кормили', () => {
    render(<SessionProgress cycle={99} cycles={7} />)
    expect(screen.getByTestId('session-cycle').textContent).toBe('КРУГ 7 из 7')
  })
})
