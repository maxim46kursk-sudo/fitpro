// Разведка перед прогоном: один пользователь проходит по экранам и выгружает
// то, что на них РЕАЛЬНО есть — подписи кнопок, полей ввода, заголовки.
//
// Зачем отдельно от run.mjs: у приложения нет data-testid, и селекторы для
// прогона иначе приходится угадывать по исходнику. Угаданный селектор,
// который не нашёлся, выглядит в отчёте как «сломанный экран» — то есть
// разведка нужна, чтобы прогон не выдумывал находки на ровном месте.
//
// Ничего не нажимает вслепую и ничего не меняет — только читает и снимает.

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const BASE = 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens/_explore'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Всё интерактивное, что видно на экране прямо сейчас.
const dump = page => page.evaluate(() => {
  const vis = el => el.offsetParent !== null && el.getBoundingClientRect().height > 0
  const txt = el => (el.innerText || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  return {
    buttons: [...document.querySelectorAll('button')].filter(vis).map(txt).filter(Boolean),
    inputs: [...document.querySelectorAll('input,textarea,select')].filter(vis)
      .map(el => `${el.tagName.toLowerCase()}[${el.type || ''}] ${el.placeholder || el.value || ''}`.trim().slice(0, 60)),
    links: [...document.querySelectorAll('a')].filter(vis).map(txt).filter(Boolean).slice(0, 15),
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(txt).filter(Boolean),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
  }
})

const map = {}
let created = []

try {
  mkdirSync(OUT, { recursive: true })
  const runId = 'explore' + String(Date.now()).slice(-4)
  created = await createUsers(runId, 1)
  const user = created[0]

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
  const page = await ctx.newPage()

  const snap = async name => {
    await sleep(1200)
    map[name] = await dump(page)
    await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {})
    console.log(`\n── ${name} ──`)
    console.log('  кнопки :', JSON.stringify(map[name].buttons))
    console.log('  поля   :', JSON.stringify(map[name].inputs))
    console.log('  текст  :', map[name].text.slice(0, 220))
  }

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await snap('01-лендинг')

  await page.locator('text=Начать бесплатно').first().click()
  await sleep(800)
  await page.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await snap('02-форма-входа')

  await page.locator('input[type="email"]:visible').first().fill(user.email)
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await page.waitForFunction(() => /Поехали|Тренировки/.test(document.body.innerText), { timeout: 45000 })
  await snap('03-согласие')

  await page.locator('text=Я даю согласие').first().click().catch(() => {})
  await sleep(400)
  await page.getByRole('button', { name: /Поехали/ }).first().click()
  await page.waitForFunction(() => /Тренировки|Питание/.test(document.body.innerText), { timeout: 45000 })
  await snap('04-главный')

  // Нижние вкладки — по одному снимку на каждую.
  for (const tab of ['Питание', 'Упражнения', 'Дневник', 'Тренировки']) {
    const el = page.locator('button:visible, div:visible').filter({ hasText: new RegExp(`^${tab}$`) }).last()
    if (await el.count().catch(() => 0)) { await el.click().catch(() => {}); await snap(`05-вкладка-${tab}`) }
    else console.log(`  (вкладка ${tab} не найдена)`)
  }

  writeFileSync(`${OUT}/map.json`, JSON.stringify(map, null, 2), 'utf8')
  console.log(`\nКарта: ${OUT}/map.json`)
  await browser.close()
} catch (e) {
  console.error('разведка упала:', e.message)
  writeFileSync(`${OUT}/map.json`, JSON.stringify(map, null, 2), 'utf8')
} finally {
  console.log('\n=== чистка ===')
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
}
