// РАЗВЕДКА, а не сбор. По одной категории на магазин, по одной странице.
//
// Смотрим то же, что видно в панели сети браузера: какими запросами страница
// тянет данные, отдаётся ли JSON, и есть ли в нём поля, без которых
// справочник бессмысленен, — прежде всего ШТРИХ-КОД.
//
// Никакого обхода защиты: обычный браузер, обычная страница, одна на магазин.
// Если магазин закрывается — это и есть результат разведки, а не препятствие,
// которое надо обойти.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const SHOPS = [
  ['vkusvill', 'https://vkusvill.ru/goods/molochnye-produkty-syry-i-yaytsa/'],
  ['5ka', 'https://5ka.ru/catalog/molochnye-produkty-syr-yaytsa/'],
  ['samokat', 'https://samokat.ru/category/moloko-syr-yayca'],
  ['perekrestok', 'https://www.perekrestok.ru/cat/c/119/molocnye-produkty-syry-i-jajca'],
]

const browser = await chromium.launch()
const out = {}

for (const [name, url] of SHOPS) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
  })
  const page = await ctx.newPage()
  const api = []

  page.on('response', async r => {
    const u = r.url()
    const ct = (r.headers()['content-type'] || '')
    if (!ct.includes('json')) return
    if (/googleapis|google-analytics|yandex|mc\.yandex|criteo|facebook|doubleclick|sentry|clarity/i.test(u)) return
    let size = 0, sample = ''
    try { const t = await r.text(); size = t.length; sample = t.slice(0, 400) } catch { /* тело уже ушло */ }
    api.push({ url: u.slice(0, 160), status: r.status(), size, sample })
  })

  let status = 'ok', title = ''
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    status = `HTTP ${resp?.status()}`
    await page.waitForTimeout(6000)
    title = (await page.title()).slice(0, 80)
  } catch (e) {
    status = `не открылась: ${e.message.slice(0, 60)}`
  }

  const body = await page.locator('body').innerText().catch(() => '')
  const blocked = /Forbidden|не робот|captcha|Доступ ограничен|請求|Request ID/i.test(body.slice(0, 600))

  out[name] = {
    url, status, title,
    blocked,
    bodyHead: body.slice(0, 220).replace(/\s+/g, ' '),
    jsonRequests: api.sort((a, b) => b.size - a.size).slice(0, 8),
  }

  console.log(`\n════ ${name} ════`)
  console.log(`${status} | заголовок: ${title}`)
  console.log(`антибот на странице: ${blocked ? 'ДА' : 'нет'}`)
  console.log(`JSON-запросов: ${api.length}`)
  for (const a of out[name].jsonRequests) console.log(`   ${String(a.size).padStart(8)} б  ${a.url}`)

  await ctx.close()
}

await browser.close()
writeFileSync('qa/_recon.json', JSON.stringify(out, null, 1))
console.log('\nподробности в qa/_recon.json')
