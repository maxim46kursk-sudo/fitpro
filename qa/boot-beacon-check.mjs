// САМОДИАГНОЗ БЕЛОГО ЭКРАНА — проверка на проде, обоими концами.
//
// ДВА ПРОГОНА, И ВТОРОЙ ВАЖНЕЕ ПЕРВОГО:
//   1) СЛОМАННАЯ ЗАГРУЗКА — бандл не отдаём вовсе. Ждём: маячок доехал до базы,
//      экран показался человеку, кнопки на месте;
//   2) НОРМАЛЬНАЯ ЗАГРУЗКА — ничего не трогаем. Ждём: маячков НЕТ ни одного.
//      Сторож, который срабатывает на здоровом заходе, хуже отсутствия сторожа:
//      его перестанут читать через неделю.
//
// Считаем маячки в базе ДО и ПОСЛЕ каждого прогона: сравнение с самим собой —
// единственный честный способ, пока на прод ходят живые люди.
//
//   node qa/boot-beacon-check.mjs
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const BASE = process.env.QA_BASE || 'https://fitproapp.ru'
const SUPA = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const OUT = 'qa-screens/boot'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const R = {}

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
const admin = (p, i) => fetch(`${SUPA}${p}`, {
  ...i,
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(i?.headers || {}) },
})

/** Маячки, приехавшие после указанной метки времени. */
const маячкиПосле = async (от) => {
  const r = await admin(`/rest/v1/boot_beacons?select=created_at,stage,ms,attempt,conn,ua,pending&created_at=gt.${encodeURIComponent(от)}&order=id.desc`)
  const rows = await r.json()
  return Array.isArray(rows) ? rows : []
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
const br = await chromium.launch({ headless: true })

// ═══ 1. СЛОМАННАЯ ЗАГРУЗКА ═════════════════════════════════════════════════
{
  const от = new Date().toISOString()
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ru-RU' })
  const page = await ctx.newPage()

  /**
   * Бандл не отдаём совсем — это и есть «белый экран» в чистом виде: страница
   * пришла, код нет. Отдать 404 было бы мягче: тогда сработала бы страховка от
   * чёрного экрана (перезаход), и мы проверили бы её, а не сторожа.
   */
  await page.route('**/assets/index-*.js', (route) => route.abort('failed'))

  await page.goto(BASE, { waitUntil: 'commit', timeout: 60000 })
  await sleep(3000)
  R.черезТриСекунды = await page.evaluate(() => ({
    стадия: window.__boot?.stage ?? null,
    экран: !!document.getElementById('boot-fail'),
  }))

  /**
   * ЖДЁМ ДОЛЬШЕ, ЧЕМ КАЖЕТСЯ НУЖНЫМ, и вот почему. На странице живёт ещё одна
   * страховка — от чёрного экрана после выкладки: увидев ошибку загрузки
   * бандла, она через шесть секунд ПЕРЕЗАГРУЖАЕТ страницу. Часы сторожа при
   * этом начинаются заново, и его сроки (8, 10, 20) отсчитываются от второго
   * захода, а не от первого. Первый прогон этого не учитывал и объявил
   * «экран не показался», когда до него оставалось четыре секунды.
   */
  await sleep(22000)
  R.черезДвадцатьПять = await page.evaluate(() => ({
    стадия: window.__boot?.stage ?? null,
    экран: !!document.getElementById('boot-fail'),
    текст: document.getElementById('boot-fail')?.innerText?.replace(/\s+/g, ' ') ?? null,
    кнопки: [...document.querySelectorAll('#boot-fail button, #boot-fail a')].map((e) => e.innerText.trim()),
  }))
  await page.screenshot({ path: `${OUT}/01-экран-вместо-белого.png` })

  // и ещё немного — на второй маячок (20 с от второго захода)
  await sleep(16000)
  await ctx.close()
  await sleep(2500)

  R.маячкиСломанной = (await маячкиПосле(от)).map((b) => ({
    стадия: b.stage, мс: b.ms, попытка: b.attempt, связь: b.conn,
    недогружено: (b.pending || []).map((x) => String(x.name).split('/').pop()).slice(0, 4),
    устройство: String(b.ua || '').slice(0, 40),
  }))
}

// ═══ 2. НОРМАЛЬНАЯ ЗАГРУЗКА ════════════════════════════════════════════════
{
  const от = new Date().toISOString()
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
  await sleep(4000)

  R.нормальная = await page.evaluate(() => ({
    стадия: window.__boot?.stage ?? null,
    доBundle: window.__boot?.t_bundle ?? null,
    доReact: window.__boot?.t_react ?? null,
    доData: window.__boot?.t_data ?? null,
    экран: !!document.getElementById('boot-fail'),
    корень: document.getElementById('root')?.childElementCount ?? 0,
  }))
  await page.screenshot({ path: `${OUT}/02-нормальная-загрузка.png` })

  // выждать оба срока сторожа и убедиться, что он промолчал
  await sleep(22000)
  R.нормальнаяПосле22 = await page.evaluate(() => ({
    стадия: window.__boot?.stage ?? null,
    экран: !!document.getElementById('boot-fail'),
  }))
  await ctx.close()
  await sleep(2500)
  R.маячкиНормальной = await маячкиПосле(от)
}

await br.close()
console.log(JSON.stringify(R, null, 2))
console.log(`\nснимки: ${OUT}/`)
