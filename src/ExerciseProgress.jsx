import { useState } from 'react'

const PUR = '#7F77DD'

const DATA = {
  'Жим штанги лёжа': [
    { date:'2026-05-05', workout:'Силовая A', sets:[{kg:60,reps:10},{kg:60,reps:8},{kg:65,reps:6},{kg:65,reps:6}] },
    { date:'2026-05-12', workout:'Силовая A', sets:[{kg:65,reps:10},{kg:65,reps:8},{kg:70,reps:6},{kg:70,reps:6}] },
    { date:'2026-05-19', workout:'Силовая A', sets:[{kg:70,reps:10},{kg:70,reps:8},{kg:72.5,reps:6},{kg:72.5,reps:6}] },
    { date:'2026-05-26', workout:'Силовая A', sets:[{kg:72.5,reps:10},{kg:72.5,reps:8},{kg:75,reps:6},{kg:75,reps:6}] },
    { date:'2026-06-02', workout:'Силовая A', sets:[{kg:75,reps:10},{kg:75,reps:8},{kg:77.5,reps:6},{kg:77.5,reps:6}] },
    { date:'2026-06-09', workout:'Силовая A', sets:[{kg:77.5,reps:10},{kg:77.5,reps:8},{kg:80,reps:6},{kg:80,reps:6}] },
    { date:'2026-06-16', workout:'Силовая A', sets:[{kg:80,reps:10},{kg:80,reps:8},{kg:82.5,reps:6},{kg:82.5,reps:6}] },
  ],
  'Приседания со штангой': [
    { date:'2026-05-07', workout:'Силовая B', sets:[{kg:80,reps:10},{kg:80,reps:8},{kg:90,reps:6},{kg:90,reps:5}] },
    { date:'2026-05-14', workout:'Силовая B', sets:[{kg:85,reps:10},{kg:85,reps:8},{kg:90,reps:6},{kg:90,reps:6}] },
    { date:'2026-05-21', workout:'Силовая B', sets:[{kg:90,reps:10},{kg:90,reps:8},{kg:95,reps:6},{kg:95,reps:5}] },
    { date:'2026-05-28', workout:'Силовая B', sets:[{kg:90,reps:10},{kg:92.5,reps:8},{kg:95,reps:6},{kg:95,reps:6}] },
    { date:'2026-06-04', workout:'Силовая B', sets:[{kg:95,reps:10},{kg:95,reps:8},{kg:100,reps:6},{kg:100,reps:5}] },
    { date:'2026-06-11', workout:'Силовая B', sets:[{kg:95,reps:10},{kg:97.5,reps:8},{kg:100,reps:6},{kg:100,reps:6}] },
    { date:'2026-06-18', workout:'Силовая B', sets:[{kg:100,reps:10},{kg:100,reps:8},{kg:102.5,reps:6},{kg:102.5,reps:6}] },
  ],
  'Тяга штанги в наклоне': [
    { date:'2026-05-05', workout:'Силовая A', sets:[{kg:70,reps:10},{kg:70,reps:8},{kg:75,reps:6},{kg:75,reps:6}] },
    { date:'2026-05-12', workout:'Силовая A', sets:[{kg:75,reps:10},{kg:75,reps:8},{kg:80,reps:6},{kg:80,reps:6}] },
    { date:'2026-05-19', workout:'Силовая A', sets:[{kg:80,reps:10},{kg:80,reps:8},{kg:82.5,reps:6},{kg:82.5,reps:6}] },
    { date:'2026-05-26', workout:'Силовая A', sets:[{kg:82.5,reps:10},{kg:82.5,reps:8},{kg:85,reps:6},{kg:85,reps:6}] },
    { date:'2026-06-02', workout:'Силовая A', sets:[{kg:85,reps:10},{kg:85,reps:8},{kg:87.5,reps:6},{kg:87.5,reps:6}] },
    { date:'2026-06-09', workout:'Силовая A', sets:[{kg:87.5,reps:10},{kg:87.5,reps:8},{kg:90,reps:6},{kg:90,reps:6}] },
    { date:'2026-06-16', workout:'Силовая A', sets:[{kg:90,reps:10},{kg:90,reps:8},{kg:92.5,reps:6},{kg:92.5,reps:6}] },
  ],
  'Подтягивания': [
    { date:'2026-05-07', workout:'Силовая B', sets:[{kg:75,reps:8},{kg:75,reps:6},{kg:75,reps:5},{kg:75,reps:4}] },
    { date:'2026-05-14', workout:'Силовая B', sets:[{kg:75,reps:10},{kg:80,reps:6},{kg:80,reps:6},{kg:80,reps:5}] },
    { date:'2026-05-21', workout:'Силовая B', sets:[{kg:80,reps:10},{kg:80,reps:8},{kg:85,reps:6},{kg:85,reps:5}] },
    { date:'2026-05-28', workout:'Силовая B', sets:[{kg:80,reps:10},{kg:85,reps:8},{kg:85,reps:6},{kg:90,reps:4}] },
    { date:'2026-06-04', workout:'Силовая B', sets:[{kg:80,reps:12},{kg:85,reps:8},{kg:90,reps:6},{kg:90,reps:5}] },
    { date:'2026-06-11', workout:'Силовая B', sets:[{kg:80,reps:12},{kg:85,reps:8},{kg:90,reps:6},{kg:90,reps:6}] },
    { date:'2026-06-18', workout:'Силовая B', sets:[{kg:85,reps:10},{kg:90,reps:8},{kg:92,reps:6},{kg:95,reps:4}] },
  ],
  'Жим гантелей сидя': [
    { date:'2026-05-02', workout:'Силовая C', sets:[{kg:20,reps:12},{kg:22.5,reps:10},{kg:22.5,reps:8},{kg:25,reps:6}] },
    { date:'2026-05-09', workout:'Силовая C', sets:[{kg:22.5,reps:12},{kg:25,reps:10},{kg:25,reps:8},{kg:27.5,reps:6}] },
    { date:'2026-05-16', workout:'Силовая C', sets:[{kg:25,reps:12},{kg:27.5,reps:10},{kg:27.5,reps:8},{kg:30,reps:6}] },
    { date:'2026-05-23', workout:'Силовая C', sets:[{kg:25,reps:12},{kg:27.5,reps:10},{kg:30,reps:8},{kg:30,reps:6}] },
    { date:'2026-05-30', workout:'Силовая C', sets:[{kg:27.5,reps:12},{kg:30,reps:10},{kg:30,reps:8},{kg:32.5,reps:6}] },
    { date:'2026-06-06', workout:'Силовая C', sets:[{kg:30,reps:12},{kg:32.5,reps:10},{kg:32.5,reps:8},{kg:35,reps:6}] },
    { date:'2026-06-13', workout:'Силовая C', sets:[{kg:30,reps:12},{kg:32.5,reps:10},{kg:35,reps:8},{kg:35,reps:6}] },
  ],
}

const ton = sets => sets.reduce((s, x) => s + x.kg * x.reps, 0)

const fmtShort = d =>
  new Date(d).toLocaleDateString('ru', { day:'numeric', month:'short' }).replace(/\./g,'')

const fmtFull = d =>
  new Date(d).toLocaleDateString('ru', { day:'numeric', month:'long', year:'numeric' })

const CHART_H = 190
const BAR_AREA_H = CHART_H - 26 // leave room for tonnage label above

export default function ExerciseProgress() {
  const [query, setQuery] = useState('')
  const [selectedEx, setSelectedEx] = useState(null)
  const [activeBar, setActiveBar] = useState(null)

  const exercises = Object.keys(DATA)
  const filtered = exercises.filter(n => n.toLowerCase().includes(query.toLowerCase()))

  // ── Exercise detail view
  if (selectedEx) {
    const sessions = DATA[selectedEx]
    const tons = sessions.map(s => ton(s.sets))
    const maxTon = Math.max(...tons)
    const active = activeBar !== null ? sessions[activeBar] : null
    const activeTon = activeBar !== null ? tons[activeBar] : 0

    return (
      <div style={{ fontFamily:'system-ui,sans-serif', background:'#fff', minHeight:'100vh', padding:'20px 24px', maxWidth:760 }}>
        <button
          onClick={() => { setSelectedEx(null); setActiveBar(null) }}
          style={{ fontSize:13, color:'#6b7280', border:'none', background:'none', cursor:'pointer', padding:0, marginBottom:22, display:'flex', alignItems:'center', gap:5 }}>
          ← Все упражнения
        </button>

        <h2 style={{ fontSize:22, fontWeight:600, color:'#111', margin:'0 0 28px' }}>{selectedEx}</h2>

        {/* ── Bar chart */}
        <div style={{ position:'relative' }}>
          {/* Bars */}
          <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:CHART_H }}>
            {sessions.map((s, i) => {
              const t = tons[i]
              const barH = maxTon > 0 ? Math.max(14, Math.round((t / maxTon) * BAR_AREA_H)) : 14
              const on = activeBar === i
              return (
                <div key={i}
                  onClick={() => setActiveBar(on ? null : i)}
                  style={{ flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end', alignItems:'center', height:'100%', cursor:'pointer', minWidth:0 }}>
                  {/* Tonnage number above bar */}
                  <div style={{
                    fontSize:10, fontWeight: on ? 700 : 500,
                    color: on ? PUR : '#9ca3af',
                    marginBottom:4, textAlign:'center', lineHeight:1, whiteSpace:'nowrap',
                  }}>
                    {t}
                  </div>
                  {/* Bar */}
                  <div style={{
                    width:'72%', height:barH,
                    background: on ? PUR : `${PUR}38`,
                    borderRadius:'4px 4px 0 0',
                    transition:'background 0.12s, height 0.12s',
                  }} />
                </div>
              )
            })}
          </div>

          {/* Baseline */}
          <div style={{ borderTop:`2px solid #e5e7eb`, marginTop:0 }} />

          {/* Date labels */}
          <div style={{ display:'flex', gap:6, paddingTop:6 }}>
            {sessions.map((s, i) => (
              <div key={i} style={{ flex:1, textAlign:'center', fontSize:10, color: activeBar===i ? PUR : '#9ca3af', fontWeight: activeBar===i ? 600 : 400 }}>
                {fmtShort(s.date)}
              </div>
            ))}
          </div>
        </div>

        {/* ── Session detail */}
        <div style={{ marginTop:24 }}>
          {active ? (
            <div>
              {/* Date + workout */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:16, fontWeight:600, color:'#111' }}>{fmtFull(active.date)}</div>
                <div style={{ fontSize:13, color:'#9ca3af', marginTop:2 }}>{active.workout}</div>
              </div>

              {/* 3 stat cards */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
                {[
                  { label:'Общий тоннаж', value:`${activeTon} кг`, accent:true },
                  { label:'Макс. вес', value:`${Math.max(...active.sets.map(s=>s.kg))} кг`, accent:false },
                  { label:'Подходов', value:active.sets.length, accent:false },
                ].map(c=>(
                  <div key={c.label} style={{ background:'#f9fafb', borderRadius:10, padding:'12px 14px' }}>
                    <div style={{ fontSize:11, color:'#9ca3af', marginBottom:6 }}>{c.label}</div>
                    <div style={{ fontSize:20, fontWeight:700, color: c.accent ? PUR : '#111' }}>{c.value}</div>
                  </div>
                ))}
              </div>

              {/* Sets list */}
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {active.sets.map((s, si) => {
                  const setTon = s.kg * s.reps
                  return (
                    <div key={si} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'11px 14px', background:'#f9fafb', borderRadius:9 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:16 }}>
                        <span style={{ fontSize:11, fontWeight:600, color:'#d1d5db', width:18, textAlign:'center' }}>{si + 1}</span>
                        <span style={{ fontSize:14, fontWeight:600, color:'#111' }}>{s.kg} кг</span>
                        <span style={{ fontSize:13, color:'#9ca3af' }}>× {s.reps} повт.</span>
                      </div>
                      <span style={{ fontSize:13, fontWeight:600, color:PUR }}>{setTon} кг</span>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div style={{ textAlign:'center', paddingTop:8, color:'#c7cad1', fontSize:13 }}>
              Нажмите на столбик, чтобы увидеть детали
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Exercise list view
  return (
    <div style={{ fontFamily:'system-ui,sans-serif', background:'#fff', minHeight:'100vh', padding:'20px 24px', maxWidth:760 }}>
      <h2 style={{ fontSize:20, fontWeight:600, color:'#111', margin:'0 0 16px' }}>Прогресс упражнений</h2>

      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Поиск упражнения..."
        style={{ width:'100%', padding:'10px 14px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', boxSizing:'border-box', outline:'none', marginBottom:8, color:'#111' }}
        onFocus={e => e.target.style.borderColor = PUR}
        onBlur={e => e.target.style.borderColor = '#e5e7eb'}
      />

      <div style={{ display:'flex', flexDirection:'column' }}>
        {filtered.map(name => {
          const sessions = DATA[name]
          const last = sessions[sessions.length - 1]
          const lastTon = ton(last.sets)
          const firstTon = ton(sessions[0].sets)
          const growth = lastTon - firstTon
          const maxKg = Math.max(...last.sets.map(s => s.kg))

          return (
            <button key={name}
              onClick={() => { setSelectedEx(name); setActiveBar(null) }}
              style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 4px', background:'none', border:'none', borderBottom:'1px solid #f3f4f6', cursor:'pointer', textAlign:'left', width:'100%' }}
              onMouseEnter={e => e.currentTarget.style.background='#fafafa'}
              onMouseLeave={e => e.currentTarget.style.background='none'}>
              <div>
                <div style={{ fontSize:14, fontWeight:500, color:'#111', marginBottom:3 }}>{name}</div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>
                  {sessions.length} тренировок · последняя {fmtShort(last.date)}
                  {growth > 0 && <span style={{ color:'#22c55e', marginLeft:8 }}>+{growth} кг</span>}
                </div>
              </div>
              <div style={{ textAlign:'right', flexShrink:0, marginLeft:16 }}>
                <div style={{ fontSize:15, fontWeight:700, color:PUR }}>{maxKg} кг</div>
                <div style={{ fontSize:10, color:'#9ca3af' }}>макс. вес</div>
              </div>
            </button>
          )
        })}

        {filtered.length === 0 && (
          <div style={{ textAlign:'center', color:'#c7cad1', fontSize:13, marginTop:48 }}>
            Упражнение не найдено
          </div>
        )}
      </div>
    </div>
  )
}
