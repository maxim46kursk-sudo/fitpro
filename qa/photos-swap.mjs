// Замена товаров, у которых «снимок таблицы» оказался негодным.
//
// Что нашлось при проверке всех тринадцати:
//   №2 творожок — вместо таблицы фотография ОТКРЫТОЙ ПАЧКИ, таблицы нет вовсе;
//   №3 снек     — таблица есть, но снимок 246×275: прочесть физически нельзя;
//   №5 батончик — вместо таблицы лицевая плашка «один батончик (40 г)
//                 содержит», без белков и углеводов и не на 100 г.
// Остальные десять — настоящие таблицы; у №9 она даже образцово читаемая.
//
// Проверять распознавание на таких снимках бессмысленно: мы меряем не модель,
// а качество чужих фотографий.
import { readFileSync, writeFileSync } from 'node:fs'

const pool = [...JSON.parse(readFileSync('qa/_pool.json', 'utf8')),
  ...JSON.parse(readFileSync('qa/_pool2.json', 'utf8'))]
const byCode = c => pool.find(p => p.code === c)

// № в наборе → чем заменяем (код в Open Food Facts).
const SWAP = {
  2: '4602117001107',  // Резной палисад, Творог 5% — таблица 1527×1854, сходится идеально
  3: '6410500090014',  // Finn Crisp, хлебцы ржаные — снек с настоящей таблицей
  5: '4607084351385',  // Orion, Choco Pie — батончик, таблица 1525×2413
}

const set = JSON.parse(readFileSync('qa/photos/set.json', 'utf8'))

async function dl(url, file) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'FitPro-QA/1.0 (maxim46kursk@gmail.com)' }, signal: AbortSignal.timeout(90000) })
      if (!r.ok) return `HTTP ${r.status}`
      const b = Buffer.from(await r.arrayBuffer())
      if (b.length < 3000) return `мал (${b.length} б)`
      writeFileSync(file, b)
      return `${Math.round(b.length / 1024)} КБ`
    } catch (e) { if (t === 2) return `не скачалось: ${e.name}` }
  }
}

for (const [n, code] of Object.entries(SWAP)) {
  const p = byCode(code)
  if (!p) { console.log(`№${n}: кандидат ${code} не найден в пуле`); continue }
  const i = set.findIndex(x => x.n === Number(n))
  const old = set[i]
  set[i] = { ...old, realCode: p.code, name: p.name, brand: p.brand, quantity: p.quantity, ref: p.ref, front: p.front, nutri: p.nutri }
  const a = await dl(p.front, `qa/photos/${n}-front.jpg`)
  const b = await dl(p.nutri, `qa/photos/${n}-nutri.jpg`)
  console.log(`№${n} ${old.cat}: «${old.name}» → «${p.name}» (${p.brand})`)
  console.log(`     лицо: ${a}   таблица: ${b}`)
}

writeFileSync('qa/photos/set.json', JSON.stringify(set, null, 1))

const md = ['# Эталонные КБЖУ (на 100 г), с этикетки товара', '',
  'Значения из карточки Open Food Facts, куда их вносят с упаковки.',
  'Снимок таблицы лежит рядом (`N-nutri.jpg`) — по нему их можно перепроверить.',
  '', 'Товары 2, 3 и 5 заменены: у прежних «снимок таблицы» оказался негодным',
  '(фотография открытой пачки, снимок 246×275 и лицевая плашка GDA).',
  '', '| № | категория | товар | марка | вес | ккал | Б | Ж | У | код в OFF | код в прогоне |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...set.map(p => `| ${p.n} | ${p.cat} | ${p.name} | ${p.brand} | ${p.quantity} | ${p.ref.kcal100} | ${p.ref.p100} | ${p.ref.f100} | ${p.ref.c100} | ${p.realCode} | ${p.barcode} |`),
].join('\n')
writeFileSync('qa/photos/reference.md', md + '\n')
console.log('\nнабор и эталон обновлены')
