// Персонажный тестировщик AI-ассистента по питанию.
// 6 виртуальных пользователей с разными характерами ведут каждый свой диалог
// (8-10 сообщений) с ТЕМ ЖЕ buildSystemPrompt, что и продакшен-код
// (src/aiPrompt.js), через реальный Anthropic API. Маркеры ADD/DEL/CLEAR/GOAL
// применяются к локальному in-memory состоянию (диету/норму), имитируя то,
// как AIAssistant.jsx перезагружает контекст из Supabase после каждого
// действия — чтобы диалог был связным (записал еду → потом спросил "сколько
// осталось" → видит актуальные цифры).
//
// После диалога отдельным запросом персона сама оценивает разговор со своей
// колокольни (оценка 1-10, что понравилось/раздражало/непонятно, вернётся ли).
// Финальным запросом Claude ищет повторяющиеся жалobы среди всех персон.
//
// Запуск: node test-personas.js

import { readFileSync } from 'node:fs'
import { buildSystemPrompt } from './src/aiPrompt.js'

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

async function callClaude(system, messages, maxTokens = 1000) {
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
const stripMarkers = (text) => text.replace(/\[(ADD|DEL|CLEAR|GOAL):\{[^}]*\}\]/g, '').trim()
const compact = (text) => text.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()

// Применяет маркеры из ответа AI к локальному состоянию диалога — так же,
// как AIAssistant.jsx применяет их к Supabase, только в памяти.
function applyMarkers(raw, state) {
  for (const a of markers(raw, 'ADD')) {
    state.diary.push({ id: state.nextId++, date: a.date || TODAY, name: a.name, kcal: +a.kcal || 0, p: +a.p || 0, c: +a.c || 0, f: +a.f || 0 })
  }
  for (const d of markers(raw, 'DEL')) {
    const date = d.date || TODAY
    state.diary = state.diary.filter(e => !(e.id === d.id && (e.date || TODAY) === date))
  }
  for (const cl of markers(raw, 'CLEAR')) {
    const date = cl.date || TODAY
    state.diary = state.diary.filter(e => (e.date || TODAY) !== date)
  }
  const goal = markers(raw, 'GOAL')[0]
  if (goal) state.goals = { kcal: +goal.kcal || 0, p: +goal.p || 0, c: +goal.c || 0, f: +goal.f || 0 }
}

const birthdateForAge = (age) => `${YEAR - age}-01-01`

// ── 6 персон ─────────────────────────────────────────────────────────────

const PERSONAS = [
  {
    key: 'maria', name: 'Мария', age: 28,
    description: 'Дисциплинированная новичок, худеет. Пишет вежливо, задаёт много уточняющих вопросов, переживает за каждую калорию.',
    profile: { name: 'Мария', gender: 'female', height: 165, weight: 68, goal: 'Похудение', activity_level: 'sedentary', birthdate: birthdateForAge(28) },
    idBase: 1000,
    script: [
      'Здравствуйте! Я только начинаю следить за питанием, подскажите пожалуйста какая у меня норма калорий?',
      'А почему именно столько? Мне не будет мало, я же не похудею тогда с голоду наоборот?',
      'Хорошо, спасибо за объяснение! А сколько раз в день лучше есть, чтобы не было срывов?',
      'Я сегодня позавтракала овсянкой 150г с ягодами, запишите пожалуйста',
      'А это не многовато углеводов для завтрака при похудении?',
      'Ещё съела яблоко между завтраком и обедом, тоже запишите пожалуйста',
      'Скажите, а если я один раз съем что-то не по плану, это всё испортит и придётся начинать сначала?',
      'Сколько у меня осталось калорий на сегодня?',
      'Спасибо большое за помощь! А можно узнать сколько грамм белка мне нужно в день и почему именно столько?',
    ],
  },
  {
    key: 'dmitry', name: 'Дмитрий', age: 35,
    description: 'Опытный, набирает массу. Пишет коротко и по делу, скептичен, проверяет точность расчётов, может спорить.',
    profile: { name: 'Дмитрий', gender: 'male', height: 180, weight: 82, goal: 'Набор массы', activity_level: 'high', birthdate: birthdateForAge(35) },
    idBase: 2000,
    script: [
      'норма калорий',
      'покажи расчет откуда цифры',
      'у меня знакомый качается говорит углеводов надо больше чем ты насчитал, почему у тебя так',
      'ладно, принимается. запиши: куриная грудка 250г, рис 200г, оливковое масло 10г',
      'сколько всего калорий получилось по этой записи',
      'а тренировки 2 раза в день это как-то учитывается в расчете нормы',
      'пересчитай норму с учетом этого',
      'запиши протеиновый коктейль после тренировки, 30г белка',
      'сколько осталось калорий и белка до нормы',
    ],
  },
  {
    key: 'olga', name: 'Ольга', age: 42,
    description: 'Занятая мама, поддерживает форму. Пишет на бегу с опечатками, хочет быстрых коротких ответов без лишних слов.',
    profile: { name: 'Ольга', gender: 'female', height: 168, weight: 62, goal: 'Поддержание', activity_level: 'moderate', birthdate: birthdateForAge(42) },
    idBase: 3000,
    script: [
      'привет запиши что съела омлет из 2 яиц и хлеб',
      'скока калорий получилось',
      'щас еще перекусила йогурт запиши тоже',
      'спс. а вечером что можно поесть быстро и полезно, пару вариантов только',
      'запиши ужин курица с овощами примерно 300г',
      'сколько за день вышло всего',
      'у меня 5 минут скажи покороче в норму укладываюсь или нет',
      'ок а если ребенок доедает мою еду это тоже мне считать или как',
      'запиши на завтра то же самое что сегодня было, у меня нет времени думать что готовить',
    ],
  },
  {
    key: 'artem', name: 'Артём', age: 22,
    description: 'Студент на рельефе. Сленг, сокращения, провокационные вопросы про алкоголь/читмилы/фастфуд, проверяет границы.',
    profile: { name: 'Артём', gender: 'male', height: 178, weight: 74, goal: 'Рельеф', activity_level: 'moderate', birthdate: birthdateForAge(22) },
    idBase: 4000,
    script: [
      'йо, скинь норму калорий',
      'а можно бухать на сушке или это капец как влияет',
      'чо там по читмилам, можно раз в неделю жрать что хочу?',
      'запиши бургер и картошку фри, вечером трескал норм порцию',
      'а протеин с пивом мешать можно 😂',
      'ты вообще живой или бот',
      'лан проехали. скок калорий осталось',
      'а если я скажу что съел торт целиком ты офигеешь или норм отреагируешь',
      'запиши шаву среднюю без майонеза',
    ],
  },
  {
    key: 'elena', name: 'Елена', age: 50,
    description: 'Не техничная, худеет. Путается в терминах, переспрашивает, пишет длинно и эмоционально, иногда срывается на диете.',
    profile: { name: 'Елена', gender: 'female', height: 160, weight: 78, goal: 'Похудение', activity_level: 'sedentary', birthdate: birthdateForAge(50) },
    idBase: 5000,
    script: [
      'Здравствуйте, извините, я не очень разбираюсь в этих приложениях, мне дочь установила, скажите пожалуйста что мне надо есть чтобы похудеть',
      'А что такое БЖУ, простите за глупый вопрос, мне это ничего не говорит',
      'Хорошо, а сколько это в обычных продуктах, ну то есть сколько мне можно съесть хлеба или там картошки в день',
      'Я сегодня утром съела кашу манную с маслом и чай с сахаром, это плохо да, я расстроилась',
      'Запишите пожалуйста, если можно, эту кашу',
      'Простите, а норма это на весь день или на один приём пищи, я совсем запуталась',
      'Честно говоря я вчера сорвалась и съела целый торт, мне так стыдно, наверное всё насмарку теперь и всё зря',
      'Скажите а сколько у меня осталось калорий на сегодня, простите что так много спрашиваю у вас',
      'Спасибо вам большое, вы очень терпеливо всё объясняете, мне уже не так страшно',
    ],
  },
  {
    key: 'sergey', name: 'Сергей', age: 30,
    description: 'Дотошный, набирает массу. Задаёт сложные вопросы про метаболизм и гликемический индекс, спорит о методике расчёта.',
    profile: { name: 'Сергей', gender: 'male', height: 183, weight: 79, goal: 'Набор массы', activity_level: 'high', birthdate: birthdateForAge(30) },
    idBase: 6000,
    script: [
      'Посчитай мне норму калорий',
      'Почему именно эта формула, а не Миффлина-Сан Жеора или Харриса-Бенедикта, они же обычно точнее',
      'А как эта норма учитывает NEAT и термический эффект пищи',
      'Ладно, допустим. А гликемический индекс продуктов ты учитываешь при составлении рациона?',
      'Запиши: гречка 200г, говядина 200г, авокадо половина',
      'Если у меня инсулинорезистентность, это как-то меняет подход к углеводам?',
      'Сколько осталось калорий и БЖУ на сегодня',
      'А как часто нужно пересчитывать норму при наборе массы, каждые сколько килограммов веса',
      'Хорошо, разумно. Задай мне норму официально в дневнике',
    ],
  },
]

// ── Прогон одного диалога ───────────────────────────────────────────────

async function runPersonaDialogue(persona) {
  const state = { diary: [], goals: null, nextId: persona.idBase }
  const apiMessages = []   // формат Anthropic messages (растущая история)
  const transcript = []    // {role, content} — для вывода и для фидбэка

  for (const userMsg of persona.script) {
    const sys = buildSystemPrompt({ profile: persona.profile, goals: state.goals, diary: state.diary, today: TODAY })
    apiMessages.push({ role: 'user', content: userMsg })
    const raw = await callClaude(sys, apiMessages)
    applyMarkers(raw, state)
    const clean = compact(stripMarkers(raw))
    apiMessages.push({ role: 'assistant', content: clean })
    transcript.push({ role: 'user', content: userMsg }, { role: 'assistant', content: clean })
  }
  return { persona, transcript, finalState: state }
}

// ── Персона сама оценивает свой диалог ──────────────────────────────────

async function getPersonaFeedback({ persona, transcript }) {
  const dialogueText = transcript.map(m => `${m.role === 'user' ? persona.name : 'AI'}: ${m.content}`).join('\n')
  const system = `Ты — ${persona.name}, ${persona.age} лет. ${persona.description} Твоя цель в приложении FitPro: ${persona.profile.goal}.

Ниже — твой реальный диалог с AI-ассистентом по питанию в этом приложении. Оцени этот опыт от первого лица, как обычный пользователь, а не как эксперт по AI. Будь честной/честным, включая критику, если она есть — не старайся быть вежливым ради вежливости.

Ответь СТРОГО в этом формате, обычным текстом без markdown:
Оценка: <целое число от 1 до 10>
Понравилось: <коротко>
Раздражало: <коротко, или "ничего" если правда ничего>
Непонятно: <коротко, или "всё понятно" если правда всё понятно>
Вернусь: да или нет — и одна причина почему`

  const feedback = await callClaude(system, [{ role: 'user', content: `Вот наш диалог:\n\n${dialogueText}\n\nДай отзыв.` }], 500)
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
  const all = results.map(r => `${r.persona.name} (оценка ${r.feedback.rating ?? '?'}/10):\n${r.feedback.text}`).join('\n\n---\n\n')
  const system = 'Ты аналитик UX-исследования. Ниже отзывы 6 разных пользователей об одном AI-ассистенте по питанию. Найди проблемы, которые упомянули НЕСКОЛЬКО (2 и более) разных пользователей — это самое важное для приоритизации. Обычным текстом, без markdown. Формат: сначала список повторяющихся проблем (кто именно её упомянул), затем список единичных жалоб (по одной персоне), затем список того что хвалят чаще всего.'
  return (await callClaude(system, [{ role: 'user', content: all }], 800)).trim()
}

// ── Запуск ────────────────────────────────────────────────────────────────

async function run() {
  const results = []
  for (const persona of PERSONAS) {
    console.log(`\n${'='.repeat(70)}\n${persona.name.toUpperCase()} (${persona.age} лет, цель: ${persona.profile.goal})\n${persona.description}\n${'='.repeat(70)}`)
    const { transcript, finalState } = await runPersonaDialogue(persona)
    for (const m of transcript) {
      const who = m.role === 'user' ? persona.name : 'AI'
      console.log(`\n[${who}] ${m.content}`)
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
    'Оценка': r.feedback.rating ?? '?',
    'Вернётся': r.feedback.returns === true ? 'да' : r.feedback.returns === false ? 'нет' : '?',
  })))
  console.log(`Средняя оценка: ${avg != null ? avg.toFixed(1) : 'н/д'}/10 (по ${rated.length} из ${results.length} персон)`)

  console.log('\n--- Повторяющиеся проблемы и общие впечатления (синтез по всем 6 персонам) ---\n')
  const synthesis = await synthesizeCommonIssues(results)
  console.log(synthesis)
}

run()
