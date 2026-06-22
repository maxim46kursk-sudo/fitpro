import { useState, useEffect, useRef } from 'react'

// ── Палитра (белый стиль FitSession)
const AC   = '#6366f1'   // accent indigo
const AC_L = '#eef2ff'   // accent light bg
const GR   = '#10b981'   // green (done)
const GR_L = '#ecfdf5'   // green light bg
const TX   = '#111827'   // primary text
const TX2  = '#6b7280'   // secondary text
const TX3  = '#d1d5db'   // tertiary / disabled
const BD   = '#e5e7eb'   // border
const BG   = '#f9fafb'   // background
const WH   = '#ffffff'   // white

// ── Дефолтные упражнения (используются если пропсы не переданы)
const DEFAULT_EXERCISES = [
  { name:'Жим штанги лёжа',      muscle:'Грудь',    totalSets:4, reps:'8–10',  restSec:90,  defaultKg:60 },
  { name:'Разведение гантелей',   muscle:'Грудь',    totalSets:3, reps:'12–15', restSec:60,  defaultKg:18 },
  { name:'Тяга штанги в наклоне', muscle:'Спина',    totalSets:4, reps:'8–10',  restSec:90,  defaultKg:55 },
  { name:'Подтягивания',          muscle:'Спина',    totalSets:3, reps:'8–12',  restSec:90,  defaultKg:0  },
  { name:'Жим гантелей сидя',     muscle:'Плечи',    totalSets:3, reps:'10–12', restSec:60,  defaultKg:16 },
]

function fmt(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

// ── Экран завершения
function CompleteScreen({ elapsed, exercises, setsData, onFinish }) {
  const totalMin = Math.floor(elapsed / 60)
  const doneSetsAll = setsData.reduce((sum, sets) => sum + sets.filter(s => s.done).length, 0)
  const totalSetsAll = exercises.reduce((sum, ex) => sum + ex.totalSets, 0)

  return (
    <div style={{ minHeight:'100vh', background:WH, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'32px 20px', fontFamily:'"Inter",system-ui,sans-serif' }}>
      <div style={{ width:'100%', maxWidth:420 }}>

        {/* Иконка */}
        <div style={{ textAlign:'center', marginBottom:36 }}>
          <div style={{
            width:88, height:88, borderRadius:'50%', background:GR_L,
            display:'flex', alignItems:'center', justifyContent:'center',
            margin:'0 auto 20px', fontSize:38, color:GR,
            boxShadow:`0 0 0 12px ${GR_L}`,
          }}>✓</div>
          <h1 style={{ fontSize:28, fontWeight:800, color:TX, margin:'0 0 8px', letterSpacing:'-0.03em' }}>
            Тренировка завершена!
          </h1>
          <p style={{ fontSize:15, color:TX2, margin:0 }}>Отличная работа. Так держать!</p>
        </div>

        {/* Статистика */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:24 }}>
          {[
            { label:'Время',       value:`${totalMin} мин` },
            { label:'Подходов',    value:`${doneSetsAll}/${totalSetsAll}` },
            { label:'Упражнений',  value:exercises.length },
          ].map(s => (
            <div key={s.label} style={{ background:BG, border:`1px solid ${BD}`, borderRadius:14, padding:'16px 10px', textAlign:'center' }}>
              <div style={{ fontSize:22, fontWeight:800, color:TX, letterSpacing:'-0.02em', marginBottom:4 }}>{s.value}</div>
              <div style={{ fontSize:10, color:TX2, textTransform:'uppercase', letterSpacing:'0.06em' }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Итоги по упражнениям */}
        <div style={{ background:BG, border:`1px solid ${BD}`, borderRadius:16, padding:'18px 20px', marginBottom:24 }}>
          <div style={{ fontSize:11, fontWeight:700, color:TX2, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:14 }}>
            Итоги
          </div>
          {exercises.map((ex, ei) => {
            const done = setsData[ei].filter(s => s.done).length
            return (
              <div key={ei} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom: ei < exercises.length-1 ? `1px solid ${BD}` : 'none' }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:600, color:TX }}>{ex.name}</div>
                  <div style={{ fontSize:11, color:TX2, marginTop:2 }}>{ex.muscle}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <span style={{ fontSize:13, fontWeight:700, color: done === ex.totalSets ? GR : TX2 }}>
                    {done}/{ex.totalSets} подх.
                  </span>
                  {setsData[ei].some(s => s.done && s.kg) && (
                    <div style={{ fontSize:11, color:TX2, marginTop:1 }}>
                      {setsData[ei].filter(s => s.done && s.kg).map(s => `${s.kg}кг×${s.reps||'?'}`).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <button onClick={onFinish} style={{
          width:'100%', padding:'17px', background:AC, color:WH,
          border:'none', borderRadius:16, fontSize:16, fontWeight:800,
          cursor:'pointer', letterSpacing:'-0.01em',
          boxShadow:`0 8px 24px ${AC}40`,
        }}>
          Готово
        </button>
      </div>
    </div>
  )
}

// ── Экран отдыха
function RestScreen({ restLeft, restTotal, elapsed, workoutName, currentEx, setIdx, nextLabel, onSkip, onAddTime }) {
  const pct = restTotal > 0 ? restLeft / restTotal : 0
  const R = 90
  const C = 2 * Math.PI * R

  return (
    <div style={{ minHeight:'100vh', background:WH, display:'flex', flexDirection:'column', fontFamily:'"Inter",system-ui,sans-serif' }}>

      {/* Шапка */}
      <div style={{ padding:'18px 24px', display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:`1px solid ${BD}` }}>
        <div>
          <div style={{ fontSize:10, color:TX2, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:3 }}>Отдых</div>
          <div style={{ fontSize:14, fontWeight:700, color:TX }}>{workoutName}</div>
        </div>
        <div style={{ fontSize:15, fontWeight:700, color:TX2, fontVariantNumeric:'tabular-nums' }}>{fmt(elapsed)}</div>
      </div>

      <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 24px' }}>

        {/* Кольцо таймера */}
        <div style={{ position:'relative', width:220, height:220, marginBottom:36 }}>
          <svg width="220" height="220" viewBox="0 0 220 220">
            <circle cx="110" cy="110" r={R} fill="none" stroke={BD} strokeWidth="10" />
            <circle
              cx="110" cy="110" r={R} fill="none" stroke={AC} strokeWidth="10"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct)}
              strokeLinecap="round"
              transform="rotate(-90 110 110)"
              style={{ transition:'stroke-dashoffset 1s linear' }}
            />
          </svg>
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
            <div style={{ fontSize:52, fontWeight:800, color:TX, letterSpacing:'-0.04em', fontVariantNumeric:'tabular-nums', lineHeight:1 }}>
              {fmt(restLeft)}
            </div>
            <div style={{ fontSize:11, color:TX2, textTransform:'uppercase', letterSpacing:'0.08em', marginTop:8 }}>отдых</div>
          </div>
        </div>

        {/* Текущее */}
        <div style={{ textAlign:'center', marginBottom:20 }}>
          <div style={{ fontSize:13, color:TX2, marginBottom:4 }}>
            Подход {setIdx + 1} из {currentEx.totalSets} выполнен
          </div>
          <div style={{ fontSize:17, fontWeight:800, color:TX, letterSpacing:'-0.02em' }}>{currentEx.name}</div>
        </div>

        {/* Следующее */}
        {nextLabel && (
          <div style={{ background:BG, border:`1px solid ${BD}`, borderRadius:12, padding:'12px 20px', textAlign:'center', marginBottom:32, minWidth:240 }}>
            <div style={{ fontSize:10, color:TX2, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Следующее</div>
            <div style={{ fontSize:14, fontWeight:600, color:TX }}>{nextLabel}</div>
          </div>
        )}

        {/* Добавить время */}
        <div style={{ display:'flex', gap:8, marginBottom:20 }}>
          {[15,30,60].map(sec => (
            <button key={sec} onClick={() => onAddTime(sec)} style={{
              padding:'8px 16px', fontSize:12, fontWeight:700, borderRadius:10,
              border:`1px solid ${BD}`, background:WH, color:TX2, cursor:'pointer',
            }}>+{sec}с</button>
          ))}
        </div>

        {/* Пропустить */}
        <button onClick={onSkip} style={{
          padding:'14px 52px', background:AC, color:WH,
          border:'none', borderRadius:14, fontSize:15, fontWeight:800,
          cursor:'pointer', boxShadow:`0 8px 24px ${AC}33`,
        }}>
          Пропустить →
        </button>
      </div>
    </div>
  )
}

// ── Главный компонент
export default function WorkoutSession({
  exercises = DEFAULT_EXERCISES,
  workoutName = 'Тренировка',
  onFinish = () => {},
}) {
  // phase: 'workout' | 'rest' | 'complete'
  const [phase, setPhase]     = useState('workout')
  const [exIdx, setExIdx]     = useState(0)
  const [setIdx, setSetIdx]   = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [restLeft, setRestLeft] = useState(0)
  const [restTotal, setRestTotal] = useState(0)

  // Данные подходов: setsData[exIdx][setIdx] = { kg, reps, done }
  const [setsData, setSetsData] = useState(() =>
    exercises.map(ex =>
      Array.from({ length: ex.totalSets }, () => ({ kg: String(ex.defaultKg || ''), reps: '', done: false }))
    )
  )

  // Сохраняем следующий экс/подход в ref чтобы избежать stale closure в таймере
  const nextRef = useRef({ exIdx: 0, setIdx: 0 })

  // Общий таймер
  useEffect(() => {
    if (phase === 'complete') return
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  // Таймер отдыха
  useEffect(() => {
    if (phase !== 'rest') return
    if (restLeft <= 0) {
      advance()
      return
    }
    const t = setTimeout(() => setRestLeft(r => r - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, restLeft])

  const advance = () => {
    const { exIdx: nei, setIdx: nsi } = nextRef.current
    setExIdx(nei)
    setSetIdx(nsi)
    setPhase('workout')
  }

  const updateSet = (field, value) => {
    setSetsData(prev => prev.map((sets, ei) =>
      ei !== exIdx ? sets : sets.map((s, si) => si !== setIdx ? s : { ...s, [field]: value })
    ))
  }

  const markSetDone = () => {
    // Вычисляем следующий подход/упражнение
    let nei = exIdx, nsi = setIdx + 1
    if (nsi >= exercises[exIdx].totalSets) { nei++; nsi = 0 }
    nextRef.current = { exIdx: nei, setIdx: nsi }

    // Помечаем выполненным
    setSetsData(prev => prev.map((sets, ei) =>
      ei !== exIdx ? sets : sets.map((s, si) => si !== setIdx ? s : { ...s, done: true })
    ))

    if (nei >= exercises.length) {
      setPhase('complete')
      return
    }

    // Запускаем отдых
    const rest = exercises[exIdx].restSec || 60
    setRestTotal(rest)
    setRestLeft(rest)
    setPhase('rest')
  }

  const currentEx   = exercises[exIdx]
  const currentSets = setsData[exIdx]
  const currentSet  = currentSets[setIdx]
  const doneSetsAll = setsData.reduce((sum, sets) => sum + sets.filter(s => s.done).length, 0)
  const totalSetsAll = exercises.reduce((sum, ex) => sum + ex.totalSets, 0)
  const doneInEx    = currentSets.filter(s => s.done).length

  // Подпись следующего
  const getNextLabel = () => {
    const { exIdx: nei, setIdx: nsi } = nextRef.current
    if (nei >= exercises.length) return null
    const nextEx = exercises[nei]
    if (nei === exIdx) return `${nextEx.name} · Подход ${nsi + 1} · ${nextEx.reps} повт.`
    return `${nextEx.name} — новое упражнение`
  }

  // ── Complete
  if (phase === 'complete') {
    return <CompleteScreen elapsed={elapsed} exercises={exercises} setsData={setsData} onFinish={onFinish} />
  }

  // ── Rest
  if (phase === 'rest') {
    return (
      <RestScreen
        restLeft={restLeft}
        restTotal={restTotal}
        elapsed={elapsed}
        workoutName={workoutName}
        currentEx={currentEx}
        setIdx={setIdx}
        nextLabel={getNextLabel()}
        onSkip={() => { setRestLeft(0) }}
        onAddTime={sec => { setRestLeft(r => r + sec); setRestTotal(t => t + sec) }}
      />
    )
  }

  // ── Workout (основной экран)
  const inputStyle = {
    padding:'10px 8px', textAlign:'center', fontSize:16, fontWeight:700, color:TX,
    border:`2px solid ${AC}`, borderRadius:10, background:AC_L, outline:'none',
    width:'100%', boxSizing:'border-box', fontFamily:'inherit',
  }
  const inputDisabled = {
    padding:'10px 8px', textAlign:'center', fontSize:15, fontWeight:600, color:TX3,
    border:`1px solid ${BD}`, borderRadius:10, background:BG, outline:'none',
    width:'100%', boxSizing:'border-box', fontFamily:'inherit',
  }

  return (
    <div style={{ minHeight:'100vh', background:WH, display:'flex', flexDirection:'column', fontFamily:'"Inter",system-ui,sans-serif' }}>

      {/* ── Шапка */}
      <div style={{ padding:'18px 24px', display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:`1px solid ${BD}`, background:WH }}>
        <div>
          <div style={{ fontSize:10, color:TX2, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:3 }}>Тренировка</div>
          <div style={{ fontSize:15, fontWeight:700, color:TX }}>{workoutName}</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <div style={{ fontSize:18, fontWeight:800, color:TX, fontVariantNumeric:'tabular-nums' }}>{fmt(elapsed)}</div>
          <button
            onClick={() => { if (window.confirm('Выйти из тренировки?')) onFinish() }}
            style={{ fontSize:12, color:TX2, background:'none', border:`1px solid ${BD}`, borderRadius:8, padding:'5px 12px', cursor:'pointer', fontWeight:600 }}>
            Выйти
          </button>
        </div>
      </div>

      {/* ── Прогресс-полоски упражнений */}
      <div style={{ padding:'14px 24px 12px', background:BG, borderBottom:`1px solid ${BD}` }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <span style={{ fontSize:12, fontWeight:600, color:TX2 }}>
            Упражнение {exIdx + 1} / {exercises.length}
          </span>
          <span style={{ fontSize:12, fontWeight:700, color:AC }}>
            {doneSetsAll} / {totalSetsAll} подходов
          </span>
        </div>
        <div style={{ display:'flex', gap:5 }}>
          {exercises.map((ex, i) => {
            const done = setsData[i].filter(s => s.done).length
            const pct = i < exIdx ? 100 : i === exIdx ? Math.round((done / ex.totalSets) * 100) : 0
            return (
              <div key={i} style={{ flex:1, height:4, borderRadius:4, background:BD, overflow:'hidden', cursor:'pointer' }} onClick={() => { setExIdx(i); setSetIdx(0) }}>
                <div style={{ height:'100%', width:`${pct}%`, background: i < exIdx ? GR : AC, borderRadius:4, transition:'width 0.4s' }} />
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Контент */}
      <div style={{ flex:1, overflowY:'auto', padding:'28px 24px 16px' }}>

        {/* Упражнение */}
        <div style={{ marginBottom:28 }}>
          <span style={{ fontSize:11, color:AC, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.1em', display:'block', marginBottom:8 }}>
            {currentEx.muscle}
          </span>
          <h2 style={{ fontSize:26, fontWeight:800, color:TX, margin:'0 0 6px', letterSpacing:'-0.03em', lineHeight:1.15 }}>
            {currentEx.name}
          </h2>
          <div style={{ fontSize:13, color:TX2 }}>
            {currentEx.totalSets} подхода · {currentEx.reps} повт. · отдых {currentEx.restSec}с
          </div>
        </div>

        {/* Таблица подходов */}
        <div style={{ marginBottom:28 }}>
          {/* Заголовки */}
          <div style={{ display:'grid', gridTemplateColumns:'36px 1fr 1fr 72px', gap:8, marginBottom:8, paddingBottom:8, borderBottom:`1px solid ${BD}` }}>
            {['#','КГ','ПОВТ','ПЛАН'].map((h, i) => (
              <div key={i} style={{ fontSize:10, color:TX2, textAlign:'center', textTransform:'uppercase', letterSpacing:'0.08em', fontWeight:700 }}>{h}</div>
            ))}
          </div>

          {currentSets.map((set, si) => {
            const isCurrent = si === setIdx
            const isDone    = set.done
            const isFuture  = si > setIdx && !isDone

            return (
              <div
                key={si}
                onClick={() => { if (!isDone) setSetIdx(si) }}
                style={{
                  display:'grid', gridTemplateColumns:'36px 1fr 1fr 72px', gap:8,
                  alignItems:'center', marginBottom:8, padding:'6px 0',
                  opacity: isFuture ? 0.4 : 1,
                  cursor: !isDone && !isCurrent ? 'pointer' : 'default',
                }}
              >
                {/* Номер / чек */}
                <div style={{
                  width:30, height:30, borderRadius:'50%', margin:'0 auto',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:13, fontWeight:700,
                  background: isDone ? GR_L : isCurrent ? AC_L : BG,
                  color: isDone ? GR : isCurrent ? AC : TX2,
                  border: `2px solid ${isDone ? GR : isCurrent ? AC : BD}`,
                  transition:'all 0.2s',
                }}>
                  {isDone ? '✓' : si + 1}
                </div>

                {/* Вес */}
                {isCurrent ? (
                  <input
                    type="number" value={set.kg}
                    onChange={e => updateSet('kg', e.target.value)}
                    placeholder="–"
                    style={inputStyle}
                  />
                ) : (
                  <div style={{ ...inputDisabled, background: isDone ? GR_L : BG, color: isDone ? TX : TX3, border:`1px solid ${isDone ? GR+'44' : BD}` }}>
                    {set.kg || '–'}
                  </div>
                )}

                {/* Повторения */}
                {isCurrent ? (
                  <input
                    type="number" value={set.reps}
                    onChange={e => updateSet('reps', e.target.value)}
                    placeholder="–"
                    style={inputStyle}
                  />
                ) : (
                  <div style={{ ...inputDisabled, background: isDone ? GR_L : BG, color: isDone ? TX : TX3, border:`1px solid ${isDone ? GR+'44' : BD}` }}>
                    {set.reps || '–'}
                  </div>
                )}

                {/* Плановые повторения */}
                <div style={{ textAlign:'center', fontSize:13, color:TX2, fontWeight:600, background:BG, border:`1px solid ${BD}`, borderRadius:10, padding:'10px 4px' }}>
                  {currentEx.reps}
                </div>
              </div>
            )
          })}
        </div>

        {/* Навигация по упражнениям */}
        <div style={{ display:'flex', justifyContent:'space-between', gap:10 }}>
          <button
            onClick={() => {
              if (setIdx > 0) { setSetIdx(s => s - 1) }
              else if (exIdx > 0) { setExIdx(e => e - 1); setSetIdx(exercises[exIdx-1].totalSets - 1) }
            }}
            disabled={exIdx === 0 && setIdx === 0}
            style={{ flex:1, padding:'10px', fontSize:13, fontWeight:600, color:TX2, background:BG, border:`1px solid ${BD}`, borderRadius:10, cursor:'pointer', opacity: exIdx===0 && setIdx===0 ? 0.3 : 1 }}>
            ← Предыдущий
          </button>
          <button
            onClick={() => {
              if (setIdx < exercises[exIdx].totalSets - 1) { setSetIdx(s => s + 1) }
              else if (exIdx < exercises.length - 1) { setExIdx(e => e + 1); setSetIdx(0) }
            }}
            disabled={exIdx === exercises.length-1 && setIdx === exercises[exIdx].totalSets-1}
            style={{ flex:1, padding:'10px', fontSize:13, fontWeight:600, color:TX2, background:BG, border:`1px solid ${BD}`, borderRadius:10, cursor:'pointer', opacity: exIdx===exercises.length-1 && setIdx===exercises[exIdx].totalSets-1 ? 0.3 : 1 }}>
            Следующий →
          </button>
        </div>
      </div>

      {/* ── Кнопка выполнено */}
      <div style={{ padding:'16px 24px', borderTop:`1px solid ${BD}`, background:WH }}>
        {/* Индикаторы подходов */}
        <div style={{ display:'flex', justifyContent:'center', gap:6, marginBottom:14 }}>
          {currentSets.map((s, i) => (
            <div key={i} style={{
              width: i === setIdx ? 20 : 8, height:8, borderRadius:8, transition:'all 0.3s',
              background: s.done ? GR : i === setIdx ? AC : BD,
            }} />
          ))}
        </div>

        <button
          onClick={markSetDone}
          style={{
            width:'100%', padding:'18px', background:AC, color:WH,
            border:'none', borderRadius:16, fontSize:17, fontWeight:800,
            cursor:'pointer', letterSpacing:'-0.01em',
            boxShadow:`0 8px 28px ${AC}40`,
            display:'flex', alignItems:'center', justifyContent:'center', gap:10,
          }}
        >
          <span>Подход выполнен</span>
          <span style={{ fontSize:22, lineHeight:1 }}>✓</span>
        </button>
      </div>
    </div>
  )
}
