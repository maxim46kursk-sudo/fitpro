import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PENDING_NOTE,
  hasDetector,
  loadRecording,
  reportSegments,
} from '../../../tools/punch-replay.mjs'

/**
 * Чтение разметки: по размеченной записи сразу видно, что просили сделать и
 * что увидели детекторы. Ради этого и сделан пошаговый режим калибровки —
 * иначе «пять подъёмов колена, детектор увидел три, а детектор удара два»
 * приходится вылавливать глазами по таблице кадров.
 *
 * Тест берёт любую размеченную запись из recordings/: живая подхватится сама.
 */

/**
 * Движения, у которых стороны нет по самому их устройству: они делаются во всю
 * ширину тела, обеими руками или обеими ногами сразу. Список тот же, что в
 * moves.js и в SIDELESS_TYPES движка — расходиться им нельзя.
 */
const SIDELESS = new Set([
  'barrier',
  'jump',
  'bend',
  'jumpsquat',
  'jack',
  'hop',
  'wings',
  'clap',
])

const DIR = fileURLToPath(new URL('../../../recordings/', import.meta.url))
const marked = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, data: loadRecording(DIR + name) }))
  .filter((entry) => entry.data.segments?.length)

describe('размеченная запись', () => {
  it('в recordings/ есть хотя бы одна запись с разметкой', () => {
    expect(marked.length).toBeGreaterThan(0)
  })

  for (const { name, data } of marked) {
    describe(name, () => {
      const rows = reportSegments(data)
      /**
       * Сегменты движений, у которых детектора ещё нет, из проверок выпадают:
       * сравнивать не с чем. Запись под них как раз и снимается — и первая же
       * такая запись не должна красить прогон в красное.
       */
      const ready = rows.filter((row) => !row.pending)

      it('каждый сегмент несёт движение, сторону и границы', () => {
        for (const { segment } of rows) {
          expect(segment.movement).toBeTruthy()
          expect(segment.to).toBeGreaterThan(segment.from)
          if (!SIDELESS.has(segment.movement)) expect(segment.side).toBeTruthy()
        }
      })

      it('движения без детектора помечены и пропущены', () => {
        for (const row of rows.filter((r) => r.pending)) {
          expect(hasDetector(row.segment.movement)).toBe(false)
          expect(row.note).toBe(PENDING_NOTE)
        }
      })

      it('сегменты не пересекаются между собой', () => {
        const sorted = [...rows].sort((a, b) => a.segment.from - b.segment.from)
        for (let i = 1; i < sorted.length; i += 1) {
          expect(sorted[i].segment.from).toBeGreaterThanOrEqual(sorted[i - 1].segment.to)
        }
      })

      /**
       * Планка на сегмент. Идеал — ровно столько повторов, сколько просили, и
       * ноль чужих; там, где живая запись этого не даёт, стоит достигнутое
       * число с объяснением, и оно не должно ухудшаться.
       */
      const limits = data.limits ?? {}
      const limitOf = (segment) =>
        limits[`${segment.movement}${segment.side ? '/' + segment.side : ''}`] ?? {}

      it('в своём сегменте детектор видит столько повторов, сколько просили', () => {
        for (const { segment, own } of ready) {
          const allowed = limitOf(segment).own ?? segment.reps
          expect({ движение: segment.movement, сторона: segment.side, повторов: own }).toEqual({
            движение: segment.movement,
            сторона: segment.side,
            повторов: allowed,
          })
        }
      })

      it('чужие детекторы в сегмент не влезают сверх допустимого', () => {
        for (const { segment, foreign } of ready) {
          const allowed = limitOf(segment).foreign ?? 0
          expect({ движение: segment.movement, чужих: foreign.length }).toEqual({
            движение: segment.movement,
            чужих: allowed,
          })
        }
      })

      it('сторона не путается: правое движение не считается левым', () => {
        for (const { segment, wrongSide } of ready) {
          const allowed = limitOf(segment).wrongSide ?? 0
          expect({ движение: segment.movement, неТаСторона: wrongSide }).toEqual({
            движение: segment.movement,
            неТаСторона: allowed,
          })
        }
      })
    })
  }
})

/**
 * Порядок работы в проекте: сначала размеченная запись, потом пороги по ней,
 * потом детектор. Между первым и третьим шагом сегмент живёт без детектора, и
 * разбор на нём падать не должен. Мах, прыжок, выпад и захлёст этот путь уже
 * прошли, поэтому здесь стоят движения из будущего: так проверка остаётся
 * честной и после них.
 */
describe('движение без детектора ждёт настройки, а не валит разбор', () => {
  /**
   * Примеры взяты из движений, которых у нас НЕ БУДЕТ НИКОГДА: планка и
   * отжимания исключены ТЗ сознательно — человек в них горизонтален, а телефон
   * стоит вертикально, и в кадр помещается разве что макушка.
   *
   * Прежние примеры (скручивание и наклон к полу) для этого не годились: они
   * из очереди на разработку, и скручивание уже стало настоящим движением
   * записи — тест пришлось бы править снова. Исключённое ТЗ движение остаётся
   * честным примером навсегда.
   */
  const data = {
    frames: [],
    segments: [
      { movement: 'plank', side: null, reps: 5, from: 0, to: 4000 },
      { movement: 'pushup', side: null, reps: 5, from: 4000, to: 8000 },
      { movement: 'barrier', side: null, reps: 5, from: 8000, to: 12000 },
    ],
  }
  const rows = reportSegments(data)

  it('движения без детектора помечены и с ним не сравниваются', () => {
    const pending = rows.filter((row) => row.pending)

    expect(pending.map((row) => row.segment.movement)).toEqual(['plank', 'pushup'])
    for (const row of pending) {
      expect(hasDetector(row.segment.movement)).toBe(false)
      expect(row.note).toBe(PENDING_NOTE)
      // сравнивать не с чем: ни своих повторов, ни путаницы сторон
      expect(row.own).toBeNull()
      expect(row.wrongSide).toBeNull()
    }
  })

  it('движения с детектором в той же записи судятся как обычно', () => {
    const ready = rows.filter((row) => !row.pending)

    expect(ready.map((row) => row.segment.movement)).toEqual(['barrier'])
    expect(ready[0].own).toBe(0)
    expect(hasDetector('barrier')).toBe(true)
    // мах и прыжок этот этап уже прошли: у них детекторы есть
    expect(hasDetector('raise')).toBe(true)
    expect(hasDetector('jump')).toBe(true)
    // выпад и захлёст прошли его вслед за ними, по записи 13 августа
    expect(hasDetector('lunge')).toBe(true)
    expect(hasDetector('heel')).toBe(true)
    // скручивание прошло его последним, по записи calibration-crunch
    expect(hasDetector('twistknee')).toBe(true)
  })

  it('снятое с игры движение тоже не валит разбор старых записей', () => {
    /**
     * Боковая складка снята с игры: её место занято скручиванием. Записи с её
     * сегментами уже сняты и лежат в recordings/, и разбор по ним должен
     * говорить «детектора нет», а не сравнивать сегмент с пустотой и падать.
     */
    const rows = reportSegments({
      frames: [],
      segments: [{ movement: 'sidecrunch', side: 'left', reps: 5, from: 0, to: 4000 }],
    })

    expect(hasDetector('sidecrunch')).toBe(false)
    expect(rows[0].pending).toBe(true)
    expect(rows[0].note).toBe(PENDING_NOTE)
  })
})
