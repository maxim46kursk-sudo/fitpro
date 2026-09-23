import { useEffect, useRef, useState } from 'react'
import hero from './assets/zmclub-hero.jpg'
import { track } from './track.js'
import { BG, SURF, HAIR, PUR, ACCENT2 } from './theme.js'

/**
 * ЛЕНДИНГ ZMCLUB — первый экран гостя (сент 2026, заменил WelcomeSheet).
 *
 * Перенос лендинга с Taplink с правками: пробный = первые 7 дней ПОСЛЕ оплаты
 * с возвратом денег (не бесплатный); эфиров и розыгрыша нет; «разбор техники» —
 * это упражнения, отобранные по миографу; цели не только женские. Кнопка и
 * цена — уже на первом экране: с лендинга челленджа 35 из 49 уходили, не
 * долистав.
 *
 * Движение (по просьбе Максима — «статичная страница выглядит дёшево»): всё на
 * CSS + IntersectionObserver, без библиотек. При «уменьшить движение» в
 * настройках телефона анимации выключаются целиком.
 *
 * onJoin — к оплате (экран «Вступить в клуб»), onLook — закрыть и гулять по
 * приложению гостем. Оба помечают приветствие увиденным (см. App).
 */

// Палитра — та же, что внутри приложения (theme.js).
const ACC = ACCENT2
const T2 = 'rgba(255,255,255,0.72)'
const T3 = 'rgba(255,255,255,0.45)'

const INSIDE = [
  ['Программы тренировок', 'Зал и дом, для девушек и для мужчин. Ассистент помогает подбирать веса к следующим тренировкам — по твоей оценке нагрузки после каждой тренировки.'],
  ['Упражнения по миографу', 'Каждое упражнение отобрано по показаниям миографа: видео техники и объяснение простыми словами.'],
  ['Питание', 'Норма КБЖУ под твою цель, готовые рационы из обычных продуктов и дневник питания. Без чудо-диет и «суперфудов».'],
  ['Чат клуба', 'Делишься видео своих подходов — я подсказываю, как улучшить технику и эффективность.'],
  ['ZMClub Motion', 'Тренировка-игра с камерой телефона: считает повторения и ставит очки. Отлично заменяет кардиотренажёры.'],
]

const GOALS = [
  ['Похудеть', 'Давая телу именно ту нагрузку, которая эффективнее всего сжигает жир. Наука, а не предположения.'],
  ['Накачать ягодицы', 'Не 100 произвольных махов, а 3–4 ключевых движения, которые по данным миографа дают пиковую активацию.'],
  ['Набрать массу', 'Сплит на базовых движениях: не больше пяти упражнений за тренировку и понятная прогрессия весов.'],
]

// [название, цена ₽, в месяц?]
const VALUE = [
  ['Программы, созданные на основе анализа миографии', 14000, false],
  ['Библиотека упражнений с разбором техники по миографу', 6000, false],
  ['Норма питания и готовые рационы', 4000, false],
  ['Обратная связь по технике в чате клуба', 8000, true],
]
const VALUE_TOTAL = VALUE.reduce((s, v) => s + v[1], 0)

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

const rub = n => n.toLocaleString('ru-RU').replace(/\s/g, ' ') + ' ₽'

const CSS = `
.zl{--acc:${ACC};--pur:${PUR}}
.zl *{box-sizing:border-box}
.zl h2{font-size:24px;font-weight:900;line-height:1.15;letter-spacing:-.3px;text-transform:uppercase;margin:0 0 18px;color:#fff}
.zl .card{background:${SURF};border:1px solid ${HAIR};border-radius:16px;padding:15px 16px;position:relative;overflow:hidden}
/* фон: два медленно плавающих пятна */
.zl-orb{position:fixed;border-radius:50%;filter:blur(60px);pointer-events:none;z-index:0;opacity:.55}
.zl-orb.a{width:340px;height:340px;background:${PUR};top:-120px;left:-80px;animation:zlFloatA 14s ease-in-out infinite alternate}
.zl-orb.b{width:300px;height:300px;background:#4d47b0;top:40%;right:-140px;opacity:.35;animation:zlFloatB 18s ease-in-out infinite alternate}
@keyframes zlFloatA{to{transform:translate(90px,120px) scale(1.15)}}
@keyframes zlFloatB{to{transform:translate(-80px,-160px) scale(.9)}}
/* первый экран */
.zl-hero img{animation:zlKen 16s ease-out both}
@keyframes zlKen{from{transform:scale(1.14)}to{transform:scale(1)}}
.zl-in{opacity:0;transform:translateY(18px);animation:zlUp .8s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes zlUp{to{opacity:1;transform:none}}
.zl-grad{background:linear-gradient(90deg,#fff 0%,var(--acc) 35%,#fff 60%,var(--acc) 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:zlSheen 6s linear infinite}
@keyframes zlSheen{to{background-position:-250% 0}}
/* кнопка: пульс свечения + блик */
.zl-btn{position:relative;overflow:hidden;display:block;width:100%;padding:17px 18px;border-radius:999px;border:none;cursor:pointer;background:linear-gradient(180deg,${ACCENT2},${PUR});color:#fff;font-size:16px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;min-height:unset;animation:zlPulse 2.6s ease-in-out infinite;transition:transform .15s}
.zl-btn:active{transform:scale(.97)}
.zl-btn::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-20deg);animation:zlShine 3.2s ease-in-out infinite}
@keyframes zlPulse{0%,100%{box-shadow:0 8px 26px ${PUR}55}50%{box-shadow:0 10px 44px ${PUR}aa}}
@keyframes zlShine{0%,55%{left:-60%}100%{left:130%}}
.zl-ghost{display:block;width:100%;padding:14px 18px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.04);color:#fff;font-size:15px;font-weight:700;min-height:unset;margin-top:10px;transition:background .2s,transform .15s}
.zl-ghost:active{transform:scale(.97);background:rgba(255,255,255,.1)}
/* появление при прокрутке */
.zl-r{opacity:0;transform:translateY(28px) scale(.98);transition:opacity .7s cubic-bezier(.2,.8,.2,1),transform .7s cubic-bezier(.2,.8,.2,1);transition-delay:var(--d,0ms)}
.zl-r.on{opacity:1;transform:none}
.zl-r.card::before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,transparent 30%,${PUR}33 50%,transparent 70%);transform:translateX(-120%)}
.zl-r.card.on::before{animation:zlSweep 1.2s ease-out forwards;animation-delay:calc(var(--d,0ms) + 250ms)}
@keyframes zlSweep{to{transform:translateX(120%)}}
/* цели: полоса слева «прорастает» */
.zl-goal{position:relative;padding-left:16px}
.zl-goal::before{content:"";position:absolute;left:0;top:0;width:3px;height:100%;background:linear-gradient(${ACC},${PUR});border-radius:3px;transform:scaleY(0);transform-origin:top;transition:transform .8s cubic-bezier(.2,.8,.2,1);transition-delay:calc(var(--d,0ms) + 150ms)}
.zl-goal.on::before{transform:scaleY(1)}
/* карусели */
.zl-row{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;margin:0 -16px;padding:0 16px 6px;scrollbar-width:none}
.zl-row::-webkit-scrollbar{display:none}
.zl-dots{display:flex;gap:6px;justify-content:center;margin-top:10px}
.zl-dots i{width:6px;height:6px;border-radius:3px;background:rgba(255,255,255,.25);transition:width .3s,background .3s}
.zl-dots i.on{width:18px;background:var(--acc)}
/* липкая кнопка снизу */
.zl-sticky{position:fixed;left:0;right:0;bottom:0;z-index:5;padding:10px 16px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(180deg,transparent,${BG} 40%);transform:translateY(110%);transition:transform .45s cubic-bezier(.2,.8,.2,1)}
.zl-sticky.show{transform:none}
@media (prefers-reduced-motion: reduce){
  .zl *,.zl *::before,.zl *::after{animation:none!important;transition:none!important}
  .zl-r,.zl-in{opacity:1!important;transform:none!important}
  .zl-goal::before{transform:none!important}
}
`

/** Число «набегает» от 0 до value, когда блок попал в экран. */
function CountUp({ value, on, suffix = '' }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!on) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setN(value); return }
    let raf, t0
    const step = t => {
      if (t0 === undefined) t0 = t
      const k = Math.min(1, (t - t0) / 1100)
      setN(Math.round(value * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [on, value])
  return <>{rub(n)}{suffix}</>
}

/** Карусель: сама листается раз в 4 с, пока человек её не тронул. */
function Carousel({ children, count }) {
  const ref = useRef(null)
  const [idx, setIdx] = useState(0)
  const touched = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const kids = [...el.children]
      const mid = el.scrollLeft + el.clientWidth / 2
      let best = 0, bd = Infinity
      kids.forEach((k, i) => { const c = k.offsetLeft + k.offsetWidth / 2; const d = Math.abs(c - mid); if (d < bd) { bd = d; best = i } })
      setIdx(best)
    }
    const stop = () => { touched.current = true }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', stop, { passive: true })
    el.addEventListener('pointerdown', stop)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const iv = reduce ? null : setInterval(() => {
      if (touched.current || !el.isConnected) return
      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return
      const kids = [...el.children].filter(k => k.offsetParent !== null)
      if (!kids.length) return
      const cur = kids.findIndex(k => k.offsetLeft + k.offsetWidth / 2 > el.scrollLeft + el.clientWidth / 2 - 5)
      const next = kids[(cur + 1) % kids.length]
      el.scrollTo({ left: next.offsetLeft - 16, behavior: 'smooth' })
    }, 4000)
    return () => { el.removeEventListener('scroll', onScroll); el.removeEventListener('touchstart', stop); el.removeEventListener('pointerdown', stop); if (iv) clearInterval(iv) }
  }, [])
  return (
    <>
      <div ref={ref} className="zl-row">{children}</div>
      <div className="zl-dots">{Array.from({ length: count }, (_, i) => <i key={i} className={i === idx ? 'on' : ''} />)}</div>
    </>
  )
}

export default function ClubLanding({ onJoin, onLook }) {
  const rootRef = useRef(null)
  const topBtnRef = useRef(null)
  const endRef = useRef(null)
  const valueRef = useRef(null)
  const [valueOn, setValueOn] = useState(false)
  const [sticky, setSticky] = useState(false)

  useEffect(() => { track('screen', { name: 'club_landing' }, '/club') }, [])
  const join = () => { track('screen', { name: 'club_join' }, '/club'); onJoin() }
  const look = () => { track('screen', { name: 'club_look' }, '/club'); onLook() }

  // Появление блоков при прокрутке + запуск счётчика цены + липкая кнопка.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const els = root.querySelectorAll('.zl-r')
    if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('on')); setValueOn(true); return }
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('on'); io.unobserve(e.target) } })
    }, { root, threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
    els.forEach(e => io.observe(e))

    const vio = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setValueOn(true); vio.disconnect() } }, { root, threshold: 0.4 })
    if (valueRef.current) vio.observe(valueRef.current)

    // Липкая кнопка: видна, когда верхняя кнопка уехала вверх, а нижняя ещё не видна.
    const vis = { top: true, end: false }
    const sio = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.target === topBtnRef.current) vis.top = e.isIntersecting || e.boundingClientRect.top > 0
        if (e.target === endRef.current) vis.end = e.isIntersecting
      })
      setSticky(!vis.top && !vis.end)
    }, { root, threshold: 0 })
    if (topBtnRef.current) sio.observe(topBtnRef.current)
    if (endRef.current) sio.observe(endRef.current)
    return () => { io.disconnect(); vio.disconnect(); sio.disconnect() }
  }, [])

  const d = i => ({ '--d': `${i * 90}ms` })

  return (
    <div ref={rootRef} data-testid="club-landing" className="zl" style={{
      position: 'fixed', inset: 0, zIndex: 3000, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch',
      background: BG, color: '#fff',
      fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', textAlign: 'left',
    }}>
      <style>{CSS}</style>
      <div className="zl-orb a" />
      <div className="zl-orb b" />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 520, margin: '0 auto', padding: '0 16px 96px' }}>

        {/* ── Первый экран: фото, обещание, цена и кнопка */}
        <div className="zl-hero" style={{ position: 'relative', margin: '16px 0 0', borderRadius: 26, overflow: 'hidden', background: '#000', boxShadow: `0 20px 60px ${PUR}33` }}>
          <img src={hero} alt="Максим Завалишин" style={{ display: 'block', width: '100%', height: 'auto' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.92) 88%)' }} />
          <div style={{ position: 'absolute', top: 22, left: 20, right: 20 }}>
            <div className="zl-in" style={{ fontSize: 30, fontWeight: 900, letterSpacing: '0.5px', animationDelay: '.1s' }}><span className="zl-grad">ZM CLUB</span></div>
            <div className="zl-in" style={{ fontSize: 17, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', animationDelay: '.25s' }}>Максим Завалишин</div>
          </div>
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
            <div className="zl-in" style={{ fontSize: 25, fontWeight: 900, color: ACC, lineHeight: 1.1, textTransform: 'uppercase', marginBottom: 10, animationDelay: '.45s' }}>
              Тренируйся не на глазок, а по научным данным
            </div>
            <div className="zl-in" style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.45, color: '#fff', textTransform: 'uppercase', animationDelay: '.65s' }}>
              Единственный клуб, где каждая программа и упражнение отобраны по показаниям миографа
            </div>
          </div>
        </div>

        <div className="zl-in" style={{ textAlign: 'center', margin: '18px 0 14px', animationDelay: '.85s' }}>
          <span style={{ fontSize: 30, fontWeight: 900 }}>{rub(1000)}</span>
          <span style={{ fontSize: 15, color: T2 }}> / месяц</span>
          <div style={{ fontSize: 13, color: T2, marginTop: 4 }}>Первые 7 дней — с гарантией возврата денег</div>
        </div>
        <div ref={topBtnRef} className="zl-in" style={{ animationDelay: '1s' }}>
          <button data-testid="club-join-top" onClick={join} className="zl-btn">Хочу 7 дней пробного периода</button>
          <button data-testid="club-look" onClick={look} className="zl-ghost">Посмотреть клуб изнутри</button>
          <div style={{ fontSize: 12, color: T3, textAlign: 'center', marginTop: 8 }}>Без регистрации: программы, упражнения, питание</div>
        </div>

        {/* ── Что внутри */}
        <div style={{ marginTop: 48 }}>
          <h2 className="zl-r">Что внутри <span style={{ color: ACC }}>ZM Club</span></h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {INSIDE.map(([t, txt], i) => (
              <div key={t} className="zl-r card" style={d(i)}>
                <div style={{ fontSize: 15, fontWeight: 800, textTransform: 'uppercase', marginBottom: 5 }}>{t}</div>
                <div style={{ fontSize: 13.5, color: T2, lineHeight: 1.5 }}>{txt}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Для кого */}
        <div style={{ marginTop: 48 }}>
          <h2 className="zl-r" style={{ color: ACC }}>Это для тебя, если ты хочешь результат, а не протоколы</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {GOALS.map(([t, txt], i) => (
              <div key={t} className="zl-r zl-goal" style={d(i)}>
                <div style={{ fontSize: 16, fontWeight: 900, color: ACC, textTransform: 'uppercase', marginBottom: 4 }}>{t}</div>
                <div style={{ fontSize: 14, color: T2, lineHeight: 1.5 }}>{txt}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Стоимость по отдельности */}
        <div ref={valueRef} style={{ marginTop: 48 }}>
          <h2 className="zl-r">Давай оценим этот подход в деньгах по отдельности</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {VALUE.map(([t, p, monthly], i) => (
              <div key={t} className="zl-r card" style={{ ...d(i), padding: '12px 14px' }}>
                <div style={{ fontSize: 13.5, color: '#fff', lineHeight: 1.45 }}>{t}</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: ACC, marginTop: 4 }}><CountUp value={p} on={valueOn} suffix={monthly ? ' / мес' : ''} /></div>
              </div>
            ))}
          </div>
          <div className="zl-r" style={{ fontSize: 18, fontWeight: 900, textTransform: 'uppercase', marginTop: 16, lineHeight: 1.3 }}>
            Итого по отдельности: ~<span style={{ color: ACC }}><CountUp value={VALUE_TOTAL} on={valueOn} /></span>
          </div>
          <div className="zl-r" style={{ fontSize: 15, color: T2, marginTop: 6 }}>
            В клубе — <b style={{ color: '#fff' }}>{rub(1000)} в месяц</b>
          </div>
        </div>

        {/* ── Почему 1000 ₽ */}
        <div style={{ marginTop: 48 }}>
          <h2 className="zl-r" style={{ textAlign: 'center' }}>Почему я даю доступ к своей методике за <span style={{ color: ACC }}>{rub(1000)}?</span></h2>
          <div className="zl-r" style={{ fontSize: 14.5, color: T2, lineHeight: 1.55, textAlign: 'center', marginBottom: 14 }}>
            Потому что я продаю не свои часы, а свою систему. Мой капитал — это экспертиза, подтверждённая аппаратурой.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="zl-r card" style={d(0)}>
              <div style={{ fontSize: 14, fontWeight: 900, textTransform: 'uppercase', marginBottom: 6 }}>Экономика сообщества</div>
              <div style={{ fontSize: 13.5, color: T2, lineHeight: 1.5 }}>Я создаю не разовых клиентов, а сообщество, которое растёт и показывает результаты. Ваши трансформации — моё лучшее доказательство и реклама.</div>
            </div>
            <div className="zl-r card" style={d(1)}>
              <div style={{ fontSize: 14, fontWeight: 900, textTransform: 'uppercase', marginBottom: 6 }}>Инвестиция в будущих чемпионов</div>
              <div style={{ fontSize: 13.5, color: T2, lineHeight: 1.5 }}>Самые активные участники — будущие герои моих кейсов и амбассадоры клуба.</div>
            </div>
          </div>
        </div>

        {/* ── Результаты и отзывы. Только настоящие участницы (подтвердил Максим). */}
        <div style={{ marginTop: 48 }}>
          <h2 className="zl-r">Результаты участниц</h2>
          <div className="zl-r">
            <Carousel count={RESULTS.length}>
              {RESULTS.map(src => (
                <img key={src} src={src} alt="До и после" loading="lazy"
                  onError={e => { e.currentTarget.style.display = 'none' }}
                  style={{ flex: '0 0 78%', maxWidth: 360, aspectRatio: '9 / 16', objectFit: 'cover', borderRadius: 18, scrollSnapAlign: 'center', background: SURF }} />
              ))}
            </Carousel>
          </div>

          <h2 className="zl-r" style={{ marginTop: 36 }}>Что говорят участницы</h2>
          <div className="zl-r">
            <Carousel count={REVIEWS.length}>
              {REVIEWS.map(([name, text]) => (
                <div key={name} className="card" style={{ flex: '0 0 82%', maxWidth: 380, scrollSnapAlign: 'center' }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: ACC, marginBottom: 6 }}>{name}</div>
                  <div style={{ fontSize: 15, lineHeight: 1.5 }}>«{text}»</div>
                </div>
              ))}
            </Carousel>
          </div>
        </div>

        {/* ── Гарантия и финальная кнопка */}
        <div style={{ marginTop: 48, textAlign: 'center' }}>
          <div className="zl-r" style={{ fontSize: 20, fontWeight: 900, textTransform: 'uppercase', marginBottom: 12 }}>Пробный период начинается здесь</div>
          <div className="zl-r" style={{ fontSize: 15, color: T2, lineHeight: 1.55, marginBottom: 22 }}>
            Первые 7 дней после оплаты — твой полный тест-драйв клуба. Не понравится — вернём деньги.
          </div>
          <div className="zl-r" style={{ fontSize: 17, fontWeight: 900, textTransform: 'uppercase', marginBottom: 18, lineHeight: 1.35 }}>
            <span className="zl-grad">ZM Club</span> — для тех, кто хочет тренироваться по науке и видеть результат без срывов и голодовок
          </div>
          <div ref={endRef}>
            <button data-testid="club-join-bottom" onClick={join} className="zl-btn">Вступить в клуб · {rub(1000)}</button>
            <button onClick={look} className="zl-ghost">Сначала посмотреть изнутри</button>
          </div>
        </div>

        {/* ── Реквизиты — нужны для приёма оплаты */}
        <div style={{ marginTop: 44, fontSize: 12.5, color: T3, lineHeight: 1.7 }}>
          Завалишин Максим Игоревич<br />
          ИНН 463227811939<br />
          e-mail: maxim-46kursk@mail.ru
        </div>
      </div>

      {/* ── Липкая кнопка: появляется, когда верхняя уехала из виду */}
      <div className={`zl-sticky${sticky ? ' show' : ''}`}>
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          <button data-testid="club-join-sticky" onClick={join} className="zl-btn" style={{ padding: '15px 18px', fontSize: 15 }}>Вступить в клуб · {rub(1000)}</button>
        </div>
      </div>
    </div>
  )
}
