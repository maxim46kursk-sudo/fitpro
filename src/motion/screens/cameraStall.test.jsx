// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { act } from 'react'
import GameScreen from './GameScreen.jsx'
import { FIGHT_TYPES } from '../game/session.js'
import { LM } from '../pose/landmarks.js'

/**
 * СЛОЙ ПАУЗЫ, КОГДА КАМЕРА ВСТАЛА.
 *
 * Полевой баг: у человека останавливалось распознавание (звонок, свёрнутый
 * Safari, перегрев), кадры переставали приходить — и бой вставал в вечную паузу
 * с текстом «Отойди дальше, не видно стоп». Текст был ПОСЛЕДНЕЙ причиной из
 * frameGate, застывшей в момент, когда кадры кончились: человек отходил,
 * подходил, отходил снова, потому что игра всё это время говорила, что дело в
 * нём. Кнопок на карточке не было вовсе, и выйти можно было только закрыв
 * вкладку — вместе с результатом захода.
 *
 * Здесь проверяется ровно слой паузы: судейство, пороги и логика зачёта
 * frameGate не тронуты и не проверяются.
 */

afterEach(cleanup)

/** Поза, которую frameGate признаёт годной: все шесть точек видны и в кадре. */
function goodPose() {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }))
  pts[LM.NOSE] = { x: 0.5, y: 0.12, z: 0, visibility: 0.99 }
  pts[LM.LEFT_SHOULDER] = { x: 0.42, y: 0.3, z: 0, visibility: 0.99 }
  pts[LM.RIGHT_SHOULDER] = { x: 0.58, y: 0.3, z: 0, visibility: 0.99 }
  pts[LM.LEFT_HIP] = { x: 0.44, y: 0.55, z: 0, visibility: 0.99 }
  pts[LM.RIGHT_HIP] = { x: 0.56, y: 0.55, z: 0, visibility: 0.99 }
  pts[LM.LEFT_KNEE] = { x: 0.44, y: 0.72, z: 0, visibility: 0.99 }
  pts[LM.RIGHT_KNEE] = { x: 0.56, y: 0.72, z: 0, visibility: 0.99 }
  pts[LM.LEFT_ANKLE] = { x: 0.44, y: 0.9, z: 0, visibility: 0.99 }
  pts[LM.RIGHT_ANKLE] = { x: 0.56, y: 0.9, z: 0, visibility: 0.99 }
  return pts
}

/**
 * Стенд: свои часы и свой rAF, чтобы «прошло три секунды» было утверждением, а
 * не ожиданием. Подписка отдаёт кадры руками — как это делает камера.
 */
function mount(props = {}) {
  const frames = []
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  let push = null
  const subscribe = (fn) => {
    push = fn
    return () => { push = null }
  }

  render(
    <GameScreen
      subscribe={subscribe}
      tier="pro"
      config={{ types: FIGHT_TYPES, durationMs: 90000, practiceNeeded: 0 }}
      onFinish={() => {}}
      onCancel={() => {}}
      {...props}
    />,
  )

  /** Прокрутить экранные часы на ms, отдав накопленные кадры. */
  const tick = (ms) => {
    act(() => {
      now.mockReturnValue(now() + ms)
      frames.splice(0).forEach((cb) => cb(now()))
    })
  }

  /** Кадр от камеры: ровно то, на что подписан экран. */
  const frame = () => {
    act(() => {
      push?.({ landmarks: goodPose(), worldLandmarks: null, timestamp: now(), frameW: 640, frameH: 480 })
    })
  }

  return { tick, frame, restore: () => { raf.mockRestore(); now.mockRestore() } }
}

describe('камера остановилась: карточка паузы', () => {
  it('пока кадры идут — карточки нет вовсе', () => {
    const { tick, frame, restore } = mount()
    try {
      frame()
      tick(50)
      frame()
      tick(50)
      expect(screen.queryByTestId('frame-blocker')).toBeNull()
    } finally {
      restore()
    }
  })

  it('кадры прекратились — пауза и ЧЕСТНЫЙ текст «Камера остановилась»', () => {
    const { tick, frame, restore } = mount()
    try {
      frame()
      tick(50)
      // кадров больше нет: только часы
      tick(4000)

      expect(screen.getByTestId('frame-blocker')).toBeTruthy()
      expect(screen.getByTestId('blocker-stalled')).toBeTruthy()
      expect(screen.getByText('Камера остановилась')).toBeTruthy()
      // и НИ СЛОВА про стопы: причина из frameGate устарела в тот момент,
      // когда кадры перестали приходить
      expect(screen.queryByText(/не видно стоп/i)).toBeNull()
      expect(screen.queryByText(/Отойди дальше/i)).toBeNull()
    } finally {
      restore()
    }
  })

  it('кадры вернулись — пауза снимается сама, карточка уходит', () => {
    const { tick, frame, restore } = mount()
    try {
      frame()
      tick(50)
      tick(4000)
      expect(screen.getByTestId('blocker-stalled')).toBeTruthy()

      // камера ожила
      frame()
      tick(50)
      frame()
      tick(50)

      expect(screen.queryByTestId('frame-blocker')).toBeNull()
    } finally {
      restore()
    }
  })

  it('ОДНА автоматическая попытка поднять камеру, а не бесконечный цикл', () => {
    const onRestartCamera = vi.fn()
    const { tick, frame, restore } = mount({ onRestartCamera })
    try {
      frame()
      tick(50)
      tick(4000)
      expect(onRestartCamera).toHaveBeenCalledTimes(1)

      // тишина продолжается — повторно сами не дёргаем
      tick(4000)
      tick(4000)
      expect(onRestartCamera).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('попытка не помогла — есть кнопка, и она повторяет ту же попытку', () => {
    const onRestartCamera = vi.fn()
    const { tick, frame, restore } = mount({ onRestartCamera })
    try {
      frame()
      tick(50)
      tick(4000)
      expect(onRestartCamera).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByTestId('blocker-restart'))
      expect(onRestartCamera).toHaveBeenCalledTimes(2)
    } finally {
      restore()
    }
  })

  it('перезапуска не предлагаем, если поднимать нечем', () => {
    const { tick, frame, restore } = mount({ onRestartCamera: null })
    try {
      frame()
      tick(50)
      tick(4000)
      expect(screen.getByTestId('blocker-stalled')).toBeTruthy()
      expect(screen.queryByTestId('blocker-restart')).toBeNull()
      // а выход есть всегда
      expect(screen.getByTestId('blocker-exit')).toBeTruthy()
    } finally {
      restore()
    }
  })

  /**
   * До этой правки выйти из вечной паузы было нечем: крестик в бою сессии не
   * рисуется (hideCancel), а карточка кнопок не имела вовсе.
   */
  it('«Выйти из захода» зовёт тот же выход, что и крестик', () => {
    const onCancel = vi.fn()
    const { tick, frame, restore } = mount({ onCancel })
    try {
      frame()
      tick(50)
      tick(4000)

      fireEvent.click(screen.getByTestId('blocker-exit'))
      expect(onCancel).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('выход с карточки есть и когда причина в человеке, а не в камере', () => {
    const onCancel = vi.fn()
    const { tick, frame, restore } = mount({ onCancel })
    try {
      frame()
      tick(50)
      // короткая тишина: пауза уже есть (STALE_RESULT_MS), но камера ещё не
      // объявлена вставшей (STALE_RECOVER_MS не вышел)
      tick(1500)

      expect(screen.getByTestId('frame-blocker')).toBeTruthy()
      expect(screen.queryByTestId('blocker-stalled')).toBeNull()
      fireEvent.click(screen.getByTestId('blocker-exit'))
      expect(onCancel).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})
