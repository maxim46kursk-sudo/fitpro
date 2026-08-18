/** Таймер обратного отсчёта. secondsLeft приходит снаружи — компонент только рисует. */
export default function Timer({ secondsLeft, total, paused = false }) {
  const clamped = Math.max(0, secondsLeft)
  const mm = Math.floor(clamped / 60)
  const ss = Math.floor(clamped % 60)
  const progress = total > 0 ? clamped / total : 0

  return (
    <div className={`mt-timer ${paused ? 'is-paused' : ''}`}>
      <div className="mt-timer__value">
        {mm}:{String(ss).padStart(2, '0')}
      </div>
      <div className="mt-timer__bar">
        <div className="mt-timer__fill" style={{ width: `${progress * 100}%` }} />
      </div>
      {paused && <div className="mt-timer__paused">пауза</div>}
    </div>
  )
}
