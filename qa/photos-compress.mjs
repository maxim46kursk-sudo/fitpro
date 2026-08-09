// Сжатие снимков ровно так, как это делает клиент перед отправкой.
//
// В BarcodeScanner.compressImage кадр ужимается до 1280 px по длинной стороне
// и жмётся в JPEG q0.8 — иначе оригинал с камеры (4–8 МБ) не пролезет ни в
// лимит тела Vercel, ни в наш LABEL_MAX_BASE64. Прогон обязан слать ровно то
// же, что шлёт приложение: без этого мы меряем не распознавание, а размер
// файла — семь снимков из двадцати шести отвалились с 413.
//
// Через headless-браузер, а не через библиотеку обработки картинок: так canvas
// и кодировщик JPEG те же самые, что у пользователя.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'

const LIMIT = 1_500_000            // LABEL_MAX_BASE64 в api/chat.js
const files = readdirSync('qa/photos').filter(f => /\.jpg$/.test(f))

const browser = await chromium.launch()
const page = await browser.newPage()

for (const f of files) {
  const path = `qa/photos/${f}`
  const size = statSync(path).size
  if (Math.ceil(size * 4 / 3) <= LIMIT) continue

  const b64 = readFileSync(path).toString('base64')
  const out = await page.evaluate(async ({ data, maxSide, quality }) => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/jpeg;base64,${data}` })
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(img, 0, 0, w, h)
    return { url: c.toDataURL('image/jpeg', quality), w, h }
  }, { data: b64, maxSide: 1280, quality: 0.8 })

  const buf = Buffer.from(out.url.slice(out.url.indexOf(',') + 1), 'base64')
  writeFileSync(path, buf)
  console.log(`${f}: ${Math.round(size / 1024)} КБ → ${Math.round(buf.length / 1024)} КБ (${out.w}×${out.h})`)
}

await browser.close()
console.log('\nготово: все снимки в пределах лимита')
