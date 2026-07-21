// Генератор src/iconData.js.
//
// ВНИМАНИЕ: почти вся иконография приложения — это КАСТОМНЫЙ набор
// src/glassIcons.jsx (<GlassIcon name="..."/>), он не требует Iconify вообще.
// Через этот генератор осталось ровно одно: 4 цветные иконки макросов еды
// (ккал / белки / углеводы / жиры) из Fluent Emoji Flat — их рисованный
// цветной стиль в glassIcons не воспроизвести.
//
// Данные вшиваются в сборку статически, поэтому в рантайме приложение НЕ
// ходит в api.iconify.design — важно для Telegram Mini App (работает офлайн).
//
// Добавить иконку: впиши имя в FLUENT и запусти `node scripts/gen-icons.mjs`.
// Поиск по набору:
//   node -e "console.log(Object.keys(require('./node_modules/@iconify-json/fluent-emoji-flat/icons.json').icons).filter(k=>k.includes('meat')))"

import { readFileSync, writeFileSync } from 'node:fs'

// Макросы еды — Fluent Emoji Flat (цветные, профессиональный набор)
const FLUENT = [
  'fire',         // ккал
  'cut-of-meat',  // белки
  'cooked-rice',  // углеводы
  'avocado',      // жиры
]

const SETS = [
  ['node_modules/@iconify-json/fluent-emoji-flat/icons.json', FLUENT],
]

const out = {}
let count = 0
for (const [path, names] of SETS) {
  const src = JSON.parse(readFileSync(path, 'utf8'))
  for (const name of names) {
    const icon = src.icons[name]
    if (!icon) { console.error(`НЕТ такой иконки в наборе ${src.prefix}:`, name); process.exit(1) }
    out[`${src.prefix}:${name}`] = {
      body: icon.body,
      width: icon.width ?? src.width ?? 24,
      height: icon.height ?? src.height ?? 24,
    }
    count++
  }
}

const file = `// СГЕНЕРИРОВАНО scripts/gen-icons.mjs — вручную не редактировать.
// Иконки макросов еды (Fluent Emoji Flat), вшиты в сборку — offline, без
// обращений к api.iconify.design. Вся остальная иконография — src/glassIcons.jsx.
export const ICON_DATA = ${JSON.stringify(out, null, 2)}
`
writeFileSync('src/iconData.js', file, 'utf8')
console.log(`src/iconData.js: ${count} иконок, ${(file.length / 1024).toFixed(1)} КБ`)
