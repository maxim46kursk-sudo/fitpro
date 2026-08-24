/**
 * СЪЁМКА КАРТИНОК ДЛЯ ПРАВИЛ ЧЕЛЛЕНДЖА — public/rules/rules-01…11.webp.
 *
 * ЗАЧЕМ АВТОМАТОМ, А НЕ РУКАМИ. Правила показывают человеку то, что он увидит в
 * приложении, и картинка, снятая руками, устаревает молча: интерфейс правят, а
 * снимок в правилах остаётся прошлогодним — и человек, заплативший за поток,
 * читает описание не того продукта. Пересъёмка обязана быть одной строкой:
 *
 *     npm run shots:rules              # все одиннадцать
 *     npm run shots:rules -- --only 05,06
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ. Восемь снимков из одиннадцати — живые экраны приложения:
 * тот же код, та же сборка, тот же MediaPipe. Подменена ровно камера — записью
 * живых движений (tools/motion-persona/camera.js), как в прогоне персонажа. Три
 * оставшихся (08, 10, 11) экранами ещё не стали: их макеты лежат в
 * scripts/rules-shots/mockups и собраны в палитре приложения — когда эти экраны
 * будут делать, макет и станет их основой.
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
const HARNESS_DIST = here('../tools/.cache/rules-harness')
const ASSETS = here('../tools/.cache/motion-assets')
const MOCKUPS = here('./rules-shots/mockups')
const OUT = here('../public/rules')

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

/** Ширина картинки в правилах и потолок веса одного файла. */
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
    'vite', 'build', '--config', 'scripts/rules-shots/vite.shots.config.js',
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
  if (url.startsWith('/mock/')) return `${MOCKUPS}/${url.slice('/mock/'.length)}`
  // Картинки правил — прямо из public, а не из собранного dist: проверка в
  // конце обязана смотреть на только что снятые файлы, а не на те, что попали
  // в сборку до съёмки.
  if (url.startsWith('/rules/')) return `${OUT}/${url.slice('/rules/'.length)}`
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
const SEASON = {
  id: 1, title: 'Поток 1', starts_on: null, price_rub: 2990,
  prize_pct: 50, prize_split: [50, 30, 20], status: 'open',
  challenge_entries: [{ id: 1, participant_no: 12, display_name: 'Ирина Ковалёва', paid_at: '2026-08-20T10:00:00Z', rules_accepted_at: '2026-08-20T09:00:00Z' }],
  challenge_rules_consent: [{ accepted_at: '2026-08-20T09:00:00Z' }],
}

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

async function mockBackend(page, { season = true, consent = true } = {}) {
  await page.route('**/auth/v1/**', (route) => {
    const url = route.request().url()
    const body = /\/user/.test(url) ? SESSION.user : SESSION
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  await page.route('**/rest/v1/**', (route) => {
    const req = route.request()
    const table = (new URL(req.url()).pathname.split('/rest/v1/')[1] || '').split('?')[0]
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
const PREVIEW_OUT = here('../qa-screens/rules-preview')

// -------------------------------------------------------------------- съёмка ---

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
})

/** Телефон, но с плотностью 2 — снимок выходит шире 720 и ужимается без потери. */
const PHONE = { width: 390, height: 780 }
/**
 * ТЕЛЕФОН ПОШИРЕ — для экранов, где важное не помещается в полосу нужной
 * пропорции: три карточки уровней и календарь тридцати дней высокие, и на
 * узком аппарате их пришлось бы резать. Это тот же настоящий экран, просто
 * снятый на аппарате побольше (430 — ширина нынешних «максов»).
 */
const PHONE_WIDE = { width: 430, height: 920 }

async function newPage({ mobile = true, wide = false, screen = null } = {}) {
  const context = await browser.newContext({
    viewport: screen ?? (mobile ? (wide ? PHONE_WIDE : PHONE) : { width: 720, height: 624 }),
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
async function motionPage({ seed = null, props = {}, query = '', season = true, wide = false, screen = null } = {}) {
  const page = await newPage({ wide, screen })
  await mockBackend(page, { season })
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
 * Пропорция — та же, что у блока картинки в правилах: он занимает 40% высоты
 * экрана во всю ширину, то есть примерно 390 × 338 на обычном телефоне. Снимок
 * в этой пропорции ложится в блок без полей и без обрезки.
 */
const SHOT_RATIO = 390 / 338
const PHONE_W = 390

/** Полоса нужной пропорции с центром на y (в CSS-пикселях экрана). */
function band(centerY, { width = PHONE_W, ratio = SHOT_RATIO, screen = null } = {}) {
  const height = Math.round(width / ratio)
  const top = Math.max(0, Math.round(centerY - height / 2))
  const from = screen ?? Math.max(PHONE_W, width)
  return { x: Math.round((from - width) / 2), y: top, width, height }
}

/**
 * ПОЛОСА ПО САМОМУ ПРЕДМЕТУ СНИМКА, а не по угаданной координате. Скрипт
 * спрашивает у страницы, где лежит то, ради чего снимок делается — силуэт,
 * карточки уровней, календарь, — и кадрирует по центру этого места. Правка
 * вёрстки сдвигает элемент, а кадр остаётся на нём.
 */
async function bandOf(page, selector, opts = {}) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, height: r.height, screenW: innerWidth, screenH: innerHeight }
  }, selector)
  if (!box) {
    say(`  не нашёл ${selector} — кадрирую по умолчанию`)
    return band(opts.fallback ?? 350, opts)
  }
  const width = opts.width ?? box.screenW
  const height = Math.round(width / (opts.ratio ?? SHOT_RATIO))
  let top = Math.round(box.top + box.height / 2 - height / 2)
  top = Math.max(0, Math.min(top, Math.round(box.screenH - height)))
  return { x: Math.round((box.screenW - width) / 2), y: top, width, height }
}

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

if (has('--preview')) {
  /**
   * ПРЕДПРОСМОТР И ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА ОБРЫВА.
   *
   * Текст, срезанный ровно по нижнему краю, читается как «здесь всё» — ровно на
   * этом владелец и не нашёл галочку согласия на двенадцатом экране. Поэтому
   * скрипт проходит все двенадцать экранов НА ДВУХ РАЗМЕРАХ (обычный телефон и
   * маленький) и падает, если хоть на одном содержимое не поместилось, а
   * признака продолжения нет.
   *
   * Заодно ищет сырую разметку и складывает снимки всех экранов человеку.
   */
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
    await page.waitForSelector('[data-testid="rules-screen"]', { timeout: 60000 })

    const total = await page.evaluate(() => document.querySelectorAll('[data-testid^="rules-dot-"]').length)
    say('')
    say(`${size.name}: ${total} экранов`)

    for (let i = 1; i <= total; i += 1) {
      await page.locator(`[data-testid="rules-dot-${i}"]`).click()
      await wait(420)

      const seen = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="rules-screen"]')
        const scroll = root.querySelector('.mt-rules__scroll')
        const hidden = Math.round(scroll.scrollHeight - scroll.clientHeight)
        return {
          title: root.querySelector('[data-testid="rules-title"]')?.textContent || '',
          text: root.innerText,
          hidden,
          compact: root.dataset.compact === '1',
          fade: !!root.querySelector('[data-testid="rules-more"]'),
          heroPct: Math.round((root.querySelector('.mt-rules__hero')?.getBoundingClientRect().height || 0) / innerHeight * 100),
        }
      })

      // 1. обрыв без признака продолжения
      if (seen.hidden > 2 && !seen.fade) {
        problems.push(`${size.name}, экран ${i} («${seen.title}»): текст обрезан на ${seen.hidden}px, а градиента нет`)
      }
      // 2. сырая разметка
      const marks = []
      if (seen.text.includes('**')) marks.push('**')
      if (seen.text.includes('#')) marks.push('#')
      if (/(?:^|\s)[-*]\s/.test(seen.text)) marks.push('дефис списка')
      if (marks.length) problems.push(`${size.name}, экран ${i}: сырая разметка (${marks.join(', ')})`)

      const state = seen.hidden > 2
        ? `не влез на ${String(seen.hidden).padStart(3)}px → картинка ${seen.heroPct}% + градиент ${seen.fade ? 'есть' : 'НЕТ'}`
        : `помещается целиком, картинка ${seen.heroPct}%`
      say(`  ${String(i).padStart(2)}. ${seen.title.padEnd(32)} ${state}`)

      // Снимки складываем с обычного телефона — на нём смотрят.
      if (size.width === 390) {
        const name = `${String(i).padStart(2, '0')}-${seen.title.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 34)}.png`
        await page.screenshot({ path: `${PREVIEW_OUT}/${name}` })
      }
    }

    // Последний экран с поставленной галочкой — как его увидит человек в момент
    // решения. Снимаем только на обычном телефоне.
    await page.locator(`[data-testid="rules-dot-${total}"]`).click()
    await page.waitForSelector('[data-testid="rules-gate"]', { timeout: 10000 })
    await page.locator('[data-testid="rules-agree"]').click()
    await wait(300)
    const joinText = await page.locator('[data-testid="rules-join"]').textContent()
    const joinOff = await page.locator('[data-testid="rules-join"]').isDisabled()
    if (joinOff) problems.push(`${size.name}: кнопка вступления не включилась после галочки`)
    if (size.width === 390) {
      await page.screenshot({ path: `${PREVIEW_OUT}/12-согласие-и-кнопка.png` })
      joinLine = `кнопка вступления: «${joinText}», после галочки ${joinOff ? 'НЕ РАБОТАЕТ' : 'активна'}`
    }
    await context.close()
  }

  await browser.close()
  server.close()

  say('')
  say(joinLine)
  say(`снимки: qa-screens/rules-preview (${readdirSync(PREVIEW_OUT).length} файлов)`)
  if (problems.length) {
    console.error('')
    console.error('НАЙДЕНО:')
    for (const p of problems) console.error('  ' + p)
    process.exit(1)
  }
  say('все экраны на обоих размерах: без немого обрыва и без сырой разметки')
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

/**
 * ПОЙМАТЬ КАЛИБРОВКУ В МОМЕНТ, КОГДА СИЛУЭТ УЖЕ ЗАГОРЕЛСЯ.
 *
 * Момент короткий: постоял две секунды — и приложение само ведёт дальше, ради
 * этого экран и сделан. Поэтому возвращаемся на него с выбора уровня столько
 * раз, сколько нужно, и снимаем, как только зоны силуэта стали зелёными.
 */
async function catchCalibration(page, shotList) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const back = page.locator('.mt-screen--levels .mt-corner--left')
    if (await back.count()) await back.first().click().catch(() => {})
    await page.waitForFunction(() => window.__shots.screen === 'calibration', null, { timeout: 30000 }).catch(() => {})
    const lit = await page
      .waitForFunction(
        () => document.querySelectorAll('.mt-sil__part.is-ok').length >= 4,
        null,
        { timeout: 20000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false)
    if (!lit) continue
    await shootSilhouette(page, shotList)
    return true
  }
  say('  силуэт поймать не удалось — снимаю как есть')
  await shootSilhouette(page, shotList)
  return false
}

/**
 * Кадр считается ЗДЕСЬ, а не заранее: силуэт живёт только на экране калибровки,
 * и спросить его коробку можно лишь когда экран открыт.
 */
async function shootSilhouette(page, ids) {
  for (const id of ids) {
    // 04 — от самого верха: подсказка и голова; 01 — крупный план фигуры
    const clip = id === '01'
      ? band(300, { width: 320 })
      : { x: 0, y: 0, width: PHONE_W, height: Math.round(PHONE_W / SHOT_RATIO) }
    await shoot(page, id, { clip })
  }
}

// ── 01, 04, 05: калибровка и выбор уровня — одной страницей -------------------
if (want('01') || want('04') || want('05')) {
  say('01/04/05 — калибровка и выбор уровня (грузится движок и модель, это долго)')
  const page = await motionPage({ season: false, wide: true })
  await framesFlowing(page)
  await skipSetup(page)
  await wait(1200)
  // Три карточки уровней — по ним и кадр; скелет камеры из-под них убираем.
  if (want('05')) await shoot(page, '05', { hideCamera: true, clip: await bandOf(page, '.mt-levels') })

  await page.context().close()
}

// ── 01 и 04: калибровка — в широком окне ------------------------------------
if (want('01') || want('04')) {
  /**
   * КАДР ОТ ВЕРХА ЭКРАНА. Человек в кадре стоит во весь рост — фигура
   * вертикальная, и в полосе нужной пропорции она целиком не помещается никак:
   * шире экрана телефона не снять, а в горизонт приложение осознанно не идёт
   * («в горизонте не видно тебя целиком»). Из двух половин выбираем верхнюю:
   * зелёная подсказка «Отлично, стой так» и загоревшийся силуэт — то, по чему
   * этот экран узнают, а нижняя половина это те же ноги на чёрном фоне.
   */
  say('01/04 — калибровка')
  const page = await motionPage({ season: false })
  await framesFlowing(page)
  await skipSetup(page)
  const calibShots = []
  if (want('04')) calibShots.push('04')
  if (want('01')) calibShots.push('01')
  await catchCalibration(page, calibShots)
  await page.context().close()
}

// ── 06 и 09: участник потока — попытки и календарь ---------------------------
if (want('06') || want('09')) {
  say('06/09 — участник: счётчик попыток и комната')
  const days = []
  for (let d = 1; d <= 11; d += 1) {
    days.push({
      day: d,
      runs: d === 6 ? 2 : 1,
      attempts: [
        { tier: 'novice', stats: { score: 3600 + d * 120, hits: 30 + d, spawned: 52, reactMs: 760 - d * 8, reps: 90 } },
        { tier: 'experienced', stats: { score: 4800 + d * 150, hits: 32 + d, spawned: 56, reactMs: 720 - d * 8, reps: 95 } },
      ],
    })
  }
  const page = await motionPage({
    wide: true,
    seed: {
      days,
      // две потраченные попытки сегодняшнего дня: на экране это «попытка 3 из 3»
      // у одного уровня и «попытка 2 из 3» у другого — то, о чём правила и
      // говорят на своём шестом экране
      attemptsToday: [
        { tier: 'novice', day: 12, stats: { score: 4200, hits: 38, spawned: 52, reactMs: 690, reps: 96 } },
        { tier: 'novice', day: 12, stats: { score: 4650, hits: 41, spawned: 54, reactMs: 665, reps: 98 } },
        { tier: 'experienced', day: 12, stats: { score: 5850, hits: 34, spawned: 56, reactMs: 640, reps: 98 } },
      ],
    },
  })
  await framesFlowing(page)
  await skipSetup(page)
  await wait(1200)
  if (want('06')) await shoot(page, '06', { hideCamera: true, clip: await bandOf(page, '.mt-levels') })

  if (want('09')) {
    await page.locator('[data-testid="open-room"]').click()
    await page.waitForSelector('[data-testid="room-days"]', { timeout: 30000 })
    await wait(900)
    // Календарь тридцати дней — то, ради чего этот снимок; берём полосу по нему
    await shoot(page, '09', { hideCamera: true, clip: await bandOf(page, '[data-testid="room-days"]') })
  }
  await page.context().close()
}

// ── 03: бой — летящая мишень и счёт ------------------------------------------
if (want('03')) {
  say('03 — бой: жду мишени и счёт (персонаж бьёт сам)')
  // ?round=1 — прежний одиночный зачётный раунд: тот же экран боя, но без
  // двадцати минут сессии впереди. Мишени, счёт и таймер здесь настоящие.
  const page = await motionPage({ query: '?round=1&motion-debug=1' })
  await framesFlowing(page)
  const panel = page.locator('[data-testid="panel-close"]')
  if (await panel.count()) await panel.first().click().catch(() => {})
  await skipSetup(page)
  await page.locator('[data-testid="level-experienced"]').click()
  await page.waitForSelector('[data-testid="game-score"]', { timeout: 90000 })
  // ждём, пока персонаж наберёт счёт: пустой ноль на картинке правил
  // рассказывал бы не про бой, а про его начало
  await page
    .waitForFunction(() => {
      const el = document.querySelector('[data-testid="game-score"]')
      return el && Number(String(el.textContent).replace(/\D/g, '')) > 0
    }, null, { timeout: 90000 })
    .catch(() => say('  счёт не набрался — снимаю как есть'))
  const p2 = page.locator('[data-testid="panel-close"]')
  if (await p2.count()) await p2.first().click().catch(() => {})
  // и ловим кадр, в котором мишень В ВОЗДУХЕ: правила показывают бой, а не
  // паузу между мишенями
  // Ждём кадр, где мишень висит ВЫСОКО: счёт живёт в шапке, и только такая
  // мишень попадает с ним в одну полосу. Не дождались — снимаем как есть.
  await page
    .waitForFunction(() => {
      const y = window.__shots?.topTarget
      return typeof y === 'number' && y < 0.42
    }, null, { timeout: 60000, polling: 40 })
    .catch(() => say('  высокой мишени не дождался — снимаю как есть'))
  await shoot(page, '03', { clip: { x: 0, y: 0, width: PHONE_W, height: Math.round(PHONE_W / SHOT_RATIO) } })
  await page.context().close()
}

// ── 02 и 07: экраны FitPro (профиль/норма и дневник питания) -----------------
if (want('02') || want('07')) {
  say('02/07 — питание: норма и дневник дня')
  const page = await newPage()
  await mockBackend(page)
  await page.addInitScript(
    ([key, session]) => {
      try { localStorage.setItem(key, JSON.stringify(session)) } catch { /* приватный режим */ }
    },
    ['fitpro-auth', SESSION],
  )
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="tab-nutrition"], [data-testid="nutrition-tab-diary"]', { timeout: 60000 }).catch(() => {})
  const tab = page.locator('[data-testid="tab-nutrition"]')
  if (await tab.count()) await tab.first().click()
  await page.waitForSelector('[data-testid="meal-breakfast"]', { timeout: 30000 })
  await wait(1200)
  // Норма и остаток за день — верхняя карточка дневника
  if (want('07')) await shoot(page, '07', { clip: band(275) })

  if (want('02')) {
    // «Мои данные» — тот самый экран, который правила просят заполнить до
    // старта: пол, возраст, рост, вес, цель. По ним и считается дневная норма
    // (calcMacroGoals), поэтому картинка второго экрана — именно он.
    // Шторка профиля открывается аватаром в шапке — у него нет своего testid,
    // поэтому берём его как первую кнопку страницы (она же первая в шапке).
    await page.locator('button').first().click()
    await page.getByText('Мои данные').first().click()
    await page.waitForSelector('[data-testid="profile-save"]', { timeout: 30000 })
    // Пролистываем к числам, из которых считается норма: рост, вес, цель,
    // активность. Шапка «Мои данные» при этом остаётся в кадре — по ней экран
    // и узнают.
    await page.mouse.wheel(0, 620)
    await wait(1200)
    await shoot(page, '02', { clip: band(350) })
  }
  await page.context().close()
}

// ── 08, 10, 11: макеты будущих экранов ---------------------------------------
const MOCK_SHOTS = [
  ['08', '08-nutrition-day.html'],
  ['10', '10-leaderboard.html'],
  ['11', '11-prize-split.html'],
]
for (const [id, file] of MOCK_SHOTS) {
  if (!want(id)) continue
  say(`${id} — макет ${file}`)
  const page = await newPage({ mobile: false })
  await page.goto(`${BASE}/mock/${file}`, { waitUntil: 'load' })
  await wait(300)
  // Макеты нарисованы сразу в пропорции блока — кадрировать нечего
  await shoot(page, id)
  await page.context().close()
}

// ------------------------------------------------------------------ в webp ---

/**
 * ЖМЁМ ХОЛСТОМ ТОГО ЖЕ БРАУЗЕРА. Ни sharp, ни cwebp в проекте нет, а тащить их
 * ради одиннадцати картинок — это новая зависимость сборки в обмен на удобство
 * одного скрипта. Chromium кодирует webp сам; качество подбирается спуском,
 * пока файл не уложится в потолок.
 */
async function toWebp(buf) {
  const page = await newPage({ mobile: false })
  await page.goto(`${BASE}/mock/08-nutrition-day.html`, { waitUntil: 'domcontentloaded' })
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
  const file = `${OUT}/rules-${id}.webp`
  writeFileSync(file, webp)
  written.push([`rules-${id}.webp`, webp.length])
  say(`  rules-${id}.webp — ${(webp.length / 1024).toFixed(1)} КБ`)
}

// ---------------------------------------------------------------- проверка ---

/**
 * ОДНА ПРОВЕРКА, И ОНА ГЛАВНАЯ: открыть правила и убедиться, что каждая
 * картинка ДЕЙСТВИТЕЛЬНО загрузилась. У экрана правил стоит обработчик onError,
 * который прячет битую картинку, — и без этой проверки пропавший файл выглядел
 * бы как «так и задумано»: текст на месте, картинки просто нет.
 */
say('')
say('проверяю: открываю правила и смотрю, все ли картинки загрузились…')
{
  const page = await newPage()
  await mockBackend(page, { consent: false })
  await page.goto(`${BASE}/harness.html`, { waitUntil: 'domcontentloaded' })
  await warmUp(page)
  await page.evaluate(() => window.__shots.mount({ startScreen: 'challenge' }))
  await page.waitForSelector('[data-testid="rules-screen"]', { timeout: 60000 })

  const total = await page.evaluate(() => document.querySelectorAll('[data-testid^="rules-dot-"]').length)
  const bad = []
  for (let i = 1; i <= total; i += 1) {
    await page.locator(`[data-testid="rules-dot-${i}"]`).click()
    const state = await page.evaluate(async () => {
      const img = document.querySelector('[data-testid="rules-image"]')
      if (!img) return { none: true }
      // ленивая картинка грузится, когда доходит до экрана: дожидаемся
      if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r })
      return { src: img.getAttribute('src'), ok: img.naturalWidth > 0, hidden: img.style.display === 'none' }
    })
    if (state.none) {
      say(`  экран ${i}: без картинки`)
      continue
    }
    if (!state.ok || state.hidden) bad.push(`${i} (${state.src})`)
    else say(`  экран ${i}: ${state.src} — загрузилась`)
  }
  await page.context().close()

  if (bad.length) {
    console.error(`НЕ ЗАГРУЗИЛИСЬ: ${bad.join(', ')}`)
    process.exitCode = 1
  } else {
    say('  все картинки на месте, onError не сработал ни разу')
  }
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
  say(`  ${name.padEnd(16)} ${(size / 1024).toFixed(1).padStart(6)} КБ${over}`)
}
say('')
say(`всего в public/rules: ${all.length} файлов, ${(total / 1024).toFixed(1)} КБ`)
if (written.some(([, size]) => size > MAX_BYTES)) process.exitCode = 1
// Потолок папки: правила открывают с телефона, и мегабайт картинок до первого
// слова человек ждать не станет.
if (total > 800 * 1024) {
  console.error('папка public/rules тяжелее 800 КБ')
  process.exitCode = 1
}
