import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { supabase } from './supabase'
import { buildSystemPrompt } from './aiPrompt'
import { buildWorkoutSystemPrompt, extractBalancedJson } from './workoutPrompt'

const PUR = '#7F77DD'
// Та же ссылка, что и кнопка "Написать тренеру" в Настройках → Поддержка (App.jsx) —
// один и тот же контакт Максима в Telegram, не заводим вторую ссылку.
const MAX_TELEGRAM_URL = 'https://t.me/maxim_athlete'

const HINTS = ['Какой рацион мне подойдет?', 'Что съесть после тренировки?', 'Можно ли мне алкоголь?']
const HINTS_WORKOUT = ['Правда что от приседаний ноги станут огромными?', 'Как правильно дышать при жиме лёжа?', 'Сколько отдыхать между подходами?']

// Сырые тексты ошибок (Overloaded, сетевые сбои, таймауты) клиенту показывать
// нельзя — непонятно и пугает. Переводим в человеческие сообщения, техническая
// причина остаётся только в консоли для отладки.
const getFriendlyErrorMessage = (err, status, rawMessage) => {
  console.error('Ошибка AI-чата:', err || rawMessage, status != null ? `(status ${status})` : '')
  if (err?.name === 'AbortError' || err instanceof TypeError) {
    return 'Не удалось связаться с сервером. Проверь интернет и попробуй снова.'
  }
  const text = `${rawMessage || ''} ${err?.message || ''}`.toLowerCase()
  if (status === 529 || text.includes('overloaded')) {
    return 'Сервис сейчас загружен, попробуй ещё раз через минуту 🙏'
  }
  if (text.includes('network') || text.includes('failed to fetch') || text.includes('timeout')) {
    return 'Не удалось связаться с сервером. Проверь интернет и попробуй снова.'
  }
  return 'Что-то пошло не так, попробуй ещё раз.'
}

const stripMd = (t) => t
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/\*(.*?)\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^[+\-•]\s+/gm, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .trim()

const AIAssistant = forwardRef(function AIAssistant({ isMobile = false, onGoToWorkoutsDiary, onGoToFoodDiary, hideButton = false }, ref) {
  const [isOpen, setIsOpen]     = useState(false)
  const [mode, setMode]         = useState('nutrition')
  const [messages, setMessages] = useState([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [ctx, setCtx]           = useState(null) // { user, today, diary, goals, profile } — свежак из Supabase
  const [showToast, setShowToast] = useState(false)
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
  // Дневник питания грузим за 30 дней.
  const loadContext = async (m) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const today = new Date().toISOString().slice(0, 10)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    if (m === 'workout') {
      const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      return { user, today, profile: profile || {} }
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
        ? buildWorkoutSystemPrompt({ profile: fresh.profile })
        : buildSystemPrompt(fresh)

      // Модели отправляем не всю историю чата целиком, а только последние
      // MAX_HISTORY_MESSAGES реплик — иначе устаревшие фразы из старой части
      // переписки (например "программа составлена" за 20 сообщений до того, как
      // клиент удалил её вручную через Дневник) остаются в контексте навсегда и
      // модель на них опирается вместо свежих данных выше (см. FRESH_DATA_RULE
      // в workoutPrompt.js/aiPrompt.js — то же самое лечится с двух сторон).
      // Полная история при этом никуда не девается — она как хранилась в
      // chat_messages и показывается в UI целиком, ограничение только на то,
      // что реально уходит в запрос к модели.
      const MAX_HISTORY_MESSAGES = 14
      let sendMsgs = newMsgs.slice(-MAX_HISTORY_MESSAGES)
      // Anthropic API требует, чтобы список сообщений начинался с role:"user" —
      // если срез отрезал историю ровно на "assistant", убираем один лишний.
      if (sendMsgs.length && sendMsgs[0].role !== 'user') sendMsgs = sendMsgs.slice(1)

      const res = await fetch('/api/chat', {
        signal: abortController.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          // Тренировочный режим может выдавать SET_PROGRAM (до 6 упражнений по 4
          // подхода) или длинный текст перед маркером удаления; 1000 токенов
          // (хватает для обычных реплик и для питания) для этого тесно и рискует
          // обрезать маркер посреди JSON — именно так один раз обрубился DEL_SET
          // при удалении целой тренировки (см. Журнал изменений). 3000 — запас,
          // плюс сам маркер удаления тренировки теперь короткий (DEL_WORKOUT).
          max_tokens: mode === 'workout' ? 3000 : 1000,
          system,
          // Последнее сообщение, если к нему приложено фото, уходит в Anthropic
          // мультимодальным content-массивом (image + text); вся остальная
          // история — как обычно, плоской строкой. api/chat — чистый прокси,
          // прогоняет body как есть, поэтому это не требует правок на бэкенде.
          messages: sendMsgs.map((m, i) => {
            if (hasImage && i === sendMsgs.length - 1) {
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
        setMessages(prev => [...prev, { role: 'assistant', content: getFriendlyErrorMessage(null, res.status, data.error?.message) }])
        setInput(userMsg.content)
        if (hasImage) setAttachedImage(sentImage)
        return
      }

      let text = stripMd(data.content[0].text)
      let added = false
      let contactMax = false

      if (mode === 'workout') {
        // Режим консультанта: чат по тренировкам больше не пишет и не читает
        // дневник, не считает вес и не составляет программы — всё это теперь
        // делает само приложение (шаблонные программы в разделе Тренировки +
        // 1ПМ-движок в workoutPrompt.js, дневник — отдельный раздел). У чата в
        // этом режиме нет НИ ОДНОГО инструмента, меняющего данные клиента.
        // Единственный маркер, который здесь может встретиться, — CONTACT_MAX
        // (см. ниже). Если модель всё же по ошибке выдаст один из старых
        // маркеров действий (ADD_SET/DEL_SET/DEL_WORKOUT/DEL_ALL_HISTORY/
        // EDIT_SET/SET_PROGRAM) — это баг промпта, а не штатная ветка: никакого
        // действия НЕ выполняем, только вырезаем маркер из текста (чтобы
        // клиент не увидел сырой JSON) и шлём console.warn — сигнал, что
        // модель пытается сделать то, чего физически не может.

        // SET_PROGRAM использовал вложенный JSON, поэтому границы искались
        // параметром скобок (extractBalancedJson), а не плоским {[^}]+} —
        // тот же приём применяем здесь только чтобы вырезать маркер целиком
        // из текста, если модель всё-таки его выдаст, без единого действия.
        const spMatch = text.match(/\[SET_PROGRAM\s*:/i)
        if (spMatch) {
          console.warn('AI-консультант по тренировкам выдал маркер SET_PROGRAM — в этом режиме такого инструмента нет, действие не выполнено')
          const extracted = extractBalancedJson(text, spMatch.index + spMatch[0].length)
          text = extracted ? text.slice(0, spMatch.index) + text.slice(extracted.endIdx + 2) : text.slice(0, spMatch.index)
        }
        const strayMarkers = ['ADD_SET', 'DEL_SET', 'DEL_WORKOUT', 'DEL_ALL_HISTORY', 'EDIT_SET'].filter(name => new RegExp(`\\[${name}[:\\]]`).test(text))
        if (strayMarkers.length) console.warn(`AI-консультант по тренировкам выдал маркер(ы) ${strayMarkers.join(', ')} — в этом режиме таких инструментов нет, действие не выполнено`)
        text = text
          .replace(/\[ADD_SET:[^\]]+\]/g, '')
          .replace(/\[DEL_SET:[^\]]+\]/g, '')
          .replace(/\[DEL_WORKOUT:[^\]]+\]/g, '')
          .replace(/\[DEL_ALL_HISTORY\]/g, '')
          .replace(/\[EDIT_SET:[^\]]+\]/g, '')

        // CONTACT_MAX — AI ответил на вопрос-миф/медицинский вопрос и предлагает написать Максиму
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

      // Защита от оборванного маркера — если ответу не хватило max_tokens и модель
      // не дописала JSON до конца, в тексте остаётся необработанный обрубок вида
      // "[DEL:{"" (маркер при этом не сработал, но обрубок всё равно не должен
      // попасть в то, что видит клиент). Все настоящие маркеры (ADD, DEL, CLEAR,
      // GOAL, CONTACT_MAX и т.п.) уже вырезаны выше — если "[СЛОВО...." всё ещё
      // торчит в самом конце текста без закрывающей "]", это и есть обрубок,
      // режем его целиком.
      text = text.replace(/\[[A-Z_]{2,}[^\]]*$/, '').trimEnd()

      // Компактный вывод — без пустых/пробельных строк после вырезания маркеров
      text = text.replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()

      setMessages(prev => [...prev, { role: 'assistant', content: text, added, contactMax }])

      await supabase.from('chat_messages').insert([
        // Фото не сохраняем как base64 в текстовое поле — только пометку, что оно было.
        { user_id: fresh.user.id, mode, role: 'user', content: hasImage ? `[фото]${userMsg.content ? ' ' + userMsg.content : ''}` : userMsg.content },
        { user_id: fresh.user.id, mode, role: 'assistant', content: text },
      ])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: getFriendlyErrorMessage(err, null, null) }])
      setInput(userMsg.content)
      if (hasImage) setAttachedImage(sentImage)
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
      {/* hideButton — во время активной тренировки (обычной или Конструктора)
          кнопка своим высоким z-index перекрывает клик по крайним элементам
          экрана (например, оценке "5" в ряду 1-5) — на этих экранах прячем
          сам плавающий триггер, чат по-прежнему открывается программно
          (aiRef.current?.open) со всех остальных экранов. */}
      {!isOpen && !hideButton && (
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
                        ? <>Спрашивай про технику, восстановление —{'\n'}и любые мифы о тренировках</>
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
                  placeholder={mode === 'workout' ? 'Спроси про технику, восстановление...' : attachedImage ? 'Можно добавить комментарий...' : 'Спроси про питание или продукт...'}
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
    </>
  )
})

export default AIAssistant
