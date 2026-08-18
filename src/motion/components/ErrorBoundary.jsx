import { Component } from 'react'
import { reportError } from '../debug/errorReporter.js'

/**
 * Ловит ошибки рендера и показывает текст прямо на экране.
 *
 * На телефоне нет консоли разработчика: любая необработанная ошибка
 * превращалась в белую страницу, и полевой отчёт звучал как «не открывается»,
 * без единой зацепки. Теперь видно, что именно упало, и текст можно скопировать.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    /**
     * В ЛОГ — до всего остального. Карточку ниже видит только человек, стоящий
     * с телефоном, и переслать её он должен догадаться сам; на челлендже
     * догадываться будет некому, и падение осталось бы известным одному ему.
     *
     * Стек компонентов идёт вместо стека вызовов: у ошибки рендера он и есть
     * ответ на «где» — какой экран собрался и на каком узле сломался.
     */
    reportError(error, {
      source: 'render',
      stack: error?.stack || info?.componentStack || '',
    })
    console.error('[motion] ошибка рендера:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    const text = [
      'FitPro Motion — ошибка',
      String(this.state.error?.stack || this.state.error),
      this.state.info?.componentStack || '',
      navigator.userAgent,
    ].join('\n')

    /**
     * Корень модуля стоит и здесь — тот же .mt-root, что и в рабочем режиме.
     *
     * Он не украшение: на нём живёт isolation, то есть собственный контекст
     * наложения. Без него экран падения (z-index 999) уехал бы в контекст
     * страницы и лёг бы между чужими слоями хозяйского приложения — поверх его
     * шапки, но под его модалками. Упавший модуль обязан оставаться в своих
     * границах ровно так же, как работающий.
     */
    return (
      <div className="mt-root">
        <div className="mt-fatal" data-testid="fatal-error">
          <div className="mt-fatal__card">
            <div className="mt-fatal__title">Что-то сломалось</div>
            <pre className="mt-fatal__text">{String(this.state.error?.message || this.state.error)}</pre>
            {/**
             * ПЕРЕЗАГРУЗКИ СТРАНИЦЫ ЗДЕСЬ БОЛЬШЕ НЕТ.
             *
             * Она была честным способом восстановления, пока Motion был всем
             * приложением: терять, кроме него самого, нечего. Внутри FitPro та же
             * кнопка уносит состояние ВСЕГО приложения — открытый дневник питания,
             * незаписанную тренировку, а заодно незавершённый обмен ссылки
             * доступа: токен из адреса хозяин вырезает сразу и держит только в
             * памяти, так что перезагрузка убивает не «состояние», а сам вход
             * человека.
             *
             * Упасть должен модуль. onRestart пересобирает поддерево Motion и не
             * трогает ничего вокруг; onExit выводит человека наружу, туда, где
             * приложение цело.
             */}
            <button
              className="mt-button"
              onClick={() => {
                navigator.clipboard?.writeText(text).catch(() => {})
                this.props.onRestart?.()
              }}
            >
              Скопировать и начать заново
            </button>
            {this.props.onExit && (
              <button className="mt-button mt-button--ghost" onClick={this.props.onExit}>
                Выйти из тренировки
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
