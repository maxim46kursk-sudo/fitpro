// Прогон 1ПМ-движка прогрессии (src/workoutPrompt.js) на 5 виртуальных
// женских персонах через 8 циклов подряд, с Excel-отчётом по росту веса.
//
// АРХИТЕКТУРА ТЕСТА (важно): в FitPro программа — это ФИКСИРОВАННЫЙ шаблон
// (см. PROGRAMS_MAP в src/programs.js): состав упражнений, их порядок и
// число повторений на подход заданы шаблоном сессии и НЕ меняются между
// занятиями. Пересчитывается на каждое занятие только рабочий ВЕС — 1ПМ-
// движком по формуле Эпли и таблице процентов роста {10,7,5,3,2}. Поэтому
// здесь для каждой персоны ОДИН раз выбирается конкретный слот программы
// (persona.sessionIndex) и передаётся в buildAssignedSessionPlan КАК
// КОНСТАНТА на все 8 циклов — сам индекс сессии никогда не увеличивается.
// Меняется только накопленная история (sets), от которой пересчитывается
// вес. Состав/порядок/повторы одинаковы каждый цикл ПО ПОСТРОЕНИЮ (не
// только по проверке) — плюс отдельный тест-кейс ниже подтверждает это
// фактически по записанным данным, как защита от регрессии старого бага.
//
// 8 циклов прогрессии считаются НАПРЯМУЮ через реальный движок
// (buildAssignedSessionPlan/buildExerciseAggregates из src/workoutPrompt.js —
// та же математика, что использует Конструктор), а не копией расчётов —
// иначе тест не ловил бы регрессии в самом движке. С переходом AI-чата в
// режим консультанта (см. workoutPrompt.js — buildWorkoutSystemPrompt больше
// не составляет программы и не выдаёт SET_PROGRAM) здесь больше нет вызовов
// Claude вообще: движок тестируется напрямую, без сети и без API-ключа.
//
// Запуск: node test-progression-personas.js

import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import ExcelJS from 'exceljs'
import { createClient } from '@supabase/supabase-js'
import { buildAssignedSessionPlan, buildExerciseAggregates, computeTargetWeight, RATING_GROWTH_PCT } from './src/workoutPrompt.js'
import { oneRepMax } from './src/oneRepMax.js'
import { PROGRAMS_MAP } from './src/programs.js'
import { findSimilarExercise } from './src/fuzzyMatch.js'

function loadEnv() {
  try {
    const text = readFileSync(new URL('./.env', import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* .env может отсутствовать в CI — тогда переменные должны быть в env */ }
}
loadEnv()

const CYCLES = 8
const TODAY = new Date().toISOString().slice(0, 10)
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

// ─────────────────────────────────────────────────────────────────────────
// Блок 2: флоу Конструктора через реальные таблицы Supabase (constructor_
// exercises/constructor_sets), под настоящим аутентифицированным клиентом
// (RLS проверяется по-настоящему, не в обход) — см. CONSTRUCTOR_TEST_EMAIL/
// CONSTRUCTOR_TEST_PASSWORD в .env. Префикс "ТЕСТ-ФЛОУ:" у всех созданных
// здесь упражнений — чтобы их можно было надёжно найти и удалить в cleanup,
// не задев ничего, что реально есть у этого аккаунта.
// ─────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://kybazlnscyzfrrafggxe.supabase.co'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'sb_publishable_8E9Baxz1q-rKOiV8-jbXtw_DIGOztMg'
const TEST_PREFIX = 'ТЕСТ-ФЛОУ:'

// ─────────────────────────────────────────────────────────────────────────
// Персоны
// ─────────────────────────────────────────────────────────────────────────
const PERSONAS = [
  {
    key: 'novice_home', name: 'Алина', age: 25, level: 'Новичок',
    description: 'Никогда не тренировалась, домашние тренировки без инвентаря',
    program: 'Домашние тренировки', sessionIndex: 0, // слот 1 программы: без единого кг-веса (см. тест-кейс "без инвентаря")
    // Новичок — разброс оценок по упражнениям, ещё не чувствует своё тело
    // стабильно (но сам набор упражнений от цикла к циклу не меняется).
    ratingFn: (cycle, exIdx) => [2, 4, 1, 3, 5, 2, 3, 4][(cycle - 1 + exIdx) % 8],
  },
  {
    key: 'beginner_glutes', name: 'Марина', age: 32, level: 'Начальный',
    description: 'В зале, фокус на ягодицах, немного боится тяжёлых весов',
    program: 'Похудение', sessionIndex: 0,
    // Консервативные оценки, отдельные упражнения ощущаются тяжелее — но
    // какие именно упражнения тяжелее, стабильно по номеру в шаблоне,
    // раз состав фиксирован.
    ratingFn: (cycle, exIdx) => (exIdx % 3 === 0 ? 4 : (cycle % 2 === 0 ? 3 : 2)),
  },
  {
    key: 'intermediate_squat', name: 'Ольга', age: 28, level: 'Средний',
    description: 'В зале уже год, хочет прогресс в приседе и тяге',
    program: 'Full Body', sessionIndex: 0, // слот 1: Приседания первым упражнением
    ratingFn: (cycle, exIdx) => (exIdx === 0 ? 3 : 2),
  },
  {
    key: 'intermediate_recovery', name: 'Наталья', age: 40, level: 'Средний',
    description: 'В зале, восстановление формы после перерыва',
    program: 'Full Body', sessionIndex: 0, // тот же слот 1, Приседания — упражнение с форс-откатом
    // Специально для проверки отката: на "Приседания" (первое упражнение слота)
    // 3 тяжёлых рейтинга подряд (циклы 1-3, 4-5). Механика buildDeload:
    // сигнал требует, чтобы последние ДВЕ записанные сессии упражнения были
    // тяжёлыми — при ratings=[4,5,4,...] это выполняется дважды подряд:
    // (цикл1,цикл2) оба ≥4 → откат применяется к циклу 3; затем
    // (цикл2,цикл3) тоже оба ≥4 → откат применяется ЕЩЁ и к циклу 4. С цикла 4
    // рейтинг падает до 3 — откат перестаёт требоваться, дальше обычный рост.
    // Остальные упражнения — ровный средний рейтинг, чтобы не путать сигнал.
    ratingFn: (cycle, exIdx, exName) => (exName === 'Приседания' ? [4, 5, 4, 3, 3, 3, 3, 3][cycle - 1] : 3),
  },
  {
    key: 'advanced', name: 'Виктория', age: 35, level: 'Продолжающий',
    description: 'Стабильно прогрессирует, высокая работоспособность',
    program: 'Сплит', sessionIndex: 1, // слот 2 "Сплита" — включает гравитрон (отрицательный вес, известный краевой случай)
    // Стабильно низкий рейтинг на всех упражнениях — контрольный случай
    // непрерывного роста без единого отката за все 8 циклов.
    ratingFn: () => 2,
  },
]

// ─────────────────────────────────────────────────────────────────────────
// Персоны Конструктора — те же 5 личностей, но каждая проходит один
// конкретный сценарий флоу Конструктора (создание упражнения → 8 сессий с
// реальными вставками в constructor_exercises/constructor_sets), а не общую
// программу тренировки. Марина — не обычный прогресс, а отдельная проверка
// "вес привязан к exercise_id, а не к тексту" (см. runDuplicateNameFlow).
// ─────────────────────────────────────────────────────────────────────────
const CONSTRUCTOR_PERSONAS = [
  {
    name: 'Алина', purpose: 'Обычная прогрессия (контроль)',
    exerciseName: `${TEST_PREFIX} Приседания (Алина)`,
    baseline: { kg: 10, reps: 15 },
    // Ровный средний рейтинг — чистая проверка "рекомендация со 2-й сессии".
    ratingFn: () => 3,
  },
  {
    name: 'Ольга', purpose: 'Обычная прогрессия (контроль)',
    exerciseName: `${TEST_PREFIX} Тяга нижнего блока (Ольга)`,
    baseline: { kg: 20, reps: 12 },
    ratingFn: (session) => (session % 2 === 0 ? 2 : 3),
  },
  {
    name: 'Наталья', purpose: 'Откат: 2 подряд тяжёлых оценки',
    exerciseName: `${TEST_PREFIX} Жим ногами (Наталья)`,
    baseline: { kg: 40, reps: 12 },
    // Тот же паттерн, что и в движковом тесте: циклы 1-2 оба ≥4 → откат на
    // сессию 3; циклы 2-3 оба ≥4 → откат ещё и на сессию 4; дальше ровно.
    ratingFn: (session) => [4, 5, 4, 3, 3, 3, 3, 3][session - 1],
  },
  {
    name: 'Виктория', purpose: 'Ассистирующий тренажёр (гравитрон) → к нулю',
    exerciseName: `${TEST_PREFIX} Гравитрон (Виктория)`,
    baseline: { kg: -39, reps: 12 }, // отрицательный вес = кг компенсации тренажёра
    ratingFn: () => 2, // стабильно легко — рост означает движение к нулю без откатов
  },
]

// ─────────────────────────────────────────────────────────────────────────
// Один живой сценарий Конструктора для персоны — ТОЧНО тот же путь, что
// проходит ConstructorView (App.jsx): создать упражнение → на каждой сессии
// сначала прочитать историю подходов из constructor_sets ПО exercise_id,
// собрать движок (buildExerciseAggregates/computeTargetWeight) ровно как
// openExercise/saveSet там, и только потом писать новый подход. Никакого
// локального дублирования состояния между сессиями — каждая сессия читает
// то, что реально лежит в БД после предыдущей записи.
// ─────────────────────────────────────────────────────────────────────────
async function runConstructorFlowPersona(supabase, userId, persona) {
  const { data: created, error: createErr } = await supabase.from('constructor_exercises')
    .insert({ user_id: userId, name: persona.exerciseName }).select('*').single()
  if (createErr) throw new Error(`[${persona.name}] создание упражнения: ${createErr.message}`)
  const exerciseId = created.id

  const sessionsLog = []
  for (let session = 1; session <= CYCLES; session++) {
    const { data: history, error: histErr } = await supabase.from('constructor_sets')
      .select('*').eq('exercise_id', exerciseId).eq('user_id', userId).order('id')
    if (histErr) throw new Error(`[${persona.name}] чтение истории сессии ${session}: ${histErr.message}`)

    // Точно как ConstructorView.engineSets — ключ агрегации exercise: String(id), не название.
    const engineSets = (history || []).map(s => ({ id: s.id, exercise: String(exerciseId), date: s.date, kg: s.kg, reps: s.reps, rating: s.rating }))
    const aggregates = buildExerciseAggregates(engineSets)
    const agg = aggregates[String(exerciseId)]
    const isBaseline = !agg || !agg.anchorSet

    let recommendation = null
    let targetReps = persona.baseline.reps
    if (!isBaseline) {
      const lastDaySets = agg.lastSession.sets
      targetReps = lastDaySets[lastDaySets.length - 1].reps
      recommendation = computeTargetWeight(agg.anchorSet, agg.lastSession.effRatings, targetReps, agg.deload)
    }

    const date = addDays(TODAY, (session - 1) * 3)
    const rating = Math.min(5, Math.max(1, Math.round(persona.ratingFn(session))))
    // Сессия 1 — стартовый замер: клиент сам задаёт вес/повторы (см. isBaseline
    // в ConstructorView). Дальше клиент выполняет ровно ту рекомендацию,
    // которую показал Конструктор (форма там предзаполняется recommendation.kg).
    const kgToRecord = session === 1 ? persona.baseline.kg : (recommendation ? recommendation.kg : persona.baseline.kg)
    const repsToRecord = session === 1 ? persona.baseline.reps : targetReps

    const { data: savedSet, error: insErr } = await supabase.from('constructor_sets').insert({
      user_id: userId, exercise_id: exerciseId, date, kg: kgToRecord, reps: repsToRecord, rating,
    }).select('*').single()
    if (insErr) throw new Error(`[${persona.name}] запись подхода сессии ${session}: ${insErr.message}`)

    sessionsLog.push({
      session, date, isBaseline, recommendation,
      kgRecorded: kgToRecord, repsRecorded: repsToRecord, rating,
      isDeload: recommendation?.isDeload || false,
      appliedPct: recommendation?.appliedPct ?? null,
      setId: savedSet.id,
    })
  }

  return { persona, exerciseId, sessionsLog }
}

// ─────────────────────────────────────────────────────────────────────────
// Проверка "вес привязан к exercise_id, а не к тексту": две записи в
// constructor_exercises с ОДИНАКОВЫМ названием (как если бы клиент
// проигнорировал мягкое предупреждение о дубле, см. fuzzyMatch.js), но
// разными id и разными траекториями оценок. Если бы движок агрегировал по
// названию, а не по id, их истории/рекомендации слились бы в одну — здесь
// проверяем, что этого не происходит: обе линии считаются независимо, и на
// БД-уровне подходы каждого id физически не видны для другого.
// ─────────────────────────────────────────────────────────────────────────
async function runDuplicateNameFlow(supabase, userId) {
  const sharedName = `${TEST_PREFIX} Жим гантелей (дубль по названию)`
  // Вес взят достаточно большим (40кг, а не лёгкий гантельный), чтобы
  // расхождение траекторий было видно даже ПОСЛЕ округления до шага
  // "блинов" (roundToPlate) — на лёгких весах шаг округления иногда
  // схлопывает разные по сути траектории в одно и то же отображаемое число
  // (см. rawKg — он в любом случае разный и даже это не обязательно для
  // вывода, т.к. паттерн отката ниже расходится однозначно).
  const personaA = { name: 'Марина-A', purpose: 'дубль по имени, ветка A (лёгкие оценки — рост)', exerciseName: sharedName, baseline: { kg: 40, reps: 12 }, ratingFn: () => 2 }
  const personaB = { name: 'Марина-B', purpose: 'дубль по имени, ветка B (тяжёлые оценки — откат)', exerciseName: sharedName, baseline: { kg: 40, reps: 12 }, ratingFn: () => 5 }

  const resA = await runConstructorFlowPersona(supabase, userId, personaA)
  const resB = await runConstructorFlowPersona(supabase, userId, personaB)

  const { data: setsA } = await supabase.from('constructor_sets').select('id').eq('exercise_id', resA.exerciseId).eq('user_id', userId)
  const { data: setsB } = await supabase.from('constructor_sets').select('id').eq('exercise_id', resB.exerciseId).eq('user_id', userId)

  const lastA = resA.sessionsLog[resA.sessionsLog.length - 1]
  const lastB = resB.sessionsLog[resB.sessionsLog.length - 1]
  // Расхождение проверяем и по итоговому весу, и по паттерну отката — вес
  // может теоретически совпасть после округления до шага "блинов" на
  // некоторых весах, а вот "ни разу не откатилась" (A, ровные лёгкие оценки)
  // против "откатывается с 3-й сессии" (B, ровные тяжёлые оценки) — это
  // структурно разные траектории, которые невозможно получить из общей,
  // слитой по названию истории.
  const deloadPatternA = resA.sessionsLog.map(s => s.isDeload).join(',')
  const deloadPatternB = resB.sessionsLog.map(s => s.isDeload).join(',')

  return {
    resA, resB,
    isolationOk: (setsA || []).length === CYCLES && (setsB || []).length === CYCLES,
    setsCountA: (setsA || []).length, setsCountB: (setsB || []).length,
    diverged: lastA.kgRecorded !== lastB.kgRecorded || deloadPatternA !== deloadPatternB,
    lastKgA: lastA.kgRecorded, lastKgB: lastB.kgRecorded,
    deloadPatternA, deloadPatternB,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Симуляция одной персоны: 8 циклов прогрессии через движок
// ─────────────────────────────────────────────────────────────────────────
function simulatePersona(persona) {
  const programTemplate = PROGRAMS_MAP[persona.program]
  const sets = []
  let nextId = 1
  // Фиксированный слот программы — та самая "константа" из архитектуры
  // приложения (см. заголовок файла): передаётся в buildAssignedSessionPlan
  // НЕИЗМЕННОЙ на все 8 циклов, поэтому состав/порядок/повторы гарантированно
  // одинаковы каждый раз, а меняется только вес, посчитанный от накопленной
  // истории (sets).
  const sessionIndex = persona.sessionIndex

  // ── 8 циклов прогрессии — строго через реальный движок, один и тот же
  // слот шаблона каждый раз ──
  const cycles = []
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const aggregates = buildExerciseAggregates(sets)
    const plan = buildAssignedSessionPlan(programTemplate, sessionIndex, aggregates)
    const date = addDays(TODAY, (cycle - 1) * 3)
    const cycleLog = { cycle, date, sessionNum: plan.sessionNum, tonnage: 0, exercises: [] }

    plan.exercises.forEach((ex, exIdx) => {
      if (!ex.sets.length) return
      const agg = aggregates[ex.name]
      const deloadSignal = !!agg?.deload
      const rating = Math.min(5, Math.max(1, Math.round(persona.ratingFn(cycle, exIdx, ex.name))))
      const setLogs = []
      ex.sets.forEach((s, si) => {
        const isWorking = si >= ex.sets.length - 2
        const setRating = isWorking ? rating : null
        sets.push({ id: nextId++, exercise: ex.name, date, kg: s.kg, reps: s.reps, rating: setRating })
        setLogs.push({ reps: s.reps, kg: s.kg, hasWeight: s.hasWeight, rating: setRating, isWorking, coldStart: s.coldStart, isDeload: s.isDeload, appliedPct: s.appliedPct })
        // Ассистирующие тренажёры (отрицательный вес = кг компенсации, не
        // поднятый вес) НЕ считаются в тоннаж — это не "выполненная работа" в
        // обычном смысле, а мера того, сколько тренажёр помог. Ни раздувать
        // тоннаж их модулем, ни вычитать их из тоннажа как отрицательную
        // работу (было раньше — s.kg отрицательный уменьшал сумму) неверно;
        // помечено отдельно в отчёте (см. Sheet2 и Sheet4).
        if (s.kg && s.kg > 0) cycleLog.tonnage += s.kg * s.reps
      })
      cycleLog.exercises.push({ name: ex.name, sets: setLogs, deloadSignal, rating })
    })

    cycles.push(cycleLog)
  }

  return { persona, cycles, finalSets: sets }
}

// ─────────────────────────────────────────────────────────────────────────
// Тест-кейсы (детерминированные проверки на уже посчитанных данных)
// ─────────────────────────────────────────────────────────────────────────
function buildTestCases(results) {
  const rows = []
  const push = (name, personaName, expected, actual, pass) => rows.push({ name, persona: personaName, expected: String(expected), actual: String(actual), pass })

  for (const { persona, cycles } of results) {
    // 0) НОВОЕ: состав упражнений (имена, порядок, повторы на подход)
    // идентичен во всех 8 циклах — единственное, что должно меняться между
    // циклами, это рабочий вес. Это защита от регрессии старого бага теста,
    // когда каждый цикл получал новый набор упражнений через ротацию слотов
    // шаблона (тоннаж между циклами тогда был несравним). Вес намеренно
    // исключён из сигнатуры сравнения — сравниваем только имя+повторы.
    const sessionSignature = (c) => c.exercises.map(ex => `${ex.name}[${ex.sets.map(s => s.reps).join(',')}]`).join('|')
    const baseSignature = sessionSignature(cycles[0])
    const compositionDrift = cycles.slice(1).filter(c => sessionSignature(c) !== baseSignature).map(c => `цикл ${c.cycle}`)
    push('Состав упражнений (имена, порядок, повторы) идентичен во всех 8 циклах', persona.name,
      'состав не меняется ни разу, меняется только вес',
      compositionDrift.length ? `состав изменился в: ${compositionDrift.join(', ')}` : 'состав не меняется ни разу, меняется только вес',
      compositionDrift.length === 0)

    // 1) 1ПМ на рабочем подходе каждого упражнения не падает от одного его
    // появления к следующему, если между ними не сработал откат. Состав
    // теперь фиксирован (см. тест-кейс 0), поэтому повторы у одного и того же
    // упражнения всегда одинаковы между циклами — сравнение через 1ПМ здесь
    // формально эквивалентно сравнению сырых кг, но оставлено через 1ПМ как
    // более общий и принципиальный инвариант движка (не завязанный на
    // случайное совпадение повторов). Отрицательный вес (ассистирующие
    // тренажёры типа гравитрона) исключён отсюда — для него отдельная
    // проверка ниже, направление там противоположное.
    const lastSeenByExercise = {} // exercise -> {cycle, rm, isDeload}
    let growthOk = true
    const growthFails = []
    for (const c of cycles) {
      for (const ex of c.exercises) {
        const working = ex.sets.filter(s => s.isWorking && s.hasWeight && s.kg > 0)
        if (!working.length) continue
        const rep = working.reduce((best, s) => oneRepMax(s.kg, s.reps) > oneRepMax(best.kg, best.reps) ? s : best)
        const rm = oneRepMax(rep.kg, rep.reps)
        const isDeload = working.some(s => s.isDeload)
        const prev = lastSeenByExercise[ex.name]
        // Допуск 3кг — это НЕ смягчение теста "на всякий случай", а прямое
        // следствие округления рабочего веса до шага 2.5кг (roundToPlate,
        // "как в зале"): на лёгких весах (гантели 3-10кг) сам процент роста
        // (2-10%) может быть меньше половины шага округления, и итоговое
        // округлённое число иногда оказывается на 1 шаг ниже предыдущего,
        // хотя внутренний непрокруглённый 1ПМ реально вырос. Без этого
        // допуска тест ловил бы не баг, а нормальную дискретизацию весов.
        const ROUNDING_TOLERANCE_KG = 3
        if (prev && !isDeload && rm < prev.rm - ROUNDING_TOLERANCE_KG) {
          growthOk = false
          growthFails.push(`${ex.name}: цикл ${prev.cycle}→${c.cycle} 1ПМ ${prev.rm.toFixed(1)}→${rm.toFixed(1)}кг упал больше чем на шаг округления без отката`)
        }
        lastSeenByExercise[ex.name] = { cycle: c.cycle, rm, isDeload }
      }
    }
    push('1ПМ рабочего подхода не падает между появлениями упражнения (кроме отката)', persona.name,
      '1ПМ не падает нигде, кроме циклов с откатом', growthOk ? '1ПМ не падает нигде, кроме циклов с откатом' : growthFails.join('; '), growthOk)

    // 1б) Ассистирующие тренажёры (отрицательный вес = кг компенсации, не
    // поднятый вес — см. computeTargetWeight в src/workoutPrompt.js):
    // прогресс означает, что число ПРИБЛИЖАЕТСЯ к нулю (меньше помощи от
    // тренажёра), а не уходит дальше в минус. Направление роста для
    // отрицательного анкера теперь инвертировано в движке — здесь проверяем
    // обе стороны: без отката помощь должна убывать по модулю (число растёт
    // к 0), а ПРИ отката — наоборот увеличиваться по модулю (число падает
    // дальше в минус, это и есть "разгрузка" для ассист-упражнения).
    const lastSeenAssisted = {}
    let assistedOk = true
    const assistedFails = []
    for (const c of cycles) {
      for (const ex of c.exercises) {
        const working = ex.sets.filter(s => s.isWorking && s.hasWeight && s.kg < 0)
        if (!working.length) continue
        const kg = working[working.length - 1].kg
        const isDeload = working.some(s => s.isDeload)
        const prev = lastSeenAssisted[ex.name]
        if (prev) {
          if (!isDeload && kg < prev.kg) {
            assistedOk = false
            assistedFails.push(`${ex.name}: цикл ${prev.cycle}→${c.cycle} помощь ${prev.kg}→${kg}кг ушла дальше в минус вместо приближения к 0`)
          }
          if (isDeload && kg > prev.kg) {
            assistedOk = false
            assistedFails.push(`${ex.name}: цикл ${prev.cycle}→${c.cycle} ОТКАТ должен увеличить помощь (уйти дальше в минус), а помощь ${prev.kg}→${kg}кг вместо этого уменьшилась`)
          }
        }
        lastSeenAssisted[ex.name] = { cycle: c.cycle, kg, isDeload }
      }
    }
    const hasAssisted = Object.keys(lastSeenAssisted).length > 0
    push('Ассистирующие тренажёры (отрицательный вес): рост → помощь к нулю, откат → помощь в минус', persona.name,
      'без отката помощь уменьшается (число растёт к 0); при откате помощь растёт (число падает)',
      !hasAssisted ? 'н/п — в программе персоны нет таких упражнений' : (assistedOk ? 'без отката помощь уменьшается (число растёт к 0); при откате помощь растёт (число падает)' : assistedFails.join('; ')),
      !hasAssisted || assistedOk)

    // 2а) Откат срабатывает ТОЛЬКО после 2 подряд высоких рейтингов усилия
    // (проверяем причину каждого реально сработавшего сигнала — это "если
    // сработал, то причина верна", одна сторона импликации).
    const seenRatingsByExercise = {} // exercise -> [ratings in order of occurrence]
    let deloadCauseOk = true
    const deloadCauseDetails = []
    let deloadCount = 0
    for (const c of cycles) {
      for (const ex of c.exercises) {
        const history = (seenRatingsByExercise[ex.name] ??= [])
        if (ex.deloadSignal) {
          deloadCount++
          const lastTwo = history.slice(-2)
          const causeOk = lastTwo.length === 2 && lastTwo.every(r => r >= 4)
          if (!causeOk) deloadCauseOk = false
          deloadCauseDetails.push(`${ex.name} (цикл ${c.cycle}): предыдущие 2 оценки ${JSON.stringify(lastTwo)}`)
        }
        history.push(ex.rating)
      }
    }
    push('Откат срабатывает только после 2 подряд высоких рейтингов (4-5)', persona.name,
      `${deloadCount} срабатывани${deloadCount === 1 ? 'е' : 'й'}, все — после 2 тяжёлых подряд`,
      deloadCount === 0 ? 'откатов не было в этом прогоне' : `${deloadCount} срабатывани${deloadCount === 1 ? 'е' : 'й'}: ${deloadCauseDetails.join('; ')}`,
      deloadCauseOk)

    // 2б) НОВОЕ — обратная сторона импликации, которой раньше не было: "если
    // на упражнении 2 подряд высоких рейтинга — откат ОБЯЗАН сработать в
    // следующем цикле". Без неё тест пропускал бы "мёртвый" откат — код,
    // который никогда фактически не срабатывает даже когда условие
    // выполнено (2а проверяет только уже сработавшие случаи, молчит про
    // случаи, где должен был сработать, но не сработал).
    const ratingsSeqByExercise = {} // exercise -> [{cycle, rating}]
    const deloadFlagByKey = {} // "имя|цикл" -> deloadSignal
    for (const c of cycles) {
      for (const ex of c.exercises) {
        (ratingsSeqByExercise[ex.name] ??= []).push({ cycle: c.cycle, rating: ex.rating })
        deloadFlagByKey[`${ex.name}|${c.cycle}`] = ex.deloadSignal
      }
    }
    let mustFireOk = true
    let mustFireChecked = 0
    const mustFireDetails = []
    for (const [name, seq] of Object.entries(ratingsSeqByExercise)) {
      for (let i = 0; i < seq.length - 1; i++) {
        if (seq[i].rating < 4 || seq[i + 1].rating < 4) continue
        const triggerCycle = seq[i + 1].cycle + 1
        if (triggerCycle > CYCLES) continue // некуда сработать в пределах 8 циклов
        mustFireChecked++
        const fired = !!deloadFlagByKey[`${name}|${triggerCycle}`]
        if (!fired) { mustFireOk = false; mustFireDetails.push(`${name}: 2 тяжёлых подряд (циклы ${seq[i].cycle}, ${seq[i + 1].cycle}) — откат в цикле ${triggerCycle} НЕ сработал`) }
      }
    }
    push('Если 2 подряд высоких рейтинга на упражнении — откат ОБЯЗАН сработать в следующем цикле', persona.name,
      mustFireChecked ? `все ${mustFireChecked} случай(ев) вызвали откат` : 'в этом прогоне не было 2 подряд высоких рейтингов',
      mustFireChecked === 0 ? 'в этом прогоне не было 2 подряд высоких рейтингов' : (mustFireOk ? `все ${mustFireChecked} случай(ев) вызвали откат` : mustFireDetails.join('; ')),
      mustFireOk)

    // 3) Проценты роста — строго из таблицы методики, ничего не выдумано.
    const allowedPct = new Set(Object.values(RATING_GROWTH_PCT))
    let pctOk = true
    const pctBad = []
    for (const c of cycles) for (const ex of c.exercises) for (const s of ex.sets) {
      if (s.appliedPct == null || s.isDeload) continue
      if (!allowedPct.has(s.appliedPct)) { pctOk = false; pctBad.push(`${ex.name} цикл ${c.cycle}: ${s.appliedPct}%`) }
    }
    push('Проценты роста только из таблицы методики {10,7,5,3,2}', persona.name, 'все проценты из таблицы', pctOk ? 'все проценты из таблицы' : pctBad.join('; '), pctOk)

    // 4) Веса нигде не уходят в абсурдные значения. Отрицательный вес сам по
    // себе — не аномалия: это легитимная запись для ассистирующих
    // тренажёров (гравитрон, "-39кг" = кг компенсации, см. programs.js) и
    // проверяется отдельно выше (1б) на направление, а не на знак. Здесь —
    // только "не 0, не NaN/Infinity, модуль не более 500кг".
    let sane = true
    const insane = []
    for (const c of cycles) for (const ex of c.exercises) for (const s of ex.sets) {
      if (s.kg == null) continue
      if (s.kg === 0 || !Number.isFinite(s.kg) || Math.abs(s.kg) > 500) { sane = false; insane.push(`${ex.name} цикл ${c.cycle}: ${s.kg}кг`) }
    }
    push('Веса нигде не абсурдные (не 0, конечны, модуль ≤ 500кг)', persona.name, 'все веса в разумных пределах', sane ? 'все веса в разумных пределах' : insane.join('; '), sane)
  }

  // 5) У новичка без инвентаря — ни одного веса в кг (только эта персона).
  const novice = results.find(r => r.persona.key === 'novice_home')
  if (novice) {
    const anyWeight = novice.cycles.some(c => c.exercises.some(ex => ex.sets.some(s => s.kg != null)))
    push('У новичка без инвентаря нет упражнений со штангой/весом', novice.persona.name, 'ни одного подхода с весом в кг', anyWeight ? 'найден подход с весом в кг' : 'ни одного подхода с весом в кг', !anyWeight)
  }

  return rows
}

// ─────────────────────────────────────────────────────────────────────────
// Тест-кейсы флоу Конструктора (Блок 1) — на данных, реально прочитанных из
// constructor_sets между сессиями, а не на локальном состоянии теста.
// ─────────────────────────────────────────────────────────────────────────
function buildConstructorFlowTestCases(flowResults, dupResult) {
  const rows = []
  const push = (name, personaName, expected, actual, pass) => rows.push({ name, persona: personaName, expected: String(expected), actual: String(actual), pass })

  for (const { persona, sessionsLog } of flowResults) {
    // 1) Рекомендация появляется начиная со 2-й сессии (не на 1-й).
    const s1 = sessionsLog[0]
    const rest = sessionsLog.slice(1)
    const s1Ok = s1.isBaseline === true && s1.recommendation === null
    const restOk = rest.every(s => s.isBaseline === false && s.recommendation != null)
    const bad = []
    if (!s1Ok) bad.push(`сессия 1: isBaseline=${s1.isBaseline}, recommendation=${s1.recommendation ? 'есть' : 'нет'} (ожидалось isBaseline=true, без рекомендации)`)
    rest.forEach(s => { if (!(s.isBaseline === false && s.recommendation != null)) bad.push(`сессия ${s.session}: isBaseline=${s.isBaseline}, recommendation=${s.recommendation ? 'есть' : 'нет'}`) })
    push('Рекомендация появляется начиная со 2-й сессии, не на 1-й', persona.name,
      'сессия 1 без рекомендации (стартовый замер), сессии 2-8 с рекомендацией',
      (s1Ok && restOk) ? 'сессия 1 без рекомендации (стартовый замер), сессии 2-8 с рекомендацией' : bad.join('; '),
      s1Ok && restOk)
  }

  // 2) Вес привязан к exercise_id, а не к тексту (два упражнения с ОДИНАКОВЫМ
  // названием, разными id — истории должны быть физически изолированы в БД
  // и давать разные результаты).
  push('Вес привязан к exercise_id, а не к тексту (два упражнения с одинаковым названием)', 'Марина (A/B)',
    `изоляция в БД: по ${CYCLES} подходов на каждый id; траектории (вес и/или паттерн отката) разошлись`,
    `id A: ${dupResult.setsCountA} подходов, кг сессии 8=${dupResult.lastKgA}, откаты=[${dupResult.deloadPatternA}]; id B: ${dupResult.setsCountB} подходов, кг сессии 8=${dupResult.lastKgB}, откаты=[${dupResult.deloadPatternB}]`,
    dupResult.isolationOk && dupResult.diverged)

  // 3) Откат: 2 подряд тяжёлых оценки → isDeload + вес не растёт.
  const natasha = flowResults.find(r => r.persona.name === 'Наталья')
  if (natasha) {
    const deloadSessions = natasha.sessionsLog.filter(s => s.isDeload)
    const deloadHappened = deloadSessions.length > 0
    const deloadWeightOk = deloadSessions.every(s => {
      const prev = natasha.sessionsLog.find(p => p.session === s.session - 1)
      return prev && s.kgRecorded <= prev.kgRecorded
    })
    push('Откат срабатывает после 2 подряд тяжёлых оценок (флаг isDeload + вес не растёт)', 'Наталья',
      'откат сработал минимум раз, appliedPct=0, вес на откате ≤ веса предыдущей сессии',
      deloadHappened
        ? `откат на сессии: ${deloadSessions.map(s => s.session).join(', ')}; вес ${deloadWeightOk ? 'не растёт (корректно)' : 'вырос — ОШИБКА'}`
        : 'откат ни разу не сработал',
      deloadHappened && deloadWeightOk)
  }

  // 4) Ассистирующий тренажёр (гравитрон) — рост означает движение К НУЛЮ
  // (вес отрицательный, помощь тренажёра уменьшается), без откатов при
  // стабильно лёгких оценках.
  const victoria = flowResults.find(r => r.persona.name === 'Виктория')
  if (victoria) {
    const growthSessions = victoria.sessionsLog.slice(1) // со 2-й сессии — там уже рекомендации
    const movesTowardZero = growthSessions.every((s, i) => {
      const prev = i === 0 ? victoria.sessionsLog[0] : growthSessions[i - 1]
      return s.kgRecorded > prev.kgRecorded // отрицательное число растёт к нулю
    })
    const noDeloads = growthSessions.every(s => !s.isDeload)
    const trace = victoria.sessionsLog.map(s => s.kgRecorded).join(' → ')
    push('Ассистирующий тренажёр (гравитрон): вес движется к нулю без откатов', 'Виктория',
      'кг монотонно растёт (приближается к 0) на всех сессиях 2-8, откатов нет',
      `траектория кг: ${trace}${movesTowardZero && noDeloads ? '' : ' — ОШИБКА: ' + (!movesTowardZero ? 'вес не монотонно приближается к 0' : 'случился откат там, где не должен был')}`,
      movesTowardZero && noDeloads)
  }

  return rows
}

// ─────────────────────────────────────────────────────────────────────────
// Тест-кейсы матчинга названий (Блок 2) — findSimilarExercise из fuzzyMatch.js.
// ─────────────────────────────────────────────────────────────────────────
const NAME_MATCH_PAIRS = [
  { a: 'Тяга верхнего блока', b: 'Тяга нижнего блока', expected: false, note: 'разные упражнения (разный блок)' },
  { a: 'Сгибание ног', b: 'Разгибание ног', expected: false, note: 'разные упражнения (антонимы)' },
  { a: 'Жим лёжа', b: 'Жим сидя', expected: false, note: 'разные упражнения (положение тела)' },
  { a: 'Приседания', b: 'Приседания сумо', expected: false, note: 'разные упражнения (вариант приседа)' },
  { a: 'Люба', b: 'Любочка', expected: true, note: 'одно и то же (уменьшительная форма)' },
  { a: 'Ягодичный мост', b: 'ягодичный мостик', expected: true, note: 'одно и то же упражнение' },
  { a: 'Присед', b: 'приседания', expected: true, note: 'одно и то же упражнение (сокращение)' },
]

function buildNameMatchTestCases() {
  return NAME_MATCH_PAIRS.map(({ a, b, expected, note }) => {
    const matched = !!findSimilarExercise(a, [{ name: b }])
    return {
      a, b, note,
      expectedLabel: expected ? 'похожи (один дубль)' : 'НЕ похожи (разные упражнения)',
      actualLabel: matched ? 'похожи (один дубль)' : 'НЕ похожи (разные упражнения)',
      pass: matched === expected,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Мини-PNG энкодер без внешних зависимостей (для line-chart картинки в Excel —
// exceljs не умеет нативные диаграммы Excel, поэтому рисуем растровую линию
// прямо в пикселях и вставляем как обычную картинку на лист).
// ─────────────────────────────────────────────────────────────────────────
function crc32(buf) {
  crc32.table ??= (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}
function encodePNG(width, height, rgbBuf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0); ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0
    rgbBuf.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3)
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdrData), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
function setPx(buf, w, h, x, y, r, g, b) {
  x = Math.round(x); y = Math.round(y)
  if (x < 0 || x >= w || y < 0 || y >= h) return
  const i = (y * w + x) * 3
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
}
function drawThickLine(buf, w, h, x0, y0, x1, y1, r, g, b, thickness = 2) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
  let err = dx + dy, x = x0, y = y0
  for (;;) {
    for (let ox = -thickness; ox <= thickness; ox++) for (let oy = -thickness; oy <= thickness; oy++) setPx(buf, w, h, x + ox, y + oy, r, g, b)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}
const PERSONA_COLORS = [
  [0x4C, 0x78, 0xA8], // синий
  [0xF5, 0x85, 0x18], // оранжевый
  [0xB2, 0x79, 0xA2], // фиолетовый
  [0x9D, 0x75, 0x5D], // коричневый
  [0xC9, 0xA2, 0x27], // золотой
]
function buildTonnageChartPNG(results) {
  const W = 760, H = 340, padL = 56, padR = 20, padT = 20, padB = 40
  const buf = Buffer.alloc(W * H * 3, 0xFF) // белый фон
  const allTonnages = results.flatMap(r => r.cycles.map(c => c.tonnage))
  const maxT = Math.max(...allTonnages, 1)
  const minT = Math.min(...allTonnages, 0)
  const plotW = W - padL - padR, plotH = H - padT - padB
  const xAt = (cycle) => padL + ((cycle - 1) / (CYCLES - 1)) * plotW
  const yAt = (t) => padT + plotH - ((t - minT) / (maxT - minT || 1)) * plotH

  // оси и сетка
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i
    for (let x = padL; x <= W - padR; x++) setPx(buf, W, H, x, y, 0xE5, 0xE7, 0xEB)
  }
  drawThickLine(buf, W, H, padL, padT, padL, H - padB, 0x9C, 0xA3, 0xAF, 1)
  drawThickLine(buf, W, H, padL, H - padB, W - padR, H - padB, 0x9C, 0xA3, 0xAF, 1)

  results.forEach((r, pi) => {
    const [cr, cg, cb] = PERSONA_COLORS[pi % PERSONA_COLORS.length]
    const pts = r.cycles.map(c => [xAt(c.cycle), yAt(c.tonnage)])
    for (let i = 0; i < pts.length - 1; i++) drawThickLine(buf, W, H, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], cr, cg, cb, 2)
    for (const [x, y] of pts) for (let ox = -3; ox <= 3; ox++) for (let oy = -3; oy <= 3; oy++) setPx(buf, W, H, x + ox, y + oy, cr, cg, cb)
  })

  return encodePNG(W, H, buf)
}

// ─────────────────────────────────────────────────────────────────────────
// Excel-отчёт
// ─────────────────────────────────────────────────────────────────────────
const GREEN_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } }
const RED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF374151' } }
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true }

function styleHeader(row) {
  row.eachCell(cell => { cell.fill = HEADER_FILL; cell.font = HEADER_FONT; cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true } })
  row.height = 24
}

async function buildWorkbook(results, flowResults, dupResult) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'test-progression-personas.js'
  wb.created = new Date()

  // ── Лист 1: Сводка ──
  const s1 = wb.addWorksheet('Сводка')
  s1.columns = [
    { header: 'Персона', key: 'name', width: 14 },
    { header: 'Уровень', key: 'level', width: 14 },
    { header: 'Программа', key: 'program', width: 20 },
    { header: 'Тоннаж цикл 1 (кг)', key: 't1', width: 16 },
    { header: 'Тоннаж цикл 8 (кг)', key: 't8', width: 16 },
    { header: '% общего прироста', key: 'growth', width: 16 },
    { header: 'Сработал откат (раз)', key: 'deloads', width: 16 },
    { header: 'Средний рейтинг усилия', key: 'avgRating', width: 18 },
  ]
  styleHeader(s1.getRow(1))
  for (const { persona, cycles } of results) {
    const t1 = cycles[0].tonnage, t8 = cycles[CYCLES - 1].tonnage
    const growth = t1 > 0 ? Math.round(((t8 - t1) / t1) * 1000) / 10 : 0
    const deloads = cycles.reduce((n, c) => n + c.exercises.filter(e => e.deloadSignal).length, 0)
    const ratings = cycles.flatMap(c => c.exercises.map(e => e.rating))
    const avgRating = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
    s1.addRow({ name: persona.name, level: persona.level, program: persona.program, t1: Math.round(t1), t8: Math.round(t8), growth, deloads, avgRating })
  }
  s1.addConditionalFormatting({
    ref: `F2:F${1 + results.length}`,
    rules: [
      { type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { fill: GREEN_FILL, font: { color: { argb: 'FF006100' } } } },
      { type: 'cellIs', operator: 'lessThanOrEqual', formulae: [0], style: { fill: RED_FILL, font: { color: { argb: 'FF9C0006' } } } },
    ],
  })
  const noteRow = s1.addRow([])
  const note = s1.addRow(['Состав упражнений (имена, порядок, повторы) зафиксирован один раз на старте и не меняется между циклами — единственное, что меняется, это рабочий вес по 1ПМ-движку (см. src/workoutPrompt.js). Поэтому тоннаж цикла 1 и цикла 8 здесь СРАВНИМ напрямую: рост — это реальный прогресс по весу, а не смена состава сессии. Просадка означает откат — см. лист "Усилие и откаты" и колонку "Сработал откат" здесь.'])
  note.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF6B7280' } }
  s1.mergeCells(`A${note.number}:H${note.number}`)
  note.getCell(1).alignment = { wrapText: true }

  // ── Лист 2: Тоннаж по циклам ──
  const s2 = wb.addWorksheet('Тоннаж по циклам')
  const cycleCols = Array.from({ length: CYCLES }, (_, i) => ({ header: `Цикл ${i + 1}`, key: `c${i + 1}`, width: 12 }))
  const growthCols = Array.from({ length: CYCLES - 1 }, (_, i) => ({ header: `Ц${i + 1}→Ц${i + 2} %`, key: `g${i + 1}`, width: 12 }))
  s2.columns = [{ header: 'Персона', key: 'name', width: 14 }, ...cycleCols, ...growthCols]
  styleHeader(s2.getRow(1))
  for (const { persona, cycles } of results) {
    const row = { name: persona.name }
    cycles.forEach((c, i) => { row[`c${i + 1}`] = Math.round(c.tonnage) })
    for (let i = 0; i < CYCLES - 1; i++) {
      const a = cycles[i].tonnage, b = cycles[i + 1].tonnage
      row[`g${i + 1}`] = a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : 0
    }
    s2.addRow(row)
  }
  const legendStartRow = s2.lastRow.number + 3
  s2.getCell(`A${legendStartRow - 1}`).value = 'Динамика тоннажа по циклам (картинка — exceljs не поддерживает нативные диаграммы Excel, поэтому это растровый график, вставленный как изображение):'
  s2.getCell(`A${legendStartRow - 1}`).font = { italic: true, size: 10, color: { argb: 'FF6B7280' } }
  results.forEach((r, i) => {
    const [cr, cg, cb] = PERSONA_COLORS[i % PERSONA_COLORS.length]
    const cell = s2.getCell(legendStartRow + i, 1)
    cell.value = r.persona.name
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${[cr, cg, cb].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}` } }
  })
  const chartPng = buildTonnageChartPNG(results)
  const imgId = wb.addImage({ buffer: chartPng, extension: 'png' })
  s2.addImage(imgId, { tl: { col: 2, row: legendStartRow - 1 }, ext: { width: 760, height: 340 } })
  const assistedNoteRow = legendStartRow + results.length + 1
  s2.getCell(`A${assistedNoteRow}`).value = 'Ассистирующие тренажёры (отрицательный вес — кг компенсации, не поднятый вес, например "Подтягивания в гравитроне") ИСКЛЮЧЕНЫ из тоннажа выше: это не выполненная работа, а мера помощи тренажёра, её нельзя складывать с обычным весом ни с плюсом, ни с минусом. Их собственная прогрессия (к нулю при росте, от нуля при откате) — на листе "Веса и повторы" (помечены "⚙ ассист") и проверена в "Тест-кейсы".'
  s2.getCell(`A${assistedNoteRow}`).font = { italic: true, size: 10, color: { argb: 'FF6B7280' } }
  s2.mergeCells(`A${assistedNoteRow}:H${assistedNoteRow}`)
  s2.getCell(`A${assistedNoteRow}`).alignment = { wrapText: true }

  // ── Лист 3: Усилие и откаты ──
  const s3 = wb.addWorksheet('Усилие и откаты')
  s3.columns = [
    { header: 'Персона', key: 'name', width: 14 },
    { header: 'Цикл', key: 'cycle', width: 8 },
    { header: 'Упражнение', key: 'ex', width: 32 },
    { header: 'Рейтинг усилия', key: 'rating', width: 14 },
    { header: 'Откат сработал?', key: 'deload', width: 16 },
    { header: 'Причина', key: 'reason', width: 40 },
  ]
  styleHeader(s3.getRow(1))
  for (const { persona, cycles } of results) {
    for (const c of cycles) {
      for (const ex of c.exercises) {
        s3.addRow({
          name: persona.name, cycle: c.cycle, ex: ex.name, rating: ex.rating,
          deload: ex.deloadSignal ? 'Да' : 'Нет',
          reason: ex.deloadSignal ? '2 подряд тяжёлых занятия (оценка ≥4 на последнем рабочем подходе)' : '',
        })
      }
    }
  }
  s3.eachRow((row, i) => { if (i > 1 && row.getCell('deload').value === 'Да') row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } } }) })

  // ── Лист 4: Веса и повторы ──
  const s4 = wb.addWorksheet('Веса и повторы')
  s4.columns = [
    { header: 'Персона', key: 'name', width: 14 },
    { header: 'Упражнение', key: 'ex', width: 32 },
    ...Array.from({ length: CYCLES }, (_, i) => ({ header: `Цикл ${i + 1}`, key: `c${i + 1}`, width: 16 })),
  ]
  styleHeader(s4.getRow(1))
  for (const { persona, cycles } of results) {
    const exNames = [...new Set(cycles.flatMap(c => c.exercises.map(e => e.name)))]
    for (const exName of exNames) {
      const isAssisted = cycles.some(c => c.exercises.find(e => e.name === exName)?.sets.some(s => s.kg < 0))
      const row = { name: persona.name, ex: isAssisted ? `⚙ ассист · ${exName}` : exName }
      cycles.forEach((c, i) => {
        const ex = c.exercises.find(e => e.name === exName)
        if (!ex) { row[`c${i + 1}`] = '—'; return }
        const working = ex.sets.filter(s => s.isWorking)
        row[`c${i + 1}`] = working.length ? working.map(s => s.hasWeight ? `${s.kg}кг×${s.reps}` : `${s.reps} повт.`).join(' / ') : '—'
      })
      s4.addRow(row)
    }
  }

  // ── Лист 5: Тест-кейсы ──
  const s5 = wb.addWorksheet('Тест-кейсы')
  s5.columns = [
    { header: 'Тест', key: 'name', width: 45 },
    { header: 'Персона', key: 'persona', width: 14 },
    { header: 'Ожидалось', key: 'expected', width: 45 },
    { header: 'Получено', key: 'actual', width: 60 },
    { header: 'Статус', key: 'status', width: 10 },
  ]
  styleHeader(s5.getRow(1))
  const testRows = buildTestCases(results)
  for (const t of testRows) s5.addRow({ name: t.name, persona: t.persona, expected: t.expected, actual: t.actual, status: t.pass ? 'PASS' : 'FAIL' })
  s5.eachRow((row, i) => { if (i > 1 && row.getCell('status').value === 'FAIL') row.eachCell(c => { c.fill = RED_FILL }) })
  s5.getColumn('status').eachCell(cell => { cell.alignment = { horizontal: 'center' } })

  // ── Лист 6: Флоу конструктора ──
  const s6 = wb.addWorksheet('Флоу конструктора')
  s6.columns = [
    { header: 'Персона', key: 'persona', width: 14 },
    { header: 'Назначение', key: 'purpose', width: 34 },
    { header: 'Сессия', key: 'session', width: 9 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Стартовый замер?', key: 'baseline', width: 16 },
    { header: 'Рекомендация (кг)', key: 'recKg', width: 16 },
    { header: 'Записано (кг×повт)', key: 'recorded', width: 18 },
    { header: 'Оценка усилия', key: 'rating', width: 14 },
    { header: 'Откат?', key: 'deload', width: 10 },
    { header: '% роста применён', key: 'pct', width: 16 },
  ]
  styleHeader(s6.getRow(1))
  for (const { persona, sessionsLog } of flowResults) {
    for (const s of sessionsLog) {
      s6.addRow({
        persona: persona.name, purpose: persona.purpose, session: s.session, date: s.date,
        baseline: s.isBaseline ? 'Да (без рекомендации)' : 'Нет',
        recKg: s.recommendation ? s.recommendation.kg : '—',
        recorded: `${s.kgRecorded}кг×${s.repsRecorded}`,
        rating: s.rating,
        deload: s.isDeload ? 'Да' : 'Нет',
        pct: s.appliedPct ?? '—',
      })
    }
    s6.addRow([])
  }
  s6.eachRow((row, i) => { if (i > 1 && row.getCell('deload').value === 'Да') row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } } }) })

  const dupNoteRow = s6.lastRow.number + 1
  s6.getCell(`A${dupNoteRow}`).value = `Проверка "вес привязан к exercise_id, а не к тексту": Марина-A и Марина-B — два отдельных упражнения с ОДИНАКОВЫМ названием ("${TEST_PREFIX} Жим гантелей (дубль по названию)"), разные exercise_id. Ветка A (лёгкие оценки, рост): ${dupResult.setsCountA} подходов в БД, кг сессии 8 = ${dupResult.lastKgA}, откаты по сессиям = [${dupResult.deloadPatternA}]. Ветка B (тяжёлые оценки, откат): ${dupResult.setsCountB} подходов в БД, кг сессии 8 = ${dupResult.lastKgB}, откаты по сессиям = [${dupResult.deloadPatternB}]. ${dupResult.isolationOk && dupResult.diverged ? 'Истории физически изолированы и разошлись — вес считается по id, не по названию.' : 'ОШИБКА — истории смешались или не разошлись.'}`
  s6.getCell(`A${dupNoteRow}`).font = { italic: true, size: 10, color: { argb: 'FF6B7280' } }
  s6.mergeCells(`A${dupNoteRow}:J${dupNoteRow}`)
  s6.getCell(`A${dupNoteRow}`).alignment = { wrapText: true }

  const flowTestRows = buildConstructorFlowTestCases(flowResults, dupResult)
  const flowCasesStartRow = dupNoteRow + 2
  s6.getCell(`A${flowCasesStartRow}`).value = 'Тест-кейсы флоу Конструктора'
  s6.getCell(`A${flowCasesStartRow}`).font = { bold: true }
  const flowHeaderRow = s6.getRow(flowCasesStartRow + 1)
  flowHeaderRow.values = ['Тест', 'Персона', 'Ожидалось', 'Получено', 'Статус']
  styleHeader(flowHeaderRow)
  for (const t of flowTestRows) {
    const row = s6.addRow([t.name, t.persona, t.expected, t.actual, t.pass ? 'PASS' : 'FAIL'])
    if (!t.pass) row.eachCell(c => { c.fill = RED_FILL })
  }

  // ── Лист 7: Матчинг названий ──
  const s7 = wb.addWorksheet('Матчинг названий')
  s7.columns = [
    { header: 'Название A', key: 'a', width: 26 },
    { header: 'Название B', key: 'b', width: 26 },
    { header: 'Комментарий', key: 'note', width: 34 },
    { header: 'Ожидалось', key: 'expected', width: 26 },
    { header: 'Получено', key: 'actual', width: 26 },
    { header: 'Статус', key: 'status', width: 10 },
  ]
  styleHeader(s7.getRow(1))
  const nameMatchRows = buildNameMatchTestCases()
  for (const t of nameMatchRows) {
    s7.addRow({ a: t.a, b: t.b, note: t.note, expected: t.expectedLabel, actual: t.actualLabel, status: t.pass ? 'PASS' : 'FAIL' })
  }
  s7.eachRow((row, i) => { if (i > 1 && row.getCell('status').value === 'FAIL') row.eachCell(c => { c.fill = RED_FILL }) })
  s7.getColumn('status').eachCell(cell => { cell.alignment = { horizontal: 'center' } })

  for (const ws of [s1, s2, s3, s4, s5, s6, s7]) ws.views = [{ state: 'frozen', ySplit: 1 }]

  return { wb, testRows, flowTestRows, nameMatchRows }
}

// Удаляет ВСЁ, что этот прогон создал в Конструкторе тестового аккаунта —
// находит по префиксу TEST_PREFIX в названии, чтобы не задеть ничего, что
// реально принадлежит этому аккаунту. Вызывается и при успехе, и при ошибке
// (см. try/finally в main) — тестовые данные не должны оставаться в БД.
async function cleanupConstructorTestData(supabase, userId) {
  const { data: exercises, error } = await supabase.from('constructor_exercises')
    .select('id').eq('user_id', userId).like('name', `${TEST_PREFIX}%`)
  if (error) { console.error('Очистка: ошибка чтения тестовых упражнений:', error.message); return 0 }
  const ids = (exercises || []).map(e => e.id)
  if (!ids.length) return 0
  const { error: setsErr } = await supabase.from('constructor_sets').delete().in('exercise_id', ids).eq('user_id', userId)
  if (setsErr) console.error('Очистка: ошибка удаления подходов:', setsErr.message)
  const { error: exErr } = await supabase.from('constructor_exercises').delete().in('id', ids).eq('user_id', userId)
  if (exErr) console.error('Очистка: ошибка удаления упражнений:', exErr.message)
  return ids.length
}

// ─────────────────────────────────────────────────────────────────────────
// Запуск
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  const results = []
  for (const persona of PERSONAS) {
    process.stdout.write(`▶ Симулирую персону: ${persona.name} (${persona.level}, ${persona.program})... `)
    const r = simulatePersona(persona)
    console.log('готово')
    results.push(r)
  }

  const TEST_EMAIL = process.env.CONSTRUCTOR_TEST_EMAIL
  const TEST_PASSWORD = process.env.CONSTRUCTOR_TEST_PASSWORD
  if (!TEST_EMAIL || !TEST_PASSWORD) { console.error('Нет CONSTRUCTOR_TEST_EMAIL/CONSTRUCTOR_TEST_PASSWORD (проверь .env)'); process.exit(1) }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
  if (authErr) { console.error('Ошибка входа тестового пользователя Конструктора:', authErr.message); process.exit(1) }
  const userId = authData.user.id
  console.log(`\n▶ Вход тестовым пользователем Конструктора выполнен (${TEST_EMAIL})`)

  let flowResults = [], dupResult
  try {
    console.log('▶ Прогоняю флоу Конструктора (создание упражнения → 8 сессий) для каждой персоны...')
    for (const persona of CONSTRUCTOR_PERSONAS) {
      process.stdout.write(`  ${persona.name} (${persona.purpose})... `)
      flowResults.push(await runConstructorFlowPersona(supabase, userId, persona))
      console.log('готово')
    }
    process.stdout.write('  Марина (дубль по названию, ветки A/B)... ')
    dupResult = await runDuplicateNameFlow(supabase, userId)
    console.log('готово')
  } finally {
    const cleaned = await cleanupConstructorTestData(supabase, userId)
    console.log(`▶ Очищено тестовых упражнений в Конструкторе: ${cleaned}`)
    await supabase.auth.signOut()
  }

  const reportsDir = path.join(process.cwd(), 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const reportPath = path.join(reportsDir, 'progression-report.xlsx')
  const desktopPath = path.join(os.homedir(), 'Desktop', 'progression-report.xlsx')

  const { wb, testRows, flowTestRows, nameMatchRows } = await buildWorkbook(results, flowResults, dupResult)
  await wb.xlsx.writeFile(reportPath)
  await wb.xlsx.writeFile(desktopPath)

  const passed = testRows.filter(t => t.pass).length
  console.log('\n── Тест-кейсы (движок) ──────────────────────────────────')
  for (const t of testRows) { console.log(`${t.pass ? '✓ PASS' : '✗ FAIL'}  [${t.persona}] ${t.name}`); if (!t.pass) console.log(`   → ${t.actual}`) }
  console.log(`Итого: ${passed}/${testRows.length}`)

  const flowPassed = flowTestRows.filter(t => t.pass).length
  console.log('\n── Тест-кейсы (флоу Конструктора) ───────────────────────')
  for (const t of flowTestRows) { console.log(`${t.pass ? '✓ PASS' : '✗ FAIL'}  [${t.persona}] ${t.name}`); if (!t.pass) console.log(`   → ${t.actual}`) }
  console.log(`Итого: ${flowPassed}/${flowTestRows.length}`)

  const namePassed = nameMatchRows.filter(t => t.pass).length
  console.log('\n── Тест-кейсы (матчинг названий) ────────────────────────')
  for (const t of nameMatchRows) { console.log(`${t.pass ? '✓ PASS' : '✗ FAIL'}  ${t.a} / ${t.b} → ${t.actualLabel}`) }
  console.log(`Итого: ${namePassed}/${nameMatchRows.length}`)

  console.log(`\nExcel-отчёт сохранён: ${reportPath}`)
  console.log(`Копия на Рабочем столе: ${desktopPath}`)

  const allPassed = passed === testRows.length && flowPassed === flowTestRows.length && namePassed === nameMatchRows.length
  process.exit(allPassed ? 0 : 1)
}

main()
