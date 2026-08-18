// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_REPORTS,
  STACK_MAX,
  installErrorReporter,
  noteScreen,
  reportError,
  resetErrorReporter,
  trimStack,
} from './errorReporter.js'
import { getShippedText, logEvent } from './logShipper.js'

/**
 * ОШИБКИ КЛИЕНТА ДОЕЗЖАЮТ САМИ. До этого упавшее приложение видел только
 * человек с телефоном: консоли там нет, а карточку падения надо догадаться
 * скопировать и переслать. На челлендже догадываться некому — человек закроет
 * вкладку и решит, что игра не работает.
 */

const lines = () => getShippedText().split('\n').filter(Boolean)
const errors = () => lines().filter((l) => l.includes('[client.error]'))

beforeEach(() => {
  resetErrorReporter()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('строка ошибки', () => {
  it('несёт сообщение, стек и экран', () => {
    noteScreen('session:fight:круг3')
    reportError(new Error('t is undefined'))

    const line = errors().at(-1)
    expect(line).toContain('t is undefined')
    expect(line).toContain('session:fight:круг3')
  })

  it('стек обрезан: верхушка — виновник, дальше одинаковые кадры библиотек', () => {
    const long = `Error: беда\n${'    at где-то (bundle.js:1:1)\n'.repeat(200)}`
    expect(trimStack(long).length).toBeLessThanOrEqual(STACK_MAX + 1)
    expect(trimStack('коротко')).toBe('коротко')
  })

  it('нестандартное падение тоже пишется — упало же', () => {
    // промис может отказать чем угодно, включая строку и undefined
    expect(reportError('всё сломалось')).toBe(true)
    expect(reportError(undefined)).toBe(true)
    expect(errors().at(-1)).toContain('неизвестная ошибка')
  })
})

describe('поток одинаковых падений не топит лог', () => {
  it('повтор того же падения не пишется второй раз', () => {
    /**
     * Ошибка в цикле отрисовки повторяется шестьдесят раз в секунду. Знать надо,
     * ЧТО упало, а не сколько раз подряд.
     */
    const before = errors().length
    const boom = () => reportError(new Error('одно и то же'))
    expect(boom()).toBe(true)
    expect(boom()).toBe(false)
    expect(errors().length).toBe(before + 1)
  })

  it('за сессию пишется не больше потолка разных ошибок', () => {
    // буфер лога общий на весь файл, поэтому считаем только свои строки
    for (let i = 0; i < MAX_REPORTS + 10; i += 1) reportError(new Error(`разное ${i}`))
    expect(errors().filter((l) => l.includes('разное '))).toHaveLength(MAX_REPORTS)
  })
})

describe('перехватчики', () => {
  it('ошибка вне рендера ловится слушателем error', () => {
    const off = installErrorReporter(window)
    try {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'вне рендера', error: new Error('вне рендера') }),
      )
      expect(errors().at(-1)).toContain('вне рендера')
      expect(errors().at(-1)).toContain('window.error')
    } finally {
      off()
    }
  })

  it('забытый отказ промиса ловится unhandledrejection', () => {
    const off = installErrorReporter(window)
    try {
      const event = new Event('unhandledrejection')
      event.reason = new Error('промис отказал')
      window.dispatchEvent(event)
      expect(errors().at(-1)).toContain('промис отказал')
      expect(errors().at(-1)).toContain('unhandledrejection')
    } finally {
      off()
    }
  })

  it('перехватчик ставится один раз, сколько ни зови', () => {
    // модуль подключается и приложением, и (в тесте) руками: двойная подписка
    // писала бы каждое падение дважды
    const off1 = installErrorReporter(window)
    const off2 = installErrorReporter(window)
    try {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('однажды') }))
      expect(errors().filter((l) => l.includes('однажды'))).toHaveLength(1)
    } finally {
      off1()
      off2()
    }
  })
})

describe('ошибки переживают переполнение буфера', () => {
  it('поток снимков состояния не вытесняет строку падения', () => {
    /**
     * Полевой случай наоборот: в прошлый раз поток снимков вытеснил из лога
     * весь силовой блок. Ошибка — то единственное, ради чего лог упавшей
     * сессии вообще читают, и вытеснить её нельзя ничем.
     */
    reportError(new Error('редкая беда'))
    // с запасом больше буфера: MAX_BUFFER = 600
    for (let i = 0; i < 1200; i += 1) logEvent('snapshot', { i })

    expect(errors().filter((l) => l.includes('редкая беда'))).toHaveLength(1)
  })

  it('и обычные события её тоже не вытесняют', () => {
    reportError(new Error('вторая беда'))
    for (let i = 0; i < 1200; i += 1) logEvent('block.attempt', { i })

    expect(errors().filter((l) => l.includes('вторая беда'))).toHaveLength(1)
  })
})
