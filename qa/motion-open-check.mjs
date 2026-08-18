// Раздел Motion открыт всем: проверка под ОБЫЧНЫМ клиентским аккаунтом.
//
// Без ключей в адресе и без роли: заходим ровно так, как зайдёт участник.
// Заодно смотрим, что клиенту не досталось тренерских кнопок — карточка стоит
// рядом с ними, и открыть её всем было легко заодно открыв и их.
import { chromium } from 'playwright'
import { createUsers, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'https://fitpro-dun.vercel.app'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const R = {}

try {
  const [u] = await createUsers('op' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', permissions: ['camera'] })).newPage()
  const posts = []
  p.on('response', r => { if (/action=motion-log/.test(r.url())) posts.push(r.status()) })

  // адрес чистый: ни ?motion=1, ни ?trainer=1
  await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await p.locator('text=Начать').first().click(); await sleep(700)
  await p.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await p.locator('input[type="email"]:visible').first().fill(u.email)
  await p.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await p.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await p.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
  if (await p.locator(tid('consent-accept')).count()) {
    await p.locator('text=Я даю согласие').first().click(); await sleep(300)
    await p.locator(tid('consent-accept')).click(); await p.waitForSelector('[data-screen]', { timeout: 45000 })
  }
  await sleep(2500)

  await p.locator(tid('tab-workouts')).click({ force: true }); await sleep(2500)
  R.карточкаВидна = (await p.locator(tid('program-folder-motion')).count()) > 0
  R.карточкаПервая = await p.evaluate(() =>
    document.querySelectorAll('[data-testid^="program-folder-"]')[0]?.getAttribute('data-testid') === 'program-folder-motion')
  R.пометкаБета = await p.locator(tid('program-folder-motion')).innerText().catch(() => null)

  // тренерского клиенту не досталось
  R.кнопкаКонструктор = (await p.locator(tid('constructor-open')).count()) > 0
  R.кнопкаНоваяПрограмма = await p.evaluate(() =>
    [...document.querySelectorAll('button')].some(e => /\+ Программа/.test(e.innerText || '')))

  // тренировка
  await p.locator(tid('program-folder-motion')).click(); await sleep(1500)
  await p.waitForSelector('.mt-root', { timeout: 40000 })
  R.разделОткрылся = (await p.locator(tid('motion-overlay')).count()) > 0
  // Модель — 8.4 МБ плюс компиляция wasm. В headless без GPU это заметно
  // дольше, чем на телефоне: ждём столько, сколько ей реально нужно, иначе
  // проверка «тренировка идёт» превращается в проверку скорости прогона.
  await p.waitForSelector('.mt-blocker--solid', { state: 'detached', timeout: 180000 }).catch(() => {})
  R.камераРаботает = await p.evaluate(() => {
    const v = document.querySelector('.mt-root video')
    return !!(v && v.srcObject && v.srcObject.getVideoTracks().some(t => t.readyState === 'live'))
  })
  R.заставкаУшла = (await p.locator('.mt-blocker--solid').count()) === 0

  await p.locator(tid('motion-exit')).click().catch(() => {})
  await sleep(4000)
  R.ответыЖурнала = posts

  console.log(JSON.stringify(R, null, 2))
  console.log(`USER_ID=${u.id}`)
  await b.close()
} catch (e) {
  console.error('прогон не дошёл до конца:', e.message)
  process.exitCode = 1
}
