// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import RoomScreen, { readRoom } from './RoomScreen.jsx'
import { PASSPORT, expectPassport } from '../test/passport.js'
import { DAYS, DELOAD, advanceDay, completeDay, resetProgress } from '../game/challenge.js'
import { submitAttempt } from '../game/day.js'

/**
 * МОЯ КОМНАТА. Проверяется не вёрстка, а два разных риска.
 *
 * Первый — арифметика: каждое число комнаты у человека без истории делится на
 * ноль. Второй — пропажа: экран собран из семи независимых кусков, и любой из
 * них можно потерять, не сломав остальных.
 */

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  resetProgress()
})

/** Пройти челлендж до названного дня так, как его проходит человек. */
function walkTo(day) {
  for (let n = 1; n < day; n += 1) {
    completeDay(n)
    advanceDay()
  }
}

describe('пустая комната не роняет экран', () => {
  it('человек ещё не играл — нули и прочерки, а не деление на ноль', () => {
    /**
     * Каждое число комнаты у новичка — деление на ноль: средняя реакция без
     * попаданий, точность без мишеней, лучший день без дней. Проверять такое
     * надо тестом, а не глазами на телефоне единственного участника без истории.
     */
    const room = readRoom(1)

    expect(room.total).toBe(0)
    expect(room.doneCount).toBe(0)
    expect(room.reactMs).toBe(0)
    expect(room.accuracy).toBe(0)
    expect(room.best).toEqual({ day: 0, total: 0 })
    expect(room.rows).toHaveLength(DAYS)
    expect(Number.isNaN(room.accuracy)).toBe(false)
  })

  it('и показывает прочерки вместо нулей там, где числа ещё нет', () => {
    render(<RoomScreen day={1} />)

    expect(screen.getByTestId('room-total').textContent).toBe('0')
    expect(screen.getByTestId('room-react').textContent).toContain('—')
    expect(screen.getByTestId('room-accuracy').textContent).toContain('—')
    expect(screen.getByTestId('room-best').textContent).toContain('—')
    // паспорт держится и на пустой комнате: пропасть тут нечему
    expectPassport('моя комната', PASSPORT.room)
  })
})

describe('показатели считаются по всем попыткам', () => {
  it('реакция взвешена по попаданиям, а не усреднена по попыткам', () => {
    /**
     * Заход с четырьмя случайными попаданиями не может весить столько же,
     * сколько отработанная сессия из пятисот: у первого реакция почти
     * случайна. Здесь: 500 попаданий по 600 мс и 4 по 1400 — правильная
     * средняя 606, простое среднее по попыткам дало бы 1000.
     */
    submitAttempt('pro', { score: 100, hits: 500, spawned: 520, reactMs: 600 }, 1)
    submitAttempt('pro', { score: 20, hits: 4, spawned: 40, reactMs: 1400 }, 1)

    expect(readRoom(1).reactMs).toBe(606)
  })

  it('попытка без замера реакции среднюю не обнуляет', () => {
    // ноль значит «замера не было», а не «мгновенно»
    submitAttempt('pro', { score: 100, hits: 100, spawned: 100, reactMs: 700 }, 1)
    submitAttempt('novice', { score: 50, hits: 100, spawned: 100, reactMs: 0 }, 1)

    expect(readRoom(1).reactMs).toBe(700)
  })

  it('точность — попадания ко всем мишеням за челлендж', () => {
    submitAttempt('pro', { score: 10, hits: 60, spawned: 100 }, 1)
    submitAttempt('pro', { score: 10, hits: 30, spawned: 100 }, 2)

    const room = readRoom(2)
    expect(room.hits).toBe(90)
    expect(room.spawned).toBe(200)
    expect(room.accuracy).toBe(45)
  })

  it('лучший день — максимум по ЗАЧЁТУ дня, то есть по лучшему заходу', () => {
    // в первом дне два захода по 1000, во втором один на 1500: зачёт дня —
    // лучший заход, поэтому второй день сильнее, хоть заход там и один
    submitAttempt('pro', { score: 1000 }, 1)
    submitAttempt('novice', { score: 1000 }, 1)
    submitAttempt('pro', { score: 1500 }, 2)

    expect(readRoom(2).best).toEqual({ day: 2, total: 1500 })
  })

  it('счёт челленджа и число сданных дней', () => {
    walkTo(3)
    submitAttempt('pro', { score: 400 }, 1)
    submitAttempt('pro', { score: 600 }, 2)

    const room = readRoom(3)
    expect(room.total).toBe(1000)
    expect(room.doneCount).toBe(2)
    expect(room.day).toBe(3)
  })
})

describe('динамика и календарь', () => {
  it('высота столбика считается от лучшего дня', () => {
    /**
     * От лучшего, а не от максимума шкалы: абсолютные очки зависят от уровня, и
     * рядом с профи новичок видел бы у себя тридцать одинаковых точек у пола.
     */
    submitAttempt('pro', { score: 1000 }, 1)
    submitAttempt('pro', { score: 500 }, 2)

    const rows = readRoom(1).rows
    expect(rows[0].height).toBe(100)
    expect(rows[1].height).toBe(50)
    // несыгранный день — тонкий след, а не пустое место
    expect(rows[2].height).toBe(2)
  })

  it('тридцать столбиков и тридцать ячеек, текущий день подсвечен', () => {
    render(<RoomScreen day={4} />)

    expect(screen.getByTestId('room-chart').children).toHaveLength(DAYS)
    expect(screen.getByTestId('room-days').children).toHaveLength(DAYS)
    expect(screen.getByTestId('room-bar-4').className).toContain('is-now')
    expect(screen.getByTestId('room-day-4').className).toContain('is-now')
    // подсвечен ровно один день, а не все подряд
    expect(screen.getByTestId('room-day-5').className).not.toContain('is-now')
  })

  it('сданные и будущие дни помечены по-разному', () => {
    walkTo(3)
    submitAttempt('pro', { score: 700 }, 1)
    render(<RoomScreen day={3} />)

    expect(screen.getByTestId('room-day-1').className).toContain('is-done')
    expect(screen.getByTestId('room-day-1').textContent).toContain('700')
    expect(screen.getByTestId('room-day-10').className).toContain('is-future')
    expect(screen.getByTestId('room-day-3').className).not.toContain('is-future')
  })

  it('разгрузочные дни ничем не выделены — это внутренняя кухня плана', () => {
    /**
     * Названная разгрузка становится разрешением: человек, увидевший её в
     * календаре, приходит в этот день вполсилы, и день перестаёт работать.
     * Разгружает его план сам — интенсивность и замены движений на месте.
     */
    render(<RoomScreen day={1} />)

    for (const day of DELOAD) {
      const cell = screen.getByTestId(`room-day-${day}`)
      expect(cell.textContent).not.toContain('разгрузка')
      expect(cell.className).not.toContain('deload')
      // и от соседнего обычного дня ничем не отличается
      expect(cell.className).toBe(screen.getByTestId(`room-day-${day - 1}`).className)
    }
    // поля тоже нет: неиспользуемое рано или поздно попадает на экран
    expect(readRoom(1).rows[6]).not.toHaveProperty('deload')
  })

  it('шапка называет день и число сданных', () => {
    walkTo(5)
    render(<RoomScreen day={5} />)
    expect(screen.getByTestId('room-where').textContent).toBe('День 5 из 30 · сдано 4')
  })
})
