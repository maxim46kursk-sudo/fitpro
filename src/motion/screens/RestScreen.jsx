import DemoSkeleton from '../debug/DemoSkeleton.jsx'
import SessionProgress from '../components/SessionProgress.jsx'
import { STRENGTH_LOOP, tempoFor } from '../game/strength.js'

/**
 * ОТДЫХ МЕЖДУ БЛОКАМИ — единственное место сессии, где человеку можно не
 * смотреть на себя.
 *
 * Поэтому здесь и только здесь возвращается тёмная подложка: в силовом блоке и
 * в бою человек — герой экрана, и затемнять его нельзя, а на отдыхе смотреть
 * надо на две вещи — сколько осталось и что будет дальше.
 *
 * «ДАЛЬШЕ» — не украшение. Человек, который узнаёт о приседе в тот момент, когда
 * начался отсчёт, тратит первые секунды блока на «а что делать?». Фигурка
 * инструктора крутит уже СЛЕДУЮЩЕЕ движение — к его началу человек успевает и
 * вспомнить, и встать в кадр.
 */
/**
 * @param {number} [props.score] Общий счёт сессии. Отдых был единственным
 *   экраном сессии без очков — и единственным, где на них есть время смотреть.
 */
export default function RestScreen({
  leftMs,
  countdown,
  nextLabel,
  nextMovement,
  tier,
  cycle = 0,
  cycles = 0,
  score = null,
}) {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000))
  const loop = nextMovement ? (STRENGTH_LOOP[nextMovement] ?? { movement: nextMovement, side: null }) : null

  return (
    <div
      className={`mt-screen mt-screen--game mt-rest ${cycles > 0 ? 'mt-screen--sprog' : ''}`}
      data-testid="rest-screen"
    >
      <div className="mt-rest__veil" aria-hidden="true" />

      <SessionProgress cycle={cycle} cycles={cycles} score={score} />

      <div className="mt-rest__title">ОТДЫХ</div>
      {countdown ? (
        <div className="mt-rest__countdown" data-testid="rest-countdown">
          {countdown}
        </div>
      ) : (
        <div className="mt-rest__timer" data-testid="rest-timer">
          {seconds}
        </div>
      )}

      <div className="mt-rest__next" data-testid="rest-next">
        ДАЛЬШЕ: {nextLabel}
      </div>

      {loop && (
        <div className="mt-block__coach mt-rest__coach" data-testid="rest-coach">
          <DemoSkeleton
            movement={loop.movement}
            side={loop.side}
            width={150}
            height={230}
            tempo={tempoFor(tier)}
          />
          <div className="mt-block__coachLabel">{nextLabel}</div>
        </div>
      )}
    </div>
  )
}
