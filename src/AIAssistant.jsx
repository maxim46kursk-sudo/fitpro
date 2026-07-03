import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { supabase } from './supabase.js'

const PUR = '#7F77DD'
const TEA = '#1D9E75'

// Ключ из переменной окружения (подставляется Vite при сборке на Vercel)
const ENV_KEY = (import.meta.env.VITE_ANTHROPIC_KEY || '').trim()

const AIAssistant = forwardRef(function AIAssistant({ workoutHistory = [], isMobile = false, nutritionPlans = [], userId = null }, ref) {
  const [isOpen, setIsOpen]         = useState(false)
  const [mode, setMode]             = useState('workout')
  const [messages, setMessages]     = useState([])
  const [input, setInput]           = useState('')
  const [loading, setLoading]       = useState(false)
  // ENV_KEY — приоритет. Если пустой — берём из localStorage (ручной ввод)
  const [apiKey, setApiKey]         = useState(() => ENV_KEY || localStorage.getItem('fitpro_ai_key') || '')
  const [keyDraft, setKeyDraft]     = useState('')
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [savedMsgIds, setSavedMsgIds] = useState({})
  const [diaryDatePicker, setDiaryDatePicker] = useState(null)
  const todayISO = (() => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}` })()
  const [pickerDate, setPickerDate] = useState(todayISO)
  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)

  useImperativeHandle(ref, () => ({
    open: (m) => {
      if (m && m !== mode) {
        setMode(m)
        setMessages([])
      }
      setIsOpen(true)
    }
  }))

  // Загрузка истории чата из Supabase при открытии или смене режима
  useEffect(() => {
    if (!isOpen || !userId) return
    supabase.from('chat_messages').select('*')
      .eq('user_id', userId).eq('mode', mode).order('created_at')
      .then(({ data }) => {
        if (data) setMessages(data.map(m => ({ role: m.role, content: m.content })))
      })
  }, [mode, isOpen, userId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 150)
  }, [isOpen])

  // ── Единый динамический системный промпт ─────────────────────────────
  const buildSystemPrompt = (mode) => {
    // Текущее время — читается свежим при каждом вызове
    const nowStr = new Date().toLocaleString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })

    // 1. Профиль клиента
    const profile = (() => { try { return JSON.parse(localStorage.getItem('fitpro_profile') || 'null') } catch { return null } }) () || {}
    const clientName   = profile.name   || 'Клиент'
    const clientGoal   = profile.goal   || 'не указана'
    const clientWeight = profile.weight ? `${profile.weight} кг` : 'не указан'
    const clientHeight = profile.height ? `${profile.height} см` : 'не указан'
    const clientOccupation = profile.occupation || null
    const clientAge = (() => {
      if (!profile.birthdate) return null
      const diff = Date.now() - new Date(profile.birthdate).getTime()
      return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25))
    })()

    // 2. Определяем идеальный вес и наличие лишнего веса
    const weightNum  = parseFloat(profile.weight) || 0
    const heightNum  = parseFloat(profile.height) || 0
    const idealWeight = heightNum > 0 ? heightNum - 100 : 0
    const isOverweight = weightNum > 0 && idealWeight > 0 && weightNum > idealWeight
    // Если лишний вес — считаем нормы от идеального веса, иначе от фактического
    const baseWeight = isOverweight && idealWeight > 0 ? idealWeight : weightNum

    // 3. Цель: множитель углеводов зависит от цели (набор / рельеф / всё остальное)
    const goalStr = (profile.goal || '').toLowerCase()
    const isMassGain = goalStr.includes('набор') || goalStr.includes('масс')
    const isCutting  = goalStr.includes('рельеф')
    const carbMult   = isMassGain ? 5 : isCutting ? 2 : 3

    // 4. Рассчитываем норму: Б×2г/кг, Ж×1г/кг, У×carbMult г/кг, ккал = Б×4 + Ж×9 + У×4
    const normP    = baseWeight > 0 ? Math.round(baseWeight * 2) : null
    const normF    = baseWeight > 0 ? Math.round(baseWeight * 1) : null
    const normC    = baseWeight > 0 ? Math.round(baseWeight * carbMult) : null
    const normKcal = normP !== null ? normP * 4 + normF * 9 + normC * 4 : null

    // 5. Подбор подходящего рациона по БАЗОВОМУ весу
    const matchedPlan = nutritionPlans.find(p => {
      const [lo, hi] = p.id.split('_').map(Number)
      return baseWeight >= lo && baseWeight <= hi
    }) || null
    const planDay1 = matchedPlan?.days?.[0]
    const planDay1Text = planDay1 ? planDay1.meals.map(m =>
      `${m.name}${m.time ? ' (' + m.time + ')' : ''}: ${m.items.join(', ')} — ${m.cal} ккал, Б:${m.p}г У:${m.c}г Ж:${m.f}г`
    ).join('\n') : ''

    // 4. Съедено сегодня
    const diary = (() => { try { return JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}') } catch { return {} } })()
    const today = new Date().toISOString().slice(0, 10)
    const todayEntries = diary[today] || []
    const eaten = todayEntries.reduce((a, e) => ({
      kcal: a.kcal + (+e.kcal || 0), p: a.p + (+e.p || 0),
      f: a.f + (+e.f || 0), c: a.c + (+e.c || 0)
    }), { kcal: 0, p: 0, f: 0, c: 0 })
    const foodGoals = (() => { try { return JSON.parse(localStorage.getItem('fitpro_food_goals') || '{}') } catch { return {} } })()
    const userNormKcal = foodGoals.kcal ? Number(foodGoals.kcal) : null
    const userNormP    = foodGoals.p    ? Number(foodGoals.p)    : null
    const userNormF    = foodGoals.f    ? Number(foodGoals.f)    : null
    const userNormC    = foodGoals.c    ? Number(foodGoals.c)    : null
    const remKcal = userNormKcal !== null ? Math.max(0, userNormKcal - eaten.kcal) : null
    const remP    = userNormP    !== null ? Math.max(0, userNormP    - eaten.p)    : null
    const remF    = userNormF    !== null ? Math.max(0, userNormF    - eaten.f)    : null
    const remC    = userNormC    !== null ? Math.max(0, userNormC    - eaten.c)    : null

    // 4. Последние 5 тренировок с весами
    const recent = [...workoutHistory]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5)

    // Определяем программу по наиболее частой папке в истории
    const folderCount = {}
    recent.forEach(w => { if (w.folder) folderCount[w.folder] = (folderCount[w.folder] || 0) + 1 })
    const topFolder = Object.entries(folderCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null

    const workoutHistoryText = recent.length === 0
      ? 'История тренировок пока пуста.'
      : recent.map(w => {
          const dateStr = new Date(w.date).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
          const exLines = (w.exercises || [])
            .filter(ex => (ex.sets || []).some(s => s.kg || s.reps))
            .map(ex => {
              const sets = (ex.sets || []).filter(s => s.kg || s.reps)
                .map(s => `${s.kg || 0}кг×${s.reps || 0}`).join(', ')
              return `    ${ex.n}: ${sets}`
            }).join('\n')
          return `  ${dateStr} — ${w.name || 'Тренировка'}:\n${exLines || '    (нет данных о весах)'}`
        }).join('\n')

    // Полный дневник питания за 3 дня с ID каждой записи
    const diaryForPrompt = (() => {
      const out = []
      for (let d = 0; d < 3; d++) {
        const dt = new Date(); dt.setDate(dt.getDate() - d)
        const iso = dt.toISOString().slice(0, 10)
        const entries = diary[iso] || []
        const label = d===0?'СЕГОДНЯ':d===1?'ВЧЕРА':'ПОЗАВЧЕРА'
        if (entries.length > 0) {
          const tot = entries.reduce((a, e) => ({ kcal: a.kcal+(+e.kcal||0), p: a.p+(+e.p||0), c: a.c+(+e.c||0), f: a.f+(+e.f||0) }), { kcal:0, p:0, c:0, f:0 })
          const lines = entries.map(e => `  [id:${e.id}] ${e.name} — ${e.kcal}ккал, Б:${e.p||0}г У:${e.c||0}г Ж:${e.f||0}г`).join('\n')
          out.push(`${label} (${iso}):\n${lines}\n  Итого: ${Math.round(tot.kcal)}ккал Б:${Math.round(tot.p)}г У:${Math.round(tot.c)}г Ж:${Math.round(tot.f)}г`)
        } else {
          out.push(`${label} (${iso}): записей нет`)
        }
      }
      return out.join('\n\n')
    })()

    // ── ПРОМПТ ДЛЯ РЕЖИМА ПИТАНИЯ ────────────────────────────────────────
    if (mode === 'nutrition') {
      const profileFilled = weightNum > 0 && heightNum > 0

      const normLine = userNormKcal
        ? `${userNormKcal} ккал, Б:${userNormP||0}г У:${userNormC||0}г Ж:${userNormF||0}г (установлена)`
        : matchedPlan
          ? `${matchedPlan.target.cal} ккал (из рациона тренера)`
          : normKcal !== null
            ? `${normKcal} ккал, Б:${normP}г У:${normC}г Ж:${normF}г (расчётная)`
            : 'не определена — заполни профиль'

      const remLine = remKcal !== null
        ? `${remKcal} ккал`
        : 'цель не установлена'

      const planText = matchedPlan && planDay1Text
        ? `${matchedPlan.title} — цель ${matchedPlan.target.cal}ккал/день\nПример дня:\n${planDay1Text}\nИтого дня: ${planDay1.total.cal}ккал Б:${planDay1.total.p}г У:${planDay1.total.c}г Ж:${planDay1.total.f}г`
        : 'Рацион не подобран — заполни профиль (вес и рост).'

      return `ВАЖНО: данные дневника питания которые я передаю тебе в этом промпте — это единственный источник правды. Игнорируй любые цифры которые ты сам упоминал в предыдущих сообщениях этого чата. Каждый раз когда пользователь спрашивает про сегодняшний рацион — смотри ТОЛЬКО на раздел ДНЕВНИК ПИТАНИЯ в этом промпте, не на историю переписки.

Сейчас: ${nowStr}
Все данные ниже прочитаны из приложения прямо сейчас в ${nowStr}. Любые цифры из истории чата устарели — не доверяй им.

Ты AI помощник по питанию в приложении тренера Максима.

ТВОЯ ЛИЧНОСТЬ:
Ты как умный друг-диетолог. Тёплый, конкретный, без воды. Максимум 3-4 предложения в ответе если вопрос простой. Никогда не используй звёздочки, решётки, тире списком — только чистый текст.

ДАННЫЕ КЛИЕНТА КОТОРЫЕ ТЫ ВИДИШЬ:
Имя: ${clientName}
Цель: ${clientGoal}
Вес: ${clientWeight}, Рост: ${clientHeight}${clientAge ? `, ${clientAge} лет` : ''}
Норма в день: ${normLine}
Съедено сегодня: ${eaten.kcal.toFixed(0)} ккал, Б:${eaten.p.toFixed(0)}г У:${eaten.c.toFixed(0)}г Ж:${eaten.f.toFixed(0)}г
Осталось: ${remLine}

Дневник питания за 3 дня:
${diaryForPrompt}

Готовые рационы тренера:
${planText}
${isOverweight ? `\nВАЖНО: у клиента лишний вес (${clientWeight} при росте ${clientHeight}). Нормы рассчитаны от идеального веса ${idealWeight}кг. Объясни это мягко если спросят.` : ''}${isMassGain ? '\nЦЕЛЬ — набор массы: углеводы x5г/кг.' : isCutting ? '\nЦЕЛЬ — рельеф: углеводы x2г/кг.' : ''}

${!profileFilled ? 'СТАТУС ПРОФИЛЯ: не заполнен (нет веса или роста).' : ''}

ЕСЛИ ПРОФИЛЬ НЕ ЗАПОЛНЕН:
Скажи: "Чтобы я мог помочь точно — заполни профиль в приложении: вес, рост и цель. Это займёт 30 секунд." Больше ничего не делай.

ЧТО ТЫ УМЕЕШЬ:
Записать еду в дневник — если человек говорит что поел или просит записать, используй маркер [DIARY_ENTRY:{"name":"...","kcal":X,"p":X,"c":X,"f":X}]
Удалить запись — [DELETE_ENTRY:{"date":"YYYY-MM-DD","id":X}]
Установить норму — [SET_GOALS:{"kcal":X,"p":X,"c":X,"f":X}]
Очистить день — [CLEAR_DIARY:{"date":"YYYY-MM-DD"}]
Составить рацион — берёшь готовый рацион тренера который подходит под вес и цель клиента. Никогда не придумывай цифры сам — только те что в рационах тренера.
Ответить на любой вопрос по питанию — продукты, калории, что можно съесть, как вписать что-то в норму.

СТРОГИЕ ПРАВИЛА:
Цифры калорий и макросов берёшь ТОЛЬКО из рационов тренера и профиля клиента. Никогда не придумываешь свои нормы.
Если человек спрашивает не про питание — вежливо скажи что ты помогаешь только с питанием.
Раз в 4-5 сообщений ненавязчиво упомяни в конце что-то вроде: "Кстати, если хочешь ускорить результат — Максим ведёт персональные тренировки, пиши ему напрямую."
Никогда не говори что у тебя нет доступа к данным — ты видишь всё что написано выше.
Отвечай на русском. Без markdown. Только чистый текст.`
    }

    // ── ПРОМПТ ДЛЯ РЕЖИМА ТРЕНИРОВОК (без изменений) ─────────────────────
    return `ВАЖНО: данные которые я передаю тебе в этом промпте — единственный источник правды. Игнорируй любые цифры которые ты сам упоминал в предыдущих сообщениях. Каждый раз смотри ТОЛЬКО на данные в этом промпте, не на историю переписки.

Сейчас: ${nowStr}
Все данные ниже прочитаны из приложения прямо сейчас. Любые цифры из истории чата устарели — не доверяй им.

Ты — дружелюбный персональный AI-помощник тренера Максима в фитнес-приложении FitPro. Максим — сертифицированный тренер, работает с клиентами лично.

=== ДАННЫЕ АКТУАЛЬНЫ НА ${nowStr} ===

=== АКТУАЛЬНЫЕ ДАННЫЕ КЛИЕНТА ===
Имя: ${clientName}${clientAge ? `, ${clientAge} лет` : ''}
Цель: ${clientGoal}
Вес: ${clientWeight}, Рост: ${clientHeight}${clientOccupation ? `, Работа: ${clientOccupation}` : ''}${profile.gymDays ? `, Тренировок в неделю: ${profile.gymDays}` : ''}${profile.steps ? `, Шагов/день: ~${profile.steps}` : ''}

=== ДНЕВНИК ПИТАНИЯ (у тебя есть ПОЛНЫЙ доступ к этим данным) ===
${diaryForPrompt}

Съедено сегодня: ${eaten.kcal.toFixed(0)} ккал, Б:${eaten.p.toFixed(0)}г У:${eaten.c.toFixed(0)}г Ж:${eaten.f.toFixed(0)}г
${userNormKcal
  ? `Цель пользователя в приложении: ${userNormKcal}ккал Б:${userNormP||0}г У:${userNormC||0}г Ж:${userNormF||0}г\nОсталось до цели: ${remKcal} ккал, Б:${remP}г У:${remC}г Ж:${remF}г`
  : 'Цель в приложении НЕ установлена. Не называй никакую цифру "нормой" или "установленной нормой".'}

=== РЕКОМЕНДУЕМАЯ НОРМА (только для советов, НЕ выдавать как "установленная норма") ===
${normKcal !== null
  ? `${isOverweight ? `Лишний вес — рекомендую считать от идеального веса ${idealWeight}кг (рост минус 100).` : ''}${isMassGain ? ' Набор массы — углеводы x5г/кг.' : isCutting ? ' Рельеф — углеводы x2г/кг.' : ''}
Рекомендация: ${normKcal} ккал, Б:${normP}г, Ж:${normF}г, У:${normC}г.`
  : 'Вес не указан — рекомендацию дать нельзя.'}

=== ИСТОРИЯ ТРЕНИРОВОК ===
${workoutHistoryText}

${matchedPlan && planDay1Text && !isMassGain && !isCutting ? `=== ГОТОВЫЙ РАЦИОН (предлагай этот план) ===
${matchedPlan.title} — ${matchedPlan.target.cal}ккал/день
День 1: ${planDay1Text}
Итого: ${planDay1.total.cal}ккал Б:${planDay1.total.p}г У:${planDay1.total.c}г Ж:${planDay1.total.f}г` : ''}

=== ТВОИ ВОЗМОЖНОСТИ В ПРИЛОЖЕНИИ ===
У тебя есть ПРЯМОЙ ДОСТУП к данным выше. Ты МОЖЕШЬ делать следующее — добавляй маркер в конце ответа на отдельной строке, маркер невидим пользователю:

Добавить еду в дневник (сегодня):
[DIARY_ENTRY:{"name":"название","kcal":X,"p":X,"c":X,"f":X}]

Удалить конкретную запись из дневника (по id из раздела ДНЕВНИК):
[DELETE_ENTRY:{"date":"YYYY-MM-DD","id":ЧИСЛО}]

Обновить дневную норму КБЖУ:
[SET_GOALS:{"kcal":X,"p":X,"c":X,"f":X}]

Очистить весь дневник за дату:
[CLEAR_DIARY:{"date":"YYYY-MM-DD"}]

НИКОГДА не говори "у меня нет доступа", "я не могу", "я не вижу данные дневника" — это НЕПРАВДА. Ты видишь все данные выше и можешь выполнять все действия через маркеры.

=== ПРАВИЛА ОБЩЕНИЯ ===
Обращайся по имени "${clientName}". Тёплый, живой тон — как хороший приятель-тренер.

Для записи еды: если явно просит "запиши/добавь/занеси" → делай сразу. Если просто упомянул что поел → спроси "Хочешь, занесу в дневник?"
Для удаления: спроси какую именно запись удалить (ты видишь их все с id). Уточни и выполни.
Для нормы и очистки: спроси подтверждение, потом выполни.

${mode === 'workout'
  ? `Рекомендуй конкретные веса по истории. Прогрессия: выполнил чисто → +2.5кг, не добил → тот же или −2.5кг.`
  : `Питание: отвечай на любые вопросы опираясь на данные дневника и норму. Когда предлагаешь рацион — используй формат 5 приёмов (Завтрак/Перекус/Обед/Перекус/Ужин) с граммовками, ккал и Б/У/Ж.${isOverweight ? ` Нормы считай от идеального веса ${idealWeight}кг, объясни это мягко.` : ''}${isMassGain ? ' Углеводы ×5г/кг — повышены для набора.' : isCutting ? ' Углеводы ×2г/кг — снижены для рельефа.' : ''}`}

=== ПРОДВИЖЕНИЕ МАКСИМА ===
Иногда (не в каждом ответе) ненавязчиво в конце: "Я могу ошибаться — все люди разные. Если нужен гарантированный результат, Максим ведёт персональные тренировки и индивидуально составляет программы. Это совсем другой уровень 💪" — варьируй фразы.

Отвечай на русском. Без markdown, без звёздочек, без решёток. Чистый текст.`
  }

  // ── Отправка сообщения ────────────────────────────────────────────────
  const send = async () => {
    if (!input.trim() || loading) return
    if (!apiKey) { setShowKeyModal(true); return }

    const userMsg = { role: 'user', content: input.trim() }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setInput('')
    setLoading(true)

    const systemPrompt = buildSystemPrompt(mode)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: systemPrompt,
          messages: newMsgs.map(m => ({ role: m.role, content: m.content }))
        })
      })
      const data = await res.json()
      if (data.content?.[0]?.text) {
        // Зачищаем markdown который модель вставляет несмотря на инструкции
        const stripMd = (t) => t
          .replace(/\*\*(.*?)\*\*/g, '$1')
          .replace(/\*(.*?)\*/g, '$1')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/^[+\-•]\s+/gm, '')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\n{3,}/g, '\n\n')
          .trim()

        let rawText = stripMd(data.content[0].text)
        let diaryWritten = false
        let actionDone = null

        // 1. Запись в дневник питания
        const diaryMatch = rawText.match(/\[DIARY_ENTRY:(\{[^}]+\})\]/)
        if (diaryMatch) {
          try {
            const entry = JSON.parse(diaryMatch[1])
            const date = new Date().toISOString().slice(0, 10)
            const newId = Date.now()
            const raw = localStorage.getItem('fitpro_food_diary')
            const diary = raw ? JSON.parse(raw) : {}
            diary[date] = [...(diary[date] || []), { id: newId, ...entry }]
            localStorage.setItem('fitpro_food_diary', JSON.stringify(diary))
            if (userId) {
              const { error } = await supabase.from('food_diary').insert({
                user_id: userId, date,
                name: entry.name, kcal: +entry.kcal||0,
                p: +entry.p||0, c: +entry.c||0, f: +entry.f||0,
              })
              if (error) console.error('Ошибка записи в дневник питания:', error)
            }
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            diaryWritten = true
          } catch {}
          rawText = rawText.replace(/\[DIARY_ENTRY:[^\]]+\]/g, '').trim()
        }

        // 2. Установить норму КБЖУ
        const goalsMatch = rawText.match(/\[SET_GOALS:(\{[^}]+\})\]/)
        if (goalsMatch) {
          try {
            const goals = JSON.parse(goalsMatch[1])
            let existing = {}
            try { existing = JSON.parse(localStorage.getItem('fitpro_food_goals') || '{}') } catch {}
            const merged = { ...existing, ...goals }
            localStorage.setItem('fitpro_food_goals', JSON.stringify(merged))
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            if (userId) {
              supabase.from('food_goals').upsert({ user_id: userId, ...merged, updated_at: new Date().toISOString() })
            }
            actionDone = 'goals_set'
          } catch {}
          rawText = rawText.replace(/\[SET_GOALS:[^\]]+\]/g, '').trim()
        }

        // 3. Удалить конкретную запись по id
        const deleteMatch = rawText.match(/\[DELETE_ENTRY:(\{[^}]+\})\]/)
        if (deleteMatch) {
          try {
            const { date, id } = JSON.parse(deleteMatch[1])
            const raw = localStorage.getItem('fitpro_food_diary')
            const diary = raw ? JSON.parse(raw) : {}
            if (diary[date]) {
              diary[date] = diary[date].filter(e => String(e.id) !== String(id))
              if (diary[date].length === 0) delete diary[date]
            }
            localStorage.setItem('fitpro_food_diary', JSON.stringify(diary))
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            if (userId) supabase.from('food_diary').delete().eq('id', id)
            actionDone = 'entry_deleted'
          } catch {}
          rawText = rawText.replace(/\[DELETE_ENTRY:[^\]]+\]/g, '').trim()
        }

        // 4. Очистить весь дневник за дату
        const clearMatch = rawText.match(/\[CLEAR_DIARY:(\{[^}]+\})\]/)
        if (clearMatch) {
          try {
            const { date } = JSON.parse(clearMatch[1])
            const raw = localStorage.getItem('fitpro_food_diary')
            const diary = raw ? JSON.parse(raw) : {}
            delete diary[date]
            localStorage.setItem('fitpro_food_diary', JSON.stringify(diary))
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            actionDone = `cleared_${date}`
          } catch {}
          rawText = rawText.replace(/\[CLEAR_DIARY:[^\]]+\]/g, '').trim()
        }

        setMessages(prev => [...prev, { role: 'assistant', content: rawText, diaryWritten, actionDone }])
        // Сохраняем оба сообщения в Supabase
        if (userId) {
          await supabase.from('chat_messages').insert([
            { user_id: userId, mode, role: 'user', content: userMsg.content },
            { user_id: userId, mode, role: 'assistant', content: rawText },
          ])
        }
      } else if (res.status === 401) {
        if (ENV_KEY) {
          setMessages(prev => [...prev, { role: 'assistant', content: '❌ Ошибка авторизации. Проверьте переменную VITE_ANTHROPIC_KEY на сервере.' }])
        } else {
          setMessages(prev => [...prev, { role: 'assistant', content: '❌ API ключ неверный. Нажми 🔑 и введи рабочий ключ.' }])
          setShowKeyModal(true)
        }
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка ${res.status}: ${data.error?.message || 'Что-то пошло не так'}` }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка сети: ${err.message}` }])
    } finally {
      setLoading(false)
    }
  }

  // Определяем рацион по весу профиля (null если вес вне диапазона всех планов)
  const getMatchedPlan = () => {
    const profile = (() => { try { return JSON.parse(localStorage.getItem('fitpro_profile') || 'null') } catch { return null } })() || {}
    const weightNum = parseFloat(profile.weight) || 0
    return nutritionPlans.find(p => {
      const [lo, hi] = p.id.split('_').map(Number)
      return weightNum >= lo && weightNum <= hi
    }) || null
  }

  // Записать день рациона в дневник — парсим текст AI сообщения
  const savePlanDayToDiary = (msgId, date) => {
    const msg = messages[msgId]
    const text = msg?.content || ''
    const mealKw = ['завтрак', 'перекус', 'обед', 'ужин']
    const entries = []

    // Парсим строки вида: "Завтрак (8:00): Овсянка 45г — 320 ккал, Б:12г У:55г Ж:10г"
    text.split('\n').forEach(line => {
      const t = line.trim()
      if (!t) return
      const low = t.toLowerCase()
      if (low.includes('итого')) return
      const meal = mealKw.find(k => low.startsWith(k))
      if (!meal) return
      const kcalM = t.match(/(\d+)\s*ккал/)
      if (!kcalM) return
      const pM = t.match(/[Бб][:\s]*(\d+)/)
      const cM = t.match(/[Уу][:\s]*(\d+)/)
      const fM = t.match(/[Жж][:\s]*(\d+)/)
      const name = t.split(/\s*[(:\-–]/)[0].trim() || meal
      entries.push({
        id: Date.now() + entries.length,
        name,
        kcal: kcalM[1],
        p: pM?.[1] || '0',
        c: cM?.[1] || '0',
        f: fM?.[1] || '0',
      })
    })

    // Если из текста ничего не распарсилось — пробуем готовый план
    if (entries.length === 0) {
      const plan = getMatchedPlan()
      if (plan?.days?.[0]) {
        plan.days[0].meals.forEach((meal, i) => entries.push({
          id: Date.now() + i,
          name: `${meal.name}${meal.time ? ' (' + meal.time + ')' : ''}`,
          kcal: String(meal.cal), p: String(meal.p), c: String(meal.c), f: String(meal.f),
        }))
      }
    }

    if (entries.length === 0) return
    let diary = {}
    try { diary = JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}') } catch {}
    diary[date] = [...(diary[date] || []), ...entries]
    localStorage.setItem('fitpro_food_diary', JSON.stringify(diary))
    window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
    if (userId) {
      supabase.from('food_diary').insert(entries.map(e => ({
        user_id: userId, date, name: e.name,
        kcal: +e.kcal||0, p: +e.p||0, c: +e.c||0, f: +e.f||0,
      })))
    }
    setSavedMsgIds(prev => ({ ...prev, [msgId]: date }))
    setDiaryDatePicker(null)
  }

  const isDietMessage = (text) => {
    const kw = ['завтрак', 'обед', 'ужин', 'перекус', 'ккал', 'рацион', 'питание', 'белки', 'день 1']
    const low = text.toLowerCase()
    return kw.filter(k => low.includes(k)).length >= 3
  }

  const saveKey = () => {
    const k = keyDraft.trim()
    if (!k) return
    localStorage.setItem('fitpro_ai_key', k)
    setApiKey(k)
    setKeyDraft('')
    setShowKeyModal(false)
  }

  const HINTS = {
    workout: ['С каким весом приседать?', 'Прогресс за месяц?', 'Жим лёжа — прибавить?'],
    nutrition: ['Какой рацион мне подойдет?', 'Что съесть после тренировки?', 'Можно ли мне алкоголь?'],
  }

  const BTN_BOTTOM = isMobile ? 78 : 24

  return (
    <>
      <style>{`
        @keyframes ai-bounce {
          0%,60%,100%{transform:translateY(0)}
          30%{transform:translateY(-5px)}
        }
        @keyframes ai-pulse {
          0%,100%{box-shadow:0 4px 20px #7F77DD55}
          50%{box-shadow:0 4px 28px #7F77DD99}
        }
      `}</style>

      {/* Плавающая кнопка */}
      {!isOpen && (
        <button onClick={() => setIsOpen(true)} style={{
          position: 'fixed', bottom: BTN_BOTTOM, right: 18, zIndex: 950,
          width: 52, height: 52, borderRadius: '50%', border: 'none',
          background: 'linear-gradient(135deg,#7F77DD,#5b54c4)',
          color: '#fff', fontSize: 22, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'ai-pulse 2.5s ease-in-out infinite',
          minHeight: 'unset',
        }}>🤖</button>
      )}

      {/* Чат */}
      {isOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1050,
          display: 'flex', flexDirection: 'column', background: '#fff',
        }}>

          {/* Хедер */}
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #e5e7eb',
            display: 'flex', alignItems: 'center', gap: 10,
            background: '#fff', flexShrink: 0,
          }}>
            <button onClick={() => setIsOpen(false)} style={{
              background: 'none', border: 'none', fontSize: 22, cursor: 'pointer',
              color: '#9ca3af', padding: 0, lineHeight: 1, minHeight: 'unset',
            }}>←</button>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#7F77DD,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🤖</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111', lineHeight: 1.2 }}>AI Ассистент</div>
              <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 500 }}>● онлайн</div>
            </div>
            {new URLSearchParams(window.location.search).get('dev') === '1' && (
              <button onClick={() => setShowKeyModal(true)} style={{
                background: 'none', border: '1px solid #e5e7eb', borderRadius: 8,
                padding: '5px 10px', fontSize: 11, color: '#9ca3af', cursor: 'pointer', minHeight: 'unset',
              }}>🔑</button>
            )}
          </div>

          {/* Переключатель режима */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 8, flexShrink: 0, background: '#fafafa' }}>
            {[{ id: 'workout', label: '🏋️ Тренировки' }, { id: 'nutrition', label: '🥗 Питание' }].map(m => (
              <button key={m.id} onClick={() => { setMode(m.id); setMessages(loadChat(m.id)) }}
                style={{
                  padding: '7px 18px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  background: mode === m.id ? PUR : '#fff',
                  color: mode === m.id ? '#fff' : '#6b7280',
                  fontSize: 13, fontWeight: mode === m.id ? 700 : 500,
                  boxShadow: mode === m.id ? `0 2px 10px ${PUR}44` : '0 1px 3px rgba(0,0,0,0.08)',
                  transition: 'all 0.15s', minHeight: 'unset',
                }}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Сообщения */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Заглушка если нет сообщений */}
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', marginTop: 24 }}>
                <div style={{ fontSize: 42, marginBottom: 12 }}>🤖</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 6 }}>
                  {(() => {
                    const p = (() => { try { return JSON.parse(localStorage.getItem('fitpro_profile') || 'null') } catch { return null } })() || {}
                    const name = (p.name || '').split(' ')[0] || ''
                    return name
                      ? `Привет, ${name}! ${mode === 'workout' ? '💪' : '🥗'}`
                      : (mode === 'workout' ? 'AI тренер по вашей программе' : 'AI диетолог')
                  })()}
                </div>
                <div style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.65, marginBottom: 20 }}>
                  {mode === 'workout'
                    ? 'Знаю твою историю весов и подберу\nнагрузку на следующую тренировку'
                    : 'Вижу твой план питания и остаток\nкалорий — спрашивай что угодно'}
                </div>
                {/* Подсказки */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                  {HINTS[mode].map((h, i) => (
                    <button key={i} onClick={() => setInput(h)}
                      style={{
                        padding: '8px 16px', borderRadius: 20, border: `1px solid ${PUR}44`,
                        background: `${PUR}08`, color: PUR, fontSize: 13, cursor: 'pointer',
                        fontWeight: 500, minHeight: 'unset',
                      }}>
                      {h}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Список сообщений */}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 8, width: '100%' }}>
                  {m.role === 'assistant' && (
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#7F77DD,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>🤖</div>
                  )}
                  <div style={{
                    maxWidth: '75%', padding: '10px 14px',
                    borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
                    background: m.role === 'user' ? PUR : '#f3f4f6',
                    color: m.role === 'user' ? '#fff' : '#111',
                    fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap',
                    textAlign: 'left',
                  }}>
                    {m.content}
                  </div>
                </div>
                {/* Авто-запись в дневник через маркер */}
                {m.role === 'assistant' && m.diaryWritten && (
                  <div style={{ paddingLeft: 36 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#f0fdf4', border: '1.5px solid #22c55e40' }}>
                      <span style={{ fontSize: 14, color: '#22c55e' }}>✓</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Записано в дневник</span>
                    </div>
                  </div>
                )}
                {/* Подтверждение установки нормы */}
                {m.role === 'assistant' && m.actionDone === 'goals_set' && (
                  <div style={{ paddingLeft: 36 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#f0fdf4', border: '1.5px solid #22c55e40' }}>
                      <span style={{ fontSize: 14, color: '#22c55e' }}>✓</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Норма КБЖУ обновлена</span>
                    </div>
                  </div>
                )}
                {/* Подтверждение удаления записи */}
                {m.role === 'assistant' && m.actionDone === 'entry_deleted' && (
                  <div style={{ paddingLeft: 36 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#fff7ed', border: '1.5px solid #f9731640' }}>
                      <span style={{ fontSize: 14, color: '#f97316' }}>🗑</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#f97316' }}>Запись удалена из дневника</span>
                    </div>
                  </div>
                )}
                {/* Подтверждение очистки дневника */}
                {m.role === 'assistant' && m.actionDone?.startsWith('cleared_') && (
                  <div style={{ paddingLeft: 36 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#fff7ed', border: '1.5px solid #f9731640' }}>
                      <span style={{ fontSize: 14, color: '#f97316' }}>🗑</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#f97316' }}>Дневник очищен</span>
                    </div>
                  </div>
                )}
                {/* Кнопка «Записать в дневник» — под AI-сообщением с рационом */}
                {m.role === 'assistant' && !m.diaryWritten && mode === 'nutrition' && isDietMessage(m.content) && (
                  <div style={{ paddingLeft: 36, paddingRight: 4 }}>
                    {savedMsgIds[i] ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#f0fdf4', border: '1.5px solid #22c55e40' }}>
                        <span style={{ fontSize: 14, color: '#22c55e' }}>✓</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Записано на {(()=>{const d=new Date(savedMsgIds[i]+'T00:00:00');const t=new Date();const y=new Date(t);y.setDate(y.getDate()-1);const ti=t.toISOString().slice(0,10);const yi=y.toISOString().slice(0,10);return savedMsgIds[i]===ti?'сегодня':savedMsgIds[i]===yi?'вчера':`${d.getDate()}.${String(d.getMonth()+1).padStart(2,'0')}`})()}</span>
                      </div>
                    ) : diaryDatePicker === i ? (
                      <div style={{ background: '#f9fafb', borderRadius: 14, padding: '12px 14px', border: '1px solid #e5e7eb', boxShadow: '0 2px 12px rgba(0,0,0,0.07)' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Выберите дату</div>
                        {/* Быстрые кнопки */}
                        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                          {[
                            ['Вчера', (()=>{const y=new Date();y.setDate(y.getDate()-1);return `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,'0')}-${String(y.getDate()).padStart(2,'0')}`})()],
                            ['Сегодня', todayISO],
                            ['Завтра', (()=>{const t=new Date();t.setDate(t.getDate()+1);return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`})()]
                          ].map(([label, iso]) => (
                            <button key={iso} onClick={() => setPickerDate(iso)}
                              style={{ flex:1, padding:'8px 0', borderRadius:9, border:`1.5px solid ${pickerDate===iso?PUR:'#e5e7eb'}`, background: pickerDate===iso?PUR:'#fff', color: pickerDate===iso?'#fff':'#6b7280', fontSize:12, fontWeight:600, cursor:'pointer', minHeight:'unset', transition:'all 0.12s' }}>
                              {label}
                            </button>
                          ))}
                        </div>
                        {/* Кнопка Записать */}
                        <div style={{ display:'flex', gap:8 }}>
                          <button onClick={() => savePlanDayToDiary(i, pickerDate)}
                            style={{ flex:1, padding:'10px', borderRadius:10, border:'none', background:TEA, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', minHeight:'unset' }}>
                            📓 Записать
                          </button>
                          <button onClick={() => setDiaryDatePicker(null)}
                            style={{ padding:'10px 14px', borderRadius:10, border:'none', background:'#e5e7eb', color:'#6b7280', fontSize:13, cursor:'pointer', minHeight:'unset', fontWeight:500 }}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setPickerDate(todayISO); setDiaryDatePicker(i) }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 20, border: `1.5px solid ${TEA}`, background: `${TEA}12`, color: TEA, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }}>
                        📓 Записать в дневник
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Индикатор загрузки */}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#7F77DD,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>🤖</div>
                <div style={{ background: '#f3f4f6', borderRadius: '16px 16px 16px 4px', padding: '12px 16px', display: 'flex', gap: 5, alignItems: 'center' }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{
                      width: 7, height: 7, borderRadius: '50%', background: '#9ca3af',
                      animation: 'ai-bounce 1.2s infinite', animationDelay: `${i * 0.18}s`,
                    }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Поле ввода */}
          <div style={{
            padding: '12px 16px',
            paddingBottom: isMobile ? 'max(12px, calc(env(safe-area-inset-bottom) + 12px))' : '12px',
            borderTop: '1px solid #e5e7eb',
            display: 'flex', gap: 8, flexShrink: 0, background: '#fff',
          }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder={mode === 'workout' ? 'Спроси про вес или упражнение...' : 'Спроси про питание или продукт...'}
              style={{
                flex: 1, padding: '11px 16px', borderRadius: 24,
                border: '1.5px solid #e5e7eb', fontSize: 14,
                outline: 'none', color: '#111', background: '#f9fafb',
                transition: 'border-color 0.15s',
              }}
              onFocus={e => e.target.style.borderColor = PUR}
              onBlur={e => e.target.style.borderColor = '#e5e7eb'}
            />
            <button
              onClick={send}
              disabled={!input.trim() || loading}
              style={{
                width: 44, height: 44, borderRadius: '50%', border: 'none', flexShrink: 0,
                background: (!input.trim() || loading) ? '#e5e7eb' : `linear-gradient(135deg,${PUR},#5b54c4)`,
                color: '#fff', fontSize: 20, cursor: (!input.trim() || loading) ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s', minHeight: 'unset',
              }}>↑</button>
          </div>

          {/* Модалка API ключа */}
          {showKeyModal && (
            <>
              <div onClick={() => setShowKeyModal(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 20 }} />
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: '#fff', borderRadius: '18px 18px 0 0',
                padding: '24px 20px 36px', zIndex: 21,
              }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: '#e5e7eb', margin: '0 auto 20px' }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 6 }}>🔑 Anthropic API ключ</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16, lineHeight: 1.7 }}>
                  Получи ключ на <b style={{ color: '#6b7280' }}>console.anthropic.com → API Keys</b><br />
                  Ключ сохраняется только в твоём браузере.
                </div>
                {apiKey && (
                  <div style={{ fontSize: 12, color: '#22c55e', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    ✓ Ключ уже сохранён
                  </div>
                )}
                <input
                  value={keyDraft}
                  onChange={e => setKeyDraft(e.target.value)}
                  placeholder="sk-ant-api03-..."
                  type="password"
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1.5px solid #e5e7eb', fontSize: 14,
                    boxSizing: 'border-box', color: '#111', outline: 'none', marginBottom: 12,
                  }}
                  onFocus={e => e.target.style.borderColor = PUR}
                  onBlur={e => e.target.style.borderColor = '#e5e7eb'}
                  onKeyDown={e => e.key === 'Enter' && saveKey()}
                />
                <button onClick={saveKey} style={{
                  width: '100%', padding: '13px', borderRadius: 11, border: 'none',
                  background: PUR, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 8,
                }}>Сохранить ключ</button>
                {apiKey && (
                  <button onClick={() => { localStorage.removeItem('fitpro_ai_key'); setApiKey(''); setShowKeyModal(false) }}
                    style={{ width: '100%', padding: '11px', borderRadius: 11, border: '1px solid #fee2e2', background: '#fff5f5', color: '#ef4444', fontSize: 13, cursor: 'pointer' }}>
                    Удалить ключ
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
})

export default AIAssistant
