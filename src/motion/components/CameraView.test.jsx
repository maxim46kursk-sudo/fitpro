// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import CameraView from './CameraView.jsx'
import { getLive } from '../debug/diagnostics.js'
import { getShownPose } from '../pose/frameSync.js'

/**
 * СЦЕПКА РЕЖИМОВ ПОКАЗА. Арифметику синхронного показа проверяет
 * pose/frameSync.test.js — здесь только то, что видно на экране: скрыт ли
 * <video>, и что об этом написано в диагностике.
 *
 * Это важно проверять отдельно: телефон без requestVideoFrameCallback обязан
 * получить прежнюю живую картинку, а не чёрный экран, — и молча такое не
 * обнаружишь, потому что на разработческой машине rVFC есть всегда.
 */

const noop = () => {}

/** Канвас в jsdom не рисует — цикл отрисовки должен получить хоть какой-то ctx. */
const fakeContext = () => ({
  setTransform: noop,
  clearRect: noop,
  fillRect: noop,
  drawImage: noop,
  beginPath: noop,
  moveTo: noop,
  lineTo: noop,
  stroke: noop,
  arc: noop,
  fill: noop,
})

describe('режим показа камеры', () => {
  let frames
  let restoreSize
  let drawn

  beforeEach(() => {
    frames = []
    drawn = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      ...fakeContext(),
      drawImage: (source) => drawn.push(source),
    }))
    // размер кадра камеры: без него нечего вписывать в экран
    for (const [key, value] of [['videoWidth', 480], ['videoHeight', 640]]) {
      Object.defineProperty(HTMLVideoElement.prototype, key, {
        configurable: true,
        get: () => value,
      })
    }
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    // без размеров обёртки цикл отрисовки выходит на первой же строке
    for (const key of ['clientWidth', 'clientHeight']) {
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => 300 })
    }
    restoreSize = () => {
      for (const key of ['clientWidth', 'clientHeight']) {
        delete HTMLElement.prototype[key]
      }
    }
  })

  afterEach(() => {
    restoreSize()
    delete HTMLVideoElement.prototype.requestVideoFrameCallback
    delete HTMLVideoElement.prototype.cancelVideoFrameCallback
    delete HTMLVideoElement.prototype.videoWidth
    delete HTMLVideoElement.prototype.videoHeight
    vi.restoreAllMocks()
    cleanup()
  })

  /** Прокрутить один кадр отрисовки. */
  const tick = () => frames.splice(0).forEach((cb) => cb(0))

  it('без requestVideoFrameCallback остаётся живое видео', () => {
    /**
     * Копировать кадры нечем: rAF срабатывает чаще кадров камеры, и буфер
     * наполнялся бы копиями одного и того же. Прежний режим тут не хуже —
     * он ровно то, что было до синхронного показа.
     */
    const videoRef = { current: null }
    render(<CameraView videoRef={videoRef} latestRef={{ current: null }} />)
    tick()

    expect(getLive().videoSync).toBe('live')
    expect(getLive().videoSyncWhy).toContain('requestVideoFrameCallback')
    // видео на месте и видно: скрыть его, не имея чем заменить, — чёрный экран
    expect(videoRef.current.style.visibility).toBe('')
  })

  it('с requestVideoFrameCallback показ идёт через canvas, а видео прячется', () => {
    // <video> остаётся источником кадров для инференса, поэтому именно
    // visibility: размонтируй его — и считать станет нечего
    const registered = []
    HTMLVideoElement.prototype.requestVideoFrameCallback = function register(cb) {
      registered.push(cb)
      return registered.length
    }
    HTMLVideoElement.prototype.cancelVideoFrameCallback = noop

    const videoRef = { current: null }
    render(<CameraView videoRef={videoRef} latestRef={{ current: null }} />)

    expect(getLive().videoSync).toBe('sync')
    expect(registered.length).toBeGreaterThan(0)

    // пока кадр камеры не пришёл, прятать видео нельзя — заменить его нечем
    tick()
    expect(videoRef.current.style.visibility).toBe('')

    // кадр пришёл и лёг в буфер — теперь на экране он, а не живое видео
    registered[registered.length - 1]()
    tick()
    expect(videoRef.current.style.visibility).toBe('hidden')
    expect(drawn.some((source) => source instanceof HTMLCanvasElement)).toBe(true)
  })

  it('показанная поза уходит наружу — по ней рисуются мишени боя', () => {
    /**
     * Мишени висят на теле, и тело им нужно то, которое видит человек. Сырая
     * свежая поза в синхронном режиме описывает тело из будущего относительно
     * показанного кадра — по ней зачёт вспыхивал раньше, чем рука доходила.
     */
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1
    const pose = [{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]

    const videoRef = { current: null }
    render(
      <CameraView
        videoRef={videoRef}
        latestRef={{ current: { landmarks: pose, timestamp: 0 } }}
      />,
    )
    tick()

    expect(getShownPose().mode).toBe('sync')
    // поза одна — смешивать не с чем, показана она же
    expect(getShownPose().landmarks).toBe(pose)
  })

  it('камера ушла с экрана — оверлеи возвращаются к сырой позе', () => {
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1
    const videoRef = { current: null }
    const view = render(
      <CameraView
        videoRef={videoRef}
        latestRef={{ current: { landmarks: [{ x: 0.5, y: 0.5 }], timestamp: 0 } }}
      />,
    )
    tick()
    expect(getShownPose().landmarks).not.toBeNull()

    view.unmount()
    expect(getShownPose().landmarks).toBeNull()
    expect(getShownPose().mode).toBe('live')
  })

  it('ключ ?livecam=1 возвращает живое видео и на телефоне с rVFC', () => {
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1
    const search = vi.spyOn(globalThis, 'location', 'get').mockReturnValue({ search: '?livecam=1' })

    const videoRef = { current: null }
    render(<CameraView videoRef={videoRef} latestRef={{ current: null }} />)
    tick()

    expect(getLive().videoSync).toBe('live')
    expect(videoRef.current.style.visibility).toBe('')
    search.mockRestore()
  })
})
