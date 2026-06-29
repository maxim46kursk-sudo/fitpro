import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'

const PUR = '#7F77DD'

const AIAssistant = forwardRef(function AIAssistant({ workoutHistory = [], isMobile = false }, ref) {
  const [isOpen, setIsOpen]         = useState(false)
  const [mode, setMode]             = useState('workout')
  const [messages, setMessages]     = useState([])
  const [input, setInput]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [apiKey, setApiKey]         = useState(() => import.meta.env.VITE_ANTHROPIC_KEY || localStorage.getItem('fitpro_ai_key') || '')
  const [keyDraft, setKeyDraft]     = useState('')
  const [showKeyModal, setShowKeyModal] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)

  useImperativeHandle(ref, () => ({
    open: (m) => { if (m) setMode(m); setIsOpen(true) }
  }))

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 150)
  }, [isOpen])

  // ── Системный промпт: тренировки ──────────────────────────────────────
  const buildWorkoutPrompt = () => {
    const recent = [...workoutHistory]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 8)
      .reverse()

    const exMap = {}
    recent.forEach(w => {
      const date = new Date(w.date).toLocaleDateString('ru', { day: 'numeric', month: 'short' }).replace('.', '')
      ;(w.exercises || []).forEach(ex => {
        const sets = (ex.sets || []).filter(s => s.kg || s.reps)
        if (!sets.length) return
        if (!exMap[ex.n]) exMap[ex.n] = []
        exMap[ex.n].push({ date, sets: sets.map(s => `${s.kg || 0}кг×${s.reps || 0}`).join(', ') })
      })
    })

    const historyText = Object.entries(exMap)
      .map(([n, s]) => `${n}:\n${s.map(r => `  ${r.date}: ${r.sets}`).join('\n')}`)
      .join('\n\n')

    return `Ты персональный AI тренер. История весов клиента за последние тренировки:\n\n${historyText || 'История тренировок пока пуста — отвечай на общие вопросы по тренировкам.'}\n\nТвоя задача — рекомендовать веса на следующую тренировку исходя из истории клиента. Принцип прогрессии: добавляй 2.5 кг когда клиент выполнил все подходы чисто. Если не выполнил — оставь тот же вес или снизь на 2.5 кг. Отвечай конкретно и коротко, как тренер. Общайся на русском.`
  }

  // ── Системный промпт: питание ─────────────────────────────────────────
  const buildNutritionPrompt = () => {
    const goals = (() => { try { return JSON.parse(localStorage.getItem('fitpro_food_goals') || 'null') } catch { return null } })()
      || { kcal: 2000, p: 150, f: 60, c: 200 }

    const diary = (() => { try { return JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}') } catch { return {} } })()
    const today = new Date().toISOString().slice(0, 10)
    const entries = diary[today] || []
    const eaten = entries.reduce((a, e) => ({
      kcal: a.kcal + (+e.kcal || 0), p: a.p + (+e.p || 0),
      f: a.f + (+e.f || 0), c: a.c + (+e.c || 0)
    }), { kcal: 0, p: 0, f: 0, c: 0 })

    const rem = k => Math.max(0, (goals[k] || 0) - eaten[k]).toFixed(k === 'kcal' ? 0 : 1)

    return `Ты диетолог.

План питания клиента на день:
- Калории: ${goals.kcal} ккал
- Белки: ${goals.p}г | Жиры: ${goals.f}г | Углеводы: ${goals.c}г

Съедено сегодня:
- Калории: ${eaten.kcal.toFixed(0)} ккал
- Белки: ${eaten.p.toFixed(1)}г | Жиры: ${eaten.f.toFixed(1)}г | Углеводы: ${eaten.c.toFixed(1)}г

Осталось:
- Калории: ${rem('kcal')} ккал
- Белки: ${rem('p')}г | Жиры: ${rem('f')}г | Углеводы: ${rem('c')}г

Отвечай строго в рамках плана клиента. Если спрашивают можно ли что-то съесть — посчитай впишется ли в оставшиеся калории и макросы. Отвечай конкретно, с числами. Общайся на русском.`
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

    const systemPrompt = mode === 'workout' ? buildWorkoutPrompt() : buildNutritionPrompt()

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
        setMessages(prev => [...prev, { role: 'assistant', content: data.content[0].text }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка: ${data.error?.message || 'Что-то пошло не так'}` }])
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Нет соединения. Проверь интернет и API ключ.' }])
    } finally {
      setLoading(false)
    }
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
        }}>✨</button>
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
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#7F77DD,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>✨</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111', lineHeight: 1.2 }}>AI Ассистент</div>
              <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 500 }}>● онлайн</div>
            </div>
            <button onClick={() => setShowKeyModal(true)} style={{
              background: 'none', border: '1px solid #e5e7eb', borderRadius: 8,
              padding: '5px 10px', fontSize: 11, color: '#9ca3af', cursor: 'pointer', minHeight: 'unset',
            }}>🔑</button>
          </div>

          {/* Переключатель режима */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 8, flexShrink: 0, background: '#fafafa' }}>
            {[{ id: 'workout', label: '🏋️ Тренировки' }, { id: 'nutrition', label: '🥗 Питание' }].map(m => (
              <button key={m.id} onClick={() => { setMode(m.id); setMessages([]) }}
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
                <div style={{ fontSize: 42, marginBottom: 12 }}>✨</div>
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
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                {m.role === 'assistant' && (
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#7F77DD,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, marginRight: 8, flexShrink: 0, alignSelf: 'flex-end', marginBottom: 2 }}>✨</div>
                )}
                <div style={{
                  maxWidth: '78%', padding: '10px 14px',
                  borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: m.role === 'user' ? PUR : '#f3f4f6',
                  color: m.role === 'user' ? '#fff' : '#111',
                  fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap',
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {/* Индикатор загрузки */}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#7F77DD,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>✨</div>
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
