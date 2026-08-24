import { useEffect, useRef, useState } from 'react'
import { RULES } from './rulesContent.js'

/**
 * ПРАВИЛА ЧЕЛЛЕНДЖА — двенадцать экранов, листаются вбок.
 *
 * ЗАЧЕМ ЛИСТАТЬ, А НЕ ПРОКРУЧИВАТЬ ОДНУ ДЛИННУЮ СТРАНИЦУ. Правила читают ровно
 * один раз в жизни и с телефона, и длинная страница читается известно как:
 * палец уезжает в конец, глаз цепляет заголовки. Здесь же на кону деньги —
 * призовой фонд, зачёт по питанию, вылет за подставного человека, — и «я не
 * знал» после этого стоит дорого обеим сторонам. Двенадцать отдельных экранов
 * заставляют пройти правила целиком: каждый следующий требует движения пальцем.
 *
 * ОТСЮДА ГЛАВНОЕ ПРАВИЛО ЭКРАНА: галочки и кнопки вступления НЕ СУЩЕСТВУЕТ,
 * пока человек не дошёл до двенадцатого. Не «спрятана» и не «погашена» —
 * её нет в разметке. Погашенная кнопка на первом экране означала бы «жми сюда,
 * когда надоест читать», то есть ровно то, чего мы пытаемся избежать.
 *
 * ПОВТОРНО ПРАВИЛА ОТКРЫВАЮТСЯ СВОБОДНО и без всего этого: человек, уже
 * согласившийся, приходит сюда за конкретным ответом («а что там про пропущенный
 * день?») и требовать от него снова листать двенадцать экранов было бы
 * издевательством. Режим задаётся снаружи, пропсом `gate`.
 *
 * ЖЕСТЫ. Свайп и стрелки, и оба обязательны: свайпом листают на телефоне, а
 * стрелки нужны и на компьютере, и тому, кто читает одной рукой в метро. Точки
 * снизу — не украшение: они отвечают на вопрос «сколько ещё осталось», без
 * которого длинное чтение бросают на середине.
 */

/**
 * @param {object[]} [props.screens] экраны правил; по умолчанию все двенадцать.
 * @param {boolean} [props.gate] ПЕРВОЕ ЧТЕНИЕ: на последнем экране появляются
 *   галочка и кнопка вступления. Повторное чтение — false.
 * @param {number} [props.price] цена билета для кнопки, из сезона.
 * @param {() => Promise<{ok?: true, error?: string}>|void} [props.onJoin]
 *   человек согласился и жмёт «Вступить»: зафиксировать согласие и открыть оплату.
 * @param {() => void} [props.onExit] закрыть правила.
 */
export default function RulesScreen({
  screens = RULES,
  gate = false,
  price = 0,
  onJoin = null,
  onExit = null,
}) {
  const pages = Array.isArray(screens) && screens.length ? screens : []
  const [index, setIndex] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  /**
   * ДОШЁЛ ЛИ ДО КОНЦА — ref, а не «index === последний». Человек, пролиставший
   * до двенадцатого и вернувшийся посмотреть таблицу уровней, дошёл до конца
   * навсегда: отбирать у него галочку за любопытство незачем.
   */
  const reachedEnd = useRef(false)
  const last = pages.length - 1
  if (index >= last) reachedEnd.current = true

  const go = (next) => {
    if (next < 0 || next > last) return
    setIndex(next)
  }

  // Стрелки клавиатуры — тем, кто читает с компьютера.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') go(index + 1)
      if (e.key === 'ArrowLeft') go(index - 1)
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => globalThis.removeEventListener?.('keydown', onKey)
  })

  /**
   * СВАЙП СЧИТАЕМ САМИ, без библиотеки. Порог в 40 пикселей и требование, чтобы
   * движение было горизонтальнее вертикального: иначе прокрутка длинного экрана
   * пальцем через раз перелистывала бы страницу.
   */
  const touch = useRef(null)
  const onTouchStart = (e) => {
    const t = e.changedTouches?.[0]
    touch.current = t ? { x: t.clientX, y: t.clientY } : null
  }
  const onTouchEnd = (e) => {
    const start = touch.current
    const t = e.changedTouches?.[0]
    touch.current = null
    if (!start || !t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return
    go(dx < 0 ? index + 1 : index - 1)
  }

  const join = async () => {
    if (busy || !agreed || !onJoin) return
    setBusy(true)
    setNote('')
    const result = await onJoin()
    setBusy(false)
    if (result?.error) setNote(result.error)
  }

  if (!pages.length) return null
  const page = pages[Math.min(index, last)]
  // Галочка и кнопка — только на последнем экране и только в первое чтение.
  const showGate = gate && index === last && reachedEnd.current

  return (
    <div
      className="mt-screen mt-screen--rules"
      data-testid="rules-screen"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="mt-rules__head">
        <div className="mt-rules__count" data-testid="rules-count">
          {index + 1} из {pages.length}
        </div>
        <h1 className="mt-title mt-rules__title" data-testid="rules-title">
          {page.title}
        </h1>
      </div>

      <div className="mt-rules__page" data-testid={`rules-page-${index + 1}`}>
        {page.image && (
          <img
            className="mt-rules__image"
            src={page.image}
            alt={page.alt || page.title}
            loading="lazy"
            decoding="async"
            data-testid="rules-image"
            /* Картинки присылают отдельно от текста; отсутствующая не должна
               оставлять посреди правил битую иконку. */
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
        )}

        <div className="mt-rules__body">
          {page.body?.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>
      </div>

      {/**
       * СОГЛАСИЕ. Появляется только здесь и только дочитавшему: см. шапку файла.
       * Кнопка без галочки не работает — и она именно НЕАКТИВНА, а не спрятана:
       * человек должен видеть, что осталось сделать один шаг.
       */}
      {showGate && (
        <div className="mt-rules__gate" data-testid="rules-gate">
          <label className="mt-rules__agree">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              data-testid="rules-agree"
            />
            <span>Я прочитал правила и согласен</span>
          </label>

          <button
            type="button"
            className="mt-button"
            data-testid="rules-join"
            disabled={!agreed || busy}
            onClick={join}
          >
            {busy ? 'Открываю оплату…' : `Вступить в челлендж — ${price} ₽`}
          </button>

          {note && (
            <div className="mt-rules__note" data-testid="rules-note">
              {note}
            </div>
          )}
        </div>
      )}

      <div className="mt-rules__nav">
        <button
          type="button"
          className="mt-rules__arrow"
          data-testid="rules-prev"
          disabled={index === 0}
          onClick={() => go(index - 1)}
          aria-label="Предыдущий экран"
        >
          ‹
        </button>

        <div className="mt-rules__dots" data-testid="rules-dots">
          {pages.map((p, i) => (
            <button
              key={p.title}
              type="button"
              className={`mt-rules__dot ${i === index ? 'is-on' : ''}`}
              data-testid={`rules-dot-${i + 1}`}
              onClick={() => go(i)}
              aria-label={`Экран ${i + 1}: ${p.title}`}
              aria-current={i === index ? 'true' : undefined}
            />
          ))}
        </div>

        <button
          type="button"
          className="mt-rules__arrow"
          data-testid="rules-next"
          disabled={index === last}
          onClick={() => go(index + 1)}
          aria-label="Следующий экран"
        >
          ›
        </button>
      </div>

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Закрыть правила">
        ✕
      </button>
    </div>
  )
}

/** Абзац, перечисление, выделенное правило или таблица уровней. */
function Block({ block }) {
  if (typeof block === 'string') return <p className="mt-rules__p">{bold(block)}</p>

  if (block?.list) {
    return (
      <ul className="mt-rules__list">
        {block.list.map((item, i) => (
          <li key={i}>{bold(item)}</li>
        ))}
      </ul>
    )
  }

  if (block?.quote) {
    return (
      <div className="mt-rules__quote" data-testid="rules-quote">
        {bold(block.quote)}
      </div>
    )
  }

  if (block?.table) {
    return (
      <div className="mt-rules__tableWrap">
        <table className="mt-rules__table">
          <thead>
            <tr>{block.table.head.map((h) => <th key={h}>{bold(h)}</th>)}</tr>
          </thead>
          <tbody>
            {block.table.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}>{bold(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return null
}

/**
 * **Жирный** — единственная разметка, которую понимает текст правил. Полного
 * markdown тут не нужно: тренер выделяет ровно те строки, которые в споре
 * потом и цитируют, и парсер ради одной пары звёздочек был бы дороже задачи.
 */
function bold(text) {
  const parts = String(text ?? '').split('**')
  return parts.map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))
}
