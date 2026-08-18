/**
 * Силуэт человека во весь рост поверх видео: показывает целевое положение
 * в кадре и, главное, ЧТО именно не влезло. Зона зелёная — видно, красная — нет.
 * Человеку в двух метрах этого достаточно, чтобы понять, куда шагнуть,
 * не читая текст.
 */
export default function BodySilhouette({ zones = {} }) {
  const cls = (zone) => `mt-sil__part ${zones[zone] ? 'is-ok' : 'is-bad'}`

  return (
    <svg
      className="mt-sil"
      viewBox="0 0 120 260"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      data-testid="silhouette"
    >
      {/* рамка целевой зоны */}
      <rect
        className="mt-sil__frame"
        x="6"
        y="4"
        width="108"
        height="252"
        rx="16"
        strokeDasharray="10 10"
      />

      {/* голова */}
      <circle className={cls('head')} data-zone="head" cx="60" cy="30" r="16" />

      {/* плечи и руки */}
      <g className={cls('shoulders')} data-zone="shoulders">
        <path d="M36 62 H84" strokeLinecap="round" />
        <path d="M36 62 L26 108" strokeLinecap="round" />
        <path d="M84 62 L94 108" strokeLinecap="round" />
        <path d="M60 48 V62" strokeLinecap="round" />
      </g>

      {/* корпус и таз */}
      <g className={cls('hips')} data-zone="hips">
        <path d="M60 62 V132" strokeLinecap="round" />
        <path d="M40 132 H80" strokeLinecap="round" />
      </g>

      {/* бёдра до колен */}
      <g className={cls('knees')} data-zone="knees">
        <path d="M40 132 L38 186" strokeLinecap="round" />
        <path d="M80 132 L82 186" strokeLinecap="round" />
      </g>

      {/* голени и стопы */}
      <g className={cls('ankles')} data-zone="ankles">
        <path d="M38 186 L36 238" strokeLinecap="round" />
        <path d="M82 186 L84 238" strokeLinecap="round" />
        <path d="M28 240 H46" strokeLinecap="round" />
        <path d="M74 240 H92" strokeLinecap="round" />
      </g>
    </svg>
  )
}
