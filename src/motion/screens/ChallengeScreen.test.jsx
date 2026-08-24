// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import ChallengeScreen from './ChallengeScreen.jsx'

/**
 * ЭКРАН ЧЕЛЛЕНДЖА — ТРИ РАЗНЫХ ЧЕЛОВЕКА, ТРИ РАЗНЫХ РАЗГОВОРА.
 *
 * Не участник спрашивает «что это и почём», участник — «какой у меня номер и
 * когда старт», гость — ни то ни другое: ему сперва нужен аккаунт, и билет
 * привязывать пока не к чему.
 *
 * Перепутать их дорого в обе стороны. Показать оплатившему кнопку «Купить
 * билет» значит предложить заплатить второй раз за то же самое; показать гостю
 * форму оплаты — взять деньги за место, которое некому записать.
 */

afterEach(cleanup)

const SEASON = {
  id: 1,
  title: 'Поток 1',
  starts_on: null,
  price_rub: 2990,
  prize_pct: 50,
  prize_split: [50, 30, 20],
  status: 'open',
}

const ENTRY = { id: 7, participant_no: 7, display_name: 'Пётр Петров', paid_at: '2026-08-24T10:00:00Z' }
/** Правила прочитаны и согласие лежит на сервере — только тогда открыта покупка. */
const ACCEPTED = '2026-08-24T09:00:00Z'

describe('не участник: чем дело кончится и почём', () => {
  it('видит цену, правило фонда и кнопку покупки', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null, rulesAcceptedAt: ACCEPTED }} />)

    expect(screen.getByTestId('challenge-price').textContent).toContain('2990')
    const prize = screen.getByTestId('challenge-prize').textContent
    expect(prize).toContain('50%')
    expect(prize).toContain('50 / 30 / 20')
    expect(screen.getByTestId('challenge-buy')).toBeTruthy()
    // чужого номера участника у него нет и быть не может
    expect(screen.queryByTestId('challenge-number')).toBeNull()
  })

  it('цена берётся из сезона, а не из кода', () => {
    // цену объявляет поток: у следующего она может быть другой, и экран обязан
    // называть ту, на которой человека набирают сейчас
    render(<ChallengeScreen state={{ season: { ...SEASON, price_rub: 4500 }, entry: null }} />)
    expect(screen.getByTestId('challenge-price').textContent).toContain('4500')
  })

  it('нажатие ведёт к оплате, а «уже участник» перечитывает состояние', () => {
    const onBuy = vi.fn().mockResolvedValue({ already: true })
    const onRefresh = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null, rulesAcceptedAt: ACCEPTED }} onBuy={onBuy} onRefresh={onRefresh} />)

    act(() => screen.getByTestId('challenge-buy').click())
    return Promise.resolve().then(() => {
      expect(onBuy).toHaveBeenCalled()
      expect(onRefresh).toHaveBeenCalled()
    })
  })

  it('не читал правил — вместо покупки дорога в правила', () => {
    /**
     * Заплатить, не увидев правил, отсюда нельзя: спор о призах упирается в
     * «я не знал», и ответ на это должен появиться до денег, а не после.
     */
    const onRules = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null, rulesAcceptedAt: null }} onRules={onRules} />)

    expect(screen.queryByTestId('challenge-buy')).toBeNull()
    act(() => screen.getByTestId('challenge-read-rules').click())
    expect(onRules).toHaveBeenCalledWith({ gate: true })
  })

  it('перечитать правила можно всегда и свободно', () => {
    const onRules = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: ENTRY, rulesAcceptedAt: ACCEPTED }} onRules={onRules} />)

    act(() => screen.getByTestId('challenge-rules').click())
    expect(onRules).toHaveBeenCalledWith({ gate: false })
  })

  it('живого потока нет — говорим прямо, а не показываем кнопку в никуда', () => {
    render(<ChallengeScreen state={null} />)

    expect(screen.getByTestId('challenge-closed')).toBeTruthy()
    expect(screen.queryByTestId('challenge-buy')).toBeNull()
    expect(screen.queryByTestId('challenge-price')).toBeNull()
  })
})

describe('участник: свой номер, а не предложение купить', () => {
  it('видит номер, имя и день', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: ENTRY }} day={12} days={30} />)

    expect(screen.getByTestId('challenge-number').textContent).toContain('7')
    expect(screen.getByTestId('challenge-name').textContent).toContain('Пётр Петров')
    expect(screen.getByTestId('challenge-day').textContent).toContain('День 12 из 30')
    // главное: второй раз купить ему не предлагают
    expect(screen.queryByTestId('challenge-buy')).toBeNull()
    expect(screen.queryByTestId('challenge-price')).toBeNull()
  })

  it('дата старта не объявлена — так и написано', () => {
    // пустое поле здесь состояние потока, а не недоделка: человек заплатил и
    // первым делом спрашивает, когда начинаем
    render(<ChallengeScreen state={{ season: SEASON, entry: ENTRY }} />)
    expect(screen.getByTestId('challenge-start').textContent).toContain('будет объявлена')
  })

  it('дата объявлена — показывается по-русски', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: '2026-09-01' }, entry: ENTRY }} />)
    expect(screen.getByTestId('challenge-start').textContent).toContain('1 сентября')
  })

  it('имя берётся из записи, а не из профиля', () => {
    // имя снято в момент покупки: переименовался человек — итоги прошлого
    // потока не переписываются, и удаление аккаунта не делает строку безымянной
    render(<ChallengeScreen state={{ season: SEASON, entry: { ...ENTRY, display_name: 'Участник 7' } }} />)
    expect(screen.getByTestId('challenge-name').textContent).toBe('Участник 7')
  })
})

describe('гость: аккаунт, а не оплата', () => {
  it('вместо оплаты — предложение аккаунта, а цена при этом видна', () => {
    /**
     * Цену от гостя не прячем: это тот самый довод, ради которого он и
     * заглянул, — так же устроен экран тарифов. Отличается ровно кнопка.
     */
    const onCreateAccount = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest onCreateAccount={onCreateAccount} />)

    expect(screen.getByTestId('challenge-signup')).toBeTruthy()
    expect(screen.queryByTestId('challenge-buy')).toBeNull()
    expect(screen.getByTestId('challenge-price').textContent).toContain('2990')

    act(() => screen.getByTestId('challenge-signup').click())
    expect(onCreateAccount).toHaveBeenCalled()
  })

  it('без сезона у гостя тоже только аккаунт', () => {
    render(<ChallengeScreen state={null} guest />)
    expect(screen.getByTestId('challenge-signup')).toBeTruthy()
    expect(screen.queryByTestId('challenge-buy')).toBeNull()
  })
})
