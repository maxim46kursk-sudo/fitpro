// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import LevelSelectScreen from './LevelSelectScreen.jsx'
import {
  CONTACT_URL,
  DAYS,
  FREE_DAYS,
  UNLOCK_CODE,
  advanceDay,
  completeDay,
  currentDay,
  isUnlocked,
  resetProgress,
  unlock,
} from '../game/challenge.js'
import { submitAttempt } from '../game/day.js'

/**
 * ПЕРЕХОД МЕЖДУ ДНЯМИ — по воле человека, а не по факту сессии.
 *
 * Раньше день двигала первая же завершённая сессия, и оставшиеся попытки
 * сгорали: прошедший день слабо оказывался наказан за то, что дошёл до конца.
 * Теперь сдача только открывает дверь, а входит в неё человек сам.
 */

afterEach(cleanup)

/** Пройти челлендж до названного дня так, как его проходит человек. */
function walkTo(day) {
  for (let n = 1; n < day; n += 1) {
    completeDay(n)
    advanceDay()
  }
}

beforeEach(() => {
  localStorage.clear()
  resetProgress()
})

describe('кнопка перехода к следующему дню', () => {
  it('дня не сдал — кнопки нет вовсе', () => {
    render(<LevelSelectScreen challengeDay={1} />)
    expect(screen.queryByTestId('advance-day')).toBeNull()
    expect(screen.getByTestId('level-pro')).toBeTruthy()
  })

  it('день сдан — кнопка есть, но уровни играются дальше', () => {
    /**
     * Это и есть суть правки: до нажатия оставшиеся попытки при человеке, и
     * он может улучшить результат дня.
     */
    completeDay(1)
    const onPick = vi.fn()
    render(<LevelSelectScreen challengeDay={1} onPick={onPick} />)

    expect(screen.getByTestId('advance-day').textContent).toBe(
      'День 1 сдан — перейти к дню 2',
    )
    act(() => screen.getByTestId('level-pro').click())
    expect(onPick).toHaveBeenCalledWith('pro')
  })

  it('нажатие двигает день и обновляет весь экран разом', () => {
    // на первом дне что-то набрано; на втором ещё ничего — и попытки целы
    submitAttempt('pro', { score: 4000 }, 1)
    completeDay(1)
    const onAdvance = vi.fn()
    render(<LevelSelectScreen challengeDay={1} onAdvance={onAdvance} />)

    expect(screen.getByTestId('day-total').textContent).toContain('4000')

    act(() => screen.getByTestId('advance-day').click())

    expect(currentDay()).toBe(2)
    expect(onAdvance).toHaveBeenCalledWith(2)
    expect(screen.getByTestId('challenge-day').textContent).toContain('День 2 из 30')
    // день сменился — попытки и сумма дня с ним, а сумма челленджа осталась
    expect(screen.getByTestId('day-total').textContent).toContain('0')
    expect(screen.getByTestId('challenge-total').textContent).toContain('4000')
    // и кнопка исчезла: новый день ещё не сдан
    expect(screen.queryByTestId('advance-day')).toBeNull()
  })

  it('на тридцатом дне кнопка завершает челлендж', () => {
    walkTo(DAYS)
    completeDay(DAYS)
    render(<LevelSelectScreen challengeDay={DAYS} />)
    expect(screen.getByTestId('advance-day').textContent).toBe('Завершить челлендж')
  })

  it('пройденный челлендж — строка вместо кнопки', () => {
    walkTo(DAYS)
    completeDay(DAYS)
    // последний шаг человек делает сам, как и все двадцать девять предыдущих
    render(<LevelSelectScreen challengeDay={DAYS} />)
    act(() => screen.getByTestId('advance-day').click())

    expect(screen.getByTestId('challenge-done').textContent).toBe('Челлендж пройден!')
    expect(screen.queryByTestId('advance-day')).toBeNull()
  })
})

describe('пять бесплатных дней', () => {
  /**
   * Граница блокирует ТРЕНИРОВКУ, а не переход: человек, дошедший до шестого
   * дня, должен увидеть свои цифры и предложение продолжить, а не тупик на
   * пятом. Ничего при этом не отнимается — комната открыта, набранное на месте.
   */
  it('пятый день играется без всякого кода', () => {
    expect(FREE_DAYS).toBe(5)
    render(<LevelSelectScreen challengeDay={5} />)

    expect(screen.getByTestId('level-pro')).toBeTruthy()
    expect(screen.queryByTestId('free-wall')).toBeNull()
  })

  it('шестой день без кода — плашка с личными цифрами вместо уровней', () => {
    submitAttempt('pro', { score: 4000, hits: 100, spawned: 200, reactMs: 800 }, 1)
    submitAttempt('pro', { score: 1000, hits: 50, spawned: 100, reactMs: 600 }, 2)
    render(<LevelSelectScreen challengeDay={6} onRoom={() => {}} />)

    expect(screen.queryByTestId('level-pro')).toBeNull()
    expect(screen.getByTestId('free-wall')).toBeTruthy()
    // его собственные цифры, а не список того, чего он лишён
    expect(screen.getByTestId('wall-total').textContent).toContain('5000')
    expect(screen.getByTestId('wall-best').textContent).toContain('4000')
    expect(screen.getByTestId('wall-best').textContent).toContain('1-й')
    expect(screen.getByTestId('wall-react').textContent).toContain('733 мс')
    expect(screen.getByTestId('free-wall').textContent).toContain('впереди ещё 25 дней')
  })

  it('набранное и комната остаются при человеке', () => {
    submitAttempt('novice', { score: 300 }, 6)
    render(<LevelSelectScreen challengeDay={6} onRoom={() => {}} />)

    expect(screen.getByTestId('day-total').textContent).toContain('300')
    expect(screen.getByTestId('challenge-total').textContent).toContain('300')
    expect(screen.getByTestId('open-room')).toBeTruthy()
  })

  it('кнопки «написать тренеру» нет, пока нет ссылки', () => {
    // мёртвая кнопка, ведущая никуда, хуже её отсутствия
    expect(CONTACT_URL).toBe('')
    render(<LevelSelectScreen challengeDay={6} />)
    expect(screen.queryByTestId('wall-contact')).toBeNull()
  })

  it('с кодом активации шестой день играется', () => {
    expect(unlock(UNLOCK_CODE)).toBe(true)
    render(<LevelSelectScreen challengeDay={6} />)

    expect(screen.getByTestId('level-pro')).toBeTruthy()
    expect(screen.queryByTestId('free-wall')).toBeNull()
  })

  it('чужой код не открывает ничего', () => {
    expect(unlock('нет')).toBe(false)
    expect(unlock('')).toBe(false)
    expect(isUnlocked()).toBe(false)
    render(<LevelSelectScreen challengeDay={6} />)
    expect(screen.getByTestId('free-wall')).toBeTruthy()
  })

  it('переход на шестой день не заблокирован — иначе был бы тупик', () => {
    /**
     * Блокируется тренировка, а не движение вперёд: человек должен ДОЙТИ до
     * плашки со своими результатами, а не упереться в неработающую кнопку на
     * пятом дне и решить, что игра сломалась.
     */
    walkTo(5)
    completeDay(5)
    const onAdvance = vi.fn()
    render(<LevelSelectScreen challengeDay={5} onAdvance={onAdvance} />)

    act(() => screen.getByTestId('advance-day').click())

    expect(currentDay()).toBe(6)
    expect(onAdvance).toHaveBeenCalledWith(6)
    expect(screen.getByTestId('free-wall')).toBeTruthy()
  })
})

describe('суммы и правила на экране', () => {
  it('сумма челленджа складывает все дни, сумма дня — только текущий', () => {
    submitAttempt('pro', { score: 4000 }, 1)
    submitAttempt('novice', { score: 500 }, 2)
    render(<LevelSelectScreen challengeDay={2} />)

    expect(screen.getByTestId('day-total').textContent).toContain('500')
    expect(screen.getByTestId('challenge-total').textContent).toContain('4500')
  })

  it('в комнату можно зайти прямо от итогов', () => {
    // сюда идут именно от цифры «за челлендж»: увидел сумму — захотел
    // посмотреть, из чего она собралась
    const onRoom = vi.fn()
    render(<LevelSelectScreen challengeDay={1} onRoom={onRoom} />)
    act(() => screen.getByTestId('open-room').click())
    expect(onRoom).toHaveBeenCalled()
  })

  it('правила названы полностью — их читают перед первой попыткой', () => {
    render(<LevelSelectScreen challengeDay={1} />)
    const note = document.querySelector('.mt-levels__note').textContent

    expect(note).toContain('До 3 попыток на уровень, в зачёт — лучшая')
    expect(note).toContain('Итог дня — сумма по уровням')
    // главное про необратимость — человек должен прочесть это ДО нажатия
    expect(note).toContain('Перешёл к следующему дню — прошлый закрыт')
  })
})

/**
 * ПОПЫТКИ — ЭТО ПРАВИЛО ЗАЧЁТА, И ГОВОРИТЬ О НЁМ НАДО ТОЛЬКО ТЕМ, КОГО ОНО
 * КАСАЕТСЯ.
 *
 * Гость играет вне зачёта: его заход не сдаёт день и не растит сумму
 * челленджа, пока нет аккаунта. Счётчик «попытка 2 из 3» обещал бы ему
 * ограничение, которого нет, а погасший уровень был бы прямым запретом играть
 * там, где запрещать нечего.
 *
 * САМ ЗАЧЁТ ПРИ ЭТОМ НЕ МЕНЯЕТСЯ. Лимит трёх попыток по-прежнему стоит на
 * записи (`submitAttempt`) — в том числе когда сыгранное гостем переезжает в
 * новый аккаунт. Меняется только то, что человеку показывают.
 */
describe('счётчик попыток виден участнику челленджа, и только ему', () => {
  it('участнику — попытки и правило трёх на месте', () => {
    render(<LevelSelectScreen challengeDay={1} challengeMember />)

    expect(document.querySelector('.mt-level__attempts').textContent).toContain('попытка 1 из 3')
    expect(document.querySelector('.mt-levels__note')).toBeTruthy()
  })

  it('вне челленджа — ни счётчика, ни правила, ни слова «попытки»', () => {
    render(<LevelSelectScreen challengeDay={1} challengeMember={false} />)

    expect(document.querySelector('.mt-level__attempts')).toBeNull()
    expect(document.querySelector('.mt-levels__note')).toBeNull()
    expect(document.body.textContent).not.toContain('попыт')
  })

  it('лучший результат вне челленджа показывается по-прежнему', () => {
    submitAttempt('pro', { score: 700 }, 1)
    render(<LevelSelectScreen challengeDay={1} challengeMember={false} />)

    const pro = screen.getByTestId('level-pro')
    expect(pro.querySelector('.mt-level__best').textContent).toContain('лучший 700')
  })

  it('участнику три сыгранные попытки гасят уровень', () => {
    for (let i = 0; i < 3; i += 1) submitAttempt('pro', { score: 100 + i }, 1)
    render(<LevelSelectScreen challengeDay={1} challengeMember />)

    const pro = screen.getByTestId('level-pro')
    expect(pro.disabled).toBe(true)
    expect(pro.querySelector('.mt-level__attempts').textContent).toContain('попытки кончились')
  })

  /** Главное в этом наборе: играть дальше вне зачёта никто не мешает. */
  it('ВНЕ ЧЕЛЛЕНДЖА уровень не гаснет и после трёх — играть можно дальше', () => {
    for (let i = 0; i < 3; i += 1) submitAttempt('pro', { score: 100 + i }, 1)
    const onPick = vi.fn()
    render(<LevelSelectScreen challengeDay={1} challengeMember={false} onPick={onPick} />)

    expect(screen.getByTestId('level-pro').disabled).toBe(false)
    act(() => screen.getByTestId('level-pro').click())
    expect(onPick).toHaveBeenCalledWith('pro')
  })

  it('по умолчанию экран считает человека участником — прежнее поведение', () => {
    render(<LevelSelectScreen challengeDay={1} />)
    expect(document.querySelector('.mt-level__attempts')).toBeTruthy()
  })
})
