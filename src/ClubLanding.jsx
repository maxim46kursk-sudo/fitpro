import { useEffect } from 'react'
import hero from './assets/zmclub-hero.jpg'
import { track } from './track.js'
import { BG, SURF, HAIR, PUR, ACCENT2 } from './theme.js'

/**
 * ЛЕНДИНГ ZMCLUB — первый экран гостя (сент 2026, заменил WelcomeSheet).
 *
 * Перенос лендинга с Taplink с правками: пробный = первые 7 дней ПОСЛЕ оплаты
 * с возвратом денег (не бесплатный); эфиров нет; «разбор техники» — это
 * упражнения, отобранные по миографу; цели не только женские. Кнопка и цена —
 * уже на первом экране: с лендинга челленджа 35 из 49 уходили, не долистав.
 *
 * onJoin — к оплате (экран «Вступить в клуб»), onLook — закрыть и гулять по
 * приложению гостем. Оба помечают приветствие увиденным (см. App).
 */

// Палитра — та же, что внутри приложения (theme.js): лендинг и клуб выглядят
// одним продуктом. RED оставлен именем «акцент», чтобы не трогать разметку.
const RED = ACCENT2
const INK = BG
const CARD = SURF
const LINE = HAIR
const T2 = 'rgba(255,255,255,0.72)'
const T3 = 'rgba(255,255,255,0.45)'

const INSIDE = [
  ['Программы тренировок', 'Зал и дом, для девушек и для мужчин. Вес и подходы приложение подбирает само — по твоей оценке нагрузки после каждой тренировки.'],
  ['Упражнения по миографу', 'Каждое упражнение отобрано по показаниям миографа: видео техники и объяснение простыми словами.'],
  ['Питание', 'Норма КБЖУ под твою цель, готовые рационы из обычных продуктов и дневник питания. Без чудо-диет и «суперфудов».'],
  ['Чат клуба', 'Делишься видео своих подходов — я подсказываю, как улучшить технику и эффективность.'],
  ['ZMClub Motion', 'Тренировка-игра с камерой телефона: считает повторения и ставит очки.'],
]

const GOALS = [
  ['Похудеть', 'Давая телу именно ту нагрузку, которая эффективнее всего сжигает жир. Наука, а не предположения.'],
  ['Накачать ягодицы', 'Не 100 произвольных махов, а 3–4 ключевых движения, которые по данным миографа дают пиковую активацию.'],
  ['Набрать массу', 'Сплит на базовых движениях: не больше пяти упражнений за тренировку и понятная прогрессия весов.'],
]

// ⚠ Строка «обратная связь в чате» — цена-заглушка, согласовать с Максимом.
const VALUE = [
  ['Программы, созданные на основе анализа миографии', '14 000 ₽'],
  ['Библиотека упражнений с разбором техники по миографу', '6 000 ₽'],
  ['Норма питания и готовые рационы', '4 000 ₽'],
  ['Обратная связь по технике в чате клуба', '8 000 ₽ / мес'],
  ['Шанс выиграть 3 персональные тренировки (анализ, работа над слабыми звеньями)', '12 000 ₽'],
]
const VALUE_TOTAL = '44 000 ₽'

// Фото «до/после» — оригиналы с Taplink, скачаны в public/club/results.
const RESULTS = [1, 2, 3, 4, 5, 6].map(n => `/club/results/${n}.jpg`)

// Отзывы — дословно со скринов на Taplink (реальные участницы, сент 2026).
const REVIEWS = [
  ['Алина', 'Блин, Макс, эта твоя «Румынская» — просто кайф! Спина перестала болеть, а попа через месяц выросла на 2 см. Ты гений 💥'],
  ['Адель', 'Макс, реально не ожидала такого эффекта от твоих программ. Занимаюсь по «Сплиту» всего 2 месяца, а уже друзья спрашивают, готовлюсь к соревнованиям? Понимаю, что это комплимент твоей работе, а не только моим усилиям. Спасибо за каждую правку в технике — ты всегда замечаешь то, что я сама не вижу!'],
  ['Евгения', 'Твой разбор моей становой в сторис пересмотрела 10 раз 😱. Оказывается, я всё делала через спину. Исправила по твоим советам — на следующий день я узнала, что такое ягодицы 💪! Это было лучшим доказательством, что теперь я делаю всё правильно. Спасибо за такие детальные объяснения 🤞!'],
  ['Санечка', 'Сидела на твоём рационе 56 — 60 кг — и это первая диета, где я не срывалась. Да ещё и ПП-шаурму ела! Минус 4 кг за месяц, я в шоке 😱'],
  ['Ольга Сергеевна', 'Макс, спасибо за всё 🙏. За программы, которые работают, за питание, которое не истощает, и за то, что всегда на связи. Чувствую, что наконец-то нашла то, что искала все эти годы.'],
  ['Тетя Люба', 'Купила клуб, потому что надоело самой искать инфу. Оказалось, здесь всё уже собрано, разжёвано и под меня настроено. Ты экономишь мне кучу времени и нервов. Особенно ценю, что отвечаешь быстро, даже на глупые вопросы 🤗'],
  ['Даша', '1000₽ в месяц — это дёшево даже для одной программы. А тут их сколько… 👏👏👏'],
]
const h2 = { fontSize: 24, fontWeight: 900, lineHeight: 1.15, letterSpacing: '-0.3px', textTransform: 'uppercase', margin: '0 0 18px', color: '#fff' }
const card = { background: CARD, border: `1px solid ${LINE}`, borderRadius: 16, padding: '15px 16px' }
const btn = {
  display: 'block', width: '100%', padding: '17px 18px', borderRadius: 999, border: 'none', cursor: 'pointer',
  background: `linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color: '#fff',
  fontSize: 16, fontWeight: 900, letterSpacing: '0.3px', textTransform: 'uppercase',
  boxShadow: `0 10px 32px ${PUR}55`, minHeight: 'unset',
}
const ghost = {
  display: 'block', width: '100%', padding: '14px 18px', borderRadius: 999, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)', color: '#fff',
  fontSize: 15, fontWeight: 700, minHeight: 'unset', marginTop: 10,
}

export default function ClubLanding({ onJoin, onLook }) {
  useEffect(() => { track('screen', { name: 'club_landing' }, '/club') }, [])
  const join = () => { track('screen', { name: 'club_join' }, '/club'); onJoin() }
  const look = () => { track('screen', { name: 'club_look' }, '/club'); onLook() }

  return (
    <div data-testid="club-landing" style={{
      position: 'fixed', inset: 0, zIndex: 3000, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
      background: `radial-gradient(140% 520px at 50% 0%, ${PUR}40 0%, transparent 100%) no-repeat, ${INK}`, color: '#fff',
      fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', textAlign: 'left',
    }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '0 16px 40px' }}>

        {/* ── Первый экран: фото, обещание, цена и кнопка */}
        <div style={{ position: 'relative', margin: '16px 0 0', borderRadius: 26, overflow: 'hidden', background: '#000' }}>
          <img src={hero} alt="Максим Завалишин" style={{ display: 'block', width: '100%', height: 'auto' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.92) 88%)' }} />
          <div style={{ position: 'absolute', top: 22, left: 20, right: 20 }}>
            <div style={{ fontSize: 30, fontWeight: 900, color: RED, letterSpacing: '0.5px' }}>ZM CLUB</div>
            <div style={{ fontSize: 17, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Максим Завалишин</div>
          </div>
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
            <div style={{ fontSize: 25, fontWeight: 900, color: RED, lineHeight: 1.1, textTransform: 'uppercase', marginBottom: 10 }}>
              Тренируйся не на глазок, а по научным данным
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.45, color: '#fff', textTransform: 'uppercase' }}>
              Единственный клуб, где каждая программа и упражнение отобраны по показаниям миографа
            </div>
          </div>
        </div>

        <div style={{ textAlign: 'center', margin: '18px 0 14px' }}>
          <span style={{ fontSize: 30, fontWeight: 900 }}>1 000 ₽</span>
          <span style={{ fontSize: 15, color: T2 }}> / месяц</span>
          <div style={{ fontSize: 13, color: T2, marginTop: 4 }}>Первые 7 дней — с гарантией возврата денег</div>
        </div>
        <button data-testid="club-join-top" onClick={join} style={btn}>Хочу 7 дней пробного периода</button>
        <button data-testid="club-look" onClick={look} style={ghost}>Посмотреть клуб изнутри</button>
        <div style={{ fontSize: 12, color: T3, textAlign: 'center', marginTop: 8 }}>Без регистрации: программы, упражнения, питание</div>

        {/* ── Что внутри */}
        <div style={{ marginTop: 44 }}>
          <h2 style={h2}>Что внутри <span style={{ color: RED }}>ZM Club</span></h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {INSIDE.map(([t, d]) => (
              <div key={t} style={card}>
                <div style={{ fontSize: 15, fontWeight: 800, textTransform: 'uppercase', marginBottom: 5 }}>{t}</div>
                <div style={{ fontSize: 13.5, color: T2, lineHeight: 1.5 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Для кого */}
        <div style={{ marginTop: 44 }}>
          <h2 style={{ ...h2, color: RED }}>Это для тебя, если ты хочешь результат, а не протоколы</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {GOALS.map(([t, d]) => (
              <div key={t} style={{ borderLeft: `3px solid ${RED}`, paddingLeft: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: RED, textTransform: 'uppercase', marginBottom: 4 }}>{t}</div>
                <div style={{ fontSize: 14, color: T2, lineHeight: 1.5 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Стоимость по отдельности */}
        <div style={{ marginTop: 44 }}>
          <h2 style={h2}>Давай оценим этот подход в деньгах по отдельности</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {VALUE.map(([t, p]) => (
              <div key={t} style={{ ...card, padding: '12px 14px' }}>
                <div style={{ fontSize: 13.5, color: '#fff', lineHeight: 1.45 }}>{t}</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: RED, marginTop: 4 }}>{p}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 18, fontWeight: 900, textTransform: 'uppercase', marginTop: 16, lineHeight: 1.3 }}>
            Итого по отдельности: ~<span style={{ color: RED }}>{VALUE_TOTAL}</span>
          </div>
        </div>

        {/* ── Почему 1000 ₽ */}
        <div style={{ marginTop: 44 }}>
          <h2 style={{ ...h2, textAlign: 'center' }}>Почему я даю доступ к своей методике за <span style={{ color: RED }}>1 000 ₽?</span></h2>
          <div style={{ fontSize: 14.5, color: T2, lineHeight: 1.55, textAlign: 'center', marginBottom: 14 }}>
            Потому что я продаю не свои часы, а свою систему. Мой капитал — это экспертиза, подтверждённая аппаратурой.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={card}>
              <div style={{ fontSize: 14, fontWeight: 900, textTransform: 'uppercase', marginBottom: 6 }}>Экономика сообщества</div>
              <div style={{ fontSize: 13.5, color: T2, lineHeight: 1.5 }}>Я создаю не разовых клиентов, а сообщество, которое растёт и показывает результаты. Ваши трансформации — моё лучшее доказательство и реклама.</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 14, fontWeight: 900, textTransform: 'uppercase', marginBottom: 6 }}>Инвестиция в будущих чемпионов</div>
              <div style={{ fontSize: 13.5, color: T2, lineHeight: 1.5 }}>Самые активные участники (из них мы выбираем победителей розыгрыша) — будущие герои моих кейсов и амбассадоры клуба.</div>
            </div>
          </div>
        </div>

        {/* ── Результаты и отзывы. Только настоящие участницы (подтвердил Максим);
            фото лежат в public/club/results, текст отзывов перенесён с Taplink. */}
        <div style={{ marginTop: 44 }}>
          <h2 style={h2}>Результаты участниц</h2>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x mandatory', margin: '0 -16px', padding: '0 16px 6px', scrollbarWidth: 'none' }}>
            {RESULTS.map(src => (
              <img key={src} src={src} alt="До и после" loading="lazy"
                onError={e => { e.currentTarget.style.display = 'none' }}
                style={{ flex: '0 0 78%', maxWidth: 360, aspectRatio: '9 / 16', objectFit: 'cover', borderRadius: 18, scrollSnapAlign: 'center', background: CARD }} />
            ))}
          </div>
          <div style={{ fontSize: 12, color: T3, marginTop: 6 }}>Листай вбок →</div>

          <h2 style={{ ...h2, marginTop: 34 }}>Что говорят участницы</h2>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x mandatory', margin: '0 -16px', padding: '0 16px 6px', scrollbarWidth: 'none' }}>
            {REVIEWS.map(([name, text]) => (
              <div key={name} style={{ ...card, flex: '0 0 82%', maxWidth: 380, scrollSnapAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: RED, marginBottom: 6 }}>{name}</div>
                <div style={{ fontSize: 15, lineHeight: 1.5 }}>«{text}»</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: T3, marginTop: 6 }}>Листай вбок →</div>
        </div>

        {/* ── Гарантия и финальная кнопка */}
        <div style={{ marginTop: 44, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 900, textTransform: 'uppercase', marginBottom: 12 }}>Пробный период начинается здесь</div>
          <div style={{ fontSize: 15, color: T2, lineHeight: 1.55, marginBottom: 22 }}>
            Первые 7 дней после оплаты — твой полный тест-драйв клуба. Не понравится — вернём деньги.
          </div>
          <div style={{ fontSize: 17, fontWeight: 900, textTransform: 'uppercase', marginBottom: 18, lineHeight: 1.35 }}>
            <span style={{ color: RED }}>ZM Club</span> — для тех, кто хочет тренироваться по науке и видеть результат без срывов и голодовок
          </div>
          <button data-testid="club-join-bottom" onClick={join} style={btn}>Вступить в клуб · 1 000 ₽</button>
          <button onClick={look} style={ghost}>Сначала посмотреть изнутри</button>
        </div>

        {/* ── Реквизиты — нужны для приёма оплаты */}
        <div style={{ marginTop: 44, fontSize: 12.5, color: T3, lineHeight: 1.7 }}>
          Завалишин Максим Игоревич<br />
          ИНН 463227811939<br />
          e-mail: maxim-46kursk@mail.ru
        </div>
      </div>
    </div>
  )
}
