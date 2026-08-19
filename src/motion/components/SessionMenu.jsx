import { useState } from 'react'

/**
 * МЕНЮ ТРЕНИРОВКИ — постоянная кнопка в углу и действия за ней.
 *
 * До неё выйти из сессии было нечем: единственный крестик жил внутри боя и
 * обрывал всю тренировку без спроса, а из силового блока и отдыха выхода не
 * было вовсе — только перезагрузка страницы. Человек, которому позвонили на
 * третьем круге, терял двадцать минут работы.
 *
 * ДЕЙСТВИЯ И НИ ОДНОГО ЛИШНЕГО:
 *   пауза и продолжить — одно и то же место, потому что это одно решение;
 *   начать заново — сессия с нуля, тем же уровнем;
 *   выйти — к выбору уровня;
 *   сообщить о проблеме — жалоба с диагностическим снимком.
 *
 * ЖАЛОБА ЖИВЁТ ИМЕННО ЗДЕСЬ, а не на отдельном экране. Человек, у которого
 * что-то не так, уже тянется к телефону и уже открывает это меню — другого
 * места, куда он придёт САМ и в момент поломки, у нас нет. Жалоба, до которой
 * надо дойти после тренировки, не будет написана никогда: к тому времени и
 * повод забудется, и состояние, которое надо было снять, исчезнет.
 *
 * Пункт стоит ПОСЛЕДНИМ среди действий и оформлен тихо: он нужен редко, а
 * место рядом с «начать заново» и «выйти» стоит дорого — промахнуться по нему
 * посреди тренировки хуже, чем не найти его сразу.
 *
 * Кнопка нарочно маленькая и в углу: человек стоит в двух метрах от телефона и
 * попадает по ней только намеренно, подойдя. Случайно её не нажимают — а
 * именно случайного нажатия здесь и надо бояться больше, чем неудобного.
 *
 * Открытое меню САМО СТАВИТ ПАУЗУ (см. SessionScreen): раз человек подошёл к
 * телефону, тренировка уже прервана — считать её идущей значит списывать ему
 * время и мишени за то, чего он не делал.
 */
export default function SessionMenu({ paused, onPause, onResume, onRestart, onExit, onReport }) {
  const [open, setOpen] = useState(false)
  /** 'idle' | 'sending' | 'sent' — состояние жалобы, живёт только пока открыто меню. */
  const [report, setReport] = useState('idle')

  const close = () => {
    setOpen(false)
    setReport('idle')
  }
  const act = (fn) => () => {
    close()
    fn?.()
  }

  /**
   * Жалоба НЕ ЗАКРЫВАЕТ меню: человек должен увидеть, что его услышали. Молча
   * закрывшееся меню он прочтёт как «кнопка не сработала» и нажмёт ещё раз,
   * потом ещё — и мы получим три жалобы вместо одной и человека, уверенного,
   * что приложение сломано и здесь тоже.
   *
   * Повторное нажатие блокируется на время отправки по той же причине.
   */
  const report_ = async () => {
    if (report !== 'idle') return
    setReport('sending')
    try {
      await onReport?.()
    } catch {
      // Отправка глотает свои сбои сама и оставляет запись в буфере — она
      // уедет со следующей удачной отправкой. Человеку сообщать не о чем:
      // жалоба принята, а доедет она сейчас или через минуту, ему всё равно.
    }
    setReport('sent')
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

        {/*
          Сообщить о проблеме. Тихое оформление и последнее место среди
          действий — см. шапку файла.
        */}
        {report === 'sent' ? (
          <div className="mt-menu__note" data-testid="menu-report-done">
            Отправлено, спасибо
          </div>
        ) : (
          <button
            type="button"
            className="mt-menu__item mt-menu__item--quiet"
            onClick={report_}
            disabled={report === 'sending'}
            data-testid="menu-report"
          >
            {report === 'sending' ? 'Отправляем…' : 'Сообщить о проблеме'}
          </button>
        )}

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
