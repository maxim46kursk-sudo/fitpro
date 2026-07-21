// Генератор src/iconData.js — вытаскивает ТОЛЬКО нужные иконки из наборов
// @iconify-json/solar и @iconify-json/game-icons (в node_modules они ~6 и ~4 МБ,
// целиком в бандл их тащить нельзя). Данные попадают в сборку статически,
// поэтому в рантайме приложение НЕ ходит в api.iconify.design — важно для
// Telegram Mini App (работает офлайн, меню не ждёт сеть).
//
// Гибрид по смыслу: game-icons — спорт/еда/макросы (яркие силуэты),
// solar bold-duotone — UI (кнопки, разделы, служебные значки).
//
// Добавить иконку: впиши имя в нужный список и запусти `node scripts/gen-icons.mjs`.
// Посмотреть доступные:
//   node -e "console.log(Object.keys(require('./node_modules/@iconify-json/game-icons/icons.json').icons).filter(k=>k.includes('leg')))"

import { readFileSync, writeFileSync } from 'node:fs'

// Спорт, еда, части тела — game-icons (силуэтные, «фирменные»)
const GAME = [
  'weight-lifting-up',  // тренировки
  'meal',               // питание
  'fire',               // ккал / всё тело
  'steak',              // белки
  'grain-bundle',       // углеводы
  'avocado',            // жиры
  'leg',                // ноги
  'muscle-up',          // ягодицы
  'chest',              // грудь
  'spine-arrow',        // спина
  'shoulder-armor',     // плечи
  'biceps',             // руки
  'abdominal-armor',    // кор
  'heart-organ',        // кардио
]

// UI — solar bold-duotone
const SOLAR = [
  'book-bold-duotone',                // упражнения
  'notebook-bookmark-bold-duotone',   // дневник
  'users-group-rounded-bold-duotone', // клиенты
  'home-2-bold-duotone',              // главная
  'scale-bold-duotone',               // общий тоннаж
  'graph-bold-duotone',               // прогресс по упражнениям
  'calculator-bold-duotone',          // калькулятор 1ПМ
  'trash-bin-minimalistic-bold-duotone', // удалить
  'pen-bold-duotone',                 // редактировать
  'notes-bold-duotone',               // заметка к подходу
  'video-frame-bold-duotone',         // видео тренеру
  'share-bold-duotone',               // отправить отчёт
  'paperclip-bold-duotone',           // прикрепить фото
  'camera-bold-duotone',              // фото профиля
  'calendar-bold-duotone',            // дата
  'settings-bold-duotone',            // настройки
  'user-rounded-bold-duotone',        // мои данные
  'chart-bold-duotone',               // мой прогресс
  'lightbulb-bold-duotone',           // подсказка
  'ruler-bold-duotone',               // замеры
  'target-bold-duotone',              // цель
  'clipboard-bold-duotone',           // программа
  'copy-bold-duotone',                // копировать
  'folder-bold-duotone',              // шаблон/папка
  'chat-round-bold-duotone',          // комментарий / AI
  'refresh-bold-duotone',             // пройти заново
  'letter-bold-duotone',              // почта
  'bug-bold-duotone',                 // сообщить об ошибке
  'question-circle-bold-duotone',     // поддержка
  'danger-triangle-bold-duotone',     // важно/предупреждение
  'men-bold-duotone',                 // пол: мужской
  'women-bold-duotone',               // пол: женский
  'scissors-bold-duotone',            // цель «рельеф»
  'magic-stick-3-bold-duotone',       // «первое приложение с AI»
]

const SETS = [
  ['node_modules/@iconify-json/solar/icons.json', SOLAR],
  ['node_modules/@iconify-json/game-icons/icons.json', GAME],
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
// Иконки Solar + Game Icons, вшиты в сборку (offline, без api.iconify.design).
export const ICON_DATA = ${JSON.stringify(out, null, 2)}
`
writeFileSync('src/iconData.js', file, 'utf8')
console.log(`src/iconData.js: ${count} иконок, ${(file.length / 1024).toFixed(1)} КБ`)
