import { useEffect, useRef } from 'react'
import { track } from './track.js'
import './ClubLanding.css'

const consultation = 'https://t.me/maxim_athlete'

const illustrations = [
  ['coach', 'Максим Завалишин, фитнес-тренер. Стаж 10 лет. КМС по пауэрлифтингу и настольному теннису. Победитель Crosslifting 2021.'],
  ['experience', 'Мне доверяют блогеры. За спиной множество обучений и повышение квалификации.'],
  ['goals', 'Помогу увеличить силовые показатели, похудеть, набрать массу, подготовиться к соревнованиям, повысить выносливость или изменить композицию тела.'],
]

// Coordinates in percent of the original artwork. The pieces tile the page
// after the entrance, without duplicating or re-encoding the source image.
const compositions = {
  coach: [
    [0, 0, 100, 18, 'drop'],
    [0, 18, 46, 68, 'left'],
    [46, 18, 54, 26, 'right'],
    [46, 44, 54, 15, 'right'],
    [46, 59, 54, 27, 'rise'],
    [0, 86, 100, 14, 'rise'],
  ],
  experience: [
    [0, 0, 100, 12, 'drop'],
    [0, 12, 42, 19, 'left'],
    [42, 12, 58, 19, 'right'],
    [0, 31, 100, 25, 'rise'],
    [0, 56, 100, 12, 'right'],
    [0, 68, 100, 32, 'rise'],
  ],
  goals: [
    [0, 0, 100, 25, 'drop'],
    ...[25, 35, 45, 55, 65, 75, 85].map((top, index) => [0, top, 100, 10, index % 2 ? 'right' : 'left']),
    [0, 95, 100, 5, 'rise'],
  ],
}

function Artwork({ name, description, eager }) {
  const src = `/club/landing/${name}.webp`
  return (
    <figure className="zm-illustration" data-zm-artwork>
      <img className="zm-artwork-source" src={src} alt={description} width="1021" height="1557" loading={eager ? 'eager' : 'lazy'} />
      <div className="zm-artwork-pieces" aria-hidden="true" style={{ '--artwork': `url("${src}")` }}>
        {compositions[name].map(([left, top, width, height, motion], index) => (
          <div key={index} className={`zm-piece zm-${motion}`} data-zm-motion style={{
            left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`,
            backgroundSize: `${10000 / width}% ${10000 / height}%`,
            backgroundPosition: `${width === 100 ? 0 : 100 * left / (100 - width)}% ${100 * top / (100 - height)}%`,
            '--zm-delay': `${index % 4 * 58}ms`,
          }} />
        ))}
      </div>
    </figure>
  )
}

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
    for (const panel of root.querySelectorAll('[data-zm-motion], .zm-tier > :not(dl, .zm-coaching), .zm-features > div, .zm-coaching img, .zm-coaching li')) {
      panel.classList.add('zm-reveal')
      observer.observe(panel)
    }
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
          <Artwork key={name} name={name} description={alt} eager={index === 0} />
        ))}
        <section className="zm-tier">
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
        <section className="zm-tier zm-featured">
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
        <section className="zm-tier">
          <h2>VIP онлайн-сопровождение</h2>
          <dl className="zm-features">
            <div><dt>Три персональные тренировки в неделю по видео</dt><dd>Занимаемся один на один, технику поправляю прямо во время подхода.</dd></div>
            <div><dt>План под твой прогресс</dt><dd>Слежу за рабочими весами и корректирую нагрузку по ходу программы.</dd></div>
            <div><dt>Питание под твою цель</dt><dd>Подбираю рацион под твои привычки и корректирую его по отчётам.</dd></div>
            <div><dt>Личная связь между тренировками</dt><dd>Если меняется график или что-то не получается, пиши мне — подстроим план.</dd></div>
          </dl>
          <p className="zm-price">от 20 000 ₽ <small>в месяц</small></p>
          <a className="zm-action" href={consultation}>Записаться на консультацию</a>
        </section>
      </div>
    </main>
  )
}
