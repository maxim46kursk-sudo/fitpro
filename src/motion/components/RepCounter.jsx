/** Крупный счётчик повторов. */
export default function RepCounter({ reps, label = 'повторов' }) {
  return (
    <div className="mt-repcounter">
      <div className="mt-repcounter__value">{reps}</div>
      <div className="mt-repcounter__label">{label}</div>
    </div>
  )
}
