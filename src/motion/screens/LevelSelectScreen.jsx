import { useState } from 'react'
import { MAX_ATTEMPTS, challengeTotal, daySummary } from '../game/day.js'
import {
  CONTACT_URL,
  DAYS,
  FREE_DAYS,
  advanceDay,
  dayPlayable,
  isChallengeDone,
  isDayDone,
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
export default function LevelSelectScreen({
  onPick,
  onExit,
  onSetup,
  /** Личный кабинет: счёт челленджа, показатели, история дней. */
  onRoom,
  /** Переход состоялся — новый номер дня. Приложение обязано узнать: сессию
   *  собирает оно, и стартуй она по вчерашнему дню, переход был бы обманом. */
  onAdvance,
  challengeDay = 0,
  challengeDays = DAYS,
}) {
  /**
   * Снимок берётся при монтировании и пересчитывается ТОЛЬКО по переходу дня:
   * пока человек стоит на экране, попытки измениться не могут, а вот переход
   * меняет разом всё — день, попытки, обе суммы.
   */
  const [view, setView] = useState(() => readView(challengeDay))

  const day = view.day
  const step = () => {
    const moved = advanceDay()
    if (!moved.advanced) return
    const next = Math.min(challengeDays, moved.day)
    setView(readView(next))
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
      {view.number > 0 && view.challengeDone && (
        <div className="mt-levels__step mt-levels__step--done" data-testid="challenge-done">
          Челлендж пройден!
        </div>
      )}
      {view.number > 0 && !view.challengeDone && view.dayDone && (
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

      <h1 className="mt-title">{view.playable ? 'Выбери уровень' : '5 дней пройдено!'}</h1>

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
      {!view.playable && (
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

          {/* Пустая ссылка кнопки не даёт: мёртвая «написать тренеру», ведущая
              никуда, хуже её отсутствия */}
          {CONTACT_URL && (
            <a
              className="mt-wall__contact"
              data-testid="wall-contact"
              href={CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Написать тренеру
            </a>
          )}
        </div>
      )}

      {view.playable && (
      <div className="mt-levels">
        {day.tiers.map((tier) => (
          <button
            key={tier.id}
            className={`mt-level ${tier.locked ? 'is-locked' : ''}`}
            data-testid={`level-${tier.id}`}
            disabled={tier.locked}
            onClick={() => onPick?.(tier.id)}
          >
            <div className="mt-level__name">{tier.name}</div>
            <div className="mt-level__price">{tier.obstaclePoints} очков за препятствие</div>

            <div className="mt-level__row">
              <span className="mt-level__attempts">
                {tier.locked ? 'попытки кончились' : `попытка ${tier.used + 1} из ${MAX_ATTEMPTS}`}
              </span>
              <span className="mt-level__best">
                {tier.best > 0 ? `лучший ${tier.best}` : 'ещё не играл'}
              </span>
            </div>
          </button>
        ))}
      </div>
      )}

      <div className="mt-levels__total" data-testid="day-total">
        Сегодня: <b>{day.total}</b> очков
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
      <div className="mt-levels__note">
        До {MAX_ATTEMPTS} попыток на уровень, в зачёт — лучшая. Итог дня — сумма по уровням.
        Перешёл к следующему дню — прошлый закрыт.
      </div>

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
function readView(number) {
  /**
   * Цифры для плашки считает комната — той же функцией, что и на своём экране.
   * Второй расчёт тех же чисел разошёлся бы с первым: человек увидел бы одну
   * среднюю реакцию на границе и другую в комнате, и не поверил бы обеим.
   */
  const room = readRoom(number || 1)
  return {
    number,
    day: daySummary(number || 1),
    total: challengeTotal(),
    dayDone: number > 0 && isDayDone(number),
    challengeDone: isChallengeDone(),
    /** Можно ли сегодня тренироваться, или день за границей бесплатных пяти. */
    playable: number <= 0 || dayPlayable(number),
    best: room.best,
    reactMs: room.reactMs,
  }
}
