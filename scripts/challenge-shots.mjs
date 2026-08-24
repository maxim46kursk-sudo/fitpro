/**
 * СЪЁМКА КАРТИНОК ДЛЯ СТРАНИЦЫ ЧЕЛЛЕНДЖА — public/challenge/shot-*.webp.
 *
 * ЗАЧЕМ АВТОМАТОМ, А НЕ РУКАМИ. Правила показывают человеку то, что он увидит в
 * приложении, и картинка, снятая руками, устаревает молча: интерфейс правят, а
 * снимок в правилах остаётся прошлогодним — и человек, заплативший за поток,
 * читает описание не того продукта. Пересъёмка обязана быть одной строкой:
 *
 *     npm run shots:challenge                     # все четыре
 *     npm run shots:challenge -- --only fight
 *     npm run shots:challenge -- --preview        # снять и проверить саму страницу
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ. Все четыре снимка — живые экраны приложения: тот же код,
 * та же сборка, тот же MediaPipe. Подменена ровно камера — записью живых
 * движений (tools/motion-persona/camera.js), как в прогоне персонажа, и сеть.
 * Таблица участников снимается так же: настоящий StandingsScreen на подставленном
 * сырье, а не нарисованный рядом макет.
 *
 * НИ ПРОДА, НИ АККАУНТОВ. Всё поднимается местным сервером на 4195, а данные для
 * экранов FitPro (профиль, норма, дневник) подставляются перехватом сети прямо в
 * браузере: снимать интерфейс, заводя ради этого живого пользователя в боевой
 * базе, — плохая цена за картинку.
 *
 * ДВИЖОК — CHROMIUM, и это не отказ от webkit. В сборке WebKit, которую везёт
 * playwright, нет OffscreenCanvas: MediaPipe уходит считать на главный поток, и
 * силуэт в кадре загорается через раз. Ровно по этой причине на chromium стоит и
 * прогон персонажа (tools/motion-persona/run.mjs, там разобрано подробно).
 * Chromium же умеет кодировать webp прямо в холсте — им и жмём.
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { POLICY_VERSION } from '../src/legalText.js'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const ROOT = here('../')
const APP_DIST = here('../dist')
const HARNESS_DIST = here('../tools/.cache/challenge-harness')
const ASSETS = here('../tools/.cache/motion-assets')
const OUT = here('../public/challenge')

const PORT = 4195
const BASE = `http://localhost:${PORT}`

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const has = (name) => args.includes(name)

const ONLY = (argOf('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const HEADED = has('--headed')

/** Ширина картинки на странице и потолок веса одного файла. */
const WIDTH = 720
const MAX_BYTES = 80 * 1024

const say = (...a) => console.log(...a)

// ------------------------------------------------------------------ сборка ---

function build(what, cmd) {
  say(`собираю ${what}…`)
  const r = spawnSync('npx', cmd, { cwd: ROOT, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`сборка (${what}) не прошла`)
    process.exit(1)
  }
}

if (!has('--no-build')) {
  build('приложение', ['vite', 'build'])
  build('страницу съёмки', [
    'vite', 'build', '--config', 'scripts/challenge-shots/vite.shots.config.js',
  ])
}

const MODEL = `${ASSETS}/models/pose_landmarker_lite.task`
if (!existsSync(MODEL)) {
  console.error(
    `нет файла модели: ${MODEL}\nскачать один раз:\n` +
      '  curl -L -o tools/.cache/motion-assets/models/pose_landmarker_lite.task \\\n' +
      '    https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  )
  process.exit(1)
}

// ------------------------------------------------------------------ сервер ---

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
}
const WASM_DIR = `${ROOT}node_modules/@mediapipe/tasks-vision/wasm`

function resolve(url) {
  // Картинки правил — прямо из public, а не из собранного dist: проверка в
  // конце обязана смотреть на только что снятые файлы, а не на те, что попали
  // в сборку до съёмки.
  if (url.startsWith('/challenge/')) return `${OUT}/${url.slice('/challenge/'.length)}`
  if (url === '/harness.html' || url.startsWith('/assets-harness/')) {
    return `${HARNESS_DIST}${url.replace('/assets-harness', '/assets')}`
  }
  const wasm = url.match(/^\/motion-assets\/tasks-vision\/[^/]+\/wasm\/(.+)$/)
  if (wasm) return `${WASM_DIR}/${wasm[1]}`
  const model = url.match(/^\/motion-assets\/models\/(.+)$/)
  if (model) return `${ASSETS}/models/${model[1]}`
  // страница съёмки просит свои чанки по относительным путям — они лежат рядом
  if (existsSync(`${HARNESS_DIST}${url}`) && url.includes('.')) return `${HARNESS_DIST}${url}`
  if (url === '/' || !url.includes('.')) return `${APP_DIST}/index.html`
  return `${APP_DIST}${url}`
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  const file = resolve(url)
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream',
    'cache-control': 'no-store',
  })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, r))
say(`сервер съёмки: ${BASE}`)

// Только поднять сервер и не снимать: этим разглядывают страницу съёмки руками,
// когда снимок вышел не тем, чего ждали.
if (has('--serve')) {
  say('режим --serve: страница открыта, съёмки не будет. Ctrl+C чтобы закрыть.')
  await new Promise(() => {})
}

// ------------------------------------------------- подставная база для FitPro ---

/**
 * ЧЕЛОВЕК, КОТОРОГО НЕТ. Экраны профиля и дневника питания показывают только
 * вошедшему, а заводить ради снимка живого пользователя в боевой базе нельзя.
 * Поэтому сессия кладётся в хранилище браузера, а все запросы к базе
 * перехватываются и отвечают заранее заготовленными данными — теми, что описаны
 * в правилах: норма 2000/120/220/65 и день, попавший в неё.
 */
const USER_ID = '11111111-1111-4111-8111-111111111111'
const TODAY = new Date().toISOString().slice(0, 10)

const PROFILE = {
  id: USER_ID,
  name: 'Ирина Ковалёва',
  email: 'irina@example.com',
  gender: 'female',
  birthdate: '1992-04-18',
  height: 168,
  weight: 63.5,
  // Значения — те же, что кладёт само приложение: цель выбирается из списка
  // («Похудение», «Набор массы»…), род деятельности пишется словами. Подставь
  // сюда коды из базы — и на картинке правил человек прочитал бы «loss».
  goal: 'Похудение',
  activity_level: 'medium',
  occupation: 'сидячая работа',
  gym_days: 4,
  role: 'client',
  plan: 'profit',
  plan_until: '2027-01-01T00:00:00Z',
  trial_used: true,
  coach_id: null,
  pd_consent_at: '2026-08-01T10:00:00Z',
  // версия берётся из самого приложения: подними POLICY_VERSION — и без этой
  // строки съёмка упрётся в экран согласия вместо дневника
  pd_consent_version: POLICY_VERSION,
  units: { weight: 'kg', height: 'cm' },
  notifs: {},
  lang: 'ru',
}

const GOALS = { user_id: USER_ID, kcal: 2000, p: 120, c: 220, f: 65 }

const MEAL = (id, meal, name, grams, kcal, p, c, f, at) => ({
  id, user_id: USER_ID, date: TODAY, meal, name,
  grams, kcal, p, c, f, created_at: at,
})
const DIARY = [
  MEAL(1, 'breakfast', 'Овсянка на молоке', 250, 320, 12, 52, 7, `${TODAY}T06:10:00Z`),
  MEAL(2, 'breakfast', 'Кофе с молоком', 200, 60, 3, 5, 3, `${TODAY}T06:12:00Z`),
  MEAL(3, 'lunch', 'Куриная грудка, гриль', 180, 300, 40, 0, 7, `${TODAY}T09:40:00Z`),
  MEAL(4, 'lunch', 'Гречка отварная', 200, 246, 9, 50, 2, `${TODAY}T09:41:00Z`),
  MEAL(5, 'lunch', 'Салат овощной с маслом', 150, 130, 2, 8, 10, `${TODAY}T09:42:00Z`),
  MEAL(6, 'dinner', 'Треска запечённая', 200, 208, 30, 0, 5, `${TODAY}T15:30:00Z`),
  MEAL(7, 'dinner', 'Овощи на пару', 250, 90, 4, 14, 2, `${TODAY}T15:31:00Z`),
  MEAL(8, 'snack', 'Творог 5%', 150, 180, 18, 5, 8, `${TODAY}T12:00:00Z`),
]

/** Сезон и участие — для экранов Motion, где виден счётчик попыток. */
/**
 * Дата за N дней до сегодня, `YYYY-MM-DD`. Нужна снимкам, где поток обязан
 * ИДТИ: день участника считает календарь (src/motion/game/challenge.js), и с
 * датой из будущего экран честно покажет «поток ещё не начался» вместо игры.
 */
const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const SEASON = {
  // дата — как на проде (sql/2026-08-24_season1_starts_on.sql): предпросмотр
  // обязан показывать ровно то, что увидит человек
  id: 1, title: 'Поток 1', starts_on: '2026-09-10', price_rub: 2990,
  prize_pct: 50, prize_split: [50, 30, 20], status: 'open',
  challenge_entries: [{ id: 1, participant_no: 12, display_name: 'Ирина Ковалёва', paid_at: '2026-08-20T10:00:00Z', rules_accepted_at: '2026-08-20T09:00:00Z' }],
  challenge_rules_consent: [{ accepted_at: '2026-08-20T09:00:00Z' }],
}

/**
 * СЫРЬЁ ТАБЛИЦЫ ПОТОКА — то, что отдаёт challenge_standings: участник × день.
 * Расклад тот же, что нарисован человеку в правилах: Аня третья в движении и
 * первая в питании обгоняет Игоря, первого в игре и пятого в еде.
 */
const STANDINGS = (() => {
  const NORM = { norm_kcal: 2000, norm_p: 120, norm_f: 65, norm_c: 220 }
  const people = [
    { no: 7, name: 'Ирина К.', me: true, score: 4280, eat: 0.98, done: 30 },
    { no: 3, name: 'Максим Д.', score: 4710, eat: 0.82, done: 30 },
    { no: 18, name: 'Алексей П.', score: 3990, eat: 0.93, done: 29 },
    { no: 25, name: 'Ольга С.', score: 3270, eat: 0.95, done: 30 },
    { no: 11, name: 'Дмитрий В.', score: 3500, eat: 0.78, done: 27 },
    { no: 31, name: 'Наталья Ж.', score: 2950, eat: 0.9, done: 26 },
    { no: 5, name: 'Сергей Т.', score: 3170, eat: 0.7, done: 24 },
    { no: 22, name: 'Павел Н.', score: 2600, eat: 0.66, done: 21 },
  ]
  const rows = []
  for (const person of people) {
    for (let day = 1; day <= 30; day += 1) {
      // поток пройден целиком: на картинке показываем итог, а не середину, где
      // средний процент питания заведомо ниже — делится он на все тридцать дней
      const played = true
      const eat = person.eat
      rows.push({
        participant_no: person.no,
        display_name: person.name,
        is_me: !!person.me,
        days_done: person.done,
        day,
        best_score: played ? person.score : 0,
        kcal: 2000 * eat,
        p: 120 * eat,
        f: 65 * eat,
        c: 220 * eat,
        meals: played ? 4 : 0,
        ...NORM,
      })
    }
  }
  return rows
})()

const TABLE_DATA = {
  profiles: [PROFILE],
  food_goals: [GOALS],
  food_diary: DIARY,
  challenge_seasons: [SEASON],
}

/** Подставной токен: supabase-js только разбирает его, подпись не проверяет. */
const fakeJwt = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 30
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, role: 'authenticated', exp, email: PROFILE.email })}.signature`
}

const SESSION = {
  access_token: fakeJwt(),
  refresh_token: 'shots-refresh',
  token_type: 'bearer',
  expires_in: 3600 * 24 * 30,
  expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 30,
  user: {
    id: USER_ID, aud: 'authenticated', role: 'authenticated', email: PROFILE.email,
    user_metadata: { name: PROFILE.name }, app_metadata: { provider: 'email' },
    created_at: '2026-01-01T00:00:00Z',
  },
}

async function mockBackend(page, { season = true, consent = true, seasonStart = null } = {}) {
  await page.route('**/auth/v1/**', (route) => {
    const url = route.request().url()
    const body = /\/user/.test(url) ? SESSION.user : SESSION
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  await page.route('**/rest/v1/**', (route) => {
    const req = route.request()
    const table = (new URL(req.url()).pathname.split('/rest/v1/')[1] || '').split('?')[0]
    // Таблица потока приходит функцией, а не таблицей: отвечаем тем же сырьём,
    // что отдала бы база живому участнику.
    if (table === 'rpc/challenge_standings') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STANDINGS) })
    }
    if (table.startsWith('rpc/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    }
    // Участие в потоке подставляется НЕ ВСЕГДА: пятый экран правил показывает
    // выбор уровня обычному человеку (три карточки), шестой — участнику, у
    // которого считаются попытки. Это два разных экрана, и разводит их ровно
    // наличие своей строки в сезоне.
    let rows = TABLE_DATA[table] || []
    if (table === 'challenge_seasons') {
      // consent: false — человек правил ещё не читал. Так проверяется дорога
      // «карточка на главной → правила», и так же выглядит первый заход.
      if (!season) rows = []
      else if (!consent) rows = [{ ...SEASON, challenge_entries: [], challenge_rules_consent: [] }]
      // Снимку таблицы нужен поток, который УЖЕ ИДЁТ: до старта таблица
      // честно пуста, и снимать в ней нечего.
      if (seasonStart && rows.length) rows = [{ ...rows[0], starts_on: seasonStart }]
    }
    // maybeSingle()/single() просят объект, а не массив — supabase-js говорит об
    // этом заголовком Accept, и ответ обязан быть в той же форме
    const wantsObject = /pgrst\.object/.test(req.headers().accept || '')
    const body = wantsObject ? (rows[0] ?? null) : rows
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  // всё остальное наружу (аналитика, api/) — молчаливая пустота
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
}

// ---------------------------------------------------------------- предпросмотр ---

/**
 * `--preview` — не съёмка картинок ДЛЯ правил, а съёмка САМИХ правил: как экран
 * выглядит человеку и нет ли на нём сырой разметки.
 *
 * Зачем отдельным ходом. Правила — витрина, по которой решают, платить ли 2990,
 * и её вид проверяют глазами. Но глаз пропускает то, что скрипт видит сразу:
 * звёздочку жирного, решётку заголовка, дефис списка, приехавшие в текст как
 * есть. Поэтому скрипт проходит ВСЕ двенадцать экранов и падает, если нашёл, —
 * а заодно откладывает четыре снимка для человека.
 */
const PREVIEW_OUT = here('../qa-screens/landing')

// -------------------------------------------------------------------- съёмка ---

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
})

/**
 * ТЕЛЕФОН РОВНО В ПРОПОРЦИИ 9:17 — той, в которой снимок стоит на странице
 * челленджа. Снимаем экран целиком, во весь рост: 390 × 737 и есть 9:17, так
 * что кадрировать потом нечего и чёрных полей не будет.
 */
const PHONE = { width: 390, height: 737 }
async function newPage({ mobile = true, screen = null } = {}) {
  const context = await browser.newContext({
    viewport: screen ?? (mobile ? PHONE : { width: 720, height: 1360 }),
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'ru-RU',
    permissions: [],
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => say('  [ошибка страницы]', String(e.message).slice(0, 160)))
  return page
}

const shots = new Map()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Дождаться, пока камера прогреется и распознавание встанет на ноги. */
async function warmUp(page) {
  await page.waitForFunction(() => window.__shotsReady === true, null, { timeout: 60000 })
  const boom = await page.evaluate(() => window.__shotsBootError || null)
  if (boom) throw new Error(`страница съёмки не поднялась: ${boom}`)
}

/**
 * Экран Motion: поднять страницу съёмки, засеять данные, смонтировать раздел.
 * seed и props — то, чем один снимок отличается от другого.
 */
async function motionPage({ seed = null, props = {}, query = '', season = true, screen = null, seasonStart = null } = {}) {
  const page = await newPage({ screen })
  await mockBackend(page, { season, seasonStart })
  await page.goto(`${BASE}/harness.html${query}`, { waitUntil: 'domcontentloaded' })
  await warmUp(page)
  if (seed) await page.evaluate((s) => window.__shots.seed(s), seed)
  await page.evaluate((p) => window.__shots.mount(p), props)
  return page
}

/** Кадры пошли — значит камера жива и распознавание получило чем работать. */
async function framesFlowing(page, min = 60) {
  await page.waitForFunction((n) => (window.__shots?.frames || 0) > n, min, { timeout: 120000 })
}

/**
 * КАДР ПОД ПРОПОРЦИЮ БЛОКА, А НЕ ТЕЛЕФОН ЦЕЛИКОМ.
 *
 * Картинка в правилах — широкий блок сверху экрана. Вертикальный снимок
 * телефона в нём либо стоит в чёрных полях по бокам, либо режется пополам.
 * Поэтому кадрируем при съёмке: берём полосу нужной пропорции по ГЛАВНОМУ
 * месту кадра — силуэт, карточки уровней, счёт, календарь, — и она заполняет
 * блок целиком.
 */
/**
 * ЧИСТЫЙ КАДР. На экране приложения живут вещи, которых в правилах быть не
 * должно: крестик выхода, тумблер звука, кнопка комнаты, панель отладки, а на
 * экранах поверх камеры — ещё и скелет распознавания, просвечивающий сквозь
 * карточки. Всё это прячется на время съёмки одним стилем и возвращается
 * сразу после: снимок обязан показывать продукт, а не служебную обвязку.
 */
const HIDE_ALWAYS = '.mt-corner, .mt-menu__button, [data-testid="panel-close"], .mt-debug, .mt-debug__fab'
const HIDE_CAMERA = '.mt-overlay, .mt-video, .mt-silhouette'

async function shoot(page, id, { hideCamera = false, ...opts } = {}) {
  const css = `${HIDE_ALWAYS}${hideCamera ? `, ${HIDE_CAMERA}` : ''} { display: none !important; }`
  const handle = await page.addStyleTag({ content: css })
  await wait(150)
  const buf = await page.screenshot({ type: 'png', ...opts })
  await handle.evaluate((el) => el.remove())
  shots.set(id, buf)
  say(`  снято ${id} (${Math.round(buf.length / 1024)} КБ png)`)
}

const want = (id) => !ONLY.length || ONLY.includes(id)

// ---------------------------------------------------------------- предпросмотр ---

/**
 * `--preview` — не съёмка картинок ДЛЯ страницы, а съёмка САМОЙ страницы: как
 * она выглядит человеку и не разъезжается ли текст.
 *
 * Проверка одна и обязательная: пройти страницу целиком на двух размерах и
 * упасть, если хоть одна строка обрезана по ширине или список развалился на
 * колонки. Ровно так и ломался макет: жирное начало пункта вставало отдельной
 * колонкой рядом с остальным текстом, и человек читал две половины подряд.
 */
if (has('--preview')) {
  const SIZES = [
    { name: '390x844', width: 390, height: 844 },
    { name: '360x640', width: 360, height: 640 },
  ]
  mkdirSync(PREVIEW_OUT, { recursive: true })

  const problems = []
  let joinLine = ''

  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'ru-RU',
    })
    const page = await context.newPage()
    await mockBackend(page, { consent: false })
    await page.goto(`${BASE}/harness.html`, { waitUntil: 'domcontentloaded' })
    await warmUp(page)
    await page.evaluate(() => window.__shots.mount({ startScreen: 'challenge' }))
    await page.waitForSelector('[data-testid="challenge-screen"]', { timeout: 60000 })

    /**
     * ЧТО СЧИТАЕТСЯ ПОЛОМКОЙ:
     *   1) строка шире своего блока — текст обрезан или уехал за край;
     *   2) страница прокручивается вбок — то же самое, но целиком;
     *   3) пункт списка развалился на колонки: текст и его жирное начало стоят
     *      рядом, а не одним потоком. Проверяется по числу текстовых детей у
     *      элемента с display:flex — их должно быть не больше одного.
     */
    const bad = await page.evaluate(() => {
      const out = []
      const root = document.querySelector('[data-testid="challenge-screen"]')
      const view = root.querySelector('.mt-ch__view')
      if (view && view.scrollWidth > view.clientWidth + 1) {
        out.push(`страница прокручивается вбок: ${view.scrollWidth} при ${view.clientWidth}`)
      }
      for (const el of root.querySelectorAll('p, li, h1, h2, h3, span, b, div')) {
        if (!el.textContent.trim()) continue
        if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'auto') {
          out.push(`«${el.textContent.trim().slice(0, 42)}…» шире блока на ${el.scrollWidth - el.clientWidth}px`)
        }
      }
      for (const li of root.querySelectorAll('.mt-ch__pain li, .mt-ch__inc li')) {
        const kids = [...li.children].filter((c) => c.textContent.trim())
        // иконка + один span с текстом; всё, что сверх, — развалившаяся строка
        if (kids.length > 2) out.push(`пункт списка разбит на ${kids.length} колонок: «${li.textContent.trim().slice(0, 42)}…»`)
      }
      return out
    })
    for (const b of bad) problems.push(`${size.name}: ${b}`)
    say('')
    say(`${size.name}: проблем ${bad.length}`)
    for (const b of bad) say(`  ${b}`)

    // Галочка включает кнопку — то же, что проверяет vitest, но на живой сборке.
    await page.locator('[data-testid="challenge-agree"]').scrollIntoViewIfNeeded()
    const before = await page.locator('[data-testid="challenge-join"]').isDisabled()
    await page.locator('[data-testid="challenge-agree"]').click()
    await wait(200)
    const after = await page.locator('[data-testid="challenge-join"]').isDisabled()
    if (!before || after) problems.push(`${size.name}: галочка не управляет кнопкой (до ${before}, после ${after})`)
    joinLine = `кнопка без галочки ${before ? 'неактивна' : 'АКТИВНА — плохо'}, после галочки ${after ? 'НЕ РАБОТАЕТ' : 'активна'}`

    /** Пять кадров человеку: герой, призы, правила, вопросы, низ с галочкой. */
    if (size.width === 390) {
      await page.locator('[data-testid="challenge-agree"]').click() // снять обратно
      // На время съёмки — прокрутка без анимации: плавная не успевает доехать
      // до места, и вместо героя в кадр попадает середина страницы.
      await page.addStyleTag({ content: '.mt-ch__view{scroll-behavior:auto !important}' })
      const shots = [
        ['01-герой.png', 0],
        ['02-призы.png', '.mt-ch__prize'],
        ['03-правила.png', '[data-testid="challenge-rules"]'],
        ['04-вопросы.png', '[data-testid="challenge-faq"]'],
        ['05-низ-галочка.png', '[data-testid="challenge-agree"]'],
      ]
      for (const [name, target] of shots) {
        if (target === 0) {
          await page.evaluate(() => { document.querySelector('.mt-ch__view').scrollTop = 0 })
        } else {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel)
            const view = document.querySelector('.mt-ch__view')
            view.scrollTop += el.getBoundingClientRect().top - 8
          }, target)
        }
        await wait(900)
        await page.screenshot({ path: `${PREVIEW_OUT}/${name}` })
        say(`  снимок: qa-screens/landing/${name}`)
      }
    }

    await context.close()
  }

  await browser.close()
  server.close()

  say('')
  say(joinLine)
  if (problems.length) {
    console.error('НАЙДЕНО:')
    for (const p of problems) console.error('  ' + p)
    process.exit(1)
  }
  say('обе ширины: ни одной обрезанной строки, списки одним потоком')
  process.exit(0)
}

/**
 * «НАСТРОЙКА ПОД СЕБЯ» ПРОПУСКАЕТСЯ, как её пропускает большинство людей (по
 * проду setup.done встречается три раза на девятнадцать заходов). Персонаж
 * приседать по команде не умеет, и без этого шага съёмка стояла бы на нём.
 */
async function skipSetup(page) {
  const setup = page.locator('[data-testid="personal-setup"]')
  await page.waitForSelector('[data-testid="personal-setup"], [data-testid="level-pro"]', { timeout: 240000 })
  if (await setup.count()) {
    await page.locator('[aria-label="Выйти"]').first().click()
    await page.waitForSelector('[data-testid="level-pro"]', { timeout: 60000 })
  }
}

// ── КАЛИБРОВКА: силуэт загорелся ─────────────────────────────────────────────
if (want('calibration')) {
  say('calibration — жду, пока силуэт увидит человека')
  const page = await motionPage({ season: false })
  await framesFlowing(page)
  await skipSetup(page)

  /**
   * Момент короткий: постоял две секунды — и приложение ведёт дальше, ради
   * этого экран и сделан. Возвращаемся на него с выбора уровня столько раз,
   * сколько нужно, и снимаем, как только зоны силуэта стали зелёными.
   */
  let lit = false
  for (let attempt = 0; attempt < 6 && !lit; attempt += 1) {
    const back = page.locator('.mt-screen--levels .mt-corner--left')
    if (await back.count()) await back.first().click().catch(() => {})
    await page.waitForFunction(() => window.__shots.screen === 'calibration', null, { timeout: 30000 }).catch(() => {})
    lit = await page
      .waitForFunction(() => document.querySelectorAll('.mt-sil__part.is-ok').length >= 4, null, { timeout: 20000, polling: 100 })
      .then(() => true)
      .catch(() => false)
  }
  if (!lit) say('  силуэт поймать не удалось — снимаю как есть')
  await shoot(page, 'calibration')
  await page.context().close()
}

// ── БОЙ: мишень в воздухе и счёт ─────────────────────────────────────────────
if (want('fight')) {
  say('fight — жду мишень и счёт (персонаж бьёт сам)')
  // ?round=1 — прежний одиночный зачётный раунд: тот же экран боя, но без
  // двадцати минут сессии впереди. Мишени, счёт и таймер здесь настоящие.
  // поток идёт пятый день: участнику открыт ровно сегодняшний день, и именно
  // его мы и снимаем
  const page = await motionPage({ query: '?round=1&motion-debug=1', seasonStart: daysAgo(4) })
  await framesFlowing(page)
  const panel = page.locator('[data-testid="panel-close"]')
  if (await panel.count()) await panel.first().click().catch(() => {})
  await skipSetup(page)
  await page.locator('[data-testid="level-experienced"]').click()
  await page.waitForSelector('[data-testid="game-score"]', { timeout: 90000 })
  await page
    .waitForFunction(() => {
      const el = document.querySelector('[data-testid="game-score"]')
      const score = el ? Number(String(el.textContent).replace(/\D/g, '')) : 0
      const y = window.__shots?.topTarget
      return score > 0 && typeof y === 'number'
    }, null, { timeout: 90000, polling: 40 })
    .catch(() => say('  счёт и мишень вместе не поймал — снимаю как есть'))
  const p2 = page.locator('[data-testid="panel-close"]')
  if (await p2.count()) await p2.first().click().catch(() => {})
  await shoot(page, 'fight')
  await page.context().close()
}

// ── ДНЕВНИК ПИТАНИЯ: норма и остаток ─────────────────────────────────────────
if (want('diary')) {
  say('diary — дневник питания: норма и остаток за день')
  const page = await newPage()
  await mockBackend(page)
  await page.addInitScript(
    ([key, session]) => {
      try { localStorage.setItem(key, JSON.stringify(session)) } catch { /* приватный режим */ }
    },
    ['fitpro-auth', SESSION],
  )
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="tab-nutrition"]', { timeout: 60000 }).catch(() => {})
  const tab = page.locator('[data-testid="tab-nutrition"]')
  if (await tab.count()) await tab.first().click()
  await page.waitForSelector('[data-testid="meal-breakfast"]', { timeout: 30000 })
  await wait(1200)
  await shoot(page, 'diary')
  await page.context().close()
}

// ── ТАБЛИЦА УЧАСТНИКОВ ───────────────────────────────────────────────────────
if (want('table')) {
  /**
   * НАСТОЯЩИЙ ЭКРАН, А НЕ МАКЕТ. Таблица потока теперь есть в приложении
   * (StandingsScreen), и картинка на странице обязана показывать её, а не
   * нарисованную рядом похожую. Данные подставлены перехватом — как и всюду в
   * этом скрипте, живого потока для снимка мы не заводим.
   */
  say('table — таблица потока, настоящий экран')
  // поток пройден целиком: на картинке итог, а не середина, где средний
  // процент питания заведомо ниже — он делится на все тридцать дней
  const page = await motionPage({ seasonStart: daysAgo(29), props: { startScreen: 'challenge' } })
  await page.waitForSelector('[data-testid="challenge-screen"]', { timeout: 60000 })
  await page.locator('[data-testid="challenge-standings"]').click()
  await page.waitForSelector('[data-testid="standings-list"]', { timeout: 30000 })
  await wait(600)
  await shoot(page, 'table')
  await page.context().close()
}

// ------------------------------------------------------------------ в webp ---

/**
 * ЖМЁМ ХОЛСТОМ ТОГО ЖЕ БРАУЗЕРА. Ни sharp, ни cwebp в проекте нет, а тащить их
 * ради четырёх картинок — новая зависимость сборки в обмен на удобство одного
 * скрипта. Chromium кодирует webp сам; качество подбирается спуском, пока файл
 * не уложится в потолок.
 */
async function toWebp(buf) {
  const page = await newPage({ mobile: false })
  // Странице нужен лишь холст: пустая вкладка сгодится, лишнего не грузим.
  await page.goto('about:blank')
  const dataUrl = await page.evaluate(
    async ([b64, width, maxBytes]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const scale = Math.min(1, width / img.naturalWidth)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      let out = ''
      for (const q of [0.92, 0.86, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32]) {
        out = canvas.toDataURL('image/webp', q)
        const bytes = Math.ceil((out.length - out.indexOf(',') - 1) * 0.75)
        if (bytes <= maxBytes) break
      }
      return out
    },
    [buf.toString('base64'), WIDTH, MAX_BYTES],
  )
  await page.context().close()
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

mkdirSync(OUT, { recursive: true })
const written = []
for (const [id, buf] of [...shots.entries()].sort()) {
  const webp = await toWebp(buf)
  const file = `${OUT}/shot-${id}.webp`
  writeFileSync(file, webp)
  written.push([`shot-${id}.webp`, webp.length])
  say(`  shot-${id}.webp — ${(webp.length / 1024).toFixed(1)} КБ`)
}

// ---------------------------------------------------------------- проверка ---

/**
 * ОДНА ПРОВЕРКА, И ОНА ГЛАВНАЯ: открыть страницу и убедиться, что каждая
 * картинка ДЕЙСТВИТЕЛЬНО загрузилась. У снимков стоит обработчик onError,
 * который прячет битую картинку, — и без этой проверки пропавший файл выглядел
 * бы как «так и задумано».
 */
say('')
say('проверяю: открываю страницу и смотрю, все ли картинки загрузились…')
{
  const page = await newPage()
  await mockBackend(page, { consent: false })
  await page.goto(`${BASE}/harness.html`, { waitUntil: 'domcontentloaded' })
  await warmUp(page)
  await page.evaluate(() => window.__shots.mount({ startScreen: 'challenge' }))
  await page.waitForSelector('[data-testid="challenge-screen"]', { timeout: 60000 })
  // ленивые картинки грузятся, когда доходят до экрана — прокручиваем страницу
  await page.evaluate(async () => {
    const view = document.querySelector('.mt-ch__view')
    for (let y = 0; y < view.scrollHeight; y += view.clientHeight / 2) {
      view.scrollTop = y
      await new Promise((r) => setTimeout(r, 120))
    }
  })
  await wait(1500)
  const state = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="challenge-shot"]')].map((img) => ({
      src: img.getAttribute('src'),
      ok: img.naturalWidth > 0 && img.style.visibility !== 'hidden',
    })),
  )
  await page.context().close()

  const broken = state.filter((s) => !s.ok)
  for (const s of state) say(`  ${s.src} — ${s.ok ? 'загрузилась' : 'НЕ ЗАГРУЗИЛАСЬ'}`)
  if (broken.length) process.exitCode = 1
}

await browser.close()
server.close()

// ------------------------------------------------------------------- итог ---

const all = readdirSync(OUT).filter((f) => f.endsWith('.webp'))
const total = all.reduce((s, f) => s + statSync(`${OUT}/${f}`).size, 0)

say('')
say('снято:')
for (const [name, size] of written) {
  const over = size > MAX_BYTES ? '  ← ТЯЖЕЛЕЕ ПОТОЛКА' : ''
  say(`  ${name.padEnd(24)} ${(size / 1024).toFixed(1).padStart(6)} КБ${over}`)
}
say('')
say(`всего в public/challenge: ${all.length} файлов, ${(total / 1024).toFixed(1)} КБ`)
if (written.some(([, size]) => size > MAX_BYTES)) process.exitCode = 1
