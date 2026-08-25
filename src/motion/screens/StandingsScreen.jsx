import { useEffect, useRef, useState } from 'react'
import { standings } from '../../challengeStandings.js'
import { streamPhase } from '../game/challenge.js'
import { MIN_MEALS } from '../../challengeNutrition.js'

/**
 * ТАБЛИЦА ПОТОКА — где я среди остальных.
 *
 * Ради неё поток и идёт у всех в один день: сравнение честное только тогда,
 * когда у всех одинаковые дни, одинаковая усталость и одинаковый календарь.
 *
 * ЧТО ПОКАЗЫВАЕМ И ПОЧЕМУ ИМЕННО ЭТО. Место, номер участника, имя, очки
 * движения, процент питания и сумма мест — то есть все слагаемые итога рядом с
 * самим итогом. Человек, увидевший себя четвёртым, обязан тут же понять,
 * ЧЕМ он четвёртый: провалом в еде или отставанием в игре. Иначе таблица
 * сообщает приговор без причины.
 *
 * СВОЯ СТРОКА ВИДНА ВСЕГДА. Она подсвечена, а если уехала за экран — прилипает
 * сверху или снизу, смотря в какую сторону уехала. В таблице на сорок человек
 * своё место ищут первым, и заставлять человека прокручивать её ради этого —
 * значит заставлять его листать чужие фамилии.
 *
 * СЧИТАЕТ НЕ ЭКРАН. Места и проценты приходят из src/challengeStandings.js по
 * сырью из базы; здесь только разметка. Один судья на приложение, тесты и
 * будущие итоги.
 */

/**
 * @param {object[]} [props.rows] сырьё из challenge_standings
 * @param {boolean} [props.loading] ещё читаем
 * @param {string} [props.startsOn] дата старта потока (YYYY-MM-DD)
 * @param {string} [props.title] имя потока для шапки
 * @param {() => void} [props.onExit] закрыть таблицу
 */
export default function StandingsScreen({
  rows = null,
  loading = false,
  startsOn = null,
  title = '',
  onExit = null,
}) {
  const table = standings(rows || [])
  const started = hasStarted(startsOn)
  /** Поток кончился — таблица окончательная, и это надо сказать вслух. */
  const frozen = streamPhase(startsOn) === 'over'

  /**
   * ГДЕ СЕЙЧАС СВОЯ СТРОКА — выше экрана, ниже или на нём. Считаем наблюдателем,
   * а не на прокрутке: обработчик scroll на длинном списке дёргается по кадру,
   * а IntersectionObserver будит нас ровно на пересечении границы.
   */
  const meRef = useRef(null)
  const scrollRef = useRef(null)
  const [meAway, setMeAway] = useState(null)

  useEffect(() => {
    const el = meRef.current
    const root = scrollRef.current
    if (!el || !root || typeof IntersectionObserver !== 'function') return undefined
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) return setMeAway(null)
        const above = entry.boundingClientRect.top < entry.rootBounds?.top
        setMeAway(above ? 'up' : 'down')
      },
      { root, threshold: 0.6 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [table.length])

  const me = table.find((r) => r.isMe) || null

  return (
    <div className="mt-screen mt-st" data-testid="standings-screen">
      <div className="mt-st__head">
        <div className="mt-st__title">{title || 'Таблица потока'}</div>
        <div className="mt-st__sub">
          {!started
            ? 'Поток ещё не начался'
            : frozen
              ? `${table.length} ${plural(table.length)} · поток завершён, итог окончательный`
              : `${table.length} ${plural(table.length)}`}
        </div>
      </div>

      {loading && <div className="mt-st__empty" data-testid="standings-loading">Собираю таблицу…</div>}

      {/**
       * ДО СТАРТА ТАБЛИЦЫ НЕТ, и врать нулями нельзя: список из сорока строк с
       * нулями читается как «все играли и все провалились», а не как «ещё не
       * начали». Говорим прямо.
       */}
      {!loading && !started && (
        <div className="mt-st__empty" data-testid="standings-not-started">
          {startsOn
            ? `Таблица появится в день старта — ${formatDate(startsOn)}. Пока в ней нечего сравнивать: дни у всех впереди.`
            : 'Дата старта будет объявлена. Таблица появится в первый день потока.'}
        </div>
      )}

      {!loading && started && !table.length && (
        <div className="mt-st__empty" data-testid="standings-empty">
          В потоке пока никого. Как только участники появятся, они будут здесь.
        </div>
      )}

      {!loading && started && table.length > 0 && (
        <>
          <div className="mt-st__cols">
            <span>Место</span>
            <span>Участник</span>
            <span>Движение</span>
            <span>Питание</span>
            <span>Сумма</span>
          </div>

          {/* Своя строка уехала ВВЕРХ — прилипает сверху. */}
          {me && meAway === 'up' && <Row row={me} pinned testId="standings-pinned-top" />}

          <div className="mt-st__list" ref={scrollRef} data-testid="standings-list">
            {table.map((row) => (
              <Row key={row.participantNo} row={row} rowRef={row.isMe ? meRef : null} />
            ))}
          </div>

          {/* Уехала ВНИЗ — прилипает снизу. */}
          {me && meAway === 'down' && <Row row={me} pinned testId="standings-pinned-bottom" />}

          {/**
            * ОТЧЕГО В ПИТАНИИ НОЛЬ. Владелец увидел 0% при заполненном за день
            * дневнике и решил, что таблица врёт. Она не врала: все три записи
            * лежали в одном завтраке, а день засчитывается от {MIN_MEALS}
            * РАЗНЫХ приёмов — иначе одна строка «торт, 2400 ккал», случайно
            * попавшая в норму, давала бы сто баллов.
            *
            * Правило было, объяснения не было. Экран, который показывает
            * человеку ноль и молчит о причине, читается как поломка — и в
            * таблице, по которой делят деньги, это недопустимо.
            */}
          <p className="mt-st__note" data-testid="standings-note">
            Питание за день засчитывается от {MIN_MEALS} разных приёмов пищи — иначе ноль,
            даже если записи есть. Дни до появления твоей нормы тоже считаются нулём.
          </p>
        </>
      )}

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Назад">✕</button>
    </div>
  )
}

/**
 * Строка таблицы. Своя — подсвечена и подписана «ты».
 *
 * rowRef, а не ref: приклеенная копия своей строки не должна перехватывать
 * наблюдателя у настоящей — иначе он следил бы за тем, что и так на экране.
 */
function Row({ row, pinned = false, rowRef = null, testId = null }) {
  return (
    <div
      ref={rowRef}
      className={`mt-st__row ${row.isMe ? 'is-me' : ''} ${pinned ? 'is-pinned' : ''}`}
      data-testid={testId || (row.isMe ? 'standings-me' : `standings-row-${row.participantNo}`)}
    >
      <div className="mt-st__place">{row.place}</div>
      <div className="mt-st__who">
        <div className="mt-st__name">{row.isMe ? 'Ты' : row.name}</div>
        <div className="mt-st__no">№ {row.participantNo}</div>
      </div>
      <div className="mt-st__v">{format(row.movement)}</div>
      <div className="mt-st__v">{Math.round(row.nutrition)}%</div>
      <div className="mt-st__sum">{row.sum}</div>
    </div>
  )
}

/** Разряды неразрывным пробелом: «128 400» не должно ломаться пополам. */
const NBSP = String.fromCharCode(160)
const format = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/\s/g, NBSP)

const plural = (n) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'участник'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'участника'
  return 'участников'
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function formatDate(value) {
  const d = parseDate(value)
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : ''
}

/**
 * Начался ли поток. Даты нет — считаем, что нет: сравнивать нечего.
 *
 * Черта та же, что и у самих дней потока, — полночь по Москве (game/challenge.js).
 * Второй способ считать сутки развёл бы таблицу с игрой на несколько часов.
 */
const hasStarted = (startsOn) => streamPhase(startsOn) !== 'unknown' && streamPhase(startsOn) !== 'before'
