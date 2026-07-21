// Генератор src/iconData.js — вытаскивает ТОЛЬКО нужные иконки из набора
// @iconify-json/solar (в node_modules он ~6 МБ / 7400 иконок, целиком в бандл
// его тащить нельзя). Данные попадают в сборку статически, поэтому в рантайме
// приложение НЕ ходит в api.iconify.design — важно для Telegram Mini App.
//
// Добавить иконку: впиши её имя в ICONS ниже и запусти `node scripts/gen-icons.mjs`.
// Имена — как в наборе Solar, со стилевым суффиксом (напр. '-bold-duotone').
// Посмотреть доступные: node -e "console.log(Object.keys(require('./node_modules/@iconify-json/solar/icons.json').icons).filter(k=>k.includes('dumbbell')))"

import { readFileSync, writeFileSync } from 'node:fs'

const ICONS = [
  'dumbbell-bold-duotone',            // Тренировки
  'chef-hat-bold-duotone',            // Питание
  'book-bold-duotone',                // Упражнения
  'notebook-bookmark-bold-duotone',   // Дневник
  'users-group-rounded-bold-duotone', // Клиенты (тренер)
]

const src = JSON.parse(readFileSync('node_modules/@iconify-json/solar/icons.json', 'utf8'))
const out = {}
for (const name of ICONS) {
  const icon = src.icons[name]
  if (!icon) { console.error('НЕТ такой иконки в наборе:', name); process.exit(1) }
  out[`${src.prefix}:${name}`] = {
    body: icon.body,
    width: icon.width ?? src.width ?? 24,
    height: icon.height ?? src.height ?? 24,
  }
}

const file = `// СГЕНЕРИРОВАНО scripts/gen-icons.mjs — вручную не редактировать.
// Иконки Solar, вшиты в сборку (offline, без запросов к api.iconify.design).
export const ICON_DATA = ${JSON.stringify(out, null, 2)}
`
writeFileSync('src/iconData.js', file, 'utf8')
console.log(`src/iconData.js: ${ICONS.length} иконок, ${(file.length / 1024).toFixed(1)} КБ`)
