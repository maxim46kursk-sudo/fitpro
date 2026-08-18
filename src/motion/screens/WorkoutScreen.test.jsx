// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import WorkoutScreen from './WorkoutScreen.jsx'
import { LM } from '../pose/landmarks.js'

/**
 * Таймер подхода живёт в requestAnimationFrame, поэтому здесь мы подменяем
 * и rAF, и performance.now — время двигаем руками, тест получается детерминированным.
 */

let now = 0
let rafQueue = []
let emit = null

function frame(dt = 16) {
  now += dt
  const callbacks = rafQueue
  rafQueue = []
  act(() => {
    callbacks.forEach((cb) => cb(now))
  })
}

/** Прокрутить время на ms миллисекунд шагами по 16 мс. */
function advance(ms, onEachFrame) {
  const steps = Math.ceil(ms / 16)
  for (let i = 0; i < steps; i += 1) {
    onEachFrame?.()
    frame(16)
  }
}

/** Кадр с человеком в нужной позе (угол в колене). */
function pushPose(angleDeg, visibility = 1, { ankleY = 0.8 } = {}) {
  const t = (angleDeg * Math.PI) / 180
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  landmarks[LM.LEFT_ANKLE] = { x: 0.5, y: ankleY, z: 0, visibility }
  landmarks[LM.RIGHT_ANKLE] = { x: 0.5, y: ankleY, z: 0, visibility }
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }))
  for (const [h, k, a] of [
    [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
    [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
  ]) {
    world[h] = { x: Math.sin(t) * 0.5, y: Math.cos(t) * 0.5, z: 0, visibility }
    world[k] = { x: 0, y: 0, z: 0, visibility }
    world[a] = { x: 0, y: 0.5, z: 0, visibility }
  }
  act(() => {
    emit?.({ landmarks, worldLandmarks: world, timestamp: now })
  })
}

const subscribe = (fn) => {
  emit = fn
  return () => {
    emit = null
  }
}

beforeEach(() => {
  now = 0
  rafQueue = []
  emit = null
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb) => rafQueue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkoutScreen', () => {
  it('не запускает таймер, пока человека не видно', () => {
    render(<WorkoutScreen subscribe={subscribe} onFinish={() => {}} />)

    // ни одного кадра ещё не пришло: таймер стоит, но и оверлей не мигаем —
    // иначе сразу после «Начали!» человек услышит «встань в кадр»
    advance(2000)
    expect(screen.getByText('1:00')).toBeTruthy()
    expect(screen.queryByTestId('frame-blocker')).toBeNull()

    // кадры пошли, но человека в них нет — вот теперь предупреждаем
    advance(2000, () => pushPose(175, 0.1))
    expect(screen.getByText('1:00')).toBeTruthy()
    expect(screen.getByTestId('frame-blocker')).toBeTruthy()
  })

  it('таймер идёт, пока человек в кадре', () => {
    render(<WorkoutScreen subscribe={subscribe} onFinish={() => {}} />)

    advance(3000, () => pushPose(175))

    expect(screen.queryByText('Встань в кадр')).toBeNull()
    expect(screen.getByText('0:57')).toBeTruthy()
  })

  it('человек вышел из кадра — таймер встал, подсказка показана; вернулся — продолжил', () => {
    render(<WorkoutScreen subscribe={subscribe} onFinish={() => {}} />)

    advance(2000, () => pushPose(175))
    expect(screen.getByText('0:58')).toBeTruthy()

    // пропал: visibility ниже порога
    advance(3000, () => pushPose(175, 0.1))
    expect(screen.getByText('Встань в кадр')).toBeTruthy()
    // за 3 секунды отсутствия таймер ушёл максимум на грейс-период (400 мс)
    expect(screen.getByText('0:58')).toBeTruthy()

    // вернулся — счёт продолжился с того же места
    advance(2000, () => pushPose(175))
    expect(screen.queryByText('Встань в кадр')).toBeNull()
    expect(screen.getByText('0:56')).toBeTruthy()
  })

  it('считает повторы и по нулю таймера отдаёт результат', () => {
    const onFinish = vi.fn()
    render(<WorkoutScreen subscribe={subscribe} onFinish={onFinish} duration={5} />)

    // три полных приседа: вниз ~500 мс, вверх ~500 мс
    for (let rep = 0; rep < 3; rep += 1) {
      advance(500, () => pushPose(80))
      advance(500, () => pushPose(175))
    }

    expect(screen.getByText('3')).toBeTruthy()

    // домотать до нуля
    advance(4000, () => pushPose(175))

    expect(onFinish).toHaveBeenCalledTimes(1)
    const stats = onFinish.mock.calls[0][0]
    expect(stats.reps).toBe(3)
    expect(stats.avgDepth).toBeLessThan(100)
    expect(stats.seconds).toBe(5)
  })

  it('угловая кнопка отменяет подход', () => {
    const onFinish = vi.fn()
    const onCancel = vi.fn()
    render(<WorkoutScreen subscribe={subscribe} onFinish={onFinish} onCancel={onCancel} />)

    advance(500, () => pushPose(80))
    advance(500, () => pushPose(175))

    act(() => {
      screen.getByLabelText('Отменить подход').click()
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('голеностоп чуть за краем кадра — это НЕ повод останавливать подход', () => {
    render(<WorkoutScreen subscribe={subscribe} onFinish={() => {}} />)

    // координата 1.02 — небольшой выход за кадр, модель там ещё считает
    advance(1000, () => pushPose(175, 1, { ankleY: 1.02 }))
    expect(screen.queryByTestId('frame-blocker')).toBeNull()

    advance(500, () => pushPose(80, 1, { ankleY: 1.02 }))
    advance(500, () => pushPose(175, 1, { ankleY: 1.02 }))
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('точка далеко за кадром дольше 0.7 с ставит подход на паузу', () => {
    render(<WorkoutScreen subscribe={subscribe} onFinish={() => {}} />)

    advance(1000, () => pushPose(175))
    expect(screen.queryByTestId('frame-blocker')).toBeNull()

    // одиночный плохой кадр паузу не включает
    act(() => pushPose(175, 1, { ankleY: 1.4 }))
    advance(200, () => pushPose(175))
    expect(screen.queryByTestId('frame-blocker')).toBeNull()

    // а вот 1 секунда подряд — включает
    advance(1000, () => pushPose(175, 1, { ankleY: 1.4 }))
    expect(screen.getByTestId('frame-blocker')).toBeTruthy()

    // приседания в этом состоянии не считаются вообще
    for (let i = 0; i < 4; i += 1) {
      advance(500, () => pushPose(80, 1, { ankleY: 1.4 }))
      advance(500, () => pushPose(175, 1, { ankleY: 1.4 }))
    }
    expect(screen.getByText('0')).toBeTruthy()

    // возврат снимает паузу с первого же хорошего кадра
    advance(100, () => pushPose(175))
    expect(screen.queryByTestId('frame-blocker')).toBeNull()
  })
})
