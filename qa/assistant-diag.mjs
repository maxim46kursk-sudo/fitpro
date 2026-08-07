// ДИАГНОСТИКА двух проблем ассистента. Ничего не чинит — только собирает факты.
//
// Проблема 1: «удалил», а запись остаётся. Снимаем всё, что нужно, чтобы
// отличить три объяснения: модель спросила подтверждение и маркер не прислала /
// прислала маркер с чужим id или датой / отчиталась об удалении вообще без
// маркера.
//
// Проблема 2: обычный вопрос без ответа. В коде уже есть AbortController на
// 45 с (AIAssistant.jsx), поэтому «нет ответа за 150 с» может быть артефактом
// прошлого замера: детектор ждал прироста текста на 60 символов, а короткое
// сообщение об ошибке столько не даёт. Здесь смотрим САМ ответ /api/chat —
// статус, время, тело — и что в итоге отрисовалось в чате.

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const OUT = 'qa-screens/_diag'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

const srk = () => {
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue
    const m = readFileSync(f, 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)$/m)
    if (m) return m[1].trim()
  }
  return null
}
const KEY = srk()
const diaryRows = async uid => {
  const r = await fetch(`https://api.fitproapp.ru/rest/v1/food_diary?user_id=eq.${uid}&select=id,date,name,kcal&order=id`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  return await r.json()
}

const R = { base: BASE, chatCalls: [], steps: {} }

try {
  mkdirSync(OUT, { recursive: true })
  const [user] = await createUsers('dg' + String(Date.now()).slice(-4), 1)
  R.user = user.email; R.uid = user.id
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()

  // Перехватываем КАЖДЫЙ вызов /api/chat: статус, время, тело ответа.
  const pending = new Map()
  page.on('request', r => { if (/\/api\/chat/.test(r.url())) pending.set(r, Date.now()) })
  page.on('response', async r => {
    if (!/\/api\/chat/.test(r.url())) return
    const started = pending.get(r.request()) || Date.now()
    let body = null
    try { body = (await r.text()).slice(0, 4000) } catch (e) { body = 'НЕ ПРОЧИТАНО: ' + e.message }
    R.chatCalls.push({ status: r.status(), ms: Date.now() - started, body })
  })
  page.on('requestfailed', r => { if (/\/api\/chat/.test(r.url())) R.chatCalls.push({ status: 'ОБРЫВ', failure: r.failure()?.errorText, ms: Date.now() - (pending.get(r) || Date.now()) }) })
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') (R.console ||= []).push(m.text().slice(0, 250)) })

  // Вход + пробный
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await page.locator('text=Попробовать бесплатно').first().click(); await sleep(700)
  await page.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await page.locator('input[type="email"]:visible').first().fill(user.email)
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await page.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
  if (await page.locator(tid('consent-accept')).count()) {
    await page.locator('text=Я даю согласие').first().click(); await sleep(300)
    await page.locator(tid('consent-accept')).click(); await page.waitForSelector('[data-screen]', { timeout: 45000 })
  }
  await sleep(2000)
  await page.locator('button:visible').first().click({ timeout: 10000 }).catch(() => {}); await sleep(900)
  await page.locator('text=Настройки').first().click({ timeout: 12000 }); await sleep(1200)
  await page.locator(tid('settings-plans')).click({ timeout: 12000 })
  await page.waitForSelector(tid('trial-start'), { timeout: 30000 }).catch(() => {})
  if (await page.locator(tid('trial-start')).count()) { await page.locator(tid('trial-start')).click(); await sleep(3500) }
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)

  await page.locator(tid('assistant-open')).click({ timeout: 12000 })
  await page.waitForSelector(tid('assistant-input'), { timeout: 25000 })

  // Читаем текст ТОЛЬКО панели чата, а не всей страницы: так видно ответ
  // модели целиком, включая короткие сообщения об ошибке.
  const chatText = () => page.evaluate(() => {
    const inp = document.querySelector('[data-testid="assistant-input"]')
    let n = inp
    for (let i = 0; i < 8 && n; i++) { n = n.parentElement; if (n && n.scrollHeight > 300) break }
    return (n?.innerText || document.body.innerText).replace(/\s+/g, ' ')
  })

  const say = async (text, name, waitMs = 60000) => {
    const callsBefore = R.chatCalls.length
    const t0 = Date.now()
    await page.locator(tid('assistant-input')).fill(text, { timeout: 12000 })
    await page.locator(tid('assistant-send')).click({ timeout: 12000 })
    // Ждём именно ОТВЕТА СЕТИ, а не прироста текста — прошлый замер ошибся тут.
    let waited = 0
    while (R.chatCalls.length === callsBefore && waited < waitMs) { await sleep(500); waited += 500 }
    await sleep(3500)   // даём отрисоваться и выполниться маркерам
    const call = R.chatCalls[R.chatCalls.length - 1]
    R.steps[name] = {
      всегоМс: Date.now() - t0,
      сетьОтветила: R.chatCalls.length > callsBefore,
      статус: call?.status, времяЗапросаМс: call?.ms,
      чат: (await chatText()).slice(-700),
    }
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log(`\n── ${name} ──`)
    console.log('   сеть ответила:', R.steps[name].сетьОтветила, '| статус:', R.steps[name].статус, '| запрос', R.steps[name].времяЗапросаМс, 'мс | всего', R.steps[name].всегоМс, 'мс')
    return R.steps[name]
  }

  // ── 1. Обычный вопрос ──
  await say('Сколько граммов белка в день нужно при весе 70 кг? Ответь одним предложением.', 'обычный-вопрос')

  // ── 2. Запись еды ──
  await say('Запиши мне в дневник питания 100 граммов гречки на обед.', 'запись-еды')
  R.diaryAfterWrite = await diaryRows(user.id)
  console.log('   food_diary после записи:', JSON.stringify(R.diaryAfterWrite))

  // ── 3. Просьба удалить ──
  const del = await say('Удали гречку из дневника питания.', 'удаление')
  R.diaryAfterDelete = await diaryRows(user.id)
  console.log('   food_diary после удаления:', JSON.stringify(R.diaryAfterDelete))

  // Разбор ответа модели на удаление: был ли маркер DEL и что в нём
  const raw = R.chatCalls[R.chatCalls.length - 1]?.body || ''
  let modelText = ''
  try {
    const j = JSON.parse(raw)
    modelText = (j.content || []).map(c => c.text || '').join('')
  } catch { modelText = '(тело не разобралось как JSON) ' + raw.slice(0, 500) }
  R.модельОтветилаНаУдаление = modelText
  const m = modelText.match(/\[DEL:\{[^}]*\}\]/)
  R.маркерDEL = m ? m[0] : null
  R.естьОбещаниеУдаления = /удал/i.test(modelText)
  console.log('\n   ОТВЕТ МОДЕЛИ НА УДАЛЕНИЕ:', modelText.slice(0, 400))
  console.log('   маркер DEL:', R.маркерDEL || 'НЕТ')
  console.log('   в тексте есть обещание удаления:', R.естьОбещаниеУдаления)

  await browser.close()
} catch (e) { R.fatal = String(e.message).slice(0, 300); console.error('УПАЛО:', R.fatal) }
finally {
  await cleanupAll().catch(e => console.error('ЧИСТКА УПАЛА:', e.message))
  writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 2), 'utf8')
  console.log('\n═══ ИТОГ ═══')
  for (const [k, v] of Object.entries(R.steps)) console.log(`  ${k}: сеть=${v.сетьОтветила} статус=${v.статус} ${v.времяЗапросаМс}мс`)
  console.log('  записей в дневнике после записи  :', (R.diaryAfterWrite || []).length)
  console.log('  записей в дневнике после удаления:', (R.diaryAfterDelete || []).length)
  console.log('  маркер DEL в ответе              :', R.маркерDEL || 'НЕТ')
}
