// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import StreamRoom, { dayState, readStreamRoom, todayNutrition } from './StreamRoom.jsx'
import { completeDay, resetProgress } from '../game/challenge.js'
import { MAX_ATTEMPTS, holdSession, resetDay, submitAttempt } from '../game/day.js'

/**
 * КОМНАТА УЧАСТНИКА — РАБОЧЕЕ МЕСТО, А НЕ КВИТАНЦИЯ.
 *
 * Проверяется здесь ровно то, из-за чего комнату и переделывали, и каждая
 * проверка отвечает на живую поломку, найденную на проде 25.08:
 *
 *   1) начать день из комнаты было НЕВОЗМОЖНО — кнопки старта не было ни одной;
 *   2) кнопка «Понятно» выбрасывала человека на список программ;
 *   3) поздравление с оплатой висело заголовком у того, чей поток уже идёт;
 *   4) питание писало «меньше 3 приёмов» — внутреннее правило зачёта наружу.
 *
 * И два правила зачёта, которые экран обязан показывать честно: три захода на
 * день и пропущенный день, который не открывается задним числом.
 */

afterEach(cleanup)

const ENTRY = { id: 7, participant_no: 24, display_name: 'Пётр Петров', paid_at: '2026-08-24T10:00:00Z' }
/** Старт такой, что «сегодня» — пятый день потока. */
const STARTS_ON = '2026-08-21'
const TODAY = 5

/** Сырьё challenge_nutrition_facts: тридцать дней без единого процента. */
const facts = (days) => Array.from({ length: 30 }, (_, i) => ({
  day: i + 1,
  kcal: days[i]?.kcal ?? 0,
  p: days[i]?.p ?? 0,
  f: days[i]?.f ?? 0,
  c: days[i]?.c ?? 0,
  meals: days[i]?.meals ?? 0,
  norm_kcal: 2000,
  norm_p: 120,
  norm_f: 65,
  norm_c: 220,
}))

/** Сырьё challenge_standings: участник × день. */
const standingRows = (people) => people.flatMap((p) =>
  Array.from({ length: 30 }, (_, i) => ({
    participant_no: p.no,
    display_name: p.name,
    is_me: !!p.me,
    days_done: p.daysDone ?? 0,
    day: i + 1,
    best_score: i === 0 ? p.movement ?? 0 : 0,
    kcal: 0, p: 0, f: 0, c: 0, meals: 0,
    norm_kcal: 2000, norm_p: 120, norm_f: 65, norm_c: 220,
  })))

const room = (props = {}) => render(
  <StreamRoom entry={ENTRY} today={TODAY} startsOn={STARTS_ON} {...props} />,
)

beforeEach(() => {
  localStorage.clear()
  resetProgress()
  resetDay()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('кнопка старта: комната — точка входа в тренировку', () => {
  it('главная кнопка называет СЕГОДНЯШНИЙ день и запускает именно его', () => {
    const onStartDay = vi.fn()
    room({ onStartDay })

    expect(screen.getByTestId('stream-day').textContent).toBe('День 5 из 30')
    expect(screen.getByTestId('stream-start').textContent).toBe('Начать день 5')
    act(() => screen.getByTestId('stream-start').click())
    expect(onStartDay).toHaveBeenCalledTimes(1)
  })

  it('незакрытый заход — «Продолжить», и продолжается ТА ЖЕ сессия', () => {
    // сессию бросили на третьем круге: спрашивать уровень заново значило бы
    // дать сменить его в середине дня
    holdSession('pro', { cycle: 3, attempt: 1, runs: 1, totals: { score: 120, hits: 10, spawned: 14 } }, TODAY)
    const onResume = vi.fn()
    const onStartDay = vi.fn()
    room({ onResume, onStartDay })

    expect(screen.getByTestId('stream-start').textContent).toBe('Продолжить день 5')
    act(() => screen.getByTestId('stream-start').click())
    expect(onStartDay).not.toHaveBeenCalled()
    expect(onResume).toHaveBeenCalledWith('pro', { resume: expect.objectContaining({ tier: 'pro' }) })
  })

  it('после трёх заходов кнопка гаснет И ГОВОРИТ ПОЧЕМУ', () => {
    // молчащая серая кнопка читается как поломка приложения; человек обязан
    // узнать, что заходы кончились, а не гадать
    for (const score of [100, 300, 200]) submitAttempt('novice', score, TODAY)
    const onStartDay = vi.fn()
    room({ onStartDay })

    const button = screen.getByTestId('stream-start')
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('кончились')
    act(() => button.click())
    expect(onStartDay).not.toHaveBeenCalled()

    const why = screen.getByTestId('stream-start-why').textContent
    expect(why).toContain('Три захода')
    // в зачёт пошёл лучший, а не последний
    expect(why).toContain('300')
  })

  it('заходы считаются на день, а не на уровень', () => {
    submitAttempt('novice', 100, TODAY)
    submitAttempt('pro', 100, TODAY)
    room({})
    expect(screen.getByTestId('stream-runs').textContent).toBe(`Осталось заходов: 1 из ${MAX_ATTEMPTS}`)
  })

  it('день не начат — «Осталось 3 из 3»', () => {
    room({})
    expect(screen.getByTestId('stream-runs').textContent).toBe('Осталось заходов: 3 из 3')
    expect(screen.getByTestId('stream-state').textContent).toBe('день не начат')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('выхода «в никуда» нет', () => {
  it('кнопки «Понятно» не существует — закрыть можно только крестиком', () => {
    const onExit = vi.fn()
    room({ onExit })

    expect(screen.getByTestId('stream-room').textContent).not.toContain('Понятно')
    const corners = document.querySelectorAll('.mt-corner')
    expect(corners.length).toBe(1)
    act(() => corners[0].click())
    expect(onExit).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('поздравление — полосой и один раз', () => {
  it('первый заход после покупки: полоса есть, заголовком она не становится', () => {
    const onGreetSeen = vi.fn()
    room({ greet: true, onGreetSeen })

    expect(screen.getByTestId('stream-greet').textContent).toContain('Оплата прошла')
    // но день по-прежнему главный: он стоит в шапке, а полоса — над ним
    expect(screen.getByTestId('stream-day').textContent).toBe('День 5 из 30')

    act(() => screen.getByTestId('stream-greet-close').click())
    expect(onGreetSeen).toHaveBeenCalled()
  })

  it('дальше комната открывается рабочим экраном дня, без слов про оплату', () => {
    room({ greet: false })
    expect(screen.queryByTestId('stream-greet')).toBeNull()
    expect(screen.getByTestId('stream-room').textContent).not.toContain('Оплата прошла')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('питание за сегодня: настоящие цифры и что делать', () => {
  /**
   * СЪЕДЕНО ВИДНО, А НЕ ТОЛЬКО «ОСТАЛОСЬ».
   *
   * Здесь стояли четыре сухие плитки с остатками: человек видел, сколько ему
   * ЕЩЁ надо, и не видел, сколько уже съел — ноль и две тысячи выглядели
   * одинаково. Теперь блок тот же, что в дневнике (src/DayMacros.jsx), и
   * проверяется именно это: обе половины на экране.
   */
  it('съеденное и норма — как в дневнике: «1500 из 2000 ккал»', () => {
    const rows = facts([{}, {}, {}, {}, { kcal: 1500, p: 90, f: 40, c: 150, meals: 3 }])
    room({ nutrition: rows })

    expect(screen.getByTestId('stream-macros-kcal').textContent).toBe('1500')
    expect(screen.getByTestId('stream-macros').textContent).toContain('из 2000 ккал')
    expect(screen.getByTestId('stream-macros-left').textContent).toBe('осталось 500 ккал')

    // и три шкалы: съедено, остаток, норма — по каждому показателю
    const белки = screen.getByTestId('stream-macros-p').textContent
    expect(белки).toContain('90 г')
    expect(белки).toContain('осталось 30 г')
    expect(белки).toContain('/ 120 г')
  })

  it('процент зачёта считает судья челленджа, а не заполненность шкалы', () => {
    // каждый показатель судится отдельно и усредняется: калории и белки по 70,
    // жиры 43, углеводы 56 — среднее 60. Недоел наказывается ровно как переел
    const rows = facts([{}, {}, {}, {}, { kcal: 1500, p: 90, f: 40, c: 150, meals: 3 }])
    room({ nutrition: rows })

    expect(screen.getByTestId('stream-nutri-pct').textContent).toBe('60%')
  })

  it('перебор показывается словом «перебор», а не отрицательным остатком', () => {
    const rows = facts([{}, {}, {}, {}, { kcal: 2600, p: 120, f: 65, c: 220, meals: 3 }])
    room({ nutrition: rows })

    expect(screen.getByTestId('stream-macros-left').textContent).toBe('перебор 600 ккал')
  })

  it('мало приёмов — говорим, ЧТО СДЕЛАТЬ, а не «меньше 3 приёмов»', () => {
    /**
     * Живая поломка: экран выворачивал наружу внутреннее правило зачёта, и
     * человек читал его как отказ. Правило не изменилось — изменилось то, что
     * ему говорят.
     */
    const rows = facts([{}, {}, {}, {}, { kcal: 900, p: 60, f: 30, c: 90, meals: 1 }])
    room({ nutrition: rows })

    const todo = screen.getByTestId('stream-nutri-todo').textContent
    expect(todo).toContain('Запиши приёмы пищи')
    expect(todo).toContain('засчитываем от 3')
    expect(todo).toContain('осталось 2')
    // и съеденное всё равно показано: человеку надо знать, сколько доесть
    expect(screen.getByTestId('stream-macros-kcal').textContent).toBe('900')
    expect(screen.getByTestId('stream-macros-left').textContent).toBe('осталось 1100 ккал')
  })

  it('кнопка ведёт в дневник, а не в норму', () => {
    const onOpenDiary = vi.fn()
    room({ nutrition: facts([]), onOpenDiary })
    act(() => screen.getByTestId('stream-diary').click())
    expect(onOpenDiary).toHaveBeenCalled()
  })

  it('нормы нет — зовём её завести, а не показываем нули', () => {
    const onFillNorm = vi.fn()
    room({ nutrition: facts([]), hasNorm: false, onFillNorm })

    expect(screen.queryByTestId('stream-nutri-pct')).toBeNull()
    act(() => screen.getByTestId('stream-fill-norm').click())
    expect(onFillNorm).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('остальное приложение', () => {
  it('числа приносит хозяин, комната их только показывает', () => {
    const onOpenWorkouts = vi.fn()
    const onOpenProgress = vi.fn()
    room({ app: { workouts7d: 3, lastWorkout: '24 августа' }, onOpenWorkouts, onOpenProgress })

    const card = screen.getByTestId('stream-app').textContent
    expect(card).toContain('Тренировок за неделю: 3')
    expect(card).toContain('24 августа')

    act(() => screen.getByTestId('stream-workouts').click())
    expect(onOpenWorkouts).toHaveBeenCalled()
    act(() => screen.getByTestId('stream-progress').click())
    expect(onOpenProgress).toHaveBeenCalled()
  })

  it('сводки не приехало — карточка не врёт числом', () => {
    room({ onOpenWorkouts: () => {} })
    expect(screen.getByTestId('stream-app').textContent).toContain('пока нет')
  })

  it('вести человека некуда — карточки нет вовсе', () => {
    room({})
    expect(screen.queryByTestId('stream-app')).toBeNull()
  })
})

describe('место в потоке', () => {
  it('«Ты N-й из M» — тем же судьёй, что и таблица', () => {
    const rows = standingRows([
      { no: 1, name: 'Аня', movement: 900 },
      { no: 24, name: 'Пётр Петров', me: true, movement: 500 },
      { no: 9, name: 'Игорь', movement: 100 },
    ])
    room({ standingsRows: rows })

    expect(screen.getByTestId('stream-place-value').textContent).toBe('2-й из 3')
  })

  it('таблица приехала пустой — прочерк вместо выдуманного места', () => {
    room({ standingsRows: [] })
    expect(screen.getByTestId('stream-place-value').textContent).toBe('—')
  })

  it('таблица ещё едет — так и говорим, а не рисуем прочерк', () => {
    // прочерк на месте своего места читается как «меня в таблице нет», а это
    // неправда: её просто не успели принести
    room({})
    expect(screen.getByTestId('stream-place-value').textContent).toBe('…')
    expect(screen.getByTestId('stream-place').textContent).toContain('Считаю таблицу')
  })

  it('кнопка открывает полную таблицу', () => {
    const onStandings = vi.fn()
    room({ standingsRows: [], onStandings })
    act(() => screen.getByTestId('stream-standings').click())
    expect(onStandings).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('календарь тридцати дней', () => {
  it('пропущенный день виден НУЛЁМ и не открывается', () => {
    /**
     * Ноль — это результат, который пойдёт в зачёт, а не пустое место. Человек
     * должен видеть цену пропуска, а не догадываться о ней. И открыть такой
     * день нельзя: задним числом он не играется.
     */
    submitAttempt('novice', 250, 2)     // день 2 сыгран
    room({})

    const missed = screen.getByTestId('stream-cell-3')
    expect(missed.dataset.state).toBe('missed')
    expect(missed.textContent).toContain('0')
    expect(missed.tagName).toBe('DIV')      // не кнопка: нажимать не на что

    const played = screen.getByTestId('stream-cell-2')
    expect(played.dataset.state).toBe('done')
    expect(played.tagName).toBe('BUTTON')
  })

  it('сегодняшний помечен, будущие под замком', () => {
    room({})
    expect(screen.getByTestId('stream-cell-5').dataset.state).toBe('now')
    const future = screen.getByTestId('stream-cell-6')
    expect(future.dataset.state).toBe('future')
    expect(future.textContent).toContain('🔒')
    expect(future.tagName).toBe('DIV')
  })

  it('тап по сданному дню открывает его сводку', () => {
    submitAttempt('novice', 250, 2)
    completeDay(2, new Date(), 2)
    room({})

    expect(screen.queryByTestId('stream-day-summary')).toBeNull()
    act(() => screen.getByTestId('stream-cell-2').click())

    const summary = screen.getByTestId('stream-day-summary')
    expect(summary.textContent).toContain('День 2')
    expect(screen.getByTestId('stream-day-score').textContent).toContain('250')
    expect(summary.textContent).toContain('собран за 2 захода')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('очки', () => {
  it('за сегодня — лучший заход дня, за поток — сумма лучших по дням', () => {
    submitAttempt('novice', 100, 4)
    submitAttempt('novice', 300, 5)
    submitAttempt('novice', 120, 5)
    room({})

    expect(screen.getByTestId('stream-today-score').textContent).toContain('300')
    expect(screen.getByTestId('stream-total').textContent).toContain('400')
    expect(screen.getByTestId('stream-best').textContent).toContain('300')
  })

  /**
   * ПОКАЗАТЕЛИ ПРИЕХАЛИ ИЗ СТАРОЙ «МОЕЙ КОМНАТЫ». Участнику она больше не
   * показывается — комната у него одна, — и потерять вместе с ней реакцию с
   * точностью значило бы отнять ответ на «а меняюсь ли я вообще»: очки за месяц
   * могут стоять на месте, а эти два числа — нет.
   */
  it('реакция и точность за поток — взвешенно по попаданиям', () => {
    submitAttempt('novice', { score: 100, hits: 10, spawned: 20, reactMs: 500 }, 4)
    submitAttempt('novice', { score: 300, hits: 40, spawned: 60, reactMs: 300 }, 5)
    room({})

    // (500×10 + 300×40) / 50 = 340: заход с четырьмя случайными попаданиями не
    // должен весить столько же, сколько отработанные двадцать минут
    expect(screen.getByTestId('stream-react').textContent).toContain('340 мс')
    expect(screen.getByTestId('stream-accuracy').textContent).toContain('63%')
    expect(screen.getByTestId('stream-accuracy').textContent).toContain('50 из 80')
  })

  it('мишеней ещё не было — прочерк, а не деление на ноль', () => {
    room({})
    expect(screen.getByTestId('stream-react').textContent).toContain('—')
    expect(screen.getByTestId('stream-accuracy').textContent).toContain('мишеней ещё не было')
  })

  it('результат не уехал наверх — человек узнаёт об этом здесь', () => {
    // он смотрит на свой счёт и считает, что судья видит то же самое
    room({ pushFailed: true })
    expect(screen.getByTestId('stream-unsent').textContent).toContain('Результат не отправлен')
  })

  it('человек без единого захода не видит ни одного NaN', () => {
    room({ nutrition: facts([]), standingsRows: [] })
    expect(screen.getByTestId('stream-room').textContent).not.toContain('NaN')
    expect(screen.getByTestId('stream-today-score').textContent).toContain('—')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('чистые функции комнаты', () => {
  it('состояние дня: потраченные заходы сильнее всего остального', () => {
    expect(dayState({ left: 0, used: 3, done: true, resume: { tier: 'pro' } })).toBe('spent')
    expect(dayState({ left: 2, used: 1, done: false, resume: { tier: 'pro' } })).toBe('started')
    expect(dayState({ left: 2, used: 1, done: true, resume: null })).toBe('done')
    expect(dayState({ left: 2, used: 1, done: false, resume: null })).toBe('partial')
    expect(dayState({ left: 3, used: 0, done: false, resume: null })).toBe('idle')
  })

  it('чтение комнаты не падает на пустом хранилище', () => {
    const value = readStreamRoom(1)
    expect(value.rows.length).toBe(30)
    expect(value.left).toBe(MAX_ATTEMPTS)
    expect(value.total).toBe(0)
    expect(value.best).toEqual({ day: 0, total: 0 })
  })

  it('питание за день, которого нет в сырье, — null, а не ноль', () => {
    expect(todayNutrition([], 5)).toBe(null)
    expect(todayNutrition(null, 5)).toBe(null)
    expect(todayNutrition(facts([]), 99)).toBe(null)
  })
})
