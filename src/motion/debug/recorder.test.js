import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginSegment,
  buildRecording,
  dropSegment,
  endSegment,
  isFull,
  isRecording,
  recordFrame,
  recordedCount,
  recordedSegments,
  startRecording,
  stopRecording,
} from './recorder.js'

/**
 * Разметка записи — то, ради чего существует пошаговая калибровка. По сплошной
 * записи не разобрать, где человек делал движение, а где просто стоял, и
 * «лишнее срабатывание» неотличимо от честного. Здесь проверяется, что метки
 * ложатся на те кадры, на которые должны, и что неудачный дубль в разметку
 * не попадает.
 */

/** Кадр записи: содержимое точек здесь не важно, важны метки времени. */
function frame(timestamp) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  recordFrame({ landmarks: points, worldLandmarks: points, timestamp })
}

/** Кадры идут по 110 мс — как на слабом телефоне. */
function frames(from, count) {
  for (let i = 0; i < count; i += 1) frame(from + i * 110)
}

beforeEach(() => {
  startRecording()
})

describe('разметка записи', () => {
  it('сегмент помнит движение, сторону и границы по времени', () => {
    // метки времени идут от первого кадра записи, а не от нуля часов
    frames(1000, 5) // 0..440 мс записи
    beginSegment({ movement: 'knee', side: 'right', reps: 5 })
    frames(1550, 10)
    endSegment()

    const [segment] = recordedSegments()
    expect(segment).toMatchObject({ movement: 'knee', side: 'right', reps: 5 })
    expect(segment.from).toBe(440)
    expect(segment.to).toBe(1540)
  })

  it('сегменты идут подряд и не наезжают друг на друга', () => {
    frames(0, 3)
    beginSegment({ movement: 'strike', side: 'left', reps: 5 })
    frames(330, 5)
    endSegment()
    beginSegment({ movement: 'strike', side: 'right', reps: 5 })
    frames(880, 5)
    endSegment()

    const [first, second] = recordedSegments()
    expect(first.side).toBe('left')
    expect(second.side).toBe('right')
    expect(second.from).toBeGreaterThanOrEqual(first.to)
  })

  it('«Заново» выбрасывает дубль из разметки, кадры при этом остаются', () => {
    frames(0, 3)
    beginSegment({ movement: 'barrier', side: null, reps: 5 })
    frames(330, 5)

    dropSegment() // не получилось — переписываем
    beginSegment({ movement: 'barrier', side: null, reps: 5 })
    frames(880, 5)
    endSegment()

    const segments = recordedSegments()
    expect(segments).toHaveLength(1)
    // размечен только второй дубль, первый остался кадрами вне сегментов
    expect(segments[0].from).toBe(770)
    expect(buildRecording().frameCount).toBe(13)
  })

  it('незакрытый сегмент в файл не попадает', () => {
    frames(0, 3)
    beginSegment({ movement: 'wall', side: 'left', reps: 5 })
    frames(330, 3)
    stopRecording()

    expect(buildRecording().segments).toEqual([])
  })

  it('файл несёт разметку рядом с кадрами', () => {
    frames(0, 3)
    beginSegment({ movement: 'beam', side: 'left', reps: 5 })
    frames(330, 3)
    endSegment()

    const data = buildRecording({ kind: 'calibration' })
    expect(data.kind).toBe('calibration')
    expect(data.segments).toHaveLength(1)
    expect(data.segments[0].movement).toBe('beam')
    expect(data.frames.length).toBe(data.frameCount)
  })

  it('новая запись начинается с чистой разметки', () => {
    beginSegment({ movement: 'knee', side: 'left', reps: 5 })
    frames(0, 3)
    endSegment()
    expect(recordedSegments()).toHaveLength(1)

    startRecording()
    expect(recordedSegments()).toEqual([])
    expect(buildRecording().frameCount).toBe(0)
  })

  /**
   * Шаг, за который не пришло ни одного кадра, — это шаг после переполнения
   * или при отвалившейся камере. Раньше он ложился в разметку сегментом
   * нулевой длины: разбор такой сегмент не переживает (segments.replay требует
   * to > from), и одна такая запись в recordings/ красит весь прогон в красное.
   */
  it('сегмент без единого кадра в разметку не попадает', () => {
    frames(0, 5)
    beginSegment({ movement: 'barrier', side: null, reps: 5 })
    endSegment() // кадры не шли

    expect(recordedSegments()).toEqual([])
    expect(buildRecording().segments).toEqual([])
  })

  it('соседние шаги без кадров не ломают разметку тех, где кадры были', () => {
    beginSegment({ movement: 'knee', side: 'right', reps: 5 })
    endSegment()
    beginSegment({ movement: 'knee', side: 'left', reps: 5 })
    frames(0, 6)
    endSegment()
    beginSegment({ movement: 'jump', side: null, reps: 5 })
    endSegment()

    const segments = recordedSegments()
    expect(segments.map((s) => [s.movement, s.side])).toEqual([['knee', 'left']])
    expect(segments[0].to).toBeGreaterThan(segments[0].from)
  })
})

/**
 * Потолок записи. Прежние 3000 кадров кончались на середине списка движений, а
 * кончались молча: экран вёл человека дальше, кадры не писались, и по файлу
 * было не понять, что оставшиеся шаги он вообще делал.
 */
describe('потолок записи', () => {
  /** Лёгкий кадр: здесь важно только их число, а не содержимое точек. */
  const tick = (t) => {
    const points = [{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]
    recordFrame({ landmarks: points, worldLandmarks: points, timestamp: t })
  }
  const ticks = (from, count) => {
    for (let i = 0; i < count; i += 1) tick(from + i * 50)
  }

  it('запись останавливается на 9000 кадрах', () => {
    ticks(0, 9200)

    expect(recordedCount()).toBe(9000)
    expect(isRecording()).toBe(false)
    expect(buildRecording().frameCount).toBe(9000)
  })

  it('переполнение не молчит: truncated виден и снаружи, и в файле', () => {
    expect(isFull()).toBe(false)
    ticks(0, 8999)
    expect(isFull()).toBe(false)

    ticks(500000, 1)
    expect(isFull()).toBe(true)
    expect(buildRecording().truncated).toBe(true)
  })

  it('запись в пределах потолка переполненной не считается', () => {
    ticks(0, 100)
    stopRecording()

    expect(isFull()).toBe(false)
    expect(buildRecording().truncated).toBe(false)
  })

  it('новая запись снимает признак переполнения', () => {
    ticks(0, 9000)
    expect(isFull()).toBe(true)

    startRecording()
    expect(isFull()).toBe(false)
    expect(buildRecording().truncated).toBe(false)
  })

  it('шаги после переполнения в разметку не попадают', () => {
    ticks(0, 9000)

    beginSegment({ movement: 'heel', side: 'right', reps: 5 })
    ticks(600000, 40) // человек делает движение, а кадры уже не принимаются
    endSegment()

    expect(recordedCount()).toBe(9000)
    expect(recordedSegments()).toEqual([])
  })
})
