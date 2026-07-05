import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { supabase } from './supabase'
import { buildSystemPrompt } from './aiPrompt'

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

  // Свежие данные пользователя из Supabase — только Supabase, никакого localStorage.
  // Дневник грузим за последние 30 дней (не только сегодня), чтобы AI видел полную
  // картину питания и мог работать с любой датой, а не только с сегодняшней.
  const loadContext = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const today = new Date().toISOString().slice(0, 10)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const [{ data: diary }, { data: goals }, { data: profile }] = await Promise.all([
      supabase.from('food_diary').select('*').eq('user_id', user.id).gte('date', since).order('date', { ascending: false }).order('created_at'),
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

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const { data: diary, error: de } = await supabase.from('food_diary').select('*').eq('user_id', user.id).gte('date', since).order('date', { ascending: false })
    console.log('DIARY (30 дней):', JSON.stringify(diary), 'ERROR:', de?.message)

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
              user_id: fresh.user.id, date: entry.date || fresh.today,
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

      // DEL — может быть несколько записей за раз (после подтверждения массового удаления)
      const delMatches = [...text.matchAll(/\[DEL:(\{[^}]+\})\]/g)]
      if (delMatches.length) {
        let deleted = false
        for (const m of delMatches) {
          try {
            const del = JSON.parse(m[1])
            const { error } = await supabase.from('food_diary').delete()
              .eq('id', del.id).eq('user_id', fresh.user.id).eq('date', del.date || fresh.today)
            if (error) console.error('Ошибка удаления записи:', error)
            else deleted = true
          } catch (e) { console.error('Ошибка разбора DEL:', e) }
        }
        text = text.replace(/\[DEL:[^\]]+\]/g, '')
        if (deleted) {
          window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
          const refreshed = await loadContext()
          if (refreshed) setCtx(refreshed)
        }
      }

      // CLEAR — полная очистка дневника за дату, может быть несколько маркеров сразу
      // (несколько дат за раз) — только после подтверждения клиентом словом "да"
      const clearMatches = [...text.matchAll(/\[CLEAR:(\{[^}]+\})\]/g)]
      if (clearMatches.length) {
        let cleared = false
        for (const m of clearMatches) {
          try {
            const clear = JSON.parse(m[1])
            const { error } = await supabase.from('food_diary').delete()
              .eq('user_id', fresh.user.id).eq('date', clear.date || fresh.today)
            if (error) console.error('Ошибка очистки дневника:', error)
            else cleared = true
          } catch (e) { console.error('Ошибка разбора CLEAR:', e) }
        }
        text = text.replace(/\[CLEAR:[^\]]+\]/g, '')
        if (cleared) {
          window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
          const refreshed = await loadContext()
          if (refreshed) setCtx(refreshed)
        }
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

      // Компактный вывод — без пустых/пробельных строк после вырезания маркеров
      text = text.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()

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
