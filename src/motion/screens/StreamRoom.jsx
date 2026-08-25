import { useState } from 'react'
import { MIN_MEALS, dayScore } from '../../challengeNutrition.js'
import { standings } from '../../challengeStandings.js'
import DayMacros from '../../DayMacros.jsx'
import { DAYS, dayRuns, isDayDone, progress } from '../game/challenge.js'
import { MAX_ATTEMPTS, attemptsFor, challengeTotal, dayTotal, daySummary, sessionResume } from '../game/day.js'

/**
 * КОМНАТА УЧАСТНИКА, ПОКА ПОТОК ИДЁТ — рабочее место, а не квитанция.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. После оплаты человек видел галочку, слова «Оплата
 * прошла» и кнопку «Понятно», которая выбрасывала его на список программ.
 * Экран отвечал на вопрос «дошли ли деньги» — тот единственный вопрос, который
 * человек задаёт ровно один раз в жизни, — и молчал обо всём, ради чего он
 * платил. Начать тренировку отсюда было НЕВОЗМОЖНО: единственный вход в день
 * лежал через камеру и выбор уровня, куда ещё надо было догадаться пойти.
 *
 * ЧТО ТЕПЕРЬ. Комната — место назначения, в котором человек живёт тридцать
 * дней, и порядок блоков отвечает порядку вопросов: какой сегодня день → чем
 * заняться прямо сейчас → сколько попыток осталось → сколько набрал → как с
 * питанием → где я среди остальных → что было в прошлые дни.
 *
 * ВЫХОДА «В НИКУДА» БОЛЬШЕ НЕТ. Закрыть комнату можно только крестиком — так же,
 * как закрывают раздел. Кнопка «Понятно» под содержимым превращала место в
 * диалог: у диалога есть «прочитал и ушёл», у комнаты — нет.
 *
 * ПОЗДРАВЛЕНИЕ — ПОЛОСОЙ ВНУТРИ, ОДИН РАЗ. Оплата — событие, а не состояние: она
 * заслуживает строки в первый заход после покупки и не заслуживает отдельного
 * экрана навсегда.
 *
 * НИЧЕГО НОВОГО ЗДЕСЬ НЕ СЧИТАЕТСЯ. Очки и заходы приходят из game/day.js,
 * проценты питания — из challengeNutrition.js, место — из challengeStandings.js.
 * Появись тут вторая формула, она разошлась бы с таблицей потока на первой же
 * правке, и человек увидел бы у себя одно место, а в таблице другое.
 */

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/**
 * Дата дня потока словами: «25 августа». Считается от даты старта сложением
 * дней, а не через toLocaleDateString: раздел открывают в том числе внутри
 * Telegram на телефонах с урезанным набором локалей.
 */
function dateOfDay(startsOn, day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startsOn || ''))
  if (!m || !(day >= 1)) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + day - 1)
  const month = MONTHS[d.getUTCMonth()]
  return month ? `${d.getUTCDate()} ${month}` : null
}

/** «4-й», «1-й», «12-й» — порядковое для показа рядом с местом. */
const ordinal = (n) => `${n}-й`

const round = (v) => Math.round(Number(v) || 0)

/**
 * СОСТОЯНИЕ СЕГОДНЯШНЕГО ДНЯ ОДНИМ СЛОВОМ, а не тремя булевыми на экране.
 *
 *   idle    — не начат: ни одного захода;
 *   started — есть незавершённая сессия, её можно продолжить;
 *   partial — заходы были, день не сдан целиком (сессия не доиграна до конца);
 *   done    — день сдан;
 *   spent   — заходы кончились.
 *
 * `spent` СИЛЬНЕЕ ОСТАЛЬНЫХ и проверяется первым: три захода потрачены — играть
 * нечего, чем бы день ни кончился. Кнопка обязана погаснуть и сказать почему,
 * а не молчать серым.
 */
export function dayState({ left, used, done, resume }) {
  if (left <= 0) return 'spent'
  if (resume) return 'started'
  if (done) return 'done'
  return used > 0 ? 'partial' : 'idle'
}

/**
 * ВСЁ, ЧТО ПОКАЗЫВАЕТ КОМНАТА, — одной чистой функцией по хранилищу.
 *
 * Вынесена наружу нарочно, ровно затем же, зачем readRoom у «Моей комнаты»: у
 * человека без единого захода каждое из этих чисел — деление на ноль, и
 * проверять такое надо тестом, а не глазами на телефоне единственного
 * участника без истории.
 *
 * @param {number} today день потока, назначенный календарём
 */
export function readStreamRoom(today, { days = DAYS } = {}) {
  const summary = daySummary(today)
  const resume = sessionResume(today)
  /**
   * ПОКАЗАТЕЛИ ЗА ВЕСЬ ПОТОК, А НЕ ТОЛЬКО ОЧКИ. Очки могут стоять на месте:
   * человек берёт те же мишени и получает те же баллы. Реакция при этом уезжает
   * на двести миллисекунд, а точность — на десять процентов, и это единственные
   * два числа, по которым видно, что он вырос. Они приехали сюда из старой
   * «Моей комнаты», которая участнику больше не показывается.
   */
  let hits = 0
  let spawned = 0
  /**
   * Реакция усредняется ВЗВЕШЕННО ПО ПОПАДАНИЯМ. Простое среднее по заходам
   * приравняло бы заход с четырьмя случайными попаданиями к целой сессии из
   * пятисот: у первого реакция почти случайна, и он тянул бы общую цифру на
   * себя ровно так же, как честно отработанные двадцать минут.
   */
  let reactWeighted = 0
  let reactHits = 0
  /**
   * «Сдан» и «в нём были заходы» — разные вещи, и обе нужны. Сдан — пройден
   * целиком (completeDay); заходы могли быть и без этого, и очки за них идут в
   * зачёт наравне. В календаре прошлый день считается прожитым при любом из
   * двух, а пропущенным — только когда не было ни того, ни другого.
   */
  const doneSet = new Set(progress().done.map((row) => row.day))

  const rows = []
  for (let day = 1; day <= days; day += 1) {
    let attempts = 0
    let dayHits = 0
    let daySpawned = 0
    let dayReactWeighted = 0
    let dayReactHits = 0
    for (const list of Object.values(attemptsFor(day).tiers)) {
      for (const attempt of list) {
        attempts += 1
        dayHits += attempt.hits ?? 0
        daySpawned += attempt.spawned ?? 0
        // ноль в реакции значит «замера не было», а не «мгновенно»: заходы без
        // него в среднюю не идут вовсе, иначе они обнуляли бы её
        if ((attempt.reactMs ?? 0) > 0 && (attempt.hits ?? 0) > 0) {
          dayReactWeighted += attempt.reactMs * attempt.hits
          dayReactHits += attempt.hits
        }
      }
    }
    hits += dayHits
    spawned += daySpawned
    reactWeighted += dayReactWeighted
    reactHits += dayReactHits
    const total = dayTotal(day)
    const played = attempts > 0 || doneSet.has(day)

    /**
     * СОСТОЯНИЕ ЯЧЕЙКИ У УЧАСТНИКА СЧИТАЕТ КАЛЕНДАРЬ, а не прогресс по кнопке:
     * день назначает дата, кнопки перехода у участника нет вовсе.
     *
     *   future — ещё не наступил, под замком;
     *   now    — сегодняшний;
     *   done   — прошлый, в котором были заходы;
     *   missed — прошлый, в котором не было ничего. Он показывается НУЛЁМ, а не
     *            пустотой: ноль — это результат, который пойдёт в зачёт, и
     *            человек должен видеть цену пропуска, а не догадываться о ней.
     */
    let state = 'future'
    if (day === today) state = 'now'
    else if (day < today) state = played ? 'done' : 'missed'

    rows.push({
      day,
      total,
      state,
      attempts,
      runs: dayRuns(day),
      hits: dayHits,
      spawned: daySpawned,
      accuracy: daySpawned > 0 ? Math.round((dayHits / daySpawned) * 100) : 0,
      reactMs: dayReactHits > 0 ? Math.round(dayReactWeighted / dayReactHits) : 0,
      /** Открывается то, где есть что показать: прошлый день с заходами. */
      openable: state === 'done',
    })
  }

  const best = rows.reduce((top, row) => (row.total > top.total ? row : top), { day: 0, total: 0 })

  return {
    today,
    days,
    /** Лучший заход СЕГОДНЯШНЕГО дня — то, что пойдёт в зачёт за сегодня. */
    todayScore: summary.total,
    left: summary.left,
    used: summary.used,
    resume,
    state: dayState({
      left: summary.left,
      used: summary.used,
      done: isDayDone(today),
      resume,
    }),
    total: challengeTotal(),
    best: { day: best.day, total: best.total },
    hits,
    spawned,
    accuracy: spawned > 0 ? Math.round((hits / spawned) * 100) : 0,
    reactMs: reactHits > 0 ? Math.round(reactWeighted / reactHits) : 0,
    rows,
  }
}

/**
 * ПИТАНИЕ ЗА СЕГОДНЯ — процент и остатки до нормы.
 *
 * Раньше здесь стояло «меньше 3 приёмов». Это внутреннее правило зачёта,
 * вывернутое наружу: человек читает его как отказ и не понимает, чего от него
 * хотят. Правило от этого не меняется — меняется то, что человеку говорят:
 * не «не засчитано», а что сделать, чтобы засчиталось.
 *
 * @param {object[]} rows сырьё challenge_nutrition_facts
 * @param {number} today день потока
 */
export function todayNutrition(rows, today) {
  const list = Array.isArray(rows) ? rows : []
  const row = today >= 1 && today <= list.length ? list[today - 1] : null
  if (!row) return null

  const norms = { kcal: row.norm_kcal, p: row.norm_p, f: row.norm_f, c: row.norm_c }
  const facts = { kcal: row.kcal, p: row.p, f: row.f, c: row.c }
  const scored = dayScore(facts, norms, row.meals)
  const meals = round(row.meals)

  /**
   * ОСТАТОК ДО НОРМЫ — по каждому показателю. Перебор показывается со знаком
   * плюс и своим словом: недоел и переел — это разные ошибки, и зачёт наказывает
   * их одинаково (challengeNutrition.js), а человеку надо знать, в какую сторону
   * он промахнулся.
   */
  const rest = ['kcal', 'p', 'f', 'c'].map((key) => {
    const norm = round(norms[key])
    const fact = round(facts[key])
    return { key, norm, fact, left: norm - fact, has: norm > 0 }
  })

  return {
    score: scored.score,
    counted: scored.counted,
    meals,
    mealsLeft: Math.max(0, MIN_MEALS - meals),
    /**
     * Съеденное и норма — целыми объектами, ровно в той форме, в какой их ждёт
     * общий блок дневника. Раньше отсюда уходили только остатки, и блок,
     * который их рисовал, не мог показать «522 из 2000»: слагаемого «522» у
     * него на руках не было.
     */
    eaten: { kcal: facts.kcal, p: facts.p, c: facts.c, f: facts.f },
    norms: { kcal: norms.kcal, p: norms.p, c: norms.c, f: norms.f },
    rest,
  }
}

/**
 * @param {object} props.entry запись участника
 * @param {number} props.today день потока, назначенный календарём
 * @param {string} props.startsOn дата старта потока
 * @param {object[]} [props.nutrition] сырьё по питанию за поток
 * @param {object[]} [props.standingsRows] сырьё таблицы потока
 * @param {boolean} [props.hasNorm] заполнена ли дневная норма
 * @param {boolean} [props.syncBroken] прогресс не прочитан — заход не в зачёт
 * @param {boolean} [props.pushFailed] результат не уехал наверх после всех
 *   повторов. Комната — то место, куда человек приходит смотреть свой счёт, и
 *   именно здесь он должен узнать, что на сервере этого счёта пока нет.
 * @param {boolean} [props.greet] показать полосу поздравления (первый заход)
 * @param {() => void} [props.onGreetSeen] полосу закрыли — больше не показывать
 * @param {() => void} [props.onStartDay] начать сегодняшний день
 * @param {(tier: string, opts: object) => void} [props.onResume] продолжить сессию
 * @param {() => void} [props.onOpenDiary] открыть дневник питания
 * @param {{workouts7d?: number, lastWorkout?: string|null}} [props.app] сводка по
 *   остальному приложению. Считает её хозяин (App.jsx): раздел Motion про неё
 *   ничего не знает и знать не должен.
 * @param {() => void} [props.onOpenWorkouts] открыть тренировки
 * @param {() => void} [props.onOpenProgress] открыть прогресс
 * @param {() => void} [props.onFillNorm] завести дневную норму
 * @param {() => void} [props.onStandings] открыть таблицу потока
 * @param {() => void} [props.onRules] открыть правила потока
 * @param {() => void} [props.onExit] закрыть комнату (крестик)
 */
export default function StreamRoom({
  entry,
  today,
  days = DAYS,
  startsOn = null,
  nutrition = null,
  standingsRows = null,
  hasNorm = true,
  syncBroken = false,
  pushFailed = false,
  greet = false,
  onGreetSeen = null,
  onStartDay = null,
  onResume = null,
  onOpenDiary = null,
  app = null,
  onOpenWorkouts = null,
  onOpenProgress = null,
  onFillNorm = null,
  onStandings = null,
  onRules = null,
  onExit = null,
}) {
  /**
   * Снимок на монтирование: пока человек стоит в комнате, играть он не может, а
   * значит и меняться числам не с чего. Пересчитывается при возврате — комната
   * монтируется заново.
   */
  const [room] = useState(() => readStreamRoom(today, { days }))
  const [openDay, setOpenDay] = useState(null)

  const food = todayNutrition(nutrition, today)
  const table = standings(standingsRows || [], { days })
  const me = table.find((p) => p.isMe) || null

  const dateLabel = dateOfDay(startsOn, today)
  const dash = (value, suffix = '') => (value > 0 ? `${value}${suffix}` : '—')

  /**
   * ГЛАВНАЯ КНОПКА — одна на экран, и её текст обязан совпадать с тем, что
   * произойдёт. «Начать» там, где начинают; «Продолжить» там, где ждёт
   * незакрытая сессия; погашенная кнопка — только вместе с причиной.
   */
  const START = {
    idle: { label: `Начать день ${today}`, can: true },
    partial: { label: `Продолжить день ${today}`, can: true },
    started: { label: `Продолжить день ${today}`, can: true },
    done: { label: `Переиграть день ${today}`, can: true },
    spent: { label: 'Заходы на сегодня кончились', can: false },
  }[room.state] || { label: `Начать день ${today}`, can: true }

  const start = () => {
    if (!START.can) return
    if (room.state === 'started' && room.resume) onResume?.(room.resume.tier, { resume: room.resume })
    else onStartDay?.()
  }

  const STATE_LABEL = {
    idle: 'день не начат',
    partial: 'собран частично',
    started: 'заход не закрыт',
    done: 'день сдан',
    spent: 'заходы кончились',
  }

  return (
    <div className="mt-screen mt-ch mt-ch--stream" data-testid="challenge-screen">
      <div className="mt-stream" data-testid="stream-room">

        {/**
          * ПОЗДРАВЛЕНИЕ — ПОЛОСОЙ И ОДИН РАЗ. Оплата прошла — это новость
          * первого захода, а не заголовок комнаты на тридцать дней.
          */}
        {greet && (
          <div className="mt-stream__greet" data-testid="stream-greet">
            <span>
              Оплата прошла — ты в потоке под номером <b>{entry?.participant_no}</b>. Это твоя
              комната: отсюда начинается каждый день.
            </span>
            <button
              type="button"
              className="mt-stream__greetX"
              data-testid="stream-greet-close"
              aria-label="Закрыть"
              onClick={() => onGreetSeen?.()}
            >
              ✕
            </button>
          </div>
        )}

        {/* ═══ 1. КАКОЙ СЕГОДНЯ ДЕНЬ ═══ */}
        <div className="mt-stream__head">
          <div className="mt-stream__day" data-testid="stream-day">
            День {today} из {days}
          </div>
          <div className="mt-stream__date" data-testid="stream-date">
            {dateLabel ? `${dateLabel} · участник № ${entry?.participant_no}` : `участник № ${entry?.participant_no}`}
          </div>
          <div className={`mt-stream__state is-${room.state}`} data-testid="stream-state">
            {STATE_LABEL[room.state]}
          </div>
        </div>

        {/**
          * ЗАХОД НЕ В ЗАЧЁТ — ДО КНОПКИ, А НЕ ПОСЛЕ ТРЕНИРОВКИ. Сказать это в
          * отчёте значило бы отнять двадцать минут работы задним числом.
          */}
        {syncBroken && (
          <div className="mt-stream__warn" data-testid="stream-unscored">
            Прогресс не загрузился — <b>заход в зачёт сейчас не пойдёт</b>. Потренироваться
            можно, но в таблицу потока он не попадёт.
          </div>
        )}

        {/**
          * РЕЗУЛЬТАТ НЕ УЕХАЛ — и молчать об этом нельзя: человек смотрит на
          * свой счёт и считает, что судья видит то же самое. Не видит. Потерян
          * результат при этом не будет — он лежит на устройстве и уедет сам,
          * как только появится связь, — но знать разницу человек обязан.
          */}
        {pushFailed && !syncBroken && (
          <div className="mt-stream__warn" data-testid="stream-unsent">
            Результат не отправлен — отправим сами, как только появится связь.
          </div>
        )}

        {/* ═══ 2. ГЛАВНАЯ КНОПКА ═══ */}
        <button
          type="button"
          className={`mt-stream__start ${START.can ? '' : 'is-off'}`}
          data-testid="stream-start"
          disabled={!START.can}
          onClick={start}
        >
          {START.label}
        </button>
        {!START.can && (
          <div className="mt-stream__why" data-testid="stream-start-why">
            Три захода на день, все три сегодня потрачены. В зачёт пошёл лучший —
            {' '}<b>{room.todayScore}</b> очков. Следующий день откроется завтра.
          </div>
        )}

        {/* ═══ 3. ЗАХОДЫ ═══ */}
        <div className="mt-stream__runs" data-testid="stream-runs">
          Осталось заходов: <b>{room.left}</b> из {MAX_ATTEMPTS}
        </div>

        {/* ═══ 4. ОЧКИ ═══ */}
        <div className="mt-stream__tiles">
          <Tile testid="stream-today-score" value={dash(room.todayScore)} label="за сегодня" hint="лучший заход дня" />
          <Tile testid="stream-total" value={dash(room.total)} label="за поток" hint="сумма лучших по дням" />
          <Tile
            testid="stream-best"
            value={dash(room.best.total)}
            label="лучший день"
            hint={room.best.total > 0 ? `день ${room.best.day}` : 'ещё впереди'}
          />
        </div>

        {/**
          * РЕАКЦИЯ И ТОЧНОСТЬ — вторым рядом, и это не украшение. Очки за месяц
          * могут стоять на месте: человек берёт те же мишени и получает те же
          * баллы. Эти два числа — единственное, по чему видно, что он вырос.
          *
          * Приехали из старой «Моей комнаты»: участнику она больше не
          * показывается (его комната одна), и потерять вместе с ней показатели
          * значило бы отнять у него ответ на «а меняюсь ли я вообще».
          */}
        <div className="mt-stream__tiles">
          <Tile
            testid="stream-react"
            value={dash(room.reactMs, ' мс')}
            label="реакция"
            hint="средняя по всем попаданиям"
          />
          <Tile
            testid="stream-accuracy"
            value={dash(room.accuracy, '%')}
            label="точность"
            hint={room.spawned > 0 ? `${room.hits} из ${room.spawned}` : 'мишеней ещё не было'}
          />
          {/* «из 0 прошедших» в первый день читается как поломка, а не как
              «прошедших ещё не было» — поэтому в первый день говорим словами */}
          <Tile
            testid="stream-days-done"
            value={room.rows.filter((r) => r.state === 'done').length || '—'}
            label="дней сыграно"
            hint={room.today > 1 ? `из ${room.today - 1} прошедших` : 'поток только начался'}
          />
        </div>

        {/* ═══ 5. ПИТАНИЕ ЗА СЕГОДНЯ ═══ */}
        <section className="mt-stream__card" data-testid="stream-nutrition">
          <div className="mt-stream__cardHead">
            <span className="mt-stream__cardTitle">Питание сегодня</span>
            {hasNorm && food && (
              <b className="mt-stream__pct" data-testid="stream-nutri-pct">
                {food.counted ? `${Math.round(food.score)}%` : '—'}
              </b>
            )}
          </div>

          {!hasNorm ? (
            <>
              <p className="mt-stream__cardP">
                Норма ещё не посчитана, а питание — половина зачёта. Заполни данные о себе:
                рост, вес, цель — остальное приложение посчитает само.
              </p>
              <button type="button" className="mt-stream__act" data-testid="stream-fill-norm" onClick={() => onFillNorm?.()}>
                Заполнить данные о себе
              </button>
            </>
          ) : !food ? (
            <p className="mt-stream__cardP" data-testid="stream-nutri-wait">Смотрю дневник…</p>
          ) : (
            <>
              {/**
                * СЪЕДЕНО ПРОТИВ НОРМЫ — ТОТ ЖЕ БЛОК, ЧТО В ДНЕВНИКЕ
                * (src/DayMacros.jsx), а не своя картинка тех же данных.
                *
                * Здесь стояли четыре плитки «осталось»: человек видел, сколько
                * ему ЕЩЁ надо, и не видел, сколько уже съел — ноль и две тысячи
                * выглядели одинаково. Понять по такому блоку, идёшь ты в норму
                * или нет, было нельзя.
                *
                * ЗАПОЛНЕННОСТЬ ШКАЛЫ — НЕ ПРОЦЕНТ ЗАЧЁТА. Шкала говорит «сколько
                * съедено от нормы», а число справа сверху — сколько за день
                * начислено (challengeNutrition.js, со своим коридором и порогом
                * приёмов). Совпадать они не обязаны и не должны.
                */}
              <DayMacros totals={food.eaten} goals={food.norms} testId="stream-macros" />

              {!food.counted && (
                <p className="mt-stream__cardP" data-testid="stream-nutri-todo">
                  Запиши приёмы пищи — засчитываем от {MIN_MEALS}.
                  {food.mealsLeft > 0 && <> Сегодня записано {food.meals}, осталось {food.mealsLeft}.</>}
                </p>
              )}
              <button type="button" className="mt-stream__act" data-testid="stream-diary" onClick={() => onOpenDiary?.()}>
                Открыть дневник
              </button>
            </>
          )}
        </section>

        {/* ═══ 6. МЕСТО В ПОТОКЕ ═══ */}
        <section className="mt-stream__card" data-testid="stream-place">
          <div className="mt-stream__cardHead">
            <span className="mt-stream__cardTitle">Место в потоке</span>
            <b className="mt-stream__pct" data-testid="stream-place-value">
              {me ? `${ordinal(me.place)} из ${table.length}` : '—'}
            </b>
          </div>
          {me ? (
            <p className="mt-stream__cardP">
              Движение — {ordinal(me.movementPlace)}, питание — {ordinal(me.nutritionPlace)}.
              Место в потоке складывается из двух.
            </p>
          ) : (
            <p className="mt-stream__cardP">Таблица соберётся, как только пойдут первые заходы.</p>
          )}
          {onStandings && (
            <button type="button" className="mt-stream__act" data-testid="stream-standings" onClick={onStandings}>
              Таблица потока
            </button>
          )}
        </section>

        {/**
          * ═══ ОСТАЛЬНОЕ ПРИЛОЖЕНИЕ ═══
          *
          * Комната задумана как единственное место, куда участник заходит
          * каждый день. Значит из неё должно быть видно и то, что живёт за её
          * пределами: тренировки и прогресс. Без этого человек всё равно
          * возвращался бы на главную — и терял бы комнату из виду.
          *
          * Числа сюда приносит хозяин приложения (App.jsx). Считать их здесь
          * нельзя: раздел Motion не знает ни про тренировки FitPro, ни про его
          * базу, и лезть туда значило бы завести вторую правду о них.
          */}
        {(onOpenWorkouts || onOpenProgress) && (
          <section className="mt-stream__card" data-testid="stream-app">
            <div className="mt-stream__cardHead">
              <span className="mt-stream__cardTitle">Остальное приложение</span>
            </div>
            <p className="mt-stream__cardP">
              {app?.workouts7d > 0
                ? `Тренировок за неделю: ${app.workouts7d}.`
                : 'Тренировок за неделю пока нет.'}
              {app?.lastWorkout ? ` Последняя — ${app.lastWorkout}.` : ''}
            </p>
            {onOpenWorkouts && (
              <button type="button" className="mt-stream__act" data-testid="stream-workouts" onClick={onOpenWorkouts}>
                Тренировки
              </button>
            )}
            {onOpenProgress && (
              <button type="button" className="mt-stream__act" data-testid="stream-progress" onClick={onOpenProgress}>
                Мой прогресс
              </button>
            )}
          </section>
        )}

        {/* ═══ 7. КАЛЕНДАРЬ ═══ */}
        <div className="mt-stream__days" data-testid="stream-days">
          {room.rows.map((row) => {
            const cls = ['mt-stream__cell', `is-${row.state}`, openDay === row.day ? 'is-open' : ''].filter(Boolean).join(' ')
            const inner = (
              <>
                <span className="mt-stream__cellNum">{row.day}</span>
                <span className="mt-stream__cellScore">
                  {row.state === 'future' ? '🔒' : row.state === 'now' ? '·' : row.total}
                </span>
              </>
            )
            const common = { className: cls, 'data-testid': `stream-cell-${row.day}`, 'data-state': row.state }
            return row.openable ? (
              <button
                key={row.day}
                {...common}
                type="button"
                onClick={() => setOpenDay((d) => (d === row.day ? null : row.day))}
              >
                {inner}
              </button>
            ) : (
              <div key={row.day} {...common}>{inner}</div>
            )
          })}
        </div>

        {/**
          * СВОДКА ОТКРЫТОГО ДНЯ — под сеткой, а не поверх: человек только что
          * ткнул в ячейку и должен видеть, в какую именно.
          */}
        {openDay != null && (() => {
          const row = room.rows.find((r) => r.day === openDay)
          if (!row) return null
          return (
            <div className="mt-stream__summary" data-testid="stream-day-summary">
              <div className="mt-stream__summaryHead">
                <span>День {row.day}{dateOfDay(startsOn, row.day) ? ` · ${dateOfDay(startsOn, row.day)}` : ''}</span>
                {row.runs > 1 && <span className="mt-stream__summaryRuns">собран за {row.runs} захода</span>}
              </div>
              <div className="mt-stream__tiles">
                <Tile testid="stream-day-score" value={dash(row.total)} label="очков" hint={`заходов ${row.attempts}`} />
                <Tile
                  testid="stream-day-accuracy"
                  value={dash(row.accuracy, '%')}
                  label="точность"
                  hint={row.spawned > 0 ? `${row.hits} из ${row.spawned}` : 'мишеней не было'}
                />
                <Tile testid="stream-day-react" value={dash(row.reactMs, ' мс')} label="реакция" hint="средняя за день" />
              </div>
            </div>
          )
        })()}

        <p className="mt-stream__legend">
          Пропущенный день закрывается и задним числом не открывается: в день N потока
          играется день N. Три захода на день, в зачёт идёт лучший.
        </p>

        {/* ═══ 8. ТИХАЯ ССЫЛКА НА ПРАВИЛА ═══ */}
        {onRules && (
          <button type="button" className="mt-stream__rules" data-testid="stream-rules" onClick={onRules}>
            Правила
          </button>
        )}
      </div>

      {/**
        * ПОЛОСА ПОД КРЕСТИКОМ. Комната длинная и прокручивается под ним; без
        * этой полосы текст уезжал бы под крестик половиной буквы, а не исчезал.
        * Та же полоса и по той же причине стоит на странице челленджа.
        */}
      <div className="mt-ch__top" aria-hidden="true" />

      {/**
        * ЕДИНСТВЕННЫЙ ВЫХОД — КРЕСТИК. Кнопки «Понятно» здесь нет и быть не
        * может: она превращала место назначения в диалог и высаживала человека
        * на список программ, то есть уводила ровно оттуда, куда он пришёл.
        */}
      <button className="mt-corner mt-corner--left mt-ch__close" onClick={onExit} aria-label="Закрыть">✕</button>
    </div>
  )
}

function Tile({ testid, value, label, hint }) {
  return (
    <div className="mt-stream__tile" data-testid={testid}>
      <div className="mt-stream__tileValue">{value}</div>
      <div className="mt-stream__tileLabel">{label}</div>
      <div className="mt-stream__tileHint">{hint}</div>
    </div>
  )
}
