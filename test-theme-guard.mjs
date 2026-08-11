// test-theme-guard.mjs — один источник цвета в проекте.
//
// Палитра живёт в src/theme.js. Экраны, которые заводят собственные цвета,
// со временем расходятся с приложением — ровно это и случилось с Конструктором
// (свой фиолетовый + десяток tailwind-серых, см. reports/constructor-ui/).
// Здесь это ловится механически: в поднадзорных файлах цветовых литералов
// быть не должно вообще, только импорт токенов.
//
// Проверка намеренно текстовая, а не «прогнать и посмотреть»: цвет,
// прокравшийся мимо токенов, виден глазами далеко не сразу, а вот в исходнике
// он всегда выглядит одинаково — #rgb, #rrggbb или rgb()/rgba().
//
// Запуск: node test-theme-guard.mjs

import { readFileSync } from 'node:fs'

let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failed++
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${!ok && detail ? `\n   → ${detail}` : ''}`)
}

// Единственное место, где литералы законны, — сам файл токенов.
const SOURCE = 'src/theme.js'

// Файлы, которые обязаны брать палитру из theme.js и не заводить своей.
// noOwnLiterals — экраны, вычищенные полностью: там цветовых литералов не
// должно остаться вообще. Остальные пока держат отдельные разовые цвета
// (подсветки, состояния) — с них спрашивается только отсутствие СВОЕЙ КОПИИ
// палитры: именно копия расходится с приложением и ради неё всё затевалось.
const GUARDED = [
  { file: 'src/ConstructorView.jsx', noOwnLiterals: true },
  { file: 'src/App.jsx', noOwnLiterals: false },
  { file: 'src/AIAssistant.jsx', noOwnLiterals: false },
  { file: 'src/BarcodeScanner.jsx', noOwnLiterals: false },
  { file: 'src/FoodDiary.jsx', noOwnLiterals: false },
  { file: 'src/HubCard.jsx', noOwnLiterals: false },
  { file: 'src/TrainerSession.jsx', noOwnLiterals: false },
]

// Комментарии не в счёт: «#111 больше не используем» — это пояснение, а не цвет.
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const COLOR_RX = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g
// Объявление собственного токена палитры — то, чего быть не должно нигде,
// кроме theme.js.
const OWN_TOKEN_RX = /^\s*(?:const|let)\s+([A-Z0-9_]+)\s*=\s*['"`](?:#|rgba?\()/gm

const themeSrc = readFileSync(SOURCE, 'utf8')
const TOKEN_NAMES = [...themeSrc.matchAll(/export const ([A-Z0-9_]+)\s*=/g)].map(m => m[1])

for (const { file, noOwnLiterals } of GUARDED) {
  const code = stripComments(readFileSync(file, 'utf8'))
  check(`${file}: цвета импортируются из theme.js`, /from\s+['"]\.\/theme\.js['"]/.test(code))

  // Своя копия токена — главный запрет: именно так палитры и разъезжались.
  const own = [...code.matchAll(OWN_TOKEN_RX)].map(m => m[1]).filter(n => TOKEN_NAMES.includes(n))
  check(`${file}: не объявляет собственную копию токенов`, own.length === 0,
    `свои объявления: ${own.join(', ')}`)

  if (noOwnLiterals) {
    const found = code.match(COLOR_RX) || []
    check(`${file}: ни одного цветового литерала`, found.length === 0,
      `найдено ${found.length}: ${[...new Set(found)].join(', ')}`)
  }
}

// Токены объявлены там, где им и место, и экспортированы наружу.
const theme = themeSrc
const REQUIRED = ['BG', 'SURF', 'SURF2', 'SEP', 'HAIR', 'TXT', 'TXT2', 'TXT3', 'PUR', 'ACCENT2', 'TEA', 'BLU', 'COR', 'KCAL', 'DANGER']
for (const t of REQUIRED) {
  check(`theme.js экспортирует ${t}`, new RegExp(`export const ${t}\\s*=`).test(theme))
}

// Значения при переносе не менялись — сверяем с тем, что было в App.jsx до
// выноса (значения зафиксированы здесь намеренно: если кто-то «поправит»
// оттенок в theme.js, тест обязан об этом сказать вслух).
const EXPECTED = {
  BG: '#0b0b0d', SURF: '#1c1c1e', SURF2: '#2c2c2e', SEP: 'rgba(255,255,255,0.09)',
  HAIR: 'rgba(255,255,255,0.12)', TXT: '#ffffff', TXT2: 'rgba(235,235,245,0.62)',
  TXT3: 'rgba(235,235,245,0.30)', PUR: '#7C7AF0', ACCENT2: '#9D96FF', TEA: '#30D158',
  BLU: '#0A84FF', COR: '#FF9F0A', KCAL: '#BF5AF2', DANGER: '#FF453A',
}
for (const [name, value] of Object.entries(EXPECTED)) {
  const m = theme.match(new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`))
  check(`${name} сохранил прежнее значение`, m?.[1] === value, `в theme.js ${m?.[1] ?? '(нет)'}, ожидалось ${value}`)
}

console.log('\n────────────────────────────────────────────────────────────────────')
console.log(`Итог: ${passed} пройдено, ${failed} провалено`)
process.exit(failed ? 1 : 0)
