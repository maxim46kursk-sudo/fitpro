import { describe, expect, it } from 'vitest'
import { STREAM_DAYS, collect, standings } from './challengeStandings.js'

/**
 * МЕСТО В ЧЕЛЛЕНДЖЕ — СУММА ДВУХ МЕСТ, и главная проверка здесь ровно та, что
 * человек читает в правилах: третий в движении и первый в питании обгоняет
 * первого в движении с пятым в питании. Одним питанием челлендж не выиграть, и
 * одной игрой тоже — это правило и означает.
 */

const NORM = { norm_kcal: 2000, norm_p: 120, norm_f: 65, norm_c: 220 }

/**
 * Строки сырья, как их отдаёт challenge_standings: участник × день.
 *
 * @param {object} p участник: no, name, me, daysDone
 * @param {object[]} days по дню: score (лучший заход), eat (доля от нормы), meals
 */
const rowsFor = (p, days) =>
  Array.from({ length: STREAM_DAYS }, (_, i) => {
    const d = days[i] || {}
    const share = d.eat ?? 0
    return {
      participant_no: p.no,
      display_name: p.name,
      is_me: !!p.me,
      days_done: p.daysDone ?? 0,
      day: i + 1,
      best_score: d.score ?? 0,
      kcal: 2000 * share,
      p: 120 * share,
      f: 65 * share,
      c: 220 * share,
      meals: d.meals ?? (share > 0 ? 4 : 0),
      ...NORM,
    }
  })

/** Полный день: заход на score и питание точно в норму. */
const full = (score) => ({ score, eat: 1, meals: 4 })

describe('пример из правил', () => {
  it('третий в движении и первый в питании выше первого в движении с пятым в питании', () => {
    /**
     * Аня слабее в игре, но вытянула питание; Игорь — наоборот. 3 + 1 = 4
     * меньше, чем 1 + 5 = 6, значит Аня выше. Ровно этот пример нарисован
     * человеку на странице челленджа.
     */
    const rows = [
      // Игорь: лучший в движении, худший в питании
      ...rowsFor({ no: 3, name: 'Игорь', daysDone: 30 }, Array.from({ length: 30 }, () => ({ score: 5000, eat: 0.3, meals: 4 }))),
      // Аня: третья в движении, первая в питании
      ...rowsFor({ no: 7, name: 'Аня', me: true, daysDone: 30 }, Array.from({ length: 30 }, () => full(3000))),
      // двое между ними по движению, и оба слабее Ани в питании
      ...rowsFor({ no: 11, name: 'Борис', daysDone: 28 }, Array.from({ length: 30 }, () => ({ score: 4000, eat: 0.5, meals: 4 }))),
      ...rowsFor({ no: 12, name: 'Вера', daysDone: 25 }, Array.from({ length: 30 }, () => ({ score: 2500, eat: 0.55, meals: 4 }))),
      ...rowsFor({ no: 15, name: 'Глеб', daysDone: 20 }, Array.from({ length: 30 }, () => ({ score: 1000, eat: 0.6, meals: 4 }))),
    ]

    const table = standings(rows)
    const аня = table.find((r) => r.name === 'Аня')
    const игорь = table.find((r) => r.name === 'Игорь')

    expect(аня.movementPlace).toBe(3)
    expect(аня.nutritionPlace).toBe(1)
    expect(аня.sum).toBe(4)
    expect(игорь.movementPlace).toBe(1)
    expect(игорь.nutritionPlace).toBe(5)
    expect(игорь.sum).toBe(6)

    expect(аня.place).toBe(1)
    expect(игорь.place).toBeGreaterThan(аня.place)
    // и своя строка помечена — по ней экран подсвечивает человека
    expect(аня.isMe).toBe(true)
  })
})

describe('равенство разводится, а не решается сортировкой', () => {
  it('равные суммы мест — выше тот, у кого лучше движение', () => {
    // у обоих сумма 3: у первого места 1 и 2, у второго 2 и 1
    const rows = [
      ...rowsFor({ no: 1, name: 'Сильный в игре', daysDone: 30 }, Array.from({ length: 30 }, () => ({ score: 5000, eat: 0.8, meals: 4 }))),
      ...rowsFor({ no: 2, name: 'Сильный в еде', daysDone: 30 }, Array.from({ length: 30 }, () => ({ score: 4000, eat: 1, meals: 4 }))),
    ]

    const table = standings(rows)
    expect(table[0].sum).toBe(table[1].sum)
    expect(table[0].name).toBe('Сильный в игре')
    expect(table[0].movementPlace).toBe(1)
  })

  it('равные очки движения — выше тот, кто прошёл больше дней целиком', () => {
    const rows = [
      ...rowsFor({ no: 1, name: 'Добивал дни', daysDone: 20 }, Array.from({ length: 30 }, () => ({ score: 1000, eat: 1, meals: 4 }))),
      ...rowsFor({ no: 2, name: 'Бросал на середине', daysDone: 5 }, Array.from({ length: 30 }, () => ({ score: 1000, eat: 1, meals: 4 }))),
    ]

    const table = standings(rows)
    const добивал = table.find((r) => r.name === 'Добивал дни')
    const бросал = table.find((r) => r.name === 'Бросал на середине')

    expect(добивал.movement).toBe(бросал.movement)
    expect(добивал.movementPlace).toBe(1)
    expect(бросал.movementPlace).toBe(2)
    expect(добивал.place).toBe(1)
  })

  it('полностью равные делят место, а не расходятся по алфавиту', () => {
    const same = Array.from({ length: 30 }, () => full(2000))
    const rows = [
      ...rowsFor({ no: 1, name: 'Первый', daysDone: 30 }, same),
      ...rowsFor({ no: 2, name: 'Второй', daysDone: 30 }, same),
    ]

    const table = standings(rows)
    expect(table[0].place).toBe(1)
    expect(table[1].place).toBe(1)
  })
})

describe('таблица не ломается на живых данных', () => {
  it('участник без единого захода стоит последним, а не рушит счёт', () => {
    const rows = [
      ...rowsFor({ no: 1, name: 'Играет', daysDone: 10 }, Array.from({ length: 30 }, () => full(2000))),
      // ни одного захода и ни одной записи в дневнике
      ...rowsFor({ no: 2, name: 'Молчит', daysDone: 0 }, []),
    ]

    const table = standings(rows)
    const молчит = table.find((r) => r.name === 'Молчит')

    expect(молчит.movement).toBe(0)
    expect(молчит.nutrition).toBe(0)
    expect(молчит.place).toBe(2)
    expect(Number.isNaN(молчит.sum)).toBe(false)
  })

  it('норма не снята — питание ноль, но таблица считается', () => {
    // человек оплатил мимо приложения, нормы на момент вступления не было
    const rows = rowsFor({ no: 5, name: 'Без нормы', daysDone: 3 }, Array.from({ length: 30 }, () => full(1500)))
      .map((r) => ({ ...r, norm_kcal: null, norm_p: null, norm_f: null, norm_c: null }))

    const table = standings(rows)
    expect(table[0].movement).toBe(1500 * 30)
    expect(table[0].nutrition).toBe(0)
    expect(table[0].place).toBe(1)
  })

  it('пустое сырьё — пустая таблица, а не поломка', () => {
    expect(standings([])).toEqual([])
    expect(standings(null)).toEqual([])
  })

  it('дни без записей считаются нулями: средний делится на весь поток', () => {
    // два идеальных дня из тридцати — это 7%, а не 100
    const rows = rowsFor({ no: 1, name: 'Два дня', daysDone: 2 }, [full(1000), full(1000)])
    const [me] = collect(rows)

    expect(me.movement).toBe(2000)
    expect(Math.round(me.nutrition)).toBe(7)
    expect(me.countedDays).toBe(2)
  })
})
