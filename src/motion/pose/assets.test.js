import { describe, expect, it, vi } from 'vitest'
import {
  CDN_MODEL_URL,
  CDN_WASM_BASE,
  MODEL_FILE,
  TASKS_VISION_VERSION,
  assetSources,
  loadFromSources,
  looksLikeLoader,
  looksLikeModel,
  looksLikeWasm,
  ownBase,
} from './assets.js'

/**
 * ОТКУДА БЕРЁТСЯ ДВИЖОК РАСПОЗНАВАНИЯ.
 *
 * Первый запуск качает около 8.8 МБ с двух чужих адресов за границей, и
 * jsdelivr к тому же за Cloudflare, которую в России режут. Отвалится любой из
 * двух — Motion не стартует ни у кого. Файлы переехали на наш сервер, но
 * запасной путь остался: свой сервер — одна машина, и упасть она может ровно
 * так же, только чинится не мгновенно.
 *
 * Здесь проверяется весь выбор целиком: какой источник берётся, когда
 * происходит откат, что при этом попадает в лог и по чему опознаётся «источник
 * ответил, но отдал не то».
 */

describe('выбор источника', () => {
  it('по умолчанию первым идёт наш сервер, запасным — прежний CDN', () => {
    const [own, cdn] = assetSources({ base: 'https://api.fitproapp.ru/storage/v1/object/public/motion-assets' })

    expect(own.name).toBe('own')
    expect(own.wasmBase).toBe(
      `https://api.fitproapp.ru/storage/v1/object/public/motion-assets/tasks-vision/${TASKS_VISION_VERSION}/wasm`,
    )
    expect(own.modelUrl).toContain(`/models/${MODEL_FILE}`)

    expect(cdn.name).toBe('cdn')
    expect(cdn.wasmBase).toBe(CDN_WASM_BASE)
    expect(cdn.modelUrl).toBe(CDN_MODEL_URL)
  })

  it('версия входит в путь: движок и пакет обязаны совпадать до цифры', () => {
    /**
     * Обновление пакета — заливка нового каталога РЯДОМ, а не подмена старого:
     * сборка, которая уже уехала к людям, продолжает брать свою версию. Без
     * версии в пути обновление бакета молча ломало бы все прежние сборки.
     */
    const [own] = assetSources({ base: 'https://x/y' })
    expect(own.wasmBase).toContain(`/${TASKS_VISION_VERSION}/`)
    expect(CDN_WASM_BASE).toContain(`@${TASKS_VISION_VERSION}/`)
  })

  it('завершающие слэши в настройке не удваиваются в адресе', () => {
    expect(ownBase('https://x/y///')).toBe('https://x/y')
    const [own] = assetSources({ base: ownBase('https://x/y///') })
    expect(own.wasmBase).not.toContain('//tasks-vision')
  })

  it('своего источника нет — остаётся один прежний CDN', () => {
    // так собирают заведомо прежний вариант, чтобы сравнить с новым
    const sources = assetSources({ base: '' })
    expect(sources.map((s) => s.name)).toEqual(['cdn'])
  })

  it('запасной путь можно отключить, но пустым список не станет', () => {
    expect(assetSources({ base: 'https://x', cdn: false }).map((s) => s.name)).toEqual(['own'])

    /**
     * Ни своего, ни запасного — это ошибка настройки сборки, а не режим работы.
     * Пустой список означал бы белый экран без единого объяснения, поэтому
     * остаётся прежний CDN.
     */
    expect(assetSources({ base: '', cdn: false }).map((s) => s.name)).toEqual(['cdn'])
  })
})

describe('источник ответил, но отдал не то', () => {
  /**
   * Это главная причина, по которой проверяется СОДЕРЖИМОЕ, а не код ответа.
   * Бакет, из которого удалили файл, отвечает JSON-ошибкой; прокси на
   * обслуживании — HTML-заглушкой. И то и другое приходит успешным ответом с
   * телом, и без проверки доехало бы до MediaPipe, где запасного пути уже нет.
   */
  const bytes = (...values) => new Uint8Array([...values, 0, 0, 0, 0, 0, 0, 0, 0])
  const utf8 = (text) => new TextEncoder().encode(text)

  it('wasm опознаётся по своей сигнатуре', () => {
    expect(looksLikeWasm(bytes(0x00, 0x61, 0x73, 0x6d))).toBe(true)
    expect(looksLikeWasm(utf8('<!DOCTYPE html><html>сервис недоступен'))).toBe(false)
    expect(looksLikeWasm(utf8('{"statusCode":"400","error":"Not found"}'))).toBe(false)
    expect(looksLikeWasm(new Uint8Array([0x00, 0x61]))).toBe(false)
    expect(looksLikeWasm(null)).toBe(false)
  })

  it('модель опознаётся по zip-сигнатуре со сдвигом', () => {
    // .task — zip с двухбайтовым префиксом: сигнатура стоит не с начала файла
    expect(looksLikeModel(bytes(0x00, 0x00, 0x50, 0x4b, 0x03, 0x04))).toBe(true)
    expect(looksLikeModel(utf8('<html>502 Bad Gateway</html>'))).toBe(false)
    expect(looksLikeModel(utf8('{"error":"Object not found"}'))).toBe(false)
    expect(looksLikeModel(null)).toBe(false)
  })

  it('загрузчик опознаётся от обратного: по тому, чем он точно НЕ является', () => {
    expect(looksLikeLoader('// This code implements the `-sMODULARIZE` settings')).toBe(true)
    expect(looksLikeLoader('var Module=(()=>{')).toBe(true)
    expect(looksLikeLoader('<!DOCTYPE html>')).toBe(false)
    expect(looksLikeLoader('  <html>')).toBe(false)
    expect(looksLikeLoader('{"statusCode":"404","error":"not_found","message":"Object not found"}')).toBe(
      false,
    )
    expect(looksLikeLoader('')).toBe(false)
  })
})

describe('запасной путь срабатывает', () => {
  const own = { name: 'own' }
  const cdn = { name: 'cdn' }

  it('свой источник ответил — до запасного дело не доходит', async () => {
    const load = vi.fn(async () => 'файлы')
    const onFallback = vi.fn()

    const picked = await loadFromSources([own, cdn], load, onFallback)

    expect(picked.source).toBe(own)
    expect(picked.value).toBe('файлы')
    expect(load).toHaveBeenCalledTimes(1)
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('свой не ответил — один раз пробуем прежний CDN и говорим об этом', async () => {
    const load = vi.fn(async (source) => {
      if (source.name === 'own') throw new Error('HTTP 502')
      return 'файлы с CDN'
    })
    const onFallback = vi.fn()

    const picked = await loadFromSources([own, cdn], load, onFallback)

    expect(picked.source).toBe(cdn)
    expect(picked.value).toBe('файлы с CDN')
    expect(load).toHaveBeenCalledTimes(2)
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledWith({ from: 'own', to: 'cdn', reason: 'HTTP 502' })
  })

  it('свой отдал не то — это тоже повод откатиться, а не только сеть', async () => {
    const load = vi.fn(async (source) => {
      if (source.name === 'own') throw new Error('не тот файл (model, 68 Б)')
      return 'файлы с CDN'
    })
    const onFallback = vi.fn()

    await loadFromSources([own, cdn], load, onFallback)

    expect(onFallback.mock.calls[0][0].reason).toContain('не тот файл')
  })

  it('ПРОБУЕМ РОВНО ОДИН РАЗ: откат не превращается в круг', async () => {
    /**
     * Повторять запасной источник бесконечно значило бы держать человека перед
     * заставкой загрузки без объяснения. Не вышло у обоих — пусть скажет экран.
     */
    const load = vi.fn(async () => {
      throw new Error('сети нет')
    })

    await expect(loadFromSources([own, cdn], load, vi.fn())).rejects.toThrow()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('не смогли оба — в ошибку идут ОБЕ причины, а не последняя', async () => {
    /**
     * По одной причине в поле не разобраться: «сети нет» от CDN ничего не
     * говорит о том, что случилось со своим сервером, а чинить надо именно его.
     */
    const load = vi.fn(async (source) => {
      throw new Error(source.name === 'own' ? 'HTTP 403' : 'сети нет')
    })

    await expect(loadFromSources([own, cdn], load, vi.fn())).rejects.toThrow(
      /own: HTTP 403.*cdn: сети нет/,
    )
  })

  it('последний источник об откате не сообщает: откатываться уже некуда', async () => {
    const onFallback = vi.fn()
    const load = vi.fn(async () => {
      throw new Error('сети нет')
    })

    await expect(loadFromSources([own, cdn], load, onFallback)).rejects.toThrow()
    // один вызов, а не два: «не смогли» — это ошибка, а не переключение
    expect(onFallback).toHaveBeenCalledTimes(1)
  })

  it('источников нет вовсе — понятная ошибка, а не молчание', async () => {
    await expect(loadFromSources([], vi.fn(), vi.fn())).rejects.toThrow('источников не задано')
    await expect(loadFromSources(undefined, vi.fn(), vi.fn())).rejects.toThrow('источников не задано')
  })
})

describe('окончательный отказ не повторяется', () => {
  /**
   * Три попытки с паузами имеют смысл против дрожащей сети. Против ответа «такого
   * нет» они бессмысленны и вредны: 403 (сняли публичность бакета), 404 (не залили
   * файл) и 400 (хранилище не знает объекта) — это определённый ответ, и повторы
   * лишь задерживают откат на запасной источник почти на три секунды. Ровно эти
   * три кода и приходят, когда с бакетом что-то не так, — то есть в самом частом
   * случае откат тормозил бы дольше всего.
   *
   * Правило живёт в poseWorker.js рядом с самим скачиванием; здесь закреплено то,
   * ЧТО считается окончательным, — иначе список кодов разъедется с рассуждением.
   */
  const isFatal = (status) => status >= 400 && status < 500 && ![408, 429].includes(status)

  it('ответы про отсутствие и доступ повторять нечего', () => {
    for (const status of [400, 401, 403, 404, 410]) expect(isFatal(status)).toBe(true)
  })

  it('перегрузку и таймаут шлюза переждать стоит', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(isFatal(status)).toBe(false)
  })
})
