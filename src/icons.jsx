import { Icon, addIcon } from '@iconify/react'
import { ICON_DATA } from './iconData.js'

// Данные иконок регистрируются локально один раз при импорте модуля. После
// этого <Icon icon="solar:..."/> берёт их из памяти и НЕ ходит в
// api.iconify.design — приложение работает офлайн и не ждёт сеть на отрисовку
// меню (критично для Telegram Mini App). Добавить иконку: см. scripts/gen-icons.mjs.
for (const [name, data] of Object.entries(ICON_DATA)) addIcon(name, data)

// Единая обёртка для иконок приложения. Тела иконок Solar нарисованы через
// fill="currentColor", поэтому цвет задаётся обычным CSS color.
export function Ic({ name, size = 22, color = 'currentColor', style, ...rest }) {
  return <Icon icon={name} width={size} height={size} style={{ color, display: 'block', ...style }} {...rest} />
}
