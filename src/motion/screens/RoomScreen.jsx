import { useState } from 'react'
import { DAYS, progress } from '../game/challenge.js'
import { attemptsFor, challengeTotal, dayTotal } from '../game/day.js'

/**
 * МОЯ КОМНАТА — личный кабинет участника челленджа.
 *
 * Зачем понадобилась. Вся жизнь человека в игре до сих пор умещалась в один
 * экран: сегодняшний день и три уровня. Он не мог увидеть ни того, что уже
 * сделал, ни того, что стал быстрее, — а челлендж длится тридцать дней, и
 * держаться в нём человека заставляет именно накопленное. Тренировка без
 * видимой истории читается как «сегодня опять с нуля».
 *
 * ПОКАЗАТЕЛИ, А НЕ ТОЛЬКО ОЧКИ. Очки за месяц могут стоять на месте: человек
 * берёт те же мишени и получает те же баллы. Реакция при этом уезжает на двести
 * миллисекунд, а точность — на десять процентов, и это единственные два числа,
 * по которым видно, что он вырос. Ради них статистика попыток и заводилась.
 *
 * ЭКРАН НИЧЕГО НЕ СЧИТАЕТ САМ — считает readRoom ниже, чистой функцией по
 * хранилищу. Разница не косметическая: у человека, который ещё не играл, всё
 * это делится на ноль, и проверять такое надо там, где можно, а не глазами на
 * телефоне единственного участника без истории.
 */
export default function RoomScreen({ day = 0, onExit }) {
  /**
   * Снимок на монтирование: пока человек стоит в комнате, играть он не может,
   * а значит и меняться числам не с чего.
   */
  const [room] = useState(() => readRoom(day))

  const dash = (value, suffix = '') => (value > 0 ? `${value}${suffix}` : '—')

  return (
    <div className="mt-screen mt-screen--room" data-testid="room-screen">
      <div className="mt-rest__veil" aria-hidden="true" />

      {/* Счёт челленджа крупнее всего: это и есть ответ на «сколько я уже
          сделал», ради которого сюда заходят */}
      <div className="mt-room__head">
        <div className="mt-room__total" data-testid="room-total">
          {room.total}
        </div>
        <div className="mt-room__totalLabel">очков за челлендж</div>
        <div className="mt-room__where" data-testid="room-where">
          День {room.day} из {room.days} · сдано {room.doneCount}
        </div>
      </div>

      <div className="mt-room__tiles">
        <Tile
          testid="room-react"
          value={dash(room.reactMs, ' мс')}
          label="реакция"
          hint="средняя по всем попаданиям"
        />
        <Tile
          testid="room-accuracy"
          value={dash(room.accuracy, '%')}
          label="точность"
          hint={room.spawned > 0 ? `${room.hits} из ${room.spawned}` : 'мишеней ещё не было'}
        />
        <Tile
          testid="room-best"
          value={dash(room.best.total)}
          label="лучший день"
          hint={room.best.total > 0 ? `день ${room.best.day}` : 'ещё впереди'}
        />
      </div>

      {/**
       * ДИНАМИКА. Тридцать столбиков — это форма всего челленджа одним взглядом:
       * где человек прибавлял, где просел и как выглядят разгрузочные дни.
       * Высота считается от ЛУЧШЕГО дня, а не от максимума шкалы: абсолютные
       * очки зависят от уровня, и рядом с профи новичок видел бы у себя
       * тридцать одинаковых точек у самого пола.
       */}
      <div className="mt-room__chart" data-testid="room-chart">
        {room.rows.map((row) => (
          <div
            key={row.day}
            className={`mt-room__bar ${row.current ? 'is-now' : ''} ${row.total > 0 ? '' : 'is-empty'}`}
            style={{ height: `${row.height}%` }}
            data-testid={`room-bar-${row.day}`}
            title={`день ${row.day}: ${row.total}`}
          />
        ))}
      </div>

      {/**
       * КАЛЕНДАРЬ. Столбики отвечают на «как шло», ячейки — на «что уже
       * позади»: сданные дни с очками, сегодняшний помечен, будущие приглушены.
       *
       * Разгрузочные дни ничем не отмечены и отмечаться не должны: расписание
       * нагрузок — внутренняя кухня плана, а не то, что участник обязан знать.
       * Названная разгрузка становится разрешением: человек, увидевший её в
       * календаре, приходит в этот день вполсилы, и день перестаёт работать.
       * План при этом делает своё молча — интенсивность и замены на месте.
       */}
      <div className="mt-room__days" data-testid="room-days">
        {room.rows.map((row) => (
          <div
            key={row.day}
            className={['mt-room__day', row.done ? 'is-done' : '', row.current ? 'is-now' : '', row.future ? 'is-future' : '']
              .filter(Boolean)
              .join(' ')}
            data-testid={`room-day-${row.day}`}
          >
            <span className="mt-room__dayNum">{row.day}</span>
            <span className="mt-room__dayScore">{row.total > 0 ? row.total : ''}</span>
          </div>
        ))}
      </div>

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Назад">
        ✕
      </button>
    </div>
  )
}

function Tile({ testid, value, label, hint }) {
  return (
    <div className="mt-room__tile" data-testid={testid}>
      <div className="mt-room__tileValue">{value}</div>
      <div className="mt-room__tileLabel">{label}</div>
      <div className="mt-room__tileHint">{hint}</div>
    </div>
  )
}

/**
 * Всё, что показывает комната, — одной чистой функцией по хранилищу.
 *
 * ВЫНЕСЕНА НАРУЖУ НАРОЧНО. У человека, который ещё ни разу не играл, каждое из
 * этих чисел — деление на ноль: средняя реакция без попаданий, точность без
 * мишеней, лучший день без дней. Такое проверяют тестом, а не глазами на
 * телефоне единственного участника без истории.
 *
 * @param {number} current текущий день челленджа
 * @param {number} [days] длина челленджа
 */
export function readRoom(current, days = DAYS) {
  const done = new Set(progress().done.map((row) => row.day))
  const rows = []
  let hits = 0
  let spawned = 0
  /**
   * Реакция усредняется ВЗВЕШЕННО ПО ПОПАДАНИЯМ. Простое среднее по попыткам
   * приравняло бы заход с четырьмя случайными попаданиями к целой сессии из
   * пятисот: у первого реакция почти случайна, и он тянул бы общую цифру на
   * себя ровно так же, как честно отработанные двадцать минут.
   */
  let reactWeighted = 0
  let reactHits = 0

  for (let day = 1; day <= days; day += 1) {
    const total = dayTotal(day)
    for (const list of Object.values(attemptsFor(day).tiers)) {
      for (const attempt of list) {
        hits += attempt.hits ?? 0
        spawned += attempt.spawned ?? 0
        // ноль в реакции значит «замера не было», а не «мгновенно»: попытки
        // без него в среднюю не идут вовсе, иначе они обнуляли бы её
        if ((attempt.reactMs ?? 0) > 0 && (attempt.hits ?? 0) > 0) {
          reactWeighted += attempt.reactMs * attempt.hits
          reactHits += attempt.hits
        }
      }
    }
    /**
     * Разгрузочных дней здесь нет и не должно быть даже полем: расписание
     * нагрузок — внутренняя кухня плана. Названная разгрузка становится
     * разрешением, а неиспользуемое поле рано или поздно попадает на экран.
     */
    rows.push({ day, total, done: done.has(day), current: day === current, future: day > current })
  }

  const best = rows.reduce((top, row) => (row.total > top.total ? row : top), { day: 0, total: 0 })
  for (const row of rows) {
    // пустой день — тонкий след, а не пустое место: тридцать позиций должны
    // читаться как шкала даже у того, кто сыграл один день
    row.height = best.total > 0 && row.total > 0 ? Math.max(6, (row.total / best.total) * 100) : 2
  }

  return {
    total: challengeTotal(),
    day: current,
    days,
    doneCount: done.size,
    hits,
    spawned,
    reactMs: reactHits > 0 ? Math.round(reactWeighted / reactHits) : 0,
    accuracy: spawned > 0 ? Math.round((hits / spawned) * 100) : 0,
    best: { day: best.day, total: best.total },
    rows,
  }
}
