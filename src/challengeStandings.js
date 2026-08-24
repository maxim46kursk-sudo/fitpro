import { dayScore, streamScore } from './challengeNutrition.js'

/**
 * ТАБЛИЦА ПОТОКА — КТО ГДЕ СТОИТ. Чистые функции, ни React, ни сети.
 *
 * База отдаёт сырьё (challenge_standings): по строке на участника и день —
 * лучший заход, съеденное и норма дня. Места считаются здесь, и только здесь:
 * появись вторая формула в SQL, она разошлась бы с первой на первой же правке
 * коридора, и человек увидел бы на экране одно место, а в итогах другое.
 *
 * ПРАВИЛО МЕСТА — то же, что написано человеку в правилах (экран «Как
 * определяется победитель»):
 *
 *   1) две отдельные таблицы: по очкам движения и по проценту питания, в каждой
 *      своё место;
 *   2) ИТОГОВОЕ МЕСТО — сумма двух мест: меньше сумма — выше человек. Третий в
 *      движении и первый в питании даёт 4 и обгоняет первого в движении с пятым
 *      в питании (сумма 6). Одним питанием челлендж не выиграть, и одной игрой
 *      тоже — ровно это правило и означает;
 *   3) равные суммы разводит МЕСТО В ДВИЖЕНИИ: игру камера считает сама, и
 *      подделать её нельзя, а дневник человек заполняет сам.
 *
 * Внутри каждой таблицы равенство тоже разводится, и оба правила взяты оттуда
 * же: равные очки движения — выше тот, кто прошёл больше дней целиком; равный
 * процент питания — выше тот, у кого больше дней с заполненным дневником.
 */

/** Сколько дней в потоке. Столько же, сколько в плане (motion/game/challenge.js). */
export const STREAM_DAYS = 30

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Собрать участников из плоских строк базы.
 *
 * Строки приходят «участник × день», потому что так их отдаёт SQL одним
 * запросом. Здесь они складываются в людей: очки движения — сумма лучших
 * заходов по всем дням, оценка питания — по дню каждая, чтобы средний за поток
 * считался тем же судьёй, что и на экране участника.
 */
export function collect(rows, { days = STREAM_DAYS } = {}) {
  const byNo = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const no = num(row?.participant_no)
    if (!no) continue
    if (!byNo.has(no)) {
      byNo.set(no, {
        participantNo: no,
        name: String(row?.display_name ?? '').trim() || `Участник ${no}`,
        isMe: !!row?.is_me,
        daysDone: num(row?.days_done),
        movement: 0,
        dayScores: [],
        countedDays: 0,
      })
    }
    const person = byNo.get(no)
    // is_me и days_done повторяются в каждой строке участника — берём любое
    // непустое: строк может не хватать, если человек не играл ни дня
    person.isMe = person.isMe || !!row?.is_me
    person.daysDone = Math.max(person.daysDone, num(row?.days_done))

    person.movement += num(row?.best_score)

    const scored = dayScore(
      { kcal: row?.kcal, p: row?.p, f: row?.f, c: row?.c },
      { kcal: row?.norm_kcal, p: row?.norm_p, f: row?.norm_f, c: row?.norm_c },
      num(row?.meals),
    )
    person.dayScores.push(scored)
    if (scored.counted) person.countedDays += 1
  }

  for (const person of byNo.values()) {
    // Средний процент делится на ВСЕ дни потока, а не на заполненные: иначе три
    // честных дня из тридцати выглядели бы как отличный результат.
    person.nutrition = streamScore(person.dayScores, days)
    delete person.dayScores
  }

  return [...byNo.values()]
}

/**
 * Места в одной таблице. Равные по всем ключам сравнения делят место (1, 2, 2,
 * 4), а не расходятся по алфавиту: приз в такой ситуации решается не сортировкой.
 */
function rank(list, compare) {
  const sorted = [...list].sort(compare)
  let place = 0
  return sorted.map((person, i) => {
    if (i === 0 || compare(sorted[i - 1], person) !== 0) place = i + 1
    return { person, place }
  })
}

/**
 * ИТОГОВАЯ ТАБЛИЦА ПОТОКА.
 *
 * @param {object[]} rows сырьё из challenge_standings
 * @returns {object[]} участники по местам: place, participantNo, name, isMe,
 *   movement, nutrition, movementPlace, nutritionPlace, sum
 */
export function standings(rows, { days = STREAM_DAYS } = {}) {
  const people = collect(rows, { days })
  if (!people.length) return []

  // Движение: больше очков выше; равные очки разводит число пройденных целиком
  // дней — заходы можно набрать и не доигрывая дни.
  const byMovement = rank(people, (a, b) => (b.movement - a.movement) || (b.daysDone - a.daysDone))
  // Питание: больше процент выше; равный процент разводит число дней, в которые
  // дневник вообще заполнялся.
  const byNutrition = rank(people, (a, b) => (b.nutrition - a.nutrition) || (b.countedDays - a.countedDays))

  const movePlace = new Map(byMovement.map(({ person, place }) => [person.participantNo, place]))
  const foodPlace = new Map(byNutrition.map(({ person, place }) => [person.participantNo, place]))

  const scored = people.map((person) => {
    const movementPlace = movePlace.get(person.participantNo)
    const nutritionPlace = foodPlace.get(person.participantNo)
    return {
      participantNo: person.participantNo,
      name: person.name,
      isMe: person.isMe,
      movement: person.movement,
      nutrition: person.nutrition,
      daysDone: person.daysDone,
      countedDays: person.countedDays,
      movementPlace,
      nutritionPlace,
      /** Сумма двух мест — то самое число, по которому и строится таблица. */
      sum: movementPlace + nutritionPlace,
    }
  })

  // Сумма меньше — выше; равные суммы разводит место в движении.
  const final = rank(scored, (a, b) => (a.sum - b.sum) || (a.movementPlace - b.movementPlace))
  return final.map(({ person, place }) => ({ ...person, place }))
}
