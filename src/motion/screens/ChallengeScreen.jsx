import { useEffect, useRef, useState } from 'react'
import { MIN_ENTRIES, MIN_MEALS, dayScore, streamScore } from '../../challengeNutrition.js'
import { DAYS, streamDay, streamPhase } from '../game/challenge.js'
import StreamRoom from './StreamRoom.jsx'
import { bump } from '../../funnel.js'
import { ступень } from '../challengeFunnel.js'

/**
 * ЧЕЛЛЕНДЖ — ОДНА ДЛИННАЯ СТРАНИЦА, по которой человек решает, платить ли.
 *
 * Раньше здесь было два разных места: короткая карточка с ценой и отдельная
 * карусель правил из двенадцати экранов. Карусель убрана намеренно — она
 * заставляла листать двенадцать раз до кнопки и прятала главное в середине
 * пути. Теперь всё одним свитком и в том порядке, в каком человек об этом
 * спрашивает: что это → зачем мне → как устроен день → я не один → что
 * получу → сколько стоит → а если... → согласен, плачу.
 *
 * ПРАВИЛА — РАЗДЕЛ ЭТОЙ ЖЕ СТРАНИЦЫ, а согласие берётся галочкой внизу: чтобы
 * до неё дойти, правила надо прокрутить, и «дочитал» здесь означает ровно это.
 * Порядок «сначала согласие в базу, потом оплата» не менялся
 * (sql/2026-08-24_challenge_rules.sql).
 *
 * НИЧЕГО ПРО ДЕНЬГИ И ДАТЫ НЕ ЗАШИТО В РАЗМЕТКУ. Цена, доля фонда, делёж между
 * тройкой и дата старта приходят из строки сезона; состав гарантированных
 * призов лежит одной таблицей ниже (PRIZES) и правится одной строкой.
 *
 * Порядок блоков, тексты и размеры — с согласованного макета
 * docs/challenge-landing-maket.html.
 */

/**
 * ГАРАНТИРОВАННЫЕ ПРИЗЫ — В ОДНОМ МЕСТЕ. Они объявлены заранее и не зависят от
 * числа участников, поэтому живут константой, а не текстом в разметке: сумма
 * фонда считается отсюда же и не разъедется с составом.
 */
export const PRIZES = [
  {
    place: 1,
    value: 30000,
    title: 'VIP-пакет: месяц тренировок со мной по видеосвязи.',
    text: 'Персональная программа тренировок и питания, составленная под тебя.',
  },
  {
    place: 2,
    value: 19980,
    title: '2 месяца тарифа ПРЕМИУМ:',
    text: 'персональная программа, разбор питания, ежедневная проверка отчётов.',
  },
  { place: 3, value: 9990, title: 'Месяц тарифа ПРЕМИУМ.', text: '' },
]

const PRIZES_TOTAL = PRIZES.reduce((sum, p) => sum + p.value, 0)

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/**
 * Дата вида «10 сентября» — руками, а не через toLocaleDateString: раздел
 * открывают в том числе внутри Telegram на телефонах с урезанным набором
 * локалей, и там человек увидел бы «9/10/2026».
 */
function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''))
  if (!m) return null
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month}` : null
}

/**
 * Сколько дней осталось до старта. null — даты нет, 0 — старт сегодня.
 *
 * Считается через день потока (game/challenge.js), а не по часам телефона:
 * граница суток у потока одна — полночь по Москве, и отсчёт обязан идти по той
 * же черте, что и сами дни. Иначе человек с другим часовым поясом увидел бы
 * «старт завтра» в день, когда день 1 у него уже идёт.
 */
function daysUntil(value) {
  const n = streamDay(value)
  return n === null ? null : 1 - n
}

/** «17 дней» / «1 день» / «2 дня» — счёт идёт людям, а не машине. */
function pluralDays(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} день`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} дня`
  return `${n} дней`
}

/** Неразрывный пробел в разрядах: «2 990 ₽» не должно ломаться пополам. */
const NBSP = String.fromCharCode(160)
const money = (n) =>
  `${Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/\s/g, NBSP)}${NBSP}₽`

/**
 * @param {{season: object, entry: object|null, rulesAcceptedAt: string|null}|null} [props.state]
 * @param {boolean} [props.guest] гость без аккаунта: цену видит, оплату — нет.
 * @param {() => Promise<{ok?: true, already?: true, error?: string}>} [props.onJoin]
 *   согласие в базу и оплата — одной дорогой, порядок задаёт вызывающий.
 * @param {() => void} [props.onCreateAccount] гость нажал «Создать аккаунт».
 * @param {() => void} [props.onRefresh] перечитать участие.
 * @param {boolean} [props.loading] участие ещё читается с сервера.
 * @param {number} [props.fallbackPrice] объявленная цена, пока сезона нет.
 * @param {boolean} [props.hasNorm] есть ли у человека дневная норма питания.
 *   Нет — билет не продаётся: питание половина зачёта (api/create-payment.js).
 * @param {() => void} [props.onFillNorm] увести на экран нормы в дневнике.
 * @param {object[]} [props.nutrition] сырьё по питанию за поток: тридцать строк
 *   из challenge_nutrition_facts. Проценты по ним считает challengeNutrition.js.
 * @param {() => void} [props.onStandings] открыть таблицу потока.
 * @param {object[]} [props.standingsRows] сырьё таблицы потока: место в ней
 *   комната показывает сразу, не заставляя человека открывать таблицу.
 * @param {() => void} [props.onStartDay] начать сегодняшний день потока.
 * @param {(tier: string, opts: object) => void} [props.onResume] продолжить
 *   незавершённую сессию. Комната сессий не запускает — отдаёт решение наверх.
 * @param {() => void} [props.onOpenDiary] открыть дневник питания.
 * @param {() => void} [props.onOpenMyData] увести в «Мои данные».
 * @param {boolean} [props.syncBroken] прогресс не прочитан — заход не в зачёт.
 * @param {boolean} [props.pushFailed] результат не уехал наверх после повторов.
 * @param {boolean} [props.greet] первый заход после покупки: показать полосу
 *   поздравления. Один раз — дальше комната открывается рабочим экраном дня.
 * @param {() => void} [props.onGreetSeen] полосу увидели, больше не показывать.
 */
export default function ChallengeScreen({
  state = null,
  guest = false,
  onJoin = null,
  onCreateAccount = null,
  onRefresh = null,
  onExit = null,
  loading = false,
  fallbackPrice = 0,
  hasNorm = true,
  onFillNorm = null,
  nutrition = null,
  onStandings = null,
  standingsRows = null,
  onStartDay = null,
  onResume = null,
  onOpenDiary = null,
  onOpenMyData = null,
  syncBroken = false,
  pushFailed = false,
  greet = false,
  onGreetSeen = null,
}) {
  const season = state?.season || null
  const entry = state?.entry || null

  const price = season?.price_rub ?? fallbackPrice
  const prizePct = season?.prize_pct ?? 50
  const split = Array.isArray(season?.prize_split) && season.prize_split.length
    ? season.prize_split
    : [50, 30, 20]
  const startDate = formatDate(season?.starts_on)
  const left = daysUntil(season?.starts_on)
  /** Где поток по календарю и какой его день идёт сегодня — одна правда на всё. */
  const phase = streamPhase(season?.starts_on)
  const today = streamDay(season?.starts_on)

  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * ОТКРЫЛИ СТРАНИЦУ ПОТОКА — первая ступень воронки продажи.
   *
   * Только пока страница продаёт. Участник открывает ЭТУ ЖЕ страницу, чтобы
   * перечитать правила, и считать его вместе с покупателями значило бы каждый
   * день подмешивать в верх воронки тех, кто уже внизу.
   */
  useEffect(() => {
    if (loading || entry) return
    bump('ch_open')
    // Ступень 1 воронки лендинга. Гость или нет — главная развилка всей
    // дорожки: на ней стоит регистрация, и без этого поля отвал не читается.
    ступень('open', { гость: !!guest })
  }, [loading, entry, guest])
  /**
   * УЧАСТНИК ЧИТАЕТ ПРАВИЛА. Открывается та же самая страница, что и до
   * покупки, — другой у правил нет и быть не должно: человек согласился именно
   * с этим текстом, и показывать ему пересказ значило бы показывать другой
   * документ. Покупка на ней при этом гасится: покупать ему уже нечего.
   */
  const [rulesOpen, setRulesOpen] = useState(false)
  const [note, setNote] = useState('')
  const [openQ, setOpenQ] = useState(null)
  const [barOn, setBarOn] = useState(false)

  const viewRef = useRef(null)
  const endRef = useRef(null)
  const rulesRef = useRef(null)

  /**
   * ЛИПКАЯ КНОПКА ПОЯВЛЯЕТСЯ ПОСЛЕ ПЕРВОГО ЭКРАНА И ПРЯЧЕТСЯ В КОНЦЕ. На герое
   * она не нужна — там своя, крупная; в конце страницы она перекрывала бы ту,
   * ради которой человек и докрутил.
   */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return undefined
    const onScroll = () => {
      const past = view.scrollTop > 420
      const end = endRef.current
      const atEnd = end ? view.scrollTop + view.clientHeight > end.offsetTop + 120 : false
      setBarOn(past && !atEnd)
      /**
       * Ступень 2: долистал до цены. «Цена» — это последний блок, тот самый, где
       * галочка и кнопка: цену видно и в шапке, но решение принимают здесь.
       *
       * Отметка ставится один раз за визит (см. challengeFunnel.js), поэтому
       * звать её на каждом пикселе прокрутки не жалко: после первого раза
       * функция выходит на проверке отметки, не трогая ни журнал, ни сеть.
       */
      if (end && view.scrollTop + view.clientHeight > end.offsetTop) {
        ступень('scroll', { гость: !!guest })
      }
    }
    view.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => view.removeEventListener('scroll', onScroll)
  }, [entry, loading, guest])

  /**
   * ПРЫЖОК ПО СТРАНИЦЕ — СВОИМИ РУКАМИ, А НЕ scrollIntoView.
   *
   * Живая поломка: «Участвовать» из липкой полосы роняло человека вниз, и там
   * его же кнопку перекрывала эта самая полоса. Причин две, и обе от
   * scrollIntoView: он прокручивает БЛИЖАЙШИЙ подходящий контейнер (а у нас их
   * два — свиток страницы и экран под ним) и ставит цель ровно в верх окна, не
   * зная ни про полосу внизу, ни про то, что у последнего раздела прокрутка
   * упирается в конец и цель остаётся ниже, чем просили.
   *
   * Здесь мы двигаем ИМЕННО свиток страницы и на ИЗВЕСТНОЕ число. Плюс
   * `.mt-ch__final` получил снизу поле в рост полосы (motion.css) — так кнопка
   * не окажется под ней даже в тот миг, пока полоса ещё не спряталась.
   */
  const scrollTo = (ref) => {
    const view = viewRef.current
    const target = ref.current
    if (!view || !target) return
    const top = target.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop
    view.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' })
  }

  const join = async () => {
    if (busy || !agreed || !onJoin) return
    setBusy(true)
    setNote('')
    const result = await onJoin()
    setBusy(false)
    if (result?.already) {
      // Сервер смотрит в базу в момент нажатия и знает про участие больше:
      // значит правы не мы — перечитываем и показываем комнату.
      setNote('Ты уже участник этого потока')
      onRefresh?.()
      return
    }
    if (result?.error) setNote(result.error)
  }

  // Пока участие читается — молчим: показать «набор закрыт» тому, кто час назад
  // купил билет, хуже, чем показать ожидание.
  if (loading) {
    return (
      <div className="mt-screen mt-ch" data-testid="challenge-screen">
        <div className="mt-ch__loading" data-testid="challenge-loading">Смотрю, что с потоком…</div>
        <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Назад">✕</button>
      </div>
    )
  }

  // ── УЧАСТНИК, ПОКА ПОТОК ИДЁТ: рабочая комната дня ──────────────────────────
  //
  // Отдельным файлом (StreamRoom.jsx), а не ещё одной веткой здесь: это уже не
  // «страница про покупку в состоянии купленного», а другое место с другим
  // назначением — оттуда человек начинает день, а не узнаёт, дошли ли деньги.
  if (entry && phase === 'running' && !rulesOpen) {
    return (
      <StreamRoom
        entry={entry}
        today={today}
        days={DAYS}
        startsOn={season?.starts_on}
        nutrition={nutrition}
        standingsRows={standingsRows}
        hasNorm={hasNorm}
        syncBroken={syncBroken}
        pushFailed={pushFailed}
        greet={greet}
        onGreetSeen={onGreetSeen}
        onStartDay={onStartDay}
        onResume={onResume}
        onOpenDiary={onOpenDiary}
        onOpenMyData={onOpenMyData}
        onStandings={onStandings}
        onRules={() => setRulesOpen(true)}
        onExit={onExit}
      />
    )
  }

  // ── УЧАСТНИК ДО СТАРТА И ПОСЛЕ ФИНИША ───────────────────────────────────────
  //
  // До старта играть нечего, и экран честно отвечает на единственный вопрос,
  // который в этот момент есть: сколько ждать и чем заняться пока. После
  // тридцатого дня — то же самое зеркально: доигрывать нечего, остаётся итог.
  if (entry && !rulesOpen) {
    return (
      <div className="mt-screen mt-ch mt-ch--room" data-testid="challenge-screen">
        <div className="mt-ch__done" data-testid="challenge-member">
          <div className="mt-ch__ring" aria-hidden="true">{phase === 'over' ? '🏁' : '✓'}</div>
          <h3>{phase === 'over' ? 'Поток пройден' : 'Ты в потоке'}</h3>
          <p>
            {phase === 'over'
              ? 'Все тридцать дней позади. Таблица заморожена — доигрывать нечего.'
              : 'Место в потоке за тобой. Дни откроются в день старта — они закрыты у всех одинаково.'}
          </p>

          <div className="mt-ch__no">
            <div className="mt-ch__noLabel">Твой номер участника</div>
            <div className="mt-ch__noValue" data-testid="challenge-number">№ {entry.participant_no}</div>
            <div className="mt-ch__noName" data-testid="challenge-name">{entry.display_name}</div>
            {/**
              * ГДЕ СЕЙЧАС ПОТОК. До старта — отсчёт, во время — номер дня (тот
              * самый, который сегодня и играется), после — что всё кончилось.
              * Номер дня здесь не украшение: у участника день назначает
              * календарь, и человек должен видеть, какой именно ему выпал.
              */}
            <div className="mt-ch__noSub" data-testid="challenge-start">
              {phase === 'unknown'
                ? 'Дата старта будет объявлена'
                : phase === 'before'
                  ? left === 0
                    ? 'Старт сегодня'
                    : `До старта потока: ${pluralDays(left)}`
                  : phase === 'running'
                    ? `Идёт день ${today} из ${DAYS} · с ${startDate}`
                    : `Поток завершён — все ${DAYS} дней позади`}
            </div>
          </div>

          {/**
           * ГЛАВНОЕ, ЧТО ЧЕЛОВЕК СПРАШИВАЕТ ПОСЛЕ ОПЛАТЫ: «я заплатил, а где
           * тренировки?». Отвечаем прямо и сразу — иначе ответ придёт вопросом
           * в личку тренеру, и не один раз.
           */}
          {phase !== 'running' && (
          <div className="mt-ch__early" data-testid="challenge-early">
            <div className="mt-ch__earlyTitle">Что доступно прямо сейчас</div>
            <p className="mt-ch__earlyP">
              Дни челленджа откроются в день старта — они закрыты у всех одинаково. А
              <b> тренировки, программы и дневник питания доступны уже сейчас</b>: заполни
              данные о себе и втягивайся.
            </p>
          </div>
          )}

          <Nutrition rows={nutrition} startsOn={season?.starts_on} hasNorm={hasNorm} onFillNorm={onOpenMyData} />

          {/* Таблица потока — рядом со своим номером: «где я среди остальных»
              спрашивают сразу после «какой у меня номер». */}
          {onStandings && (
            <button
              type="button"
              className="mt-ch__btn mt-ch__btn--line"
              data-testid="challenge-standings"
              onClick={onStandings}
            >
              Таблица потока
            </button>
          )}

          <button type="button" className="mt-ch__rulesLink" data-testid="challenge-rules-link" onClick={() => setRulesOpen(true)}>
            Правила
          </button>
        </div>

        {/**
          * ВЫХОД ТОЛЬКО КРЕСТИКОМ. Кнопки «Понятно» здесь больше нет: она
          * высаживала человека на список программ, то есть уводила ровно
          * оттуда, куда он пришёл. Комната — место назначения, а не диалог.
          */}
        <button className="mt-corner mt-corner--left mt-ch__close" onClick={onExit} aria-label="Закрыть">✕</button>
      </div>
    )
  }

  /**
   * СТРАНИЦУ ЧИТАЕТ УЧАСТНИК. Сюда он попадает по тихой ссылке «Правила» из
   * комнаты, и единственное, что для него меняется, — покупка: она гасится
   * целиком (кнопки, галочка, липкая полоса с ценой). Сам текст правил не
   * трогается ни на слово: человек согласился именно с ним, и показывать ему
   * пересказ значило бы показывать другой документ.
   */
  const readOnly = !!entry
  const priceLabel = money(price)

  return (
    <div className="mt-screen mt-ch" data-testid="challenge-screen">
      <div className="mt-ch__view" ref={viewRef}>

        {/* ═══ ГЕРОЙ ═══ */}
        <div className="mt-ch__hero">
          <div className="mt-ch__heroGlow" aria-hidden="true" />
          <div className="mt-ch__heroIn">
            <div className="mt-ch__tag" data-testid="challenge-tag">
              {season?.title || 'Поток 1'}{startDate ? ` · старт ${startDate}` : ' · дата будет объявлена'}
            </div>
            <h1 className="mt-ch__big">
              30<br />ДНЕЙ
              <small>Челлендж FitPro Motion</small>
            </h1>
            <p className="mt-ch__heroP">
              Двадцать минут в день перед камерой телефона. <b>Без зала, без гантелей, без
              абонемента.</b> Камера считает каждое движение сама.
            </p>
            <div className="mt-ch__heroCta">
              {readOnly ? null : (
                <button type="button" className="mt-ch__btn" data-testid="challenge-hero-join" onClick={() => scrollTo(endRef)}>
                  Участвовать — {priceLabel}
                </button>
              )}
              <button type="button" className="mt-ch__btn mt-ch__btn--line" data-testid="challenge-to-rules" onClick={() => scrollTo(rulesRef)}>
                Сначала правила
              </button>
            </div>
            <p className="mt-ch__heroNote">Разовый вход в поток. Не подписка.</p>
          </div>
        </div>

        {/* ═══ ЗАЧЕМ ═══ */}
        <section>
          <p className="mt-ch__kicker">Зачем это тебе</p>
          <h2 className="mt-ch__h2">Дело не только<br />в <em>весах</em></h2>
          <p>
            Вес — то, что видно первым. Но за тридцать дней движения меняется куда больше, и
            обычно люди замечают это раньше, чем цифру на весах.
          </p>
          <ul className="mt-ch__pain">
            {[
              ['Энергия.', 'Просыпаться перестаёт быть подвигом, к вечеру ещё что-то остаётся.'],
              ['Спина и колени.', 'Тело, которое двигается каждый день, перестаёт ныть от сидячей работы.'],
              ['Сон и голова.', 'Засыпаешь быстрее, а нервы держат то, что раньше выбивало.'],
              ['Уверенность.', 'Тридцать дней, которые ты не бросил, меняют отношение к себе сильнее любого зеркала.'],
            ].map(([head, tail]) => (
              <li key={head}>
                <i className="mt-ch__iUp" aria-hidden="true">↑</i>
                <span><b>{head}</b> {tail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-ch__punch">
            И да — <em>вес тоже уходит.</em> Но только если тренировку не съедать вечером.
            Поэтому здесь считается и движение, и еда.
          </p>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ КАК ═══ */}
        <section>
          <p className="mt-ch__kicker">Как это работает</p>
          <h2 className="mt-ch__h2">Три вещи<br />каждый день</h2>

          <Step
            n="01 — ПОСТАВЬ"
            title="Телефон на пол, ты — в двух метрах"
            text="Камера видит тебя целиком и подсвечивает силуэт, когда встал правильно. Больше настраивать нечего."
            image="/challenge/shot-calibration.webp"
            alt="Экран калибровки: силуэт человека загорелся зелёным"
            caption="Экран калибровки: силуэт загорелся — можно начинать"
          />
          <Step
            n="02 — ОТРАБОТАЙ"
            title="20 минут: силовая и бой"
            text="Семь кругов. В каждом полминуты силового движения и пара минут боя — к тебе летят мишени, ты выбиваешь их руками и ногами. Счёт идёт сразу, на экране."
            image="/challenge/shot-fight.webp"
            alt="Экран боя: мишень в воздухе, счёт и таймер круга"
            caption="Бой: мишень в воздухе, счёт и таймер круга"
          />
          <Step
            n="03 — ЗАПИШИ"
            title="Что съел за день"
            text="Поиск по базе, штрих-код с упаковки или руками. Норму приложение считает по твоим данным — попадать в неё и есть задача."
            image="/challenge/shot-diary.webp"
            alt="Дневник питания: дневная норма, съедено и остаток по КБЖУ"
            caption="Дневник питания: норма, съедено, остаток по КБЖУ"
          />
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ВМЕСТЕ ═══ */}
        <section>
          <p className="mt-ch__kicker">И главное</p>
          <h2 className="mt-ch__h2">Ты идёшь<br />не <em>один</em></h2>
          <p>
            Поток стартует у всех в один день, и тридцать дней у всех одни и те же — день в
            день. Видно, где ты среди остальных, и это держит лучше любой мотивации.
          </p>
          <Shot
            image="/challenge/shot-table.webp"
            alt="Таблица потока: место, номер участника, очки движения и процент питания"
            caption="Таблица потока: место, номер участника, очки и питание"
          />
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ПРИЗЫ ═══ */}
        <section>
          <p className="mt-ch__kicker">Призы</p>
          <h2 className="mt-ch__h2">Призовой фонд —<br />это <em>две части</em></h2>

          <div className="mt-ch__prize">
            <div className="mt-ch__fundLbl">Часть первая · призы</div>
            <div className="mt-ch__fund" data-testid="challenge-prizes-total">{money(PRIZES_TOTAL)}</div>
            <div className="mt-ch__fundL">
              Они уже есть и не зависят от того, сколько человек придёт в поток.
            </div>
            <div className="mt-ch__places">
              {PRIZES.map((p) => (
                <div className="mt-ch__pl" key={p.place}>
                  <div className="mt-ch__plN"><i>{p.place}</i>место</div>
                  <div className="mt-ch__plD">
                    <b>{p.title}</b>{p.text ? ` ${p.text}` : ''}
                    {' '}<span className="mt-ch__plV">{money(p.value)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-ch__prize mt-ch__prize--second">
            <div className="mt-ch__fundLbl">Часть вторая · деньги</div>
            <div className="mt-ch__fund" data-testid="challenge-prize-pct">+ {prizePct}% каждого билета</div>
            <div className="mt-ch__fundL">
              Живые деньги, которые делятся между теми же тремя. Чем больше народу в потоке —
              тем больше эта часть.
            </div>
            <div className="mt-ch__split" data-testid="challenge-split">
              {split.slice(0, 3).map((pct, i) => (
                <div key={i}><b>{pct}%</b><span>{i + 1} место</span></div>
              ))}
            </div>
          </div>

          <p className="mt-ch__after">
            Место считается по двум показателям сразу — как ты двигаешься и как ты ешь. Одним
            питанием челлендж не выиграть, и одной игрой тоже.
          </p>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ЧИСЛА ═══ */}
        <section>
          <p className="mt-ch__kicker">Коротко</p>
          <div className="mt-ch__nums">
            {[
              ['30', 'дней, одинаковых у всех'],
              ['~20 мин', 'на один день'],
              ['3', 'захода в день, в зачёт лучший'],
              ['0 ₽', 'на зал и снаряды'],
            ].map(([v, l]) => (
              <div className="mt-ch__num" key={l}>
                <div className="mt-ch__numV">{v}</div>
                <div className="mt-ch__numL">{l}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ЧТО ВХОДИТ ═══ */}
        <section>
          <p className="mt-ch__kicker">Что входит в билет</p>
          <h2 className="mt-ch__h2">Что ты<br />получаешь</h2>
          <ul className="mt-ch__inc">
            {[
              ['Все 30 дней программы', ' — с первого до последнего'],
              ['Свою норму питания', ', посчитанную по твоим данным'],
              ['Место в таблице потока', ' и своё положение каждый день'],
              ['Право на призы', ' — фонд делится между тремя лучшими'],
            ].map(([head, tail]) => (
              <li key={head}>
                <i aria-hidden="true">✓</i>
                <span><b>{head}</b>{tail}</span>
              </li>
            ))}
          </ul>
          <div className="mt-ch__early">
            <div className="mt-ch__earlyTitle">И всё приложение — уже сейчас</div>
            <p className="mt-ch__earlyP">
              Челлендж откроется в день старта. Но <b>тренировки, программы и дневник питания
              доступны сразу после оплаты</b> — можно втягиваться, не дожидаясь первого дня.
            </p>
          </div>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ПОСЛЕ ОПЛАТЫ ═══ */}
        <section>
          <p className="mt-ch__kicker">Что будет после оплаты</p>
          <h2 className="mt-ch__h2">Дальше всё<br />по шагам</h2>
          <div className="mt-ch__flow">
            {[
              ['Оплата', 'Открывается защищённая страница оплаты. Карта, СБП — как обычно. После оплаты возвращаешься в приложение сам.'],
              ['Ты в потоке, у тебя есть номер', 'Появляется твой номер участника — под ним ты будешь в таблице. Ничего подтверждать и никому писать не надо.'],
              ['Заполняешь данные о себе', 'Рост, вес, цель, активность. Приложение считает твою норму питания — до старта её ещё можно менять.'],
              ['Ждёшь старта — но не сидишь без дела', 'Дни челленджа до старта закрыты у всех одинаково: в комнате тикает обратный отсчёт. Зато всё остальное приложение уже твоё — тренировки, программы, дневник питания.'],
              ['День старта — открывается первый день', 'Дальше по календарю: каждый день свой, тридцать дней подряд.'],
            ].map(([title, text], i) => (
              <div className="mt-ch__fl" key={title}>
                <div className="mt-ch__flDot">{i + 1}</div>
                <div className="mt-ch__flBody">
                  <div className="mt-ch__flT">{title}</div>
                  <div className="mt-ch__flD">{text}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ПРАВИЛА ═══ */}
        <section ref={rulesRef} data-testid="challenge-rules">
          <p className="mt-ch__kicker">Правила · читать до конца</p>
          <h2 className="mt-ch__h2">Как всё<br />считается</h2>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Что сделать до старта</h3>
            <p>
              Заполни данные о себе: пол, возраст, рост, вес, цель, активность. По ним
              приложение посчитает дневную норму — калории, белки, жиры, углеводы.
            </p>
            <p>
              <b>Норма замораживается в день старта.</b> Менять её посреди потока нельзя, иначе
              можно было бы вечером подогнать норму под съеденное. Один пересчёт — на 15-й
              день, по новому весу.
            </p>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Как проходит день</h3>
            <p>
              Семь кругов, на тяжёлых днях восемь. Круг — полминуты силового движения и
              полторы-две минуты боя, между ними короткий отдых.
            </p>
            <p>
              Можно выйти на середине и вернуться позже — день соберётся из нескольких заходов.
              Но <b>день засчитан, только когда сделаны все круги.</b>
            </p>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Три уровня</h3>
            <p>
              Уровень выбираешь сам, каждый день заново. Движения везде одни и те же — разница
              в темпе и в том, насколько точно надо попасть.
            </p>
            <div className="mt-ch__tiers">
              {[
                ['НОВИЧОК', 'крупная', 'долго', '100 очков'],
                ['ОПЫТНЫЙ', 'средняя', 'меньше', '150 очков'],
                ['ПРОФИ', 'мелкая', 'мало', '200 очков'],
              ].map(([name, size, hangs, cost]) => (
                <div className="mt-ch__tier" key={name}>
                  <div className="mt-ch__tierN">{name}</div>
                  <div className="mt-ch__tierR"><span>Мишень</span><b>{size}</b></div>
                  <div className="mt-ch__tierR"><span>Висит</span><b>{hangs}</b></div>
                  <div className="mt-ch__tierR"><span>Цена мишени</span><b>{cost}</b></div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Очки и заходы</h3>
            <p>
              <b>Каждая выбитая мишень — очки уровня.</b> Никаких множителей: сколько выбил,
              столько и заработал. Промах очков не отнимает.
            </p>
            <div className="mt-ch__quote">
              Три захода в день. Все три — на любые уровни, как решишь. В зачёт идёт один,
              лучший.
            </div>
            <p>
              Три захода на новичке — или один на профи и два на опытном: твой выбор. На профи
              мишень дороже, но темп жёстче, и слабый заход там может проиграть сильному на
              новичке. <b>Уровень — это ставка.</b>
            </p>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Как считается питание</h3>
            <p>
              Смотрим, насколько ты промахнулся мимо своей нормы по каждому из четырёх
              показателей:
            </p>
            <ul className="mt-ch__ul">
              <li>промах <b>до 10%</b> — это <b>100 баллов</b>, твой коридор;</li>
              <li>дальше падает: 20% мимо — 80 баллов, 30% — 60, 60% и хуже — ноль.</li>
            </ul>
            <p>
              Оценка дня — среднее по четырём. Чтобы день считался, за него нужно{' '}
              <b>минимум {MIN_ENTRIES} записи и хотя бы {MIN_MEALS} приёма пищи</b>: одной
              строчкой «торт, 2400 ккал» в зачёт не попасть, и это правильно.
            </p>
            <p>Итог за поток — средний процент за все 30 дней. День без записей — ноль.</p>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Поток идёт по календарю</h3>
            <div className="mt-ch__quote">
              В первый день потока играется первый день. Во второй — второй. Пропустил — за
              этот день ноль, и вернуться нельзя.
            </div>
            <p>
              То же и с питанием: дневник закрывается вместе с днём. Это не наказание, это и
              есть челлендж.
            </p>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Как определяется победитель</h3>
            <p>
              Сначала считаются две таблицы. В одной все выстроены по <b>очкам движения</b>, в
              другой — по <b>проценту питания</b>. У тебя получается два места: например,
              третье в движении и первое в питании.
            </p>
            <div className="mt-ch__quote">
              Эти два места складываются. Чем меньше вышло — тем выше ты в итоговой таблице.
            </div>
            <p>
              Первое место в обеих таблицах дало бы 1 + 1 = 2, лучше не бывает. Посмотри, как
              это работает на двоих:
            </p>
            <div className="mt-ch__calc">
              <div className="mt-ch__calcH">
                <span>Участник</span><span>Движение</span><span>Питание</span><b>Сумма</b>
              </div>
              <div className="mt-ch__calcR mt-ch__calcR--win">
                <span>Аня</span><span>3 место</span><span>1 место</span><b>4</b>
              </div>
              <div className="mt-ch__calcR">
                <span>Игорь</span><span>1 место</span><span>5 место</span><b>6</b>
              </div>
            </div>
            <p>
              Игорь сильнее в игре, но провалил питание — и проиграл Ане, которая вытянула
              оба. <b>Четыре меньше шести, значит Аня выше.</b>
            </p>
            <p>
              Если суммы совпали, выше тот, у кого лучше место в движении: игру камера считает
              сама, и подделать её нельзя.
            </p>
          </div>

          <div className="mt-ch__rule">
            <h3 className="mt-ch__h3">Честно — значит честно</h3>
            <ul className="mt-ch__ul">
              <li>Играет <b>тот, кто зарегистрирован</b>. Подставить вместо себя другого — вылет из потока.</li>
              <li>Один аккаунт — один участник.</li>
              <li><b>Финалисты присылают видео последнего дня.</b> Не совпало с записью игры — приз уходит следующему.</li>
              <li>Если игра не смогла загрузить твой прогресс, она скажет об этом прямо на экране.</li>
            </ul>
            <div className="mt-ch__quote">Дневник питания — на твоей совести.</div>
            <p>
              Движение считает камера, обмануть её нельзя. А дневник заполняешь ты сам, и никто
              не стоит у тебя на кухне. Вписать красивые цифры может каждый — и обмануть этим
              можно только себя. Ты пришёл за своим весом и своим самочувствием через тридцать
              дней, а их никаким дневником не подделать.
            </p>
          </div>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ВОПРОСЫ ═══ */}
        <section>
          <p className="mt-ch__kicker">Частые вопросы</p>
          <h2 className="mt-ch__h2">Коротко<br />о главном</h2>
          <div className="mt-ch__faq" data-testid="challenge-faq">
            {faqList(prizePct, PRIZES_TOTAL).map(([q, a], i) => (
              <div className={`mt-ch__q ${openQ === i ? 'is-open' : ''}`} key={q}>
                <button type="button" onClick={() => setOpenQ(openQ === i ? null : i)}>
                  {q}<span aria-hidden="true">+</span>
                </button>
                <div className="mt-ch__qa"><p>{a}</p></div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-ch__sep" />

        {/* ═══ ФИНАЛ ═══ */}
        <section className="mt-ch__final" ref={endRef}>
          {readOnly ? (
            <>
              <p className="mt-ch__kicker">Ты в потоке</p>
              <h2 className="mt-ch__h2">Участник<br />№ {entry.participant_no}</h2>
              <p className="mt-ch__foot" data-testid="challenge-rules-back-note">
                Это те самые правила, с которыми ты согласился при вступлении. Вернуться в
                комнату — крестиком слева сверху.
              </p>
            </>
          ) : (
          <>
          <p className="mt-ch__kicker">Вход в поток</p>
          <h2 className="mt-ch__h2">Тридцать дней<br />начинаются <em>сейчас</em></h2>

          <div className="mt-ch__pricebox">
            <div className="mt-ch__pr">
              <b data-testid="challenge-price">{priceLabel}</b>
              <span>разовый вход<br />{season?.title ? `в ${season.title.toLowerCase()}` : 'в поток'}</span>
            </div>
            <p>{prizePct}% всех билетов уходит в призовой фонд потока.</p>
          </div>

          {/**
            * ОДНА КНОПКА НА ВСЕХ, И НИКАКОЙ АНКЕТЫ ПЕРЕД ДЕНЬГАМИ.
            *
            * Было два лишних порога, и оба стояли ДО оплаты. Гостю вместо цены
            * предлагали завести аккаунт — то есть просили заплатить вниманием
            * раньше, чем он решил, нужно ли ему это вообще. А тому, у кого не
            * заполнены данные о себе, вместо «Участвовать» показывали
            * «Заполнить данные»: форма между человеком и кнопкой оплаты убивает
            * продажу вернее любой цены.
            *
            * Теперь кнопка одна и говорит одно и то же всем: «Участвовать —
            * столько-то». Что происходит по нажатию, зависит от того, кто
            * нажал: гостю показывают предложение аккаунта (место в потоке
            * действительно держится на человеке, а не на телефоне), вошедшему —
            * оплату. Данные о себе спрашиваются ПОСЛЕ оплаты, в комнате: там
            * они и нужны, и там человек уже свой.
            */}
          <label className={`mt-ch__agree ${agreed ? 'is-on' : ''}`}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => {
                setAgreed(e.target.checked)
                // Галочка стоит под всем текстом правил: её отметили — значит
                // страницу дочитали до конца. Снятие не считаем, иначе одно
                // сомнение выглядело бы как второй прочитавший.
                if (e.target.checked) bump('ch_rules')
              }}
              data-testid="challenge-agree"
            />
            <i aria-hidden="true">{agreed ? '✓' : ''}</i>
            <span>Я прочитал правила и согласен</span>
          </label>

          <button
            type="button"
            className="mt-ch__btn"
            data-testid="challenge-join"
            disabled={!agreed || busy || (!guest && !season)}
            onClick={guest
              ? () => {
                bump('ch_join'); bump('ch_signup')
                // Ступени 3 и 4 подряд: гость нажал «Участвовать» и на этом же
                // пути упёрся в регистрацию. Порядок важен — по нему в сводке
                // видно, что стена именно здесь, а не где-то дальше.
                ступень('join-click', { гость: true })
                ступень('auth', { куда: 'регистрация' })
                onCreateAccount?.()
              }
              : () => {
                bump('ch_join')
                ступень('join-click', { гость: false })
                join()
              }}
          >
            {!guest && !season ? 'Набор пока закрыт' : busy ? 'Открываю оплату…' : `Участвовать — ${priceLabel}`}
          </button>

          {guest && (
            <p className="mt-ch__guestNote" data-testid="challenge-guest">
              Место в потоке держится на человеке, а не на телефоне: номер участника,
              результаты и призы привязываются к аккаунту. Он бесплатный и заводится за минуту.
            </p>
          )}

          {note && <p className="mt-ch__note" data-testid="challenge-note">{note}</p>}

          <p className="mt-ch__foot">
            {startDate
              ? `Старт потока — ${startDate}. Опоздал к старту — ждёшь следующий: все идут день в день.`
              : 'Дата старта будет объявлена. Все идут день в день: опоздал к старту — ждёшь следующий.'}
          </p>
          </>
          )}
        </section>
      </div>

      {/**
       * ЗАКРЕПЛЁННАЯ ШАПКА С КРЕСТИКОМ. Раньше он висел просто поверх страницы
       * и наезжал на текст при прокрутке — на призах и вопросах читать мешало
       * именно это. Теперь под ним полоса, которая гасит уезжающий текст:
       * читаемость дороже пары пикселей воздуха.
       */}
      <div className="mt-ch__top" aria-hidden="true" />

      {/* ЛИПКАЯ ПОЛОСА: появляется после первого экрана, прячется в конце.
          Гостю она такая же, как всем: он читает ту же страницу и видит ту же
          цену. Участнику её нет вовсе — покупать ему нечего. */}
      {!readOnly && (
        <div className={`mt-ch__bar ${barOn ? 'is-on' : ''}`} data-testid="challenge-bar">
          <div className="mt-ch__barPrice">{priceLabel}</div>
          <button type="button" className="mt-ch__btn" data-testid="challenge-bar-join" onClick={() => scrollTo(endRef)}>
            Участвовать
          </button>
        </div>
      )}

      {/* У участника крестик возвращает в КОМНАТУ, а не закрывает раздел: он
          пришёл сюда из неё и туда же должен вернуться. */}
      <button
        className="mt-corner mt-corner--left mt-ch__close"
        data-testid="challenge-rules-back"
        onClick={readOnly ? () => setRulesOpen(false) : onExit}
        aria-label="Назад"
      >✕</button>
    </div>
  )
}

/**
 * ПИТАНИЕ УЧАСТНИКА — три числа и ни одного лишнего.
 *
 * Считает их src/challengeNutrition.js по сырью из базы: процент за сегодня,
 * средний за поток и сколько дней вообще засчитано. Средний по потоку делится
 * на ВСЕ тридцать дней, а не на заполненные, — иначе три честных дня из
 * тридцати выглядели бы как отличный результат.
 */
function Nutrition({ rows, startsOn, hasNorm, onFillNorm }) {
  if (!Array.isArray(rows) || !rows.length) return null

  const norms = (row) => ({ kcal: row.norm_kcal, p: row.norm_p, f: row.norm_f, c: row.norm_c })
  const scores = rows.map((row) => dayScore(row, norms(row), row.meals, row.entries ?? undefined))

  const today = dayOfStream(startsOn)
  const todayRow = today && today >= 1 && today <= rows.length ? scores[today - 1] : null
  const counted = scores.filter((d) => d.counted).length
  const average = streamScore(scores, rows.length)
  const pct = (v) => `${Math.round(v)}%`

  return (
    <div className="mt-ch__nutri" data-testid="challenge-nutrition">
      <div className="mt-ch__nutriTitle">Питание</div>

      {hasNorm ? (
        <div className="mt-ch__nutriRows">
          <div className="mt-ch__nutriRow">
            <span>Сегодня</span>
            <b data-testid="nutri-today">
              {todayRow ? (todayRow.counted ? pct(todayRow.score) : `нужно ${MIN_ENTRIES} записи в ${MIN_MEALS} приёмах`) : '—'}
            </b>
          </div>
          <div className="mt-ch__nutriRow">
            <span>Средний за поток</span>
            <b data-testid="nutri-average">{pct(average)}</b>
          </div>
          <div className="mt-ch__nutriRow">
            <span>Дней с дневником</span>
            <b data-testid="nutri-days">{counted} из {rows.length}</b>
          </div>
        </div>
      ) : (
        <button type="button" className="mt-ch__btn mt-ch__btn--line" data-testid="nutri-fill" onClick={() => onFillNorm?.()}>
          Мои данные
        </button>
      )}
    </div>
  )
}

/** Какой сегодня день потока. null — даты старта нет или поток ещё не начался. */
function dayOfStream(startsOn) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startsOn || ''))
  if (!m) return null
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = Math.round((today - start) / 86400000) + 1
  return day >= 1 ? day : null
}

/** Шаг «как это работает»: номер, заголовок, текст и снимок экрана. */
function Step({ n, title, text, image, alt, caption }) {
  return (
    <div className="mt-ch__step">
      <div className="mt-ch__stepN">{n}</div>
      <h3 className="mt-ch__h3">{title}</h3>
      <p>{text}</p>
      <Shot image={image} alt={alt} caption={caption} />
    </div>
  )
}

/**
 * Снимок экрана в полный рост телефона (9:17). Файла может не быть — тогда
 * остаётся тёмная плашка с подписью, и страница не разъезжается.
 */
function Shot({ image, alt, caption }) {
  return (
    <div className="mt-ch__shot">
      <img
        src={image}
        alt={alt}
        loading="lazy"
        decoding="async"
        data-testid="challenge-shot"
        onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
      />
      <div className="mt-ch__shotCap">{caption}</div>
    </div>
  )
}

/** Вопросы. Числа подставляются из сезона и призов — чтобы не разъехаться. */
const faqList = (prizePct, prizesTotal) => [
  ['Я вообще не спортивный. Потяну?',
    'Для этого есть уровень НОВИЧОК: мишень крупная и висит долго. Первые дни лёгкие, нагрузка растёт постепенно — тридцать дней на то и рассчитаны.'],
  ['Мне за сорок, спина и колени. Можно?',
    'Движения без прыжков со штангой и без ударной работы на суставы, темп ты выбираешь сам. Но если есть диагноз или боль — сначала спроси своего врача, а не меня.'],
  ['Нужен зал или инвентарь?',
    'Нет. Телефон, два метра свободного пола и свет спереди. Всё.'],
  ['А если пропущу день?',
    'За этот день ноль, и вернуться к нему нельзя — поток идёт по календарю у всех одинаково. Один пропуск челлендж не рушит, но каждый следующий стоит места в таблице.'],
  ['Это подписка? Спишется ещё раз?',
    'Нет. Разовый вход в один поток: заплатил один раз, прошёл тридцать дней. Ничего не продлевается само.'],
  ['Каким будет призовой фонд?',
    `Две части. Первая — призы на ${money(prizesTotal)}, они гарантированы и не зависят от числа участников: VIP-пакет победителю — месяц тренировок со мной по видеосвязи, второму и третьему — месяцы тарифа ПРЕМИУМ. Вторая часть — деньги: ${prizePct}% каждого проданного билета, делится между теми же тремя. Итоговую денежную сумму объявляю в день старта, когда набор закрыт.`],
  ['А что делать до старта потока?',
    'Челлендж откроется в день старта — до этого его дни закрыты у всех одинаково. Но само приложение тебе уже доступно: тренировки, программы, дневник питания. Заполни данные о себе и втягивайся, к старту будешь готов.'],
  ['Обязательно вести дневник питания?',
    'Обязательно, если борешься за приз: питание — половина зачёта. Тренироваться можно и без него, но место в таблице будет ниже.'],
]
