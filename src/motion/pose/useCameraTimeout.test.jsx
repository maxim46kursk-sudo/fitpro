// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useCamera } from './useCamera.js'
import { getShippedText, resetLogShipper } from '../debug/logShipper.js'

/**
 * МОЛЧАЩИЙ ЗАПРОС КАМЕРЫ — ровно тот случай, который дал 54-минутную сессию на
 * проде: getUserMedia не отвечает ни успехом, ни отказом, и прежний код
 * оставался в состоянии `requesting` навсегда, не записав ни строки.
 */
/**
 * Имя латиницей намеренно: правило react-hooks/rules-of-hooks определяет
 * компонент по заглавной первой букве и кириллическую «П» таковой не считает.
 */
function Probe({ out }) {
  Object.assign(out, useCamera({ enabled: true }))
  return null
}

describe('камера не отвечает', () => {
  let разрешить
  let отклонить

  beforeEach(() => {
    vi.useFakeTimers()
    resetLogShipper()
    window.isSecureContext = true
    navigator.mediaDevices = {
      getUserMedia: vi.fn(
        () =>
          new Promise((res, rej) => {
            разрешить = res
            отклонить = rej
          }),
      ),
      enumerateDevices: vi.fn(async () => []),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    разрешить = отклонить = undefined
  })

  it('через 10 секунд молчания пишет camera.timeout и показывает код ошибки', async () => {
    const out = {}
    render(<Probe out={out} />)
    expect(out.status).toBe('requesting')
    expect(out.errorCode).toBe(null)

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    expect(out.status).toBe('error')
    expect(out.errorCode).toBe('CAMERA_TIMEOUT')

    const лог = getShippedText()
    expect(лог).toContain('[camera.timeout]')
    // обстановка обязана быть в строке: без неё разбор снова пойдёт вслепую
    expect(лог).toMatch(/"браузер":/)
    expect(лог).toMatch(/"webview":/)
    expect(лог).toMatch(/"secure":/)
  })

  it('до 10 секунд молчит и ничего не пишет — честный ответ ещё может прийти', async () => {
    const out = {}
    render(<Probe out={out} />)
    await act(async () => {
      vi.advanceTimersByTime(9000)
    })
    expect(out.status).toBe('requesting')
    expect(getShippedText()).not.toContain('[camera.timeout]')
  })

  it('успевший ответ снимает часы: camera.timeout не пишется', async () => {
    const out = {}
    render(<Probe out={out} />)

    const track = {
      getSettings: () => ({ width: 1280, height: 720, frameRate: 30, deviceId: 'a' }),
      getCapabilities: () => ({}),
      stop: () => {},
      label: 'front',
    }
    await act(async () => {
      разрешить({ getVideoTracks: () => [track], getTracks: () => [track] })
    })
    await act(async () => {
      vi.advanceTimersByTime(20000)
    })

    expect(getShippedText()).toContain('[camera.ready]')
    expect(getShippedText()).not.toContain('[camera.timeout]')
    expect(out.status).toBe('ready')
  })

  /**
   * Человек думал над системным вопросом дольше десяти секунд и всё-таки
   * разрешил. Экран обязан вернуться к работе, а не остаться на приговоре.
   */
  it('ответ ПОСЛЕ срабатывания часов возвращает камеру в строй', async () => {
    const out = {}
    render(<Probe out={out} />)
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })
    expect(out.errorCode).toBe('CAMERA_TIMEOUT')

    const track = {
      getSettings: () => ({ width: 1280, height: 720, frameRate: 30, deviceId: 'a' }),
      getCapabilities: () => ({}),
      stop: () => {},
      label: 'front',
    }
    await act(async () => {
      разрешить({ getVideoTracks: () => [track], getTracks: () => [track] })
    })

    expect(out.status).toBe('ready')
    expect(out.errorCode).toBe(null)
  })

  it('честный отказ пишет camera.error с обстановкой, а не timeout', async () => {
    const out = {}
    render(<Probe out={out} />)
    await act(async () => {
      отклонить(Object.assign(new Error('нет'), { name: 'NotAllowedError' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(20000)
    })

    expect(out.errorCode).toBe('PERMISSION_DENIED')
    expect(getShippedText()).toContain('[camera.error]')
    expect(getShippedText()).toMatch(/"браузер":/)
    expect(getShippedText()).not.toContain('[camera.timeout]')
  })

  /**
   * Бывшая немая ветка: без secure context код ошибки выставлялся, а в журнале
   * не оставалось ничего — сессия выглядела точно так же, как зависшая.
   */
  it('отсутствие secure context теперь тоже попадает в журнал', async () => {
    window.isSecureContext = false
    const out = {}
    render(<Probe out={out} />)
    expect(out.errorCode).toBe('INSECURE_CONTEXT')
    expect(getShippedText()).toContain('[camera.error]')
    expect(getShippedText()).toContain('INSECURE_CONTEXT')
  })
})
