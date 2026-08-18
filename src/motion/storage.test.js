// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYS, LEGACY_KEYS, allKeys, clearAll, readJson, readRaw, remove, writeJson, writeRaw } from './storage.js'

/**
 * ОБЁРТКА НАД ХРАНИЛИЩЕМ НИЧЕГО НЕ МЕНЯЕТ — вот что здесь проверяется, и это
 * единственное, ради чего тест написан.
 *
 * Модуль появился ради этапов 3 и 4 переезда: прогресс поедет в базу, и подменить
 * тогда придётся один слой, а не девять разрозненных try/catch. Но сам переезд —
 * это ЭТАП 3. Если заодно с рефакторингом уедет хоть один ключ или хоть одна
 * форма записи, у человека на телефоне пропадёт челлендж, и разбираться придётся
 * сразу в двух изменениях.
 *
 * Поэтому тест держит три вещи:
 *   ключи буквально те же, что лежат на телефонах участников;
 *   форма данных та же — читается ровно то, что записано;
 *   чтение СИНХРОННОЕ (никаких промисов) — от этого зависят ленивые
 *     инициализаторы useState и игровой цикл, и менять это будет этап 3.
 */

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ключи не изменились', () => {
  /**
   * Список буквальный, а не собранный из KEYS: сверять значение с самим собой
   * бессмысленно. Эти девять строк лежат в браузерах участников, и любая правка
   * здесь — это потерянный прогресс у живого человека.
   */
  const ON_DEVICES = [
    'fitpro-motion.audio.v1',
    'fitpro-motion.camera.deviceId.v1',
    'fitpro-motion.challenge.v1',
    'fitpro-motion.challenge.attempts.v1',
    'fitpro-motion.challenge.unlocked.v1',
    'fitpro-motion.debug.open.v1',
    'fitpro-motion.game.best.v1',
    'fitpro-motion.game.personal.v1',
    'fitpro-motion.thresholds.v2',
    /**
     * Служебная отметка «чей это кэш». Данными игры не является, но живёт по тем
     * же правилам: тот же префикс, та же уборка. Появилась вместе с переездом
     * прогресса на сервер — телефон бывает общим, и без неё второй человек
     * открыл бы раздел с чужим челленджем.
     */
    'fitpro-motion.owner.v1',
  ]

  it('все ключи на месте и с прежними именами', () => {
    expect(Object.values(KEYS).sort()).toEqual([...ON_DEVICES].sort())
  })

  it('префикс через дефис — им Motion и отличается от ключей FitPro', () => {
    // clearFitproData() в FitPro фильтрует по 'fitpro_' через подчёркивание;
    // ровно поэтому ключи Motion переживают выход из аккаунта (этап 4)
    for (const key of allKeys()) {
      expect(key.startsWith('fitpro-motion.')).toBe(true)
      expect(key.startsWith('fitpro_')).toBe(false)
    }
  })

  it('устаревший ключ помнится ради уборки, но в рабочие не попал', () => {
    expect(LEGACY_KEYS).toContain('fitpro-motion.game.day.v1')
    expect(Object.values(KEYS)).not.toContain('fitpro-motion.game.day.v1')
  })
})

describe('форма данных не изменилась', () => {
  it('строка возвращается ровно той же строкой', () => {
    writeRaw(KEYS.best, '1234')
    expect(readRaw(KEYS.best)).toBe('1234')
    expect(localStorage.getItem(KEYS.best)).toBe('1234')
  })

  it('объект ложится обычным JSON — без обёрток и без метаданных', () => {
    const value = { day: 7, done: ['2026-08-18'] }
    writeJson(KEYS.challenge, value)

    // именно так запись выглядит на устройстве: голый JSON.stringify
    expect(localStorage.getItem(KEYS.challenge)).toBe(JSON.stringify(value))
    expect(readJson(KEYS.challenge)).toEqual(value)
  })

  it('запись, сделанная прежним кодом напрямую, читается обёрткой', () => {
    // это и есть человек, у которого игра уже стоит: его данные лежат с прошлой версии
    localStorage.setItem(KEYS.personal, JSON.stringify({ version: 2, max: { squat: 0.4 } }))
    expect(readJson(KEYS.personal)).toEqual({ version: 2, max: { squat: 0.4 } })
  })

  it('нет ключа и есть мусор — одинаково «данных нет»', () => {
    expect(readRaw(KEYS.challenge)).toBeNull()
    expect(readJson(KEYS.challenge)).toBeNull()

    localStorage.setItem(KEYS.challenge, 'не json')
    expect(readJson(KEYS.challenge)).toBeNull()
  })

  it('remove стирает, clearAll стирает всё своё и не трогает чужое', () => {
    writeRaw(KEYS.best, '10')
    remove(KEYS.best)
    expect(readRaw(KEYS.best)).toBeNull()

    for (const key of allKeys()) localStorage.setItem(key, 'x')
    localStorage.setItem('fitpro_role', 'trainer')

    clearAll()

    for (const key of allKeys()) expect(localStorage.getItem(key)).toBeNull()
    // чужое приложение живёт своей жизнью
    expect(localStorage.getItem('fitpro_role')).toBe('trainer')
  })
})

describe('чтение синхронное — это условие, а не деталь', () => {
  it('readRaw и readJson возвращают значение, а не промис', () => {
    writeRaw(KEYS.audio, '1')
    writeJson(KEYS.thresholds, { upAngle: 160 })

    // ленивые инициализаторы useState и игровой цикл читают именно так;
    // асинхронное чтение — этап 3 переезда, и оно потребует их переписать
    expect(readRaw(KEYS.audio)).not.toBeInstanceOf(Promise)
    expect(readJson(KEYS.thresholds)).not.toBeInstanceOf(Promise)
    expect(readRaw(KEYS.audio)).toBe('1')
    expect(readJson(KEYS.thresholds)).toEqual({ upAngle: 160 })
  })
})

describe('недоступное хранилище не роняет игру', () => {
  /** Приватный режим Safari: getItem и setItem бросают. */
  const throwing = {
    getItem() {
      throw new DOMException('denied')
    },
    setItem() {
      throw new DOMException('denied')
    },
    removeItem() {
      throw new DOMException('denied')
    },
  }

  it('чтение отвечает «данных нет», запись — «не легло»', () => {
    vi.stubGlobal('localStorage', throwing)

    expect(readRaw(KEYS.challenge)).toBeNull()
    expect(readJson(KEYS.challenge)).toBeNull()
    expect(writeRaw(KEYS.challenge, 'x')).toBe(false)
    expect(writeJson(KEYS.challenge, { day: 1 })).toBe(false)
    expect(() => remove(KEYS.challenge)).not.toThrow()
    expect(() => clearAll()).not.toThrow()
  })

  it('хранилища нет вовсе (сервер, воркер) — то же самое', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(readRaw(KEYS.challenge)).toBeNull()
    expect(writeRaw(KEYS.challenge, 'x')).toBe(true)
  })

  it('несериализуемое значение не бросает наружу', () => {
    const loop = {}
    loop.self = loop
    expect(writeJson(KEYS.challenge, loop)).toBe(false)
  })
})
