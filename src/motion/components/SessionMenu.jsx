import { useState } from 'react'
import { NOTE_MAX } from '../debug/diagnostics.js'
import RulesScreen from '../screens/RulesScreen.jsx'

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
 * ОКНО СО СЛОВАМИ. Снимок состояния говорит, ЧТО происходило с телефоном, но не
 * что человек при этом видел: «очки не начислились» и «эффекта попадания не
 * видно» дают один и тот же снимок и чинятся по-разному. Поэтому у жалобы есть
 * поле для слов — и оно НЕОБЯЗАТЕЛЬНОЕ: пустая жалоба всё равно ценнее
 * ненажатой кнопки, а требование что-то написать отсечёт ровно тех, кому
 * некогда. Плейсхолдер показывает пример не для красоты: без него в поле пишут
 * «не работает», и разбирать это невозможно.
 *
 * «Отмена» возвращает в меню, а не закрывает его: человек, передумавший писать,
 * чаще всего хочет продолжить тренировку, а не выйти из неё.
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
  /** 'idle' | 'form' | 'sending' | 'sent' — где человек в жалобе. */
  const [report, setReport] = useState('idle')
  const [note, setNote] = useState('')
  /**
   * ПРАВИЛА ОТКРЫВАЮТСЯ ПРЯМО ЗДЕСЬ, поверх меню, а не переключением экрана
   * раздела. Вопрос «а сколько попыток?» приходит в голову посреди тренировки,
   * и уводить человека из сессии ради ответа значит убить сессию: она
   * размонтируется вместе с набранным. Меню и так ставит паузу, когда его
   * открывают, — правила просто читаются в этой паузе.
   */
  const [rules, setRules] = useState(false)

  const close = () => {
    setOpen(false)
    setReport('idle')
    setNote('')
    setRules(false)
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
  const send = async () => {
    if (report === 'sending' || report === 'sent') return
    setReport('sending')
    try {
      await onReport?.(note)
    } catch {
      // Отправка глотает свои сбои сама и оставляет запись в буфере — она
      // уедет со следующей удачной отправкой. Человеку сообщать не о чем:
      // жалоба принята, а доедет она сейчас или через минуту, ему всё равно.
    }
    setReport('sent')
  }

  // Правила — на весь экран и без галочки: согласие даётся один раз до покупки
  // (см. RulesScreen), а здесь их перечитывают.
  if (open && rules) {
    return <RulesScreen onExit={() => setRules(false)} />
  }

  /**
   * ОКНО ЖАЛОБЫ вместо карточки меню, а не поверх неё: два наложенных окна на
   * телефоне в двух метрах — это способ промахнуться, а не выбрать.
   */
  if (open && (report === 'form' || report === 'sending')) {
    return (
      <div className="mt-menu" data-testid="report-form">
        <div className="mt-menu__veil" aria-hidden="true" />
        <div className="mt-menu__card">
          <div className="mt-menu__title">Сообщить о проблеме</div>

          <textarea
            className="mt-menu__field"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            rows={4}
            disabled={report === 'sending'}
            placeholder="Что пошло не так? Например: не начислились очки за попадание"
            aria-label="Что пошло не так"
            data-testid="report-text"
          />
          {/* Поле необязательное — так и написано, чтобы никто не искал, что ввести. */}
          <div className="mt-menu__hint">Можно отправить и без описания</div>

          <button
            type="button"
            className="mt-menu__item mt-menu__item--main"
            onClick={send}
            disabled={report === 'sending'}
            data-testid="report-send"
          >
            {report === 'sending' ? 'Отправляем…' : 'Отправить'}
          </button>

          <button
            type="button"
            className="mt-menu__item mt-menu__item--quiet"
            onClick={() => {
              setReport('idle')
              setNote('')
            }}
            disabled={report === 'sending'}
            data-testid="report-cancel"
          >
            Отмена
          </button>
        </div>
      </div>
    )
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

        {/* Правила потока — тихим пунктом: за ними приходят с конкретным
            вопросом, а не листать двенадцать экранов посреди тренировки. */}
        <button
          type="button"
          className="mt-menu__item mt-menu__item--quiet"
          onClick={() => setRules(true)}
          data-testid="menu-rules"
        >
          Правила челленджа
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
            onClick={() => setReport('form')}
            data-testid="menu-report"
          >
            Сообщить о проблеме
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
