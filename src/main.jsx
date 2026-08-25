import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

/**
 * МЕТКИ ЗАГРУЗКИ — ответ сторожу из index.html.
 *
 * `bundle` ставится тем, что этот файл вообще начал выполняться: значит код
 * приехал и разобрался. `react` — после первого кадра, а не сразу после
 * render(): render только запускает работу, и приложение, упавшее в первом же
 * рендере, отметилось бы «поднявшимся». requestAnimationFrame срабатывает
 * ПОСЛЕ отрисовки, то есть тогда, когда человек действительно что-то увидел.
 *
 * Функции может не быть (страница из старого кэша, где сторожа ещё нет) —
 * поэтому опциональный вызов, а не проверка на существование в трёх местах.
 */
window.__bootStage?.('bundle')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

requestAnimationFrame(() => {
  const root = document.getElementById('root')
  if (root && root.childElementCount > 0) window.__bootStage?.('react')
})
