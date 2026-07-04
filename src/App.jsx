import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import AIAssistant from './AIAssistant'
import { supabase } from './supabase.js'
import './App.css'

const PUR = '#7F77DD'
const TEA = '#1D9E75'
const COR = '#D85A30'
const BLU = '#378ADD'

const clearFitproData = () => {
  Object.keys(localStorage)
    .filter(k => k.startsWith('fitpro_'))
    .forEach(k => localStorage.removeItem(k))
}

const CLIENTS = [
  { id:1, name:'Анна Соколова',   goal:'Похудение',    program:'Кардио + Сила',     progress:78, av:'АС', cal:1800, wk:4, wts:[75,74.2,73.5,72.8,72,71.5,71] },
  { id:2, name:'Дмитрий Козлов', goal:'Набор массы',   program:'Силовые тренировки', progress:62, av:'ДК', cal:2800, wk:3, wts:[70,70.5,71,71.8,72.5,73,73.5] },
  { id:3, name:'Сергей Петров',   goal:'Выносливость', program:'Бег + Кардио',       progress:45, av:'СП', cal:2400, wk:2, wts:[80,80,79.5,79,79,78.5,78] },
]


const EXERCISES = [
  { n:'Приседания со штангой', m:'Ноги', eq:'Штанга' },
  { n:'Жим лёжа', m:'Грудь', eq:'Штанга' },
  { n:'Становая тяга', m:'Спина', eq:'Штанга' },
  { n:'Подтягивания', m:'Спина', eq:'Турник' },
  { n:'Планка', m:'Кор', eq:'Без оборудования' },
  { n:'Берпи', m:'Всё тело', eq:'Без оборудования' },
  { n:'Выпады с гантелями', m:'Ноги', eq:'Гантели' },
  { n:'Жим гантелей сидя', m:'Плечи', eq:'Гантели' },
  { n:'Тяга верхнего блока', m:'Спина', eq:'Блок' },
  { n:'Скручивания', m:'Кор', eq:'Без оборудования' },
  { n:'Жим ногами', m:'Ноги', eq:'Тренажёр' },
  { n:'Отжимания', m:'Грудь', eq:'Без оборудования' },
  { n:'Подъём на бицепс', m:'Руки', eq:'Гантели' },
  { n:'Боковые подъёмы', m:'Плечи', eq:'Гантели' },
  { n:'Трицепс на блоке', m:'Руки', eq:'Блок' },
]

const CHAT_INIT = [
  { id:1, from:'client', text:'Привет! Можно изменить программу? Болит колено 😔', t:'10:15' },
  { id:2, from:'trainer', text:'Конечно! Заменим приседания на жим ногами лёжа.', t:'10:18' },
  { id:3, from:'client', text:'Спасибо! А питание без углеводов вечером можно?', t:'10:22' },
  { id:4, from:'trainer', text:'Да, всё ок. Белок и овощи — отличный выбор для цели 💪', t:'10:25' },
]

const BADGE = {
  'Сила':        { bg:'#EEEDFE', tx:'#3C3489' },
  'Кардио':      { bg:'#E1F5EE', tx:'#085041' },
  'HIIT':        { bg:'#FAECE7', tx:'#712B13' },
  'Похудение':   { bg:'#E1F5EE', tx:'#085041' },
  'Набор массы': { bg:'#EEEDFE', tx:'#3C3489' },
  'Выносливость':{ bg:'#E6F1FB', tx:'#0C447C' },
}

const WORKOUT_ACTIONS = [
  { key:'start', icon:'▶️', label:'Начать тренировку',   desc:'Запустить тренировку прямо сейчас' },
  { key:'done',  icon:'✅', label:'Добавить выполненную', desc:'Записать уже проведённую тренировку' },
]

const WCOLORS = ['#D85A30','#7F77DD','#1D9E75','#378ADD','#E53935','#F59E0B']

// ── UI компоненты
function Av({ lbl, sz=36, bg=PUR, photo, gender }) {
  if (photo) return (
    <div style={{ width:sz, height:sz, borderRadius:'50%', flexShrink:0, overflow:'hidden' }}>
      <img src={photo} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
    </div>
  )
  const genderEmoji = gender==='female' ? '👩' : gender==='male' ? '👨' : null
  return (
    <div style={{ width:sz, height:sz, borderRadius:'50%', background:genderEmoji?'#f3f4f6':bg, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:genderEmoji?Math.round(sz*.52):Math.round(sz*.35), fontWeight:500, flexShrink:0 }}>
      {genderEmoji || lbl}
    </div>
  )
}

function Card({ children, style={}, onClick }) {
  return (
    <div onClick={onClick} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:'14px 16px', ...style }}>
      {children}
    </div>
  )
}

function Metric({ label, value, icon, color=PUR }) {
  return (
    <div style={{ background:'#f9fafb', borderRadius:10, padding:'12px 14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
        <span style={{ fontSize:11, color:'#6b7280' }}>{label}</span>
        <span style={{ fontSize:16, color }}>{icon}</span>
      </div>
      <div style={{ fontSize:22, fontWeight:500, color:'#111' }}>{value}</div>
    </div>
  )
}

function PBar({ v, color=PUR }) {
  return (
    <div style={{ background:'#e5e7eb', borderRadius:4, height:5, marginTop:4 }}>
      <div style={{ width:`${v}%`, background:color, borderRadius:4, height:'100%' }} />
    </div>
  )
}

function Badge({ lbl }) {
  const c = BADGE[lbl] || { bg:'#f3f4f6', tx:'#6b7280' }
  return <span style={{ fontSize:10, padding:'2px 7px', borderRadius:20, background:c.bg, color:c.tx, fontWeight:500 }}>{lbl}</span>
}

function NavBtn({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ width:'100%', display:'flex', alignItems:'center', gap:9, padding:'8px 10px', borderRadius:8, border:'none', background:active?PUR:'transparent', color:active?'#fff':'#6b7280', fontSize:13, textAlign:'left', marginBottom:2, cursor:'pointer' }}>
      <span style={{ fontSize:16 }}>{icon}</span>{label}
    </button>
  )
}

// ── Экраны
function Dashboard({ setNav, setSC, isTrainer }) {
  const workoutHistory = (() => { try { return JSON.parse(localStorage.getItem('fitpro_history')||'[]') } catch { return [] } })()
  const foodDiary = (() => { try { return JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}') } catch { return {} } })()
  const foodDays = Object.keys(foodDiary).length
  const chatMsgCount = CLIENTS.reduce((sum,c)=>{
    try { return sum+(JSON.parse(localStorage.getItem(`fitpro_chat_${c.id}`)||'null')||[]).length } catch { return sum }
  },0)
  const quickActions = [
    {icon:'👥',label:'Клиенты',nav:'clients'},
    {icon:'🏋️',label:'Тренировки',nav:'workouts'},
    {icon:'🥗',label:'Питание',nav:'nutrition'},
    {icon:'📚',label:'Упражнения',nav:'library'},
    {icon:'💬',label:'Чат',nav:'chat'},
    {icon:'📓',label:'Дневник',nav:'progress'},
  ]

  return (
    <div>
      <div style={{ marginBottom:18 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:0 }}>Добро пожаловать 👋</h2>
        <p style={{ fontSize:13, color:'#6b7280', marginTop:4 }}>Твоя платформа для тренеров</p>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <Metric label="Клиентов" value={CLIENTS.length} icon="👥" color={PUR} />
        <Metric label="Тренировок" value={workoutHistory.length} icon="🏋️" color={TEA} />
        <Metric label="Дней питания" value={foodDays} icon="🥗" color={BLU} />
        <Metric label="Сообщений" value={chatMsgCount||'—'} icon="💬" color={COR} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        {isTrainer&&(
          <Card>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <span style={{ fontWeight:500, color:'#111' }}>Клиенты</span>
              <button onClick={()=>setNav('clients')} style={{ fontSize:12, color:PUR, border:'none', background:'none', cursor:'pointer' }}>Все →</button>
            </div>
            {CLIENTS.map(c=>(
              <div key={c.id} onClick={()=>{setSC(c);setNav('cdetail')}} style={{ display:'flex', alignItems:'center', gap:9, padding:'7px 0', borderBottom:'1px solid #f3f4f6', cursor:'pointer' }}>
                <Av lbl={c.av} sz={30} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:'#111' }}>{c.name}</div>
                  <div style={{ fontSize:11, color:'#9ca3af' }}>{c.goal}</div>
                  <PBar v={c.progress} color={c.progress>70?TEA:PUR} />
                </div>
                <span style={{ fontSize:12, fontWeight:500, color:c.progress>70?TEA:PUR }}>{c.progress}%</span>
              </div>
            ))}
          </Card>
        )}
        <Card>
          <div style={{ fontWeight:500, color:'#111', marginBottom:12 }}>Быстрые действия</div>
          {quickActions.map(a=>(
            <button key={a.label} onClick={()=>setNav(a.nav)} style={{ width:'100%', display:'flex', alignItems:'center', gap:9, padding:'8px 10px', marginBottom:6, background:'#f9fafb', border:'none', borderRadius:8, cursor:'pointer', textAlign:'left' }}>
              <span>{a.icon}</span><span style={{ fontSize:13, color:'#111' }}>{a.label}</span>
            </button>
          ))}
        </Card>
      </div>
    </div>
  )
}

function ClientsView({ setSC, setNav }) {
  const [q,setQ]=useState('')
  const [showAdd,setShowAdd]=useState(false)
  const [addForm,setAddForm]=useState({name:'',goal:'Похудение',program:''})
  const [localClients,setLocalClients]=useState(()=>{
    try{ return JSON.parse(localStorage.getItem('fitpro_local_clients')||'[]') }catch{ return [] }
  })

  const saveLocal=(list)=>{
    setLocalClients(list)
    localStorage.setItem('fitpro_local_clients',JSON.stringify(list))
  }

  const addClient=()=>{
    if(!addForm.name.trim())return
    const initials=addForm.name.trim().split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'КЛ'
    const newC={
      id:Date.now(),
      name:addForm.name.trim(),
      goal:addForm.goal,
      program:addForm.program.trim()||'Без программы',
      progress:0,
      av:initials,
      cal:0,wk:0,wts:[],
      isLocal:true,
    }
    saveLocal([...localClients,newC])
    setAddForm({name:'',goal:'Похудение',program:''})
    setShowAdd(false)
  }

  const deleteLocal=(id)=>saveLocal(localClients.filter(c=>c.id!==id))

  const allClients=[...CLIENTS,...localClients]
  const fl=allClients.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:0 }}>Клиенты</h2>
        <button onClick={()=>setShowAdd(true)} style={{ fontSize:13, padding:'7px 14px', background:PUR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>+ Добавить</button>
      </div>

      {showAdd&&(
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}
          onClick={()=>setShowAdd(false)}>
          <div style={{ background:'#fff',borderRadius:16,padding:'24px 22px',width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18 }}>
              <span style={{ fontSize:16,fontWeight:700,color:'#111' }}>Новый клиент</span>
              <button onClick={()=>setShowAdd(false)} style={{ background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#9ca3af',lineHeight:1 }}>✕</button>
            </div>
            <div style={{ display:'flex',flexDirection:'column',gap:12 }}>
              <div>
                <div style={{ fontSize:11,color:'#6b7280',marginBottom:4 }}>Имя и фамилия *</div>
                <input value={addForm.name} onChange={e=>setAddForm(f=>({...f,name:e.target.value}))}
                  placeholder="Анна Иванова" autoFocus
                  style={{ width:'100%',padding:'10px 12px',fontSize:13,borderRadius:9,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',color:'#111' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'}
                  onKeyDown={e=>e.key==='Enter'&&addClient()} />
              </div>
              <div>
                <div style={{ fontSize:11,color:'#6b7280',marginBottom:4 }}>Цель</div>
                <select value={addForm.goal} onChange={e=>setAddForm(f=>({...f,goal:e.target.value}))}
                  style={{ width:'100%',padding:'10px 12px',fontSize:13,borderRadius:9,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',color:'#111',background:'#fff' }}>
                  {['Похудение','Набор массы','Выносливость','Тонус','Реабилитация'].map(g=><option key={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize:11,color:'#6b7280',marginBottom:4 }}>Программа</div>
                <input value={addForm.program} onChange={e=>setAddForm(f=>({...f,program:e.target.value}))}
                  placeholder="Кардио + Сила"
                  style={{ width:'100%',padding:'10px 12px',fontSize:13,borderRadius:9,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',color:'#111' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
              </div>
              <div style={{ display:'flex',gap:8,marginTop:4 }}>
                <button onClick={()=>setShowAdd(false)} style={{ flex:1,padding:'11px',fontSize:13,borderRadius:9,border:'1px solid #e5e7eb',background:'none',color:'#6b7280',cursor:'pointer' }}>Отмена</button>
                <button onClick={addClient} style={{ flex:1,padding:'11px',fontSize:13,borderRadius:9,border:'none',background:PUR,color:'#fff',fontWeight:600,cursor:'pointer' }}>Добавить</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск..." style={{ width:'100%', marginBottom:14, padding:'8px 12px', fontSize:13, borderRadius:8, border:'1px solid #e5e7eb', boxSizing:'border-box' }} />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:10 }}>
        {fl.map(c=>(
          <Card key={c.id} style={{ cursor:'pointer', position:'relative' }}>
            <div onClick={()=>{setSC(c);setNav('cdetail')}} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <Av lbl={c.av} sz={40} />
              <div><div style={{ fontSize:14, fontWeight:500, color:'#111' }}>{c.name}</div><Badge lbl={c.goal} /></div>
            </div>
            <div onClick={()=>{setSC(c);setNav('cdetail')}}>
              <div style={{ fontSize:12, color:'#6b7280', marginBottom:7 }}>🏋️ {c.program}</div>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ fontSize:12, color:'#6b7280' }}>Прогресс</span>
                <span style={{ fontSize:12, fontWeight:500, color:c.progress>70?TEA:PUR }}>{c.progress}%</span>
              </div>
              <PBar v={c.progress} color={c.progress>70?TEA:PUR} />
            </div>
            {c.isLocal&&(
              <button onClick={e=>{e.stopPropagation();if(window.confirm(`Удалить клиента ${c.name}?`))deleteLocal(c.id)}}
                style={{ position:'absolute',top:10,right:10,background:'none',border:'none',color:'#d1d5db',fontSize:16,cursor:'pointer',lineHeight:1,padding:4 }}>✕</button>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}

function ClientDetail({ client, goBack }) {
  const lost=+(client.wts[0]-client.wts[client.wts.length-1]).toFixed(1)
  const maxW=Math.max(...client.wts), minW=Math.min(...client.wts), range=maxW-minW||1
  const W=400,H=120,PAD=20
  const pts=client.wts.map((kg,i)=>{
    const x=PAD+(i/(client.wts.length-1))*(W-PAD*2)
    const y=H-PAD-((kg-minW)/range)*(H-PAD*2)
    return `${x},${y}`
  }).join(' ')
  return (
    <div>
      <button onClick={goBack} style={{ fontSize:12, color:'#6b7280', border:'none', background:'none', cursor:'pointer', marginBottom:14, padding:0 }}>← Назад</button>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18 }}>
        <Av lbl={client.av} sz={50} />
        <div>
          <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:0 }}>{client.name}</h2>
          <div style={{ fontSize:13, color:'#6b7280', marginTop:2 }}>{client.goal} · {client.program}</div>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:16 }}>
        <Metric label="Прогресс" value={`${client.progress}%`} icon="📈" color={PUR} />
        <Metric label="Нач. вес" value={`${client.wts[0]} кг`} icon="⚖️" color="#6b7280" />
        <Metric label="Тек. вес" value={`${client.wts[client.wts.length-1]} кг`} icon="📉" color={TEA} />
        <Metric label="Результат" value={`−${Math.abs(lost)} кг`} icon="🎯" color={COR} />
      </div>
      <Card>
        <div style={{ fontWeight:500, color:'#111', marginBottom:10 }}>Динамика веса</div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:H }}>
          <polyline points={pts} fill="none" stroke={PUR} strokeWidth="2.5" strokeLinejoin="round" />
          {client.wts.map((kg,i)=>{
            const x=PAD+(i/(client.wts.length-1))*(W-PAD*2)
            const y=H-PAD-((kg-minW)/range)*(H-PAD*2)
            return <circle key={i} cx={x} cy={y} r={4} fill={PUR} />
          })}
        </svg>
      </Card>
    </div>
  )
}

// ── IndexedDB для хранения видеофайлов ──
const IDB_NAME='fitpro_videos_db', IDB_STORE='videos'
function idbOpen(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(IDB_NAME,1)
    r.onupgradeneeded=e=>e.target.result.createObjectStore(IDB_STORE,{keyPath:'id'})
    r.onsuccess=e=>res(e.target.result)
    r.onerror=e=>rej(e.target.error)
  })
}
async function idbSave(id,file){
  const db=await idbOpen()
  const buf=await file.arrayBuffer()
  return new Promise((res,rej)=>{
    const tx=db.transaction(IDB_STORE,'readwrite')
    tx.objectStore(IDB_STORE).put({id,buf,type:file.type||'video/mp4'})
    tx.oncomplete=res; tx.onerror=e=>rej(e.target.error)
  })
}
async function idbLoadAll(){
  const db=await idbOpen()
  return new Promise((res,rej)=>{
    const tx=db.transaction(IDB_STORE,'readonly')
    const r=tx.objectStore(IDB_STORE).getAll()
    r.onsuccess=e=>res(e.target.result)
    r.onerror=e=>rej(e.target.error)
  })
}
async function idbDelete(id){
  const db=await idbOpen()
  return new Promise((res,rej)=>{
    const tx=db.transaction(IDB_STORE,'readwrite')
    tx.objectStore(IDB_STORE).delete(id)
    tx.oncomplete=res; tx.onerror=e=>rej(e.target.error)
  })
}

const FOLDERS=['Full Body','Сплит','Похудение','Домашние тренировки']
const FOLDER_ICONS={'Full Body':'💪','Сплит':'⚡','Похудение':'🏃','Домашние тренировки':'🏠'}
const SLOT_COUNT=12

const FULL_BODY_PROGRAM=[
  [{num:1,name:'Приседания',sets:'20 кг × 15, 25 кг × 12, 25 кг × 12, 25 кг × 12'},{num:2,name:'Зашагивание на тумбу',sets:'3 кг × 20, 3 кг × 20, 3 кг × 20, 3 кг × 20'},{num:3,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20'},{num:4,name:'Тяга верхнего блока широким хватом',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:5,name:'Жим гантелей на наклонной скамье',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:6,name:'Махи с гантелями стоя',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20'},{num:7,name:'Молитва в кроссовере',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'}],
  [{num:1,name:'Болгарские выпады с гантелями',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:2,name:'Румынская тяга со штангой',sets:'10 кг × 20, 20 кг × 15, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:4,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:5,name:'Бабочка',sets:'8 кг × 15, 8 кг × 15, 8 кг × 15, 8 кг × 15'},{num:6,name:'Жим гантелей сидя',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:7,name:'Вращение корпуса сидя на ягодицах',sets:'3 кг × 20, 3 кг × 20, 3 кг × 20, 3 кг × 20'}],
  [{num:1,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 30 кг × 15, 30 кг × 12, 35 кг × 12'},{num:2,name:'Румынская тяга на одной ноге со штангой',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:3,name:'Махи стоя в кроссовере',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:4,name:'Тяга верхнего блока с V-образной рукоятью',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:5,name:'Разгибание рук (косичка)',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:6,name:'Сгибание рук (косичка)',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:7,name:'Складка',sets:'30, 30, 30, 30'}],
  [{num:1,name:'Приседания',sets:'20 кг × 15, 25 кг × 12, 30 кг × 10, 35 кг × 8, 35 кг × 6'},{num:2,name:'Болгарские выпады с гантелями',sets:'12 кг × 16, 12 кг × 16, 12 кг × 16, 12 кг × 16'},{num:3,name:'Тяга верхнего блока широким хватом',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:4,name:'Жим гантелей лежа на наклонной скамье',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:5,name:'Протяжка штанги широким хватом',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:6,name:'Молитва в кроссовере',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'},{num:7,name:'Скручивания лежа на полу',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 30 кг × 5, 35 кг × 8, 40 кг × 8, 40 кг × 8'},{num:2,name:'Румынская тяга со штангой',sets:'10 кг × 20, 20 кг × 15, 25 кг × 15, 30 кг × 12, 35 кг × 10'},{num:3,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:4,name:'Бабочка',sets:'8 кг × 15, 8 кг × 15, 8 кг × 15, 8 кг × 15'},{num:5,name:'Жим гантелей сидя',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:6,name:'Спайдер',sets:'20, 20, 20, 20'},{num:7,name:'Вращение корпуса сидя на ягодицах',sets:'3 кг × 20, 3 кг × 20, 3 кг × 20, 3 кг × 20'}],
  [{num:1,name:'Выпады',sets:'20 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20'},{num:2,name:'Отведения бедер сидя в тренажере',sets:'20 кг × 20, 30 кг × 20, 35 кг × 20, 35 кг × 20'},{num:3,name:'Махи стоя в кроссовере',sets:'8 кг × 24, 8 кг × 24, 8 кг × 24, 8 кг × 24'},{num:4,name:'Сгибание ног сидя/лежа',sets:'15 кг × 15, 15 кг × 15, 15 кг × 15, 15 кг × 15'},{num:5,name:'Разгибание рук (прямая рукоять)',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:6,name:'Сгибание рук (прямая рукоять)',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:7,name:'Гиперэкстензия',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'}],
  [{num:1,name:'Приседания',sets:'20 кг × 20, 20 кг × 20, 20 кг × 20, 20 кг × 20'},{num:2,name:'Болгарские выпады с гантелями',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:3,name:'Зашагивание на тумбу',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20'},{num:4,name:'Тяга верхнего блока широким хватом',sets:'20 кг × 20, 20 кг × 20, 20 кг × 20, 20 кг × 20'},{num:5,name:'Жим гантелей лежа на наклонной скамье',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:6,name:'Махи с гантелями стоя',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20'},{num:7,name:'Молитва в кроссовере',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'}],
  [{num:1,name:'Румынская тяга со штангой',sets:'15 кг × 20, 20 кг × 20, 25 кг × 20, 25 кг × 20'},{num:2,name:'Румынская тяга на одной ноге со штангой',sets:'12 кг × 20, 12 кг × 20, 12 кг × 20, 12 кг × 20'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:4,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20'},{num:5,name:'Бабочка',sets:'15 кг × 15, 15 кг × 15, 15 кг × 15, 15 кг × 15'},{num:6,name:'Жим гантелей сидя',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:7,name:'Спайдер',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 20, 30 кг × 20, 30 кг × 20, 30 кг × 20'},{num:2,name:'Отведения бедер сидя в тренажере',sets:'20 кг × 20, 30 кг × 20, 35 кг × 20, 35 кг × 20'},{num:3,name:'Махи стоя в кроссовере',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:4,name:'Сгибание ног сидя/лежа',sets:'15 кг × 15, 15 кг × 15, 15 кг × 15, 15 кг × 15'},{num:5,name:'Разгибание рук (косичка)',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:6,name:'Сгибание рук (косичка)',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:7,name:'Гиперэкстензия',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'}],
  [{num:1,name:'Приседания',sets:'20 кг × 15, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:2,name:'Зашагивание на тумбу',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:3,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20'},{num:4,name:'Тяга верхнего блока с V-образной рукоятью',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:5,name:'Жим гантелей лежа на наклонной скамье',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:6,name:'Протяжка штанги широким хватом',sets:'12 кг × 15, 12 кг × 15, 12 кг × 15, 12 кг × 15'},{num:7,name:'Молитва в кроссовере',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'}],
  [{num:1,name:'Болгарские выпады с гантелями',sets:'8 кг × 20, 8 кг × 20, 8 кг × 20, 8 кг × 20'},{num:2,name:'Румынская тяга со штангой',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 35 кг × 12, 35 кг × 12'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:4,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 20, 25 кг × 15, 30 кг × 15, 30 кг × 15'},{num:5,name:'Бабочка',sets:'15 кг × 15, 15 кг × 15, 15 кг × 15, 15 кг × 15'},{num:6,name:'Жим гантелей сидя',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:7,name:'Спайдер',sets:'30, 30, 30, 30'}],
  [{num:1,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 15, 30 кг × 15, 35 кг × 12, 40 кг × 12'},{num:2,name:'Румынская тяга на одной ноге со штангой',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:3,name:'Махи стоя в кроссовере',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:4,name:'Тяга верхнего блока широким хватом',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:5,name:'Разгибание рук (прямая рукоять)',sets:'9 кг × 20, 9 кг × 20, 9 кг × 20, 9 кг × 20'},{num:6,name:'Сгибание рук (прямая рукоять)',sets:'9 кг × 20, 9 кг × 20, 9 кг × 20, 9 кг × 20'},{num:7,name:'Складка',sets:'30, 30, 30, 30'}],
]

const SPLIT_PROGRAM=[
  [{num:1,name:'Приседания',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:2,name:'Болгарские выпады с гантелями',sets:'б/в × 20, б/в × 20, б/в × 20, б/в × 20'},{num:3,name:'Зашагивание на тумбу',sets:'б/в × 20, б/в × 20, б/в × 20, б/в × 20'},{num:4,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:5,name:'Сгибание ног сидя/лежа',sets:'15 кг × 15, 15 кг × 15, 15 кг × 15, 15 кг × 15'},{num:6,name:'Гиперэкстензия',sets:'б/в × 15, б/в × 15, б/в × 15, б/в × 15'},{num:7,name:'Скручивания лежа на полу',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Подтягивания в гравитроне параллельный хват',sets:'-39 кг × 12, -39 кг × 12, -39 кг × 12, -39 кг × 12'},{num:2,name:'Тяга верхнего блока широким хватом',sets:'15 кг × 20, 20 кг × 15, 25 кг × 12, 25 кг × 12'},{num:3,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'15 кг × 20, 20 кг × 15, 25 кг × 12, 25 кг × 12'},{num:4,name:'Тяга горизонтальная к поясу по одной руке стоя в выпаде',sets:'10 кг × 10, 10 кг × 10, 10 кг × 10, 10 кг × 10'},{num:5,name:'Жим гантелей лежа на наклонной скамье',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:6,name:'Бабочка',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:7,name:'Молитва в кроссовере',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20'}],
  [{num:1,name:'Жим гантелей сидя',sets:'5 кг × 20, 7 кг × 15, 10 кг × 12, 10 кг × 10'},{num:2,name:'Протяжка штанги широким хватом стоя',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:3,name:'Махи с гантелями стоя',sets:'3 кг × 20, 3 кг × 20, 3 кг × 20, 3 кг × 20'},{num:4,name:'Отведение рук назад сидя в наклоне',sets:'3 кг × 15, 3 кг × 15, 3 кг × 15, 3 кг × 15'},{num:5,name:'Разгибание рук (прямая рукоять)',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:6,name:'Сгибание рук (прямая рукоять)',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:7,name:'Вращение корпуса сидя на ягодицах',sets:'3 кг × 20, 3 кг × 20, 3 кг × 20, 3 кг × 20'}],
  [{num:1,name:'Румынская тяга со штангой',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:2,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20'},{num:3,name:'Румынская тяга на одной ноге со штангой',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:4,name:'Махи стоя в кроссовере',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:5,name:'Отведения бедер сидя в тренажере',sets:'20 кг × 20, 30 кг × 20, 40 кг × 20, 40 кг × 20'},{num:6,name:'Гиперэкстензия',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:7,name:'Скручивания лежа на полу',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Подтягивания в гравитроне параллельный хват',sets:'-30 кг × 10, -30 кг × 10, -30 кг × 10, -30 кг × 10'},{num:2,name:'Тяга верхнего блока с V-образной рукоятью',sets:'15 кг × 20, 20 кг × 15, 25 кг × 12, 30 кг × 10'},{num:3,name:'Тяга нижнего блока с упором грудью',sets:'15 кг × 20, 20 кг × 15, 25 кг × 15, 25 кг × 15'},{num:4,name:'Тяга гантели в наклоне с опорой на скамью',sets:'10 кг × 24, 10 кг × 24, 10 кг × 24, 10 кг × 24'},{num:5,name:'Жим гантелей лежа на наклонной скамье',sets:'7 кг × 15, 7 кг × 15, 7 кг × 15, 7 кг × 15'},{num:6,name:'Разводка',sets:'3 кг × 15, 3 кг × 15, 3 кг × 15, 3 кг × 15'},{num:7,name:'Молитва в кроссовере',sets:'20 кг × 20, 20 кг × 20, 20 кг × 20, 20 кг × 20'}],
  [{num:1,name:'Жим гантелей сидя',sets:'5 кг × 20, 7 кг × 15, 9 кг × 15, 9 кг × 15'},{num:2,name:'Протяжка штанги широким хватом стоя',sets:'5 кг × 20, 10 кг × 15, 15 кг × 12, 15 кг × 12'},{num:3,name:'Махи в кроссовере по одной руке V-образной рукояткой',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20'},{num:4,name:'Обратная бабочка',sets:'2,5 кг × 12, 2,5 кг × 12, 2,5 кг × 12, 2,5 кг × 12'},{num:5,name:'Сгибание рук (косичка)',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:6,name:'Разгибание рук (косичка)',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:7,name:'Складка',sets:'30, 30, 30, 30'}],
  [{num:1,name:'Приседания',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:2,name:'Болгарские выпады с гантелями',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20'},{num:3,name:'Зашагивание на тумбу',sets:'б/в × 20, б/в × 20, б/в × 20, б/в × 20'},{num:4,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 15, 25 кг × 15, 25 кг × 15'},{num:5,name:'Сгибание ног сидя/лежа',sets:'12 кг × 20, 12 кг × 20, 12 кг × 20, 12 кг × 20'},{num:6,name:'Гиперэкстензия',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:7,name:'Скручивания лежа на полу',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Подтягивания в гравитроне параллельный хват',sets:'-42 кг × 15, -42 кг × 15, -42 кг × 15, -42 кг × 15'},{num:2,name:'Тяга верхнего блока широким хватом',sets:'15 кг × 20, 20 кг × 15, 25 кг × 15, 25 кг × 15'},{num:3,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'15 кг × 20, 20 кг × 15, 25 кг × 15, 25 кг × 15'},{num:4,name:'Тяга горизонтальная к поясу по одной руке стоя в выпаде',sets:'12 кг × 10, 12 кг × 10, 12 кг × 10, 12 кг × 10'},{num:5,name:'Жим гантелей лежа на наклонной скамье',sets:'8 кг × 15, 8 кг × 15, 8 кг × 15, 8 кг × 15'},{num:6,name:'Бабочка',sets:'12 кг × 12, 12 кг × 12, 12 кг × 12, 12 кг × 12'},{num:7,name:'Молитва в кроссовере',sets:'20 кг × 20, 20 кг × 20, 20 кг × 20, 20 кг × 20'}],
  [{num:1,name:'Жим гантелей сидя',sets:'5 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:2,name:'Протяжка штанги широким хватом стоя',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:3,name:'Махи с гантелями стоя',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'},{num:4,name:'Отведение рук назад сидя в наклоне',sets:'5 кг × 12, 5 кг × 12, 5 кг × 12, 5 кг × 12'},{num:5,name:'Разгибание рук (прямая рукоять)',sets:'12 кг × 12, 12 кг × 12, 12 кг × 12, 12 кг × 12'},{num:6,name:'Сгибание рук (прямая рукоять)',sets:'12 кг × 12, 12 кг × 12, 12 кг × 12, 12 кг × 12'},{num:7,name:'Вращение корпуса сидя на ягодицах',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'}],
  [{num:1,name:'Румынская тяга со штангой',sets:'20 кг × 20, 25 кг × 15, 30 кг × 15, 30 кг × 15, 35 кг × 12'},{num:2,name:'Ягодичный мост со штангой',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 35 кг × 10, 40 кг × 10'},{num:3,name:'Румынская тяга на одной ноге со штангой',sets:'12 кг × 20, 12 кг × 20, 12 кг × 20, 12 кг × 20'},{num:4,name:'Махи стоя в кроссовере',sets:'12 кг × 20, 12 кг × 20, 12 кг × 20, 12 кг × 20'},{num:5,name:'Отведения бедер сидя в тренажере',sets:'20 кг × 20, 30 кг × 20, 40 кг × 20, 50 кг × 20'},{num:6,name:'Гиперэкстензия',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:7,name:'Скручивания лежа на полу',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Подтягивания в гравитроне параллельный хват',sets:'-30 кг × 12, -30 кг × 12, -30 кг × 12, -30 кг × 12'},{num:2,name:'Тяга верхнего блока с V-образной рукоятью',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 10'},{num:3,name:'Тяга нижнего блока с упором грудью',sets:'20 кг × 20, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:4,name:'Тяга гантели в наклоне с опорой на скамью',sets:'12 кг × 20, 12 кг × 20, 12 кг × 20, 12 кг × 20'},{num:5,name:'Жим гантелей лежа на наклонной скамье',sets:'9 кг × 12, 9 кг × 12, 9 кг × 12, 9 кг × 12'},{num:6,name:'Разводка',sets:'5 кг × 12, 5 кг × 12, 5 кг × 12, 5 кг × 12'},{num:7,name:'Молитва в кроссовере',sets:'20 кг × 20, 20 кг × 20, 20 кг × 20, 20 кг × 20'}],
  [{num:1,name:'Жим гантелей сидя',sets:'5 кг × 20, 8 кг × 15, 10 кг × 15, 12 кг × 12, 12 кг × 10'},{num:2,name:'Протяжка штанги широким хватом стоя',sets:'5 кг × 20, 10 кг × 15, 17 кг × 12, 17 кг × 10'},{num:3,name:'Махи в кроссовере по одной руке V-образной рукояткой',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20'},{num:4,name:'Обратная бабочка',sets:'2,5 кг × 12, 2,5 кг × 12, 2,5 кг × 12, 2,5 кг × 12'},{num:5,name:'Сгибание рук (косичка)',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:6,name:'Разгибание рук (косичка)',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:7,name:'Складка',sets:'30, 30, 30, 30'}],
]

const HOME_PROGRAM=[
  [{num:1,name:'Приседания',sets:'20, 20, 20, 20'},{num:2,name:'Выпады назад на месте',sets:'20, 20, 20, 20'},{num:3,name:'Ягодичный мост на одной ноге (упор на стул/диван)',sets:'20, 20, 20, 20'},{num:4,name:'Тяга резины 1 лежа на полу',sets:'15, 15, 15, 15'},{num:5,name:'Отжимания от пола',sets:'12, 12, 12, 12'},{num:6,name:'Отведение руки с резиной 1',sets:'20, 20, 20, 20'},{num:7,name:'Скручивания лежа на полу',sets:'15, 15, 15, 15'}],
  [{num:1,name:'Болгарские выпады',sets:'20, 20, 20, 20'},{num:2,name:'Румынская тяга на одной ноге отводя другую ногу назад с резиной 1',sets:'20, 20, 20, 20'},{num:3,name:'Шаги в сторону с резиной 1 на коленях',sets:'20, 20, 20, 20'},{num:4,name:'Тяга резины 1 сидя на полу',sets:'15, 15, 15, 15'},{num:5,name:'Приведение руки с резиной 1',sets:'20, 20, 20, 20'},{num:6,name:'Жим резины 1 сидя',sets:'20, 20, 20, 20'},{num:7,name:'Вращение корпуса сидя на ягодицах',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Ягодичный мост на одной ноге с резиной 2 (упор на стул/диван)',sets:'20, 20, 20, 20'},{num:2,name:'Румынская на одной ноге с упором другой ноги в стену',sets:'20, 20, 20, 20'},{num:3,name:'Махи ноги стоя резиной 1',sets:'20, 20, 20, 20'},{num:4,name:'Тяга резины 1 лежа на полу',sets:'20, 20, 20, 20'},{num:5,name:'Разгибание рук резина 1',sets:'20, 20, 20, 20'},{num:6,name:'Сгибание рук резина 1',sets:'20, 20, 20, 20'},{num:7,name:'Складка',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Приседания с резиной',sets:'1 рез. × 15, 2 рез. × 12, 3 рез. × 10, 4 рез. × 8, 4 рез. × 8'},{num:2,name:'Болгарские выпады',sets:'20, 20, 20, 20'},{num:3,name:'Тяга резины 2 лежа на полу',sets:'15, 15, 15, 15'},{num:4,name:'Отжимания от пола',sets:'12, 12, 12, 12'},{num:5,name:'Протяжка резины 1',sets:'15, 15, 15, 15'},{num:6,name:'Скручивания лежа на полу',sets:'15, 15, 15, 15'},{num:7,name:'Мертвый жук',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Ягодичный мост на одной ноге с резиной (упор на стул/диван)',sets:'1 рез. × 20, 2 рез. × 18, 3 рез. × 16, 4 рез. × 14, 4 рез. × 14'},{num:2,name:'Румынская тяга на одной ноге отводя другую ногу назад с резиной',sets:'1 рез. × 20, 2 рез. × 18, 3 рез. × 16, 3 рез. × 14, 3 рез. × 14'},{num:3,name:'Тяга стоя в наклоне резины 2',sets:'15, 15, 15, 15'},{num:4,name:'Приведение руки с резиной 1',sets:'20, 20, 20, 20'},{num:5,name:'Жим резины 2 сидя',sets:'20, 20, 20, 20'},{num:6,name:'Спайдер',sets:'20, 20, 20, 20'},{num:7,name:'Вращение корпуса сидя на ягодицах',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Выпады назад на месте резина 2',sets:'20, 20, 20, 20'},{num:2,name:'Отведения бедер сидя резина 3',sets:'20, 20, 20, 20'},{num:3,name:'Фроги',sets:'20, 20, 20, 20'},{num:4,name:'Махи ноги стоя резиной 2',sets:'20, 20, 20, 20'},{num:5,name:'Разгибание рук резина 1',sets:'20, 20, 20, 20'},{num:6,name:'Сгибание рук резина 1',sets:'20, 20, 20, 20'},{num:7,name:'Обратная лодочка',sets:'15, 15, 15, 15'}],
  [{num:1,name:'Приседания с резиной 2',sets:'20, 20, 20, 20'},{num:2,name:'Болгарские выпады с резиной 1',sets:'20, 20, 20, 20'},{num:3,name:'Отведение согнутой ноги стоя в наклоне резина 1',sets:'20, 20, 20, 20'},{num:4,name:'Тяга резины 2 лежа на полу',sets:'15, 15, 15, 15'},{num:5,name:'Отжимания от пола',sets:'12, 12, 12, 12'},{num:6,name:'Отведение руки с резиной 1',sets:'20, 20, 20, 20'},{num:7,name:'Скручивания лежа на полу',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Фроги',sets:'20, 20, 20, 20'},{num:2,name:'Румынская тяга на одной ноге отводя другую ногу назад с резиной 2',sets:'20, 20, 20, 20'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену резина 1',sets:'20, 20, 20, 20'},{num:4,name:'Тяга к поясу резины 2 с упором рукой в наклоне',sets:'15, 15, 15, 15'},{num:5,name:'Приведение руки с резиной 2',sets:'20, 20, 20, 20'},{num:6,name:'Жим резины 2 сидя',sets:'20, 20, 20, 20'},{num:7,name:'Спайдер',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Ягодичный мост на одной ноге с резиной 3 (упор на стул/диван)',sets:'20, 20, 20, 20'},{num:2,name:'Отведения бедер сидя резина 4',sets:'20, 20, 20, 20'},{num:3,name:'Шаги в сторону с резиной 2 на коленях',sets:'20, 20, 20, 20'},{num:4,name:'Отведение согнутой ноги стоя в наклоне резина 2',sets:'20, 20, 20, 20'},{num:5,name:'Разгибание рук резина 2',sets:'20, 20, 20, 20'},{num:6,name:'Сгибание рук резина 2',sets:'20, 20, 20, 20'},{num:7,name:'Обратная лодочка',sets:'15, 15, 15, 15'}],
  [{num:1,name:'Приседания с резиной',sets:'2 рез. × 15, 3 рез. × 12, 4 рез. × 10, 5 рез. × 8, 5 рез. × 8'},{num:2,name:'Выпады назад на месте резина 3',sets:'20, 20, 20, 20'},{num:3,name:'Ягодичный мост на одной ноге с резиной 3 (упор на стул/диван)',sets:'20, 20, 20, 20'},{num:4,name:'Тяга стоя в наклоне резины 3',sets:'15, 15, 15, 15'},{num:5,name:'Жим резины 2 сидя',sets:'20, 20, 20, 20'},{num:6,name:'Протяжка резины 2',sets:'15, 15, 15, 15'},{num:7,name:'Мертвый жук',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Болгарские выпады с резиной 2',sets:'20, 20, 20, 20'},{num:2,name:'Румынская тяга на одной ноге отводя другую ногу назад с резиной',sets:'1 рез. × 20, 2 рез. × 18, 3 рез. × 16, 4 рез. × 14, 4 рез. × 14'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену резина 2',sets:'20, 20, 20, 20'},{num:4,name:'Тяга к поясу резины 3 с упором рукой в наклоне',sets:'20, 20, 20, 20'},{num:5,name:'Отжимания от пола',sets:'12, 12, 12, 12'},{num:6,name:'Жим резины 2 сидя',sets:'20, 20, 20, 20'},{num:7,name:'Спайдер',sets:'20, 20, 20, 20'}],
  [{num:1,name:'Ягодичный мост на одной ноге с резиной (упор на стул/диван)',sets:'20, 20, 20, 20'},{num:2,name:'Фроги',sets:'20, 20, 20, 20'},{num:3,name:'Махи ноги стоя резиной 3',sets:'20, 20, 20, 20'},{num:4,name:'Тяга резины 3 лежа на полу',sets:'15, 15, 15, 15'},{num:5,name:'Разгибание рук резина 2',sets:'20, 20, 20, 20'},{num:6,name:'Сгибание рук резина 2',sets:'20, 20, 20, 20'},{num:7,name:'Складка',sets:'20, 20, 20, 20'}],
]

const WEIGHT_LOSS_PROGRAM=[
  [{num:1,name:'Приседания',sets:'10 кг × 15, 10 кг × 15, 10 кг × 15, 10 кг × 15'},{num:2,name:'Отведения бедер сидя в тренажере',sets:'33 кг × 15, 33 кг × 15, 33 кг × 15, 33 кг × 15'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:4,name:'Румынская стоя на одной ноге с отведением второй ноги назад',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20'},{num:5,name:'Махи стоя в кроссовере',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:6,name:'Гиперэкстензия',sets:'5 кг × 15, 5 кг × 15, 5 кг × 15, 5 кг × 15'}],
  [{num:1,name:'Тяга верхнего блока',sets:'20 кг × 15, 25 кг × 15, 30 кг × 12, 30 кг × 12'},{num:2,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 15, 20 кг × 15, 20 кг × 15, 20 кг × 15'},{num:3,name:'Жим гантелей лежа на наклонной скамье',sets:'6 кг × 15, 6 кг × 15, 6 кг × 15, 6 кг × 15'},{num:4,name:'Бабочка',sets:'12 кг × 15, 12 кг × 15, 12 кг × 15, 12 кг × 15'},{num:5,name:'Жим гантелей сидя',sets:'4 кг × 15, 4 кг × 15, 4 кг × 15, 4 кг × 15'},{num:6,name:'Махи с гантелями стоя',sets:'3 кг × 15, 3 кг × 15, 3 кг × 15, 3 кг × 15'}],
  [{num:1,name:'Доползание до планки + становимся на локти',sets:'б/в × 10'},{num:2,name:'Боковой выпад с подъемом гантели над головой',sets:'6 кг × 12'},{num:3,name:'Выпад + прыжок',sets:'б/в × 20'},{num:4,name:'В планке перетаскиваем гантелю под собой',sets:'6 кг × 20'},{num:5,name:'Вращение корпуса сидя на ягодицах',sets:'3 кг × 20'}],
  [{num:1,name:'Зашагивание на тумбу',sets:'б/в × 20, б/в × 20, б/в × 20, б/в × 20'},{num:2,name:'Болгарские выпады с гантелями',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:3,name:'Ягодичный мост со штангой',sets:'20 кг × 12, 25 кг × 10, 25 кг × 10, 25 кг × 10, 30 кг × 8'},{num:4,name:'Гиперэкстензия',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'}],
  [{num:1,name:'Тяга верхнего блока широким хватом',sets:'25 кг × 15, 25 кг × 15, 25 кг × 15, 25 кг × 15',superset:'A'},{num:2,name:'Жим гантелей сидя',sets:'4 кг × 20, 4 кг × 20, 4 кг × 20, 4 кг × 20',superset:'A'},{num:3,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 15, 20 кг × 15, 20 кг × 15, 20 кг × 15',superset:'B'},{num:4,name:'Жим гантелей лежа на наклонной скамье',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20',superset:'B'},{num:5,name:'Бабочка',sets:'12 кг × 20, 12 кг × 20, 12 кг × 20, 12 кг × 20',superset:'C'},{num:6,name:'Махи с гантелями стоя',sets:'2 кг × 20, 2 кг × 20, 2 кг × 20, 2 кг × 20',superset:'C'},{num:7,name:'Разгибание рук (косичка)',sets:'7 кг × 15, 7 кг × 15, 7 кг × 15, 7 кг × 15',superset:'D'},{num:8,name:'Сгибание рук (косичка)',sets:'7 кг × 15, 7 кг × 15, 7 кг × 15, 7 кг × 15',superset:'D'}],
  [{num:1,name:'Трастеры',sets:'4 кг × 20'},{num:2,name:'Рывок гантели одной рукой',sets:'7 кг × 20'},{num:3,name:'Спайдер',sets:'× 20'},{num:4,name:'В планке перетаскиваем гантелю под собой',sets:'6 кг × 20'},{num:5,name:'Вращение корпуса сидя на ягодицах',sets:'5 кг × 20'}],
  [{num:1,name:'Зашагивание на тумбу',sets:'б/в × 20, б/в × 20, б/в × 20, б/в × 20'},{num:2,name:'Отведения бедер сидя в тренажере',sets:'30 кг × 20, 30 кг × 20, 30 кг × 20, 30 кг × 20'},{num:3,name:'Румынская на одной ноге с упором другой ноги в стену',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:4,name:'Румынская стоя на одной ноге с отведением второй ноги назад',sets:'6 кг × 20, 6 кг × 20, 6 кг × 20, 6 кг × 20'},{num:5,name:'Махи стоя в кроссовере',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'},{num:6,name:'Гиперэкстензия',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'}],
  [{num:1,name:'Тяга верхнего блока',sets:'20 кг × 15, 25 кг × 15, 30 кг × 15, 30 кг × 15'},{num:2,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 15, 20 кг × 15, 25 кг × 15, 25 кг × 15'},{num:3,name:'Жим гантелей лежа на наклонной скамье',sets:'6 кг × 15, 6 кг × 15, 6 кг × 15, 6 кг × 15'},{num:4,name:'Бабочка',sets:'15 кг × 15, 15 кг × 15, 15 кг × 15, 15 кг × 15'},{num:5,name:'Жим гантелей сидя',sets:'4 кг × 15, 4 кг × 15, 4 кг × 15, 4 кг × 15'},{num:6,name:'Махи с гантелями стоя',sets:'3 кг × 15, 3 кг × 15, 3 кг × 15, 3 кг × 15'}],
  [{num:1,name:'Доползание до планки + касание рукой противоположного плеча',sets:'× 10'},{num:2,name:'Присед + мах гантелями вперед',sets:'3 кг × 20'},{num:3,name:'Выпад + прыжок',sets:'б/в × 20'},{num:4,name:'Махи гирей',sets:'12 кг × 20'},{num:5,name:'Складка',sets:'× 30'}],
  [{num:1,name:'Болгарские выпады с гантелями',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20'},{num:2,name:'Румынская тяга со штангой',sets:'20 кг × 15, 30 кг × 15, 35 кг × 12, 35 кг × 12'},{num:3,name:'Выпады назад на месте',sets:'20 кг × 20, 25 кг × 20, 25 кг × 20, 25 кг × 20'},{num:4,name:'Отведения бедер сидя в тренажере',sets:'20 кг × 20, 30 кг × 20, 35 кг × 20, 35 кг × 20'},{num:5,name:'Гиперэкстензия',sets:'10 кг × 20, 10 кг × 20, 10 кг × 20, 10 кг × 20'}],
  [{num:1,name:'Тяга верхнего блока широким хватом',sets:'25 кг × 15, 25 кг × 15, 25 кг × 15, 25 кг × 15',superset:'A'},{num:2,name:'Жим гантелей сидя',sets:'5 кг × 20, 5 кг × 20, 5 кг × 20, 5 кг × 20',superset:'A'},{num:3,name:'Тяга нижнего блока с V-образной рукоятью сидя',sets:'20 кг × 15, 20 кг × 15, 20 кг × 15, 20 кг × 15',superset:'B'},{num:4,name:'Жим гантелей лежа на наклонной скамье',sets:'7 кг × 20, 7 кг × 20, 7 кг × 20, 7 кг × 20',superset:'B'},{num:5,name:'Бабочка',sets:'15 кг × 20, 15 кг × 20, 15 кг × 20, 15 кг × 20',superset:'C'},{num:6,name:'Махи с гантелями стоя',sets:'3 кг × 20, 3 кг × 20, 3 кг × 20, 3 кг × 20',superset:'C'},{num:7,name:'Разгибание рук (косичка)',sets:'7 кг × 15, 7 кг × 15, 7 кг × 15, 7 кг × 15',superset:'D'},{num:8,name:'Сгибание рук (косичка)',sets:'7 кг × 15, 7 кг × 15, 7 кг × 15, 7 кг × 15',superset:'D'}],
  [{num:1,name:'Трастеры',sets:'5 кг × 15'},{num:2,name:'Выпад назад с гантелей в руке над головой',sets:'5 кг × 20'},{num:3,name:'Рывок гантели одной рукой',sets:'7 кг × 20'},{num:4,name:'Боковой выпад с подъемом гантели над головой',sets:'7 кг × 20'},{num:5,name:'Спайдер',sets:'× 20'}],
]

const SUPERSET_COLORS={'A':PUR,'B':TEA,'C':COR,'D':BLU}

const PROGRAMS_MAP={'Full Body':FULL_BODY_PROGRAM,'Сплит':SPLIT_PROGRAM,'Домашние тренировки':HOME_PROGRAM,'Похудение':WEIGHT_LOSS_PROGRAM}

const makeDefaultSlots=folder=>
  Array.from({length:SLOT_COUNT},(_,i)=>{
    const slotId=`${folder.replace(/\s+/g,'_')}_${i+1}`
    const prog=PROGRAMS_MAP[folder]
    const exercises=prog&&prog[i]
      ?prog[i].map(ex=>({id:`${slotId}_ex${ex.num}`,num:ex.num,name:ex.name,sets:ex.sets,superset:ex.superset||null,videoId:null,videoUrl:null,videoName:null}))
      :[]
    return {id:slotId,slotNum:i+1,title:`Тренировка ${i+1}`,exercises}
  })

const makeDefaultFolderSlots=()=>{
  const o={}; FOLDERS.forEach(f=>{o[f]=makeDefaultSlots(f)}); return o
}

function WorkoutsView({ customExercises, setCustomExercises, onWorkoutComplete, onWorkoutUpdate, editTarget, onClearEdit, onWorkoutActiveChange, pendingAction, onClearPendingAction, onOpenAI }) {
  const [openFolder,setOpenFolder]=useState(null)
  const [openSlotId,setOpenSlotId]=useState(null)
  const [openSlotHeaderMenu,setOpenSlotHeaderMenu]=useState(false)
  const [openExMenu,setOpenExMenu]=useState(null)
  const [folderSlots,setFolderSlots]=useState(makeDefaultFolderSlots)
  const [playVideo,setPlayVideo]=useState(null)
  const [editingSlotTitle,setEditingSlotTitle]=useState(null) // {id,title}
  const [editingExercise,setEditingExercise]=useState(null)   // {slotId,exId,name,sets}
  const [slotsReady,setSlotsReady]=useState(false)
  const videoInputRef=useRef(null)
  const uploadTargetRef=useRef(null) // {slotId,exId}

  // Загружаем слоты из localStorage + видео из IndexedDB
  useEffect(()=>{
    const meta=JSON.parse(localStorage.getItem('fitpro_slots_meta_v2')||'null')
    if(!meta){setSlotsReady(true);return}
    idbLoadAll().then(items=>{
      const byId={}
      items.forEach(it=>{byId[it.id]=it})
      const loaded=makeDefaultFolderSlots()
      Object.keys(meta).forEach(folder=>{
        if(!loaded[folder])return
        meta[folder].forEach((saved,idx)=>{
          if(!loaded[folder][idx])return
          const savedEx=saved.exercises||[]
          const defExArr=loaded[folder][idx].exercises
          const exercises=savedEx.length>0
            ?savedEx.map((ex,ei)=>{
                // merge superset from program defaults (static, may be missing in old saved data)
                const ss=ex.superset??defExArr[ei]?.superset??null
                const merged={...ex,superset:ss}
                if(!merged.videoId)return merged
                const it=byId[merged.videoId]
                if(!it)return{...merged,videoId:null,videoUrl:null,videoName:null}
                return{...merged,videoUrl:URL.createObjectURL(new Blob([it.buf],{type:it.type||'video/mp4'}))}
              })
            :defExArr
          loaded[folder][idx]={...loaded[folder][idx],title:saved.title||loaded[folder][idx].title,exercises}
        })
      })
      setFolderSlots(loaded)
      setSlotsReady(true)
    })
  },[])

  // Сохраняем метаданные (без videoUrl) при изменении
  useEffect(()=>{
    if(!slotsReady)return
    const meta={}
    Object.keys(folderSlots).forEach(folder=>{
      meta[folder]=folderSlots[folder].map(slot=>({
        id:slot.id,slotNum:slot.slotNum,title:slot.title,
        exercises:slot.exercises.map(({videoUrl,...rest})=>rest)
      }))
    })
    localStorage.setItem('fitpro_slots_meta_v2',JSON.stringify(meta))
  },[folderSlots,slotsReady])
  const [menuOpen,setMenuOpen]=useState(false)
  const [step,setStep]=useState(null)
  const [wName,setWName]=useState('Новая тренировка')
  const [wColor,setWColor]=useState('#D85A30')
  const [wExercises,setWExercises]=useState([])
  const [wMode,setWMode]=useState('start') // 'start' | 'log'
  const [wDate,setWDate]=useState('')

  const [timer,setTimer]=useState(0)
  const intervalRef=useRef(null)

  const [swTime,setSwTime]=useState(0)
  const [swRunning,setSwRunning]=useState(false)
  const swRef=useRef(null)

  const [pickOpen,setPickOpen]=useState(false)
  const [pickQ,setPickQ]=useState('')
  const [pickMuscle,setPickMuscle]=useState('Все')

  const [customOpen,setCustomOpen]=useState(false)
  const [customForm,setCustomForm]=useState({n:'',m:'',eq:''})
  const [isEditMode,setIsEditMode]=useState(false)
  const [wComment,setWComment]=useState('')
  const [openSetNote,setOpenSetNote]=useState(null) // {ei,si}
  const [setVideos,setSetVideos]=useState({}) // '${ei}_${si}' → {url,name}
  const [showSendModal,setShowSendModal]=useState(false)
  const [sendCopied,setSendCopied]=useState(false)
  const setVideoInputRef=useRef(null)
  const setVideoUploadTarget=useRef(null)

  useEffect(()=>{
    if(editTarget&&!isEditMode){
      const w=editTarget.workout
      setWName(w.name||'Тренировка')
      setWColor(w.color||'#D85A30')
      setWExercises((w.exercises||[]).map(ex=>({...ex,sets:(ex.sets||[]).map(s=>({...s})),done:false})))
      const isLog=w.duration===null||w.duration===undefined
      setWMode(isLog?'log':'start')
      if(isLog&&w.date)setWDate(new Date(w.date).toISOString().split('T')[0])
      setTimer(0);setSwTime(0);setSwRunning(false)
      setWComment(w.comment||'')
      setIsEditMode(true)
      setStep('active')
    }
  },[editTarget])

  useEffect(()=>{
    if(onWorkoutActiveChange)onWorkoutActiveChange(step==='active')
  },[step])

  useEffect(()=>{
    if(pendingAction&&(pendingAction==='start'||pendingAction==='done')&&!step&&!isEditMode){
      handleAction(pendingAction)
      if(onClearPendingAction)onClearPendingAction()
    }
  },[pendingAction])

  useEffect(()=>{
    if(step==='active'&&wMode==='start'){intervalRef.current=setInterval(()=>setTimer(t=>t+1),1000)}
    else{clearInterval(intervalRef.current)}
    return ()=>clearInterval(intervalRef.current)
  },[step,wMode])

  useEffect(()=>{
    if(swRunning){swRef.current=setInterval(()=>setSwTime(t=>t+1),1000)}
    else{clearInterval(swRef.current)}
    return ()=>clearInterval(swRef.current)
  },[swRunning])

  const fmt=s=>{
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  const handleAction=key=>{
    setMenuOpen(false)
    if(key==='start'){
      setWName('Новая тренировка');setWColor('#D85A30');setWExercises([]);setTimer(0);setSwTime(0);setSwRunning(false);setWMode('start');setWDate('');setStep('naming')
    }
    if(key==='done'){
      const today=new Date().toISOString().split('T')[0]
      setWName('Тренировка');setWColor('#1D9E75');setWExercises([]);setWMode('log');setWDate(today);setStep('naming')
    }
  }

  const allExercises=[...EXERCISES,...customExercises]
  const muscles=['Все',...new Set(allExercises.map(e=>e.m))]
  const filteredEx=allExercises.filter(e=>(pickMuscle==='Все'||e.m===pickMuscle)&&e.n.toLowerCase().includes(pickQ.toLowerCase()))

  const pickExercise=ex=>{
    setWExercises(p=>[...p,{...ex,sets:[{kg:'',reps:''}],done:false}])
    setPickOpen(false);setPickQ('');setPickMuscle('Все')
  }

  const saveCustomExercise=()=>{
    if(!customForm.n.trim())return
    const newEx={n:customForm.n.trim(),m:customForm.m.trim(),eq:customForm.eq.trim(),custom:true}
    setCustomExercises(p=>[...p,newEx])
    pickExercise(newEx)
    setCustomForm({n:'',m:'',eq:''})
    setCustomOpen(false)
  }

  const exitWorkout=()=>{
    setStep(null);setTimer(0);setSwTime(0);setSwRunning(false);setWExercises([]);setWMode('start');setWDate('')
    setIsEditMode(false)
    setWComment('');setOpenSetNote(null);setSetVideos({});setShowSendModal(false)
    if(onClearEdit)onClearEdit()
  }

  const finishWorkout=()=>{
    if(wExercises.length>0){
      const date=wMode==='log'&&wDate
        ?new Date(wDate+'T12:00:00').toISOString()
        :(isEditMode&&editTarget?editTarget.workout.date:new Date().toISOString())
      const updated={name:wName,color:wColor,exercises:wExercises,duration:wMode==='start'?timer:null,date,comment:wComment}
      if(isEditMode&&editTarget){
        onWorkoutUpdate(editTarget.histIdx,updated)
      } else {
        onWorkoutComplete(updated)
      }
    }
    exitWorkout()
  }

  const exTonnage=ex=>ex.sets.reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)

  const formatWorkoutReport=()=>{
    const lines=[`🏋️ ${wName}`,`📅 ${new Date().toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})}`,'']
    wExercises.forEach((ex,ei)=>{
      lines.push(`${ei+1}. ${ex.n}`)
      ex.sets.forEach((s,si)=>{
        const w=[]
        if(s.kg)w.push(`${s.kg} кг`)
        if(s.reps)w.push(`${s.reps} повт`)
        const vid=setVideos[`${ei}_${si}`]?` 🎬 ${setVideos[`${ei}_${si}`].name}`:''
        const nt=s.note?`\n      📝 ${s.note}`:''
        lines.push(`   ${si+1}. ${w.join(' × ')||'—'}${vid}${nt}`)
      })
    })
    if(wComment){lines.push('');lines.push(`💬 ${wComment}`)}
    return lines.join('\n')
  }

  const copyReport=()=>{
    navigator.clipboard.writeText(formatWorkoutReport()).then(()=>{
      setSendCopied(true);setTimeout(()=>setSendCopied(false),2000)
    }).catch(()=>{})
  }

  const updateSlots=fn=>setFolderSlots(prev=>{
    const next={}
    Object.keys(prev).forEach(f=>{next[f]=prev[f].map(fn)})
    return next
  })

  const handleVideoUpload=async(e)=>{
    const target=uploadTargetRef.current
    if(!target)return
    const file=e.target.files[0]
    if(!file)return
    const id=Date.now().toString(36)+Math.random().toString(36).slice(2)
    await idbSave(id,file)
    const videoUrl=URL.createObjectURL(file)
    updateSlots(s=>{
      if(s.id!==target.slotId)return s
      return{...s,exercises:s.exercises.map(ex=>ex.id===target.exId?{...ex,videoId:id,videoUrl,videoName:file.name}:ex)}
    })
    uploadTargetRef.current=null
    e.target.value=''
  }

  const removeExerciseVideo=async(slotId,exId,videoId)=>{
    await idbDelete(videoId)
    updateSlots(s=>{
      if(s.id!==slotId)return s
      return{...s,exercises:s.exercises.map(ex=>ex.id===exId?{...ex,videoId:null,videoUrl:null,videoName:null}:ex)}
    })
  }

  const addExercise=slotId=>{
    updateSlots(s=>{
      if(s.id!==slotId)return s
      const num=s.exercises.length+1
      const id=`ex_${Date.now().toString(36)}_${num}`
      return{...s,exercises:[...s.exercises,{id,num,name:'',sets:'',videoId:null,videoUrl:null,videoName:null}]}
    })
  }

  const deleteExercise=async(slotId,exId)=>{
    let vid=null
    Object.values(folderSlots).forEach(arr=>arr.forEach(s=>{if(s.id===slotId){const ex=s.exercises.find(e=>e.id===exId);if(ex&&ex.videoId)vid=ex.videoId}}))
    if(vid)await idbDelete(vid)
    updateSlots(s=>{
      if(s.id!==slotId)return s
      return{...s,exercises:s.exercises.filter(ex=>ex.id!==exId)}
    })
  }

  const saveExercise=()=>{
    if(!editingExercise)return
    const{slotId,exId,name,sets}=editingExercise
    updateSlots(s=>s.id===slotId?{...s,exercises:s.exercises.map(ex=>ex.id===exId?{...ex,name,sets}:ex)}:s)
    setEditingExercise(null)
  }

  const saveSlotTitle=()=>{
    if(!editingSlotTitle)return
    updateSlots(s=>s.id===editingSlotTitle.id?{...s,title:editingSlotTitle.title}:s)
    setEditingSlotTitle(null)
  }

  const deleteSlot=(slotId)=>{
    setFolderSlots(prev=>{
      const next={}
      Object.keys(prev).forEach(f=>{next[f]=prev[f].filter(s=>s.id!==slotId)})
      return next
    })
    setOpenSlotId(null)
  }

  const allSlots=Object.values(folderSlots).flat()
  const currentSlot=openSlotId?allSlots.find(s=>s.id===openSlotId):null

  // ── Активная тренировка
  if(step==='active'){
    return (
      <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 40px)', background:'#111', borderRadius:14, overflow:'hidden', color:'#fff', position:'relative' }}>

        {/* Мини-попап нового упражнения */}
        {customOpen&&(
          <div style={{ position:'absolute', inset:0, zIndex:300, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.6)', borderRadius:14 }}
            onClick={()=>setCustomOpen(false)}>
            <div style={{ background:'#1c1c1e', borderRadius:14, padding:'22px 20px 18px', width:300, boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
                <span style={{ fontSize:15, fontWeight:700, color:'#fff' }}>Новое упражнение</span>
                <button onClick={()=>setCustomOpen(false)} style={{ background:'none', border:'none', color:'#6b7280', fontSize:18, cursor:'pointer' }}>✕</button>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:'#6b7280', marginBottom:5 }}>Название *</div>
                  <input value={customForm.n} onChange={e=>setCustomForm(f=>({...f,n:e.target.value}))}
                    placeholder="Например: Жим гантелей лёжа" autoFocus
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:8, border:'1px solid #374151', background:'#2a2a2e', color:'#fff', boxSizing:'border-box', outline:'none' }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:'#6b7280', marginBottom:5 }}>Группа мышц</div>
                  <input value={customForm.m} onChange={e=>setCustomForm(f=>({...f,m:e.target.value}))}
                    placeholder="Например: Грудь, Ноги, Спина..."
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:8, border:'1px solid #374151', background:'#2a2a2e', color:'#fff', boxSizing:'border-box', outline:'none' }} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:'#6b7280', marginBottom:5 }}>Оборудование</div>
                  <input value={customForm.eq} onChange={e=>setCustomForm(f=>({...f,eq:e.target.value}))}
                    placeholder="Например: Гантели, Штанга..."
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:8, border:'1px solid #374151', background:'#2a2a2e', color:'#fff', boxSizing:'border-box', outline:'none' }} />
                </div>
                <div style={{ display:'flex', gap:8, marginTop:4 }}>
                  <button onClick={()=>setCustomOpen(false)} style={{ flex:1, padding:'10px', fontSize:13, borderRadius:8, border:'1px solid #374151', background:'none', color:'#9ca3af', cursor:'pointer' }}>Отмена</button>
                  <button onClick={saveCustomExercise} style={{ flex:1, padding:'10px', fontSize:13, borderRadius:8, border:'none', background:wColor, color:'#fff', fontWeight:600, cursor:'pointer' }}>Добавить</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Пикер упражнений */}
        {pickOpen&&(
          <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.8)', zIndex:200, display:'flex', flexDirection:'column', borderRadius:14, overflow:'hidden' }}>
            <div style={{ background:'#1c1c1e', padding:'16px 18px 12px', borderBottom:'1px solid #2a2a2a', flexShrink:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <span style={{ fontSize:16, fontWeight:700, color:'#fff' }}>Упражнения</span>
                <button onClick={()=>{setPickOpen(false);setPickQ('');setPickMuscle('Все')}} style={{ background:'none', border:'none', color:'#9ca3af', fontSize:20, cursor:'pointer' }}>✕</button>
              </div>
              <div style={{ display:'flex', gap:8, marginBottom:10 }}>
                <input value={pickQ} onChange={e=>setPickQ(e.target.value)} placeholder="Поиск упражнения..."
                  style={{ flex:1, padding:'9px 12px', fontSize:13, borderRadius:8, border:'1px solid #374151', background:'#2a2a2e', color:'#fff', boxSizing:'border-box' }} />
                <button onClick={()=>{setCustomOpen(true);setCustomForm({n:'',m:'',eq:''})}}
                  style={{ padding:'9px 13px', fontSize:12, fontWeight:600, borderRadius:8, border:'none', background:wColor, color:'#fff', cursor:'pointer', whiteSpace:'nowrap' }}>
                  Добавить упражнение +
                </button>
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {muscles.map(m=>(
                  <button key={m} onClick={()=>setPickMuscle(m)} style={{ fontSize:11, padding:'4px 10px', borderRadius:20, cursor:'pointer', border:'none', background:pickMuscle===m?wColor:'#2a2a2e', color:pickMuscle===m?'#fff':'#9ca3af', fontWeight:pickMuscle===m?600:400 }}>{m}</button>
                ))}
              </div>
            </div>
            <div style={{ flex:1, overflowY:'auto' }}>
              {filteredEx.length===0&&<div style={{ textAlign:'center', color:'#6b7280', marginTop:40, fontSize:13 }}>Ничего не найдено</div>}
              {filteredEx.map((ex,i)=>(
                <button key={i} onClick={()=>pickExercise(ex)}
                  style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%', padding:'13px 18px', background:'none', border:'none', borderBottom:'1px solid #1f2937', cursor:'pointer', textAlign:'left' }}
                  onMouseEnter={e=>e.currentTarget.style.background='#1f2937'}
                  onMouseLeave={e=>e.currentTarget.style.background='none'}>
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:14, fontWeight:500, color:'#fff' }}>{ex.n}</span>
                      {ex.custom&&<span style={{ fontSize:10, padding:'2px 6px', borderRadius:6, background:wColor+'33', color:wColor }}>моё</span>}
                    </div>
                    <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{ex.m}{ex.eq?` · ${ex.eq}`:''}</div>
                  </div>
                  <span style={{ color:wColor, fontSize:18, fontWeight:300 }}>+</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Шапка: название → время */}
        <div style={{ background:wColor, padding:'14px 18px 16px', flexShrink:0 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ fontSize:22, fontWeight:700, color:'#fff' }}>{wName}</div>
                {isEditMode&&<span style={{ fontSize:10, padding:'2px 7px', borderRadius:6, background:'rgba(0,0,0,0.25)', color:'#fff' }}>редактирование</span>}
              </div>
              {wMode==='start'&&<div style={{ fontSize:14, color:'rgba(255,255,255,0.7)', marginTop:3 }}>⏱ {fmt(timer)}</div>}
              {wMode==='log'&&wDate&&<div style={{ fontSize:14, color:'rgba(255,255,255,0.7)', marginTop:3 }}>📅 {new Date(wDate+'T12:00:00').toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})}</div>}
            </div>
            <button onClick={exitWorkout} style={{ fontSize:12, color:'#fff', background:'rgba(0,0,0,0.25)', border:'none', borderRadius:6, padding:'5px 11px', cursor:'pointer', marginTop:4, flexShrink:0 }}>✕ Выйти</button>
          </div>
        </div>

        {/* Контент */}
        <div style={{ flex:1, overflowY:'auto', padding:'14px 18px' }}>

          {/* Секундомер — только в режиме активной тренировки */}
          {wMode==='start'&&(
            <div style={{ background:'#1c1c1e', borderRadius:12, padding:'14px 18px 16px', marginBottom:16, textAlign:'center' }}>
              <div style={{ fontSize:10, color:'#6b7280', textTransform:'uppercase', letterSpacing:2, marginBottom:8 }}>Секундомер</div>
              <div style={{ fontSize:46, fontWeight:700, color:'#fff', fontVariantNumeric:'tabular-nums', letterSpacing:2, marginBottom:14 }}>
                {fmt(swTime)}
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
                <button onClick={()=>setSwRunning(r=>!r)}
                  style={{ padding:'10px 32px', borderRadius:8, border:'none', background:swRunning?'#374151':wColor, color:'#fff', fontSize:14, fontWeight:600, cursor:'pointer' }}>
                  {swRunning?'⏸ Стоп':'▶ Старт'}
                </button>
                <button onClick={()=>{setSwRunning(false);setSwTime(0)}}
                  style={{ padding:'10px 18px', borderRadius:8, border:'1px solid #374151', background:'none', color:'#9ca3af', fontSize:14, cursor:'pointer' }}>
                  ↺
                </button>
              </div>
            </div>
          )}

          {/* Упражнения */}
          {wExercises.length===0?(
            <div style={{ textAlign:'center', marginTop:40 }}>
              <div style={{ fontSize:18, fontWeight:600, color:'#fff', marginBottom:8 }}>
                {wMode==='log'?'Добавьте упражнения':'Тренировка началась'}
              </div>
              <div style={{ fontSize:14, color:'#9ca3af', lineHeight:1.7 }}>Нажмите «+», чтобы добавить упражнения.</div>
            </div>
          ):(
            wExercises.map((ex,ei)=>{
              const tonnage=exTonnage(ex)
              return (
                <div key={ei} style={{ marginBottom:14, background:ex.done?'#0d2010':'#1f2937', borderRadius:10, padding:'12px 14px', border:ex.done?'1px solid #14532d':'none' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                    <span style={{ fontSize:14, fontWeight:600, color:ex.done?'#4ade80':wColor }}>{ex.n}</span>
                    {ex.done&&<span style={{ fontSize:11, color:'#4ade80' }}>✓ Выполнено</span>}
                  </div>

                  {ex.done?(
                    <div>
                      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:8 }}>
                        {ex.sets.map((s,si)=>(s.kg||s.reps)&&(
                          <span key={si} style={{ fontSize:11, color:'#9ca3af' }}>{si+1}. {s.kg||'—'}кг × {s.reps||'—'}</span>
                        ))}
                      </div>
                      <div style={{ fontSize:16, fontWeight:700, color:'#4ade80' }}>Тоннаж: {tonnage} кг</div>
                      <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,done:false}:x))}
                        style={{ marginTop:6, fontSize:11, color:'#6b7280', background:'none', border:'none', cursor:'pointer', padding:0 }}>
                        ↩ Редактировать
                      </button>
                    </div>
                  ):(
                    <>
                      <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 26px 26px 20px', gap:5, marginBottom:5 }}>
                        {['#','КГ','ПОВТ','','',''].map((h,i)=>(
                          <span key={i} style={{ fontSize:10, color:'#6b7280', textAlign:'center', textTransform:'uppercase' }}>{h}</span>
                        ))}
                      </div>
                      {ex.sets.map((set,si)=>{
                        const noteOpen=openSetNote?.ei===ei&&openSetNote?.si===si
                        const hasVid=!!setVideos[`${ei}_${si}`]
                        return(
                          <div key={si} style={{ marginBottom:noteOpen?3:5 }}>
                            <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 26px 26px 20px', gap:5, alignItems:'center' }}>
                              <span style={{ fontSize:12, color:'#6b7280', textAlign:'center', fontWeight:700 }}>{si+1}</span>
                              <input value={set.kg}
                                onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,kg:e.target.value}:s)}:x))}
                                placeholder="0"
                                style={{ background:'#374151', border:'1px solid #4b5563', borderRadius:6, padding:'6px 6px', fontSize:13, color:'#fff', textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                              <input value={set.reps}
                                onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,reps:e.target.value}:s)}:x))}
                                placeholder="0"
                                style={{ background:'#374151', border:'1px solid #4b5563', borderRadius:6, padding:'6px 6px', fontSize:13, color:'#fff', textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                              <button onClick={()=>setOpenSetNote(noteOpen?null:{ei,si})}
                                style={{ width:26, height:26, borderRadius:6, border:'none', background:set.note?`${PUR}50`:'#374151', color:set.note?PUR:'#6b7280', cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center' }}>📝</button>
                              <button onClick={()=>{setVideoUploadTarget.current={ei,si};setVideoInputRef.current.click()}}
                                style={{ width:26, height:26, borderRadius:6, border:'none', background:hasVid?`${TEA}50`:'#374151', color:hasVid?TEA:'#6b7280', cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center' }}>🎬</button>
                              <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.filter((_,j)=>j!==si)}:x).filter(x=>x.sets.length>0))}
                                style={{ background:'none', border:'none', color:'#6b7280', cursor:'pointer', fontSize:14, textAlign:'center' }}>✕</button>
                            </div>
                            {noteOpen&&(
                              <input value={set.note||''} autoFocus
                                onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,note:e.target.value}:s)}:x))}
                                placeholder="Заметка к подходу..."
                                style={{ width:'100%', background:'#1f2937', border:'1px solid #374151', borderRadius:6, padding:'5px 10px', fontSize:12, color:'#e5e7eb', marginTop:3, boxSizing:'border-box', outline:'none' }} />
                            )}
                            {hasVid&&(
                              <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3, fontSize:11, color:TEA }}>
                                🎬 {setVideos[`${ei}_${si}`].name}
                                <button onClick={()=>{URL.revokeObjectURL(setVideos[`${ei}_${si}`].url);setSetVideos(v=>{const n={...v};delete n[`${ei}_${si}`];return n})}}
                                  style={{ background:'none', border:'none', color:'#6b7280', cursor:'pointer', fontSize:12, padding:0 }}>✕</button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:6 }}>
                        <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:[...x.sets,{kg:'',reps:''}]}:x))}
                          style={{ fontSize:12, color:wColor, background:'none', border:'none', cursor:'pointer', fontWeight:600, padding:0 }}>
                          + Подход
                        </button>
                        <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,done:true}:x))}
                          style={{ fontSize:12, color:'#fff', background:'#16a34a', border:'none', borderRadius:6, padding:'6px 14px', cursor:'pointer', fontWeight:600 }}>
                          ✓ Завершить упражнение
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Поле комментария к тренировке */}
        <div style={{ padding:'8px 14px', background:'#111', borderTop:'1px solid #1f2937', flexShrink:0 }}>
          <textarea value={wComment} onChange={e=>setWComment(e.target.value)} placeholder="💬 Комментарий к тренировке..." rows={2}
            style={{ width:'100%', background:'#1f2937', border:'1px solid #374151', borderRadius:8, padding:'7px 11px', fontSize:12, color:'#e5e7eb', resize:'none', outline:'none', fontFamily:'inherit', boxSizing:'border-box', lineHeight:1.5 }} />
        </div>

        {/* Нижняя панель */}
        <div style={{ padding:'10px 18px', display:'flex', justifyContent:'space-between', alignItems:'center', background:'#111', flexShrink:0 }}>
          <button onClick={()=>setPickOpen(true)} style={{ width:42, height:42, borderRadius:'50%', border:'2px solid #374151', background:'none', color:'#9ca3af', fontSize:22, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>+</button>
          <button onClick={finishWorkout} style={{ padding:'12px 36px', borderRadius:24, border:'none', background:wColor, color:'#fff', fontSize:15, fontWeight:700, cursor:'pointer', boxShadow:`0 4px 16px ${wColor}66` }}>
            {isEditMode?'Сохранить':'Завершить'}
          </button>
          <button onClick={()=>setShowSendModal(true)} style={{ width:42, height:42, borderRadius:'50%', border:'2px solid #374151', background:'none', color:'#9ca3af', fontSize:20, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>📤</button>
        </div>

        {/* Модал "Отправить тренеру" */}
        {showSendModal&&(
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1200, display:'flex', alignItems:'flex-end', justifyContent:'center' }}
            onClick={()=>setShowSendModal(false)}>
            <div onClick={e=>e.stopPropagation()} style={{ background:'#1f2937', borderRadius:'16px 16px 0 0', padding:'20px 18px', width:'100%', maxWidth:500, maxHeight:'75vh', display:'flex', flexDirection:'column' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14, flexShrink:0 }}>
                <span style={{ fontSize:16, fontWeight:700, color:'#fff' }}>📤 Отчёт тренеру</span>
                <button onClick={()=>setShowSendModal(false)} style={{ background:'none', border:'none', color:'#9ca3af', fontSize:22, cursor:'pointer', padding:0, lineHeight:1 }}>✕</button>
              </div>
              <pre style={{ background:'#111', borderRadius:10, padding:'12px 14px', fontSize:12, color:'#e5e7eb', whiteSpace:'pre-wrap', fontFamily:'monospace', flex:1, overflowY:'auto', lineHeight:1.7, marginBottom:14 }}>
                {formatWorkoutReport()}
              </pre>
              <button onClick={copyReport} style={{ width:'100%', padding:'13px', borderRadius:10, border:'none', background:sendCopied?TEA:PUR, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', transition:'background 0.2s', flexShrink:0 }}>
                {sendCopied?'✓ Скопировано!':'📋 Скопировать отчёт'}
              </button>
            </div>
          </div>
        )}

        {/* Скрытый input для видео подхода */}
        <input ref={setVideoInputRef} type="file" accept="video/*" style={{ display:'none' }}
          onChange={e=>{
            const file=e.target.files[0]
            if(!file||!setVideoUploadTarget.current)return
            const {ei,si}=setVideoUploadTarget.current
            setSetVideos(v=>({...v,[`${ei}_${si}`]:{url:URL.createObjectURL(file),name:file.name}}))
            e.target.value=''
          }} />
      </div>
    )
  }

  // ── Список программ
  return (
    <div style={{ position:'relative' }}>
      {menuOpen&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setMenuOpen(false)}>
          <div style={{ background:'#fff', borderRadius:16, padding:'22px 22px 18px', width:370, boxShadow:'0 12px 40px rgba(0,0,0,0.18)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:'#111' }}>Новая тренировка</h3>
              <button onClick={()=>setMenuOpen(false)} style={{ border:'none', background:'none', fontSize:18, color:'#9ca3af', cursor:'pointer' }}>✕</button>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              {WORKOUT_ACTIONS.map(a=>(
                <button key={a.key} onClick={()=>handleAction(a.key)}
                  style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 14px', border:'1px solid #e5e7eb', borderRadius:10, background:'#fafafa', cursor:'pointer', textAlign:'left', width:'100%' }}
                  onMouseEnter={e=>e.currentTarget.style.background='#f0effe'}
                  onMouseLeave={e=>e.currentTarget.style.background='#fafafa'}>
                  <span style={{ fontSize:22, flexShrink:0 }}>{a.icon}</span>
                  <div>
                    <div style={{ fontSize:13, fontWeight:500, color:'#111' }}>{a.label}</div>
                    <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{a.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step==='naming'&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setStep(null)}>
          <div style={{ background:'#1c1c1e', borderRadius:16, padding:'22px 22px 18px', width:340, boxShadow:'0 16px 48px rgba(0,0,0,0.5)' }}
            onClick={e=>e.stopPropagation()}>
            <h3 style={{ margin:'0 0 18px', fontSize:16, fontWeight:700, color:'#fff', textAlign:'center' }}>
              {wMode==='log'?'Добавить тренировку':'Новая тренировка'}
            </h3>
            <div style={{ borderBottom:'1px solid #2c2c2e', paddingBottom:14, marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:15, color:'#fff' }}>Название</span>
              <input value={wName} onChange={e=>setWName(e.target.value)}
                style={{ background:'none', border:'none', outline:'none', fontSize:15, color:'#9ca3af', textAlign:'right', width:170 }} />
            </div>
            {wMode==='log'&&(
              <div style={{ borderBottom:'1px solid #2c2c2e', paddingBottom:14, marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontSize:15, color:'#fff' }}>Дата</span>
                <input type="date" value={wDate} onChange={e=>setWDate(e.target.value)}
                  style={{ background:'none', border:'none', outline:'none', fontSize:15, color:'#9ca3af', textAlign:'right', colorScheme:'dark', cursor:'pointer' }} />
              </div>
            )}
            <div style={{ borderBottom:'1px solid #2c2c2e', paddingBottom:14, marginBottom:18 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <span style={{ fontSize:15, color:'#fff' }}>Цвет</span>
                <div style={{ width:26, height:26, borderRadius:'50%', background:wColor }} />
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
                {WCOLORS.map(c=>(
                  <button key={c} onClick={()=>setWColor(c)} style={{ width:32, height:32, borderRadius:'50%', background:c, border:wColor===c?'3px solid #fff':'3px solid transparent', cursor:'pointer', outline:wColor===c?`2px solid ${c}`:'none', outlineOffset:1 }} />
                ))}
              </div>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <button onClick={()=>setStep(null)} style={{ background:'none', border:'none', color:wColor, fontSize:15, fontWeight:500, cursor:'pointer' }}>Отменить</button>
              <button onClick={()=>setStep('active')} style={{ padding:'11px 28px', borderRadius:24, border:'none', background:wColor, color:'#fff', fontSize:15, fontWeight:700, cursor:'pointer' }}>
                {wMode==='log'?'Добавить':'Начать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Скрытый input */}
      <input ref={videoInputRef} type="file" accept="video/*" style={{ display:'none' }}
        onChange={handleVideoUpload} />

      {/* Попап: переименование тренировки */}
      {editingSlotTitle&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setEditingSlotTitle(null)}>
          <div style={{ background:'#fff', borderRadius:16, padding:'22px', width:380, maxWidth:'94vw', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <span style={{ fontSize:16, fontWeight:700, color:'#111' }}>Название тренировки</span>
              <button onClick={()=>setEditingSlotTitle(null)} style={{ background:'none', border:'none', fontSize:20, color:'#9ca3af', cursor:'pointer', minHeight:'unset' }}>✕</button>
            </div>
            <input value={editingSlotTitle.title}
              onChange={e=>setEditingSlotTitle(s=>({...s,title:e.target.value}))}
              placeholder="Название тренировки"
              style={{ width:'100%', padding:'11px 13px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', outline:'none', color:'#111', fontFamily:'inherit', boxSizing:'border-box' }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'}
            />
            <div style={{ display:'flex', gap:10, marginTop:16 }}>
              <button onClick={()=>setEditingSlotTitle(null)}
                style={{ flex:1, padding:'12px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', background:'none', color:'#6b7280', cursor:'pointer' }}>Отмена</button>
              <button onClick={saveSlotTitle}
                style={{ flex:2, padding:'12px', fontSize:14, borderRadius:10, border:'none', background:PUR, color:'#fff', fontWeight:700, cursor:'pointer' }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* Попап: редактирование упражнения */}
      {editingExercise&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setEditingExercise(null)}>
          <div style={{ background:'#fff', borderRadius:16, padding:'22px', width:440, maxWidth:'94vw', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <span style={{ fontSize:16, fontWeight:700, color:'#111' }}>Редактировать упражнение</span>
              <button onClick={()=>setEditingExercise(null)} style={{ background:'none', border:'none', fontSize:20, color:'#9ca3af', cursor:'pointer', minHeight:'unset' }}>✕</button>
            </div>
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, color:'#6b7280', marginBottom:6 }}>Название упражнения</div>
              <input value={editingExercise.name}
                onChange={e=>setEditingExercise(v=>({...v,name:e.target.value}))}
                placeholder="Приседания"
                style={{ width:'100%', padding:'11px 13px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', outline:'none', color:'#111', fontFamily:'inherit', boxSizing:'border-box' }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'}
              />
            </div>
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, color:'#6b7280', marginBottom:6 }}>Подходы / вес / повторения</div>
              <textarea value={editingExercise.sets}
                onChange={e=>setEditingExercise(v=>({...v,sets:e.target.value}))}
                placeholder="20 кг × 15, 25 кг × 12, 25 кг × 12"
                rows={4}
                style={{ width:'100%', padding:'11px 13px', fontSize:13, borderRadius:10, border:'1.5px solid #e5e7eb', outline:'none', color:'#111', resize:'vertical', lineHeight:1.65, fontFamily:'inherit', boxSizing:'border-box' }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'}
              />
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={()=>setEditingExercise(null)}
                style={{ flex:1, padding:'12px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', background:'none', color:'#6b7280', cursor:'pointer' }}>Отмена</button>
              <button onClick={saveExercise}
                style={{ flex:2, padding:'12px', fontSize:14, borderRadius:10, border:'none', background:PUR, color:'#fff', fontWeight:700, cursor:'pointer' }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* Попап просмотра видео */}
      {playVideo&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.92)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setPlayVideo(null)}>
          <div style={{ position:'relative', maxWidth:860, width:'95%' }} onClick={e=>e.stopPropagation()}>
            <button onClick={()=>setPlayVideo(null)}
              style={{ position:'absolute', top:-42, right:0, background:'none', border:'none', color:'#fff', fontSize:26, cursor:'pointer', minHeight:'unset' }}>✕</button>
            <div style={{ fontSize:13, color:'#9ca3af', marginBottom:8 }}>{playVideo.name}</div>
            <video src={playVideo.url} controls autoPlay style={{ width:'100%', borderRadius:12, maxHeight:'75vh' }} />
          </div>
        </div>
      )}

      {/* ── Уровень 2: упражнения тренировки ── */}
      {currentSlot&&createPortal(
        <div style={{ position:'fixed', inset:0, background:'#f3f4f6', zIndex:1001, display:'flex', flexDirection:'column' }}>
          <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'14px 18px', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
            <button onClick={()=>setOpenSlotId(null)}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:'#6b7280', lineHeight:1, padding:0, minHeight:'unset' }}>←</button>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:17, fontWeight:700, color:'#111', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{currentSlot.title}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{currentSlot.exercises.length} упражнений</div>
            </div>
            <div style={{ position:'relative' }}>
              <button onClick={e=>{e.stopPropagation();setOpenSlotHeaderMenu(v=>!v)}}
                style={{ background:'none',border:'1px solid #e5e7eb',borderRadius:7,fontSize:16,cursor:'pointer',color:'#9ca3af',padding:'2px 8px',minHeight:'unset',lineHeight:1.4,letterSpacing:1 }}>⋯</button>
              {openSlotHeaderMenu&&(
                <>
                  <div onClick={()=>setOpenSlotHeaderMenu(false)} style={{ position:'fixed',inset:0,zIndex:19 }} />
                  <div style={{ position:'absolute',top:34,right:0,background:'#fff',borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:180,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                    <button onClick={()=>{setOpenSlotHeaderMenu(false);setEditingSlotTitle({id:currentSlot.id,title:currentSlot.title})}}
                      style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:'1px solid #f3f4f6',background:'transparent',cursor:'pointer',textAlign:'left',color:'#111',fontSize:13 }}>✏️ Редактировать</button>
                    <button onClick={()=>{setOpenSlotHeaderMenu(false);if(window.confirm(`Удалить тренировку «${currentSlot.title}»?`))deleteSlot(currentSlot.id)}}
                      style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {currentSlot.exercises.length>0&&(
              <button
                onClick={()=>{
                  const exs=currentSlot.exercises.filter(e=>e.name)
                  if(exs.length===0)return
                  setWName(currentSlot.title)
                  setWColor(PUR)
                  setWExercises(exs.map(ex=>{
                    const str=(ex.sets||'').trim()
                    let parsedSets
                    // "20 кг × 15, 25 кг × 12" — подходы с весом
                    const kgMatches=[...str.matchAll(/(\d+(?:[.,]\d+)?)\s*кг\s*[×x]\s*(\d+)/g)]
                    if(kgMatches.length>0){
                      parsedSets=kgMatches.map(m=>({kg:m[1].replace(',','.'),reps:m[2]}))
                    } else {
                      // "3×12" — количество × повторы
                      const sm=str.match(/^(\d+)\s*[×x]\s*(\d+)$/)
                      if(sm){
                        parsedSets=Array.from({length:parseInt(sm[1])},()=>({kg:'',reps:sm[2]}))
                      } else {
                        // "30, 30, 30, 30" — повторы без веса
                        const parts=str.split(',').map(s=>s.trim()).filter(s=>/^\d+$/.test(s))
                        parsedSets=parts.length>0?parts.map(r=>({kg:'',reps:r})):[{kg:'',reps:''}]
                      }
                    }
                    return{n:ex.name,m:'',eq:'',sets:parsedSets,done:false}
                  }))
                  setWMode('start')
                  setWDate('')
                  setTimer(0);setSwTime(0);setSwRunning(false)
                  setStep('active')
                  setOpenSlotId(null)
                }}
                style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:8,width:'100%',padding:'15px',marginBottom:14,borderRadius:12,border:'none',background:TEA,color:'#fff',fontSize:15,fontWeight:700,cursor:'pointer',boxSizing:'border-box',minHeight:'unset' }}>
                ▶ Начать тренировку
              </button>
            )}
            {currentSlot.exercises.length===0&&(
              <div style={{ textAlign:'center', color:'#c7cad1', fontSize:13, marginTop:40 }}>Нажмите «+ Добавить упражнение»</div>
            )}
            {(()=>{
              const exArr=currentSlot.exercises
              const groups=[]
              let gi=0
              while(gi<exArr.length){
                const ex=exArr[gi]
                if(ex.superset&&gi+1<exArr.length&&exArr[gi+1].superset===ex.superset){
                  groups.push({kind:'ss',color:SUPERSET_COLORS[ex.superset]||PUR,items:[ex,exArr[gi+1]]})
                  gi+=2
                } else {
                  groups.push({kind:'single',items:[ex]})
                  gi++
                }
              }
              const renderExBody=(ex,borderTop)=>(
                <div key={ex.id} style={{ padding:'14px 14px 12px', borderTop:borderTop?'1px dashed rgba(0,0,0,0.1)':undefined }}>
                  <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                    <div style={{ flexShrink:0, width:36, height:36, borderRadius:'50%', background:PUR, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:'#fff' }}>{ex.num}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:700, color:'#111', marginBottom:3 }}>{ex.name||'Упражнение'}</div>
                      {ex.sets&&<div style={{ fontSize:12, color:'#6b7280', lineHeight:1.7 }}>{ex.sets}</div>}
                    </div>
                    <div style={{ position:'relative',flexShrink:0 }}>
                      <button onClick={e=>{e.stopPropagation();setOpenExMenu(openExMenu===ex.id?null:ex.id)}}
                        style={{ width:36,height:36,borderRadius:9,background:'#f3f4f6',border:'none',cursor:'pointer',fontSize:17,color:'#6b7280',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,letterSpacing:1,minHeight:'unset' }}>⋯</button>
                      {openExMenu===ex.id&&(
                        <>
                          <div onClick={()=>setOpenExMenu(null)} style={{ position:'fixed',inset:0,zIndex:19 }} />
                          <div style={{ position:'absolute',top:40,right:0,background:'#fff',borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:180,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                            <button onClick={()=>{setOpenExMenu(null);setEditingExercise({slotId:currentSlot.id,exId:ex.id,name:ex.name,sets:ex.sets})}}
                              style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:'1px solid #f3f4f6',background:'transparent',cursor:'pointer',textAlign:'left',color:'#111',fontSize:13 }}>✏️ Редактировать</button>
                            <button onClick={()=>{setOpenExMenu(null);deleteExercise(currentSlot.id,ex.id)}}
                              style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ marginTop:10, paddingTop:10, borderTop:'1px solid #f3f4f6' }}>
                    {ex.videoId?(
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ fontSize:18 }}>📹</span>
                        <div style={{ flex:1, minWidth:0, fontSize:11, color:'#6b7280', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ex.videoName}</div>
                        <button onClick={()=>setPlayVideo({url:ex.videoUrl,name:ex.videoName})}
                          style={{ width:36, height:36, borderRadius:9, background:`${PUR}18`, border:'none', cursor:'pointer', fontSize:16, color:PUR, display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset' }}>▶</button>
                        <button onClick={()=>removeExerciseVideo(currentSlot.id,ex.id,ex.videoId)}
                          style={{ width:36, height:36, borderRadius:9, background:'#fef2f2', border:'none', cursor:'pointer', color:'#ef4444', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset' }}>✕</button>
                      </div>
                    ):(
                      <button onClick={()=>{uploadTargetRef.current={slotId:currentSlot.id,exId:ex.id};videoInputRef.current.click()}}
                        style={{ fontSize:12, color:PUR, background:'#EEEDFE', border:'none', borderRadius:8, padding:'7px 14px', cursor:'pointer', fontWeight:600, minHeight:'unset' }}>
                        📹 Добавить видео
                      </button>
                    )}
                  </div>
                </div>
              )
              return groups.map((g,gi2)=>g.kind==='ss'?(
                <div key={g.items[0].id} style={{ borderRadius:13, overflow:'hidden', marginBottom:10, border:`1.5px solid ${g.color}40`, boxShadow:`0 1px 4px ${g.color}18` }}>
                  <div style={{ background:g.color, padding:'6px 14px', display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#fff', letterSpacing:'0.3px' }}>⚡ СУПЕРСЕТ — без отдыха между упражнениями</span>
                  </div>
                  <div style={{ background:'#fff' }}>
                    {g.items.map((ex,ii)=>renderExBody(ex,ii>0))}
                  </div>
                </div>
              ):(
                <div key={g.items[0].id} style={{ background:'#fff', borderRadius:13, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10 }}>
                  {renderExBody(g.items[0],false)}
                </div>
              ))
            })()}
            <button onClick={()=>addExercise(currentSlot.id)}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, width:'100%', padding:'14px', marginTop:4, borderRadius:12, border:`1.5px dashed ${PUR}`, background:'#EEEDFE', color:PUR, fontSize:14, fontWeight:700, cursor:'pointer', boxSizing:'border-box', minHeight:'unset' }}>
              ＋ Добавить упражнение
            </button>

          </div>
        </div>
      , document.body)}

      {/* ── Уровень 1: список тренировок в папке ── */}
      {openFolder&&createPortal(
        <div style={{ position:'fixed', inset:0, background:'#f3f4f6', zIndex:1000, display:'flex', flexDirection:'column' }}>
          <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'14px 18px', display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
            <button onClick={()=>setOpenFolder(null)}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:'#6b7280', lineHeight:1, padding:0, minHeight:'unset' }}>←</button>
            <span style={{ fontSize:22 }}>{FOLDER_ICONS[openFolder]}</span>
            <div>
              <div style={{ fontSize:17, fontWeight:700, color:'#111' }}>{openFolder}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>
                {SLOT_COUNT} тренировок · {folderSlots[openFolder].reduce((s,sl)=>s+sl.exercises.filter(e=>e.videoId).length,0)} видео
              </div>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {folderSlots[openFolder].map(slot=>{
              const ec=slot.exercises.length
              const vc=slot.exercises.filter(e=>e.videoId).length
              return (
                <div key={slot.id} style={{ background:'#fff', borderRadius:13, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10, display:'flex', flexDirection:'column', alignItems:'center', padding:'16px 16px 14px', cursor:'pointer', position:'relative' }}
                  onClick={()=>setOpenSlotId(slot.id)}>
                  <div style={{ position:'absolute', top:14, left:14, width:36, height:36, borderRadius:'50%', background:ec>0?PUR:'#f3f4f6', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, color:ec>0?'#fff':'#9ca3af' }}>
                    {slot.slotNum}
                  </div>
                  <span style={{ position:'absolute', top:18, right:14, fontSize:18, color:'#c7cad1' }}>›</span>
                  <div style={{ textAlign:'center', paddingTop:6 }}>
                    <div style={{ fontSize:16, fontWeight:700, color:'#111', marginBottom:4 }}>{slot.title}</div>
                    <div style={{ fontSize:12, color:'#9ca3af' }}>
                      {ec===0?'Нет упражнений':`${ec} упр.${vc>0?` · ${vc} видео`:''}`}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      , document.body)}

      {/* ── Плашка AI тренера ── */}
      {onOpenAI&&(
        <div onClick={()=>onOpenAI('workout')} style={{ display:'flex',alignItems:'center',gap:12,background:'linear-gradient(135deg,#7F77DD18,#5b54c408)',border:'1.5px solid #7F77DD44',borderRadius:14,padding:'12px 16px',marginBottom:14,cursor:'pointer' }}>
          <div style={{ width:38,height:38,borderRadius:'50%',background:'linear-gradient(135deg,#7F77DD,#5b54c4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0 }}>🤖</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13,fontWeight:700,color:'#7F77DD' }}>Спросить AI тренера</div>
            <div style={{ fontSize:11,color:'#9ca3af',marginTop:1 }}>Подберёт вес на следующую тренировку</div>
          </div>
          <span style={{ fontSize:18,color:'#7F77DD' }}>›</span>
        </div>
      )}

      {/* ── Уровень 0: список папок ── */}
      {FOLDERS.map(folder=>{
        const totalEx=folderSlots[folder].reduce((s,sl)=>s+sl.exercises.length,0)
        const totalVids=folderSlots[folder].reduce((s,sl)=>s+sl.exercises.filter(e=>e.videoId).length,0)
        return (
          <Card key={folder} style={{ marginBottom:10, cursor:'pointer', position:'relative' }}
            onClick={()=>setOpenFolder(folder)}>
            <span style={{ position:'absolute', top:'50%', right:16, transform:'translateY(-50%)', fontSize:20, color:'#c7cad1' }}>›</span>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingRight:20 }}>
              <div style={{ fontSize:28, marginBottom:6 }}>{FOLDER_ICONS[folder]}</div>
              <div style={{ fontSize:16, fontWeight:700, color:'#111', textAlign:'center' }}>{folder}</div>
              <div style={{ fontSize:12, color:'#9ca3af', marginTop:3, textAlign:'center' }}>
                {SLOT_COUNT} тренировок · {totalEx} упр.{totalVids>0?` · ${totalVids} видео`:''}
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}

const NUTRITION_PLANS=[
  {
    id:'45_50',title:'Рацион 45–50 кг',subtitle:'7 дней · ~1400 ккал/день',icon:'🥗',
    target:{cal:1400,p:94,c:141,f:47},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'8:00',items:['Овсянка на воде/молоке (45г сух.)','Банан (80г), Семена льна (5г), Грецкие орехи (10г)'],p:12,c:55,f:10,cal:320},
        {name:'Перекус',time:'11:00',items:['Творог 5% (100г)','Яблоко (120г)'],p:18,c:20,f:5,cal:180},
        {name:'Обед',time:'14:00',items:['Куриная грудка запеч. (100г сыр.), Гречка (50г сух.)','Салат (огурец, помидор 150г), Оливковое масло (5г)'],p:35,c:40,f:10,cal:450},
        {name:'Перекус',time:'17:00',items:['Кефир 1% (150мл)','Черника (70г)'],p:6,c:10,f:3,cal:90},
        {name:'Ужин',time:'19:30',items:['Треска на пару (90г)','Брокколи туш. (200г)','1/4 авокадо (30г)'],p:22,c:15,f:10,cal:250},
      ],total:{p:93,c:140,f:38,cal:1290},tip:'Добавьте 1 ч.л. орехов (5г) или 1 фрукт для добора жиров/углеводов.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречка (45г сух.)','Омлет из 2 яиц','Огурец (100г)'],p:20,c:35,f:15,cal:380},
        {name:'Перекус',time:'',items:['Йогурт натуральный (150г)','Груша (100г)'],p:5,c:20,f:3,cal:130},
        {name:'Обед',time:'',items:['Индейка тушеная (100г сыр.)','Бурый рис (45г сух.)','Кабачок гриль (150г)'],p:30,c:40,f:8,cal:400},
        {name:'Перекус',time:'',items:['Творог 5% (80г)','1/2 грейпфрута'],p:14,c:10,f:4,cal:130},
        {name:'Ужин',time:'',items:['Салат «Греческий»: Помидор (100г), Огурец (100г), Фета (50г), Маслины (5 шт), Масло (3г)'],p:15,c:15,f:18,cal:250},
      ],total:{p:84,c:120,f:48,cal:1290},tip:'Добавьте 30г риса или 1 хлебец к обеду.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка: Творог 120г + 1 яйцо + Яблоко 50г'],p:22,c:20,f:10,cal:290},
        {name:'Перекус',time:'',items:['Хлебец цельнозерновой (10г)','Сыр (20г)','Помидор (100г)'],p:5,c:8,f:5,cal:90},
        {name:'Обед',time:'',items:['Суп куриный: Курица (70г), Картофель (80г), Овощи (150г)','Хлеб (20г)'],p:20,c:40,f:8,cal:340},
        {name:'Перекус',time:'',items:['Яблоко (120г)','Фисташки (10г)'],p:2,c:15,f:5,cal:120},
        {name:'Ужин',time:'',items:['Говядина отварная (80г)','Свекла варёная (100г)','Чернослив (15г)','Сметана 10% (15г)'],p:20,c:25,f:10,cal:280},
      ],total:{p:69,c:108,f:38,cal:1120},tip:'Увеличьте порцию говядины до 100г и добавьте 30г гречки.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 2 яиц с помидорами (100г)','1/2 тоста (15г)','Авокадо (20г)'],p:15,c:15,f:18,cal:270},
        {name:'Перекус',time:'',items:['Творог 5% (100г)','Киви (80г)'],p:18,c:15,f:5,cal:190},
        {name:'Обед',time:'',items:['Хек запеченный (100г)','Картофель отварной (120г)','Капуста тушеная (150г)'],p:25,c:35,f:8,cal:350},
        {name:'Перекус',time:'',items:['Кефир 1% (150мл)','Курага (20г)'],p:6,c:15,f:3,cal:120},
        {name:'Ужин',time:'',items:['Куриная грудка (70г)','Чечевица (40г сух.)','Руккола (50г)'],p:30,c:30,f:5,cal:320},
      ],total:{p:94,c:110,f:39,cal:1250},tip:'Добавьте 1 ч.л. масла (5г) в гарнир или фрукт на перекус.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Пшённая каша (40г сух.)','Яйцо вареное (1 шт)','Тыквенные семечки (10г)'],p:15,c:35,f:12,cal:320},
        {name:'Перекус',time:'',items:['Йогурт греческий (150г)','Апельсин (100г)'],p:5,c:20,f:3,cal:130},
        {name:'Обед',time:'',items:['Фрикадельки из индейки (100г фарша)','Макароны (40г сух.)','Стручковая фасоль (120г)'],p:25,c:40,f:10,cal:400},
        {name:'Перекус',time:'',items:['Творог 5% (80г)','Клубника (70г)'],p:14,c:10,f:4,cal:140},
        {name:'Ужин',time:'',items:['Рагу овощное с фасолью: Фасоль конс. (40г), Овощи (200г)','Тофу (60г)'],p:15,c:25,f:8,cal:250},
      ],total:{p:74,c:130,f:37,cal:1240},tip:'Увеличьте макароны до 50г и добавьте 10г орехов.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (120г), Сметана 10% (20г), Изюм (15г), Миндаль (5г)'],p:20,c:20,f:10,cal:270},
        {name:'Перекус',time:'',items:['Хлебец (10г), Авокадо (20г), Огурец (100г)'],p:3,c:8,f:7,cal:110},
        {name:'Обед',time:'',items:['Куриная голень без кожи (100г сыр.), Перловка (40г сух.)','Салат (150г)'],p:25,c:35,f:15,cal:420},
        {name:'Перекус',time:'',items:['Яблоко печеное (120г)','Кешью (10г)'],p:2,c:20,f:5,cal:150},
        {name:'Ужин',time:'',items:['Омлет из 2 яиц с шампиньонами (50г)','Свекла вареная (100г)'],p:20,c:15,f:15,cal:310},
      ],total:{p:70,c:103,f:52,cal:1260},tip:'Добавьте 30г творога и 30г риса.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (45г сух.)','Яблоко зеленое (100г)','Арахисовая паста (5г)'],p:10,c:50,f:7,cal:300},
        {name:'Перекус',time:'',items:['Кефир 1% (150г)','Банан (70г)'],p:6,c:25,f:3,cal:150},
        {name:'Обед',time:'',items:['Говядина тушеная (90г сыр.)','Гречка (45г сух.)','Морковь тушеная (150г)'],p:30,c:45,f:15,cal:480},
        {name:'Перекус',time:'',items:['Творог 5% (100г)','Мандарин (100г)'],p:18,c:15,f:5,cal:180},
        {name:'Ужин',time:'',items:['Котлеты рыбные (90г филе)','Цветная капуста (250г)','Лимонный сок'],p:20,c:15,f:8,cal:240},
      ],total:{p:84,c:150,f:38,cal:1350},tip:'Добавьте 1 ст.л. оливкового масла (10г) в салат или гарнир.'},
    ]
  },
  {
    id:'51_55',title:'Рацион 51–55 кг',subtitle:'7 дней · ~1600 ккал/день',icon:'🥗',
    target:{cal:1600,p:106,c:159,f:53},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде/молоке (55г сух.) + Банан (100г) + 1 ч.л. льняных семян (5г) + Грецкие орехи (20г)'],p:16,c:65,f:17,cal:400},
        {name:'Перекус',time:'',items:['Творог 5% (120г) + Яблоко (150г)'],p:21,c:20,f:6,cal:165},
        {name:'Обед',time:'',items:['Запеченная куриная грудка (130г сыр) + Гречка (65г сух)','Салат (огурцы, помидоры 150г) + 1 ч.л. оливк. масла (5г)'],p:38,c:50,f:13,cal:515},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (200мл) + Ягоды (100г)'],p:7,c:15,f:4,cal:135},
        {name:'Ужин',time:'',items:['Запеченная белая рыба (110г сыр) + Тушеные овощи (брокколи, цв. капуста 200г) + 1/4 авокадо (50г)'],p:22,c:15,f:13,cal:305},
      ],total:{p:104,c:165,f:53,cal:1520},tip:''},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречневая каша (55г сух.) + Омлет из 2 яиц + Огурец (100г)'],p:22,c:38,f:16,cal:435},
        {name:'Перекус',time:'',items:['Йогурт натуральный (150г) + Груша (120г)'],p:5,c:25,f:3,cal:155},
        {name:'Обед',time:'',items:['Индейка (филе, 130г сыр) тушеная с овощами (150г) + Бурый рис (55г сух.)'],p:33,c:50,f:9,cal:465},
        {name:'Перекус',time:'',items:['Творог 5% (120г) + 1/2 грейпфрута'],p:21,c:10,f:6,cal:145},
        {name:'Ужин',time:'',items:['Салат «Греческий»: Помидор (120г), Огурец (120г), Перец (60г), Фета (70г), Маслины 6 шт (30г), 1 ч.л. оливк. масла (5г)'],p:23,c:18,f:19,cal:380},
      ],total:{p:104,c:141,f:53,cal:1580},tip:'Углеводы немного ниже — можно добавить хлебец к салату или чуть больше фрукта.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 170г + 1 яйцо + Яблоко 50г) + Миндаль (20г)'],p:28,c:22,f:19,cal:435},
        {name:'Перекус',time:'',items:['2 цельнозерн. хлебца (30г) + Ломтик сыра (25г) + Огурец (100г)'],p:9,c:20,f:8,cal:180},
        {name:'Обед',time:'',items:['Суп куриный (Курица 90г, Картофель 110г, Морковь 50г, Лук, Цв. капуста 100г) + 1 кус. цельнозерн. хлеба (30г)'],p:28,c:50,f:9,cal:425},
        {name:'Перекус',time:'',items:['Яблоко (150г) + Фисташки (20г)'],p:4,c:20,f:9,cal:195},
        {name:'Ужин',time:'',items:['Отварная говядина (110г сыр) + Салат из свеклы (120г) с черносливом (25г) и 1 ч.л. смет. 10% (15г)'],p:27,c:30,f:11,cal:350},
      ],total:{p:96,c:142,f:56,cal:1585},tip:'Углеводы чуть ниже, жиры чуть выше — можно уменьшить орехи в перекусе или масло в другие дни.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 2 яиц с овощами (120г) + 1/2 цельнозерн. булки (35г) + 1/4 авокадо (30г)'],p:20,c:30,f:20,cal:450},
        {name:'Перекус',time:'',items:['Творог 5% (120г) + Киви (2 шт, 120г)'],p:21,c:20,f:6,cal:175},
        {name:'Обед',time:'',items:['Рыба на пару (130г) + Картофель отварной (160г) + Салат из капусты (150г) + 1 ч.л. раст. масла (5г)'],p:27,c:45,f:11,cal:480},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (200мл) + Курага (35г)'],p:7,c:25,f:4,cal:185},
        {name:'Ужин',time:'',items:['Куриная грудка отварная (90г) + Чечевица отварная (65г сух) + Салат из зелени (100г)'],p:32,c:38,f:5,cal:360},
      ],total:{p:107,c:158,f:46,cal:1650},tip:'Жиры чуть ниже — можно добавить 5г орехов или пол-ложки масла в салат.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Каша пшенная (55г сух) + 1 яйцо вареное + Тыквенные семечки (20г)'],p:20,c:45,f:17,cal:420},
        {name:'Перекус',time:'',items:['Йогурт натуральный (150г) + Апельсин (150г)'],p:5,c:25,f:3,cal:160},
        {name:'Обед',time:'',items:['Котлеты из фарша индейки на пару (130г сыр. фарш) + Макароны из тв. сортов (55г сух) + Стручк. фасоль (150г)'],p:33,c:50,f:13,cal:525},
        {name:'Перекус',time:'',items:['Творог 5% (120г) + Клубника (100г)'],p:21,c:12,f:6,cal:160},
        {name:'Ужин',time:'',items:['Овощное рагу с фасолью (Брокколи, кабачок, помидор 60г) + Фасоль красная конс. (60г) + 1 ч.л. оливк. масла (5г) + Сыр Фета (30г)'],p:17,c:30,f:16,cal:340},
      ],total:{p:96,c:162,f:55,cal:1605},tip:'Белки чуть ниже — можно увеличить фасоль/сыр в ужине или порцию творога.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (170г) + 1 ст.л. сметаны 10% (25г) + Изюм (20г) + Грецкие орехи (15г)'],p:28,c:25,f:18,cal:410},
        {name:'Перекус',time:'',items:['1 Цельнозерн. хлебец (15г) + 1/4 авокадо (30г) + Ломтик помидора'],p:3,c:10,f:10,cal:155},
        {name:'Обед',time:'',items:['Запеченная куриная ножка без кожи (130г сыр) + Перловка (55г сух) + Салат (огурцы, зелень 150г)'],p:27,c:45,f:16,cal:530},
        {name:'Перекус',time:'',items:['Запеченное яблоко (150г) с корицей + Кешью (20г)'],p:3,c:25,f:10,cal:220},
        {name:'Ужин',time:'',items:['Омлет из 2 яиц с грибами (шампиньоны 80г) и шпинатом (50г) + Салат из свеклы (120г)'],p:22,c:20,f:16,cal:340},
      ],total:{p:83,c:125,f:70,cal:1655},tip:'Белки и углеводы ниже, жиры выше — добавить порцию фрукта/каши в обед или перекус, уменьшить орехи/авокадо.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде (55г сух) с тёртым яблоком (120г) и 1 ч.л. арах. пасты (10г)'],p:14,c:60,f:12,cal:395},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (200мл) + Банан (100г)'],p:7,c:30,f:4,cal:200},
        {name:'Обед',time:'',items:['Говядина тушеная (110г сыр) с овощами (морковь, лук, сельдерей 170г) + Гречка отварная (45г сух)'],p:33,c:40,f:16,cal:480},
        {name:'Перекус',time:'',items:['Творог 5% (120г) + Мандарин (2 шт, 150г)'],p:21,c:20,f:6,cal:175},
        {name:'Ужин',time:'',items:['Рыбные котлеты на пару (из трески/минтая, 110г филе) + Овощи гриль (кабачок, баклажан, перец 220г) + Листья салата'],p:22,c:20,f:11,cal:310},
      ],total:{p:97,c:170,f:49,cal:1560},tip:'Белки чуть ниже — можно увеличить порцию рыбы/говядины или творога.'},
    ]
  },
  {
    id:'56_60',title:'Рацион 56–60 кг',subtitle:'7 дней · ~1800 ккал/день',icon:'🥗',
    target:{cal:1800,p:116,c:174,f:58},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде/молоке (60г сух.) + Банан (100г) + 1 ч.л. льняных семян (5г) + Грецкие орехи (25г)'],p:18,c:70,f:20,cal:470},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Яблоко (150г)'],p:26,c:20,f:7,cal:200},
        {name:'Обед',time:'',items:['Запеченная куриная грудка (140г сыр) + Гречка (70г сух)','Салат (огурцы, помидоры 200г) + 1 ч.л. оливк. масла (5г)'],p:41,c:55,f:14,cal:565},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (200мл) + Ягоды (120г)'],p:7,c:18,f:4,cal:150},
        {name:'Ужин',time:'',items:['Запеченная белая рыба (120г сыр) + Тушеные овощи (брокколи, цв. капуста, морковь 250г) + 1/4 авокадо (50г)'],p:24,c:20,f:14,cal:345},
      ],total:{p:116,c:183,f:59,cal:1730},tip:''},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречневая каша (60г сух.) + Омлет из 2 яиц + Огурец (100г)'],p:24,c:42,f:17,cal:480},
        {name:'Перекус',time:'',items:['Йогурт натуральный (200г) + Груша (150г)'],p:7,c:30,f:4,cal:200},
        {name:'Обед',time:'',items:['Индейка (филе, 140г сыр) тушеная с овощами (лук, морковь, кабачок 180г) + Бурый рис (60г сух.)'],p:35,c:55,f:10,cal:510},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + 1/2 грейпфрута'],p:26,c:10,f:7,cal:180},
        {name:'Ужин',time:'',items:['Салат «Греческий»: Помидор (150г), Огурец (150г), Перец (70г), Фета (80г), Маслины 7 шт (35г), 1 ч.л. оливк. масла (5г)'],p:26,c:20,f:22,cal:440},
      ],total:{p:118,c:157,f:60,cal:1810},tip:'Углеводы ниже — можно добавить цельнозерновой хлебец к салату.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 200г + 1 яйцо + Яблоко 50г) + Миндаль (25г)'],p:32,c:25,f:23,cal:490},
        {name:'Перекус',time:'',items:['2 цельнозерн. хлебца (30г) + Ломтик сыра (30г) + Огурец (100г)'],p:10,c:20,f:10,cal:220},
        {name:'Обед',time:'',items:['Суп куриный (Курица 100г, Картофель 120г, Морковь 60г, Лук, Брокколи 100г) + 1 кус. цельнозерн. хлеба (40г)'],p:32,c:60,f:10,cal:485},
        {name:'Перекус',time:'',items:['Яблоко (150г) + Фисташки (25г)'],p:5,c:20,f:11,cal:230},
        {name:'Ужин',time:'',items:['Отварная говядина (120г сыр) + Салат из свеклы (150г) с черносливом (30г) и 1 ч.л. смет. 10% (15г)'],p:30,c:35,f:12,cal:395},
      ],total:{p:109,c:160,f:66,cal:1820},tip:'Белки чуть ниже, жиры выше — можно добавить бобовых в обед/ужин, уменьшить орехи в перекусе.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 3 яиц с овощами (помидор, перец, шпинат 150г) + 1/2 цельнозерн. булки (40г) + 1/4 авокадо (30г)'],p:25,c:35,f:25,cal:520},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Киви (2 шт, 150г)'],p:26,c:25,f:7,cal:220},
        {name:'Обед',time:'',items:['Рыба на пару (140г) + Картофель отварной (180г) + Салат из капусты с морковью (200г) + 1 ч.л. раст. масла (5г)'],p:30,c:55,f:12,cal:550},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (200мл) + Курага (40г)'],p:7,c:30,f:4,cal:210},
        {name:'Ужин',time:'',items:['Куриная грудка отварная (100г) + Чечевица отварная (70г сух) + Салат из рукколы и шпината (150г) с лимонным соком'],p:35,c:40,f:6,cal:395},
      ],total:{p:123,c:185,f:54,cal:1895},tip:'Углеводы и белки выше — можно чуть уменьшить картофель/чечевицу, если нужно снизить.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Каша пшенная (60г сух) + 1 яйцо вареное + Тыквенные семечки (25г)'],p:22,c:50,f:20,cal:490},
        {name:'Перекус',time:'',items:['Йогурт натуральный (200г) + Апельсин (180г)'],p:7,c:30,f:4,cal:210},
        {name:'Обед',time:'',items:['Котлеты из фарша индейки на пару (140г сыр. фарш) + Макароны из тв. сортов (60г сух) + Стручк. фасоль (180г)'],p:36,c:55,f:14,cal:580},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Клубника (120г)'],p:26,c:15,f:7,cal:200},
        {name:'Ужин',time:'',items:['Овощное рагу с фасолью (Кабачок, баклажан, помидор 300г + Фасоль красная конс. 70г) + 1 ч.л. оливк. масла (5г) + Сыр Фета (40г)'],p:20,c:40,f:18,cal:420},
      ],total:{p:111,c:190,f:63,cal:1900},tip:'Углеводы и жиры выше — можно уменьшить порцию макарон/рагу или масло.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (200г) + 1 ст.л. сметаны 10% (30г) + Изюм (25г) + Грецкие орехи (20г)'],p:33,c:30,f:22,cal:490},
        {name:'Перекус',time:'',items:['1 цельнозерн. хлебец (15г) + 1/4 авокадо (40г) + Ломтик помидора'],p:3,c:10,f:14,cal:190},
        {name:'Обед',time:'',items:['Запеченная куриная ножка без кожи (140г сыр) + Перловка (60г сух) + Салат (огурцы, зелень 200г)'],p:30,c:50,f:18,cal:580},
        {name:'Перекус',time:'',items:['Запеченное яблоко (180г) с корицей + Кешью (25г)'],p:4,c:30,f:13,cal:270},
        {name:'Ужин',time:'',items:['Омлет из 3 яиц с грибами (шампиньоны 100г) и шпинатом (70г) + Салат из свеклы (150г)'],p:28,c:25,f:22,cal:420},
      ],total:{p:98,c:145,f:89,cal:1950},tip:'Белки и углеводы ниже, жиры выше — добавить порцию крупы/фрукта в обед/перекус, уменьшить орехи/авокадо/яйца.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде (60г сух) с тёртым яблоком (150г) и 1 ч.л. арах. пасты (10г)'],p:15,c:70,f:13,cal:440},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (200мл) + Банан (120г)'],p:7,c:35,f:4,cal:230},
        {name:'Обед',time:'',items:['Говядина тушеная (120г сыр) с овощами (морковь, лук, сельдерей 200г) + Отварная гречка (50г сух)'],p:36,c:45,f:17,cal:530},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Мандарин (2 шт, 180г)'],p:26,c:25,f:7,cal:220},
        {name:'Ужин',time:'',items:['Рыбные котлеты на пару (из трески/минтая, 120г филе) + Овощи гриль (кабачок, баклажан, перец 250г) + Листья салата + 1/2 ч.л. оливк. масла (3г)'],p:25,c:25,f:13,cal:350},
      ],total:{p:109,c:200,f:54,cal:1770},tip:'Белки чуть ниже — можно увеличить порцию говядины/рыбы или творога.'},
    ]
  },
  {
    id:'61_65',title:'Рацион 61–65 кг',subtitle:'7 дней · ~1900 ккал/день',icon:'🥗',
    target:{cal:1900,p:124,c:186,f:62},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде/молоке (65г сух.) + Банан (120г) + 1 ч.л. льняных семян (5г) + Грецкие орехи (25г)'],p:19,c:80,f:21,cal:520},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Яблоко (150г) + 1 ч.л. мёда (7г, опционально)'],p:26,c:30,f:7,cal:255},
        {name:'Обед',time:'',items:['Запеченная куриная грудка (150г сыр) + Гречка (75г сух)','Салат (огурцы, помидоры 250г) + 1 ч.л. оливк. масла (5г)'],p:44,c:60,f:15,cal:610},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Ягоды (120г)'],p:9,c:20,f:5,cal:180},
        {name:'Ужин',time:'',items:['Запечённый лосось (130г сыр) + Тушёные овощи (брокколи, цв. капуста, стручковая фасоль 250г) + Лимонный сок'],p:30,c:20,f:20,cal:420},
      ],total:{p:128,c:210,f:68,cal:1985},tip:'Жиры чуть выше — можно уменьшить орехи утром на 5г.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречневая каша (65г сух.) + Омлет из 3 яиц + Огурец (100г)'],p:28,c:48,f:20,cal:540},
        {name:'Перекус',time:'',items:['Йогурт натуральный (200г) + Груша (150г) + 1 ст.л. отрубей (10г)'],p:8,c:40,f:4,cal:240},
        {name:'Обед',time:'',items:['Индейка (филе, 150г сыр) тушеная с овощами (лук, морковь, кабачок 200г) + Бурый рис (65г сух.)'],p:38,c:60,f:11,cal:560},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Грейпфрут (1/2 крупного)'],p:26,c:15,f:7,cal:190},
        {name:'Ужин',time:'',items:['Салат с тунцом: Тунец конс. (120г) + Яйцо варёное (1 шт) + Помидор (150г) + Огурец (150г) + Руккола (50г) + 1 ч.л. оливк. масла (5г) + 1 ч.л. семян кунжута (5г)'],p:35,c:15,f:20,cal:420},
      ],total:{p:135,c:178,f:62,cal:1950},tip:''},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 200г + 1 яйцо + Яблоко тёртое 70г) + Миндаль (25г)'],p:35,c:35,f:24,cal:540},
        {name:'Перекус',time:'',items:['2 цельнозерн. хлебца (30г) + Ломтик сыра (30г) + Помидор (100г)'],p:10,c:25,f:10,cal:230},
        {name:'Обед',time:'',items:['Суп чечевичный (Чечевица красная 60г сух + Куриный бульон + Морковь 50г + Лук + Сельдерей) + 1 кус. цельнозерн. хлеба (40г)'],p:30,c:75,f:8,cal:520},
        {name:'Перекус',time:'',items:['Яблоко (180г) + Фисташки (25г)'],p:5,c:25,f:11,cal:240},
        {name:'Ужин',time:'',items:['Запечённая телятина (120г сыр) + Киноа отварная (50г сух) + Салат из свежих овощей (200г)'],p:35,c:45,f:12,cal:450},
      ],total:{p:115,c:205,f:65,cal:1980},tip:'Белки чуть ниже — можно добавить яйцо в салат или увеличить творог утром.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 3 яиц с овощами (помидор, шпинат, грибы 150г) + 1/2 цельнозерн. булки (40г) + 1/4 авокадо (40г)'],p:25,c:40,f:28,cal:560},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Апельсин (180г)'],p:26,c:30,f:7,cal:240},
        {name:'Обед',time:'',items:['Запечённая треска (140г) + Картофель в мундире (200г) + Салат из капусты с морковью и зеленью (250г) + 1 ч.л. раст. масла (5г)'],p:32,c:65,f:13,cal:600},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Чернослив (30г)'],p:9,c:35,f:5,cal:230},
        {name:'Ужин',time:'',items:['Куриная грудка на гриле (110г) + Булгур отварной (60г сух) + Салат из огурцов и редиса (150г)'],p:35,c:50,f:8,cal:440},
      ],total:{p:127,c:220,f:61,cal:2070},tip:'Углеводы выше — можно уменьшить картофель до 180г или чернослив до 20г.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Каша пшенная (65г сух) + 1 яйцо варёное + Тыквенные семечки (25г) + 1/2 банана (50г)'],p:23,c:70,f:21,cal:570},
        {name:'Перекус',time:'',items:['Йогурт натуральный (200г) + Персик (150г)'],p:7,c:25,f:4,cal:190},
        {name:'Обед',time:'',items:['Котлеты из говядины на пару (140г сыр. фарш) + Макароны из тв. сортов (65г сух) + Тушеная брокколи (200г)'],p:38,c:65,f:15,cal:610},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Свежая малина (120г)'],p:26,c:20,f:7,cal:220},
        {name:'Ужин',time:'',items:['Фасоль стручковая на пару (150г) + Тофу запечённый (120г) + Овощное рагу (кабачок, перец, помидор 200г) + 1 ч.л. кунжутного масла (5г)'],p:25,c:25,f:18,cal:370},
      ],total:{p:119,c:205,f:65,cal:1960},tip:'Белки чуть ниже — можно увеличить порцию котлет или тофу.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (200г) + 1 ст.л. сметаны 10% (30г) + Изюм (25г) + Грецкие орехи (15г) + Горсть ягод (50г)'],p:35,c:40,f:20,cal:520},
        {name:'Перекус',time:'',items:['1 цельнозерн. тост (30г) + 1/4 авокадо (40г) + Ломтик слабосолёной сёмги (30г)'],p:10,c:20,f:18,cal:290},
        {name:'Обед',time:'',items:['Запечённая куриная голень без кожи (160г сыр) + Перловка (65г сух) + Салат из свежих овощей (250г)'],p:35,c:55,f:20,cal:620},
        {name:'Перекус',time:'',items:['Запечённая груша (180г) с корицей + Миндаль (15г)'],p:4,c:35,f:9,cal:250},
        {name:'Ужин',time:'',items:['Омлет из 2 яиц с брокколи и цвет. капустой (150г) + Салат из свеклы (150г) + 1 ч.л. льняного масла (5г)'],p:22,c:30,f:20,cal:420},
      ],total:{p:106,c:180,f:87,cal:2100},tip:'Белки ниже, жиры выше — добавить куриную грудку к ужину, убрать часть орехов/авокадо/сёмги.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде (65г сух) с тёртым яблоком (150г) + 1 ч.л. арах. пасты (10г) + корица'],p:16,c:80,f:14,cal:490},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Банан (120г) + 1 ст.л. овсяных отрубей (10г)'],p:9,c:50,f:5,cal:290},
        {name:'Обед',time:'',items:['Говядина тушеная (130г сыр) с овощами (морковь, лук, сельдерей, томаты 250г) + Отварная гречка (55г сух)'],p:40,c:55,f:18,cal:590},
        {name:'Перекус',time:'',items:['Творог 5% (150г) + Киви (2 шт, 150г)'],p:26,c:25,f:7,cal:220},
        {name:'Ужин',time:'',items:['Креветки отварные (150г очищ.) + Овощной рататуй (кабачок, баклажан, перец, помидор 300г) + Зелень + 1/2 ч.л. оливк. масла (3г)'],p:30,c:25,f:10,cal:350},
      ],total:{p:121,c:235,f:54,cal:1940},tip:'Углеводы выше — можно уменьшить банан или гречку; белки в норме.'},
    ]
  },
  {
    id:'66_70',title:'Рацион 66–70 кг',subtitle:'7 дней · ~2200 ккал/день',icon:'🥗',
    target:{cal:2200,p:134,c:201,f:67},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде/молоке (70г сух.) + Банан (120г) + 1 ч.л. льняных семян (5г) + Миндаль (30г)'],p:21,c:85,f:26,cal:600},
        {name:'Перекус',time:'',items:['Творог 5% (180г) + Яблоко (150г) + 1 ч.л. мёда (7г)'],p:31,c:35,f:8,cal:300},
        {name:'Обед',time:'',items:['Запеченная куриная грудка (160г сыр) + Гречка (80г сух)','Салат (огурцы, помидоры, перец 300г) + 1 ч.л. оливк. масла (5г)'],p:47,c:65,f:16,cal:665},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Ягоды (150г)'],p:9,c:25,f:5,cal:200},
        {name:'Ужин',time:'',items:['Запеченная скумбрия (140г сыр) + Тушеные овощи (кабачок, брокколи, морковь 300г)'],p:30,c:25,f:22,cal:460},
      ],total:{p:138,c:235,f:77,cal:2225},tip:'Жиры выше — можно уменьшить орехи утром на 5г.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречневая каша (70г сух.) + Омлет из 3 яиц с сыром (30г нежир.) + Огурец (100г)'],p:35,c:55,f:25,cal:620},
        {name:'Перекус',time:'',items:['Йогурт натуральный (250г) + Груша (150г) + 1 ст.л. овс. отруб. (10г)'],p:10,c:45,f:5,cal:290},
        {name:'Обед',time:'',items:['Индейка (филе, 160г сыр) тушеная с овощами (200г) + Бурый рис (70г сух.)'],p:41,c:65,f:12,cal:600},
        {name:'Перекус',time:'',items:['Творог 5% (180г) + Апельсин (180г)'],p:31,c:30,f:8,cal:270},
        {name:'Ужин',time:'',items:['Салат с курицей и авокадо: Куриная грудка отварная (100г) + Авокадо (80г) + Помидор (150г) + Руккола (50г) + Яйцо вареное (1 шт) + 1 ч.л. оливк. масла (5г)'],p:35,c:15,f:30,cal:480},
      ],total:{p:152,c:210,f:80,cal:2260},tip:'Белки и жиры выше — можно уменьшить сыр в завтраке или авокадо в ужине.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 220г + 1 яйцо + Яблоко 70г) + Грецкие орехи (20г)'],p:38,c:40,f:22,cal:560},
        {name:'Перекус',time:'',items:['2 цельнозерн. тоста (50г) + Ломтик сыра (40г) + Огурец (100г)'],p:15,c:35,f:15,cal:330},
        {name:'Обед',time:'',items:['Суп фасолевый (Фасоль белая конс. 150г / 60г сух. + Куриный бульон + Овощи 150г) + 1 кус. цельнозерн. хлеба (40г)'],p:30,c:80,f:10,cal:580},
        {name:'Перекус',time:'',items:['Яблоко (180г) + Фисташки (30г)'],p:6,c:25,f:13,cal:260},
        {name:'Ужин',time:'',items:['Запеченная говяжья вырезка (130г сыр) + Киноа отварная (60г сух) + Салат из свежих овощей (250г)'],p:40,c:55,f:15,cal:550},
      ],total:{p:129,c:235,f:75,cal:2280},tip:'Белки чуть ниже — можно увеличить порцию говядины.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 3 яиц с овощами (грибы, шпинат, помидор 180г) + 1/2 цельнозерн. булки (40г) + 1/4 авокадо (40г)'],p:26,c:45,f:30,cal:600},
        {name:'Перекус',time:'',items:['Творог 5% (180г) + Грейпфрут (1 шт)'],p:31,c:20,f:8,cal:240},
        {name:'Обед',time:'',items:['Запеченный хек (150г) + Картофель запеченный (220г) + Салат из капусты с огурцом (250г) + 1 ч.л. раст. масла (5г)'],p:35,c:75,f:15,cal:650},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Курага (40г)'],p:9,c:35,f:5,cal:230},
        {name:'Ужин',time:'',items:['Куриное филе на гриле (120г) + Булгур отварной (70г сух) + Салат из помидоров и зелени (200г)'],p:38,c:60,f:10,cal:520},
      ],total:{p:139,c:235,f:68,cal:2240},tip:'Углеводы выше — можно уменьшить картофель до 200г.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Каша пшенная (70г сух) + 1 яйцо вареное + Семена подсолнечника (25г) + 1/2 банана (50г)'],p:24,c:85,f:24,cal:640},
        {name:'Перекус',time:'',items:['Йогурт натуральный (250г) + Персик (180г)'],p:8,c:30,f:5,cal:220},
        {name:'Обед',time:'',items:['Фрикадельки из индейки на пару (160г сыр. фарш) + Макароны из тв. сортов (70г сух) + Тушеная стручковая фасоль (250г)'],p:42,c:70,f:16,cal:670},
        {name:'Перекус',time:'',items:['Творог 5% (180г) + Черника (150г)'],p:31,c:25,f:8,cal:260},
        {name:'Ужин',time:'',items:['Чечевица отварная (80г сух) + Запеченный тофу (100г) + Овощное рагу (баклажан, перец, лук 250г) + 1 ч.л. оливк. масла (5г)'],p:35,c:65,f:18,cal:580},
      ],total:{p:140,c:275,f:71,cal:2370},tip:'Углеводы значительно выше — уменьшить макароны до 60г сух или чечевицу до 60г.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (200г) + 1 ст.л. сметаны 10% (30г) + Изюм (30г) + Тыквенные семечки (20г) + Горсть клубники (80г)'],p:36,c:50,f:20,cal:560},
        {name:'Перекус',time:'',items:['1 цельнозерн. тост (30г) + 1/4 авокадо (50г) + Ломтик индейки (40г)'],p:12,c:25,f:20,cal:330},
        {name:'Обед',time:'',items:['Запеченное куриное бедрышко без кожи (180г сыр) + Перловка (70г сух) + Салат из свежих овощей (300г)'],p:40,c:60,f:25,cal:680},
        {name:'Перекус',time:'',items:['Запеченное яблоко (200г) с творогом (50г) и корицей'],p:10,c:40,f:2,cal:230},
        {name:'Ужин',time:'',items:['Омлет из 2 яиц с брокколи и цветной капустой (200г) + Салат из свеклы и моркови (150г) + 1 ч.л. льняного масла (5г)'],p:23,c:35,f:22,cal:450},
      ],total:{p:121,c:210,f:89,cal:2250},tip:'Белки ниже, жиры выше — добавить куриную грудку к ужину, уменьшить авокадо/семечки.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде (70г сух) с тёртым яблоком (150г) + 1 ч.л. арах. пасты (10г) + корица + 10г орехов'],p:18,c:90,f:18,cal:580},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Банан (120г) + 1 ст.л. семян чиа (10г)'],p:11,c:55,f:8,cal:340},
        {name:'Обед',time:'',items:['Говядина тушеная (140г сыр) с овощами (250г) + Отварная гречка (60г сух)'],p:43,c:60,f:20,cal:650},
        {name:'Перекус',time:'',items:['Творог 5% (180г) + Мандарин (2 шт, 180г)'],p:31,c:25,f:8,cal:260},
        {name:'Ужин',time:'',items:['Креветки тигровые (180г очищ.) + Овощи-гриль (цукини, баклажан, перец 350г) + Зелень + Лимонный сок + 1/2 ч.л. оливк. масла (3г)'],p:36,c:30,f:12,cal:420},
      ],total:{p:139,c:260,f:66,cal:2250},tip:'Углеводы выше — уменьшить банан или гречку.'},
    ]
  },
  {
    id:'71_75',title:'Рацион 71–75 кг',subtitle:'7 дней · ~2350 ккал/день',icon:'🥗',
    target:{cal:2350,p:144,c:216,f:72},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде/молоке (75г сух.) + Банан (120г) + 1 ст.л. семян чиа (10г) + Миндаль (30г)'],p:22,c:95,f:27,cal:650},
        {name:'Перекус',time:'',items:['Творог 5% (200г) + Яблоко (180г) + 1 ч.л. мёда (7г)'],p:35,c:40,f:9,cal:335},
        {name:'Обед',time:'',items:['Запечённая куриная грудка (170г сыр) + Гречка (85г сух)','Салат (огурцы, помидоры, лук 350г) + 1 ч.л. оливк. масла (5г)'],p:50,c:70,f:17,cal:710},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Ягоды (150г)'],p:9,c:25,f:5,cal:200},
        {name:'Ужин',time:'',items:['Запечённый лосось (150г сыр) + Овощное рагу (кабачок, брокколи, морковь 350г) + Лимонный сок'],p:35,c:30,f:25,cal:520},
      ],total:{p:151,c:260,f:83,cal:2415},tip:'Жиры выше — можно уменьшить орехи на 5г.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречневая каша (75г сух.) + Омлет из 3 яиц с сыром (40г, 10–17%) + Помидор (150г)'],p:40,c:60,f:28,cal:690},
        {name:'Перекус',time:'',items:['Йогурт натуральный (250г) + Груша (180г) + 1.5 ст.л. овсяных отрубей (15г)'],p:11,c:55,f:6,cal:330},
        {name:'Обед',time:'',items:['Индейка (филе, 170г сыр) тушеная с овощами (220г) + Бурый рис (75г сух.)'],p:44,c:70,f:13,cal:640},
        {name:'Перекус',time:'',items:['Творог 5% (200г) + Апельсин (200г)'],p:35,c:35,f:9,cal:310},
        {name:'Ужин',time:'',items:['Салат с говядиной и фасолью: Говядина отварная (120г) + Фасоль красная конс. (80г) + Авокадо (60г) + Помидор (150г) + Руккола (50г) + 1 ч.л. оливк. масла (5г)'],p:40,c:35,f:30,cal:580},
      ],total:{p:170,c:255,f:86,cal:2550},tip:'Белки и жиры выше — можно уменьшить сыр в завтраке или авокадо в ужине.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 250г + 1 яйцо + Груша тёртая 80г) + Грецкие орехи (25г)'],p:43,c:50,f:25,cal:640},
        {name:'Перекус',time:'',items:['2 цельнозерн. тоста (60г) + Ломтик сыра (40г) + Огурец (150г)'],p:16,c:45,f:16,cal:390},
        {name:'Обед',time:'',items:['Суп чечевичный с курицей (Чечевица красная 70г сух + Куриный бульон + Курица 80г + Овощи 150г) + 1 кус. цельнозерн. хлеба (40г)'],p:45,c:85,f:12,cal:670},
        {name:'Перекус',time:'',items:['Яблоко (200г) + Фисташки (30г)'],p:6,c:30,f:13,cal:280},
        {name:'Ужин',time:'',items:['Запечённая телятина (140г сыр) + Киноа отварная (70г сух) + Салат из свежих овощей с зеленью (300г)'],p:45,c:65,f:17,cal:630},
      ],total:{p:155,c:275,f:83,cal:2610},tip:'Углеводы и калории выше — можно уменьшить хлеб в обед и киноа до 60г.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 3 яиц с овощами (грибы, шпинат, перец 200г) + 1 цельнозерн. тост (30г) + 1/4 авокадо (40г)'],p:27,c:50,f:32,cal:620},
        {name:'Перекус',time:'',items:['Творог 5% (200г) + Киви (2 шт, 150г)'],p:35,c:25,f:9,cal:270},
        {name:'Обед',time:'',items:['Запечённая треска (160г) + Картофель запечённый (250г) + Салат из капусты и моркови (300г) + 1 ч.л. раст. масла (5г)'],p:38,c:85,f:16,cal:710},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Чернослив (40г)'],p:9,c:40,f:5,cal:250},
        {name:'Ужин',time:'',items:['Куриное филе на гриле (130г) + Булгур отварной (75г сух) + Салат из помидоров и огурцов (250г)'],p:40,c:65,f:11,cal:570},
      ],total:{p:149,c:265,f:73,cal:2420},tip:'Углеводы выше — можно уменьшить картофель до 220г.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Каша пшенная (75г сух) + 1 яйцо вареное + Семена подсолнечника (25г) + Банан (80г)'],p:25,c:100,f:25,cal:690},
        {name:'Перекус',time:'',items:['Йогурт натуральный (250г) + Персик (200г)'],p:8,c:35,f:5,cal:240},
        {name:'Обед',time:'',items:['Фрикадельки из говядины на пару (170г сыр. фарш) + Макароны из тв. сортов (75г сух) + Тушеная стручковая фасоль (300г)'],p:45,c:75,f:17,cal:720},
        {name:'Перекус',time:'',items:['Творог 5% (200г) + Малина (150г)'],p:35,c:25,f:9,cal:280},
        {name:'Ужин',time:'',items:['Чечевица отварная (85г сух) + Запечённый тофу (120г) + Овощное рагу (кабачок, баклажан, томаты 300г) + 1 ч.л. оливк. масла (5г)'],p:42,c:75,f:20,cal:670},
      ],total:{p:155,c:310,f:76,cal:2600},tip:'Углеводы значительно выше — уменьшить макароны до 65г или чечевицу до 70г.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (200г) + 1 ст.л. сметаны 10% (30г) + Изюм (30г) + Тыквенные семечки (20г) + Черника (100г)'],p:38,c:55,f:20,cal:580},
        {name:'Перекус',time:'',items:['1 цельнозерн. тост (30г) + 1/4 авокадо (50г) + Ломтик запечённой индейки (50г)'],p:15,c:25,f:22,cal:350},
        {name:'Обед',time:'',items:['Запечённое куриное бедро без кожи (190г сыр) + Перловка (75г сух) + Салат из свежих овощей (350г)'],p:45,c:65,f:28,cal:740},
        {name:'Перекус',time:'',items:['Запечённое яблоко (200г) с творогом (50г) и грецкими орехами (10г)'],p:12,c:40,f:8,cal:300},
        {name:'Ужин',time:'',items:['Омлет из 3 яиц с брокколи и цвет. капустой (250г) + Салат из свеклы и моркови (200г) + 1 ч.л. льняного масла (5г)'],p:30,c:45,f:25,cal:530},
      ],total:{p:140,c:230,f:103,cal:2500},tip:'Жиры значительно выше — уменьшить авокадо/семечки/масло; белки чуть ниже.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсяная каша на воде (75г сух) с тёртым яблоком (150г) + 1 ст.л. арах. пасты без сахара (15г) + корица + 10г миндаля'],p:22,c:100,f:22,cal:650},
        {name:'Перекус',time:'',items:['Кефир 1–2.5% (250мл) + Банан (120г) + 1 ст.л. семян чиа (10г)'],p:11,c:55,f:8,cal:340},
        {name:'Обед',time:'',items:['Говядина тушеная (150г сыр) с овощами (300г) + Отварная гречка (65г сух)'],p:46,c:65,f:22,cal:700},
        {name:'Перекус',time:'',items:['Творог 5% (200г) + Мандарин (2 шт, 200г)'],p:35,c:30,f:9,cal:290},
        {name:'Ужин',time:'',items:['Креветки королевские (200г очищ.) + Овощи-гриль (цукини, баклажан, перец 400г) + Зелень + Лимонный сок + 1 ч.л. оливк. масла (5г)'],p:40,c:35,f:15,cal:480},
      ],total:{p:154,c:285,f:76,cal:2460},tip:'Углеводы выше — уменьшить банан или гречку.'},
    ]
  },
  {
    id:'76_80',title:'Рацион 76–80 кг',subtitle:'7 дней · ~2550 ккал/день',icon:'🥗',
    target:{cal:2550,p:154,c:231,f:77},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (80г сух.) + Банан (150г) + Семена чиа (15г) + Миндаль (30г)'],p:24,c:110,f:28,cal:710},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Яблоко (200г) + Мёд (10г)'],p:38,c:45,f:10,cal:370},
        {name:'Обед',time:'',items:['Куриная грудка (180г сыр.) + Гречка (90г сух.) + Овощной салат (400г) + Оливк. масло (5г)'],p:55,c:75,f:18,cal:760},
        {name:'Перекус',time:'',items:['Кефир 1% (300мл) + Малина (150г)'],p:11,c:25,f:6,cal:220},
        {name:'Ужин',time:'',items:['Лосось на гриле (160г) + Брокколи на пару (300г) + Авокадо (50г)'],p:35,c:20,f:30,cal:520},
      ],total:{p:163,c:275,f:92,cal:2580},tip:'Уменьшите орехи до 25г, если нужно снизить жиры.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречка (80г сух.) + Омлет из 3 яиц + Сыр (40г, 10–17%) + Помидор (200г)'],p:42,c:65,f:30,cal:740},
        {name:'Перекус',time:'',items:['Греческий йогурт (300г) + Груша (200г) + Отруби (20г)'],p:15,c:60,f:8,cal:360},
        {name:'Обед',time:'',items:['Индейка (180г сыр.) + Бурый рис (80г сух.) + Тушёные овощи (300г)'],p:47,c:75,f:14,cal:670},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Киви (180г)'],p:38,c:35,f:10,cal:330},
        {name:'Ужин',time:'',items:['Салат с тунцом: Тунец в с/с (150г) + Яйцо (2 шт) + Авокадо (60г) + Овощи (300г) + Лимонный сок'],p:45,c:20,f:25,cal:510},
      ],total:{p:187,c:255,f:87,cal:2610},tip:'Замените одно яйцо в ужине на огурцы, чтобы снизить белок и жиры.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 250г + 2 яйца + Яблоко 100г) + Грецкие орехи (25г)'],p:50,c:50,f:25,cal:680},
        {name:'Перекус',time:'',items:['Тосты цельнозерн. (70г) + Сыр (50г) + Огурец (200г)'],p:20,c:50,f:18,cal:450},
        {name:'Обед',time:'',items:['Чечевичный суп (Чечевица 80г сух. + Говядина 100г + Овощи 200г) + Хлеб (40г)'],p:50,c:90,f:12,cal:720},
        {name:'Перекус',time:'',items:['Запечённое яблоко (250г) + Фисташки (35г)'],p:8,c:40,f:15,cal:340},
        {name:'Ужин',time:'',items:['Телятина запеч. (150г) + Киноа (75г сух.) + Салат (350г)'],p:45,c:70,f:18,cal:670},
      ],total:{p:173,c:300,f:88,cal:2860},tip:'Уменьшите хлеб в обеде до 30г и киноа до 65г, если хотите снизить углеводы.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 3 яиц с брокколи (250г) + Авокадо (60г) + Тост (40г)'],p:30,c:50,f:35,cal:650},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Апельсин (200г)'],p:38,c:35,f:10,cal:330},
        {name:'Обед',time:'',items:['Треска запеч. (180г) + Картофель (300г) + Капустный салат (400г)'],p:40,c:95,f:18,cal:780},
        {name:'Перекус',time:'',items:['Ряженка (300мл) + Чернослив (50г)'],p:10,c:50,f:8,cal:310},
        {name:'Ужин',time:'',items:['Курица-гриль (140г) + Булгур (80г сух.) + Овощи (300г)'],p:42,c:70,f:12,cal:610},
      ],total:{p:160,c:300,f:83,cal:2680},tip:'Сократите картофель до 250г и чернослив до 35г, если хотите снизить углеводы.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Пшённая каша (80г сух.) + 2 яйца + Семена подсолнечника (30г) + Малина (100г)'],p:28,c:110,f:28,cal:780},
        {name:'Перекус',time:'',items:['Смузи: Йогурт (300г) + Персик (200г) + Шпинат (50г)'],p:10,c:40,f:6,cal:260},
        {name:'Обед',time:'',items:['Котлеты из говядины (180г фарша) + Макароны (80г сух.) + Зелёная фасоль (350г)'],p:48,c:80,f:18,cal:740},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Голубика (150г)'],p:38,c:25,f:10,cal:320},
        {name:'Ужин',time:'',items:['Тофу запеч. (150г) + Чечевица (70г сух.) + Рагу из овощей (400г)'],p:45,c:80,f:20,cal:700},
      ],total:{p:169,c:335,f:82,cal:2800},tip:'Уменьшите макароны до 70г и чечевицу до 60г, если хотите снизить углеводы.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (250г) + Сметана 10% (40г) + Изюм (40г) + Тыквенные семечки (25г)'],p:45,c:60,f:22,cal:640},
        {name:'Перекус',time:'',items:['Хлебец (40г) + Авокадо (80г) + Слайсы индейки (60г)'],p:18,c:30,f:25,cal:420},
        {name:'Обед',time:'',items:['Куриное бедро без кожи (200г сыр.) + Перловка (80г сух.) + Салат (500г)'],p:48,c:70,f:30,cal:780},
        {name:'Перекус',time:'',items:['Творожный мусс: Творог (100г) + Кефир (100г) + Груша (150г)'],p:18,c:40,f:5,cal:270},
        {name:'Ужин',time:'',items:['Омлет из 3 яиц с грибами (200г) + Свёкла отварная (200г) + Льняное масло (5г)'],p:30,c:40,f:25,cal:520},
      ],total:{p:159,c:240,f:107,cal:2630},tip:'Уменьшите авокадо до 50г и уберите масло в ужине, если хотите снизить жиры.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (80г сух.) + Тёртое яблоко (200г) + Арахисовая паста (20г) + Кешью (20г)'],p:25,c:120,f:25,cal:780},
        {name:'Перекус',time:'',items:['Творожная запеканка: Творог (150г) + 1 яйцо + Ягоды (100г)'],p:25,c:20,f:10,cal:280},
        {name:'Обед',time:'',items:['Говядина тушеная (160г сыр.) + Гречка (70г сух.) + Овощи (500г)'],p:48,c:70,f:22,cal:720},
        {name:'Перекус',time:'',items:['Кефир (300мл) + Мандарины (300г)'],p:11,c:45,f:8,cal:290},
        {name:'Ужин',time:'',items:['Креветки (220г очищ.) + Цукини-гриль (500г) + Урбеч (15г)'],p:45,c:40,f:15,cal:500},
      ],total:{p:154,c:295,f:80,cal:2570},tip:'Замените урбеч на лимонный сок, если нужно снизить жиры.'},
    ]
  },
  {
    id:'81_85',title:'Рацион 81–85 кг',subtitle:'7 дней · ~2900 ккал/день',icon:'🥗',
    target:{cal:2900,p:164,c:246,f:82},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (90г сух.) + Сывороточный протеин (30г) + Банан (180г) + Миндаль (40г)'],p:50,c:130,f:28,cal:950},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Яблоко (200г) + Льняные семена (10г)'],p:43,c:40,f:12,cal:430},
        {name:'Обед',time:'',items:['Куриная грудка (200г сыр.) + Гречка (100г сух.) + Овощной салат (500г) + Оливк. масло (10г)'],p:60,c:85,f:22,cal:850},
        {name:'Перекус',time:'',items:['Кефир 1% (400мл) + Малина (200г)'],p:14,c:30,f:8,cal:260},
        {name:'Ужин',time:'',items:['Лосось на гриле (180г) + Спаржа (400г) + Авокадо (60г)'],p:40,c:25,f:35,cal:600},
      ],total:{p:207,c:310,f:105,cal:3090},tip:'Можно уменьшить авокадо до 40г, если хотите снизить жиры.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречка (90г сух.) + Омлет из 4 яиц + Сыр (50г) + Помидор (250г)'],p:50,c:70,f:35,cal:820},
        {name:'Перекус',time:'',items:['Греческий йогурт (400г) + Груша (250г) + Отруби (25г)'],p:20,c:75,f:10,cal:480},
        {name:'Обед',time:'',items:['Индейка (200г сыр.) + Бурый рис (90г сух.) + Тушеные овощи (400г)'],p:52,c:85,f:15,cal:720},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Киви (200г)'],p:43,c:35,f:11,cal:390},
        {name:'Ужин',time:'',items:['Салат с тунцом: Тунец в с/с (180г) + Яйца (2 шт) + Авокадо (70г) + Овощи (400г)'],p:55,c:25,f:30,cal:600},
      ],total:{p:220,c:290,f:101,cal:3010},tip:'Можно убрать 1 яйцо и уменьшить авокадо до 50г, если хотите снизить белок и жиры.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 300г + 2 яйца + Яблоко 150г) + Грецкие орехи (30г)'],p:60,c:60,f:30,cal:800},
        {name:'Перекус',time:'',items:['Цельнозерн. тосты (80г) + Сыр (60г) + Огурец (250г)'],p:25,c:60,f:20,cal:520},
        {name:'Обед',time:'',items:['Чечевичный суп (Чечевица 100г сух. + Говядина 120г + Овощи 300г) + Хлеб (50г)'],p:60,c:110,f:15,cal:850},
        {name:'Перекус',time:'',items:['Запеч. яблоко (300г) + Фисташки (40г)'],p:10,c:50,f:18,cal:420},
        {name:'Ужин',time:'',items:['Телятина запеч. (180г) + Киноа (90г сух.) + Салат (500г)'],p:55,c:85,f:22,cal:780},
      ],total:{p:210,c:365,f:105,cal:3370},tip:'Можно уменьшить хлеб до 30г и киноа до 75г, если хотите снизить углеводы.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 4 яиц с брокколи (300г) + Авокадо (80г) + Тост (50г)'],p:40,c:60,f:40,cal:780},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Апельсин (250г)'],p:43,c:45,f:11,cal:430},
        {name:'Обед',time:'',items:['Треска запеч. (200г) + Картофель (350г) + Капустный салат (600г)'],p:45,c:110,f:20,cal:880},
        {name:'Перекус',time:'',items:['Ряженка (400мл) + Чернослив (60г)'],p:14,c:65,f:10,cal:410},
        {name:'Ужин',time:'',items:['Курица-гриль (160г) + Булгур (90г сух.) + Овощи (500г)'],p:48,c:80,f:14,cal:680},
      ],total:{p:190,c:360,f:95,cal:3180},tip:'Можно уменьшить картофель до 280г и чернослив до 40г, если хотите снизить углеводы.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Пшенная каша (90г сух.) + Яйца (3 шт) + Семена подсолнечника (40г) + Малина (150г)'],p:35,c:125,f:35,cal:950},
        {name:'Перекус',time:'',items:['Смузи: Йогурт (400г) + Персик (250г) + Шпинат (100г)'],p:15,c:55,f:8,cal:340},
        {name:'Обед',time:'',items:['Котлеты из говядины (200г фарша) + Макароны (90г сух.) + Зеленая фасоль (500г)'],p:55,c:90,f:20,cal:800},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Голубика (200г)'],p:43,c:35,f:11,cal:410},
        {name:'Ужин',time:'',items:['Тофу запеч. (180г) + Чечевица (90г сух.) + Рагу из овощей (600г)'],p:55,c:100,f:25,cal:850},
      ],total:{p:203,c:405,f:99,cal:3350},tip:'Можно уменьшить макароны до 75г и чечевицу до 70г, если хотите снизить углеводы и белок.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (300г) + Сметана 10% (50г) + Изюм (50г) + Тыкв. семечки (30г)'],p:55,c:70,f:25,cal:750},
        {name:'Перекус',time:'',items:['Хлебец (50г) + Авокадо (100г) + Индейка слайсы (80г)'],p:20,c:35,f:30,cal:500},
        {name:'Обед',time:'',items:['Куриное бедро без кожи (220г сыр.) + Перловка (90г сух.) + Салат (700г)'],p:55,c:80,f:35,cal:850},
        {name:'Перекус',time:'',items:['Творожный мусс: Творог (150г) + Кефир (150г) + Груша (200г)'],p:25,c:50,f:7,cal:350},
        {name:'Ужин',time:'',items:['Омлет из 4 яиц с грибами (300г) + Свекла отварная (300г) + Льняное масло (10г)'],p:40,c:60,f:35,cal:700},
      ],total:{p:195,c:295,f:132,cal:3150},tip:'Можно уменьшить авокадо до 60г и убрать масло, если хотите снизить жиры.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (90г сух.) + Сывороточный протеин (25г) + Яблоко (250г) + Арах. паста (25г)'],p:45,c:130,f:25,cal:900},
        {name:'Перекус',time:'',items:['Творожная запеканка: Творог (200г) + 1 яйцо + Ягоды (150г)'],p:35,c:30,f:12,cal:380},
        {name:'Обед',time:'',items:['Говядина тушеная (180г сыр.) + Гречка (80г сух.) + Овощи (700г)'],p:55,c:80,f:25,cal:780},
        {name:'Перекус',time:'',items:['Кефир (400мл) + Мандарины (400г)'],p:14,c:60,f:10,cal:400},
        {name:'Ужин',time:'',items:['Креветки королевские (250г очищ.) + Цукини гриль (700г) + Лимонный сок'],p:50,c:50,f:8,cal:500},
      ],total:{p:199,c:350,f:80,cal:2960},tip:'Можно заменить протеин на орехи 20г, если нужно снизить белок.'},
    ]
  },
]

const DAY_NAMES=['Пн','Вт','Ср','Чт','Пт','Сб','Вс']
const MEAL_ICONS={'Завтрак':'🌅','Перекус':'🍎','Обед':'🍽️','Ужин':'🌙'}

function NutritionView({ userId }){
  const [openPlan,setOpenPlan]=useState(null)
  const [openDay,setOpenDay]=useState(null)
  const [logDate,setLogDate]=useState(()=>{const t=new Date();return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`})
  const [logDone,setLogDone]=useState(false)
  const [showLogDatePicker,setShowLogDatePicker]=useState(false)
  const logCalInputRef=useRef(null)

  const applyToFoodDiary=async(day,date)=>{
    const newEntries=day.meals.map((meal,i)=>({
      id:Date.now()+i,
      name:`${meal.name}${meal.time?' ('+meal.time+')':''}`,
      kcal:String(meal.cal),
      p:String(meal.p),
      c:String(meal.c),
      f:String(meal.f),
      items:meal.items||[],
    }))
    if(userId){
      await supabase.from('food_diary').insert(newEntries.map(e=>({
        user_id:userId, date, name:e.name,
        kcal:+e.kcal||0, p:+e.p||0, c:+e.c||0, f:+e.f||0,
      })))
    }
    const raw=localStorage.getItem('fitpro_food_diary')
    const diary=raw?JSON.parse(raw):{}
    diary[date]=[...(diary[date]||[]),...newEntries]
    localStorage.setItem('fitpro_food_diary',JSON.stringify(diary))
    window.dispatchEvent(new CustomEvent('fitpro:diary-update'))
    setLogDone(true)
    setShowLogDatePicker(false)
    setTimeout(()=>setLogDone(false),2500)
  }

  if(openDay!==null&&openPlan!==null){
    const plan=NUTRITION_PLANS.find(p=>p.id===openPlan)
    const day=plan.days[openDay]
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:'#f3f4f6',zIndex:1001,display:'flex',flexDirection:'column' }}>
        <div style={{ background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 18px',display:'flex',alignItems:'center',gap:14,flexShrink:0 }}>
          <button onClick={()=>setOpenDay(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset' }}>←</button>
          <div>
            <div style={{ fontSize:17,fontWeight:700,color:'#111' }}>День {day.n} — {DAY_NAMES[openDay]}</div>
            <div style={{ fontSize:11,color:'#9ca3af' }}>{plan.title}</div>
          </div>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 100px' }}>
          {/* Target macros */}
          <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14 }}>
            {[{l:'Калории',v:`${day.total.cal}`,u:'ккал',c:PUR},{l:'Белки',v:`${day.total.p}`,u:'г',c:TEA},{l:'Углеводы',v:`${day.total.c}`,u:'г',c:BLU},{l:'Жиры',v:`${day.total.f}`,u:'г',c:COR}].map(m=>(
              <div key={m.l} style={{ background:'#fff',borderRadius:11,padding:'10px 8px',textAlign:'center',boxShadow:'0 1px 4px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize:15,fontWeight:700,color:m.c }}>{m.v}<span style={{ fontSize:10,fontWeight:400,color:'#9ca3af' }}> {m.u}</span></div>
                <div style={{ fontSize:10,color:'#9ca3af',marginTop:2 }}>{m.l}</div>
              </div>
            ))}
          </div>
          {/* Meals */}
          {day.meals.map((meal,mi)=>(
            <div key={mi} style={{ background:'#fff',borderRadius:13,boxShadow:'0 1px 4px rgba(0,0,0,0.07)',marginBottom:10,overflow:'hidden' }}>
              <div style={{ background:`${TEA}12`,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #f3f4f6' }}>
                <div style={{ display:'flex',alignItems:'center',gap:7 }}>
                  <span style={{ fontSize:16 }}>{MEAL_ICONS[meal.name]||'🍴'}</span>
                  <span style={{ fontSize:14,fontWeight:700,color:'#111' }}>{meal.name}</span>
                  {meal.time&&<span style={{ fontSize:11,color:'#9ca3af' }}>({meal.time})</span>}
                </div>
                <span style={{ fontSize:13,fontWeight:600,color:COR }}>{meal.cal} ккал</span>
              </div>
              <div style={{ padding:'10px 14px' }}>
                {meal.items.map((item,ii)=>(
                  <div key={ii} style={{ fontSize:13,color:'#374151',padding:'3px 0',borderBottom:ii<meal.items.length-1?'1px solid #f9fafb':'none' }}>{item}</div>
                ))}
                <div style={{ display:'flex',gap:12,marginTop:8,paddingTop:8,borderTop:'1px solid #f3f4f6' }}>
                  {[['Б',meal.p,TEA],['У',meal.c,BLU],['Ж',meal.f,COR]].map(([l,v,c])=>(
                    <span key={l} style={{ fontSize:11,color:c,fontWeight:600 }}>{l}: {v}г</span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {/* Tip */}
          {day.tip&&(
            <div style={{ background:`${PUR}12`,border:`1px solid ${PUR}30`,borderRadius:11,padding:'10px 14px',fontSize:12,color:'#374151',lineHeight:1.6 }}>
              <span style={{ fontWeight:700,color:PUR }}>💡 Можно: </span>{day.tip}
            </div>
          )}
        </div>
        {/* ── Панель «Копировать рацион» */}
        <div style={{ background:'#fff',borderTop:'1px solid #e5e7eb',padding:'10px 16px 14px',flexShrink:0 }}>
          {showLogDatePicker?(()=>{
            const toISO=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
            const yd=new Date();yd.setDate(yd.getDate()-1);const yISO=toISO(yd)
            const td=new Date();const tISO=toISO(td)
            const tmr=new Date();tmr.setDate(tmr.getDate()+1);const tmrISO=toISO(tmr)
            return(
              <div>
                <div style={{ fontSize:12,color:'#6b7280',fontWeight:600,marginBottom:8,textAlign:'center' }}>Выбери дату:</div>
                <div style={{ display:'flex',gap:6,marginBottom:10 }}>
                  {[['Вчера',yISO],['Сегодня',tISO],['Завтра',tmrISO]].map(([lbl,iso])=>(
                    <button key={iso} onClick={()=>setLogDate(iso)}
                      style={{ flex:1,padding:'9px 4px',borderRadius:10,border:`1.5px solid ${logDate===iso?BLU:'#e5e7eb'}`,background:logDate===iso?`${BLU}15`:'#fff',color:logDate===iso?BLU:'#6b7280',fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>
                      {lbl}
                    </button>
                  ))}
                  <button onClick={()=>logCalInputRef.current?.showPicker?.()??logCalInputRef.current?.click()}
                    style={{ width:42,flexShrink:0,borderRadius:10,border:'1.5px solid #e5e7eb',background:'#fff',cursor:'pointer',fontSize:18,display:'flex',alignItems:'center',justifyContent:'center',minHeight:'unset' }}>
                    📅
                    <input ref={logCalInputRef} type="date" value={logDate} onChange={e=>setLogDate(e.target.value)}
                      style={{ position:'absolute',opacity:0,width:0,height:0,pointerEvents:'none' }} />
                  </button>
                </div>
                <div style={{ display:'flex',gap:8 }}>
                  <button onClick={()=>applyToFoodDiary(day,logDate)}
                    style={{ flex:1,padding:'12px',borderRadius:12,border:'none',background:BLU,color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset' }}>
                    📋 Копировать
                  </button>
                  <button onClick={()=>setShowLogDatePicker(false)}
                    style={{ padding:'12px 16px',borderRadius:12,border:'none',background:'#f3f4f6',color:'#6b7280',fontSize:14,cursor:'pointer',minHeight:'unset' }}>
                    Отмена
                  </button>
                </div>
              </div>
            )
          })():(
            <button onClick={()=>{if(logDone)return;const t=new Date();setLogDate(`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`);setShowLogDatePicker(true)}}
              style={{ width:'100%',padding:'13px',borderRadius:12,border:'none',
                background:logDone?TEA:BLU,color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset',
                display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'background 0.3s' }}>
              {logDone?'✓ Рацион скопирован в дневник!':'📋 Копировать рацион'}
            </button>
          )}
        </div>
      </div>
    , document.body)
  }

  if(openPlan!==null){
    const plan=NUTRITION_PLANS.find(p=>p.id===openPlan)
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:'#f3f4f6',zIndex:1000,display:'flex',flexDirection:'column' }}>
        <div style={{ background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 18px',display:'flex',alignItems:'center',gap:14,flexShrink:0 }}>
          <button onClick={()=>setOpenPlan(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset' }}>←</button>
          <span style={{ fontSize:22 }}>{plan.icon}</span>
          <div>
            <div style={{ fontSize:17,fontWeight:700,color:'#111' }}>{plan.title}</div>
            <div style={{ fontSize:11,color:'#9ca3af' }}>Цель: {plan.target.p}г Б / {plan.target.c}г У / {plan.target.f}г Ж / ~{plan.target.cal} ккал</div>
          </div>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          {plan.days.map((day,di)=>(
            <div key={di} style={{ background:'#fff',borderRadius:13,boxShadow:'0 1px 4px rgba(0,0,0,0.07)',marginBottom:10,display:'flex',alignItems:'center',gap:12,padding:'14px 16px',cursor:'pointer' }}
              onClick={()=>setOpenDay(di)}>
              <div style={{ flexShrink:0,width:46,height:46,borderRadius:12,background:TEA,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center' }}>
                <span style={{ fontSize:11,fontWeight:700,color:'#fff',lineHeight:1 }}>{DAY_NAMES[di]}</span>
                <span style={{ fontSize:16,fontWeight:800,color:'#fff',lineHeight:1.2 }}>{di+1}</span>
              </div>
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ fontSize:15,fontWeight:600,color:'#111' }}>День {day.n}</div>
                <div style={{ fontSize:11,color:'#9ca3af',marginTop:2 }}>
                  {day.meals.length} приёма · Итого: Б{day.total.p}г У{day.total.c}г Ж{day.total.f}г
                </div>
              </div>
              <div style={{ textAlign:'right',flexShrink:0 }}>
                <div style={{ fontSize:15,fontWeight:700,color:COR }}>{day.total.cal}</div>
                <div style={{ fontSize:10,color:'#9ca3af' }}>ккал</div>
              </div>
              <span style={{ fontSize:20,color:'#c7cad1' }}>›</span>
            </div>
          ))}
        </div>
      </div>
    , document.body)
  }

  return(
    <div>
      <h2 style={{ fontSize:20,fontWeight:500,color:'#111',margin:'0 0 14px' }}>Планы питания</h2>
      {NUTRITION_PLANS.map(plan=>(
        <Card key={plan.id} style={{ marginBottom:10,cursor:'pointer' }} onClick={()=>setOpenPlan(plan.id)}>
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center' }}>
            <div style={{ display:'flex',alignItems:'center',gap:12 }}>
              <div style={{ fontSize:30 }}>{plan.icon}</div>
              <div>
                <div style={{ fontSize:15,fontWeight:600,color:'#111' }}>{plan.title}</div>
                <div style={{ fontSize:11,color:'#9ca3af',marginTop:2 }}>{plan.subtitle}</div>
              </div>
            </div>
            <span style={{ fontSize:20,color:'#c7cad1' }}>›</span>
          </div>
          <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginTop:12 }}>
            {[['🔥',`~${plan.target.cal}`,PUR,'ккал/день'],['🥩',`${plan.target.p}г`,TEA,'белков'],['🍚',`${plan.target.c}г`,BLU,'углеводов'],['🥑',`${plan.target.f}г`,COR,'жиров']].map(([ic,v,c,l])=>(
              <div key={l} style={{ background:'#f9fafb',borderRadius:9,padding:'8px 6px',textAlign:'center' }}>
                <div style={{ fontSize:13 }}>{ic}</div>
                <div style={{ fontSize:13,fontWeight:700,color:c }}>{v}</div>
                <div style={{ fontSize:9,color:'#9ca3af' }}>{l}</div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

const MUSCLE_ICONS={'Ноги':'🦵','Грудь':'💪','Спина':'🔙','Плечи':'🏔','Руки':'💪','Кор':'⚡','Всё тело':'🔥','Кардио':'❤️'}
const EQ_TIPS={
  'Штанга':'Контролируйте траекторию, не бросайте снаряд.',
  'Гантели':'Следите за симметрией движения обеих рук.',
  'Турник':'Тяните лопатки вниз перед началом движения.',
  'Блок':'Зафиксируйте корпус, двигайте только целевой сустав.',
  'Тренажёр':'Настройте сиденье под свой рост перед началом.',
  'Без оборудования':'Контролируйте темп — не используйте инерцию.',
}

function LibraryView({ customExercises }) {
  const [filt,setFilt]=useState('Все')
  const [sel,setSel]=useState(null)
  const [query,setQuery]=useState('')
  const all=[...EXERCISES,...(customExercises||[])]
  const muscles=['Все',...new Set(all.map(e=>e.m))]
  const fl=all.filter(e=>(filt==='Все'||e.m===filt)&&e.n.toLowerCase().includes(query.toLowerCase()))

  const history=(()=>{ try{ return JSON.parse(localStorage.getItem('fitpro_history')||'[]') }catch{ return [] } })()

  if(sel){
    const records=history.flatMap(w=>{
      const found=(w.exercises||[]).find(ex=>ex.n===sel.n)
      if(!found)return[]
      const ton=(found.sets||[]).reduce((s,st)=>s+(parseFloat(st.kg)||0)*(parseInt(st.reps)||0),0)
      const maxKg=Math.max(0,...(found.sets||[]).map(s=>parseFloat(s.kg)||0))
      return[{date:w.date,workoutName:w.name,sets:found.sets||[],ton,maxKg}]
    }).sort((a,b)=>new Date(a.date)-new Date(b.date))
    const tip=EQ_TIPS[sel.eq]||'Выполняйте упражнение в полной амплитуде.'
    const best=records.length?Math.max(...records.map(r=>r.maxKg)):0
    return(
      <div>
        <button onClick={()=>setSel(null)} style={{ fontSize:13,color:'#6b7280',border:'none',background:'none',cursor:'pointer',padding:0,marginBottom:18,display:'flex',alignItems:'center',gap:5 }}>← Все упражнения</button>
        <div style={{ display:'flex',alignItems:'center',gap:12,marginBottom:20 }}>
          <div style={{ width:52,height:52,borderRadius:14,background:'#EEEDFE',display:'flex',alignItems:'center',justifyContent:'center',fontSize:24,flexShrink:0 }}>
            {MUSCLE_ICONS[sel.m]||'🏋️'}
          </div>
          <div>
            <h2 style={{ fontSize:20,fontWeight:700,color:'#111',margin:0 }}>{sel.n}</h2>
            <div style={{ fontSize:12,color:'#9ca3af',marginTop:3 }}>{sel.m}{sel.eq?` · ${sel.eq}`:''}{sel.custom&&<span style={{ marginLeft:6,fontSize:10,padding:'1px 6px',borderRadius:4,background:'#EEEDFE',color:PUR }}>моё</span>}</div>
          </div>
        </div>
        <Card style={{ marginBottom:12,border:`1.5px solid ${PUR}22` }}>
          <div style={{ fontSize:11,fontWeight:700,color:PUR,marginBottom:6,textTransform:'uppercase',letterSpacing:'0.5px' }}>💡 Техника</div>
          <div style={{ fontSize:13,color:'#374151',lineHeight:1.6 }}>{tip}</div>
        </Card>
        {records.length===0?(
          <Card>
            <div style={{ textAlign:'center',padding:'20px 0',color:'#c7cad1',fontSize:13 }}>
              <div style={{ fontSize:32,marginBottom:8 }}>📊</div>
              Нет данных. Выполните тренировку с этим упражнением.
            </div>
          </Card>
        ):(
          <Card>
            <div style={{ fontSize:13,fontWeight:700,color:'#111',marginBottom:12 }}>Статистика</div>
            <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14 }}>
              {[{l:'Лучший вес',v:`${best} кг`,c:PUR},{l:'Тренировок',v:records.length,c:'#111'},{l:'Посл. тоннаж',v:`${records[records.length-1].ton} кг`,c:TEA}].map(m=>(
                <div key={m.l} style={{ background:'#f9fafb',borderRadius:10,padding:'10px 12px',textAlign:'center' }}>
                  <div style={{ fontSize:10,color:'#9ca3af',marginBottom:4 }}>{m.l}</div>
                  <div style={{ fontSize:16,fontWeight:700,color:m.c }}>{m.v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize:11,color:'#9ca3af',marginBottom:6 }}>История по дням</div>
            <div style={{ display:'flex',flexDirection:'column',gap:6 }}>
              {[...records].reverse().slice(0,5).map((r,i)=>(
                <div key={i} style={{ display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 12px',background:'#f9fafb',borderRadius:9 }}>
                  <div>
                    <div style={{ fontSize:13,fontWeight:500,color:'#111' }}>{new Date(r.date).toLocaleDateString('ru',{day:'numeric',month:'short'})}</div>
                    <div style={{ fontSize:11,color:'#9ca3af',marginTop:1 }}>{r.workoutName}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:13,fontWeight:700,color:PUR }}>{r.maxKg} кг</div>
                    <div style={{ fontSize:10,color:'#9ca3af' }}>макс. вес</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:'0 0 14px' }}>Библиотека упражнений</h2>
      <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск упражнения..."
        style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:9,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',marginBottom:10,color:'#111' }}
        onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
      <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:14 }}>
        {muscles.map(m=>(
          <button key={m} onClick={()=>setFilt(m)} style={{ fontSize:12, padding:'4px 10px', borderRadius:20, cursor:'pointer', border:`1px solid ${filt===m?PUR:'#e5e7eb'}`, background:filt===m?'#EEEDFE':'transparent', color:filt===m?'#3C3489':'#6b7280' }}>{m}</button>
        ))}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:9 }}>
        {fl.map((ex,i)=>(
          <Card key={i} onClick={()=>setSel(ex)} style={{ cursor:'pointer' }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5 }}>
              <span style={{ fontSize:22 }}>{MUSCLE_ICONS[ex.m]||'🏋️'}</span>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:15, fontWeight:600, color:'#111' }}>{ex.n}{ex.custom&&<span style={{ marginLeft:6, fontSize:10, padding:'1px 6px', borderRadius:4, background:'#EEEDFE', color:PUR }}>моё</span>}</div>
                <div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>{ex.m}{ex.eq?` · ${ex.eq}`:''}</div>
              </div>
            </div>
          </Card>
        ))}
        {fl.length===0&&<div style={{ color:'#c7cad1',fontSize:13,gridColumn:'1/-1',textAlign:'center',padding:'30px 0' }}>Ничего не найдено</div>}
      </div>
    </div>
  )
}

function ChatView() {
  const loadMsgs = (clientId) => {
    try {
      const stored = JSON.parse(localStorage.getItem(`fitpro_chat_${clientId}`)||'null')
      return stored || (clientId===CLIENTS[0].id ? CHAT_INIT : [])
    } catch { return [] }
  }
  const [active,setActive]=useState(CLIENTS[0])
  const [msgs,setMsgs]=useState(()=>loadMsgs(CLIENTS[0].id))
  const [inp,setInp]=useState('')
  const msgsEndRef=useRef(null)

  const switchClient=(c)=>{
    setActive(c)
    setMsgs(loadMsgs(c.id))
    setInp('')
  }

  useEffect(()=>{
    msgsEndRef.current?.scrollIntoView({behavior:'smooth'})
  },[msgs])

  const send=()=>{
    if(!inp.trim())return
    const now=new Date()
    const newMsg={id:Date.now(),from:'trainer',text:inp,t:`${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`}
    const newMsgs=[...msgs,newMsg]
    setMsgs(newMsgs)
    localStorage.setItem(`fitpro_chat_${active.id}`,JSON.stringify(newMsgs))
    setInp('')
  }

  return (
    <div>
      <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:'0 0 14px' }}>Чат с клиентами</h2>
      <div style={{ display:'flex', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', height:460 }}>
        <div style={{ width:170, borderRight:'1px solid #e5e7eb', overflowY:'auto' }}>
          {CLIENTS.map(c=>{
            const cMsgs=loadMsgs(c.id)
            const last=cMsgs[cMsgs.length-1]
            return(
              <div key={c.id} onClick={()=>switchClient(c)} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', cursor:'pointer', background:active.id===c.id?'#f9fafb':'transparent', borderBottom:'1px solid #f3f4f6' }}>
                <Av lbl={c.av} sz={28} />
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:'#111' }}>{c.name.split(' ')[0]}</div>
                  <div style={{ fontSize:10, color:'#9ca3af', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' }}>{last?last.text.slice(0,18)+(last.text.length>18?'…':''):c.goal}</div>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'9px 13px', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', gap:8 }}>
            <Av lbl={active.av} sz={26} />
            <div>
              <span style={{ fontSize:13, fontWeight:500, color:'#111' }}>{active.name}</span>
              <div style={{ fontSize:10, color:'#9ca3af' }}>{active.goal}</div>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'11px 13px', display:'flex', flexDirection:'column', gap:7 }}>
            {msgs.length===0&&<div style={{ textAlign:'center',color:'#c7cad1',fontSize:12,marginTop:40 }}>Начните переписку</div>}
            {msgs.map(m=>(
              <div key={m.id} style={{ display:'flex', justifyContent:m.from==='trainer'?'flex-end':'flex-start' }}>
                <div style={{ maxWidth:'72%', padding:'8px 11px', borderRadius:11, background:m.from==='trainer'?PUR:'#f3f4f6', color:m.from==='trainer'?'#fff':'#111', fontSize:13 }}>
                  {m.text}
                  <div style={{ fontSize:10, marginTop:3, opacity:.6, textAlign:'right' }}>{m.t}</div>
                </div>
              </div>
            ))}
            <div ref={msgsEndRef} />
          </div>
          <div style={{ padding:'9px 13px', borderTop:'1px solid #e5e7eb', display:'flex', gap:7 }}>
            <input value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder="Написать сообщение..." style={{ flex:1, padding:'7px 11px', fontSize:13, borderRadius:8, border:'1px solid #e5e7eb' }} />
            <button onClick={send} style={{ padding:'7px 14px', background:PUR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>➤</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Скроллер дат (тёмный, как на скрине)
function DateScroller({ value, onChange }) {
  const ref = useRef(null)
  const today = new Date()
  const toISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const todayISO = toISO(today)
  const DAY_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб']
  const MONTH_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек']

  const days = Array.from({length:365},(_,i)=>{
    const d = new Date(today)
    d.setDate(today.getDate()-180+i)
    return d
  })

  const ITEM_W = 46

  useEffect(()=>{
    const idx = days.findIndex(d=>toISO(d)===value)
    if(idx>=0 && ref.current){
      const el = ref.current
      el.scrollLeft = idx*ITEM_W - el.clientWidth/2 + ITEM_W/2
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[value])

  const selDate = new Date(value+'T00:00:00')
  const isSelToday = value===todayISO
  const isSelYesterday = (()=>{ const y=new Date(today); y.setDate(y.getDate()-1); return toISO(y)===value })()
  const label = isSelToday ? 'Сегодня' : isSelYesterday ? 'Вчера' : `${selDate.getDate()} ${MONTH_RU[selDate.getMonth()]}`

  return (
    <div style={{ marginBottom:14, userSelect:'none' }}>
      {/* Заголовок с текущей датой */}
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 4px',marginBottom:8 }}>
        <span style={{ fontSize:15,fontWeight:700,color:'#111' }}>{label}</span>
        <span style={{ fontSize:12,color:'#9ca3af' }}>{selDate.toLocaleDateString('ru',{weekday:'long'})}</span>
      </div>
      {/* Скроллер */}
      <div style={{ background:'#f9fafb',borderRadius:16,padding:'10px 0',border:'1px solid #f0f0f0' }}>
        <div ref={ref} style={{ display:'flex',overflowX:'auto',scrollbarWidth:'none',WebkitOverflowScrolling:'touch',padding:'0 10px' }}>
          {days.map(d=>{
            const iso = toISO(d)
            const sel = iso===value
            const isToday = iso===todayISO
            return (
              <div key={iso} onClick={()=>onChange(iso)}
                style={{ display:'flex',flexDirection:'column',alignItems:'center',flexShrink:0,width:ITEM_W,cursor:'pointer',padding:'2px 0' }}>
                <span style={{ fontSize:10,fontWeight:500,color:sel?PUR:isToday?PUR:'#b0b7c3',marginBottom:4,letterSpacing:'0.02em',textTransform:'uppercase' }}>
                  {DAY_RU[d.getDay()]}
                </span>
                <div style={{ width:34,height:34,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',
                  background: sel?PUR:isToday?`${PUR}15`:'transparent',
                  fontSize:13,fontWeight:sel?700:isToday?600:400,
                  color:sel?'#fff':isToday?PUR:'#6b7280',
                  transition:'all 0.15s' }}>
                  {d.getDate()}
                </div>
                {isToday&&!sel&&<div style={{ width:4,height:4,borderRadius:'50%',background:PUR,marginTop:3 }} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Дневник
function DiaryView({ workoutHistory, onEditWorkout, onDeleteWorkout, onCopyWorkout, onWorkoutAction, isMobile, onOpenAI, userId }) {
  const [section, setSection] = useState(null)
  // tonnage
  const [period,setPeriod]=useState('all')
  const [customFrom,setCustomFrom]=useState('')
  const [customTo,setCustomTo]=useState('')
  const [selectedTonBar,setSelectedTonBar]=useState(null)
  // exercises
  const [selectedEx,setSelectedEx]=useState(null)
  const [exQuery,setExQuery]=useState('')
  const [activeBar,setActiveBar]=useState(null)
  // workouts
  const [selIdx,setSelIdx]=useState(null)
  const [showWorkoutMenu,setShowWorkoutMenu]=useState(false)
  const [openCardMenu,setOpenCardMenu]=useState(null)
  const [openSelWorkoutMenu,setOpenSelWorkoutMenu]=useState(false)
  const [openActiveRecMenu,setOpenActiveRecMenu]=useState(false)
  const [showScheduleForm,setShowScheduleForm]=useState(false)
  const [scheduleForm,setScheduleForm]=useState({name:'',date:''})
  const [plannedWorkouts,setPlannedWorkouts]=useState(()=>{try{return JSON.parse(localStorage.getItem('fitpro_planned')||'[]')}catch{return[]}})
  const [templateMsg,setTemplateMsg]=useState('')

  // ── общие вычисления (нужны всем секциям)
  const exerciseMap={}
  workoutHistory.forEach((w,histIdx)=>{
    ;(w.exercises||[]).forEach(ex=>{
      if(!exerciseMap[ex.n])exerciseMap[ex.n]={muscle:ex.m,records:[]}
      const validSets=(ex.sets||[]).filter(s=>s.kg||s.reps)
      const tonnage=validSets.reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)
      const maxKg=validSets.length?Math.max(...validSets.map(s=>parseFloat(s.kg)||0)):0
      exerciseMap[ex.n].records.push({date:w.date,sets:ex.sets,tonnage,maxKg,histIdx,workoutName:w.name})
    })
  })
  const exerciseNames=Object.keys(exerciseMap).sort()
  const allWorkoutTons=workoutHistory
    .map((w,histIdx)=>({
      date:w.date,name:w.name,color:w.color||PUR,histIdx,exercises:w.exercises||[],
      ton:(w.exercises||[]).reduce((s1,ex)=>(ex.sets||[]).reduce((s2,set)=>s2+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),s1),0),
    }))
    .sort((a,b)=>new Date(a.date)-new Date(b.date))
  const fmtD=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'short'}).replace(/\./g,'')
  const fmtFull=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})

  // ── питание дневник
  const [foodDiary,setFoodDiary]=useState({})
  const [foodDate,setFoodDate]=useState(()=>{const t=new Date();return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`})
  const [showFoodForm,setShowFoodForm]=useState(false)
  const [foodForm,setFoodForm]=useState({name:'',kcal:'',p:'',c:'',f:''})
  const [editingFoodId,setEditingFoodId]=useState(null)
  const [editFoodForm,setEditFoodForm]=useState({name:'',kcal:'',p:'',c:'',f:'',items:[]})
  const [openFoodMenu,setOpenFoodMenu]=useState(null)
  const [showCalPicker,setShowCalPicker]=useState(false)
  const [calPickerMonth,setCalPickerMonth]=useState(()=>{const t=new Date();return{y:t.getFullYear(),m:t.getMonth()}})
  const [foodView,setFoodView]=useState('day') // 'day' | 'week'
  const [showGoals,setShowGoals]=useState(false)
  const [foodGoals,setFoodGoals]=useState({kcal:2000,p:150,c:200,f:60})
  const [goalsForm,setGoalsForm]=useState(foodGoals)

  // Загрузка дневника из Supabase при смене даты
  useEffect(()=>{
    if(!userId){
      setFoodDiary(d=>({...d,...(()=>{try{return JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}')}catch{return{}}})()}))
      return
    }
    supabase.from('food_diary').select('*').eq('user_id',userId).eq('date',foodDate).order('created_at')
      .then(({data})=>{
        const entries=(data||[]).map(r=>({id:r.id,name:r.name,kcal:String(r.kcal||0),p:String(r.p||0),c:String(r.c||0),f:String(r.f||0)}))
        setFoodDiary(d=>{
          const updated={...d,[foodDate]:entries}
          const all={...JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}'),[foodDate]:entries}
          localStorage.setItem('fitpro_food_diary',JSON.stringify(all))
          return updated
        })
      })
  },[foodDate,userId])

  // Загрузка целей КБЖУ из Supabase
  useEffect(()=>{
    if(!userId){
      const g=JSON.parse(localStorage.getItem('fitpro_food_goals')||'{"kcal":2000,"p":150,"c":200,"f":60}')
      setFoodGoals(g);setGoalsForm(g);return
    }
    supabase.from('food_goals').select('*').eq('user_id',userId).single()
      .then(({data})=>{
        if(data){
          const g={kcal:data.kcal||2000,p:data.p||150,c:data.c||200,f:data.f||60}
          setFoodGoals(g);setGoalsForm(g)
          localStorage.setItem('fitpro_food_goals',JSON.stringify(g))
        }
      })
  },[userId])

  useEffect(()=>{
    const handler=()=>{
      if(!userId){
        setFoodDiary(JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}'))
        return
      }
      supabase.from('food_diary').select('*').eq('user_id',userId).eq('date',foodDate).order('created_at')
        .then(({data})=>{
          const entries=(data||[]).map(r=>({id:r.id,name:r.name,kcal:String(r.kcal||0),p:String(r.p||0),c:String(r.c||0),f:String(r.f||0)}))
          setFoodDiary(d=>{
            const updated={...d,[foodDate]:entries}
            const all={...JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}'),[foodDate]:entries}
            localStorage.setItem('fitpro_food_diary',JSON.stringify(all))
            return updated
          })
        })
    }
    window.addEventListener('fitpro:diary-update',handler)
    return()=>window.removeEventListener('fitpro:diary-update',handler)
  },[userId,foodDate])
  const dayEntries=foodDiary[foodDate]||[]
  const dayTotal=dayEntries.reduce((acc,e)=>({kcal:acc.kcal+(+e.kcal||0),p:acc.p+(+e.p||0),c:acc.c+(+e.c||0),f:acc.f+(+e.f||0)}),{kcal:0,p:0,c:0,f:0})
  const addFood=async()=>{
    if(!foodForm.name.trim())return
    let entry={id:Date.now(),...foodForm}
    if(userId){
      const {data}=await supabase.from('food_diary').insert({
        user_id:userId,date:foodDate,name:foodForm.name,
        kcal:+foodForm.kcal||0,p:+foodForm.p||0,c:+foodForm.c||0,f:+foodForm.f||0,
      }).select().single()
      if(data)entry={...entry,id:data.id}
    }
    setFoodDiary(d=>{
      const updated={...d,[foodDate]:[...(d[foodDate]||[]),entry]}
      const all={...JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}'),[foodDate]:updated[foodDate]}
      localStorage.setItem('fitpro_food_diary',JSON.stringify(all))
      return updated
    })
    setFoodForm({name:'',kcal:'',p:'',c:'',f:''})
    setShowFoodForm(false)
  }
  const removeFood=async(id)=>{
    if(userId)await supabase.from('food_diary').delete().eq('id',id)
    setFoodDiary(d=>{
      const updated={...d,[foodDate]:(d[foodDate]||[]).filter(e=>e.id!==id)}
      const all={...JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}'),[foodDate]:updated[foodDate]}
      localStorage.setItem('fitpro_food_diary',JSON.stringify(all))
      return updated
    })
  }
  const startEditFood=(e)=>{setEditFoodForm({name:e.name,kcal:e.kcal||'',p:e.p||'',c:e.c||'',f:e.f||'',items:e.items||[]});setEditingFoodId(e.id)}
  const saveEditFood=async()=>{
    if(!editFoodForm.name.trim())return
    if(userId)await supabase.from('food_diary').update({
      name:editFoodForm.name,kcal:+editFoodForm.kcal||0,
      p:+editFoodForm.p||0,c:+editFoodForm.c||0,f:+editFoodForm.f||0,
    }).eq('id',editingFoodId)
    setFoodDiary(d=>{
      const updated={...d,[foodDate]:(d[foodDate]||[]).map(e=>e.id===editingFoodId?{...e,...editFoodForm}:e)}
      const all={...JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}'),[foodDate]:updated[foodDate]}
      localStorage.setItem('fitpro_food_diary',JSON.stringify(all))
      return updated
    })
    setEditingFoodId(null)
  }

  const BackBtn=({label})=>(
    <div style={{ background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 18px',display:'flex',alignItems:'center',gap:14,flexShrink:0,position:'sticky',top:0,zIndex:10 }}>
      <button onClick={()=>setSection(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset' }}>←</button>
      <span style={{ fontSize:17,fontWeight:700,color:'#111' }}>{label}</span>
    </div>
  )

  // ── СЕКЦИЯ: Общий тоннаж
  if(section==='tonnage'){
    const PERIOD_DAYS={'7d':7,'30d':30,'3m':90}
    const workoutTons=(customFrom||customTo)
      ?allWorkoutTons.filter(w=>{const t=new Date(w.date).getTime();const from=customFrom?new Date(customFrom).getTime():0;const to=customTo?new Date(customTo+'T23:59:59').getTime():Infinity;return t>=from&&t<=to})
      :period==='all'?allWorkoutTons
      :allWorkoutTons.filter(w=>new Date(w.date).getTime()>=Date.now()-PERIOD_DAYS[period]*86400000)
    const totalTonnage=workoutTons.reduce((s,w)=>s+w.ton,0)
    const chartMaxTon=workoutTons.length?Math.max(...workoutTons.map(w=>w.ton),1):1
    const CHART_BAR_H=120
    const selW=selectedTonBar!==null?workoutTons[selectedTonBar]:null
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:'#f3f4f6',zIndex:1000,display:'flex',flexDirection:'column' }}>
        <BackBtn label="Общий тоннаж" />
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          <Card style={{ marginBottom:16 }}>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11,fontWeight:500,color:'#9ca3af',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:4 }}>Общий тоннаж</div>
              <div style={{ fontSize:32,fontWeight:800,color:PUR,lineHeight:1 }}>{totalTonnage.toLocaleString('ru')} <span style={{ fontSize:18,fontWeight:600 }}>кг</span></div>
            </div>
            <div style={{ display:'flex',flexDirection:'column',alignItems:'center',gap:8,marginBottom:14 }}>
              <div style={{ display:'flex',gap:6 }}>
                {[{k:'7d',l:'7 дней'},{k:'30d',l:'30 дней'},{k:'all',l:'Всё'}].map(p=>(
                  <button key={p.k} onClick={()=>{setPeriod(p.k);setCustomFrom('');setCustomTo('');setSelectedTonBar(null)}}
                    style={{ fontSize:12,padding:'7px 16px',borderRadius:8,border:'none',cursor:'pointer',minHeight:'unset',
                      background:period===p.k&&!customFrom&&!customTo?PUR:'#f3f4f6',
                      color:period===p.k&&!customFrom&&!customTo?'#fff':'#6b7280',
                      fontWeight:period===p.k&&!customFrom&&!customTo?600:400 }}>
                    {p.l}
                  </button>
                ))}
              </div>
              <div style={{ display:'flex',flexDirection:isMobile?'column':'row',alignItems:isMobile?'stretch':'center',gap:8,width:isMobile?'100%':'auto' }}>
                <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                  <span style={{ fontSize:11,color:'#9ca3af',flexShrink:0 }}>с</span>
                  <input type="date" value={customFrom} onChange={e=>{setCustomFrom(e.target.value);setSelectedTonBar(null)}}
                    style={{ flex:1,fontSize:13,padding:'7px 9px',borderRadius:7,border:'1.5px solid #e5e7eb',outline:'none',color:'#111',background:'#fff',colorScheme:'light',minHeight:'unset' }}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                </div>
                <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                  <span style={{ fontSize:11,color:'#9ca3af',flexShrink:0 }}>по</span>
                  <input type="date" value={customTo} onChange={e=>{setCustomTo(e.target.value);setSelectedTonBar(null)}}
                    style={{ flex:1,fontSize:13,padding:'7px 9px',borderRadius:7,border:'1.5px solid #e5e7eb',outline:'none',color:'#111',background:'#fff',colorScheme:'light',minHeight:'unset' }}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                  {(customFrom||customTo)&&(
                    <button onClick={()=>{setCustomFrom('');setCustomTo('');setSelectedTonBar(null)}}
                      style={{ fontSize:13,padding:'6px 10px',borderRadius:6,border:'none',background:'#f3f4f6',color:'#9ca3af',cursor:'pointer',minHeight:'unset',flexShrink:0 }}>✕</button>
                  )}
                </div>
              </div>
            </div>
            {workoutTons.length===0?(
              <div style={{ textAlign:'center',color:'#c7cad1',fontSize:13,padding:'20px 0' }}>Завершите тренировку — она появится здесь</div>
            ):(
              <div>
                <div style={{ display:'flex',alignItems:'flex-end',gap:5,height:CHART_BAR_H }}>
                  {workoutTons.map((w,i)=>{
                    const bh=Math.max(10,Math.round((w.ton/chartMaxTon)*(CHART_BAR_H-22)))
                    const on=selectedTonBar===i
                    return(
                      <div key={i} onClick={()=>setSelectedTonBar(on?null:i)}
                        style={{ flex:1,display:'flex',flexDirection:'column',justifyContent:'flex-end',alignItems:'center',height:'100%',minWidth:0,cursor:'pointer' }}>
                        <div style={{ fontSize:11,fontWeight:on?700:600,color:on?PUR:`${PUR}99`,marginBottom:4,textAlign:'center',lineHeight:1,whiteSpace:'nowrap' }}>{w.ton}</div>
                        <div style={{ width:'68%',height:bh,background:on?PUR:`${PUR}55`,borderRadius:'3px 3px 0 0',transition:'background 0.12s' }} />
                      </div>
                    )
                  })}
                </div>
                <div style={{ borderTop:'2px solid #f3f4f6' }} />
                <div style={{ display:'flex',gap:5,paddingTop:5 }}>
                  {workoutTons.map((w,i)=>(
                    <div key={i} style={{ flex:1,textAlign:'center',fontSize:9,color:selectedTonBar===i?PUR:'#9ca3af',lineHeight:1.2,minWidth:0,overflow:'hidden' }}>{fmtD(w.date)}</div>
                  ))}
                </div>
                <div style={{ textAlign:'center',fontSize:11,color:'#c7cad1',marginTop:10 }}>Нажмите на столбик, чтобы увидеть подробную сводку</div>
              </div>
            )}
          </Card>
          {selW&&(
            <Card style={{ marginBottom:16,border:`1.5px solid ${PUR}33` }}>
              <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:14,fontWeight:600,color:'#111' }}>{fmtFull(selW.date)}</div>
                  <div style={{ fontSize:12,color:'#9ca3af',marginTop:2 }}>{selW.name}</div>
                </div>
                <div style={{ position:'relative' }}>
                  <button onClick={e=>{e.stopPropagation();setOpenSelWorkoutMenu(v=>!v)}}
                    style={{ width:30,height:30,borderRadius:8,border:'1px solid #e5e7eb',background:'#f9fafb',cursor:'pointer',fontSize:17,color:'#6b7280',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,letterSpacing:1,minHeight:'unset' }}>⋯</button>
                  {openSelWorkoutMenu&&(
                    <>
                      <div onClick={()=>setOpenSelWorkoutMenu(false)} style={{ position:'fixed',inset:0,zIndex:19 }} />
                      <div style={{ position:'absolute',top:34,right:0,background:'#fff',borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:180,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                        <button onClick={()=>{setOpenSelWorkoutMenu(false);onEditWorkout(workoutHistory[selW.histIdx],selW.histIdx)}}
                          style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:'1px solid #f3f4f6',background:'transparent',cursor:'pointer',textAlign:'left',color:'#111',fontSize:13 }}>✏️ Редактировать</button>
                        <button onClick={()=>{setOpenSelWorkoutMenu(false);if(window.confirm('Удалить тренировку?')){onDeleteWorkout(selW.histIdx);setSelIdx(null)}}}
                          style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12 }}>
                {[{label:'Тоннаж',value:`${selW.ton} кг`,accent:true},{label:'Упражнений',value:selW.exercises.length,accent:false},{label:'Подходов',value:selW.exercises.reduce((s,ex)=>s+(ex.sets||[]).filter(s=>s.kg||s.reps).length,0),accent:false}].map(c=>(
                  <div key={c.label} style={{ background:'#f9fafb',borderRadius:10,padding:'10px 12px' }}>
                    <div style={{ fontSize:10,color:'#9ca3af',marginBottom:4 }}>{c.label}</div>
                    <div style={{ fontSize:17,fontWeight:700,color:c.accent?PUR:'#111' }}>{c.value}</div>
                  </div>
                ))}
              </div>
              {selW.exercises.map((ex,ei)=>{
                const exTon=(ex.sets||[]).reduce((s,set)=>s+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),0)
                return(
                  <div key={ei} style={{ paddingTop:ei>0?10:0,borderTop:ei>0?'1px solid #f3f4f6':'' }}>
                    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5 }}>
                      <span style={{ fontSize:13,fontWeight:500,color:'#111' }}>{ex.n}</span>
                      {exTon>0&&<span style={{ fontSize:11,color:PUR,fontWeight:600 }}>{exTon} кг</span>}
                    </div>
                    <div style={{ display:'flex',gap:5,flexWrap:'wrap' }}>
                      {(ex.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                        <span key={si} style={{ fontSize:11,color:'#6b7280',background:'#f3f4f6',padding:'2px 8px',borderRadius:5 }}>
                          {si+1}. {s.kg||'—'} кг × {s.reps||'—'}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </Card>
          )}
        </div>
      </div>
    , document.body)
  }

  // ── СЕКЦИЯ: Прогресс по упражнениям
  if(section==='exercises'){
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:'#f3f4f6',zIndex:1000,display:'flex',flexDirection:'column' }}>
        <BackBtn label="Прогресс по упражнениям" />
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          <input value={exQuery} onChange={e=>setExQuery(e.target.value)} placeholder="Поиск упражнения..."
            style={{ width:'100%',padding:'10px 16px',fontSize:14,borderRadius:10,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',marginBottom:10,color:'#111',background:'#fff' }}
            onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
          {exerciseNames.length===0?(
            <div style={{ textAlign:'center',color:'#9ca3af',fontSize:13,marginTop:40 }}>Завершите тренировку с упражнениями, чтобы видеть аналитику</div>
          ):exerciseNames.filter(n=>n.toLowerCase().includes(exQuery.toLowerCase())).length===0?(
            <div style={{ textAlign:'center',color:'#9ca3af',fontSize:13,marginTop:40 }}>Упражнение не найдено</div>
          ):(
            exerciseNames.filter(n=>n.toLowerCase().includes(exQuery.toLowerCase())).map(name=>{
              const ex=exerciseMap[name]
              const records=[...ex.records].sort((a,b)=>new Date(a.date)-new Date(b.date))
              const best=Math.max(...ex.records.map(r=>r.maxKg))
              const growth=records.length>1?records[records.length-1].tonnage-records[0].tonnage:0
              const exMaxTon=Math.max(...records.map(r=>r.tonnage),1)
              const isActive=selectedEx===name
              const activeRec=isActive&&activeBar!==null?records[activeBar]:null
              return(
                <div key={name} style={{ marginBottom:8 }}>
                  <Card>
                    {(()=>{
                      const DOT_R=6
                      const CHART_H=72
                      const minTon=Math.min(...records.map(r=>r.tonnage))
                      const maxTon=Math.max(...records.map(r=>r.tonnage),1)
                      const range=maxTon-minTon||1
                      const dotY=ton=>CHART_H-DOT_R-Math.round(((ton-minTon)/range)*(CHART_H-DOT_R*2-16))
                      return(
                        <div>
                          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10 }}>
                            <div>
                              <div style={{ fontSize:14,fontWeight:600,color:'#111',marginBottom:2 }}>{name}</div>
                              <div style={{ fontSize:11,color:'#9ca3af' }}>
                                {ex.muscle?`${ex.muscle} · `:''}{records.length} {records.length===1?'тренировка':records.length<5?'тренировки':'тренировок'}
                                {growth>0&&<span style={{ color:'#22c55e',marginLeft:4 }}>+{growth.toFixed(0)} кг</span>}
                              </div>
                            </div>
                            <div style={{ textAlign:'right',flexShrink:0 }}>
                              <div style={{ fontSize:16,fontWeight:700,color:PUR }}>{best} кг</div>
                              <div style={{ fontSize:10,color:'#9ca3af' }}>макс. вес</div>
                            </div>
                          </div>
                          {/* SVG линейный график */}
                          <div style={{ overflowX:'auto',paddingBottom:2 }}>
                            <svg width={Math.max(records.length*52,200)} height={CHART_H+28} style={{ display:'block',overflow:'visible' }}>
                              {/* Линии между точками */}
                              {records.map((r,i)=>{
                                if(i===0)return null
                                const x1=(i-1)*52+26, y1=dotY(records[i-1].tonnage)
                                const x2=i*52+26,     y2=dotY(r.tonnage)
                                return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={`${PUR}55`} strokeWidth={2} />
                              })}
                              {/* Точки */}
                              {records.map((r,i)=>{
                                const cx=i*52+26, cy=dotY(r.tonnage)
                                const on=isActive&&activeBar===i
                                const fmtDate=new Date(r.date).toLocaleDateString('ru',{day:'numeric',month:'short'}).replace('.','')
                                return(
                                  <g key={i} onClick={()=>{setSelectedEx(name);setActiveBar(on?null:i)}} style={{ cursor:'pointer' }}>
                                    {/* Тоннаж над точкой */}
                                    <text x={cx} y={cy-10} textAnchor="middle" fontSize={9} fontWeight={on?700:500} fill={on?PUR:'#9ca3af'}>{r.tonnage}</text>
                                    {/* Внешний круг при активации */}
                                    {on&&<circle cx={cx} cy={cy} r={DOT_R+4} fill={`${PUR}22`} />}
                                    {/* Основная точка */}
                                    <circle cx={cx} cy={cy} r={DOT_R} fill={on?PUR:'#fff'} stroke={PUR} strokeWidth={2} />
                                    {/* Дата под точкой */}
                                    <text x={cx} y={CHART_H+14} textAnchor="middle" fontSize={8.5} fill={on?PUR:'#b0b4bb'}>{fmtDate}</text>
                                  </g>
                                )
                              })}
                            </svg>
                          </div>
                        </div>
                      )
                    })()}
                  </Card>
                  {activeRec&&(
                    <Card style={{ marginTop:4,border:`1.5px solid ${PUR}33` }}>
                      <div style={{ marginBottom:10 }}>
                        <div style={{ fontSize:14,fontWeight:600,color:'#111' }}>{fmtFull(activeRec.date)}</div>
                        {activeRec.workoutName&&<div style={{ fontSize:12,color:'#9ca3af',marginTop:2 }}>{activeRec.workoutName}</div>}
                      </div>
                      <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12 }}>
                        {[{label:'Тоннаж',value:`${activeRec.tonnage} кг`,accent:true},{label:'Макс. вес',value:`${activeRec.maxKg} кг`,accent:false},{label:'Подходов',value:(activeRec.sets||[]).filter(s=>s.kg||s.reps).length,accent:false}].map(c=>(
                          <div key={c.label} style={{ background:'#f9fafb',borderRadius:10,padding:'10px 12px' }}>
                            <div style={{ fontSize:10,color:'#9ca3af',marginBottom:4 }}>{c.label}</div>
                            <div style={{ fontSize:17,fontWeight:700,color:c.accent?PUR:'#111' }}>{c.value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display:'flex',flexDirection:'column',gap:5 }}>
                        {(activeRec.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                          <div key={si} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 12px',background:'#f9fafb',borderRadius:8 }}>
                            <div style={{ display:'flex',alignItems:'center',gap:12 }}>
                              <span style={{ fontSize:11,fontWeight:600,color:'#d1d5db',width:16,textAlign:'center' }}>{si+1}</span>
                              <span style={{ fontSize:14,fontWeight:600,color:'#111' }}>{parseFloat(s.kg)||0} кг</span>
                              <span style={{ fontSize:13,color:'#9ca3af' }}>× {parseInt(s.reps)||0} повт.</span>
                            </div>
                            <span style={{ fontSize:13,fontWeight:600,color:PUR }}>{(parseFloat(s.kg)||0)*(parseInt(s.reps)||0)} кг</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ position:'relative',marginTop:12,display:'inline-block' }}>
                        <button onClick={e=>{e.stopPropagation();setOpenActiveRecMenu(v=>!v)}}
                          style={{ fontSize:12,padding:'6px 16px',borderRadius:7,border:'1px solid #e5e7eb',background:'#f9fafb',cursor:'pointer',color:'#6b7280',fontWeight:500,letterSpacing:2 }}>⋯</button>
                        {openActiveRecMenu&&(
                          <>
                            <div onClick={()=>setOpenActiveRecMenu(false)} style={{ position:'fixed',inset:0,zIndex:19 }} />
                            <div style={{ position:'absolute',bottom:38,right:0,background:'#fff',borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:200,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                              <button onClick={()=>{setOpenActiveRecMenu(false);onEditWorkout(workoutHistory[activeRec.histIdx],activeRec.histIdx)}}
                                style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:'1px solid #f3f4f6',background:'transparent',cursor:'pointer',textAlign:'left',color:'#111',fontSize:13 }}>✏️ Редактировать</button>
                              <button onClick={()=>{setOpenActiveRecMenu(false);if(window.confirm('Удалить тренировку?')){onDeleteWorkout(activeRec.histIdx)}}}
                                style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                            </div>
                          </>
                        )}
                      </div>
                    </Card>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    , document.body)
  }

  // ── СЕКЦИЯ: Мои тренировки (журнал)
  if(section==='workouts'){
    const sorted=[...allWorkoutTons].reverse()
    const savePlanned=(pw)=>{const next=[...plannedWorkouts,pw];setPlannedWorkouts(next);localStorage.setItem('fitpro_planned',JSON.stringify(next))}
    const deletePlanned=(id)=>{const next=plannedWorkouts.filter(p=>p.id!==id);setPlannedWorkouts(next);localStorage.setItem('fitpro_planned',JSON.stringify(next))}
    const saveTemplate=(workout)=>{
      const tpl={id:Date.now(),name:workout.name,exercises:(workout.exercises||[]).map(ex=>({n:ex.n,m:ex.m,eq:ex.eq}))}
      const existing=JSON.parse(localStorage.getItem('fitpro_user_templates')||'[]')
      localStorage.setItem('fitpro_user_templates',JSON.stringify([...existing,tpl]))
      setTemplateMsg(`Шаблон «${workout.name}» сохранён`)
      setTimeout(()=>setTemplateMsg(''),2500)
    }
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:'#f3f4f6',zIndex:1000,display:'flex',flexDirection:'column' }}>
        {/* ─ Шапка с кнопкой + */}
        <div style={{ background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 18px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0,position:'sticky',top:0,zIndex:10 }}>
          <div style={{ display:'flex',alignItems:'center',gap:14 }}>
            <button onClick={()=>{setSection(null);setShowWorkoutMenu(false);setOpenCardMenu(null)}} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset' }}>←</button>
            <span style={{ fontSize:17,fontWeight:700,color:'#111' }}>Мои тренировки</span>
          </div>
          <div style={{ position:'relative' }}>
            <button onClick={()=>{setShowWorkoutMenu(v=>!v);setOpenCardMenu(null)}}
              style={{ width:36,height:36,borderRadius:10,background:PUR,border:'none',color:'#fff',fontSize:26,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,fontWeight:300 }}>+</button>
            {showWorkoutMenu&&(
              <>
                <div onClick={()=>setShowWorkoutMenu(false)} style={{ position:'fixed',inset:0,zIndex:10 }} />
                <div style={{ position:'absolute',top:42,right:0,background:'#fff',borderRadius:13,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:228,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                  {[
                    {icon:'📅',label:'Запланировать тренировку',sub:'Назначить дату'},
                    {icon:'▶️',label:'Начать тренировку',sub:'Запустить прямо сейчас',key:'start'},
                    {icon:'✅',label:'Добавить выполненную',sub:'Записать прошедшую',key:'done'},
                    {icon:'📋',label:'Шаблон тренировки',sub:'Выбрать из готовых',key:'template'},
                  ].map((item,idx)=>(
                    <button key={idx} onClick={()=>{
                      setShowWorkoutMenu(false)
                      if(item.key){if(onWorkoutAction)onWorkoutAction(item.key)}
                      else{setShowScheduleForm(true)}
                    }} style={{ display:'flex',alignItems:'center',gap:11,width:'100%',padding:'11px 15px',border:'none',borderTop:idx>0?'1px solid #f3f4f6':'none',background:'transparent',cursor:'pointer',textAlign:'left' }}>
                      <span style={{ fontSize:19,flexShrink:0 }}>{item.icon}</span>
                      <div>
                        <div style={{ fontSize:13,fontWeight:500,color:'#111' }}>{item.label}</div>
                        <div style={{ fontSize:11,color:'#9ca3af' }}>{item.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          {templateMsg&&<div style={{ background:'#22c55e',color:'#fff',borderRadius:9,padding:'8px 14px',fontSize:13,marginBottom:12,textAlign:'center' }}>{templateMsg}</div>}

          {/* Форма планирования */}
          {showScheduleForm&&(
            <div style={{ background:'#fff',borderRadius:12,padding:'16px',marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize:14,fontWeight:600,color:'#111',marginBottom:10 }}>📅 Запланировать тренировку</div>
              <input value={scheduleForm.name} onChange={e=>setScheduleForm(f=>({...f,name:e.target.value}))} placeholder="Название тренировки"
                style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:8,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',color:'#111',marginBottom:8 }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
              <input type="date" value={scheduleForm.date} onChange={e=>setScheduleForm(f=>({...f,date:e.target.value}))}
                style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:8,border:'1.5px solid #e5e7eb',boxSizing:'border-box',outline:'none',color:'#111',background:'#fff',colorScheme:'light',marginBottom:12 }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
              <div style={{ display:'flex',gap:8 }}>
                <button onClick={()=>{setShowScheduleForm(false);setScheduleForm({name:'',date:''})}}
                  style={{ flex:1,padding:'9px',borderRadius:8,border:'1px solid #e5e7eb',background:'transparent',color:'#6b7280',cursor:'pointer',fontSize:13 }}>Отмена</button>
                <button onClick={()=>{
                  if(!scheduleForm.name.trim()||!scheduleForm.date)return
                  savePlanned({id:Date.now(),name:scheduleForm.name.trim(),date:scheduleForm.date})
                  setShowScheduleForm(false);setScheduleForm({name:'',date:''})
                }} style={{ flex:1,padding:'9px',borderRadius:8,border:'none',background:PUR,color:'#fff',cursor:'pointer',fontSize:13,fontWeight:500 }}>Сохранить</button>
              </div>
            </div>
          )}

          {/* Запланированные */}
          {[...plannedWorkouts].sort((a,b)=>new Date(a.date)-new Date(b.date)).map(pw=>(
            <div key={pw.id} style={{ background:'#fff',borderRadius:12,padding:'12px 14px',marginBottom:8,border:`1.5px dashed ${PUR}55`,display:'flex',justifyContent:'space-between',alignItems:'center' }}>
              <div>
                <div style={{ fontSize:13,fontWeight:500,color:'#111' }}>{pw.name}</div>
                <div style={{ fontSize:11,color:PUR,marginTop:2 }}>📅 Запланировано · {fmtFull(pw.date)}</div>
              </div>
              <div style={{ display:'flex',gap:8,alignItems:'center' }}>
                <button onClick={()=>{if(onWorkoutAction)onWorkoutAction('start')}}
                  style={{ fontSize:11,padding:'5px 10px',borderRadius:7,border:`1px solid ${PUR}`,background:'#EEEDFE',color:PUR,cursor:'pointer',fontWeight:500 }}>▶ Начать</button>
                <button onClick={()=>deletePlanned(pw.id)}
                  style={{ fontSize:14,padding:'4px 9px',borderRadius:7,border:'1px solid #e5e7eb',background:'transparent',color:'#9ca3af',cursor:'pointer',lineHeight:1 }}>✕</button>
              </div>
            </div>
          ))}

          {sorted.length===0&&plannedWorkouts.length===0?(
            <div style={{ textAlign:'center',color:'#9ca3af',fontSize:13,marginTop:60 }}>
              <div style={{ fontSize:40,marginBottom:12 }}>🏋️</div>
              Нажмите «+» чтобы добавить тренировку
            </div>
          ):sorted.map((w,i)=>(
            <div key={i} style={{ marginBottom:8,position:'relative' }}>
              {openCardMenu===i&&<div onClick={()=>setOpenCardMenu(null)} style={{ position:'fixed',inset:0,zIndex:10 }} />}
              <div style={{ background:'#fff',borderRadius:13,boxShadow:'0 1px 4px rgba(0,0,0,0.07)',padding:'14px 16px',cursor:'pointer',border:selIdx===i?`1.5px solid ${PUR}33`:'1.5px solid transparent' }}
                onClick={()=>{setSelIdx(selIdx===i?null:i);setOpenCardMenu(null)}}>
                <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start' }}>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:14,fontWeight:600,color:'#111' }}>{w.name}</div>
                    <div style={{ fontSize:11,color:'#9ca3af',marginTop:2 }}>{fmtFull(w.date)}</div>
                  </div>
                  <div style={{ display:'flex',alignItems:'flex-start',gap:8,flexShrink:0 }}>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:16,fontWeight:700,color:PUR }}>{w.ton} кг</div>
                      <div style={{ fontSize:10,color:'#9ca3af' }}>тоннаж</div>
                    </div>
                    {/* Три точки */}
                    <div style={{ position:'relative' }}>
                      <button onClick={e=>{e.stopPropagation();setOpenCardMenu(openCardMenu===i?null:i);setShowWorkoutMenu(false)}}
                        style={{ width:28,height:28,borderRadius:7,border:'1px solid #e5e7eb',background:'#f9fafb',cursor:'pointer',fontSize:17,color:'#6b7280',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,letterSpacing:1 }}>⋯</button>
                      {openCardMenu===i&&(
                        <div onClick={e=>e.stopPropagation()} style={{ position:'absolute',top:34,right:0,background:'#fff',borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:200,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                          {[
                            {icon:'✏️',label:'Редактировать тренировку'},
                            {icon:'📋',label:'Копировать тренировку'},
                            {icon:'📁',label:'Сделать шаблон'},
                            {icon:'🗑',label:'Удалить тренировку',danger:true},
                          ].map((item,idx)=>(
                            <button key={idx} onClick={()=>{
                              setOpenCardMenu(null)
                              if(item.label==='Редактировать тренировку'){onEditWorkout(workoutHistory[w.histIdx],w.histIdx)}
                              else if(item.label==='Копировать тренировку'){if(onCopyWorkout)onCopyWorkout(workoutHistory[w.histIdx])}
                              else if(item.label==='Сделать шаблон'){saveTemplate(workoutHistory[w.histIdx])}
                              else if(item.label==='Удалить тренировку'){
                                if(window.confirm(`Удалить тренировку «${w.name}»?`)){if(onDeleteWorkout)onDeleteWorkout(w.histIdx);setSelIdx(null)}
                              }
                            }} style={{ display:'flex',alignItems:'center',gap:10,width:'100%',padding:'11px 15px',border:'none',borderTop:idx>0?'1px solid #f3f4f6':'none',background:'transparent',cursor:'pointer',textAlign:'left',color:item.danger?'#ef4444':'#111',fontSize:13 }}>
                              <span>{item.icon}</span>{item.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display:'flex',gap:12,marginTop:8 }}>
                  <span style={{ fontSize:11,color:'#6b7280' }}>💪 {w.exercises.length} упр.</span>
                  <span style={{ fontSize:11,color:'#6b7280' }}>📋 {w.exercises.reduce((s,ex)=>s+(ex.sets||[]).filter(s=>s.kg||s.reps).length,0)} подх.</span>
                </div>
              </div>
              {selIdx===i&&(
                <Card style={{ marginTop:4,border:`1.5px solid ${PUR}22` }}>
                  {w.exercises.map((ex,ei)=>{
                    const exTon=(ex.sets||[]).reduce((s,set)=>s+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),0)
                    return(
                      <div key={ei} style={{ paddingTop:ei>0?10:0,borderTop:ei>0?'1px solid #f3f4f6':'' }}>
                        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4 }}>
                          <span style={{ fontSize:13,fontWeight:500,color:'#111' }}>{ex.n}</span>
                          {exTon>0&&<span style={{ fontSize:11,color:PUR,fontWeight:600 }}>{exTon} кг</span>}
                        </div>
                        <div style={{ display:'flex',gap:5,flexWrap:'wrap' }}>
                          {(ex.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                            <span key={si} style={{ fontSize:11,color:'#6b7280',background:'#f3f4f6',padding:'2px 8px',borderRadius:5 }}>
                              {si+1}. {s.kg||'—'} кг × {s.reps||'—'}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </Card>
              )}
            </div>
          ))}
        </div>
      </div>
    , document.body)
  }

  // ── СЕКЦИЯ: Питание (дневник)
  if(section==='food'){
    const selDate=new Date(foodDate+'T00:00:00')
    const dow=selDate.getDay()
    const weekStart=new Date(selDate); weekStart.setDate(selDate.getDate()-(dow===0?6:dow-1))
    const weekDays=Array.from({length:7},(_,i)=>{
      const d=new Date(weekStart); d.setDate(weekStart.getDate()+i)
      const iso=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const entries=foodDiary[iso]||[]
      const tot=entries.reduce((a,e)=>({kcal:a.kcal+(+e.kcal||0),p:a.p+(+e.p||0),c:a.c+(+e.c||0),f:a.f+(+e.f||0)}),{kcal:0,p:0,c:0,f:0})
      return {iso,d,entries,tot}
    })
    const weekTotal=weekDays.reduce((a,d)=>({kcal:a.kcal+d.tot.kcal,p:a.p+d.tot.p,c:a.c+d.tot.c,f:a.f+d.tot.f}),{kcal:0,p:0,c:0,f:0})
    const weekAvg={kcal:Math.round(weekTotal.kcal/7),p:Math.round(weekTotal.p/7),c:Math.round(weekTotal.c/7),f:Math.round(weekTotal.f/7)}
    const DAY_SHORT=['Пн','Вт','Ср','Чт','Пт','Сб','Вс']
    const weekKcalMax=Math.max(...weekDays.map(d=>d.tot.kcal),foodGoals.kcal||1,1)
    const rem=(k)=>Math.max(0,foodGoals[k]-dayTotal[k])
    const over=(k)=>Math.max(0,dayTotal[k]-foodGoals[k])
    const pct=(k)=>foodGoals[k]?Math.min(100,Math.round((dayTotal[k]/foodGoals[k])*100)):0
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:'#f3f4f6',zIndex:1000,display:'flex',flexDirection:'column' }}>
        {/* Шапка */}
        <div style={{ background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 16px',display:'flex',alignItems:'center',gap:10,flexShrink:0 }}>
          <button onClick={()=>setSection(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset' }}>←</button>
          <span style={{ fontSize:17,fontWeight:700,color:'#111',flex:1 }}>Питание</span>
          <button onClick={()=>{setGoalsForm(foodGoals);setShowGoals(g=>!g)}}
            style={{ background:showGoals?PUR:'#f3f4f6',border:'none',borderRadius:9,padding:'7px 13px',fontSize:12,fontWeight:600,color:showGoals?'#fff':'#6b7280',cursor:'pointer',minHeight:'unset' }}>
            ⚙️ Норма
          </button>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>

          {/* Плашка AI диетолога */}
          {onOpenAI&&(
            <div onClick={()=>onOpenAI('nutrition')} style={{ display:'flex',alignItems:'center',gap:12,background:'linear-gradient(135deg,#1D9E7518,#1D9E7508)',border:'1.5px solid #1D9E7544',borderRadius:14,padding:'12px 16px',marginBottom:14,cursor:'pointer' }}>
              <div style={{ width:38,height:38,borderRadius:'50%',background:'linear-gradient(135deg,#1D9E75,#157a5b)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0 }}>🤖</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13,fontWeight:700,color:'#1D9E75' }}>Спросить AI диетолога</div>
                <div style={{ fontSize:11,color:'#9ca3af',marginTop:1 }}>Знает ваш план и остаток калорий</div>
              </div>
              <span style={{ fontSize:18,color:'#1D9E75' }}>›</span>
            </div>
          )}

          {/* Настройка норм */}
          {showGoals&&(
            <Card style={{ marginBottom:14,border:`1.5px solid ${PUR}33` }}>
              <div style={{ fontSize:13,fontWeight:700,color:'#111',marginBottom:10 }}>Дневная норма</div>
              <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:12 }}>
                {[['ккал','kcal',PUR],['Белки г','p',TEA],['Углев. г','c',BLU],['Жиры г','f',COR]].map(([pl,k,c])=>(
                  <div key={k}>
                    <div style={{ fontSize:9,color:'#9ca3af',marginBottom:3,textAlign:'center' }}>{pl}</div>
                    <input type="number" value={goalsForm[k]} onChange={e=>setGoalsForm(f=>({...f,[k]:+e.target.value||0}))}
                      style={{ width:'100%',padding:'8px 4px',fontSize:14,fontWeight:700,borderRadius:8,border:`1.5px solid ${c}55`,outline:'none',boxSizing:'border-box',color:c,background:'#fff',textAlign:'center' }}
                      onFocus={e=>e.target.style.borderColor=c} onBlur={e=>e.target.style.borderColor=`${c}55`} />
                  </div>
                ))}
              </div>
              <button onClick={async()=>{
                setFoodGoals(goalsForm);setShowGoals(false)
                localStorage.setItem('fitpro_food_goals',JSON.stringify(goalsForm))
                if(userId)await supabase.from('food_goals').upsert({user_id:userId,...goalsForm,updated_at:new Date().toISOString()})
              }}
                style={{ width:'100%',padding:'10px',borderRadius:9,border:'none',background:PUR,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>
                Сохранить
              </button>
            </Card>
          )}

          {/* Вкладки + иконка календаря */}
          <div style={{ display:'flex',gap:6,marginBottom:14,alignItems:'stretch' }}>
            {[['day','День'],['week','Неделя']].map(([k,l])=>(
              <button key={k} onClick={()=>setFoodView(k)}
                style={{ flex:1,padding:'9px',borderRadius:10,border:'none',cursor:'pointer',fontSize:13,fontWeight:600,minHeight:'unset',
                  background:foodView===k?PUR:'#e5e7eb',color:foodView===k?'#fff':'#6b7280' }}>
                {l}
              </button>
            ))}
            <button onClick={()=>setShowCalPicker(v=>!v)}
              style={{ width:42,borderRadius:10,border:`1.5px solid ${showCalPicker?PUR:'#e5e7eb'}`,background:showCalPicker?`${PUR}15`:'#fff',cursor:'pointer',fontSize:18,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,minHeight:'unset',color:showCalPicker?PUR:'#6b7280' }}>
              📅
            </button>
          </div>

          {/* Попап-календарь */}
          {showCalPicker&&(()=>{
            const{y,m}=calPickerMonth
            const first=new Date(y,m,1)
            const startDow=(first.getDay()+6)%7 // Пн=0
            const daysInMonth=new Date(y,m+1,0).getDate()
            const MONTH_RU=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
            const DAY_HEADS=['Пн','Вт','Ср','Чт','Пт','Сб','Вс']
            const todayISO=(()=>{const t=new Date();return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`})()
            const cells=[]
            for(let i=0;i<startDow;i++)cells.push(null)
            for(let d=1;d<=daysInMonth;d++)cells.push(d)
            while(cells.length%7!==0)cells.push(null)
            return(
              <div style={{ background:'#fff',borderRadius:16,boxShadow:'0 4px 24px rgba(0,0,0,0.10)',border:'1px solid #e5e7eb',padding:'16px',marginBottom:14 }}>
                {/* Навигация месяца */}
                <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14 }}>
                  <button onClick={()=>setCalPickerMonth(({y,m})=>m===0?{y:y-1,m:11}:{y,m:m-1})}
                    style={{ background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#6b7280',minHeight:'unset',padding:'0 6px' }}>‹</button>
                  <span style={{ fontSize:15,fontWeight:700,color:'#111' }}>{MONTH_RU[m]} {y}</span>
                  <button onClick={()=>setCalPickerMonth(({y,m})=>m===11?{y:y+1,m:0}:{y,m:m+1})}
                    style={{ background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#6b7280',minHeight:'unset',padding:'0 6px' }}>›</button>
                </div>
                {/* Заголовки дней */}
                <div style={{ display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,marginBottom:4 }}>
                  {DAY_HEADS.map(h=>(
                    <div key={h} style={{ textAlign:'center',fontSize:10,fontWeight:600,color:'#b0b7c3',padding:'2px 0' }}>{h}</div>
                  ))}
                </div>
                {/* Сетка дней */}
                <div style={{ display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2 }}>
                  {cells.map((d,ci)=>{
                    if(!d)return <div key={ci} />
                    const iso=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
                    const entries=foodDiary[iso]||[]
                    const kcal=entries.reduce((s,e)=>s+(+e.kcal||0),0)
                    const hasData=kcal>0
                    const isSel=iso===foodDate
                    const isToday=iso===todayISO
                    return(
                      <div key={ci} onClick={()=>{setFoodDate(iso);setFoodView('day');setShowCalPicker(false)}}
                        style={{ display:'flex',flexDirection:'column',alignItems:'center',cursor:'pointer',borderRadius:10,padding:'5px 2px',
                          background:isSel?PUR:isToday?`${PUR}10`:'transparent',
                          border:isToday&&!isSel?`1px solid ${PUR}40`:'1px solid transparent' }}>
                        <span style={{ fontSize:13,fontWeight:isSel||isToday?700:400,color:isSel?'#fff':isToday?PUR:'#111',lineHeight:1.4 }}>{d}</span>
                        {hasData&&(
                          <span style={{ fontSize:9,fontWeight:600,color:isSel?'rgba(255,255,255,0.85)':PUR,lineHeight:1.2,marginTop:1,textAlign:'center' }}>
                            {kcal}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* ДЕНЬ */}
          {foodView==='day'&&(<>
            <Card style={{ marginBottom:14 }}>
              <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10 }}>
                <span style={{ fontSize:13,fontWeight:700,color:'#111' }}>Итого за день</span>
                <span style={{ fontSize:11,color:'#9ca3af' }}>{selDate.toLocaleDateString('ru',{day:'numeric',month:'short'})}</span>
              </div>
              <div style={{ display:'flex',alignItems:'flex-end',gap:6,marginBottom:10 }}>
                <div style={{ fontSize:36,fontWeight:800,color:PUR,lineHeight:1 }}>{dayTotal.kcal}</div>
                <div style={{ fontSize:14,color:'#9ca3af',paddingBottom:4 }}>/ {foodGoals.kcal} ккал</div>
                {over('kcal')>0&&<div style={{ fontSize:11,color:COR,fontWeight:600,paddingBottom:4 }}>+{over('kcal')} перебор</div>}
                {dayTotal.kcal===0&&<div style={{ fontSize:11,color:'#9ca3af',paddingBottom:4 }}>добавьте продукты</div>}
              </div>
              <div style={{ height:10,background:'#f3f4f6',borderRadius:5,overflow:'hidden',marginBottom:14 }}>
                <div style={{ height:'100%',width:`${pct('kcal')}%`,background:over('kcal')>0?COR:PUR,borderRadius:5,transition:'width 0.3s' }} />
              </div>
              {[['Белки','p',TEA],['Углеводы','c',BLU],['Жиры','f',COR]].map(([l,k,c])=>{
                const p2=pct(k),r=rem(k),ov=over(k)
                return(
                  <div key={k} style={{ marginBottom:10 }}>
                    <div style={{ display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:4,gap:4,flexWrap:'wrap' }}>
                      <span style={{ color:'#6b7280',fontWeight:600 }}>{l}</span>
                      <span style={{ fontWeight:700,color:c }}>{dayTotal[k]} г</span>
                      <span style={{ flex:1 }} />
                      {ov>0
                        ?<span style={{ fontSize:11,color:COR }}>+{ov} г перебор</span>
                        :<span style={{ fontSize:11,color:'#9ca3af' }}>осталось {r} г</span>}
                      <span style={{ fontSize:11,color:'#c7cad1' }}>/ {foodGoals[k]} г</span>
                    </div>
                    <div style={{ height:7,background:'#f3f4f6',borderRadius:4,overflow:'hidden' }}>
                      <div style={{ height:'100%',width:`${p2}%`,background:ov>0?COR:c,borderRadius:4,transition:'width 0.3s' }} />
                    </div>
                  </div>
                )
              })}
            </Card>
            {dayEntries.length>0&&(
              <div style={{ marginBottom:12 }}>
                {dayEntries.map(e=>(
                  <div key={e.id} style={{ background:'#fff',borderRadius:11,boxShadow:'0 1px 4px rgba(0,0,0,0.06)',marginBottom:8,position:'relative',zIndex:openFoodMenu===e.id?50:'auto' }}>
                    {editingFoodId===e.id?(
                      <div style={{ padding:'12px 14px' }}>
                        <input value={editFoodForm.name} onChange={ev=>setEditFoodForm(f=>({...f,name:ev.target.value}))}
                          style={{ width:'100%',padding:'8px 10px',fontSize:14,borderRadius:8,border:'1.5px solid #e5e7eb',outline:'none',boxSizing:'border-box',color:'#111',marginBottom:8 }}
                          onFocus={ev=>ev.target.style.borderColor=PUR} onBlur={ev=>ev.target.style.borderColor='#e5e7eb'} />
                        {/* items list editable */}
                        {editFoodForm.items.length>0&&(
                          <div style={{ marginBottom:8 }}>
                            {editFoodForm.items.map((item,ii)=>(
                              <div key={ii} style={{ display:'flex',gap:6,marginBottom:4 }}>
                                <input value={item} onChange={ev=>setEditFoodForm(f=>({...f,items:f.items.map((it,idx)=>idx===ii?ev.target.value:it)}))}
                                  style={{ flex:1,padding:'6px 10px',fontSize:12,borderRadius:7,border:'1px solid #e5e7eb',outline:'none',color:'#374151' }}
                                  onFocus={ev=>ev.target.style.borderColor=PUR} onBlur={ev=>ev.target.style.borderColor='#e5e7eb'} />
                                <button onClick={()=>setEditFoodForm(f=>({...f,items:f.items.filter((_,idx)=>idx!==ii)}))}
                                  style={{ background:'none',border:'none',fontSize:16,cursor:'pointer',color:'#d1d5db',padding:'4px',minHeight:'unset' }}>✕</button>
                              </div>
                            ))}
                            <button onClick={()=>setEditFoodForm(f=>({...f,items:[...f.items,'']}))}
                              style={{ fontSize:12,color:PUR,border:'none',background:'none',cursor:'pointer',padding:'4px 0',minHeight:'unset' }}>+ добавить позицию</button>
                          </div>
                        )}
                        <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:10 }}>
                          {[['ккал','kcal',PUR],['Б','p',TEA],['У','c',BLU],['Ж','f',COR]].map(([pl,k,c])=>(
                            <input key={k} type="number" placeholder={pl} value={editFoodForm[k]} onChange={ev=>setEditFoodForm(f=>({...f,[k]:ev.target.value}))}
                              style={{ width:'100%',padding:'7px 6px',fontSize:12,borderRadius:7,border:`1.5px solid ${c}44`,outline:'none',boxSizing:'border-box',color:'#111',textAlign:'center' }}
                              onFocus={ev=>ev.target.style.borderColor=c} onBlur={ev=>ev.target.style.borderColor=`${c}44`} />
                          ))}
                        </div>
                        <div style={{ display:'flex',gap:8 }}>
                          <button onClick={saveEditFood} style={{ flex:1,padding:'9px',borderRadius:8,border:'none',background:PUR,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>Сохранить</button>
                          <button onClick={()=>setEditingFoodId(null)} style={{ padding:'9px 14px',borderRadius:8,border:'none',background:'#f3f4f6',color:'#6b7280',fontSize:13,cursor:'pointer',minHeight:'unset' }}>Отмена</button>
                          <button onClick={()=>{removeFood(e.id);setEditingFoodId(null)}} style={{ padding:'9px 14px',borderRadius:8,border:'none',background:'#fff5f5',color:'#ef4444',fontSize:13,cursor:'pointer',minHeight:'unset' }}>Удалить</button>
                        </div>
                      </div>
                    ):(
                      <div style={{ padding:'12px 14px' }}>
                        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start' }}>
                          <div style={{ flex:1,minWidth:0 }}>
                            <div style={{ fontSize:14,fontWeight:600,color:'#111',marginBottom:2 }}>{e.name}</div>
                            {e.items&&e.items.length>0&&(
                              <div style={{ marginBottom:6 }}>
                                {e.items.map((item,ii)=>(
                                  <div key={ii} style={{ fontSize:12,color:'#374151',lineHeight:1.5,paddingLeft:8,borderLeft:'2px solid #f3f4f6',marginBottom:1 }}>• {item}</div>
                                ))}
                              </div>
                            )}
                            <div style={{ fontSize:11,color:'#9ca3af',display:'flex',gap:8,flexWrap:'wrap' }}>
                              {e.kcal&&<span style={{ color:PUR,fontWeight:600 }}>{e.kcal} ккал</span>}
                              {e.p&&<span>Б: {e.p}г</span>}
                              {e.c&&<span>У: {e.c}г</span>}
                              {e.f&&<span>Ж: {e.f}г</span>}
                            </div>
                          </div>
                          <div style={{ position:'relative',flexShrink:0 }}>
                            <button onClick={ev=>{ev.stopPropagation();setOpenFoodMenu(openFoodMenu===e.id?null:e.id);setEditingFoodId(null)}}
                              style={{ background:'none',border:'1px solid #e5e7eb',borderRadius:7,fontSize:15,cursor:'pointer',color:'#9ca3af',padding:'2px 7px',minHeight:'unset',lineHeight:1.4,letterSpacing:1 }}>⋯</button>
                            {openFoodMenu===e.id&&(
                              <>
                                <div onClick={()=>setOpenFoodMenu(null)} style={{ position:'fixed',inset:0,zIndex:49 }} />
                                <div onClick={ev=>ev.stopPropagation()} style={{ position:'absolute',top:30,right:0,background:'#fff',borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:51,minWidth:160,overflow:'hidden',border:'1px solid #f0f0f0' }}>
                                  <button onClick={()=>{setOpenFoodMenu(null);startEditFood(e)}} style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:'1px solid #f3f4f6',background:'transparent',cursor:'pointer',textAlign:'left',color:'#111',fontSize:13 }}>✏️ Редактировать</button>
                                  <button onClick={()=>{setOpenFoodMenu(null);removeFood(e.id)}} style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {showFoodForm?(
              <Card style={{ marginBottom:12 }}>
                <div style={{ fontSize:13,fontWeight:700,color:'#111',marginBottom:10 }}>Добавить продукт</div>
                <input placeholder="Название *" value={foodForm.name} onChange={e=>setFoodForm(f=>({...f,name:e.target.value}))}
                  style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:8,border:'1.5px solid #e5e7eb',outline:'none',boxSizing:'border-box',marginBottom:8,color:'#111',background:'#fff' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:12 }}>
                  {[['ккал','kcal',PUR],['Б (г)','p',TEA],['У (г)','c',BLU],['Ж (г)','f',COR]].map(([pl,k,c])=>(
                    <input key={k} type="number" placeholder={pl} value={foodForm[k]} onChange={e=>setFoodForm(f=>({...f,[k]:e.target.value}))}
                      style={{ width:'100%',padding:'9px 8px',fontSize:13,borderRadius:8,border:`1.5px solid ${c}44`,outline:'none',boxSizing:'border-box',color:'#111',background:'#fff',textAlign:'center' }}
                      onFocus={e=>e.target.style.borderColor=c} onBlur={e=>e.target.style.borderColor=`${c}44`} />
                  ))}
                </div>
                <div style={{ display:'flex',gap:8 }}>
                  <button onClick={addFood} style={{ flex:1,padding:'10px',borderRadius:9,border:'none',background:PUR,color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>Добавить</button>
                  <button onClick={()=>setShowFoodForm(false)} style={{ padding:'10px 16px',borderRadius:9,border:'none',background:'#f3f4f6',color:'#6b7280',fontSize:13,cursor:'pointer',minHeight:'unset' }}>Отмена</button>
                </div>
              </Card>
            ):(
              <button onClick={()=>setShowFoodForm(true)}
                style={{ width:'100%',padding:'13px',borderRadius:12,border:`2px dashed ${PUR}55`,background:'transparent',color:PUR,fontSize:14,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>
                + Добавить продукт
              </button>
            )}
          </>)}

          {/* НЕДЕЛЯ */}
          {foodView==='week'&&(<>
            <Card style={{ marginBottom:14 }}>
              <div style={{ fontSize:13,fontWeight:700,color:'#111',marginBottom:4 }}>Сводка за неделю</div>
              <div style={{ fontSize:11,color:'#9ca3af',marginBottom:12 }}>
                {weekStart.toLocaleDateString('ru',{day:'numeric',month:'short'})} — {weekDays[6].d.toLocaleDateString('ru',{day:'numeric',month:'short',year:'numeric'})}
              </div>
              <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14 }}>
                {[['🔥',weekTotal.kcal,'ккал',PUR],['🥩',weekTotal.p+'г','белки',TEA],['🍚',weekTotal.c+'г','углев.',BLU],['🥑',weekTotal.f+'г','жиры',COR]].map(([ic,v,l,c])=>(
                  <div key={l} style={{ background:'#f9fafb',borderRadius:10,padding:'8px 4px',textAlign:'center' }}>
                    <div style={{ fontSize:12 }}>{ic}</div>
                    <div style={{ fontSize:13,fontWeight:700,color:c }}>{v}</div>
                    <div style={{ fontSize:9,color:'#9ca3af' }}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{ background:'#f9fafb',borderRadius:10,padding:'10px 12px',marginBottom:14 }}>
                <div style={{ fontSize:11,color:'#9ca3af',marginBottom:4 }}>Среднее в день</div>
                <div style={{ display:'flex',gap:10,flexWrap:'wrap',marginBottom:4 }}>
                  <span style={{ fontSize:14,fontWeight:700,color:PUR }}>{weekAvg.kcal} ккал</span>
                  <span style={{ fontSize:12,color:TEA }}>Б {weekAvg.p}г</span>
                  <span style={{ fontSize:12,color:BLU }}>У {weekAvg.c}г</span>
                  <span style={{ fontSize:12,color:COR }}>Ж {weekAvg.f}г</span>
                </div>
                {foodGoals.kcal>0&&(
                  <div style={{ fontSize:12,fontWeight:600 }}>
                    {weekAvg.kcal>=foodGoals.kcal
                      ?<span style={{ color:COR }}>+{weekAvg.kcal-foodGoals.kcal} ккал/день сверх нормы</span>
                      :<span style={{ color:TEA }}>−{foodGoals.kcal-weekAvg.kcal} ккал/день до нормы</span>}
                  </div>
                )}
              </div>
              <div style={{ fontSize:11,color:'#9ca3af',marginBottom:8 }}>Калории по дням</div>
              <div style={{ display:'flex',alignItems:'flex-end',gap:3,height:90 }}>
                {weekDays.map((d,i)=>{
                  const bh=Math.max(4,Math.round((d.tot.kcal/weekKcalMax)*74))
                  const isSel=d.iso===foodDate
                  const goalLine=foodGoals.kcal?Math.round((foodGoals.kcal/weekKcalMax)*74):0
                  return(
                    <div key={i} onClick={()=>{setFoodDate(d.iso);setFoodView('day')}}
                      style={{ flex:1,display:'flex',flexDirection:'column',alignItems:'center',cursor:'pointer',height:'100%',justifyContent:'flex-end',position:'relative' }}>
                      {foodGoals.kcal>0&&<div style={{ position:'absolute',bottom:goalLine+14,left:0,right:0,height:1,background:`${COR}66` }} />}
                      <div style={{ fontSize:9,color:isSel?PUR:'#c7cad1',marginBottom:2,fontWeight:isSel?700:400 }}>{d.tot.kcal||''}</div>
                      <div style={{ width:'80%',height:bh,background:isSel?PUR:d.tot.kcal>foodGoals.kcal&&foodGoals.kcal>0?`${COR}88`:`${PUR}44`,borderRadius:'3px 3px 0 0' }} />
                      <div style={{ fontSize:9,color:isSel?PUR:'#9ca3af',marginTop:4,fontWeight:isSel?700:400 }}>{DAY_SHORT[i]}</div>
                    </div>
                  )
                })}
              </div>
            </Card>
            <Card>
              <div style={{ fontSize:13,fontWeight:700,color:'#111',marginBottom:10 }}>По дням</div>
              {weekDays.map((d,i)=>(
                <div key={i} onClick={()=>{setFoodDate(d.iso);setFoodView('day')}}
                  style={{ display:'flex',alignItems:'center',gap:10,padding:'9px 0',borderBottom:i<6?'1px solid #f3f4f6':'',cursor:'pointer' }}>
                  <div style={{ width:36,textAlign:'center',flexShrink:0 }}>
                    <div style={{ fontSize:10,color:d.iso===foodDate?PUR:'#9ca3af',fontWeight:d.iso===foodDate?700:400 }}>{DAY_SHORT[i]}</div>
                    <div style={{ fontSize:15,fontWeight:700,color:d.iso===foodDate?PUR:'#111' }}>{d.d.getDate()}</div>
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    {d.tot.kcal===0?(
                      <div style={{ fontSize:11,color:'#c7cad1' }}>Нет записей</div>
                    ):(
                      <div style={{ display:'flex',gap:8,flexWrap:'wrap' }}>
                        <span style={{ fontSize:13,fontWeight:700,color:PUR }}>{d.tot.kcal} ккал</span>
                        <span style={{ fontSize:11,color:TEA }}>Б{d.tot.p}г</span>
                        <span style={{ fontSize:11,color:BLU }}>У{d.tot.c}г</span>
                        <span style={{ fontSize:11,color:COR }}>Ж{d.tot.f}г</span>
                      </div>
                    )}
                  </div>
                  {foodGoals.kcal>0&&d.tot.kcal>0&&(
                    <div style={{ fontSize:11,fontWeight:700,color:d.tot.kcal>=foodGoals.kcal?COR:TEA,flexShrink:0 }}>
                      {d.tot.kcal>=foodGoals.kcal?`+${d.tot.kcal-foodGoals.kcal}`:`−${foodGoals.kcal-d.tot.kcal}`}
                    </div>
                  )}
                  <span style={{ color:'#c7cad1',fontSize:16,flexShrink:0 }}>›</span>
                </div>
              ))}
            </Card>
          </>)}
        </div>
      </div>
    , document.body)
  }

  // ── ГЛАВНАЯ: 4 папки
  const totalTon=allWorkoutTons.reduce((s,w)=>s+w.ton,0)
  const FOLDERS_DIARY=[
    {key:'tonnage',icon:'⚖️',label:'Общий тоннаж',color:PUR,sub:`${totalTon.toLocaleString('ru')} кг · ${allWorkoutTons.length} тренировок`},
    {key:'exercises',icon:'📈',label:'Прогресс по упражнениям',color:TEA,sub:`${exerciseNames.length} упражнений отслеживается`},
    {key:'workouts',icon:'🏋️',label:'Мои тренировки',color:COR,sub:allWorkoutTons.length>0?`Последняя: ${fmtFull(allWorkoutTons[allWorkoutTons.length-1].date)}`:'Нет записей'},
    {key:'food',icon:'🥗',label:'Питание',color:BLU,sub:'Дневник питания · макросы'},
  ]
  return(
    <div>
      <h2 style={{ fontSize:20,fontWeight:500,color:'#111',margin:'0 0 16px' }}>Дневник</h2>
      {FOLDERS_DIARY.map(f=>(
        <div key={f.key} style={{ background:'#fff',borderRadius:14,boxShadow:'0 1px 5px rgba(0,0,0,0.08)',marginBottom:10,display:'flex',alignItems:'center',gap:14,padding:'16px',cursor:'pointer' }}
          onClick={()=>setSection(f.key)}>
          <div style={{ width:50,height:50,borderRadius:14,background:`${f.color}18`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24,flexShrink:0 }}>
            {f.icon}
          </div>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontSize:15,fontWeight:700,color:'#111' }}>{f.label}</div>
            <div style={{ fontSize:11,color:'#9ca3af',marginTop:3 }}>{f.sub}</div>
          </div>
          <span style={{ fontSize:22,color:'#c7cad1',flexShrink:0 }}>›</span>
        </div>
      ))}
    </div>
  )
}

const NAV=[
  {id:'dashboard',icon:'🏠',label:'Главная'},
  {id:'clients',icon:'👥',label:'Клиенты'},
  {id:'workouts',icon:'🏋️',label:'Тренировки'},
  {id:'nutrition',icon:'🥗',label:'Питание'},
  {id:'library',icon:'📚',label:'Упражнения'},
  {id:'chat',icon:'💬',label:'Чат'},
  {id:'progress',icon:'📓',label:'Дневник'},
]
const NAV_MOBILE=[
  {id:'workouts',icon:'🏋️',label:'Тренировки'},
  {id:'nutrition',icon:'🥗',label:'Питание'},
  {id:'library',icon:'📚',label:'Упражнения'},
  {id:'progress',icon:'📓',label:'Дневник'},
  {id:'chat',icon:'💬',label:'Чат'},
  {id:'clients',icon:'👥',label:'Клиенты'},
]

function LandingPage({ onEnter }) {
  const [view,setView]=useState('hero')
  const [authTab,setAuthTab]=useState('login')
  const [form,setForm]=useState({name:'',email:'',password:'',confirm:''})
  const [mobile,setMobile]=useState(()=>window.innerWidth<640)
  const [authError,setAuthError]=useState('')
  const [forgotMode,setForgotMode]=useState(false)
  const [forgotEmail,setForgotEmail]=useState('')
  const [forgotDone,setForgotDone]=useState(false)

  useEffect(()=>{
    const fn=()=>setMobile(window.innerWidth<640)
    window.addEventListener('resize',fn)
    return()=>window.removeEventListener('resize',fn)
  },[])

  const switchTab=(tab)=>{setAuthTab(tab);setAuthError('');setForgotMode(false);setForgotDone(false);setForm({name:'',email:'',password:'',confirm:''})}

  const openForm=(tab)=>{setAuthTab(tab);setView('form')}

  const [authBusy,setAuthBusy]=useState(false)

  const handleRegister=async()=>{
    if(!form.name.trim()||!form.email.trim()||!form.password.trim()){setAuthError('Заполни все обязательные поля');return}
    if(form.password!==form.confirm){setAuthError('Пароли не совпадают');return}
    if(form.password.length<6){setAuthError('Пароль минимум 6 символов');return}
    setAuthBusy(true);setAuthError('')
    clearFitproData()
    const{error}=await supabase.auth.signUp({
      email:form.email.trim(),password:form.password,
      options:{data:{name:form.name.trim()}}
    })
    if(error){setAuthError(error.message);setAuthBusy(false);return}
    // Запись в public.profiles создаётся автоматически триггером on_auth_user_created в Supabase —
    // делать это здесь на клиенте ненадёжно, т.к. сразу после signUp сессии ещё может не быть (email-подтверждение)
    setAuthBusy(false)
    // onAuthStateChange в App() автоматически установит пользователя
  }

  const handleLogin=async()=>{
    if(!form.email.trim()||!form.password.trim()){setAuthError('Введи email и пароль');return}
    setAuthBusy(true);setAuthError('')
    const{error}=await supabase.auth.signInWithPassword({email:form.email.trim(),password:form.password})
    if(error){setAuthError('Неверный email или пароль');setAuthBusy(false);return}
    setAuthBusy(false)
    // onAuthStateChange в App() автоматически установит пользователя
  }

  const G='rgba(255,255,255,0.06)'
  const GB='1px solid rgba(255,255,255,0.09)'

  return(
    <div style={{ minHeight:'100vh',background:'#08080f',color:'#fff',fontFamily:'system-ui,-apple-system,sans-serif',overflowX:'hidden' }}>

      {/* ── Шапка */}
      <div style={{ padding:'13px 22px',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid rgba(255,255,255,0.07)',position:'sticky',top:0,background:'rgba(8,8,15,0.92)',backdropFilter:'blur(12px)',zIndex:20 }}>
        <div style={{ display:'flex',alignItems:'center',gap:9 }}>
          <span style={{ fontSize:22 }}>🏋️</span>
          <span style={{ fontSize:18,fontWeight:800,letterSpacing:'-0.5px' }}>FitPro</span>
        </div>
        <div style={{ display:'flex',gap:8,alignItems:'center' }}>
          <button onClick={()=>openForm('login')}
            style={{ padding:'7px 20px',borderRadius:8,border:`1px solid ${PUR}60`,background:`${PUR}20`,color:'#c4c0f7',fontSize:13,fontWeight:600,cursor:'pointer' }}>
            Войти
          </button>
        </div>
      </div>

      {view==='hero'?(
        <div style={{ maxWidth:900,margin:'0 auto',padding:mobile?'0 18px':'0 28px' }}>

          {/* ── Hero */}
          <div style={{ padding:mobile?'52px 0 44px':'80px 0 60px',textAlign:'center',background:`radial-gradient(ellipse at 50% -10%, ${PUR}30 0%, transparent 62%)` }}>

            {/* Бейдж */}
            <div style={{ display:'inline-flex',alignItems:'center',gap:7,background:`linear-gradient(90deg,${PUR}35,#5b54c420)`,border:`1px solid ${PUR}70`,borderRadius:20,padding:'6px 16px',fontSize:12,color:'#d0ccff',marginBottom:22,fontWeight:700,letterSpacing:'0.5px',boxShadow:`0 0 18px ${PUR}30` }}>
              <span style={{ fontSize:14 }}>✨</span> Первое приложение с AI-ассистентом
            </div>

            <h1 style={{ fontSize:mobile?32:56,fontWeight:800,lineHeight:1.12,margin:'0 0 32px',background:'linear-gradient(150deg,#fff 45%,#9d97e8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent' }}>
              Ваш персональный<br />тренер всегда<br />рядом
            </h1>

            <button onClick={()=>openForm('register')}
              style={{ padding:'15px 40px',borderRadius:14,border:'none',background:`linear-gradient(135deg,${PUR},#5b54c4)`,color:'#fff',fontSize:17,fontWeight:700,cursor:'pointer',boxShadow:`0 10px 32px ${PUR}55`,marginBottom:52 }}>
              Попробовать бесплатно
            </button>

            {/* ── AI-персонаж */}
            <div style={{ textAlign:'left',background:'rgba(255,255,255,0.03)',border:`1px solid ${PUR}35`,borderRadius:20,overflow:'hidden',boxShadow:`0 0 48px ${PUR}18` }}>

              {/* Хедер карточки */}
              <div style={{ background:`linear-gradient(90deg,${PUR}28,transparent)`,borderBottom:`1px solid ${PUR}25`,padding:'16px 20px',display:'flex',alignItems:'center',gap:14 }}>
                <div style={{ position:'relative',flexShrink:0 }}>
                  <div style={{ width:52,height:52,borderRadius:'50%',background:`linear-gradient(135deg,${PUR},#4d47b0)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,boxShadow:`0 4px 16px ${PUR}50` }}>🤖</div>
                  <div style={{ position:'absolute',bottom:2,right:2,width:13,height:13,borderRadius:'50%',background:'#22c55e',border:'2.5px solid #0d0d1a' }} />
                </div>
                <div>
                  <div style={{ fontSize:16,fontWeight:700,color:'#fff' }}>FitPro AI</div>
                  <div style={{ fontSize:12,color:'rgba(255,255,255,0.4)',marginTop:2 }}>Обучен вашим тренером</div>
                </div>
              </div>

              {/* Сообщение AI */}
              <div style={{ padding:'20px 20px 8px' }}>
                {/* Сообщение — умения */}
                <div style={{ display:'flex',gap:10,alignItems:'flex-start' }}>
                  <div style={{ background:`${PUR}18`,border:`1px solid ${PUR}30`,borderRadius:14,padding:'12px 15px',flex:1 }}>
                    <p style={{ margin:'0 0 10px',fontSize:13,color:'rgba(255,255,255,0.75)',lineHeight:1.5,fontWeight:600 }}>Вот что я умею:</p>
                    <div style={{ display:'flex',flexDirection:'column',gap:7 }}>
                      {[
                        ['📋','Знаю твою программу тренировок — вижу какой вес ты делал в прошлый раз'],
                        ['🥗','Помогу с питанием — спроси что съесть, что заменить или как вписать любимое'],
                        ['🔄','Скорректирую план если было слишком тяжело или слишком легко'],
                        ['💬','Отвечаю так, как ответил бы сам тренер — потому что он меня именно так обучил'],
                      ].map(([ic,tx],i)=>(
                        <div key={i} style={{ display:'flex',gap:9,alignItems:'flex-start',background:'rgba(255,255,255,0.04)',borderRadius:9,padding:'8px 11px' }}>
                          <span style={{ fontSize:15,flexShrink:0,marginTop:1 }}>{ic}</span>
                          <span style={{ fontSize:12,color:'rgba(255,255,255,0.6)',lineHeight:1.6 }}>{tx}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ padding:'6px 0 2px' }} />
              </div>
            </div>
          </div>

          {/* ── Карточки функций */}
          <div style={{ display:'grid',gridTemplateColumns:mobile?'1fr':'1fr 1fr',gap:12,marginBottom:32 }}>
            {[
              {icon:'📋',title:'Программы тренировок от maxim_athlete',desc:'Готовые программы под ваши цели. Просто запусти тренировку — все упражнения, вес и подходы уже внутри'},
              {icon:'🏋️',title:'Умный журнал тренировок',desc:'Записывай кг и повторы прямо в процессе тренировки, оставляй заметки для тренера или AI-ассистента'},
              {icon:'🥗',title:'Умный дневник питания',desc:'Умеет не только считать КБЖУ, но и даёт рекомендации — что на что заменить'},
              {icon:'📈',title:'Достижения',desc:'Аналитика общего тоннажа тренировок, прогресс по каждому упражнению и аналитика питания'},
            ].map((f,i)=>(
              <div key={i} style={{ background:G,border:GB,borderRadius:16,padding:'20px 18px',display:'flex',gap:14,alignItems:'flex-start' }}>
                <span style={{ fontSize:26,flexShrink:0,marginTop:2 }}>{f.icon}</span>
                <div>
                  <div style={{ fontSize:14,fontWeight:700,color:'#fff',marginBottom:6,lineHeight:1.35 }}>{f.title}</div>
                  <div style={{ fontSize:12,color:'rgba(255,255,255,0.42)',lineHeight:1.65 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* ── Акцентная строка */}
          <div style={{ textAlign:'center',marginBottom:28,padding:'22px 20px',background:`linear-gradient(135deg,${PUR}20,${TEA}12)`,border:`1px solid ${PUR}35`,borderRadius:16 }}>
            <div style={{ fontSize:mobile?17:20,fontWeight:800,background:`linear-gradient(135deg,#fff 40%,#b8b3f5)`,WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',lineHeight:1.4 }}>
              Теперь тренировки станут ещё комфортнее ✨
            </div>
          </div>

          {/* ── Кнопка внизу */}
          <div style={{ textAlign:'center',paddingBottom:52 }}>
            <button onClick={()=>openForm('register')}
              style={{ padding:'15px 44px',borderRadius:14,border:'none',background:`linear-gradient(135deg,${PUR},#5b54c4)`,color:'#fff',fontSize:17,fontWeight:700,cursor:'pointer',boxShadow:`0 10px 32px ${PUR}50` }}>
              Попробовать бесплатно
            </button>
          </div>

        </div>
      ):(
        /* ── Форма входа / регистрации */
        <div style={{ minHeight:'calc(100vh - 62px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'28px 18px' }}>
          <div style={{ width:'100%',maxWidth:400 }}>
            <button onClick={()=>{setView('hero');setAuthError('');setForgotMode(false)}} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.38)',fontSize:14,cursor:'pointer',padding:'0 0 18px',display:'flex',alignItems:'center',gap:6 }}>
              ← Назад
            </button>
            <div style={{ background:'rgba(255,255,255,0.04)',border:GB,borderRadius:20,padding:'30px 24px' }}>

              {forgotMode ? (
                /* ── Восстановление пароля */
                <div>
                  <button onClick={()=>{setForgotMode(false);setForgotDone(false);setForgotEmail('')}} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.38)',fontSize:13,cursor:'pointer',padding:'0 0 16px',display:'flex',alignItems:'center',gap:5 }}>
                    ← Назад к входу
                  </button>
                  <h2 style={{ fontSize:20,fontWeight:800,margin:'0 0 6px' }}>Восстановление пароля</h2>
                  <p style={{ fontSize:13,color:'rgba(255,255,255,0.38)',margin:'0 0 22px',lineHeight:1.65 }}>
                    Введи email — пришлём инструкции по восстановлению
                  </p>
                  {forgotDone ? (
                    <div style={{ textAlign:'center',padding:'24px 0' }}>
                      <div style={{ fontSize:42,marginBottom:14 }}>✉️</div>
                      <p style={{ fontSize:15,color:'#22c55e',fontWeight:700,margin:'0 0 8px' }}>Инструкции отправлены!</p>
                      <p style={{ fontSize:13,color:'rgba(255,255,255,0.4)',margin:0 }}>Проверь почту {forgotEmail}</p>
                    </div>
                  ):(
                    <div style={{ display:'flex',flexDirection:'column',gap:14 }}>
                      <div>
                        <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Email</label>
                        <input value={forgotEmail} type="email" placeholder="ivan@example.com"
                          onChange={e=>setForgotEmail(e.target.value)}
                          onKeyDown={e=>e.key==='Enter'&&forgotEmail.trim()&&setForgotDone(true)}
                          style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                          onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                      </div>
                      <button onClick={()=>forgotEmail.trim()&&setForgotDone(true)} disabled={!forgotEmail.trim()}
                        style={{ padding:'14px',borderRadius:11,border:'none',background:forgotEmail.trim()?PUR:`${PUR}35`,color:'#fff',fontSize:15,fontWeight:700,cursor:forgotEmail.trim()?'pointer':'default',transition:'all 0.15s' }}>
                        Отправить инструкции
                      </button>
                    </div>
                  )}
                </div>
              ):(
                /* ── Вход / Регистрация */
                <div>
                  {/* Табы */}
                  <div style={{ display:'flex',gap:0,marginBottom:24,background:'rgba(255,255,255,0.06)',borderRadius:10,padding:3 }}>
                    {[['login','Войти'],['register','Зарегистрироваться']].map(([t,l])=>(
                      <button key={t} onClick={()=>switchTab(t)}
                        style={{ flex:1,padding:'9px',borderRadius:8,border:'none',background:authTab===t?PUR:'transparent',color:authTab===t?'#fff':'rgba(255,255,255,0.45)',fontSize:13,fontWeight:600,cursor:'pointer',transition:'all 0.15s',minHeight:'unset' }}>
                        {l}
                      </button>
                    ))}
                  </div>

                  <div style={{ display:'flex',flexDirection:'column',gap:14 }}>
                    {authTab==='register' && (
                      <div>
                        <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Имя <span style={{ color:COR }}>*</span></label>
                        <input value={form.name} type="text" placeholder="Иван Иванов"
                          onChange={e=>{setForm(v=>({...v,name:e.target.value}));setAuthError('')}}
                          onKeyDown={e=>e.key==='Enter'&&handleRegister()}
                          style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                          onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                      </div>
                    )}

                    <div>
                      <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Email <span style={{ color:COR }}>*</span></label>
                      <input value={form.email} type="email" placeholder="ivan@example.com"
                        onChange={e=>{setForm(v=>({...v,email:e.target.value}));setAuthError('')}}
                        onKeyDown={e=>e.key==='Enter'&&(authTab==='login'?handleLogin():handleRegister())}
                        style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                        onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                    </div>

                    <div>
                      <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Пароль <span style={{ color:COR }}>*</span></label>
                      <input value={form.password} type="password" placeholder="Минимум 6 символов"
                        onChange={e=>{setForm(v=>({...v,password:e.target.value}));setAuthError('')}}
                        onKeyDown={e=>e.key==='Enter'&&(authTab==='login'?handleLogin():handleRegister())}
                        style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                        onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                    </div>

                    {authTab==='register' && (
                      <div>
                        <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Подтверди пароль <span style={{ color:COR }}>*</span></label>
                        <input value={form.confirm} type="password" placeholder="Повтори пароль"
                          onChange={e=>{setForm(v=>({...v,confirm:e.target.value}));setAuthError('')}}
                          onKeyDown={e=>e.key==='Enter'&&handleRegister()}
                          style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                          onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                      </div>
                    )}

                    {authError && (
                      <div style={{ padding:'10px 14px',borderRadius:9,background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.3)',fontSize:13,color:'#fca5a5' }}>
                        {authError}
                      </div>
                    )}

                    <button onClick={authTab==='login'?handleLogin:handleRegister} disabled={authBusy}
                      style={{ padding:'14px',borderRadius:11,border:'none',background:authBusy?'#6b7280':PUR,color:'#fff',fontSize:15,fontWeight:700,cursor:authBusy?'not-allowed':'pointer',marginTop:2,boxShadow:`0 6px 22px ${PUR}44`,transition:'all 0.15s' }}>
                      {authBusy ? 'Подождите...' : authTab==='login' ? 'Войти →' : 'Создать аккаунт →'}
                    </button>

                    {authTab==='login' && (
                      <button onClick={()=>{setForgotMode(true);setForgotEmail(form.email);setForgotDone(false)}}
                        style={{ background:'none',border:'none',color:`${PUR}bb`,fontSize:13,cursor:'pointer',textAlign:'center',padding:'2px 0',textDecoration:'underline',textDecorationStyle:'dotted',textUnderlineOffset:3 }}>
                        Забыли пароль?
                      </button>
                    )}

                    <p style={{ textAlign:'center',fontSize:12,color:'rgba(255,255,255,0.22)',margin:0,lineHeight:1.6 }}>
                      {authTab==='login' ? 'Нет аккаунта? ' : 'Уже есть аккаунт? '}
                      <button onClick={()=>switchTab(authTab==='login'?'register':'login')}
                        style={{ background:'none',border:'none',color:`${PUR}cc`,fontSize:12,cursor:'pointer',padding:0,textDecoration:'underline' }}>
                        {authTab==='login' ? 'Зарегистрироваться' : 'Войти'}
                      </button>
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── SettingsView ─────────────────────────────────────────────────────────────
function SettingsView({ user }) {
  const load=(k,def)=>{try{return JSON.parse(localStorage.getItem(k)??'null')??def}catch{return def}}
  const [notifs,setNotifs]=useState(()=>load('fitpro_notifs',{workout:false,diary:false,report:false}))
  const [units,setUnits]=useState(()=>load('fitpro_units',{weight:'kg',height:'cm'}))
  const [lang,setLang]=useState(()=>load('fitpro_lang','ru'))
  const [chatCount,setChatCount]=useState(null)
  const [clearConfirm,setClearConfirm]=useState(false)
  const [deleteConfirm,setDeleteConfirm]=useState(false)
  const [dataMsg,setDataMsg]=useState('')

  useEffect(()=>{
    if(!user?.id)return
    supabase.from('chat_messages').select('*',{count:'exact',head:true}).eq('user_id',user.id)
      .then(({count})=>setChatCount(count??0))
  },[user?.id])

  const saveNotifs=(next)=>{setNotifs(next);localStorage.setItem('fitpro_notifs',JSON.stringify(next))}
  const saveUnits=(next)=>{setUnits(next);localStorage.setItem('fitpro_units',JSON.stringify(next))}
  const saveLang=(v)=>{setLang(v);localStorage.setItem('fitpro_lang',v)}

  const clearChat=async()=>{
    if(!user?.id)return
    await supabase.from('chat_messages').delete().eq('user_id',user.id)
    setChatCount(0);setClearConfirm(false)
  }

  const deleteAll=async()=>{
    if(!user?.id)return
    await supabase.from('chat_messages').delete().eq('user_id',user.id)
    await supabase.from('food_diary').delete().eq('user_id',user.id)
    await supabase.from('food_goals').delete().eq('user_id',user.id)
    Object.keys(localStorage).filter(k=>k.startsWith('fitpro_')).forEach(k=>localStorage.removeItem(k))
    await supabase.auth.signOut()
  }

  const Toggle=({on,onToggle})=>(
    <button onClick={onToggle} style={{
      width:44,height:24,borderRadius:12,border:'none',cursor:'pointer',padding:0,
      background:on?PUR:'#d1d5db',transition:'background 0.2s',position:'relative',flexShrink:0,minHeight:'unset',
    }}>
      <span style={{
        position:'absolute',top:2,left:on?22:2,width:20,height:20,borderRadius:'50%',
        background:'#fff',transition:'left 0.2s',boxShadow:'0 1px 3px #0002',display:'block',
      }}/>
    </button>
  )

  const Row=({label,sub,right})=>(
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'13px 0',borderBottom:'1px solid #f3f4f6'}}>
      <div>
        <div style={{fontSize:15,color:'#111',fontWeight:500}}>{label}</div>
        {sub&&<div style={{fontSize:12,color:'#9ca3af',marginTop:2}}>{sub}</div>}
      </div>
      {right}
    </div>
  )

  const Section=({title,children})=>(
    <div style={{background:'#fff',borderRadius:14,padding:'0 16px',marginBottom:14,boxShadow:'0 1px 4px #0000000a'}}>
      <div style={{fontSize:12,fontWeight:700,color:'#9ca3af',padding:'14px 0 6px',letterSpacing:'0.5px',textTransform:'uppercase'}}>{title}</div>
      {children}
    </div>
  )

  return(
    <div style={{padding:'16px 16px 40px',display:'flex',flexDirection:'column',gap:0}}>

      {/* Уведомления */}
      <Section title="Уведомления">
        <Row label="Напоминание о тренировке" right={<Toggle on={notifs.workout} onToggle={()=>saveNotifs({...notifs,workout:!notifs.workout})}/>}/>
        <Row label="Заполнить дневник питания вечером" right={<Toggle on={notifs.diary} onToggle={()=>saveNotifs({...notifs,diary:!notifs.diary})}/>}/>
        <Row label="Еженедельный отчёт на почту" right={<Toggle on={notifs.report} onToggle={()=>saveNotifs({...notifs,report:!notifs.report})}/>}/>
      </Section>

      {/* Единицы измерения */}
      <Section title="Единицы измерения">
        <Row label="Вес" right={
          <div style={{display:'flex',gap:4}}>
            {['kg','lbs'].map(v=>(
              <button key={v} onClick={()=>saveUnits({...units,weight:v})} style={{
                padding:'5px 12px',borderRadius:8,border:`1.5px solid ${units.weight===v?PUR:'#e5e7eb'}`,
                background:units.weight===v?`${PUR}15`:'#fff',color:units.weight===v?PUR:'#6b7280',
                fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset',
              }}>{v}</button>
            ))}
          </div>
        }/>
        <Row label="Рост" right={
          <div style={{display:'flex',gap:4}}>
            {['cm','in'].map(v=>(
              <button key={v} onClick={()=>saveUnits({...units,height:v})} style={{
                padding:'5px 12px',borderRadius:8,border:`1.5px solid ${units.height===v?PUR:'#e5e7eb'}`,
                background:units.height===v?`${PUR}15`:'#fff',color:units.height===v?PUR:'#6b7280',
                fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset',
              }}>{v}</button>
            ))}
          </div>
        }/>
      </Section>

      {/* История чата */}
      <Section title="История чата">
        <Row label="Сохранено сообщений" sub="История очищается раз в 30 дней" right={
          <span style={{fontSize:15,fontWeight:700,color:PUR}}>{chatCount===null?'...' :chatCount}</span>
        }/>
        <div style={{padding:'6px 0 14px'}}>
          <div style={{fontSize:12,color:'#9ca3af',marginBottom:10}}>История автоматически очищается раз в 30 дней. Перед очисткой вы получите письмо с архивом на ваш email.</div>
          {!clearConfirm?(
            <button onClick={()=>setClearConfirm(true)} style={{
              width:'100%',padding:'11px',borderRadius:10,border:'1.5px solid #fee2e2',
              background:'#fff5f5',color:'#ef4444',fontSize:14,fontWeight:600,cursor:'pointer',minHeight:'unset',
            }}>Очистить историю чата</button>
          ):(
            <div style={{display:'flex',gap:8}}>
              <button onClick={clearChat} style={{flex:1,padding:'11px',borderRadius:10,border:'none',background:'#ef4444',color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset'}}>Удалить</button>
              <button onClick={()=>setClearConfirm(false)} style={{flex:1,padding:'11px',borderRadius:10,border:'1.5px solid #e5e7eb',background:'#fff',color:'#6b7280',fontSize:14,cursor:'pointer',minHeight:'unset'}}>Отмена</button>
            </div>
          )}
        </div>
      </Section>

      {/* Конфиденциальность */}
      <Section title="Конфиденциальность">
        {dataMsg&&<div style={{padding:'10px 0',fontSize:13,color:TEA,fontWeight:500}}>{dataMsg}</div>}
        <div style={{paddingBottom:14,display:'flex',flexDirection:'column',gap:8}}>
          <button onClick={()=>{setDataMsg('✓ Данные будут отправлены на ваш email');setTimeout(()=>setDataMsg(''),4000)}} style={{
            width:'100%',padding:'11px',borderRadius:10,border:'1.5px solid #e5e7eb',
            background:'#fff',color:'#111',fontSize:14,fontWeight:500,cursor:'pointer',minHeight:'unset',textAlign:'left',
          }}>📤 Скачать мои данные</button>
          {!deleteConfirm?(
            <button onClick={()=>setDeleteConfirm(true)} style={{
              width:'100%',padding:'11px',borderRadius:10,border:'1.5px solid #fee2e2',
              background:'#fff5f5',color:'#ef4444',fontSize:14,fontWeight:600,cursor:'pointer',minHeight:'unset',
            }}>🗑 Удалить все мои данные</button>
          ):(
            <div style={{background:'#fff5f5',borderRadius:12,padding:'14px',border:'1.5px solid #fecaca'}}>
              <div style={{fontSize:14,fontWeight:600,color:'#ef4444',marginBottom:10}}>Удалить все данные?</div>
              <div style={{fontSize:13,color:'#6b7280',marginBottom:12}}>Это действие необратимо. Все тренировки, питание и история чата будут удалены.</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={deleteAll} style={{flex:1,padding:'11px',borderRadius:10,border:'none',background:'#ef4444',color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset'}}>Удалить всё</button>
                <button onClick={()=>setDeleteConfirm(false)} style={{flex:1,padding:'11px',borderRadius:10,border:'1.5px solid #e5e7eb',background:'#fff',color:'#6b7280',fontSize:14,cursor:'pointer',minHeight:'unset'}}>Отмена</button>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Язык */}
      <Section title="Язык">
        <Row label="Язык приложения" right={
          <div style={{display:'flex',gap:4}}>
            {[['ru','Русский'],['en','English']].map(([v,lbl])=>(
              <button key={v} onClick={()=>saveLang(v)} style={{
                padding:'5px 12px',borderRadius:8,border:`1.5px solid ${lang===v?PUR:'#e5e7eb'}`,
                background:lang===v?`${PUR}15`:'#fff',color:lang===v?PUR:'#6b7280',
                fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset',
              }}>{lbl}</button>
            ))}
          </div>
        }/>
      </Section>

      {/* Поддержка */}
      <Section title="Поддержка">
        {[
          {label:'Написать тренеру',icon:'💬',url:'https://t.me/maxim_athlete'},
          {label:'Поддержка',icon:'🛟',url:'https://t.me/fitpro_supportt'},
          {label:'Сообщить об ошибке',icon:'🐛',url:'https://t.me/fitpro_supportt'},
        ].map(item=>(
          <a key={item.label} href={item.url} target="_blank" rel="noopener noreferrer" style={{
            display:'flex',alignItems:'center',gap:12,padding:'13px 0',
            borderBottom:'1px solid #f3f4f6',textDecoration:'none',color:'#111',
          }}>
            <span style={{fontSize:18}}>{item.icon}</span>
            <span style={{fontSize:15,fontWeight:500,flex:1}}>{item.label}</span>
            <span style={{fontSize:16,color:'#9ca3af'}}>›</span>
          </a>
        ))}
      </Section>

    </div>
  )
}

// ── ProfileView ──────────────────────────────────────────────────────────────
function ProfileView({ user, onClose, onOpenAI, onUserUpdate }) {
  const [tab,setTab]=useState('profile')
  const [profile,setProfile]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_profile')||'null')||{name:user?.name||'',birthdate:'',height:'',weight:'',goal:'',steps:'',gymDays:'',occupation:'',activityLevel:''}}catch{return{name:user?.name||'',birthdate:'',height:'',weight:'',goal:'',steps:'',gymDays:'',occupation:'',activityLevel:''}}
  })
  const [userEdit,setUserEdit]=useState({name:user?.name||'',email:user?.email||'',telegram:user?.telegram||'',gender:user?.gender||'',photoURL:user?.photoURL||''})
  const photoInputPVRef=useRef(null)
  const [saved,setSaved]=useState(false)
  const [showGoalPicker,setShowGoalPicker]=useState(false)
  const [customGoal,setCustomGoal]=useState('')
  const [typedText,setTypedText]=useState('')
  const [typingDone,setTypingDone]=useState(false)
  const TYPING_MSG='Могу подобрать рацион под твою цель'
  useEffect(()=>{
    if(!profile.goal){setTypedText('');setTypingDone(false);return}
    setTypedText('');setTypingDone(false)
    let i=0
    const t=setTimeout(()=>{
      const iv=setInterval(()=>{
        i++
        setTypedText(TYPING_MSG.slice(0,i))
        if(i>=TYPING_MSG.length){clearInterval(iv);setTypingDone(true)}
      },38)
      return()=>clearInterval(iv)
    },420)
    return()=>clearTimeout(t)
  },[profile.goal])

  const [measurements,setMeasurements]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_measurements')||'[]')}catch{return[]}
  })
  const [showAddM,setShowAddM]=useState(false)
  const [newM,setNewM]=useState({shoulders:'',underarm:'',chest:'',waist:'',glutes:'',thigh:'',calf:'',bicep:''})

  const M_FIELDS=[
    {key:'shoulders',label:'Обхват плеч'},
    {key:'underarm', label:'Обхват под мышками'},
    {key:'chest',    label:'Обхват груди'},
    {key:'waist',    label:'Обхват талии'},
    {key:'glutes',   label:'Обхват ягодиц'},
    {key:'thigh',    label:'Обхват бедра'},
    {key:'calf',     label:'Обхват голени'},
    {key:'bicep',    label:'Обхват руки (бицепс)'},
  ]

  const saveProfile=async()=>{
    localStorage.setItem('fitpro_profile',JSON.stringify(profile))
    // Сохраняем также редактируемые данные пользователя
    const updatedUser={...user,...userEdit,name:userEdit.name||user.name}
    localStorage.setItem('fitpro_user',JSON.stringify(updatedUser))
    if(onUserUpdate)onUserUpdate(updatedUser)
    // Синхронизируем с таблицей profiles в Supabase — AI-ассистент по питанию читает профиль только оттуда
    if(user?.id){
      const{error}=await supabase.from('profiles').upsert({
        id:user.id,
        name:updatedUser.name||null,
        weight:profile.weight?Number(profile.weight):null,
        height:profile.height?Number(profile.height):null,
        goal:profile.goal||null,
        birthdate:profile.birthdate||null,
        occupation:profile.occupation||null,
        gym_days:profile.gymDays?Number(profile.gymDays):null,
        activity_level:profile.activityLevel||null,
      })
      if(error)console.error('Ошибка синхронизации профиля с Supabase:',error)
    }
    setSaved(true); setTimeout(()=>setSaved(false),2000)
  }

  const handlePhotoPV=(e)=>{
    const file=e.target.files[0]
    if(!file)return
    const reader=new FileReader()
    reader.onload=ev=>setUserEdit(u=>({...u,photoURL:ev.target.result}))
    reader.readAsDataURL(file)
  }

  const addMeasurement=()=>{
    const hasAny=Object.values(newM).some(v=>v.trim())
    if(!hasAny)return
    const entry={date:new Date().toISOString(),...newM}
    const updated=[entry,...measurements]
    setMeasurements(updated)
    localStorage.setItem('fitpro_measurements',JSON.stringify(updated))
    setShowAddM(false)
    setNewM({shoulders:'',underarm:'',chest:'',waist:'',glutes:'',thigh:'',calf:'',bicep:''})
  }

  const fmtDate=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})

  return(
    <div style={{position:'fixed',inset:0,background:'#f9fafb',zIndex:1050,display:'flex',flexDirection:'column',fontFamily:'system-ui,sans-serif'}}>
      {/* Хедер */}
      <div style={{background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 16px',display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
        <button onClick={onClose} style={{background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset'}}>←</button>
        <span style={{fontSize:18,fontWeight:800,color:'#111',flex:1}}>Мои данные</span>
      </div>

      {/* Табы */}
      <div style={{display:'flex',gap:0,borderBottom:'1px solid #e5e7eb',background:'#fff',flexShrink:0}}>
        {[{id:'profile',label:'Профиль'},{id:'measurements',label:'Замеры'}].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            flex:1,padding:'13px 0',border:'none',borderBottom:tab===t.id?`2.5px solid ${PUR}`:'2.5px solid transparent',
            background:'none',fontSize:15,fontWeight:tab===t.id?700:500,color:tab===t.id?PUR:'#9ca3af',cursor:'pointer',minHeight:'unset'
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'18px 16px 40px'}}>

        {/* ── Профиль ── */}
        {tab==='profile'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            {/* Фото профиля */}
            <input ref={photoInputPVRef} type="file" accept="image/*" onChange={handlePhotoPV} style={{display:'none'}} />
            <div style={{display:'flex',alignItems:'center',gap:14}}>
              <div onClick={()=>photoInputPVRef.current?.click()} style={{position:'relative',cursor:'pointer',flexShrink:0}}>
                <Av lbl={(userEdit.name||user?.name||'').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={64} photo={userEdit.photoURL} gender={userEdit.gender} />
                <div style={{position:'absolute',bottom:0,right:0,width:22,height:22,borderRadius:'50%',background:PUR,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,border:'2px solid #fff'}}>📷</div>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:'#111',marginBottom:2}}>{userEdit.name||user?.name}</div>
                <div style={{fontSize:11,color:'#9ca3af'}}>{userEdit.email||user?.email}</div>
                <div style={{fontSize:11,color:PUR,marginTop:2,cursor:'pointer'}} onClick={()=>photoInputPVRef.current?.click()}>Изменить фото</div>
              </div>
            </div>

            {/* Пол */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Пол</label>
              <div style={{display:'flex',gap:8}}>
                {[['male','👨 Мужчина'],['female','👩 Женщина']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setUserEdit(u=>({...u,gender:val}))} type="button"
                    style={{flex:1,padding:'10px',borderRadius:10,border:`1.5px solid ${userEdit.gender===val?PUR:'#e5e7eb'}`,background:userEdit.gender===val?`${PUR}12`:'#fff',color:userEdit.gender===val?PUR:'#6b7280',fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset'}}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* ФИО */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>ФИО</label>
              <input value={userEdit.name||''} type="text" placeholder="Иванов Иван Иванович"
                onChange={e=>setUserEdit(u=>({...u,name:e.target.value}))}
                style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:'#111',outline:'none',boxSizing:'border-box',background:'#fff'}}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
            </div>
            {/* Email и Telegram */}
            {[{key:'email',label:'Email'},{key:'telegram',label:'Telegram'}].map(f=>(
              <div key={f.key}>
                <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>{f.label}</label>
                <input value={userEdit[f.key]||''} type="text" placeholder={f.key==='email'?'ivan@example.com':'@username'}
                  onChange={e=>setUserEdit(u=>({...u,[f.key]:e.target.value}))}
                  style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:'#111',outline:'none',boxSizing:'border-box',background:'#fff'}}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
              </div>
            ))}
            {/* Физические данные */}
            {/* Дата рождения — нативный календарь, хранится в ISO (YYYY-MM-DD) */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Дата рождения</label>
              <input value={profile.birthdate||''} type="date" max={new Date().toISOString().slice(0,10)}
                onChange={e=>setProfile(p=>({...p,birthdate:e.target.value}))}
                style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:profile.birthdate?'#111':'#9ca3af',outline:'none',boxSizing:'border-box',background:'#fff'}}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
            </div>
            {/* Рост и Вес */}
            {[
              {key:'height', label:'Рост (см)', placeholder:'175'},
              {key:'weight', label:'Вес (кг)',  placeholder:'75'},
            ].map(f=>(
              <div key={f.key}>
                <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>{f.label}</label>
                <input value={profile[f.key]||''} type="number" placeholder={f.placeholder}
                  onChange={e=>setProfile(p=>({...p,[f.key]:e.target.value}))}
                  style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:'#111',outline:'none',boxSizing:'border-box',background:'#fff'}}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
              </div>
            ))}

            {/* Цель */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Цель</label>
              {/* Строка-триггер */}
              <button onClick={()=>setShowGoalPicker(v=>!v)}
                style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${profile.goal?PUR:'#e5e7eb'}`,background:profile.goal?'#EEEDFE':'#fff',cursor:'pointer',textAlign:'left',minHeight:'unset',transition:'all 0.2s'}}>
                <span style={{fontSize:15,fontWeight:600,color:profile.goal?PUR:'#9ca3af'}}>
                  {profile.goal||'Выбрать цель...'}
                </span>
                <span style={{fontSize:13,color:'#9ca3af',transition:'transform 0.2s',display:'inline-block',transform:showGoalPicker?'rotate(180deg)':'rotate(0deg)'}}>▼</span>
              </button>
              {/* Раскрывающийся список */}
              <div style={{overflow:'hidden',maxHeight:showGoalPicker?400:0,opacity:showGoalPicker?1:0,transition:'max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease'}}>
                <div style={{display:'flex',flexDirection:'column',gap:6,paddingTop:8}}>
                  {[
                    {val:'Похудение',   icon:'🔥'},
                    {val:'Набор массы', icon:'💪'},
                    {val:'Поддержание', icon:'⚖️'},
                    {val:'Рельеф',      icon:'✂️'},
                  ].map(opt=>(
                    <button key={opt.val} onClick={()=>{setProfile(p=>({...p,goal:opt.val}));setShowGoalPicker(false)}}
                      style={{display:'flex',alignItems:'center',gap:10,padding:'11px 14px',borderRadius:10,border:`1.5px solid ${profile.goal===opt.val?PUR:'#e5e7eb'}`,background:profile.goal===opt.val?'#EEEDFE':'#fafafa',cursor:'pointer',textAlign:'left',minHeight:'unset',transition:'all 0.15s'}}>
                      <span style={{fontSize:18}}>{opt.icon}</span>
                      <span style={{fontSize:15,fontWeight:600,color:profile.goal===opt.val?PUR:'#374151'}}>{opt.val}</span>
                      {profile.goal===opt.val&&<span style={{marginLeft:'auto',fontSize:15,color:PUR}}>✓</span>}
                    </button>
                  ))}
                  {/* Свой вариант */}
                  <div style={{display:'flex',gap:8,paddingTop:2}}>
                    <input value={customGoal} onChange={e=>setCustomGoal(e.target.value)}
                      placeholder="Написать свой вариант..."
                      style={{flex:1,padding:'11px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:14,color:'#111',outline:'none',background:'#fafafa'}}
                      onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'}
                      onKeyDown={e=>{if(e.key==='Enter'&&customGoal.trim()){setProfile(p=>({...p,goal:customGoal.trim()}));setCustomGoal('');setShowGoalPicker(false)}}} />
                    <button onClick={()=>{if(customGoal.trim()){setProfile(p=>({...p,goal:customGoal.trim()}));setCustomGoal('');setShowGoalPicker(false)}}}
                      style={{padding:'11px 16px',borderRadius:10,border:'none',background:PUR,color:'#fff',fontSize:14,fontWeight:600,cursor:'pointer',minHeight:'unset',flexShrink:0}}>OK</button>
                  </div>
                </div>
              </div>
            </div>

            {/* AI баннер — появляется после выбора цели */}
            <div style={{
              overflow:'hidden',
              maxHeight: profile.goal ? 120 : 0,
              opacity: profile.goal ? 1 : 0,
              transition: 'max-height 0.45s cubic-bezier(0.4,0,0.2,1), opacity 0.4s ease',
            }}>
              <style>{`
                @keyframes bot-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
                @keyframes bot-blink{0%,100%{opacity:1}50%{opacity:0}}
                @keyframes banner-glow{0%,100%{box-shadow:0 0 0 0 #1D9E7520}50%{box-shadow:0 0 0 6px #1D9E7508}}
              `}</style>
              <div onClick={()=>{ if(onOpenAI){ onClose(); setTimeout(()=>onOpenAI('nutrition'),200) } }}
                style={{
                  display:'flex', alignItems:'center', gap:14,
                  background:'linear-gradient(135deg,#1D9E7514,#1D9E7506)',
                  border:'1.5px solid #1D9E7540', borderRadius:14,
                  padding:'14px 16px', cursor: onOpenAI ? 'pointer' : 'default',
                  marginBottom:4,
                  animation:'banner-glow 2s ease-in-out infinite',
                }}>
                <div style={{
                  width:44,height:44,borderRadius:'50%',
                  background:'linear-gradient(135deg,#1D9E75,#157a5b)',
                  display:'flex',alignItems:'center',justifyContent:'center',
                  fontSize:22,flexShrink:0,
                  animation: typingDone ? 'bot-float 2.2s ease-in-out infinite' : 'none',
                }}>🤖</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:15,fontWeight:700,color:'#1D9E75',minHeight:22}}>
                    {typedText}
                    {!typingDone&&<span style={{animation:'bot-blink 0.7s step-end infinite',marginLeft:1,color:'#1D9E75'}}>|</span>}
                  </div>
                </div>
                {onOpenAI&&typingDone&&<span style={{fontSize:20,color:'#1D9E75',flexShrink:0}}>›</span>}
              </div>
            </div>

            {/* Активность */}
            <div style={{background:'#f0eeff',borderRadius:12,padding:'14px 16px'}}>
              <div style={{fontSize:14,fontWeight:700,color:PUR,marginBottom:12}}>Активность</div>
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Шагов в день (среднее)</label>
                  <input value={profile.steps||''} type="number" placeholder="например 8000"
                    onChange={e=>setProfile(p=>({...p,steps:e.target.value}))}
                    style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:'#111',outline:'none',boxSizing:'border-box',background:'#fff'}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Тренировок в неделю</label>
                  <input value={profile.gymDays||''} type="number" placeholder="например 3"
                    onChange={e=>setProfile(p=>({...p,gymDays:e.target.value}))}
                    style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:'#111',outline:'none',boxSizing:'border-box',background:'#fff'}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Род деятельности</label>
                  <input value={profile.occupation||''} type="text" placeholder="например: сидячая работа, много стою, физический труд"
                    onChange={e=>setProfile(p=>({...p,occupation:e.target.value}))}
                    style={{width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid #e5e7eb',fontSize:15,color:'#111',outline:'none',boxSizing:'border-box',background:'#fff'}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:'#6b7280',display:'block',marginBottom:6}}>Уровень активности</label>
                  <div style={{display:'flex',gap:8}}>
                    {[['sedentary','Малоподвижный'],['moderate','Умеренный'],['high','Высокий']].map(([val,lbl])=>(
                      <button key={val} type="button" onClick={()=>setProfile(p=>({...p,activityLevel:val}))}
                        style={{flex:1,padding:'10px 6px',borderRadius:10,border:`1.5px solid ${profile.activityLevel===val?PUR:'#e5e7eb'}`,background:profile.activityLevel===val?`${PUR}12`:'#fff',color:profile.activityLevel===val?PUR:'#6b7280',fontSize:12,fontWeight:600,cursor:'pointer',minHeight:'unset'}}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <button onClick={saveProfile} style={{padding:'14px',borderRadius:12,border:'none',background:saved?TEA:PUR,color:'#fff',fontSize:16,fontWeight:700,cursor:'pointer',transition:'background 0.2s'}}>
              {saved?'✓ Сохранено':'Сохранить'}
            </button>
          </div>
        )}

        {/* ── Замеры ── */}
        {tab==='measurements'&&(
          <div>
            {/* Подсказка о замерах */}
            <div style={{display:'flex',gap:10,background:'#fff8e6',border:'1px solid #fcd34d',borderRadius:12,padding:'12px 14px',marginBottom:18,alignItems:'flex-start'}}>
              <span style={{fontSize:16,flexShrink:0}}>❗</span>
              <div style={{fontSize:13,color:'#92400e',lineHeight:1.6}}>
                <b>Важно:</b> все замеры делаются в самых выпуклых (наибольших) точках тела. Мышцы расслаблены, лента горизонтально без натяжения.
              </div>
            </div>

            <button onClick={()=>setShowAddM(true)} style={{width:'100%',padding:'14px',borderRadius:12,border:`2px dashed ${PUR}`,background:'#f0eeff',color:PUR,fontSize:15,fontWeight:700,cursor:'pointer',marginBottom:20}}>
              + Добавить замеры
            </button>

            {/* История замеров */}
            {measurements.length===0?(
              <div style={{textAlign:'center',color:'#9ca3af',fontSize:14,marginTop:32}}>
                <div style={{fontSize:40,marginBottom:12}}>📏</div>
                Пока нет замеров. Добавь первые — и сможешь отслеживать прогресс.
              </div>
            ):(
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                {measurements.map((m,i)=>(
                  <div key={i} style={{background:'#fff',borderRadius:14,padding:'16px',border:'1px solid #e5e7eb'}}>
                    <div style={{fontSize:14,fontWeight:700,color:'#111',marginBottom:12}}>📅 {fmtDate(m.date)}</div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                      {M_FIELDS.map(f=>m[f.key]?(
                        <div key={f.key} style={{background:'#f9fafb',borderRadius:8,padding:'8px 10px'}}>
                          <div style={{fontSize:11,color:'#9ca3af',marginBottom:2}}>{f.label}</div>
                          <div style={{fontSize:16,fontWeight:700,color:PUR}}>{m[f.key]} <span style={{fontSize:11,fontWeight:400,color:'#9ca3af'}}>см</span></div>
                          {/* разница с предыдущей записью */}
                          {measurements[i+1]&&measurements[i+1][f.key]&&(()=>{
                            const diff=(parseFloat(m[f.key])-parseFloat(measurements[i+1][f.key])).toFixed(1)
                            const pos=parseFloat(diff)>0
                            return diff!=='0.0'&&<div style={{fontSize:11,color:pos?COR:TEA,fontWeight:600}}>{pos?'+':''}{diff} см</div>
                          })()}
                        </div>
                      ):null)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Форма добавления замеров */}
            {showAddM&&(
              <>
                <div onClick={()=>setShowAddM(false)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:10}}/>
                <div style={{position:'fixed',bottom:0,left:0,right:0,background:'#fff',borderRadius:'18px 18px 0 0',zIndex:11,padding:'20px 18px 36px',maxHeight:'85vh',overflowY:'auto'}}>
                  <div style={{width:36,height:4,borderRadius:2,background:'#e5e7eb',margin:'0 auto 18px'}}/>
                  <div style={{fontSize:16,fontWeight:700,color:'#111',marginBottom:6}}>Новые замеры</div>
                  <div style={{fontSize:12,color:'#9ca3af',marginBottom:16}}>Все поля необязательны — заполни те что есть</div>
                  <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:18}}>
                    {M_FIELDS.map(f=>(
                      <div key={f.key} style={{display:'flex',alignItems:'center',gap:10}}>
                        <label style={{fontSize:13,color:'#374151',flex:1}}>{f.label}</label>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <input value={newM[f.key]} type="number" placeholder="см"
                            onChange={e=>setNewM(p=>({...p,[f.key]:e.target.value}))}
                            style={{width:72,padding:'9px 10px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:14,color:'#111',outline:'none',textAlign:'center'}}
                            onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
                          <span style={{fontSize:12,color:'#9ca3af'}}>см</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button onClick={addMeasurement} style={{width:'100%',padding:'14px',borderRadius:12,border:'none',background:PUR,color:'#fff',fontSize:15,fontWeight:700,cursor:'pointer'}}>
                    Сохранить замеры
                  </button>
                </div>
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

export default function App() {
  const [user,setUser]=useState(null)
  const [authLoading,setAuthLoading]=useState(true)
  const [userRole,setUserRole]=useState(()=>localStorage.getItem('fitpro_role')||'client')
  const [nav,setNav]=useState('dashboard')
  const [sc,setSC]=useState(null)
  const [isMobile,setIsMobile]=useState(()=>window.innerWidth<768)
  const [workoutActive,setWorkoutActive]=useState(false)
  const [pendingWorkoutAction,setPendingWorkoutAction]=useState(null)
  const [showProfileView,setShowProfileView]=useState(false)
  const [showProfileSheet,setShowProfileSheet]=useState(false)
  const [showSettingsView,setShowSettingsView]=useState(false)
  const aiRef=useRef()

  // Проверка ?trainer=1 в URL при загрузке
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search)
    if(params.get('trainer')==='1'){
      localStorage.setItem('fitpro_role','trainer')
      setUserRole('trainer')
      params.delete('trainer')
      const newUrl=window.location.pathname+(params.toString()?'?'+params.toString():'')
      window.history.replaceState({},'',newUrl)
    }
  },[])

  const mergeUserWithProfile=(supaUser)=>{
    if(!supaUser)return null
    let stored={},profile={}
    try{stored=JSON.parse(localStorage.getItem('fitpro_user')||'{}')}catch{}
    try{profile=JSON.parse(localStorage.getItem('fitpro_profile')||'{}')}catch{}
    return{
      ...supaUser,
      name:profile.name||stored.name||supaUser.user_metadata?.name||supaUser.email?.split('@')[0]||'',
      telegram:stored.telegram||'',gender:stored.gender||'',photoURL:stored.photoURL||'',
    }
  }

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{
      setUser(mergeUserWithProfile(session?.user??null))
      setAuthLoading(false)
    })
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_,session)=>{
      setUser(mergeUserWithProfile(session?.user??null))
    })
    return()=>subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])

  useEffect(()=>{
    const fn=()=>setIsMobile(window.innerWidth<768)
    window.addEventListener('resize',fn)
    return()=>window.removeEventListener('resize',fn)
  },[])

  const [workoutHistory,setWorkoutHistory]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_history')||'[]')}catch{return []}
  })
  const [customExercises,setCustomExercises]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_custom_ex')||'[]')}catch{return []}
  })

  useEffect(()=>{localStorage.setItem('fitpro_history',JSON.stringify(workoutHistory))},[workoutHistory])
  useEffect(()=>{localStorage.setItem('fitpro_custom_ex',JSON.stringify(customExercises))},[customExercises])

  const [editTarget,setEditTarget]=useState(null)

  const handleNav=(id)=>{
    if(workoutActive&&id!=='workouts'){
      if(!window.confirm('Тренировка в процессе. Выйти? Прогресс будет потерян.'))return
      setWorkoutActive(false)
    }
    setNav(id)
  }

  const handleWorkoutComplete=workout=>{
    setWorkoutHistory(h=>[...h,{...workout,date:workout.date||new Date().toISOString()}])
  }

  const handleWorkoutUpdate=(histIdx,updated)=>{
    setWorkoutHistory(h=>h.map((w,i)=>i===histIdx?{...updated,date:updated.date||w.date}:w))
  }

  const handleEditWorkout=(workout,histIdx)=>{
    setEditTarget({workout,histIdx})
    setNav('workouts')
  }

  const handleDeleteWorkout=(histIdx)=>{
    setWorkoutHistory(h=>h.filter((_,i)=>i!==histIdx))
  }

  const handleCopyWorkout=(workout)=>{
    handleWorkoutComplete({...workout,date:new Date().toISOString(),name:workout.name+' (копия)'})
  }

  const handleWorkoutAction=(action)=>{
    if(action==='start'||action==='done') setPendingWorkoutAction(action)
    handleNav('workouts')
  }

  if(authLoading) return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#08080f',color:'#9ca3af',fontSize:14}}>Загрузка...</div>
  if(!user) return <LandingPage onEnter={setUser} />

  const renderMain=()=>{
    if(nav==='cdetail'&&sc)return <ClientDetail client={sc} goBack={()=>handleNav('clients')} />
    switch(nav){
      case 'dashboard': return userRole==='trainer'
        ? <Dashboard setNav={handleNav} setSC={setSC} isTrainer={true} />
        : <DiaryView workoutHistory={workoutHistory} onEditWorkout={handleEditWorkout} onDeleteWorkout={handleDeleteWorkout} onCopyWorkout={handleCopyWorkout} onWorkoutAction={handleWorkoutAction} isMobile={isMobile} onOpenAI={m=>aiRef.current?.open(m)} userId={user?.id} />
      case 'clients':   return <ClientsView setSC={setSC} setNav={handleNav} />
      case 'workouts':  return <WorkoutsView customExercises={customExercises} setCustomExercises={setCustomExercises} onWorkoutComplete={handleWorkoutComplete} onWorkoutUpdate={handleWorkoutUpdate} editTarget={editTarget} onClearEdit={()=>setEditTarget(null)} onWorkoutActiveChange={setWorkoutActive} pendingAction={pendingWorkoutAction} onClearPendingAction={()=>setPendingWorkoutAction(null)} onOpenAI={m=>aiRef.current?.open(m)} />
      case 'nutrition': return <NutritionView userId={user?.id} />
      case 'library':   return <LibraryView customExercises={customExercises} />
      case 'chat':      return <ChatView />
      case 'progress':  return <DiaryView workoutHistory={workoutHistory} onEditWorkout={handleEditWorkout} onDeleteWorkout={handleDeleteWorkout} onCopyWorkout={handleCopyWorkout} onWorkoutAction={handleWorkoutAction} isMobile={isMobile} onOpenAI={m=>aiRef.current?.open(m)} userId={user?.id} />
      default:          return null
    }
  }

  const BOTTOM_NAV_H = 62
  const MOBILE_TOP_H = 48

  return (
    <>
      {/* Глобальные стили — адаптив */}
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; text-align: left; }

        /* Мобильные кнопки — минимум 44px */
        @media (max-width: 767px) {
          button { min-height: 44px; }
          input, select, textarea { min-height: 44px; font-size: 16px !important; }
          /* Базовые размеры шрифтов на мобильном */
          body { font-size: 15px; }
          h1, h2, h3, h4 { font-size: 16px !important; }
          .mobile-content span[style*="font-size:11"],
          .mobile-content span[style*="font-size: 11"] { font-size: 13px !important; }
          .mobile-content div[style*="font-size:11"],
          .mobile-content div[style*="font-size: 11"] { font-size: 13px !important; }
          .mobile-content span[style*="font-size:12"],
          .mobile-content span[style*="font-size: 12"] { font-size: 13px !important; }
          .mobile-content div[style*="font-size:12"],
          .mobile-content div[style*="font-size: 12"] { font-size: 13px !important; }
        }

        /* Safe area под iPhone (notch/home bar) */
        @supports (padding-bottom: env(safe-area-inset-bottom)) {
          .bottom-nav { padding-bottom: env(safe-area-inset-bottom); }
          .mobile-content { padding-bottom: calc(${BOTTOM_NAV_H}px + env(safe-area-inset-bottom)); }
        }
      `}</style>

      {isMobile ? (
        /* ── МОБИЛЬНЫЙ LAYOUT ── */
        <div style={{ display:'flex', flexDirection:'column', minHeight:'100vh', fontFamily:'system-ui,sans-serif', background:'#f9fafb' }}>

          {/* Мобильный хедер */}
          <div style={{ position:'fixed', top:0, left:0, right:0, height:MOBILE_TOP_H, background:'#fff', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px', zIndex:901, flexShrink:0 }}>
            <button onClick={()=>setShowProfileSheet(true)}
              style={{ width:36, height:36, borderRadius:'50%', border:'none', background:'transparent', padding:0, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset', overflow:'hidden' }}>
              <Av lbl={user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={36} photo={user.photoURL} gender={user.gender} />
            </button>
            <div style={{ display:'flex', alignItems:'center', gap:7 }}>
              <span style={{ fontSize:20 }}>🏋️</span>
              <span style={{ fontSize:16, fontWeight:800, color:'#111', letterSpacing:'-0.3px' }}>FitPro</span>
            </div>
          </div>

          <div className="mobile-content" style={{ flex:1, overflowY:'auto', padding:`${MOBILE_TOP_H+14}px 16px ${BOTTOM_NAV_H+16}px` }}>
            {renderMain()}
          </div>

          <nav className="bottom-nav" style={{
            position:'fixed', bottom:0, left:0, right:0,
            background:'#fff', borderTop:'1px solid #e5e7eb',
            display:'flex', height:BOTTOM_NAV_H, zIndex:900,
          }}>
            {NAV_MOBILE.filter(item=>userRole==='trainer'||item.id!=='clients').map(item=>{
              const active=nav===item.id||(nav==='cdetail'&&item.id==='clients')
              return (
                <button key={item.id} onClick={()=>handleNav(item.id)} style={{
                  flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                  gap:3, border:'none', background:'none', cursor:'pointer', padding:'0 2px',
                  position:'relative', minHeight:'unset',
                }}>
                  <div style={{ position:'absolute', top:0, left:'50%', transform:'translateX(-50%)', width:active?28:0, height:2.5, borderRadius:'0 0 3px 3px', background:PUR, transition:'width 0.18s' }} />
                  <span style={{ fontSize:22, lineHeight:1 }}>{item.icon}</span>
                  <span style={{ fontSize:11, fontWeight:active?700:400, color:active?PUR:'#9ca3af' }}>{item.label}</span>
                </button>
              )
            })}
          </nav>

          {/* Профиль — bottom sheet */}
          {showProfileSheet&&(
            <>
              <div onClick={()=>setShowProfileSheet(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1100 }} />
              <div style={{ position:'fixed', bottom:0, left:0, right:0, background:'#fff', borderRadius:'18px 18px 0 0', zIndex:1101, padding:'20px 20px 36px' }}>
                <div style={{ width:36, height:4, borderRadius:2, background:'#e5e7eb', margin:'0 auto 16px' }} />
                {/* Аватар + имя */}
                <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20, padding:'0 2px' }}>
                  <Av lbl={user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={48} photo={user.photoURL} gender={user.gender} />
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                      <span style={{ fontSize:17, fontWeight:700, color:'#111' }}>{user.name}</span>
                      {userRole==='trainer'&&<span style={{ fontSize:11, fontWeight:700, color:PUR, background:`${PUR}18`, borderRadius:6, padding:'2px 7px' }}>Тренер</span>}
                    </div>
                    <div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>{user.email}</div>
                  </div>
                </div>
                {/* Меню */}
                {[
                  { icon:'👤', label:'Мои данные',  sub:'Профиль, замеры и динамика',    action:()=>{ setShowProfileSheet(false); setShowProfileView(true) } },
                  { icon:'📊', label:'Мой прогресс', sub:'Тоннаж, тренировки, питание', action:()=>{ setShowProfileSheet(false); handleNav('progress') } },
                  { icon:'⚙️', label:'Настройки',   sub:'Уведомления, единицы, данные',  action:()=>{ setShowProfileSheet(false); setShowSettingsView(true) } },
                ].map((item,i)=>(
                  <button key={i} onClick={item.action} style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 16px', borderRadius:14, border:'1px solid #f3f4f6', background:'#fafafa', cursor:'pointer', marginBottom:10, textAlign:'left' }}>
                    <span style={{ fontSize:24 }}>{item.icon}</span>
                    <div>
                      <div style={{ fontSize:15, fontWeight:700, color:'#111' }}>{item.label}</div>
                      <div style={{ fontSize:12, color:'#9ca3af', marginTop:1 }}>{item.sub}</div>
                    </div>
                    <span style={{ marginLeft:'auto', fontSize:18, color:'#d1d5db' }}>›</span>
                  </button>
                ))}
                <button onClick={async()=>{setShowProfileSheet(false);await supabase.auth.signOut();clearFitproData()}}
                  style={{ width:'100%', padding:'13px', borderRadius:12, border:'1.5px solid #fee2e2', background:'#fff5f5', color:'#ef4444', fontSize:14, fontWeight:600, cursor:'pointer', marginTop:4 }}>
                  ← Выйти / сменить аккаунт
                </button>
              </div>
            </>
          )}

        </div>
      ) : (
        /* ── ДЕСКТОПНЫЙ LAYOUT ── */
        <div style={{ display:'flex', minHeight:'100vh', fontFamily:'system-ui,sans-serif', background:'#f9fafb' }}>
          <div style={{ width:190, background:'#fff', borderRight:'1px solid #e5e7eb', display:'flex', flexDirection:'column', flexShrink:0 }}>
            <div style={{ padding:'16px 14px 12px', borderBottom:'1px solid #e5e7eb' }}>
              <div onClick={()=>setShowProfileView(true)} style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                <Av lbl={user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={34} photo={user.photoURL} gender={user.gender} />
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:'#111', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.name.split(' ')[0]}</div>
                  <div style={{ fontSize:11, color:'#9ca3af' }}>{userRole==='trainer'?'Тренер':'Клиент'}</div>
                </div>
              </div>
            </div>
            <nav style={{ padding:'8px', flex:1 }}>
              {NAV.filter(item=>userRole==='trainer'||item.id!=='clients').map(item=>(
                <NavBtn key={item.id} {...item} active={nav===item.id||(nav==='cdetail'&&item.id==='clients')} onClick={()=>handleNav(item.id)} />
              ))}
            </nav>
            <div style={{ padding:'12px 14px', borderTop:'1px solid #e5e7eb' }}>
              <button onClick={()=>setShowSettingsView(true)}
                style={{ display:'flex',alignItems:'center',gap:7,fontSize:12,color:'#6b7280',background:'none',border:'none',cursor:'pointer',padding:'4px 0',marginBottom:4,width:'100%' }}>
                <span>⚙️</span> Настройки
              </button>
              <button onClick={async()=>{await supabase.auth.signOut();clearFitproData()}}
                style={{ fontSize:11, color:'#9ca3af', background:'none', border:'none', cursor:'pointer', padding:0, marginTop:2, display:'block' }}>
                Выйти →
              </button>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'20px 24px' }}>
            {renderMain()}
          </div>
        </div>
      )}
      {/* Экран "Мои данные" (mobile + desktop) */}
      {showProfileView&&<ProfileView user={user} onClose={()=>setShowProfileView(false)} onOpenAI={m=>aiRef.current?.open(m)} onUserUpdate={u=>setUser(u)} />}

      {/* Экран "Настройки" (mobile + desktop) */}
      {showSettingsView&&(
        <div style={{position:'fixed',inset:0,background:'#f9fafb',zIndex:1060,display:'flex',flexDirection:'column',fontFamily:'system-ui,sans-serif'}}>
          <div style={{background:'#fff',borderBottom:'1px solid #e5e7eb',padding:'14px 16px',display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
            <button onClick={()=>setShowSettingsView(false)} style={{background:'none',border:'none',fontSize:24,cursor:'pointer',color:'#6b7280',lineHeight:1,padding:0,minHeight:'unset'}}>←</button>
            <span style={{fontSize:18,fontWeight:800,color:'#111',flex:1}}>Настройки</span>
          </div>
          <div style={{flex:1,overflowY:'auto'}}>
            <SettingsView user={user} />
          </div>
        </div>
      )}

      <AIAssistant ref={aiRef} workoutHistory={workoutHistory} isMobile={isMobile} nutritionPlans={NUTRITION_PLANS} userId={user?.id} />
    </>
  )
}

