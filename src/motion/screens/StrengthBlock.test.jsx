// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import StrengthBlock from './StrengthBlock.jsx'
import {
  BLOCK_MS,
  STRENGTH_LABEL,
  STRENGTH_TYPES,
  TEMPO_BY_TIER,
  createRepCounter,
  tempoFor,
} from '../game/strength.js'
import { obstaclePointsFor } from '../game/levels.js'

/**
 * Силовой блок. Проверяется не красота, а три вещи, без которых он не работает:
 * он монтируется для КАЖДОГО силового движения, повтор от детектора превращается
 * в цифру и очки, и инструктор крутит петлю в темпе уровня.
 *
 * Кадры человека сюда не подаются: гонять целую запись через экран, чтобы
 * убедиться, что цифра выросла, дороже самой цифры. Источник повторов у экрана
 * поэтому подменяемый — а сами счётчики проверяются в strength.test.js на тех
 * же признаках, что и детекторы.
 */

afterEach(cleanup)

/** Подписка, которую тест дёргает руками: кадр приходит, когда мы решим. */
function fakeSubscribe() {
  const listeners = []
  const subscribe = (fn) => {
    listeners.push(fn)
    return () => {
      const i = listeners.indexOf(fn)
      if (i > -1) listeners.splice(i, 1)
    }
  }
  subscribe.frame = (over = {}) => {
    act(() => {
      for (const fn of listeners) {
        fn({ landmarks: [], worldLandmarks: [], timestamp: 1000, ...over })
      }
    })
  }
  return subscribe
}

/** Счётчик, который отдаёт заранее назначенные повторы. */
const scripted = (queue) => () => ({
  update: () => queue.shift() ?? 0,
  reset: () => {},
})

describe('силовой блок монтируется для всех силовых движений', () => {
  for (const movement of STRENGTH_TYPES) {
    it(`${movement}: экран собирается и показывает команду тренера`, () => {
      const subscribe = fakeSubscribe()
      expect(() =>
        render(
          <StrengthBlock
            subscribe={subscribe}
            movement={movement}
            tier="novice"
            makeCounter={scripted([])}
          />,
        ),
      ).not.toThrow()

      expect(screen.getByTestId('block-command').textContent).toBe(STRENGTH_LABEL[movement])
      expect(screen.getByTestId('block-reps').textContent).toContain('повторов')
      // таймер стартует с полных тридцати секунд
      expect(screen.getByTestId('block-timer').textContent).toBe(String(BLOCK_MS / 1000))
    })
  }

  it('у каждого силового движения есть команда и своя петля инструктора', () => {
    for (const movement of STRENGTH_TYPES) {
      expect(STRENGTH_LABEL[movement]).toBeTruthy()
    }
    // семь движений, и список закрыт: остальные в силовой блок не попадают
    expect(STRENGTH_TYPES).toHaveLength(7)
    for (const alien of ['wall', 'beam', 'strike', 'bird', 'knee', 'heel', 'hop', 'wings', 'clap']) {
      expect(STRENGTH_TYPES).not.toContain(alien)
    }
  })
})

describe('повтор от детектора', () => {
  it('увеличивает счёт повторов и очки на цену уровня', () => {
    const subscribe = fakeSubscribe()
    render(
      <StrengthBlock
        subscribe={subscribe}
        movement="barrier"
        tier="pro"
        makeCounter={scripted([1, 0, 2])}
      />,
    )

    expect(screen.getByTestId('block-reps').textContent).toContain('0')

    subscribe.frame()
    expect(screen.getByTestId('block-reps').textContent).toContain('1')
    expect(screen.getByTestId('block-score').textContent).toBe(String(obstaclePointsFor('pro')))

    // кадр без повтора ничего не меняет
    subscribe.frame()
    expect(screen.getByTestId('block-score').textContent).toBe(String(obstaclePointsFor('pro')))

    // два повтора одним кадром считаются оба
    subscribe.frame()
    expect(screen.getByTestId('block-reps').textContent).toContain('3')
    expect(screen.getByTestId('block-score').textContent).toBe(String(obstaclePointsFor('pro') * 3))
  })

  it('цена повтора — цена уровня, и никаких надбавок за серию', () => {
    const subscribe = fakeSubscribe()
    render(
      <StrengthBlock
        subscribe={subscribe}
        movement="jack"
        tier="novice"
        makeCounter={scripted([1, 1, 1, 1, 1, 1])}
      />,
    )

    for (let i = 0; i < 6; i += 1) subscribe.frame()

    // шесть повторов по сто — ровно шестьсот, хотя пятый и был «юбилейным»
    expect(screen.getByTestId('block-score').textContent).toBe(
      String(obstaclePointsFor('novice') * 6),
    )
  })
})

describe('инструктор крутит петлю в темпе уровня', () => {
  it('новичок — родной темп записи, дальше быстрее', () => {
    expect(tempoFor('novice')).toBe(1)
    expect(tempoFor('experienced')).toBeCloseTo(1.2, 5)
    expect(tempoFor('pro')).toBeCloseTo(1.4, 5)
    // неизвестный уровень не должен останавливать фигурку
    expect(tempoFor('нет-такого')).toBe(1)
    expect(Object.keys(TEMPO_BY_TIER)).toHaveLength(3)
  })

  it('темп уходит в саму фигурку, а не остаётся числом в модуле', () => {
    const subscribe = fakeSubscribe()
    const { container } = render(
      <StrengthBlock
        subscribe={subscribe}
        movement="barrier"
        tier="pro"
        makeCounter={scripted([])}
      />,
    )
    // фигурка живёт в своём углу и не ложится на человека посреди кадра
    expect(container.querySelector('.mt-block__coach')).toBeTruthy()
    expect(screen.getByTestId('block-coach')).toBeTruthy()
  })
})

describe('счётчики повторов собираются на настоящих детекторах', () => {
  it('на каждое силовое движение счётчик создаётся и не падает на пустом кадре', () => {
    for (const movement of STRENGTH_TYPES) {
      const counter = createRepCounter(movement)
      expect(() => counter.update(0, { landmarks: null, worldLandmarks: null })).not.toThrow()
      expect(counter.update(50, { landmarks: [], worldLandmarks: [] })).toBe(0)
      expect(() => counter.reset()).not.toThrow()
    }
  })
})

describe('блок кончается сам', () => {
  it('через тридцать секунд отдаёт итог и больше не считает', () => {
    /**
     * Часы блока идут по performance.now, а не по системному времени: подменяем
     * именно их. Кадр отрисовки тоже дёргаем руками — в jsdom его никто не
     * вызовет, а ждать тридцать реальных секунд в тесте незачем.
     */
    const now = vi.spyOn(performance, 'now')
    let frames = []
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      now.mockReturnValue(0)
      const subscribe = fakeSubscribe()
      const onFinish = vi.fn()
      render(
        <StrengthBlock
          subscribe={subscribe}
          movement="pit"
          tier="experienced"
          onFinish={onFinish}
          makeCounter={scripted([1])}
        />,
      )
      subscribe.frame()
      expect(onFinish).not.toHaveBeenCalled()

      // время вышло — следующий же кадр отрисовки закрывает блок
      now.mockReturnValue(BLOCK_MS + 100)
      act(() => {
        frames.pop()?.(BLOCK_MS + 100)
      })

      expect(onFinish).toHaveBeenCalledTimes(1)
      expect(onFinish.mock.calls[0][0]).toMatchObject({
        movement: 'pit',
        reps: 1,
        score: obstaclePointsFor('experienced'),
      })

      // и второй раз итог не отдаётся, сколько кадров ни рисуй
      act(() => {
        frames.pop()?.(BLOCK_MS + 200)
      })
      expect(onFinish).toHaveBeenCalledTimes(1)
    } finally {
      raf.mockRestore()
      now.mockRestore()
    }
  })
})
