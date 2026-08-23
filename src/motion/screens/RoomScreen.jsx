import { useState } from 'react'
import { DAYS, dayRuns, progress } from '../game/challenge.js'
import { attemptsFor, challengeTotal, dayTotal, sessionResume } from '../game/day.js'
import ResumeChoice from '../components/ResumeChoice.jsx'

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
/**
 * @param {boolean} [props.guest] гость без аккаунта: у него открыт только
 *   первый день, остальные показываются замком с подписью «С аккаунтом»
 */
/**
 * @param {(tier: string, opts: {resume: object}) => void} [props.onResume]
 *   продолжить незавершённую сессию. Комната сама сессий не запускает — она
 *   отдаёт решение наверх, тому же, кто запускает их с выбора уровня.
 */
export default function RoomScreen({ day = 0, onExit, guest = false, onResume = null }) {
  /**
   * Снимок на монтирование: пока человек стоит в комнате, играть он не может,
   * а значит и меняться числам не с чего.
   */
  const [room, setRoom] = useState(() => readRoom(day, DAYS, { guest }))
  /** Открытая ячейка календаря: сводка дня или выбор по незавершённой сессии. */
  const [openDay, setOpenDay] = useState(null)

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
        {room.rows.map((row) => {
          /**
           * ЖИВАЯ СЕТКА. До этого тридцать ячеек были картинкой: человек видел
           * очки за день и не мог узнать о нём ничего больше — ни точности, ни
           * реакции, ни того, что день собран за два захода. Всё это уже
           * лежало в хранилище и никуда не показывалось.
           *
           * Нажимается ровно то, где есть что открыть: сданный день и день с
           * незавершённой сессией. Будущий и закрытый гостю остаются
           * неподвижными — кнопка, которая ничего не делает, хуже её отсутствия.
           */
          const cls = [
            'mt-room__day',
            `is-${row.state}`,
            row.openable ? 'is-openable' : '',
            openDay === row.day ? 'is-open' : '',
          ]
            .filter(Boolean)
            .join(' ')

          const common = {
            key: row.day,
            className: cls,
            'data-testid': `room-day-${row.day}`,
            'data-state': row.state,
          }

          const inner = (
            <>
              <span className="mt-room__dayNum">{row.day}</span>
              {row.state === 'locked' && <span className="mt-room__dayLock">С аккаунтом</span>}
              {row.state === 'started' && <span className="mt-room__dayLock">начата</span>}
              {row.state !== 'locked' && row.state !== 'started' && (
                <span className="mt-room__dayScore">{row.total > 0 ? row.total : ''}</span>
              )}
            </>
          )

          return row.openable ? (
            <button
              {...common}
              type="button"
              onClick={() => setOpenDay((d) => (d === row.day ? null : row.day))}
            >
              {inner}
            </button>
          ) : (
            <div {...common} {...(row.state === 'locked' ? { title: 'С аккаунтом' } : {})}>
              {inner}
            </div>
          )
        })}
      </div>

      {/**
        * СВОДКА ОТКРЫТОГО ДНЯ — под сеткой, а не поверх неё: человек только что
        * ткнул в ячейку и должен видеть, какую именно. Модалка закрыла бы
        * календарь целиком и потеряла бы эту связь.
        */}
      {openDay != null && (() => {
        const row = room.rows.find((r) => r.day === openDay)
        if (!row) return null
        if (row.state === 'started') {
          return (
            <ResumeChoice
              compact
              resume={room.resume}
              onContinue={(r) => onResume?.(r.tier, { resume: r })}
              onRestart={() => {
                setOpenDay(null)
                setRoom(readRoom(day, DAYS, { guest }))
              }}
            />
          )
        }
        return (
          <div className="mt-room__summary" data-testid="room-day-summary">
            <div className="mt-room__summaryHead">
              <span>День {row.day}</span>
              {/* «За N заходов» — только когда их больше одного: «за 1 заход»
                  это обычный случай, и называть его значит сказать пустое */}
              {row.runs > 1 && (
                <span className="mt-room__summaryRuns" data-testid="room-day-runs">
                  собран за {row.runs} захода
                </span>
              )}
            </div>
            <div className="mt-room__summaryRow">
              <Tile testid="room-day-score" value={dash(row.total)} label="очков" hint={`попыток ${row.attempts}`} />
              <Tile
                testid="room-day-accuracy"
                value={dash(row.accuracy, '%')}
                label="точность"
                hint={row.spawned > 0 ? `${row.hits} из ${row.spawned}` : 'мишеней не было'}
              />
              <Tile testid="room-day-react" value={dash(row.reactMs, ' мс')} label="реакция" hint="средняя за день" />
            </div>
          </div>
        )
      })()}

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
/**
 * @param {number} current текущий день челленджа
 * @param {number} [days] длина челленджа
 * @param {{guest?: boolean}} [options] ГОСТЬ БЕЗ АККАУНТА. Ему всегда первый
 *   день, а сданных дней у него нет вовсе — даже если в хранилище осталось
 *   что-то от заходов до появления гостевого режима. Показать ему чужой
 *   накопленный челлендж значило бы пообещать прогресс, которого он не сможет
 *   ни продолжить, ни забрать с собой.
 */
export function readRoom(current, days = DAYS, { guest = false } = {}) {
  const done = guest ? new Set() : new Set(progress().done.map((row) => row.day))
  /**
   * Снимок в хранилище один, и он знает свой день. Читаем его РАЗ и сравниваем
   * с номером — иначе тридцать вызовов подряд на каждую перерисовку сетки.
   */
  const снимок = sessionResume(guest ? 1 : current)
  const hasResume = снимок ? Number(снимок.day) : 0
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

  const открыт = guest ? 1 : current

  for (let day = 1; day <= days; day += 1) {
    const total = dayTotal(day)
    /** Те же числа, но по одному дню: их показывает сводка при нажатии. */
    let dayHits = 0
    let daySpawned = 0
    let dayReactWeighted = 0
    let dayReactHits = 0
    let dayAttempts = 0
    for (const list of Object.values(attemptsFor(day).tiers)) {
      for (const attempt of list) {
        dayAttempts += 1
        dayHits += attempt.hits ?? 0
        daySpawned += attempt.spawned ?? 0
        if ((attempt.reactMs ?? 0) > 0 && (attempt.hits ?? 0) > 0) {
          dayReactWeighted += attempt.reactMs * attempt.hits
          dayReactHits += attempt.hits
        }
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
    /**
     * СОСТОЯНИЕ ЯЧЕЙКИ — одно поле, а не четыре булевых на экране. Иначе их
     * приходится складывать в разметке, и порядок проверок в двух местах
     * разъезжается на первой же правке.
     *
     *   locked  — гостю всё, кроме первого дня: он туда не попадёт;
     *   future  — день ещё не наступил, нажимать не на что;
     *   started — начатая и не завершённая сессия, её можно продолжить;
     *   done    — сдан, открывается сводка;
     *   now     — сегодняшний, но ещё не сдан.
     */
    const locked = guest && day !== 1
    const future = !locked && day > открыт
    const started = !locked && !future && hasResume === day
    let state = 'idle'
    if (locked) state = 'locked'
    else if (future) state = 'future'
    else if (started) state = 'started'
    else if (done.has(day)) state = 'done'
    else if (day === открыт) state = 'now'

    rows.push({
      day,
      total,
      done: done.has(day),
      current: day === открыт,
      future,
      locked,
      started,
      state,
      /** Кликается всё, где есть что показать или что продолжить. */
      openable: state === 'done' || state === 'started',
      runs: guest ? 0 : dayRuns(day),
      attempts: dayAttempts,
      hits: dayHits,
      spawned: daySpawned,
      accuracy: daySpawned > 0 ? Math.round((dayHits / daySpawned) * 100) : 0,
      reactMs: dayReactHits > 0 ? Math.round(dayReactWeighted / dayReactHits) : 0,
    })
  }

  const best = rows.reduce((top, row) => (row.total > top.total ? row : top), { day: 0, total: 0 })
  for (const row of rows) {
    // пустой день — тонкий след, а не пустое место: тридцать позиций должны
    // читаться как шкала даже у того, кто сыграл один день
    row.height = best.total > 0 && row.total > 0 ? Math.max(6, (row.total / best.total) * 100) : 2
  }

  return {
    total: challengeTotal(),
    // гостю — его единственный открытый день, а не указатель из хранилища:
    // шапка «День N из 30» иначе называла бы день, которого он не увидит
    day: открыт,
    days,
    doneCount: done.size,
    hits,
    spawned,
    reactMs: reactHits > 0 ? Math.round(reactWeighted / reactHits) : 0,
    accuracy: spawned > 0 ? Math.round((hits / spawned) * 100) : 0,
    best: { day: best.day, total: best.total },
    resume: снимок,
    rows,
  }
}
