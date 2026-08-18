// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MoveCalibration, { MOVES } from './MoveCalibration.jsx'
import { loadDemoLoops } from './DemoSkeleton.jsx'
import { buildRecording, recordFrame } from './recorder.js'

const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
const feed = (from, n) => {
  for (let i = 0; i < n; i += 1) {
    recordFrame({ landmarks: pts, worldLandmarks: pts, timestamp: from + i * 110 })
  }
}

afterEach(() => cleanup())

/**
 * Оставить в списке только названные движения. Именно по названиям, а не по
 * номерам галочек: список движений растёт (мах и прыжок приехали позже всех),
 * и номера в тестах пришлось бы править каждый раз.
 */
function keepOnly(...names) {
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    // Сравниваем имя ЦЕЛИКОМ, а не по вхождению: движений стало больше, и
    // одно теперь начинается с другого — «Присед» и «Присед с прыжком»,
    // «Прыжок» и «Прыжок ноги в стороны». По вхождению тест молча включал бы
    // оба и проверял не то, что написано.
    const label = (box.closest('label')?.textContent || '').replace(' (обе стороны)', '').trim()
    const wanted = names.includes(label)
    if (box.checked !== wanted) fireEvent.click(box)
  }
}

/**
 * Пошаговая калибровка: человек проходит по списку движений, а запись выходит
 * размеченной. Проверяем именно это — что шаги идут в нужном порядке, что у
 * парных движений сторона разводится по отдельным шагам и что переписанный
 * дубль в разметку не попадает.
 */
describe('список движений', () => {
  it('id уникальны — иначе два движения сольются в один сегмент', () => {
    /**
     * Общий id — это не косметика. Галочка в списке одна на id, то есть два
     * движения включались бы вместе; а в записи оба сегмента получили бы одно
     * имя, и развести их офлайн стало бы нечем — при том что снимают запись
     * ровно ради того, чтобы их различить.
     */
    const ids = MOVES.map((m) => m.id)
    expect(ids).toEqual([...new Set(ids)])
  })

  it('у каждого движения есть имя и задание с числом повторов', () => {
    for (const move of MOVES) {
      const task = move.sided ? move.task(5, 'right') : move.task(5)
      expect({ id: move.id, имя: !!move.name, задание: task.includes('5') }).toEqual({
        id: move.id,
        имя: true,
        задание: true,
      })
    }
  })

  it('у парных движений задание разное на разные стороны', () => {
    for (const move of MOVES.filter((m) => m.sided)) {
      expect({ id: move.id, разное: move.task(5, 'left') !== move.task(5, 'right') }).toEqual({
        id: move.id,
        разное: true,
      })
    }
  })
})

describe('список движений листается', () => {
  /**
   * Полевой отчёт 13 августа: «открыл калибровку движений, страница со списком
   * не листается». Движений стало под два десятка, в экран телефона они не влезают,
   * а прокрутки у экрана не было — вместе со списком за нижний край уезжала и
   * кнопка «Начать», то есть экран выглядел сломанным.
   */
  it('галочки живут в своём прокручиваемом блоке', () => {
    render(<MoveCalibration onClose={() => {}} />)

    const list = screen.getByTestId('cal-list')
    const boxes = [...document.querySelectorAll('input[type=checkbox]')]

    expect(boxes.length).toBe(MOVES.length)
    // все до одной — внутри списка
    for (const box of boxes) expect(list.contains(box)).toBe(true)
  })

  it('кнопка «Начать» — ВНЕ списка, иначе она уедет вместе с ним', () => {
    render(<MoveCalibration onClose={() => {}} />)

    const list = screen.getByTestId('cal-list')
    expect(list.contains(screen.getByTestId('cal-start'))).toBe(false)
  })

  it('на кнопке видно, сколько шагов человек берёт на себя', () => {
    render(<MoveCalibration onClose={() => {}} />)

    // у парных движений шагов два, поэтому число заметно больше списка
    const total = MOVES.reduce((n, m) => n + (m.sided ? 2 : 1), 0)
    expect(screen.getByTestId('cal-start').textContent).toBe(`Начать — ${total} шагов`)

    keepOnly('Присед')
    expect(screen.getByTestId('cal-start').textContent).toBe('Начать — 1 шаг')

    keepOnly('Удар рукой')
    expect(screen.getByTestId('cal-start').textContent).toBe('Начать — 2 шага')
  })

  it('без единой галочки начинать нечего, и кнопка это говорит', () => {
    render(<MoveCalibration onClose={() => {}} />)

    keepOnly()
    const start = screen.getByTestId('cal-start')
    expect(start.textContent).toBe('Выбери движения')
    expect(start.disabled).toBe(true)

    // и нажатие ничего не запускает
    fireEvent.click(start)
    expect(screen.getByTestId('move-calibration').dataset.phase).toBe('setup')
  })
})

describe('пошаговая калибровка', () => {
  it('проходит шаги и оставляет размеченную запись', () => {
    render(<MoveCalibration onClose={() => {}} />)

    // оставляем только присед и удар — шагов будет 1 + 2 (стороны)
    keepOnly('Присед', 'Удар рукой')
    fireEvent.click(screen.getByTestId('cal-start'))

    expect(screen.getByTestId('cal-task').textContent).toContain('приседа')
    feed(1000, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('cal-task').textContent).toContain('ПРАВОЙ')
    feed(2100, 10)

    // дубль не удался — переписываем
    fireEvent.click(screen.getByTestId('cal-again'))
    feed(3200, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    expect(screen.getByTestId('cal-task').textContent).toContain('ЛЕВОЙ')
    feed(4300, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    const data = buildRecording({ kind: 'calibration' })
    expect(data.segments.map((s) => [s.movement, s.side])).toEqual([
      ['barrier', null],
      ['strike', 'right'],
      ['strike', 'left'],
    ])
    // переписанный дубль в разметку не попал: сегмент начался позже
    expect(data.segments[1].from).toBeGreaterThan(2000)
    expect(screen.getByText('Готово')).toBeTruthy()
  })

  it('мах рукой и прыжок пишутся размеченными, хотя детекторов ещё нет', () => {
    render(<MoveCalibration onClose={() => {}} />)

    keepOnly('Мах рукой вверх', 'Прыжок')
    fireEvent.click(screen.getByTestId('cal-start'))

    // мах — движение парное, и «через сторону вверх» надо сказать словами:
    // иначе человек делает рывок перед собой, и запись выходит бесполезной
    const first = screen.getByTestId('cal-task').textContent
    expect(first).toContain('ПРАВОЙ')
    expect(first).toContain('через сторону вверх над головой')
    feed(1000, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('cal-task').textContent).toContain('ЛЕВОЙ')
    feed(2100, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('cal-task').textContent).toContain('мягко приземлись')
    feed(3200, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    const data = buildRecording({ kind: 'calibration' })
    expect(data.segments.map((s) => [s.movement, s.side])).toEqual([
      ['raise', 'right'],
      ['raise', 'left'],
      ['jump', null],
    ])
    // границы у новых движений размечаются как у всех остальных
    for (const segment of data.segments) {
      expect(segment.to).toBeGreaterThan(segment.from)
      expect(segment.reps).toBe(5)
    }
  })

  it('выпад назад и захлёст голени пишутся размеченными — детекторов у них нет', () => {
    render(<MoveCalibration onClose={() => {}} />)

    keepOnly('Выпад назад', 'Захлёст голени')
    fireEvent.click(screen.getByTestId('cal-start'))

    // у выпада выделено НАЗАД: вперёд шагают привычнее, и это было бы другое
    // движение — по записи их потом не различить
    const lungeRight = screen.getByTestId('cal-task').textContent
    expect(lungeRight).toContain('НАЗАД')
    expect(lungeRight).toContain('правой')
    expect(lungeRight).toContain('вернись в стойку')
    feed(1000, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('cal-task').textContent).toContain('левой')
    feed(2100, 10)

    // у захлёста выделена сторона: стоя на месте перепутать ногу проще всего
    fireEvent.click(screen.getByTestId('cal-next'))
    const heelRight = screen.getByTestId('cal-task').textContent
    expect(heelRight).toContain('ПРАВОЙ')
    expect(heelRight).toContain('пяткой к ягодице')
    feed(3200, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('cal-task').textContent).toContain('ЛЕВОЙ')
    feed(4300, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    const data = buildRecording({ kind: 'calibration' })
    expect(data.segments.map((s) => [s.movement, s.side])).toEqual([
      ['lunge', 'right'],
      ['lunge', 'left'],
      ['heel', 'right'],
      ['heel', 'left'],
    ])
    for (const segment of data.segments) {
      expect(segment.to).toBeGreaterThan(segment.from)
      expect(segment.reps).toBe(5)
    }
  })

  it('новые движения пишутся размеченными, хотя детекторов у них нет', () => {
    /**
     * Джек и прыжок ноги врозь отличаются ТОЛЬКО положением рук, боковой выпад
     * от шага — ТОЛЬКО просадкой таза. Заглавные буквы в заданиях стоят ровно
     * на этих признаках: не выделишь их человеку — получишь две записи, по
     * которым детекторы неразличимы.
     */
    render(<MoveCalibration onClose={() => {}} />)

    keepOnly('Джампинг-джек', 'Прыжок ноги в стороны', 'Боковой выпад')
    fireEvent.click(screen.getByTestId('cal-start'))

    const jack = screen.getByTestId('cal-task').textContent
    expect(jack).toContain('РУКИ НАД ГОЛОВОЙ')
    feed(1000, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    // то же прыжковое движение, и развести их можно только по рукам
    expect(screen.getByTestId('cal-task').textContent).toContain('РУКИ ВНИЗУ')
    feed(2100, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('cal-task').textContent).toContain('ОПУСТИСЬ')
    feed(3200, 10)
    fireEvent.click(screen.getByTestId('cal-next'))
    feed(4300, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    const data = buildRecording({ kind: 'calibration' })
    expect(data.segments.map((s) => [s.movement, s.side])).toEqual([
      ['jack', null],
      ['hop', null],
      ['sidelunge', 'right'],
      ['sidelunge', 'left'],
    ])
    for (const segment of data.segments) {
      expect(segment.to).toBeGreaterThan(segment.from)
      expect(segment.reps).toBe(5)
    }
  })

  it('скручивание просит ЛОКОТЬ и запрещает убирать руки за голову', () => {
    /**
     * Две оговорки в задании — не украшение, а условия замера.
     *
     * ЛОКОТЬ: «дотянись рукой» человек выполняет одним махом руки, корпус при
     * этом не делает ничего, и движение становится неотличимо от обычного
     * подъёма колена — на этом скручивание один раз уже отменяли. «Локоть к
     * колену» заставляет скручивать корпус.
     *
     * РУКИ ЗА ГОЛОВОЙ: с ладонями за затылком кисть остаётся у головы, а судит
     * камера именно по кисти (локоть стоя до колена не достаёт и наполовину
     * закрыт корпусом — см. moves.js). Мерить было бы нечего.
     */
    render(<MoveCalibration onClose={() => {}} />)

    // складка снята с игры: её потолок в поле — 59% зачётов
    expect(MOVES.map((m) => m.id)).not.toContain('sidecrunch')

    keepOnly('Скручивание с коленом')
    fireEvent.click(screen.getByTestId('cal-start'))

    const right = screen.getByTestId('cal-task').textContent
    expect(right).toContain('ПРАВОЕ')
    expect(right).toContain('ЛОКТЕМ')
    expect(right).toContain('противоположной')
    expect(right).toContain('Руки за голову НЕ убирай')
    feed(1000, 10)

    fireEvent.click(screen.getByTestId('cal-next'))
    const left = screen.getByTestId('cal-task').textContent
    expect(left).toContain('ЛЕВОЕ')
    feed(2100, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    // сторона — по ПОДНИМАЕМОМУ КОЛЕНУ, как у колена и захлёста
    const data = buildRecording({ kind: 'calibration' })
    expect(data.segments.map((s) => [s.movement, s.side])).toEqual([
      ['twistknee', 'right'],
      ['twistknee', 'left'],
    ])
  })

  it('движение показывается фигуркой, а не только описывается словами', async () => {
    // петли приезжают отдельным чанком — дожидаемся его, как и живой экран
    await loadDemoLoops()
    render(<MoveCalibration onClose={() => {}} />)

    keepOnly('Подъём колена')
    fireEvent.click(screen.getByTestId('cal-start'))

    // фигурка показывает ровно то движение и ту сторону, что и просят словами
    expect(screen.getByTestId('demo-skeleton').dataset.loop).toBe('knee:right')
    expect(screen.getByTestId('cal-task').textContent).toContain('ПРАВОГО')

    // и она живёт В ПЛАШКЕ рядом с текстом, а не отдельным слоем поверх видео:
    // середина экрана обязана оставаться за камерой
    expect(screen.getByTestId('cal-top').contains(screen.getByTestId('demo-skeleton'))).toBe(
      true,
    )

    fireEvent.click(screen.getByTestId('cal-next'))
    expect(screen.getByTestId('demo-skeleton').dataset.loop).toBe('knee:left')
  })

  it('во время записи экран отдан камере: сплошной подложки нет', () => {
    render(<MoveCalibration onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('cal-start'))

    const overlay = screen.getByTestId('move-calibration')
    // главный дефект первой версии: тёмный фон на весь экран, человек не
    // видел ни себя, ни скелета и не понимал, попадает ли в кадр
    expect(overlay.dataset.phase).toBe('run')
    expect(overlay.className).toContain('mt-cal--clear')

    // интерфейс живёт двумя плашками по краям, середина свободна
    expect(screen.getByTestId('cal-top')).toBeTruthy()
    expect(screen.getByTestId('cal-next')).toBeTruthy()
    // выбор движений и его тёмная подложка на время записи уходят
    expect(document.querySelector('.mt-cal__setup')).toBeNull()
  })

  it('на выборе движений подложка остаётся: камера там не нужна', () => {
    render(<MoveCalibration onClose={() => {}} />)

    const overlay = screen.getByTestId('move-calibration')
    expect(overlay.dataset.phase).toBe('setup')
    expect(overlay.className).not.toContain('mt-cal--clear')
  })

  it('пустая запись не предлагает отправку: показывает, что кадров нет', () => {
    render(<MoveCalibration onClose={() => {}} />)

    // остаётся один присед, и ни одного кадра за всю запись
    keepOnly('Присед')
    fireEvent.click(screen.getByTestId('cal-start'))
    fireEvent.click(screen.getByTestId('cal-next'))

    expect(screen.getByText('Запись пустая')).toBeTruthy()
    expect(screen.getByTestId('cal-empty')).toBeTruthy()
    expect(screen.queryByTestId('cal-send')).toBeNull()
    expect(screen.queryByTestId('cal-download')).toBeNull()

    // «Пройти заново» возвращает к выбору движений
    fireEvent.click(screen.getByTestId('cal-restart'))
    expect(screen.getByTestId('move-calibration').dataset.phase).toBe('setup')
  })

  /**
   * Потолок записи. Молчаливое переполнение — худшее, что здесь бывает: экран
   * ведёт человека дальше по списку, кадры не пишутся, и десять шагов из
   * двенадцати он делает впустую, узнавая об этом уже по файлу.
   */
  describe('переполнение записи', () => {
    /** Кадр с одной точкой: тут важно только их число, а не содержимое. */
    const fill = (from, n) => {
      const one = [{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]
      for (let i = 0; i < n; i += 1) {
        recordFrame({ landmarks: one, worldLandmarks: one, timestamp: from + i * 50 })
      }
    }

    it('на шагах висит красная плашка — и она главнее «камера не пишет»', () => {
      vi.useFakeTimers()
      try {
        render(<MoveCalibration onClose={() => {}} />)
        keepOnly('Присед', 'Удар рукой')
        fireEvent.click(screen.getByTestId('cal-start'))

        act(() => fill(0, 9000))
        // кадры после этого не идут вовсе, так что сработало бы и «камера не
        // пишет» — но причина другая, и лечится она не «встань в кадр»
        act(() => vi.advanceTimersByTime(3000))

        expect(screen.getByTestId('cal-full').textContent).toContain('переполнена')
        expect(screen.queryByTestId('cal-stale')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('на «Готово» названы шаги, которые в запись не попали', () => {
      render(<MoveCalibration onClose={() => {}} />)

      // шаги: присед, удар правой, удар левой
      keepOnly('Присед', 'Удар рукой')
      fireEvent.click(screen.getByTestId('cal-start'))

      // приседом запись упирается в потолок, оба удара пишутся уже в пустоту
      fill(0, 9000)
      fireEvent.click(screen.getByTestId('cal-next'))
      fireEvent.click(screen.getByTestId('cal-next'))
      fireEvent.click(screen.getByTestId('cal-next'))

      const warn = screen.getByTestId('cal-truncated')
      expect(warn.textContent).toContain('2 шага')
      expect(warn.textContent).toContain('Удар рукой (правая)')
      expect(warn.textContent).toContain('Удар рукой (левая)')

      // размечен только присед: пустые шаги в файл не идут вовсе
      const data = buildRecording({ kind: 'calibration' })
      expect(data.truncated).toBe(true)
      expect(data.segments.map((s) => s.movement)).toEqual(['barrier'])
    })

    it('в пределах потолка ни плашки, ни предупреждения нет', () => {
      render(<MoveCalibration onClose={() => {}} />)

      keepOnly('Присед')
      fireEvent.click(screen.getByTestId('cal-start'))
      fill(0, 200)
      fireEvent.click(screen.getByTestId('cal-next'))

      expect(screen.getByText('Готово')).toBeTruthy()
      expect(screen.queryByTestId('cal-truncated')).toBeNull()
    })
  })

  it('когда кадры есть, отправка и скачивание на месте', () => {
    render(<MoveCalibration onClose={() => {}} />)

    keepOnly('Присед')
    fireEvent.click(screen.getByTestId('cal-start'))
    feed(1000, 10)
    fireEvent.click(screen.getByTestId('cal-next'))

    expect(screen.getByText('Готово')).toBeTruthy()
    expect(screen.getByTestId('cal-download')).toBeTruthy()
  })
})
