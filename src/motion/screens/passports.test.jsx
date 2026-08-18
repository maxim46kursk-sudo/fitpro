// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import SessionScreen from './SessionScreen.jsx'
import SessionResult from './SessionResult.jsx'
import LevelSelectScreen from './LevelSelectScreen.jsx'
import GameScreen from './GameScreen.jsx'
import { PASSPORT, expectPassport } from '../test/passport.js'
import { dayPlan } from '../game/challenge.js'
import { FIGHT_TYPES, START_COUNTDOWN_MS } from '../game/session.js'

/**
 * ПАСПОРТА ЭКРАНОВ: что человек обязан видеть на каждом.
 *
 * Остальные тесты экранов проверяют поведение и по одному куску за раз —
 * пропажу элемента не ловит ни один из них. Элемент можно случайно вынести за
 * условие, задеть при вёрстке соседа, потерять при переносе разметки, и все
 * тесты останутся зелёными. Узнаем мы об этом от человека в поле, у которого
 * пропал таймер или счёт.
 *
 * Экраны сессии проверяются В СОСТАВЕ СЕССИИ, а не поодиночке: половина
 * обязательных элементов (полоса круга, счёт в ней, кнопка меню) приходит
 * снаружи, и собранные вручную пропсы проверяли бы не приложение, а тест.
 */

afterEach(cleanup)

const noopSubscribe = () => () => {}
const DAY1 = dayPlan(1)

/** Пережить стартовый отсчёт целиком — с него начинается любая сессия. */
const START_MS = START_COUNTDOWN_MS + 100

function runClock(frames, now, ms) {
  act(() => {
    now.mockReturnValue(now() + ms)
    frames.splice(0).forEach((cb) => cb(now()))
  })
}

function startSession() {
  const frames = []
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  render(<SessionScreen subscribe={noopSubscribe} tier="pro" />)
  return {
    frames,
    now,
    restore: () => {
      raf.mockRestore()
      now.mockRestore()
    },
  }
}

describe('паспорта экранов сессии', () => {
  it('отдых: таймер, «дальше», счёт и круг', () => {
    const { frames, now, restore } = startSession()
    try {
      // первый отсчёт идёт крупными секундами, обычный отдых — таймером;
      // паспорт отдыха проверяем на отдыхе, а не на отсчёте
      runClock(frames, now, START_MS)
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)

      expect(screen.getByTestId('rest-screen')).toBeTruthy()
      expectPassport('отдых', PASSPORT.rest)
    } finally {
      restore()
    }
  })

  it('отдых перед силовым движением показывает инструктора', () => {
    /**
     * Фигурка крутит СЛЕДУЮЩЕЕ движение — к началу блока человек успевает и
     * вспомнить его, и встать в кадр. Перед боем её нет и быть не должно: бой
     * не движение, показывать нечего.
     */
    const { frames, now, restore } = startSession()
    try {
      // самый первый отсчёт: дальше — первое силовое движение дня
      expect(screen.getByTestId('rest-coach')).toBeTruthy()

      runClock(frames, now, START_MS)
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)
      // а этот отдых ведёт в бой
      expect(screen.getByTestId('rest-next').textContent).toContain('БОЙ')
      expect(screen.queryByTestId('rest-coach')).toBeNull()
    } finally {
      restore()
    }
  })

  it('силовой блок: инструктор, команда, таймер, повторы, счёт, круг', () => {
    const { frames, now, restore } = startSession()
    try {
      runClock(frames, now, START_MS)
      expectPassport('силовой блок', PASSPORT.strength)
    } finally {
      restore()
    }
  })

  it('бой: счёт, часы, уровень, меню, круг', () => {
    const { frames, now, restore } = startSession()
    try {
      runClock(frames, now, START_MS)
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)
      runClock(frames, now, DAY1.restStrengthSec * 1000 + 100)

      expect(screen.getByTestId('game-canvas')).toBeTruthy()
      expectPassport('бой', PASSPORT.fight)
    } finally {
      restore()
    }
  })

  it('в бою сессии нет углового крестика: выход только через меню', () => {
    /**
     * Крестик лежал поверх блока очков — то есть закрывал ровно то число, ради
     * которого человек работает. И дублировал выход из меню, дублировал плохо:
     * он обрывал тренировку молча, а меню сначала ставит паузу и спрашивает.
     * Две двери с разным поведением на одном экране — человек нажмёт ту, что
     * ближе, и потеряет двадцать минут.
     */
    const { frames, now, restore } = startSession()
    try {
      runClock(frames, now, START_MS)
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)
      runClock(frames, now, DAY1.restStrengthSec * 1000 + 100)

      expect(screen.getByTestId('game-canvas')).toBeTruthy()
      expect(screen.queryByTestId('game-cancel')).toBeNull()
      // а выход при этом есть — через меню
      expect(screen.getByTestId('session-menu-button')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('в одиночном раунде крестик остаётся: другого выхода там нет', () => {
    // меню в ?round=1 нет вовсе, и без крестика человек заперт в раунде
    render(
      <GameScreen
        subscribe={noopSubscribe}
        tier="pro"
        config={{ types: FIGHT_TYPES, durationMs: 90000, practiceNeeded: 0 }}
        onFinish={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByTestId('game-cancel')).toBeTruthy()
  })

  it('кнопка меню есть на всех трёх экранах, а не только в бою', () => {
    /**
     * До меню выйти из сессии было нечем: крестик жил внутри боя, а из блока и
     * отдыха выхода не было вовсе. Человек, которому позвонили на третьем
     * круге, терял двадцать минут работы.
     */
    const { frames, now, restore } = startSession()
    try {
      expect(screen.getByTestId('session-menu-button')).toBeTruthy()
      runClock(frames, now, START_MS)
      expect(screen.getByTestId('session-menu-button')).toBeTruthy()
      runClock(frames, now, DAY1.strengthSec * 1000 + 100)
      expect(screen.getByTestId('session-menu-button')).toBeTruthy()
    } finally {
      restore()
    }
  })
})

describe('паспорта экранов вокруг сессии', () => {
  it('выбор уровня: день челленджа, три уровня и обе суммы', () => {
    // пятый день ещё бесплатный: карточки уровней на месте
    render(<LevelSelectScreen challengeDay={5} challengeDays={30} />)
    expectPassport('выбор уровня', PASSPORT.levels)
    expect(screen.getByTestId('challenge-day').textContent).toBe('День 5 из 30')
  })

  it('за границей бесплатных дней — паспорт плашки вместо уровней', () => {
    // человек не в тупике: ему показывают его собственные цифры и предлагают
    // продолжить, а комната и набранное остаются при нём
    render(<LevelSelectScreen challengeDay={6} challengeDays={30} onRoom={() => {}} />)
    expectPassport('граница бесплатных дней', PASSPORT.wall)
    expect(screen.queryByTestId('level-pro')).toBeNull()
  })

  it('калибровка называет себя на обоих своих видах', () => {
    render(<LevelSelectScreen challengeDay={1} onSetup={() => {}} />)
    expect(screen.getByTestId('level-setup').textContent).toBe('Калибровка')
  })

  it('финальный лист: очки, «ещё раз», «в меню»', () => {
    render(
      <SessionResult
        result={{
          score: 4200,
          hitPoints: 200,
          level: { id: 'pro', name: 'ПРОФИ' },
          day: 1,
          strength: [{ cycle: 0, movement: 'barrier', reps: 7, score: 1400 }],
          fights: [{ cycle: 0, cleared: 14, spawned: 20, score: 2800 }],
        }}
        onExit={() => {}}
        onRestart={() => {}}
      />,
    )
    expectPassport('финальный лист', PASSPORT.final)
  })
})

describe('помощник паспортов', () => {
  it('пропажа элемента — красный тест с именем пропавшего и причиной', () => {
    /**
     * Паспорт ценен ровно настолько, насколько внятно он падает: получивший
     * красный тест не должен гадать, важна пропажа или нет.
     */
    render(<div data-testid="есть" />)
    expect(() =>
      expectPassport('выдуманный', [
        { testid: 'есть', что: 'этот на месте', зачем: 'и не должен мешать' },
        { testid: 'пропал', что: 'таймер', зачем: 'без него не видно, сколько осталось' },
      ]),
    ).toThrow(/таймер.*пропал.*сколько осталось/s)
  })
})
