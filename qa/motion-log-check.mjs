// Журнал Motion доезжает до нашей базы: тренировка на боевом адресе, а потом
// строки в motion_log под нужным пользователем.
//
// Проверка сквозная: телефон -> ветка ручки -> таблица. Ни одно звено по
// отдельности не доказывает, что журнал работает, — а вместе они и есть ответ.
import { chromium } from 'playwright'
import { createUsers, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'https://fitpro-dun.vercel.app'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

try {
  const [u] = await createUsers('ml' + String(Date.now()).slice(-4), 1)
  console.log(`пользователь прогона: ${u.id}`)

  const b = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', permissions: ['camera'] })).newPage()

  const posts = []
  p.on('response', r => { if (/action=motion-log/.test(r.url())) posts.push(r.status()) })

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
  await sleep(2500)

  await p.locator(tid('tab-workouts')).click({ force: true }); await sleep(2000)
  await p.locator(tid('program-folder-motion')).click(); await sleep(1500)
  await p.waitForSelector('.mt-root', { timeout: 40000 })
  // тренировка: держим раздел открытым дольше интервала отправки (10 с)
  await sleep(35000)
  console.log(`ответы ручки за сессию: ${posts.join(', ') || 'ни одного'}`)

  // закрытие отдаёт хвост буфера
  await p.locator(tid('motion-exit')).click().catch(() => {})
  await sleep(4000)
  console.log(`ответы ручки всего: ${posts.join(', ')}`)

  await b.close()
  console.log(`\nUSER_ID=${u.id}`)
  /**
   * Аккаунт здесь НЕ удаляется намеренно: строки нужны для запроса из базы, а
   * удаление тестового пользователя как раз и упрётся в них — внешний ключ
   * motion_log объявлен NO ACTION. Уборка идёт после проверки, штатным путём:
   * сначала строки USER_TABLES, потом сам auth-пользователь.
   */
} catch (e) {
  console.error('прогон не дошёл до конца:', e.message)
  process.exitCode = 1
}
