// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import MotionApp from './index.jsx'
import { LM } from './pose/landmarks.js'
import { setCalibrating } from './debug/calibrationMode.js'

/**
 * Пока открыта калибровка движений, всё остальное стоит.
 *
 * Полевой баг: под экраном калибровки продолжал работать автозапуск. Он видел
 * человека в кадре, отсчитывал пять секунд и запускал разминку прямо посреди
 * записи движений — вместо записи получалась игра.
 *
 * Камера и модель здесь подменены: важна только развязка кадров и экранов.
 */

let onResult = null

vi.mock('./pose/useCamera.js', () => ({
  useCamera: () => ({
    status: 'ready',
    stream: null,
    info: null,
    devices: [],
    errorCode: null,
    retry: () => {},
    selectDevice: () => {},
  }),
}))

/**
 * Модель по умолчанию готова, но не всегда: комната обязана открываться и пока
 * качаются восемь мегабайт, а это другая ветка разметки — там вместо экранов
 * стоит заставка загрузки.
 */
let poseReady = true

vi.mock('./pose/usePoseLandmarker.js', () => ({
  usePoseLandmarker: (options) => {
    onResult = options.onResult
    return {
      status: poseReady ? 'ready' : 'loading',
      warm: poseReady,
      errorCode: null,
      errorDetail: null,
      progress: null,
      delegate: 'GPU',
      thread: 'worker',
      latestRef: { current: null },
      fpsRef: { current: { value: 30, inferenceMs: 10 } },
    }
  },
}))

/** Кадр с человеком целиком в кадре: именно он и запускает автозапуск. */
function pushFrame(timestamp) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  points[LM.LEFT_SHOULDER] = { x: 0.4, y: 0.3, z: 0, visibility: 1 }
  points[LM.RIGHT_SHOULDER] = { x: 0.6, y: 0.3, z: 0, visibility: 1 }
  points[LM.LEFT_HIP] = { x: 0.45, y: 0.55, z: 0, visibility: 1 }
  points[LM.RIGHT_HIP] = { x: 0.55, y: 0.55, z: 0, visibility: 1 }
  points[LM.LEFT_KNEE] = { x: 0.45, y: 0.72, z: 0, visibility: 1 }
  points[LM.RIGHT_KNEE] = { x: 0.55, y: 0.72, z: 0, visibility: 1 }
  points[LM.LEFT_ANKLE] = { x: 0.45, y: 0.9, z: 0, visibility: 1 }
  points[LM.RIGHT_ANKLE] = { x: 0.55, y: 0.9, z: 0, visibility: 1 }
  points[LM.NOSE] = { x: 0.5, y: 0.2, z: 0, visibility: 1 }

  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
  act(() => {
    onResult?.({ landmarks: points, worldLandmarks: world, timestamp })
  })
}

/** Держим человека в кадре дольше, чем нужно для удержания и отсчёта. */
function stayInFrame(seconds) {
  for (let i = 0; i < seconds * 30; i += 1) {
    now += 33
    pushFrame(now)
    act(() => {
      const callbacks = rafQueue
      rafQueue = []
      callbacks.forEach((cb) => cb(now))
    })
  }
}

let now = 0
let rafQueue = []

beforeEach(() => {
  now = 0
  rafQueue = []
  onResult = null
  poseReady = true
  // хранилище общее на весь файл: без чистки личные данные одного теста решали
  // бы, какой экран увидит следующий
  globalThis.localStorage?.clear()
  // jsdom не знает matchMedia, а без него падает блокировка ландшафта
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb) => rafQueue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  setCalibrating(false)
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * ЧИСТЫЙ АДРЕС = ИГРОВАЯ СЕССИЯ. Клиент челленджа приходит по ссылке без
 * параметров, и попасть он обязан в продукт, а не в отладочный простой подход.
 */
describe('вход по умолчанию', () => {
  it('чистый адрес ведёт в игру: постоял в кадре — и дальше без отсчёта', () => {
    render(<MotionApp />)
    stayInFrame(4)

    // отсчёт в игре один и стоит перед самой работой — его ведёт сессия
    expect(screen.queryByTestId('countdown')).toBeNull()
    // первый раз человека встречает «Настройка под себя»: игра узнаёт амплитуду
    // до челленджа, а не в первом же круге на скорости
    expect(screen.getByTestId('personal-setup')).toBeTruthy()
  })

  it('уже настроенного человека чистый адрес ведёт прямо к выбору уровня', () => {
    globalThis.localStorage.setItem(
      'fitpro-motion.game.personal.v1',
      JSON.stringify({ version: 2, max: { knee: 0.7 } }),
    )
    render(<MotionApp />)
    stayInFrame(4)

    expect(screen.getByTestId('level-pro')).toBeTruthy()
    // и день челленджа он видит там же, первой строкой
    expect(screen.getByTestId('challenge-day').textContent).toContain('из 30')
  })

  it('простой подход остался — по ?plain=1, с прежним отсчётом', () => {
    /**
     * Страховка и отладка: самый короткий путь к счётчику повторов. Раз он
     * ведёт прямо к работе, отсчёт здесь по-прежнему нужен — человеку надо
     * успеть встать.
     */
    vi.stubGlobal('location', { search: '?plain=1', hash: '' })
    render(<MotionApp />)
    stayInFrame(4)

    expect(screen.getByTestId('countdown')).toBeTruthy()
    expect(screen.queryByTestId('personal-setup')).toBeNull()
  })
})

describe('комната открывается без камеры', () => {
  /**
   * До этого посмотреть свою статистику можно было только встав перед камерой в
   * полный рост: комната жила за выбором уровня, выбор уровня — за постановкой
   * в кадр, а постановка — за восемью мегабайтами модели. Человек в поезде,
   * захотевший взглянуть на свой счёт, упирался в «отойди дальше».
   */
  it('кнопка есть на постановке в кадр, и она ведёт в комнату', () => {
    render(<MotionApp />)
    // в кадр никто не вставал: кнопка обязана быть доступна сразу
    act(() => {
      screen.getByTestId('calibration-room').click()
    })

    expect(screen.getByTestId('room-screen')).toBeTruthy()
    expect(screen.getByTestId('room-total')).toBeTruthy()
  })

  it('возврат из комнаты — обратно на постановку, а не на выбор уровня', () => {
    // высадить человека не там, откуда он пришёл, значит потерять его: он
    // оказался бы на выборе уровня, ни разу не встав в кадр
    render(<MotionApp />)
    act(() => screen.getByTestId('calibration-room').click())
    act(() => screen.getByTestId('room-screen').querySelector('.mt-corner').click())

    expect(screen.queryByTestId('room-screen')).toBeNull()
    expect(screen.getByTestId('calibration-room')).toBeTruthy()
  })

  it('комната читает хранилище и без единого кадра показывает свои числа', () => {
    render(<MotionApp />)
    act(() => screen.getByTestId('calibration-room').click())

    // кадров не было вовсе, а экран собран целиком
    expect(screen.getByTestId('room-chart').children).toHaveLength(30)
    expect(screen.getByTestId('room-days').children).toHaveLength(30)
    expect(screen.getByTestId('room-where').textContent).toContain('из 30')
  })

  it('модель ещё качается — в комнату всё равно можно', () => {
    /**
     * Восемь мегабайт на плохой сети идут долго, а статистика готова сразу:
     * она в хранилище и модель ей не нужна. Заставка загрузки уступает комнате
     * место — она закрывает собой то, чему нужна камера.
     */
    poseReady = false
    render(<MotionApp />)

    expect(screen.getByTestId('boot-room')).toBeTruthy()
    act(() => screen.getByTestId('boot-room').click())

    expect(screen.getByTestId('room-screen')).toBeTruthy()
    expect(screen.getByTestId('room-days').children).toHaveLength(30)
  })

  it('вышел из комнаты во время загрузки — снова заставка, а не пустой экран', () => {
    // тренироваться без модели всё-таки нельзя, и об этом надо сказать
    poseReady = false
    render(<MotionApp />)
    act(() => screen.getByTestId('boot-room').click())
    act(() => screen.getByTestId('room-screen').querySelector('.mt-corner').click())

    expect(screen.queryByTestId('room-screen')).toBeNull()
    expect(screen.getByTestId('boot-room')).toBeTruthy()
  })

  it('в простом подходе комнаты нет: челленджа там нет вовсе', () => {
    vi.stubGlobal('location', { search: '?plain=1', hash: '' })
    render(<MotionApp />)
    expect(screen.queryByTestId('calibration-room')).toBeNull()
  })
})

describe('калибровка ставит остальное на паузу', () => {
  it('без калибровки человек в кадре доходит до следующего экрана', () => {
    render(<MotionApp />)
    stayInFrame(4)

    // удержание две секунды — и экран камеры сменился
    expect(screen.getByTestId('personal-setup')).toBeTruthy()
  })

  it('при открытой калибровке кадры не запускают ни удержание, ни отсчёт', () => {
    render(<MotionApp />)
    act(() => {
      setCalibrating(true)
    })

    stayInFrame(8)

    // ни удержания, ни перехода дальше: кадры до экранов не доходят вовсе
    expect(screen.queryByTestId('personal-setup')).toBeNull()
    expect(screen.queryByTestId('countdown')).toBeNull()
    // экрана калибровки позы под ней тоже нет: он размонтирован
    expect(document.querySelector('.mt-screen')).toBeNull()
  })

  it('камера и скелет во время калибровки остаются', () => {
    render(<MotionApp />)
    act(() => {
      setCalibrating(true)
    })
    stayInFrame(1)

    expect(document.querySelector('.mt-stage')).toBeTruthy()
  })

  it('после закрытия калибровки всё начинается с чистого состояния', () => {
    render(<MotionApp />)
    act(() => {
      setCalibrating(true)
    })
    stayInFrame(8)

    act(() => {
      setCalibrating(false)
    })
    expect(screen.queryByTestId('personal-setup')).toBeNull()

    // удержание считается заново, а не продолжается с накопленного
    stayInFrame(1)
    expect(screen.queryByTestId('personal-setup')).toBeNull()

    stayInFrame(4)
    expect(screen.getByTestId('personal-setup')).toBeTruthy()
  })
})
