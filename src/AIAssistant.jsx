import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { supabase } from './supabase'

const PUR = '#7F77DD'

const HINTS = ['Какой рацион мне подойдет?', 'Что съесть после тренировки?', 'Можно ли мне алкоголь?']

const stripMd = (t) => t
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/\*(.*?)\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^[+\-•]\s+/gm, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .trim()

const AIAssistant = forwardRef(function AIAssistant({ isMobile = false }, ref) {
  const [isOpen, setIsOpen]     = useState(false)
  const [mode, setMode]         = useState('nutrition')
  const [messages, setMessages] = useState([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [ctx, setCtx]           = useState(null) // { user, today, diary, goals, profile } — свежак из Supabase
  const [showToast, setShowToast] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)

  useImperativeHandle(ref, () => ({
    open: (m) => {
      if (m && m !== mode) setMode(m)
      setIsOpen(true)
    }
  }))

  const flashToast = () => {
    setShowToast(true)
    setTimeout(() => setShowToast(false), 2000)
  }

  // Свежие данные пользователя из Supabase — только Supabase, никакого localStorage
  const loadContext = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const today = new Date().toISOString().slice(0, 10)
    const [{ data: diary }, { data: goals }, { data: profile }] = await Promise.all([
      supabase.from('food_diary').select('*').eq('user_id', user.id).eq('date', today).order('created_at'),
      supabase.from('food_goals').select('*').eq('user_id', user.id).single(),
      supabase.from('profiles').select('*').eq('id', user.id).single(),
    ])
    return { user, today, diary: diary || [], goals: goals || null, profile: profile || {} }
  }

  // Диагностика — выводит в консоль браузера что реально приходит из Supabase.
  // Открой DevTools → Console, открой AI-ассистент и посмотри вывод USER/PROFILE/DIARY/GOALS.
  const runDiagnostics = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    console.log('USER:', user?.id, user?.email)

    if (!user) { console.log('НЕТ ПОЛЬЗОВАТЕЛЯ'); return }

    const { data: profile, error: pe } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    console.log('PROFILE:', JSON.stringify(profile), 'ERROR:', pe?.message)

    const today = new Date().toISOString().slice(0, 10)
    const { data: diary, error: de } = await supabase.from('food_diary').select('*').eq('user_id', user.id).eq('date', today)
    console.log('DIARY:', JSON.stringify(diary), 'ERROR:', de?.message)

    const { data: goals, error: ge } = await supabase.from('food_goals').select('*').eq('user_id', user.id).single()
    console.log('GOALS:', JSON.stringify(goals), 'ERROR:', ge?.message)
  }

  // При открытии чата — диагностика в консоль + подтягиваем актуальные данные для промпта
  useEffect(() => {
    if (!isOpen) return
    runDiagnostics()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || mode !== 'nutrition') return
    loadContext().then(c => c && setCtx(c))
  }, [isOpen, mode])

  // История чата по питанию — из Supabase
  useEffect(() => {
    if (!isOpen || mode !== 'nutrition') return
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data } = await supabase.from('chat_messages').select('*')
        .eq('user_id', user.id).eq('mode', 'nutrition').order('created_at')
      if (!cancelled && data) setMessages(data.map(m => ({ role: m.role, content: m.content })))
    })()
    return () => { cancelled = true }
  }, [isOpen, mode])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (isOpen && mode === 'nutrition') setTimeout(() => inputRef.current?.focus(), 150)
  }, [isOpen, mode])

  const ACTIVITY_LABELS = { sedentary: 'малоподвижный', moderate: 'умеренный', high: 'высокий' }

  // Возраст на сегодняшнюю дату из birthdate (YYYY-MM-DD)
  const calcAge = (birthdate) => {
    if (!birthdate) return null
    const b = new Date(birthdate)
    if (isNaN(b)) return null
    const now = new Date()
    let age = now.getFullYear() - b.getFullYear()
    const beforeBirthday = now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())
    if (beforeBirthday) age--
    return age
  }

  const PER_KG_BY_GOAL = {
    'Похудение':   { p: 2, c: 3, f: 1 },
    'Рельеф':      { p: 2, c: 2, f: 1 },
    'Набор массы': { p: 2, c: 5, f: 1 },
    'Поддержание': { p: 2, c: 3, f: 1 },
  }

  // Методика тренера: расчёт нормы КБЖУ от роста/веса/пола/цели (см. буквальные шаги в системном промпте)
  const calcMacroGoals = ({ height, weight, gender, goal }) => {
    const h = Number(height), w = Number(weight)
    if (!h || !w) return null
    const lastTwo = h % 100
    const leanMass = gender === 'female' ? h - 110 : h - 100
    const baseWeight = w > lastTwo ? leanMass : w
    const perKg = PER_KG_BY_GOAL[goal] || PER_KG_BY_GOAL['Поддержание']
    const p = Math.round(baseWeight * perKg.p)
    const c = Math.round(baseWeight * perKg.c)
    const f = Math.round(baseWeight * perKg.f)
    const kcal = p * 4 + c * 4 + f * 9
    return { baseWeight, p, c, f, kcal }
  }

  const buildSystemPrompt = ({ profile, goals, diary, today }) => {
    const eaten = diary.reduce((s, e) => s + (+e.kcal || 0), 0)
    const left = (goals?.kcal || 0) - eaten
    const diaryText = diary.length
      ? diary.map(e => `[id:${e.id}] ${e.name} — ${e.kcal}ккал Б:${e.p}г У:${e.c}г Ж:${e.f}г`).join('\n')
      : 'пусто'
    const age = calcAge(profile.birthdate)
    const macroGoals = calcMacroGoals(profile)

    return `Ты AI помощник по питанию в приложении FitPro тренера Максима.

Данные клиента:
Имя: ${profile.name || 'не указано'}
Возраст: ${age ?? 'не указан'}
Пол: ${profile.gender === 'female' ? 'женский' : profile.gender === 'male' ? 'мужской' : 'не указан (считать мужским)'}
Цель: ${profile.goal || 'не указана'}
Вес: ${profile.weight || '?'}кг, Рост: ${profile.height || '?'}см
Уровень активности: ${ACTIVITY_LABELS[profile.activity_level] || 'не указан'}
Норма: ${goals?.kcal || 'не задана'} ккал, Б:${goals?.p || 0}г У:${goals?.c || 0}г Ж:${goals?.f || 0}г

Дневник сегодня (${today}):
${diaryText}

Съедено: ${eaten} ккал
Осталось: ${left} ккал

МЕТОДИКА РАСЧЁТА НОРМЫ КБЖУ — используй СТРОГО эту формулу, никогда не считай по другим методикам (Миффлина, TDEE и т.п.) и не придумывай свои цифры:
Шаг 1 — базовый вес:
  - Последние две цифры роста (рост 185 → 85, рост 160 → 60)
  - Если реальный вес БОЛЬШЕ этого числа: базовый вес = сухая масса (мужчина: рост−100, женщина: рост−110)
  - Если реальный вес МЕНЬШЕ или РАВЕН этому числу: базовый вес = реальный вес
  - Пол берётся из поля gender; если не указан — считать мужским
Шаг 2 — граммы на 1 кг базового веса по цели:
  - Похудение: Б2/У3/Ж1 · Рельеф: Б2/У2/Ж1 · Набор массы: Б2/У5/Ж1 · Поддержание: Б2/У3/Ж1
Шаг 3 — калории = Б×4 + У×4 + Ж×9

${macroGoals
  ? `Расчёт по этой методике для текущего клиента (базовый вес ${macroGoals.baseWeight}кг): ${macroGoals.kcal} ккал, Б:${macroGoals.p}г У:${macroGoals.c}г Ж:${macroGoals.f}г. Если задаёшь/пересчитываешь норму — используй маркер GOAL ИМЕННО с этими числами, не меняя их.`
  : 'Рассчитать норму нельзя — в профиле не заполнены рост и/или вес. Попроси клиента заполнить профиль, прежде чем называть любые цифры по КБЖУ.'}

ПРАВИЛА:
1. Отвечай кратко и по делу, без markdown и звёздочек
2. Если профиль не заполнен — попроси заполнить его
3. Темы кроме питания не обсуждай
4. Раз в 5 сообщений упоминай что Максим ведёт персональные тренировки
5. Любые цифры нормы КБЖУ — только из расчёта по методике выше, никогда не оценивай на глаз

ДЕЙСТВИЯ — добавляй маркер в конце ответа на новой строке:
Записать еду: [ADD:{"name":"Завтрак: овсянка 90г, яйца 2шт","kcal":420,"p":25,"c":45,"f":12}]
Удалить запись: [DEL:{"id":123}]
Задать норму: [GOAL:{"kcal":2000,"p":150,"c":200,"f":60}]`
  }

  const send = async () => {
    if (!input.trim() || loading || mode !== 'nutrition') return

    const userMsg = { role: 'user', content: input.trim() }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setInput('')
    setLoading(true)

    try {
      // Перед каждым запросом перезагружаем данные — единственный источник правды
      const fresh = await loadContext()
      if (!fresh) throw new Error('Не удалось определить пользователя')
      setCtx(fresh)

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: buildSystemPrompt(fresh),
          messages: newMsgs.map(m => ({ role: m.role, content: m.content })),
        }),
      })
      const data = await res.json()
      if (!data.content?.[0]?.text) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка: ${data.error?.message || 'что-то пошло не так'}` }])
        return
      }

      let text = stripMd(data.content[0].text)
      let added = false

      // ADD — может быть несколько приёмов пищи за раз, каждый в своём маркере
      const addMatches = [...text.matchAll(/\[ADD:(\{[^}]+\})\]/g)]
      if (addMatches.length) {
        for (const m of addMatches) {
          try {
            const entry = JSON.parse(m[1])
            const { error } = await supabase.from('food_diary').insert({
              user_id: fresh.user.id, date: fresh.today,
              name: entry.name, kcal: +entry.kcal || 0,
              p: +entry.p || 0, c: +entry.c || 0, f: +entry.f || 0,
            })
            if (error) console.error('Ошибка записи в дневник:', error)
            else added = true
          } catch (e) { console.error('Ошибка разбора ADD:', e) }
        }
        text = text.replace(/\[ADD:[^\]]+\]/g, '')
        if (added) {
          window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
          flashToast()
          const refreshed = await loadContext()
          if (refreshed) setCtx(refreshed)
        }
      }

      // DEL
      const delMatch = text.match(/\[DEL:(\{[^}]+\})\]/)
      if (delMatch) {
        try {
          const { id } = JSON.parse(delMatch[1])
          const { error } = await supabase.from('food_diary').delete().eq('id', id).eq('user_id', fresh.user.id)
          if (error) console.error('Ошибка удаления записи:', error)
          window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
          const refreshed = await loadContext()
          if (refreshed) setCtx(refreshed)
        } catch (e) { console.error('Ошибка разбора DEL:', e) }
        text = text.replace(/\[DEL:[^\]]+\]/g, '')
      }

      // GOAL
      const goalMatch = text.match(/\[GOAL:(\{[^}]+\})\]/)
      if (goalMatch) {
        try {
          const goal = JSON.parse(goalMatch[1])
          const { error } = await supabase.from('food_goals').upsert({
            user_id: fresh.user.id,
            kcal: +goal.kcal || 0, p: +goal.p || 0, c: +goal.c || 0, f: +goal.f || 0,
            updated_at: new Date().toISOString(),
          })
          if (error) console.error('Ошибка обновления нормы:', error)
          window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
        } catch (e) { console.error('Ошибка разбора GOAL:', e) }
        text = text.replace(/\[GOAL:[^\]]+\]/g, '')
      }

      // Компактный вывод — без пустых строк после вырезания маркеров
      text = text.replace(/\n{2,}/g, '\n').trim()

      setMessages(prev => [...prev, { role: 'assistant', content: text, added }])

      await supabase.from('chat_messages').insert([
        { user_id: fresh.user.id, mode: 'nutrition', role: 'user', content: userMsg.content },
        { user_id: fresh.user.id, mode: 'nutrition', role: 'assistant', content: text },
      ])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка: ${err.message}` }])
    } finally {
      setLoading(false)
    }
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

          {/* Тост об успешной записи */}
          {showToast && (
            <div style={{
              position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
              zIndex: 1200, padding: '10px 18px', borderRadius: 24,
              background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 700,
              boxShadow: '0 6px 20px rgba(22,163,74,0.35)',
            }}>
              Записано ✓
            </div>
          )}

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
          </div>

          {/* Переключатель режима */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 8, flexShrink: 0, background: '#fafafa' }}>
            {[{ id: 'workout', label: '🏋️ Тренировки' }, { id: 'nutrition', label: '🥗 Питание' }].map(m => (
              <button key={m.id} onClick={() => setMode(m.id)}
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

          {/* Режим тренировок — пока заглушка */}
          {mode === 'workout' ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: 42, marginBottom: 12 }}>🚧</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 6 }}>Скоро здесь появится AI-тренер</div>
                <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>Пока помогаю только с питанием</div>
                <button onClick={() => setMode('nutrition')} style={{
                  padding: '10px 20px', borderRadius: 20, border: 'none',
                  background: PUR, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>
                  Перейти к питанию
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Сообщения */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Заглушка если нет сообщений */}
                {messages.length === 0 && (
                  <div style={{ textAlign: 'center', marginTop: 24 }}>
                    <div style={{ fontSize: 42, marginBottom: 12 }}>🥗</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 6 }}>
                      {ctx?.profile?.name ? `Привет, ${ctx.profile.name.split(' ')[0]}! 🥗` : 'AI диетолог'}
                    </div>
                    <div style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.65, marginBottom: 20 }}>
                      Вижу твой дневник и норму —{'\n'}спрашивай что угодно
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                      {HINTS.map((h, i) => (
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
                    {/* Плашка «Записано в дневник» под ответом с ADD-маркером */}
                    {m.role === 'assistant' && m.added && (
                      <div style={{ paddingLeft: 36 }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: '#f0fdf4', border: '1.5px solid #22c55e40' }}>
                          <span style={{ fontSize: 14, color: '#22c55e' }}>✓</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Записано в дневник ✓</span>
                        </div>
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
                  placeholder="Спроси про питание или продукт..."
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
            </>
          )}
        </div>
      )}
    </>
  )
})

export default AIAssistant
