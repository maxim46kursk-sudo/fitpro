// Прогресс Motion живёт в базе: три сценария, ради которых этап и делался.
//
//   1. тренировка на телефоне -> попытка появилась в базе;
//   2. тот же человек, ДРУГОЕ устройство -> день и результаты те же;
//   3. другой человек на ТОМ ЖЕ устройстве -> чужого прогресса не видно.
//
// Тренировку не проходим по-настоящему (для этого нужен человек перед камерой):
// прогресс пишется тем же путём, что и в игре — через хранилище раздела, — а
// проверяется то, что переезд и добавил: доехало ли это до базы и вернулось ли
// обратно на другом устройстве.
import { chromium } from 'playwright'
import { createUsers, QA_PASSWORD } from './admin.mjs'

const BASE = process.env.QA_BASE || 'https://fitpro-dun.vercel.app'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`
const R = {}

/**
 * Дождаться, что раздел ЗАГРУЗИЛ прогресс и смонтировал игру.
 *
 * По `.mt-root` ждать нельзя: тот же корень рисует и заставка «Загружаю
 * прогресс…». Первый прогон на этом и попался — кэш читался до окончания
 * загрузки, и второе устройство выглядело пустым.
 */
async function дождатьсяЗагрузки(p) {
  await p.waitForSelector('.mt-root', { timeout: 60000 })
  await p.waitForFunction(
    () => !/Загружаю прогресс/.test(document.body.innerText),
    { timeout: 60000 },
  )
}

/** Вход в приложение на чистом контексте — это и есть «другое устройство». */
async function войти(b, u) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', permissions: ['camera'] })
  const p = await ctx.newPage()
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
  return p
}

/** Что лежит в кэше раздела на этом устройстве. */
const прогрессНаУстройстве = p => p.evaluate(() => ({
  день: JSON.parse(localStorage.getItem('fitpro-motion.challenge.v1') || 'null')?.day ?? null,
  сдано: JSON.parse(localStorage.getItem('fitpro-motion.challenge.v1') || 'null')?.done?.length ?? 0,
  рекорд: Number(localStorage.getItem('fitpro-motion.game.best.v1')) || 0,
  попытки: Object.keys(JSON.parse(localStorage.getItem('fitpro-motion.challenge.attempts.v1') || '{}')?.days || {}),
  владелец: localStorage.getItem('fitpro-motion.owner.v1'),
}))

/** Прожить тренировку: записать результат ровно тем же путём, что и игра. */
async function сыгратьДень(p) {
  await p.locator(tid('tab-workouts')).click({ force: true }); await sleep(2000)
  await p.locator(tid('program-folder-motion')).click(); await sleep(1500)
  // ждём, пока раздел загрузит прогресс и смонтируется
  await дождатьсяЗагрузки(p)
  await sleep(1000)

  // пишем результат в хранилище раздела — тот же путь, которым пишет игра
  await p.evaluate(() => {
    localStorage.setItem('fitpro-motion.challenge.v1', JSON.stringify({ day: 4, done: [{ day: 3, at: new Date().toISOString() }] }))
    localStorage.setItem('fitpro-motion.game.best.v1', '3300')
    localStorage.setItem('fitpro-motion.challenge.attempts.v1', JSON.stringify({
      days: { 3: { pro: [{ score: 3300, reps: 12, hits: 18, spawned: 24, reactMs: 480, at: new Date().toISOString() }] } },
    }))
  })
  // выход из раздела отдаёт накопленное наверх
  await p.locator(tid('motion-exit')).click().catch(() => {})
  await sleep(6000)
}

try {
  const [A] = await createUsers('pr' + String(Date.now()).slice(-4), 1)
  const [B] = await createUsers('pq' + String(Date.now()).slice(-4), 1)
  const b = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })

  // ── 1. тренировка на «телефоне» ──
  const телефон1 = await войти(b, A)
  await сыгратьДень(телефон1)
  R.послеТренировки = await прогрессНаУстройстве(телефон1)
  await телефон1.context().close()

  // ── 2. тот же человек, другое устройство ──
  const телефон2 = await войти(b, A)
  await телефон2.locator(tid('tab-workouts')).click({ force: true }); await sleep(1500)
  await телефон2.locator(tid('program-folder-motion')).click(); await sleep(1500)
  await дождатьсяЗагрузки(телефон2)
  await sleep(1000)
  R.наДругомУстройстве = await прогрессНаУстройстве(телефон2)
  await телефон2.locator(tid('motion-exit')).click().catch(() => {})
  await sleep(2000)

  // ── 3. другой человек на ТОМ ЖЕ устройстве ──
  // тот же контекст: выходим из аккаунта и заходим другим
  await телефон2.locator('button:visible').first().click().catch(() => {})
  await sleep(1500)
  await телефон2.locator('button:visible').filter({ hasText: /Выйти/i }).first().click().catch(() => {})
  await sleep(2500)
  await телефон2.locator('button:visible').filter({ hasText: /Выйти|Да|Подтвер/i }).first().click().catch(() => {})
  await sleep(3000)
  R.кэшПослеВыхода = await прогрессНаУстройстве(телефон2)

  await телефон2.locator('button:visible').filter({ hasText: /^Войти$/ }).first().click().catch(() => {})
  await телефон2.locator('input[type="email"]:visible').first().fill(B.email)
  await телефон2.locator('input[type="password"]:visible').first().fill(QA_PASSWORD)
  await телефон2.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
  await телефон2.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
  if (await телефон2.locator(tid('consent-accept')).count()) {
    await телефон2.locator('text=Я даю согласие').first().click(); await sleep(300)
    await телефон2.locator(tid('consent-accept')).click(); await телефон2.waitForSelector('[data-screen]', { timeout: 45000 })
  }
  await sleep(2500)
  await телефон2.locator(tid('tab-workouts')).click({ force: true }); await sleep(1500)
  await телефон2.locator(tid('program-folder-motion')).click(); await sleep(1500)
  await дождатьсяЗагрузки(телефон2)
  await sleep(1000)
  R.уДругогоЧеловека = await прогрессНаУстройстве(телефон2)

  await b.close()
  console.log(JSON.stringify(R, null, 2))
  console.log(`A=${A.id}`)
  console.log(`B=${B.id}`)
} catch (e) {
  console.error('прогон не дошёл до конца:', e.message)
  process.exitCode = 1
}
