import { useEffect, useRef, useState } from 'react'
import hero from './assets/zmclub-hero.jpg'
import { track } from './track.js'
import { BG, SURF, HAIR, PUR, ACCENT2 } from './theme.js'

/**
 * ЛЕНДИНГ ZMCLUB — первый экран гостя (сент 2026, заменил WelcomeSheet).
 *
 * Окт 2026 — АКЦИЯ С МАШИНОЙ: каждый, кто оплатил клуб до 10 ноября, получает
 * номер участника; 12 ноября в эфире определяем 10 призовых мест (Skoda Octavia,
 * iPhone 18 Pro Max, iPhone 17, 7 × AirPods). На время акции первым экраном
 * идёт ролик с машиной (сюда приходят из Instagram ради неё), фото Максима со
 * слоганом — ниже. Пробного периода и гарантии возврата больше нет. Клуб —
 * 3000 ₽ за месяц (тариф club) или 3+1 = 4 месяца за 9000 ₽ (тариф club4).
 * После акции блок PROMO выключается флагом PROMO_ON, фото снова наверху.
 *
 * Движение (по просьбе Максима — «статичная страница выглядит дёшево»): всё на
 * CSS + IntersectionObserver, без библиотек. При «уменьшить движение» в
 * настройках телефона анимации выключаются целиком.
 *
 * onJoin — к оплате (экран «Вступить в клуб»), onLook — закрыть и гулять по
 * приложению гостем. Оба помечают приветствие увиденным (см. App).
 */

// Акция с машиной. Выключить после итогов — false, и лендинг вернётся к фото.
const PROMO_ON = true
const PROMO_DIR = '/club/promo'
const PRIZES = [
  ['2 место', 'iPhone 18 Pro Max', `${PROMO_DIR}/iphone-18-pro-max.png`],
  ['3 место', 'iPhone 17', `${PROMO_DIR}/iphone-17.png`],
  ['4–10 место', 'AirPods × 7', `${PROMO_DIR}/airpods.png`],
]

// Пакеты клуба. Цены синхронны с src/plans.js (club, club4) и api/_prodamus.js.
const PKGS = [
  { key: 'club', title: '1 месяц', price: 3000, note: '1 номер участника' },
  { key: 'club4', title: '3+1 · 4 месяца', price: 9000, note: '4 номера участника', badge: 'Выгоднее' },
]
const PRICE = 3000

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
  // Отзыв Даши («1000₽ в месяц — это дёшево…») снят в окт 2026: называет старую цену.
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
/* акция: ролик с машиной */
.zl-promo{position:relative;margin:16px 0 0;border-radius:26px;overflow:hidden;background:#050508;border:1px solid ${PUR}55;box-shadow:0 20px 60px ${PUR}40;aspect-ratio:540/840}
.zl-promo video,.zl-promo>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.zl-promo .gt{position:absolute;left:0;right:0;top:0;height:46%;background:linear-gradient(rgba(5,5,8,.92),rgba(5,5,8,.55) 55%,transparent)}
.zl-promo .gb{position:absolute;left:0;right:0;bottom:0;height:32%;background:linear-gradient(transparent,rgba(5,5,8,.85) 60%,#050508)}
.zl-tag{display:table;margin:0 auto;padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase}
.zl-tag i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff4d6d;margin-right:7px;box-shadow:0 0 10px #ff4d6d;vertical-align:1px;animation:zlBlink 1.6s ease-in-out infinite}
@keyframes zlBlink{50%{opacity:.35}}
.zl-snd{position:absolute;right:14px;bottom:92px;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;min-height:unset}
.zl-prz{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;align-items:end;margin-top:6px}
.zl-prz .im{height:110px;display:flex;align-items:flex-end;justify-content:center;position:relative}
.zl-prz .im::before{content:"";position:absolute;bottom:2px;left:50%;width:86px;height:86px;transform:translateX(-50%);background:radial-gradient(closest-side,${PUR}66,transparent)}
.zl-prz img{position:relative;max-height:104px;max-width:92%;filter:drop-shadow(0 10px 14px rgba(0,0,0,.8))}
.zl-pkg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.zl-pkg button{position:relative;text-align:left;padding:13px 14px;border-radius:16px;border:1px solid ${HAIR};background:${SURF};color:#fff;cursor:pointer;min-height:unset;transition:border-color .2s,background .2s}
.zl-pkg button.on{border:2px solid ${ACCENT2};background:${PUR}22}
.zl-pkg .bd{position:absolute;top:-9px;right:10px;background:linear-gradient(${ACCENT2},${PUR});font-size:10.5px;font-weight:900;padding:3px 8px;border-radius:999px;text-transform:uppercase}
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
  const [pkg, setPkg] = useState('club')
  const [muted, setMuted] = useState(true)
  const videoRef = useRef(null)
  const cur = PKGS.find(p => p.key === pkg) || PKGS[0]

  useEffect(() => { track('screen', { name: 'club_landing' }, '/club') }, [])
  // В кассу уходит выбранный пакет: club (1 месяц) или club4 (3+1).
  const join = () => { track('screen', { name: 'club_join', plan: pkg }, '/club'); onJoin(pkg) }
  const look = () => { track('screen', { name: 'club_look' }, '/club'); onLook() }
  const toggleSound = () => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    if (!v.muted) v.play?.().catch(() => {})
    setMuted(v.muted)
    track('screen', { name: v.muted ? 'club_promo_mute' : 'club_promo_sound' }, '/club')
  }

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

        {/* ── Акция: ролик с машиной и призы (первый экран на время акции) */}
        {PROMO_ON && (
          <>
            <div className="zl-promo zl-in" style={{ animationDelay: '.05s' }}>
              <video ref={videoRef} src={`${PROMO_DIR}/octavia.mp4`} poster={`${PROMO_DIR}/octavia.jpg`}
                autoPlay muted loop playsInline preload="auto" aria-label="Ролик: Skoda Octavia — главный приз" />
              <div className="gt" /><div className="gb" />
              <div style={{ position: 'absolute', left: 14, right: 14, top: 16, textAlign: 'center' }}>
                <div className="zl-tag"><i />Приём участников до 10 ноября</div>
                <div style={{ marginTop: 12, fontSize: 29, fontWeight: 900, lineHeight: 1.02, textTransform: 'uppercase', letterSpacing: '-.4px', textShadow: '0 2px 20px rgba(0,0,0,.6)' }}>
                  Эта машина<br /><span className="zl-grad">может быть твоей</span>
                </div>
              </div>
              <button className="zl-snd" onClick={toggleSound} aria-label={muted ? 'Включить звук' : 'Выключить звук'}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5z" />
                  {muted ? <path d="m22 9-6 6M16 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
                </svg>
              </button>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 10.5, letterSpacing: 3, color: ACC, fontWeight: 800 }}>ГЛАВНЫЙ ПРИЗ</div>
                <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: 1.5, marginTop: 3 }}>SKODA OCTAVIA</div>
              </div>
            </div>

            <div className="zl-in" style={{ animationDelay: '.3s', marginTop: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10.5, letterSpacing: 2.6, color: T3, fontWeight: 700 }}>
                <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.14)' }} />А ТАКЖЕ<span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.14)' }} />
              </div>
              <div className="zl-prz">
                {PRIZES.map(([place, name, src]) => (
                  <div key={name} style={{ textAlign: 'center' }}>
                    <div className="im"><img src={src} alt={name} loading="eager" /></div>
                    <div style={{ marginTop: 10, fontSize: 10, letterSpacing: 1.6, color: ACC, fontWeight: 800, textTransform: 'uppercase' }}>{place}</div>
                    <div style={{ marginTop: 3, fontSize: 13, fontWeight: 900, lineHeight: 1.15 }}>{name}</div>
                  </div>
                ))}
              </div>
              <div style={{ textAlign: 'center', fontSize: 12.5, color: T2, marginTop: 14, lineHeight: 1.5 }}>
                10 призовых мест · каждый участник клуба получает номер<br />Итоги — <b style={{ color: '#fff' }}>12 ноября в прямом эфире</b>
              </div>
            </div>
          </>
        )}

        {/* ── Цена, выбор пакета и кнопка */}
        <div className="zl-in" style={{ margin: '22px 0 14px', animationDelay: '.45s' }}>
          <div className="zl-pkg">
            {PKGS.map(p => (
              <button key={p.key} data-testid={`club-pkg-${p.key}`} className={pkg === p.key ? 'on' : ''} onClick={() => setPkg(p.key)}>
                {p.badge && <span className="bd">{p.badge}</span>}
                <div style={{ fontSize: 12, color: T2 }}>{p.title}</div>
                <div style={{ fontSize: 22, fontWeight: 900, margin: '2px 0' }}>{rub(p.price)}</div>
                <div style={{ fontSize: 12, color: ACC, fontWeight: 700 }}>{p.note}</div>
              </button>
            ))}
          </div>
        </div>
        <div ref={topBtnRef} className="zl-in" style={{ animationDelay: '.6s' }}>
          <button data-testid="club-join-top" onClick={join} className="zl-btn">Вступить в клуб · {rub(cur.price)}</button>
          <button data-testid="club-look" onClick={look} className="zl-ghost">Посмотреть клуб изнутри</button>
          <div style={{ fontSize: 12, color: T3, textAlign: 'center', marginTop: 8 }}>Без регистрации: программы, упражнения, питание</div>
        </div>

        {/* ── О клубе: обещание (окт 2026 — фото Максима убрано, он есть в ролике).
             При PROMO_ON=false фото возвращается первым экраном — см. блок ниже. */}
        {PROMO_ON ? (
          <div className="zl-r" style={{ marginTop: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: ACC, lineHeight: 1.1, textTransform: 'uppercase' }}>
              Тренируйся не на глазок, а по научным данным
            </div>
            <div style={{ fontSize: 14.5, color: T2, lineHeight: 1.5, marginTop: 10 }}>
              Каждая программа и упражнение в клубе отобраны по показаниям миографа
            </div>
          </div>
        ) : (
          <div className="zl-hero zl-r" style={{ position: 'relative', margin: '40px 0 0', borderRadius: 26, overflow: 'hidden', background: '#000', boxShadow: `0 20px 60px ${PUR}33` }}>
            <img src={hero} alt="Максим Завалишин" loading="lazy" style={{ display: 'block', width: '100%', height: 'auto' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.92) 88%)' }} />
            <div style={{ position: 'absolute', top: 22, left: 20, right: 20 }}>
              <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: '0.5px' }}><span className="zl-grad">ZM CLUB</span></div>
              <div style={{ fontSize: 17, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Максим Завалишин</div>
            </div>
            <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
              <div style={{ fontSize: 25, fontWeight: 900, color: ACC, lineHeight: 1.1, textTransform: 'uppercase' }}>
                Тренируйся не на глазок, а по научным данным
              </div>
            </div>
          </div>
        )}

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
            В клубе — <b style={{ color: '#fff' }}>{rub(PRICE)} в месяц</b>
          </div>
        </div>

        {/* ── Почему так недорого */}
        <div style={{ marginTop: 48 }}>
          <h2 className="zl-r" style={{ textAlign: 'center' }}>Почему я даю доступ к своей методике за <span style={{ color: ACC }}>{rub(PRICE)}?</span></h2>
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

        {/* ── Финальная кнопка (окт 2026: пробный период и гарантия возврата сняты) */}
        <div style={{ marginTop: 48, textAlign: 'center' }}>
          {PROMO_ON && (
            <>
              <div className="zl-r" style={{ fontSize: 20, fontWeight: 900, textTransform: 'uppercase', marginBottom: 12 }}>Вступай до 10 ноября</div>
              <div className="zl-r" style={{ fontSize: 15, color: T2, lineHeight: 1.55, marginBottom: 22 }}>
                Каждый, кто вступит в клуб до 10 ноября, получает номер участника. 12 ноября в прямом эфире определим 10 победителей — главный приз Skoda Octavia.
              </div>
            </>
          )}
          <div className="zl-r" style={{ fontSize: 17, fontWeight: 900, textTransform: 'uppercase', marginBottom: 18, lineHeight: 1.35 }}>
            <span className="zl-grad">ZM Club</span> — для тех, кто хочет тренироваться по науке и видеть результат без срывов и голодовок
          </div>
          <div ref={endRef}>
            <button data-testid="club-join-bottom" onClick={join} className="zl-btn">Вступить в клуб · {rub(cur.price)}</button>
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
          <button data-testid="club-join-sticky" onClick={join} className="zl-btn" style={{ padding: '15px 18px', fontSize: 15 }}>Вступить в клуб · {rub(cur.price)}</button>
        </div>
      </div>
    </div>
  )
}
