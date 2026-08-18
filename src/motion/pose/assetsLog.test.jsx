// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { usePoseLandmarker } from './usePoseLandmarker.js'
import { getShippedText, resetLogShipper } from '../debug/logShipper.js'

/**
 * ОТКУДА ВЗЯЛИСЬ ФАЙЛЫ — ЭТО ВИДНО ПО ЛОГУ.
 *
 * Без этого переезд движка на свой сервер невозможно ни подтвердить, ни
 * опровергнуть: телефон, тихо ушедший на прежний CDN, выглядит ровно как
 * телефон, взявший всё со своего бакета, — игра в обоих случаях просто
 * работает. А разница как раз та, ради которой всё и делалось.
 *
 * `assets.source` пишется всегда, `assets.fallback` — только когда свой
 * источник не ответил или отдал не то. Одна такая строка в поле означает, что
 * бакет лёг, и узнать об этом надо не от человека, у которого «долго грузится».
 *
 * Воркер здесь подменён: проверяется не загрузка (её проверяет assets.test.js),
 * а то, что сообщение доезжает до лога и несёт причину.
 */

/** Последний созданный поддельный воркер — через него шлём сообщения в хук. */
let worker = null

class FakeWorker {
  constructor() {
    this.onmessage = null
    this.onerror = null
    this.sent = []
    worker = this
  }
  postMessage(data) {
    this.sent.push(data)
  }
  terminate() {}
  addEventListener() {}
}

/** Хук живёт только внутри компонента — вот самый маленький, какой годится. */
function Probe() {
  const videoRef = useRef(null)
  usePoseLandmarker({ videoRef, active: false, onResult: () => {} })
  return null
}

const lines = () => getShippedText().split('\n').filter(Boolean)
const assetLines = () => lines().filter((l) => l.includes('[assets.'))

beforeEach(() => {
  worker = null
  resetLogShipper()
  vi.stubGlobal('Worker', FakeWorker)
  // отправка лога никуда не идёт, но строки копятся в буфере — их и читаем
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Отдать хуку сообщение так, как его отдал бы настоящий воркер. */
function fromWorker(data) {
  act(() => {
    worker?.onmessage?.({ data })
  })
}

describe('источник файлов доезжает до лога', () => {
  it('воркеру уходит СПИСОК источников, а не один адрес', () => {
    render(<Probe />)

    const init = worker.sent.find((m) => m.type === 'init')
    expect(init).toBeTruthy()
    expect(init.sources.map((s) => s.name)).toEqual(['own', 'cdn'])
    // и первым — свой: порядок и есть весь смысл переезда
    expect(init.sources[0].wasmBase).toContain('/storage/v1/object/public/motion-assets/')
    expect(init.sources[1].wasmBase).toContain('cdn.jsdelivr.net')
  })

  it('обычный запуск пишет, что файлы взяты со своего сервера', () => {
    render(<Probe />)
    fromWorker({ type: 'assets', event: 'source', from: 'own' })

    const line = assetLines().at(-1)
    expect(line).toContain('[assets.source]')
    expect(line).toContain('own')
    // отката не было — и строки об откате быть не должно
    expect(assetLines().some((l) => l.includes('assets.fallback'))).toBe(false)
  })

  it('откат пишет ПРИЧИНУ, а не только факт', () => {
    /**
     * «Переключились на CDN» без причины не даёт починить бакет: HTTP 403 (сняли
     * публичность), 404 (не залили файл) и «не тот файл» (прокси отдал заглушку)
     * лечатся по-разному, а выглядят одинаково.
     */
    render(<Probe />)
    fromWorker({
      type: 'assets',
      event: 'fallback',
      from: 'own',
      to: 'cdn',
      reason: 'не тот файл (model, 68 Б)',
    })
    fromWorker({ type: 'assets', event: 'source', from: 'cdn' })

    const fallback = assetLines().find((l) => l.includes('assets.fallback'))
    expect(fallback).toContain('"from":"own"')
    expect(fallback).toContain('"to":"cdn"')
    expect(fallback).toContain('не тот файл')

    // и следом — с какого источника в итоге поднялись
    expect(assetLines().at(-1)).toContain('[assets.source]')
    expect(assetLines().at(-1)).toContain('cdn')
  })

  it('полная потеря обоих — прежняя понятная ошибка на экране, а не белый экран', () => {
    /**
     * Код ошибки тот же самый, что и до переезда: человек видит «не скачалась
     * модель» и кнопку повтора. Меняется только строка в логе — в ней теперь обе
     * причины сразу.
     */
    render(<Probe />)
    fromWorker({
      type: 'error',
      code: 'MODEL_NETWORK_FAILED',
      stage: 'wasm',
      message: 'own: HTTP 403 | cdn: сети нет',
    })

    const line = lines().find((l) => l.includes('[model.error]'))
    expect(line).toContain('MODEL_NETWORK_FAILED')
    expect(line).toContain('own: HTTP 403')
    expect(line).toContain('cdn: сети нет')
  })
})
