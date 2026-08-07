// Сквозной прогон приложения браузером: пять пользователей одновременно.
//
// ПРОГОН ИДЁТ ПО ПРОДУ — стенда нет. Отсюда весь характер файла:
//   * ничего не чинит и не правит, только ходит, замеряет и записывает;
//   * оплату не трогает — форма Продамуса не открывается (FORBIDDEN_URL);
//   * тестовые аккаунты удаляются в finally, то есть и после падения.
//
// Опора — data-testid, расставленные в приложении. До них селекторы
// приходилось выводить из вёрстки, и НЕНАЙДЕННЫЙ селектор выглядел в отчёте
// как сломанный экран. Теперь «не нашлось» означает либо реальную поломку,
// либо честное «не проверено» — эти два состояния в отчёте разделены.

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createUsers, cleanupAll, QA_PASSWORD, ANON } from './admin.mjs'

// Адрес прогона. По умолчанию прод, но функциональный прогон идёт против
// ЛОКАЛЬНОГО dev-сервера: data-testid есть только в незапушенном коде, а на
// проде их пока нет. Бэкенд при этом настоящий — Vite отдаёт только фронт,
// база и авторизация те же боевые (VITE_SUPABASE_URL в .env).
//
// ВАЖНО ПРО ЗАМЕРЫ: тайминги с dev-сервера НЕ сравнимы с продом — там нет
// минификации и раздачи через CDN. Числа производительности брать только с
// прода (QA_BASE не задан), функциональные находки — отсюда.
const BASE = process.env.QA_BASE || 'https://fitpro-dun.vercel.app'
const OUT = 'qa-screens'
const RUN_ID = String(Date.now()).slice(-6)
const USERS = Number(process.env.QA_USERS || 5)
const PHONE = { width: 390, height: 844 }
const NARROW = { width: 320, height: 844 }
const FORBIDDEN_URL = /payform\.ru/i
// Ассистент тратит квоту Anthropic — с ним говорит ОДИН пользователь и не
// более шести запросов за прогон.
const ASSISTANT_USER = 1
const ASSISTANT_MAX_CALLS = 6

const sleep = ms => new Promise(r => setTimeout(r, ms))

class Rec {
  constructor(label) {
    this.label = label
    this.timings = []; this.console = []; this.network = []
    this.findings = []; this.buttons = []; this.backChecks = []
    this.notChecked = []; this.assistantCalls = 0; this.shots = 0
  }
  time(step, ms) { this.timings.push({ step, ms: Math.round(ms) }) }
  find(sev, what, where = '') { this.findings.push({ severity: sev, what, where }); console.log(`  [${sev}] ${this.label}: ${what}${where ? ' — ' + where : ''}`) }
  skip(what, why) { this.notChecked.push({ what, why }); console.log(`  [не проверено] ${this.label}: ${what} — ${why}`) }
}

const tid = t => `[data-testid="${t}"]`

async function snapshot(page) {
  try {
    return {
      url: page.url(),
      screen: await page.getAttribute('[data-screen]', 'data-screen').catch(() => null),
      text: (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' '),
    }
  } catch { return { url: '?', screen: null, text: '' } }
}
const sameScreen = (a, b) => a.url === b.url && a.screen === b.screen && a.text === b.text

async function shot(page, rec, name) {
  rec.shots++
  try { await page.screenshot({ path: `${OUT}/${rec.label}/${String(rec.shots).padStart(2, '0')}-${name}.png` }) } catch {}
}

// Шаг: замеряет, снимает, ловит ошибку. Возвращает true/false — прошёл ли.
async function step(page, rec, name, fn, { critical = false } = {}) {
  const t0 = Date.now()
  let ok = true
  try { await fn() } catch (e) {
    ok = false
    const msg = String(e.message || e).split('\n')[0].slice(0, 160)
    if (critical) rec.find('ошибка', `шаг «${name}» не прошёл`, msg)
    else rec.skip(name, msg)
  }
  rec.time(name, Date.now() - t0)
  await shot(page, rec, name.replace(/[^\wа-яА-Я-]+/g, '-').slice(0, 38))
  return ok
}

// Нажатие с честным исходом: 'отклик' | 'молчит' | 'не нажалась'.
async function probe(page, rec, label, selector) {
  const el = page.locator(selector).first()
  if (!await el.count().catch(() => 0)) { rec.buttons.push({ label, selector, result: 'не проверено', why: 'нет на экране' }); return 'нет' }
  const before = await snapshot(page)
  let reqs = 0
  const onReq = () => { reqs++ }
  page.on('request', onReq)
  try { await el.click({ timeout: 5000 }) }
  catch (e) {
    page.off('request', onReq)
    rec.buttons.push({ label, selector, result: 'не проверено', why: 'нажатие не состоялось: ' + String(e.message).split('\n')[0].slice(0, 80) })
    return 'не нажалась'
  }
  await sleep(700); page.off('request', onReq)
  const after = await snapshot(page)
  const changed = !sameScreen(before, after) || reqs > 0
  rec.buttons.push({ label, selector, result: changed ? 'отклик' : 'молчит', screen: before.screen })
  if (!changed) console.log(`  [молчит] ${rec.label}: ${label}`)
  return changed ? 'отклик' : 'молчит'
}

// Закрыть модалку, если она висит. Без этого одна всплывшая плашка (например
// «доступно в пакете БАЗА») перекрывает экран, и ВСЕ последующие шаги падают по
// таймауту — отчёт наполняется мнимыми поломками вместо одной настоящей.
async function dismiss(page) {
  for (const sel of ['text=Закрыть', 'text=Отмена', 'text=Понятно', 'text=Позже']) {
    const el = page.locator(sel).first()
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => {})
      await sleep(600)
      return true
    }
  }
  return false
}

// «Назад» — по общему признаку data-back. Проверяем, что вернулись на
// ОЖИДАЕМЫЙ экран, а не на главный.
async function back(page, rec, chain, expect) {
  const before = await snapshot(page)
  const btn = page.locator('[data-back="1"]:visible').first()
  if (!await btn.count().catch(() => 0)) { rec.skip(`назад из «${chain}»`, 'кнопка назад не найдена на экране'); return false }
  try { await btn.click({ timeout: 5000 }) } catch (e) { rec.skip(`назад из «${chain}»`, String(e.message).split('\n')[0].slice(0, 90)); return false }
  await sleep(1000)
  const after = await snapshot(page)
  const ok = expect ? after.text.includes(expect) : !sameScreen(before, after)
  rec.backChecks.push({ chain, expect, ok, got: after.text.slice(0, 90) })
  if (!ok) rec.find('навигация', `«назад» из «${chain}» ушёл не на предыдущий экран`, `ждали «${expect}», видим «${after.text.slice(0, 70)}»`)
  return ok
}

async function walkUser(browser, user, viewport, label) {
  const rec = new Rec(label)
  mkdirSync(`${OUT}/${label}`, { recursive: true })
  const ctx = await browser.newContext({ viewport, locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  const page = await ctx.newPage()

  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') rec.console.push({ type: m.type(), text: m.text().slice(0, 250) }) })
  page.on('pageerror', e => rec.console.push({ type: 'pageerror', text: String(e.message).slice(0, 250) }))
  page.on('response', r => { if (r.status() >= 400) rec.network.push({ status: r.status(), url: r.url().replace(/(token|apikey)=[^&]+/gi, '$1=…').slice(0, 160) }) })
  page.on('framenavigated', f => { if (f === page.mainFrame() && FORBIDDEN_URL.test(f.url())) rec.find('ЗАПРЕТ', 'открылась форма оплаты — её трогать нельзя', f.url().slice(0, 100)) })

  try {
    // ── 1. Первая загрузка ──
    const t0 = Date.now()
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {})
    rec.time('первая загрузка', Date.now() - t0)
    await shot(page, rec, 'лендинг')
    const nv = await page.evaluate(() => { const t = performance.getEntriesByType('navigation')[0]; return t ? { ttfb: t.responseStart, dom: t.domContentLoadedEventEnd } : null }).catch(() => null)
    if (nv) { rec.time('TTFB', nv.ttfb); rec.time('DOMContentLoaded', nv.dom) }

    // ── 2. Вход ──
    await step(page, rec, 'открыть форму входа', async () => {
      await page.locator('text=Попробовать бесплатно').first().click({ timeout: 15000 })
      await sleep(800)
      const toLogin = page.locator('button:visible').filter({ hasText: /^Войти$/ }).first()
      if (await toLogin.count().catch(() => 0)) { await toLogin.click().catch(() => {}); await sleep(500) }
    }, { critical: true })

    const tLogin = Date.now()
    await step(page, rec, 'вход', async () => {
      await page.locator('input[type="email"]:visible').first().fill(user.email, { timeout: 10000 })
      await page.locator('input[type="password"]:visible').first().fill(QA_PASSWORD, { timeout: 10000 })
      await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click({ timeout: 10000 })
      await page.waitForSelector(`${tid('consent-accept')}, [data-screen]`, { timeout: 45000 })
    }, { critical: true })
    rec.time('вход до смены экрана', Date.now() - tLogin)

    // ── 3. Согласие 152-ФЗ ──
    if (await page.locator(tid('consent-accept')).count().catch(() => 0)) {
      await step(page, rec, 'согласие 152-ФЗ', async () => {
        const btn = page.locator(tid('consent-accept'))
        if (await btn.isDisabled().catch(() => null) === false) rec.find('важное', 'кнопка согласия активна ДО отметки галочки — согласие можно проскочить')
        await page.locator('text=Я даю согласие').first().click({ timeout: 8000 })
        await sleep(400)
        await btn.click({ timeout: 10000 })
        await page.waitForSelector('[data-screen]', { timeout: 45000 })
      }, { critical: true })
    } else rec.find('внимание', 'экран согласия 152-ФЗ не показался при первом входе')

    await sleep(1500)
    await shot(page, rec, 'главный-экран')

    // ── 4. Вкладки ──
    for (const [id, name] of [['nutrition', 'Питание'], ['library', 'Упражнения'], ['progress', 'Дневник'], ['workouts', 'Тренировки']]) {
      const t = Date.now()
      const ok = await step(page, rec, `вкладка ${name}`, async () => {
        await page.locator(tid(`tab-${id}`)).click({ timeout: 10000 })
        await page.waitForFunction(v => document.querySelector('[data-screen]')?.dataset.screen === v, id, { timeout: 15000 })
      }, { critical: true })
      rec.time(`переход на «${name}»`, Date.now() - t)
      if (!ok) continue
      const txt = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (/Загрузка\.\.\./.test(txt)) rec.find('зависло', `на вкладке «${name}» осталась «Загрузка...»`)
      if (txt.trim().length < 60) rec.find('пусто', `вкладка «${name}» пуста`, `${txt.trim().length} символов`)
    }

    // ── 4б. Профиль и пробный период ──
    // Пробный ОБЯЗАН идти до тренировок: на пакете СТАРТ открыты только первые
    // три тренировки шаблона, остальные закрыты модалкой «доступно в БАЗА».
    // Без пробного прогон упирается в этот пейволл и дальше не идёт.
    await step(page, rec, 'открыть профиль', async () => {
      await page.locator('header button:visible, [data-screen] ~ * button:visible').first().click({ timeout: 6000 }).catch(async () => {
        await page.locator('button:visible').first().click({ timeout: 6000 })
      })
      await sleep(1000)
    })
    await step(page, rec, 'заполнить профиль', async () => {
      const mine = page.locator('text=/Мои данные|Профиль/i').first()
      if (await mine.count().catch(() => 0)) { await mine.click({ timeout: 6000 }); await sleep(1500) }
      const num = page.locator('input[type="number"]:visible')
      if (await num.count().catch(() => 0) >= 2) {
        await num.nth(0).fill('175', { timeout: 6000 }); await num.nth(1).fill('75', { timeout: 6000 })
      }
      const save = page.locator(tid('profile-save'))
      if (await save.count().catch(() => 0)) { await save.click({ timeout: 8000 }); await sleep(1500) }
      else rec.skip('сохранение профиля', 'кнопка сохранения не найдена')
    })
    await dismiss(page)

    await step(page, rec, 'активировать пробный период', async () => {
      const t = page.locator(tid('trial-start'))
      if (!await t.count().catch(() => 0)) { rec.skip('пробный период', 'кнопка активации не найдена на экране'); return }
      await t.click({ timeout: 10000 }); await sleep(3000)
    })
    await dismiss(page)

    // ── 5. Тренировка: папка → программа → начать → подход → завершить ──
    await step(page, rec, 'вкладка Тренировки', async () => { await page.locator(tid('tab-workouts')).click({ timeout: 10000 }); await sleep(1200) })
    const tFolder = Date.now()
    const folderOk = await step(page, rec, 'открыть папку Full Body', async () => {
      await page.locator('text=Full Body').first().click({ timeout: 10000 }); await sleep(1800)
    }, { critical: true })
    rec.time('открытие папки', Date.now() - tFolder)

    if (folderOk) {
      await back(page, rec, 'Тренировки → папка', 'Full Body')
      await page.locator('text=Full Body').first().click({ timeout: 10000 }).catch(() => {})
      await sleep(1500)
      // Берём ПЕРВУЮ тренировку: на СТАРТ открыты только 1–3, остальные ведут
      // в модалку тарифа. Если она всё же вылезла — закрываем и отмечаем.
      await step(page, rec, 'открыть тренировку в папке', async () => {
        await page.locator('text=Тренировка 1').first().click({ timeout: 8000 })
        await sleep(1800)
        if (await page.locator('text=/доступны в пакете/i').count().catch(() => 0)) {
          rec.find('внимание', 'первая тренировка шаблона закрыта пейволлом даже после пробного периода')
          await dismiss(page)
        }
      })
      const startVisible = await page.locator(tid('workout-start')).count().catch(() => 0)
      if (startVisible) {
        const tStart = Date.now()
        await step(page, rec, 'начать тренировку', async () => {
          await page.locator(tid('workout-start')).click({ timeout: 10000 })
          await page.waitForSelector(tid('set-kg'), { timeout: 25000 })
        }, { critical: true })
        rec.time('старт тренировки до полей подхода', Date.now() - tStart)

        await step(page, rec, 'записать подход', async () => {
          await page.locator(tid('set-kg')).first().fill('40', { timeout: 8000 })
          await page.locator(tid('set-reps')).first().fill('10', { timeout: 8000 })
          await sleep(600)
        }, { critical: true })

        await step(page, rec, 'завершить тренировку', async () => {
          await page.locator(tid('workout-finish')).click({ timeout: 10000 })
          await sleep(1200)
          const confirm = page.locator(tid('workout-save-confirm'))
          if (await confirm.count().catch(() => 0)) { await confirm.click({ timeout: 8000 }); await sleep(2500) }
        }, { critical: true })
      } else rec.skip('начать тренировку', 'кнопка старта не появилась на экране тренировки')
    }

    await dismiss(page)

    // ── 6. Дневник питания: добавить → порция → перенос → удалить → сводка ──
    await step(page, rec, 'вкладка Дневник', async () => { await page.locator(tid('tab-progress')).click({ timeout: 10000 }); await sleep(1200) }, { critical: true })
    const tDiary = Date.now()
    const diaryOk = await step(page, rec, 'открыть дневник питания', async () => {
      await page.locator('text=Дневник питания').first().click({ timeout: 10000 })
      await page.waitForSelector(tid('meal-breakfast'), { timeout: 20000 })
    }, { critical: true })
    rec.time('открытие дневника питания', Date.now() - tDiary)

    if (diaryOk) {
      await step(page, rec, 'добавить в завтрак', async () => {
        await page.locator(tid('meal-add-breakfast')).click({ timeout: 10000 })
        await page.waitForSelector(tid('food-search-input'), { timeout: 15000 })
      }, { critical: true })

      const tSearch = Date.now()
      const searchOk = await step(page, rec, 'поиск еды', async () => {
        await page.locator(tid('food-search-input')).fill('гречка', { timeout: 10000 })
        await page.waitForFunction(() => /гречк/i.test(document.body.innerText), { timeout: 25000 })
      }, { critical: true })
      rec.time('поиск еды «гречка»', Date.now() - tSearch)

      if (searchOk) {
        await step(page, rec, 'выбрать продукт', async () => {
          await page.locator('text=/гречк/i').nth(1).click({ timeout: 10000 }); await sleep(1500)
          const add = page.locator('button:visible').filter({ hasText: /Добавить|Готово|Сохранить/ }).first()
          if (await add.count().catch(() => 0)) { await add.click({ timeout: 8000 }); await sleep(2000) }
        }, { critical: true })

        const inDiary = await page.locator(tid('meal-breakfast')).innerText().catch(() => '')
        if (!/гречк/i.test(inDiary)) rec.find('важное', 'после добавления продукт не появился в завтраке')

        await step(page, rec, 'меню записи', async () => { await page.locator(tid('food-menu')).first().click({ timeout: 8000 }); await sleep(800) })
        await step(page, rec, 'перенести в обед', async () => {
          await page.locator(tid('food-move-open')).first().click({ timeout: 8000 }); await sleep(600)
          await page.locator(tid('food-move-lunch')).first().click({ timeout: 8000 }); await sleep(2000)
        })
        const lunch = await page.locator(tid('meal-lunch')).innerText().catch(() => '')
        if (!/гречк/i.test(lunch)) rec.find('важное', 'перенос между приёмами: запись не появилась в обеде')

        await step(page, rec, 'удалить запись', async () => {
          await page.locator(tid('food-menu')).first().click({ timeout: 8000 }); await sleep(700)
          await page.locator(tid('food-delete')).first().click({ timeout: 8000 }); await sleep(2000)
        })
        const after = await page.evaluate(() => document.body.innerText).catch(() => '')
        if (/гречк/i.test(after)) rec.find('важное', 'после удаления запись всё ещё видна в дневнике')
      }

      await step(page, rec, 'сводка питания', async () => {
        const gear = page.locator('[aria-label="Настройки питания"]').first()
        if (await gear.count().catch(() => 0)) { await gear.click({ timeout: 8000 }); await sleep(700) }
        await page.locator(tid('food-summary')).click({ timeout: 8000 }); await sleep(2000)
      })
      await back(page, rec, 'Дневник питания → Сводка', 'Дневник питания')
    }

    // ── 7. Ассистент — только у одного пользователя, лимит запросов ──
    if (label === `u${ASSISTANT_USER}`) {
      const askAssistant = async (text, name) => {
        if (rec.assistantCalls >= ASSISTANT_MAX_CALLS) { rec.skip(`ассистент: ${name}`, 'исчерпан лимит запросов на прогон'); return false }
        rec.assistantCalls++
        const t = Date.now()
        const ok = await step(page, rec, `ассистент: ${name}`, async () => {
          await page.locator(tid('assistant-input')).fill(text, { timeout: 10000 })
          await page.locator(tid('assistant-send')).click({ timeout: 10000 })
          await page.waitForFunction(n => (document.body.innerText.match(/\n/g) || []).length > n,
            await page.evaluate(() => (document.body.innerText.match(/\n/g) || []).length), { timeout: 90000 })
        }, { critical: true })
        rec.time(`ответ ассистента (${name})`, Date.now() - t)
        return ok
      }
      const opened = await step(page, rec, 'открыть ассистента', async () => {
        await page.locator('text=/ассистент|AI|Спроси/i').first().click({ timeout: 10000 })
        await page.waitForSelector(tid('assistant-input'), { timeout: 20000 })
      })
      if (opened) {
        await askAssistant('Сколько белка нужно в день при весе 70 кг?', 'вопрос 1')
        await askAssistant('А сколько воды пить в день?', 'вопрос 2')
        await askAssistant('Запиши мне в дневник питания 100 г гречки на обед', 'запись рациона')
        await sleep(3000)
        const txt = await page.evaluate(() => document.body.innerText).catch(() => '')
        if (!/гречк/i.test(txt)) rec.find('важное', 'ассистент сказал, что записал рацион, но записи не видно')
        await askAssistant('Удали гречку из дневника питания', 'удаление рациона')
        await sleep(3000)
      } else rec.skip('ассистент целиком', 'не нашёлся вход в ассистента')
    }

    await dismiss(page)

    // ── 8. Настройки и подэкраны ──
    await step(page, rec, 'открыть настройки', async () => {
      await page.locator('button:visible').first().click({ timeout: 8000 })   // аватар в шапке
      await sleep(900)
      await page.locator('text=Настройки').first().click({ timeout: 8000 })
      await page.waitForSelector(tid('settings-plans'), { timeout: 15000 })
    }, { critical: true })

    for (const [t, name, expect] of [['settings-plans', 'Тарифы и подписка', 'Настройки'], ['settings-policy', 'Политика', 'Настройки'], ['settings-consent', 'Согласие', 'Настройки']]) {
      if (!await page.locator(tid(t)).count().catch(() => 0)) { rec.skip(`настройки: ${name}`, 'пункта нет на экране'); continue }
      await step(page, rec, `настройки: ${name}`, async () => { await page.locator(tid(t)).click({ timeout: 8000 }); await sleep(1500) })
      await back(page, rec, `Настройки → ${name}`, expect)
    }

    // ── 9. Перепись кнопок: честно три исхода ──
    const census = ['tab-workouts', 'tab-nutrition', 'tab-library', 'tab-progress', 'settings-plans', 'settings-policy', 'settings-consent', 'trial-start', 'food-summary', 'food-goals']
    for (const t of census) await probe(page, rec, t, tid(t))

  } catch (e) {
    rec.find('ошибка', 'прогон прерван', String(e.message).split('\n')[0].slice(0, 160))
  }

  await shot(page, rec, 'финал')
  rec.token = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('fitpro-auth') || '{}').access_token || null } catch { return null } }).catch(() => null)
  await ctx.close()
  return rec
}

async function checkIsolation(users, recs) {
  const out = []
  for (const a of recs) {
    if (!a.token) { out.push({ from: a.label, skipped: 'нет токена' }); continue }
    for (const b of users) {
      if (b.label === a.label) continue
      for (const table of ['food_diary', 'workouts', 'measurements', 'chat_messages']) {
        const r = await fetch(`https://api.fitproapp.ru/rest/v1/${table}?user_id=eq.${b.id}&select=id&limit=5`,
          { headers: { apikey: ANON, Authorization: `Bearer ${a.token}` } })
        const body = await r.json().catch(() => null)
        const leaked = Array.isArray(body) && body.length > 0
        out.push({ from: a.label, to: b.label, table, status: r.status, rows: Array.isArray(body) ? body.length : null, leaked })
        if (leaked) console.log(`  !!! УТЕЧКА: ${a.label} видит ${table} у ${b.label}`)
      }
    }
  }
  return out
}

let report = { runId: RUN_ID, base: BASE, startedAt: new Date().toISOString(), users: [], isolation: [], narrow: null }
try {
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
  console.log(`\n=== Прогон ${RUN_ID}: завожу ${USERS} аккаунтов ===`)
  const created = await createUsers(RUN_ID, USERS)
  const browser = await chromium.launch({ headless: true })

  console.log(`\n=== ${USERS} пользователей ОДНОВРЕМЕННО, ${PHONE.width}x${PHONE.height} ===`)
  const tAll = Date.now()
  report.users = await Promise.all(created.map(u => walkUser(browser, u, PHONE, `u${u.n}`)))
  report.wallClockSec = Math.round((Date.now() - tAll) / 1000)
  console.log(`Все закончили за ${report.wallClockSec} с`)

  console.log(`\n=== Изоляция данных ===`)
  report.isolation = await checkIsolation(created.map(u => ({ id: u.id, label: `u${u.n}` })), report.users)

  console.log(`\n=== Прогон на ${NARROW.width}px ===`)
  report.narrow = await walkUser(browser, created[0], NARROW, 'narrow-320')
  await browser.close()
} catch (e) {
  report.fatal = String(e.stack || e).slice(0, 1200)
  console.error('\nПРОГОН УПАЛ:', report.fatal)
} finally {
  console.log(`\n=== Удаление тестовых аккаунтов ===`)
  try { const c = await cleanupAll(); report.cleanup = { deleted: c.deleted, problems: c.problems, left: c.left?.length || 0 } }
  catch (e) { report.cleanup = { error: String(e.message) }; console.error('!!! ЧИСТКА УПАЛА:', e.message) }
  report.finishedAt = new Date().toISOString()
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nОтчёт: ${OUT}/report.json`)
}
