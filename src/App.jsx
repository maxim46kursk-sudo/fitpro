import { useState, useEffect, useRef } from 'react'
import './App.css'

const PUR = '#7F77DD'
const TEA = '#1D9E75'
const COR = '#D85A30'
const BLU = '#378ADD'

const CLIENTS = [
  { id:1, name:'Анна Соколова',   goal:'Похудение',    program:'Кардио + Сила',     progress:78, av:'АС', cal:1800, wk:4, wts:[75,74.2,73.5,72.8,72,71.5,71] },
  { id:2, name:'Дмитрий Козлов', goal:'Набор массы',   program:'Силовые тренировки', progress:62, av:'ДК', cal:2800, wk:3, wts:[70,70.5,71,71.8,72.5,73,73.5] },
  { id:3, name:'Сергей Петров',   goal:'Выносливость', program:'Бег + Кардио',       progress:45, av:'СП', cal:2400, wk:2, wts:[80,80,79.5,79,79,78.5,78] },
]

const PROGRAMS = [
  { id:1, name:'Силовые 3 дня', cat:'Сила', lvl:'Средний', days:3, dur:'8 нед', plan:[
    { day:'День А — Грудь и трицепс', ex:[
      { n:'Жим штанги лёжа', s:4, r:'8–10', rest:'90 сек', m:'Грудь' },
      { n:'Разведение гантелей', s:3, r:'12–15', rest:'60 сек', m:'Грудь' },
      { n:'Трицепс на блоке', s:3, r:'12–15', rest:'60 сек', m:'Трицепс' },
    ]},
    { day:'День Б — Спина и бицепс', ex:[
      { n:'Тяга штанги в наклоне', s:4, r:'8–10', rest:'90 сек', m:'Спина' },
      { n:'Подтягивания', s:3, r:'8–12', rest:'90 сек', m:'Спина' },
      { n:'Подъём штанги на бицепс', s:3, r:'12–15', rest:'60 сек', m:'Бицепс' },
    ]},
    { day:'День В — Ноги и плечи', ex:[
      { n:'Приседания со штангой', s:4, r:'8–10', rest:'90 сек', m:'Ноги' },
      { n:'Жим ногами', s:3, r:'12–15', rest:'60 сек', m:'Ноги' },
      { n:'Жим гантелей сидя', s:3, r:'10–12', rest:'60 сек', m:'Плечи' },
    ]},
  ]},
  { id:2, name:'Кардио + Тонус', cat:'Кардио', lvl:'Начинающий', days:4, dur:'6 нед', plan:[
    { day:'День А — Полное тело', ex:[
      { n:'Бег (беговая дорожка)', s:1, r:'20 мин', rest:'—', m:'Кардио' },
      { n:'Приседания без веса', s:3, r:'15–20', rest:'45 сек', m:'Ноги' },
      { n:'Отжимания', s:3, r:'10–15', rest:'45 сек', m:'Грудь' },
      { n:'Планка', s:3, r:'45–60с', rest:'30 сек', m:'Кор' },
    ]},
  ]},
]

const MEALS = [
  { name:'Завтрак', time:'08:00', cal:480, items:[
    { n:'Овсянка на молоке (150г)', cal:280, p:10, c:48, f:6 },
    { n:'Яйца варёные (2 шт)', cal:140, p:12, c:1, f:10 },
    { n:'Банан', cal:90, p:1, c:23, f:0 },
  ]},
  { name:'Обед', time:'13:30', cal:620, items:[
    { n:'Куриная грудка (200г)', cal:220, p:42, c:0, f:5 },
    { n:'Рис бурый (100г сух.)', cal:340, p:7, c:72, f:3 },
    { n:'Огуречный салат', cal:60, p:1, c:10, f:2 },
  ]},
  { name:'Ужин', time:'19:00', cal:500, items:[
    { n:'Лосось запечённый (150г)', cal:280, p:33, c:0, f:16 },
    { n:'Брокколи (200г)', cal:70, p:6, c:14, f:1 },
    { n:'Греческий йогурт', cal:150, p:8, c:20, f:4 },
  ]},
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
  { key:'start',    icon:'▶️', label:'Начать тренировку',         desc:'Запустить тренировку прямо сейчас' },
  { key:'schedule', icon:'📅', label:'Запланировать тренировку',   desc:'Добавить в расписание на будущее' },
  { key:'done',     icon:'✅', label:'Добавить выполненную',       desc:'Записать уже проведённую тренировку' },
  { key:'template', icon:'📋', label:'Создать шаблон тренировки',  desc:'Сохранить как многоразовый шаблон' },
  { key:'use',      icon:'📂', label:'Добавить шаблон тренировки', desc:'Выбрать из существующих шаблонов' },
]

const WCOLORS = ['#D85A30','#7F77DD','#1D9E75','#378ADD','#E53935','#F59E0B']

// ── UI компоненты
function Av({ lbl, sz=36, bg=PUR }) {
  return (
    <div style={{ width:sz, height:sz, borderRadius:'50%', background:bg, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:Math.round(sz*.35), fontWeight:500, flexShrink:0 }}>
      {lbl}
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
function Dashboard({ setNav, setSC }) {
  const avg = Math.round(CLIENTS.reduce((s,c)=>s+c.progress,0)/CLIENTS.length)
  return (
    <div>
      <div style={{ marginBottom:18 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:0 }}>Добро пожаловать 👋</h2>
        <p style={{ fontSize:13, color:'#6b7280', marginTop:4 }}>Твоя платформа для тренеров</p>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <Metric label="Клиентов" value={CLIENTS.length} icon="👥" color={PUR} />
        <Metric label="Программ" value={PROGRAMS.length} icon="🏋️" color={TEA} />
        <Metric label="Средний прогресс" value={`${avg}%`} icon="📈" color={BLU} />
        <Metric label="Сообщений" value="3" icon="💬" color={COR} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
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
        <Card>
          <div style={{ fontWeight:500, color:'#111', marginBottom:12 }}>Быстрые действия</div>
          {[
            {icon:'👥',label:'Клиенты',nav:'clients'},
            {icon:'🏋️',label:'Тренировки',nav:'workouts'},
            {icon:'🥗',label:'Питание',nav:'nutrition'},
            {icon:'📚',label:'Упражнения',nav:'library'},
            {icon:'💬',label:'Чат',nav:'chat'},
            {icon:'📊',label:'Прогресс',nav:'progress'},
          ].map(a=>(
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
  const fl=CLIENTS.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:0 }}>Клиенты</h2>
        <button style={{ fontSize:13, padding:'7px 14px', background:PUR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>+ Добавить</button>
      </div>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск..." style={{ width:'100%', marginBottom:14, padding:'8px 12px', fontSize:13, borderRadius:8, border:'1px solid #e5e7eb', boxSizing:'border-box' }} />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:10 }}>
        {fl.map(c=>(
          <Card key={c.id} onClick={()=>{setSC(c);setNav('cdetail')}} style={{ cursor:'pointer' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <Av lbl={c.av} sz={40} />
              <div><div style={{ fontSize:14, fontWeight:500, color:'#111' }}>{c.name}</div><Badge lbl={c.goal} /></div>
            </div>
            <div style={{ fontSize:12, color:'#6b7280', marginBottom:7 }}>🏋️ {c.program}</div>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span style={{ fontSize:12, color:'#6b7280' }}>Прогресс</span>
              <span style={{ fontSize:12, fontWeight:500, color:c.progress>70?TEA:PUR }}>{c.progress}%</span>
            </div>
            <PBar v={c.progress} color={c.progress>70?TEA:PUR} />
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
const MAX_VIDEOS_PER_SLOT=10
const makeDefaultSlots=folder=>
  Array.from({length:SLOT_COUNT},(_,i)=>({
    id:`${folder.replace(/\s+/g,'_')}_${i+1}`,
    slotNum:i+1,
    title:`Тренировка ${i+1}`,
    videos:[],
  }))
const makeDefaultFolderSlots=()=>{
  const o={}; FOLDERS.forEach(f=>{o[f]=makeDefaultSlots(f)}); return o
}

function WorkoutsView({ customExercises, setCustomExercises, onWorkoutComplete, onWorkoutUpdate, editTarget, onClearEdit }) {
  const [openFolder,setOpenFolder]=useState(null)
  const [openSlotId,setOpenSlotId]=useState(null)
  const [folderSlots,setFolderSlots]=useState(makeDefaultFolderSlots)
  const [playVideo,setPlayVideo]=useState(null)
  const [editingSlotTitle,setEditingSlotTitle]=useState(null) // {id,title}
  const [editingVideo,setEditingVideo]=useState(null)         // {slotId,videoId,description}
  const [slotsReady,setSlotsReady]=useState(false)
  const videoInputRef=useRef(null)
  const uploadTargetRef=useRef(null) // id слота при загрузке

  // Загружаем слоты из localStorage + видео из IndexedDB
  useEffect(()=>{
    const meta=JSON.parse(localStorage.getItem('fitpro_slots_meta')||'null')
    if(!meta){setSlotsReady(true);return}
    idbLoadAll().then(items=>{
      const byId={}
      items.forEach(it=>{byId[it.id]=it})
      const loaded=makeDefaultFolderSlots()
      Object.keys(meta).forEach(folder=>{
        if(!loaded[folder])return
        meta[folder].forEach((saved,idx)=>{
          if(!loaded[folder][idx])return
          const videos=(saved.videos||[]).map(v=>{
            const it=byId[v.id]
            if(!it)return null
            return{...v,url:URL.createObjectURL(new Blob([it.buf],{type:it.type||'video/mp4'}))}
          }).filter(Boolean)
          loaded[folder][idx]={...loaded[folder][idx],title:saved.title||loaded[folder][idx].title,videos}
        })
      })
      setFolderSlots(loaded)
      setSlotsReady(true)
    })
  },[])

  // Сохраняем метаданные (без url) при изменении
  useEffect(()=>{
    if(!slotsReady)return
    const meta={}
    Object.keys(folderSlots).forEach(folder=>{
      meta[folder]=folderSlots[folder].map(slot=>({
        id:slot.id,slotNum:slot.slotNum,title:slot.title,
        videos:slot.videos.map(({url,...rest})=>rest)
      }))
    })
    localStorage.setItem('fitpro_slots_meta',JSON.stringify(meta))
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
      setIsEditMode(true)
      setStep('active')
    }
  },[editTarget])

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
    if(onClearEdit)onClearEdit()
  }

  const finishWorkout=()=>{
    if(wExercises.length>0){
      const date=wMode==='log'&&wDate
        ?new Date(wDate+'T12:00:00').toISOString()
        :(isEditMode&&editTarget?editTarget.workout.date:new Date().toISOString())
      const updated={name:wName,color:wColor,exercises:wExercises,duration:wMode==='start'?timer:null,date}
      if(isEditMode&&editTarget){
        onWorkoutUpdate(editTarget.histIdx,updated)
      } else {
        onWorkoutComplete(updated)
      }
    }
    exitWorkout()
  }

  const exTonnage=ex=>ex.sets.reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)

  const updateSlots=fn=>setFolderSlots(prev=>{
    const next={}
    Object.keys(prev).forEach(f=>{next[f]=prev[f].map(fn)})
    return next
  })

  const handleVideoUpload=async(e)=>{
    const slotId=uploadTargetRef.current
    if(!slotId)return
    const files=Array.from(e.target.files)
    if(!files.length)return
    // Найдём текущий слот, чтобы знать сколько уже видео
    let curVideos=0
    Object.values(folderSlots).forEach(arr=>arr.forEach(s=>{if(s.id===slotId)curVideos=s.videos.length}))
    const toAdd=files.slice(0,MAX_VIDEOS_PER_SLOT-curVideos)
    const newVids=[]
    for(const f of toAdd){
      const id=Date.now().toString(36)+Math.random().toString(36).slice(2)
      await idbSave(id,f)
      newVids.push({id,name:f.name,size:(f.size/1024/1024).toFixed(1),url:URL.createObjectURL(f),description:''})
    }
    updateSlots(s=>s.id===slotId?{...s,videos:[...s.videos,...newVids]}:s)
    uploadTargetRef.current=null
    e.target.value=''
  }

  const removeVideo=async(slotId,videoId)=>{
    await idbDelete(videoId)
    updateSlots(s=>s.id===slotId?{...s,videos:s.videos.filter(v=>v.id!==videoId)}:s)
  }

  const saveSlotTitle=()=>{
    if(!editingSlotTitle)return
    updateSlots(s=>s.id===editingSlotTitle.id?{...s,title:editingSlotTitle.title}:s)
    setEditingSlotTitle(null)
  }

  const saveVideoDesc=()=>{
    if(!editingVideo)return
    updateSlots(s=>s.id===editingVideo.slotId
      ?{...s,videos:s.videos.map(v=>v.id===editingVideo.videoId?{...v,description:editingVideo.description}:v)}
      :s
    )
    setEditingVideo(null)
  }

  const saveVideoDescToAll=()=>{
    if(!editingVideo)return
    updateSlots(s=>s.id===editingVideo.slotId
      ?{...s,videos:s.videos.map(v=>({...v,description:editingVideo.description}))}
      :s
    )
    setEditingVideo(null)
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
                      <div style={{ display:'grid', gridTemplateColumns:'28px 1fr 1fr 28px', gap:6, marginBottom:6 }}>
                        {['#','КГ','ПОВТ',''].map((h,i)=>(
                          <span key={i} style={{ fontSize:10, color:'#6b7280', textAlign:'center', textTransform:'uppercase' }}>{h}</span>
                        ))}
                      </div>
                      {ex.sets.map((set,si)=>(
                        <div key={si} style={{ display:'grid', gridTemplateColumns:'28px 1fr 1fr 28px', gap:6, marginBottom:5, alignItems:'center' }}>
                          <span style={{ fontSize:12, color:'#6b7280', textAlign:'center', fontWeight:700 }}>{si+1}</span>
                          <input value={set.kg}
                            onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,kg:e.target.value}:s)}:x))}
                            placeholder="0"
                            style={{ background:'#374151', border:'1px solid #4b5563', borderRadius:6, padding:'6px 8px', fontSize:13, color:'#fff', textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                          <input value={set.reps}
                            onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,reps:e.target.value}:s)}:x))}
                            placeholder="0"
                            style={{ background:'#374151', border:'1px solid #4b5563', borderRadius:6, padding:'6px 8px', fontSize:13, color:'#fff', textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                          <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.filter((_,j)=>j!==si)}:x).filter(x=>x.sets.length>0))}
                            style={{ background:'none', border:'none', color:'#6b7280', cursor:'pointer', fontSize:14, textAlign:'center' }}>✕</button>
                        </div>
                      ))}
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

        {/* Нижняя панель */}
        <div style={{ padding:'12px 18px', borderTop:'1px solid #1f2937', display:'flex', justifyContent:'space-between', alignItems:'center', background:'#111', flexShrink:0 }}>
          <button onClick={()=>setPickOpen(true)} style={{ width:42, height:42, borderRadius:'50%', border:'2px solid #374151', background:'none', color:'#9ca3af', fontSize:22, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>+</button>
          <button onClick={finishWorkout} style={{ padding:'12px 36px', borderRadius:24, border:'none', background:wColor, color:'#fff', fontSize:15, fontWeight:700, cursor:'pointer', boxShadow:`0 4px 16px ${wColor}66` }}>
            {isEditMode?'Сохранить':'Завершить'}
          </button>
          <div style={{ width:42 }} />
        </div>
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
      <input ref={videoInputRef} type="file" accept="video/*" multiple style={{ display:'none' }}
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

      {/* Попап: описание видео */}
      {editingVideo&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setEditingVideo(null)}>
          <div style={{ background:'#fff', borderRadius:16, padding:'22px', width:440, maxWidth:'94vw', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <span style={{ fontSize:16, fontWeight:700, color:'#111' }}>Описание тренировки</span>
              <button onClick={()=>setEditingVideo(null)} style={{ background:'none', border:'none', fontSize:20, color:'#9ca3af', cursor:'pointer', minHeight:'unset' }}>✕</button>
            </div>
            <textarea value={editingVideo.description}
              onChange={e=>setEditingVideo(v=>({...v,description:e.target.value}))}
              placeholder={'Жим штанги лёжа — 4×10 (80 кг)\nРазводка гантелей — 3×12 (18 кг)\nОтжимания на брусьях — 3×15\nКроссовер — 4×15 (15 кг)'}
              rows={10}
              style={{ width:'100%', padding:'11px 13px', fontSize:13, borderRadius:10, border:'1.5px solid #e5e7eb', outline:'none', color:'#111', resize:'vertical', lineHeight:1.65, fontFamily:'inherit', boxSizing:'border-box' }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'}
            />
            <div style={{ display:'flex', gap:10, marginTop:16 }}>
              <button onClick={()=>setEditingVideo(null)}
                style={{ flex:1, padding:'12px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', background:'none', color:'#6b7280', cursor:'pointer' }}>Отмена</button>
              <button onClick={saveVideoDesc}
                style={{ flex:1, padding:'12px', fontSize:14, borderRadius:10, border:'none', background:PUR, color:'#fff', fontWeight:700, cursor:'pointer' }}>Сохранить</button>
            </div>
            <button onClick={saveVideoDescToAll}
              style={{ width:'100%', padding:'11px', marginTop:8, fontSize:13, borderRadius:10, border:`1.5px solid ${PUR}`, background:'#EEEDFE', color:PUR, fontWeight:600, cursor:'pointer' }}>
              Применить ко всем видео в тренировке
            </button>
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

      {/* ── Уровень 2: видео конкретной тренировки ── */}
      {currentSlot&&(
        <div style={{ position:'fixed', inset:0, background:'#f3f4f6', zIndex:1001, display:'flex', flexDirection:'column' }}>
          <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'14px 18px', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
            <button onClick={()=>setOpenSlotId(null)}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:'#6b7280', lineHeight:1, padding:0, minHeight:'unset' }}>←</button>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:17, fontWeight:700, color:'#111', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{currentSlot.title}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{currentSlot.videos.length} / {MAX_VIDEOS_PER_SLOT} видео</div>
            </div>
            <button onClick={()=>setEditingSlotTitle({id:currentSlot.id,title:currentSlot.title})}
              style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#9ca3af', minHeight:'unset' }}>✏️</button>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {/* Кнопка добавить видео */}
            {currentSlot.videos.length<MAX_VIDEOS_PER_SLOT&&(
              <button onClick={()=>{uploadTargetRef.current=currentSlot.id;videoInputRef.current.click()}}
                style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, width:'100%', padding:'14px', marginBottom:14, borderRadius:12, border:`1.5px dashed ${PUR}`, background:'#EEEDFE', color:PUR, fontSize:14, fontWeight:700, cursor:'pointer', boxSizing:'border-box', minHeight:'unset' }}>
                ＋ Добавить видео ({MAX_VIDEOS_PER_SLOT-currentSlot.videos.length} осталось)
              </button>
            )}
            {currentSlot.videos.length===0?(
              <div style={{ textAlign:'center', color:'#c7cad1', fontSize:13, marginTop:40 }}>Загрузите видео с тренировки</div>
            ):(
              currentSlot.videos.map((v,vi)=>(
                <div key={v.id} style={{ background:'#fff', borderRadius:13, overflow:'hidden', boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 14px' }}>
                    {/* Номер видео */}
                    <div style={{ flexShrink:0, width:36, height:36, borderRadius:'50%', background:PUR, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:'#fff' }}>{vi+1}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:'#111', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{v.name}</div>
                      <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>{v.size} МБ</div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                      <button onClick={()=>setPlayVideo(v)}
                        style={{ width:38, height:38, borderRadius:9, background:`${PUR}18`, border:'none', cursor:'pointer', fontSize:16, color:PUR, display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset' }}>▶</button>
                      <button onClick={()=>setEditingVideo({slotId:currentSlot.id,videoId:v.id,description:v.description||''})}
                        style={{ width:38, height:38, borderRadius:9, background:'#f3f4f6', border:'none', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset' }}>✏️</button>
                      <button onClick={()=>removeVideo(currentSlot.id,v.id)}
                        style={{ width:38, height:38, borderRadius:9, background:'#fef2f2', border:'none', cursor:'pointer', color:'#ef4444', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset' }}>✕</button>
                    </div>
                  </div>
                  {v.description&&(
                    <div style={{ padding:'10px 14px 14px', borderTop:'1px solid #f3f4f6' }}>
                      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:5 }}>Программа тренировки</div>
                      <pre style={{ fontSize:13, color:'#374151', margin:0, whiteSpace:'pre-wrap', fontFamily:'inherit', lineHeight:1.7 }}>{v.description}</pre>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Уровень 1: список тренировок в папке ── */}
      {openFolder&&(
        <div style={{ position:'fixed', inset:0, background:'#f3f4f6', zIndex:1000, display:'flex', flexDirection:'column' }}>
          <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'14px 18px', display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
            <button onClick={()=>setOpenFolder(null)}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:'#6b7280', lineHeight:1, padding:0, minHeight:'unset' }}>←</button>
            <span style={{ fontSize:22 }}>{FOLDER_ICONS[openFolder]}</span>
            <div>
              <div style={{ fontSize:17, fontWeight:700, color:'#111' }}>{openFolder}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>
                {folderSlots[openFolder].reduce((s,sl)=>s+sl.videos.length,0)} видео в {SLOT_COUNT} тренировках
              </div>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {folderSlots[openFolder].map(slot=>{
              const vc=slot.videos.length
              return (
                <div key={slot.id} style={{ background:'#fff', borderRadius:13, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10, display:'flex', alignItems:'center', gap:12, padding:'14px 16px', cursor:'pointer' }}
                  onClick={()=>setOpenSlotId(slot.id)}>
                  <div style={{ flexShrink:0, width:42, height:42, borderRadius:'50%', background:vc>0?PUR:'#f3f4f6', display:'flex', alignItems:'center', justifyContent:'center', fontSize:15, fontWeight:700, color:vc>0?'#fff':'#9ca3af' }}>
                    {slot.slotNum}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:15, fontWeight:600, color:'#111' }}>{slot.title}</div>
                    <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>
                      {vc===0?'Нет видео':`${vc} видео`}
                    </div>
                  </div>
                  <span style={{ fontSize:20, color:'#c7cad1' }}>›</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Уровень 0: список папок ── */}
      {FOLDERS.map(folder=>{
        const totalVids=folderSlots[folder].reduce((s,sl)=>s+sl.videos.length,0)
        return (
          <Card key={folder} style={{ marginBottom:10, cursor:'pointer' }}
            onClick={()=>setOpenFolder(folder)}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                <div style={{ fontSize:26 }}>{FOLDER_ICONS[folder]}</div>
                <div>
                  <div style={{ fontSize:15, fontWeight:600, color:'#111' }}>{folder}</div>
                  <div style={{ fontSize:11, color:'#9ca3af', marginTop:2 }}>
                    {SLOT_COUNT} тренировок · {totalVids} видео
                  </div>
                </div>
              </div>
              <span style={{ fontSize:20, color:'#c7cad1' }}>›</span>
            </div>
          </Card>
        )
      })}
    </div>
  )
}

function NutritionView() {
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:0 }}>Планы питания</h2>
        <button style={{ fontSize:13, padding:'7px 14px', background:COR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>+ Новый план</button>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:16 }}>
        <Metric label="Калории" value="1800 ккал" icon="🔥" color={PUR} />
        <Metric label="Белки" value="140 г" icon="🥩" color={TEA} />
        <Metric label="Углеводы" value="180 г" icon="🍚" color={BLU} />
        <Metric label="Жиры" value="60 г" icon="🥑" color={COR} />
      </div>
      {MEALS.map((meal,mi)=>(
        <Card key={mi} style={{ marginBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:9 }}>
            <div>
              <span style={{ fontSize:14, fontWeight:500, color:'#111' }}>{meal.name}</span>
              <span style={{ fontSize:12, color:'#9ca3af', marginLeft:7 }}>{meal.time}</span>
            </div>
            <span style={{ fontSize:13, fontWeight:500, color:COR }}>{meal.cal} ккал</span>
          </div>
          {meal.items.map((it,ii)=>(
            <div key={ii} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #f3f4f6', fontSize:12 }}>
              <span style={{ color:'#111' }}>{it.n}</span>
              <div style={{ display:'flex', gap:8, color:'#9ca3af' }}>
                <span>{it.cal} ккал</span><span>Б:{it.p}г</span><span>У:{it.c}г</span><span>Ж:{it.f}г</span>
              </div>
            </div>
          ))}
        </Card>
      ))}
    </div>
  )
}

function LibraryView({ customExercises }) {
  const [filt,setFilt]=useState('Все')
  const all=[...EXERCISES,...(customExercises||[])]
  const muscles=['Все',...new Set(all.map(e=>e.m))]
  const fl=filt==='Все'?all:all.filter(e=>e.m===filt)
  return (
    <div>
      <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:'0 0 14px' }}>Библиотека упражнений</h2>
      <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:14 }}>
        {muscles.map(m=>(
          <button key={m} onClick={()=>setFilt(m)} style={{ fontSize:12, padding:'4px 10px', borderRadius:20, cursor:'pointer', border:`1px solid ${filt===m?PUR:'#e5e7eb'}`, background:filt===m?'#EEEDFE':'transparent', color:filt===m?'#3C3489':'#6b7280' }}>{m}</button>
        ))}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:9 }}>
        {fl.map((ex,i)=>(
          <Card key={i}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
              <span style={{ fontSize:13, fontWeight:500, color:'#111' }}>{ex.n}</span>
              {ex.custom&&<span style={{ fontSize:9, padding:'1px 5px', borderRadius:4, background:'#EEEDFE', color:PUR }}>моё</span>}
            </div>
            <div style={{ fontSize:11, color:'#9ca3af' }}>{ex.m}{ex.eq?` · ${ex.eq}`:''}</div>
          </Card>
        ))}
      </div>
    </div>
  )
}

function ChatView() {
  const [msgs,setMsgs]=useState(CHAT_INIT)
  const [inp,setInp]=useState('')
  const [active,setActive]=useState(CLIENTS[0])
  const send=()=>{
    if(!inp.trim())return
    const now=new Date()
    setMsgs(p=>[...p,{id:p.length+1,from:'trainer',text:inp,t:`${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`}])
    setInp('')
  }
  return (
    <div>
      <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:'0 0 14px' }}>Чат с клиентами</h2>
      <div style={{ display:'flex', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', height:460 }}>
        <div style={{ width:170, borderRight:'1px solid #e5e7eb', overflowY:'auto' }}>
          {CLIENTS.map(c=>(
            <div key={c.id} onClick={()=>setActive(c)} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', cursor:'pointer', background:active.id===c.id?'#f9fafb':'transparent', borderBottom:'1px solid #f3f4f6' }}>
              <Av lbl={c.av} sz={28} />
              <div><div style={{ fontSize:12, fontWeight:500, color:'#111' }}>{c.name.split(' ')[0]}</div><div style={{ fontSize:10, color:'#9ca3af' }}>{c.goal}</div></div>
            </div>
          ))}
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'9px 13px', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', gap:8 }}>
            <Av lbl={active.av} sz={26} /><span style={{ fontSize:13, fontWeight:500, color:'#111' }}>{active.name}</span>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'11px 13px', display:'flex', flexDirection:'column', gap:7 }}>
            {msgs.map(m=>(
              <div key={m.id} style={{ display:'flex', justifyContent:m.from==='trainer'?'flex-end':'flex-start' }}>
                <div style={{ maxWidth:'72%', padding:'8px 11px', borderRadius:11, background:m.from==='trainer'?PUR:'#f3f4f6', color:m.from==='trainer'?'#fff':'#111', fontSize:13 }}>
                  {m.text}
                  <div style={{ fontSize:10, marginTop:3, opacity:.6, textAlign:'right' }}>{m.t}</div>
                </div>
              </div>
            ))}
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

// ── Прогресс
function ProgressView({ workoutHistory, onEditWorkout }) {
  const [period,setPeriod]=useState('all')
  const [customFrom,setCustomFrom]=useState('')
  const [customTo,setCustomTo]=useState('')
  const [selectedTonBar,setSelectedTonBar]=useState(null)
  const [selectedEx,setSelectedEx]=useState(null)
  const [exQuery,setExQuery]=useState('')
  const [activeBar,setActiveBar]=useState(null)

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
      date:w.date, name:w.name, color:w.color||PUR, histIdx,
      exercises:w.exercises||[],
      ton:(w.exercises||[]).reduce((s1,ex)=>(ex.sets||[]).reduce((s2,set)=>s2+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),s1),0),
    }))
    .sort((a,b)=>new Date(a.date)-new Date(b.date))

  const PERIOD_DAYS={'7d':7,'30d':30,'3m':90}
  const workoutTons=(customFrom||customTo)
    ?allWorkoutTons.filter(w=>{
        const t=new Date(w.date).getTime()
        const from=customFrom?new Date(customFrom).getTime():0
        const to=customTo?new Date(customTo+'T23:59:59').getTime():Infinity
        return t>=from&&t<=to
      })
    :period==='all'
      ?allWorkoutTons
      :allWorkoutTons.filter(w=>new Date(w.date).getTime()>=Date.now()-PERIOD_DAYS[period]*86400000)

  const totalTonnage=workoutTons.reduce((s,w)=>s+w.ton,0)
  const chartMaxTon=workoutTons.length?Math.max(...workoutTons.map(w=>w.ton),1):1
  const fmtD=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'short'}).replace(/\./g,'')
  const fmtFull=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})
  const CHART_BAR_H=120
  const selW=selectedTonBar!==null?workoutTons[selectedTonBar]:null

  return (
    <div>
      <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:'0 0 14px' }}>Прогресс</h2>

      {/* Бар-чарт тоннажа */}
      <Card style={{ marginBottom:16 }}>
        {/* Общий тоннаж */}
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11, fontWeight:500, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Общий тоннаж</div>
          <div style={{ fontSize:32, fontWeight:800, color:PUR, lineHeight:1 }}>{totalTonnage.toLocaleString('ru')} <span style={{ fontSize:18, fontWeight:600 }}>кг</span></div>
        </div>

        {/* Период — по центру над чартом */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, marginBottom:14 }}>
          <div style={{ display:'flex', gap:6 }}>
            {[{k:'7d',l:'7 дней'},{k:'30d',l:'30 дней'},{k:'all',l:'Всё'}].map(p=>(
              <button key={p.k} onClick={()=>{setPeriod(p.k);setCustomFrom('');setCustomTo('');setSelectedTonBar(null)}}
                style={{ fontSize:11, padding:'5px 14px', borderRadius:8, border:'none', cursor:'pointer',
                  background:period===p.k&&!customFrom&&!customTo?PUR:'#f3f4f6',
                  color:period===p.k&&!customFrom&&!customTo?'#fff':'#6b7280',
                  fontWeight:period===p.k&&!customFrom&&!customTo?600:400 }}>
                {p.l}
              </button>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:11, color:'#9ca3af' }}>с</span>
            <input type="date" value={customFrom} onChange={e=>{setCustomFrom(e.target.value);setSelectedTonBar(null)}}
              style={{ fontSize:12, padding:'5px 9px', borderRadius:7, border:'1.5px solid #e5e7eb', outline:'none', color:'#111', background:'#fff', colorScheme:'light' }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
            <span style={{ fontSize:11, color:'#9ca3af' }}>по</span>
            <input type="date" value={customTo} onChange={e=>{setCustomTo(e.target.value);setSelectedTonBar(null)}}
              style={{ fontSize:12, padding:'5px 9px', borderRadius:7, border:'1.5px solid #e5e7eb', outline:'none', color:'#111', background:'#fff', colorScheme:'light' }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='#e5e7eb'} />
            {(customFrom||customTo)&&(
              <button onClick={()=>{setCustomFrom('');setCustomTo('');setSelectedTonBar(null)}}
                style={{ fontSize:11, padding:'4px 8px', borderRadius:6, border:'none', background:'#f3f4f6', color:'#9ca3af', cursor:'pointer' }}>
                ✕
              </button>
            )}
          </div>
        </div>

        {workoutTons.length===0?(
          <div style={{ textAlign:'center', color:'#c7cad1', fontSize:13, padding:'20px 0' }}>
            Завершите тренировку — она появится здесь
          </div>
        ):(
          <div>
            <div style={{ display:'flex', alignItems:'flex-end', gap:5, height:CHART_BAR_H }}>
              {workoutTons.map((w,i)=>{
                const bh=Math.max(10,Math.round((w.ton/chartMaxTon)*(CHART_BAR_H-22)))
                const on=selectedTonBar===i
                return (
                  <div key={i} onClick={()=>setSelectedTonBar(on?null:i)}
                    style={{ flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end', alignItems:'center', height:'100%', minWidth:0, cursor:'pointer' }}>
                    <div style={{ fontSize:11, fontWeight:on?700:600, color:on?PUR:`${PUR}99`, marginBottom:4, textAlign:'center', lineHeight:1, whiteSpace:'nowrap' }}>
                      {w.ton}
                    </div>
                    <div style={{ width:'68%', height:bh, background:on?PUR:`${PUR}55`, borderRadius:'3px 3px 0 0', transition:'background 0.12s' }} />
                  </div>
                )
              })}
            </div>
            <div style={{ borderTop:'2px solid #f3f4f6' }} />
            <div style={{ display:'flex', gap:5, paddingTop:5 }}>
              {workoutTons.map((w,i)=>(
                <div key={i} style={{ flex:1, textAlign:'center', fontSize:9, color:selectedTonBar===i?PUR:'#9ca3af', lineHeight:1.2, minWidth:0, overflow:'hidden' }}>
                  {fmtD(w.date)}
                </div>
              ))}
            </div>
            <div style={{ textAlign:'center', fontSize:11, color:'#c7cad1', marginTop:10 }}>
              Нажмите на столбик, чтобы увидеть подробную сводку тренировки
            </div>
          </div>
        )}
      </Card>

      {/* Сводка выбранной тренировки */}
      {selW&&(
        <Card style={{ marginBottom:16, border:`1.5px solid ${PUR}33` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
            <div>
              <div style={{ fontSize:14, fontWeight:600, color:'#111' }}>{fmtFull(selW.date)}</div>
              <div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>{selW.name}</div>
            </div>
            <button onClick={()=>onEditWorkout(workoutHistory[selW.histIdx],selW.histIdx)}
              style={{ fontSize:12, padding:'5px 12px', borderRadius:7, border:`1px solid ${PUR}`, background:'#EEEDFE', color:PUR, cursor:'pointer', fontWeight:500, flexShrink:0 }}>
              ✏️ Редактировать
            </button>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
            {[
              {label:'Тоннаж',value:`${selW.ton} кг`,accent:true},
              {label:'Упражнений',value:selW.exercises.length,accent:false},
              {label:'Подходов',value:selW.exercises.reduce((s,ex)=>s+(ex.sets||[]).filter(s=>s.kg||s.reps).length,0),accent:false},
            ].map(c=>(
              <div key={c.label} style={{ background:'#f9fafb', borderRadius:10, padding:'10px 12px' }}>
                <div style={{ fontSize:10, color:'#9ca3af', marginBottom:4 }}>{c.label}</div>
                <div style={{ fontSize:17, fontWeight:700, color:c.accent?PUR:'#111' }}>{c.value}</div>
              </div>
            ))}
          </div>
          {selW.exercises.map((ex,ei)=>{
            const exTon=(ex.sets||[]).reduce((s,set)=>s+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),0)
            return (
              <div key={ei} style={{ paddingTop: ei>0?10:0, borderTop: ei>0?'1px solid #f3f4f6':'' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
                  <span style={{ fontSize:13, fontWeight:500, color:'#111' }}>{ex.n}</span>
                  {exTon>0&&<span style={{ fontSize:11, color:PUR, fontWeight:600 }}>{exTon} кг</span>}
                </div>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                  {(ex.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                    <span key={si} style={{ fontSize:11, color:'#6b7280', background:'#f3f4f6', padding:'2px 8px', borderRadius:5 }}>
                      {si+1}. {s.kg||'—'} кг × {s.reps||'—'}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </Card>
      )}

      {/* Список упражнений */}
      <h2 style={{ fontSize:20, fontWeight:500, color:'#111', margin:'0 0 12px' }}>Упражнения</h2>
      <input
        value={exQuery} onChange={e=>setExQuery(e.target.value)}
        placeholder="Поиск упражнения..."
        style={{ width:'100%', padding:'10px 16px', fontSize:14, borderRadius:10, border:'1.5px solid #e5e7eb', boxSizing:'border-box', outline:'none', marginBottom:10, color:'#111', background:'#fff' }}
        onFocus={e=>e.target.style.borderColor=PUR}
        onBlur={e=>e.target.style.borderColor='#e5e7eb'}
      />
      {exerciseNames.length===0?(
        <div style={{ textAlign:'center', color:'#9ca3af', fontSize:13, marginTop:40 }}>
          Завершите тренировку с упражнениями, чтобы видеть аналитику
        </div>
      ):exerciseNames.filter(n=>n.toLowerCase().includes(exQuery.toLowerCase())).length===0?(
        <div style={{ textAlign:'center', color:'#9ca3af', fontSize:13, marginTop:40 }}>Упражнение не найдено</div>
      ):(
        exerciseNames.filter(n=>n.toLowerCase().includes(exQuery.toLowerCase())).map(name=>{
          const ex=exerciseMap[name]
          const records=[...ex.records].sort((a,b)=>new Date(a.date)-new Date(b.date))
          const best=Math.max(...ex.records.map(r=>r.maxKg))
          const growth=records.length>1?records[records.length-1].tonnage-records[0].tonnage:0
          const exMaxTon=Math.max(...records.map(r=>r.tonnage),1)
          const isActive=selectedEx===name
          const activeRec=isActive&&activeBar!==null?records[activeBar]:null
          return (
            <div key={name} style={{ marginBottom:8 }}>
              <Card>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                  {/* Название + подпись — фиксированная ширина, всегда от левого края */}
                  <div style={{ flex:'0 0 190px' }}>
                    <div style={{ fontSize:14, fontWeight:500, color:'#111', marginBottom:2 }}>{name}</div>
                    <div style={{ fontSize:11, color:'#9ca3af' }}>
                      {ex.muscle?`${ex.muscle} · `:''}
                      {records.length} {records.length===1?'тренировка':records.length<5?'тренировки':'тренировок'}
                      {growth>0&&<span style={{ color:'#22c55e', marginLeft:4 }}>+{growth} кг</span>}
                    </div>
                  </div>
                  {/* Столбики — компактные, начинаются от красной линии */}
                  <div style={{ flex:1, display:'flex', alignItems:'flex-end', justifyContent:'flex-start', gap:5, height:54 }}>
                    {records.map((r,i)=>{
                      const bh=Math.max(4,Math.round((r.tonnage/exMaxTon)*44))
                      const on=isActive&&activeBar===i
                      return (
                        <div key={i} onClick={()=>{setSelectedEx(name);setActiveBar(on?null:i)}}
                          style={{ flexShrink:0, width:22, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end', height:'100%', cursor:'pointer' }}>
                          <div style={{ fontSize:8, color:on?PUR:'#c7cad1', marginBottom:2, lineHeight:1 }}>{r.tonnage}</div>
                          <div style={{ width:'100%', height:bh, background:on?PUR:`${PUR}44`, borderRadius:'2px 2px 0 0', transition:'background 0.1s' }} />
                        </div>
                      )
                    })}
                  </div>
                  {/* Макс. вес */}
                  <div style={{ flexShrink:0, textAlign:'right', width:60 }}>
                    <div style={{ fontSize:15, fontWeight:700, color:PUR }}>{best} кг</div>
                    <div style={{ fontSize:10, color:'#9ca3af' }}>макс. вес</div>
                  </div>
                </div>
              </Card>
              {/* Детальная сводка под карточкой */}
              {activeRec&&(
                <Card style={{ marginTop:4, border:`1.5px solid ${PUR}33` }}>
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:14, fontWeight:600, color:'#111' }}>{fmtFull(activeRec.date)}</div>
                    {activeRec.workoutName&&<div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>{activeRec.workoutName}</div>}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
                    {[
                      {label:'Тоннаж',value:`${activeRec.tonnage} кг`,accent:true},
                      {label:'Макс. вес',value:`${activeRec.maxKg} кг`,accent:false},
                      {label:'Подходов',value:(activeRec.sets||[]).filter(s=>s.kg||s.reps).length,accent:false},
                    ].map(c=>(
                      <div key={c.label} style={{ background:'#f9fafb', borderRadius:10, padding:'10px 12px' }}>
                        <div style={{ fontSize:10, color:'#9ca3af', marginBottom:4 }}>{c.label}</div>
                        <div style={{ fontSize:17, fontWeight:700, color:c.accent?PUR:'#111' }}>{c.value}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                    {(activeRec.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                      <div key={si} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 12px', background:'#f9fafb', borderRadius:8 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                          <span style={{ fontSize:11, fontWeight:600, color:'#d1d5db', width:16, textAlign:'center' }}>{si+1}</span>
                          <span style={{ fontSize:14, fontWeight:600, color:'#111' }}>{parseFloat(s.kg)||0} кг</span>
                          <span style={{ fontSize:13, color:'#9ca3af' }}>× {parseInt(s.reps)||0} повт.</span>
                        </div>
                        <span style={{ fontSize:13, fontWeight:600, color:PUR }}>{(parseFloat(s.kg)||0)*(parseInt(s.reps)||0)} кг</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>onEditWorkout(workoutHistory[activeRec.histIdx],activeRec.histIdx)}
                    style={{ marginTop:12, fontSize:12, padding:'6px 12px', borderRadius:7, border:`1px solid ${PUR}`, background:'#EEEDFE', color:PUR, cursor:'pointer', fontWeight:500 }}>
                    ✏️ Редактировать тренировку
                  </button>
                </Card>
              )}
            </div>
          )
        })
      )}
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
  {id:'progress',icon:'📊',label:'Прогресс'},
]
const NAV_MOBILE=[
  {id:'dashboard',icon:'🏠',label:'Главная'},
  {id:'clients',icon:'👥',label:'Клиенты'},
  {id:'workouts',icon:'🏋️',label:'Тренировки'},
  {id:'nutrition',icon:'🥗',label:'Питание'},
  {id:'chat',icon:'💬',label:'Чат'},
  {id:'progress',icon:'📊',label:'Прогресс'},
]

export default function App() {
  const [nav,setNav]=useState('dashboard')
  const [sc,setSC]=useState(null)
  const [isMobile,setIsMobile]=useState(()=>window.innerWidth<768)
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

  const [editTarget,setEditTarget]=useState(null) // {workout, histIdx}

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

  const renderMain=()=>{
    if(nav==='cdetail'&&sc)return <ClientDetail client={sc} goBack={()=>setNav('clients')} />
    switch(nav){
      case 'dashboard': return <Dashboard setNav={setNav} setSC={setSC} />
      case 'clients':   return <ClientsView setSC={setSC} setNav={setNav} />
      case 'workouts':  return <WorkoutsView customExercises={customExercises} setCustomExercises={setCustomExercises} onWorkoutComplete={handleWorkoutComplete} onWorkoutUpdate={handleWorkoutUpdate} editTarget={editTarget} onClearEdit={()=>setEditTarget(null)} />
      case 'nutrition': return <NutritionView />
      case 'library':   return <LibraryView customExercises={customExercises} />
      case 'chat':      return <ChatView />
      case 'progress':  return <ProgressView workoutHistory={workoutHistory} onEditWorkout={handleEditWorkout} />
      default:          return null
    }
  }

  const BOTTOM_NAV_H = 62

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
          <div className="mobile-content" style={{ flex:1, overflowY:'auto', padding:`16px 16px ${BOTTOM_NAV_H + 16}px` }}>
            {renderMain()}
          </div>

          <nav className="bottom-nav" style={{
            position:'fixed', bottom:0, left:0, right:0,
            background:'#fff', borderTop:'1px solid #e5e7eb',
            display:'flex', height:BOTTOM_NAV_H, zIndex:900,
          }}>
            {NAV_MOBILE.map(item=>{
              const active=nav===item.id||(nav==='cdetail'&&item.id==='clients')
              return (
                <button key={item.id} onClick={()=>setNav(item.id)} style={{
                  flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                  gap:3, border:'none', background:'none', cursor:'pointer', padding:'0 2px',
                  position:'relative', minHeight:'unset',
                }}>
                  {/* Индикатор сверху */}
                  <div style={{ position:'absolute', top:0, left:'50%', transform:'translateX(-50%)', width:active?28:0, height:2.5, borderRadius:'0 0 3px 3px', background:PUR, transition:'width 0.18s' }} />
                  <span style={{ fontSize:22, lineHeight:1 }}>{item.icon}</span>
                  <span style={{ fontSize:10, fontWeight:active?700:400, color:active?PUR:'#9ca3af' }}>{item.label}</span>
                </button>
              )
            })}
          </nav>
        </div>
      ) : (
        /* ── ДЕСКТОПНЫЙ LAYOUT ── */
        <div style={{ display:'flex', minHeight:'100vh', fontFamily:'system-ui,sans-serif', background:'#f9fafb' }}>
          <div style={{ width:190, background:'#fff', borderRight:'1px solid #e5e7eb', display:'flex', flexDirection:'column', flexShrink:0 }}>
            <div style={{ padding:'16px 14px 12px', borderBottom:'1px solid #e5e7eb' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <Av lbl="АМ" sz={34} />
                <div>
                  <div style={{ fontSize:13, fontWeight:500, color:'#111' }}>Алексей М.</div>
                  <div style={{ fontSize:11, color:'#9ca3af' }}>Тренер · Владелец</div>
                </div>
              </div>
            </div>
            <nav style={{ padding:'8px', flex:1 }}>
              {NAV.map(item=>(
                <NavBtn key={item.id} {...item} active={nav===item.id||(nav==='cdetail'&&item.id==='clients')} onClick={()=>setNav(item.id)} />
              ))}
            </nav>
            <div style={{ padding:'12px 14px', borderTop:'1px solid #e5e7eb' }}>
              <div style={{ fontSize:12, fontWeight:500, color:'#111' }}>FitPro Platform</div>
              <div style={{ fontSize:10, color:'#9ca3af', marginTop:2 }}>v1.0 · 14 дней пробного</div>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'20px 24px' }}>
            {renderMain()}
          </div>
        </div>
      )}
    </>
  )
}

