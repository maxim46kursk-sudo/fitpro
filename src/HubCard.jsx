// HubCard — крупная карточка-папка для ГЛАВНЫХ экранов вкладок.
//
// Зачем: такие карточки уже были на «Тренировках» (папки программ), и они там
// работают — большая иконка, название, короткая сводка, шеврон. Но каждая
// вкладка рисовала своё: «Дневник» — горизонтальную строку с цветной плиткой
// под иконку, «Упражнения» — вообще плоский список. Вкладки выглядели как
// три разных приложения.
//
// Здесь один компонент на все хабы. Правило простое: экран, который только ведёт
// в другие экраны, состоит из HubCard; экран, где работают со списком
// (записи дня, история, каталог внутри категории), остаётся плотным.
//
// Отдельный файл, а не функция в App.jsx: карточку используют и App.jsx, и
// вынесенные экраны, а App.jsx мы не раздуваем.

import { GlassIcon } from './glassIcons'

// Те же токены тёмной темы, что в App.jsx. Скопированы по той же причине, что
// и в остальных вынесенных файлах: App.jsx импортирует этот модуль, обратный
// импорт замкнул бы зависимость в кольцо.
const SURF = '#1c1c1e'
const SURF2 = '#2c2c2e'
const HAIR = 'rgba(255,255,255,0.12)'
const TXT = '#ffffff'
const TXT3 = 'rgba(235,235,245,0.30)'
const PUR = '#7C7AF0'

export default function HubCard({
  icon,
  title,
  subtitle,
  onClick,
  selected = false,   // выбранная программа: подсветка рамкой и фоном
  checked = false,    // галочка в правом верхнем углу
  onInfo,             // кружок «?» слева сверху (описание раздела)
  topRight,           // произвольный слот справа сверху (шестерёнка тренера)
  locked = false,     // раздел закрыт тарифом: приглушаем и меняем шеврон на замок
  style = {},
}) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'relative',
        background: selected ? 'rgba(124,122,240,0.14)' : SURF,
        border: selected ? `1.5px solid ${PUR}` : '1.5px solid transparent',
        borderRadius: 16,
        padding: '22px 16px',
        boxShadow: '0 1px 5px rgba(0,0,0,0.08)',
        marginBottom: 10,
        cursor: 'pointer',
        opacity: locked ? 0.55 : 1,
        ...style,
      }}>

      {/* Кружок «?» — описание раздела. stopPropagation обязателен: иначе тап
          по нему открыл бы и саму папку. */}
      {onInfo && (
        <button onClick={e => { e.stopPropagation(); onInfo() }} aria-label="Описание"
          style={{ position: 'absolute', top: 10, left: 12, width: 22, height: 22, borderRadius: '50%', border: `1px solid ${HAIR}`, background: SURF2, color: TXT3, fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'unset', padding: 0 }}>?</button>
      )}

      {topRight && <div style={{ position: 'absolute', top: 8, right: 44 }}>{topRight}</div>}
      {checked && <span style={{ position: 'absolute', top: 10, right: 16 }}><GlassIcon name="check" size={18} /></span>}

      {/* paddingRight освобождает место под шеврон: без него длинное название
          заезжало бы под него на узких экранах. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingRight: 20, paddingLeft: 20 }}>
        {icon && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 46, marginBottom: 8 }}>
            <GlassIcon name={icon} size={46} />
          </div>
        )}
        {/* Длинное название переносится на две строки и НЕ обрезается:
            «Прогресс по упражнениям» на 320px в одну строку не помещается. */}
        <div style={{ fontSize: 19, fontWeight: 700, color: TXT, textAlign: 'center', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 13, color: TXT3, marginTop: 4, textAlign: 'center', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{subtitle}</div>
        )}
      </div>

      <span style={{ position: 'absolute', top: '50%', right: 16, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', color: TXT3, fontSize: 20 }}>
        {locked ? <GlassIcon name="lock" size={18} /> : '›'}
      </span>
    </div>
  )
}
