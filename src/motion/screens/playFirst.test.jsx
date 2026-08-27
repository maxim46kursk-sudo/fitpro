// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ChallengeScreen from './ChallengeScreen.jsx'
import PlayExitScreen from './PlayExitScreen.jsx'
import { забытьВизит } from '../challengeFunnel.js'
import { getShippedText, resetLogShipper } from '../debug/logShipper.js'

/**
 * СНАЧАЛА ИГРАЕТ, ПОТОМ УЗНАЁТ ЦЕНУ.
 *
 * Правило, ради которого страница и перестраивалась: на первом экране цены нет
 * НИГДЕ. Человек приходит из поста, про Motion не знает ничего, и цифра до
 * опыта отвечает на не заданный им вопрос единственным доступным ей способом —
 * «дорого».
 *
 * Проверять это глазами нельзя: цена приезжает из строки сезона и легко
 * просачивается обратно любой правкой героя. Поэтому проверка машинная и
 * смотрит на ТЕКСТ первого экрана целиком, а не на конкретную кнопку.
 */

const SEASON = {
  id: 1,
  title: 'Поток 1',
  starts_on: '2026-09-10',
  price_rub: 2990,
  prize_pct: 50,
  prize_split: [50, 30, 20],
  status: 'open',
}

beforeEach(() => {
  resetLogShipper()
  забытьВизит()
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  забытьВизит()
  vi.unstubAllGlobals()
})

/** Текст первого экрана — от плашки до кнопки «Играть» включительно. */
function первыйЭкран() {
  return screen.getByTestId('challenge-play').closest('.mt-ch__hero').textContent
}

describe('первый экран страницы челленджа', () => {
  /**
   * ЗАПРЕЩЕНА ЦЕНА, А НЕ РУБЛЬ.
   *
   * Прежний сторож ловил любое «₽» и любое «руб» — и был прав, пока на первом
   * экране не было ни одной суммы. Теперь там намеренно стоит призовая:
   * «Призов на 59 970 ₽» — это не то, что человек платит, а то, что он может
   * выиграть, и убирать её ради буквы правила значит выкинуть главный довод.
   *
   * Сторож сузился до того, что и охранялся: СКОЛЬКО ПЛАТИТЬ. Цена билета,
   * слово «Участвовать» и всё, что зовёт к кассе, на первом экране по-прежнему
   * запрещены.
   */
  it('цены билета нет: ни числом, ни словом (призовая сумма — можно)', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    const текст = первыйЭкран()

    expect(текст).not.toContain('2990')
    expect(текст).not.toContain('2 990')
    expect(текст).not.toMatch(/Участвовать|цена|стоимость/i)

    // а призовая сумма обязана быть — ради неё сторож и сужался
    expect(текст).toMatch(/59\s?970/)
  })

  it('всё, что положено, на месте и в нужном порядке', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)

    // дата ушла с плашки сверху под кнопку — метка осталась на ней же
    expect(screen.getByTestId('challenge-tag').textContent).toContain('10 сентября')
    expect(screen.getByTestId('challenge-tag').textContent).toContain('Без регистрации')
    const заголовок = screen.getByTestId('challenge-hero-title').textContent
    expect(заголовок).toContain('Игра, которая')
    expect(заголовок).toContain('заставляет')
    expect(заголовок).toContain('тренироваться')

    const текст = первыйЭкран()
    expect(текст).toContain('20 минут в день перед камерой телефона')
    expect(текст).toContain('Без зала, без гантелей, без абонемента')
    expect(текст).toContain('Только ты, 2 квадратных метра и телефон')
    expect(текст).toContain('половина всех билетов')
    expect(текст).toContain('личная работа с тренером')
    expect(screen.getByTestId('challenge-play').textContent).toBe('Играть — бесплатно')
  })

  /**
   * Ролик обязан быть немым, зацикленным и БЕЗ полноэкранного перехвата: без
   * playsInline iOS открывает его поверх страницы, то есть подменяет первый
   * экран лендинга плеером с крестиком.
   */
  it('видео играет само, по кругу, без звука и не во весь экран', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    const v = screen.getByTestId('challenge-video')

    expect(v.getAttribute('src')).toBe('/challenge-motion.mp4')
    expect(v.getAttribute('poster')).toBe('/challenge-motion.jpg')
    expect(v.autoplay).toBe(true)
    expect(v.loop).toBe(true)
    expect(v.muted).toBe(true)
    expect(v.getAttribute('playsinline')).not.toBe(null)
  })

  it('«Играть» зовёт наружу и ставит ступень воронки', () => {
    const onPlay = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest onPlay={onPlay} />)

    fireEvent.click(screen.getByTestId('challenge-play'))

    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(getShippedText()).toContain('[challenge.play]')
  })

  /** Цена ниже по странице никуда не делась — там ей и место. */
  it('ниже по странице цена и кнопка участия на месте', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    expect(screen.getByTestId('challenge-price').textContent).toContain('990')
    // money() ставит НЕРАЗРЫВНЫЙ пробел: «2 990 ₽» не должно ломаться пополам
    expect(screen.getByTestId('challenge-warm-join').textContent).toContain('990')
    expect(screen.getByTestId('challenge-warm-join').textContent).toContain('₽')
  })
})

describe('тёплый блок после игры', () => {
  it('есть на странице с текстом и кнопкой из макета', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    const блок = screen.getByTestId('challenge-warm')

    expect(блок.textContent).toContain('Тогда смотри,')
    expect(блок.textContent).toContain('что дальше')
    expect(блок.textContent).toContain('Тридцать дней подряд')
    expect(блок.textContent).toContain('Считает камера, подделать нельзя')
    expect(блок.textContent).toContain('Участвовать — ')
    expect(блок.textContent).toContain('Подробные правила ниже')
  })

  /** Участнику продавать нечего — блока у него нет вовсе. */
  it('участнику не показывается', () => {
    render(
      <ChallengeScreen
        state={{ season: SEASON, entry: { id: 7, participant_no: 1, display_name: 'Пётр', paid_at: '2026-08-20T10:00:00Z' } }}
      />,
    )
    expect(screen.queryByTestId('challenge-warm')).toBeNull()
  })
})

describe('продающая страница: выход и меню', () => {
  const УЧАСТНИК = { id: 7, participant_no: 1, display_name: 'Пётр', paid_at: '2026-08-20T10:00:00Z' }

  it('у гостя «Назад» словом, у участника — крестик', () => {
    const onExit = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest onExit={onExit} />)
    const назад = screen.getByTestId('challenge-rules-back')
    expect(назад.textContent).toContain('Назад')
    expect(назад.className).toContain('mt-ch__back')

    fireEvent.click(назад)
    expect(onExit).toHaveBeenCalledTimes(1)

    /**
     * У участника — прежний крестик. Ветка «участник до старта» рисует свой, и
     * метки на нём нет; проверяем по существу: кнопки «Назад» словом там не
     * появилось, а крестик на месте.
     */
    cleanup()
    render(<ChallengeScreen state={{ season: SEASON, entry: УЧАСТНИК }} />)
    expect(document.querySelector('.mt-ch__back')).toBeNull()
    expect(document.querySelector('.mt-corner--left')?.textContent).toBe('✕')
  })

  /**
   * Меню — та самая дверь в остальное приложение, которой на странице не было.
   * Оплатившему оно не нужно: у него своя комната и своё меню.
   */
  it('гость видит меню приложения, участник — нет', () => {
    const onAppNav = vi.fn()
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest onAppNav={onAppNav} />)
    const меню = screen.getByTestId('challenge-app-nav')
    for (const [id, подпись] of [
      ['workouts', 'Тренировки'], ['nutrition', 'Питание'],
      ['library', 'Упражнения'], ['progress', 'Прогресс'],
    ]) {
      expect(screen.getByTestId(`challenge-nav-${id}`).textContent).toContain(подпись)
    }
    expect(меню.querySelectorAll('button')).toHaveLength(4)

    fireEvent.click(screen.getByTestId('challenge-nav-nutrition'))
    expect(onAppNav).toHaveBeenCalledWith('nutrition')

    cleanup()
    render(<ChallengeScreen state={{ season: SEASON, entry: УЧАСТНИК }} onAppNav={onAppNav} />)
    expect(screen.queryByTestId('challenge-app-nav')).toBeNull()
  })

  it('секции «Числа» на странице больше нет', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    const текст = document.body.textContent
    expect(текст).not.toContain('дней, одинаковых у всех')
    expect(текст).not.toContain('захода в день, в зачёт лучший')
  })

  it('у шагов 01 и 02 картинок нет, у 03 — есть', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    const шаги = [...document.querySelectorAll('.mt-ch__step')]
    expect(шаги).toHaveLength(3)
    expect(шаги[0].textContent).toContain('Телефон на пол, ты — в двух метрах')
    expect(шаги[0].querySelector('img')).toBeNull()
    expect(шаги[1].textContent).toContain('20 минут: силовая и бой')
    expect(шаги[1].querySelector('img')).toBeNull()
    expect(шаги[2].querySelector('img')?.getAttribute('src')).toBe('/challenge/shot-diary.webp')
  })

  it('открытие правил отмечается в воронке', () => {
    render(<ChallengeScreen state={{ season: SEASON, entry: null }} guest />)
    fireEvent.click(screen.getByTestId('challenge-rules-open'))
    expect(getShippedText()).toContain('[challenge.rules-open]')
  })
})

describe('выход из пробной игры', () => {
  const ИТОГ = { score: 4700, hits: 47, seconds: 360 }

  it('экран 1: настоящие цифры и вопрос с двумя пальцами', () => {
    render(<PlayExitScreen итог={ИТОГ} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={() => {}} />)

    expect(screen.getByTestId('play-exit-score').textContent).toBe('4 700')
    expect(screen.getByTestId('play-exit-sub').textContent).toBe('47 мишеней · 6 минут')
    expect(screen.getByTestId('play-exit').textContent).toContain('Как тебе игра?')
    expect(screen.getByTestId('play-exit-up')).toBeTruthy()
    expect(screen.getByTestId('play-exit-down')).toBeTruthy()
  })

  /**
   * НУЛЕЙ ВМЕСТО РЕЗУЛЬТАТА НЕ БЫВАЕТ. Человеку, который только что двигался,
   * «0» читается как «ты ничего не сделал» — а это не наша оценка, это наша
   * потеря данных. Нет цифр — нет и блока.
   */
  it('результата нет — блок с цифрами не рисуется, а не показывает нули', () => {
    render(<PlayExitScreen итог={null} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={() => {}} />)
    expect(screen.queryByTestId('play-exit-result')).toBeNull()
    expect(screen.getByTestId('play-exit').textContent).toContain('Как тебе игра?')

    cleanup()
    render(<PlayExitScreen итог={{ score: 0, hits: 0, seconds: 0 }} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={() => {}} />)
    expect(screen.queryByTestId('play-exit-result')).toBeNull()
  })

  it('палец вверх — на страницу челленджа, ступень «up»', () => {
    const onЧеллендж = vi.fn()
    render(<PlayExitScreen итог={ИТОГ} onЧеллендж={onЧеллендж} onСохранить={() => {}} onЗакрыть={() => {}} />)

    fireEvent.click(screen.getByTestId('play-exit-up'))

    expect(onЧеллендж).toHaveBeenCalledTimes(1)
    expect(getShippedText()).toContain('[challenge.up]')
  })

  it('палец вниз — экран «Жаль» с его же цифрами и без цены', () => {
    render(<PlayExitScreen итог={ИТОГ} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={() => {}} />)

    fireEvent.click(screen.getByTestId('play-exit-down'))

    const экран = screen.getByTestId('play-exit-sorry')
    expect(экран.textContent).toContain('Жаль.')
    expect(экран.textContent).toContain('47 мишеней с первого раза')
    expect(экран.textContent).toContain('Первые дни в игре бесплатные')
    /**
     * Цифры на этом экране идут ПРОЗОЙ, а не карточкой: так в макете, и так
     * они работают — «47 мишеней с первого раза» это довод, а та же цифра
     * отдельным блоком была бы просто числом.
     */
    expect(screen.queryByTestId('play-exit-result')).toBeNull()
    // цены на этом экране нет: человеку не понравилось, продавать ему нечего
    expect(экран.textContent).not.toMatch(/₽|2990|2 990|Участвовать/)
    expect(getShippedText()).toContain('[challenge.down]')
  })

  it('«Сохранить результат» ведёт наружу и ставит ступень «save»', () => {
    const onСохранить = vi.fn()
    render(<PlayExitScreen итог={ИТОГ} onЧеллендж={() => {}} onСохранить={onСохранить} onЗакрыть={() => {}} />)

    fireEvent.click(screen.getByTestId('play-exit-down'))
    fireEvent.click(screen.getByTestId('play-exit-save'))

    expect(onСохранить).toHaveBeenCalledTimes(1)
    expect(getShippedText()).toContain('[challenge.save]')
  })

  it('«Закрыть» просто отпускает', () => {
    const onЗакрыть = vi.fn()
    render(<PlayExitScreen итог={ИТОГ} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={onЗакрыть} />)

    fireEvent.click(screen.getByTestId('play-exit-down'))
    fireEvent.click(screen.getByTestId('play-exit-close'))

    expect(onЗакрыть).toHaveBeenCalledTimes(1)
  })

  /** Похвала опирается на его число: «0 мишеней с первого раза» — насмешка. */
  it('без мишеней похвалы нет, а вторая половина текста остаётся', () => {
    render(
      <PlayExitScreen
        итог={{ score: 300, hits: 0, seconds: 40 }}
        onЧеллендж={() => {}}
        onСохранить={() => {}}
        onЗакрыть={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('play-exit-down'))

    const экран = screen.getByTestId('play-exit-sorry')
    expect(экран.textContent).not.toContain('с первого раза')
    expect(экран.textContent).toContain('Первые дни в игре бесплатные')
  })

  /** Ступень ставится один раз за визит — как у всех остальных. */
  it('повторный ответ второй отметки не даёт', () => {
    const { unmount } = render(
      <PlayExitScreen итог={ИТОГ} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={() => {}} />,
    )
    fireEvent.click(screen.getByTestId('play-exit-down'))
    unmount()
    render(<PlayExitScreen итог={ИТОГ} onЧеллендж={() => {}} onСохранить={() => {}} onЗакрыть={() => {}} />)
    fireEvent.click(screen.getByTestId('play-exit-down'))

    const сколько = getShippedText().split('[challenge.down]').length - 1
    expect(сколько).toBe(1)
  })
})
