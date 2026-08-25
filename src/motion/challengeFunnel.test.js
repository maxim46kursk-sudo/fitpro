// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ВОРОНКА ЛЕНДИНГА: считаем ЛЮДЕЙ, А НЕ ДВИЖЕНИЯ МЫШИ.
 *
 * Проверяется ровно то, из-за чего такие счётчики обычно врут:
 *   • ступень засчитывается один раз за визит — иначе «долистал до цены»
 *     считает прокрутки, и один человек выглядит десятком;
 *   • метка источника запоминается на ПЕРВОМ заходе — человек приходит по
 *     ссылке из поста, а покупает через день и уже без метки; не запомни мы
 *     её, все продажи выглядели бы «прямыми».
 */

const события = []
vi.mock('./debug/logShipper.js', () => ({
  logEvent: (тег, данные) => события.push({ тег, данные }),
}))

let ступень
let vid
let источник
let забытьВизит

beforeEach(async () => {
  события.length = 0
  localStorage.clear()
  sessionStorage.clear()
  vi.resetModules()
  ;({ ступень, vid, источник, забытьВизит } = await import('./challengeFunnel.js'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ступень засчитывается один раз за визит', () => {
  it('вторая и третья попытки того же шага ничего не пишут', () => {
    expect(ступень('scroll')).toBe(true)
    expect(ступень('scroll')).toBe(false)
    expect(ступень('scroll')).toBe(false)
    expect(события.filter((e) => e.тег === 'challenge.scroll')).toHaveLength(1)
  })

  it('разные ступени друг другу не мешают', () => {
    ступень('open')
    ступень('scroll')
    ступень('join-click')
    expect(события.map((e) => e.тег)).toEqual([
      'challenge.open', 'challenge.scroll', 'challenge.join-click',
    ])
  })

  it('новый визит считает заново — человек вернулся, это новый заход', () => {
    ступень('open')
    забытьВизит()
    expect(ступень('open')).toBe(true)
    expect(события).toHaveLength(2)
  })
})

describe('кто и откуда', () => {
  it('номер посетителя один и тот же во всех событиях и переживает перезагрузку', async () => {
    ступень('open')
    const первый = события[0].данные.vid
    expect(первый).toMatch(/^[0-9a-z]+$/)

    // «перезагрузка страницы»: модуль загружается заново, localStorage цел
    vi.resetModules()
    const снова = await import('./challengeFunnel.js')
    expect(снова.vid()).toBe(первый)
  })

  it('метка источника запоминается на первом заходе и держится без неё', () => {
    expect(источник('?utm_source=instagram&utm_medium=post')).toEqual({ s: 'instagram', m: 'post' })
    // человек вернулся прямым заходом — источник обязан остаться прежним
    expect(источник('')).toEqual({ s: 'instagram', m: 'post' })
  })

  it('без метки и без памяти — «прямой», а не пусто', () => {
    expect(источник('')).toEqual({ s: 'прямой' })
  })

  it('ref работает наравне с utm_source: ссылки из постов бывают и такими', () => {
    expect(источник('?ref=tg')).toEqual({ s: 'tg', m: undefined })
  })

  it('в событие едут и номер, и источник, и устройство', () => {
    источник('?utm_source=vk')
    ступень('open', { гость: true })
    expect(события[0].данные).toMatchObject({ s: 'vk', гость: true })
    expect(события[0].данные.d).toBeTruthy()
    expect(события[0].данные.vid).toBeTruthy()
  })
})

describe('сломанное хранилище лендинг не роняет', () => {
  it('без sessionStorage событие всё равно уходит', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('нет доступа') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('нет доступа') })
    expect(() => ступень('open')).not.toThrow()
    expect(события).toHaveLength(1)
    // личности нет — и это честнее, чем выдумать её
    expect(события[0].данные.vid).toBe('нет-хранилища')
  })
})
