import { beforeEach, describe, expect, it } from 'vitest'
import { noteCounts, noteFrame, noteStage, resetStages, stageReport } from './stageMeter.js'

/**
 * Измеритель стадий. Проверяется не красота чисел, а три вещи, без которых он
 * бесполезен или вреден:
 *
 *   • МИНУТЫ РАЗДЕЛЬНО. Ради этого он и заведён: средняя за бой прячет ровно то,
 *     что ищем — стадию, выросшую втрое к седьмой минуте.
 *   • МЕДИАНА, А НЕ СРЕДНЕЕ. Один провал на разогреве не должен решать за минуту.
 *   • РАСХОД ПАМЯТИ ПОСТОЯНЕН. Кадров в минуте больше тысячи, и хранить их все,
 *     чтобы посчитать медиану, значило бы лечить тормоза измерением тормозов.
 */
describe('измеритель стадий', () => {
  beforeEach(() => resetStages(0))

  it('раскладывает время по минутам, а не в одно число', () => {
    // первая минута дешёвая, седьмая — втрое дороже: ровно та картина, ради
    // которой всё и делалось
    for (let i = 0; i < 50; i += 1) noteStage('draw', 5, 1000 + i)
    for (let i = 0; i < 50; i += 1) noteStage('draw', 15, 6 * 60000 + i)

    const { minutes } = stageReport()
    expect(minutes[0].min).toBe(0)
    expect(minutes[0].draw).toBe(5)
    expect(minutes.at(-1).min).toBe(6)
    expect(minutes.at(-1).draw).toBe(15)
  })

  it('медиана, а не среднее: один провал минуту не портит', () => {
    for (let i = 0; i < 99; i += 1) noteStage('judge', 2, i)
    noteStage('judge', 5000, 100)
    expect(stageReport().minutes[0].judge).toBe(2)
  })

  it('расход памяти не растёт с числом кадров', () => {
    // десять тысяч замеров — это несколько минут боя на быстром телефоне
    for (let i = 0; i < 10000; i += 1) noteStage('inference', 30 + (i % 3), i % 59000)
    const строка = stageReport().minutes[0]
    expect(строка.inference).toBeGreaterThanOrEqual(30)
    expect(строка.inference).toBeLessThanOrEqual(32)
    // выборка ограничена; сериализованная строка обязана оставаться короткой
    expect(JSON.stringify(stageReport()).length).toBeLessThan(2000)
  })

  it('считает кадры и живые объекты рядом со временем стадий', () => {
    noteFrame(0)
    noteFrame(1)
    noteCounts({ targets: 1, obstacles: 3, particles: 12, stars: 60, dom: 400, canvas: 2 }, 2)
    const строка = stageReport().minutes[0]
    expect(строка.frames).toBe(2)
    expect(строка.targets).toBe(1)
    expect(строка.obstacles).toBe(3)
    expect(строка.particles).toBe(12)
    expect(строка.dom).toBe(400)
    expect(строка.canvas).toBe(2)
  })

  it('пустые стадии в строку не идут — она не должна пухнуть нулями', () => {
    noteStage('grab', 4, 0)
    const строка = stageReport().minutes[0]
    expect(строка.grab).toBe(4)
    expect('draw' in строка).toBe(false)
    expect('heapMb' in строка).toBe(false)
  })

  it('до первого замера отчёта нет вовсе', () => {
    expect(stageReport()).toBeNull()
  })

  it('мусор не портит выборку', () => {
    noteStage('draw', Number.NaN, 0)
    noteStage('draw', -1, 0)
    noteStage('нет такой стадии', 5, 0)
    noteStage('draw', 7, 0)
    expect(stageReport().minutes[0].draw).toBe(7)
  })
})
