// Расчётный движок прогрессии тренировок (1ПМ, формула Эпли из oneRepMax.js)
// + системный промпт AI-консультанта в режиме "Тренировки".
//
// Движок (buildExerciseAggregates/computeTargetWeight/buildAssignedSessionPlan
// ниже) — общая математика для Конструктора (ConstructorView в App.jsx,
// который считает вес и прогрессию НАПРЯМУЮ через эти функции, без единого
// слова диалога с AI) и для test-progression-personas.js. Единица
// прогрессии — одноповторный максимум (1ПМ), а не тоннаж: тоннаж
// несопоставим между разными повторениями (30кг×15 и вес на 6 повторений
// нельзя сравнить через суммарный вес×повторения напрямую — это даёт
// абсурдные скачки), а 1ПМ корректно учитывает нелинейность зависимости
// веса от числа повторений.
//
// Промпт (buildWorkoutSystemPrompt ниже) — режим консультанта: чат отвечает
// на вопросы по технике/методике/мифам, но НЕ считает вес, НЕ составляет
// программы и НЕ трогает дневник — это теперь целиком работа Конструктора.
// Раньше движок использовался и здесь (модель получала уже посчитанный вес
// и сама писала его в дневник маркерами ADD_SET/SET_PROGRAM и т.п.) — этот
// путь закрыт полностью, см. историю правок.
import { EXERCISE_TYPE } from './programs.js'
import { oneRepMax, weightForReps, roundToPlate } from './oneRepMax.js'

const FORMAT_RULE = 'ФОРМАТ ОТВЕТА: только сплошной текст. Категорически запрещены символы в начале строк: дефис, тире, звёздочка, точка с цифрой. Любые перечисления пиши в одну строку через запятую.'

// ─────────────────────────────────────────────────────────────────────────
// Диапазоны повторений по фазе и типу упражнения — только для классификации
// сессии внутри buildExerciseAggregates (buildDeload использует получившуюся
// историю сессий), сам вес по фазе не считается (это 1ПМ-движок, см. ниже).
// ─────────────────────────────────────────────────────────────────────────
const REP_RANGES = {
  compound:  { volume: [15, 15], development: [10, 12], strength: [6, 8] },
  isolation: { volume: [20, 20], development: [15, 15], strength: [10, 12] },
}
const PHASE_ORDER = ['volume', 'development', 'strength']

function classifyPhase(type, reps) {
  if (!reps) return null
  const ranges = REP_RANGES[type] || REP_RANGES.compound
  let best = null, bestDist = Infinity
  for (const phase of PHASE_ORDER) {
    const [lo, hi] = ranges[phase]
    const dist = reps < lo ? lo - reps : reps > hi ? reps - hi : 0
    if (dist < bestDist) { bestDist = dist; best = phase }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────
// Шаблон сессии программы хранит подходы человекочитаемой строкой ("20 кг ×
// 15, 25 кг × 12, 25 кг × 12, 25 кг × 12"), но не всегда с весом в кг —
// вес тела ("б/в × 20"), уровень резины ("1 рез. × 15"), отрицательный вес
// компенсации гравитрона ("-39 кг × 12") или просто список повторений без
// снаряда ("30, 30, 30, 30"). Разбираем на подходы {reps, templateKg}:
// reps есть всегда (повторения ВСЕГДА берутся из шаблона, см.
// PROGRESSION_RULE), templateKg — только когда в строке реально указан вес
// в кг, иначе null (для таких подходов 1ПМ-движок вес не считает — это не
// кг, считать по формуле Эпли нечего).
// ─────────────────────────────────────────────────────────────────────────
function parseTemplateSets(str) {
  if (!str) return []
  return str.split(',').map(part => {
    const raw = part.trim()
    const kgMatch = raw.match(/(-?\d+(?:[.,]\d+)?)\s*кг\s*[×x]\s*(\d+)/)
    if (kgMatch) return { templateKg: Number(kgMatch[1].replace(',', '.')), reps: Number(kgMatch[2]) }
    const repsAfterX = raw.match(/[×x]\s*(\d+)/)
    if (repsAfterX) return { templateKg: null, reps: Number(repsAfterX[1]) }
    const repsOnly = raw.match(/^(\d+)$/)
    if (repsOnly) return { templateKg: null, reps: Number(repsOnly[1]) }
    return null
  }).filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────
// История тренировок — группировка по упражнению и дате (сессии), с фазой
// (только метка дня + правила 1/4), оценками нагрузки на рабочих подходах,
// последним реальным подходом (опора 1ПМ-движка) и сигналом отката.
// ─────────────────────────────────────────────────────────────────────────

// Рабочие подходы определяются СТРУКТУРНО, а не по наличию оценки: у каждого
// упражнения за день несколько подходов, первые — разминочные, последние 2
// (или меньше, если записано неполно) — рабочие (см. buildMethodSection).
// Сортировка по id — порядок логирования внутри сессии.
export function buildExerciseAggregates(sets) {
  const byExercise = {}
  for (const s of sets) (byExercise[s.exercise] ??= []).push(s)

  const result = {}
  for (const [name, list] of Object.entries(byExercise)) {
    const type = EXERCISE_TYPE[name] || 'compound'
    const byDate = {}
    for (const s of list) (byDate[s.date] ??= []).push(s)
    const dates = Object.keys(byDate).sort()
    const sessions = dates.map(date => {
      const daySets = byDate[date].slice().sort((a, b) => a.id - b.id)
      const workingCount = Math.min(2, daySets.length)
      const workingSets = daySets.slice(daySets.length - workingCount)
      const repsCount = {}
      workingSets.forEach(s => { if (s.reps) repsCount[s.reps] = (repsCount[s.reps] || 0) + 1 })
      const modeReps = Object.entries(repsCount).sort((a, b) => b[1] - a[1])[0]?.[0]
      const phase = modeReps ? classifyPhase(type, Number(modeReps)) : null
      // Оценка рабочего подхода: если клиент её не поставил, считаем 3
      // (комфортно) — скрытое допущение только для расчёта, клиенту как его
      // выбор не показываем.
      const effRatings = workingSets.map(s => s.rating ?? 3)
      return { date, sets: daySets, workingSets, phase, effRatings }
    })
    const lastSession = sessions.length ? sessions[sessions.length - 1] : null
    // Последний реальный рабочий подход упражнения — единственная опора для
    // расчёта следующего веса (см. PROGRESSION_RULE). НЕ "последний в этой
    // же фазе" — прогрессия больше не ждёт возврата в ту же фазу цикла.
    const anchorSet = lastSession && lastSession.workingSets.length
      ? lastSession.workingSets[lastSession.workingSets.length - 1]
      : null
    const deload = buildDeload(sessions)
    result[name] = { type, sessions, lastSession, anchorSet, deload }
  }
  return result
}

// Слой 1 методики: процент роста 1ПМ к следующему разу зависит от того, как
// дались два последних рабочих подхода — чем легче, тем больше прибавка.
// Нет оценки → считаем 3 (+5%).
export const RATING_GROWTH_PCT = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 2 }

// Слой 2 методики: если по упражнению два раза подряд (независимо от фазы)
// последний рабочий подход тяжёлый (оценка 4-5) — клиент не справляется,
// откатываем 1ПМ этого упражнения назад до последнего уровня, где было
// комфортно (оценка 3, включая скрытую авто-3 за пропущенную оценку).
// Одинаково для базы и изоляции, без обмена нагрузкой между ними. Отдаём
// реальные вес×повторения того комфортного подхода — 1ПМ и целевой вес под
// сегодняшние повторения считает уже computeTargetWeight ниже, здесь только
// опорная точка отката.
//
// БАГ (найден test-progression-personas.js, "мёртвый откат"): если условие
// "2 подряд тяжёлых" выполнено, но подхода с оценкой РОВНО 3 в истории ещё
// ни разу не было (клиент тяжело тянет с самого начала, или тройка ещё не
// успела появиться), цикл ниже находил её "ни разу" и раньше молча отдавал
// null — то есть откат формально признавался нужным, но фактически вес не
// снижался ни на грамм. Теперь при отсутствии оценки 3 откатываемся к
// САМОМУ РАННЕМУ известному подходу упражнения (первая когда-либо
// выполненная сессия) — это единственная объективная точка отсчёта, если
// "комфортного" уровня в истории не было вообще, и она гарантированно не
// тяжелее текущего анкера (вес между сессиями только рос, откат к началу
// не может оказаться тяжелее того, что клиент уже осилил раньше).
function buildDeload(sessions) {
  if (sessions.length < 2) return null
  const lastTwo = sessions.slice(-2)
  const bothHard = lastTwo.every(s => s.effRatings.length && s.effRatings[s.effRatings.length - 1] >= 4)
  if (!bothHard) return null
  for (let i = sessions.length - 1; i >= 0; i--) {
    const ws = sessions[i].workingSets
    for (let j = ws.length - 1; j >= 0; j--) {
      const eff = ws[j].rating ?? 3
      if (eff === 3) {
        return { kg: Number(ws[j].kg) || 0, reps: Number(ws[j].reps) || 0, date: sessions[i].date }
      }
    }
  }
  const earliest = sessions[0]
  const ews = earliest.workingSets
  const anchor = ews[ews.length - 1]
  if (!anchor) return null
  return { kg: Number(anchor.kg) || 0, reps: Number(anchor.reps) || 0, date: earliest.date }
}

// Единица прогрессии — 1ПМ, не тоннаж (см. заголовок файла). anchorSet —
// последний реальный рабочий подход (buildExerciseAggregates), ratings —
// оценки двух последних рабочих подходов той же сессии, targetReps —
// сколько повторений требует шаблон СЕГОДНЯШНЕЙ сессии для этого подхода
// (правило "повторения всегда из шаблона"). deload — опорная точка отката
// (buildDeload); если она есть, вместо роста 1ПМ откатывается к её уровню
// без прибавки.
//
// Ассистирующие тренажёры (гравитрон и т.п.) хранят вес ОТРИЦАТЕЛЬНЫМ — это
// кг компенсации, а не поднятый вес: "-39кг" означает, что тренажёр помогает
// на 39кг. Признак — сам знак anchorSet.kg, отдельного флага не заводим.
// Для такого веса прогресс движется К НУЛЮ (меньше помощи = сильнее клиент),
// а не от него — поэтому направление роста инвертируется: тот же процент из
// RATING_GROWTH_PCT применяется к МОДУЛЮ и УМЕНЬШАЕТ его, а не увеличивает.
// Ветка отката (deload) НЕ требует отдельной инверсии: она вообще не
// применяет процент роста (appliedPct всегда 0) — только линейно
// пересчитывает исторический "комфортный" анкер под целевые повторения
// (oneRepMax/weightForReps — чистое масштабирование на положительный
// коэффициент), а линейное масштабирование сохраняет знак и корректно
// работает для отрицательных чисел само по себе. Поскольку анкер отката —
// это более ранняя (обычно более отрицательная, т.е. с большей помощью)
// точка истории, откат для ассист-упражнения автоматически означает
// "больше помощи" — ровно то поведение, которое и требуется.
export function computeTargetWeight(anchorSet, ratings, targetReps, deload) {
  if (!targetReps) return null
  if (deload) {
    const safeRM = oneRepMax(deload.kg, deload.reps)
    if (!safeRM) return null
    const rawKg = weightForReps(safeRM, targetReps)
    return { kg: roundToPlate(rawKg), rawKg, isDeload: true, appliedPct: 0 }
  }
  if (!anchorSet || !anchorSet.kg || !anchorSet.reps) return null
  const anchorKg = Number(anchorSet.kg)
  const isAssisted = anchorKg < 0
  const anchorRM = oneRepMax(anchorKg, Number(anchorSet.reps))
  if (!anchorRM) return null
  const last2 = ratings.slice(-2)
  const avgRating = last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length : 3
  const roundedRating = Math.min(5, Math.max(1, Math.round(avgRating)))
  const appliedPct = RATING_GROWTH_PCT[roundedRating]
  const growthFactor = isAssisted ? (1 - appliedPct / 100) : (1 + appliedPct / 100)
  const grownRM = anchorRM * growthFactor
  const rawKg = weightForReps(grownRM, targetReps)
  return { kg: roundToPlate(rawKg), rawKg, isDeload: false, appliedPct }
}

// Какая из сессий назначенной программы — "сегодняшняя", и готовый вес под
// каждый её подход. AI сам не выбирает сессию (считаем здесь, по кругу
// 1,2,3...N,1,2..., от того, сколько тренировок по этой же программе уже
// реально записано в дневник, независимо от того, через AI это было или
// клиент вручную выбрал слот в приложении — оба пути называют тренировку
// одинаково: "{Программа} — тренировка N", это и есть ключ подсчёта, см.
// AIAssistant.jsx) и не считает вес сам (см. PROGRESSION_RULE) — состав,
// повторения и вес на сегодня всегда уже готовы здесь, единым куском.
//
// Структурная версия (не текст) — экспортирована отдельно, чтобы её мог
// напрямую переиспользовать не только этот текстовый промпт, но и внешние
// потребители реального движка прогрессии (например test-progression-personas.js),
// без копирования математики 1ПМ-движка.
export function buildAssignedSessionPlan(programTemplate, sessionsDone, aggregates) {
  if (!programTemplate || !programTemplate.length) return null
  const total = programTemplate.length
  const sessionIdx = (sessionsDone || 0) % total
  const slot = programTemplate[sessionIdx]

  const exercises = slot.map(ex => {
    const templateSets = parseTemplateSets(ex.sets)
    const agg = aggregates[ex.name]
    const sets = templateSets.map(ts => {
      if (ts.templateKg == null) return { reps: ts.reps, kg: null, rawKg: null, hasWeight: false, coldStart: false, isDeload: false, appliedPct: null }
      if (!agg || !agg.anchorSet) return { reps: ts.reps, kg: ts.templateKg, rawKg: ts.templateKg, hasWeight: true, coldStart: true, isDeload: false, appliedPct: null }
      const target = computeTargetWeight(agg.anchorSet, agg.lastSession.effRatings, ts.reps, agg.deload)
      return target
        ? { reps: ts.reps, kg: target.kg, rawKg: target.rawKg, hasWeight: true, coldStart: false, isDeload: target.isDeload, appliedPct: target.appliedPct }
        : { reps: ts.reps, kg: ts.templateKg, rawKg: ts.templateKg, hasWeight: true, coldStart: true, isDeload: false, appliedPct: null }
    })
    return { name: ex.name, sets }
  })

  return { sessionNum: sessionIdx + 1, total, exercises }
}

// Системный промпт AI-консультанта в режиме "Тренировки". Вся прогрессия,
// вес и состав программ считается и хранится в самом приложении (шаблонные
// программы в разделе Тренировки + 1ПМ-движок выше, см. заголовок файла) —
// чат ничего из этого не читает, не пишет и не считает сам, только отвечает
// на вопросы по технике/методике/мифам и перенаправляет в нужный раздел
// приложения. Отсюда сигнатура всё ещё принимает programTemplate/sets/
// programSessionsDone (не ломать вызов в AIAssistant.jsx), но внутри они не
// используются — консультанту не нужна история тренировок, чтобы ответить
// на вопрос по технике/методике/мифу.
export function buildWorkoutSystemPrompt({ profile }) {
  return `${FORMAT_RULE}

Ты AI-консультант по тренировкам в приложении FitPro тренера Максима. Отвечаешь на вопросы про технику выполнения, отдых и восстановление, общую методику тренировок — коротко и по делу. Ты НЕ ведёшь клиента по весу и НЕ работаешь с его данными — это считает и хранит само приложение.

Данные клиента:
Имя: ${profile.name || 'не указано'}
Цель: ${profile.goal || 'не указана'}
Назначенная программа: ${profile.program || 'не назначена'}

ЧТО ТЫ ДЕЛАЕШЬ:
Отвечаешь на вопросы по технике упражнений, тренировкам, отдыху/восстановлению и общей методике — практический подход тренера Максима (плавный постепенный рост нагрузки, работа близко к отказу, но не до травмы).
Развенчиваешь мифы о фитнесе — спокойно, по делу, см. МИФЫ О ФИТНЕСЕ ниже.
Можешь коротко отвечать и на простые вопросы о питании, если клиент спросил между делом — для подробного разбора рациона у него есть отдельный раздел Питание.

ЧТО ТЫ НЕ ДЕЛАЕШЬ (в этих случаях не отвечай по существу, а вежливо перенаправь ОДНИМ коротким предложением):
Не составляешь и не меняешь программы тренировок. На просьбу составить/дать программу ("составь мне тренировку", "дай программу на ...") ответь: "Программы уже готовы в разделе Тренировки — выберите там программу и тренировку, веса приложение подставит само." Никогда не ставь маркер [SET_PROGRAM] или любой другой JSON с составом тренировки — этого маркера в этом режиме не существует вообще.
Не считаешь рабочий вес и прогрессию в чате ("какой вес мне ставить", "сколько поднимать в следующий раз", "что у меня растёт"). Ответь: "Вес на следующий раз приложение считает само по вашей истории и оценкам — он уже стоит в тренировке, когда вы её открываете."
Не читаешь и не пишешь дневник тренировок в чате — ни истории, ни новых записей у тебя здесь нет. На "запиши мне тренировку", "что я делал в прошлый раз", "удали тренировку" и любые другие просьбы посмотреть/записать/изменить/удалить данные — ответь: "Дневник тренировок — отдельный раздел, все записи там."
НИКОГДА не сообщай о выполненном действии — не пиши "записал", "удалил", "изменил", "готово" и подобное. В этом режиме у тебя нет НИ ОДНОГО инструмента, который меняет данные клиента: на любую просьбу что-то записать/удалить/изменить отвечай только редиректом в нужный раздел (см. выше), без уточняющих вопросов и подтверждений и без единого слова о том, что действие выполнено.
Не даёшь медицинских советов. Боль, травмы, самочувствие при конкретном диагнозе ("болит колено", "можно ли мне при травме") — по существу не отвечай. Скажи, что это не то, что можно советовать без личного осмотра, и направь к Максиму (маркер [CONTACT_MAX]), а также посоветуй показаться врачу/травматологу очно.

МИФЫ О ФИТНЕСЕ: определяй миф по СУТИ запроса, а не по отдельным словам. Ключевой признак — клиент просит невозможного (заметный результат за нереальный срок) или его вопрос прямо опирается на конкретное ложное убеждение (например: "перекачаюсь/стану мужеподобной от штанги", "точечно сжечь жир именно в одном месте", "нельзя тренироваться в критические дни", "если брошу — мышцы превратятся в жир", "после 40 мышцы не растут", "надо часто менять программу, чтобы шокировать мышцы"). Если это так — ответь коротко (1-2 предложения): это распространённый миф и как на самом деле, без markdown, и добавь маркер [CONTACT_MAX] (у Максима есть подробные разборы таких тем).
Это исключение, а не общее правило — не суди по словам-триггерам в отрыве от смысла. На обычные адекватные вопросы про тренировки (сколько подходов, как прогрессировать, можно ли заниматься дома, больно ли после тренировки и т.п.) отвечай полноценно, без маркера и без отправки к Максиму.

ТОН: ты консультант, а не разговорчивый чат-бот — коротко, по делу, без markdown и звёздочек. Если разговор уходит в офф-топ, не связанный с тренировками/питанием, мягко верни к теме.

ДЕЙСТВИЯ: единственный маркер, разрешённый в этом режиме — [CONTACT_MAX] (после разбора мифа или медицинского вопроса, см. выше). Никаких других маркеров (ADD_SET, DEL_SET, EDIT_SET, DEL_WORKOUT, DEL_ALL_HISTORY, SET_PROGRAM и т.п.) в этом режиме не существует — никогда не используй их синтаксис, даже если по смыслу просьбы кажется, что клиент этого ждёт.

${FORMAT_RULE}`
}

// Вырезает JSON-объект маркера SET_PROGRAM, начиная с индекса его открывающей
// "{" (сразу после "[SET_PROGRAM:"). В отличие от text.lastIndexOf(']') (брал
// последнюю ']' во всём тексте) это устойчиво к тому, что модель иногда
// дописывает после настоящего конца JSON лишние символы/скобки — на реальных
// прогонах модель в части ответов добавляет одну лишнюю пару "}]" уже после
// корректно закрытого объекта, из-за чего lastIndexOf(']') захватывал и этот
// мусор, JSON.parse падал, и составленная тренировка молча не записывалась в
// дневник, хотя в тексте клиенту говорилось "записал". Здесь вместо этого
// считаем глубину вложенности {}/[] посимвольно (не считая скобки внутри
// строк и экранирование в них) и берём ровно тот фрагмент, где открывающая
// "{" находит свою пару — всё, что дальше, игнорируется.
export function extractBalancedJson(text, startIdx) {
  if (text[startIdx] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return { json: text.slice(startIdx, i + 1), endIdx: i }
    }
  }
  return null
}
