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
  computeTargetWeight,
  RATING_GROWTH_PCT,
  BAND_REPS_CAP,
  UNRATED_STOP_AFTER,
  buildAssignedSessionPlan,
} from './src/workoutPrompt.js'
import { roundToPlate, oneRepMax, plateStep } from './src/oneRepMax.js'
import { PROGRAMS_MAP, isOneSidedExercise } from './src/programs.js'

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
// roundToPlate(templateKg * scale.scale, plateStep(rawKg)).
function templateWeights(templateSets, scale) {
  return templateSets.map(ts => {
    if (ts.templateKg == null) return null
    const rawKg = ts.templateKg * scale.scale
    return roundToPlate(rawKg, plateStep(rawKg))
  })
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

console.log('\n── Кейс 10: остановка "слепого" роста без оценки (unratedStreak/forceHold) ──')

// Фейковая история: одна сессия (свой workout_id) на каждый элемент —
// rating:null означает "клиент не оценил", число — реальная оценка. Тот же
// приём, что и fakeHardStreak выше.
function fakeUnratedRows(ratingsSeq) {
  return ratingsSeq.map((rating, i) => ({
    id: i + 1, exercise: 'Приседания', date: `2026-02-${String(i + 1).padStart(2, '0')}`,
    kg: 25, reps: 12, rating, workout_id: i + 1,
  }))
}

{
  // 10а) 1 сессия без оценки — рост как раньше (default 3, +5%), порог ещё не достигнут
  const agg = buildExerciseAggregates(fakeUnratedRows([null]))['Приседания']
  assertEqual('Кейс 10а: 1 сессия без оценки → unratedStreak=1', agg.unratedStreak, 1)
  const progressionStopped = agg.unratedStreak >= 2
  assertEqual('Кейс 10а: порог (2) ещё не достигнут → progressionStopped=false', progressionStopped, false)
  const scale = computeTemplateScale(agg.anchorSet, agg.lastSession.effRatings, squatTemplate, agg.hardStreak, progressionStopped)
  assertClose('Кейс 10а: вес всё ещё растёт (scale ≈ 1.05, угаданная оценка 3)', scale.scale, 1.05)
}
{
  // 10б) 2 сессии подряд без оценки — следующая рекомендация ДЕРЖИТ вес
  const agg = buildExerciseAggregates(fakeUnratedRows([null, null]))['Приседания']
  assertEqual('Кейс 10б: 2 сессии подряд без оценки → unratedStreak=2', agg.unratedStreak, 2)
  const progressionStopped = agg.unratedStreak >= 2
  assertEqual('Кейс 10б: порог достигнут → progressionStopped=true', progressionStopped, true)
  const scale = computeTemplateScale(agg.anchorSet, agg.lastSession.effRatings, squatTemplate, agg.hardStreak, progressionStopped)
  assertClose('Кейс 10б: вес держится (scale ≈ 1.0, forceHold)', scale.scale, 1.0)
  assertEqual('Кейс 10б: appliedPct === 0 при forceHold', scale.appliedPct, 0)
  assertEqual('Кейс 10б: isDeload === false при forceHold', scale.isDeload, false)
}
{
  // 10в) оценка после пропусков обнуляет счётчик, рост возвращается
  const agg = buildExerciseAggregates(fakeUnratedRows([null, null, 1]))['Приседания']
  assertEqual('Кейс 10в: оценка после пропусков → unratedStreak=0', agg.unratedStreak, 0)
  const progressionStopped = agg.unratedStreak >= 2
  const scale = computeTemplateScale(agg.anchorSet, agg.lastSession.effRatings, squatTemplate, agg.hardStreak, progressionStopped)
  assertClose('Кейс 10в: рост возвращается (scale ≈ 1.10, оценка «легко»)', scale.scale, 1.10)
}

console.log('\n── Кейс 11: то же правило остановки на резинках/весе тела ─────────────')

// Та же фейковая история, что и в кейсе 10, но упражнение с резиной —
// bandTemplateSet имитирует ts (распарсенный шаблонный подход СЕГОДНЯШНЕЙ
// сессии), band_level в строках истории не важен для computeProgressSteps
// (тот смотрит только на rating), но нужен для реализма fromSupabase-формы.
function fakeBandRows(ratingsSeq) {
  return ratingsSeq.map((rating, i) => ({
    id: i + 1, exercise: 'Приседания с резиной', date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    kg: null, reps: 15, rating, band_level: 2, workout_id: i + 1,
  }))
}
const bandTemplateSet = { bandLevel: 2, reps: 15 }

{
  // 11а) 1 сессия без оценки — шаги растут как раньше (default 3 → +1 шаг)
  const agg = buildExerciseAggregates(fakeBandRows([null]))['Приседания с резиной']
  assertEqual('Кейс 11а: 1 сессия без оценки → unratedStreak=1', agg.unratedStreak, 1)
  const progressionStopped = agg.unratedStreak >= 2
  assertEqual('Кейс 11а: порог ещё не достигнут → progressionStopped=false', progressionStopped, false)
  assertEqual('Кейс 11а: шаги растут (default оценка 3 → +1)', agg.progressSteps, 1)
  assertDeepEqual('Кейс 11а: bandTarget по agg.progressSteps → {bandLevel:2,reps:17}',
    computeBandTarget(bandTemplateSet, agg.progressSteps), { bandLevel: 2, reps: 17 })
}
{
  // 11б) 2 сессии подряд без оценки — держим на уровне ПОСЛЕ 2 разрешённых
  // приростов (та же семантика, что и у кг-анкера в кейсе 10б), а НЕ
  // откатываем к уровню до серии пропусков. slice(0, length - max(0,
  // unratedStreak-UNRATED_STOP_AFTER)) при unratedStreak===2 берёт ВСЕ
  // сессии — оба неоценённых прироста сохраняются.
  const agg = buildExerciseAggregates(fakeBandRows([null, null]))['Приседания с резиной']
  assertEqual('Кейс 11б: 2 сессии подряд без оценки → unratedStreak=2', agg.unratedStreak, 2)
  const progressionStopped = agg.unratedStreak >= 2
  assertEqual('Кейс 11б: порог достигнут → progressionStopped=true', progressionStopped, true)
  const heldSteps = computeProgressSteps(agg.sessions.slice(0, agg.sessions.length - Math.max(0, agg.unratedStreak - UNRATED_STOP_AFTER)))
  assertEqual('Кейс 11б: heldSteps=2 (оба неоценённых прироста сохранены, не откачены)', heldSteps, 2)
  assertDeepEqual('Кейс 11б: bandTarget держится ПОСЛЕ 2 приростов → {bandLevel:2,reps:19} (не откат к 15)',
    computeBandTarget(bandTemplateSet, heldSteps), { bandLevel: 2, reps: 19 })
}
{
  // 11г) 3 сессии подряд без оценки — заморожено на уровне ПОСЛЕ 2 приростов
  // (то же reps:19, что и в 11б), а не растёт дальше и не откатывается к 0.
  const agg = buildExerciseAggregates(fakeBandRows([null, null, null]))['Приседания с резиной']
  assertEqual('Кейс 11г: 3 сессии подряд без оценки → unratedStreak=3', agg.unratedStreak, 3)
  const heldSteps = computeProgressSteps(agg.sessions.slice(0, agg.sessions.length - Math.max(0, agg.unratedStreak - UNRATED_STOP_AFTER)))
  assertEqual('Кейс 11г: heldSteps=2 (заморожено на уровне после 2 приростов, 3-й не учтён)', heldSteps, 2)
  assertDeepEqual('Кейс 11г: bandTarget та же, что в 11б → {bandLevel:2,reps:19} (не 21)',
    computeBandTarget(bandTemplateSet, heldSteps), { bandLevel: 2, reps: 19 })
}
{
  // 11в) оценка после пропусков обнуляет счётчик, рост возвращается
  const agg = buildExerciseAggregates(fakeBandRows([null, null, 1]))['Приседания с резиной']
  assertEqual('Кейс 11в: оценка после пропусков → unratedStreak=0', agg.unratedStreak, 0)
  assertEqual('Кейс 11в: шаги посчитаны по всей истории (не held) → 4', agg.progressSteps, 4)
  assertDeepEqual('Кейс 11в: bandTarget по agg.progressSteps → {bandLevel:2,reps:23}',
    computeBandTarget(bandTemplateSet, agg.progressSteps), { bandLevel: 2, reps: 23 })
}

console.log('\n── Кейс 12: лёгкие веса — шаг округления 1 кг вместо 2.5 ─────────────')

{
  // plateStep сам по себе: порог ровно 10 — граница ещё "тяжёлая" (2.5),
  // модуль веса учитывается для ассист-тренажёров (отрицательный вес).
  assertEqual('Кейс 12: plateStep(4.4) === 1', plateStep(4.4), 1)
  assertEqual('Кейс 12: plateStep(10) === 2.5 (граница не включена в "лёгкие")', plateStep(10), 2.5)
  assertEqual('Кейс 12: plateStep(9.99) === 1', plateStep(9.99), 1)
  assertEqual('Кейс 12: plateStep(-4.4) === 1 (ассист-тренажёр, по модулю)', plateStep(-4.4), 1)
}

const lightTemplate = parseTemplateSets('4 кг × 20')

{
  // 12а) computeTargetWeight — одиночный подход. rawKg=4×1.10=4.4:
  // шагом 1 → 4, шагом 2.5 (старое поведение) вышло бы 5 — скачок 25%.
  const target = computeTargetWeight({ kg: 4, reps: 20 }, [1, 1], 20, false)
  assertClose('Кейс 12а: rawKg ≈ 4.4', target.rawKg, 4.4)
  assertEqual('Кейс 12а: kg округлён шагом 1 → 4 (не 5)', target.kg, 4)
}
{
  // 12б) весь шаблонный ряд (computeTemplateScale + templateWeights, тот же
  // путь, что и buildAssignedSessionPlan) — тот же результат.
  const scale = computeTemplateScale({ kg: 4, reps: 20 }, [1, 1], lightTemplate, false)
  assertClose('Кейс 12б: scale ≈ 1.10 (рост, оценка «легко»)', scale.scale, 1.10)
  assertArrayEqual('Кейс 12б: вес ряда [4] (шаг 1 кг, не 5)', templateWeights(lightTemplate, scale), [4])
}

console.log('\n── Кейс 13: односторонние упражнения — 1ПМ считается от reps/2 ──────')

{
  // Болгарские выпады с гантелями — реально одностороннее (isOneSidedExercise),
  // повторения в шаблоне/истории записаны суммой на обе стороны.
  assertEqual('Кейс 13: isOneSidedExercise("Болгарские выпады с гантелями") === true', isOneSidedExercise('Болгарские выпады с гантелями'), true)
  assertEqual('Кейс 13: isOneSidedExercise("Приседания") === false', isOneSidedExercise('Приседания'), false)

  // 13а) computeTargetWeight: 12 кг × 16 (сумма на обе ноги) → 1ПМ должен
  // считаться от 8, не от 16. anchorSet.reps=16, targetReps=12 — разные,
  // чтобы деление пополам реально повлияло на итог (при equal reps формула
  // самообратима и разницы не показала бы, см. комментарий computeTargetWeight).
  const withoutOneSided = computeTargetWeight({ kg: 12, reps: 16 }, [3, 3], 12, false, false)
  const withOneSided = computeTargetWeight({ kg: 12, reps: 16 }, [3, 3], 12, false, true)
  assertClose('Кейс 13а: без oneSided — rawKg ≈ 13.8 (1ПМ от 16 повторений)', withoutOneSided.rawKg, 13.8, 0.05)
  assertClose('Кейс 13а: с oneSided — rawKg ≈ 13.3 (1ПМ от 8 повторений, не 16)', withOneSided.rawKg, 13.3, 0.05)

  // 13б) то же через computeTemplateScale (шаблонный ряд) — anchorSet.reps=14
  // (клиент реально сделал 14, не 16 из шаблона), тоже показывает разницу.
  const lungeTemplate = parseTemplateSets('12 кг × 16, 12 кг × 16, 12 кг × 16, 12 кг × 16')
  const scaleFlat = computeTemplateScale({ kg: 12, reps: 14 }, [1, 1], lungeTemplate, false, false, false)
  const scaleOneSided = computeTemplateScale({ kg: 12, reps: 14 }, [1, 1], lungeTemplate, false, false, true)
  assertClose('Кейс 13б: без oneSided — scale ≈ 1.0522', scaleFlat.scale, 1.0522, 0.001)
  assertClose('Кейс 13б: с oneSided — scale ≈ 1.0711 (не совпадает с не-oneSided)', scaleOneSided.scale, 1.0711, 0.001)
}

console.log('\n── Кейс 14: потолок повторений резины/веса тела (BAND_REPS_CAP) ─────')

{
  assertEqual('Кейс 14: BAND_REPS_CAP === 30', BAND_REPS_CAP, 30)

  // 14а) вес тела (bandLevel:null) — без потолка ушло бы в 20+20×2=60
  const bodyweight = computeBandTarget({ bandLevel: null, reps: 20 }, 20)
  assertDeepEqual('Кейс 14а: вес тела при больших steps → reps упирается в потолок 30', bodyweight, { bandLevel: null, reps: 30 })

  // 14б) резина — без потолка ушло бы в 15+6×5×2=75, уровень при этом
  // всё равно поднимается до максимума (5) как и раньше, ограничены только повторения.
  const banded = computeBandTarget({ bandLevel: 1, reps: 15 }, 50)
  assertDeepEqual('Кейс 14б: резина при больших steps → уровень 5, повторения упираются в потолок 30', banded, { bandLevel: 5, reps: 30 })
}

console.log('\n── Кейс 16: остановка кг-роста без оценки — теперь и в buildAssignedSessionPlan ──')

{
  // 16а) 1 сессия без оценки — buildAssignedSessionPlan всё ещё растит вес
  // (progressionStopped=false, тот же scale≈1.05, что и в кейсе 10а).
  const agg1 = buildExerciseAggregates(fakeUnratedRows([null]))
  const plan1 = buildAssignedSessionPlan(PROGRAMS_MAP['Full Body'], 0, agg1)
  const squat1 = plan1.exercises.find(e => e.name === 'Приседания')
  assertArrayEqual('Кейс 16а: 1 сессия без оценки — вес всё ещё растёт [20, 27.5, 27.5, 27.5]', squat1.sets.map(s => s.kg), [20, 27.5, 27.5, 27.5])
}
{
  // 16б) 2 сессии подряд без оценки — раньше buildAssignedSessionPlan вообще
  // не применял остановку (растил бы дальше вслепую) — теперь держит на
  // анкере, так же как runStartSlotWorkout в App.jsx (кейс 10б).
  const agg2 = buildExerciseAggregates(fakeUnratedRows([null, null]))
  const plan2 = buildAssignedSessionPlan(PROGRAMS_MAP['Full Body'], 0, agg2)
  const squat2 = plan2.exercises.find(e => e.name === 'Приседания')
  assertArrayEqual('Кейс 16б: 2 сессии подряд без оценки — вес держится на анкере [20, 25, 25, 25]', squat2.sets.map(s => s.kg), [20, 25, 25, 25])
}

console.log(`\nИтого: ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
