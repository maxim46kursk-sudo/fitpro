import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
 * ЭТО ВИТРИНА, А НЕ СПРАВКА. По этому экрану человек решает, платить ли 2990,
 * поэтому раскладка ровно такая: картинка сверху во всю ширину, крупный
 * заголовок, спокойный текст ограниченной ширины — и ЗАКРЕПЛЁННАЯ нижняя
 * панель, в которой всегда видно, где ты и куда дальше.
 *
 * ПАНЕЛЬ ЗАКРЕПЛЕНА НЕ РАДИ КРАСОТЫ. Кнопка, живущая в потоке текста, уезжает
 * за нижний край на длинных экранах — и человек, дочитавший правила, не находит
 * ни галочки, ни кнопки вступления. Здесь она приклеена к низу экрана и знает
 * про safe-area айфона, иначе уедет под системную полосу.
 *
 * ВОРОТА. Галочки и кнопки вступления НЕ СУЩЕСТВУЕТ, пока человек не дошёл до
 * последнего экрана. Не «спрятана» и не «погашена» — её нет в разметке:
 * погашенная кнопка на первом экране означала бы «жми сюда, когда надоест
 * читать», то есть ровно то, чего мы пытаемся избежать.
 *
 * ПОВТОРНО правила открываются свободно и без всего этого: человек, уже
 * согласившийся, приходит сюда за конкретным ответом («а что там про
 * пропущенный день?»), и требовать от него снова листать двенадцать экранов
 * было бы издевательством. Режим задаётся снаружи, пропсом `gate`.
 */

/**
 * @param {object[]} [props.screens] экраны правил; по умолчанию все двенадцать.
 * @param {boolean} [props.gate] ПЕРВОЕ ЧТЕНИЕ: на последнем экране появляются
 *   галочка и кнопка вступления. Повторное чтение — false.
 * @param {number} [props.price] цена билета для кнопки, из сезона.
 * @param {() => Promise<{ok?: true, error?: string}>|void} [props.onJoin]
 *   человек согласился и жмёт «Участвовать»: зафиксировать согласие и открыть оплату.
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

  /**
   * ТЕКСТ НЕ ИМЕЕТ ПРАВА ОБРЫВАТЬСЯ МОЛЧА.
   *
   * Полевая история: правила листали до двенадцатого экрана и не находили ни
   * галочки, ни кнопки — потому что текст был срезан на полуслове ровно по
   * нижнему краю, и человек читал это как «здесь всё». Обрыв без признака
   * продолжения — не мелочь вёрстки, а потерянная покупка.
   *
   * Отсюда две ступени, обе видимые:
   *   1) не влезает — КАРТИНКА УЖИМАЕТСЯ (40% высоты → 22%), и чаще всего
   *      этого хватает, чтобы экран поместился целиком;
   *   2) не влезло и так — снизу текста ложится мягкий градиент: он говорит
   *      «ниже есть ещё» и исчезает, когда человек дочитал до низа.
   *
   * Меряем после отрисовки (useLayoutEffect), а не гадаем по числу букв: высота
   * зависит от экрана, шрифта и переносов, и любая прикидка разъедется на
   * первом же телефоне другого размера.
   */
  const scrollRef = useRef(null)
  const [compact, setCompact] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  const measure = () => {
    const el = scrollRef.current
    if (!el) return
    const rest = el.scrollHeight - el.scrollTop - el.clientHeight
    setHasMore(rest > 4)
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    // Первая ступень: не влезает — ужимаем картинку и меряем заново.
    if (!compact && el.scrollHeight - el.clientHeight > 2) {
      setCompact(true)
      return undefined
    }
    measure()
    // И ещё раз следующим кадром: высота картинки и переносы строк успевают
    // устояться только после отрисовки, а ошибиться тут — значит оставить текст
    // обрезанным молча.
    const again = requestAnimationFrame(measure)
    // Картинка догружается позже текста и меняет высоту блока — меряем и после.
    const img = el.parentElement?.querySelector('img')
    img?.addEventListener('load', measure)
    globalThis.addEventListener?.('resize', measure)
    return () => {
      cancelAnimationFrame(again)
      img?.removeEventListener('load', measure)
      globalThis.removeEventListener?.('resize', measure)
    }
  }, [index, compact])

  const go = (next) => {
    if (next < 0 || next > last) return
    setIndex(next)
    // Новый экран начинается сверху и снова с крупной картинкой: короткому
    // экрану ужиматься незачем.
    setCompact(false)
    setHasMore(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
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
      className={`mt-screen mt-screen--rules ${compact ? 'is-compact' : ''}`}
      data-testid="rules-screen"
      data-compact={compact ? '1' : '0'}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* КАРТИНКА СВЕРХУ во всю ширину. contain на тёмной подложке: снимки
          экранов приложения вертикальные, и обрезка срезала бы у них ровно то,
          ради чего они сняты — счёт, норму, номер участника. */}
      {/* Экран без картинки (двенадцатый — про совесть) не держит пустую чёрную
          полосу в сорок процентов высоты: место отдаётся тексту, а счётчик
          переезжает строкой над заголовком. */}
      {page.image ? (
        <div className="mt-rules__hero">
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
          <div className="mt-rules__badge" data-testid="rules-count">
            {index + 1} / {pages.length}
          </div>
        </div>
      ) : (
        <div className="mt-rules__badge mt-rules__badge--flat" data-testid="rules-count">
          {index + 1} / {pages.length}
        </div>
      )}

      <div className="mt-rules__reading">
        <div
          className="mt-rules__scroll"
          ref={scrollRef}
          onScroll={measure}
          data-testid={`rules-page-${index + 1}`}
        >
          <h1 className="mt-rules__title" data-testid="rules-title">{page.title}</h1>
          <div className="mt-rules__body">
            {page.body?.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>
        </div>

        {/* «Ниже есть ещё» — единственная задача этой полоски. */}
        {hasMore && (
          <div className="mt-rules__fade" data-testid="rules-more" aria-hidden="true" />
        )}
      </div>

      {/* ЗАКРЕПЛЁННАЯ ПАНЕЛЬ: где я и куда дальше. На последнем экране первого
          чтения место «Далее» занимает согласие — главное действие обязано быть
          под большим пальцем, а не в конце прокрутки. */}
      <div className="mt-rules__bar">
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

        {showGate && (
          <div className="mt-rules__gate" data-testid="rules-gate">
            {/* Строка целиком — цель касания: палец, а не мышь. */}
            <label className="mt-rules__agree">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                data-testid="rules-agree"
              />
              <span>Я прочитал правила и согласен</span>
            </label>
          </div>
        )}

        {note && (
          <div className="mt-rules__note" data-testid="rules-note">
            {note}
          </div>
        )}

        <div className="mt-rules__actions">
          {index > 0 && (
            <button
              type="button"
              className="mt-rules__back"
              data-testid="rules-prev"
              onClick={() => go(index - 1)}
              aria-label="Предыдущий экран"
            >
              ‹
            </button>
          )}

          {showGate ? (
            <button
              type="button"
              className="mt-rules__main"
              data-testid="rules-join"
              disabled={!agreed || busy}
              onClick={join}
            >
              {busy ? 'Открываю оплату…' : `Участвовать — ${price} ₽`}
            </button>
          ) : index < last ? (
            <button
              type="button"
              className="mt-rules__main"
              data-testid="rules-next"
              onClick={() => go(index + 1)}
            >
              Далее
            </button>
          ) : (
            <button
              type="button"
              className="mt-rules__main mt-rules__main--quiet"
              data-testid="rules-done"
              onClick={() => onExit?.()}
            >
              Закрыть
            </button>
          )}
        </div>
      </div>

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Закрыть правила">
        ✕
      </button>
    </div>
  )
}

/** Абзац, перечисление, выделенное правило или уровни карточками. */
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

  /**
   * УРОВНИ — КАРТОЧКАМИ, А НЕ ТАБЛИЦЕЙ. Четыре колонки на экране шириной в
   * ладонь превращаются либо в мелкий шрифт, либо в горизонтальную прокрутку, и
   * человек не сравнивает уровни, а разбирает вёрстку. Карточка отвечает на
   * вопрос сразу: как называется, чем отличается, сколько стоит мишень.
   */
  if (block?.table) {
    const [, ...cols] = block.table.head
    return (
      <div className="mt-rules__levels" data-testid="rules-levels">
        {block.table.rows.map((row, i) => {
          const [name, ...values] = row
          return (
            <div className="mt-rules__level" key={i}>
              <div className="mt-rules__levelName">{bold(name)}</div>
              <div className="mt-rules__levelRows">
                {cols.map((col, j) => (
                  <div className="mt-rules__levelRow" key={col}>
                    <span>{col}</span>
                    <b>{bold(values[j])}</b>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return null
}

/**
 * **Жирный** — единственная разметка, которую понимает текст правил. Полного
 * markdown тут не нужно: тренер выделяет ровно те строки, которые в споре
 * потом и цитируют, и парсер ради одной пары звёздочек был бы дороже задачи.
 *
 * Сырых звёздочек на экране быть не должно ни при каких данных: split съедает
 * их все, даже если пара не закрыта.
 */
function bold(text) {
  const parts = String(text ?? '').split('**')
  return parts.map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))
}
