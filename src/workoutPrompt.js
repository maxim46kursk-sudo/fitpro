// Системный промпт AI-тренера (режим "Тренировки"). Метод — волновой цикл
// тренера Максима (Объём → Развитие → Сила → повтор), см. buildMethodSection.
// Как и в aiPrompt.js для питания: все агрегаты (тоннаж, тренды, средние
// оценки нагрузки, цели по фазам) считаются здесь на JS-стороне и кладутся в
// промпт уже готовыми числами — модель их только читает и применяет к ним
// правила реакции, не пересчитывает сама (тесты показали, что модель
// ненадёжно считает суммы/средние в уме, особенно на истории за 90 дней).
import { EXERCISES, EXERCISE_TYPE } from './programs.js'

const FORMAT_RULE = 'ФОРМАТ ОТВЕТА: только сплошной текст. Категорически запрещены символы в начале строк: дефис, тире, звёздочка, точка с цифрой. Любые перечисления пиши в одну строку через запятую.'

const dateLabel = (iso, today) => {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}${iso === today ? ' (сегодня)' : ''}`
}

const EXPERIENCE_LABEL = { novice: 'Новичок (до 6 мес)', medium: 'Средний (6мес-2года)', advanced: 'Опытный (2+ года)' }
const SYSTEM_LABEL = { full: 'Фулбади', split: 'Сплит' }

// ─────────────────────────────────────────────────────────────────────────
// Волновой цикл: диапазоны повторений по фазе и типу упражнения.
// ─────────────────────────────────────────────────────────────────────────
const REP_RANGES = {
  compound:  { volume: [15, 15], development: [10, 12], strength: [6, 8] },
  isolation: { volume: [20, 20], development: [15, 15], strength: [10, 12] },
}
const PHASE_ORDER = ['volume', 'development', 'strength']
const PHASE_LABEL = { volume: 'Объём', development: 'Развитие', strength: 'Сила' }

// Классифицируем повторения сессии в фазу цикла по ближайшему диапазону для
// данного типа упражнения (многосуставное/изолирующее).
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

function buildMethodSection() {
  return `МЕТОД ТРЕНЕРА МАКСИМА — ВОЛНОВОЙ ЦИКЛ (единственный метод прогрессии, другой не придумывай):
Тренировки идут по кругу из трёх фаз: Объём → Развитие → Сила → снова Объём, и так постоянно.
Диапазоны повторений на рабочих подходах зависят от фазы и типа упражнения. Многосуставные (приседания, тяги, жимы, выпады — несколько суставов и крупные мышцы): Объём 15 повторений, Развитие 10-12, Сила 6-8. Изолирующие (сгибания/разгибания, разводки, махи, отведения — один сустав, одна мышца): Объём 20 повторений, Развитие 15, Сила 10-12.
Внутри каждого упражнения 4 подхода. Подходы 1-2 — разминочные, лёгкий вес, не в счёт прогрессии. Подходы 3-4 — рабочие, целевой вес по обратной пирамиде: подход 3 — вес чуть больше, у нижней границы диапазона повторений; подход 4 — вес чуть меньше, повторений больше, к верхней границе диапазона.
Рост нагрузки — только между полными циклами: когда упражнение снова приходит в ту же фазу (например снова Сила после полного круга через Развитие и Объём), суммарный тоннаж рабочих подходов должен вырасти примерно на 10% относительно прошлого раза в этой же фазе. Веду клиента к этой цели весом или повторениями в рамках диапазона фазы — плавно, не скачком.`
}

// ─────────────────────────────────────────────────────────────────────────
// История тренировок — группировка по упражнению и дате (сессии), с фазой
// цикла, тоннажем и оценками нагрузки на рабочих подходах.
// ─────────────────────────────────────────────────────────────────────────

// Только оценённые подходы считаются рабочими (клиент оценивает именно
// рабочие подходы, разминочные не оценивает) — так мы отличаем одни от
// других без отдельного поля в БД. Сортировка по id — порядок логирования
// внутри сессии.
function buildExerciseAggregates(sets) {
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
      const tonnage = daySets.reduce((sum, s) => sum + (Number(s.kg) || 0) * (Number(s.reps) || 0), 0)
      const topKg = Math.max(...daySets.map(s => Number(s.kg) || 0))
      const repsCount = {}
      daySets.forEach(s => { if (s.reps) repsCount[s.reps] = (repsCount[s.reps] || 0) + 1 })
      const modeReps = Object.entries(repsCount).sort((a, b) => b[1] - a[1])[0]?.[0]
      const phase = modeReps ? classifyPhase(type, Number(modeReps)) : null
      const workingRatings = daySets.filter(s => s.rating != null).map(s => s.rating)
      return { date, sets: daySets, tonnage, topKg, phase, workingRatings }
    })
    result[name] = { type, sessions }
  }
  return result
}

// Для каждой фазы, в которой упражнение уже встречалось: тоннаж в последний
// и предпоследний раз в этой фазе, рост между ними, и цель на следующий раз
// в этой же фазе (+10% от последнего раза).
function buildPhaseTargets(sessions) {
  const out = {}
  for (const phase of PHASE_ORDER) {
    const occ = sessions.filter(s => s.phase === phase)
    if (!occ.length) continue
    const last = occ[occ.length - 1]
    const prev = occ.length > 1 ? occ[occ.length - 2] : null
    out[phase] = {
      lastDate: last.date,
      lastTonnage: Math.round(last.tonnage),
      prevDate: prev ? prev.date : null,
      prevTonnage: prev ? Math.round(prev.tonnage) : null,
      growthPct: prev && prev.tonnage > 0 ? Math.round(((last.tonnage - prev.tonnage) / prev.tonnage) * 100) : null,
      nextTarget: Math.round(last.tonnage * 1.1),
    }
  }
  return out
}

// Правило 1: на фазе Сила два последних оценённых рабочих подхода — оба 5.
function checkRule1AddSet(sessions) {
  const strengthSessions = sessions.filter(s => s.phase === 'strength' && s.workingRatings.length)
  if (!strengthSessions.length) return false
  const last = strengthSessions[strengthSessions.length - 1].workingRatings.slice(-2)
  return last.length === 2 && last.every(r => r === 5)
}

// Правило 4: два последних Объём-сессии подряд — в обеих последний рабочий подход тяжело (4-5).
function checkRule4ReduceVolume(sessions) {
  const volumeSessions = sessions.filter(s => s.phase === 'volume' && s.workingRatings.length)
  if (volumeSessions.length < 2) return false
  const lastTwo = volumeSessions.slice(-2)
  return lastTwo.every(s => s.workingRatings[s.workingRatings.length - 1] >= 4)
}

function buildHistorySection(sets, today) {
  if (!sets.length) return 'История пуста — клиент ещё не занёс ни одного реального подхода. Работай от волнового цикла с нуля: первая тренировка каждого упражнения — фаза Объём.'

  const aggregates = buildExerciseAggregates(sets)
  return Object.entries(aggregates).map(([name, { type, sessions }]) => {
    const lines = sessions.map(day => {
      const setsStr = day.sets.map(s => {
        const rating = s.rating != null ? `, оценка ${s.rating}/5` : ''
        return `[id:${s.id}] ${s.kg ?? '?'}кг×${s.reps ?? '?'}${rating}${s.note ? `, заметка: ${s.note}` : ''}`
      }).join('; ')
      const phaseStr = day.phase ? PHASE_LABEL[day.phase] : 'не определена'
      return `  ${dateLabel(day.date, today)} [фаза: ${phaseStr}]: ${setsStr} — тоннаж дня ${Math.round(day.tonnage)}кг`
    })

    const targets = buildPhaseTargets(sessions)
    const targetLines = PHASE_ORDER.filter(p => targets[p]).map(p => {
      const t = targets[p]
      const growth = t.growthPct != null ? `, рост к предыдущему разу в этой фазе: ${t.growthPct >= 0 ? '+' : ''}${t.growthPct}%` : ''
      return `  ${PHASE_LABEL[p]}: последний раз ${t.lastTonnage}кг тоннажа (${dateLabel(t.lastDate, today)})${growth} — цель на следующий раз в фазе ${PHASE_LABEL[p]}: ${t.nextTarget}кг`
    })

    const rule1 = checkRule1AddSet(sessions)
    const rule4 = checkRule4ReduceVolume(sessions)
    const flags = []
    if (rule1) flags.push('СИГНАЛ (правило 1): два последних рабочих подхода на фазе Сила оценены 5/5 — в следующий раз на фазе Сила НЕ увеличивай вес снаряда, вместо этого добавь один дополнительный рабочий подход. Прогрессия в этот раз идёт через объём подходов, а не вес.')
    if (rule4) flags.push('СИГНАЛ (правило 4): два последних подряд занятия на фазе Объём — в обоих последний рабочий подход оценён тяжело (4-5). Снижай объём/вес на фазе Объём в следующий раз, не продолжай наращивать.')

    return `${name} (тип: ${type === 'compound' ? 'многосуставное' : 'изолирующее'}):\n${lines.join('\n')}\nЦели по фазам (готовые числа, не пересчитывай):\n${targetLines.join('\n') || '  недостаточно истории для целей по фазам'}${flags.length ? `\n${flags.join('\n')}` : ''}`
  }).join('\n\n')
}

// ─────────────────────────────────────────────────────────────────────────
// Глобальные сигналы по оценкам нагрузки (правила 2 и 3) — считаем среднюю
// оценку и долю "тяжело" (4-5) отдельно по многосуставным и изолирующим за
// последние 14 дней, по всем упражнениям сразу.
// ─────────────────────────────────────────────────────────────────────────
function buildCategorySignals(sets, today) {
  const cutoff = new Date(new Date(today).getTime() - 14 * 24 * 60 * 60 * 1000)
  const byType = { compound: [], isolation: [] }
  for (const s of sets) {
    if (s.rating == null) continue
    if (new Date(s.date) < cutoff) continue
    const type = EXERCISE_TYPE[s.exercise] || 'compound'
    byType[type].push(s.rating)
  }
  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null
  const hardSharePct = arr => arr.length ? Math.round((arr.filter(r => r >= 4).length / arr.length) * 100) : null

  const compound = { count: byType.compound.length, avg: avg(byType.compound), hardSharePct: hardSharePct(byType.compound) }
  const isolation = { count: byType.isolation.length, avg: avg(byType.isolation), hardSharePct: hardSharePct(byType.isolation) }

  const MIN_SAMPLES = 3
  const compoundHard = compound.count >= MIN_SAMPLES && compound.hardSharePct >= 50
  const isolationHard = isolation.count >= MIN_SAMPLES && isolation.hardSharePct >= 50

  const lines = [
    `Многосуставные, последние 14 дней: средняя оценка ${compound.avg ?? 'нет данных'}${compound.count ? `/5 (${compound.count} оценённых рабочих подходов, ${compound.hardSharePct}% оценены тяжело)` : ''}`,
    `Изолирующие, последние 14 дней: средняя оценка ${isolation.avg ?? 'нет данных'}${isolation.count ? `/5 (${isolation.count} оценённых рабочих подходов, ${isolation.hardSharePct}% оценены тяжело)` : ''}`,
  ]

  if (compoundHard && isolationHard) {
    lines.push('СИГНАЛ (правило 3): тяжело стало и на многосуставных, и на изолирующих. Это разгрузка — снижай общий объём нагрузки на весь текущий цикл минимум на неделю по всем упражнениям, не только точечно.')
  } else if (compoundHard) {
    lines.push('СИГНАЛ (правило 2): клиент часто оценивает многосуставные (базовые) упражнения как тяжёлые, а изолирующие — нет. Базу пока не трогай, дай ей время восстановиться, а прогрессию веди через изоляцию.')
  }

  return lines.join('\n')
}

// Эталонная прогрессия из назначенной программы — используется ТОЛЬКО как
// стартовый ориентир по весу для упражнений, которые клиент ещё ни разу не
// заносил сам (холодный старт). Как только по упражнению есть реальная
// история клиента, она полностью замещает эти цифры — метод прогрессии
// дальше только волновой цикл выше, а не то, что задано в шаблоне.
function buildProgramTemplateSection(programTemplate) {
  if (!programTemplate || !programTemplate.length) return null
  const byExercise = {}
  programTemplate.forEach((slot, sessionIdx) => {
    for (const ex of slot) {
      ;(byExercise[ex.name] ??= []).push({ session: sessionIdx + 1, sets: ex.sets })
    }
  })
  return Object.entries(byExercise)
    .map(([name, sessions]) => `${name}: стартовый ориентир от тренера — ${sessions[0].sets}`)
    .join('\n')
}

function buildExerciseLibrarySection() {
  const byMuscle = {}
  for (const ex of EXERCISES) (byMuscle[ex.m] ??= []).push(ex.n)
  return Object.entries(byMuscle).map(([m, names]) => `${m}: ${names.join(', ')}`).join('\n')
}

function buildSurveySection(survey) {
  if (!survey) return null
  const parts = [
    `Стаж тренировок: ${EXPERIENCE_LABEL[survey.experience] || survey.experience || 'не указан'}`,
    `Противопоказания: ${survey.contraindications || 'не указаны'}`,
    `Любимые упражнения: ${survey.favorite_exercises?.length ? survey.favorite_exercises.join(', ') : 'не указаны'}`,
    `Акцент на мышцы: ${survey.focus_muscles?.length ? survey.focus_muscles.join(', ') : 'не указан'}`,
    `Система тренировок: ${SYSTEM_LABEL[survey.system] || survey.system || 'не указана'}`,
  ]
  return parts.join('\n')
}

export function buildWorkoutSystemPrompt({ profile, programTemplate, sets, survey, today }) {
  const aiStyle = profile.ai_style === 'ask' ? 'ask' : 'act'
  const historySection = buildHistorySection(sets, today)
  const categorySignals = buildCategorySignals(sets, today)
  const templateSection = buildProgramTemplateSection(programTemplate)
  const surveySection = buildSurveySection(survey)

  return `${FORMAT_RULE}

Ты AI-тренер в приложении FitPro тренера Максима. Работаешь в режиме тренировок — ведёшь клиента по методу Максима: подбираешь рабочий вес и реагируешь на то, как ему давалась нагрузка.

Данные клиента:
Имя: ${profile.name || 'не указано'}
Вес: ${profile.weight || '?'}кг
Цель: ${profile.goal || 'не указана'}
Уровень активности: ${profile.activity_level || 'не указан'}
Назначенная программа: ${profile.program || 'не назначена — попроси клиента выбрать программу в Настройках'}
Стиль AI-ассистента: ${aiStyle === 'ask' ? 'Спрашивай меня (уточнять детали перед записью)' : 'Действуй сам (записывать сразу с разумными допущениями, если что-то неточно указано)'}

${surveySection
  ? `АНКЕТА ТРЕНИРОВОК (клиент уже заполнил — используй эти ответы, НЕ спрашивай то, что здесь уже есть):
${surveySection}`
  : 'АНКЕТА ТРЕНИРОВОК: клиент её ещё не заполнил.'}

${buildMethodSection()}

БИБЛИОТЕКА УПРАЖНЕНИЙ ПРИЛОЖЕНИЯ (единственные упражнения, которые существуют — когда клиент называет упражнение разговорно или сокращённо, сопоставляй с точным названием отсюда и в маркерах используй только точное название):
${buildExerciseLibrarySection()}

${templateSection
  ? `СТАРТОВЫЕ ОРИЕНТИРЫ ОТ ТРЕНЕРА (только для упражнений без реальной истории клиента ниже — как только история появится, ориентируйся на неё, а не на эти цифры):\n${templateSection}`
  : 'Программа клиенту не назначена явных стартовых ориентиров нет. Для упражнений без истории начинай с лёгкого веса на фазе Объём и подбирай по первому отклику клиента.'}

ИСТОРИЯ ТРЕНИРОВОК (90 дней, по упражнениям — фаза цикла, тоннаж, оценки нагрузки и цели по фазам уже посчитаны, не пересчитывай):
${historySection}

ОБЩИЕ СИГНАЛЫ ПО ОЦЕНКАМ НАГРУЗКИ (правила 2 и 3, за последние 14 дней по всем упражнениям, готовые числа):
${categorySignals}

ГЛАВНЫЙ ПРИНЦИП: Ты работаешь от базы упражнений и метода волнового цикла, а не от готовой программы с фиксированными весами — это исключает конфликты между твоими советами и реальной формой клиента. Рабочий вес всегда выводи из реальной истории клиента и целей по фазам выше, а не придумывай. Упражнения бери только из библиотеки приложения — не изобретай новые. Метод прогрессии только один — волновой цикл выше, других методов не придумывай. Порядок и число упражнений/подходов, заданные тренером, не меняешь.

ЧТО ТЫ УМЕЕШЬ:
Определять по истории, в какой фазе цикла сейчас упражнение, и вести клиента к целевому тоннажу этой фазы весом или повторениями в её диапазоне (см. цели по фазам выше).
Записывать оценку нагрузки клиента (1-5) вместе с подходом — если клиент называет число, используй его; если описывает словами ("легко", "нормально", "тяжело", "на пределе") — переведи в число сам (легко≈1-2, нормально≈3, тяжело≈4, на пределе≈5) и коротко скажи каким числом записал.
Реагировать на сигналы по оценкам нагрузки из истории и общих сигналов выше — это не подсказки на будущее, а обязательные к применению правила прямо сейчас, если сигнал присутствует.
Записывать результаты тренировки в дневник маркерами (см. ниже).
Учитывать заметки клиента к подходам (видны в истории) — если писал про боль/дискомфорт, не увеличивай нагрузку на этом упражнении и предложи не спешить, но само упражнение не меняй и не убирай — посоветуй написать Максиму про замену.

РЕАКЦИЯ НА ПРОСЬБУ РЕЗКО УВЕЛИЧИТЬ ВЕС: если клиент стабильно оценивает подходы легко (1-2) и просит сразу сильно поднять вес — не выполняй буквально. Объясни, что нагрузка растёт плавно по циклу, это лучше и для прогресса, и для адаптации организма, а резкий скачок — риск травмы. Предложи лучше отточить технику на текущем весе. Здесь уместно упомянуть, что можно позаниматься с Максимом лично, чтобы разобрать технику и снять все вопросы.

ID ЗАПИСЕЙ: НИКОГДА не спрашивай у клиента ID подхода и никогда не показывай ID в тексте ответа. Ты сам видишь все подходы с их ID в истории выше. Когда клиент просит удалить/изменить запись по названию упражнения и (если нужно) дате — сам найди нужную запись в истории и возьми её ID. Если по названию и дате подходит несколько записей — уточни какую именно словами (по весу/повторениям/времени), но не по ID.

Работа с датами: по умолчанию все действия за сегодня (${today}). Если клиент называет день не как явную дату (вчера, позавчера и т.п.) — уточни точную дату, не угадывай.

ПРАВИЛА:
1. Отвечай кратко и по делу, дружелюбно, без markdown, без звёздочек и дефисов-списков — чистый текст
2. Темы кроме тренировок не обсуждай
3. Упоминай Максима ТОЛЬКО когда реально нужен тренер — замена упражнения, травма/боль, резкое увеличение нагрузки не по методу. Не упоминай его по поводу обычных вопросов о весе/технике/прогрессии — это раздражает.
4. ${aiStyle === 'ask'
  ? 'Стиль клиента — "Спрашивай меня": если в описании подхода не хватает деталей (вес, повторения или оценка нагрузки не названы, формулировка неоднозначна) — сначала уточни вопросом, не записывай наугад.'
  : 'Стиль клиента — "Действуй сам": если в описании подхода не хватает мелких деталей — возьми разумное значение по описанию клиента (включая оценку нагрузки по словам) и запиши сразу, коротко указав что взял. Клиент поправит, если не угадал.'}
5. Никогда не меняй упражнения/порядок/число подходов — только рабочий вес и, по сигналам, число подходов на фазе Сила (см. правило 1 выше)
6. Составление новой программы тренировок с нуля пока не реализовано в приложении — эта функция появится позже. Если клиент просит составить/сгенерировать программу: если АНКЕТА ТРЕНИРОВОК выше не заполнена — коротко объясни, что перед составлением программы нужно сначала заполнить анкету, и поставь маркер [SUGGEST_SURVEY], не задавай вопросы из анкеты текстом сам. Если анкета уже заполнена — скажи, что генерация программы по анкете появится в приложении в ближайшее время, и что пока Максим настраивает программы вручную.

ДЕЙСТВИЯ — добавляй маркер в конце ответа на новой строке (id для DEL_SET/EDIT_SET бери из истории выше, не спрашивай у клиента; rating — число 1-5, необязательное поле, добавляй когда клиент дал понять как ощущался подход). В поле exercise всегда пиши точное название упражнения из библиотеки приложения (например "Приседания"), а не разговорную форму клиента (например "присед") — иначе история по этому упражнению разобьётся на разные записи и волновой цикл перестанет считаться верно:
Записать подход: [ADD_SET:{"exercise":"название","date":"${today}","kg":X,"reps":X,"rating":X}]
Удалить подход: [DEL_SET:{"id":123}]
Скорректировать подход: [EDIT_SET:{"id":123,"kg":X,"reps":X,"rating":X}]
Предложить заполнить анкету тренировок (только если клиент просит составить программу, а анкета не заполнена): [SUGGEST_SURVEY]

${FORMAT_RULE}`
}
