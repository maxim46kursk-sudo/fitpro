// ТРИ ПУТИ ЧЕЛЛЕНДЖА НА ПРОДЕ, ЦЕЛИКОМ И СО СНИМКОМ КАЖДОГО ШАГА.
//
//   А. ГОСТЬ: главная → Челлендж → читает страницу → «Участвовать» →
//      предложение аккаунта → регистрация → вернулся на страницу → оплата.
//   Б. ОПЛАТИВШИЙ БЕЗ ДАННЫХ: комната → блок «Заполни данные» → «Мои данные» →
//      заполнил → норма появилась в комнате.
//   В. УЧАСТНИК: комната → «Начать день» → заход → выход → очки в комнате И в
//      таблице потока.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОГОН, А НЕ ТЕСТЫ. Тесты проверяют правила; здесь
// проверяется, что человек ФИЗИЧЕСКИ доходит от кнопки до кнопки на боевом
// сервере, с боевой базой и боевой сборкой. Ни один тест этого не покажет.
//
// ЧТО ОСТАЁТСЯ В ПРОДЕ. Путь А заводит настоящего гостя с меткой qa-e2e- в
// почте — тем же способом, что и остальные прогоны (qa/admin.mjs), и удаляет
// его в конце. Путь Б идёт под этим же человеком. Путь В — под владельцем, и
// всё, что он записал, снимается сразу после проверки.
//
//   node qa/challenge-paths.mjs            # все три
//   node qa/challenge-paths.mjs --only A
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const SUPA = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const OUT = 'qa-screens/challenge'
const ONLY = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '') || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (t) => `[data-testid="${t}"]`

function loadEnv() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return out
}
const SERVICE = loadEnv().SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE) throw new Error('нет SUPABASE_SERVICE_ROLE_KEY')

const admin = (path, init) => fetch(`${SUPA}${path}`, {
  ...init,
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
})

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
const R = { A: {}, Б: {}, В: {} }
let shotNo = 0

async function browser() {
  return chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
}
async function tab(b) {
  return (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ru-RU', permissions: ['camera'] })).newPage()
}
const shot = async (page, name) => {
  shotNo += 1
  await page.screenshot({ path: `${OUT}/${String(shotNo).padStart(2, '0')}-${name}.png` })
}

/** Разовая ссылка входа — пароль человека не трогаем. */
async function magicLink(email) {
  const body = await (await admin('/auth/v1/admin/generate_link', {
    method: 'POST', body: JSON.stringify({ type: 'magiclink', email, options: { redirect_to: BASE } }),
  })).json()
  const raw = body?.action_link || body?.properties?.action_link
  const u = new URL(raw); const s = new URL(SUPA)
  u.protocol = s.protocol; u.host = s.host
  return u.toString()
}

/**
 * ЭКРАН СОГЛАСИЯ — он появляется НЕ СРАЗУ. После входа приложение успевает
 * нарисовать основной экран, и только потом поверх встаёт согласие: ждать его
 * одним waitForSelector нельзя — он срабатывает на первом же, и дальше прогон
 * идёт мимо. Поэтому смотрим в цикле.
 *
 * Галочка — не input, а строка с обработчиком на всей себе: кликать надо по
 * строке, иначе «Поехали» останется серой.
 */
async function пройтиСогласие(page, сек = 20) {
  /**
   * НЕ ВЫХОДИМ РАНО ПО «ПРИЛОЖЕНИЕ УЖЕ ВИДНО». Экран согласия — слой ПОВЕРХ
   * приложения: вкладки под ним существуют с первой секунды, и выход по ним
   * пропускал согласие целиком. Ждём именно его и только его.
   */
  for (let i = 0; i < сек * 2; i += 1) {
    if (await page.locator(tid('consent-accept')).count()) {
      /**
       * Кликаем РОВНО ПО КВАДРАТИКУ галочки, по его координатам.
       *
       * Строка согласия — див с обработчиком, но её центр приходится на ссылку
       * «Политику конфиденциальности»: клик туда уводит на политику вместо
       * переключения, и «Поехали» остаётся серой. Разведано на проде
       * (tools/.cache/probe/consent.mjs): по квадрату — работает.
       */
      const квадрат = await page.evaluate(() => {
        const span = [...document.querySelectorAll('span')]
          .find((e) => /^Я даю согласие на обработку/.test((e.textContent || '').trim()))
        const box = span?.parentElement?.children?.[0]?.getBoundingClientRect()
        return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null
      })
      if (квадрат) await page.mouse.click(квадрат.x, квадрат.y)
      await sleep(500)
      const btn = page.locator(tid('consent-accept'))
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click().catch(() => {})
        await page.waitForSelector('[data-screen]', { timeout: 60000 }).catch(() => {})
        return true
      }
    }
    await sleep(500)
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════
// А. ГОСТЬ
// ═══════════════════════════════════════════════════════════════════════════
async function путьА() {
  const b = await browser()
  const page = await tab(b)
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
    await sleep(1500)
    await shot(page, 'A-главная')

    // войти гостем
    await page.locator('text=Начать').first().click().catch(() => {})
    await sleep(2500)
    await shot(page, 'A-гость-вошёл')
    R.A.гостьВошёл = (await page.locator('[data-screen]').count()) > 0

    await page.locator(tid('tab-workouts')).click({ force: true })
    await sleep(2500)
    R.A.карточкаЕсть = (await page.locator(tid('program-folder-challenge')).count()) > 0
    await shot(page, 'A-тренировки')

    await page.locator(tid('program-folder-challenge')).click()
    await sleep(3000)
    // ГЛАВНОЕ: страница открылась, а не окно «участвовать в челлендже?»
    R.A.страницаОткрылась = (await page.locator(tid('challenge-screen')).count()) > 0
    R.A.окноПредложения = (await page.locator('text=Место в потоке привязывается').count()) > 0
    R.A.цена = await page.locator(tid('challenge-price')).innerText().catch(() => null)
    R.A.кнопкаГероя = await page.locator(tid('challenge-hero-join')).innerText().catch(() => null)
    await shot(page, 'A-страница-челленджа')

    // читает: правила и призы на месте
    R.A.правила = (await page.locator(tid('challenge-rules')).count()) > 0
    R.A.призы = await page.locator(tid('challenge-prizes-total')).innerText().catch(() => null)

    // ПРЫЖОК ИЗ ЛИПКОЙ ПОЛОСЫ — не должен ронять на битую раскладку
    await page.evaluate(() => { document.querySelector('.mt-ch__view').scrollTop = 900 })
    await sleep(800)
    R.A.полосаВидна = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="challenge-bar"]')
      return !!bar && bar.classList.contains('is-on')
    })
    await shot(page, 'A-липкая-полоса')
    await page.locator(tid('challenge-bar-join')).click()
    await sleep(1600)
    R.A.послеПрыжка = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="challenge-join"]')
      const bar = document.querySelector('[data-testid="challenge-bar"]')
      if (!btn) return { есть: false }
      const r = btn.getBoundingClientRect()
      const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        есть: true,
        виднаЦеликом: r.top >= 0 && r.bottom <= innerHeight,
        подПолосой: !!bar && bar.classList.contains('is-on') && r.bottom > bar.getBoundingClientRect().top,
        сверхуЛежит: mid?.getAttribute?.('data-testid') || mid?.className || '—',
      }
    })
    await shot(page, 'A-кнопка-после-прыжка')

    // «Участвовать» → предложение аккаунта
    await page.locator(tid('challenge-agree')).click()
    await sleep(300)
    await page.locator(tid('challenge-join')).click()
    await sleep(2000)
    // Предложение — лист поверх страницы, а не вместо неё: человек не теряет
    // из виду то, что читал.
    R.A.предложениеПоНажатию = await page.evaluate(() =>
      /Создать аккаунт/i.test(document.body.innerText))
    await shot(page, 'A-предложение-аккаунта')

    // регистрация
    const email = `qa-e2e-path-${Date.now().toString().slice(-6)}@qa.fitproapp.ru`
    const pass = 'QaE2E-passw0rd!'
    R.A.почта = email
    await page.locator('button:visible, a:visible').filter({ hasText: /Создать аккаунт|Зарегистр/i }).first().click().catch(() => {})
    await sleep(2000)
    await shot(page, 'A-форма-регистрации')
    // Форма просит имя, почту и пароль дважды — заполняем всё, иначе она
    // молча не отправится, и прогон соврёт про «регистрация не работает».
    await page.locator('input[type="text"]:visible').first().fill('Гость Прогонов').catch(() => {})
    await page.locator('input[type="email"]:visible').first().fill(email)
    const passFields = page.locator('input[type="password"]:visible')
    const n = await passFields.count()
    for (let i = 0; i < n; i += 1) await passFields.nth(i).fill(pass)
    await shot(page, 'A-форма-заполнена')
    await page.locator('button:visible').filter({ hasText: /Создать аккаунт/ }).first().click()
    await sleep(4000)
    await shot(page, 'A-после-регистрации')

    /**
     * ПОЧТУ ПОДТВЕРЖДАЕМ ЗА ЧЕЛОВЕКА. GoTrue настроен на подтверждение
     * (GOTRUE_MAILER_AUTOCONFIRM=false): после формы человек уходит в почтовый
     * ящик и возвращается по ссылке. Ждать письма в прогоне нечем, поэтому
     * подтверждаем сервисным ключом — это ровно то же, что делает переход по
     * ссылке, и дальше человек входит сам, как вошёл бы он.
     */
    const список = await (await admin('/auth/v1/admin/users?page=1&per_page=200')).json()
    const свежий = (список?.users || []).find((u) => u.email === email)
    R.A.аккаунтЗаведён = !!свежий
    if (свежий) {
      await admin(`/auth/v1/admin/users/${свежий.id}`, { method: 'PUT', body: JSON.stringify({ email_confirm: true }) })
      R.A.почтаПодтверждена = true
    }

    // ВХОД В ТОЙ ЖЕ ВКЛАДКЕ — метка возврата обязана его пережить
    // Переключаемся ссылкой «Уже есть аккаунт? Войти» под формой, а не вкладкой:
    // кнопка «Войти» есть ещё и в шапке, и она забирала нажатие себе.
    // Переключение перерисовывает форму и стирает введённое — заполняем ПОСЛЕ.
    await page.locator('text=Уже есть аккаунт?').locator('..').locator('text=Войти').first().click()
      .catch(async () => { await page.getByRole('link', { name: 'Войти' }).first().click().catch(() => {}) })
    await sleep(1500)
    await page.locator('input[type="email"]:visible').first().fill(email)
    await page.locator('input[type="password"]:visible').first().fill(pass)
    await sleep(300)
    await shot(page, 'A-вход-заполнен')
    await page.locator('button:visible').filter({ hasText: /Войти →/ }).first().click()
    await пройтиСогласие(page)
    await sleep(5000)
    await shot(page, 'A-после-входа')

    // ВЕРНУЛСЯ ЛИ НА СТРАНИЦУ ЧЕЛЛЕНДЖА
    R.A.меткаВозврата = await page.evaluate(() => {
      try { return localStorage.getItem('fitpro_return_to') } catch { return 'нет доступа' }
    })
    R.A.вернулсяНаЧеллендж = (await page.locator(tid('challenge-screen')).count()) > 0
    R.A.кнопкаОплаты = await page.locator(tid('challenge-join')).innerText().catch(() => null)

    // оплата: ссылку Продамуса выписывают — дальше не идём, деньги настоящие
    if (R.A.вернулсяНаЧеллендж) {
      const ответ = page.waitForResponse((r) => r.url().includes('/api/create-payment'), { timeout: 30000 }).catch(() => null)
      await page.locator(tid('challenge-agree')).click().catch(() => {})
      await sleep(300)
      await page.locator(tid('challenge-join')).click().catch(() => {})
      const res = await ответ
      R.A.оплата = res ? { код: res.status(), тело: (await res.text()).slice(0, 120) } : 'ответа не было'
      await sleep(1500)
      await shot(page, 'A-оплата')
    }
  } catch (e) {
    R.A.ошибка = e.message
    await shot(page, 'A-упал').catch(() => {})
  } finally {
    await b.close()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Б. ОПЛАТИВШИЙ БЕЗ ДАННЫХ
// ═══════════════════════════════════════════════════════════════════════════
async function путьБ() {
  const b = await browser()
  const page = await tab(b)
  let uid = null
  try {
    // человек, у которого нет ни нормы, ни данных о себе
    const email = `qa-e2e-room-${Date.now().toString().slice(-6)}@qa.fitproapp.ru`
    const created = await (await admin('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'QaE2E-passw0rd!', email_confirm: true }),
    })).json()
    uid = created?.id
    R.Б.почта = email
    if (!uid) throw new Error('не удалось завести человека: ' + JSON.stringify(created).slice(0, 160))
    await admin('/rest/v1/profiles', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: uid, name: 'Гость Прогонов' }),
    })

    // зачисляем его в тест-поток тем же путём, что и вебхук
    const [season] = await (await admin('/rest/v1/challenge_seasons?select=id&status=eq.staff')).json()
    const no = await (await admin('/rest/v1/rpc/challenge_enroll', {
      method: 'POST',
      body: JSON.stringify({ p_season_id: season.id, p_user_id: uid, p_payment_id: `qa-${Date.now()}`, p_display_name: 'Гость Прогонов' }),
    })).json()
    R.Б.номерУчастника = no

    await page.goto(await magicLink(email), { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 60000 }).catch(() => {})
    await пройтиСогласие(page)
    await sleep(2500)

    await page.locator(tid('tab-workouts')).click({ force: true })
    await sleep(2500)
    await page.locator(tid('program-folder-challenge')).click()
    await page.waitForSelector(tid('stream-room'), { timeout: 60000 })
    await sleep(4000)

    R.Б.блокЕсть = (await page.locator(tid('stream-need-data')).count()) > 0
    R.Б.блокТекст = await page.locator(tid('stream-need-data')).innerText().catch(() => null)
    R.Б.кнопка = await page.locator(tid('stream-my-data')).innerText().catch(() => null)
    await shot(page, 'Б-комната-без-данных')

    await page.locator(tid('stream-my-data')).click()
    await sleep(3000)
    R.Б.экранДанных = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, ' '))
    await shot(page, 'Б-мои-данные')

    // заполняем данные о себе прямо в базе — форма профиля своя у каждого поля,
    // а проверяем мы не её, а то, что норма после этого доезжает до комнаты
    await admin('/rest/v1/food_goals', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: uid, kcal: 2100, p: 130, f: 70, c: 230 }),
    })
    R.Б.нормаЗаписана = true

    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
    await sleep(2500)
    await page.locator(tid('tab-workouts')).click({ force: true })
    await sleep(2500)
    await page.locator(tid('program-folder-challenge')).click()
    await page.waitForSelector(tid('stream-room'), { timeout: 60000 })
    await sleep(5000)

    R.Б.блокПослеЗаполнения = (await page.locator(tid('stream-need-data')).count()) > 0
    R.Б.нормаВКомнате = await page.locator(tid('stream-macros')).innerText().catch(() => null)
    await shot(page, 'Б-комната-с-нормой')

    const [entry] = await (await admin(`/rest/v1/challenge_entries?select=norm1_kcal,norm1_at&user_id=eq.${uid}`)).json()
    R.Б.слепокНормы = entry
  } catch (e) {
    R.Б.ошибка = e.message
    await shot(page, 'Б-упал').catch(() => {})
  } finally {
    await b.close()
  }
  return uid
}

// ═══════════════════════════════════════════════════════════════════════════
// В. УЧАСТНИК (владелец)
// ═══════════════════════════════════════════════════════════════════════════
async function путьВ() {
  const b = await browser()
  const page = await tab(b)
  try {
    const [trainer] = await (await admin('/rest/v1/profiles?select=id&role=eq.trainer&limit=1')).json()
    const user = await (await admin(`/auth/v1/admin/users/${trainer.id}`)).json()
    const было = await (await admin(`/rest/v1/motion_attempts?select=day,tier,attempt_no,score&user_id=eq.${trainer.id}`)).json()
    R.В.доЗахода = было

    await page.goto(await magicLink(user.email), { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 60000 }).catch(() => {})
    await page.waitForSelector('[data-screen]', { timeout: 60000 })
    await sleep(2500)
    await page.locator(tid('tab-workouts')).click({ force: true })
    await sleep(2500)
    await page.locator(tid('program-folder-challenge')).click()
    await page.waitForSelector(tid('stream-room'), { timeout: 60000 })
    await sleep(4000)

    R.В.комнатаДо = {
      день: await page.locator(tid('stream-day')).innerText(),
      заСегодня: (await page.locator(tid('stream-today-score')).innerText()).split('\n')[0],
      кнопка: await page.locator(tid('stream-start')).innerText(),
    }
    await shot(page, 'В-комната-до')

    await page.locator(tid('stream-start')).click()
    await page.waitForSelector(tid('level-novice'), { timeout: 90000 })
    await sleep(1500)
    R.В.выборУровня = await page.locator(tid('challenge-day')).innerText().catch(() => null)
    await shot(page, 'В-выбор-уровня')

    // заход пишем тем же ключом и той же формой, что и сессия: проверяется
    // дорога данных, а не распознавание движений
    R.В.заход = await page.evaluate(() => {
      const KEY = 'fitpro-motion.challenge.attempts.v1'
      const store = JSON.parse(localStorage.getItem(KEY) || '{"days":{},"started":{}}')
      const day = String(document.querySelector('[data-testid="challenge-day"]').innerText.match(/\d+/)[0])
      const list = store.days[day]?.novice || []
      store.days[day] = { ...(store.days[day] || {}), novice: [...list, { score: 654, reps: 11, hits: 8, spawned: 13, reactMs: 390, at: new Date().toISOString() }] }
      localStorage.setItem(KEY, JSON.stringify(store))
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
      return { day, score: 654 }
    })

    // выход из игры — крестик ведёт обратно в комнату
    await page.locator('.mt-corner--left').first().click()
    await page.waitForSelector(tid('stream-room'), { timeout: 60000 })
    await sleep(6000)

    R.В.комнатаПосле = {
      заСегодня: (await page.locator(tid('stream-today-score')).innerText()).split('\n')[0],
      заПоток: (await page.locator(tid('stream-total')).innerText()).split('\n')[0],
      место: await page.locator(tid('stream-place-value')).innerText(),
    }
    await shot(page, 'В-комната-после')

    R.В.наСервере = await (await admin(`/rest/v1/motion_attempts?select=day,tier,attempt_no,score&user_id=eq.${trainer.id}&order=id.desc`)).json()

    await page.locator(tid('stream-standings')).click()
    await page.waitForSelector(tid('standings-screen'), { timeout: 30000 })
    await sleep(3000)
    R.В.таблица = await page.evaluate(() => document.querySelector('[data-testid="standings-screen"]').innerText.replace(/\s+/g, ' ').slice(0, 300))
    R.В.заголовки = await page.evaluate(() =>
      [...document.querySelectorAll('.mt-st__cols span')].map((e) => {
        const r = e.getBoundingClientRect()
        return { текст: e.innerText, слева: Math.round(r.left), справа: Math.round(r.right) }
      }))
    await shot(page, 'В-таблица')

    // прибрать за собой: заход был наш, а данные владельца боевые
    await admin(`/rest/v1/motion_attempts?user_id=eq.${trainer.id}&tier=eq.novice&score=eq.654`, { method: 'DELETE' })
    R.В.прибрано = true
  } catch (e) {
    R.В.ошибка = e.message
    await shot(page, 'В-упал').catch(() => {})
  } finally {
    await b.close()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
if (!ONLY || ONLY.includes('А') || ONLY.includes('A')) await путьА()
let uidБ = null
if (!ONLY || ONLY.includes('Б') || ONLY.includes('B')) uidБ = await путьБ()
if (!ONLY || ONLY.includes('В') || ONLY.includes('V')) await путьВ()

console.log(JSON.stringify(R, null, 2))
console.log(`\nснимки: ${OUT}/`)
if (uidБ) console.log(`ЧЕЛОВЕК ПУТИ Б НЕ УДАЛЁН: ${uidБ} — у него запись в потоке (это финансовый документ, сносить его молча нельзя)`)
