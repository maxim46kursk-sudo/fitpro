// РАБОТАЕТ ЛИ АССИСТЕНТ У НОВОГО ПОЛЬЗОВАТЕЛЯ.
//
// Единственная функция, которой люди пользуются каждый день и которая ни разу
// не была проверена. Прошлый прогон получил таймаут 120 с на первом же вопросе,
// и в той же секции насчитал семь ответов 406 на food_goals — отсюда подозрение,
// что одно связано с другим.
//
// Сценарий целиком: вопрос → ответ → просьба записать еду → ФАКТ записи в
// дневнике → просьба удалить → ФАКТ удаления. Проверяем дневник, а не слова
// ассистента: он вполне может отчитаться о записи, ничего не записав.
//
// Лимит: не более шести обращений к модели за прогон, один пользователь.

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens/_assistant'
const MAX_CALLS = 6
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

const R = { base: BASE, calls: 0, steps: [], net406: 0, netErrors: [], console: [] }
const note = (k, v) => { R[k] = v; console.log(`   ${k}: ${v}`) }

try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('as' + String(Date.now()).slice(-4), 1)
  R.user = user.email
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()

  page.on('response', r => {
    if (r.status() < 400) return
    if (/food_goals/.test(r.url()) && r.status() === 406) R.net406++
    R.netErrors.push({ s: r.status(), u: r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 110) })
  })
  page.on('console', m => { if (m.type() === 'error') R.console.push(m.text().slice(0, 200)) })

  // Вход + согласие + пробный (ассистент за гейтом ПРОФИТ, пробный его даёт)
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await page.locator('text=Попробовать бесплатно').first().click(); await sleep(700)
  await page.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await page.locator('input[type="email"]:visible').first().fill(user.email)
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await page.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
  if (await page.locator(tid('consent-accept')).count()) {
    await page.locator('text=Я даю согласие').first().click(); await sleep(300)
    await page.locator(tid('consent-accept')).click()
    await page.waitForSelector('[data-screen]', { timeout: 45000 })
  }
  await sleep(2000)
  await page.locator('button:visible').first().click({ timeout: 10000 }).catch(() => {}); await sleep(900)
  await page.locator('text=Настройки').first().click({ timeout: 12000 }); await sleep(1200)
  await page.locator(tid('settings-plans')).click({ timeout: 12000 })
  await page.waitForSelector(tid('trial-start'), { timeout: 30000 }).catch(() => {})
  if (await page.locator(tid('trial-start')).count()) { await page.locator(tid('trial-start')).click(); await sleep(3500) }
  note('пробный активирован', /Пробный активирован/.test(await page.evaluate(() => document.body.innerText)))
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)

  // Открыть ассистента
  const opened = await (async () => {
    for (const sel of ['text=/Спроси|ассистент/i', `${tid('assistant-input')}`]) {
      const e = page.locator(sel).first()
      if (await e.count().catch(() => 0)) { await e.click({ timeout: 8000 }).catch(() => {}); await sleep(1200) }
      if (await page.locator(tid('assistant-input')).count().catch(() => 0)) return true
    }
    // Плавающая круглая кнопка ассистента — без текста, ищем по позиции справа снизу
    const fab = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .filter(b => { const r = b.getBoundingClientRect(); return b.offsetParent && r.right > innerWidth - 90 && r.bottom > innerHeight - 190 && r.width < 90 })[0] || null)
    const el = fab.asElement()
    if (el) { await el.click({ timeout: 6000 }).catch(() => {}); await sleep(1500) }
    return await page.locator(tid('assistant-input')).count().catch(() => 0) > 0
  })()
  note('ассистент открылся', opened)
  await page.screenshot({ path: `${OUT}/1-ассистент.png` })
  if (!opened) throw new Error('вход в ассистента не найден')

  const ask = async (text, name, timeout = 150000) => {
    if (R.calls >= MAX_CALLS) { R.steps.push({ name, result: 'пропущен — лимит запросов' }); return false }
    R.calls++
    const before = await page.evaluate(() => document.body.innerText.length)
    const t0 = Date.now()
    await page.locator(tid('assistant-input')).fill(text, { timeout: 12000 })
    await page.locator(tid('assistant-send')).click({ timeout: 12000 })
    let ok = true
    try { await page.waitForFunction(n => document.body.innerText.length > n + 60, before, { timeout }) }
    catch { ok = false }
    const ms = Date.now() - t0
    R.steps.push({ name, ok, ms, вопрос: text.slice(0, 50) })
    console.log(`   ${name}: ${ok ? 'ответ за ' + ms + ' мс' : 'ОТВЕТА НЕТ за ' + Math.round(timeout / 1000) + ' с'}`)
    await sleep(1500)
    await page.screenshot({ path: `${OUT}/${R.calls + 1}-${name}.png` })
    return ok
  }

  R.answer1 = await ask('Сколько граммов белка в день нужно при весе 70 кг? Ответь кратко.', 'вопрос')
  if (R.answer1) R.lastReply = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(-260)

  await ask('Запиши мне в дневник питания 100 граммов гречки на обед.', 'запись-рациона')
  await sleep(4000)

  // ФАКТ записи — смотрим дневник, а не слова
  const openDiary = async () => {
    await page.keyboard.press('Escape').catch(() => {})
    await page.locator(tid('tab-progress')).click({ timeout: 12000 }).catch(() => {}); await sleep(1500)
    await page.locator('text=Дневник питания').first().click({ timeout: 12000 }).catch(() => {})
    await page.waitForSelector(tid('meal-breakfast'), { timeout: 25000 }).catch(() => {})
    return (await page.evaluate(() => document.body.innerText))
  }
  const afterWrite = await openDiary()
  note('запись появилась в дневнике', /гречк/i.test(afterWrite))
  await page.screenshot({ path: `${OUT}/дневник-после-записи.png` })

  // Просим удалить
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)
  const reopened = await (async () => {
    const e = page.locator('text=/Спроси|ассистент/i').first()
    if (await e.count().catch(() => 0)) { await e.click({ timeout: 8000 }).catch(() => {}); await sleep(1200) }
    return await page.locator(tid('assistant-input')).count().catch(() => 0) > 0
  })()
  if (reopened) {
    await ask('Удали гречку из дневника питания.', 'удаление-рациона')
    await sleep(4000)
    const afterDelete = await openDiary()
    note('запись исчезла из дневника', !/гречк/i.test(afterDelete))
    await page.screenshot({ path: `${OUT}/дневник-после-удаления.png` })
  } else R.steps.push({ name: 'удаление', result: 'ассистент не открылся повторно' })

  await browser.close()
} catch (e) { R.fatal = String(e.message).slice(0, 300); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 2), 'utf8')
  console.log('\n═══ АССИСТЕНТ У НОВОГО ПОЛЬЗОВАТЕЛЯ ═══')
  console.log('адрес прогона        :', R.base)
  console.log('обращений к модели   :', R.calls, 'из', MAX_CALLS)
  R.steps.forEach(s => console.log('  ', JSON.stringify(s)))
  console.log('406 на food_goals    :', R.net406)
  console.log('прочие ошибки сети   :', JSON.stringify(R.netErrors.filter(e => !/food_goals/.test(e.u)).slice(0, 5)))
  console.log('ошибки консоли       :', JSON.stringify(R.console.slice(0, 4)))
  console.log('последний ответ      :', (R.lastReply || '—').slice(-200))
}
