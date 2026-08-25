// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ChallengeScreen, { PRIZES } from './ChallengeScreen.jsx'
import { moscowDate } from '../game/challenge.js'

/**
 * СТРАНИЦА ЧЕЛЛЕНДЖА — ВИТРИНА, ПО КОТОРОЙ РЕШАЮТ, ПЛАТИТЬ ЛИ.
 *
 * Проверяется не вёрстка, а то, что нельзя перепутать: гостю не показывают
 * оплату (но цену показывают — это довод, ради которого он и заглянул), кнопка
 * не работает без галочки, участник попадает в комнату и больше не видит
 * предложения купить, а деньги и даты нигде не зашиты в разметку.
 */

afterEach(cleanup)

const SEASON = {
  id: 1,
  title: 'Поток 1',
  starts_on: '2026-09-10',
  price_rub: 2990,
  prize_pct: 50,
  prize_split: [50, 30, 20],
  status: 'open',
}

const ENTRY = {
  id: 7,
  participant_no: 24,
  display_name: 'Пётр Петров',
  paid_at: '2026-08-24T10:00:00Z',
}

/** Текст всей страницы: так его читает человек, без разбора вёрстки. */
const pageText = () => screen.getByTestId('challenge-screen').textContent

describe('не участник: цена, правила и вступление на одной странице', () => {
  it('цена, доля фонда и делёж берутся из сезона, а не из разметки', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, price_rub: 4500, prize_pct: 40, prize_split: [60, 25, 15] }, entry: null }} />)

    expect(screen.getByTestId('challenge-price').textContent).toContain('4')
    expect(screen.getByTestId('challenge-price').textContent).toContain('500')
    expect(screen.getByTestId('challenge-prize-pct').textContent).toContain('40%')
    const split = screen.getByTestId('challenge-split').textContent
    expect(split).toContain('60%')
    expect(split).toContain('25%')
    expect(split).toContain('15%')
  })

  it('дата старта — из сезона: и в шапке, и в подписи под кнопкой', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} />)

    expect(screen.getByTestId('challenge-tag').textContent).toContain('10 сентября')
    expect(pageText()).toContain('Старт потока — 10 сентября')
  })

  it('даты нет — так и написано, вместо пустого места', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: null }, entry: null }} />)
    expect(screen.getByTestId('challenge-tag').textContent).toContain('дата будет объявлена')
  })

  it('правила — раздел этой же страницы, а не отдельный экран', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} />)

    const rules = screen.getByTestId('challenge-rules').textContent
    expect(rules).toContain('Норма замораживается в день старта')
    expect(rules).toContain('В первый день потока играется первый день')
    expect(rules).toContain('Дневник питания — на твоей совести')
  })

  it('гарантированные призы и их сумма — из одного места', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} />)
    const total = PRIZES.reduce((s, p) => s + p.value, 0)

    expect(total).toBe(59970)
    expect(screen.getByTestId('challenge-prizes-total').textContent).toContain('970')
    expect(pageText()).toContain('VIP-пакет')
  })

  it('кнопка вступления не работает, пока не стоит галочка', () => {
    const onJoin = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} onJoin={onJoin} />)

    const join = screen.getByTestId('challenge-join')
    expect(join.disabled).toBe(true)
    expect(join.textContent).toContain('990')
    act(() => join.click())
    expect(onJoin).not.toHaveBeenCalled()
  })

  it('галочка включает кнопку, и она зовёт вступление', async () => {
    const onJoin = vi.fn().mockResolvedValue({ ok: true })
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} onJoin={onJoin} />)

    fireEvent.click(screen.getByTestId('challenge-agree'))
    expect(screen.getByTestId('challenge-join').disabled).toBe(false)

    await act(async () => screen.getByTestId('challenge-join').click())
    expect(onJoin).toHaveBeenCalled()
  })

  it('снял галочку — кнопка снова не работает', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} onJoin={() => {}} />)

    fireEvent.click(screen.getByTestId('challenge-agree'))
    fireEvent.click(screen.getByTestId('challenge-agree'))
    expect(screen.getByTestId('challenge-join').disabled).toBe(true)
  })

  it('«уже участник» перечитывает состояние, а не спорит с сервером', async () => {
    const onJoin = vi.fn().mockResolvedValue({ already: true })
    const onRefresh = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} onJoin={onJoin} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByTestId('challenge-agree'))
    await act(async () => screen.getByTestId('challenge-join').click())
    expect(onRefresh).toHaveBeenCalled()
  })

  it('живого потока нет — кнопка честно молчит про покупку', () => {
    render(<ChallengeScreen state={null} fallbackPrice={2990} />)

    const join = screen.getByTestId('challenge-join')
    expect(join.disabled).toBe(true)
    expect(join.textContent).toContain('Набор пока закрыт')
    // но цена на витрине всё равно объявленная, а не ноль
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
  })
})

describe('без нормы питания билет не продаётся', () => {
  it('вместо «Участвовать» — «Заполнить данные о себе»', () => {
    /**
     * Питание — половина зачёта, и считается оно от дневной нормы. Продать
     * билет человеку без нормы значит взять деньги за заведомо половину
     * челленджа. Сервер держит то же правило (api/create-payment.js), экран
     * лишь говорит об этом заранее, а не отказом после нажатия.
     */
    const onFillNorm = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} hasNorm={false} onFillNorm={onFillNorm} />)

    expect(screen.queryByTestId('challenge-join')).toBeNull()
    expect(screen.queryByTestId('challenge-agree')).toBeNull()
    expect(screen.getByTestId('challenge-no-norm').textContent).toContain('половина зачёта')

    act(() => screen.getByTestId('challenge-fill-norm').click())
    expect(onFillNorm).toHaveBeenCalled()
  })

  it('цена при этом видна — человек должен знать, к чему готовиться', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} hasNorm={false} />)
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
  })
})

/**
 * ПИТАНИЕ ДО СТАРТА И ПОСЛЕ ФИНИША — три числа за весь поток. Пока поток ИДЁТ,
 * человеку нужны не итоги, а сегодняшний день и остатки до нормы, и это уже
 * другой экран — рабочая комната (StreamRoom.test.jsx).
 */
describe('участник видит своё питание', () => {
  /** Сырьё, как его отдаёт challenge_nutrition_facts: без процентов. */
  const facts = (days) => days.map((d, i) => ({
    day: i + 1,
    kcal: d.kcal ?? 0,
    p: d.p ?? 0,
    f: d.f ?? 0,
    c: d.c ?? 0,
    meals: d.meals ?? 0,
    norm_kcal: 2000,
    norm_p: 120,
    norm_f: 65,
    norm_c: 220,
  }))

  it('средний за поток и дни с дневником — по итогам, а не по заполненным', () => {
    const rows = facts([
      { kcal: 2000, p: 120, f: 65, c: 220, meals: 4 },
      { kcal: 1950, p: 118, f: 63, c: 215, meals: 3 },
      ...Array.from({ length: 28 }, () => ({})),
    ])
    render(
      <ChallengeScreen
        state={{ season: { ...SEASON, starts_on: сдвиг(-40) }, entry: ENTRY }}
        nutrition={rows}
      />,
    )

    // два дня из тридцати по сотне — это 7%, а не 100: средний делится на весь
    // поток, иначе три честных дня выглядели бы отличным результатом
    expect(screen.getByTestId('nutri-average').textContent).toBe('7%')
    expect(screen.getByTestId('nutri-days').textContent).toBe('2 из 30')
  })

  it('нормы у участника нет — блок зовёт её завести, а не показывает нули', () => {
    const onFillNorm = vi.fn()
    render(
      <ChallengeScreen
        state={{ season: SEASON, entry: ENTRY }}
        nutrition={facts([{}, {}])}
        hasNorm={false}
        onFillNorm={onFillNorm}
      />,
    )

    expect(screen.queryByTestId('nutri-average')).toBeNull()
    act(() => screen.getByTestId('nutri-fill').click())
    expect(onFillNorm).toHaveBeenCalled()
  })

  it('питание ещё не приехало — блока нет вовсе', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: ENTRY }} />)
    expect(screen.queryByTestId('challenge-nutrition')).toBeNull()
  })
})

describe('гость: аккаунт вместо оплаты', () => {
  it('видит цену, но не видит ни галочки, ни кнопки оплаты', () => {
    const onCreateAccount = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest onCreateAccount={onCreateAccount} />)

    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
    expect(screen.queryByTestId('challenge-join')).toBeNull()
    expect(screen.queryByTestId('challenge-agree')).toBeNull()

    act(() => screen.getByTestId('challenge-signup').click())
    expect(onCreateAccount).toHaveBeenCalled()
  })

  it('липкой кнопки оплаты у гостя нет вовсе', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    expect(screen.queryByTestId('challenge-bar')).toBeNull()
  })
})

/** Дата за N московских дней от сегодня: минус — прошлое, плюс — будущее. */
const сдвиг = (дней) => {
  const [y, m, d] = moscowDate().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + дней)).toISOString().slice(0, 10)
}

describe('участник: комната потока вместо витрины', () => {
  it('номер, имя и обратный отсчёт до старта', () => {
    /**
     * Дата в будущем считается ПО МЕСТНОМУ времени: `toISOString()` уводит в
     * UTC, и вечером у московского пользователя тест получал бы «16 дней»
     * там, где приложение показывает семнадцать.
     */
    const d = new Date()
    d.setDate(d.getDate() + 17)
    const soon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: soon }, entry: ENTRY }} />)

    expect(screen.getByTestId('challenge-number').textContent).toContain('24')
    expect(screen.getByTestId('challenge-name').textContent).toBe('Пётр Петров')
    expect(screen.getByTestId('challenge-start').textContent).toBe('До старта потока: 17 дней')
  })

  it('даты нет — «дата будет объявлена», а не пустой отсчёт', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: null }, entry: ENTRY }} />)
    expect(screen.getByTestId('challenge-start').textContent).toContain('будет объявлена')
  })

  it('прямым текстом: дни откроются в старт, остальное доступно сейчас', () => {
    // это первый вопрос оплатившего — «я заплатил, а где тренировки?»
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: сдвиг(3) }, entry: ENTRY }} />)
    const early = screen.getByTestId('challenge-early').textContent

    expect(early).toContain('откроются в день старта')
    expect(early).toContain('тренировки, программы и дневник питания доступны уже сейчас')
  })

  it('поток идёт — вместо квитанции открывается рабочая комната дня', () => {
    /**
     * ГЛАВНАЯ ПЕРЕМЕНА. Раньше участник идущего потока видел здесь галочку,
     * слова «Оплата прошла» и кнопку «Понятно», которая выбрасывала его на
     * список программ. Начать тренировку с этого экрана было нельзя вовсе.
     *
     * Теперь тот же случай отдаёт другое место — комнату (StreamRoom.jsx), в
     * которой первым делом стоит кнопка старта сегодняшнего дня.
     */
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: сдвиг(-4) }, entry: ENTRY }} />)

    expect(screen.getByTestId('stream-room')).toBeTruthy()
    expect(screen.getByTestId('stream-day').textContent).toBe('День 5 из 30')
    expect(screen.getByTestId('stream-start').textContent).toContain('день 5')
    // ни поздравления как заголовка, ни выхода «в никуда»
    expect(screen.queryByTestId('challenge-member')).toBeNull()
    expect(screen.queryByTestId('challenge-room-exit')).toBeNull()
    expect(pageText()).not.toContain('Понятно')
  })

  it('поток кончился — итог, а не рабочий день', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: сдвиг(-40) }, entry: ENTRY }} />)

    expect(screen.getByTestId('challenge-start').textContent).toContain('Поток завершён')
    expect(screen.queryByTestId('stream-room')).toBeNull()
    // и здесь кнопки «Понятно» тоже нет: выход только крестиком
    expect(pageText()).not.toContain('Понятно')
  })

  it('до старта комната остаётся прежней — ждать и втягиваться', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: сдвиг(3) }, entry: ENTRY }} />)

    expect(screen.getByTestId('challenge-start').textContent).toContain('До старта потока')
    expect(screen.queryByTestId('stream-room')).toBeNull()
    expect(pageText()).not.toContain('Понятно')
  })

  it('тихая ссылка «Правила» открывает те же правила, но без покупки', () => {
    render(<ChallengeScreen state={{ season: { ...SEASON, starts_on: сдвиг(-4) }, entry: ENTRY }} />)

    act(() => screen.getByTestId('stream-rules').click())
    // текст правил — тот самый, с которым человек согласился при вступлении
    expect(screen.getByTestId('challenge-rules')).toBeTruthy()
    // а покупки на нём для участника нет ни в каком виде
    expect(screen.queryByTestId('challenge-join')).toBeNull()
    expect(screen.queryByTestId('challenge-hero-join')).toBeNull()
    expect(screen.queryByTestId('challenge-bar')).toBeNull()

    // крестик возвращает в комнату, а не закрывает раздел
    act(() => screen.getByTestId('challenge-rules-back').click())
    expect(screen.getByTestId('stream-room')).toBeTruthy()
  })

  it('участнику не показывают ни цены, ни кнопки покупки', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: ENTRY }} />)

    expect(screen.queryByTestId('challenge-join')).toBeNull()
    expect(screen.queryByTestId('challenge-price')).toBeNull()
    expect(screen.queryByTestId('challenge-bar')).toBeNull()
  })
})

describe('пока участие читается', () => {
  it('молчим, а не говорим «набор закрыт»', () => {
    render(<ChallengeScreen state={null} loading />)
    expect(screen.getByTestId('challenge-loading')).toBeTruthy()
    expect(screen.queryByTestId('challenge-join')).toBeNull()
  })
})
