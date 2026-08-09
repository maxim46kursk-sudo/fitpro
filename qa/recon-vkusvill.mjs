// Углублённая разведка по ВкусВиллу — единственному из четырёх, кто пускает.
// Одна категория, одна карточка товара. Смотрим, есть ли штрих-код и КБЖУ
// отдельными числами.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const browser = await chromium.launch()
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'ru-RU' })
const page = await ctx.newPage()

// ── 1. Находим раздел молочки в собственном меню каталога
await page.goto('https://vkusvill.ru/goods/', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(4000)
const cats = await page.evaluate(() => [...document.querySelectorAll('a[href*="/goods/"]')]
  .map(a => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 60) }))
  .filter(x => /молоч|сыр|яйц/i.test(x.text)).slice(0, 10))
console.log('── разделы про молочку ──')
for (const c of cats) console.log(`   ${c.text}  →  ${c.href}`)

const catUrl = cats[0] ? new URL(cats[0].href, 'https://vkusvill.ru').href : null
if (!catUrl) { console.log('раздел не найден'); await browser.close(); process.exit(0) }

// ── 2. Открываем категорию и слушаем, чем страница набивается
const api = []
page.on('response', async r => {
  const ct = r.headers()['content-type'] || ''
  if (!ct.includes('json')) return
  if (/yandex|google|criteo|sentry|clarity|mindbox/i.test(r.url())) return
  try { const t = await r.text(); api.push({ url: r.url().slice(0, 140), size: t.length, sample: t.slice(0, 300) }) } catch { /* пусто */ }
})

console.log(`\n── категория: ${catUrl}`)
await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(7000)

const count = await page.evaluate(() => {
  const t = document.body.innerText
  const m = t.match(/(\d[\d\s]{1,7})\s*(товар|продукт)/i)
  return m ? m[0] : null
})
console.log(`товаров в категории (по тексту страницы): ${count || 'не нашёл'}`)
console.log(`JSON-запросов на категории: ${api.length}`)
for (const a of api.sort((x, y) => y.size - x.size).slice(0, 6)) console.log(`   ${String(a.size).padStart(7)} б  ${a.url}`)

// ── 3. Одна карточка товара: есть ли штрих-код и КБЖУ числами
const first = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a[href*="/goods/"]')].find(x => /\/goods\/[a-z0-9-]+-\d+\.html/.test(x.getAttribute('href') || ''))
  return a ? a.getAttribute('href') : null
})
const prodUrl = first ? new URL(first, 'https://vkusvill.ru').href : null
console.log(`\n── карточка товара: ${prodUrl || 'ссылку не нашёл'}`)

let card = null
if (prodUrl) {
  api.length = 0
  await page.goto(prodUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(6000)

  card = await page.evaluate(() => {
    const text = document.body.innerText
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s => { try { return JSON.parse(s.textContent) } catch { return null } }).filter(Boolean)
    // Штрих-код в разметке Schema.org зовётся gtin13/gtin/sku.
    const flat = JSON.stringify(ld)
    return {
      title: document.title.slice(0, 90),
      ldTypes: ld.map(x => x['@type']).join(','),
      hasGtin: /gtin/i.test(flat),
      gtinSample: (flat.match(/"gtin\d*"\s*:\s*"?[\d]+/i) || [null])[0],
      hasSku: /"sku"/i.test(flat),
      skuSample: (flat.match(/"sku"\s*:\s*"?[^",}]+/i) || [null])[0],
      // КБЖУ на странице: ищем подписи и числа рядом.
      kbjuText: (text.match(/Пищевая ценность[\s\S]{0,320}/i) || [null])[0],
      barcodeText: (text.match(/(штрих[- ]?код|ean)[\s:]*\d{8,14}/i) || [null])[0],
      weightText: (text.match(/\b\d+([.,]\d+)?\s*(г|кг|мл|л)\b/i) || [null])[0],
    }
  })
  console.log(JSON.stringify(card, null, 1).slice(0, 1400))
  console.log(`\nJSON-запросов на карточке: ${api.length}`)
  for (const a of api.sort((x, y) => y.size - x.size).slice(0, 6)) console.log(`   ${String(a.size).padStart(7)} б  ${a.url}`)
}

writeFileSync('qa/_recon-vv.json', JSON.stringify({ cats, catUrl, count, prodUrl, card, api: api.slice(0, 10) }, null, 1))
await browser.close()
