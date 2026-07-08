// Автоматический тестировщик AI-тренера по тренировкам (режим "Тренировки").
// Прогоняет набор сценариев напрямую через Anthropic API, используя ТОТ ЖЕ
// buildWorkoutSystemPrompt, что и продакшен-код (src/workoutPrompt.js), и
// проверяет ответы: отсутствие markdown, отсутствие утечки внутренней
// терминологии методики (фаза/волновой цикл/тоннаж/диапазон повторений),
// корректную реакцию на 4 правила нагрузки, корректность маркеров
// ADD_SET/EDIT_SET/DEL_SET, сопоставление названий упражнений со справочником
// (src/programs.js) и то, что AI не выдумывает свои сигналы там, где JS ещё
// не насчитал достаточно данных.
//
// По аналогии с test-ai.js (тот покрывает только AI-диетолога, src/aiPrompt.js).
//
// Запуск: node test-workout.js

import { readFileSync } from 'node:fs'
import { buildWorkoutSystemPrompt } from './src/workoutPrompt.js'
import { EXERCISES } from './src/programs.js'

// .env в проекте не грузится автоматически (dotenv не используется) — читаем вручную
function loadEnv() {
  try {
    const text = readFileSync(new URL('./.env', import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* .env может отсутствовать в CI — тогда ключ должен быть в env */ }
}
loadEnv()

const API_KEY = process.env.VITE_ANTHROPIC_KEY
const MODEL = 'claude-sonnet-4-6'
const TODAY = new Date().toISOString().slice(0, 10)
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

if (!API_KEY) {
  console.error('Нет VITE_ANTHROPIC_KEY (проверь .env)')
  process.exit(1)
}

// ── Фикстуры клиента ─────────────────────────────────────────────────────
const PROFILE = { name: 'Тест Тестов', weight: 75, goal: 'Похудение', activity_level: 'moderate', program: null, ai_style: 'act' }
const SURVEY = { experience: 'medium', contraindications: null, favorite_exercises: ['Приседания'], focus_muscles: ['Ноги'], system: 'full' }

// Конструктор подхода истории. id уникален и растёт по порядку создания —
// сценарии, которым нужен конкретный id (EDIT_SET/DEL_SET), берут его из
// возвращённого объекта, а не хардкодят число.
let nextId = 1
const S = (exercise, daysAgoN, kg, reps, rating = null) => ({ id: nextId++, exercise, date: daysAgo(daysAgoN), kg, reps, rating })

const ctxWorkout = (sets = [], { survey = SURVEY, profile = PROFILE } = {}) =>
  buildWorkoutSystemPrompt({ profile, programTemplate: null, sets, survey, today: TODAY })

// ── Общие проверки ───────────────────────────────────────────────────────
const MD_RE = /\*\*|\*|^#{1,6}\s|`[^`]+`|^[+\-•]\s/m
const hasMarkdown = (text) => MD_RE.test(text)
// SET_PROGRAM содержит вложенный JSON — плоский шаблон {[^}]*} остальных
// маркеров его не берёт, поэтому вырезаем/парсим его отдельно (та же логика,
// что и в продакшене — AIAssistant.jsx).
const stripMarkers = (text) => {
  let t = text
  const spIdx = t.indexOf('[SET_PROGRAM:')
  if (spIdx !== -1) {
    const jsonEnd = t.lastIndexOf(']')
    if (jsonEnd > spIdx) t = t.slice(0, spIdx) + t.slice(jsonEnd + 1)
  }
  return t.replace(/\[(ADD_SET|DEL_SET|EDIT_SET|SUGGEST_SURVEY):?(\{[^}]*\})?\]/g, '').trim()
}

const markers = (text, type) => [...text.matchAll(new RegExp(`\\[${type}:(\\{[^}]+\\})\\]`, 'g'))]
  .map(m => { try { return JSON.parse(m[1]) } catch { return null } }).filter(Boolean)

const extractSetProgram = (text) => {
  const spIdx = text.indexOf('[SET_PROGRAM:')
  if (spIdx === -1) return null
  const jsonStart = spIdx + '[SET_PROGRAM:'.length
  const jsonEnd = text.lastIndexOf(']')
  if (jsonEnd <= jsonStart) return null
  try { return JSON.parse(text.slice(jsonStart, jsonEnd)) } catch { return null }
}

// Термины внутренней кухни метода — не должны появляться в видимом клиенту
// тексте (см. STYLE_RULE в workoutPrompt.js). "фаза"/"цикл"/"тоннаж"/
// "диапазон повторений" достаточно редки в обычной разговорной речи тренера,
// чтобы не давать ложных срабатываний на бытовые фразы.
const LEAK_RE = /фаза|волновой\s+цикл|\bцикл\w*|тоннаж|диапазон\s+повторени|\d{3,}\s*(кг)?\s*против\s+\d/i

const kgNumbers = (text) => [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*кг/gi)].map(m => parseFloat(m[1].replace(',', '.')))
// "20кг на 15" — обычная разговорная форма тренера, слово "повторений" не
// повторяется каждый раз; засчитываем оба варианта как явное число повторений.
// \w* после "повтор" — иначе "15 повторений" не матчится (\b сразу после
// "повтор" требует границы слова, а слово продолжается "-ений").
const mentionsReps = (text) => /\d+\s*повтор\w*|\d+\s*раз\b|кг\s*на\s*\d+/i.test(text)

const asksUserForId = (text) => /(укажи|назови|напиши|скажи|дай)[^.?\n]{0,20}\bid\b|какой (у записи )?id|номер записи/i.test(text)

// ── Вспомогательный конструктор сценариев ───────────────────────────────
const scenarios = []

function mk({ group, name, sets = [], survey, profile, setup = [], user, expect, extra }) {
  scenarios.push({
    group, name, sys: ctxWorkout(sets, { survey, profile }), setup, user, expect,
    check(text) {
      const issues = []
      if (hasMarkdown(text)) issues.push('есть markdown-символы')
      const visible = stripMarkers(text)
      if (LEAK_RE.test(visible)) issues.push('утечка внутренней терминологии методики (фаза/цикл/тоннаж/диапазон повторений)')
      if (extra) issues.push(...extra(text))
      return issues
    },
  })
}

// ── Группа: Стиль ответа ─────────────────────────────────────────────────

mk({
  group: 'Стиль ответа', name: 'холодный старт без истории',
  sets: [], user: 'какой вес брать сегодня на приседания',
  expect: 'Даёт конкретный лёгкий стартовый вес и число повторений, без терминов методики',
  extra: (t) => {
    const issues = []
    if (!kgNumbers(t).length) issues.push('нет конкретного веса в кг')
    if (!mentionsReps(t)) issues.push('нет конкретного числа повторений')
    return issues
  },
})
mk({
  group: 'Стиль ответа', name: 'клиент спрашивает почему такой вес',
  sets: [], setup: ['какой вес брать сегодня на приседания'], user: 'а почему именно такой вес, объясни логику',
  expect: 'Объясняет причину простыми словами, но всё ещё без терминов методики (фаза/цикл/тоннаж)',
})

const STANDARD_HISTORY = [
  S('Приседания', 28, 20, 15, 3), S('Приседания', 28, 20, 15, 3), S('Приседания', 28, 25, 15, 3), S('Приседания', 28, 25, 15, 3),
  S('Приседания', 21, 22, 11, 3), S('Приседания', 21, 22, 11, 3), S('Приседания', 21, 27, 11, 4), S('Приседания', 21, 27, 11, 3),
  S('Приседания', 14, 30, 7, 3), S('Приседания', 14, 30, 7, 4), S('Приседания', 14, 40, 7, 3), S('Приседания', 14, 40, 7, 3),
]
mk({
  group: 'Стиль ответа', name: 'вопрос про общий прогресс',
  sets: STANDARD_HISTORY, user: 'как вообще у меня дела с прогрессом по приседаниям',
  expect: 'Коротко резюмирует прогресс человеческим языком, без терминов методики',
})

// ── Группа: Правила реакции на нагрузку ──────────────────────────────────

// Правило 1: последняя силовая сессия — оба последних рабочих подхода 5/5
// → в следующий силовой раз не повышать вес, добавить рабочий подход.
const RULE1_HISTORY = [
  S('Приседания', 42, 15, 15, 3), S('Приседания', 42, 20, 15, 3), S('Приседания', 42, 22, 15, 3), S('Приседания', 42, 22, 15, 3),
  S('Приседания', 35, 15, 7, null), S('Приседания', 35, 20, 7, null), S('Приседания', 35, 40, 7, 5), S('Приседания', 35, 40, 7, 5),
  S('Приседания', 28, 20, 11, 3), S('Приседания', 28, 24, 11, 3), S('Приседания', 28, 24, 11, 3), S('Приседания', 28, 24, 11, 3),
  S('Приседания', 21, 20, 15, 3), S('Приседания', 21, 22, 15, 3), S('Приседания', 21, 24, 15, 3), S('Приседания', 21, 24, 15, 3),
  S('Приседания', 14, 22, 11, 3), S('Приседания', 14, 24, 11, 3), S('Приседания', 14, 26, 11, 3), S('Приседания', 14, 26, 11, 3),
]
mk({
  group: 'Правила реакции на нагрузку', name: 'правило 1 — два подхода 5/5 на силовом диапазоне',
  sets: RULE1_HISTORY, user: 'сегодня опять силовая — какой вес и сколько подходов делать на приседаниях',
  expect: 'Не повышает вес выше прошлого силового максимума (40кг), предлагает добавить рабочий подход вместо роста веса',
  extra: (t) => {
    const issues = []
    const kgs = kgNumbers(t)
    if (kgs.length && Math.max(...kgs) > 42) issues.push(`похоже увеличил вес выше прошлого силового максимума (${Math.max(...kgs)}кг, ожидалось не выше ~40-42кг)`)
    if (!/(добав\S*[^.?!]{0,30}подход|ещё[^.?!]{0,15}подход|дополнительн\S*[^.?!]{0,15}подход|(третий|четвёртый|пятый)\s+(рабочий\s+)?подход|подход\s+сверху|\d\s*рабочих?\s+подход\S*[^.?!]{0,15}вместо|вместо[^.?!]{0,15}(обычны[хй]|двух)[^.?!]{0,15}подход|(три|четыре|3|4)\s+рабочих)/i.test(t)) issues.push('не предложил добавить дополнительный рабочий подход вместо роста веса')
    return issues
  },
})

// Правило 2 ("тяжело на базе → уходим в изоляцию") убрано методикой — вместо
// него единый откат по упражнению (Слой 2), см. модульную проверку формулы
// ниже. Фикстура базы оставлена только как половина условия для правила 3.
const BASE_HARD_HISTORY = [
  S('Приседания', 10, 30, 11, 4), S('Приседания', 10, 32, 11, 4),
  S('Приседания', 7, 30, 11, 5), S('Приседания', 7, 32, 11, 5),
  S('Приседания', 3, 32, 11, 4), S('Приседания', 3, 34, 11, 5),
]

// Правило 3: тяжело и на базе, и на изоляции (оба ≥3 подходов, ≥50% тяжело) → разгрузка.
const RULE3_HISTORY = [
  ...BASE_HARD_HISTORY,
  S('Сгибание рук (косичка)', 10, 8, 15, 4), S('Сгибание рук (косичка)', 10, 8, 15, 5),
  S('Сгибание рук (косичка)', 7, 9, 15, 4), S('Сгибание рук (косичка)', 7, 9, 15, 5),
]
mk({
  group: 'Правила реакции на нагрузку', name: 'правило 3 — тяжело и на базе, и на изоляции',
  sets: RULE3_HISTORY, user: 'что делать сегодня, в последнее время всё тяжело даётся',
  expect: 'Предлагает более лёгкую разгрузочную тренировку в целом, не наращивает нагрузку',
  extra: (t) => !/(легч\S*|легк\S*|снизь|снизим|сниж\S*|уменьш|отдохн|разгруз|поберег|меньше|пони[зж]\S*|скромн\S*)/i.test(t) ? ['не предложил снизить нагрузку/разгрузочный режим'] : [],
})

// Правило 4: два последних объёмных занятия подряд — в обоих последний
// рабочий подход тяжело (≥4) → не наращивать вес на объёме дальше.
const RULE4_HISTORY = [
  S('Приседания', 42, 15, 15, 3), S('Приседания', 42, 15, 15, 3), S('Приседания', 42, 20, 15, 3), S('Приседания', 42, 20, 15, 4),
  S('Приседания', 35, 18, 11, 3), S('Приседания', 35, 18, 11, 3), S('Приседания', 35, 22, 11, 3), S('Приседания', 35, 22, 11, 3),
  S('Приседания', 28, 30, 7, 3), S('Приседания', 28, 30, 7, 3), S('Приседания', 28, 35, 7, 3), S('Приседания', 28, 35, 7, 3),
  S('Приседания', 21, 20, 15, 3), S('Приседания', 21, 20, 15, 3), S('Приседания', 21, 25, 15, 3), S('Приседания', 21, 25, 15, 5),
  S('Приседания', 14, 20, 11, 3), S('Приседания', 14, 20, 11, 3), S('Приседания', 14, 24, 11, 3), S('Приседания', 14, 24, 11, 3),
  S('Приседания', 7, 32, 7, 3), S('Приседания', 7, 32, 7, 3), S('Приседания', 7, 38, 7, 3), S('Приседания', 7, 38, 7, 3),
]
mk({
  group: 'Правила реакции на нагрузку', name: 'правило 4 — два объёмных подряд тяжело',
  sets: RULE4_HISTORY, user: 'сегодня опять объёмная тренировка — какой вес брать на приседаниях',
  expect: 'Не поднимает вес выше прошлого объёмного максимума (25кг) — держит или снижает',
  extra: (t) => {
    const kgs = kgNumbers(t)
    return kgs.length && Math.max(...kgs) > 27 ? [`похоже продолжил наращивать вес на объёмной фазе (${Math.max(...kgs)}кг), хотя должен был снизить/удержать`] : []
  },
})

// ── Группа: Прогрессия ────────────────────────────────────────────────────

// Тоннаж считается ТОЛЬКО по 2 последним (рабочим) подходам дня — первые 2
// всегда разминочные и не в счёт. Рейтинг 2/2 на рабочих подходах → рост
// тоннажа +7% по таблице методики (RATING_GROWTH_PCT в workoutPrompt.js).
// На фазе Развитие у изоляции диапазон повторений фиксирован (15, без
// разброса), поэтому рост тоннажа обязан проявиться именно ростом веса, а не
// повторений — проверка однозначна независимо от того, как AI решит вес и
// повторы поделить.
const PROGRESS_HISTORY = [
  S('Ягодичный мост со штангой', 14, 10, 15, null), S('Ягодичный мост со штангой', 14, 10, 15, null),
  S('Ягодичный мост со штангой', 14, 16, 15, 2), S('Ягодичный мост со штангой', 14, 16, 15, 2),
]
mk({
  group: 'Прогрессия', name: 'лёгкие рабочие подходы (оценка 2/2) — вес должен вырасти к следующему разу',
  sets: PROGRESS_HISTORY, user: 'сегодня снова та же тренировка что в прошлый раз, что взять по весу на ягодичном мосте со штангой',
  expect: 'Тоннаж дня по всем подходам 10×15+10×15+16×15+16×15=780, оценка 2/2 на рабочих → +7% → цель 835кг тоннажа; диапазон повторений фазы фиксирован на 15, поэтому рост обязан выйти через вес — называет вес выше 16кг на рабочих подходах',
  extra: (t) => {
    const kgs = kgNumbers(t)
    const issues = []
    if (!kgs.length) issues.push('нет конкретного веса в кг')
    else if (Math.max(...kgs) <= 16) issues.push(`вес не вырос относительно прошлого раза (${Math.max(...kgs)}кг ≤ 16кг)`)
    if (!mentionsReps(t)) issues.push('нет конкретного числа повторений')
    return issues
  },
})

// ── Группа: Конструктор программы ────────────────────────────────────────

const FULLBODY_SURVEY = { experience: 'medium', contraindications: null, favorite_exercises: ['Приседания'], focus_muscles: ['Ноги'], system: 'full' }
mk({
  group: 'Конструктор программы', name: 'фулбади — 6 упражнений (2 база + 1 изоляция на акцент + 3 всё тело)',
  sets: [], survey: FULLBODY_SURVEY,
  user: 'Составь мне тренировку на сегодня. В приседаниях работаю с 40 кг, жим гантелей на наклонной скамье делаю с 8 кг. Остальные упражнения — на твой выбор, предложи лёгкий вес сам.',
  expect: 'SET_PROGRAM с 6 упражнениями: 2 многосуставных база, 1 изолирующее на акцент (ноги), 3 из категории "Всё тело", все названия из справочника',
  extra: (t) => {
    const program = extractSetProgram(t)
    if (!program) return ['нет маркера SET_PROGRAM']
    const session = program.sessions?.[0]
    if (!session) return ['в SET_PROGRAM нет ни одной сессии']
    const issues = []
    const exNames = (session.exercises || []).map(e => e.exercise)
    if (exNames.length !== 6) issues.push(`ожидалось 6 упражнений, получено ${exNames.length}`)
    const validNames = EXERCISES.map(e => e.n)
    const unknown = exNames.filter(n => !validNames.includes(n))
    if (unknown.length) issues.push(`упражнения вне справочника: ${unknown.join(', ')}`)
    const byName = Object.fromEntries(EXERCISES.map(e => [e.n, e]))
    const baseCompoundCount = exNames.filter(n => byName[n]?.type === 'compound' && byName[n]?.m !== 'Всё тело').length
    const wholeBodyCount = exNames.filter(n => byName[n]?.m === 'Всё тело').length
    const isolationCount = exNames.filter(n => byName[n]?.type === 'isolation').length
    if (baseCompoundCount < 2) issues.push(`меньше 2 базовых многосуставных упражнений (${baseCompoundCount})`)
    if (wholeBodyCount < 3) issues.push(`меньше 3 упражнений категории "Всё тело" (${wholeBodyCount})`)
    if (isolationCount < 1) issues.push(`нет изолирующего упражнения на акцент (${isolationCount})`)
    for (const ex of session.exercises || []) {
      if (!ex.sets?.length) issues.push(`у упражнения "${ex.exercise}" нет подходов`)
      else if (ex.sets.some(s => s.reps == null || s.recKg == null)) issues.push(`у упражнения "${ex.exercise}" подход без reps/recKg`)
    }
    return issues
  },
})

const SPLIT_SURVEY = { experience: 'medium', contraindications: null, favorite_exercises: ['Тяга верхнего блока'], focus_muscles: ['Спина'], system: 'split' }
mk({
  group: 'Конструктор программы', name: 'сплит — 5 упражнений (2 база + 3 изоляция)',
  sets: [], survey: SPLIT_SURVEY,
  user: 'Составь мне тренировку на сегодня на спину. Тягу верхнего блока делаю с 25 кг. Остальное подбери сам, лёгкий вес для начала.',
  expect: 'SET_PROGRAM с 5 упражнениями: 2 многосуставных база, 3 изолирующих, все названия из справочника',
  extra: (t) => {
    const program = extractSetProgram(t)
    if (!program) return ['нет маркера SET_PROGRAM']
    const session = program.sessions?.[0]
    if (!session) return ['в SET_PROGRAM нет ни одной сессии']
    const issues = []
    const exNames = (session.exercises || []).map(e => e.exercise)
    if (exNames.length !== 5) issues.push(`ожидалось 5 упражнений, получено ${exNames.length}`)
    const validNames = EXERCISES.map(e => e.n)
    const unknown = exNames.filter(n => !validNames.includes(n))
    if (unknown.length) issues.push(`упражнения вне справочника: ${unknown.join(', ')}`)
    const byName = Object.fromEntries(EXERCISES.map(e => [e.n, e]))
    const compoundCount = exNames.filter(n => byName[n]?.type === 'compound').length
    const isolationCount = exNames.filter(n => byName[n]?.type === 'isolation').length
    if (compoundCount < 2) issues.push(`меньше 2 базовых упражнений (${compoundCount})`)
    if (isolationCount < 3) issues.push(`меньше 3 изолирующих упражнений (${isolationCount})`)
    for (const ex of session.exercises || []) {
      if (!ex.sets?.length) issues.push(`у упражнения "${ex.exercise}" нет подходов`)
    }
    return issues
  },
})

mk({
  group: 'Конструктор программы', name: 'отказ расписывать программу на месяц вперёд',
  sets: [], survey: FULLBODY_SURVEY,
  user: 'Распиши мне подробную программу тренировок на весь следующий месяц вперёд.',
  expect: 'Не выдаёт программу на месяц — тактично объясняет, что вперёд надолго не планируют, предлагает только ближайшую тренировку',
  extra: (t) => {
    const issues = []
    const program = extractSetProgram(t)
    if (program && (program.sessions || []).length > 3) issues.push(`составил план больше чем на 3 сессии (${program.sessions.length}) — похоже расписал на долгий срок`)
    if (!/(наперёд|заранее|вперёд|подстра|состояни|не расписыва|не планиру)/i.test(t)) issues.push('не объяснил, почему не расписывает надолго')
    return issues
  },
})

mk({
  group: 'Конструктор программы', name: 'несколько тренировок на неделю — сначала спрашивает дни',
  sets: [], survey: FULLBODY_SURVEY,
  user: 'Составь мне 3 тренировки на эту неделю.',
  expect: 'Не ставит SET_PROGRAM сразу — сначала спрашивает, на какие дни их поставить',
  extra: (t) => {
    const issues = []
    if (extractSetProgram(t)) issues.push('поставил SET_PROGRAM сразу, не спросив дни для нескольких тренировок')
    if (!/(как[иеой]+\s+дни|дни\s+недели|на какие дни|в как[ие]+ дни)/i.test(t)) issues.push('не спросил явно, на какие дни ставить тренировки')
    if (!/\?/.test(t)) issues.push('нет вопроса клиенту')
    return issues
  },
})

mk({
  group: 'Конструктор программы', name: 'несколько тренировок — использует названные клиентом дни, не все на сегодня',
  sets: [], survey: FULLBODY_SURVEY,
  setup: ['Составь мне 3 тренировки на эту неделю.'],
  user: 'Давай понедельник, среду и пятницу. В приседаниях работаю с 40 кг, остальное подбери сам, лёгкий вес для старта.',
  expect: 'SET_PROGRAM с 3 сессиями на разные даты (не все три на сегодня)',
  extra: (t) => {
    const program = extractSetProgram(t)
    if (!program) return ['нет маркера SET_PROGRAM после того как клиент назвал дни']
    const dates = (program.sessions || []).map(s => s.date)
    const issues = []
    if (dates.length !== 3) issues.push(`ожидалось 3 сессии, получено ${dates.length}`)
    if (new Set(dates).size !== dates.length) issues.push(`не все даты разные: ${dates.join(', ')}`)
    if (dates.every(d => d === TODAY)) issues.push('все тренировки поставлены на сегодня, хотя клиент назвал разные дни')
    return issues
  },
})

const NOVICE_SURVEY = { experience: 'novice', contraindications: null, favorite_exercises: [], focus_muscles: ['Ноги'], system: 'full' }
mk({
  group: 'Конструктор программы', name: 'новичок без названного веса — AI сам предлагает лёгкий старт',
  sets: [], survey: NOVICE_SURVEY,
  user: 'Составь мне тренировку, я вообще не знаю какой вес брать.',
  expect: 'Предлагает лёгкий стартовый вес сам, с дружелюбным комментарием про новичка, а не требует от клиента назвать вес',
  extra: (t) => {
    const issues = []
    if (!/(новичк|начин|начнём|перв(ый|ая) раз|только начал|с малого|небольш\S* вес|легк\S*|простого)/i.test(t)) issues.push('нет дружелюбного комментария про старт с лёгкого для новичка')
    const program = extractSetProgram(t)
    if (!program && !kgNumbers(t).length) issues.push('не предложил ни одного конкретного веса')
    return issues
  },
})

// ── Группа: Защита от пересчёта (JS считает готовые числа/пороги, AI не сам) ──

// Всего 2 оценённых подхода за 14 дней — порог сигнала (MIN_SAMPLES=3) ещё не
// достигнут, JS не поднимает флаг правила 2. AI не должен сам придумать
// сигнал разгрузки по паре тяжёлых подходов.
const BELOW_THRESHOLD_HISTORY = [S('Приседания', 5, 30, 11, 5), S('Приседания', 5, 32, 11, 5)]
mk({
  group: 'Защита от пересчёта', name: 'недостаточно данных для сигнала — AI не выдумывает сам',
  sets: BELOW_THRESHOLD_HISTORY, user: 'что скажешь по приседаниям, стоит прибавить вес?',
  expect: 'Всего 2 оценённых подхода (порог сигнала — 3) — JS ещё не поднял сигнал, AI не придумывает разгрузку сам из пары тяжёлых подходов',
  extra: (t) => /(разгруз|снизь вес|уменьш\S*\s*вес|поберег)/i.test(t) ? ['похоже сам придумал сигнал разгрузки при недостаточном количестве данных (порог — 3 оценённых подхода)'] : [],
})

// ── Группа: Маркеры ────────────────────────────────────────────────────────

mk({
  group: 'Маркеры', name: 'ADD_SET — запись нового подхода с качественной оценкой',
  sets: [], user: 'сделал присед 32 на 12, было нормально',
  expect: `Записывает ADD_SET на сегодня (${TODAY}) с kg:32, reps:12, rating:3 ("нормально"→3)`,
  extra: (t) => {
    const add = markers(t, 'ADD_SET')
    if (!add.length) return ['нет маркера ADD_SET']
    const issues = []
    if (add[0].exercise !== 'Приседания') issues.push(`неверное название упражнения в маркере: ${add[0].exercise}`)
    if (+add[0].kg !== 32) issues.push(`неверный вес в маркере: ${add[0].kg}`)
    if (+add[0].reps !== 12) issues.push(`неверные повторения в маркере: ${add[0].reps}`)
    if (add[0].date !== TODAY) issues.push(`дата не сегодня: ${add[0].date}`)
    if (add[0].rating != null && +add[0].rating !== 3) issues.push(`оценка "нормально" переведена не в 3, а в ${add[0].rating}`)
    return issues
  },
})

const editTarget = S('Приседания', 0, 30, 10, 3)
mk({
  group: 'Маркеры', name: 'EDIT_SET — корректировка веса без вопроса про ID',
  sets: [editTarget], user: 'я перепутал, на приседаниях сегодня было не 30 а 34 кг',
  expect: `Сам находит подход по названию+дате (id:${editTarget.id}) и корректирует kg на 34, не спрашивая ID`,
  extra: (t) => {
    const issues = []
    if (asksUserForId(t)) issues.push('спросил у пользователя ID записи')
    const edit = markers(t, 'EDIT_SET')
    if (!edit.length) { issues.push('нет маркера EDIT_SET'); return issues }
    if (edit[0].id !== editTarget.id) issues.push(`не тот id (${edit[0].id}, ожидался ${editTarget.id})`)
    if (+edit[0].kg !== 34) issues.push(`неверный скорректированный вес: ${edit[0].kg}`)
    return issues
  },
})

const delTarget = S('Приседания', 0, 28, 12, 3)
mk({
  group: 'Маркеры', name: 'DEL_SET — удаление подхода без вопроса про ID',
  sets: [delTarget], user: 'убери подход по приседаниям за сегодня, я ошибся и не должен был его записывать',
  expect: `Сам находит подход (id:${delTarget.id}) и удаляет, не спрашивая ID`,
  extra: (t) => {
    const issues = []
    if (asksUserForId(t)) issues.push('спросил у пользователя ID записи')
    const del = markers(t, 'DEL_SET')
    if (!del.length) { issues.push('нет маркера DEL_SET'); return issues }
    if (del[0].id !== delTarget.id) issues.push(`не тот id (${del[0].id}, ожидался ${delTarget.id})`)
    return issues
  },
})

// ── Группа: Библиотека упражнений ────────────────────────────────────────

mk({
  group: 'Библиотека упражнений', name: 'разговорное название сопоставляется с точным из справочника',
  sets: [], user: 'запиши присед 35 на 10, некисло было',
  expect: 'В ADD_SET название упражнения — точное "Приседания" из справочника, не разговорное "присед"',
  extra: (t) => {
    const add = markers(t, 'ADD_SET')
    if (!add.length) return ['нет маркера ADD_SET']
    return add[0].exercise !== 'Приседания' ? [`название не сопоставлено с точным из справочника: "${add[0].exercise}"`] : []
  },
})
mk({
  group: 'Библиотека упражнений', name: 'несуществующее упражнение — не выдумывает',
  sets: [], user: 'запиши жим штанги лёжа 40 на 10, было тяжело',
  expect: 'В библиотеке нет "жима штанги лёжа" — AI либо уточняет/предлагает похожее из справочника, либо не пишет ADD_SET с этим названием',
  extra: (t) => {
    const add = markers(t, 'ADD_SET')
    if (!add.length) return []
    const validNames = EXERCISES.map(e => e.n)
    return !validNames.includes(add[0].exercise) ? [`записал несуществующее упражнение вне справочника: "${add[0].exercise}"`] : []
  },
})

// ── Модульная проверка формулы Слоя 1/2 (без API, чисто JS, детерминированно) ──
// Проверяет саму формулу прогрессии напрямую в сгенерированном промпте —
// независимо от того, как AI её потом озвучит. Ловит регрессии в формуле,
// которые API-сценарии не могут поймать надёжно (модель не всегда точно
// повторяет исходные числа).
function checkFormula() {
  const checks = []

  // Слой 1: одна сессия, рейтинг 2/2 на рабочих подходах, тоннаж — ПО ВСЕМ
  // 4 подходам дня (разминка + рабочие): 10кг×15+10кг×15+16кг×15+16кг×15=780
  // → +7% по таблице (оценка 2/2 на рабочих) → round(780×1.07)=835.
  {
    const sets = [
      S('Ягодичный мост со штангой', 14, 10, 15, null), S('Ягодичный мост со штангой', 14, 10, 15, null),
      S('Ягодичный мост со штангой', 14, 16, 15, 2), S('Ягодичный мост со штангой', 14, 16, 15, 2),
    ]
    const prompt = ctxWorkout(sets)
    const expected = 'цель на следующий раз в фазе Развитие: 835кг тоннажа (рост по оценке нагрузки: +7%)'
    checks.push({ name: 'Слой 1 — рост тоннажа по таблице оценок, тоннаж по всем подходам (мост, рейтинг 2/2 → +7%)', pass: prompt.includes(expected), detail: expected })
  }

  // Слой 2: два раза подряд тяжело (последний рабочий подход 5, затем 4) →
  // откат к последнему уровню с оценкой 3 — это сессия "35 дней назад"
  // (более свежая тройка, чем "42 дня назад"), где рабочий вес был 18кг×15,
  // а тоннаж ВСЕГО дня (разминка 16×15×2 + рабочие 18×15×2) = 1020.
  {
    const sets = [
      S('Ягодичный мост со штангой', 42, 10, 15, null), S('Ягодичный мост со штангой', 42, 10, 15, null),
      S('Ягодичный мост со штангой', 42, 16, 15, 3), S('Ягодичный мост со штангой', 42, 16, 15, 3),
      S('Ягодичный мост со штангой', 35, 16, 15, null), S('Ягодичный мост со штангой', 35, 16, 15, null),
      S('Ягодичный мост со штангой', 35, 18, 15, 3), S('Ягодичный мост со штангой', 35, 18, 15, 3),
      S('Ягодичный мост со штангой', 28, 18, 15, null), S('Ягодичный мост со штангой', 28, 18, 15, null),
      S('Ягодичный мост со штангой', 28, 20, 15, 4), S('Ягодичный мост со штангой', 28, 20, 15, 5),
      S('Ягодичный мост со штангой', 21, 20, 15, null), S('Ягодичный мост со штангой', 21, 20, 15, null),
      S('Ягодичный мост со штангой', 21, 21, 15, 4), S('Ягодичный мост со штангой', 21, 21, 15, 4),
    ]
    const prompt = ctxWorkout(sets)
    const expectedTarget = 'ОТКАТ, цель на следующий раз: 1020кг тоннажа'
    const expectedFlag = 'Верни цель по тоннажу для всех его фаз к уровню 18кг×15 (1020кг тоннажа'
    checks.push({ name: 'Слой 2 — откат к последнему комфортному уровню, тоннаж по всем подходам (мост, 2 раза подряд тяжело)', pass: prompt.includes(expectedTarget) && prompt.includes(expectedFlag), detail: `${expectedTarget} / ${expectedFlag}` })
  }

  console.log('── Модульная проверка формулы (без API) ──────────────────')
  let allPass = true
  for (const c of checks) {
    console.log(`${c.pass ? '✓' : '✗'} ${c.name}`)
    if (!c.pass) { allPass = false; console.log(`   ожидалась строка в промпте: "${c.detail}"`) }
  }
  console.log('')
  return allPass
}

// ── Запуск ────────────────────────────────────────────────────────────────

async function callClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    // 2000, не 1000 — SET_PROGRAM может нести до 6 упражнений по 4 подхода в
    // одном маркере, тесного бюджета для остального сценариев тоже хватает.
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages }),
  })
  const data = await res.json()
  const raw = data?.content?.[0]?.text
  if (!raw) throw new Error(data?.error?.message || `пустой ответ (HTTP ${res.status})`)
  return raw
}

function truncate(s, n) {
  const oneLine = s.replace(/\n/g, ' ⏎ ')
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

async function run() {
  const results = []
  for (const sc of scenarios) {
    process.stdout.write(`▶ [${sc.group}] ${sc.name} ... `)
    try {
      let history = []
      for (const setupMsg of sc.setup) {
        const setupRaw = await callClaude(sc.sys, [...history, { role: 'user', content: setupMsg }])
        history.push({ role: 'user', content: setupMsg }, { role: 'assistant', content: setupRaw })
      }
      const raw = await callClaude(sc.sys, [...history, { role: 'user', content: sc.user }])
      const issues = sc.check(raw)
      results.push({ group: sc.group, name: sc.name, expect: sc.expect, response: raw, pass: issues.length === 0, issues })
      console.log(issues.length === 0 ? 'OK' : `FAIL (${issues.length})`)
    } catch (e) {
      results.push({ group: sc.group, name: sc.name, expect: sc.expect, response: `[ошибка запроса: ${e.message}]`, pass: false, issues: [e.message] })
      console.log('ERROR')
    }
  }
  return results
}

function printTable(results) {
  const rows = results.map(r => ({
    'Группа': r.group,
    'Сценарий': r.name,
    'Ответ AI': truncate(stripMarkers(r.response), 80),
    'Статус': r.pass ? '✓ OK' : '✗ FAIL',
    'Проблема': r.issues.length ? r.issues.join('; ') : '—',
  }))
  console.table(rows)

  const passed = results.filter(r => r.pass).length
  const pct = ((passed / results.length) * 100).toFixed(1)
  console.log(`\nИтого: ${passed}/${results.length} пройдено (${pct}%)`)

  const byGroup = {}
  for (const r of results) {
    byGroup[r.group] ??= { pass: 0, total: 0 }
    byGroup[r.group].total++
    if (r.pass) byGroup[r.group].pass++
  }
  console.log('\nПо группам:')
  for (const [g, s] of Object.entries(byGroup)) console.log(`  ${g}: ${s.pass}/${s.total}`)

  const failed = results.filter(r => !r.pass)
  if (failed.length) {
    console.log('\n── Провалены (детали) ──────────────────────────────────')
    for (const r of failed) {
      console.log(`\n[${r.group}] ${r.name}`)
      console.log(`  Ожидалось: ${r.expect}`)
      console.log(`  Проблемы: ${r.issues.join('; ')}`)
      console.log(`  Ответ: ${truncate(stripMarkers(r.response), 400)}`)
    }
  }
}

const formulaOk = checkFormula()
const results = await run()
printTable(results)
process.exit(results.every(r => r.pass) && formulaOk ? 0 : 1)
