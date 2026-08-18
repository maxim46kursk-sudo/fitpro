// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import DemoSkeleton, { hasDemo, loadDemoLoops, loopKey } from './DemoSkeleton.jsx'
import { MOVES } from './MoveCalibration.jsx'
import { SETUP_MOVEMENTS, SETUP_SIDE } from '../game/amplitude.js'
import { LM } from '../pose/landmarks.js'

/**
 * Демо-скелет в калибровке: зелёная фигурка вместо текстовой инструкции.
 *
 * Проверять здесь надо две вещи. Первая — что он ВООБЩЕ РИСУЕТ: невидимая цель
 * в этом проекте уже была, человек бил в пустоту. Вторая — что на каждое
 * движение из списка калибровки есть петля: движения добавляются раньше, чем
 * под них снимают записи, и без сторожа шаг молча остался бы без показа.
 */

/** Канвы в jsdom нет — подсовываем свою и записываем, что на ней рисовали. */
function mockCanvas() {
  const calls = { moveTo: [], lineTo: [], arc: [], stroke: 0, fill: 0, clearRect: 0 }
  const ctx = {
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    clearRect: () => {
      calls.clearRect += 1
    },
    moveTo: (x, y) => calls.moveTo.push([x, y]),
    lineTo: (x, y) => calls.lineTo.push([x, y]),
    arc: (x, y, r) => calls.arc.push([x, y, r]),
    stroke: () => {
      calls.stroke += 1
    },
    fill: () => {
      calls.fill += 1
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  return calls
}

let raf
/**
 * Петли приезжают отдельным чанком, поэтому их надо сперва дождаться. После
 * первой загрузки они лежат в модульном кеше, и компонент получает их уже
 * первым же рендером — как и в живом экране, где чанк приходит один раз.
 */
let demoLoops

beforeAll(async () => {
  demoLoops = await loadDemoLoops()
})

beforeEach(() => {
  // rAF в jsdom есть, но нам нужен управляемый: кадры прогоняем вручную
  raf = []
  vi.stubGlobal('requestAnimationFrame', (fn) => raf.push(fn))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('демо-скелет рисует движение', () => {
  it('на канве появляются кости и голова, и всё внутри её границ', () => {
    const calls = mockCanvas()
    render(<DemoSkeleton movement="barrier" width={100} height={140} />)

    expect(screen.getByTestId('demo-skeleton')).toBeTruthy()
    // двенадцать костей одним путём плюс голова точкой
    expect(calls.stroke).toBeGreaterThan(0)
    expect(calls.fill).toBeGreaterThan(0)
    expect(calls.moveTo.length).toBe(12)
    expect(calls.lineTo.length).toBe(12)
    expect(calls.arc.length).toBe(1)

    // ничего не улетело за края: иначе фигурка была бы обрезана или невидима
    for (const [x, y] of [...calls.moveTo, ...calls.lineTo]) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(100)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(140)
    }
  })

  it('фигурка не прыгает: рамка одна на всю петлю, а не своя на каждый кадр', () => {
    /**
     * Присед — тот самый случай, ради которого рамка и берётся общей. При
     * покадровом автомасштабе фигурка каждый раз растягивалась бы на всю канву,
     * то есть макушка всегда стояла бы у верхнего края, — и приседа на демо не
     * было бы видно ВООБЩЕ. С общей рамкой макушка честно опускается.
     */
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const calls = mockCanvas()
    render(<DemoSkeleton movement="barrier" width={100} height={140} />)

    /** Самая верхняя точка i-го нарисованного кадра. */
    const topOf = (i) => {
      const bones = calls.lineTo.slice(i * 12, i * 12 + 12).map(([, y]) => y)
      return Math.min(calls.arc[i][1], ...bones)
    }

    // Прокручиваем петлю до середины — там нижняя точка приседа. Время
    // двигаем от нуля, а не шагами: складывать 1000/12 два десятка раз значит
    // накопить ошибку и потерять кадр на ровном месте.
    const mid = Math.floor(demoLoops.loops.barrier.length / 2)
    for (let i = 1; i <= mid; i += 1) {
      now = (i * 1000) / demoLoops.fps
      for (const fn of raf.splice(0, raf.length)) fn()
    }
    // петля и правда крутится, а последний нарисованный кадр — её середина
    expect(calls.arc.length).toBe(mid + 1)

    // стоя макушка у самого верха рамки, в приседе — заметно ниже
    const last = calls.arc.length - 1
    expect(topOf(last)).toBeGreaterThan(topOf(0) + 10)
  })

  it('фигурка отражена, как и видео: мах ЛЕВОЙ идёт по левой половине', () => {
    /**
     * Видео человек видит зеркальным (.mt-mirror, scaleX(-1)) — там его левая
     * рука слева, как в настоящем зеркале. Петли же лежат в СЫРЫХ координатах
     * кадра, где та же рука справа. Без отражения рядом с человеком стоял бы
     * двойник, поднимающий противоположную руку, — для парных движений это
     * хуже, чем не показывать ничего.
     */
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const calls = mockCanvas()
    render(<DemoSkeleton movement="raise" side="left" width={100} height={140} />)

    // Кости рисуются постоянным списком, поэтому запястья лежат на известных
    // местах: 3-я кость — левое предплечье, 5-я — правое.
    const wrist = (frame, side) => calls.lineTo[frame * 12 + (side === 'left' ? 2 : 4)]

    // левая рука нарисована левее правой — это и есть зеркало, и видно это уже
    // на первом кадре, когда человек просто стоит
    expect(wrist(0, 'left')[0]).toBeLessThan(wrist(0, 'right')[0])

    // прокручиваем всю петлю и ищем кадр, где левое запястье выше всего
    const frames = demoLoops.loops['raise:left']
    for (let i = 1; i < frames.length; i += 1) {
      now = (i * 1000) / demoLoops.fps
      for (const fn of raf.splice(0, raf.length)) fn()
    }
    let peak = 0
    for (let i = 1; i < calls.arc.length; i += 1) {
      if (wrist(i, 'left')[1] < wrist(peak, 'left')[1]) peak = i
    }

    // в верхней точке маха рука выше головы — и она на ЛЕВОЙ половине картинки
    expect(wrist(peak, 'left')[1]).toBeLessThan(calls.arc[peak][1])
    expect(wrist(peak, 'left')[0]).toBeLessThan(50)
  })

  it('нет петли для движения — не рисуется ничего, и это не падение', () => {
    const calls = mockCanvas()
    // планка исключена ТЗ сознательно: петли у неё не будет никогда, и пример
    // не устареет, как устарело скручивание — оно стало настоящим движением
    render(<DemoSkeleton movement="plank" side="right" />)

    expect(screen.queryByTestId('demo-skeleton')).toBeNull()
    expect(calls.stroke).toBe(0)
    expect(hasDemo('plank', 'right')).toBe(false)
  })

  it('движение просят стороной: у парных петля своя на каждую ногу и руку', () => {
    mockCanvas()
    render(<DemoSkeleton movement="knee" side="left" />)

    expect(screen.getByTestId('demo-skeleton').dataset.loop).toBe('knee:left')
    expect(loopKey('knee', 'left')).toBe('knee:left')
    // у движения без стороны ключ без двоеточия
    expect(loopKey('barrier', null)).toBe('barrier')
  })

  /**
   * ЧЕРЕДОВАНИЕ СТОРОН У ОДНОСТОРОННИХ ДВИЖЕНИЙ.
   *
   * Полевой прогон сессии: инструктор весь силовой блок делал выпад одной и той
   * же ногой, человек копировал — и тридцать секунд грузил одну сторону.
   * Детекторы принимают обе; чинить надо показ, и починка тоже показная —
   * каждый второй проход петли отражается по горизонтали.
   */
  describe('односторонние движения показываются то одной стороной, то другой', () => {
    /**
     * Прокрутить n кадров петли и вернуть x головы на каждом нарисованном.
     *
     * Время двигается от нуля с постоянным запасом в миллисекунду: ровно на
     * шаг мало — накопитель компонента считает в тех же долях, и одного
     * округления вниз хватает, чтобы кадр потерялся и вся нумерация уехала.
     */
    function play(movement, side, frames) {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const calls = mockCanvas()
      render(<DemoSkeleton movement={movement} side={side} width={100} height={140} />)
      for (let i = 1; i <= frames; i += 1) {
        now = (i * 1000) / demoLoops.fps + 1
        for (const fn of raf.splice(0, raf.length)) fn()
      }
      // голова каждого кадра: по ней и видно, в какую сторону смотрит фигурка
      return calls.arc.map(([x]) => x)
    }

    it('выпад: второй проход петли зеркален первому', () => {
      const length = demoLoops.loops[loopKey('lunge', 'left')].length
      // два полных прохода: первый как снят, второй отражённый
      const heads = play('lunge', 'left', length * 2)
      const first = heads.slice(0, length)
      const second = heads.slice(length, length * 2)
      expect(second).toHaveLength(length)

      // отражение относительно середины канвы: x и (ширина - x)
      for (let i = 0; i < length; i += 1) {
        expect(second[i]).toBeCloseTo(100 - first[i], 6)
      }
      // и это не «то же самое»: фигурка и правда несимметрична
      expect(Math.max(...first.map((x) => Math.abs(x - 50)))).toBeGreaterThan(1)
    })

    it('третий проход возвращает исходную сторону', () => {
      const length = demoLoops.loops[loopKey('sidelunge', 'right')].length
      const heads = play('sidelunge', 'right', length * 3)
      for (let i = 0; i < length; i += 1) {
        expect(heads[length * 2 + i]).toBeCloseTo(heads[i], 6)
      }
    })

    it('симметричные движения не отражаются: показывать нечего', () => {
      // присед в зеркале — тот же присед, и лишний переворот только дёргает глаз
      const length = demoLoops.loops.barrier.length
      const heads = play('barrier', null, length * 2)
      for (let i = 0; i < length; i += 1) {
        expect(heads[length + i]).toBeCloseTo(heads[i], 6)
      }
    })
  })

  it('человек просил не анимировать — показываем один кадр и не крутим петлю', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const calls = mockCanvas()
    render(<DemoSkeleton movement="barrier" width={100} height={140} />)

    // кадр нарисован
    expect(calls.stroke).toBe(1)
    // и никакой анимации не заведено
    expect(raf.length).toBe(0)
  })
})

describe('петли есть на все движения калибровки', () => {
  it('петли грузятся отдельным чанком и второй раз не тянутся', async () => {
    // семьдесят килобайт ради одного экрана не должны висеть на первой загрузке
    const again = await loadDemoLoops()
    expect(again).toBe(demoLoops)
  })

  it('файл собран из живых записей и объявляет свой формат', () => {
    expect(demoLoops.version).toBe(1)
    expect(demoLoops.fps).toBeGreaterThan(0)
    // точки скелета: голова, плечи, локти, запястья, таз, колени, стопы
    expect(demoLoops.points).toContain(LM.NOSE)
    expect(demoLoops.points).toContain(LM.LEFT_ANKLE)
    expect(demoLoops.points).toContain(LM.RIGHT_WRIST)
  })

  /**
   * Сторож. Движение появляется в калибровке РАНЬШЕ, чем под него снята запись
   * (так было с махом, прыжком, выпадом и захлёстом), и без этой проверки шаг
   * молча остался бы с одним текстом — то есть ровно в том состоянии, из-за
   * которого демо и понадобилось.
   */
  /**
   * Движения, под которые записи ещё нет. Петли режутся ИЗ записей, поэтому у
   * нового движения демо и не может появиться раньше, чем его снимут: сначала
   * размеченная запись, потом пороги, потом детектор и петля.
   *
   * Список именной, а не общее послабление: пока движение в нём, оно живёт без
   * фигурки осознанно; как только запись снята, строка отсюда уходит, и страж
   * снова следит за ним, как за всеми.
   */
  const AWAITING_RECORDING = new Set([
    // Очередь ПУСТА: под инструктора силового блока нарезаны петли всех
    // движений калибровки, включая девять новых и скручивание. Страж теперь
    // следит за каждым — и первым же красным тестом скажет, если движение
    // добавили, а запись под него снять забыли.
  ])

  it('на каждое СНЯТОЕ движение калибровки есть своя петля', () => {
    const missing = []
    for (const move of MOVES) {
      if (AWAITING_RECORDING.has(move.id)) continue
      const sides = move.sided ? ['right', 'left'] : [null]
      for (const side of sides) {
        if (!hasDemo(move.id, side)) missing.push(loopKey(move.id, side))
      }
    }
    expect(missing).toEqual([])
  })

  it('движение из очереди на запись петли и не имеет — иначе список врёт', () => {
    // если запись сняли и петлю нарезали, строку отсюда надо убрать, иначе
    // страж перестанет следить за движением, которое уже готово
    const stale = [...AWAITING_RECORDING].filter((id) => hasDemo(id, 'right') || hasDemo(id, null))
    expect(stale).toEqual([])
  })

  /**
   * И на каждое движение «Настройки под себя» тоже. Список там СВОЙ и с другими
   * именами: в калибровке движения зовутся по себе (`raise`, `jump`), а на
   * настройке — по препятствию, которое их требует (`bird`, `pit`).
   *
   * Полевой тест 13 августа: у птицы и ямы фигурки не было вовсе, человек видел
   * один текст. Страж стоял только на списке калибровки и этого не заметил.
   */
  it('и на каждое движение «Настройки под себя» — с её именами', () => {
    const missing = SETUP_MOVEMENTS.filter(
      (id) => !hasDemo(id, SETUP_SIDE[id] ?? null),
    )
    expect(missing).toEqual([])
  })

  it('игровое имя движения находит петлю калибровки', () => {
    // птица снята как «мах рукой», яма — как «прыжок»
    expect(loopKey('bird', 'right')).toBe('raise:right')
    expect(loopKey('pit', null)).toBe('jump')
    // у остальных имя и там, и там одно
    expect(loopKey('knee', 'left')).toBe('knee:left')
  })

  it('в каждой петле хватает кадров и все они одной длины', () => {
    const size = (demoLoops.points?.length ?? 0) * 2
    for (const [key, frames] of Object.entries(demoLoops.loops)) {
      // меньше восьми кадров — это не движение, а подёргивание
      expect({ петля: key, кадров: frames.length >= 8 }).toEqual({ петля: key, кадров: true })
      for (const row of frames) {
        expect({ петля: key, длина: row.length }).toEqual({ петля: key, длина: size })
        expect(row.every((v) => Number.isFinite(v))).toBe(true)
      }
    }
  })
})
