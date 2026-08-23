/**
 * ПРОГОН ВИРТУАЛЬНЫМ ТЕСТИРОВЩИКОМ: полная сессия в настоящем браузере.
 *
 * ЗАЧЕМ. Частота замеров за сессию падает с 20 поз/с до 8, задержка показа
 * растёт втрое, зачёты сыплются — и до сих пор это видели только на телефоне
 * владельца. Утечки исключены, перегрев отвергнут, значит замедляется какая-то
 * одна стадия конвейера. Разбор по стадиям в приложении уже есть
 * (`debug/stageMeter.js`), не было только способа получить его, не занимая
 * человека на семнадцать минут.
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ. Всё, кроме источника пикселей:
 *
 *   браузер   — настоящий, playwright, окно телефона (iPhone 13) и настоящая
 *               видеокарта; про выбор движка и почему по умолчанию не webkit —
 *               длинно расписано у константы ENGINE ниже;
 *   сборка    — боевая конфигурация Vite, та же цель компиляции и тот же
 *               формат воркера (`vite.harness.config.js`);
 *   код       — тот же `<MotionApp />` из `src/motion`, без правок ради прогона;
 *   модель    — настоящий MediaPipe в настоящем воркере, тот же файл модели и
 *               тот же движок wasm, что уезжают людям;
 *   судейство — настоящее, по сырым позам, которые вернула модель.
 *
 * Подменена ровно камера (`camera.js`), и как именно — расписано там же.
 *
 * ПОЧЕМУ ОТДЕЛЬНОЙ КОМАНДОЙ, А НЕ В `pre-push`. Прогон идёт полную сессию —
 * семь кругов, около семнадцати минут по расписанию `game/session.js`. Хук,
 * который держит пуш семнадцать минут, обходят через `--no-verify`, а обход
 * `pre-push` в этом проекте уже стоил чёрного экрана на проде.
 *
 * Запуск: npm run test:motion-session
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { webkit, chromium, devices } from 'playwright'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const ROOT = here('../../')
const DIST = here('../.cache/harness-dist')
const ASSETS = here('../.cache/motion-assets')
const REPORTS = here('../../reports')

/**
 * Порт зашит, и это не лень. `VITE_MOTION_ASSETS_BASE` попадает в сборку
 * подстановкой на этапе сборки, то есть адрес движка и модели вмуровывается в
 * файлы. Выбери мы порт случайно — собранная страница ходила бы за моделью на
 * порт прошлого прогона.
 */
const PORT = 4194
const BASE = `http://localhost:${PORT}`

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const has = (name) => args.includes(name)

/**
 * ДВИЖОК ПО УМОЛЧАНИЮ — CHROMIUM, И ЭТО НЕ ОТКАЗ ОТ WEBKIT.
 *
 * WebKit здесь был бы правдивее: оба браузера на iPhone — это он. Но в сборке
 * WebKit, которую везёт с собой playwright, НЕТ `OffscreenCanvas` — ни в
 * воркере, ни на главном потоке (проверено прямо, `typeof OffscreenCanvas`
 * возвращает `undefined`). MediaPipe по этому признаку решает, что холста в
 * воркере не будет, и уходит на `document.createElement('canvas')` — в воркере
 * документа нет, инициализация падает с «Can't find variable: document», и
 * приложение честно откатывается считать на ГЛАВНЫЙ ПОТОК.
 *
 * А главный поток — это другая архитектура, не та, которую надо мерить.
 * Замеренный так прогон показывает 2 позы в секунду и кадр раз в 330 мс, потому
 * что инференс блокирует и насос кадров, и отрисовку. Искать в таких числах
 * «какая стадия растёт» бессмысленно: растёт очередь на главном потоке.
 *
 * Настоящий Safari `OffscreenCanvas` умеет с версии 16.4, и в поле воркер
 * поднимается — прод это подтверждает (`"thread":"worker"` в снимках). То есть
 * ограничение чисто харнесное, а не продуктовое.
 *
 * `--engine webkit` остаётся: он ловит то, ради чего webkit и держат в проекте
 * (страница открывается, скрипты грузятся), и прогон сам скажет, что считал на
 * главном потоке.
 */
const ENGINE = argOf('--engine', 'chromium')
const TIER = argOf('--tier', 'pro')
const SEED = argOf('--seed', '7')
/**
 * Ключи в адрес страницы — для коротких проверок самого прогона.
 * `--extra "block=jack"` открывает один силовой блок на тридцать секунд, минуя
 * калибровку и выбор уровня: этого хватает, чтобы убедиться, что персонаж
 * виден, а стадии меряются, и не ждать семнадцать минут ради опечатки.
 */
const EXTRA = argOf('--extra', '')
const BLOCK_MODE = /(^|&)block=/.test(EXTRA)
/**
 * ЗРЕНИЕ ПЕРСОНАЖА. Экран боя публикует список летящих мишеней только под
 * `?motion-debug` (см. src/motion/debug/liveTargets.js), и без него персонаж
 * бьёт вслепую: 8% зачётов против 57% в поле, сцена пустая, отрисовка и эффекты
 * попадания не проверены. По умолчанию ключ включён.
 *
 * `--blind` его снимает — этим сравнивают два прогона и видят, сколько стоит
 * сама отрисовка попаданий.
 */
const BLIND = has('--blind')
/** Потолок ожидания. Расписание — около 17 минут, плюс загрузка модели и вход. */
const LIMIT_MS = Number(argOf('--limit-min', 30)) * 60000
const HEADED = has('--headed')

const say = (...a) => console.log(...a)

// ---------------------------------------------------------------- сборка ---

if (!has('--no-build')) {
  say('собираю страницу прогона боевой конфигурацией…')
  const build = spawnSync(
    'npx',
    ['vite', 'build', '--config', here('./vite.harness.config.js')],
    {
      cwd: ROOT,
      stdio: 'inherit',
      // без shell на Windows не находится npx: он там .cmd, а не исполняемый файл
      shell: true,
      env: {
        ...process.env,
        /**
         * ДВИЖОК И МОДЕЛЬ — С МЕСТНОГО СЕРВЕРА, а не с боевого бакета.
         *
         * Не ради скорости: 8.4 МБ на каждый прогон — это трафик боевого
         * сервера, который раздаёт их живым людям, и зависимость прогона от
         * того, жив ли сейчас бакет. Файлы те же самые: wasm берётся из
         * `node_modules/@mediapipe/tasks-vision` (версия запинена в
         * package.json и обязана совпадать), модель — тот же
         * `pose_landmarker_lite.task`, что лежит в бакете.
         */
        VITE_MOTION_ASSETS_BASE: `${BASE}/motion-assets`,
      },
    },
  )
  if (build.status !== 0) {
    console.error('сборка страницы прогона не прошла')
    process.exit(1)
  }
}

if (!existsSync(`${DIST}/harness.html`)) {
  console.error(`нет собранной страницы: ${DIST}/harness.html`)
  process.exit(1)
}

/** Профиль прода едет рядом со страницей: персонаж читает его по сети. */
const PROFILE_SRC = here('./prod-profile.json')
if (existsSync(PROFILE_SRC)) copyFileSync(PROFILE_SRC, `${DIST}/prod-profile.json`)
else say('! профиля прода нет — темп персонажа пойдёт по умолчаниям, а не по motion_log')

const MODEL = `${ASSETS}/models/pose_landmarker_lite.task`
if (!existsSync(MODEL)) {
  console.error(
    `нет файла модели: ${MODEL}\n` +
      'скачать один раз:\n' +
      '  curl -L -o tools/.cache/motion-assets/models/pose_landmarker_lite.task \\\n' +
      '    https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  )
  process.exit(1)
}

// ---------------------------------------------------------------- сервер ---

const TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
}
const WASM_DIR = `${ROOT}node_modules/@mediapipe/tasks-vision/wasm`

function resolve(url) {
  if (url === '/' || url === '/harness.html') return `${DIST}/harness.html`
  // тот же путь, по которому файлы лежат в боевом бакете, — чтобы `assets.js`
  // собирал адрес ровно так же, как в проде
  const wasm = url.match(/^\/motion-assets\/tasks-vision\/[^/]+\/wasm\/(.+)$/)
  if (wasm) return `${WASM_DIR}/${wasm[1]}`
  const model = url.match(/^\/motion-assets\/models\/(.+)$/)
  if (model) return `${ASSETS}/models/${model[1]}`
  return `${DIST}${url}`
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  const file = resolve(url)
  if (!existsSync(file) || !file.includes('.')) {
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
say(`страница прогона поднята: ${BASE}/harness.html`)

// ---------------------------------------------------------------- браузер ---

const engines = { webkit, chromium }
if (!engines[ENGINE]) {
  console.error(`неизвестный движок: ${ENGINE} (webkit | chromium)`)
  process.exit(1)
}

/**
 * НАСТОЯЩАЯ ВИДЕОКАРТА В ЗАКРЫТОМ ОКНЕ.
 *
 * Chromium без этих ключей поднимает SwiftShader — отрисовку на процессоре, — и
 * инференс на нём занимает 590 мс против 33 мс на живой карте. Прогон при этом
 * не «медленнее», он ДРУГОЙ: телефон считает на своей GPU, и стадия
 * `inference` там не главная. С флагами то же закрытое окно берёт настоящий
 * D3D11 (проверено: ANGLE / Intel UHD 630), и воркер видит его через
 * OffscreenCanvas.
 */
const CHROMIUM_GPU = [
  '--use-angle=d3d11',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
]

const browser = await engines[ENGINE].launch({
  headless: !HEADED,
  args: ENGINE === 'chromium' ? CHROMIUM_GPU : [],
})
/**
 * iPhone 13 — не украшение. Жалоба на замедление пришла с телефона, а размер
 * экрана и плотность точек прямо задают, сколько пикселей рисуется каждый кадр:
 * на десктопном окне стадия `draw` мерила бы другую работу.
 */
const context = await browser.newContext({
  ...devices['iPhone 13'],
  locale: 'ru-RU',
  permissions: [],
})
const page = await context.newPage()

const pageErrors = []
page.on('pageerror', (e) => {
  pageErrors.push(String(e.message))
  say('  [ошибка страницы]', String(e.message).slice(0, 200))
})
page.on('console', (m) => {
  const t = m.text()
  if (/\[motion\]|\[vt\]|MODEL_|воркер|калибровка/.test(t)) say('  [консоль]', t.slice(0, 200))
})

const runStartedAt = Date.now()
const url =
  `${BASE}/harness.html?vt-seed=${SEED}` +
  `${BLIND ? '' : '&motion-debug=1'}${EXTRA ? `&${EXTRA}` : ''}`
await page.goto(url, { waitUntil: 'domcontentloaded' })

const boom = await page.evaluate(() => window.__vtBootError || null)
if (boom) {
  console.error('страница прогона не поднялась:\n', boom)
  await browser.close()
  server.close()
  process.exit(1)
}

/**
 * ПАНЕЛЬ ДИАГНОСТИКИ — ЗАКРЫТЬ.
 *
 * `?motion-debug` включает не только публикацию мишеней, но и саму панель: она
 * ложится поверх экрана, перехватывает нажатия (выбор уровня становится
 * недоступен) и, что важнее, каждый кадр рисует собственную разметку. Мерили бы
 * мы тогда не бой, а бой с открытой панелью поверх.
 *
 * Закрывается нажатием той же кнопки, которой её закрывает человек, — своего
 * пути для прогона не заводим.
 */
async function closePanel(where) {
  const x = page.locator('[data-testid="panel-close"]')
  if (!(await x.count())) return false
  await x.first().click({ timeout: 5000 }).catch(() => {})
  say(`  панель диагностики закрыта (${where})`)
  return true
}

say('жду, пока поднимется распознавание (первый прогон компилирует шейдеры)…')
await page.waitForFunction(() => window.__vt && window.__vt.cameraFrames > 30, null, {
  timeout: 120000,
})

/**
 * ВХОД В СЕССИЮ. Человек здесь делает ровно два действия: стоит в кадре
 * (это делает персонаж сам) и выбирает уровень — единственное нажатие за всю
 * тренировку. Экран «Настройка под себя» пропускается так же, как его
 * пропускает большинство: по проду `setup.done` встречается три раза на
 * девятнадцать заходов.
 */
if (!BLIND) await closePanel('после загрузки')

if (BLOCK_MODE) {
  say('короткая проверка: один силовой блок, выбор уровня не показывается')
} else {
  const levelButton = `[data-testid="level-${TIER}"]`
  say('жду выбор уровня…')
  await page
    .waitForSelector(`${levelButton}, [data-testid="personal-setup"]`, { timeout: 180000 })
    .catch(() => {})

  if (await page.locator('[data-testid="personal-setup"]').count()) {
    say('  пропускаю «Настройку под себя»')
    await page.locator('[aria-label="Выйти"]').first().click()
    await page.waitForSelector(levelButton, { timeout: 60000 })
  }

  await page.locator(levelButton).click()
  say(`уровень «${TIER}» выбран — сессия пошла`)
}

// ------------------------------------------------------------- наблюдение ---

const tickEvery = 30000
let lastLine = ''
const deadline = Date.now() + LIMIT_MS

while (Date.now() < deadline) {
  const state = await page.evaluate(() => {
    const events = window.__vt.collect()
    let cleared = 0
    let missed = 0
    for (const e of events) {
      if (e.tag !== 'game.end') continue
      cleared += Number(e.data?.cleared) || 0
      missed += Number(e.data?.missed) || 0
    }
    return {
      screen: window.__vt.screen,
      frames: window.__vt.cameraFrames,
      elapsed: window.__vt.elapsedMs,
      rate: window.__vt.rate(),
      eyes: window.__vt.eyes,
      hits: cleared + missed ? Math.round((cleared / (cleared + missed)) * 100) : null,
    }
  })

  const line =
    `  ${String(Math.round(state.elapsed / 1000)).padStart(4)}с  ${String(state.screen).padEnd(26)}` +
    ` кадров ${String(state.frames).padStart(6)}` +
    `  поз/с ${String(state.rate.poseFps ?? '—').padStart(3)}` +
    `  задержка ${String(state.rate.latencyMs ?? '—').padStart(4)}мс` +
    `  зачёт ${String(state.hits == null ? '—' : `${state.hits}%`).padStart(4)}`
  if (line !== lastLine) {
    say(line)
    lastLine = line
  }

  // панель могла всплыть заново при пересборке поддерева — гасим молча
  if (!BLIND) await closePanel('в ходе сессии')

  // сессия дошла до конца: экран результата или возврат на выбор уровня
  const done = await page.evaluate(() => {
    const log = window.__vt.log()
    return log.includes('[session.end]')
  })
  if (done) {
    say('сессия завершена приложением')
    break
  }

  await page.waitForTimeout(tickEvery)
}

const collected = await page.evaluate(() => window.__vt.collect())
const fromProd = await page.evaluate(() => window.__vt.profileFromProd)
const finalLog = await page.evaluate(() => window.__vt.log())

await browser.close()
server.close()

// ---------------------------------------------------------------- разбор ---

const { buildTable, verdictOf, renderTable, renderVerdict } = await import('./report.mjs')

const table = buildTable(collected)
const verdict = verdictOf(table, collected)

say('')
say(renderTable(table))
say('')
say(renderVerdict(verdict, { fromProd, engine: ENGINE, pageErrors, collected }))

mkdirSync(REPORTS, { recursive: true })
const stamp = new Date(runStartedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = `${REPORTS}/motion-session-${stamp}.json`
writeFileSync(
  out,
  JSON.stringify(
    {
      startedAt: new Date(runStartedAt).toISOString(),
      engine: ENGINE,
      tier: TIER,
      seed: SEED,
      eyes: !BLIND,
      profileFromProd: fromProd,
      pageErrors,
      table,
      verdict,
      events: collected,
      log: finalLog.split('\n'),
    },
    null,
    2,
  ),
)
say(`\nполный отчёт: ${out}`)

process.exit(verdict.kind === 'error' ? 1 : 0)
