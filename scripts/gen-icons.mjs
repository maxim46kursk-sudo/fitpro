// Генератор src/iconData.js — вытаскивает ТОЛЬКО нужные иконки из наборов
// Iconify (в node_modules каждый набор — мегабайты, целиком в бандл нельзя).
// Данные попадают в сборку статически, поэтому в рантайме приложение НЕ ходит
// в api.iconify.design — важно для Telegram Mini App (работает офлайн).
//
// ЕДИНЫЙ ВЕС: берём только СПЛОШНЫЕ (filled/solid) начертания — game-icons
// (силуэты), healthicons (filled), solar '-bold' (НЕ '-bold-duotone', иначе
// полупрозрачные подложки duotone дают разнобой рядом с силуэтами).
//
// Добавить иконку: впиши имя в нужный список и запусти `node scripts/gen-icons.mjs`.
// Поиск по набору:
//   node -e "console.log(Object.keys(require('./node_modules/@iconify-json/game-icons/icons.json').icons).filter(k=>k.includes('leg')))"

import { readFileSync, writeFileSync } from 'node:fs'

// Спорт, еда, анатомия — game-icons (сплошные силуэты)
const GAME = [
  'weight-lifting-up',  // тренировки
  'meal',               // питание
  'fire',               // ккал
  'steak',              // белки
  'grain-bundle',       // углеводы
  'avocado',            // жиры
  'leg',                // ноги
  'spine-arrow',        // спина
  'biceps',             // руки
  'muscular-torso',     // кор / пресс
  'heart-organ',        // кардио
]

// Тело/здоровье — healthicons (filled)
const HEALTH = [
  'body',               // всё тело
]

// UI — solar '-bold' (сплошные, без duotone-подложек)
const SOLAR = [
  'book-bold',                // упражнения
  'notebook-bookmark-bold',   // дневник
  'users-group-rounded-bold', // клиенты
  'home-2-bold',              // главная
  'scale-bold',               // общий тоннаж
  'graph-bold',               // прогресс по упражнениям
  'calculator-bold',          // калькулятор 1ПМ
  'trash-bin-minimalistic-bold', // удалить
  'pen-bold',                 // редактировать
  'notes-bold',               // заметка к подходу
  'video-frame-bold',         // видео тренеру
  'share-bold',               // отправить отчёт
  'paperclip-bold',           // прикрепить фото
  'camera-bold',              // фото профиля
  'calendar-bold',            // дата
  'settings-bold',            // настройки
  'user-rounded-bold',        // мои данные
  'chart-bold',               // мой прогресс
  'lightbulb-bold',           // подсказка
  'ruler-bold',               // замеры
  'target-bold',              // цель
  'clipboard-bold',           // программа
  'copy-bold',                // копировать
  'folder-bold',              // шаблон/папка
  'chat-round-bold',          // комментарий / AI
  'refresh-bold',             // пройти заново
  'letter-bold',              // почта
  'bug-bold',                 // сообщить об ошибке
  'question-circle-bold',     // поддержка
  'danger-triangle-bold',     // важно/предупреждение
  'men-bold',                 // пол: мужской
  'women-bold',               // пол: женский
  'scissors-bold',            // цель «рельеф»
  'magic-stick-3-bold',       // «первое приложение с AI»
]

const SETS = [
  ['node_modules/@iconify-json/solar/icons.json', SOLAR],
  ['node_modules/@iconify-json/game-icons/icons.json', GAME],
  ['node_modules/@iconify-json/healthicons/icons.json', HEALTH],
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
// Иконки Iconify (solar/game-icons/healthicons), вшиты в сборку — offline,
// без обращений к api.iconify.design.
export const ICON_DATA = ${JSON.stringify(out, null, 2)}
`
writeFileSync('src/iconData.js', file, 'utf8')
console.log(`src/iconData.js: ${count} иконок, ${(file.length / 1024).toFixed(1)} КБ`)
