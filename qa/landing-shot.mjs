import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const TAG = process.env.QA_TAG || 'до'
mkdirSync('qa-screens/_landing', { recursive: true })
const b = await chromium.launch({ headless: true })
for (const w of [320, 390]) {
  const p = await (await b.newContext({ viewport: { width: w, height: 844 }, locale: 'ru-RU' })).newPage()
  await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2000))
  await p.screenshot({ path: `qa-screens/_landing/${TAG}-${w}.png`, fullPage: true })
  const h = await p.evaluate(() => document.body.scrollHeight)
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  console.log(`${TAG} ${w}px: высота ${h}px, горизонтальная прокрутка: ${overflow ? 'ЕСТЬ (плохо)' : 'нет'}`)
}
await b.close()
