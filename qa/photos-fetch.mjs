// Набор товаров для прогона распознавания: скачивает по два снимка на товар
// (лицевая сторона и таблица «Пищевая ценность») и выписывает эталонные КБЖУ.
//
// Источник — Open Food Facts: там у карточки лежат обе стороны упаковки, снятые
// живыми людьми, и картинки отдаются без антибота, в отличие от магазинов.
//
// ШТРИХ-КОДЫ У ТОВАРОВ ПОДМЕНЕНЫ на синтетические 2909…. Так надо: настоящий
// код Open Food Facts знает, и тогда сканер нашёл бы товар в OFF и до
// распознавания по фото дело бы не дошло — то есть проверяемый путь не
// запустился бы вовсе. Синтетический код промахивается и по нашему
// справочнику, и по OFF, и открывает ровно тот сценарий, который проверяем.
// Заодно это делает чистку тривиальной: barcode like '2909%'.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

const pool = [...JSON.parse(readFileSync('qa/_pool.json', 'utf8')),
  ...JSON.parse(readFileSync('qa/_pool2.json', 'utf8'))]
const byName = frag => pool.find(p => p.name.toLowerCase().includes(frag.toLowerCase()))

// Категория → чем её закрываем. Порядок задаёт номер синтетического кода.
const PICK = [
  ['молочка', 'Молоко питьевое ультрапастеризованное'],
  ['творожок', 'Творог 2%'],
  ['снек', 'Pringles Original'],
  ['снек (второй вкус той же линейки)', 'Pringles Cașcaval'],
  ['батончик', 'Сникерс супер'],
  ['крупа', 'Гречневая крупа'],
  ['консервы', 'Кукуруза сладкая'],
  ['напиток', 'Lipton Ice Tea Original'],
  ['соус', 'Kikkoman соевый соус'],
  ['замороженное', 'Эскимо с миндалём'],
  ['сладость', 'шоколад элитный 75%'],
  ['спортпит', 'Малиновый чизкейк'],
  ['детское питание', 'Мультизлаковая каша молочная'],
]

mkdirSync('qa/photos', { recursive: true })

const set = []
let i = 0
for (const [cat, frag] of PICK) {
  const p = byName(frag)
  if (!p) { console.log(`✗ не нашёл в пуле: ${frag}`); continue }
  i++
  const barcode = `290900000${String(i).padStart(4, '0')}`
  set.push({ n: i, cat, barcode, realCode: p.code, name: p.name, brand: p.brand, quantity: p.quantity, ref: p.ref, front: p.front, nutri: p.nutri })
}

async function dl(url, file, tries = 3) {
  if (existsSync(file)) return 'уже есть'
  for (let t = 0; t < tries; t++) {
    try { return await once(url, file) } catch (e) { if (t === tries - 1) return 'не скачалось: ' + e.name }
  }
}

async function once(url, file) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'FitPro-QA/1.0 (maxim46kursk@gmail.com)' },
    signal: AbortSignal.timeout(90000),
  })
  if (!r.ok) return `HTTP ${r.status}`
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 3000) return `слишком мал (${buf.length} б)`
  writeFileSync(file, buf)
  return `${Math.round(buf.length / 1024)} КБ`
}

for (const p of set) {
  const a = await dl(p.front, `qa/photos/${p.n}-front.jpg`)
  const b = await dl(p.nutri, `qa/photos/${p.n}-nutri.jpg`)
  console.log(`${String(p.n).padStart(2)} ${p.cat.padEnd(34)} лицо: ${String(a).padEnd(10)} таблица: ${b}`)
}

writeFileSync('qa/photos/set.json', JSON.stringify(set, null, 1))

// Эталон — отдельным читаемым файлом, как просили.
const md = ['# Эталонные КБЖУ (на 100 г), с этикетки товара', '',
  'Значения взяты из карточки Open Food Facts, куда их вносят с упаковки.',
  'Снимок таблицы лежит рядом (`N-nutri.jpg`) — по нему их можно перепроверить глазами.',
  '', '| № | категория | товар | марка | вес | ккал | Б | Ж | У | код в OFF | код в прогоне |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...set.map(p => `| ${p.n} | ${p.cat} | ${p.name} | ${p.brand} | ${p.quantity} | ${p.ref.kcal100} | ${p.ref.p100} | ${p.ref.f100} | ${p.ref.c100} | ${p.realCode} | ${p.barcode} |`),
].join('\n')
writeFileSync('qa/photos/reference.md', md + '\n')

console.log(`\nнабор: ${set.length} товаров, файлы в qa/photos/, эталон в qa/photos/reference.md`)
