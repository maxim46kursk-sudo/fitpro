import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detect, detectKnee, judgeStrikes, loadRecording } from '../../../tools/punch-replay.mjs'

/**
 * Регрессия по записи сырых точек: удар должен ловиться ровно столько раз,
 * сколько его сделали, и ни разу на приседах.
 *
 * Такой тест нужен именно этому движению. Удар правился трижды по описанию
 * «не работает» и трижды не работал: на фронтальной камере он почти не меняет
 * угол локтя, зато в приседе человек выносит вперёд обе руки, и это неотличимо
 * от удара по одной руке. Синтетические позы такого не показывают — только
 * запись целиком.
 *
 * Как добавить свою запись: снять её в приложении (диагностическая панель ->
 * «Записать сырые точки» -> 5 ударов правой, пауза, 5 левой, пауза, 2 приседа
 * -> «Скачать запись») и положить файл в recordings/. Ожидания можно указать
 * прямо в файле полем expected — иначе берётся этот же сценарий 5 + 5.
 */

const DIR = fileURLToPath(new URL('../../../recordings/', import.meta.url))
const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()

describe('удар по записи сырых точек', () => {
  it('в recordings/ есть хотя бы одна запись', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const name of files) {
    describe(name, () => {
      const data = loadRecording(DIR + name)

      // Записи из пошаговой калибровки размечены по сегментам, и их полностью
      // проверяет segments.replay.test.js — здесь их дублировать незачем.
      if (data.segments?.length) {
        it('размеченная запись проверяется отдельным тестом по сегментам', () => {
          expect(data.segments.length).toBeGreaterThan(0)
        })
        return
      }

      // Запись с разметкой из лога сессии: там известно, где были астероиды,
      // какой рукой их надо было бить и что человек делал между ними.
      if (data.expected?.strikes) {
        const verdicts = judgeStrikes(data.frames, data.expected.strikes)
        const hits = detect(data.frames)

        it('каждый астероид из лога засчитывается', () => {
          const missed = verdicts.filter((v) => !v.ok)
          expect(missed).toEqual([])
        })

        it('удар опаздывает относительно пролёта — окно это учитывает', () => {
          // именно из-за опоздания игра и засчитала тогда 4 из 12
          const late = verdicts.filter((v) => v.at > v.passAt)
          expect(late.length).toBeGreaterThan(verdicts.length / 2)
        })

        it('до начала ударов ложных срабатываний нет: приседы, шаги, наклоны', () => {
          const quiet = hits.filter(
            (h) => h.at > 20000 && h.at < (data.expected.quietUntilMs ?? 100000),
          )
          expect(quiet).toEqual([])
        })

        it('подъёмов колена столько, сколько их было на самом деле', () => {
          const knees = data.expected.knees ?? []
          expect(knees.length).toBeGreaterThan(0)

          // Человек ни разу не поднял колено: кольцо не рисовалось из-за ошибки
          // в отрисовке, на экране были только слова. Значит ни один астероид
          // колена засчитаться и не мог — проверяем именно это.
          const lifts = detectKnee(data.frames)
          const inWindows = lifts.filter((lift) =>
            knees.some((k) => Math.abs(lift.at - k.passAt) < 2000 && k.side === lift.side),
          )
          expect(inWindows).toEqual([])
          expect(data.expected.kneeClears).toBe(0)
        })

        it('присед подъёмом колена не считается', () => {
          const squats = data.expected.squats ?? []
          expect(squats.length).toBeGreaterThan(0)

          // в приседе к тазу идут обе ноги сразу — по записи разница между ними
          // там не больше 0.1, и зачёта быть не должно
          const lifts = detectKnee(data.frames)
          const nearSquats = lifts.filter((lift) =>
            squats.some((sq) => Math.abs(lift.at - sq.passAt) < 2500),
          )
          expect(nearSquats).toEqual([])
        })

        return
      }

      const expectation = data.expected ?? { punchesRight: 5, punchesLeft: 5, falseOnSquats: 0 }
      const hits = detect(data.frames)
      const bySide = {
        left: hits.filter((h) => h.side === 'left').length,
        right: hits.filter((h) => h.side === 'right').length,
      }

      it('ударов правой ровно столько, сколько сделано', () => {
        expect(bySide.right).toBe(expectation.punchesRight)
      })

      it('ударов левой ровно столько, сколько сделано', () => {
        expect(bySide.left).toBe(expectation.punchesLeft)
      })

      it('лишних срабатываний нет — в том числе на приседах', () => {
        const total = expectation.punchesRight + expectation.punchesLeft
        expect(hits.length - total).toBe(expectation.falseOnSquats ?? 0)
      })

      it('каждый удар — рывок, а не медленное вытягивание руки', () => {
        for (const hit of hits) {
          expect(hit.durationMs).toBeLessThanOrEqual(1200)
          expect(hit.toValue - hit.fromValue).toBeGreaterThan(0.2)
        }
      })
    })
  }
})
