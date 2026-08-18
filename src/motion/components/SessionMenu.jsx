import { useState } from 'react'

/**
 * МЕНЮ ТРЕНИРОВКИ — постоянная кнопка в углу и четыре действия за ней.
 *
 * До неё выйти из сессии было нечем: единственный крестик жил внутри боя и
 * обрывал всю тренировку без спроса, а из силового блока и отдыха выхода не
 * было вовсе — только перезагрузка страницы. Человек, которому позвонили на
 * третьем круге, терял двадцать минут работы.
 *
 * ЧЕТЫРЕ ДЕЙСТВИЯ И НИ ОДНОГО ЛИШНЕГО:
 *   пауза и продолжить — одно и то же место, потому что это одно решение;
 *   начать заново — сессия с нуля, тем же уровнем;
 *   выйти — к выбору уровня.
 *
 * Кнопка нарочно маленькая и в углу: человек стоит в двух метрах от телефона и
 * попадает по ней только намеренно, подойдя. Случайно её не нажимают — а
 * именно случайного нажатия здесь и надо бояться больше, чем неудобного.
 *
 * Открытое меню САМО СТАВИТ ПАУЗУ (см. SessionScreen): раз человек подошёл к
 * телефону, тренировка уже прервана — считать её идущей значит списывать ему
 * время и мишени за то, чего он не делал.
 */
export default function SessionMenu({ paused, onPause, onResume, onRestart, onExit }) {
  const [open, setOpen] = useState(false)

  const close = () => setOpen(false)
  const act = (fn) => () => {
    close()
    fn?.()
  }

  if (!open) {
    return (
      <button
        type="button"
        className="mt-menu__button"
        onClick={() => {
          setOpen(true)
          onPause?.()
        }}
        aria-label="Меню тренировки"
        data-testid="session-menu-button"
      >
        <span aria-hidden="true">⋯</span>
      </button>
    )
  }

  return (
    <div className="mt-menu" data-testid="session-menu">
      <div className="mt-menu__veil" aria-hidden="true" />
      <div className="mt-menu__card">
        <div className="mt-menu__title">Тренировка</div>

        <button
          type="button"
          className="mt-menu__item mt-menu__item--main"
          onClick={act(paused ? onResume : onPause)}
          data-testid="menu-resume"
        >
          {paused ? 'Продолжить' : 'Пауза'}
        </button>

        <button
          type="button"
          className="mt-menu__item"
          onClick={act(onRestart)}
          data-testid="menu-restart"
        >
          Начать заново
        </button>

        <button
          type="button"
          className="mt-menu__item"
          onClick={act(onExit)}
          data-testid="menu-exit"
        >
          Выйти к выбору уровня
        </button>

        {/* закрыть, ничего не меняя: меню открывают и чтобы просто передохнуть */}
        <button
          type="button"
          className="mt-menu__item mt-menu__item--quiet"
          onClick={close}
          data-testid="menu-close"
        >
          Закрыть
        </button>
      </div>
    </div>
  )
}
