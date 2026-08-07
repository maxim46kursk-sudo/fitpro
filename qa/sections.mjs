// Прогон по проду НЕЗАВИСИМЫМИ СЕКЦИЯМИ.
//
// Чем отличается от run.mjs, который заменяет. Тот был одним линейным
// маршрутом: любая заминка в середине — открытая модалка, режим тренировки со
// скрытой навигацией — рушила всё, что шло следом, и отчёт наполнялся мнимыми
// поломками. Здесь каждая секция:
//   * поднимает СВОЙ контекст браузера и входит заново;
//   * первым делом гасит висящие модалки и приводит экран в известное состояние;
//   * падает сама по себе — остальные секции это не отменяет.
//
// Навигация взята не из вёрстки, а та, что доказана экспериментом
// (qa/trial-refresh.mjs): аватар → «Настройки» → data-testid. Прошлый прогон
// ходил другим путём и стабильно спотыкался на входе в профиль.
//
// Прогон идёт по ПРОДУ: на локальной сборке нет serverless-функций, и платные
// ветки (пробный период) там молча не срабатывают.
// Оплату не трогаем: переход на payform.ru считается находкой.

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD, ANON } from './admin.mjs'

const PROD = process.env.QA_BASE || 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens'
const RUN_ID = String(Date.now()).slice(-6)
const PHONE = { width: 390, height: 844 }
const NARROW = { width: 320, height: 844 }
const FORBIDDEN = /payform\.ru/i
const ASSISTANT_MAX = 6

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tid = t => `[data-testid="${t}"]`

class Rec {
  constructor(name) { this.section = name; this.ok = null; this.timings = []; this.findings = []; this.notChecked = []; this.backChecks = []; this.console = []; this.network = []; this.shots = 0; this.assistantCalls = 0 }
  time(s, ms) { this.timings.push({ step: s, ms: Math.round(ms) }) }
  find(sev, what, where = '') { this.findings.push({ severity: sev, what, where }); console.log(`   [${sev}] ${this.section}: ${what}${where ? ' — ' + where : ''}`) }
  skip(what, why) { this.notChecked.push({ what, why }); console.log(`   [не проверено] ${this.section}: ${what} — ${why}`) }
}

async function shot(page, rec, name) {
  rec.shots++
  try { await page.screenshot({ path: `${OUT}/${rec.section}/${String(rec.shots).padStart(2, '0')}-${name.replace(/[^\wа-яА-Я-]+/g, '-').slice(0, 34)}.png` }) } catch {}
}

async function step(page, rec, name, fn, { critical = true } = {}) {
  const t0 = Date.now()
  let ok = true
  try { await fn() } catch (e) {
    ok = false
    const m = String(e.message || e).split('\n')[0].slice(0, 150)
    if (critical) rec.find('ошибка', `шаг «${name}» не прошёл`, m); else rec.skip(name, m)
  }
  rec.time(name, Date.now() - t0)
  await shot(page, rec, name)
  return ok
}

// Гасим всё, что могло всплыть. Вызывается в начале каждой секции и между
// разделами: одна незакрытая плашка перекрывает экран целиком.
async function dismiss(page) {
  for (const t of ['Закрыть', 'Отмена', 'Понятно', 'Позже', 'Не сейчас']) {
    const el = page.locator(`button:visible:has-text("${t}")`).first()
    if (await el.count().catch(() => 0)) { await el.click({ timeout: 3000 }).catch(() => {}); await sleep(500); return true }
  }
  return false
}

async function backTo(page, rec, chain, expect) {
  const btn = page.locator('[data-back="1"]:visible').first()
  if (!await btn.count().catch(() => 0)) { rec.skip(`назад из «${chain}»`, 'кнопки назад нет на экране'); return false }
  try { await btn.click({ timeout: 6000 }) } catch (e) { rec.skip(`назад из «${chain}»`, String(e.message).split('\n')[0].slice(0, 80)); return false }
  await sleep(1200)
  const txt = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
  const ok = txt.includes(expect)
  rec.backChecks.push({ chain, expect, ok, got: txt.slice(0, 80) })
  if (!ok) rec.find('навигация', `«назад» из «${chain}» ушёл не туда`, `ждали «${expect}», видим «${txt.slice(0, 60)}»`)
  return ok
}

// ── Общий вход: логин + согласие + пробный период ───────────────────────────
// Пробный обязателен: без него тренировки 4–12 закрыты пейволлом, и секция
// тренировки упрётся в него, а не в то, что проверяет.
async function bootstrap(page, user, rec, { withTrial = true } = {}) {
  const t0 = Date.now()
  await page.goto(PROD, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 40000 }).catch(() => {})
  rec.time('первая загрузка', Date.now() - t0)

  await page.locator('text=Попробовать бесплатно').first().click({ timeout: 20000 }); await sleep(700)
  const toLogin = page.locator('button:visible').filter({ hasText: /^Войти$/ }).first()
  if (await toLogin.count().catch(() => 0)) { await toLogin.click().catch(() => {}); await sleep(500) }
  await page.locator('input[type="email"]:visible').first().fill(user.email, { timeout: 15000 })
  await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD, { timeout: 15000 })
  const tl = Date.now()
  await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click({ timeout: 15000 })
  await page.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
  rec.time('вход', Date.now() - tl)

  if (await page.locator(tid('consent-accept')).count().catch(() => 0)) {
    await page.locator('text=Я даю согласие').first().click({ timeout: 10000 })
    await sleep(300)
    await page.locator(tid('consent-accept')).click({ timeout: 10000 })
    await page.waitForSelector('[data-screen]', { timeout: 45000 })
  }
  await sleep(2000)
  await dismiss(page)

  if (withTrial) {
    // Доказанный путь: аватар (первая кнопка шапки) → Настройки → Тарифы →
    // ждём саму кнопку, а не фиксированную паузу (экран грузит профиль ~450 мс).
    await page.locator('button:visible').first().click({ timeout: 10000 }).catch(() => {})
    await sleep(900)
    await page.locator('text=Настройки').first().click({ timeout: 12000 })
    await sleep(1200)
    await page.locator(tid('settings-plans')).click({ timeout: 12000 })
    const btn = page.locator(tid('trial-start'))
    await page.waitForSelector(tid('trial-start'), { timeout: 30000 }).catch(() => {})
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 10000 }); await sleep(3500)
      rec.trialActivated = /Пробный активирован/.test(await page.evaluate(() => document.body.innerText))
    } else rec.skip('пробный период', 'кнопка активации не появилась')
    // Возвращаемся на главный экран приложения
    await page.goto(PROD, { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2500)
    await dismiss(page)
  }
}

// Обёртка секции: свой контекст, свой вход, своё падение.
async function runSection(browser, user, name, viewport, body, opts = {}) {
  const rec = new Rec(name)
  mkdirSync(`${OUT}/${name}`, { recursive: true })
  const ctx = await browser.newContext({ viewport, locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') rec.console.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => rec.console.push('pageerror: ' + String(e.message).slice(0, 200)))
  page.on('response', r => { if (r.status() >= 400) rec.network.push({ status: r.status(), url: r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 120) }) })
  page.on('framenavigated', f => { if (f === page.mainFrame() && FORBIDDEN.test(f.url())) rec.find('ЗАПРЕТ', 'открылась форма оплаты — трогать нельзя') })

  console.log(`\n▶ секция «${name}» (${viewport.width}px)`)
  try {
    await bootstrap(page, user, rec, opts)
    await body(page, rec)
    rec.ok = rec.findings.filter(f => f.severity === 'ошибка').length === 0
  } catch (e) {
    rec.ok = false
    rec.find('ошибка', `секция прервана`, String(e.message).split('\n')[0].slice(0, 150))
  }
  await shot(page, rec, 'финал')
  await ctx.close()
  console.log(`   итог: ${rec.ok ? 'ПРОШЛА' : 'НЕ ПРОШЛА'}`)
  return rec
}

// ── Тела секций ─────────────────────────────────────────────────────────────

const secWorkout = async (page, rec) => {
  await step(page, rec, 'вкладка Тренировки', async () => { await page.locator(tid('tab-workouts')).click({ timeout: 12000 }); await sleep(1500) })
  await step(page, rec, 'открыть папку', async () => { await page.locator('text=Full Body').first().click({ timeout: 12000 }); await sleep(2000) })
  await step(page, rec, 'открыть тренировку 1', async () => {
    await page.locator('text=Тренировка 1').first().click({ timeout: 12000 }); await sleep(2000)
    if (await page.locator('text=/доступны в пакете/i').count().catch(() => 0)) {
      rec.find('важное', 'тренировка 1 закрыта пейволлом даже с активным пробным'); await dismiss(page)
    }
  })
  const t = Date.now()
  const started = await step(page, rec, 'начать тренировку', async () => {
    await page.locator(tid('workout-start')).click({ timeout: 12000 })
    await page.waitForSelector(tid('set-kg'), { timeout: 30000 })
  })
  rec.time('старт до полей подхода', Date.now() - t)
  if (!started) return
  await step(page, rec, 'записать подход', async () => {
    await page.locator(tid('set-kg')).first().fill('40', { timeout: 10000 })
    await page.locator(tid('set-reps')).first().fill('10', { timeout: 10000 })
    await sleep(800)
  })
  await step(page, rec, 'завершить тренировку', async () => {
    await page.locator(tid('workout-finish')).click({ timeout: 12000 }); await sleep(1500)
    const c = page.locator(tid('workout-save-confirm'))
    if (await c.count().catch(() => 0)) { await c.click({ timeout: 10000 }); await sleep(3000) }
  })
  const txt = await page.evaluate(() => document.body.innerText)
  if (/Тренировка сохранена|сохранен/i.test(txt) === false) rec.skip('подтверждение сохранения', 'на экране нет явного подтверждения — проверить глазами')
}

const secDiary = async (page, rec) => {
  await step(page, rec, 'вкладка Дневник', async () => { await page.locator(tid('tab-progress')).click({ timeout: 12000 }); await sleep(1500) })
  const opened = await step(page, rec, 'открыть дневник питания', async () => {
    await page.locator('text=Дневник питания').first().click({ timeout: 12000 })
    await page.waitForSelector(tid('meal-breakfast'), { timeout: 25000 })
  })
  if (!opened) return
  await step(page, rec, 'добавить в завтрак', async () => {
    await page.locator(tid('meal-add-breakfast')).click({ timeout: 12000 })
    await page.waitForSelector(tid('food-search-input'), { timeout: 20000 })
  })
  const ts = Date.now()
  const found = await step(page, rec, 'поиск еды', async () => {
    await page.locator(tid('food-search-input')).fill('гречка', { timeout: 12000 })
    await page.waitForFunction(() => /гречк/i.test(document.body.innerText), { timeout: 30000 })
  })
  rec.time('поиск «гречка»', Date.now() - ts)
  if (!found) return
  await step(page, rec, 'выбрать продукт', async () => {
    await page.locator('text=/гречк/i').nth(1).click({ timeout: 12000 }); await sleep(1800)
    const add = page.locator('button:visible').filter({ hasText: /Добавить|Готово|Сохранить/ }).first()
    if (await add.count().catch(() => 0)) { await add.click({ timeout: 10000 }); await sleep(2500) }
  })
  const inBreakfast = await page.locator(tid('meal-breakfast')).innerText().catch(() => '')
  if (!/гречк/i.test(inBreakfast)) rec.find('важное', 'продукт не появился в завтраке после добавления')

  await step(page, rec, 'перенести в обед', async () => {
    await page.locator(tid('food-menu')).first().click({ timeout: 10000 }); await sleep(800)
    await page.locator(tid('food-move-open')).first().click({ timeout: 10000 }); await sleep(700)
    await page.locator(tid('food-move-lunch')).first().click({ timeout: 10000 }); await sleep(2500)
  })
  const inLunch = await page.locator(tid('meal-lunch')).innerText().catch(() => '')
  if (!/гречк/i.test(inLunch)) rec.find('важное', 'после переноса запись не появилась в обеде')

  await step(page, rec, 'удалить запись', async () => {
    await page.locator(tid('food-menu')).first().click({ timeout: 10000 }); await sleep(800)
    await page.locator(tid('food-delete')).first().click({ timeout: 10000 }); await sleep(2500)
  })
  if (/гречк/i.test(await page.evaluate(() => document.body.innerText))) rec.find('важное', 'после удаления запись всё ещё видна')

  await step(page, rec, 'сводка питания', async () => {
    const gear = page.locator('[aria-label="Настройки питания"]').first()
    if (await gear.count().catch(() => 0)) { await gear.click({ timeout: 10000 }); await sleep(800) }
    await page.locator(tid('food-summary')).click({ timeout: 10000 }); await sleep(2500)
  })
  await backTo(page, rec, 'Дневник питания → Сводка', 'Дневник питания')
}

const secSettings = async (page, rec) => {
  const opened = await step(page, rec, 'открыть настройки', async () => {
    await page.locator('button:visible').first().click({ timeout: 10000 }); await sleep(900)
    await page.locator('text=Настройки').first().click({ timeout: 12000 })
    await page.waitForSelector(tid('settings-plans'), { timeout: 20000 })
  })
  if (!opened) return
  for (const [t, label] of [['settings-plans', 'Тарифы и подписка'], ['settings-policy', 'Политика'], ['settings-consent', 'Согласие']]) {
    if (!await page.locator(tid(t)).count().catch(() => 0)) { rec.skip(`подэкран «${label}»`, 'пункта нет в настройках'); continue }
    await step(page, rec, `подэкран ${label}`, async () => { await page.locator(tid(t)).click({ timeout: 10000 }); await sleep(2000) })
    await backTo(page, rec, `Настройки → ${label}`, 'Настройки')
  }
}

const secBack = async (page, rec) => {
  // Вложенная цепочка: вкладка → папка → тренировка → назад → назад
  await step(page, rec, 'вкладка Тренировки', async () => { await page.locator(tid('tab-workouts')).click({ timeout: 12000 }); await sleep(1500) })
  await step(page, rec, 'папка Full Body', async () => { await page.locator('text=Full Body').first().click({ timeout: 12000 }); await sleep(2000) })
  await step(page, rec, 'тренировка 1', async () => { await page.locator('text=Тренировка 1').first().click({ timeout: 12000 }); await sleep(2000); await dismiss(page) })
  await backTo(page, rec, 'тренировка → папка', 'Тренировка 1')
  await backTo(page, rec, 'папка → список папок', 'Full Body')
  // Вторая цепочка: Дневник → дневник питания → назад
  await step(page, rec, 'вкладка Дневник', async () => { await page.locator(tid('tab-progress')).click({ timeout: 12000 }); await sleep(1500) })
  await step(page, rec, 'дневник питания', async () => { await page.locator('text=Дневник питания').first().click({ timeout: 12000 }); await sleep(2000) })
  await backTo(page, rec, 'дневник питания → Дневник', 'Общий тоннаж')
}

const secAssistant = async (page, rec) => {
  const ask = async (text, name) => {
    if (rec.assistantCalls >= ASSISTANT_MAX) { rec.skip(`ассистент: ${name}`, 'исчерпан лимит 6 запросов'); return false }
    rec.assistantCalls++
    const t = Date.now()
    const ok = await step(page, rec, `ассистент: ${name}`, async () => {
      const before = await page.evaluate(() => document.body.innerText.length)
      await page.locator(tid('assistant-input')).fill(text, { timeout: 12000 })
      await page.locator(tid('assistant-send')).click({ timeout: 12000 })
      await page.waitForFunction(n => document.body.innerText.length > n + 40, before, { timeout: 120000 })
      await sleep(1500)
    })
    rec.time(`ответ (${name})`, Date.now() - t)
    return ok
  }
  const opened = await step(page, rec, 'открыть ассистента', async () => {
    const fab = page.locator('button:visible').filter({ hasText: /^$/ }).last()
    const byText = page.locator('text=/ассистент|Спроси/i').first()
    if (await byText.count().catch(() => 0)) await byText.click({ timeout: 8000 })
    else await fab.click({ timeout: 8000 })
    await page.waitForSelector(tid('assistant-input'), { timeout: 25000 })
  })
  if (!opened) { rec.skip('ассистент целиком', 'не нашёлся вход в ассистента'); return }

  await ask('Сколько белка в день нужно при весе 70 кг? Ответь одним предложением.', 'вопрос')
  await ask('Запиши мне в дневник питания 100 г гречки на обед.', 'запись рациона')
  await sleep(3000)
  // Проверяем ФАКТ записи в дневнике, а не слова ассистента
  await step(page, rec, 'проверить запись в дневнике', async () => {
    await page.locator(tid('tab-progress')).click({ timeout: 12000 }); await sleep(1500)
    await page.locator('text=Дневник питания').first().click({ timeout: 12000 })
    await page.waitForSelector(tid('meal-breakfast'), { timeout: 25000 })
  })
  rec.diaryHasEntryAfterAssistant = /гречк/i.test(await page.evaluate(() => document.body.innerText))
  if (!rec.diaryHasEntryAfterAssistant) rec.find('важное', 'ассистент сообщил о записи рациона, но в дневнике её нет')
  await shot(page, rec, 'дневник-после-ассистента')

  await step(page, rec, 'вернуться к ассистенту', async () => {
    const byText = page.locator('text=/ассистент|Спроси/i').first()
    if (await byText.count().catch(() => 0)) await byText.click({ timeout: 8000 })
    await page.waitForSelector(tid('assistant-input'), { timeout: 25000 })
  }, { critical: false })
  await ask('Удали гречку из дневника питания.', 'удаление рациона')
  await sleep(3000)
  await step(page, rec, 'проверить удаление', async () => {
    await page.locator(tid('tab-progress')).click({ timeout: 12000 }); await sleep(1500)
    await page.locator('text=Дневник питания').first().click({ timeout: 12000 })
    await page.waitForSelector(tid('meal-breakfast'), { timeout: 25000 })
  })
  rec.diaryEntryRemoved = !/гречк/i.test(await page.evaluate(() => document.body.innerText))
  if (!rec.diaryEntryRemoved) rec.find('важное', 'ассистент сообщил об удалении, но запись осталась в дневнике')
}

// ── Запуск ──────────────────────────────────────────────────────────────────
const report = { runId: RUN_ID, base: PROD, startedAt: new Date().toISOString(), sections: [] }
try {
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
  console.log(`\n=== Прогон секциями ${RUN_ID} по ${PROD} ===`)
  // Свой пользователь на каждую секцию — секции не должны видеть данные друг друга.
  const users = await createUsers(RUN_ID, 6)
  const browser = await chromium.launch({ headless: true })

  const plan = [
    ['тренировка', PHONE, secWorkout, users[0]],
    ['дневник-питания', PHONE, secDiary, users[1]],
    ['настройки', PHONE, secSettings, users[2]],
    ['назад-цепочки', PHONE, secBack, users[3]],
    ['ассистент', PHONE, secAssistant, users[4]],
    ['320px-тренировка', NARROW, secWorkout, users[5]],
  ]
  for (const [name, vp, body, user] of plan) {
    report.sections.push(await runSection(browser, user, name, vp, body))
  }
  await browser.close()
} catch (e) {
  report.fatal = String(e.stack || e).slice(0, 1000)
  console.error('\nПРОГОН УПАЛ:', report.fatal)
} finally {
  console.log(`\n=== Удаление тестовых аккаунтов ===`)
  try { const c = await cleanupAll(); report.cleanup = { deleted: c.deleted, problems: c.problems, left: c.left?.length || 0 } }
  catch (e) { report.cleanup = { error: String(e.message) }; console.error('!!! ЧИСТКА УПАЛА:', e.message) }
  report.finishedAt = new Date().toISOString()
  writeFileSync(`${OUT}/sections.json`, JSON.stringify(report, null, 2), 'utf8')
  console.log('\n══════ ИТОГ ПО СЕКЦИЯМ ══════')
  for (const s of report.sections) console.log(`  ${s.ok ? 'ПРОШЛА    ' : 'НЕ ПРОШЛА '} ${s.section}  (находок: ${s.findings.length}, не проверено: ${s.notChecked.length})`)
  console.log(`\nОтчёт: ${OUT}/sections.json`)
}
