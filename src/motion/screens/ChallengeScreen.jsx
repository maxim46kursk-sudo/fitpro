import { useState } from 'react'
import { DAYS, FREE_DAYS } from '../game/challenge.js'

/**
 * ЧЕЛЛЕНДЖ: ЧТО ЭТО И КАК В НЕГО ПОПАСТЬ.
 *
 * Один экран на два разных разговора, и это намеренно. Пока человек не в
 * потоке, разговор один — что это за тридцать дней, сколько стоит место и как
 * считается призовой фонд. Как только он в потоке, разговор становится
 * другим — какой у него номер, когда старт, какой сегодня день, — а прежний
 * теряет смысл целиком. Два экрана здесь означали бы две двери к одному и тому
 * же, и человек, оплативший билет, продолжал бы натыкаться на предложение
 * купить.
 *
 * ЭКРАН НИЧЕГО НЕ ЗНАЕТ ПРО СЕТЬ. Участие приезжает пропсом (src/challengeSeason.js),
 * покупка уходит колбэком. Причина не в чистоте, а в проверяемости: «что видит
 * не участник», «что видит участник» и «что видит гость» — это три вопроса к
 * разметке, и отвечать на них должно без поднятого supabase.
 *
 * ГОСТЬ ВИДИТ ВСЁ, КРОМЕ КНОПКИ ОПЛАТЫ. Цена и правило фонда от него не
 * прячутся — это ровно тот довод, ради которого он сюда и заглянул, и тем же
 * правилом живёт экран тарифов (PlansView в App.jsx). Меняется одна кнопка:
 * купить билет он всё равно не может (платёж привязывается к аккаунту), и форма
 * оплаты была бы обещанием, которое некому исполнить. Его первый шаг —
 * бесплатный аккаунт, об этом кнопка и говорит.
 */

/**
 * @param {{season: object, entry: object|null}|null} [props.state] участие:
 *   null — живого потока нет вовсе (или прочитать не удалось).
 * @param {boolean} [props.guest] гость без аккаунта.
 * @param {number} [props.day] текущий день челленджа у этого человека.
 * @param {() => Promise<{ok?: true, already?: true, error?: string}>} [props.onBuy]
 * @param {() => void} [props.onCreateAccount] гость нажал «Создать аккаунт».
 * @param {() => void} [props.onRefresh] перечитать участие (после «уже участник»).
 * @param {(opts: {gate: boolean}) => void} [props.onRules] открыть правила.
 *   gate — первое чтение, с галочкой и кнопкой вступления в конце.
 * @param {boolean} [props.loading] участие ещё читается с сервера.
 */
export default function ChallengeScreen({
  state = null,
  guest = false,
  day = 1,
  days = DAYS,
  onBuy = null,
  onCreateAccount = null,
  onRefresh = null,
  onRules = null,
  loading = false,
  onExit = null,
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const season = state?.season || null
  const entry = state?.entry || null
  /**
   * ПРАВИЛА ПЕРЕД ПОКУПКОЙ — ОБЯЗАТЕЛЬНО, И ЭТО НЕ ФОРМАЛЬНОСТЬ. Спор о призах
   * упирается в «я не знал правил», а там и вылет за подставного человека, и
   * ноль за пропущенный день, и требование прислать видео последнего дня.
   * Поэтому не прочитавшему кнопка ведёт не в оплату, а в правила: заплатить,
   * не увидев их, отсюда нельзя.
   */
  const accepted = !!state?.rulesAcceptedAt

  const buy = async () => {
    if (busy || !onBuy) return
    setBusy(true)
    setNote('')
    const result = await onBuy()
    setBusy(false)
    if (result?.already) {
      // Сервер знает про участие больше, чем экран: он смотрит в базу в момент
      // нажатия. Значит правы не мы — перечитываем и показываем номер.
      setNote('Ты уже участник этого потока')
      onRefresh?.()
      return
    }
    if (result?.error) setNote(result.error)
  }

  return (
    <div className="mt-screen mt-screen--challenge" data-testid="challenge-screen">
      <div className="mt-rest__veil" aria-hidden="true" />

      <h1 className="mt-title">{entry ? 'Ты в потоке' : 'Челлендж 30 дней'}</h1>

      {/* Пока участие читается, молчим: показать «набор закрыт» человеку,
          который час назад купил билет, хуже, чем показать ожидание. */}
      {loading && (
        <div className="mt-ch__closed" data-testid="challenge-loading">
          Смотрю, что с потоком…
        </div>
      )}

      {/* ── УЧАСТНИК: номер, имя, старт, день ─────────────────────────────── */}
      {!loading && entry && (
        <div className="mt-ch__card" data-testid="challenge-member">
          <div className="mt-ch__no" data-testid="challenge-number">
            №{entry.participant_no}
          </div>
          <div className="mt-ch__name" data-testid="challenge-name">
            {entry.display_name}
          </div>
          <div className="mt-ch__season">{season?.title}</div>

          {/**
           * ДАТА СТАРТА ОБЪЯВЛЯЕТСЯ ПОЗЖЕ НАБОРА, и пустое поле здесь — не
           * недоделка, а состояние потока. Молчать о ней нельзя: человек
           * заплатил и первым делом спрашивает «когда начинаем».
           */}
          <div className="mt-ch__start" data-testid="challenge-start">
            {season?.starts_on ? `Старт ${formatDate(season.starts_on)}` : 'Дата старта будет объявлена'}
          </div>

          <div className="mt-ch__day" data-testid="challenge-day">
            День {Math.min(days, Math.max(1, day))} из {days}
          </div>
        </div>
      )}

      {/* ── НЕ УЧАСТНИК: что это, почём и что в фонде ─────────────────────── */}
      {!loading && !entry && (
        <div className="mt-ch__about" data-testid="challenge-about">
          <ul className="mt-ch__list">
            <li>{days} дней подряд: каждый день своя тренировка, план ведёт сам</li>
            <li>Поток стартует у всех в один день — идём вместе, а не кто когда</li>
            <li>До трёх попыток на уровень в день, в зачёт идёт лучшая</li>
            <li>Первые {FREE_DAYS} дней открыты всем и без билета</li>
          </ul>

          {season && (
            <>
              <div className="mt-ch__price" data-testid="challenge-price">
                {season.price_rub} ₽
                <span> — место в потоке «{season.title}»</span>
              </div>
              <div className="mt-ch__prize" data-testid="challenge-prize">
                В призовой фонд идёт {season.prize_pct}% сборов — он делится между тремя лучшими
                {Array.isArray(season.prize_split) && season.prize_split.length > 0
                  ? ` (${season.prize_split.join(' / ')}%)`
                  : ''}
                .
              </div>
            </>
          )}

          {/**
           * ЖИВОГО ПОТОКА НЕТ — говорим прямо. Кнопка «купить» в этот момент
           * вела бы к оплате места, которого ещё не существует.
           */}
          {!season && !guest && (
            <div className="mt-ch__closed" data-testid="challenge-closed">
              Набор в поток пока закрыт. Открытие объявим — первые {FREE_DAYS} дней доступны и
              сейчас.
            </div>
          )}

          {guest ? (
            <>
              <div className="mt-ch__closed" data-testid="challenge-guest">
                Участие идёт в зачёт только с аккаунтом: номер участника, результаты и призы
                привязаны к человеку, а не к телефону. Аккаунт бесплатный.
              </div>
              <button
                type="button"
                className="mt-button"
                data-testid="challenge-signup"
                onClick={() => onCreateAccount?.()}
              >
                Создать аккаунт
              </button>
            </>
          ) : (
            season && (accepted ? (
              <button
                type="button"
                className="mt-button"
                data-testid="challenge-buy"
                disabled={busy}
                onClick={buy}
              >
                {busy ? 'Открываю оплату…' : 'Купить билет'}
              </button>
            ) : (
              <button
                type="button"
                className="mt-button"
                data-testid="challenge-read-rules"
                onClick={() => onRules?.({ gate: true })}
              >
                Правила и вступление
              </button>
            ))
          )}
        </div>
      )}

      {note && (
        <div className="mt-ch__note" data-testid="challenge-note">
          {note}
        </div>
      )}

      {/* ПЕРЕЧИТАТЬ ПРАВИЛА можно всегда и свободно: участник приходит сюда за
          конкретным ответом («что там про пропущенный день?»), и требовать от
          него снова листать двенадцать экранов было бы издевательством. */}
      {onRules && (
        <button
          type="button"
          className="mt-levels__room"
          data-testid="challenge-rules"
          onClick={() => onRules({ gate: false })}
        >
          Правила челленджа
        </button>
      )}

      <button className="mt-corner mt-corner--left" onClick={onExit} aria-label="Назад">
        ✕
      </button>
    </div>
  )
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/**
 * Дата вида «1 сентября». Руками, а не через toLocaleDateString: раздел живёт
 * в том числе внутри Telegram на телефонах, где набор локалей урезан, и там
 * человек увидел бы «9/1/2026».
 */
function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''))
  if (!m) return String(value || '')
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month}` : String(value)
}
