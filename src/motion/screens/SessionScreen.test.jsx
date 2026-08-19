// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SessionScreen from './SessionScreen.jsx'
import SessionResult from './SessionResult.jsx'
import {
  PHASE_MS,
  START_COUNTDOWN_MS,
  STRENGTH_ORDER,
  buildDay,
  cycleOf,
  cyclesOf,
} from '../game/session.js'
import { dayPlan } from '../game/challenge.js'
import { tierById } from '../game/levels.js'
import { cueCountdown, cueStart, cueTick } from '../feedback/audio.js'
import { getLive } from '../debug/diagnostics.js'
import { flush, logEvent } from '../debug/logShipper.js'

/**
 * Отправка подменена: проверяется, ЧТО экран кладёт в журнал по кнопке жалобы
 * и что он торопит отправку. Как строка уезжает на сервер — дело
 * logShipper.test.js.
 */
vi.mock('../debug/logShipper.js', async (importOriginal) => ({
  ...(await importOriginal()),
  logEvent: vi.fn(),
  flush: vi.fn(async () => {}),
}))

/**
 * Сигналы подменены, всё остальное в звуке — настоящее: проверяется, ЧТО и
 * СКОЛЬКО раз зовёт экран, а не как оно звучит (это дело audio.test.js).
 */
vi.mock('../feedback/audio.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cueTick: vi.fn(),
  cueCountdown: vi.fn(),
  cueStart: vi.fn(),
}))

/**
 * Экран собирает сессию по ПЛАНУ ДНЯ, и по умолчанию это первый день. Числа
 * берём оттуда же, а не из PHASE_MS: константы остались базовым днём, а первый
 * день чуть тяжелее его.
 */
const DAY1 = dayPlan(1)
import { STRENGTH_LABEL } from '../game/strength.js'
import { obstaclePointsFor } from '../game/levels.js'

/**
 * Сессия целиком глазами экрана. Кадры человека сюда не подаются — их
 * проверяет автопрогон (tools/full-session.test.js) на настоящих записях.
 * Здесь проверяется СЦЕПКА: отсчёт перед блоком, отдых со следующим движением,
 * переход от блока к бою и финальный лист с той самой арифметикой.
 */

afterEach(cleanup)

const noopSubscribe = () => () => {}

/** Пережить стартовый отсчёт целиком — с него начинается любая сессия. */
const START_MS = START_COUNTDOWN_MS + 100

/** Прокрутить часы отдыха: экран ведёт их через requestAnimationFrame. */
function runClock(frames, now, ms) {
  act(() => {
    now.mockReturnValue(now() + ms)
    frames.splice(0).forEach((cb) => cb(now()))
  })
}

describe('сессия ведёт человека по кругам', () => {
  it('начинается с отсчёта, который называет первое движение', () => {
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)

    expect(screen.getByTestId('rest-screen')).toBeTruthy()
    expect(screen.getByTestId('rest-countdown').textContent).toBe('10')
    expect(screen.getByTestId('rest-next').textContent).toContain(STRENGTH_LABEL[STRENGTH_ORDER[0]])
  })

  it('первый кадр отсчёта — уже «10», без мигания трёшкой', () => {
    /**
     * Часы заводятся эффектом, то есть ПОСЛЕ первого кадра: возьми начальный
     * остаток из константы отсчёта между блоками — и человек на старте увидел бы
     * «3», которое тут же сменяется на «10».
     *
     * Поэтому здесь разметка без эффектов (renderToStaticMarkup) — обычный
     * render их уже прогнал бы и мигание спрятал.
     */
    const first = renderToStaticMarkup(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    const shown = first.match(/data-testid="rest-countdown"[^>]*>([^<]*)</)
    expect(shown?.[1]).toBe(String(START_COUNTDOWN_MS / 1000))
  })

  it('после отсчёта идёт силовой блок первого движения', () => {
    const frames = []
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
      runClock(frames, now, START_MS)

      expect(screen.queryByTestId('rest-screen')).toBeNull()
      expect(screen.getByTestId('block-command').textContent).toBe(
        STRENGTH_LABEL[STRENGTH_ORDER[0]],
      )
      // счёт блока стартует с нуля, но табло показывает общий счёт сессии
      expect(screen.getByTestId('block-score').textContent).toBe('0')
    } finally {
      raf.mockRestore()
      now.mockRestore()
    }
  })

  it('силовой блок кончается сам, и отдых объявляет следующим бой', () => {
    /**
     * Ровно та сцепка, ради которой расписание ведётся по событиям блоков, а не
     * по часам сессии: блок отчитывается сам, и только тогда идёт отдых.
     */
    const frames = []
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
      runClock(frames, now, START_MS)
      expect(screen.getByTestId('block-command')).toBeTruthy()

      // тридцать секунд блока вышли — он отдаёт итог, сессия уходит на отдых
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)

      expect(screen.queryByTestId('block-command')).toBeNull()
      expect(screen.getByTestId('rest-next').textContent).toContain('БОЙ')
      expect(screen.getByTestId('rest-timer').textContent).toBe(
        String(DAY1.restStrengthSec),
      )
    } finally {
      raf.mockRestore()
      now.mockRestore()
    }
  })
})

describe('полоса прогресса одна на всю сессию', () => {
  /**
   * Внутри сессии три разных экрана, и до полосы ни один из них не отвечал на
   * главный вопрос — сколько ещё. Человек на четвёртом круге из восьми и на
   * седьмом видел одно и то же, а работают они по-разному: первый распределяет
   * силы, второй дотягивает.
   *
   * Проверяется поэтому не вёрстка, а СЦЕПКА: строка есть на всех трёх экранах,
   * числа в ней те же, что в расписании, и на отдыхе к ней добавлен счёт.
   */
  const CYCLES = DAY1.circles

  function runSession() {
    const frames = []
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    return { frames, now, restore: () => { raf.mockRestore(); now.mockRestore() } }
  }

  it('круг назван на отдыхе, в силовом блоке и в бою — одной и той же строкой', () => {
    const { frames, now, restore } = runSession()
    try {
      // 1. первый отсчёт — это уже отдых-экран, и человек на нём на первом круге
      expect(screen.getByTestId('session-cycle').textContent).toBe(`КРУГ 1 из ${CYCLES}`)

      // 2. силовой блок
      runClock(frames, now, START_MS)
      expect(screen.getByTestId('block-command')).toBeTruthy()
      expect(screen.getByTestId('session-cycle').textContent).toBe(`КРУГ 1 из ${CYCLES}`)

      // 3. отдых перед боем
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)
      expect(screen.getByTestId('rest-screen')).toBeTruthy()
      expect(screen.getByTestId('session-cycle').textContent).toBe(`КРУГ 1 из ${CYCLES}`)

      // 4. бой
      runClock(frames, now, DAY1.restStrengthSec * 1000 + 100)
      expect(screen.getByTestId('game-canvas')).toBeTruthy()
      expect(screen.getByTestId('session-cycle').textContent).toBe(`КРУГ 1 из ${CYCLES}`)
    } finally {
      restore()
    }
  })

  it('номер круга растёт вместе с расписанием и не промахивается на единицу', () => {
    /**
     * Проверяется на ВСЁМ расписании сразу, а не через экран: экран показывает
     * по одной фазе за раз, и промах на единицу виден только тогда, когда фазы
     * выложены в ряд. Прогнать через экран все восемь кругов нельзя — бой
     * кончается по кадрам человека, а их в этом тесте нет.
     */
    const { phases } = buildDay(1, tierById('pro'))
    const shown = phases.map((p) => cycleOf(p))

    // первый отсчёт своего круга не имеет — человек на нём уже на первом
    expect(phases[0].kind).toBe('countdown')
    expect(shown[0]).toBe(1)
    // ни ноля, ни выхода за расписание
    expect(Math.min(...shown)).toBe(1)
    expect(Math.max(...shown)).toBe(CYCLES)
    expect(cyclesOf(phases)).toBe(CYCLES)

    // каждый силовой блок — свой круг, по порядку и без пропусков
    const blocks = phases.filter((p) => p.kind === 'strength').map(cycleOf)
    expect(blocks).toEqual(Array.from({ length: CYCLES }, (_, i) => i + 1))
    // отдых после боя ещё принадлежит своему кругу — он его закрывает
    const afterFight = phases.findIndex((p) => p.kind === 'fight') + 1
    expect(shown[afterFight]).toBe(1)
  })

  it('на отдыхе виден общий счёт сессии — больше его там взять неоткуда', () => {
    /**
     * Отдых был единственным экраном сессии без очков и единственным, где на
     * них есть время смотреть: в блоке и в бою человек занят.
     */
    const { frames, now, restore } = runSession()
    try {
      expect(screen.getByTestId('session-progress-score').textContent).toBe('0')

      runClock(frames, now, START_MS)
      // в блоке счёт свой и крупный — второго такого же в полосе быть не должно
      expect(screen.queryByTestId('session-progress-score')).toBeNull()
      expect(screen.getByTestId('block-score')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('финальный лист', () => {
  /**
   * Экран собирается из готовых итогов: важно, что таблица показывает и повторы,
   * и попадания, и строку сверки — участник по ней пересчитывает очки руками.
   */
  it('показывает очки, повторы, бои и строку сверки', () => {
    const price = obstaclePointsFor('pro')
    render(
      <SessionResult
        result={{
          score: 12 * price,
          hitPoints: price,
          level: { id: 'pro', name: 'ПРОФИ' },
          strength: [
            { cycle: 0, movement: 'barrier', reps: 5, score: 5 * price },
            { cycle: 1, movement: 'lunge', reps: 3, score: 3 * price },
          ],
          fights: [{ cycle: 0, cleared: 4, spawned: 6, score: 4 * price }],
        }}
      />,
    )

    expect(screen.getByTestId('session-score').textContent).toBe(String(12 * price))
    expect(screen.getByTestId('session-result').textContent).toContain('ПРИСЯДЬ')
    expect(screen.getByTestId('session-result').textContent).toContain('4 из 6')
    // строка сверки: действия × цена = очки
    expect(screen.getByTestId('session-sum').textContent).toBe(
      `12 действий × ${price} = ${12 * price}`,
    )
  })

  it('под счётом — зачёт дня: какая попытка, лучшая за день, сумма дня', () => {
    /**
     * Первый вопрос человека после двадцати минут работы не «сколько повторов в
     * четвёртом круге», а «это пошло в счёт и стало ли лучше». Отвечать надо
     * там, куда он смотрит, — под счётом, до разбора по кругам.
     */
    render(
      <SessionResult
        result={{
          score: 4200,
          hitPoints: 200,
          level: { id: 'pro', name: 'ПРОФИ' },
          strength: [],
          fights: [],
          attempt: {
            recorded: true,
            attempt: 2,
            best: 5000,
            isBest: false,
            dayTotal: 9100,
            attemptsLeft: 1,
          },
        }}
      />,
    )

    expect(screen.getByTestId('attempt-line').textContent).toContain('Попытка 2 из 3')
    expect(screen.getByTestId('attempt-line').textContent).toContain('лучшая за день: 5000')
    expect(screen.getByTestId('attempt-total').textContent).toContain('В зачёт дня: 9100')
  })

  it('лучший результат дня — похвала вместо числа, на том же месте', () => {
    // человек ищет глазами одно место, а не два разных на разных исходах
    render(
      <SessionResult
        result={{
          score: 5200,
          level: { id: 'pro', name: 'ПРОФИ' },
          strength: [],
          fights: [],
          attempt: { recorded: true, attempt: 3, best: 5200, isBest: true, dayTotal: 9300 },
        }}
      />,
    )

    expect(screen.getByTestId('attempt-line').textContent).toContain('новый лучший результат!')
    expect(screen.getByTestId('attempt-line').textContent).not.toContain('лучшая за день')
    // сумма дня остаётся на месте: она не про эту попытку
    expect(screen.getByTestId('attempt-total').textContent).toContain('9300')
  })

  it('сверх лимита сказано прямо, а не молчанием', () => {
    /**
     * Молчание читалось бы как «записано»: человек отработал те же двадцать
     * минут и имеет право знать, что этот заход в сумму не пошёл.
     */
    render(
      <SessionResult
        result={{
          score: 9999,
          level: { id: 'pro', name: 'ПРОФИ' },
          strength: [],
          fights: [],
          attempt: { recorded: false, attempt: 3, best: 5200, isBest: false, dayTotal: 9300 },
        }}
      />,
    )

    expect(screen.getByTestId('attempt-out').textContent).toContain(
      'Попытки на сегодня кончились',
    )
    expect(screen.queryByTestId('attempt-line')).toBeNull()
    expect(screen.queryByTestId('attempt-total')).toBeNull()
  })

  it('вне челленджа зачёта дня на листе нет вовсе', () => {
    // одиночный раунд к дням челленджа отношения не имеет, и врать про попытки
    // ему нечем
    render(
      <SessionResult
        result={{ score: 100, level: { id: 'pro', name: 'ПРОФИ' }, strength: [], fights: [] }}
      />,
    )
    expect(screen.queryByTestId('attempt-verdict')).toBeNull()
  })

  it('арифметика сходится и на другом уровне', () => {
    const price = obstaclePointsFor('novice')
    expect(price).toBe(100)
    expect(PHASE_MS.fight).toBe(90000)
  })
})

describe('меню тренировки', () => {
  /**
   * До меню выйти из сессии было нечем: единственный крестик жил внутри боя и
   * обрывал тренировку без спроса, а из силового блока и отдыха выхода не было
   * вовсе — только перезагрузка страницы. Человек, которому позвонили на
   * третьем круге, терял двадцать минут работы.
   */
  it('кнопка меню есть на любой фазе, включая отдых', () => {
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    expect(screen.getByTestId('rest-screen')).toBeTruthy()
    expect(screen.getByTestId('session-menu-button')).toBeTruthy()
  })

  it('открытое меню само ставит паузу: человек уже подошёл к телефону', () => {
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    act(() => {
      screen.getByTestId('session-menu-button').click()
    })

    expect(screen.getByTestId('session-menu')).toBeTruthy()
    // и предлагает продолжить, а не встать на паузу ещё раз
    expect(screen.getByTestId('menu-resume').textContent).toBe('Продолжить')
  })

  /**
   * КНОПКА ЖАЛОБЫ. Единственное место, куда человек придёт САМ и в момент
   * поломки. Ценна не словами, а снимком состояния, снятым тогда, когда ему
   * что-то не понравилось, — поэтому проверяется именно содержимое события.
   */
  it('«Сообщить о проблеме» кладёт в журнал снимок состояния и торопит отправку', async () => {
    logEvent.mockClear()
    flush.mockClear()
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    act(() => {
      screen.getByTestId('session-menu-button').click()
    })

    await act(async () => {
      screen.getByTestId('menu-report').click()
    })

    const жалоба = logEvent.mock.calls.find(([tag]) => tag === 'user.report')
    expect(жалоба).toBeTruthy()
    // снимок отклонений целиком: по этим полям и разбирают «не видно попаданий»
    expect(жалоба[1]).toMatchObject({ screen: expect.anything(), cheap: expect.any(Boolean) })
    expect(жалоба[1].tier).toBe('pro')
    // и ничего личного сверх того, что журнал пишет каждые пять секунд
    expect(JSON.stringify(жалоба[1])).not.toMatch(/label|deviceId/i)
    expect(flush).toHaveBeenCalled()
  })

  it('после жалобы человек видит подтверждение, а меню не закрывается', async () => {
    /**
     * Молча закрывшееся меню читается как «кнопка не сработала»: человек нажмёт
     * ещё раз, потом ещё — три жалобы вместо одной и уверенность, что сломано и
     * здесь тоже.
     */
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    act(() => {
      screen.getByTestId('session-menu-button').click()
    })
    await act(async () => {
      screen.getByTestId('menu-report').click()
    })

    expect(screen.getByTestId('menu-report-done').textContent).toContain('Отправлено')
    expect(screen.getByTestId('session-menu')).toBeTruthy()
    // повторно нажать нечего: кнопка уступила место подтверждению
    expect(screen.queryByTestId('menu-report')).toBeNull()
  })

  it('на паузе блок снимается с экрана целиком, а не замирает', () => {
    /**
     * Иначе счётчик повторов продолжал бы видеть позу и считать: человек стоит
     * у телефона, а игра пишет ему приседы.
     */
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    act(() => {
      screen.getByTestId('session-menu-button').click()
    })
    act(() => {
      screen.getByTestId('menu-close').click()
    })

    expect(screen.getByTestId('session-paused')).toBeTruthy()
    expect(screen.queryByTestId('rest-screen')).toBeNull()
  })

  it('продолжить возвращает к тому же месту тренировки', () => {
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    act(() => {
      screen.getByTestId('session-menu-button').click()
    })
    act(() => {
      screen.getByTestId('menu-resume').click()
    })

    expect(screen.queryByTestId('session-paused')).toBeNull()
    expect(screen.getByTestId('rest-screen')).toBeTruthy()
  })

  it('выйти зовёт наружу — к выбору уровня', () => {
    const onExit = vi.fn()
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" onExit={onExit} />)
    act(() => {
      screen.getByTestId('session-menu-button').click()
    })
    act(() => {
      screen.getByTestId('menu-exit').click()
    })
    expect(onExit).toHaveBeenCalled()
  })

  it('начать заново возвращает к первому отсчёту', () => {
    const frames = []
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb) && frames.length)
    vi.stubGlobal('cancelAnimationFrame', () => {})

    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    // уходим с самого первого отсчёта дальше по расписанию
    runClock(frames, now, DAY1.strengthSec * 1000)
    expect(screen.queryByTestId('rest-countdown')).toBeNull()

    act(() => {
      screen.getByTestId('session-menu-button').click()
    })
    act(() => {
      screen.getByTestId('menu-restart').click()
    })

    // снова самый первый отсчёт, и пауза снята
    expect(screen.queryByTestId('session-paused')).toBeNull()
    expect(screen.getByTestId('rest-screen')).toBeTruthy()

    now.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('снимок состояния знает, где человек', () => {
  /**
   * Полевые логи 18 августа: во время всей тренировки snapshot писал
   * "screen":"calibration" — поле обновлял только экран калибровки. Разбор
   * начинался с того, что читающий не верил собственному логу.
   */
  it('фаза называет себя сама — и в отсчёте, и в блоке', () => {
    const frames = []
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
      expect(getLive().screen).toBe('session:countdown:круг1')

      runClock(frames, now, START_MS)
      expect(screen.getByTestId('block-command')).toBeTruthy()
      expect(getLive().screen).toBe('session:strength:круг1')

      runClock(frames, now, DAY1.strengthSec * 1000 + 100)
      expect(getLive().screen).toBe('session:rest:круг1')
    } finally {
      raf.mockRestore()
      now.mockRestore()
    }
  })
})

describe('отсчёт слышно', () => {
  /**
   * Человек на отсчёте смотрит не в экран, а туда, где сейчас будет работать:
   * он отходит и встаёт в стойку. Немые цифры он пропускает и узнаёт о начале
   * блока по тому, что блок уже идёт.
   *
   * Проверяется не звучание (это дело audio.test.js), а СЦЕПКА: на каждую смену
   * цифры ровно один сигнал, и ни одного лишнего.
   */
  const cues = () => [cueTick, cueCountdown, cueStart]
  const calls = () => cues().reduce((sum, cue) => sum + cue.mock.calls.length, 0)

  beforeEach(() => cues().forEach((cue) => cue.mockClear()))

  function startSession() {
    const frames = []
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
    return { frames, now, restore: () => { raf.mockRestore(); now.mockRestore() } }
  }

  it('каждая смена цифры — ровно один сигнал, и ни одного лишнего', () => {
    const { frames, now, restore } = startSession()
    try {
      // первая цифра стартового отсчёта — «10», тикает
      expect(calls()).toBe(1)
      expect(cueTick).toHaveBeenCalledTimes(1)

      // секунда прошла — «9», ещё один тик и ничего больше
      runClock(frames, now, 1000)
      expect(calls()).toBe(2)
      expect(cueTick).toHaveBeenCalledTimes(2)

      // тот же кадр без смены цифры — молчание
      runClock(frames, now, 10)
      expect(calls()).toBe(2)

      // последние три секунды — акцент, а не тик
      runClock(frames, now, 6000)
      expect(screen.getByTestId('rest-countdown').textContent).toBe('3')
      expect(cueCountdown).toHaveBeenCalledTimes(1)
      expect(cueCountdown).toHaveBeenCalledWith(3)
      expect(cueTick).toHaveBeenCalledTimes(2)

      runClock(frames, now, 1000)
      expect(cueCountdown).toHaveBeenCalledWith(2)
      expect(calls()).toBe(4)

      /**
       * На нуле отсчёт замолкает: сигнал старта даёт сама работа — силовой блок
       * на первом кадре, бой по round.start. Дай его ещё и отсчёт — и на нуле
       * звучали бы два трезвучия подряд, то есть старт с эхом.
       */
      runClock(frames, now, 2100)
      expect(screen.getByTestId('block-command')).toBeTruthy()
      expect(cueStart).not.toHaveBeenCalled()
      expect(calls()).toBe(4)
    } finally {
      restore()
    }
  })

  it('на паузе часы стоят — и отсчёт молчит', () => {
    // человек отошёл к телефону; сигналы в пустой комнате торопили бы никого
    const { frames, now, restore } = startSession()
    try {
      runClock(frames, now, 1000)
      const before = calls()

      act(() => {
        screen.getByTestId('session-menu-button').click()
      })
      expect(screen.getByTestId('session-menu')).toBeTruthy()

      runClock(frames, now, 5000)
      expect(calls()).toBe(before)

      /**
       * А вот продолжение — сигнал: отсчёт после паузы начинается заново
       * (человек только что отошёл от телефона, и ему снова надо встать в
       * кадр), цифра меняется на «10» — её и слышно, ровно один раз.
       */
      act(() => {
        screen.getByTestId('menu-resume').click()
      })
      expect(screen.getByTestId('rest-countdown').textContent).toBe('10')
      expect(calls()).toBe(before + 1)
    } finally {
      restore()
    }
  })
})
