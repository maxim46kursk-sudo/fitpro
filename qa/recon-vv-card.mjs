// Одна карточка товара ВкусВилла в настоящем браузере: есть ли в ней
// штрих-код и КБЖУ отдельными числами.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const URL_ = 'https://vkusvill.ru/goods/zefir-sharmel-s-aromatom-vanili-255-g-33421.html'
const browser = await chromium.launch()
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  viewport: { width: 1280, height: 1200 }, locale: 'ru-RU',
})).newPage()

const json = []
page.on('response', async r => {
  const ct = r.headers()['content-type'] || ''
  if (!ct.includes('json') || /yandex|google|criteo|sentry|clarity|mindbox|vk\.com/i.test(r.url())) return
  try { const t = await r.text(); json.push({ url: r.url().slice(0, 140), size: t.length }) } catch { /* пусто */ }
})

const resp = await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 })
console.log('HTTP', resp?.status())
await page.waitForTimeout(6000)
// Пищевая ценность на ВкусВилле обычно в раскрывающемся блоке — раскроем всё.
await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)))
await page.evaluate(() => [...document.querySelectorAll('button,summary,[role=button]')]
  .filter(b => /состав|ценность|характеристик|подроб/i.test(b.textContent || '')).forEach(b => b.click()))
await page.waitForTimeout(2500)

const info = await page.evaluate(() => {
  const text = document.body.innerText
  const html = document.documentElement.innerHTML
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent) } catch { return null } }).filter(Boolean)
  const flat = JSON.stringify(ld)
  const grab = re => (text.match(re) || [null])[0]
  return {
    title: document.title.slice(0, 90),
    ldTypes: ld.map(x => x['@type'] || (x['@graph'] && '@graph')).join(','),
    ldKeys: [...new Set(flat.match(/"[a-zA-Z@]+":/g) || [])].join(' ').slice(0, 600),
    gtinInLd: (flat.match(/"gtin\d*"\s*:\s*"?\d+/i) || [null])[0],
    skuInLd: (flat.match(/"sku"\s*:\s*"?[^",}]+/i) || [null])[0],
    barcodeAnywhere: (html.match(/(штрих[-\s]?код|barcode|ean13?)[^<]{0,60}/i) || [null])[0],
    digits13: [...new Set((html.match(/\b46\d{11}\b/g) || []))].slice(0, 3),
    nutritionBlock: grab(/Пищевая ценность[\s\S]{0,400}/i),
    kcal: grab(/(калорийность|ккал)[\s\S]{0,60}/i),
    weight: grab(/\b\d+([.,]\d+)?\s*(г|кг|мл|л)\b/i),
    brand: grab(/(Бренд|Производитель|Марка)[\s:]*[^\n]{0,50}/i),
  }
})

console.log(JSON.stringify(info, null, 1).slice(0, 2000))
console.log(`\nJSON-запросов: ${json.length}`)
for (const j of json.sort((a, b) => b.size - a.size).slice(0, 8)) console.log(`   ${String(j.size).padStart(7)} б  ${j.url}`)
writeFileSync('qa/_recon-card.json', JSON.stringify({ info, json }, null, 1))
await browser.close()
