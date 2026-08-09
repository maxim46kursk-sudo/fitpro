// Сборка отчёта по прогону: одна строка на товар плюс сводки.
import { readFileSync } from 'node:fs'

const R = JSON.parse(readFileSync('qa/photos/result.json', 'utf8'))
const SET = JSON.parse(readFileSync('qa/photos/set.json', 'utf8'))

const n = v => (v === null || v === undefined ? '—' : String(v))
const kbju = p => (p ? `${n(p.kcal100)}/${n(p.p100)}/${n(p.f100)}/${n(p.c100)}` : '—')
// Расхождение по калорийности в процентах — по ней и считаем «больше 10%».
const diffPct = (a, b) => (typeof a === 'number' && typeof b === 'number' && b ? Math.round(Math.abs(a - b) / b * 1000) / 10 : null)

const rows = []
let big = 0, asked = 0, truncated = 0
for (const p of SET) {
  const r = R[String(p.n)]
  if (!r) continue
  const est = r.front?.product
  const lab = r.nutri?.product
  const fin = r.final
  const dEst = diffPct(est?.kcal100, p.ref.kcal100)
  const dLab = diffPct(lab?.kcal100, p.ref.kcal100)
  if (dEst !== null && dEst > 10) big++
  if (r.saveFront?.asked || r.saveNutri?.asked) asked++

  // Обрезка названия: во что превратилось то, что напечатано на пачке.
  const packName = `${p.name} ${p.quantity}`.toLowerCase()
  const got = String(est?.name || '').toLowerCase()
  const lostWeight = /\d/.test(p.quantity) && !/\d/.test(got.replace(/\d+\s*%/g, ''))
  if (lostWeight) truncated++

  rows.push({
    n: p.n, cat: p.cat,
    pack: `${p.brand} ${p.name}${p.quantity ? ' ' + p.quantity : ''}`,
    got: est?.name ? `${est.name}${est.brand ? ' / ' + est.brand : ''}` : '—',
    estBasis: est?.basis || '—', est: kbju(est),
    labBasis: lab?.basis || '—', lab: kbju(lab),
    ref: `${p.ref.kcal100}/${p.ref.p100}/${p.ref.f100}/${p.ref.c100}`,
    dEst: dEst === null ? '—' : `${dEst}%`,
    dLab: dLab === null ? '—' : `${dLab}%`,
    db: fin ? `${fin.source} ${kbju(fin)}` : 'нет строки',
    asked: r.saveFront?.asked || r.saveNutri?.asked ? 'да' : 'нет',
    lostWeight,
  })
}

console.log('| № | категория | на пачке | что распознал | прикидка (К/Б/Ж/У) | с этикетки (К/Б/Ж/У) | эталон | Δ прикидки | Δ этикетки | в базе |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(`| ${r.n} | ${r.cat} | ${r.pack} | ${r.got} | ${r.estBasis}: ${r.est} | ${r.labBasis}: ${r.lab} | ${r.ref} | ${r.dEst} | ${r.dLab} | ${r.db} |`)
}

console.log(`\nтоваров в прогоне: ${rows.length}`)
console.log(`прикидка разошлась с эталоном больше 10%: ${big} из ${rows.filter(r => r.dEst !== '—').length}`)
console.log(`вопрос про похожие сработал: на ${asked} товарах`)
console.log(`потеряли вес в названии: ${truncated}`)
console.log(`\nбез строки в базе: ${rows.filter(r => r.db === 'нет строки').map(r => r.n).join(', ') || 'нет'}`)
console.log(`точные не вытеснили прикидку: ${rows.filter(r => r.db.startsWith('ai_estimate')).map(r => r.n).join(', ') || 'нет'}`)
