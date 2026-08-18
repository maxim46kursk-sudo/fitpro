import { STRENGTH_LABEL } from '../game/strength.js'
import { MAX_ATTEMPTS } from '../game/day.js'

/**
 * ФИНАЛ СЕССИИ — таблица, по которой участник может сам сверить арифметику.
 *
 * Это не праздничный экран, а расчётный лист: на кону деньги челленджа, и
 * человек имеет право пересчитать очки руками. Поэтому здесь не «молодец, 4200
 * очков», а построчно — сколько повторов в каждом силовом блоке, сколько
 * попаданий из скольких мишеней в каждом бою, цена действия и произведение.
 *
 * Одна цена на всё и никаких множителей за серию — ровно затем, чтобы эта
 * таблица сходилась в уме.
 */
export default function SessionResult({ result, onExit, onRestart }) {
  const {
    strength = [],
    fights = [],
    score = 0,
    level,
    hitPoints = 0,
    day = 0,
    days = 30,
    /** Ответ зачёта дня (day.js). Нет — сессия сыграна вне челленджа. */
    attempt = null,
  } = result ?? {}
  const reps = strength.reduce((sum, row) => sum + row.reps, 0)
  const clears = fights.reduce((sum, row) => sum + row.cleared, 0)
  const actions = reps + clears

  return (
    <div className="mt-screen mt-screen--game mt-final" data-testid="session-result">
      <div className="mt-rest__veil" aria-hidden="true" />

      <div className="mt-final__head">
        <div className="mt-final__title">ТРЕНИРОВКА ОКОНЧЕНА</div>
        <div className="mt-final__level">
          {level?.name ?? ''}
          {day > 0 ? ` · день ${day} из ${days}` : ''}
        </div>
      </div>

      <div className="mt-final__score" data-testid="session-score">
        {score}
      </div>
      <div className="mt-final__scoreLabel">очков</div>

      {/**
       * ЗАЧЁТ ДНЯ — сразу под счётом, до таблицы. Человек только что отработал
       * двадцать минут, и первый его вопрос не «сколько повторов в четвёртом
       * круге», а «это пошло в счёт и стало ли лучше». Отвечать на него надо
       * там, куда он смотрит, а не строкой ниже разбора.
       */}
      {attempt && (
        <div className="mt-final__day" data-testid="attempt-verdict">
          {attempt.recorded ? (
            <>
              <div className="mt-final__dayLine" data-testid="attempt-line">
                Попытка {attempt.attempt} из {MAX_ATTEMPTS} ·{' '}
                {attempt.isBest ? (
                  /* Похвала стоит РОВНО ТАМ, где иначе было бы число: человек
                     ищет глазами одно место, а не два разных на разных исходах */
                  <b className="mt-final__dayBest">новый лучший результат!</b>
                ) : (
                  <>лучшая за день: {attempt.best}</>
                )}
              </div>
              <div className="mt-final__dayLine" data-testid="attempt-total">
                В зачёт дня: {attempt.dayTotal}
              </div>
            </>
          ) : (
            /**
             * Отказ говорится прямо и на месте обеих строк. Молчание здесь
             * читалось бы как «записано»: человек отработал те же двадцать
             * минут и имеет право знать, что этот заход в сумму не пошёл.
             */
            <div className="mt-final__dayLine mt-final__dayLine--out" data-testid="attempt-out">
              Попытки на сегодня кончились — результат не в зачёте
            </div>
          )}
        </div>
      )}

      <div className="mt-final__table">
        <div className="mt-final__row mt-final__row--head">
          <span>сила</span>
          <span>повторов</span>
        </div>
        {strength.map((row) => (
          <div className="mt-final__row" key={`s-${row.cycle}`}>
            <span>{STRENGTH_LABEL[row.movement] ?? row.movement}</span>
            <span>{row.reps}</span>
          </div>
        ))}

        <div className="mt-final__row mt-final__row--head">
          <span>бой</span>
          <span>попаданий</span>
        </div>
        {fights.map((row) => (
          <div className="mt-final__row" key={`f-${row.cycle}`}>
            <span>бой {row.cycle + 1}</span>
            <span>
              {row.cleared} из {row.spawned}
            </span>
          </div>
        ))}
      </div>

      {/* та самая строчка, ради которой таблица и сделана */}
      <div className="mt-final__sum" data-testid="session-sum">
        {actions} действий × {hitPoints} = {actions * hitPoints}
      </div>

      {/* Две кнопки, а не одна: после тренировки человек либо идёт на второй
          заход, либо возвращается выбирать. Раньше был только выход, и «ещё
          раз» приходилось искать через постановку в кадр заново. */}
      <div className="mt-final__actions">
        {onRestart && (
          <button
            type="button"
            className="mt-final__again"
            onClick={onRestart}
            data-testid="final-again"
          >
            Ещё раз
          </button>
        )}
        {onExit && (
          <button
            type="button"
            className="mt-final__exit"
            onClick={onExit}
            data-testid="final-menu"
          >
            В меню
          </button>
        )}
      </div>
    </div>
  )
}
