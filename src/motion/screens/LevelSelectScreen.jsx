import { useState } from 'react'
import { MAX_ATTEMPTS, challengeTotal, daySummary, sessionResume } from '../game/day.js'
import ResumeChoice from '../components/ResumeChoice.jsx'
import {
  DAYS,
  FREE_DAYS,
  advanceDay,
  dayPlayable,
  dayRuns,
  isChallengeDone,
  isDayDone,
  streamDay,
  streamPhase,
} from '../game/challenge.js'
import { readRoom } from './RoomScreen.jsx'

/**
 * Выбор уровня перед раундом.
 *
 * Уровень человек выбирает сам — автопрогрессию Максим отменил. Поэтому экран
 * обязан показать всё, что нужно для выбора, и ровно в том порядке, в каком об
 * этом думают: во что играю (имя), почём здесь препятствие, сколько попыток
 * осталось и сколько я тут уже набрал.
 *
 * Уровень с тремя сыгранными попытками гасится, а не прячется: исчезнувшая
 * карточка читалась бы как поломка, а погашенная — как «на сегодня всё».
 *
 * Сумма дня внизу и крупно: это то, что поедет в общий дашборд участников, и
 * именно её человек сравнивает с другими. Под ней — сумма челленджа: она растёт
 * тридцать дней и отвечает на вопрос, ради которого всё затевалось.
 */
/**
 * @param {number} [props.challengeDay] Какой день челленджа идёт сейчас, 1..30.
 *   Ноль — челленджа нет вовсе (обычный подход), и строка не показывается.
 */
/**
 * ЧТО СКАЗАТЬ УЧАСТНИКУ, КОГДА ИГРАТЬ НЕЧЕГО. Два случая, и они разные: до
 * старта надо дождаться, после тридцатого дня — уже нечего ждать. Третий
 * случай — «поток идёт, но открыт не этот день» (сюда попадает отладочный
 * `?day=N`), и текст к нему собирается на месте: в нём есть номер.
 */
const STREAM_WALL = {
  before: {
    title: 'Поток ещё не начался',
    text: 'Дни челленджа откроются в день старта — они закрыты у всех участников одинаково. Тренировки, программы и дневник питания доступны уже сейчас.',
  },
  over: {
    title: 'Поток завершён',
    text: 'Тридцать дней позади. Итог потока — в таблице участников, и он больше не меняется.',
  },
}

export default function LevelSelectScreen({
  onPick,
  onExit,
  onSetup,
  /** Личный кабинет: счёт челленджа, показатели, история дней. */
  onRoom,
  /** Экран челленджа: что это, почём место, номер участника. */
  onChallenge = null,
  /** Переход состоялся — новый номер дня. Приложение обязано узнать: сессию
   *  собирает оно, и стартуй она по вчерашнему дню, переход был бы обманом. */
  onAdvance,
  challengeDay = 0,
  challengeDays = DAYS,
  /**
   * УЧАСТНИК ЖИВОГО ПОТОКА. Отвечает сразу за две вещи: открыты ли дни после
   * пятого и видны ли правила зачёта (счётчик попыток, правило трёх). Не
   * участник — уровни не гаснут и счётчик не показывается: см. пояснение на
   * месте вызова (index.jsx). Сам зачёт при этом не меняется ни на строку.
   *
   * УМОЛЧАНИЕ — НЕ УЧАСТНИК, и это важнее удобства. Участие теперь означает
   * оплаченное место в потоке; экран, отрисованный без этого пропса, откроет
   * тридцать дней всякому, до кого ответ сервера не доехал.
   */
  challengeMember = false,
  /**
   * ДАТА СТАРТА ПОТОКА участника, `YYYY-MM-DD`. Есть она — день считается
   * календарём, и кнопки перехода на экране нет вовсе: в день N потока играется
   * день N. Нет её (одиночка либо поток без объявленной даты) — всё по-старому,
   * вперёд по кнопке после сданного дня.
   */
  challengeStart = null,
  /**
   * ПРОГРЕСС НЕ ПРОЧИТАН С СЕРВЕРА. Заход участника в зачёт при этом не идёт:
   * его очки могут не сойтись с общей таблицей, а на ней призы. Тренироваться
   * можно — но человек обязан знать, что этот заход никуда не записывается.
   */
  syncBroken = false,
}) {
  /**
   * Снимок берётся при монтировании и пересчитывается ТОЛЬКО по переходу дня:
   * пока человек стоит на экране, попытки измениться не могут, а вот переход
   * меняет разом всё — день, попытки, обе суммы.
   */
  const [view, setView] = useState(() => readView(challengeDay, challengeMember, challengeStart))
  /**
   * НЕЗАВЕРШЁННАЯ СЕССИЯ этого дня. Снимок берётся при монтировании: пока
   * человек стоит на экране, начаться она не может, а вернуться он сюда может
   * только через размонтирование.
   */
  const [resume, setResume] = useState(() => sessionResume(challengeDay || undefined))

  const day = view.day
  /** Поток ведёт человека по календарю — своей воли в выборе дня у него нет. */
  const byCalendar = challengeMember && !!challengeStart
  const step = () => {
    const moved = advanceDay()
    if (!moved.advanced) return
    const next = Math.min(challengeDays, moved.day)
    setView(readView(next, challengeMember, challengeStart))
    onAdvance?.(next)
  }

  return (
    <div className="mt-screen mt-screen--levels">
      {/**
       * День челленджа — первое, что человек видит: тренировка у него сегодня
       * не «какая-то», а вполне определённая, тридцатая часть пути.
       *
       * Про разгрузку здесь не говорится ничего, хотя план о ней знает.
       * Расписание нагрузок — внутренняя кухня: названная разгрузка становится
       * разрешением, и человек приходит в этот день вполсилы, отчего день
       * перестаёт работать. Разгружает его план сам, молча.
       */}
      {view.number > 0 && (
        <div className="mt-levels__day" data-testid="challenge-day">
          День {view.number} из {challengeDays}
        </div>
      )}

      {/**
       * ПЕРЕХОД ВПЕРЁД — кнопкой и только кнопкой.
       *
       * Сам переход необратим: прошлый день закрывается навсегда. За необратимое
       * человек должен нажать сам, а не получить его в подарок за то, что дошёл
       * до конца сессии. До нажатия уровни остаются играбельными — это и есть
       * оставшиеся попытки улучшить результат дня.
       */}
      {!byCalendar && view.number > 0 && view.challengeDone && (
        <div className="mt-levels__step mt-levels__step--done" data-testid="challenge-done">
          Челлендж пройден!
        </div>
      )}
      {!byCalendar && view.number > 0 && !view.challengeDone && view.dayDone && (
        <button
          type="button"
          className="mt-levels__step"
          data-testid="advance-day"
          onClick={step}
        >
          {view.number >= challengeDays
            ? 'Завершить челлендж'
            : `День ${view.number} сдан — перейти к дню ${view.number + 1}`}
        </button>
      )}
      {/**
        * ЗА СКОЛЬКО ЗАХОДОВ СОБРАН ДЕНЬ. Показывается только когда их больше
        * одного: «за 1 заход» — это обычный случай, и называть его значит
        * добавить строку, которая ничего не сообщает.
        *
        * Для судейства призов разница существенна, и человек должен видеть то
        * же, что увидит судья: сюрпризов в споре о деньгах быть не должно.
        */}
      {view.number > 0 && view.dayDone && view.runs > 1 && (
        <div className="mt-levels__runs" data-testid="day-runs">
          Собран за {view.runs} захода
        </div>
      )}

      {/**
        * НАЧАТАЯ И НЕ ЗАВЕРШЁННАЯ СЕССИЯ — первым делом, до выбора уровня.
        *
        * Сессия идёт двадцать минут, и люди выходят из неё на третьем круге:
        * зазвонил телефон, позвали, кончилось время. До сих пор возвращаться им
        * было некуда — только начинать заново, тратя вторую попытку на то, что
        * уже сделано. Отсюда и выбор из двух: продолжить ту же попытку или
        * закрыть её и начать чистую.
        */}
      {resume && view.playable && (
        <ResumeChoice
          resume={resume}
          onContinue={(r) => onPick?.(r.tier, { resume: r })}
          onRestart={() => {
            setResume(null)
            setView(readView(challengeDay, challengeMember, challengeStart))
          }}
        />
      )}

      <h1 className="mt-title">
        {view.playable
          ? 'Выбери уровень'
          : byCalendar
            ? STREAM_WALL[view.phase]?.title ?? 'Этот день закрыт'
            : '5 дней пройдено!'}
      </h1>

      {/**
        * ПОТОК ЗАКРЫТ — ДО СТАРТА И ПОСЛЕ ТРИДЦАТОГО ДНЯ. Стена бесплатных дней
        * здесь не годится: человеку не надо ничего покупать, ему надо дождаться
        * или уже нечего ждать. Оба ответа короткие и без кнопок: нажимать
        * нечего, и предлагать нажатие значит врать.
        */}
      {byCalendar && !view.playable && (
        <div className="mt-levels__wall" data-testid="stream-wall">
          <div className="mt-wall__text" data-testid={`stream-${view.phase}`}>
            {STREAM_WALL[view.phase]?.text
              ?? `Сегодня идёт день ${view.streamNumber} потока — играется только он. Прошлые дни закрыты, будущие откроются в свой срок.`}
          </div>
        </div>
      )}

      {/**
       * ГРАНИЦА БЕСПЛАТНЫХ ДНЕЙ. Вместо карточек уровней — цифры самого человека
       * и предложение продолжить.
       *
       * Здесь важно, ЧТО именно показано. Не «оплатите доступ» и не список того,
       * чего он лишён, а его собственные пять дней работы: сколько набрал, какой
       * день вышел лучшим, насколько быстрее он стал реагировать. Решение
       * продолжать принимается не от жадности до контента, а от вида
       * собственного результата — человек смотрит на свою реакцию и понимает,
       * что за пять дней с ним что-то произошло.
       *
       * Ничего при этом не отнимается: комната открыта, набранное на месте,
       * пятый день можно переигрывать сколько угодно. Заблокирована ровно
       * тренировка шестого дня.
       */}
      {!view.playable && !byCalendar && (
        <div className="mt-levels__wall" data-testid="free-wall">
          <div className="mt-wall__stats">
            <div className="mt-wall__stat" data-testid="wall-total">
              <b>{view.total}</b>
              <span>очков за челлендж</span>
            </div>
            <div className="mt-wall__stat" data-testid="wall-best">
              <b>{view.best.total > 0 ? view.best.total : '—'}</b>
              <span>{view.best.total > 0 ? `лучший день — ${view.best.day}-й` : 'лучший день'}</span>
            </div>
            <div className="mt-wall__stat" data-testid="wall-react">
              <b>{view.reactMs > 0 ? `${view.reactMs} мс` : '—'}</b>
              <span>средняя реакция</span>
            </div>
          </div>

          <div className="mt-wall__text">
            Продолжи — впереди ещё {challengeDays - FREE_DAYS} дней челленджа
          </div>

          {/* ДВЕРЬ В ЧЕЛЛЕНДЖ ровно там, где человек упёрся в границу. Раньше
              здесь стояла ссылка «написать тренеру» — то есть предложение выйти
              из приложения и ждать ответа. Теперь на том же месте экран, где
              видно, что за поток, почём место и что в призовом фонде. */}
          {onChallenge && (
            <button
              type="button"
              className="mt-wall__contact"
              data-testid="wall-challenge"
              onClick={onChallenge}
            >
              Что за челлендж
            </button>
          )}
        </div>
      )}

      {/**
        * ЗАХОД НЕ В ЗАЧЁТ — САМЫМ ВЕРХОМ, ДО ВЫБОРА УРОВНЯ.
        *
        * Сказать это после тренировки было бы издевательством: двадцать минут
        * работы, которые не засчитались, человек не простит. Поэтому отказ
        * стоит на входе, а не в отчёте.
        */}
      {syncBroken && view.playable && (
        <div className="mt-levels__unscored" data-testid="unscored-note">
          Прогресс не загрузился — <b>заход в зачёт сейчас невозможен</b>. Потренироваться
          можно, но этот заход никуда не запишется и в таблицу потока не попадёт.
        </div>
      )}

      {/**
        * ОСТАТОК ЗАХОДОВ — ОДНОЙ СТРОКОЙ НА ЭКРАН. Заходов три на весь день, а
        * не на каждый уровень, поэтому «попытка 2 из 3» на карточке врала бы
        * трижды: она обещала бы отдельный запас каждому уровню.
        */}
      {view.playable && challengeMember && !syncBroken && (
        <div className="mt-levels__runsLeft" data-testid="runs-left">
          {view.left > 0
            ? `Осталось заходов: ${view.left} из ${MAX_ATTEMPTS}`
            : 'Заходы на сегодня кончились'}
        </div>
      )}

      {view.playable && (
      <div className="mt-levels">
        {day.tiers.map((tier) => (
          <button
            key={tier.id}
            className={`mt-level ${challengeMember && !syncBroken && tier.locked ? 'is-locked' : ''}`}
            data-testid={`level-${tier.id}`}
            disabled={challengeMember && !syncBroken && tier.locked}
            onClick={() => onPick?.(tier.id)}
          >
            <div className="mt-level__name">
              {tier.name}
              {syncBroken && <span className="mt-level__free"> · без зачёта</span>}
            </div>
            <div className="mt-level__price">{tier.obstaclePoints} очков за препятствие</div>

            <div className="mt-level__row">
              {/* Сколько заходов человек сделал именно тут — подсказка к
                  выбору, а не ограничение: ограничение общее и стоит строкой
                  выше. Ноль заходов не поминаем вовсе, это шум. */}
              {challengeMember && tier.used > 0 && (
                <span className="mt-level__attempts">
                  {tier.used === 1 ? 'заход сделан' : `заходов: ${tier.used}`}
                </span>
              )}
              <span className="mt-level__best">
                {tier.best > 0 ? `лучший ${tier.best}` : 'ещё не играл'}
              </span>
            </div>
          </button>
        ))}
      </div>
      )}

      <div className="mt-levels__total" data-testid="day-total">
        Лучший заход: <b>{day.total}</b> очков
      </div>
      <div className="mt-levels__challenge" data-testid="challenge-total">
        За челлендж: <b>{view.total}</b> очков
      </div>

      {/* Рядом с итогами, а не в углу: сюда идут именно от цифры «за челлендж» —
          увидел сумму, захотел посмотреть, из чего она собралась */}
      {onRoom && (
        <button type="button" className="mt-levels__room" data-testid="open-room" onClick={onRoom}>
          Моя комната
        </button>
      )}
      {challengeMember && (
        <div className="mt-levels__note">
          {MAX_ATTEMPTS} захода на весь день — на любые уровни, как решишь. В зачёт дня идёт
          один, лучший.{' '}
          {byCalendar
            ? 'День потока идёт по календарю: сегодня играется сегодняшний. Не сыграл — за этот день ноль.'
            : 'Перешёл к следующему дню — прошлый закрыт.'}
        </div>
      )}

      {/* Неброско и внизу: сюда приходят раз в жизни и по своей воле. Кнопка
          крупнее спорила бы с уровнями, а именно они здесь главные. */}
      {onSetup && (
        <button className="mt-levels__setup" data-testid="level-setup" onClick={onSetup}>
          Калибровка
        </button>
      )}

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Назад">
        ✕
      </button>
    </div>
  )
}

/**
 * Всё, что экран знает о состоянии челленджа, — одним снимком.
 *
 * Одной функцией, потому что после перехода меняется РАЗОМ ВСЁ: номер дня,
 * попытки, сумма дня и сумма челленджа. Собирай их по отдельности — и экран
 * успел бы показать новый день со вчерашними попытками.
 */
function readView(number, member = false, startsOn = null) {
  /**
   * Цифры для плашки считает комната — той же функцией, что и на своём экране.
   * Второй расчёт тех же чисел разошёлся бы с первым: человек увидел бы одну
   * среднюю реакцию на границе и другую в комнате, и не поверил бы обеим.
   */
  const room = readRoom(number || 1)
  const summary = daySummary(number || 1)
  return {
    number,
    day: summary,
    total: challengeTotal(),
    /** Сколько заходов осталось на день — общий счёт, не по уровням. */
    left: summary.left,
    dayDone: number > 0 && isDayDone(number),
    /** За сколько заходов собран день. Ноль — ещё не сдан. */
    runs: number > 0 ? dayRuns(number) : 0,
    challengeDone: isChallengeDone(),
    /** Можно ли сегодня тренироваться, или день за границей бесплатных пяти. */
    playable: number <= 0 || dayPlayable(number, member, startsOn),
    /** Где поток: до старта, идёт или закончился. Нет даты — `unknown`. */
    phase: streamPhase(startsOn),
    /** Какой день потока идёт сегодня. Нужен и тексту, и проверке номера. */
    streamNumber: streamDay(startsOn),
    best: room.best,
    reactMs: room.reactMs,
  }
}
