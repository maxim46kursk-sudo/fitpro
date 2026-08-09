// Что магазины сами пишут про автоматический сбор — в соглашении и robots.txt.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const browser = await chromium.launch()
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'ru-RU' })
const page = await ctx.newPage()

// Слова, которыми в соглашениях описывают запрет на автосбор.
const RE = /(робот|автоматизирован|автоматическ|парсинг|скрап|scrap|crawl|копирован|извлечен|базы данных|интеллектуальн)/gi

const TARGETS = [
  ['vkusvill robots', 'https://vkusvill.ru/robots.txt'],
  ['vkusvill соглашение', 'https://vkusvill.ru/company/legal-information/'],
  ['vkusvill правила', 'https://vkusvill.ru/company/user-agreement/'],
  ['5ka robots', 'https://5ka.ru/robots.txt'],
  ['samokat robots', 'https://samokat.ru/robots.txt'],
  ['perekrestok robots', 'https://www.perekrestok.ru/robots.txt'],
]

const out = {}
for (const [name, url] of TARGETS) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 })
    await page.waitForTimeout(1500)
    const txt = await page.locator('body').innerText().catch(() => '')
    const blocked = /не робот|Проверка браузера|Forbidden|ID запроса/i.test(txt.slice(0, 400))
    const hits = [...new Set(txt.match(RE) || [])].join(', ')
    // Короткие выдержки вокруг найденных слов — чтобы было что процитировать.
    const quotes = []
    for (const m of txt.matchAll(/[^.\n]{0,140}(робот|автоматизирован|автоматическ|парсинг|scrap|базы данных)[^.\n]{0,140}\./gi)) {
      if (quotes.length < 3) quotes.push(m[0].replace(/\s+/g, ' ').trim())
    }
    out[name] = { url, status: r?.status(), blocked, len: txt.length, hits, quotes }
    console.log(`\n══ ${name} (HTTP ${r?.status()}${blocked ? ', АНТИБОТ' : ''}) ══`)
    if (blocked) console.log('   страница закрыта проверкой «я не робот»')
    else {
      console.log(`   объём текста: ${txt.length}`)
      if (hits) console.log(`   ключевые слова: ${hits}`)
      for (const q of quotes) console.log(`   « ${q.slice(0, 220)} »`)
      if (!hits) console.log('   упоминаний автосбора не найдено')
    }
  } catch (e) {
    out[name] = { url, error: e.message.slice(0, 80) }
    console.log(`\n══ ${name} ══\n   не открылось: ${e.message.slice(0, 80)}`)
  }
}

writeFileSync('qa/_recon-terms.json', JSON.stringify(out, null, 1))
await browser.close()
