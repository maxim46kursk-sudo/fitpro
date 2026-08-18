/** Крупная цифра отсчёта. Дублирует голос — на случай, если звук выключен. */
export default function Countdown({ value }) {
  return (
    <div className="mt-countdown" data-testid="countdown">
      <div className="mt-countdown__value" key={value}>
        {value}
      </div>
      <div className="mt-countdown__label">приготовься</div>
    </div>
  )
}
