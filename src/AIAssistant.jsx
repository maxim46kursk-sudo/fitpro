import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { supabase } from './supabase'
import { buildSystemPrompt } from './aiPrompt'
import { buildWorkoutSystemPrompt, extractBalancedJson } from './workoutPrompt'

// Те же жёсткие пределы, что и в App.jsx (формы питания/профиля) — маленькие
// константы, дублировать нормально (тот же принцип, что и у localTodayISO
// выше). Модель тоже может прислать мусор в ADD/GOAL (отрицательные или
// гигантские числа), клампим перед записью в Supabase.
const CAL_MIN = 0, CAL_MAX = 20000
const MACRO_MIN = 0, MACRO_MAX = 2000
const PROFILE_WEIGHT_MIN = 0, PROFILE_WEIGHT_MAX = 500
const PROFILE_HEIGHT_MIN = 0, PROFILE_HEIGHT_MAX = 300
const clampNum = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0))

// ADD/DEL/CLEAR/GOAL — маркеры на путях ЗАПИСИ/УДАЛЕНИЯ данных клиента, где
// хрупкий regex недопустим: старый \{[^}]+\} ломался на вложенных объектах
// и на '}' внутри значений, а вырезание \[TAG:[^\]]+\] обрезало маркер по
// первой попавшейся ']' — например в названии еды "хлеб [бородинский]" это
// рвало маркер на середине, и в чат клиенту утекал сырой хвост JSON.
// extractBalancedJson (workoutPrompt.js, уже используется для SET_PROGRAM)
// считает вложенность { } [ ] по-настоящему и не путает скобки внутри строк.
// Возвращает по каждому найденному "[TAG:" маркеру { data, start, end } —
// start/end это индексы в ИСХОДНОМ тексте (оба включительно), чтобы вырезать
// маркер целиком по точному диапазону, а не regex'ом. Закрывающая ']' должна
// идти сразу после сбалансированной '}' — если её нет, или JSON вообще не
// удалось сбалансировать (например ответ оборвался на max_tokens посреди
// объекта), маркер считается битым: data===null (не исполняется), диапазон
// всё равно возвращается, чтобы огрызок не попал клиенту в текст. Тихо, без
// writeFailed — это не сбой записи (ничего и не пытались записать), а
// оборванный/некорректный маркер модели, дисклеймер про "пропала связь" тут
// был бы неправдой.
function extractMarkers(text, tag) {
  const results = []
  const re = new RegExp(`\\[${tag}:`, 'g')
  let m
  while ((m = re.exec(text))) {
    const start = m.index
    const jsonStart = m.index + m[0].length
    const extracted = extractBalancedJson(text, jsonStart)
    if (extracted && text[extracted.endIdx + 1] === ']') {
      let data
      try { data = JSON.parse(extracted.json) } catch { data = null }
      results.push({ data, start, end: extracted.endIdx + 1 })
      re.lastIndex = extracted.endIdx + 2
    } else {
      const end = extracted ? extracted.endIdx : text.length - 1
      results.push({ data: null, start, end })
      re.lastIndex = end + 1
    }
  }
  return results
}

// Вырезает диапазоны extractMarkers из текста (start/end включительно,
// маркеры идут по возрастанию start — так их и находит extractMarkers).
function removeMarkerRanges(text, markers) {
  if (!markers.length) return text
  let result = ''
  let cursor = 0
  for (const mk of markers) {
    result += text.slice(cursor, mk.start)
    cursor = mk.end + 1
  }
  result += text.slice(cursor)
  return result
}
import { MAX_TELEGRAM_URL } from './config.js'
import { GlassIcon } from './glassIcons'

// Палитра тёмной темы — те же значения, что в App.jsx (продублированы, т.к.
// этот компонент их не импортирует).
const BG = '#0b0b0d'
const SURF = '#1c1c1e'
const SURF2 = '#2c2c2e'
const HAIR = 'rgba(255,255,255,0.12)'
const TXT = '#ffffff'
const TXT2 = 'rgba(235,235,245,0.62)'
const TXT3 = 'rgba(235,235,245,0.30)'
const PUR = '#7C7AF0'
const ACCENT2 = '#9D96FF'
const DANGER = '#FF453A'

const HINTS = ['Какой рацион мне подойдёт?', 'Что съесть после тренировки?', 'Можно ли мне алкоголь?']
const HINTS_WORKOUT = ['Правда, что от приседаний ноги станут огромными?', 'Как правильно дышать при жиме лёжа?', 'Сколько отдыхать между подходами?']

// Сырые тексты ошибок (Overloaded, сетевые сбои, таймауты) клиенту показывать
// нельзя — непонятно и пугает. Переводим в человеческие сообщения, техническая
// причина остаётся только в консоли для отладки.
const getFriendlyErrorMessage = (err, status, rawMessage) => {
  console.error('Ошибка AI-чата:', err || rawMessage, status != null ? `(status ${status})` : '')
  if (err?.name === 'AbortError' || err instanceof TypeError) {
    return 'Не удалось связаться с сервером. Проверь связь и повтори.'
  }
  const text = `${rawMessage || ''} ${err?.message || ''}`.toLowerCase()
  if (status === 529 || text.includes('overloaded')) {
    return 'Сервис сейчас загружен, попробуй ещё раз через минуту 🙏'
  }
  if (text.includes('network') || text.includes('failed to fetch') || text.includes('timeout')) {
    return 'Не удалось связаться с сервером. Проверь связь и повтори.'
  }
  return 'Что-то пошло не так, попробуй ещё раз.'
}

// "Сегодня" по МЕСТНОМУ времени клиента — new Date().toISOString() отдаёт
// UTC-дату, из-за чего поздним вечером/ночью fresh.today для AI (тренировки
// и питание) мог отличаться от реального календарного дня клиента, пока
// дневник питания в App.jsx уже был локальным. Тот же helper, что в App.jsx —
// маленький, дублировать нормально.
const localTodayISO = () => { const d = new Date(); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}` }

const stripMd = (t) => t
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/\*(.*?)\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^[+\-•]\s+/gm, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .trim()

const AIAssistant = forwardRef(function AIAssistant({ isMobile = false, onGoToWorkoutsDiary, onGoToFoodDiary, hideButton = false, extraBottomOffset = 0 }, ref) {
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
    const today = localTodayISO()
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
    // Клампим вес/рост перед подачей в calcMacroGoals (aiPrompt.js, вызывается
    // из buildSystemPrompt ниже) — гигантские/отрицательные значения, попавшие
    // в profiles в обход App.jsx (например до этой правки), иначе ломают
    // расчёт нормы КБЖУ.
    const clampedProfile = profile ? {
      ...profile,
      weight: profile.weight != null ? clampNum(profile.weight, PROFILE_WEIGHT_MIN, PROFILE_WEIGHT_MAX) : profile.weight,
      height: profile.height != null ? clampNum(profile.height, PROFILE_HEIGHT_MIN, PROFILE_HEIGHT_MAX) : profile.height,
    } : {}
    return { user, today, diary: diary || [], goals: goals || null, profile: clampedProfile }
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

      // api/chat теперь требует Supabase-токен (см. api/chat.js) — без него
      // сервер отдаёт 401 ещё до обращения к Anthropic. Без сессии запрос
      // отправлять бессмысленно, поэтому проверяем и падаем в тот же catch
      // ниже (setInput/setAttachedImage восстановятся так же, как и при
      // "Не удалось определить пользователя" выше).
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Не удалось подтвердить сессию')

      const res = await fetch('/api/chat', {
        signal: abortController.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
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
      // Тихая потеря данных: если запись в Supabase падает (нет связи и
      // т.п.), сейчас ошибка уходит только в console.error, а текст модели
      // ("записал"/"удалил"/"норма установлена") остаётся единственным, что
      // видит клиент — ложный успех. writeFailed взводится в любом error-
      // или catch-случае ниже (режим питания) и добавляет дисклеймер к
      // тексту перед показом, см. ниже.
      let writeFailed = false

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
        const addMarkers = extractMarkers(text, 'ADD')
        if (addMarkers.length) {
          for (const mk of addMarkers) {
            if (!mk.data) { console.warn('AI-ассистент по питанию прислал битый маркер ADD — пропущен'); continue }
            const entry = mk.data
            const { error } = await supabase.from('food_diary').insert({
              user_id: fresh.user.id, date: entry.date || fresh.today,
              name: entry.name,
              kcal: clampNum(entry.kcal, CAL_MIN, CAL_MAX),
              p: clampNum(entry.p, MACRO_MIN, MACRO_MAX),
              c: clampNum(entry.c, MACRO_MIN, MACRO_MAX),
              f: clampNum(entry.f, MACRO_MIN, MACRO_MAX),
            })
            if (error) { console.error('Ошибка записи в дневник:', error); writeFailed = true }
            else added = true
          }
          text = removeMarkerRanges(text, addMarkers)
          if (added) {
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            flashToast()
            const refreshed = await loadContext(mode)
            if (refreshed) setCtx(refreshed)
          }
        }

        // DEL — может быть несколько записей за раз. Промпт требует спросить
        // "да" перед массовым удалением, но это только текстовая инструкция
        // модели — при её ошибке или инъекции в чат ничего не мешает ей сразу
        // прислать пачку DEL. Страховка в коде: при 2+ маркерах — обязательный
        // window.confirm, при отмене ни одна запись не удаляется. Одиночный
        // DEL (ровно 1) — как раньше, без подтверждения, это не "массовое".
        const delMarkers = extractMarkers(text, 'DEL')
        if (delMarkers.length) {
          let deleted = false
          let delCancelled = false
          if (delMarkers.some(mk => !mk.data)) console.warn('AI-ассистент по питанию прислал битый маркер DEL — пропущен')
          const parsedDels = delMarkers.filter(mk => mk.data).map(mk => mk.data)
          const delConfirmed = parsedDels.length < 2
            || window.confirm(`Удалить ${parsedDels.length} записей из дневника? Это безвозвратно.`)
          if (delConfirmed) {
            for (const del of parsedDels) {
              const { error } = await supabase.from('food_diary').delete()
                .eq('id', del.id).eq('user_id', fresh.user.id).eq('date', del.date || fresh.today)
              if (error) { console.error('Ошибка удаления записи:', error); writeFailed = true }
              else deleted = true
            }
          } else {
            delCancelled = true
          }
          text = removeMarkerRanges(text, delMarkers)
          if (deleted) {
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            const refreshed = await loadContext(mode)
            if (refreshed) setCtx(refreshed)
          }
          if (delCancelled) text += '\n\nУдаление отменено.'
        }

        // CLEAR — полная очистка дневника за дату, может быть несколько маркеров
        // сразу (несколько дат за раз). Та же страховка, что и у DEL выше:
        // промпт просит модель спросить "да" словами, но это не защита от бага
        // модели или инъекции — в коде это безвозвратное массовое удаление,
        // поэтому window.confirm обязателен всегда, при любом числе маркеров.
        const clearMarkers = extractMarkers(text, 'CLEAR')
        if (clearMarkers.length) {
          let cleared = false
          let clearCancelled = false
          if (clearMarkers.some(mk => !mk.data)) console.warn('AI-ассистент по питанию прислал битый маркер CLEAR — пропущен')
          const parsedClears = clearMarkers.filter(mk => mk.data).map(mk => mk.data)
          if (parsedClears.length) {
            const dates = parsedClears.map(c => c.date || fresh.today).join(', ')
            const clearConfirmed = window.confirm(`Очистить дневник питания за ${dates}? Записи удалятся безвозвратно.`)
            if (clearConfirmed) {
              for (const clear of parsedClears) {
                const { error } = await supabase.from('food_diary').delete()
                  .eq('user_id', fresh.user.id).eq('date', clear.date || fresh.today)
                if (error) { console.error('Ошибка очистки дневника:', error); writeFailed = true }
                else cleared = true
              }
            } else {
              clearCancelled = true
            }
          }
          text = removeMarkerRanges(text, clearMarkers)
          if (cleared) {
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
            const refreshed = await loadContext(mode)
            if (refreshed) setCtx(refreshed)
          }
          if (clearCancelled) text += '\n\nОчистка отменена.'
        }

        // GOAL — только первый маркер исполняется (как и раньше, text.match
        // без /g брал только первое вхождение), но вырезаются из текста ВСЕ
        // найденные — если модель по ошибке пришлёт два, второй не должен
        // остаться в тексте сырым JSON.
        const goalMarkers = extractMarkers(text, 'GOAL')
        if (goalMarkers.length) {
          const goal = goalMarkers[0].data
          if (goal) {
            const { error } = await supabase.from('food_goals').upsert({
              user_id: fresh.user.id,
              kcal: clampNum(goal.kcal, CAL_MIN, CAL_MAX),
              p: clampNum(goal.p, MACRO_MIN, MACRO_MAX),
              c: clampNum(goal.c, MACRO_MIN, MACRO_MAX),
              f: clampNum(goal.f, MACRO_MIN, MACRO_MAX),
              updated_at: new Date().toISOString(),
            })
            if (error) { console.error('Ошибка обновления нормы:', error); writeFailed = true }
            window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
          } else {
            console.warn('AI-ассистент по питанию прислал битый маркер GOAL — пропущен')
          }
          text = removeMarkerRanges(text, goalMarkers)
        }

        // CONTACT_MAX — AI отказался автоматически ставить дефицитную норму
        // при недоборе веса (см. aiPrompt.js) и предлагает написать Максиму.
        contactMax = /\[CONTACT_MAX\]/.test(text)
        if (contactMax) text = text.replace(/\[CONTACT_MAX\]/g, '')
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

      // Дописываем СНИЗУ, не стирая текст модели — иначе клиент останется с
      // ложным "записал"/"удалил"/"норма установлена", хотя данные не долетели.
      if (writeFailed) {
        text += '\n\n⚠️ Не удалось сохранить это в дневник — похоже, пропало соединение. Проверь связь и повтори.'
      }

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

  // extraBottomOffset — поднимает кнопку на высоту плашки свёрнутой
  // тренировки (App.jsx), пока та видна, чтобы плашка не перекрыла кнопку
  // (известный ранее z-index-баг с плавающими элементами внизу экрана).
  const BTN_BOTTOM = (isMobile ? 78 : 24) + extraBottomOffset

  return (
    <>
      <style>{`
        @keyframes ai-bounce {
          0%,60%,100%{transform:translateY(0)}
          30%{transform:translateY(-5px)}
        }
        @keyframes ai-pulse {
          0%,100%{box-shadow:0 4px 20px #7C7AF055}
          50%{box-shadow:0 4px 28px #7C7AF099}
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
          background: 'linear-gradient(135deg,#7C7AF0,#5b54c4)',
          color: '#fff', fontSize: 22, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'ai-pulse 2.5s ease-in-out infinite',
          minHeight: 'unset',
        }}><GlassIcon name="robot" size={30} /></button>
      )}

      {/* Чат */}
      {isOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1050,
          display: 'flex', flexDirection: 'column', background: BG,
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
            padding: '12px 16px', borderBottom: `1px solid ${HAIR}`,
            display: 'flex', alignItems: 'center', gap: 10,
            background: SURF, flexShrink: 0,
          }}>
            <button onClick={() => setIsOpen(false)} style={{
              background: 'none', border: 'none', fontSize: 22, cursor: 'pointer',
              color: TXT3, padding: 0, lineHeight: 1, minHeight: 'unset',
            }}><GlassIcon name="back" size={20} /></button>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#7C7AF0,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><GlassIcon name="robot" size={26} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: TXT, lineHeight: 1.2 }}>AI-ассистент</div>
              <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 500 }}>● онлайн</div>
            </div>
            {/* Постоянная кнопка в дневник — всегда видна, не только после SET_PROGRAM/ADD.
                Ведёт в дневник тренировок или питания в зависимости от текущего режима чата. */}
            <button onClick={() => { setIsOpen(false); (mode === 'workout' ? onGoToWorkoutsDiary : onGoToFoodDiary)?.() }}
              title={mode === 'workout' ? 'Дневник тренировок' : 'Дневник питания'}
              style={{
                width: 34, height: 34, borderRadius: 10, border: `1px solid ${HAIR}`, background: SURF2,
                fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, minHeight: 'unset',
              }}>📖</button>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowClearConfirm(true)} title="Очистить историю чата"
                disabled={!messages.length}
                style={{
                  width: 34, height: 34, borderRadius: 10, border: `1px solid ${HAIR}`, background: SURF2,
                  fontSize: 15, cursor: messages.length ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, minHeight: 'unset', opacity: messages.length ? 1 : 0.4,
                }}><GlassIcon name="trash" size={20} /></button>
              {showClearConfirm && (
                <>
                  <div onClick={() => setShowClearConfirm(false)} style={{ position: 'fixed', inset: 0, zIndex: 1400 }} />
                  <div style={{
                    position: 'absolute', top: 40, right: 0, background: SURF, borderRadius: 12,
                    boxShadow: '0 6px 24px rgba(0,0,0,0.18)', zIndex: 1401, minWidth: 230, padding: 14,
                    border: `1px solid ${HAIR}`,
                  }}>
                    <div style={{ fontSize: 13, color: TXT, fontWeight: 600, marginBottom: 10 }}>Очистить историю чата?</div>
                    <div style={{ fontSize: 12, color: TXT3, marginBottom: 12, lineHeight: 1.4 }}>
                      Удалятся только сообщения режима «{mode === 'workout' ? 'Тренировки' : 'Питание'}».
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setShowClearConfirm(false)}
                        style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${HAIR}`, background: SURF, color: TXT3, fontSize: 12.5, cursor: 'pointer', minHeight: 'unset' }}>
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
          <div style={{ padding: '10px 16px', borderBottom: `1px solid ${HAIR}`, display: 'flex', gap: 8, flexShrink: 0, background: SURF2 }}>
            {[{ id: 'workout', ic: 'dumbbell', label: 'Тренировки' }, { id: 'nutrition', ic: 'food', label: 'Питание' }].map(m => (
              <button key={m.id} onClick={() => setMode(m.id)}
                style={{
                  padding: '7px 18px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  background: mode === m.id ? PUR : 'transparent',
                  color: mode === m.id ? '#fff' : TXT2,
                  fontSize: 13, fontWeight: mode === m.id ? 700 : 500,
                  boxShadow: mode === m.id ? `0 2px 10px ${PUR}44` : 'none',
                  transition: 'all 0.15s', minHeight: 'unset',
                }}>
                <><GlassIcon name={m.ic} size={26} style={{marginRight:6,verticalAlign:"-6px"}} />{m.label}</>
              </button>
            ))}
          </div>

          <>
              {/* Сообщения */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Заглушка если нет сообщений */}
                {messages.length === 0 && (
                  <div style={{ textAlign: 'center', marginTop: 24 }}>
                    <div style={{ display:'flex', justifyContent:'center', marginBottom: 12 }}><GlassIcon name={mode === 'workout' ? 'dumbbell' : 'food'} size={48} /></div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: TXT, marginBottom: 6 }}>
                      {mode === 'workout'
                        ? (ctx?.profile?.name ? `Привет, ${ctx.profile.name.split(' ')[0]}! 🏋️` : 'AI-ассистент')
                        : (ctx?.profile?.name ? `Привет, ${ctx.profile.name.split(' ')[0]}! 🥗` : 'AI-ассистент')}
                    </div>
                    <div style={{ fontSize: 13, color: TXT3, lineHeight: 1.65, marginBottom: 20 }}>
                      {mode === 'workout'
                        ? <>Спрашивай про технику, восстановление —{'\n'}и любые мифы о тренировках</>
                        : <>Вижу твой дневник и норму —{'\n'}спрашивай что угодно</>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                      {(mode === 'workout' ? HINTS_WORKOUT : HINTS).map((h, i) => (
                        <button key={i} onClick={() => setInput(h)}
                          style={{
                            padding: '8px 16px', borderRadius: 20, border: `1px solid ${HAIR}`,
                            background: SURF2, color: TXT, fontSize: 13, cursor: 'pointer',
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
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#7C7AF0,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><GlassIcon name="robot" size={20} /></div>
                      )}
                      <div style={{
                        maxWidth: '75%', padding: '10px 14px',
                        borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
                        background: m.role === 'user' ? PUR : SURF,
                        color: m.role === 'user' ? '#fff' : TXT,
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
                          <GlassIcon name="check" size={18} />
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
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#7C7AF0,#5b54c4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><GlassIcon name="robot" size={20} /></div>
                    <div style={{ background: SURF2, borderRadius: '16px 16px 16px 4px', padding: '12px 16px', display: 'flex', gap: 5, alignItems: 'center' }}>
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
                <div style={{ padding: '10px 16px 0', display: 'flex', alignItems: 'center', gap: 10, background: SURF, flexShrink: 0 }}>
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <img src={attachedImage.dataUrl} alt="Превью" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 10, border: `1px solid ${HAIR}`, display: 'block' }} />
                    <button onClick={() => setAttachedImage(null)}
                      style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#ef4444', color: '#fff', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, minHeight: 'unset', padding: 0 }}><GlassIcon name="close" size={14} /></button>
                  </div>
                  <span style={{ fontSize: 12, color: TXT3, lineHeight: 1.4 }}>Фото прикреплено — считаю цифры со скриншота</span>
                </div>
              )}

              {/* Поле ввода */}
              <div style={{
                padding: '12px 16px',
                paddingBottom: isMobile ? 'max(12px, calc(env(safe-area-inset-bottom) + 12px))' : '12px',
                borderTop: `1px solid ${HAIR}`,
                display: 'flex', gap: 8, flexShrink: 0, background: SURF,
              }}>
                {mode === 'nutrition' && (
                  <>
                    <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageSelect} style={{ display: 'none' }} />
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      title="Прикрепить фото/скриншот"
                      style={{
                        width: 44, height: 44, borderRadius: '50%', border: `1.5px solid ${HAIR}`, flexShrink: 0,
                        background: attachedImage ? `${PUR}18` : SURF2, color: attachedImage ? PUR : TXT2,
                        fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        minHeight: 'unset',
                      }}><GlassIcon name="plus" size={20} /></button>
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
                    border: `1.5px solid ${HAIR}`, fontSize: 14,
                    outline: 'none', color: TXT, background: SURF2,
                    transition: 'border-color 0.15s',
                  }}
                  onFocus={e => e.target.style.borderColor = PUR}
                  onBlur={e => e.target.style.borderColor = HAIR}
                />
                <button
                  onClick={send}
                  disabled={(!input.trim() && !attachedImage) || loading}
                  style={{
                    width: 44, height: 44, borderRadius: '50%', border: 'none', flexShrink: 0,
                    background: ((!input.trim() && !attachedImage) || loading) ? SURF2 : `linear-gradient(135deg,${PUR},#5b54c4)`,
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
