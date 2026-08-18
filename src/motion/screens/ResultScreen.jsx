import { useEffect, useRef } from 'react'
import { useAutoStart } from '../flow/useAutoStart.js'
import { cueFinish } from '../feedback/audio.js'
import Countdown from '../components/Countdown.jsx'
import { submitAttempt } from '../game/day.js'
import { logEvent } from '../debug/logShipper.js'

/**
 * Итог подхода. Из игрового раунда здесь записывается попытка дня — в зачёт
 * идёт лучшая на уровне, а итог дня складывается из лучших по трём уровням.
 * Остальные цифры живут только в React state.
 *
 * Вердиктов по уровню больше нет: раньше экран объявлял «уровень вверх/вниз»,
 * но автопрогрессию Максим отменил — уровень выбирает человек, и сообщать ему
 * решение игры теперь не о чем.
 *
 * Результат проговаривается вслух, а повторный подход запускается тем же
 * механизмом, что и первый: встал в кадр, дождался отсчёта. Касаний не нужно.
 */
export default function ResultScreen({ stats, onRestart, onExit, subscribe }) {
  const {
    reps = 0,
    avgDepth = null,
    bestDepth = null,
    seconds = 0,
    // после игрового раунда приходят ещё очки — на обычном подходе их нет
    score = null,
    cleared = null,
    obstacles = null,
    best = null,
    isRecord = false,
    /** Уровень и номер попытки: приходят только из игры. */
    tier = null,
    tierName = null,
    attempt = null,
  } = stats || {}
  const spokenRef = useRef(false)
  const savedRef = useRef(null)

  /**
   * Попытка записывается один раз на появление экрана — иначе перерисовка
   * съедала бы вторую попытку. Ref, а не эффект: цифры нужны уже в первой
   * отрисовке, а эффект приходит после неё.
   */
  if (tier != null && savedRef.current === null) {
    savedRef.current = submitAttempt(tier, score ?? 0)
  }
  const day = savedRef.current

  useEffect(() => {
    if (spokenRef.current) return
    spokenRef.current = true
    cueFinish()
    if (!day) return
    logEvent('game.day', {
      tier,
      attempt,
      score: day.score,
      best: day.best,
      isBest: day.isBest,
      recorded: day.recorded,
      total: day.dayTotal,
    })
  }, [reps, day, tier, attempt])

  const { countdown, hint } = useAutoStart({
    subscribe,
    onStart: onRestart,
    screen: 'result',
  })

  return (
    <div className="mt-screen mt-screen--result">
      <div className="mt-result">
        <h1 className="mt-title">{score == null ? 'Подход закончен' : 'Раунд закончен'}</h1>

        {score != null && (
          <>
            {/* Рекорд — единственное, что переживает перезагрузку, и ради него
                человек заходит завтра. Поэтому он крупно и сразу. */}
            {isRecord && (
              <div className="mt-result__record" data-testid="new-record">
                НОВЫЙ РЕКОРД!
              </div>
            )}
            {/* На каком уровне играли — иначе балл не с чем соотнести:
                препятствие стоит по-разному на разных уровнях. */}
            {tierName && (
              <div className="mt-result__level" data-testid="result-tier">
                {tierName}
                {attempt ? ` · попытка ${attempt}` : ''}
              </div>
            )}
            {/* Промахи отдельной цифрой не показываем: сколько не вышло —
                видно из разницы, а лишний счётчик неудач тут ни к чему. */}
            <div className="mt-result__grid">
              <Metric value={score} label="очков за попытку" />
              <Metric value={obstacles ?? 0} label="движений всего" />
              <Metric value={cleared ?? 0} label="из них засчитано" />
              <Metric value={best ?? score} label="рекорд" />
            </div>

            {/* Зачёт дня: лучшая на этом уровне и сумма трёх. Ради этих двух
                цифр человек и приходит второй раз за день. */}
            {day && (
              <div className="mt-result__grid" data-testid="day-score">
                <Metric value={day.best} label={`лучший на «${tierName}»`} />
                <Metric value={day.dayTotal} label="сумма дня" />
              </div>
            )}
            {day && !day.recorded && (
              <div className="mt-result__note">
                Попытки на этом уровне сегодня кончились — балл в зачёт не пошёл.
              </div>
            )}
          </>
        )}

        <div className="mt-result__grid">
          <Metric value={reps} label="повторов" />
          <Metric
            value={avgDepth == null ? '—' : `${Math.round(avgDepth)}°`}
            label="средняя глубина"
          />
          <Metric value={`${seconds} с`} label="время" />
        </div>

        {bestDepth != null && (
          <div className="mt-result__note">Самый глубокий присед — {Math.round(bestDepth)}°</div>
        )}
        {reps === 0 && (
          <div className="mt-result__note">
            Ни одного повтора. Попробуй приседать глубже — колено должно согнуться заметно ниже
            прямого угла.
          </div>
        )}

        <div className="mt-result__again">
          Чтобы повторить — просто встань в кадр. {hint}
        </div>
      </div>

      {countdown != null && <Countdown value={countdown} />}

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Выйти">
        ✕
      </button>
    </div>
  )
}

function Metric({ value, label }) {
  return (
    <div className="mt-metric">
      <div className="mt-metric__value">{value}</div>
      <div className="mt-metric__label">{label}</div>
    </div>
  )
}
