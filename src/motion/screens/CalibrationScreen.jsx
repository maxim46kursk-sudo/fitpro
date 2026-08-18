import { useAutoStart } from '../flow/useAutoStart.js'
import { REASON } from '../pose/frameGate.js'
import BodySilhouette from '../components/BodySilhouette.jsx'
import Countdown from '../components/Countdown.jsx'

/**
 * Постановка камеры. Кнопок нет вообще: человек стоит в двух метрах и не может
 * ничего нажать, не сбив кадр. Встал целиком в кадр, простоял две секунды —
 * пошёл отсчёт, дальше подход.
 */
/**
 * @param {boolean} [props.instant] Не отсчитывать: постоял в кадре — и дальше.
 *   Так работает игра, где за этим экраном идёт ВЫБОР УРОВНЯ. Считать «5, 4, 3,
 *   2, 1» и привести человека к экрану с кнопками значит отсчитать его в
 *   никуда: он отдышался, собрался — и стоит выбирает. Отсчёт в игре один, и
 *   он там, где ему место, — перед самой работой, его ведёт сессия.
 * @param {Function} [props.onRoom] Личный кабинет. Единственная кнопка на этом
 *   экране — и она здесь потому, что до сих пор посмотреть свою статистику
 *   можно было только встав перед камерой в полный рост: комната жила за
 *   выбором уровня, а выбор уровня — за постановкой в кадр. Человек в поезде
 *   или на работе, захотевший взглянуть на свой счёт, упирался в «отойди
 *   дальше». Комнате камера не нужна вовсе, она читает хранилище.
 */
export default function CalibrationScreen({ subscribe, onStart, instant = false, onRoom }) {
  const { countdown, reason, hint, zones, holdProgress } = useAutoStart({
    subscribe,
    onStart,
    screen: 'calibration',
    countdownFrom: instant ? 0 : undefined,
  })

  const ready = reason === REASON.OK

  return (
    <div className="mt-screen mt-screen--calibration">
      <div className="mt-panel mt-panel--top">
        <div className="mt-hintline">
          <span className={`mt-status__dot ${ready ? 'is-ok' : 'is-bad'}`} />
          <span className="mt-hintline__text">{hint}</span>
        </div>
        <div className="mt-subhint">
          Телефон вертикально, на высоте пояса, в 2–3 метрах. Встань так, чтобы было
          видно с головы до стоп — {instant ? 'дальше выберешь уровень' : 'подход начнётся сам'}.
        </div>
      </div>

      <BodySilhouette zones={zones} />

      {countdown == null && ready && (
        <div className="mt-hold">
          <div className="mt-hold__bar" style={{ width: `${Math.round(holdProgress * 100)}%` }} />
        </div>
      )}

      {countdown != null && <Countdown value={countdown} />}

      {/* Неброско и в свободном углу: главное на этом экране — встать в кадр,
          и кнопка не должна с этим спорить. Но и прятать её некуда — это
          единственный вход в комнату, не требующий камеры. */}
      {onRoom && (
        <button
          type="button"
          className="mt-corner mt-corner--room"
          data-testid="calibration-room"
          onClick={onRoom}
        >
          Моя комната
        </button>
      )}
    </div>
  )
}
