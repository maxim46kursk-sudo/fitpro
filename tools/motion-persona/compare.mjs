#!/usr/bin/env node
/**
 * ДВА ПРОГОНА РЯДОМ: воркер против главного потока на одном материале.
 *
 * Полевые числа на этот вопрос не отвечают: какой режим достанется человеку,
 * решает его телефон, и в журнале «поток» намертво слипается с устройством —
 * все откаты пришлись на один айфон, все успехи воркера на другие телефоны.
 * Сравнивать так — значит сравнивать телефоны.
 *
 * Здесь материал один и тот же: тот же персонаж, то же зерно, те же движения,
 * тот же браузер. Отличается ровно одно — где считается модель.
 *
 * Показывает три вещи, и все три нужны вместе:
 *   ЧАСТОТА И ЗАДЕРЖКА по боям — сколько замеров в секунду и сколько идёт от
 *     кадра до результата;
 *   СТАДИИ по минутам — не проседает ли отрисовка (`draw`), когда модель и
 *     игровой цикл делят один поток;
 *   ПУТЬ ПОПАДАНИЯ по кругам — сквозная задержка до кадра со взрывом, и растёт
 *     ли она от первого круга к седьмому.
 *
 *   node tools/motion-persona/compare.mjs отчёт-воркер.json отчёт-главный.json
 */
import { readFileSync, readdirSync } from 'node:fs'

const dir = 'reports'
const [a, b] = process.argv.slice(2)
const свежие = () => readdirSync(dir).filter((f) => f.startsWith('motion-session-')).sort().slice(-2)
const [файлA, файлB] = a && b ? [a, b] : свежие()

const читать = (f) => ({ имя: f, ...JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) })
const A = читать(файлA)
const B = читать(файлB)

const кв = (v, p) => {
  if (!v.length) return null
  const s = [...v].sort((x, y) => x - y)
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] * 10) / 10
}

/** Из журнала прогона: чем он считал на самом деле. */
function поток(отчёт) {
  const строки = отчёт.log || []
  const наГлавном = строки.some((l) => /"thread":"main"/.test(l))
  const вВоркере = строки.some((l) => /"thread":"worker"/.test(l))
  const откат = строки.some((l) => /\[worker\.fallback\]/.test(l))
  if (наГлавном && !вВоркере) return откат ? 'главный (после отката)' : 'главный'
  if (вВоркере && !наГлавном) return 'воркер'
  if (наГлавном && вВоркере) return 'смесь — сравнивать нельзя'
  return '—'
}

/** Бои: частота замеров и задержка из строк `game.end`. */
function бои(отчёт) {
  const out = []
  for (const e of отчёт.events || []) {
    if (e.tag !== 'game.end' || !e.data) continue
    out.push({ fps: Number(e.data.poseFps), lat: Number(e.data.latencyMs) })
  }
  return out
}

const таблица = (строки, колонки) => {
  const все = [колонки, ...строки.map((r) => колонки.map((c) => String(r[c] ?? '—')))]
  const ш = колонки.map((_, i) => Math.max(...все.map((s) => [...s[i]].length)))
  return все.map((s, i) => s.map((v, j) => (i === 0 || j === 0 ? v.padEnd(ш[j]) : v.padStart(ш[j]))).join('  ')).join('\n')
}

console.log(`A: ${A.имя}  → ${поток(A)}`)
console.log(`B: ${B.имя}  → ${поток(B)}\n`)

console.log('══ БОИ: частота замеров и задержка кадр→результат ══')
console.log(таблица([A, B].map((о) => {
  const b = бои(о)
  return {
    прогон: поток(о),
    боёв: b.length,
    'поз/с мед': кв(b.map((x) => x.fps).filter(Number.isFinite), 0.5),
    'поз/с мин': кв(b.map((x) => x.fps).filter(Number.isFinite), 0),
    'задержка мед': кв(b.map((x) => x.lat).filter(Number.isFinite), 0.5),
    'задержка макс': кв(b.map((x) => x.lat).filter(Number.isFinite), 1),
  }
}), ['прогон', 'боёв', 'поз/с мед', 'поз/с мин', 'задержка мед', 'задержка макс']))

console.log('\n══ СТАДИИ: первая минута боя против последней ══')
/** Минуты боя из общей таблицы прогона: только они сравнимы между собой. */
const стадии = (о) => (о.table?.minutes || []).filter((r) => r.phase === 'бой')
for (const о of [A, B]) {
  const rows = стадии(о)
  if (!rows.length) { console.log(`${поток(о)}: таблица стадий пуста`); continue }
  const первая = rows[0]
  const последняя = rows[rows.length - 1]
  const п = (r, k) => (r?.[k] ?? '—')
  console.log(`${поток(о)}: минут боя ${rows.length}`)
  console.log(таблица([
    { минута: `первая (${первая.min})`, кадров: первая.frames, grab: п(первая, 'grab'), inference: п(первая, 'inference'), judge: п(первая, 'judge'), draw: п(первая, 'draw'), частиц: п(первая, 'particles') },
    { минута: `последняя (${последняя.min})`, кадров: последняя.frames, grab: п(последняя, 'grab'), inference: п(последняя, 'inference'), judge: п(последняя, 'judge'), draw: п(последняя, 'draw'), частиц: п(последняя, 'particles') },
  ], ['минута', 'кадров', 'grab', 'inference', 'judge', 'draw', 'частиц']))
}

console.log('\n══ ПУТЬ ПОПАДАНИЯ: круг 1 против круга 7 ══')
const поКругам = (о) => {
  const hits = о.hits || []
  const круги = [...new Set(hits.map((h) => h.cycle))].sort((x, y) => x - y)
  return круги.map((c) => {
    const h = hits.filter((x) => x.cycle === c)
    return {
      круг: c, n: h.length,
      'замер мед': кв(h.map((x) => x.замер), 0.5),
      'судейство мед': кв(h.map((x) => x.судейство), 0.5),
      'показ мед': кв(h.map((x) => x.показ), 0.5),
      'всего мед': кв(h.map((x) => x.всего), 0.5),
      'всего p90': кв(h.map((x) => x.всего), 0.9),
    }
  })
}
for (const о of [A, B]) {
  const rows = поКругам(о)
  console.log(`\n${поток(о)} — попаданий ${(о.hits || []).length}`)
  if (!rows.length) { console.log('  записей нет'); continue }
  console.log(таблица(rows, ['круг', 'n', 'замер мед', 'судейство мед', 'показ мед', 'всего мед', 'всего p90']))
}
