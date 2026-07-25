// Строит РЕДАКТИРУЕМУЮ таблицу решений scripts/video-map.csv из отчёта
// scripts/video-match-report.csv. Мой автоскоринг — только предложение;
// колонка final_exercise правится вручную. Пустой или 'skip' в final = файл
// не заливаем. Ничего не трогает, кроме записи video-map.csv.
//
// Запуск: node scripts/build-video-map.mjs

import { readFileSync, writeFileSync } from 'node:fs'

const REPORT = 'scripts/video-match-report.csv'
const OUT = 'scripts/video-map.csv'

// ── Мини-парсер CSV (значения в кавычках, экранирование "").
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += ch
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') { row.push(field); field = '' }
      else if (ch === '\n' || ch === '\r') { if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = '' } }
      else field += ch
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

const raw = parseCsv(readFileSync(REPORT, 'utf8'))
const header = raw[0]
const idx = Object.fromEntries(header.map((h, i) => [h, i]))
const data = raw.slice(1).map(r => ({
  folder: r[idx.folder], file: r[idx.file], match: r[idx.match],
  score: r[idx.score], runnerUp: r[idx.runner_up], tier: r[idx.tier],
}))

// ── Дубли: несколько файлов → одно proposed-упражнение (без unmatched).
const byMatch = new Map()
for (const r of data) {
  if (r.tier === 'unmatched' || !r.match) continue
  if (!byMatch.has(r.match)) byMatch.set(r.match, [])
  byMatch.get(r.match).push(r)
}
const dupGroupOf = new Map() // file -> group name
for (const [ex, list] of byMatch) if (list.length > 1) for (const r of list) dupGroupOf.set(r.file, ex)

// ── Курируемые решения, ключ — basename файла. {note, final}.
// final: '' или 'skip' = не заливать. Иначе — итоговое упражнение.
// PRIMARY у дубля — берём студийный (Зал) при равном движении; для домашних
// вариантов (резина) — Дом. Остальные файлы дубля → 'дубль' + skip.
const D = {
  // — Спорные, по сути верные (то же упражнение, другое написание) —
  '020_Выпады назад с гантелей на головой.mp4': { note: 'то же упражнение — брать', final: 'Выпад назад с гантелью в руке над головой' },
  '018_В планке перетаскивание гантели.mp4':    { note: 'то же упражнение — брать', final: 'В планке перетаскиваем гантель под собой' },

  // — Спорный/пробел каталога —
  '037_Тяга нижнего блока широким хватом.mp4':  { note: "в каталоге НЕТ 'нижнего широким'; ближайшее по движению 'Тяга нижнего блока с V-образной рукоятью сидя' — иначе skip", final: 'skip' },

  // — Уверенные, но матч навесил лишнее/не тот снаряд —
  'выпады с резиной.mp4':        { note: "матч навесил 'Болгарские'; это простые выпады с резиной — ближайшее 'Выпады назад на месте с резиной'", final: 'Выпады назад на месте с резиной' },
  'Жим резины .mp4':            { note: "матч навесил 'сидя' — проверь на видео сидя/стоя; если сидя, брать как есть", final: 'Жим резины сидя' },
  'Махи ноги стоя.mp4':         { note: 'Дом = резина, вероятно верно (в имени резина опущена)', final: 'Махи ноги стоя с резиной' },

  // — Ягодичный мост: три файла форсированы в «со штангой» (разный снаряд) —
  '04_Ягодичный мост.mp4':      { note: 'основной для «Ягодичный мост со штангой» (студия); движение то же', final: 'Ягодичный мост со штангой' },
  'ягодичный мост .mp4':        { note: 'дубль к Зал/04 (дома без снаряда, каталог только «со штангой»)', final: 'skip' },
  'ягодичный мост с резиной .mp4': { note: 'нет двуногой резина-версии в каталоге — skip (есть только «на одной ноге с резиной»)', final: 'skip' },

  // — Приседания: штанга/гантель/дом форсированы в «Приседания» —
  '01_Приседания со штангой .mp4': { note: 'основной для «Приседания» (студия, база)', final: 'Приседания' },
  '02_Приседания с гантелью.mp4':  { note: 'дубль к Зал/01 (снаряд гантель; каталог — только «Приседания»)', final: 'skip' },
  'Приседания .mp4':               { note: 'дубль к Зал/01 (дома без снаряда)', final: 'skip' },

  // — Отведение согнутой ноги: файл без резины дублирует версию с резиной —
  'отведение согнутой ноги стоя в наклоне .mp4': { note: 'нет версии без резины; дубль к «…с резиной» (Дом) — skip', final: 'skip' },

  // — Прочие дубли зал/дом (одно движение) — основной студийный (Зал) —
  '03_Болгарские выпады .mp4':  { note: 'основной (студия)', final: 'Болгарские выпады' },
  'Болгарские выпады .mp4':     { note: 'дубль к Зал/03', final: 'skip' },
  '027_Вращение корпуса сидя на ягодицах.mp4': { note: 'основной (студия)', final: 'Вращение корпуса сидя на ягодицах' },
  'Вращения корпуса сидя на ягодицах .mp4':    { note: 'дубль к Зал/027', final: 'skip' },
  '015_Складка.mp4':            { note: 'основной (студия)', final: 'Складка' },
  'Складка .mp4':               { note: 'дубль к Зал/015', final: 'skip' },
  '016_Скручивания лёжа на полу.mp4': { note: 'основной (студия)', final: 'Скручивания лёжа на полу' },
  'Скручивания лёжа на полу.mp4':     { note: 'дубль к Зал/016', final: 'skip' },
  '014_Спайдер.mp4':            { note: 'основной (студия)', final: 'Спайдер' },
  'Спайдер.mp4':                { note: 'дубль к Зал/014', final: 'skip' },
  '030_Румынская тяга стоя на одной ноге с отведением второй ноги назад .mp4': { note: 'основной (студия)', final: 'Румынская стоя на одной ноге с отведением второй ноги назад' },
  'Румыгская тяга на одной ноге с отведение другой ноги назад.mp4':            { note: 'дубль к Зал/030 (в имени опечатка «Румыгская»)', final: 'skip' },
  '031_Румынская тяга на одной ноге с упором другой ноги в стену.mp4':         { note: 'основной (студия)', final: 'Румынская на одной ноге с упором другой ноги в стену' },
  'Румыгская тяга на одной ноге с упорои второй ноги в стену.mp4':             { note: 'дубль к Зал/031', final: 'skip' },
  // — Пара «выпады на месте» (оба Зал) —
  '022_Выпады на месте .mp4':   { note: 'основной; проверь направление «назад» на видео', final: 'Выпады назад на месте' },
  '05_выпады на месте .mp4':    { note: 'дубль к Зал/022', final: 'skip' },
  // — Ложная пара с «упором грудью»: 050 верный, 037 отдельно (см. выше) —
  '050_Тяга нижнего блока с упором грудью.mp4': { note: 'верный; 037 — другой (широким хватом), не дубль', final: 'Тяга нижнего блока с упором грудью' },
}

function decide(r) {
  const ov = D[r.file]
  if (ov) return { note: ov.note, final: ov.final }
  if (r.tier === 'confident') return { note: '', final: r.match }
  if (r.tier === 'doubtful') return { note: 'спорно — проверь глазами', final: '' }
  return { note: 'нет уверенного матча', final: '' }
}

const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
const cols = ['file', 'proposed_exercise', 'confidence', 'second_candidate', 'dup_group', 'note', 'final_exercise']
const out = [cols.join(',')]
const decidedRows = []
for (const r of data) {
  const dg = dupGroupOf.get(r.file) || ''
  const { note, final } = decide(r)
  const rec = {
    file: `${r.folder}/${r.file}`, proposed: r.match, confidence: r.score,
    second: r.runnerUp, dup: dg, note, final,
  }
  out.push([rec.file, rec.proposed, rec.confidence, rec.second, rec.dup, rec.note, rec.final].map(esc).join(','))
  if (note || dg) decidedRows.push(rec)
}
writeFileSync(OUT, out.join('\n'), 'utf8')

// ── Печать ТОЛЬКО строк с предложенным решением (спорные + дубли + правки).
console.log(`\nvideo-map.csv: ${data.length} строк. Требуют решения: ${decidedRows.length}\n`)
const skip = decidedRows.filter(r => !r.final || r.final === 'skip')
const keep = decidedRows.filter(r => r.final && r.final !== 'skip')
console.log(`=== ОСТАВИТЬ / ПЕРЕНАЗНАЧИТЬ (${keep.length}) ===`)
for (const r of keep) console.log(`  ${r.file}\n     → ${r.final}${r.dup ? `   [дубль-группа: ${r.dup}]` : ''}\n     ${r.note} (score ${r.confidence}, 2-й: ${r.second})`)
console.log(`\n=== SKIP — не заливать (${skip.length}) ===`)
for (const r of skip) console.log(`  ${r.file}  —  ${r.note}${r.dup ? `   [группа: ${r.dup}]` : ''}`)
console.log()
