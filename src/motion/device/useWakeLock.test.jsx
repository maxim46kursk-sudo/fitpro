// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useWakeLock, resetWakeLock } from './useWakeLock.js'

/**
 * ОДИН ЛОК НА ВЕСЬ РАЗДЕЛ И ЧЕСТНОЕ ИМЯ СОБЫТИЯ.
 *
 * Из поля пришло «wakelock.lost по два раза за тренировку на обоих телефонах».
 * Разбор журнала: обе строки в одну миллисекунду, через 26–28 с после
 * последнего блока, вместе с page.hidden. То есть срыва не было вовсе — было
 * штатное снятие при сворачивании, посчитанное дважды, потому что лок просили
 * три экрана сразу.
 */

const events = []
vi.mock('../debug/logShipper.js', () => ({
  logEvent: (tag, data) => events.push([tag, data]),
}))

let requests = 0
let releases = 0
let listeners = []

function fakeSentinel() {
  return {
    addEventListener: (kind, fn) => {
      if (kind === 'release') listeners.push(fn)
    },
    release: () => {
      releases += 1
      listeners.forEach((fn) => fn())
      return Promise.resolve()
    },
  }
}

/** Система сняла лок сама: браузер зовёт release, нас не спрашивая. */
const снятоСистемой = () => act(() => listeners.forEach((fn) => fn()))

const видимость = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

// имя латиницей: правило react-hooks/rules-of-hooks узнаёт компонент
// по заглавной букве, и кириллическая «Э» ему таковой не кажется
function MotionScreen() {
  useWakeLock(true)
  return null
}

beforeEach(() => {
  events.length = 0
  listeners = []
  requests = 0
  releases = 0
  видимость('visible')
  globalThis.navigator.wakeLock = {
    request: () => {
      requests += 1
      return Promise.resolve(fakeSentinel())
    },
  }
})

afterEach(() => {
  cleanup()
  resetWakeLock()
  delete globalThis.navigator.wakeLock
})

const дать = () => act(async () => {})

describe('общий лок экрана', () => {
  it('три экрана просят — лок берётся один', async () => {
    render(
      <>
        <MotionScreen />
        <MotionScreen />
        <MotionScreen />
      </>,
    )
    await дать()
    expect(requests).toBe(1)
  })

  it('лок отпускается, когда ушёл ПОСЛЕДНИЙ экран, а не первый', async () => {
    const { rerender } = render(
      <>
        <MotionScreen />
        <MotionScreen />
      </>,
    )
    await дать()
    rerender(
      <>
        <MotionScreen />
      </>,
    )
    await дать()
    expect(releases).toBe(0)

    rerender(<></>)
    await дать()
    expect(releases).toBe(1)
  })

  it('своё снятие в журнал не идёт', async () => {
    const { rerender } = render(<MotionScreen />)
    await дать()
    rerender(<></>)
    await дать()
    expect(events).toEqual([])
  })

  it('сворачивание вкладки — это пауза, а не срыв', async () => {
    render(<MotionScreen />)
    await дать()
    видимость('hidden')
    снятоСистемой()
    expect(events.map((e) => e[0])).toEqual(['wakelock.paused'])
  })

  it('лок сняли, а человек смотрит на экран — вот это срыв', async () => {
    render(<MotionScreen />)
    await дать()
    снятоСистемой()
    expect(events.map((e) => e[0])).toEqual(['wakelock.lost'])
  })

  it('одно снятие — одна строка, сколько бы экранов ни было', async () => {
    render(
      <>
        <MotionScreen />
        <MotionScreen />
        <MotionScreen />
      </>,
    )
    await дать()
    видимость('hidden')
    снятоСистемой()
    expect(events).toHaveLength(1)
  })

  it('вернулись во вкладку — лок берётся заново', async () => {
    render(<MotionScreen />)
    await дать()
    видимость('hidden')
    снятоСистемой()
    видимость('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(requests).toBe(2)
  })

  it('без поддержки в браузере ничего не ломается', async () => {
    delete globalThis.navigator.wakeLock
    render(<MotionScreen />)
    await дать()
    expect(events).toEqual([])
  })
})
