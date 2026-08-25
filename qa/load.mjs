#!/usr/bin/env node
/**
 * НАГРУЗОЧНЫЙ ЗАМЕР ПО ПРОДУ — пятьдесят человек одновременно.
 *
 * ЗАЧЕМ. Приложение переехало с Vercel на один VPS: восемь ядер, двенадцать
 * гигабайт, ОДИН процесс Node на всю статику и все двенадцать функций, рядом в
 * контейнерах вся Supabase. Пока людей десятки в сутки, это незаметно; вопрос в
 * том, что случится, когда по ссылке из Инстаграма придут полсотни разом. На
 * него нельзя ответить «всё хорошо» — только числами.
 *
 * ГДЕ ИДЁТ ПРОГОН. По боевому серверу: стенда нет, а замер на пустой копии
 * отвечал бы на другой вопрос. Отсюда три правила, которые здесь соблюдаются
 * буквально:
 *
 *   1. КОРОТКИМИ ЗАЛПАМИ. Каждый сценарий — секунды, а не минуты. Живой человек
 *      в худшем случае увидит одну медленную загрузку, а не «сайт лежал».
 *   2. ПРЕРЫВАЕМО. Ctrl+C останавливает всё немедленно: залпы идут через
 *      AbortController, и незавершённые запросы снимаются, а не дожидаются.
 *   3. БЕЗ МУСОРА В БАЗЕ. Пишущий сценарий работает под тестовыми аккаунтами
 *      (qa-e2e-, см. qa/admin.mjs) и убирает за собой сам. Ни одной строки от
 *      живого человека он не трогает.
 *
 * ЧТО МЕРЯЕТСЯ И ЧТО НЕТ. Меряется СЕРВЕР: сколько он держит и где упирается.
 * Время «до первого экрана» у человека этим не меряется вовсе — там ещё разбор
 * бандла и старт React на его телефоне; для этого рядом ходит настоящий браузер
 * (сценарий «а», ключ --browsers).
 *
 *   node qa/load.mjs --scenario=a --n=50     холодное открытие
 *   node qa/load.mjs --scenario=b --n=50     челлендж и таблица потока
 *   node qa/load.mjs --scenario=c --n=50     скачивание модели Motion
 *   node qa/load.mjs --scenario=d --n=50     всплеск записей
 *   node qa/load.mjs --scenario=e            наши собственные ограничители
 *   node qa/load.mjs --scenario=base         одиночные запросы, точка отсчёта
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const APP = process.env.LOAD_APP || 'https://fitproapp.ru'
const SUPA = process.env.LOAD_SUPA || 'https://api.fitproapp.ru'

const arg = (name, def) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : def
}
const SCENARIO = arg('scenario', 'base')
const N = Number(arg('n', 50))
const BROWSERS = Number(arg('browsers', 0))

function loadEnv() {
  const out = {}
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return out
}
const env = loadEnv()
const ANON = env.VITE_SUPABASE_KEY
const SRK = env.SUPABASE_SERVICE_ROLE_KEY

// ── Прерывание ─────────────────────────────────────────────────────────────
const abort = new AbortController()
let остановлено = false
process.on('SIGINT', () => {
  остановлено = true
  abort.abort()
  console.log('\n⛔ прервано, снимаю незавершённые запросы')
})

// ── Статистика ─────────────────────────────────────────────────────────────
const кв = (values, p) => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.floor((s.length - 1) * p))
  return Math.round(s[i])
}

function свод(имя, записи, доп = {}) {
  const ok = записи.filter((r) => r.ok)
  const ms = ok.map((r) => r.ms)
  const коды = {}
  for (const r of записи) {
    const k = r.ok ? 'ok' : String(r.status ?? r.error ?? 'err')
    коды[k] = (коды[k] ?? 0) + 1
  }
  return {
    сценарий: имя,
    запросов: записи.length,
    успешных: ok.length,
    медиана: кв(ms, 0.5),
    p90: кв(ms, 0.9),
    p99: кв(ms, 0.99),
    макс: кв(ms, 1),
    коды,
    ...доп,
  }
}

/** Один залп: n задач разом, каждая возвращает {ok, ms, status}. */
async function залп(n, задача) {
  const t0 = Date.now()
  const записи = await Promise.all(Array.from({ length: n }, (_, i) => задача(i)))
  return { записи, стенка: Date.now() - t0 }
}

/** Запрос с секундомером. Тело читается ЦЕЛИКОМ — иначе меряли бы заголовки. */
async function замер(url, init = {}) {
  const t0 = performance.now()
  try {
    const r = await fetch(url, { ...init, signal: abort.signal, cache: 'no-store' })
    const buf = await r.arrayBuffer()
    return { ok: r.ok, status: r.status, ms: performance.now() - t0, bytes: buf.byteLength, enc: r.headers.get('content-encoding') }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'abort' : (e.cause?.code || e.message), ms: performance.now() - t0 }
  }
}

// ── Что творится на сервере во время залпа ─────────────────────────────────
/**
 * ЗАЛП МОЖЕТ ИДТИ И С САМОГО СЕРВЕРА, и это не прихоть.
 *
 * С ноутбука через домашний канал упирается КАНАЛ, а не сервер: одна модель
 * Motion едет шесть секунд, и полсотни таких — это замер провайдера. Чтобы
 * узнать, сколько держит сервер, залп запускается на нём же: тот же TLS, тот же
 * Caddy, тот же Node, но без глобальной сети между ними. Оба числа нужны, и
 * путать их нельзя — поэтому у прогона два режима, а не один «правильный».
 *
 * LOAD_LOCAL=1 — мы уже на сервере: наблюдать за ним надо своей же оболочкой.
 */
const МЕСТНЫЙ = process.env.LOAD_LOCAL === '1'
const ssh = async (cmd) => {
  try {
    const { stdout } = МЕСТНЫЙ
      ? await exec('bash', ['-lc', cmd], { timeout: 20000 })
      : await exec('ssh', ['fitpro', cmd], { timeout: 20000 })
    return stdout.trim()
  } catch (e) {
    return `наблюдение не ответило: ${e.message}`
  }
}

const снимокСервера = () => ssh(
  "echo -n 'load '; cut -d' ' -f1-3 /proc/loadavg; "
  + "echo -n 'соединений в БД '; docker exec supabase-db psql -U postgres -At -c \"select count(*) from pg_stat_activity where datname='postgres'\"; "
  + "echo -n 'ждут блокировку '; docker exec supabase-db psql -U postgres -At -c \"select count(*) from pg_stat_activity where wait_event_type='Lock'\"; "
  + "echo -n 'активных запросов '; docker exec supabase-db psql -U postgres -At -c \"select count(*) from pg_stat_activity where state='active'\"",
)

// ── Тестовые аккаунты ──────────────────────────────────────────────────────
async function tokens(count) {
  const { createUsers, QA_PASSWORD } = await import('./admin.mjs')
  const runId = `load${Date.now().toString(36)}`
  const users = await createUsers(runId, count)
  const out = []
  for (const u of users) {
    const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: QA_PASSWORD }),
    })
    const b = await r.json()
    if (b?.access_token) out.push({ id: u.id, token: b.access_token })
  }
  return out
}

// ── Сценарии ───────────────────────────────────────────────────────────────
async function активы() {
  const html = await (await fetch(`${APP}/`, { cache: 'no-store' })).text()
  const set = new Set()
  for (const m of html.matchAll(/["'](\/assets\/[A-Za-z0-9._-]+\.(?:js|css))["']/g)) set.add(m[1])
  return ['/telegram-web-app.js', ...set]
}

const ЗАГОЛОВКИ_БРАУЗЕРА = {
  'Accept-Encoding': 'zstd, gzip, deflate',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
}

async function сценарийA() {
  const список = await активы()
  console.log(`холодное открытие: ${список.length} файлов на человека`)
  const задача = async () => {
    const t0 = performance.now()
    // Порядок как у браузера: сначала страница, потом всё, на что она ссылается.
    const page = await замер(`${APP}/`, { headers: ЗАГОЛОВКИ_БРАУЗЕРА })
    if (!page.ok) return { ok: false, status: page.status ?? page.error, ms: performance.now() - t0 }
    const части = await Promise.all(список.map((p) => замер(`${APP}${p}`, { headers: ЗАГОЛОВКИ_БРАУЗЕРА })))
    const плохо = части.find((c) => !c.ok)
    const байт = части.reduce((s, c) => s + (c.bytes ?? 0), page.bytes)
    return { ok: !плохо, status: плохо?.status ?? плохо?.error, ms: performance.now() - t0, bytes: байт }
  }
  const { записи, стенка } = await залп(N, задача)
  const байт = записи.reduce((s, r) => s + (r.bytes ?? 0), 0)
  return свод('а) холодное открытие', записи, {
    стенкаМс: стенка,
    мегабайт: Math.round((байт / 1048576) * 10) / 10,
    'Мбит/с': Math.round(((байт * 8) / стенка / 1000) * 10) / 10,
  })
}

async function сценарийB(список) {
  // Номер сезона спрашиваем служебным ключом: у anon нет прав на эту таблицу
  // (у неё вообще нет GRANT для anon), а нам тут нужен просто номер.
  const сезон = await (await fetch(`${SUPA}/rest/v1/challenge_seasons?select=id,status&status=eq.open`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  })).json()
  const id = сезон?.[0]?.id
  console.log(`страница челленджа и таблица потока: сезон ${id}, людей ${список.length}`)

  const задача = async (i) => {
    const u = список[i % список.length]
    const h = { apikey: ANON, Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }
    const t0 = performance.now()
    // То же, что делает экран: сезоны, своё участие, потом таблица потока.
    const шаги = await Promise.all([
      замер(`${SUPA}/rest/v1/challenge_seasons?select=*&status=in.(open,running,staff)`, { headers: h }),
      замер(`${SUPA}/rest/v1/challenge_entries?select=*&user_id=eq.${u.id}`, { headers: h }),
    ])
    const табл = await замер(`${SUPA}/rest/v1/rpc/challenge_standings`, {
      method: 'POST', headers: h, body: JSON.stringify({ p_season_id: id }),
    })
    /**
     * ТАБЛИЦУ ПОТОКА ВИДЯТ ТОЛЬКО ЕГО УЧАСТНИКИ — так написана сама функция.
     * Тестовый аккаунт билет не покупал, и отказ здесь ОЖИДАЕМ: он всё равно
     * проходит весь путь (Caddy → Kong → PostgREST → соединение из пула →
     * plpgsql), то есть меряет накладные расходы обращения. Стоимость самого
     * запроса на живом числе участников меряется отдельно, синтетикой: вписать
     * полсотни выдуманных участников в боевой поток нельзя — их увидят люди,
     * купившие билет.
     */
    const отказТаблицы = !табл.ok && [400, 403, 404].includes(табл.status)
    const плохо = [...шаги, ...(отказТаблицы ? [] : [табл])].find((c) => !c.ok)
    return {
      ok: !плохо, status: плохо?.status ?? плохо?.error, ms: performance.now() - t0,
      таблицаМс: табл.ms, таблицаКод: табл.status ?? табл.error,
    }
  }
  const { записи, стенка } = await залп(N, задача)
  return свод('б) челлендж + таблица', записи, {
    стенкаМс: стенка,
    'таблица медиана': кв(записи.filter((r) => r.таблицаМс).map((r) => r.таблицаМс), 0.5),
    'таблица p90': кв(записи.filter((r) => r.таблицаМс).map((r) => r.таблицаМс), 0.9),
    'таблица коды': записи.reduce((a, r) => ({ ...a, [r.таблицаКод]: (a[r.таблицаКод] ?? 0) + 1 }), {}),
  })
}

async function сценарийC() {
  /**
   * ЧТО ИМЕННО КАЧАЕТ MOTION ПРИ ПЕРВОМ ЗАПУСКЕ — спрашиваем у самого кода, а
   * не выписываем сюда руками: обнови версию tasks-vision, и список бы врал.
   *
   * Файлов три, и главный из них — НЕ модель. Модель 5.8 МБ, а движок wasm
   * 11.2 МБ; на проводе после сжатия 5.3 и 3.3 соответственно. Мерить одну
   * модель значило бы недосчитать больше трети веса первого запуска.
   */
  const { ownModelUrl, ownWasmBase } = await import('../src/motion/pose/assets.js')
  const wasm = ownWasmBase()
  const пробы = [ownModelUrl(), `${wasm}/vision_wasm_internal.wasm`, `${wasm}/vision_wasm_internal.js`]
  console.log(`движок Motion: ${пробы.length} файла, ${пробы[0]}`)

  const задача = async () => {
    const t0 = performance.now()
    const части = await Promise.all(пробы.map((u) => замер(u, { headers: ЗАГОЛОВКИ_БРАУЗЕРА })))
    const плохо = части.find((c) => !c.ok)
    return {
      ok: !плохо, status: плохо?.status ?? плохо?.error, ms: performance.now() - t0,
      bytes: части.reduce((s, c) => s + (c.bytes ?? 0), 0), enc: части[0]?.enc,
    }
  }
  const { записи, стенка } = await залп(N, задача)
  const байт = записи.reduce((s, r) => s + (r.bytes ?? 0), 0)
  return свод('в) движок Motion', записи, {
    стенкаМс: стенка,
    сжатие: записи[0]?.enc ?? 'нет',
    мегабайт: Math.round((байт / 1048576) * 10) / 10,
    'Мбит/с': Math.round(((байт * 8) / стенка / 1000) * 10) / 10,
  })
}

async function сценарийD(список) {
  console.log(`всплеск записей: ${N} заходов заканчиваются разом, аккаунтов ${список.length}`)
  const задача = async (i) => {
    const u = список[i % список.length]
    const h = { apikey: ANON, Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }
    const t0 = performance.now()
    // Ровно то, чем заканчивается заход: попытка, прогресс, строка журнала.
    // День у каждого запроса свой: у motion_attempts уникальность по
    // (user_id, day, tier, attempt_no), и без этого половина залпа упиралась бы
    // в собственный конфликт, а не в сервер.
    const попытка = await замер(`${SUPA}/rest/v1/motion_attempts?on_conflict=user_id,day,tier,attempt_no`, {
      method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: u.id, day: (i % 30) + 1, tier: 'load', attempt_no: (Math.floor(i / 30) % 3) + 1, score: 100, reps: 10, hits: 8, spawned: 10, react_ms: 400 }),
    })
    const прогресс = await замер(`${SUPA}/rest/v1/motion_progress?on_conflict=user_id`, {
      method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: u.id, payload: { load: true, at: Date.now() } }),
    })
    const журнал = await замер(`${APP}/api/set-exercise?action=motion-log`, {
      method: 'POST', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'motion-log', payload: { t: 'load.test', i } }),
    })
    const части = [попытка, прогресс, журнал]
    const плохо = части.find((c) => !c.ok)
    return {
      ok: !плохо, status: плохо?.status ?? плохо?.error, ms: performance.now() - t0,
      части: { попытка: попытка.status, прогресс: прогресс.status, журнал: журнал.status },
      журналМс: журнал.ms,
    }
  }
  const наблюдение = снимокСервера()
  const { записи, стенка } = await залп(N, задача)
  const во_время = await наблюдение
  const коды = {}
  for (const r of записи) for (const [k, v] of Object.entries(r.части ?? {})) коды[`${k}:${v}`] = (коды[`${k}:${v}`] ?? 0) + 1
  return свод('г) всплеск записей', записи, { стенкаМс: стенка, поЧастям: коды, серверВоВремя: во_время })
}

/**
 * НАШИ СОБСТВЕННЫЕ ОГРАНИЧИТЕЛИ. Полсотни человек из одного офиса приходят с
 * одного адреса — для лимитера это один и тот же посетитель.
 *
 * Проверяется на публичных ветках, где нет ни токена, ни личности: маячок
 * загрузки (20/мин) и воронка (60/мин). Обе не пишут ничего ценного, и лишние
 * строки в счётчиках погоды не делают.
 */
async function сценарийE() {
  /**
   * ТЕЛО НАРОЧНО НЕГОДНОЕ. Ограничитель считает запрос ДО разбора тела, а вот
   * до базы негодное тело не доходит: ветка маячка выходит первой строкой, если
   * приехал не объект. Так проверка меряет ровно лимитер и не оставляет за
   * собой ни одного маячка — иначе она сама подняла бы тревогу «больше трёх
   * маячков за час», и владелец пошёл бы искать несуществующий белый экран.
   */
  const проба = async (имя, url, тело, n) => {
    const { записи } = await залп(n, () => замер(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(тело),
    }))
    const отказов = записи.filter((r) => r.status === 429).length
    return { ветка: имя, послано: n, отказов, первыйОтказНа: отказов ? записи.findIndex((r) => r.status === 429) + 1 : null }
  }
  const out = []
  out.push(await проба('/api/boot (лимит 20/мин)', `${APP}/api/boot`, 'нагрузочная проверка', 25))
  out.push(await проба('воронка (лимит 60/мин)', `${APP}/api/set-exercise?action=funnel`, { event: 'нет-такого-события' }, 65))
  return { сценарий: 'д) наши ограничители', пробы: out }
}

async function базовый() {
  const цели = [
    ['страница', `${APP}/`, {}],
    ['главный бандл', `${APP}/assets/${(await активы()).find((a) => a.includes('index-') && a.endsWith('.js'))?.split('/').pop()}`, {}],
    ['воронка', `${APP}/api/set-exercise?action=funnel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event":"нет"}' }],
    ['сезоны (PostgREST)', `${SUPA}/rest/v1/challenge_seasons?select=id&status=eq.open`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }],
  ]
  const out = []
  for (const [имя, url, init] of цели) {
    const пробы = []
    for (let i = 0; i < 5; i++) пробы.push(await замер(url, { ...init, headers: { ...ЗАГОЛОВКИ_БРАУЗЕРА, ...(init.headers || {}) } }))
    out.push({ цель: имя, медиана: кв(пробы.filter((p) => p.ok).map((p) => p.ms), 0.5), коды: пробы.map((p) => p.status).join(',') })
  }
  return { сценарий: 'точка отсчёта (по одному запросу)', цели: out }
}

// ── Прогон ─────────────────────────────────────────────────────────────────
const до = await снимокСервера()
console.log('сервер ДО:', до.replace(/\n/g, ' | '))

let результат
let созданные = []
try {
  if (SCENARIO === 'a') результат = await сценарийA()
  else if (SCENARIO === 'c') результат = await сценарийC()
  else if (SCENARIO === 'e') результат = await сценарийE()
  else if (SCENARIO === 'base') результат = await базовый()
  else if (SCENARIO === 'b' || SCENARIO === 'd') {
    созданные = await tokens(Number(arg('users', 12)))
    console.log(`заведено тестовых аккаунтов: ${созданные.length}`)
    результат = SCENARIO === 'b' ? await сценарийB(созданные) : await сценарийD(созданные)
  } else throw new Error(`неизвестный сценарий ${SCENARIO}`)
} finally {
  if (созданные.length) {
    const { cleanupAll } = await import('./admin.mjs')
    const убрано = await cleanupAll()
    console.log(`тестовые аккаунты убраны: ${JSON.stringify(убрано)}`)
  }
}

const после = await снимокСервера()
console.log('сервер ПОСЛЕ:', после.replace(/\n/g, ' | '))
console.log(JSON.stringify(результат, null, 2))

if (BROWSERS > 0) {
  console.log(`\nнастоящие браузеры: ${BROWSERS} холодных открытия`)
  const { chromium } = await import('playwright')
  const br = await chromium.launch({ headless: true })
  const один = async () => {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 } })
    const page = await ctx.newPage()
    const t0 = performance.now()
    await page.goto(APP, { waitUntil: 'commit', timeout: 60000 })
    await page.waitForFunction(() => window.__boot?.stage === 'react' || window.__boot?.stage === 'data', { timeout: 60000 }).catch(() => {})
    const b = await page.evaluate(() => ({ ...window.__boot }))
    await ctx.close()
    return { ok: !!b.t_react, ms: b.t_react ?? performance.now() - t0, стадия: b.stage, доБандла: b.t_bundle }
  }
  const { записи } = await залп(BROWSERS, один)
  console.log(JSON.stringify(свод('а+) настоящий браузер до React', записи), null, 2))
  await br.close()
}

mkdirSync('reports', { recursive: true })
const файл = `reports/load-${SCENARIO}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
writeFileSync(файл, JSON.stringify({ app: APP, n: N, до, после, результат }, null, 2))
console.log(`\nотчёт: ${файл}`)
if (остановлено) process.exitCode = 130
