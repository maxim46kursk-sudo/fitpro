// Сборка fitpro_export.md — снимка исходников для переноса в новый чат.
//
// Раньше файл собирался руками, и это видно по нему: часть проекта в снимок
// не попадала просто потому, что о ней забывали. Теперь список файлов
// вычисляется из дерева, а порядок задан явно — тем же, что сложился в
// прежнем файле, чтобы диффы между снимками оставались читаемыми.
//
// Запуск: npm run export
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'

// ── Что НЕ включаем
// Бинарники и данные: в снимке они бесполезны, а объём раздувают вчетверо.
// package-lock.json — то же самое, плюс он полностью выводится из package.json.
// Сам экспорт и рабочие заметки — иначе снимок начнёт содержать себя.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vercel', 'qa/photos', 'qa/shots'])
const SKIP_FILES = new Set(['package-lock.json', 'fitpro_export.md'])
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.xlsx', '.csv', '.zip', '.pdf', '.mp4'])
// Рабочие заметки по проекту — не исходники; в прежнем снимке их тоже не было.
const SKIP_ROOT_MD = /^(fitpro_handoff|fitpro_security_\d+)\.md$/

const LANG = {
  '.jsx': 'jsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js',
  '.sql': 'sql', '.json': 'json', '.html': 'html', '.css': 'css',
  '.svg': 'xml', '.py': 'python', '.md': 'md', '.yml': 'yaml', '.yaml': 'yaml',
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = dir === '.' ? e : `${dir}/${e}`
    // Отсекаем каталог .git целиком, но НЕ .gitignore: он часть проекта и в
    // прежнем снимке был. Проверка по точному имени, а не по префиксу.
    if (SKIP_DIRS.has(p) || SKIP_DIRS.has(e) || e === '.git') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// Всё, что игнорирует git, — в снимок не берём. Это не только про мусор:
// в qa/ лежат кэши выгрузок из Open Food Facts на сотни килобайт, которые
// раздували снимок и ничего о коде не сообщали.
const ignored = new Set(
  execSync('git ls-files --others --ignored --exclude-standard --directory')
    .toString().split('\n').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
)
const isIgnored = p => {
  if (ignored.has(p)) return true
  // Каталог целиком тоже мог приехать одной строкой.
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    if (ignored.has(p.slice(0, i))) return true
  }
  return false
}

const ext = p => (p.includes('.') ? p.slice(p.lastIndexOf('.')) : '')
const all = walk('.').filter(p => {
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (SKIP_FILES.has(base) || SKIP_EXT.has(ext(p))) return false
  if (!p.includes('/') && SKIP_ROOT_MD.test(base)) return false
  if (isIgnored(p)) return false
  return true
})

const has = p => all.includes(p)
const sorted = list => [...list].sort()

// ── Порядок секций. Тот же, что сложился в прежнем снимке: сперва то, что
// читают первым (главные экраны и промты), затем всё остальное группами.
const SRC_FIRST = [
  'src/App.jsx', 'src/AIAssistant.jsx', 'src/ConstructorView.jsx',
  'src/aiPrompt.js', 'src/workoutPrompt.js', 'src/programs.js',
  'src/constructorPhases.js', 'src/fuzzyMatch.js', 'src/oneRepMax.js',
  'src/config.js', 'src/supabase.js', 'src/main.jsx',
].filter(has)

const isCode = p => ['.js', '.jsx', '.mjs'].includes(ext(p))
const srcRest = sorted(all.filter(p => p.startsWith('src/') && isCode(p) && !SRC_FIRST.includes(p)))
const apiFirst = has('api/telegram-auth.js') ? ['api/telegram-auth.js'] : []
const apiRest = sorted(all.filter(p => p.startsWith('api/') && !apiFirst.includes(p)))
const sqlAll = [...sorted(all.filter(p => p.startsWith('sql/'))), ...(has('supabase_setup.sql') ? ['supabase_setup.sql'] : [])]
const tests = sorted(all.filter(p => !p.includes('/') && /^test-/.test(p)))
const qa = sorted(all.filter(p => p.startsWith('qa/')))
const scripts = sorted(all.filter(p => p.startsWith('scripts/') && p !== 'scripts/build-export.mjs'))
const srcOther = sorted(all.filter(p => p.startsWith('src/') && !isCode(p)))

// Сам сборщик добавляется последней секцией вручную, поэтому здесь он тоже
// «занят» — иначе попадёт в снимок дважды.
const taken = new Set([...SRC_FIRST, ...srcRest, ...apiFirst, ...apiRest, ...sqlAll, ...tests, ...qa, ...scripts, ...srcOther, 'scripts/build-export.mjs'])
const rest = sorted(all.filter(p => !taken.has(p)))

const order = [...SRC_FIRST, ...srcRest, ...apiFirst, ...apiRest, ...sqlAll, ...tests, ...qa, ...scripts, ...srcOther, ...rest, 'scripts/build-export.mjs'].filter(has)

// ── Шапка
const head = execSync('git rev-parse --short HEAD').toString().trim()
// Сам экспорт и этот скрипт из проверки исключены: файл переписывается каждым
// запуском и всегда «грязный», а предупреждать надо о ЧУЖИХ несохранённых
// правках — иначе снимок разойдётся с коммитом, который в нём указан.
const dirty = execSync('git status --porcelain').toString().trim().split('\n')
  .filter(l => l && !/fitpro_export\.md|scripts\/build-export\.mjs/.test(l)).join('\n')
const now = new Date()
const p2 = n => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`

const testFiles = JSON.parse(readFileSync('package.json', 'utf8')).scripts.test
  .split('&&').map(s => s.trim().replace(/^node\s+/, '')).filter(Boolean)
const extra = testFiles.filter(f => f !== 'test-progression.mjs' && f !== 'test-nutrition.mjs')

const lines = [
  '# FitPro — экспорт исходников для нового чата',
  '',
  `Собрано ${stamp} из ${head} (main).${dirty ? ' ВНИМАНИЕ: рабочее дерево было не чистым.' : ''}`,
  '',
  `Полный снимок проекта: ${order.length} файлов — весь \`src/\`, все функции \`api/\`,`,
  'схема и миграции `sql/`, тесты, оснастка прогонов `qa/`, конфиги,',
  'вспомогательные `scripts/`.',
  'Не включены бинарные файлы, xlsx/csv-данные, package-lock.json и рабочие',
  'заметки (`fitpro_handoff.md`, `fitpro_security_*.md`).',
  '',
  'Тесты лежат в `test-progression.mjs` (движок прогрессии) и `test-nutrition.mjs`',
  '(calcMacroGoals), запускаются вместе через `npm test`. Той же командой сейчас',
  `гоняются ещё ${extra.length} наборов:`,
  // Перенос по ширине, как в прежнем снимке: длинная строка списка плохо
  // читается в диффе между снимками.
  ...wrap(extra.map(f => `\`${f}\``).join(', ') + '.', 74),
  '',
]

function wrap(text, width) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

for (const p of order) {
  const lang = LANG[ext(p)] ?? ''
  lines.push(`## \`${p}\``, '', '```' + lang, readFileSync(p, 'utf8').replace(/\s*$/, ''), '```', '')
}

writeFileSync('fitpro_export.md', lines.join('\n'))
console.log(`fitpro_export.md: ${order.length} файлов, ${Math.round(lines.join('\n').length / 1024)} КБ, из ${head}`)
