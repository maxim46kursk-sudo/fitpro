import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'

const PUR = '#7F77DD'

const TEA = '#1D9E75'

const CHAT_KEY = (m) => `fitpro_chat_${m}`
const loadChat  = (m) => { try { return JSON.parse(localStorage.getItem(CHAT_KEY(m)) || '[]') } catch { return [] } }
const saveChat  = (m, msgs) => { try { localStorage.setItem(CHAT_KEY(m), JSON.stringify(msgs)) } catch {} }

const AIAssistant = forwardRef(function AIAssistant({ workoutHistory = [], isMobile = false, nutritionPlans = [] }, ref) {
  const [isOpen, setIsOpen]         = useState(false)
  const [mode, setMode]             = useState('workout')
  const [messages, setMessages]     = useState(() => loadChat('workout'))
  const [input, setInput]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [apiKey, setApiKey]         = useState(() => {
    const envKey = import.meta.env.VITE_ANTHROPIC_KEY || ''
    const validEnv = envKey.startsWith('sk-ant-') ? envKey : ''
    return validEnv || localStorage.getItem('fitpro_ai_key') || ''
  })
  const [keyDraft, setKeyDraft]     = useState('')
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [savedMsgIds, setSavedMsgIds] = useState({})
  const [diaryDatePicker, setDiaryDatePicker] = useState(null) // msgId when picker is open
  const todayISO = (() => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}` })()
  const [pickerDate, setPickerDate] = useState(todayISO)
  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)

  useImperativeHandle(ref, () => ({
    open: (m) => {
      if (m && m !== mode) {
        setMode(m)
        setMessages(loadChat(m))
      }
      setIsOpen(true)
    }
  }))

  // Сохраняем историю чата при каждом изменении сообщений
  useEffect(() => {
    saveChat(mode, messages)
  }, [messages, mode])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 150)
  }, [isOpen])

  // ── Единый динамический системный промпт ─────────────────────────────
  const buildSystemPrompt = (mode) => {
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
    const remKcal = normKcal !== null ? Math.max(0, normKcal - eaten.kcal) : null
    const remP    = normP    !== null ? Math.max(0, normP    - eaten.p)    : null
    const remF    = normF    !== null ? Math.max(0, normF    - eaten.f)    : null
    const remC    = normC    !== null ? Math.max(0, normC    - eaten.c)    : null

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

    return `Ты персональный AI тренер в приложении FitPro.

ДАННЫЕ КЛИЕНТА:
Имя: ${clientName}${clientAge ? `, возраст: ${clientAge} лет` : ''}
Цель: ${clientGoal}
Вес: ${clientWeight}, Рост: ${clientHeight}${clientOccupation ? `\nРод деятельности: ${clientOccupation}` : ''}${topFolder ? `\nПрограмма тренировок: ${topFolder}` : ''}${profile.steps ? `\nШагов в день: ~${profile.steps}` : ''}${profile.gymDays ? `\nТренировок в неделю: ${profile.gymDays}` : ''}

ДНЕВНАЯ НОРМА ПИТАНИЯ (рассчитана по весу клиента):
${normKcal !== null
  ? `${isOverweight ? `Фактический вес: ${weightNum} кг. Идеальная масса тела (рост ${heightNum} − 100): ${idealWeight} кг. Нормы рассчитаны по идеальному весу.` : `Вес: ${weightNum} кг.`}
${isMassGain ? 'Цель: набор массы — углеводы повышены (×5г/кг).' : isCutting ? 'Цель: рельеф — углеводы снижены (×2г/кг).' : ''}
Калории: ${normKcal} ккал
Белки: ${normP}г (${baseWeight}кг × 2г)
Жиры: ${normF}г (${baseWeight}кг × 1г)
Углеводы: ${normC}г (${baseWeight}кг × ${carbMult}г)
Используй эту норму как основу для рациона и рекомендаций.`
  : 'Вес клиента не указан, норму рассчитать невозможно.'}

ПИТАНИЕ СЕГОДНЯ:
Съедено: ${eaten.kcal.toFixed(0)} ккал, Б: ${eaten.p.toFixed(1)}г, У: ${eaten.c.toFixed(1)}г, Ж: ${eaten.f.toFixed(1)}г
${remKcal !== null ? `Осталось до нормы: ${remKcal} ккал, Б: ${remP}г, У: ${remC}г, Ж: ${remF}г` : ''}

ПОСЛЕДНИЕ 5 ТРЕНИРОВОК:
${workoutHistoryText}

${matchedPlan && planDay1Text ? `ГОТОВЫЙ РАЦИОН ДЛЯ КЛИЕНТА (используй эти данные когда предлагаешь рацион):
Название: ${matchedPlan.title}
Цель рациона: ~${matchedPlan.target.cal} ккал/день, Б:${matchedPlan.target.p}г У:${matchedPlan.target.c}г Ж:${matchedPlan.target.f}г
Пример дня 1:
${planDay1Text}
Итого день 1: ${planDay1.total.cal} ккал, Б:${planDay1.total.p}г У:${planDay1.total.c}г Ж:${planDay1.total.f}г` : ''}

${mode === 'workout'
  ? `РЕЖИМ: Тренировки
Не меняй программу. Рекомендуй веса на следующий подход по истории клиента.
Прогрессия: выполнил все подходы чисто — плюс 2.5 кг. Не выполнил — тот же вес или минус 2.5 кг.
Называй конкретно: упражнение и вес.`
  : `РЕЖИМ: Питание
Когда клиент просит помочь с рационом — отвечай строго в таком порядке:

1. Объясни логику рациона. ${isOverweight
  ? `ВАЖНО: у клиента значительный лишний вес (вес ${weightNum} кг при росте ${heightNum} см). Объясни это очень мягко и тактично, без осуждения, примерно так: "При значительном лишнем весе принято рассчитывать нормы питания от целевой — идеальной — массы тела. Для твоего роста ${heightNum} см это примерно ${idealWeight} кг (рост − 100). Именно от этой цифры я считаю нормы — так рацион будет работать на снижение веса, а не на его поддержание." Будь деликатен, поддержи клиента.`
  : 'Объясни почему этот рацион подходит клиенту (цель, вес, активность).'}

2. Напиши норму от тренера: "Максим рекомендует тебе: белки — ${normP ?? '?'}г в день, углеводы — ${normC ?? '?'}г в день, жиры — ${normF ?? '?'}г в день. Итого: ${normKcal ?? '?'} ккал в день.${isMassGain ? ' Углеводы повышены для набора мышечной массы.' : isCutting ? ' Углеводы снижены для прорисовки рельефа.' : ''} Эту норму ты можешь занести в свой дневник в разделе Питание — там есть кнопка Норма, чтобы отслеживать макросы каждый день."

3. Напиши: "На основе этого я предлагаю тебе рацион:" и затем:
${matchedPlan && !isMassGain && !isCutting
  ? `   Покажи полный день 1 из готового рациона (раздел ГОТОВЫЙ РАЦИОН выше). После рациона напиши: "Это день 1 из рациона «${matchedPlan.title}» — полный план на 7 дней найдёшь в разделе Питание."`
  : `   ${isMassGain || isCutting ? `Для цели "${isMassGain ? 'набор массы' : 'рельеф'}" составь рацион сам под норму (${normKcal ?? '?'} ккал, Б:${normP ?? '?'}г У:${normC ?? '?'}г Ж:${normF ?? '?'}г).` : `Готового рациона под эти параметры нет — составь рацион сам, ориентируясь на норму (${normKcal ?? '?'} ккал, Б:${normP ?? '?'}г У:${normC ?? '?'}г Ж:${normF ?? '?'}г).`} Используй формат: 5 приёмов пищи (Завтрак, Перекус, Обед, Перекус, Ужин) с указанием времени, конкретных продуктов с граммовкой, калорий и макросов каждого приёма, итого за день. ${isMassGain ? 'Включи больше сложных углеводов: крупы, картофель, хлеб, макароны, бананы.' : isCutting ? 'Акцент на белок и овощи, углеводы минимальны и только утром.' : 'Используй простые продукты: гречка, куриная грудка, рыба, яйца, творог, овощи, фрукты.'} После рациона напиши: "Это индивидуальный рацион, составленный специально под твои данные."`}

4. Добавь: "Если что-то не подходит — скажи что именно, я предложу замену."

Если клиент спрашивает можно ли съесть что-то — считай по остатку на сегодня, отвечай с числами.`}

ЗАПИСЬ В ДНЕВНИК ПИТАНИЯ: Если пользователь просит тебя записать еду, макросы или калории в дневник (например "занеси белков 100г жиров 50г углей 200г", "запиши в дневник", "добавь в дневник") — ты МОЖЕШЬ это сделать напрямую. Подтверди что записываешь, а в самом конце своего ответа добавь ОДИН специальный блок (без пробелов, на отдельной строке):
[DIARY_ENTRY:{"name":"название блюда или Запись из чата","kcal":X,"p":X,"c":X,"f":X}]
Где X — числа из запроса пользователя. Если ккал не указаны — посчитай: ккал = белки×4 + углеводы×4 + жиры×9. Если каких-то макросов нет — ставь 0. Не показывай этот блок пользователю явно, это служебная метка. Записывай на сегодня если дата не уточнена.

Отвечай коротко и конкретно, как тренер. На русском языке.
Отвечай обычным текстом без звёздочек, без двойных звёздочек, без решёток, без тире в начале строк, без markdown разметки вообще. Просто чистый текст как в обычном сообщении.`
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
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: systemPrompt,
          messages: newMsgs.map(m => ({ role: m.role, content: m.content }))
        })
      })
      const data = await res.json()
      if (data.content?.[0]?.text) {
        let rawText = data.content[0].text
        // Парсим маркер записи в дневник
        const diaryMatch = rawText.match(/\[DIARY_ENTRY:(\{[^}]+\})\]/)
        let diaryWritten = false
        if (diaryMatch) {
          try {
            const entry = JSON.parse(diaryMatch[1])
            const date = new Date().toISOString().slice(0, 10)
            const raw = localStorage.getItem('fitpro_food_diary')
            const diary = raw ? JSON.parse(raw) : {}
            diary[date] = [...(diary[date] || []), { id: Date.now(), ...entry }]
            localStorage.setItem('fitpro_food_diary', JSON.stringify(diary))
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            diaryWritten = true
          } catch {}
          rawText = rawText.replace(/\[DIARY_ENTRY:[^\]]+\]/g, '').trim()
        }
        setMessages(prev => [...prev, { role: 'assistant', content: rawText, diaryWritten }])
      } else if (res.status === 401) {
        setMessages(prev => [...prev, { role: 'assistant', content: '❌ API ключ неверный. Нажми 🔑 и введи рабочий ключ.' }])
        setShowKeyModal(true)
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

  // Записать день рациона в дневник на выбранную дату
  const savePlanDayToDiary = (msgId, date) => {
    const plan = getMatchedPlan()
    if (!plan?.days?.[0]) return
    const day = plan.days[0]
    const raw = localStorage.getItem('fitpro_food_diary')
    const diary = raw ? JSON.parse(raw) : {}
    const existing = diary[date] || []
    const newEntries = day.meals.map((meal, i) => ({
      id: Date.now() + i,
      name: `${meal.name}${meal.time ? ' (' + meal.time + ')' : ''}`,
      kcal: String(meal.cal), p: String(meal.p), c: String(meal.c), f: String(meal.f),
      items: meal.items || [],
    }))
    diary[date] = [...existing, ...newEntries]
    localStorage.setItem('fitpro_food_diary', JSON.stringify(diary))
    window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
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
    nutrition: ['Можно шоколадку?', 'Что съесть после тренировки?', 'Сколько белка осталось?'],
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
            {messages.length > 0 && (
              <button onClick={() => { saveChat(mode, []); setMessages([]) }} style={{
                background: 'none', border: '1px solid #e5e7eb', borderRadius: 8,
                padding: '5px 10px', fontSize: 11, color: '#9ca3af', cursor: 'pointer', minHeight: 'unset',
              }} title="Очистить чат">🗑</button>
            )}
            <button onClick={() => setShowKeyModal(true)} style={{
              background: 'none', border: '1px solid #e5e7eb', borderRadius: 8,
              padding: '5px 10px', fontSize: 11, color: '#9ca3af', cursor: 'pointer', minHeight: 'unset',
            }}>🔑</button>
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
                  {mode === 'workout' ? 'AI тренер по вашей программе' : 'AI диетолог'}
                </div>
                <div style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.65, marginBottom: 20 }}>
                  {mode === 'workout'
                    ? 'Знаю вашу историю весов и подберу\nнагрузку на следующую тренировку'
                    : 'Вижу ваш план питания и остаток\nкалорий — спросите что угодно'}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#f0fdf4', border: '1.5px solid #22c55e40' }}>
                      <span style={{ fontSize: 14, color: '#22c55e' }}>✓</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Записано в дневник на сегодня</span>
                    </div>
                  </div>
                )}
                {/* Кнопка «Записать в дневник» — под AI-сообщением с рационом */}
                {m.role === 'assistant' && !m.diaryWritten && mode === 'nutrition' && isDietMessage(m.content) && (
                  <div style={{ paddingLeft: 36 }}>
                    {savedMsgIds[i] ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#f0fdf4', border: '1.5px solid #22c55e40' }}>
                        <span style={{ fontSize: 14, color: '#22c55e' }}>✓</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Записано на {(()=>{const d=new Date(savedMsgIds[i]+'T00:00:00');const t=new Date();const y=new Date(t);y.setDate(y.getDate()-1);const ti=t.toISOString().slice(0,10);const yi=y.toISOString().slice(0,10);return savedMsgIds[i]===ti?'сегодня':savedMsgIds[i]===yi?'вчера':`${d.getDate()}.${String(d.getMonth()+1).padStart(2,'0')}`})()}</span>
                      </div>
                    ) : diaryDatePicker === i ? (
                      <div style={{ background: '#f9fafb', borderRadius: 16, padding: '14px', border: '1px solid #e5e7eb', maxWidth: 300 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 10 }}>Выбери дату:</div>
                        {/* Быстрые кнопки */}
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                          {[['Вчера', (()=>{const y=new Date();y.setDate(y.getDate()-1);return `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,'0')}-${String(y.getDate()).padStart(2,'0')}`})()], ['Сегодня', todayISO], ['Завтра', (()=>{const t=new Date();t.setDate(t.getDate()+1);return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`})()]].map(([label, iso]) => (
                            <button key={iso} onClick={() => setPickerDate(iso)}
                              style={{ flex:1, padding:'7px 4px', borderRadius:10, border:`1.5px solid ${pickerDate===iso?PUR:'#e5e7eb'}`, background: pickerDate===iso?`${PUR}15`:'#fff', color: pickerDate===iso?PUR:'#6b7280', fontSize:12, fontWeight:600, cursor:'pointer', minHeight:'unset' }}>
                              {label}
                            </button>
                          ))}
                        </div>
                        {/* Точная дата */}
                        <input type="date" value={pickerDate} onChange={e => setPickerDate(e.target.value)}
                          max={(() => { const t = new Date(); t.setDate(t.getDate()+7); return t.toISOString().slice(0,10) })()}
                          style={{ width:'100%', padding:'8px 10px', fontSize:13, borderRadius:10, border:`1.5px solid ${PUR}40`, outline:'none', boxSizing:'border-box', color:'#111', background:'#fff', marginBottom:10 }} />
                        <div style={{ display:'flex', gap:8 }}>
                          <button onClick={() => savePlanDayToDiary(i, pickerDate)}
                            style={{ flex:1, padding:'9px', borderRadius:10, border:'none', background:TEA, color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer', minHeight:'unset' }}>
                            📓 Записать
                          </button>
                          <button onClick={() => setDiaryDatePicker(null)}
                            style={{ padding:'9px 14px', borderRadius:10, border:'none', background:'#e5e7eb', color:'#6b7280', fontSize:13, cursor:'pointer', minHeight:'unset' }}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setPickerDate(todayISO); setDiaryDatePicker(i) }}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 20, border: `1.5px solid ${TEA}`, background: `${TEA}12`, color: TEA, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }}>
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
