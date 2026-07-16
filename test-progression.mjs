// test-progression.mjs — точечный регрессионный тест математики движка
// прогрессии. Импортирует РЕАЛЬНЫЕ функции из src/workoutPrompt.js,
// src/oneRepMax.js, src/programs.js (ничего не мокается) и сверяет их вывод
// с эталонными числами, посчитанными вручную, отдельно от кода. Не путать с
// test-progression-personas.js — тот гоняет движок через сквозные AI-сценарии,
// этот — только саму формулу, без сети/API, быстро и детерминированно.

import {
  parseTemplateSets,
  buildExerciseAggregates,
  computeTemplateScale,
  computeProgressSteps,
  computeBandTarget,
  computeHardStreak,
  RATING_GROWTH_PCT,
  buildAssignedSessionPlan,
} from './src/workoutPrompt.js'
import { roundToPlate, oneRepMax } from './src/oneRepMax.js'
import { PROGRAMS_MAP } from './src/programs.js'

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = actual === expected
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}
function assertClose(label, actual, expected, eps = 1e-6) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) < eps
  report(label, ok, ok ? '' : `ожидалось ≈${expected}, получено ${actual}`)
}
function assertArrayEqual(label, actual, expected) {
  const ok = Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((v, i) => v === expected[i])
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}
function assertDeepEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

// Веса ряда по шаблону — ровно то же вычисление, что делает приложение
// (buildAssignedSessionPlan): для каждого весового подхода шаблона
// roundToPlate(templateKg * scale.scale).
function templateWeights(templateSets, scale) {
  return templateSets.map(ts => ts.templateKg == null ? null : roundToPlate(ts.templateKg * scale.scale))
}

console.log('── Кейсы 1-3: рост/откат по оценке (Приседания Full Body) ────────')

const squatTemplate = parseTemplateSets('20 кг × 15, 25 кг × 12, 25 кг × 12, 25 кг × 12')

// Опорное 1ПМ (25кг × 12 по формуле Эпли = 35) — независимая сверка того
// промежуточного числа, от которого считаются все scale ниже.
assertClose('База: oneRepMax(25, 12) = 35', oneRepMax(25, 12), 35)

{
  // 1) РОСТ, оценка «легко»
  const scale = computeTemplateScale({ kg: 25, reps: 12 }, [1, 1], squatTemplate, false)
  assertClose('Кейс 1: scale ≈ 1.10 (рост, оценка «легко»)', scale.scale, 1.10)
  assertEqual('Кейс 1: appliedPct === RATING_GROWTH_PCT[1]', scale.appliedPct, RATING_GROWTH_PCT[1])
  assertArrayEqual('Кейс 1: веса ряда [22.5, 27.5, 27.5, 27.5]', templateWeights(squatTemplate, scale), [22.5, 27.5, 27.5, 27.5])
}
{
  // 2) РОСТ, нейтральная оценка
  const scale = computeTemplateScale({ kg: 25, reps: 12 }, [3, 3], squatTemplate, false)
  assertClose('Кейс 2: scale ≈ 1.05 (рост, нейтральная оценка)', scale.scale, 1.05)
  assertEqual('Кейс 2: appliedPct === RATING_GROWTH_PCT[3]', scale.appliedPct, RATING_GROWTH_PCT[3])
  assertArrayEqual('Кейс 2: веса ряда [20, 27.5, 27.5, 27.5]', templateWeights(squatTemplate, scale), [20, 27.5, 27.5, 27.5])
}
{
  // 3) ОТКАТ
  const scale = computeTemplateScale({ kg: 25, reps: 12 }, [5, 5], squatTemplate, true)
  assertClose('Кейс 3: scale ≈ 0.85 (откат)', scale.scale, 0.85)
  assertEqual('Кейс 3: appliedPct === -15 (фиксированный откат, не из таблицы)', scale.appliedPct, -15)
  assertArrayEqual('Кейс 3: веса ряда [17.5, 22.5, 22.5, 22.5]', templateWeights(squatTemplate, scale), [17.5, 22.5, 22.5, 22.5])
}

console.log('\n── Кейс 4: логика отката (computeHardStreak через реальную историю) ──')

// Строит фейковую историю workout_sets: одна сессия (свой workout_id) на
// каждую оценку в последовательности — buildExerciseAggregates собирает
// sessions тем же путём, что и из настоящей таблицы (группировка по
// workout_id, сортировка по id).
function fakeHardStreak(ratingsSeq) {
  const rows = ratingsSeq.map((rating, i) => ({
    id: i + 1, exercise: 'Приседания', date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    kg: 25, reps: 12, rating, workout_id: i + 1,
  }))
  const agg = buildExerciseAggregates(rows)
  return agg['Приседания'].hardStreak
}

for (const { seq, expected } of [
  { seq: [5, 5], expected: true },
  { seq: [4, 4], expected: true },
  { seq: [3, 5, 5], expected: true },
  { seq: [5, 3, 5, 5], expected: true },
  { seq: [5, 5, 5], expected: false },
]) {
  assertEqual(`Кейс 4: computeHardStreak по оценкам [${seq}] → ${expected}`, fakeHardStreak(seq), expected)
}

console.log('\n── Кейс 5: резинки — шаги и computeBandTarget ─────────────────────')

for (const { seq, expected } of [
  { seq: [1], expected: 2 },
  { seq: [1, 1], expected: 4 },
  { seq: [3, 3, 3], expected: 3 },
  { seq: [5, 5], expected: 0 },
  { seq: [1, 1, 1], expected: 6 },
]) {
  const sessions = seq.map(rating => ({ effRatings: [rating] }))
  assertEqual(`Кейс 5: computeProgressSteps([${seq}]) → ${expected}`, computeProgressSteps(sessions), expected)
}

assertDeepEqual('Кейс 5: computeBandTarget({bandLevel:1,reps:15}, 6) → {bandLevel:2,reps:17}',
  computeBandTarget({ bandLevel: 1, reps: 15 }, 6), { bandLevel: 2, reps: 17 })
assertDeepEqual('Кейс 5: computeBandTarget({bandLevel:null,reps:20}, 3) → {bandLevel:null,reps:26}',
  computeBandTarget({ bandLevel: null, reps: 20 }, 3), { bandLevel: null, reps: 26 })
assertDeepEqual('Кейс 5: computeBandTarget({bandLevel:5,reps:15}, 6) → {bandLevel:5,reps:27} (переполнение уровня в повторения)',
  computeBandTarget({ bandLevel: 5, reps: 15 }, 6), { bandLevel: 5, reps: 27 })

console.log('\n── Кейс 6: ассист-тренажёр (гравитрон) — рост и откат в обе стороны ──')

const assistTemplate = parseTemplateSets('-39 кг × 12, -39 кг × 12, -39 кг × 12, -39 кг × 12')

// -39 × 1.4 = -54.6 — та же сверка для ассист-тренажёра (отрицательный вес
// компенсации, формула Эпли работает и с отрицательным весом как есть).
assertClose('База: oneRepMax(-39, 12) = -54.6', oneRepMax(-39, 12), -54.6)

{
  // 6) рост, «легко» — помощи МЕНЬШЕ (клиент сильнее), вес идёт к нулю
  const scale = computeTemplateScale({ kg: -39, reps: 12 }, [1, 1], assistTemplate, false)
  assertClose('Кейс 6: scale ≈ 0.90 (ассист, рост, «легко»)', scale.scale, 0.90)
  assertArrayEqual('Кейс 6: веса ряда [-35, -35, -35, -35]', templateWeights(assistTemplate, scale), [-35, -35, -35, -35])
}
{
  // 6b) откат — помощи БОЛЬШЕ (разгрузка), инверсия в другую сторону
  const scale = computeTemplateScale({ kg: -39, reps: 12 }, [5, 5], assistTemplate, true)
  assertClose('Кейс 6b: scale ≈ 1.15 (ассист, откат)', scale.scale, 1.15)
  assertArrayEqual('Кейс 6b: веса ряда [-45, -45, -45, -45]', templateWeights(assistTemplate, scale), [-45, -45, -45, -45])
}

console.log('\n── Кейс 7: холодный старт (нет истории) ────────────────────────────')

{
  const plan = buildAssignedSessionPlan(PROGRAMS_MAP['Full Body'], 0, {})
  const squat = plan.exercises.find(e => e.name === 'Приседания')
  assertArrayEqual('Кейс 7: холодный старт — веса из шаблона [20, 25, 25, 25]', squat.sets.map(s => s.kg), [20, 25, 25, 25])
  assertArrayEqual('Кейс 7: холодный старт — повторения [15, 12, 12, 12]', squat.sets.map(s => s.reps), [15, 12, 12, 12])
  assertEqual('Кейс 7: все подходы помечены coldStart=true', squat.sets.every(s => s.coldStart === true), true)
}

console.log('\n── Кейс 8: «повторения всегда из шаблона» (не из истории) ──────────')

{
  // Тот же кейс 1 (рост, «легко»), но anchorSet.reps=8 вместо 12 — через
  // buildAssignedSessionPlan (реальную сборку сессии), а не через ручной
  // computeTemplateScale, чтобы проверить именно то место, где могла бы
  // просочиться история: reps на выходе там всегда из ts.reps (сегодняшний
  // шаблон), agg.anchorSet.reps на итоговые повторения не влияет вообще.
  const aggregates = { 'Приседания': { anchorSet: { kg: 25, reps: 8 }, lastSession: { effRatings: [1, 1] }, hardStreak: false } }
  const plan = buildAssignedSessionPlan(PROGRAMS_MAP['Full Body'], 0, aggregates)
  const squat = plan.exercises.find(e => e.name === 'Приседания')
  assertArrayEqual('Кейс 8: повторения ряда остались [15, 12, 12, 12], несмотря на anchorSet.reps=8', squat.sets.map(s => s.reps), [15, 12, 12, 12])
}

console.log('\n── Кейс 9: откат на резинках (симметрично кг-оси) ──────────────────')

{
  const sessions = [1, 1, 5, 5].map(rating => ({ effRatings: [rating] }))
  assertEqual('Кейс 9: computeProgressSteps([1,1,5,5]) → 2 (две лёгкие +4, откат -2)', computeProgressSteps(sessions), 2)
}

console.log(`\nИтого: ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
