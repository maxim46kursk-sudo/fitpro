// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import PersonalSetupScreen, { STUCK_MS } from './PersonalSetupScreen.jsx'
import { loadDemoLoops } from '../debug/DemoSkeleton.jsx'
import { SETUP_MOVEMENTS, SETUP_REPS } from '../game/amplitude.js'
import { needsPersonalSetup, readMaxes, resetPersonal } from '../game/personal.js'
import { LM } from '../pose/landmarks.js'

/**
 * «Калибровка»: знакомство с движениями и замер личной амплитуды.
 *
 * Тут проверяется поведение экрана, а не арифметика замера — она живёт в
 * amplitude.js и проверена там. Здесь важнее другое: что человек НЕ ЗАСТРЯНЕТ
 * (движение можно пропустить), что пропуск оставляет общую планку, что «пройти
 * заново» и правда стирает личное и что камера не перекрыта.
 */

/** Кадр с точками: обе стопы поднимаются на footLift долей корпуса. */
function frame(timestamp, { footLift = 0 } = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const at = (index, y, x = 0.5) => {
    points[index] = { x, y, z: 0, visibility: 1 }
  }
  // корпус 0.2: плечи 0.4, таз 0.6
  at(LM.LEFT_SHOULDER, 0.4, 0.45)
  at(LM.RIGHT_SHOULDER, 0.4, 0.55)
  at(LM.LEFT_HIP, 0.6, 0.47)
  at(LM.RIGHT_HIP, 0.6, 0.53)
  at(LM.LEFT_KNEE, 0.8, 0.47)
  at(LM.RIGHT_KNEE, 0.8, 0.53)
  // подъём стоп считается от их же медианы и делится на корпус
  at(LM.LEFT_ANKLE, 0.95 - footLift * 0.2, 0.47)
  at(LM.RIGHT_ANKLE, 0.95 - footLift * 0.2, 0.53)
  return { landmarks: points, worldLandmarks: points, timestamp }
}

/** Подписка, которой можно скармливать кадры прямо из теста. */
function fakeCamera() {
  const subs = new Set()
  let t = 0
  return {
    subscribe: (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    /** Отдать кадр всем подписчикам. */
    send(options) {
      t += 100
      act(() => {
        for (const fn of subs) fn(frame(t, options))
      })
    },
    /**
     * Повтор прыжка: несколько кадров на полу (автомату нужна опора — он
     * считает подъём от медианы стоп), три в воздухе, снова на полу.
     */
    pitRep(lift) {
      for (let i = 0; i < 6; i += 1) this.send({})
      for (let i = 0; i < 3; i += 1) this.send({ footLift: lift })
      for (let i = 0; i < 6; i += 1) this.send({})
    },
  }
}

beforeEach(() => {
  resetPersonal()
  // Часы подменяем ДО рендера: интервал ожидания заводится в эффекте, и
  // созданный настоящим setInterval он фальшивым временем уже не двигается.
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  resetPersonal()
  vi.useRealTimers()
})

describe('калибровка', () => {
  it('идёт по трём силовым движениям и показывает счётчик повторов', () => {
    /**
     * Было девять, и это оказалось входным барьером не хуже платного:
     * двадцать семь подходов ДО первой тренировки, стоя перед камерой в
     * незнакомой игре. Остались силовые — те самые, чья личная планка потом
     * работает в каждом круге сессии.
     */
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    expect(screen.getByTestId('setup-count').textContent).toBe(`0/${SETUP_REPS}`)
    // первым идёт присед — то, что человек уже умеет
    expect(screen.getByTestId('setup-task').textContent).toContain('Присядь')
    expect(SETUP_MOVEMENTS).toEqual(['barrier', 'lunge', 'pit'])
    expect(screen.getByTestId('setup-title').textContent).toBe('Калибровка')
  })

  it('демо-фигурка стоит в своей плашке, а не поверх камеры', async () => {
    // тот же принцип, что в «Калибровке движений»: не видя себя, человек не
    // понимает, попадает ли он в кадр
    await loadDemoLoops()
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    const top = screen.getByTestId('setup-top')
    // фигурка живёт ВНУТРИ плашки, а не отдельным слоем над видео
    expect(top.contains(screen.getByTestId('demo-skeleton'))).toBe(true)
    expect(screen.getByTestId('demo-skeleton').dataset.loop).toBe('barrier')
    // середина экрана свободна: сплошной подложки у экрана нет
    expect(screen.getByTestId('personal-setup').className).toContain('mt-setup--run')
    // счётчик живёт отдельно от плашки — в свободной середине
    expect(top.contains(screen.getByTestId('setup-count'))).toBe(false)
  })

  it('три повтора закрывают движение и запоминают медиану', () => {
    const camera = fakeCamera()
    // начинать сразу с третьего движения нельзя, поэтому пропускаем первые два
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)
    skipTo(camera, 'pit')

    expect(screen.getByTestId('setup-task').textContent).toContain('Подпрыгни')

    camera.pitRep(0.3)
    expect(screen.getByTestId('setup-count').textContent).toBe(`1/${SETUP_REPS}`)
    camera.pitRep(0.9)
    camera.pitRep(0.5)

    // медиана трёх, а не лучший из них: один шумный повтор не задирает планку
    expect(readMaxes().pit).toBeCloseTo(0.5, 5)
    // прыжок последний в калибровке — за ним сводка
    expect(screen.getByTestId('setup-summary')).toBeTruthy()
  })

  it('через 25 секунд без повтора появляется «Пропустить движение»', () => {
    // Человек не должен застрять перед платным челленджем: причина может быть
    // любой — тесная комната, слабая камера, непонятая инструкция.
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    expect(screen.queryByTestId('setup-skip')).toBeNull()

    waitStuck(camera)

    expect(screen.getByTestId('setup-skip')).toBeTruthy()
    expect(screen.getByTestId('setup-stuck').textContent).toContain('общей планке')
  })

  it('пока кадров нет, время ожидания не течёт: человек не виноват', () => {
    // иначе кнопка «пропустить» вылезала бы тому, кто просто вышел за водой
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    camera.send({})
    // камера замолчала, а часы идут
    act(() => vi.advanceTimersByTime(STUCK_MS * 2))

    expect(screen.queryByTestId('setup-skip')).toBeNull()
  })

  it('пропуск оставляет общую планку и не роняет поток', () => {
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    const first = screen.getByTestId('setup-task').textContent
    skip(camera)

    // движение пропущено: личных данных по нему нет, планка осталась общей
    expect(readMaxes().barrier).toBeUndefined()
    // а поток пошёл дальше, а не встал
    expect(screen.getByTestId('setup-task').textContent).not.toBe(first)
    expect(screen.getByTestId('setup-count').textContent).toBe(`0/${SETUP_REPS}`)
  })

  it('неполный замер планку НЕ пишет, даже если повторы были', () => {
    /**
     * Полевой тест 13 августа: человек сделал часть повторов удара, не смог
     * доделать и нажал «Пропустить» — планка всё равно записалась, по одному
     * замеру вместо медианы трёх. То есть защита от выброса, ради которой
     * повторов именно три, не сработала. А лог написал «reps 0, skipped» и
     * противоречил сам себе.
     */
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)
    skipTo(camera, 'pit')

    // два повтора из трёх — и человек сдаётся
    camera.pitRep(0.4)
    camera.pitRep(0.9)
    expect(screen.getByTestId('setup-count').textContent).toBe(`2/${SETUP_REPS}`)
    skip(camera)

    // планки нет: медианы из двух повторов не бывает
    expect(readMaxes().pit).toBeUndefined()
    // и поток пошёл дальше, а не встал
    expect(screen.getByTestId('setup-summary')).toBeTruthy()
  })

  it('в конце — сводка своими словами и пометка у пропущенных', () => {
    const camera = fakeCamera()
    const onDone = vi.fn()
    render(<PersonalSetupScreen subscribe={camera.subscribe} onDone={onDone} />)

    // проходим все три, настроив только прыжок
    for (const movement of SETUP_MOVEMENTS) {
      if (movement === 'pit') {
        camera.pitRep(0.4)
        camera.pitRep(0.5)
        camera.pitRep(0.6)
      } else {
        skip(camera)
      }
    }

    expect(screen.getByTestId('setup-summary')).toBeTruthy()
    // у настроенного движения планка своя и объяснена по-человечески
    expect(screen.getByTestId('setup-row-pit').textContent).toContain('корпуса от пола')
    expect(screen.getByTestId('setup-row-pit').textContent).not.toContain('общая')
    // у пропущенного честно сказано, что планка общая
    expect(screen.getByTestId('setup-row-barrier').textContent).toContain('общая')

    fireEvent.click(screen.getByTestId('setup-done'))
    expect(onDone).toHaveBeenCalled()
  })

  it('«Пройти заново» стирает личные данные и начинает сначала', () => {
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    for (const movement of SETUP_MOVEMENTS) {
      if (movement === 'pit') {
        camera.pitRep(0.4)
        camera.pitRep(0.5)
        camera.pitRep(0.6)
      } else {
        skip(camera)
      }
    }
    expect(readMaxes().pit).toBeCloseTo(0.5, 5)

    fireEvent.click(screen.getByTestId('setup-restart'))

    expect(readMaxes()).toEqual({})
    // и человек снова на первом движении
    expect(screen.getByTestId('setup-task').textContent).toContain('Присядь')
    expect(screen.queryByTestId('setup-summary')).toBeNull()
  })

  it('ни очков, ни таймера — это знакомство, а не зачёт', () => {
    // гонка на этом экране прямо вредит его цели: человек начнёт частить и
    // покажет не свою амплитуду, а свою торопливость
    const camera = fakeCamera()
    const { container } = render(<PersonalSetupScreen subscribe={camera.subscribe} />)

    expect(screen.getByTestId('personal-setup').textContent).toContain('Не спеши')
    // ни счёта, ни обратного отсчёта, ни полосы времени — как в игре
    expect(container.querySelector('.mt-game__score')).toBeNull()
    expect(container.querySelector('.mt-game__timer')).toBeNull()
    // единственная цифра на экране — сколько повторов уже сделано
    expect(screen.getByTestId('setup-count').textContent).toBe(`0/${SETUP_REPS}`)
  })
})

describe('когда экран показывается сам', () => {
  it('пустой профиль — ведём на настройку', () => {
    expect(needsPersonalSetup()).toBe(true)
  })

  it('заполненный профиль — не показываем, человек идёт играть', () => {
    const camera = fakeCamera()
    render(<PersonalSetupScreen subscribe={camera.subscribe} />)
    skipTo(camera, 'pit')
    camera.pitRep(0.4)
    camera.pitRep(0.5)
    camera.pitRep(0.6)

    // хоть одно настроенное движение — и человека больше не перехватывают
    expect(needsPersonalSetup()).toBe(false)
  })
})

/**
 * Пропустить текущее движение: пробуем, ничего не выходит, жмём кнопку.
 *
 * Кадры при этом идут: ожидание считается только пока камера работает — иначе
 * «прошло 25 секунд» означало бы «вкладка провисела полминуты», и кнопка
 * вылезала бы человеку, который вышел за водой.
 */
function waitStuck(camera) {
  for (let waited = 0; waited < STUCK_MS; waited += 1000) {
    camera.send({})
    act(() => vi.advanceTimersByTime(1000))
  }
}

function skip(camera) {
  waitStuck(camera)
  fireEvent.click(screen.getByTestId('setup-skip'))
}

/** Пропускать движения, пока не дойдём до нужного. */
function skipTo(camera, movement) {
  for (const id of SETUP_MOVEMENTS) {
    if (id === movement) return
    skip(camera)
  }
}
