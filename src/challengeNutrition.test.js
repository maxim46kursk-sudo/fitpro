import { describe, expect, it } from 'vitest'
import { CORRIDOR, FALLOFF, MIN_ENTRIES, MIN_MEALS, accuracy, dayScore, streamScore, whatIsMissing } from './challengeNutrition.js'

/**
 * АРИФМЕТИКА ВТОРОГО ЗАЧЁТА. Половина места в челлендже считается этими
 * функциями, поэтому проверяются не «работает ли», а границы: коридор с ОБЕИХ
 * сторон (недоел — тот же промах, что переел), точки падения шкалы, ноль за
 * незаполненный день и разница между «нормы нет» и «промахнулся».
 */

describe('accuracy: попадание в норму', () => {
  it('точное попадание — сто', () => {
    expect(accuracy(2000, 2000)).toBe(100)
  })

  it('коридор работает в обе стороны', () => {
    // недоел и переел на те же 10% — промах одинаковый: голодание тут не
    // добродетель, а такой же промах мимо нормы
    expect(accuracy(1800, 2000)).toBe(100)
    expect(accuracy(2200, 2000)).toBe(100)
    // ровно на границе коридора — ещё сто
    expect(CORRIDOR).toBe(10)
  })

  it('промах 20% — 80 баллов, 30% — 60', () => {
    expect(accuracy(2400, 2000)).toBe(80)
    expect(accuracy(1600, 2000)).toBe(80)
    expect(accuracy(2600, 2000)).toBe(60)
    expect(accuracy(1400, 2000)).toBe(60)
  })

  it('промах 60% и больше — ноль, ниже нуля не уходит', () => {
    expect(accuracy(3200, 2000)).toBe(0)
    expect(accuracy(800, 2000)).toBe(0)
    // вдвое больше нормы и совсем ничего — оба ноль, а не минус
    expect(accuracy(6000, 2000)).toBe(0)
    expect(accuracy(0, 2000)).toBe(0)
  })

  it('шкала падает ровно по FALLOFF за процент сверх коридора', () => {
    expect(FALLOFF).toBe(2)
    // 25% промаха: 100 − (25 − 10) × 2 = 70
    expect(accuracy(2500, 2000)).toBe(70)
  })

  it('нормы нет — null, а не ноль', () => {
    // «мерить нечем» и «промахнулся» — разные вещи, и складывать их нельзя
    for (const norm of [0, null, undefined, NaN, -100, 'нет']) {
      expect(accuracy(120, norm)).toBe(null)
    }
  })

  it('факта нет — это ноль съеденного, а не отсутствие мерки', () => {
    expect(accuracy(null, 2000)).toBe(0)
    expect(accuracy(undefined, 2000)).toBe(0)
  })
})

describe('dayScore: оценка дня', () => {
  const NORM = { kcal: 2000, p: 120, c: 220, f: 65 }

  it('всё в коридоре — сотня и день засчитан', () => {
    const day = dayScore({ kcal: 2050, p: 118, c: 210, f: 62 }, NORM, 4)
    expect(day.score).toBe(100)
    expect(day.counted).toBe(true)
    expect(day.parts.kcal).toBe(100)
  })

  it('среднее по четырём показателям, а не по худшему', () => {
    // 100, 100, 100 и 80 → 95: один промах не обнуляет день целиком
    const day = dayScore({ kcal: 2000, p: 120, c: 220, f: 78 }, NORM, 3)
    expect(day.score).toBe(95)
    expect(day.parts.f).toBe(80)
  })

  /**
   * ПОРОГ ДНЯ СМЯГЧЁН, И ЭТО ПРАВИЛО, ПО КОТОРОМУ ДЕЛЯТ ДЕНЬГИ.
   *
   * Было: записи в трёх РАЗНЫХ приёмах. Оно било по честному случаю — завтрак из
   * трёх продуктов давал за день ноль. Стало: не меньше трёх ЗАПИСЕЙ и не меньше
   * чем в двух приёмах. Дверь, ради которой порог заводили, осталась закрытой:
   * одной строкой «торт, 2400 ккал» не пройти.
   */
  const ЕДА = { kcal: 2000, p: 120, c: 220, f: 65 }

  it('одна строка «торт» — не день', () => {
    const day = dayScore(ЕДА, NORM, 1, 1)
    expect(day.counted).toBe(false)
    expect(day.score).toBe(0)
    // при этом сами показатели посчитаны — видно, ПОЧЕМУ день не засчитан
    expect(day.parts.kcal).toBe(100)
  })

  it('завтрак из трёх продуктов — всё ещё не день: приём один', () => {
    // три записи есть, а приём один — второго не хватает
    expect(dayScore(ЕДА, NORM, 1, 3).counted).toBe(false)
  })

  it('три записи в двух приёмах — день считается', () => {
    // ровно тот случай, ради которого правило и меняли
    expect(MIN_ENTRIES).toBe(3)
    expect(MIN_MEALS).toBe(2)
    expect(dayScore(ЕДА, NORM, 2, 3).counted).toBe(true)
  })

  it('две записи в двух приёмах — мало: записей меньше трёх', () => {
    expect(dayScore(ЕДА, NORM, 2, 2).counted).toBe(false)
  })

  it('много записей, но один приём — по-прежнему не день', () => {
    expect(dayScore(ЕДА, NORM, 1, 9).counted).toBe(false)
  })

  it('сырьё без числа записей судится по-старому, по приёмам', () => {
    // база могла не успеть отдать колонку entries; молча обнулять людям дни
    // из-за недостающего поля нельзя — это деньги
    expect(dayScore(ЕДА, NORM, 3).counted).toBe(true)
    expect(dayScore(ЕДА, NORM, 2).counted).toBe(false)
  })

  it('чего не хватает — считает судья, а не экран', () => {
    expect(whatIsMissing(2, 3)).toBe(null)
    expect(whatIsMissing(1, 3)).toEqual({ записей: 0, приёмов: 1 })
    expect(whatIsMissing(2, 1)).toEqual({ записей: 2, приёмов: 0 })
    expect(whatIsMissing(1, 1)).toEqual({ записей: 2, приёмов: 1 })
  })

  it('незаданная норма не портит среднее', () => {
    // человек не заполнил данные по жирам: считаем по трём, а не даём ноль за
    // то, чего не мерили
    const day = dayScore({ kcal: 2000, p: 120, c: 220, f: 500 }, { ...NORM, f: 0 }, 4)
    expect(day.parts.f).toBe(null)
    expect(day.score).toBe(100)
    expect(day.counted).toBe(true)
  })

  it('норм нет вовсе — день не считается', () => {
    const day = dayScore({ kcal: 2000, p: 120, c: 220, f: 65 }, {}, 4)
    expect(day.counted).toBe(false)
    expect(day.score).toBe(0)
  })
})

describe('streamScore: итог за поток', () => {
  it('все тридцать дней по сотне — сотня', () => {
    expect(streamScore(Array(30).fill(100), 30)).toBe(100)
  })

  it('пропущенные дни считаются нулями, а не выбрасываются', () => {
    // три дня по сотне из тридцати — это десять процентов, а не сто:
    // незаполненный дневник обязан стоить дорого
    expect(streamScore([100, 100, 100], 30)).toBe(10)
  })

  it('принимает и числа, и результат dayScore', () => {
    const days = [{ score: 100 }, { score: 50 }, 0, { score: 0, counted: false }]
    expect(streamScore(days, 4)).toBe(37.5)
  })

  it('пустой поток — ноль без деления на ноль', () => {
    expect(streamScore([], 0)).toBe(0)
    expect(streamScore([100], 0)).toBe(0)
    expect(Number.isNaN(streamScore([], 0))).toBe(false)
  })

  it('дней нет вовсе — ноль за весь поток', () => {
    expect(streamScore([], 30)).toBe(0)
    expect(streamScore(null, 30)).toBe(0)
  })

  it('лишние дни сверх потока не накручивают счёт', () => {
    // день переиграли, данные приехали дважды — считаем ровно тридцать
    expect(streamScore(Array(40).fill(100), 30)).toBe(100)
  })

  it('значение вне шкалы прижимается к ней', () => {
    expect(streamScore([200, 200], 2)).toBe(100)
    expect(streamScore([-50, 100], 2)).toBe(50)
  })
})
