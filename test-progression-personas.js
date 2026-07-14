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
// (buildAssignedSessionPlan/buildExerciseAggregates из src/workoutPrompt.js,
// той же самой, что WorkoutsView в App.jsx врезает в кнопку "▶ Начать
// тренировку"), а не копией расчётов — иначе тест не ловил бы регрессии в
// самом движке. Никакой сети — ни Claude (чат тренировок в режиме
// консультанта не считает вес и не составляет программы, см.
// buildWorkoutSystemPrompt), ни Supabase (Конструктор, который раньше здесь
// тестировался отдельным блоком через реальные таблицы, вынесен из
// приложения и заморожен, см. docs/CONSTRUCTOR_FROZEN.md) — движок
// тестируется напрямую, в памяти.
//
// Запуск: node test-progression-personas.js

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import ExcelJS from 'exceljs'
import { buildAssignedSessionPlan, buildExerciseAggregates, computeTargetWeight, RATING_GROWTH_PCT } from './src/workoutPrompt.js'
import { oneRepMax } from './src/oneRepMax.js'
import { PROGRAMS_MAP } from './src/programs.js'
import { findSimilarExercise } from './src/fuzzyMatch.js'

const CYCLES = 8
const TODAY = new Date().toISOString().slice(0, 10)
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

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
    // Специально для проверки ONE-SHOT отката (computeHardStreak в
    // workoutPrompt.js — разовое срабатывание, счётчик подряд-тяжёлых
    // обнуляется сразу после отката) на "Приседания" (первое упражнение
    // слота), ratings = [4, 5, 4, 3, 4, 5, 3, 3]:
    // циклы 1,2 тяжёлые подряд → откат на цикле 3 (первое срабатывание).
    // Цикл 3 ТОЖЕ тяжёлый (третий тяжёлый подряд) — но счётчик уже
    // сброшен откатом, поэтому цикл 4 откат НЕ повторяет (one-shot).
    // Цикл 4 — комфортно (3), чисто размыкает серию, чтобы следующая пара
    // была заведомо НОВОЙ, а не хвостом предыдущей. Циклы 5,6 — снова
    // тяжёлые подряд → откат срабатывает ЕЩЁ РАЗ на цикле 7 (доказывает,
    // что one-shot не "выжигает" механизм навсегда, а просто требует
    // заново набрать пару). Остальные упражнения — ровный средний рейтинг,
    // чтобы не путать сигнал.
    ratingFn: (cycle, exIdx, exName) => (exName === 'Приседания' ? [4, 5, 4, 3, 4, 5, 3, 3][cycle - 1] : 3),
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
      const deloadSignal = !!agg?.hardStreak
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

    // 2б) ПЕРЕПИСАНО под ONE-SHOT откат (см. computeHardStreak в
    // workoutPrompt.js): раньше здесь проверялась обратная импликация "2
    // подряд высоких рейтинга -> откат ОБЯЗАН сработать в следующем цикле"
    // без исключений — это был тест-кейс под старый buildDeload (не
    // one-shot, срабатывал на КАЖДОЙ паре подряд тяжёлых, без сброса
    // счётчика). При one-shot это правило больше не универсально: если
    // предыдущий откат уже "потратил" одну из сессий пары, третья тяжёлая
    // подряд НЕ обязана вызвать повторный откат немедленно (счётчик
    // сброшен и стартует заново с этой сессии). Поэтому вместо ручной
    // расстановки ожиданий по циклам (легко ошибиться на off-by-one на
    // границе сброса) сверяем реальный agg.hardStreak движка с независимой
    // эталонной реализацией ТОЧНО того же алгоритма, что описан в задаче
    // (дословно как hasHardStreak в constructorPhases.js, но без пропуска
    // baseline — здесь её нет, первая тренировка участвует в подсчёте
    // наравне со всеми). Это одновременно и универсальная регрессия (на
    // всех персонах/упражнениях), и — отдельным кейсом ниже — предметная
    // демонстрация one-shot на Наталье: разовое срабатывание, отсутствие
    // немедленного повтора, и повторное срабатывание позже на новой паре.
    function referenceHardStreak(ratingsInOrder) {
      // ratingsInOrder[i] — рейтинг (i+1)-й по счёту сессии. Возвращает
      // массив той же длины: hardStreak СРАЗУ ПОСЛЕ i-й сессии — то самое
      // значение, которое движок использует для расчёта ВЕСА СЛЕДУЮЩЕЙ,
      // (i+2)-й по счёту, сессии (см. buildExerciseAggregates: hardStreak
      // считается из sessions 1..N и применяется к ещё не рассчитанной N+1).
      let streak = 0
      return ratingsInOrder.map(r => {
        if (streak >= 2) streak = 0
        streak = r >= 4 ? streak + 1 : 0
        return streak >= 2
      })
    }

    const ratingsSeqByExercise = {} // exercise -> [{cycle, rating}]
    const deloadFlagByKey = {} // "имя|цикл" -> deloadSignal
    for (const c of cycles) {
      for (const ex of c.exercises) {
        (ratingsSeqByExercise[ex.name] ??= []).push({ cycle: c.cycle, rating: ex.rating })
        deloadFlagByKey[`${ex.name}|${c.cycle}`] = ex.deloadSignal
      }
    }

    let matchOk = true
    let matchChecked = 0
    const matchDetails = []
    for (const [name, seq] of Object.entries(ratingsSeqByExercise)) {
      const ref = referenceHardStreak(seq.map(s => s.rating))
      for (let i = 0; i < seq.length; i++) {
        const targetCycle = seq[i].cycle + 1
        if (targetCycle > CYCLES) continue // некуда применить в пределах 8 циклов
        matchChecked++
        const expected = ref[i]
        const actual = !!deloadFlagByKey[`${name}|${targetCycle}`]
        if (expected !== actual) { matchOk = false; matchDetails.push(`${name}: цикл ${targetCycle} ожидался hardStreak=${expected} (эталон), движок дал ${actual}`) }
      }
    }
    push('Откат (one-shot): agg.hardStreak движка совпадает с эталонной реализацией алгоритма на каждом цикле', persona.name,
      `все ${matchChecked} проверенных цикла(ов) совпадают с эталоном`,
      matchOk ? `все ${matchChecked} проверенных цикла(ов) совпадают с эталоном` : matchDetails.join('; '),
      matchOk)

    // Предметная демонстрация one-shot на "Приседания" (персона Наталья,
    // ratingFn = [4, 5, 4, 3, 4, 5, 3, 3]): ищем и разовость (тяжёлая
    // оценка сразу после срабатывания НЕ вызывает повтор), и повторное
    // срабатывание позже на новой паре — без этого тест мог бы "случайно"
    // пройти на персоне, где откат вообще ни разу не всплывал.
    const squatsSeq = ratingsSeqByExercise['Приседания']
    if (persona.key === 'intermediate_recovery' && squatsSeq) {
      const ref = referenceHardStreak(squatsSeq.map(s => s.rating))
      const fireCount = ref.filter(Boolean).length
      let suppressedAfterFire = false
      for (let i = 1; i < ref.length; i++) {
        if (ref[i - 1] && !ref[i] && squatsSeq[i].rating >= 4) suppressedAfterFire = true
      }
      const refired = fireCount >= 2
      push('Откат (one-shot) на Наталье: разовое срабатывание не повторяется немедленно, но срабатывает снова позже на новой паре', persona.name,
        'минимум 1 случай "тяжёлая сразу после отката не вызвала повтор" И минимум 2 срабатывания отката за 8 циклов',
        `срабатываний всего: ${fireCount}; суппрессия сразу после отката: ${suppressedAfterFire ? 'да' : 'нет'}`,
        suppressedAfterFire && refired)
    }

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
// Тест-кейсы матчинга названий — findSimilarExercise из fuzzyMatch.js.
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

async function buildWorkbook(results) {
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

  // ── Лист 6: Матчинг названий ──
  const s6 = wb.addWorksheet('Матчинг названий')
  s6.columns = [
    { header: 'Название A', key: 'a', width: 26 },
    { header: 'Название B', key: 'b', width: 26 },
    { header: 'Комментарий', key: 'note', width: 34 },
    { header: 'Ожидалось', key: 'expected', width: 26 },
    { header: 'Получено', key: 'actual', width: 26 },
    { header: 'Статус', key: 'status', width: 10 },
  ]
  styleHeader(s6.getRow(1))
  const nameMatchRows = buildNameMatchTestCases()
  for (const t of nameMatchRows) {
    s6.addRow({ a: t.a, b: t.b, note: t.note, expected: t.expectedLabel, actual: t.actualLabel, status: t.pass ? 'PASS' : 'FAIL' })
  }
  s6.eachRow((row, i) => { if (i > 1 && row.getCell('status').value === 'FAIL') row.eachCell(c => { c.fill = RED_FILL }) })
  s6.getColumn('status').eachCell(cell => { cell.alignment = { horizontal: 'center' } })

  for (const ws of [s1, s2, s3, s4, s5, s6]) ws.views = [{ state: 'frozen', ySplit: 1 }]

  return { wb, testRows, nameMatchRows }
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

  const reportsDir = path.join(process.cwd(), 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const reportPath = path.join(reportsDir, 'progression-report.xlsx')
  const desktopPath = path.join(os.homedir(), 'Desktop', 'progression-report.xlsx')

  const { wb, testRows, nameMatchRows } = await buildWorkbook(results)
  await wb.xlsx.writeFile(reportPath)
  await wb.xlsx.writeFile(desktopPath)

  const passed = testRows.filter(t => t.pass).length
  console.log('\n── Тест-кейсы (движок) ──────────────────────────────────')
  for (const t of testRows) { console.log(`${t.pass ? '✓ PASS' : '✗ FAIL'}  [${t.persona}] ${t.name}`); if (!t.pass) console.log(`   → ${t.actual}`) }
  console.log(`Итого: ${passed}/${testRows.length}`)

  const namePassed = nameMatchRows.filter(t => t.pass).length
  console.log('\n── Тест-кейсы (матчинг названий) ────────────────────────')
  for (const t of nameMatchRows) { console.log(`${t.pass ? '✓ PASS' : '✗ FAIL'}  ${t.a} / ${t.b} → ${t.actualLabel}`) }
  console.log(`Итого: ${namePassed}/${nameMatchRows.length}`)

  console.log(`\nExcel-отчёт сохранён: ${reportPath}`)
  console.log(`Копия на Рабочем столе: ${desktopPath}`)

  const allPassed = passed === testRows.length && namePassed === nameMatchRows.length
  process.exit(allPassed ? 0 : 1)
}

main()
