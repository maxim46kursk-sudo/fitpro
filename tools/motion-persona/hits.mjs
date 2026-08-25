/**
 * ПУТЬ ПОПАДАНИЯ ПО КРУГАМ: медиана и 90-й процентиль.
 *
 * Читает `hits` из отчёта прогона (их пишет сам экран боя, см.
 * src/motion/debug/hitLatency.js) и раскладывает по кругам сессии. Вопрос, ради
 * которого таблица и нужна: РАСТЁТ ЛИ задержка от первого круга к седьмому.
 * Одно среднее по сессии на него не отвечает — именно в нём рост и тонет.
 *
 * Три столбца — три ожидания, а не три стадии:
 *   замер      — от захвата кадра до результата модели (включая очередь);
 *   судейство  — от результата до тика игрового цикла, который его разберёт;
 *   показ      — от решения судьи до кадра, в котором мишень взорвалась.
 * «промежуток» рядом — расстояние между двумя замерами: на него «размазано»
 * начало отсчёта, потому что рука входит в круг МЕЖДУ кадрами.
 *
 *   node tools/motion-persona/hits.mjs [имя отчёта]
 */
import { readFileSync, readdirSync } from 'node:fs'

const dir = 'reports'
const файл = process.argv[2] || readdirSync(dir).filter((f) => f.startsWith('motion-session-')).sort().pop()
const r = JSON.parse(readFileSync(`${dir}/${файл}`, 'utf8'))
const hits = r.hits || []

const кв = (v, p) => {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] * 10) / 10
}

const поля = ['замер', 'судейство', 'показ', 'всего', 'промежуток']
const круги = [...new Set(hits.map((h) => h.cycle))].sort((a, b) => a - b)

console.log(`отчёт: ${файл}`)
console.log(`попаданий: ${hits.length}, режим показа: ${[...new Set(hits.map((h) => h.режим))].join(',')}`)
console.log(`отрицательных «судейство»: ${hits.filter((h) => h.судейство < 0).length}`)
console.log('')
const шапка = ['круг', 'n', ...поля.flatMap((p) => [`${p} мед`, `${p} p90`])]
const строки = [шапка]
for (const c of круги) {
  const h = hits.filter((x) => x.cycle === c)
  строки.push([String(c), String(h.length), ...поля.flatMap((p) => [String(кв(h.map((x) => x[p]), 0.5)), String(кв(h.map((x) => x[p]), 0.9))])])
}
const все = hits
строки.push(['все', String(все.length), ...поля.flatMap((p) => [String(кв(все.map((x) => x[p]), 0.5)), String(кв(все.map((x) => x[p]), 0.9))])])
const ширины = шапка.map((_, i) => Math.max(...строки.map((s) => s[i].length)))
for (const s of строки) console.log(s.map((v, i) => v.padStart(ширины[i])).join('  '))
