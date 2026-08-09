// Полный путь по каждому товару, под постоянным тестовым аккаунтом:
//   лицевая сторона → карточка → сохранить → отсканировать снова →
//   снять таблицу с обратной стороны → сохранить → проверить, что точные
//   цифры вытеснили прикидку.
//
// Пишет результат по каждому шагу в qa/photos/result.json сразу, а не в конце:
// прогон длинный (26 обращений к модели, почасовая квота 20), и оборваться он
// может на любом шаге — терять из-за этого всё уже сделанное незачем.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { ensureBot, botToken, ANON } from './bot.mjs'

const BASE = 'https://fitproapp.ru'
const SET = JSON.parse(readFileSync('qa/photos/set.json', 'utf8'))
const OUT = 'qa/photos/result.json'
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 1))
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ensureBot()
let token = await botToken()

async function recognise(barcode, file) {
  const image = readFileSync(file).toString('base64')
  for (let t = 0; t < 12; t++) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'food_label', barcode, image }),
    })
    const j = await r.json().catch(() => null)
    if (r.status === 429) {
      // Почасовой потолок распознаваний. Ждём и повторяем: прогон длиннее
      // квоты по построению, это штатная пауза, а не сбой.
      console.log(`   429 (${j?.reason || 'почасовой лимит'}) — жду 5 мин`)
      await sleep(300000)
      continue
    }
    if (r.status === 401) { token = await botToken(); continue }
    return { status: r.status, body: j }
  }
  return { status: 429, body: null }
}

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))

// Сохранение карточки с ответом на вопрос о похожем товаре.
//
// Вопрос срабатывает часто: в справочнике уже лежат те же товары под своими
// настоящими кодами, а прогон идёт по синтетическим. Отвечаем «другой вкус» —
// это правда: карточка заводится на другой штрих-код, и подменять ей числа
// чужими было бы неверно. Факт вопроса записываем: сам по себе он проверяемый
// результат.
async function saveCard(barcode, q) {
  const body = { barcode, basis: q.basis, name: q.name, brand: q.brand, kcal100: q.kcal100, p100: q.p100, c100: q.c100, f100: q.f100 }
  const first = await post('/api/set-exercise?action=save-product', body)
  if (first.body?.reason !== 'similar_exists') return { ...first, asked: false }
  const second = await post('/api/set-exercise?action=save-product', { ...body, distinct: true })
  return { ...second, asked: true, candidate: first.body?.candidate }
}

const scan = code => fetch(`${BASE}/api/set-exercise?action=barcode&code=${code}`)
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))

for (const p of SET) {
  const key = String(p.n)
  if (results[key]?.done) { console.log(`${p.n}. ${p.cat} — уже сделано`); continue }
  const R = results[key] = results[key] || {}
  R.cat = p.cat; R.barcode = p.barcode; R.real = { name: p.name, brand: p.brand, quantity: p.quantity }; R.ref = p.ref
  console.log(`\n${p.n}. ${p.cat}: ${p.brand} — ${p.name}`)

  // 1. Лицевая сторона
  const front = await recognise(p.barcode, `qa/photos/${p.n}-front.jpg`)
  R.front = { status: front.status, ok: front.body?.ok, reason: front.body?.reason, product: front.body?.product }
  console.log(`   лицо: ${front.status} basis=${front.body?.product?.basis} «${front.body?.product?.name}» ${front.body?.product?.kcal100}/${front.body?.product?.p100}/${front.body?.product?.f100}/${front.body?.product?.c100}`)
  save()

  // 2. Сохранение прикидки
  if (front.body?.product) {
    const s = await saveCard(p.barcode, front.body.product)
    R.saveFront = { status: s.status, created: s.body?.created, asked: s.asked, candidate: s.candidate?.name, error: s.body?.error }
    console.log(`   сохранение прикидки: ${s.status} created=${s.body?.created} вопрос=${s.asked ? 'был' : 'нет'} ${s.body?.error || ''}`)
    save()
  }

  // 3. Повторный скан
  const again = await scan(p.barcode)
  R.rescan = { status: again.status, found: again.body?.found, source: again.body?.product?.source, kcal: again.body?.product?.kcal100 }
  console.log(`   повторный скан: found=${again.body?.found} source=${again.body?.product?.source} ${again.body?.product?.kcal100} ккал`)
  save()

  // 4. Таблица с обратной стороны
  const nutri = await recognise(p.barcode, `qa/photos/${p.n}-nutri.jpg`)
  R.nutri = { status: nutri.status, ok: nutri.body?.ok, reason: nutri.body?.reason, product: nutri.body?.product }
  console.log(`   таблица: ${nutri.status} basis=${nutri.body?.product?.basis} ${nutri.body?.product?.kcal100}/${nutri.body?.product?.p100}/${nutri.body?.product?.f100}/${nutri.body?.product?.c100}`)
  save()

  // 5. Сохранение точных
  if (nutri.body?.product) {
    const s = await saveCard(p.barcode, nutri.body.product)
    R.saveNutri = { status: s.status, created: s.body?.created, replaced: s.body?.replaced, asked: s.asked, error: s.body?.error }
    console.log(`   сохранение точных: ${s.status} replaced=${s.body?.replaced} вопрос=${s.asked ? 'был' : 'нет'} ${s.body?.error || ''}`)
    save()
  }

  // 6. Что в итоге в базе
  const fin = await scan(p.barcode)
  R.final = fin.body?.product || null
  R.done = true
  console.log(`   в базе: source=${fin.body?.product?.source} ${fin.body?.product?.kcal100}/${fin.body?.product?.p100}/${fin.body?.product?.f100}/${fin.body?.product?.c100}`)
  save()
}

console.log('\nпрогон закончен, результат в qa/photos/result.json')
