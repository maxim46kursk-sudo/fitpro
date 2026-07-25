// СУХОЙ ПРОГОН сопоставления видеофайлов с упражнениями. Ничего не заливает,
// не перекодирует, в базу/гит не пишет — только строит отчёт «файл → упражнение»
// для ручной проверки. Запуск: node scripts/match-videos.mjs
//
// Логика имени: имя файла без расширения → предочистка (убрать ведущий
// номер-префикс, подчёркивания/скобки → пробелы) → normalizeExerciseName из
// приложения (та же, что в fuzzyMatch.js) → скоринг против всех EXERCISES.

import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { EXERCISES } from '../src/programs.js'
import { normalizeExerciseName } from '../src/fuzzyMatch.js'

const FOLDERS = [
  { label: 'Дом', dir: 'D:/банк упражнений/Дом' },
  { label: 'Зал', dir: 'D:/банк упражнений/Зал' },
]
const REPORT_PATH = 'scripts/video-match-report.csv'

// Порог уверенности: >= CONFIDENT — уверенно, [DOUBTFUL, CONFIDENT) — спорно,
// < DOUBTFUL — не сматчилось. Подобрано под шкалу similarity ниже (0..1).
const CONFIDENT = 0.72   // тот же порог, что SIMILARITY_THRESHOLD в fuzzyMatch
const DOUBTFUL = 0.5

// ── Скоринг (fuzzyMatch.findSimilarExercise не возвращает оценку, поэтому
// считаем свою: Левенштейн-похожесть + бонус за вложенность множества слов).
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
  return dp[a.length][b.length]
}
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length)
  if (!maxLen) return 1
  return 1 - levenshtein(a, b) / maxLen
}
const tokens = s => s.split(' ').filter(Boolean)

// Вето по антонимам — та же идея, что hasAntonymConflict в fuzzyMatch.js (она
// не экспортирована, поэтому воспроизводим). Если в названиях РАЗНЫЕ корни из
// одной группы (верхний/нижний блок, сгибание/разгибание, сидя/лёжа/стоя) —
// это разные упражнения, каким бы похожим ни был остальной текст.
const ANTONYM_GROUPS = [['верхн', 'нижн'], ['сгибан', 'разгибан'], ['сидя', 'леж', 'стоя']]
function hasAntonymConflict(a, b) {
  return ANTONYM_GROUPS.some(group => {
    // Конфликт — только при ВЗАИМНО исключительных корнях: один есть у A и нет
    // у B, а другой наоборот. Иначе «сидя/лёжа» (оба корня в обоих названиях)
    // ложно считалось бы конфликтом само с собой.
    const onlyA = group.filter(r => a.includes(r) && !b.includes(r))
    const onlyB = group.filter(r => b.includes(r) && !a.includes(r))
    return onlyA.length > 0 && onlyB.length > 0
  })
}

// Оценка пары нормализованных строк. Полное множество слов файла вложено в
// упражнение (или наоборот) — сильный сигнал даже при разной длине строки.
function scorePair(nf, ne) {
  if (!nf || !ne) return 0
  if (hasAntonymConflict(nf, ne)) return 0 // верхн/нижн, сгибан/разгибан и т.п.
  if (nf === ne) return 1
  const base = similarity(nf, ne)
  const tf = tokens(nf), te = tokens(ne)
  const subset = tf.every(w => te.includes(w)) || te.every(w => tf.includes(w))
  if (subset) {
    // Доля общих слов от большего набора — чем ближе к 1, тем полнее вложение.
    const shared = tf.filter(w => te.includes(w)).length
    const cover = shared / Math.max(tf.length, te.length)
    return Math.max(base, 0.6 + 0.4 * cover)
  }
  return base
}

// Предочистка имени файла ДО normalizeExerciseName: убрать ведущий числовой
// префикс камеры (010_, 12 -, 3.) и служебные разделители.
function preclean(nameNoExt) {
  return nameNoExt
    .replace(/^\s*\d+\s*[_.\-)]*\s*/, ' ') // ведущий номер-префикс
    .replace(/[_()\[\].\-]+/g, ' ')        // разделители → пробел
    .replace(/\s+/g, ' ')
    .trim()
}

function collectMp4(dir) {
  const out = []
  const walk = d => {
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      const full = join(d, e)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (extname(e).toLowerCase() === '.mp4') out.push(full)
    }
  }
  walk(dir)
  return out
}

// Нормализованные названия упражнений считаем один раз.
const exNorms = EXERCISES.map(ex => ({ name: ex.n, norm: normalizeExerciseName(ex.n) }))

const rows = []
for (const { label, dir } of FOLDERS) {
  for (const file of collectMp4(dir)) {
    const fname = basename(file)
    const nameNoExt = fname.slice(0, fname.length - extname(fname).length)
    const cleaned = preclean(nameNoExt)
    const norm = normalizeExerciseName(cleaned)
    let best = { name: '', score: 0 }
    let second = { name: '', score: 0 }
    for (const ex of exNorms) {
      const s = scorePair(norm, ex.norm)
      if (s > best.score) { second = best; best = { name: ex.name, score: s } }
      else if (s > second.score) { second = { name: ex.name, score: s } }
    }
    const tier = best.score >= CONFIDENT ? 'confident' : best.score >= DOUBTFUL ? 'doubtful' : 'unmatched'
    rows.push({
      folder: label, file: fname, cleaned, norm,
      match: best.name, score: +best.score.toFixed(3),
      runnerUp: second.name, runnerUpScore: +second.score.toFixed(3), tier,
    })
  }
}

// ── Дубли: несколько файлов → одно упражнение (учитываем только не-unmatched).
const byExercise = new Map()
for (const r of rows) {
  if (r.tier === 'unmatched') continue
  if (!byExercise.has(r.match)) byExercise.set(r.match, [])
  byExercise.get(r.match).push(r)
}
const dupes = [...byExercise.entries()].filter(([, list]) => list.length > 1)

// ── CSV.
const esc = v => `"${String(v).replace(/"/g, '""')}"`
const header = ['folder', 'file', 'cleaned', 'norm', 'match', 'score', 'runner_up', 'runner_up_score', 'tier']
const sorted = [...rows].sort((a, b) => b.score - a.score)
const csv = [header.join(',')]
  .concat(sorted.map(r => [r.folder, r.file, r.cleaned, r.norm, r.match, r.score, r.runnerUp, r.runnerUpScore, r.tier].map(esc).join(',')))
  .join('\n')
writeFileSync(REPORT_PATH, csv, 'utf8')

// ── Сводка в консоль.
const confident = sorted.filter(r => r.tier === 'confident')
const doubtful = sorted.filter(r => r.tier === 'doubtful')
const unmatched = sorted.filter(r => r.tier === 'unmatched')

const line = (r) => `  [${r.score.toFixed(3)}] ${r.folder}/${r.file}  →  ${r.match}${r.runnerUp ? `   (2-й: ${r.runnerUp} ${r.runnerUpScore.toFixed(3)})` : ''}`

console.log(`\n===== СВОДКА СОПОСТАВЛЕНИЯ (сухой прогон) =====`)
console.log(`Всего файлов: ${rows.length}  |  уверенно: ${confident.length}  |  спорных: ${doubtful.length}  |  без матча: ${unmatched.length}`)
console.log(`Порог: уверенно >= ${CONFIDENT}, спорно >= ${DOUBTFUL}`)
console.log(`CSV: ${REPORT_PATH}`)

console.log(`\n----- УВЕРЕННО (${confident.length}) -----`)
for (const r of confident) console.log(line(r))

console.log(`\n----- СПОРНЫЕ, нужен глаз (${doubtful.length}) -----`)
for (const r of doubtful) console.log(line(r))

console.log(`\n----- БЕЗ УВЕРЕННОГО МАТЧА (${unmatched.length}) -----`)
for (const r of unmatched) console.log(`  ${r.folder}/${r.file}   (лучшее: ${r.match || '—'} ${r.score.toFixed(3)})`)

console.log(`\n----- ДУБЛИ: несколько файлов в одно упражнение (${dupes.length}) -----`)
if (!dupes.length) console.log('  нет')
for (const [ex, list] of dupes) {
  console.log(`  «${ex}»:`)
  for (const r of list) console.log(`     [${r.score.toFixed(3)}] ${r.folder}/${r.file} (${r.tier})`)
}
console.log()
