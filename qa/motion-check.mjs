// Проверка раздела Motion внутри FitPro: карточка, открытие, аппаратная
// «назад», закрытие кнопкой и — главное — гаснет ли камера.
//
// Камера здесь поддельная (--use-fake-device-for-media-stream): проверяется не
// картинка, а жизненный цикл — что поток берётся при открытии и отпускается при
// закрытии. На настоящем телефоне это же видно по индикатору камеры.
import { chromium } from 'playwright'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'http://localhost:5199'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const R = {}

try {
  const [u] = await createUsers('mo' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', permissions: ['camera'] })
  const p = await ctx.newPage()

  // сеть за файлами движка и любые 404 (журнал в этой сборке обязан молчать)
  const net = []
  p.on('response', r => net.push({ url: r.url(), status: r.status() }))

  // карточка открыта владельцу: роль trainer или запасной ключ. Прогон заходит
  // обычным аккаунтом, поэтому берёт ключ — проверяем сам раздел, а не доступ
  await p.goto(BASE + '/?motion=1', { waitUntil: 'networkidle', timeout: 60000 })
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
  await sleep(2000)

  // --- карточка на месте и ПЕРВАЯ ---
  await p.locator(tid('tab-workouts')).click({ timeout: 12000 }); await sleep(1500)
  R.карточкаЕсть = await p.locator(tid('program-folder-motion')).count() > 0
  R.карточкаПервая = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid^="program-folder-"]')]
    return cards[0]?.getAttribute('data-testid') === 'program-folder-motion'
  })
  R.подписьКарточки = await p.locator(tid('program-folder-motion')).innerText().catch(() => null)

  // --- открытие ---
  await p.locator(tid('program-folder-motion')).click(); await sleep(1200)
  R.оверлейОткрылся = await p.locator(tid('motion-overlay')).count() > 0
  await p.waitForSelector('.mt-root', { timeout: 30000 })
  R.корень = await p.locator('.mt-root').count() > 0
  // корень раздела обязан лежать поверх приложения и во весь экран
  R.геометрия = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="motion-overlay"]')
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return { position: s.position, zIndex: s.zIndex, isolation: s.isolation, ширина: Math.round(r.width), высота: Math.round(r.height) }
  })

  // камера должна подняться
  await sleep(4000)
  R.камераВзята = await p.evaluate(() => {
    const v = document.querySelector('.mt-root video')
    return !!(v && v.srcObject && v.srcObject.getVideoTracks().some(t => t.readyState === 'live'))
  })

  // --- аппаратная «назад» закрывает РАЗДЕЛ, а не приложение ---
  await p.goBack(); await sleep(1200)
  R.назадЗакрылоРаздел = await p.locator(tid('motion-overlay')).count() === 0
  R.назадОставилоПриложение = await p.locator('[data-screen]').count() > 0
  R.экранПослеНазад = await p.getAttribute('[data-screen]', 'data-screen').catch(() => null)

  // --- второе открытие и закрытие кнопкой: камера обязана погаснуть ---
  await p.locator(tid('program-folder-motion')).click(); await sleep(1200)
  await p.waitForSelector('.mt-root', { timeout: 30000 })
  await sleep(4000)
  R.второеОткрытие = await p.locator('.mt-root').count() > 0

  // держим ссылку на поток, чтобы после закрытия посмотреть на его треки
  await p.evaluate(() => {
    const v = document.querySelector('.mt-root video')
    window.__motionStream = v?.srcObject || null
  })
  const exit = p.locator(tid('motion-exit'))
  R.кнопкаВыходаЕсть = await exit.count() > 0
  if (R.кнопкаВыходаЕсть) await exit.click()
  await sleep(1500)

  R.закрылосьКнопкой = await p.locator(tid('motion-overlay')).count() === 0
  R.камераПогасла = await p.evaluate(() => {
    const s = window.__motionStream
    if (!s) return 'потока не было'
    return s.getVideoTracks().every(t => t.readyState === 'ended')
  })

  // --- приложение цело после раздела ---
  await sleep(800)
  R.приложениеЦело = await p.locator('[data-screen]').count() > 0
  await p.locator(tid('tab-nutrition')).click({ timeout: 12000 }); await sleep(1500)
  R.питаниеОткрылось = await p.locator(tid('meal-breakfast')).count() > 0

  // --- журнал молчит: 404 быть не должно ---
  R.запросыКЖурналу = net.filter(r => /\/api\/log/.test(r.url)).length
  R.всего404 = net.filter(r => r.status === 404).map(r => r.url.replace(BASE, '')).slice(0, 5)
  R.файлыДвижка = net.filter(r => /motion-assets/.test(r.url)).map(r => `${r.status} ${r.url.split('/').pop()}`)

  console.log(JSON.stringify(R, null, 2))
  await b.close()
} finally {
  await cleanupAll()
}
