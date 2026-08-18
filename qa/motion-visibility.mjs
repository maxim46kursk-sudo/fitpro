// Кому видна карточка Motion и кто грузит её чанк.
//
// Клиент не должен видеть ни карточки, ни единого байта раздела: он в бете и
// открыт владельцу. Роль тренера здесь ставится штатным ключом ?trainer=1 —
// тем же, которым её ставит само приложение, — чтобы не трогать профили в базе.
import { chromium } from 'playwright'
import { createUsers, cleanupAll, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'http://localhost:5199'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const R = {}

async function look(b, u, suffix = '/') {
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage()
  const chunks = []
  p.on('response', r => {
    const n = r.url().split('/').pop()
    if (/^motion-|^poseWorker|^space3d|^vision_bundle|^demoLoops/.test(n)) chunks.push(n)
  })
  await p.goto(BASE + suffix, { waitUntil: 'networkidle', timeout: 60000 })
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
  const out = {
    карточка: (await p.locator(tid('program-folder-motion')).count()) > 0,
    чанкиРаздела: [...new Set(chunks)],
  }
  await p.close()
  return out
}

try {
  const [u] = await createUsers('vz' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({ headless: true })
  R.обычныйКлиент = await look(b, u, '/')
  R.клиентСКлючомMotion = await look(b, u, '/?motion=1')
  R.рольТренера = await look(b, u, '/?trainer=1')
  await b.close()
  console.log(JSON.stringify(R, null, 2))
} finally {
  await cleanupAll()
}
