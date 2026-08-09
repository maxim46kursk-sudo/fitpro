// Четвёрка полей КБЖУ с постоянными подписями — один компонент на все места,
// где эти поля встречаются: сверка распознанной этикетки (BarcodeScanner.jsx),
// ручное добавление продукта и правка записи дневника (FoodDiary.jsx).
//
// Зачем понадобился: раньше подписи жили в placeholder, а он исчезает, как
// только в поле появляется значение. На экране сверки поля заполнены ВСЕГДА
// (их заполняет модель), при правке записи — тоже, и человек видел четыре
// безымянных числа и гадал, где белки, а где углеводы.
//
// Отдельный файл, а не функция внутри FoodDiary.jsx: BarcodeScanner.jsx
// подгружается из FoodDiary.jsx лениво, и импорт в обратную сторону замкнул бы
// зависимость в кольцо.

import { useState, useEffect } from 'react'

// Те же токены тёмной темы, что в App.jsx. Скопированы по той же причине, что
// и в остальных вынесенных экранах.
const SURF2 = '#2c2c2e'
const TXT = '#ffffff'
const PUR = '#7C7AF0'
const TEA = '#30D158'
const BLU = '#0A84FF'
const COR = '#FF9F0A'

// Пределы полей — те же, что применяются при сохранении (src/nutrition.js).
// Здесь они только подсказка браузеру: настоящий кламп всё равно в коде.
import { CAL_MIN, CAL_MAX, MACRO_MIN, MACRO_MAX } from './nutrition.js'

// Полная подпись и короткая — для узких экранов. Цвет подписи совпадает с
// цветом рамки поля: это единственное, что связывает подпись с полем, когда
// их четыре в ряд.
const FIELDS = [
  { key: 'kcal', full: 'Ккал', short: 'Ккал', color: PUR },
  { key: 'p', full: 'Белки, г', short: 'Б, г', color: TEA },
  { key: 'c', full: 'Углеводы, г', short: 'У, г', color: BLU },
  { key: 'f', full: 'Жиры, г', short: 'Ж, г', color: COR },
]

// На 320px четыре колонки дают примерно по 66px, а «Углеводы, г» кеглем 11
// занимает около 70 — подпись переносилась бы на вторую строку и ломала
// высоту сетки. Порог 360px: ниже него подписи сокращаются до «Б, г».
//
// matchMedia, а не разовая проверка ширины: экран поворачивают, и подписи
// должны перестроиться. Слушатель снимается при размонтировании.
const NARROW_QUERY = '(max-width: 360px)'

function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = e => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

// values  — объект со значениями; ключи собираются как `${key}${suffix}`
//           (в дневнике это kcal/p/c/f, у карточки продукта — kcal100/p100/…).
// onChange(fullKey, value) — вызывающий сам решает, куда это положить.
// size    — 'md' обычные формы, 'sm' компактная правка записи в списке дня.
// type    — 'number' даёт браузерные min/max и цифровую клавиатуру;
//           'decimal' только клавиатуру. Второй нужен там, где значение может
//           прийти с запятой (ответ модели), а type="number" такое поле
//           обнулял бы.
// highlightEmpty — подсветить незаполненные поля.
//
// Нужно там, где карточку нельзя сохранить, пока не заполнены все четыре
// числа: у Snickers модель прочитала таблицу, но не разобрала белок, и человек
// видел погашенную кнопку без единого намёка, ЧЕГО не хватает. Подсвеченная
// рамка отвечает на этот вопрос быстрее любой подписи.
export default function MacroInputs({ values, onChange, suffix = '', size = 'md', type = 'number', highlightEmpty = false }) {
  const narrow = useNarrow()
  const sm = size === 'sm'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: sm ? 6 : 8 }}>
      {FIELDS.map(f => {
        const key = `${f.key}${suffix}`
        const isKcal = f.key === 'kcal'
        const empty = highlightEmpty && String(values?.[key] ?? '').trim() === ''
        return (
          <div key={key} style={{ minWidth: 0 }}>
            {/* nowrap + overflow:hidden — страховка на совсем узких экранах и
                на крупном системном шрифте: лучше подрезать подпись, чем
                разъехавшаяся на две строки сетка. */}
            <div style={{
              fontSize: 11, fontWeight: 600, color: f.color, marginBottom: 4,
              textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {narrow ? f.short : f.full}
            </div>
            <input
              value={values?.[key] ?? ''}
              onChange={e => onChange(key, e.target.value)}
              inputMode="decimal"
              {...(type === 'number'
                ? { type: 'number', min: isKcal ? CAL_MIN : MACRO_MIN, max: isKcal ? CAL_MAX : MACRO_MAX }
                : {})}
              style={{
                width: '100%', padding: sm ? '7px 6px' : '10px 8px', fontSize: sm ? 12 : 14,
                borderRadius: sm ? 7 : 9, outline: 'none',
                // Пустое и обязательное — рамка в полный цвет поля и заметно
                // толще: видно боковым зрением, куда ткнуть.
                border: empty ? `2px solid ${f.color}` : `1.5px solid ${f.color}44`,
                boxSizing: 'border-box', color: TXT, background: SURF2, textAlign: 'center',
              }}
              onFocus={e => e.target.style.borderColor = f.color}
              onBlur={e => e.target.style.borderColor = empty ? f.color : `${f.color}44`}
            />
          </div>
        )
      })}
    </div>
  )
}
