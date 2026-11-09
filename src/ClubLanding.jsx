import { useEffect, useRef } from 'react'
import { track } from './track.js'
import './ClubLanding.css'

const consultation = 'https://t.me/maxim_athlete'

const illustrations = [
  ['coach', 'Максим Завалишин, фитнес-тренер. Стаж 10 лет. КМС по пауэрлифтингу и настольному теннису. Победитель Crosslifting 2021.'],
  ['experience', 'Мне доверяют блогеры. За спиной множество обучений и повышение квалификации.'],
  ['goals', 'Помогу увеличить силовые показатели, похудеть, набрать массу, подготовиться к соревнованиям, повысить выносливость или изменить композицию тела.'],
]

export default function ClubLanding({ onLook }) {
  const rootRef = useRef(null)

  useEffect(() => {
    track('screen', { name: 'club_landing' }, '/club')
    const root = rootRef.current
    if (!root || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('zm-arrived')
        observer.unobserve(entry.target)
      }
    }, { root, threshold: .08 })
    for (const panel of root.querySelectorAll('.zm-reveal')) observer.observe(panel)
    root.classList.add('zm-animate')
    return () => observer.disconnect()
  }, [])

  function look() {
    track('screen', { name: 'club_look' }, '/club')
    onLook()
  }

  return (
    <main className="zm-landing" data-testid="club-landing" ref={rootRef} aria-label="Максим Завалишин и ZMClub">
      <div className="zm-layout">
        {illustrations.map(([name, alt], index) => (
          <div className={index ? 'zm-illustration zm-reveal' : 'zm-illustration zm-intro'} key={name}>
            <img src={`/club/landing/${name}.webp`} alt={alt} width="1021" height="1557" loading={index ? 'lazy' : 'eager'} />
          </div>
        ))}
        <section className="zm-tier zm-reveal">
          <p className="zm-kicker">Что внутри клуба</p>
          <h2>Онлайн фитнес-клуб ZMClub</h2>
          <dl className="zm-features">
            <div><dt>Тренировки</dt><dd>Готовые программы для дома и зала.</dd></div>
            <div><dt>Миограф</dt><dd>Видео техники с разбором работы мышц.</dd></div>
            <div><dt>Питание</dt><dd>Расчёт КБЖУ, готовые рационы и дневник.</dd></div>
            <div><dt>Обратная связь</dt><dd>Пришли видео подхода — подскажу, что поправить.</dd></div>
          </dl>
          <p className="zm-price">1 000 ₽ <small>за месяц</small></p>
          <button className="zm-action" data-testid="club-look" onClick={look}>Посмотреть клуб</button>
        </section>
        <section className="zm-tier zm-featured zm-reveal">
          <h2>Онлайн-ведение</h2>
          <p className="zm-kicker">Бесплатная консультация</p>
          <p>Созвонимся и проведём тесты на базовых упражнениях. По результатам я составлю тебе программу тренировок.</p>
          <p className="zm-note">60 минут</p>
          <div className="zm-coaching">
            <img src="/club/landing/results.webp" alt="Фото результатов онлайн-ведения" width="225" height="405" loading="lazy" />
            <ul>
              <li>Индивидуальный план на три тренировки в неделю.</li>
              <li>Снимаешь подходы, я смотрю видео и поправляю технику.</li>
              <li>План питания с учётом твоих пожеланий и бюджета.</li>
              <li>Ежедневная проверка отчётов по питанию.</li>
              <li>Связь со мной 24/7.</li>
            </ul>
          </div>
          <p className="zm-price">15 000 ₽ <small>за 3 месяца</small></p>
          <a className="zm-action" href={consultation}>Записаться на консультацию</a>
        </section>
        <section className="zm-tier zm-reveal">
          <h2>VIP · Тренировки со мной</h2>
          <p className="zm-kicker">Три персональные тренировки по видеосвязи в неделю</p>
          <p>Тренируемся вместе в прямом эфире. Я вижу твои движения и сразу поправляю технику.</p>
          <p>План тренировок и питание под твою цель.</p>
          <p className="zm-price">30 000 ₽ <small>в месяц</small></p>
          <a className="zm-action" href={consultation}>Записаться на консультацию</a>
        </section>
      </div>
    </main>
  )
}
