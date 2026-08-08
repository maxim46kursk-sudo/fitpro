// Экран «Провести тренировку»: тренер ведёт занятие клиента вживую (обычно по
// видеосвязи) и пишет подходы прямо в дневник клиента, в реальном времени.
//
// Права на запись дала миграция sql/2026-08-04_trainer_logs_workouts.sql:
// тренер вправе INSERT/UPDATE/DELETE в workouts и workout_sets для СВОИХ
// клиентов при условии workouts.created_by = его id. Отсюда два железных
// правила этого файла: в каждую создаваемую тренировку кладём created_by, а
// user_id подходов всегда равен user_id тренировки — иначе политика откажет.
//
// Отдельный файл, а не кусок App.jsx: тот и без того на одиннадцать тысяч
// строк. Вынесено по образцу AIAssistant.jsx и ConstructorView.jsx — оттуда же
// взят приём с локальным объявлением палитры (единый источник — App.jsx,
// значения обязаны совпадать).
//
// СОХРАНЕНИЕ — главное в этом экране. Ничего не копится в памяти до «Завершить»:
// строка workouts создаётся при первом же упражнении, каждый подход уходит в
// базу при потере фокуса поля, правка — update, удаление — delete. Плюс тот же
// приём, что в редакторе программы (App.jsx, ProgramEditor): дискретные
// действия пишутся немедленно, а при уходе с экрана недописанное досылается
// fetch'ем с keepalive — обычный запрос не переживает закрытия Mini App свайпом,
// на этом уже теряли правки программы.
import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabase.js'
import { parseTemplateSets } from './workoutPrompt.js'
import { GlassIcon } from './glassIcons'
import { logError } from './logError'

// Палитра — копия из App.jsx (см. шапку). Значения обязаны совпадать.
const BG = '#0b0b0d'
const SURF = '#1c1c1e'
const SURF2 = '#2c2c2e'
const HAIR = 'rgba(255,255,255,0.12)'
const TXT = '#ffffff'
const TXT2 = 'rgba(235,235,245,0.62)'
const TXT3 = 'rgba(235,235,245,0.30)'
const PUR = '#7C7AF0'
const ACCENT2 = '#9D96FF'
const TEA = '#30D158'

const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
const pad2 = n => String(n).padStart(2, '0')
const localTodayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}` }
// «12 июля» из '2026-07-12'. Кривую строку показываем как есть — врать датой хуже.
const dateWords = key => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '')
  if (!m) return key || ''
  return `${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1] || ''}`.trim()
}

// Ключ строки списка: у упражнения нет своего id, а имена могут повторяться
// (одно и то же упражнение дважды за тренировку — обычное дело).
let uidCounter = 0
const uid = () => `e${++uidCounter}`

const emptySet = () => ({ id: null, kg: '', reps: '' })
const mkExercise = (name, sets, note = '') => ({
  key: uid(), name, note,
  sets: sets && sets.length ? sets.map(s => ({ id: null, kg: s.kg ?? '', reps: s.reps ?? '' })) : [emptySet()],
})

// ── Выбор упражнения ────────────────────────────────────────────────────────
// Свой пикер, а не переиспользованный: общего КОМПОНЕНТА в App.jsx нет — там
// две одинаковые модалки, вписанные прямо в разметку ProgramEditor и
// WorkoutsView. Вытаскивать одну из них в общий компонент значит править два
// боевых экрана ради нового; вёрстка и поведение здесь повторены один в один,
// плюс поле «своё название» — его в тех двух нет, а тренеру оно нужно.
function ExercisePicker({ catalogExercises, onPick, onClose }) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const list = (catalogExercises || []).filter(e =>
    (e.label || e.n).toLowerCase().includes(query) || e.n.toLowerCase().includes(query))
  const custom = q.trim()
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={onClose}>
      <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:400, maxHeight:'75vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Выбери упражнение</span>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
        </div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск или своё название..." autoFocus
          style={{ width:'100%', marginBottom:12, padding:'9px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF2 }}
          onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = HAIR} />
        {/* Своё название — когда упражнения нет в каталоге. Показываем только
            если введённое не совпало с готовым вариантом, иначе кнопка-дубль. */}
        {custom && !list.some(e => (e.label || e.n).toLowerCase() === custom.toLowerCase()) && (
          <button onClick={() => onPick(custom)}
            style={{ width:'100%', marginBottom:8, padding:'10px', fontSize:13, fontWeight:700, borderRadius:9, border:`1px dashed ${PUR}`, background:`${PUR}18`, color:PUR, cursor:'pointer', textAlign:'left' }}>
            + Добавить «{custom}»
          </button>
        )}
        <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:2 }}>
          {list.map(e => (
            <button key={e.n} onClick={() => onPick(e.n)}
              style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', width:'100%', padding:'9px 10px', border:'none', background:'transparent', cursor:'pointer', textAlign:'left', borderRadius:8 }}>
              <span style={{ fontSize:13, color:TXT }}>{e.label || e.n}</span>
              <span style={{ fontSize:11, color:TXT3 }}>{e.m}{e.eq ? ` · ${e.eq}` : ''}</span>
            </button>
          ))}
          {!list.length && !custom && (
            <div style={{ fontSize:12, color:TXT3, padding:'10px 2px' }}>Начни вводить название</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Список тренировок, записанных этим тренером ─────────────────────────────
// Показывается в карточке клиента. Только СВОИ записи (created_by = тренер):
// то, что клиент вёл сам, тренеру править нельзя — база откажет по политике,
// поэтому и кнопки «Изменить» у таких записей нет.
export function TrainerSessionsList({ clientId, trainerId, onEdit }) {
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  // Запрос живёт прямо в эффекте, а состояние трогается только ПОСЛЕ ответа:
  // setState в синхронном теле эффекта даёт лишний каскад перерисовок.
  // Повтор после сбоя — через reloadToken, тем же приёмом, что historyReloadToken
  // в App.jsx.
  useEffect(() => {
    if (!clientId || !trainerId) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase.from('workouts')
        .select('id,name,date,duration')
        .eq('user_id', clientId).eq('created_by', trainerId)
        .order('date', { ascending: false }).limit(10)
      if (cancelled) return
      if (error) { console.error('Мои записи: ошибка загрузки:', error); setFailed(true); return }
      setFailed(false)
      setRows(data || [])
    })()
    return () => { cancelled = true }
  }, [clientId, trainerId, reloadToken])

  if (failed) return (
    <div onClick={() => setReloadToken(t => t + 1)} style={{ fontSize:12, color:TXT2, cursor:'pointer', marginBottom:12 }}>
      Не удалось загрузить мои записи · <span style={{ color:TEA }}>повторить</span>
    </div>
  )
  if (!rows || !rows.length) return null
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:11, color:TXT3, marginBottom:6 }}>Мои записи в дневнике клиента</div>
      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {rows.map(w => (
          <div key={w.id} style={{ display:'flex', alignItems:'center', gap:8, background:SURF, border:`1px solid ${HAIR}`, borderRadius:12, padding:'9px 12px' }}>
            <span style={{ flex:1, minWidth:0, fontSize:13, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {w.name || 'Тренировка'}
            </span>
            <span style={{ fontSize:11, color:TXT3, flexShrink:0 }}>{dateWords(w.date)}</span>
            <button onClick={() => onEdit(w.id)}
              style={{ flexShrink:0, fontSize:12, fontWeight:600, color:PUR, background:'none', border:`1px solid ${PUR}`, borderRadius:8, padding:'5px 10px', cursor:'pointer' }}>
              Изменить
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Основной экран ──────────────────────────────────────────────────────────
// ── Секундомер занятия ───────────────────────────────────────────────────────
// Занимает то место, где на остальных экранах висит плавающая кнопка
// ассистента: во время занятия тренеру нужны часы, а не чат — он и так говорит
// с клиентом голосом.
//
// Время считаем от МЕТКИ СТАРТА (Date.now()), а не увеличением счётчика на
// единицу в секунду: setInterval в фоновой вкладке душится браузером, и
// счётчик отстал бы тем сильнее, чем дольше идёт занятие. Здесь же интервал
// нужен только чтобы перерисовать — сама величина всегда честная разница.
function SessionStopwatch() {
  const [startedAt, setStartedAt] = useState(null)   // null — не запущен
  const [accumulated, setAccumulated] = useState(0)  // накоплено до последней паузы, мс
  const [elapsed, setElapsed] = useState(0)          // что показываем, мс

  // Date.now() зовём ТОЛЬКО в эффекте, не в теле рендера: рендер обязан быть
  // чистым, иначе одно и то же состояние даёт разный результат.
  useEffect(() => {
    if (startedAt === null) return
    // Без немедленного вызова: первый тик придёт через 250 мс, глазу это
    // незаметно, зато в эффекте нет синхронного setState.
    const id = setInterval(() => setElapsed(accumulated + (Date.now() - startedAt)), 250)
    return () => clearInterval(id)
  }, [startedAt, accumulated])

  const total = Math.floor(elapsed / 1000)
  const mmss = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  const running = startedAt !== null

  const toggle = () => {
    if (running) {
      // Показания на паузе фиксирует сам обработчик: эффект их больше не
      // трогает, а интервал уже снят — без этого на экране осталось бы время
      // последнего тика, до полусекунды меньше настоящего.
      const done = accumulated + (Date.now() - startedAt)
      setAccumulated(done); setElapsed(done); setStartedAt(null)
    } else setStartedAt(Date.now())
  }
  const reset = () => { setStartedAt(null); setAccumulated(0); setElapsed(0) }

  const btn = {
    border: 'none', borderRadius: 10, cursor: 'pointer',
    minHeight: 44, minWidth: 44, padding: '0 12px',
    fontSize: 12.5, fontWeight: 700,
  }
  return (
    <div data-testid="session-stopwatch" style={{
      position: 'fixed', right: 14, bottom: 'calc(74px + env(safe-area-inset-bottom))', zIndex: 1070,
      display: 'flex', alignItems: 'center', gap: 8,
      background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14,
      padding: '8px 10px', boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    }}>
      <span style={{ fontSize: 17, fontWeight: 800, color: TXT, fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'center' }}>{mmss}</span>
      <button data-testid="stopwatch-toggle" onClick={toggle}
        style={{ ...btn, background: running ? SURF2 : PUR, color: running ? TXT : '#fff' }}>
        {running ? 'Пауза' : 'Старт'}
      </button>
      <button data-testid="stopwatch-reset" onClick={reset}
        style={{ ...btn, background: 'none', border: `1px solid ${HAIR}`, color: TXT3 }}>
        Сброс
      </button>
    </div>
  )
}

export default function TrainerSession({ client, trainerId, catalogExercises = [], editWorkoutId = null, onExit }) {
  const clientId = client?.id
  const [phase, setPhase] = useState(editWorkoutId ? 'session' : 'loading')  // loading | choose | session

  // Пока экран открыт, плавающая кнопка ассистента в App должна быть спрятана:
  // её место занимает секундомер, и две кнопки в одном углу перекрывали бы друг
  // друга. Событием, а не пропом — TrainerSession монтируется глубоко внутри
  // карточки клиента, и протаскивать флаг через всю цепочку ради одной кнопки
  // не стоит. Тот же приём, что у fitpro:diary-update.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fitpro:trainer-session', { detail: { active: true } }))
    return () => window.dispatchEvent(new CustomEvent('fitpro:trainer-session', { detail: { active: false } }))
  }, [])
  const [starters, setStarters] = useState({ program: null, last: null })

  const [workoutId, setWorkoutId] = useState(editWorkoutId)
  const [date, setDate] = useState(localTodayISO())
  const [name, setName] = useState('Тренировка с тренером')
  const [comment, setComment] = useState('')
  const [exercises, setExercises] = useState([])
  const [prev, setPrev] = useState({})          // имя упражнения → {text, date}
  const [pickerOpen, setPickerOpen] = useState(false)
  const [finishing, setFinishing] = useState(false)

  const [saveState, setSaveState] = useState('idle')   // idle | saving | saved | error
  const [saveError, setSaveError] = useState('')
  const [elapsed, setElapsed] = useState(0)

  // Момент начала сессии. Проставляется эффектом ниже, а не в инициализаторе
  // useRef: Date.now() во время рендера — недетерминированное значение.
  const startedAtRef = useRef(null)
  const tokenRef = useRef(null)
  // Незаписанные правки для аварийного досыла (см. flushKeepalive): ключ строки
  // → тело запроса. Держим в ref, чтобы обработчик закрытия страницы читал
  // самое свежее без перерисовок.
  const pendingRef = useRef(new Map())
  const latestRef = useRef({ workoutId: editWorkoutId, comment: '' })
  const creatingRef = useRef(null)               // промис создания workouts — защита от двойной вставки
  // Содержимое сессии реально загружено/выбрано. Нужен ТОЛЬКО как предохранитель
  // для удаления пустой тренировки: в режиме правки workoutId известен с первого
  // рендера, а упражнения приезжают позже, и «подходов ноль» до загрузки —
  // неправда. Плюс StrictMode в разработке прогоняет эффекты дважды (mount →
  // cleanup → mount), то есть досылка успевает сработать до загрузки данных —
  // без этого флага она снесла бы открытую на правку настоящую тренировку.
  const contentReadyRef = useRef(false)

  useEffect(() => { latestRef.current = { workoutId, comment } }, [workoutId, comment])

  // Токен держим заранее: в момент pagehide спрашивать сессию асинхронно поздно.
  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => { if (!cancelled) tokenRef.current = data?.session?.access_token || null })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => { tokenRef.current = s?.access_token || null })
    return () => { cancelled = true; subscription?.unsubscribe() }
  }, [])

  // Секундомер сессии. Для правки старой записи не показываем — там он врёт.
  useEffect(() => {
    if (startedAtRef.current == null) startedAtRef.current = Date.now()
    if (editWorkoutId) return
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [editWorkoutId])

  const fail = (msg, e) => {
    if (e) console.error('Тренировка с тренером:', msg, e)
    logError('trainer_session_save', { message: e?.message || msg, details: { table: 'workout_sets', code: e?.code } })
    setSaveError(e?.code === '42501'
      ? 'База отклонила запись: клиент числится не за тобой. Открой карточку клиента заново'
      : msg)
    setSaveState('error')
  }

  // ── Загрузка ──────────────────────────────────────────────────────────────
  // Что клиент делал в прошлый раз по каждому упражнению — ОДНИМ запросом на
  // все упражнения сессии, а не по запросу на каждое. Берём самую свежую дату
  // по каждому названию; подходы текущей тренировки исключаем, иначе «в прошлый
  // раз» показывало бы то, что тренер вводит прямо сейчас.
  const loadPrev = useCallback(async (names, excludeWorkoutId) => {
    const uniq = [...new Set((names || []).filter(Boolean))]
    if (!uniq.length) return
    const { data, error } = await supabase.from('workout_sets')
      .select('exercise,date,kg,reps,workout_id')
      .eq('user_id', clientId).in('exercise', uniq)
      .order('date', { ascending: false }).order('id', { ascending: true }).limit(600)
    if (error) { console.error('Тренировка с тренером: не удалось прочитать прошлые подходы:', error); return }
    const byName = {}
    for (const row of data || []) {
      if (excludeWorkoutId != null && row.workout_id === excludeWorkoutId) continue
      const cur = byName[row.exercise]
      if (cur && cur.date !== row.date) continue      // строки уже отсортированы: держим только самую свежую дату
      if (!cur) byName[row.exercise] = { date: row.date, sets: [] }
      byName[row.exercise].sets.push(row)
    }
    const out = {}
    for (const [ex, v] of Object.entries(byName)) {
      const text = v.sets.map(s => {
        const kg = s.kg != null ? String(s.kg) : ''
        const reps = s.reps != null ? String(s.reps) : ''
        return kg && reps ? `${kg}×${reps}` : (reps || kg || '')
      }).filter(Boolean).join(', ')
      if (text) out[ex] = { text, date: v.date }
    }
    setPrev(p => ({ ...p, ...out }))
  }, [clientId])

  // Стартовый экран: что вообще можно предложить. Пусто и там и там — сразу
  // чистый лист, промежуточный экран с одной кнопкой не нужен.
  useEffect(() => {
    if (editWorkoutId || !clientId) return
    let cancelled = false
    ;(async () => {
      const today = localTodayISO()
      const [prog, hist] = await Promise.all([
        supabase.from('assigned_programs').select('structure').eq('client_id', clientId).maybeSingle(),
        supabase.from('workouts').select('id,name,date').eq('user_id', clientId).order('date', { ascending: false }).limit(1),
      ])
      if (cancelled) return
      const structure = Array.isArray(prog.data?.structure) ? prog.data.structure : []
      const todayPlan = structure.find(w => w?.date === today) || null
      const lastWorkout = hist.data?.[0] || null
      setStarters({ program: todayPlan, last: lastWorkout })
      if (!todayPlan && !lastWorkout) { contentReadyRef.current = true; setPhase('session'); return }
      setPhase('choose')
    })()
    return () => { cancelled = true }
  }, [clientId, editWorkoutId])

  // Правка ранее записанной тренировки: поднимаем её целиком.
  useEffect(() => {
    if (!editWorkoutId) return
    let cancelled = false
    ;(async () => {
      const [{ data: w, error: we }, { data: sets, error: se }] = await Promise.all([
        supabase.from('workouts').select('id,name,date,comment,created_by,user_id').eq('id', editWorkoutId).maybeSingle(),
        supabase.from('workout_sets').select('id,exercise,kg,reps,note').eq('workout_id', editWorkoutId).order('id'),
      ])
      if (cancelled) return
      if (we || se || !w) { fail('Не удалось открыть запись', we || se); return }
      setName(w.name || 'Тренировка с тренером')
      setDate(w.date || localTodayISO())
      setComment(w.comment || '')
      // Порядок упражнений — по первому появлению подхода, как их и записывали.
      const order = []
      const byEx = new Map()
      for (const s of sets || []) {
        if (!byEx.has(s.exercise)) { byEx.set(s.exercise, []); order.push(s.exercise) }
        byEx.get(s.exercise).push(s)
      }
      setExercises(order.map(ex => ({
        key: uid(), name: ex,
        note: (byEx.get(ex).find(s => s.note)?.note) || '',
        sets: byEx.get(ex).map(s => ({ id: s.id, kg: s.kg != null ? String(s.kg) : '', reps: s.reps != null ? String(s.reps) : '' })),
      })))
      contentReadyRef.current = true
      loadPrev(order, editWorkoutId)
    })()
    return () => { cancelled = true }
  }, [editWorkoutId, loadPrev])

  // ── Запись в базу ─────────────────────────────────────────────────────────
  // Строка workouts заводится ровно один раз и как можно раньше — на первом же
  // упражнении. creatingRef держит промис: два быстрых действия подряд не должны
  // создать две тренировки.
  const ensureWorkout = useCallback(async () => {
    if (workoutId) return workoutId
    if (creatingRef.current) return creatingRef.current
    creatingRef.current = (async () => {
      setSaveState('saving')
      const { data, error } = await supabase.from('workouts')
        .insert({ user_id: clientId, name: name || 'Тренировка с тренером', date, created_by: trainerId })
        .select('id').single()
      if (error || !data?.id) {
        creatingRef.current = null
        fail('Не удалось создать тренировку — проверь связь и нажми «Повторить»', error)
        return null
      }
      setWorkoutId(data.id)
      latestRef.current = { ...latestRef.current, workoutId: data.id }
      return data.id
    })()
    const id = await creatingRef.current
    creatingRef.current = null
    return id
  }, [workoutId, clientId, name, date, trainerId])

  // Один подход. Есть id — update, нет — insert (и запоминаем выданный id).
  // user_id подхода ВСЕГДА равен владельцу тренировки: иначе политика откажет.
  const persistSet = useCallback(async (exKey, setIdx) => {
    const ex = exercises.find(e => e.key === exKey)
    if (!ex) return
    const s = ex.sets[setIdx]
    if (!s) return
    const kg = String(s.kg).trim() === '' ? null : Number(String(s.kg).replace(',', '.'))
    const reps = String(s.reps).trim() === '' ? null : parseInt(s.reps, 10)
    // Пустой и ещё не сохранённый подход в базу не пишем — это просто заготовка.
    if (s.id == null && kg == null && reps == null) return
    const wid = await ensureWorkout()
    if (!wid) return
    setSaveState('saving')
    const row = {
      user_id: clientId, exercise: ex.name, date,
      kg: Number.isFinite(kg) ? kg : null,
      reps: Number.isFinite(reps) ? reps : null,
      note: setIdx === 0 ? (ex.note || null) : null,
      workout_id: wid,
    }
    pendingRef.current.delete(`${exKey}:${setIdx}`)
    if (s.id) {
      const { error } = await supabase.from('workout_sets').update(row).eq('id', s.id)
      if (error) { fail('Подход не сохранён — проверь связь и нажми «Повторить»', error); return }
    } else {
      const { data, error } = await supabase.from('workout_sets').insert(row).select('id').single()
      if (error || !data?.id) { fail('Подход не сохранён — проверь связь и нажми «Повторить»', error); return }
      setExercises(list => list.map(e => e.key !== exKey ? e
        : { ...e, sets: e.sets.map((x, i) => i === setIdx ? { ...x, id: data.id } : x) }))
    }
    setSaveError(''); setSaveState('saved')
  }, [exercises, ensureWorkout, clientId, date])

  // ── Правка состояния ──────────────────────────────────────────────────────
  const setField = (exKey, setIdx, field, value) => {
    pendingRef.current.set(`${exKey}:${setIdx}`, true)
    setExercises(list => list.map(e => e.key !== exKey ? e
      : { ...e, sets: e.sets.map((s, i) => i === setIdx ? { ...s, [field]: value } : s) }))
  }

  const addExercise = async (exName) => {
    setPickerOpen(false)
    const ex = mkExercise(exName)
    setExercises(list => [...list, ex])
    loadPrev([exName], workoutId)
    // Тренировку заводим сразу — она должна существовать в базе с первого
    // добавленного упражнения, а не с первого заполненного поля.
    ensureWorkout()
  }

  const addSet = async (exKey) => {
    const ex = exercises.find(e => e.key === exKey)
    if (!ex) return
    const last = ex.sets[ex.sets.length - 1]
    const copy = { id: null, kg: last?.kg ?? '', reps: last?.reps ?? '' }
    setExercises(list => list.map(e => e.key !== exKey ? e : { ...e, sets: [...e.sets, copy] }))
    // «+ подход» копирует предыдущий, то есть сразу несёт значения — пишем его
    // немедленно, не дожидаясь фокуса и потери фокуса.
    if (String(copy.kg).trim() || String(copy.reps).trim()) {
      const idx = ex.sets.length
      const wid = await ensureWorkout()
      if (!wid) return
      const kg = String(copy.kg).trim() === '' ? null : Number(String(copy.kg).replace(',', '.'))
      const reps = String(copy.reps).trim() === '' ? null : parseInt(copy.reps, 10)
      const { data, error } = await supabase.from('workout_sets')
        .insert({ user_id: clientId, exercise: ex.name, date, kg: Number.isFinite(kg) ? kg : null, reps: Number.isFinite(reps) ? reps : null, workout_id: wid })
        .select('id').single()
      if (error || !data?.id) { fail('Подход не сохранён — проверь связь и нажми «Повторить»', error); return }
      setExercises(list => list.map(e => e.key !== exKey ? e
        : { ...e, sets: e.sets.map((x, i) => i === idx ? { ...x, id: data.id } : x) }))
      setSaveError(''); setSaveState('saved')
    }
  }

  const removeSet = async (exKey, setIdx) => {
    const ex = exercises.find(e => e.key === exKey)
    const s = ex?.sets[setIdx]
    if (!ex) return
    // Последний подход не удаляем — упражнение без подходов бессмысленно.
    if (ex.sets.length <= 1) return
    pendingRef.current.delete(`${exKey}:${setIdx}`)
    setExercises(list => list.map(e => e.key !== exKey ? e : { ...e, sets: e.sets.filter((_, i) => i !== setIdx) }))
    if (s?.id) {
      setSaveState('saving')
      const { error } = await supabase.from('workout_sets').delete().eq('id', s.id)
      if (error) { fail('Не удалось удалить подход', error); return }
      setSaveError(''); setSaveState('saved')
    }
  }

  const removeExercise = async (exKey) => {
    const ex = exercises.find(e => e.key === exKey)
    if (!ex) return
    if (!window.confirm(`Убрать «${ex.name}» из тренировки?`)) return
    const ids = ex.sets.map(s => s.id).filter(Boolean)
    setExercises(list => list.filter(e => e.key !== exKey))
    for (const k of [...pendingRef.current.keys()]) if (k.startsWith(`${exKey}:`)) pendingRef.current.delete(k)
    if (ids.length) {
      setSaveState('saving')
      const { error } = await supabase.from('workout_sets').delete().in('id', ids)
      if (error) { fail('Не удалось удалить упражнение', error); return }
      setSaveError(''); setSaveState('saved')
    }
  }

  // Смена даты в шапке. Дата лежит В ДВУХ местах: workouts.date и date каждого
  // подхода — так устроена схема, workout_sets несёт свою копию. Меняем ОБА
  // разом: разъехавшись, они ломают и аналитику (она группирует подходы по их
  // собственной дате), и блок «в прошлый раз» — он берёт самую свежую дату по
  // упражнению из workout_sets, а не из тренировки.
  const changeDate = async (next) => {
    setDate(next)
    const wid = latestRef.current.workoutId
    if (!wid) return                       // тренировки ещё нет — дата уйдёт при создании
    setSaveState('saving')
    const [{ error: we }, { error: se }] = await Promise.all([
      supabase.from('workouts').update({ date: next }).eq('id', wid),
      supabase.from('workout_sets').update({ date: next }).eq('workout_id', wid),
    ])
    if (we || se) { fail('Дата не сохранена — проверь связь и нажми «Повторить»', we || se); return }
    setSaveError(''); setSaveState('saved')
  }

  // Заметка к упражнению живёт на ПЕРВОМ подходе: в workout_sets поле note
  // относится к подходу, отдельного места под заметку упражнения в схеме нет,
  // а дневник клиента показывает именно эти note.
  const persistNote = async (exKey) => {
    const ex = exercises.find(e => e.key === exKey)
    if (!ex) return
    const first = ex.sets[0]
    if (!first?.id) { persistSet(exKey, 0); return }
    setSaveState('saving')
    const { error } = await supabase.from('workout_sets').update({ note: ex.note || null }).eq('id', first.id)
    if (error) { fail('Заметка не сохранена', error); return }
    setSaveError(''); setSaveState('saved')
  }

  // ── Аварийный досыл при уходе с экрана ────────────────────────────────────
  // supabase-js не умеет keepalive, а внутри Telegram свайп закрытия убивает
  // страницу вместе с незавершённым запросом. Тот же приём, что в редакторе
  // программы: синхронный fetch с keepalive:true, адрес и ключ — из
  // src/supabase.js, токен из tokenRef. Ничего не ждём: любое await означало бы,
  // что страница может умереть раньше отправки.
  const flushKeepalive = useCallback(() => {
    const token = tokenRef.current
    const { workoutId: wid, comment: cmt } = latestRef.current
    if (!token || !wid) return
    const send = (url, method, body) => {
      try {
        const opts = {
          method, keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${token}`,
            Prefer: 'return=minimal',
          },
        }
        // У DELETE тела нет — с body:undefined fetch отправит запрос без него,
        // но явная ветка честнее и не зависит от поведения реализации.
        if (body !== undefined) opts.body = JSON.stringify(body)
        fetch(url, opts).catch(e => console.error('Тренировка с тренером: досылка не дошла:', e?.message || e))
      } catch (e) { console.error('Тренировка с тренером: не удалось отправить досылку:', e?.message || e) }
    }
    // Незакоммиченные правки полей: те, у кого уже есть id — PATCH, новые — POST.
    let willHaveSets = 0
    for (const ex of exercises) for (const s of ex.sets) if (s.id) willHaveSets++
    for (const key of pendingRef.current.keys()) {
      const [exKey, idxRaw] = key.split(':')
      const ex = exercises.find(e => e.key === exKey)
      const s = ex?.sets[Number(idxRaw)]
      if (!ex || !s) continue
      const kg = String(s.kg).trim() === '' ? null : Number(String(s.kg).replace(',', '.'))
      const reps = String(s.reps).trim() === '' ? null : parseInt(s.reps, 10)
      if (s.id == null && kg == null && reps == null) continue
      const body = {
        user_id: clientId, exercise: ex.name, date,
        kg: Number.isFinite(kg) ? kg : null, reps: Number.isFinite(reps) ? reps : null,
        workout_id: wid,
      }
      if (s.id) send(`${SUPABASE_URL}/rest/v1/workout_sets?id=eq.${s.id}`, 'PATCH', { kg: body.kg, reps: body.reps })
      else { send(`${SUPABASE_URL}/rest/v1/workout_sets`, 'POST', body); willHaveSets++ }
    }
    pendingRef.current.clear()

    // Уходим, не записав ни одного подхода (открыл экран, добавил упражнение и
    // передумал) — тренировку сносим, пустышке в дневнике клиента не место.
    // Подходы ушли бы каскадом, но их тут и нет. Комментарий в этом случае
    // писать уже некуда.
    if (willHaveSets === 0) {
      // Пока содержимое не загружено, «ноль подходов» ничего не значит.
      if (contentReadyRef.current) send(`${SUPABASE_URL}/rest/v1/workouts?id=eq.${wid}`, 'DELETE', undefined)
      return
    }
    // Комментарий к тренировке — он живёт только в состоянии до «Завершить».
    if (cmt) send(`${SUPABASE_URL}/rest/v1/workouts?id=eq.${wid}`, 'PATCH', { comment: cmt })
  }, [exercises, clientId, date])

  // Досылку зовём ЧЕРЕЗ ref, а эффекты вешаем с пустыми зависимостями.
  // Иначе flushKeepalive попадает в зависимости, его identity меняется на
  // каждую правку упражнений, и cleanup эффекта срабатывает не при уходе с
  // экрана, а после КАЖДОГО изменения: лишний поток запросов, а с удалением
  // пустой тренировки (ниже) — ещё и снос свежесозданной записи в момент,
  // когда подходов в ней пока ноль.
  const flushRef = useRef(flushKeepalive)
  useEffect(() => { flushRef.current = flushKeepalive }, [flushKeepalive])
  useEffect(() => () => { flushRef.current() }, [])
  useEffect(() => {
    const flush = () => flushRef.current()
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // ── Старт из программы / из прошлой тренировки ────────────────────────────
  const startFrom = async (source) => {
    let list = []
    if (source === 'program') {
      list = (starters.program?.exercises || []).map(ex => {
        const parsed = (ex.sets ? parseTemplateSets(ex.sets) : []).map(t => ({
          kg: t.templateKg != null ? String(t.templateKg) : '', reps: String(t.reps ?? ''),
        }))
        return mkExercise(ex.name, parsed, ex.note || '')
      })
    } else if (source === 'last') {
      const { data, error } = await supabase.from('workout_sets')
        .select('exercise,kg,reps,note').eq('workout_id', starters.last.id).order('id')
      if (error) { fail('Не удалось прочитать прошлую тренировку', error); return }
      const order = []; const byEx = new Map()
      for (const s of data || []) {
        if (!byEx.has(s.exercise)) { byEx.set(s.exercise, []); order.push(s.exercise) }
        byEx.get(s.exercise).push(s)
      }
      list = order.map(ex => mkExercise(
        ex,
        byEx.get(ex).map(s => ({ kg: s.kg != null ? String(s.kg) : '', reps: s.reps != null ? String(s.reps) : '' })),
        byEx.get(ex).find(s => s.note)?.note || '',
      ))
    }
    setExercises(list)
    contentReadyRef.current = true
    setPhase('session')
    if (list.length) {
      loadPrev(list.map(e => e.name), null)
      // Подставленные подходы — это уже данные, а не заготовка: пишем сразу,
      // чтобы сессия существовала в базе с первой секунды.
      const wid = await ensureWorkout()
      if (!wid) return
      const rows = []
      list.forEach(ex => ex.sets.forEach((s, i) => {
        const kg = String(s.kg).trim() === '' ? null : Number(String(s.kg).replace(',', '.'))
        const reps = String(s.reps).trim() === '' ? null : parseInt(s.reps, 10)
        if (kg == null && reps == null) return
        rows.push({ exKey: ex.key, i, row: { user_id: clientId, exercise: ex.name, date, kg: Number.isFinite(kg) ? kg : null, reps: Number.isFinite(reps) ? reps : null, note: i === 0 ? (ex.note || null) : null, workout_id: wid } })
      }))
      if (!rows.length) return
      setSaveState('saving')
      const { data, error } = await supabase.from('workout_sets').insert(rows.map(r => r.row)).select('id')
      if (error || !data) { fail('Не удалось записать подходы — проверь связь и нажми «Повторить»', error); return }
      // id возвращаются в порядке вставки — раскладываем обратно по подходам.
      setExercises(cur => {
        const copy = cur.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s })) }))
        rows.forEach((r, k) => {
          const ex = copy.find(e => e.key === r.exKey)
          if (ex && ex.sets[r.i] && data[k]?.id) ex.sets[r.i].id = data[k].id
        })
        return copy
      })
      setSaveError(''); setSaveState('saved')
    }
  }

  // ── Завершение ────────────────────────────────────────────────────────────
  const finish = async () => {
    if (finishing) return
    setFinishing(true)
    try {
      const wid = latestRef.current.workoutId
      // Тренировку даже не заводили — выходить нечем.
      if (!wid) { onExit(); return }
      setSaveState('saving')

      // Сначала дописываем то, что тренер ввёл, но не увёл фокус: на мобильных
      // тап по «Завершить» гасит клавиатуру и blur может прийти уже после
      // клика. Без этого последний подход считался бы несуществующим — и
      // тренировка могла уехать в удаление как пустая.
      for (const key of [...pendingRef.current.keys()]) {
        const [exKey, idx] = key.split(':')
        await persistSet(exKey, Number(idx))
      }

      // Пустышку в дневнике клиента не оставляем. Считаем ПО БАЗЕ, а не по
      // состоянию: состояние могло разойтись с базой, если какая-то запись
      // не прошла. Подходы уйдут сами — внешний ключ workout_sets.workout_id
      // объявлен с ON DELETE CASCADE.
      const { count, error: cErr } = await supabase
        .from('workout_sets').select('id', { count: 'exact', head: true }).eq('workout_id', wid)
      if (cErr) { fail('Не удалось завершить тренировку — проверь связь и нажми «Повторить»', cErr); return }
      if (!count) {
        const { error: dErr } = await supabase.from('workouts').delete().eq('id', wid)
        if (dErr) { fail('Не удалось убрать пустую тренировку', dErr); return }
        pendingRef.current.clear()
        latestRef.current = { ...latestRef.current, workoutId: null }
        setWorkoutId(null)
        onExit()
        return
      }

      const patch = { comment: comment || null, name: name || 'Тренировка с тренером', date }
      // Длительность — минуты с начала сессии, и ТОЛЬКО для новой записи. В
      // режиме правки секундомер не идёт вовсе (см. эффект выше), и время
      // занятия здесь не наше: перезаписав его, мы бы стёрли настоящую
      // длительность прошедшей тренировки.
      if (!editWorkoutId) patch.duration = Math.max(1, Math.round((Date.now() - (startedAtRef.current ?? Date.now())) / 60000))
      const { error } = await supabase.from('workouts').update(patch).eq('id', wid)
      if (error) { fail('Не удалось завершить тренировку — проверь связь и нажми «Повторить»', error); return }
      pendingRef.current.clear()
      setSaveState('saved')
      onExit()
    } finally {
      setFinishing(false)
    }
  }

  // Повтор после ошибки: пере-сохраняем всё, что помечено незаписанным.
  const retry = async () => {
    setSaveError(''); setSaveState('saving')
    const keys = [...pendingRef.current.keys()]
    if (!keys.length) { await ensureWorkout(); setSaveState('saved'); return }
    for (const key of keys) {
      const [exKey, idx] = key.split(':')
      await persistSet(exKey, Number(idx))
    }
  }

  const mmss = s => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
  const clientName = client?.name || 'Клиент'

  // ── Разметка ──────────────────────────────────────────────────────────────
  if (phase === 'loading') return (
    <div style={{ padding:'40px 0', textAlign:'center', color:TXT3, fontSize:13 }}>Загрузка…</div>
  )

  if (phase === 'choose') return (
    <div>
      <button onClick={onExit} style={{ fontSize:12, color:TXT3, border:'none', background:'none', cursor:'pointer', marginBottom:14, padding:0, display:'inline-flex', alignItems:'center', gap:5 }}>
        <GlassIcon name="back" size={16} />Назад
      </button>
      <h2 style={{ fontSize:20, fontWeight:500, color:TXT, margin:'0 0 4px' }}>Тренировка · {clientName}</h2>
      <div style={{ fontSize:12, color:TXT3, marginBottom:16 }}>С чего начнём</div>
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {starters.program && (
          <button onClick={() => startFrom('program')}
            style={{ width:'100%', textAlign:'left', padding:'14px 16px', borderRadius:16, border:`1px solid ${PUR}`, background:`${PUR}18`, color:TXT, cursor:'pointer' }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:3 }}>Взять из программы</div>
            <div style={{ fontSize:12, color:TXT2 }}>
              {starters.program.name || 'Тренировка'} · {(starters.program.exercises || []).length} упр. на сегодня
            </div>
          </button>
        )}
        {starters.last && (
          <button onClick={() => startFrom('last')}
            style={{ width:'100%', textAlign:'left', padding:'14px 16px', borderRadius:16, border:`1px solid ${HAIR}`, background:SURF, color:TXT, cursor:'pointer' }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:3 }}>Повторить прошлую</div>
            <div style={{ fontSize:12, color:TXT2 }}>
              {starters.last.name || 'Тренировка'} · {dateWords(starters.last.date)} — веса подставим, поправишь на ходу
            </div>
          </button>
        )}
        <button onClick={() => { setExercises([]); contentReadyRef.current = true; setPhase('session') }}
          style={{ width:'100%', textAlign:'left', padding:'14px 16px', borderRadius:16, border:`1px solid ${HAIR}`, background:SURF, color:TXT, cursor:'pointer' }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:3 }}>С чистого листа</div>
          <div style={{ fontSize:12, color:TXT2 }}>Добавить упражнения вручную</div>
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ paddingBottom:24 }}>
      {/* Секундомер — только на самом занятии (phase==='session'), не на
          выборе, с чего начать. Закреплён, поэтому не уезжает при прокрутке
          длинного списка упражнений. */}
      <SessionStopwatch />
      {pickerOpen && (
        <ExercisePicker catalogExercises={catalogExercises} onPick={addExercise} onClose={() => setPickerOpen(false)} />
      )}

      {/* Ошибка записи обязана быть заметной: тренер смотрит на клиента, а не
          на экран, и мелкую строчку под шапкой не увидит. */}
      {saveState === 'error' && (
        <div style={{ position:'fixed', top:10, left:'50%', transform:'translateX(-50%)', zIndex:2500, width:'calc(100% - 24px)', maxWidth:420, boxSizing:'border-box', padding:'12px 14px', borderRadius:14, background:'#dc2626', color:'#fff', boxShadow:'0 10px 30px rgba(220,38,38,0.4)' }}>
          <div style={{ fontSize:13, fontWeight:800, marginBottom:2 }}>Запись НЕ сохранена</div>
          <div style={{ fontSize:12, lineHeight:1.4, opacity:0.95 }}>{saveError || 'Проверь связь и нажми «Повторить»'}</div>
          <button onClick={retry}
            style={{ marginTop:8, padding:'7px 14px', fontSize:12, fontWeight:700, borderRadius:9, border:'1px solid rgba(255,255,255,0.6)', background:'rgba(255,255,255,0.15)', color:'#fff', cursor:'pointer' }}>
            Повторить
          </button>
        </div>
      )}

      {/* Шапка закреплена: тренер прокручивает список упражнений, но должен
          всё время видеть, что запись идёт и в базу доходит. */}
      <div style={{ position:'sticky', top:0, zIndex:6, background:BG, paddingBottom:8, marginBottom:6 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
          <button onClick={onExit} style={{ fontSize:12, color:TXT3, border:'none', background:'none', cursor:'pointer', padding:0, display:'inline-flex', alignItems:'center', gap:5, flexShrink:0 }}>
            <GlassIcon name="back" size={16} />Назад
          </button>
          <span style={{ flex:1, minWidth:0, fontSize:14, fontWeight:700, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{clientName}</span>
          {!editWorkoutId && (
            <span style={{ fontSize:13, fontWeight:700, color:TXT2, fontVariantNumeric:'tabular-nums', flexShrink:0 }}>{mmss(elapsed)}</span>
          )}
          <span style={{ fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:20, whiteSpace:'nowrap', flexShrink:0,
            background: saveState === 'error' ? '#fee2e2' : saveState === 'saved' ? '#dcfce7' : SURF2,
            color: saveState === 'error' ? '#b91c1c' : saveState === 'saved' ? '#085041' : TXT3 }}>
            {saveState === 'saving' ? 'Сохраняю…' : saveState === 'saved' ? 'Сохранено' : 'Черновик'}
          </span>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Название"
            onBlur={() => { if (latestRef.current.workoutId) supabase.from('workouts').update({ name: name || 'Тренировка с тренером' }).eq('id', latestRef.current.workoutId).then(({ error }) => error && fail('Название не сохранено', error)) }}
            style={{ flex:1, minWidth:0, padding:'8px 10px', fontSize:13, fontWeight:600, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF2 }} />
          {/* Дату можно менять — тренер записывает и задним числом. Пишем по
              onChange, а не по onBlur: выбор в календаре — законченное
              действие, а blur у date-инпута на мобильных приходит не всегда. */}
          <input type="date" value={date} onChange={e => changeDate(e.target.value)}
            style={{ flexShrink:0, padding:'8px 10px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF2 }} />
        </div>
      </div>

      {exercises.length === 0 && (
        <div style={{ fontSize:13, color:TXT3, textAlign:'center', padding:'22px 0' }}>
          Упражнений пока нет — добавь первое
        </div>
      )}

      {exercises.map(ex => {
        const last = prev[ex.name]
        return (
          <div key={ex.key} style={{ marginBottom:14, background:SURF, borderRadius:20, padding:'12px 14px', border:`1px solid ${HAIR}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8, marginBottom:8 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ex.name}</div>
                {/* Что клиент делал по этому упражнению в прошлый раз — главное,
                    на что тренер смотрит, назначая вес. */}
                <div style={{ fontSize:11.5, color:last ? TXT2 : TXT3, marginTop:3, lineHeight:1.35 }}>
                  {last ? `В прошлый раз: ${last.text} · ${dateWords(last.date)}` : 'Раньше не делал'}
                </div>
              </div>
              <button onClick={() => removeExercise(ex.key)}
                style={{ width:26, height:26, flexShrink:0, borderRadius:6, border:'none', background:SURF2, color:TXT3, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center' }}>🗑</button>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 20px', gap:5, marginBottom:5 }}>
              {['#','КГ','ПОВТ',''].map((h, i) => (
                <span key={i} style={{ fontSize:11, fontWeight:700, color:TXT2, textAlign:'center', textTransform:'uppercase', letterSpacing:'.06em' }}>{h}</span>
              ))}
            </div>
            {ex.sets.map((s, si) => (
              <div key={si} style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 20px', gap:5, alignItems:'center', marginBottom:5 }}>
                <span style={{ fontSize:12, color:TXT3, textAlign:'center', fontWeight:700 }}>{si + 1}</span>
                <input value={s.kg} inputMode="decimal" placeholder="0"
                  onChange={e => setField(ex.key, si, 'kg', e.target.value)}
                  onBlur={() => persistSet(ex.key, si)}
                  style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'8px 6px', fontSize:18, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                <input value={s.reps} inputMode="decimal" placeholder="0"
                  onChange={e => setField(ex.key, si, 'reps', e.target.value)}
                  onBlur={() => persistSet(ex.key, si)}
                  style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'8px 6px', fontSize:18, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                {ex.sets.length > 1
                  ? <button onClick={() => removeSet(ex.key, si)} style={{ background:'none', border:'none', color:TXT3, cursor:'pointer', textAlign:'center', padding:0 }}><GlassIcon name="close" size={22} /></button>
                  : <span />}
              </div>
            ))}
            <button onClick={() => addSet(ex.key)}
              style={{ fontSize:12, color:PUR, background:'none', border:'none', cursor:'pointer', fontWeight:600, padding:0, marginTop:6 }}>
              + подход
            </button>
            <textarea value={ex.note} rows={2} placeholder="Заметка к упражнению"
              onChange={e => setExercises(list => list.map(x => x.key === ex.key ? { ...x, note: e.target.value } : x))}
              onBlur={() => persistNote(ex.key)}
              style={{ width:'100%', marginTop:10, padding:'8px 10px', fontSize:12, borderRadius:8, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF2, resize:'vertical', fontFamily:'inherit' }} />
          </div>
        )
      })}

      <button onClick={() => setPickerOpen(true)}
        style={{ width:'100%', padding:'12px', fontSize:13, color:PUR, background:`${PUR}10`, border:`1px dashed ${PUR}55`, borderRadius:12, cursor:'pointer', fontWeight:700, marginBottom:14 }}>
        + Упражнение
      </button>

      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Комментарий к тренировке</div>
        <textarea value={comment} rows={2} placeholder="Как прошло занятие"
          onChange={e => setComment(e.target.value)}
          onBlur={() => { const wid = latestRef.current.workoutId; if (wid) supabase.from('workouts').update({ comment: comment || null }).eq('id', wid).then(({ error }) => error && fail('Комментарий не сохранён', error)) }}
          style={{ width:'100%', padding:'9px 11px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF2, resize:'vertical', fontFamily:'inherit' }} />
      </div>

      <button onClick={finish} disabled={finishing}
        style={{ width:'100%', padding:'14px', fontSize:15, borderRadius:14, border:'none', background: finishing ? SURF2 : `linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontWeight:800, cursor: finishing ? 'default' : 'pointer', boxShadow:'0 8px 22px rgba(124,122,240,.4)' }}>
        {finishing ? 'Сохраняем…' : 'Завершить'}
      </button>
      <div style={{ fontSize:11, color:TXT3, textAlign:'center', marginTop:8, lineHeight:1.4 }}>
        Подходы уже записаны в дневник клиента — «Завершить» добавит длительность и комментарий
      </div>
    </div>
  )
}
