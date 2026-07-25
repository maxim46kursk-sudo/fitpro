// Заливка видео упражнений в Supabase Storage (self-hosted) + заполнение
// справочника exercise_videos. Оригиналы НЕ трогает: перекодирует во временные
// файлы, заливает, временные удаляет. Идемпотентно (x-upsert + merge-duplicates).
//
// Требует env:
//   SUPABASE_SERVICE_ROLE_KEY — service_role JWT (bypassrls). НЕ печатается.
//   FFMPEG / FFPROBE — пути к бинарям (иначе берём из PATH).
// Запуск: SUPABASE_SERVICE_ROLE_KEY=... FFMPEG=... node scripts/upload-videos.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const BASE = 'https://api.fitproapp.ru'
const MAP = 'scripts/video-map.csv'
const TMP = 'C:/Users/maxim/AppData/Local/Temp/claude/c--Users-maxim-Desktop-fitpro/b68c2133-89cc-4e59-bf76-b0625f3aa861/scratchpad/vid-tmp'
const DIRS = { 'Дом': 'D:/банк упражнений/Дом', 'Зал': 'D:/банк упражнений/Зал' }
const FOLDER_SLUG = { 'Дом': 'dom', 'Зал': 'zal' }
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
// Опции перезаливки: SKIP_POSTERS=1 — не трогать постеры; SKIP_CATALOG=1 — не
// переписывать справочник exercise_videos (напр. при перекодировке видео, когда
// ссылки версионируются отдельным шагом).
const SKIP_POSTERS = process.env.SKIP_POSTERS === '1'
const SKIP_CATALOG = process.env.SKIP_CATALOG === '1'

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!KEY) { console.error('НЕТ SUPABASE_SERVICE_ROLE_KEY в env'); process.exit(1) }
const authHeaders = { Authorization: `Bearer ${KEY}`, apikey: KEY }

mkdirSync(TMP, { recursive: true })

// ── CSV-парсер (кавычки, экранирование "").
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { row.push(f); f = '' }
    else if (ch === '\n' || ch === '\r') { if (f !== '' || row.length) { row.push(f); rows.push(row); row = []; f = '' } }
    else f += ch
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row) }
  return rows
}

const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }
function slugify(s) {
  const lat = s.toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
  return lat.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-')
}

async function uploadObject(bucket, path, buf, contentType) {
  const res = await fetch(`${BASE}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  })
  if (!res.ok) throw new Error(`upload ${bucket}/${path} -> ${res.status} ${await res.text().catch(() => '')}`)
}
const publicUrl = (bucket, path) => `${BASE}/storage/v1/object/public/${bucket}/${path}`

// ── Читаем таблицу решений.
const raw = parseCsv(readFileSync(MAP, 'utf8'))
const H = Object.fromEntries(raw[0].map((h, i) => [h, i]))
const rows = raw.slice(1).map(r => ({
  fileCell: r[H.file], proposed: r[H.proposed_exercise], dup: r[H.dup_group],
  note: r[H.note], final: (r[H.final_exercise] || '').trim(),
}))

// Уникальные ascii-имена объектов (детерминированно, устойчиво к повторам).
const usedNames = new Set()
function objectName(folder, basename) {
  const noExt = basename.replace(/\.[^.]+$/, '')
  let base = `${FOLDER_SLUG[folder]}-${slugify(noExt)}` || `${FOLDER_SLUG[folder]}-file`
  let name = base, i = 2
  while (usedNames.has(name)) name = `${base}-${i++}`
  usedNames.add(name)
  return name
}

const report = { uploadedVideos: 0, uploadedPosters: 0, failures: [], catalog: [], skipped: [] }
const catalogByExercise = new Map()

let n = 0
for (const r of rows) {
  n++
  const [folder, basename] = r.fileCell.split('/')
  const srcDir = DIRS[folder]
  const src = join(srcDir, basename)
  const name = objectName(folder, basename)
  const outMp4 = join(TMP, `${name}.mp4`)
  const outJpg = join(TMP, `${name}.jpg`)
  const tag = `[${n}/${rows.length}] ${folder}/${basename}`
  try {
    // Перекодировка: H.264, высота до 720 (без апскейла, чётная ширина),
    // faststart, CRF 23. Звук СОХРАНЯЕМ (AAC 128k) — в роликах голосом
    // объясняется техника. Если у источника нет аудио — ffmpeg просто не
    // создаёт дорожку, ошибки нет. Оригинал не трогаем.
    execFileSync(FFMPEG, ['-y', '-i', src,
      '-vf', "scale=-2:'min(720,ih)'",
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k', outMp4],
      { stdio: 'ignore' })

    await uploadObject('exercise-videos', `${name}.mp4`, readFileSync(outMp4), 'video/mp4')
    report.uploadedVideos++

    // Постеры генерируем/заливаем только в полном прогоне. SKIP_POSTERS=1 —
    // перезаливка одного лишь видео (постеры уже в хранилище, не трогаем).
    if (!SKIP_POSTERS) {
      execFileSync(FFMPEG, ['-y', '-i', src, '-frames:v', '1', '-q:v', '3', outJpg], { stdio: 'ignore' })
      await uploadObject('exercise-posters', `${name}.jpg`, readFileSync(outJpg), 'image/jpeg')
      report.uploadedPosters++
    }

    const vUrl = publicUrl('exercise-videos', `${name}.mp4`)
    const pUrl = publicUrl('exercise-posters', `${name}.jpg`)

    if (r.final && r.final.toLowerCase() !== 'skip') {
      catalogByExercise.set(r.final, { exercise_name: r.final, video_url: vUrl, poster_url: pUrl, file: r.fileCell, object: name })
    } else {
      report.skipped.push({ file: r.fileCell, object: name, video_url: vUrl, reason: r.note || (r.dup ? `дубль: ${r.dup}` : 'нет каталожного соответствия') })
    }
    console.log(`${tag}  OK  -> ${name}`)
  } catch (e) {
    report.failures.push({ file: r.fileCell, error: String(e.message || e) })
    console.log(`${tag}  FAIL  ${String(e.message || e).slice(0, 200)}`)
  } finally {
    try { rmSync(outMp4, { force: true }) } catch {}
    try { rmSync(outJpg, { force: true }) } catch {}
  }
}

// ── Upsert справочника (merge-duplicates по PK exercise_name).
const catalogRows = [...catalogByExercise.values()]
if (SKIP_CATALOG) {
  console.log(`\nСправочник: SKIP_CATALOG=1 — exercise_videos не трогаем.`)
} else if (catalogRows.length) {
  const now = new Date().toISOString()
  const body = catalogRows.map(c => ({ exercise_name: c.exercise_name, video_url: c.video_url, poster_url: c.poster_url, updated_at: now }))
  const res = await fetch(`${BASE}/rest/v1/exercise_videos`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  })
  if (!res.ok) { console.error(`CATALOG UPSERT FAIL -> ${res.status} ${await res.text().catch(() => '')}`); process.exitCode = 1 }
  else console.log(`\nСправочник: upsert ${catalogRows.length} строк — OK`)
}
report.catalog = catalogRows.map(c => ({ exercise: c.exercise_name, file: c.file, object: c.object }))

// ── Итоговый отчёт (JSON в файл + сводка в консоль).
writeFileSync('scripts/upload-report.json', JSON.stringify(report, null, 2), 'utf8')

console.log(`\n===== ОТЧЁТ ЗАЛИВКИ =====`)
console.log(`Видео залито:   ${report.uploadedVideos}/${rows.length}`)
console.log(`Постеров:       ${report.uploadedPosters}/${rows.length}`)
console.log(`Ошибок:         ${report.failures.length}`)
console.log(`В справочнике:  ${report.catalog.length} упражнений`)
console.log(`\n--- УПРАЖНЕНИЕ → живой файл (${report.catalog.length}) ---`)
for (const c of report.catalog.sort((a, b) => a.exercise.localeCompare(b.exercise, 'ru'))) console.log(`  ${c.exercise}  ←  ${c.file}  [${c.object}]`)
console.log(`\n--- Залито в хранилище, но НЕ показано в приложении (${report.skipped.length}) ---`)
for (const s of report.skipped) console.log(`  ${s.file}  [${s.object}]  —  ${s.reason}`)
if (report.failures.length) {
  console.log(`\n--- ОШИБКИ (${report.failures.length}) ---`)
  for (const f of report.failures) console.log(`  ${f.file}  —  ${f.error}`)
}
console.log(`\nОтчёт: scripts/upload-report.json`)
