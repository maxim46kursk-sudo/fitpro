import { useState } from 'react'
import { ступень } from '../challengeFunnel.js'

/**
 * ВЫХОД ИЗ ПРОБНОЙ ИГРЫ — три экрана из docs/challenge-exit-maket.html.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. Страница челленджа перестроена: цены на первом экране
 * нет, человек сначала играет. Значит крестик в пробном заходе — это не «выход
 * из тренировки», а единственная точка, где мы с ним разговариваем: он только
 * что играл, он тёплый, и отпустить его молча — значит потерять весь смысл
 * перестройки.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Этот экран НЕ заменяет обычный выход из тренировки
 * (ExitChoice в SessionScreen: сохранить заход или выбросить). Тот вопрос — про
 * данные участника, у которого на кону призы, и подменять его вопросом «как
 * тебе игра?» нельзя. Показывается только пробный заход с первого экрана
 * лендинга — см. `trialRun` в index.jsx.
 *
 * ЦИФРЫ НАСТОЯЩИЕ ИЛИ ИХ НЕТ ВОВСЕ. Нули вместо результата — худший из
 * возможных ответов человеку, который только что двигался: он читает их как
 * «ты ничего не сделал». Поэтому блок с числами просто не рисуется, если
 * результата не пришло (см. `есть` ниже).
 */

/** Склонение мишеней: 1 мишень, 2 мишени, 5 мишеней. */
function мишени(n) {
  const с = n % 100
  const е = n % 10
  if (с >= 11 && с <= 14) return 'мишеней'
  if (е === 1) return 'мишень'
  if (е >= 2 && е <= 4) return 'мишени'
  return 'мишеней'
}

/** Склонение минут. Секунды до минуты не округляем вверх: «1 минута» за 20 секунд — враньё. */
function времяТекстом(секунды) {
  if (!(секунды > 0)) return null
  if (секунды < 60) return `${Math.round(секунды)} секунд`
  const м = Math.floor(секунды / 60)
  const с = м % 100
  const е = м % 10
  const слово = с >= 11 && с <= 14 ? 'минут' : е === 1 ? 'минута' : е >= 2 && е <= 4 ? 'минуты' : 'минут'
  return `${м} ${слово}`
}

/** Очки с разрядами: «4 700», а не «4700» — так в макете и так читается быстрее. */
function очки(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * Карточка результата. Общая у экранов 1 и 3 — цифры человека одни и те же, и
 * разойтись они не имеют права.
 */
function Результат({ итог }) {
  const строки = [
    итог.hits > 0 ? `${итог.hits} ${мишени(итог.hits)}` : null,
    времяТекстом(итог.seconds),
  ].filter(Boolean)

  return (
    <div className="mt-px__res" data-testid="play-exit-result">
      <div className="mt-px__resLab">твой результат</div>
      <div className="mt-px__resBig" data-testid="play-exit-score">{очки(итог.score)}</div>
      {строки.length > 0 && (
        <div className="mt-px__resSub" data-testid="play-exit-sub">{строки.join(' · ')}</div>
      )}
    </div>
  )
}

/**
 * @param {object} props
 * @param {{score:number,hits:number,seconds:number}|null} props.итог результат
 *   захода. null — показываем экраны без цифр, а не с нулями.
 * @param {() => void} props.onЧеллендж  палец вверх: на страницу челленджа, в
 *   блок «Тогда смотри, что дальше»
 * @param {() => void} props.onСохранить «Сохранить результат» — в регистрацию
 * @param {() => void} props.onЗакрыть   «Закрыть» — наружу
 * @param {number} props.цена            подпись кнопки участия
 * @param {string|null} props.старт      «Старт 10 сентября», как на лендинге
 */
export default function PlayExitScreen({
  итог = null,
  onЧеллендж,
  onСохранить,
  onЗакрыть,
  цена = 2990,
  старт = null,
}) {
  const [экран, setЭкран] = useState('вопрос')
  const есть = !!итог && итог.score > 0

  // ═══ 1. НАЖАЛ КРЕСТИК · выход из игры ═══
  if (экран === 'вопрос') {
    return (
      <div className="mt-screen mt-px" data-testid="play-exit">
        <div className="mt-px__glow" aria-hidden="true" />
        <div className="mt-px__in">
          {есть && <Результат итог={итог} />}
          <div className="mt-px__sp" />
          <h2 className="mt-px__h2 mt-px__h2--mid">Как тебе игра?</h2>
          <div className="mt-px__thumbs">
            <button
              type="button"
              className="mt-px__tb mt-px__tb--up"
              data-testid="play-exit-up"
              aria-label="Понравилось"
              onClick={() => {
                ступень('up', {})
                onЧеллендж?.()
              }}
            >👍</button>
            <button
              type="button"
              className="mt-px__tb mt-px__tb--down"
              data-testid="play-exit-down"
              aria-label="Не понравилось"
              onClick={() => {
                ступень('down', {})
                setЭкран('жаль')
              }}
            >👎</button>
          </div>
          <div className="mt-px__sp" />
        </div>
      </div>
    )
  }

  // ═══ 3. ПАЛЕЦ ВНИЗ · отпускаем по-человечески ═══
  return (
    <div className="mt-screen mt-px" data-testid="play-exit-sorry">
      <div className="mt-px__glow" aria-hidden="true" />
      <div className="mt-px__in">
        <div className="mt-px__sp" />
        <h2 className="mt-px__h2">Жаль.</h2>
        {/*
          Похвала опирается на ЕГО число и без него не имеет смысла: «столько-то
          мишеней с первого раза» — это довод, «0 мишеней с первого раза» —
          насмешка. Нет цифр — остаётся вторая половина текста, она самостоятельна.
        */}
        {есть && итог.hits > 0 && (
          <p className="mt-px__p">
            Но смотри: <b>{итог.hits} {мишени(итог.hits)} с первого раза</b>, не зная ни одного
            движения. Это нормальный первый заход — тело схватывает быстро, обычно к третьему дню.
          </p>
        )}
        <p className="mt-px__p">Первые дни в игре бесплатные. Заходи, когда будет настроение.</p>
        <div className="mt-px__sp" />
        <div className="mt-px__g10">
          <button
            type="button"
            className="mt-px__btn mt-px__btn--pri"
            data-testid="play-exit-save"
            onClick={() => {
              ступень('save', {})
              onСохранить?.()
            }}
          >Сохранить результат</button>
          <button
            type="button"
            className="mt-px__btn mt-px__btn--sec"
            data-testid="play-exit-close"
            onClick={() => onЗакрыть?.()}
          >Закрыть</button>
        </div>
      </div>
    </div>
  )
}

/**
 * ═══ 2. ПАЛЕЦ ВВЕРХ · знакомим с челленджем ═══
 *
 * Живёт НЕ здесь, а на самой странице челленджа: палец вверх возвращает туда,
 * и блок обязан быть частью страницы, а не всплывать поверх неё. Иначе человек,
 * закрывший всплывашку, оказался бы на первом экране — там же, откуда ушёл
 * играть, — и предложение пришлось бы искать прокруткой.
 *
 * См. ChallengeScreen: секция `data-testid="challenge-warm"`.
 */
export { мишени, времяТекстом, очки }
