// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

/**
 * MOTION УМЕЕТ БЫТЬ ГОСТЕМ — критерий готовности этапа 0 переезда.
 *
 * Всё, что здесь проверяется, до сих пор работало правильно ровно по одной
 * причине: Motion был всем приложением, и его закрывала перезагрузка страницы.
 * Модульное состояние, слушатели на window, AudioContext, поток камеры — ничего
 * из этого не убиралось само, потому что убирать было незачем.
 *
 * Внутри FitPro раздел открывается и закрывается сколько угодно раз за одну
 * загрузку. Каждая из этих незакрытых вещей превращается в дефект у живого
 * человека: камера горит, пока он смотрит дневник питания; двадцать ошибок
 * первой тренировки затыкают диагностику всех следующих; шестое открытие
 * остаётся без звука вовсе.
 *
 * ПОЧЕМУ ПРОВЕРКА ИМЕННО ДВОЙНАЯ. Один цикл открыть-закрыть ловит только грубое.
 * Утечки, о которых речь, проявляются на ВТОРОМ открытии: модуль уже загружен,
 * его модульные переменные несут след первого захода, и именно тогда видно, что
 * сброшено, а что нет.
 */

// --- окружение, которого в jsdom нет ---

/** Треки потока с камеры: по ним и видно, погасла ли камера. */
let tracks = []
/** Все AudioContext, созданные за тест, — живые и закрытые. */
let contexts = []
/** Слушатели, повешенные на window и document, минус снятые. */
let listeners = new Map()

function trackListeners(target, name) {
  const add = target.addEventListener.bind(target)
  const off = target.removeEventListener.bind(target)
  vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, opts) => {
    const key = `${name}:${type}`
    const list = listeners.get(key) ?? []
    list.push(fn)
    listeners.set(key, list)
    return add(type, fn, opts)
  })
  vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, opts) => {
    const key = `${name}:${type}`
    const list = listeners.get(key) ?? []
    const at = list.indexOf(fn)
    if (at >= 0) list.splice(at, 1)
    if (list.length) listeners.set(key, list)
    else listeners.delete(key)
    return off(type, fn, opts)
  })
}

/**
 * Что осталось висеть. Только те события, которые вешает Motion: React и
 * testing-library вешают своё, и требовать от них симметрии не наше дело.
 */
const MOTION_EVENTS = [
  'mql:change',
  'window:pointerdown',
  'window:pagehide',
  'window:visibilitychange',
  'window:resize',
  'window:orientationchange',
  'window:error',
  'window:unhandledrejection',
  'document:visibilitychange',
]

const leftover = () =>
  MOTION_EVENTS.filter((key) => (listeners.get(key) ?? []).length > 0).map(
    (key) => `${key} x${listeners.get(key).length}`,
  )

/**
 * АДРЕС ПОДМЕНЯЕТСЯ ЦЕЛИКОМ, а не растекается по jsdom-объекту.
 *
 * Первая версия этого теста делала `{...window.location, reload}` — и получала
 * объект, у которого geттеры Location оторваны от своего внутреннего состояния.
 * Дальше `new URL()` внутри модуля бросал, MotionApp падал в ErrorBoundary, и
 * тест это молча принимал за рабочее приложение. Отсюда же и страховка в visit().
 */
let locationDescriptor = null

function stubLocation(extra = {}) {
  if (!locationDescriptor) {
    locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location')
  }
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      href: 'http://localhost/',
      origin: 'http://localhost',
      protocol: 'http:',
      host: 'localhost',
      pathname: '/',
      search: '',
      hash: '',
      reload: () => {},
      toString: () => 'http://localhost/',
      ...extra,
    },
  })
}

beforeEach(() => {
  tracks = []
  contexts = []
  listeners = new Map()
  localStorage.clear()

  trackListeners(window, 'window')
  trackListeners(document, 'document')

  /**
   * jsdom не знает matchMedia, а без него падает блокировка ландшафта.
   *
   * Подписки на медиазапрос считаются наравне с оконными: useLandscapeBlock
   * вешает их на MediaQueryList, а не на window, и незамеченная утечка там
   * ничем не лучше — это тот же слушатель, живущий дольше раздела.
   */
  vi.stubGlobal('matchMedia', (query) => {
    const mql = {
      matches: false,
      media: query,
      addEventListener: (type, fn) => {
        const key = `mql:${type}`
        listeners.set(key, [...(listeners.get(key) ?? []), fn])
      },
      removeEventListener: (type, fn) => {
        const key = `mql:${type}`
        const list = listeners.get(key) ?? []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
        if (list.length) listeners.set(key, list)
        else listeners.delete(key)
      },
      addListener: () => {},
      removeListener: () => {},
    }
    return mql
  })

  // камера: поток с одним видеотреком, у которого видно, остановили ли его
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  vi.stubGlobal('navigator', {
    ...window.navigator,
    userAgent: 'тест',
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = {
          kind: 'video',
          label: 'front',
          stopped: false,
          stop() {
            this.stopped = true
          },
          getSettings: () => ({ deviceId: 'cam-1', width: 640, height: 480, frameRate: 30 }),
          getCapabilities: () => ({}),
          applyConstraints: async () => {},
          addEventListener() {},
        }
        tracks.push(track)
        return { getVideoTracks: () => [track], getTracks: () => [track] }
      }),
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'cam-1', kind: 'videoinput', label: 'front' },
      ]),
    },
    clipboard: { writeText: async () => {} },
  })

  // звук: контекст, который умеет закрываться и помнит, закрыли ли его
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
      contexts.push(this)
    }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { setValueAtTime() {} },
        connect: () => ({ connect() {} }),
        start() {},
        stop() {},
      }
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect: () => ({ connect() {} }),
      }
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      this.state = 'closed'
      return Promise.resolve()
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)

  // сеть: отправка лога никуда не идёт, но и не падает
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))

  // jsdom не проигрывает видео: play() возвращает undefined вместо промиса
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})

  // воркер инференса: в jsdom его нет, и поднимать его тесту незачем
  vi.stubGlobal(
    'Worker',
    class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // defineProperty не отменяется unstubAllGlobals: вернуть адрес обязаны сами,
  // иначе сломанный location утечёт в следующий тест файла
  if (locationDescriptor) {
    Object.defineProperty(window, 'location', locationDescriptor)
    locationDescriptor = null
  }
})

/**
 * Один заход человека: открыть раздел, дать эффектам отработать, закрыть.
 *
 * Модуль импортируется ВНУТРИ, а не сверху файла: половина проверяемого —
 * модульные переменные, и импорт до подмены окружения дал бы им не то окружение.
 * Импорт кэшируется, то есть второй заход получает ровно тот же модуль с его
 * следом от первого — именно это здесь и проверяется.
 */
async function visit(props = {}) {
  const { default: MotionApp } = await import('./index.jsx')
  const view = render(<MotionApp {...props} />)
  /**
   * Камера поднимается в три ожидания подряд: getUserMedia, сброс зума, список
   * устройств. Двух микрозадач на это не хватает, а недоподнятая камера не
   * оставляет трека — и проверка «камера погасла» прошла бы на пустом месте.
   */
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })

  /**
   * СТРАХОВКА, БЕЗ КОТОРОЙ ВЕСЬ ФАЙЛ НИЧЕГО НЕ ЗНАЧИТ.
   *
   * Упавший модуль показывает карточку ErrorBoundary — и у неё нет ни камеры,
   * ни звука, ни слушателей. То есть на упавшем приложении почти все проверки
   * «после закрытия ничего не осталось» проходят сами собой. Так уже и вышло:
   * кривая подмена location роняла MotionApp, а тест этого не замечал.
   */
  const fatal = screen.queryByTestId('fatal-error')
  if (fatal) throw new Error(`MotionApp упал при монтировании: ${fatal.textContent}`)

  return view
}

describe('раздел открывается и закрывается дважды подряд', () => {
  it('без перезагрузки страницы: reload не зовётся ни разу', async () => {
    const reload = vi.fn()
    stubLocation({ reload })

    for (let i = 0; i < 2; i += 1) {
      const view = await visit()
      view.unmount()
    }

    expect(reload).not.toHaveBeenCalled()
  })

  it('второе открытие рисует раздел так же, как первое', async () => {
    const first = await visit({ onExit: () => {} })
    expect(screen.getByTestId('motion-exit')).toBeTruthy()
    first.unmount()

    const second = await visit({ onExit: () => {} })
    // не «что-то отрисовалось», а именно рабочий вход с кнопкой выхода
    expect(screen.getByTestId('motion-exit')).toBeTruthy()
    second.unmount()
  })

  it('кнопка выхода зовёт onExit, а не трогает адрес', async () => {
    const onExit = vi.fn()
    const view = await visit({ onExit })

    await act(async () => {
      screen.getByTestId('motion-exit').click()
    })

    expect(onExit).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('без onExit кнопки выхода нет — модуль остаётся отдельным приложением', async () => {
    const view = await visit()
    expect(screen.queryByTestId('motion-exit')).toBeNull()
    view.unmount()
  })
})

describe('после второго закрытия не осталось следов', () => {
  it('камера погасла — оба потока остановлены', async () => {
    for (let i = 0; i < 2; i += 1) {
      const view = await visit()
      view.unmount()
    }

    expect(tracks.length).toBeGreaterThan(0)
    // ни одного живого трека: иначе камера горит, пока человек смотрит другой раздел
    expect(tracks.filter((t) => !t.stopped)).toHaveLength(0)
  })

  it('живого AudioContext не осталось', async () => {
    const { unlockAudio } = await import('./feedback/audio.js')

    for (let i = 0; i < 2; i += 1) {
      const view = await visit()
      // человек коснулся экрана — звук поднялся, как в жизни
      await act(async () => {
        unlockAudio()
      })
      view.unmount()
    }

    expect(contexts.length).toBeGreaterThan(0)
    expect(contexts.filter((c) => c.state !== 'closed')).toHaveLength(0)
  })

  it('на window и document не осталось слушателей Motion', async () => {
    for (let i = 0; i < 2; i += 1) {
      const view = await visit()
      view.unmount()
    }

    expect(leftover()).toEqual([])
  })

  it('потолок ошибок обнулился: reported не унаследован от прошлого захода', async () => {
    const { MAX_REPORTS, reportError } = await import('./debug/errorReporter.js')
    const { getShippedText } = await import('./debug/logShipper.js')

    const first = await visit()
    // первый заход выбирает потолок целиком
    for (let i = 0; i < MAX_REPORTS + 5; i += 1) reportError(new Error(`первый ${i}`))
    first.unmount()

    const second = await visit()
    /**
     * Если бы счётчик пережил закрытие, эта строка не записалась бы вовсе — и
     * вся диагностика второй тренировки человека молчала бы до конца дня.
     */
    expect(reportError(new Error('второй заход'))).toBe(true)
    expect(getShippedText()).toContain('второй заход')

    // и след первого захода в буфере не остался
    expect(getShippedText()).not.toContain('первый 0')
    second.unmount()
  })

  it('выключенная отправка лога включается обратно', async () => {
    const { isShipping, logEvent } = await import('./debug/logShipper.js')

    const first = await visit()
    // сеть отвалилась — отправка выключается навсегда... но только в пределах захода
    vi.mocked(fetch).mockRejectedValueOnce(new Error('сети нет'))
    await act(async () => {
      logEvent('block.start', {})
      await vi.mocked(fetch).mock.results[0]?.value?.catch?.(() => {})
    })
    first.unmount()

    const second = await visit()
    /**
     * Раньше «навсегда» кончалось перезагрузкой страницы. Внутри FitPro
     * перезагрузки нет: одна потерянная сеть в первом заходе выключила бы лог до
     * конца дня, и все следующие тренировки этого человека никуда бы не доехали.
     */
    expect(isShipping()).toBe(true)
    second.unmount()
  })
})

/**
 * Падение ХОЗЯЙСКОГО приложения: стек ведёт в его код, а не в наш.
 *
 * Стек ставится на саму ошибку, а не передаётся отдельным полем: reportError
 * читает extra.stack только как запасной, когда у ошибки своего стека нет вовсе.
 * Так же приходит и настоящее событие window.error от хозяина.
 */
function foreignError(message) {
  const error = new Error(message)
  error.stack = `Error: ${message}
    at handler (/app/src/App.jsx:120:9)`
  return error
}

describe('чужие падения не занимают место наших', () => {
  it('у чужой ошибки свой маленький потолок', async () => {
    const { MAX_FOREIGN, MAX_REPORTS, reportError } = await import('./debug/errorReporter.js')
    const { getShippedText } = await import('./debug/logShipper.js')

    const view = await visit()

    // хозяйское приложение сыплет ошибками из своего кода
    for (let i = 0; i < MAX_FOREIGN + 10; i += 1) {
      reportError(foreignError(`чужая ${i}`), { source: 'window.error' })
    }

    const lines = () => getShippedText().split('\n').filter(Boolean)
    expect(lines().filter((l) => l.includes('чужая '))).toHaveLength(MAX_FOREIGN)

    /**
     * И главное: после чужого потока НАШ потолок цел. Без разделения потолков
     * глобальный перехват не просто шумел бы — он глушил бы собственную
     * диагностику Motion ровно в тот заход, ради которого лог и читают.
     */
    for (let i = 0; i < MAX_REPORTS; i += 1) reportError(new Error(`своя ${i}`))
    expect(lines().filter((l) => l.includes('своя '))).toHaveLength(MAX_REPORTS)

    view.unmount()
  })

  it('чужая строка помечена, чтобы её не читали как падение Motion', async () => {
    const { reportError } = await import('./debug/errorReporter.js')
    const { getShippedText } = await import('./debug/logShipper.js')

    const view = await visit()
    reportError(foreignError('чужое'), { source: 'window.error' })

    expect(getShippedText()).toContain('"foreign":true')
    view.unmount()
  })
})

describe('хозяин задаёт день и уровень', () => {
  it('день из пропса играется, а прогресс на устройстве не двигает', async () => {
    const { progress } = await import('./game/challenge.js')
    const before = progress().day

    const view = await visit({ day: 12 })
    // сам факт открытия на чужом дне прогресса не касается
    expect(progress().day).toBe(before)
    view.unmount()
  })
})
