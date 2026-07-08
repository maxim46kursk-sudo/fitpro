import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { supabase } from './supabase'
import { buildSystemPrompt } from './aiPrompt'
import { buildWorkoutSystemPrompt } from './workoutPrompt'
import { PROGRAMS_MAP, EXERCISES } from './programs'
import TrainingSurvey from './TrainingSurvey'

const PUR = '#7F77DD'
// Та же ссылка, что и кнопка "Написать тренеру" в Настройках → Поддержка (App.jsx) —
// один и тот же контакт Максима в Telegram, не заводим вторую ссылку.
const MAX_TELEGRAM_URL = 'https://t.me/maxim_athlete'

const HINTS = ['Какой рацион мне подойдет?', 'Что съесть после тренировки?', 'Можно ли мне алкоголь?']
const HINTS_WORKOUT = ['Жим 50кг на 8 было легко, какой вес дальше?', 'Что у меня растёт, а что стоит на месте?', 'Побаливает плечо на жиме, что делать?']

const stripMd = (t) => t
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/\*(.*?)\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^[+\-•]\s+/gm, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .trim()

const AIAssistant = forwardRef(function AIAssistant({ isMobile = false, onWorkoutComplete, onGoToWorkoutsDiary, onGoToFoodDiary }, ref) {
  const [isOpen, setIsOpen]     = useState(false)
  const [mode, setMode]         = useState('nutrition')
  const [messages, setMessages] = useState([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [ctx, setCtx]           = useState(null) // { user, today, diary, goals, profile } — свежак из Supabase
  const [showToast, setShowToast] = useState(false)
  const [showSurvey, setShowSurvey] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [attachedImage, setAttachedImage] = useState(null) // { dataUrl, mediaType, base64 } — фото питания перед отправкой (режим "Питание")
  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)
  const imageInputRef  = useRef(null)

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  const handleImageSelect = (e) => {
    const file = e.target.files[0]
    e.target.value = '' // сброс, чтобы можно было выбрать тот же файл повторно
    if (!file) return
    if (!file.type.startsWith('image/')) return
    if (file.size > MAX_IMAGE_BYTES) {
      alert('Фото слишком большое (максимум 5 МБ) — попробуй сделать скриншот меньше.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(reader.result || '')
      if (!match) return
      setAttachedImage({ dataUrl: reader.result, mediaType: match[1], base64: match[2] })
    }
    reader.readAsDataURL(file)
  }

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

  // Очистка истории чата — только для текущего режима (питание/тренировки
  // чистятся раздельно, у каждого своя строка mode в chat_messages).
  const clearChatHistory = async () => {
    if (clearing) return
    setClearing(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { error } = await supabase.from('chat_messages').delete().eq('user_id', user.id).eq('mode', mode)
      if (error) console.error('Ошибка очистки истории чата:', error)
    }
    setMessages([])
    setClearing(false)
    setShowClearConfirm(false)
  }

  // Свежие данные пользователя из Supabase — только Supabase, никакого localStorage.
  // Дневник питания грузим за 30 дней. Тренировки — за 90 дней: волновой цикл
  // тренера Максима (см. workoutPrompt.js) крутится по нескольким полным
  // циклам Объём/Развитие/Сила, 30 дней их не покрывают.
  const loadContext = async (m) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const today = new Date().toISOString().slice(0, 10)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    if (m === 'workout') {
      const workoutSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const [{ data: sets }, { data: profile }, { data: survey }] = await Promise.all([
        supabase.from('workout_sets').select('*').eq('user_id', user.id).gte('date', workoutSince).order('date'),
        supabase.from('profiles').select('*').eq('id', user.id).single(),
        supabase.from('training_survey').select('*').eq('user_id', user.id).single(),
      ])
      return { user, today, sets: sets || [], profile: profile || {}, survey: survey || null }
    }

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
    if (!isOpen) return
    loadContext(mode).then(c => c && setCtx(c))
  }, [isOpen, mode])

  // История чата — своя ветка на каждый режим, из Supabase
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data } = await supabase.from('chat_messages').select('*')
        .eq('user_id', user.id).eq('mode', mode).order('created_at')
      if (!cancelled && data) setMessages(data.map(m => ({ role: m.role, content: m.content })))
    })()
    return () => { cancelled = true }
  }, [isOpen, mode])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 150)
  }, [isOpen, mode])

  useEffect(() => { setShowClearConfirm(false); setAttachedImage(null) }, [mode, isOpen])

  const send = async () => {
    const hasImage = mode === 'nutrition' && !!attachedImage
    if ((!input.trim() && !hasImage) || loading) return

    const sentImage = attachedImage
    const userMsg = { role: 'user', content: input.trim(), image: hasImage ? sentImage.dataUrl : undefined }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setInput('')
    setAttachedImage(null)
    setLoading(true)

    // Таймаут на ответ — без него зависший /api/chat (долгий ответ Anthropic,
    // упавшая serverless-функция без ответа и т.п.) оставлял чат в "зависшем"
    // состоянии навсегда: спиннер крутится, а промис фетча никогда не
    // резолвится и не реджектится сам по себе.
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => abortController.abort(), 45000)

    try {
      // Перед каждым запросом перезагружаем данные — единственный источник правды
      const fresh = await loadContext(mode)
      if (!fresh) throw new Error('Не удалось определить пользователя')
      setCtx(fresh)

      const system = mode === 'workout'
        ? buildWorkoutSystemPrompt({
            profile: fresh.profile,
            programTemplate: PROGRAMS_MAP[fresh.profile.program] || null,
            sets: fresh.sets,
            survey: fresh.survey,
            today: fresh.today,
          })
        : buildSystemPrompt(fresh)

      const res = await fetch('/api/chat', {
        signal: abortController.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          // Тренировочный режим может выдавать SET_PROGRAM — до 6 упражнений по 4
          // подхода в одном маркере, плюс текст ответа; 1000 токенов (хватает для
          // обычных реплик и для питания) для этого тесно и рискует обрезать маркер.
          max_tokens: mode === 'workout' ? 2000 : 1000,
          system,
          // Последнее сообщение, если к нему приложено фото, уходит в Anthropic
          // мультимодальным content-массивом (image + text); вся остальная
          // история — как обычно, плоской строкой. api/chat — чистый прокси,
          // прогоняет body как есть, поэтому это не требует правок на бэкенде.
          messages: newMsgs.map((m, i) => {
            if (hasImage && i === newMsgs.length - 1) {
              const blocks = [{ type: 'image', source: { type: 'base64', media_type: sentImage.mediaType, data: sentImage.base64 } }]
              if (m.content) blocks.push({ type: 'text', text: m.content })
              return { role: m.role, content: blocks }
            }
            return { role: m.role, content: m.content }
          }),
        }),
      })
      const data = await res.json()
      if (!data.content?.[0]?.text) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка: ${data.error?.message || 'что-то пошло не так'}` }])
        return
      }

      let text = stripMd(data.content[0].text)
      let added = false
      let suggestSurvey = false
      let programSet = false
      let contactMax = false

      if (mode === 'workout') {
        // ADD_SET — может быть несколько подходов за раз
        const addSetMatches = [...text.matchAll(/\[ADD_SET:(\{[^}]+\})\]/g)]
        if (addSetMatches.length) {
          for (const m of addSetMatches) {
            try {
              const entry = JSON.parse(m[1])
              const { error } = await supabase.from('workout_sets').insert({
                user_id: fresh.user.id, exercise: entry.exercise, date: entry.date || fresh.today,
                kg: entry.kg != null ? Number(entry.kg) : null,
                reps: entry.reps != null ? Number(entry.reps) : null,
                rating: entry.rating != null ? Number(entry.rating) : null,
              })
              if (error) console.error('Ошибка записи подхода:', error)
              else added = true
            } catch (e) { console.error('Ошибка разбора ADD_SET:', e) }
          }
          text = text.replace(/\[ADD_SET:[^\]]+\]/g, '')
        }

        // DEL_SET — может быть несколько записей за раз
        const delSetMatches = [...text.matchAll(/\[DEL_SET:(\{[^}]+\})\]/g)]
        if (delSetMatches.length) {
          for (const m of delSetMatches) {
            try {
              const del = JSON.parse(m[1])
              const { error, count } = await supabase.from('workout_sets').delete({ count: 'exact' })
                .eq('id', del.id).eq('user_id', fresh.user.id)
              if (error) console.error('Ошибка удаления подхода:', error)
              else if (!count) console.warn(`DEL_SET: id:${del.id} не найден в workout_sets — AI сообщил об удалении записи, которой не существовало`)
            } catch (e) { console.error('Ошибка разбора DEL_SET:', e) }
          }
          text = text.replace(/\[DEL_SET:[^\]]+\]/g, '')
        }

        // EDIT_SET — может быть несколько корректировок за раз
        const editSetMatches = [...text.matchAll(/\[EDIT_SET:(\{[^}]+\})\]/g)]
        if (editSetMatches.length) {
          for (const m of editSetMatches) {
            try {
              const edit = JSON.parse(m[1])
              const patch = {}
              if (edit.kg != null) patch.kg = Number(edit.kg)
              if (edit.reps != null) patch.reps = Number(edit.reps)
              if (edit.rating != null) patch.rating = Number(edit.rating)
              const { error } = await supabase.from('workout_sets').update(patch)
                .eq('id', edit.id).eq('user_id', fresh.user.id)
              if (error) console.error('Ошибка изменения подхода:', error)
            } catch (e) { console.error('Ошибка разбора EDIT_SET:', e) }
          }
          text = text.replace(/\[EDIT_SET:[^\]]+\]/g, '')
        }

        // SET_PROGRAM — составленная AI программа (несколько сессий/упражнений/подходов).
        // Вложенный JSON не укладывается в плоский шаблон {[^}]+} остальных маркеров,
        // поэтому границы ищем по индексу открывающей метки и последней "]" в ответе
        // (маркер всегда ставится в конце, см. workoutPrompt.js).
        // Каждая сессия становится полноценной записью в дневнике тренировок — тем
        // же путём, что и обычная выполненная тренировка (onWorkoutComplete),
        // поэтому она сразу видна в "Мои тренировки" и синхронизируется в
        // workout_sets с проставленным recommended_kg. Кнопка "Перейти к
        // тренировке" в чате должна появляться, только если это реально
        // получилось — отсюда флаг programSet выставляется только когда
        // хотя бы одна сессия успешно превратилась в запись.
        const spIdx = text.indexOf('[SET_PROGRAM:')
        if (spIdx !== -1) {
          const jsonStart = spIdx + '[SET_PROGRAM:'.length
          const jsonEnd = text.lastIndexOf(']')
          if (jsonEnd > jsonStart) {
            try {
              const program = JSON.parse(text.slice(jsonStart, jsonEnd))
              // Защита от дублей: если на эту дату уже лежит запланированная
              // (ещё не выполненная — kg пуст, recommended_kg заполнен) программа,
              // не создаём вторую, даже если модель по ошибке прислала SET_PROGRAM
              // повторно (см. buildPlannedProgramSection в workoutPrompt.js — сама
              // модель тоже должна это видеть и не пересоставлять, но код подстраховывает).
              const plannedDates = new Set(
                (fresh.sets || []).filter(s => s.kg == null && s.recommended_kg != null).map(s => s.date)
              )
              let createdCount = 0
              for (const session of program.sessions || []) {
                const date = session.date || fresh.today
                if (plannedDates.has(date)) {
                  console.warn(`SET_PROGRAM: на ${date} уже есть запланированная тренировка — пропускаю дубль`)
                  continue
                }
                const exercises = (session.exercises || [])
                  .filter(ex => ex.exercise && ex.sets?.length)
                  .map(ex => {
                    const meta = EXERCISES.find(e => e.n === ex.exercise)
                    return {
                      n: ex.exercise, m: meta?.m || '', eq: meta?.eq || '',
                      sets: ex.sets.map(s => ({
                        kg: '', reps: s.reps != null ? String(s.reps) : '',
                        recKg: s.recKg != null ? String(s.recKg) : '',
                      })),
                      done: false,
                    }
                  })
                if (!exercises.length) continue
                const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('ru', { day: 'numeric', month: 'long' })
                onWorkoutComplete?.({
                  name: `Тренировка от AI-ассистента, ${dateLabel}`,
                  color: PUR, exercises, duration: null,
                  date: new Date(date + 'T12:00:00').toISOString(), comment: '',
                })
                createdCount++
                plannedDates.add(date)
              }
              if (createdCount) programSet = true
            } catch (e) { console.error('Ошибка разбора SET_PROGRAM:', e) }
            text = text.slice(0, spIdx) + text.slice(jsonEnd + 1)
          }
        }

        if (addSetMatches.length || delSetMatches.length || editSetMatches.length) {
          if (added) flashToast()
          const refreshed = await loadContext(mode)
          if (refreshed) setCtx(refreshed)
        }

        // SUGGEST_SURVEY — AI предлагает заполнить анкету перед составлением программы
        suggestSurvey = /\[SUGGEST_SURVEY\]/.test(text)
        if (suggestSurvey) text = text.replace(/\[SUGGEST_SURVEY\]/g, '')

        // CONTACT_MAX — AI ответил на вопрос-миф и предлагает написать Максиму за подробностями
        contactMax = /\[CONTACT_MAX\]/.test(text)
        if (contactMax) text = text.replace(/\[CONTACT_MAX\]/g, '')
      } else {
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
            const refreshed = await loadContext(mode)
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
            const refreshed = await loadContext(mode)
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
            const refreshed = await loadContext(mode)
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
      }

      // Компактный вывод — без пустых/пробельных строк после вырезания маркеров
      text = text.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()

      setMessages(prev => [...prev, { role: 'assistant', content: text, added, suggestSurvey, programSet, contactMax }])

      await supabase.from('chat_messages').insert([
        // Фото не сохраняем как base64 в текстовое поле — только пометку, что оно было.
        { user_id: fresh.user.id, mode, role: 'user', content: hasImage ? `[фото]${userMsg.content ? ' ' + userMsg.content : ''}` : userMsg.content },
        { user_id: fresh.user.id, mode, role: 'assistant', content: text },
      ])
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Не дождались ответа (слишком долго) — попробуй ещё раз' : err.message
      setMessages(prev => [...prev, { role: 'assistant', content: `Ошибка: ${message}` }])
    } finally {
      clearTimeout(timeoutId)
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

      {/* Плавающая кнопка — z-index должен быть выше ЛЮБОГО полноэкранного
          "текущего экрана" (подразделы Дневника и т.п. используют 1000-1001,
          Мои данные 1050, Настройки 1060), иначе они перекрывают клик по
          кнопке своей fixed-inset:0 областью. При этом ниже диалогов поверх
          всего — чат (1050, но кнопка и чат никогда не показаны одновременно),
          шторка профиля (1100), тосты/модалки (1200+), анкета (1300). */}
      {!isOpen && (
        <button onClick={() => setIsOpen(true)} style={{
          position: 'fixed', bottom: BTN_BOTTOM, right: 18, zIndex: 1070,
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
            {mode === 'workout' && (
              <button onClick={() => setShowSurvey(true)} title="Заполнить анкету"
                style={{
                  width: 34, height: 34, borderRadius: 10, border: '1px solid #e5e7eb', background: '#f9fafb',
                  fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, minHeight: 'unset',
                }}>📋</button>
            )}
            {/* Постоянная кнопка в дневник — всегда видна, не только после SET_PROGRAM/ADD.
                Ведёт в дневник тренировок или питания в зависимости от текущего режима чата. */}
            <button onClick={() => { setIsOpen(false); (mode === 'workout' ? onGoToWorkoutsDiary : onGoToFoodDiary)?.() }}
              title={mode === 'workout' ? 'Дневник тренировок' : 'Дневник питания'}
              style={{
                width: 34, height: 34, borderRadius: 10, border: '1px solid #e5e7eb', background: '#f9fafb',
                fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, minHeight: 'unset',
              }}>📖</button>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowClearConfirm(true)} title="Очистить историю чата"
                disabled={!messages.length}
                style={{
                  width: 34, height: 34, borderRadius: 10, border: '1px solid #e5e7eb', background: '#f9fafb',
                  fontSize: 15, cursor: messages.length ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, minHeight: 'unset', opacity: messages.length ? 1 : 0.4,
                }}>🗑</button>
              {showClearConfirm && (
                <>
                  <div onClick={() => setShowClearConfirm(false)} style={{ position: 'fixed', inset: 0, zIndex: 1400 }} />
                  <div style={{
                    position: 'absolute', top: 40, right: 0, background: '#fff', borderRadius: 12,
                    boxShadow: '0 6px 24px rgba(0,0,0,0.18)', zIndex: 1401, minWidth: 230, padding: 14,
                    border: '1px solid #f0f0f0',
                  }}>
                    <div style={{ fontSize: 13, color: '#111', fontWeight: 600, marginBottom: 10 }}>Очистить историю чата?</div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12, lineHeight: 1.4 }}>
                      Удалятся только сообщения режима «{mode === 'workout' ? 'Тренировки' : 'Питание'}».
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setShowClearConfirm(false)}
                        style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 12.5, cursor: 'pointer', minHeight: 'unset' }}>
                        Отмена
                      </button>
                      <button onClick={clearChatHistory} disabled={clearing}
                        style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }}>
                        {clearing ? 'Удаление...' : 'Очистить'}
                      </button>
                    </div>
                  </div>
                </>
              )}
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

          <>
              {/* Сообщения */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Заглушка если нет сообщений */}
                {messages.length === 0 && (
                  <div style={{ textAlign: 'center', marginTop: 24 }}>
                    <div style={{ fontSize: 42, marginBottom: 12 }}>{mode === 'workout' ? '🏋️' : '🥗'}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 6 }}>
                      {mode === 'workout'
                        ? (ctx?.profile?.name ? `Привет, ${ctx.profile.name.split(' ')[0]}! 🏋️` : 'AI-тренер')
                        : (ctx?.profile?.name ? `Привет, ${ctx.profile.name.split(' ')[0]}! 🥗` : 'AI диетолог')}
                    </div>
                    <div style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.65, marginBottom: 20 }}>
                      {mode === 'workout'
                        ? <>Вижу твою программу и историю —{'\n'}спрашивай про вес и прогресс</>
                        : <>Вижу твой дневник и норму —{'\n'}спрашивай что угодно</>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                      {(mode === 'workout' ? HINTS_WORKOUT : HINTS).map((h, i) => (
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
                        {m.image && (
                          <img src={m.image} alt="Прикреплённое фото" style={{ display: 'block', maxWidth: '100%', maxHeight: 220, borderRadius: 10, marginBottom: m.content ? 8 : 0 }} />
                        )}
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
                    {/* Кнопка «Перейти к тренировке» под ответом с SET_PROGRAM-маркером —
                        только если запись в дневник реально прошла (m.programSet). */}
                    {m.role === 'assistant' && m.programSet && (
                      <div style={{ paddingLeft: 36 }}>
                        <button onClick={() => { setIsOpen(false); onGoToWorkoutsDiary?.() }}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 20, background: PUR, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                          📋 Перейти к тренировке
                        </button>
                      </div>
                    )}
                    {/* Кнопка «Заполнить анкету» под ответом с SUGGEST_SURVEY-маркером */}
                    {m.role === 'assistant' && m.suggestSurvey && (
                      <div style={{ paddingLeft: 36 }}>
                        <button onClick={() => setShowSurvey(true)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 20, background: PUR, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                          📋 Заполнить анкету
                        </button>
                      </div>
                    )}
                    {/* Кнопка «Написать Максиму» под ответом на вопрос-миф (CONTACT_MAX-маркер) */}
                    {m.role === 'assistant' && m.contactMax && (
                      <div style={{ paddingLeft: 36 }}>
                        <a href={MAX_TELEGRAM_URL} target="_blank" rel="noopener noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 20, background: PUR, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' }}>
                          💬 Написать Максиму
                        </a>
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

              {/* Превью прикреплённого фото — над полем ввода, до отправки */}
              {attachedImage && (
                <div style={{ padding: '10px 16px 0', display: 'flex', alignItems: 'center', gap: 10, background: '#fff', flexShrink: 0 }}>
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <img src={attachedImage.dataUrl} alt="Превью" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 10, border: '1px solid #e5e7eb', display: 'block' }} />
                    <button onClick={() => setAttachedImage(null)}
                      style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#ef4444', color: '#fff', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, minHeight: 'unset', padding: 0 }}>✕</button>
                  </div>
                  <span style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.4 }}>Фото прикреплено — считаю цифры со скриншота</span>
                </div>
              )}

              {/* Поле ввода */}
              <div style={{
                padding: '12px 16px',
                paddingBottom: isMobile ? 'max(12px, calc(env(safe-area-inset-bottom) + 12px))' : '12px',
                borderTop: '1px solid #e5e7eb',
                display: 'flex', gap: 8, flexShrink: 0, background: '#fff',
              }}>
                {mode === 'nutrition' && (
                  <>
                    <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageSelect} style={{ display: 'none' }} />
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      title="Прикрепить фото/скриншот"
                      style={{
                        width: 44, height: 44, borderRadius: '50%', border: '1.5px solid #e5e7eb', flexShrink: 0,
                        background: attachedImage ? `${PUR}18` : '#f9fafb', color: attachedImage ? PUR : '#6b7280',
                        fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        minHeight: 'unset',
                      }}>📎</button>
                  </>
                )}
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  placeholder={mode === 'workout' ? 'Расскажи как прошёл подход...' : attachedImage ? 'Можно добавить комментарий...' : 'Спроси про питание или продукт...'}
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
                  disabled={(!input.trim() && !attachedImage) || loading}
                  style={{
                    width: 44, height: 44, borderRadius: '50%', border: 'none', flexShrink: 0,
                    background: ((!input.trim() && !attachedImage) || loading) ? '#e5e7eb' : `linear-gradient(135deg,${PUR},#5b54c4)`,
                    color: '#fff', fontSize: 20, cursor: ((!input.trim() && !attachedImage) || loading) ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 0.15s', minHeight: 'unset',
                  }}>↑</button>
              </div>
            </>
        </div>
      )}

      {showSurvey && (
        <TrainingSurvey onClose={() => setShowSurvey(false)} onSaved={() => { if (mode === 'workout') loadContext('workout').then(c => c && setCtx(c)) }} />
      )}
    </>
  )
})

export default AIAssistant
