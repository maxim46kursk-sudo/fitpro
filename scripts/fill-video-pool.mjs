// Заполняет public.video_pool всеми 85 роликами из scripts/upload-report.json.
// URL выводятся детерминированно из storage-ключа (object). Идемпотентно
// (merge-duplicates по key). Требует env SUPABASE_SERVICE_ROLE_KEY (не печатаем).
// Запуск: SUPABASE_SERVICE_ROLE_KEY=... node scripts/fill-video-pool.mjs

import { readFileSync } from 'node:fs'

const BASE = 'https://api.fitproapp.ru'
const VID = `${BASE}/storage/v1/object/public/exercise-videos`
const POS = `${BASE}/storage/v1/object/public/exercise-posters`

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!KEY) { console.error('НЕТ SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const report = JSON.parse(readFileSync('scripts/upload-report.json', 'utf8'))

// Читаемое имя из пути файла: без папки, без расширения, без ведущего номера.
function titleFrom(fileCell) {
  const base = (fileCell.split('/').pop() || '').replace(/\.[^.]+$/, '')
  return base.replace(/^\s*\d+\s*[_.\-)]*\s*/, '').replace(/\s+/g, ' ').trim()
}

// Все 85 = catalog (71) + skipped (14). У обоих есть object и file.
const all = [...report.catalog.map(c => ({ object: c.object, file: c.file })),
             ...report.skipped.map(s => ({ object: s.object, file: s.file }))]

const rows = all.map(r => ({
  key: r.object,
  title: titleFrom(r.file),
  folder: r.object.startsWith('zal-') ? 'zal' : 'dom',
  video_url: `${VID}/${r.object}.mp4`,
  poster_url: `${POS}/${r.object}.jpg`,
}))

// Защита от дублей ключей (не должно быть).
const seen = new Set()
for (const r of rows) { if (seen.has(r.key)) console.warn('дубль key:', r.key); seen.add(r.key) }

const res = await fetch(`${BASE}/rest/v1/video_pool`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${KEY}`, apikey: KEY,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify(rows),
})
if (!res.ok) { console.error(`UPSERT FAIL -> ${res.status} ${await res.text().catch(() => '')}`); process.exit(1) }
console.log(`Upsert video_pool: ${rows.length} строк отправлено (уникальных ключей: ${seen.size}).`)
