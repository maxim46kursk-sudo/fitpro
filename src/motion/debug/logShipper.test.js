import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * БУФЕР ЛОГА: что переживает переполнение, а что нет.
 *
 * Полевой прогон полной сессии: начало лога обрезано, и весь силовой блок
 * приседа пропал из него целиком — вместе с block.start, всеми block.attempt и
 * block.end. То есть ровно те строки, ради которых диагностика и писалась,
 * вытеснил поток снимков состояния и зачётов.
 *
 * Отсюда правило: массовое (снимок раз в пять секунд, каждый зачёт и промах)
 * выбрасывается первым, редкое живёт до конца сессии.
 */

/**
 * Модуль держит буфер в замыкании — на каждый тест берём его заново.
 * `dev` выбирает среду: от неё зависит, какой приёмник считается своим.
 */
async function freshLog(search = '?log=0', dev = false) {
  vi.resetModules()
  vi.stubEnv('DEV', dev)
  // по умолчанию отправки нет: буфер должен копиться, как он копится на
  // телефоне без приёмника — именно там переполнение и случается
  vi.stubGlobal('location', { search })
  return import('./logShipper.js')
}

const linesOf = (text) => (text ? text.split('\n') : [])
const countTag = (text, tag) => linesOf(text).filter((l) => l.includes(`[${tag}]`)).length

describe('переполнение выбрасывает массовое, а не всё подряд', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('block.* переживают тысячу снимков', async () => {
    const { logEvent, getShippedText } = await freshLog()

    logEvent('block.start', { movement: 'barrier' })
    for (let i = 0; i < 40; i += 1) logEvent('block.attempt', { movement: 'barrier', metric: i })
    logEvent('block.end', { movement: 'barrier', reps: 3 })

    // столько снимков за сессию не наберётся и близко — а блок обязан выжить
    for (let i = 0; i < 1000; i += 1) logEvent('snapshot', { fps: 20 })

    const text = getShippedText()
    expect(countTag(text, 'block.start')).toBe(1)
    expect(countTag(text, 'block.attempt')).toBe(40)
    expect(countTag(text, 'block.end')).toBe(1)
  })

  it('зачёты и промахи боя тоже считаются массовыми', async () => {
    const { logEvent, getShippedText } = await freshLog()
    logEvent('block.start', { movement: 'lunge' })
    for (let i = 0; i < 800; i += 1) {
      logEvent(i % 2 ? 'game.clear' : 'game.miss', { id: i })
    }
    expect(countTag(getShippedText(), 'block.start')).toBe(1)
  })

  it('буфер всё-таки ограничен: память телефона не резиновая', async () => {
    const { logEvent, getShippedText } = await freshLog()
    // одни только редкие события, вытеснять нечего — но расти без предела
    // буфер не должен, иначе длинная сессия съест телефон
    for (let i = 0; i < 3000; i += 1) logEvent('block.attempt', { i })
    expect(linesOf(getShippedText()).length).toBeLessThanOrEqual(600)
  })

  it('порядок строк не путается: лог читают сверху вниз', async () => {
    const { logEvent, getShippedText } = await freshLog()
    logEvent('block.start', {})
    for (let i = 0; i < 700; i += 1) logEvent('snapshot', { i })
    logEvent('block.end', {})

    const lines = linesOf(getShippedText())
    expect(lines[0]).toContain('[block.start]')
    expect(lines[lines.length - 1]).toContain('[block.end]')
  })
})

describe('лог с телефона доходит сам: куда и когда слать', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('на проде приёмник свой, на деве свой', async () => {
    /**
     * Раньше приёмник был один, дев-серверный, и на проде отправка молча
     * выключалась: лог доезжал только выгрузкой файлом через кнопку в панели.
     * Полевая сессия показала цену — до разбора доходит то, что человек
     * догадался сохранить, а не то, что случилось.
     */
    expect((await freshLog('', false)).logEndpoint()).toBe('/api/log')
    expect((await freshLog('', true)).logEndpoint()).toBe('/__log')
  })

  it('без ключа отправка включена — приёмник есть везде', async () => {
    const { isShipping } = await freshLog('')
    expect(isShipping()).toBe(true)
  })

  it('?log=0 глушит отправку, но лог всё равно копится', async () => {
    const { isShipping, logEvent, getShippedText } = await freshLog('?log=0')
    expect(isShipping()).toBe(false)
    logEvent('block.start', { movement: 'barrier' })
    // строка на месте: её заберёт кнопка выгрузки
    expect(getShippedText()).toContain('[block.start]')
  })

  it('приёмник не ответил — отправка выключается, лог остаётся', async () => {
    const { flush, isShipping, logEvent, getShippedText } = await freshLog('')
    vi.stubGlobal('fetch', () => Promise.reject(new Error('нет сети')))
    logEvent('block.start', {})
    await flush()

    expect(isShipping()).toBe(false)
    // и ни одной строки не потеряно: они вернулись в буфер
    expect(getShippedText()).toContain('[block.start]')
  })

  it('успешная отправка уносит строки из буфера', async () => {
    const { flush, logEvent, getShippedText } = await freshLog('')
    const sent = []
    vi.stubGlobal('fetch', (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) })
      return Promise.resolve({ ok: true })
    })
    logEvent('block.end', { reps: 3 })
    await flush()

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/api/log')
    expect(sent[0].body.session).toMatch(/^session-/)
    expect(sent[0].body.lines[0]).toContain('[block.end]')
    expect(getShippedText()).toBe('')
  })
})

describe('события-переходы: пишется смена состояния, а не состояние', () => {
  /**
   * Урок 18 августа: бой шёл в экономном режиме (эффекты урезаны), а в логах
   * этого не было вовсе — жалобу «не видно попадания» разобрать было нечем.
   * Писать такое состояние каждым кадром нельзя: это тысячи одинаковых строк.
   */
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('одинаковое состояние подряд не пишется', async () => {
    const { createTransitionLog, getShippedText } = await freshLog()
    const note = createTransitionLog()

    for (let i = 0; i < 100; i += 1) note('render.cheap', true, { on: true }, 1000 + i)

    expect(countTag(getShippedText(), 'render.cheap')).toBe(1)
  })

  it('дребезг на границе порога гасится паузой', async () => {
    /**
     * Экономный режим включается и выключается по кадру отрисовки, и на
     * границе он скачет. Лог должен показывать, ЧТО телефон не тянет, а не
     * считать колебания.
     */
    const { createTransitionLog, getShippedText } = await freshLog()
    const note = createTransitionLog(5000)

    expect(note('render.cheap', true, { on: true }, 0)).toBe(true)
    // скачок туда-обратно внутри паузы не оставляет следа вовсе
    expect(note('render.cheap', false, { on: false }, 1000)).toBe(false)
    expect(note('render.cheap', true, { on: true }, 2000)).toBe(false)
    expect(countTag(getShippedText(), 'render.cheap')).toBe(1)

    // а устойчивая смена пишется, как только пауза вышла
    expect(note('render.cheap', false, { on: false }, 5000)).toBe(true)
    expect(countTag(getShippedText(), 'render.cheap')).toBe(2)
  })

  it('первое состояние пишется сразу, паузы не ждёт', async () => {
    const { createTransitionLog, getShippedText } = await freshLog()
    const note = createTransitionLog(5000)
    expect(note('orientation.change', true, { landscape: true }, 0)).toBe(true)
    expect(countTag(getShippedText(), 'orientation.change')).toBe(1)
  })

  it('отклонения не выбрасываются раньше массовых событий', async () => {
    // они и есть то, ради чего лог читают: снимок можно потерять, эту строку нет
    const { createTransitionLog, logEvent, getShippedText } = await freshLog()
    const note = createTransitionLog()

    note('render.cheap', true, { on: true, frameMs: 41 }, 0)
    logEvent('audio.blocked', { cause: 'suspended' })
    logEvent('camera.degraded', { width: 320, frameRate: 15 })
    for (let i = 0; i < 1000; i += 1) logEvent('snapshot', { fps: 7 })

    const text = getShippedText()
    expect(countTag(text, 'render.cheap')).toBe(1)
    expect(countTag(text, 'audio.blocked')).toBe(1)
    expect(countTag(text, 'camera.degraded')).toBe(1)
  })
})
