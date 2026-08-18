// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYS, readJson, readRaw, writeJson, writeRaw } from './storage.js'
import {
  applyProgress,
  attemptRows,
  collectProgress,
  configureSync,
  hasLocalProgress,
  hydrate,
  mergeAttempts,
  newerOf,
  push,
  resetSync,
} from './sync.js'

/**
 * ПРОГРЕСС ПЕРЕЕХАЛ НА СЕРВЕР, И ЭТО САМОЕ ОПАСНОЕ МЕСТО ВСЕГО ПЕРЕЕЗДА.
 *
 * Челлендж платный, и здесь ошибка стоит человеку тридцати дней работы: молча
 * затёртый прогресс, чужие данные на общем телефоне, пустой ответ сервера,
 * принятый за «данных нет». Каждый из этих случаев проверяется отдельно.
 */

const день = (n, tier, list) => ({ days: { [String(n)]: { [tier]: list } } })
const попытка = (score, at) => ({ score, reps: 0, hits: 0, spawned: 0, reactMs: 0, at })

beforeEach(() => {
  localStorage.clear()
  resetSync()
  configureSync(null)
})

afterEach(() => {
  configureSync(null)
  resetSync()
  vi.restoreAllMocks()
})

describe('прогресс собирается и раскладывается обратно', () => {
  it('что собрали, то и разложилось', () => {
    writeJson(KEYS.challenge, { day: 7, done: [{ day: 6, at: '2026-08-01' }] })
    writeJson(KEYS.personal, { version: 2, max: { squat: 0.4 } })
    writeRaw(KEYS.best, '4200')
    writeRaw(KEYS.challengeUnlocked, '1')

    const собранное = collectProgress()
    localStorage.clear()
    applyProgress(собранное)

    expect(readJson(KEYS.challenge)).toEqual({ day: 7, done: [{ day: 6, at: '2026-08-01' }] })
    expect(readJson(KEYS.personal)).toEqual({ version: 2, max: { squat: 0.4 } })
    expect(readRaw(KEYS.best)).toBe('4200')
    expect(readRaw(KEYS.challengeUnlocked)).toBe('1')
  })

  it('пустой прогресс ничего не затирает', () => {
    /**
     * Ключевая строка всего файла. Пустой объект приезжает и от сервера, у
     * которого этот человек ещё не играл, и от сбоя разбора. Разложи мы его
     * поверх кэша — тридцать дней исчезли бы молча.
     */
    writeJson(KEYS.challenge, { day: 9, done: [] })
    applyProgress({})
    applyProgress(null)
    expect(readJson(KEYS.challenge)).toEqual({ day: 9, done: [] })
  })
})

describe('два телефона у одного человека', () => {
  it('прогресс берётся свежий по времени', () => {
    const старый = { updatedAt: '2026-08-01T10:00:00Z', challenge: { day: 3, done: [] } }
    const новый = { updatedAt: '2026-08-05T10:00:00Z', challenge: { day: 8, done: [] } }
    expect(newerOf(старый, новый)).toBe(новый)
    expect(newerOf(новый, старый)).toBe(новый)
  })

  it('без отметки времени данные не считаются свежее', () => {
    const сОтметкой = { updatedAt: '2026-08-05T10:00:00Z' }
    expect(newerOf(сОтметкой, {})).toBe(сОтметкой)
  })

  it('ПОПЫТКИ ТОЛЬКО ОБЪЕДИНЯЮТСЯ, а не побеждают свежестью', () => {
    /**
     * Попытка — будущий предмет спора о деньгах. Тренировка со второго телефона
     * не имеет права стереть тренировку с первого только потому, что случилась
     * позже: у человека их две, и обе настоящие.
     */
    const телефонA = день(3, 'pro', [попытка(1000, '2026-08-01T10:00:00Z')])
    const телефонB = день(3, 'pro', [попытка(2000, '2026-08-02T10:00:00Z')])

    const слитое = mergeAttempts(телефонA, телефонB)
    expect(слитое.days['3'].pro.map((a) => a.score).sort()).toEqual([1000, 2000])
  })

  it('одна и та же попытка не удваивается при повторном слиянии', () => {
    const одна = день(3, 'pro', [попытка(1000, '2026-08-01T10:00:00Z')])
    expect(mergeAttempts(одна, одна).days['3'].pro).toHaveLength(1)
    expect(mergeAttempts(mergeAttempts(одна, одна), одна).days['3'].pro).toHaveLength(1)
  })

  it('дни и уровни не смешиваются между собой', () => {
    const a = день(3, 'pro', [попытка(1000, 'A')])
    const b = день(4, 'novice', [попытка(500, 'B')])
    const слитое = mergeAttempts(a, b)
    expect(слитое.days['3'].pro).toHaveLength(1)
    expect(слитое.days['4'].novice).toHaveLength(1)
  })
})

describe('попытки превращаются в строки таблицы', () => {
  it('номер попытки идёт по порядку внутри дня и уровня', () => {
    const rows = attemptRows(день(5, 'pro', [попытка(100, 'A'), попытка(300, 'B')]))
    expect(rows.map((r) => [r.day, r.tier, r.attempt_no, r.score])).toEqual([
      [5, 'pro', 1, 100],
      [5, 'pro', 2, 300],
    ])
  })

  it('пустое хранилище даёт пустой список, а не падение', () => {
    expect(attemptRows(null)).toEqual([])
    expect(attemptRows({})).toEqual([])
  })
})

describe('чужой телефон и смена пользователя', () => {
  it('ЧУЖОЙ КЭШ СТИРАЕТСЯ ПРИ ВХОДЕ ДРУГИМ ЧЕЛОВЕКОМ', async () => {
    /**
     * Телефон бывает общим, а ключи Motion переживают выход из аккаунта:
     * уборщик FitPro фильтрует по `fitpro_` через подчёркивание, у нас префикс
     * через дефис. Без этой проверки второй человек увидел бы чужой день и
     * чужие рекорды — и его собственная тренировка уехала бы на сервер поверх
     * них, уже под его именем.
     */
    writeRaw(KEYS.owner, 'человек-А')
    writeJson(KEYS.challenge, { day: 20, done: [{ day: 19, at: 'вчера' }] })
    writeRaw(KEYS.best, '9999')

    await hydrate('человек-Б')

    expect(readJson(KEYS.challenge)).toBeNull()
    expect(readRaw(KEYS.best)).toBeNull()
    expect(readRaw(KEYS.owner)).toBe('человек-Б')
  })

  it('свой кэш при повторном входе остаётся', async () => {
    writeRaw(KEYS.owner, 'человек-А')
    writeJson(KEYS.challenge, { day: 20, done: [] })

    await hydrate('человек-А')

    expect(readJson(KEYS.challenge)).toEqual({ day: 20, done: [] })
  })
})

describe('сервер не ответил', () => {
  it('ОШИБКА ЗАГРУЗКИ — НЕ «ДАННЫХ НЕТ»: кэш остаётся нетронутым', async () => {
    writeJson(KEYS.challenge, { day: 12, done: [{ day: 11, at: 'вчера' }] })
    configureSync({
      load: async () => null,
      saveProgress: async () => {},
      saveAttempts: async () => {},
    })

    const итог = await hydrate('человек-А')

    expect(итог.ok).toBe(false)
    // прогресс на месте: игра откроется на кэше, как работала до переезда
    expect(readJson(KEYS.challenge)).toEqual({ day: 12, done: [{ day: 11, at: 'вчера' }] })
  })

  it('исключение при загрузке равносильно отказу, а не пустоте', async () => {
    writeJson(KEYS.challenge, { day: 12, done: [] })
    configureSync({
      load: async () => {
        throw new Error('сети нет')
      },
      saveProgress: async () => {},
      saveAttempts: async () => {},
    })

    expect((await hydrate('человек-А')).ok).toBe(false)
    expect(readJson(KEYS.challenge)).toEqual({ day: 12, done: [] })
  })
})

describe('перенос того, что уже есть', () => {
  it('сервер пуст, а на телефоне прогресс — он уезжает наверх', async () => {
    writeJson(KEYS.challenge, { day: 6, done: [{ day: 5, at: 'вчера' }] })
    writeJson(KEYS.challengeAttempts, день(5, 'pro', [попытка(1500, '2026-08-01T10:00:00Z')]))

    const saveProgress = vi.fn(async () => {})
    const saveAttempts = vi.fn(async () => {})
    configureSync({ load: async () => ({ progress: null, attempts: [] }), saveProgress, saveAttempts })

    await hydrate('человек-А')

    expect(saveProgress).toHaveBeenCalledTimes(1)
    expect(saveProgress.mock.calls[0][0].challenge.day).toBe(6)
    expect(saveAttempts).toHaveBeenCalledTimes(1)
    expect(saveAttempts.mock.calls[0][0][0]).toMatchObject({ day: 5, tier: 'pro', attempt_no: 1, score: 1500 })
  })

  it('пусто и там и там — наверх ничего не шлём', async () => {
    const saveProgress = vi.fn(async () => {})
    configureSync({ load: async () => ({ progress: null, attempts: [] }), saveProgress, saveAttempts: async () => {} })

    await hydrate('человек-А')

    expect(saveProgress).not.toHaveBeenCalled()
  })

  it('пустой кэш опознаётся как пустой', () => {
    expect(hasLocalProgress(collectProgress())).toBe(false)
    writeRaw(KEYS.best, '10')
    expect(hasLocalProgress(collectProgress())).toBe(true)
  })
})

describe('сеть отвалилась посреди тренировки', () => {
  it('отправка повторяется, и результат доезжает', async () => {
    vi.useFakeTimers()
    writeRaw(KEYS.best, '700')

    let попыток = 0
    const saveProgress = vi.fn(async () => {
      попыток += 1
      if (попыток < 3) throw new Error('сети нет')
    })
    configureSync({ load: async () => null, saveProgress, saveAttempts: async () => {} })

    const дело = push()
    await vi.advanceTimersByTimeAsync(10000)
    await дело

    expect(saveProgress).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('не доехало и после повторов — молчим, но кэш цел', async () => {
    vi.useFakeTimers()
    writeJson(KEYS.challenge, { day: 4, done: [] })
    configureSync({
      load: async () => null,
      saveProgress: async () => {
        throw new Error('сети нет')
      },
      saveAttempts: async () => {},
    })

    const дело = push()
    await vi.advanceTimersByTimeAsync(60000)
    await expect(дело).resolves.toBeUndefined()

    // главное: тренировка не упала и данные на месте — доедут в следующий раз
    expect(readJson(KEYS.challenge)).toEqual({ day: 4, done: [] })
    vi.useRealTimers()
  })
})
