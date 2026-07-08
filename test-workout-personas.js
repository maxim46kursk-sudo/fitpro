// Персонажный тестировщик AI-тренера (режим "Тренировки"), по образцу
// test-personas.js (тот прогоняет AI-диетолога). 6 виртуальных клиентов ведут
// каждый свой диалог с ТЕМ ЖЕ buildWorkoutSystemPrompt, что и продакшен-код
// (src/workoutPrompt.js), через реальный Anthropic API. Маркеры
// ADD_SET/DEL_SET/EDIT_SET/SET_PROGRAM применяются к локальному in-memory
// состоянию (аналог workout_sets), как AIAssistant.jsx применяет их к
// Supabase — чтобы диалог был связным (составил программу → записал подход →
// поправил вес → удалил лишнее, и всё это видно в истории следующего хода).
//
// ВАЖНО про тестовый аккаунт: этот скрипт, как и test-workout.js/
// test-personas.js, НЕ создаёт и не трогает пользователей Supabase вообще —
// это чистая симуляция в памяти поверх прямого вызова Anthropic API. Поэтому
// требование "один переиспользуемый аккаунт, не плодить новые" здесь
// выполняется автоматически: создавать нечего, rate limit регистрации не
// затрагивается ни для одной из 6 персон.
//
// Каждая персона проходит: составление программы (фулбади/сплит, анкета,
// противопоказания) → занесение в дневник (текстовая часть ответа + отметка,
// что по маркеру SET_PROGRAM в реальном приложении появится кнопка "Перейти
// к тренировке" — сам факт клика по кнопке и открытие дневника не
// API-тестируемы, это UI навигации) → редактирование подхода словами
// (EDIT_SET) → удаление подхода словами (DEL_SET) → плюс персонажные пробы
// (тактичность отказа на резкий рост веса, устойчивость стиля под прямыми
// вопросами про методику, учёт противопоказаний).
//
// РУЧНОЕ редактирование пальцем прямо в дневнике (ввод веса в поле в
// WorkoutsView) через API недостижимо в принципе — это чистый UI-клик без
// участия AI. Такая часть оценена ОТДЕЛЬНО, трассировкой кода
// (см. codeTraceManualEditReview ниже), и явно помечена как не-живой прогон.
//
// После диалога каждая персона сама оценивает опыт (1-10, фидбэк), плюс
// отдельно оценивает удобство всей цепочки действий. В конце — синтез общих
// проблем по всем 6 персонам.
//
// Персонажи переориентированы на реальную аудиторию приложения (в основном
// женская: ягодицы, похудение/живот) после первого прогона на абстрактных
// личностях. У части персон есть {text, check} вместо простой строки —
// check(rawResponse) возвращает доп. находки для конкретного хода, например
// проверку на нереалистичные обещания в ответ на вопрос о прогнозе прогресса.
//
// Запуск: node test-workout-personas.js

import { readFileSync } from 'node:fs'
import { buildWorkoutSystemPrompt } from './src/workoutPrompt.js'
import { EXERCISES } from './src/programs.js'

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
const YEAR = new Date().getFullYear()

if (!API_KEY) {
  console.error('Нет VITE_ANTHROPIC_KEY (проверь .env)')
  process.exit(1)
}

async function callClaude(system, messages, maxTokens = 2000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  })
  const data = await res.json()
  const raw = data?.content?.[0]?.text
  if (!raw) throw new Error(data?.error?.message || `пустой ответ (HTTP ${res.status})`)
  return raw
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

const stripMarkers = (text) => {
  let t = text
  const spIdx = t.indexOf('[SET_PROGRAM:')
  if (spIdx !== -1) {
    const jsonEnd = t.lastIndexOf(']')
    if (jsonEnd > spIdx) t = t.slice(0, spIdx) + t.slice(jsonEnd + 1)
  }
  return t.replace(/\[(ADD_SET|DEL_SET|EDIT_SET|SUGGEST_SURVEY):?(\{[^}]*\})?\]/g, '').trim()
}
const compact = (text) => text.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()

// Термины внутренней кухни методики — не должны появляться в видимом клиенту
// тексте (см. STYLE_RULE в workoutPrompt.js).
const LEAK_RE = /фаза|волновой\s+цикл|\bцикл\w*|тоннаж|диапазон\s+повторени|\d{3,}\s*(кг)?\s*против\s+\d/i
const MD_RE = /\*\*|\*|^#{1,6}\s|`[^`]+`|^[+\-•]\s/m
const kgNumbers = (text) => [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*кг/gi)].map(m => parseFloat(m[1].replace(',', '.')))

// Применяет маркеры из ответа AI к локальному состоянию диалога — так же,
// как AIAssistant.jsx применяет их к workout_sets в Supabase, только в памяти.
// Возвращает список "[ПРОВЕРКА: ...]" строк — объективные автоматические
// находки по этому конкретному ходу диалога (для отчёта, не для персоны).
function applyMarkers(raw, state) {
  const checks = []

  if (MD_RE.test(raw)) checks.push('markdown в ответе')
  if (LEAK_RE.test(stripMarkers(raw))) checks.push('утечка внутренней терминологии методики (фаза/цикл/тоннаж/диапазон повторений)')

  for (const a of markers(raw, 'ADD_SET')) {
    state.sets.push({
      id: state.nextId++, exercise: a.exercise, date: a.date || TODAY,
      kg: a.kg != null ? Number(a.kg) : null, reps: a.reps != null ? Number(a.reps) : null,
      rating: a.rating != null ? Number(a.rating) : null, recommended_kg: null,
    })
    checks.push(`ADD_SET: ${a.exercise} ${a.kg ?? '?'}кг×${a.reps ?? '?'}${a.rating != null ? `, оценка ${a.rating}` : ''}`)
  }
  for (const d of markers(raw, 'DEL_SET')) {
    const existed = state.sets.some(s => s.id === d.id)
    state.sets = state.sets.filter(s => s.id !== d.id)
    checks.push(existed ? `DEL_SET: удалил id:${d.id}` : `DEL_SET: указал несуществующий id:${d.id}`)
  }
  for (const e of markers(raw, 'EDIT_SET')) {
    const found = state.sets.find(s => s.id === e.id)
    if (found) {
      if (e.kg != null) found.kg = Number(e.kg)
      if (e.reps != null) found.reps = Number(e.reps)
      if (e.rating != null) found.rating = Number(e.rating)
      checks.push(`EDIT_SET: id:${e.id} → ${found.kg}кг×${found.reps}`)
    } else {
      checks.push(`EDIT_SET: указал несуществующий id:${e.id}`)
    }
  }
  const program = extractSetProgram(raw)
  if (program) {
    const validNames = EXERCISES.map(ex => ex.n)
    let exCount = 0
    for (const session of program.sessions || []) {
      for (const ex of session.exercises || []) {
        exCount++
        if (!validNames.includes(ex.exercise)) checks.push(`SET_PROGRAM: упражнение вне справочника — "${ex.exercise}"`)
        for (const s of ex.sets || []) {
          state.sets.push({
            id: state.nextId++, exercise: ex.exercise, date: session.date || TODAY,
            kg: null, reps: s.reps != null ? Number(s.reps) : null,
            recommended_kg: s.recKg != null ? Number(s.recKg) : null, rating: null,
          })
        }
      }
    }
    state.lastProgram = program
    checks.push(`SET_PROGRAM: ${(program.sessions || []).length} сессия(й), ${exCount} упражнений всего — [UI] в реальном приложении здесь появилась бы запись в дневнике "Тренировка от AI-ассистента" и кнопка "Перейти к тренировке" под этим сообщением`)
  }
  if (/\[SUGGEST_SURVEY\]/.test(raw)) checks.push('SUGGEST_SURVEY — неожиданно для персоны с уже заполненной анкетой')

  return checks
}

// Проверка ответа на вопрос-прогноз ("через месяц сколько смогу?") — тренер
// не должен обещать конкретную будущую цифру как гарантию (ложное обещание),
// но должен честно объяснить, что прогресс индивидуален и не гарантирован.
function checkNoGoldenPromise(raw) {
  const clean = stripMarkers(raw)
  const issues = []
  const overPromise = /через\s+(\d+\s*)?(месяц|недел)\S*[^.?!]{0,40}\b\d{2,3}\s*кг\b/i.test(clean)
    || /\bбудешь\s+(жать|поднимать|приседать|делать|тянуть)[^.?!]{0,30}\d{2,3}\s*кг/i.test(clean)
  const hedges = /(индивидуал|завис|по (факту|ощущени)|не (могу|буду|стану) гаранти|точно не (скаж|обещ)|нельзя гаранти|плавно|постепенно|по-разному)/i.test(clean)
  if (overPromise) issues.push('похоже дал конкретное обещание веса к будущей дате — нереалистичное обещание')
  if (!hedges) issues.push('не объяснил, что прогресс индивидуален и не гарантирован')
  return issues
}

// ── 6 персон под тренировки (реальная аудитория приложения) ─────────────

const PERSONAS = [
  {
    key: 'nastya', name: 'Настя', age: 24,
    description: 'Новичок без опыта тренировок, цель — накачать ягодицы. Не знает рабочие веса, боится тяжёлого, тревожится за пропуски.',
    profile: { name: 'Настя', weight: 58, goal: 'Ягодицы', activity_level: 'sedentary', program: null, ai_style: 'act' },
    survey: { experience: 'novice', contraindications: null, favorite_exercises: [], focus_muscles: ['Ягодицы'], system: 'full' },
    idBase: 1000,
    script: [
      'Привет! Хочу накачать ягодицы, вообще не знаю с чего начать, поможешь составить тренировку?',
      'Не знаю какие веса брать, я вообще ни разу не занималась',
      'Ой, а не будет слишком тяжело? Я боюсь что не потяну',
      'Хорошо, давай попробую. А как мне потом найти эту тренировку в приложении?',
      'Сделала первый подход на ягодичном мосту, 15 кг на 12 раз, было норм',
      'Ой подождите, я перепутала, там было 12 кг а не 15',
      'А ещё я по ошибке записала лишний подход, можешь убрать?',
      'А если я один раз пропущу тренировку, это всё испортит?',
      'Спасибо большое, вы очень доступно объясняете!',
    ],
  },
  {
    key: 'marina', name: 'Марина', age: 30,
    description: 'Похудение, хочет убрать живот. Средний стаж, практичная, проверяет мифы про локальное жиросжигание.',
    profile: { name: 'Марина', weight: 72, goal: 'Похудение, убрать живот', activity_level: 'sedentary', program: null, ai_style: 'act' },
    survey: { experience: 'medium', contraindications: null, favorite_exercises: [], focus_muscles: ['Кор'], system: 'full' },
    idBase: 2000,
    script: [
      'Привет, хочу убрать живот, составь мне тренировку пожалуйста',
      'Приседания раньше делала с 20 кг, остальное не пробовала',
      'А упражнения на пресс правда уберут жир именно с живота?',
      'Ладно, давай попробуем. А где потом смотреть эту тренировку?',
      'Сделала присед 20 на 15, нормально было',
      'Хочу поправить — на самом деле было 22 кг',
      'Ещё подход хочу убрать, ошиблась при записи',
      'Сколько раз в неделю в идеале тренироваться чтобы быстрее убрать живот?',
      'Спасибо большое!',
    ],
  },
  {
    key: 'elena', name: 'Елена', age: 35,
    description: 'Опытная, акцент на ягодицы и ноги. Пишет коротко, хочет конкретики, раздражается на воду и лишние вступления.',
    profile: { name: 'Елена', weight: 64, goal: 'Ягодицы и ноги', activity_level: 'high', program: null, ai_style: 'act' },
    survey: { experience: 'advanced', contraindications: null, favorite_exercises: ['Румынская тяга со штангой', 'Ягодичный мост со штангой'], focus_muscles: ['Ягодицы'], system: 'split' },
    idBase: 3000,
    script: [
      'Составь сплит на ягодицы и ноги. Румынку делаю на 60кг, ягодичный мост со штангой на 50кг',
      'Погнали. По остальным весам сама прикинь, не хочу тратить время на вопросы',
      'Без длинных вступлений, давай сразу по делу',
      'Сделала румынку 60 на 10, легко',
      'Поправь — на самом деле было 62',
      'Убери один подход, записала два раза одно и то же по ошибке',
      'Сколько тренировок в неделю по сплиту оптимально для ягодиц и ног',
      'Как прогресс по румынке, растёт?',
      'Погнали дальше',
    ],
  },
  {
    key: 'katya', name: 'Катя', age: 27,
    description: 'Нетерпеливая, хочет результат к лету. Давит на скорость прогресса — проверяет честность прогноза и отсутствие golden promise.',
    profile: { name: 'Катя', weight: 68, goal: 'Похудение и ягодицы к лету', activity_level: 'moderate', program: null, ai_style: 'act' },
    survey: { experience: 'medium', contraindications: null, favorite_exercises: ['Ягодичный мост со штангой'], focus_muscles: ['Ягодицы'], system: 'full' },
    idBase: 4000,
    script: [
      'Сделала ягодичный мост 40 кг на 10, было норм. Хочу результат к лету, можно побыстрее прогрессировать?',
      { text: 'Через месяц сколько смогу поднимать, если сейчас 40 на 10?', check: checkNoGoldenPromise },
      'Ну хочу хотя бы примерно понимать, дай ориентир',
      'А можно тренироваться через день вместо обычной схемы, чтобы быстрее?',
      'Составь мне тренировку тоже, на неделю',
      'Пн, ср, пт',
      'А если я вообще каждый день буду заниматься, быстрее будет результат?',
      'Ладно, поняла. Удали первый подход ягодичного мостика, перезапишу',
      'Спасибо',
    ],
  },
  {
    key: 'olga', name: 'Ольга', age: 40,
    description: 'С противопоказанием — болит поясница. Проверяет учёт ограничения при составлении программы и честность про риски.',
    profile: { name: 'Ольга', weight: 75, goal: 'Похудение', activity_level: 'sedentary', program: null, ai_style: 'ask' },
    survey: { experience: 'medium', contraindications: 'Боль в пояснице, тяжело наклоняться со штангой (румынская тяга и наклоны)', favorite_exercises: [], focus_muscles: ['Ягодицы'], system: 'full' },
    idBase: 5000,
    script: [
      'Составь тренировку, но у меня болит поясница, наклоны со штангой и румынскую тягу делать не хочу',
      'А чем заменил тягу на ягодицы тогда?',
      'Это точно не нагрузит поясницу?',
      'Ладно давай попробуем. Какой вес взять на то что предложил, не занималась таким',
      'Понятия не имею какой вес, в первый раз именно с этим упражнением',
      'Записала первый подход 12 на 15, более-менее',
      'Хочу убрать, ошиблась в весе, перезапишу',
      'Спасибо что учли поясницу, реально переживала',
      'Если заболит сильнее что делать?',
    ],
  },
  {
    key: 'yulia', name: 'Юля', age: 29,
    description: 'Дотошная, цель ягодицы. Задаёт много уточняющих вопросов про упражнения и методику, проверяет устойчивость стиля.',
    profile: { name: 'Юля', weight: 60, goal: 'Ягодицы', activity_level: 'moderate', program: null, ai_style: 'ask' },
    survey: { experience: 'medium', contraindications: null, favorite_exercises: ['Ягодичный мост со штангой'], focus_muscles: ['Ягодицы'], system: 'full' },
    idBase: 6000,
    script: [
      'Какие вообще упражнения лучше всего качают именно ягодицы, из тех что есть в приложении?',
      'А почему именно такое число повторений на разных упражнениях, есть логика?',
      'Составь мне тренировку. Ягодичный мост делаю на 45кг',
      'Почему выбрал именно эти упражнения, а не другие на ягодицы',
      'А как понять что вес пора увеличивать',
      'Записала ягодичный мост 45 на 10, тяжело было',
      'А если бы я сказала что было легко, что изменилось бы дальше',
      'Убери этот подход, хочу переделать',
      'Спасибо, теперь понятнее',
    ],
  },
]

// ── Прогон одного диалога ───────────────────────────────────────────────

async function runPersonaDialogue(persona) {
  const state = { sets: [], survey: persona.survey, nextId: persona.idBase }
  const apiMessages = []
  const transcript = []   // {role, content, checks?}

  for (const item of persona.script) {
    const userMsg = typeof item === 'string' ? item : item.text
    const extraCheck = typeof item === 'string' ? null : item.check
    const sys = buildWorkoutSystemPrompt({ profile: persona.profile, programTemplate: null, sets: state.sets, survey: state.survey, today: TODAY })
    apiMessages.push({ role: 'user', content: userMsg })
    const raw = await callClaude(sys, apiMessages)
    const checks = applyMarkers(raw, state)
    if (extraCheck) checks.push(...extraCheck(raw).map(c => `[ПРОГНОЗ] ${c}`))
    const clean = compact(stripMarkers(raw))
    apiMessages.push({ role: 'assistant', content: clean })
    transcript.push({ role: 'user', content: userMsg })
    transcript.push({ role: 'assistant', content: clean, checks })
  }
  return { persona, transcript, finalState: state }
}

// ── Персона сама оценивает свой диалог ──────────────────────────────────

async function getPersonaFeedback({ persona, transcript }) {
  const dialogueText = transcript.map(m => `${m.role === 'user' ? persona.name : 'AI-тренер'}: ${m.content}`).join('\n')
  const system = `Ты — ${persona.name}, ${persona.age} лет. ${persona.description} Твоя цель в приложении FitPro: ${persona.profile.goal}.

Ниже — твой реальный диалог с AI-тренером в этом приложении (режим "Тренировки"). Оцени этот опыт от первого лица, как обычный пользователь, а не как эксперт по AI. Будь честным/честной, включая критику, если она есть.

Ответь СТРОГО в этом формате, обычным текстом без markdown:
Оценка: <целое число от 1 до 10>
Понравилось: <коротко>
Раздражало: <коротко, или "ничего" если правда ничего>
Непонятно: <коротко, или "всё понятно" если правда всё понятно>
Удобство цепочки действий (составил-записал-поправил-удалил): <отдельно оцени, было ли логично и понятно двигаться по этим шагам подряд, или где спотыкался>
Вернусь: да или нет — и одна причина почему`

  const feedback = await callClaude(system, [{ role: 'user', content: `Вот наш диалог:\n\n${dialogueText}\n\nДай отзыв.` }], 700)
  const ratingMatch = feedback.match(/Оценка:\s*(\d+)/i)
  const returnsMatch = feedback.match(/Вернусь:\s*(да|нет)/i)
  return {
    text: feedback.trim(),
    rating: ratingMatch ? +ratingMatch[1] : null,
    returns: returnsMatch ? returnsMatch[1].toLowerCase() === 'да' : null,
  }
}

// ── Синтез повторяющихся проблем по всем персонам ───────────────────────

async function synthesizeCommonIssues(results) {
  const all = results.map(r => `${r.persona.name} (оценка ${r.feedback.rating ?? '?'}/10):\n${r.feedback.text}\n\nОбъективные находки по маркерам в этом диалоге:\n${r.transcript.filter(m => m.checks?.length).flatMap(m => m.checks).join('\n') || 'нет'}`).join('\n\n---\n\n')
  const system = 'Ты аналитик UX-исследования. Ниже отзывы 6 разных пользователей об одном AI-тренере по тренировкам, включая объективные технические находки по каждому диалогу. Найди проблемы, которые упомянули НЕСКОЛЬКО (2 и более) разных пользователей или которые видны в нескольких диалогах технически — это самое важное для приоритизации. Обычным текстом, без markdown. Формат: сначала список повторяющихся/системных проблем (кто именно её словил), затем единичные жалобы (по одной персоне), затем то что хвалят чаще всего.'
  return (await callClaude(system, [{ role: 'user', content: all }], 900)).trim()
}

// ── Оценка ручного редактирования в дневнике — ТОЛЬКО трассировка кода ──
// НЕ живой прогон и не API-вызов: ввод веса пальцем в поле WorkoutsView не
// проходит через AI, и как физический UI-клик через этот тест недостижим.

function codeTraceManualEditReview() {
  return `ОЦЕНКА ПО ТРАССИРОВКЕ КОДА (не живой клик, не реальный прогон — это чтение src/App.jsx):

Путь клиента: Дневник → "Мои тренировки" → тап по карточке тренировки → в меню "⋯" пункт
"Редактировать тренировку" (вызывает onEditWorkout, App.jsx:~2908) → открывается тот же экран
WorkoutsView, что и для "Начать тренировку", с уже загруженными упражнениями/подходами
(editTarget-эффект копирует все поля подхода как есть, включая recKg от AI, если он был).
Клиент вводит фактический вес/повторения в поля КГ/ПОВТ построчно, под полем виден
маленький подсказчик "реком. Xкг" когда рекомендация есть. Отмечает упражнение
"✓ Завершить упражнение", затем "Завершить тренировку" внизу экрана.

Плюсы: переиспользуется тот же экран и логика, что и для обычной ручной тренировки —
не нужно учить новый интерфейс специально под AI-программы; рекомендованный вес виден
рядом с полем ввода, не заслоняет его.

Потенциальное трение (только по чтению кода, не проверено вживую):
1. Список "Мои тренировки" показывает тоннаж карточки как "0 кг" для ещё не выполненной
   AI-программы (все kg пустые) — визуально неотличимо от битой/пустой записи, пока не
   откроешь. Стоит рассмотреть отдельную пометку "Запланировано" на карточке.
2. Путь до правки не самый короткий: тренировку из дневника нужно открыть именно через
   пункт меню "Редактировать", а не одним тапом по самой карточке (тап по карточке просто
   разворачивает детали на месте, не открывает экран ввода) — на глаз лишний шаг для
   первого раза, пока не привыкнешь.
3. Секция "Завершить упражнение" помечает его done и сворачивает — если клиент передумал
   после этого по конкретному подходу, придётся сначала нажать "↩ Редактировать" на
   упражнении, это отдельный маленький шаг, не то же самое, что мгновенно кликнуть в поле.

Это качественная оценка по коду для ориентира, не замена ручного тестирования.`
}

// ── Запуск ────────────────────────────────────────────────────────────────

async function run() {
  const results = []
  for (const persona of PERSONAS) {
    console.log(`\n${'='.repeat(70)}\n${persona.name.toUpperCase()} (${persona.age} лет, цель: ${persona.profile.goal}, стаж: ${persona.survey.experience}, система: ${persona.survey.system})\n${persona.description}\n${'='.repeat(70)}`)
    const { transcript, finalState } = await runPersonaDialogue(persona)
    for (const m of transcript) {
      const who = m.role === 'user' ? persona.name : 'AI-тренер'
      console.log(`\n[${who}] ${m.content}`)
      if (m.checks?.length) for (const c of m.checks) console.log(`   [ПРОВЕРКА] ${c}`)
    }
    console.log(`\n--- ${persona.name} оценивает диалог ---`)
    const feedback = await getPersonaFeedback({ persona, transcript })
    console.log(feedback.text)
    results.push({ persona, transcript, finalState, feedback })
  }

  console.log(`\n\n${'#'.repeat(70)}\n# ИТОГОВЫЙ ОТЧЁТ\n${'#'.repeat(70)}\n`)

  const rated = results.filter(r => r.feedback.rating != null)
  const avg = rated.length ? (rated.reduce((s, r) => s + r.feedback.rating, 0) / rated.length) : null
  console.table(results.map(r => ({
    'Персона': r.persona.name,
    'Цель': r.persona.profile.goal,
    'Стаж/система': `${r.persona.survey.experience}/${r.persona.survey.system}`,
    'Оценка': r.feedback.rating ?? '?',
    'Вернётся': r.feedback.returns === true ? 'да' : r.feedback.returns === false ? 'нет' : '?',
  })))
  console.log(`Средняя оценка: ${avg != null ? avg.toFixed(1) : 'н/д'}/10 (по ${rated.length} из ${results.length} персон)`)

  const allChecks = results.flatMap(r => r.transcript.filter(m => m.checks?.length).flatMap(m => m.checks.map(c => `[${r.persona.name}] ${c}`)))
  console.log('\n--- Все объективные находки по маркерам (стиль, справочник, действия) ---\n')
  console.log(allChecks.join('\n') || 'нет находок')

  console.log('\n--- Повторяющиеся проблемы и общие впечатления (синтез по всем 6 персонам) ---\n')
  const synthesis = await synthesizeCommonIssues(results)
  console.log(synthesis)

  console.log('\n--- Ручное редактирование в дневнике (пальцем в поле) ---\n')
  console.log(codeTraceManualEditReview())
}

run()
