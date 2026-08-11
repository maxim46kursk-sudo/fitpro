import { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import AIAssistant from './AIAssistant'
import TrainerSession, { TrainerSessionsList } from './TrainerSession.jsx'
import { supabase, SUPABASE_AUTH_STORAGE_KEY, SUPABASE_URL, SUPABASE_KEY } from './supabase.js'
import { resolveAuthOutcome, AUTH_OUTCOME } from './authState.js'
import { logError } from './logError'
import { FOLDERS, PROGRAMS_MAP, EXERCISES, isOneSidedExercise, countCompletedProgramSlots, isProgramFullyCompleted } from './programs.js'
import { oneRepMax, weightForReps, roundToPlate, percentTable, plateStep } from './oneRepMax.js'
// Движок прогрессии (1ПМ) — врезан в кнопку "▶ Начать тренировку" внутри
// слота шаблонной программы (WorkoutsView), см. подробный комментарий там.
import { buildExerciseAggregates, computeTemplateScale, parseTemplateSets, computeProgressSteps, computeBandTarget, UNRATED_STOP_AFTER } from './workoutPrompt.js'
import { MAX_TELEGRAM_URL, MAX_EMAIL, BOT_USERNAME, realEmail, telegramChatIdOf } from './config.js'
import { Ic } from './icons.jsx'
import { GlassDefs, GlassIcon } from './glassIcons'
import { MuscleDefs } from './muscleIcons'
import { muscleGroup, equipment } from './exerciseMeta'
import { POLICY_VERSION, POLICY_SECTIONS, CONSENT_SECTIONS, CONSENT_CHECKBOX, DATA_ATTRIBUTION } from './legalText'
import { VIP, VIP_LEVEL, FEATURES, TEST_MODE, TRIAL_DAYS, planByKey, priceOf, effectiveAccess, visiblePlans, daysOfPlan, PLAN_DAYS_DEFAULT } from './plans'
// clampNum нужен полям профиля (вес/рост). Пределы питания уехали вместе с
// разделом в src/FoodDiary.jsx.
import { clampNum } from './nutrition.js'
import FoodDiary from './FoodDiary.jsx'
import HubCard from './HubCard.jsx'
// Совместимость с телефоном: закрытие меню тапом мимо без плёнки-перехватчика
// и подтверждение действия, работающее внутри Telegram (window.confirm там
// заблокирован). Подробности и причины — в src/uiCompat.js.
import { useCloseOnOutsideTap, askConfirm } from './uiCompat.js'
// Конструктор тренировок — размораживается по этапам (docs/CONSTRUCTOR_FROZEN.md).
// Этап 1: экран снова в навигации, но вход к нему открыт ТОЛЬКО тренеру (см.
// кнопку в WorkoutsView и case 'constructor' в renderOther) — клиент его не
// видит и попасть в него не может.
import ConstructorView from './ConstructorView.jsx'
import './App.css'

// ── Тёмная тема (единая палитра, шаг 1: каркас + экран «Тренировки»).
// Акцентные имена (PUR/TEA/BLU/COR) сохранены — переопределены на новые
// значения, чтобы новый цвет подхватился везде, где они уже используются.
const BG = '#0b0b0d'                    // фон страницы
const SURF = '#1c1c1e'                  // карточки/поверхности
const SURF2 = '#2c2c2e'                 // вложенное/инпуты
const SEP = 'rgba(255,255,255,0.09)'    // разделители
const HAIR = 'rgba(255,255,255,0.12)'   // тонкие границы
const TXT = '#ffffff'                   // основной текст
const TXT2 = 'rgba(235,235,245,0.62)'   // вторичный текст
const TXT3 = 'rgba(235,235,245,0.30)'   // приглушённый текст
const PUR = '#7C7AF0'                    // акцент
const ACCENT2 = '#9D96FF'               // акцент (ярче, активные состояния)
const TEA = '#30D158'                    // зелёный / белок
const BLU = '#0A84FF'                    // синий / углеводы
const COR = '#FF9F0A'                    // оранжевый / жиры
const KCAL = '#BF5AF2'                   // калории
const DANGER = '#FF453A'                 // ошибки / удаление

const clearFitproData = () => {
  Object.keys(localStorage)
    .filter(k => k.startsWith('fitpro_'))
    .forEach(k => localStorage.removeItem(k))
}

// "Сегодня" по МЕСТНОМУ времени клиента, а не по UTC. new Date().toISOString()
// всегда отдаёт дату в UTC — поздним вечером/ночью (когда местное время уже
// перевалило за полночь, а UTC ещё нет, или наоборот) это давало дефолт даты
// тренировки, отличающийся от реального календарного дня клиента, пока
// дневник питания (foodDate в DiaryView) уже был локальным — тренировка и еда
// одного вечера расходились по дням.
const localTodayISO = () => { const d = new Date(); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}` }

// Жёсткие пределы числовых полей питания/профиля — без них отрицательные
// или гигантские значения (ккал −9999 или 1e9, вес 1e9) ломают суммы дня,
// графики и расчёт нормы КБЖУ (calcMacroGoals, aiPrompt.js). Клампим ПРИ
// СОХРАНЕНИИ (жёстко, в коде) — HTML min/max на инпутах ниже это только
// подсказка браузеру, её легко обойти (вставка, автозаполнение, DevTools).
//
// Пределы питания (CAL_*/MACRO_*) и сам clampNum переехали в src/nutrition.js
// и импортируются выше: те же значения нужны сканеру штрих-кода, который
// считает КБЖУ порции у себя, а импортировать их из App.jsx не может —
// App.jsx подгружает сканер лениво, вышло бы кольцо.
const PROFILE_WEIGHT_MIN = 0, PROFILE_WEIGHT_MAX = 500
const PROFILE_HEIGHT_MIN = 0, PROFILE_HEIGHT_MAX = 300

const BADGE = {
  'Сила':        { bg:'#EEEDFE', tx:'#3C3489' },
  'Кардио':      { bg:'#E1F5EE', tx:'#085041' },
  'HIIT':        { bg:'#FAECE7', tx:'#712B13' },
  'Похудение':   { bg:'#E1F5EE', tx:'#085041' },
  'Набор массы': { bg:'#EEEDFE', tx:'#3C3489' },
  'Выносливость':{ bg:'#E6F1FB', tx:'#0C447C' },
}

const WORKOUT_ACTIONS = [
  { key:'start', icon:'play', label:'Начать тренировку',   desc:'Запустить тренировку прямо сейчас' },
  { key:'done',  icon:'check', label:'Добавить выполненную', desc:'Записать уже проведённую тренировку' },
]


// ── UI компоненты
function Av({ lbl, sz=36, bg=PUR, photo, gender }) {
  if (photo) return (
    <div style={{ width:sz, height:sz, borderRadius:'50%', flexShrink:0, overflow:'hidden' }}>
      <img src={photo} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
    </div>
  )
  const genderEmoji = gender==='female' ? '👩' : gender==='male' ? '👨' : null
  return (
    <div style={{ width:sz, height:sz, borderRadius:'50%', background:genderEmoji?SURF2:bg, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:genderEmoji?Math.round(sz*.52):Math.round(sz*.35), fontWeight:500, flexShrink:0 }}>
      {genderEmoji || lbl}
    </div>
  )
}

const MUSCLE_LABELS = { chest:'Грудь', back:'Спина', legs:'Ноги', shoulders:'Плечи',
  arms:'Руки', abs:'Пресс', cardio:'Кардио' }
// Справочник по названию: у упражнений из программы поля m/eq приходят пустыми
// (см. сборку wExercises), а в EXERCISES они заполнены руками и точнее любой
// эвристики — на 68 из 76 упражнений разбор по названию даёт другой ответ.
const EX_BY_NAME = new Map(EXERCISES.map(e => [e.n, e]))

// Эффективный каталог упражнений = зашитый EXERCISES + правки тренера из
// глобального catalog_exercises. Раздаётся через контекст, чтобы все списки и
// пикеры (LibraryView, WorkoutsView, ProgramEditor) брали один и тот же набор.
// value: { exercises: [{n,m,eq,type}], reloadCatalog }.
const CatalogContext = createContext({ exercises: EXERCISES, reloadCatalog: () => {} })

// Контекст выбора видео по папке шаблона (зал/дом).
const FOLDER_CTX_FALLBACK = key => key === 'Домашние тренировки' ? 'dom' : 'zal'

// Шаблоны программ = зашитые FOLDERS/PROGRAMS_MAP + program_templates из базы.
// Раздаётся через контекст: { folders:[{key,label,context}] (по sort),
// structures:{key→structure} }. Ключ key НЕ меняется никогда — за него держатся
// profiles.program, префикс названий workouts, localStorage. На экран — label.
const TemplatesContext = createContext(mergeTemplates([]))

// По образцу mergeCatalog: строка из базы перекрывает зашитое; hidden → папка
// скрыта; ключа нет в базе → берём из кода (запасной вариант, если база молчит).
function mergeTemplates(rows) {
  const byKey = new Map((rows || []).map(r => [r.key, r]))
  const folders = []
  const structures = {}
  const seen = new Set()
  FOLDERS.forEach((key, i) => {
    seen.add(key)
    const r = byKey.get(key)
    if (r?.hidden) return
    folders.push({ key, label: (r && r.display_name) || key, context: (r && r.context) || FOLDER_CTX_FALLBACK(key), sort: r ? r.sort : i })
    structures[key] = (r && Array.isArray(r.structure) && r.structure.length) ? r.structure : PROGRAMS_MAP[key]
  })
  for (const r of rows || []) {
    if (seen.has(r.key) || r.hidden) continue
    folders.push({ key: r.key, label: r.display_name || r.key, context: r.context || 'zal', sort: r.sort ?? 0 })
    structures[r.key] = Array.isArray(r.structure) ? r.structure : []
  }
  folders.sort((a, b) => a.sort - b.sort)
  return { folders: folders.map(({ key, label, context, sort }) => ({ key, label, context, sort })), structures }
}

// Сливает зашитый EXERCISES с записями catalog_exercises по имени:
//  - hidden=true  → упражнение исключается;
//  - hidden=false → мета из каталога переопределяет зашитую;
//  - имени нет в EXERCISES → добавляется как новое.
function mergeCatalog(rows) {
  const byName = new Map((rows || []).map(r => [r.name, r]))
  const out = []
  const usedNames = new Set()
  for (const e of EXERCISES) {
    const c = byName.get(e.n)
    if (c?.hidden) { usedNames.add(e.n); continue }
    // n — КЛЮЧ (не меняется никогда), label — что показываем пользователю.
    if (c) out.push({ n: e.n, m: c.muscle_group || e.m, eq: c.equipment || e.eq, type: c.type || e.type, technique: c.technique || '', label: c.display_name || e.n })
    else out.push({ ...e, technique: '', label: e.n })
    usedNames.add(e.n)
  }
  for (const r of rows || []) {
    if (usedNames.has(r.name) || r.hidden) continue
    out.push({ n: r.name, m: r.muscle_group || '', eq: r.equipment || '', type: r.type || 'compound', technique: r.technique || '', label: r.display_name || r.name })
  }
  return out
}

// Отображаемое имя по ключу. Нужно там, где на руках только ключ (история,
// дневник): если упражнения нет в каталоге — возвращаем сам ключ.
function labelOf(catalogExercises, name){
  const e = (catalogExercises || []).find(x => x.n === name)
  return (e && e.label) || name
}

// Подпись персональной программы клиенту. Пусто ИЛИ старое дефолтное 'Программа'
// (у уже созданных программ в базе лежит именно оно) → «Персональная программа»,
// иначе то, что написал тренер.
function programTitle(title){
  const t = (title || '').trim()
  return (!t || t === 'Программа') ? 'Персональная программа' : t
}

// Выбор ролика из двухуровневой карты видео { имя → { контекст → {…} } }.
// Порядок: точный контекст → общий (default) → любой имеющийся (zal/dom). Так
// видео не пропадает, если для нужного контекста ролик ещё не снят.
function pickVideo(map, name, ctx){
  const e = map?.[name]
  if(!e) return null
  return (ctx && e[ctx]) || e.default || e.zal || e.dom || null
}

// Мелкая строка под названием упражнения: группа мышц · снаряд.
// Порядок источников — от точного к приблизительному: поля переданного
// упражнения, затем справочник EXERCISES, и только потом эвристика
// src/exerciseMeta.js (нужна для пользовательских упражнений, их в справочнике
// нет). Если не определилось ни то ни другое — строки нет, пустое место не занимаем.
function ExMeta({ name, m, eq, style={} }) {
  const known = EX_BY_NAME.get(name)
  const group = m || known?.m || MUSCLE_LABELS[muscleGroup(name)] || ''
  const gear = eq || known?.eq || equipment(name)?.label || ''
  const text = [group, gear].filter(Boolean).join(' · ')
  if (!text) return null
  return <div style={{ fontSize:12, color:TXT2, marginTop:2, ...style }}>{text}</div>
}

function Card({ children, style={}, onClick }) {
  return (
    <div onClick={onClick} style={{ background:SURF, border:`1px solid ${HAIR}`, borderRadius:20, padding:'14px 16px', ...style }}>
      {children}
    </div>
  )
}

function Metric({ label, value, icon, color=PUR }) {
  return (
    <div style={{ background:SURF2, borderRadius:16, padding:'12px 14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
        <span style={{ fontSize:11, color:TXT3 }}>{label}</span>
        <span style={{ fontSize:16, color }}>{icon}</span>
      </div>
      <div style={{ fontSize:22, fontWeight:500, color:TXT }}>{value}</div>
    </div>
  )
}

function PBar({ v, color=PUR }) {
  return (
    <div style={{ background:'rgba(255,255,255,.07)', borderRadius:4, height:5, marginTop:4 }}>
      <div style={{ width:`${v}%`, background:color, borderRadius:4, height:'100%' }} />
    </div>
  )
}

function Badge({ lbl }) {
  const c = BADGE[lbl] || { bg:'#f3f4f6', tx:'#6b7280' }
  return <span style={{ fontSize:10, padding:'2px 7px', borderRadius:20, background:c.bg, color:c.tx, fontWeight:500 }}>{lbl}</span>
}

function NavBtn({ ic, color, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ width:'100%', display:'flex', alignItems:'center', gap:9, padding:'8px 10px', borderRadius:8, border:'none', background:active?PUR:'transparent', color:active?'#fff':TXT3, fontSize:13, textAlign:'left', marginBottom:2, cursor:'pointer' }}>
      <GlassIcon name={ic} size={26} style={{opacity:active?1:.55}} />{label}
    </button>
  )
}

// Шапка "назад" (DiaryView) и Toggle/Row/Section (SettingsView) — вынесены
// на верхний уровень модуля из тел родительских компонентов: определения
// внутри функции-компонента пересоздаются на каждый ререндер, из-за чего
// React считает их НОВЫМ типом компонента и перемонтирует поддерево целиком
// (мигание, сброс фокуса в инпутах). Поведение не менялось — только
// перемещение plus проброс того, что раньше бралось из замыкания, пропсами.
function BackBtn({ label, right, onBack }) {
  return (
    <div style={{ background:SURF, borderBottom:`1px solid ${HAIR}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:14, flexShrink:0, position:'sticky', top:0, zIndex:10 }}>
      <button data-back="1" onClick={onBack} style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:TXT3, lineHeight:1, padding:0, minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
      <span style={{ fontSize:17, fontWeight:700, color:TXT, flex:1 }}>{label}</span>
      {right}
    </div>
  )
}

// Настройки уведомлений: у каждого — вкл/выкл, время и дни недели (по getDay:
// 0=Вс…6=Сб). Отправку сделаем отдельно, пока храним в profiles.notifs.
const NOTIF_DEFAULTS={
  workout:{enabled:false,time:'18:00',days:[1,2,3,4,5]},
  diary:{enabled:false,time:'21:00',days:[0,1,2,3,4,5,6]},
}
// Приводит любой сохранённый формат к новому. Старое значение было булевым
// (notifs.workout===true) — заворачиваем в объект с дефолтным временем/днями;
// частичный объект дополняем недостающими полями.
const normalizeNotifs=raw=>{
  const src=raw&&typeof raw==='object'?raw:{}
  const out={}
  for(const key of Object.keys(NOTIF_DEFAULTS)){
    const def=NOTIF_DEFAULTS[key]
    const v=src[key]
    if(typeof v==='boolean')out[key]={enabled:v,time:def.time,days:[...def.days]}
    else if(v&&typeof v==='object')out[key]={
      enabled:typeof v.enabled==='boolean'?v.enabled:def.enabled,
      time:typeof v.time==='string'?v.time:def.time,
      days:Array.isArray(v.days)?v.days:[...def.days],
    }
    else out[key]={enabled:def.enabled,time:def.time,days:[...def.days]}
  }
  return out
}
// Дни недели для чипов: подпись + номер по getDay (Пн=1…Сб=6, Вс=0).
const WEEKDAYS=[
  {n:1,l:'Пн'},{n:2,l:'Вт'},{n:3,l:'Ср'},{n:4,l:'Чт'},{n:5,l:'Пт'},{n:6,l:'Сб'},{n:0,l:'Вс'},
]

function Toggle({ on, onToggle }) {
  return (
    <button onClick={onToggle} style={{
      width:44, height:24, borderRadius:12, border:'none', cursor:'pointer', padding:0,
      background:on?PUR:'#d1d5db', transition:'background 0.2s', position:'relative', flexShrink:0, minHeight:'unset',
    }}>
      <span style={{
        position:'absolute', top:2, left:on?22:2, width:20, height:20, borderRadius:'50%',
        background:SURF, transition:'left 0.2s', boxShadow:'0 1px 3px #0002', display:'block',
      }}/>
    </button>
  )
}

function Row({ label, sub, right }) {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'13px 0',borderBottom:`1px solid ${HAIR}`}}>
      <div>
        <div style={{fontSize:15,color:TXT,fontWeight:500}}>{label}</div>
        {sub&&<div style={{fontSize:12,color:TXT3,marginTop:2}}>{sub}</div>}
      </div>
      {right}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{background:SURF,borderRadius:14,padding:'0 16px',marginBottom:14,boxShadow:'0 1px 4px #0000000a'}}>
      <div style={{fontSize:12,fontWeight:700,color:TXT3,padding:'14px 0 6px',letterSpacing:'0.5px',textTransform:'uppercase'}}>{title}</div>
      {children}
    </div>
  )
}

// ── Единая подсказка «нужен пакет повыше». Одна вёрстка на все точки блокировки,
// чтобы формулировка и кнопка не разъезжались по экранам.
function PlanLockNotice({ title, text, onOpenPlans }) {
  return (
    <div style={{textAlign:'center',padding:'8px 4px'}}>
      <div style={{
        width:56,height:56,borderRadius:'50%',margin:'0 auto 14px',
        background:`${PUR}20`,border:`1px solid ${PUR}40`,
        display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,
      }}>🔒</div>
      <div style={{fontSize:17,fontWeight:800,color:TXT,marginBottom:8}}>{title}</div>
      {text&&<div style={{fontSize:13,lineHeight:1.55,color:TXT2,maxWidth:320,margin:'0 auto 18px'}}>{text}</div>}
      <button onClick={onOpenPlans} style={{
        width:'100%',maxWidth:280,padding:'13px',borderRadius:13,border:'none',
        background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',
        fontSize:15,fontWeight:700,cursor:'pointer',boxShadow:`0 8px 24px ${PUR}45`,
      }}>Открыть тарифы</button>
    </div>
  )
}

// Та же подсказка модалкой — для мест, где нет отдельного экрана (список слотов,
// пункт меню Дневника).
function PlanLockModal({ title, text, onClose, onOpenPlans }) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
      onClick={onClose}>
      <div style={{background:SURF,borderRadius:18,padding:'24px 22px',width:'100%',maxWidth:360,boxShadow:'0 20px 60px rgba(0,0,0,0.45)'}}
        onClick={e=>e.stopPropagation()}>
        <PlanLockNotice title={title} text={text} onOpenPlans={onOpenPlans} />
        <button onClick={onClose} style={{
          display:'block',margin:'12px auto 0',padding:'8px 14px',border:'none',background:'none',
          color:TXT3,fontSize:14,fontWeight:500,cursor:'pointer',minHeight:'unset',
        }}>Закрыть</button>
      </div>
    </div>
  )
}

// Тексты гейтов — в одном месте, чтобы не расходились между точками блокировки.
const LOCK_SLOTS = { title:'Тренировки 4–12 доступны в пакете БАЗА', text:'В СТАРТ открыты первые 3 тренировки в каждом шаблоне. БАЗА открывает все тренировки во всех четырёх шаблонах.' }
const LOCK_EXERCISES = { title:'Прогресс по упражнениям доступен в пакете БАЗА', text:'Покажет динамику весов и повторений по каждому упражнению за любой период.' }
// Со скольки слотов начинается платная часть шаблона и какой уровень нужен.
const FREE_SLOTS = 3
const SLOTS_MIN_LEVEL = 1

// Иконка карточки группы мышц. В наборе GlassIcon анатомии нет, поэтому связь
// ассоциативная — задача иконки здесь отличать карточки друг от друга, смысл
// несёт подпись под ней. Анатомический силуэт (muscleIcons.jsx) сюда просится,
// но его сознательно откатили раньше (см. комментарий у <MuscleDefs/> в конце
// файла) — не возвращаем.
const GROUP_ICON = {
  'Ноги': 'runner', 'Ягодицы': 'target', 'Спина': 'ruler', 'Грудь': 'dumbbell',
  'Плечи': 'lightning', 'Руки': 'flame', 'Кор': 'droplet', 'Всё тело': 'people',
}

// ── Экраны
// workoutHistory приходит пропом из App, а не читается из localStorage прямо в
// рендере, как было раньше. Чтение из localStorage тут было НЕреактивным: когда
// App догружал историю из Supabase, этот компонент про это не узнавал и не
// перерисовывался — на главной висели цифры из кэша до ближайшего
// перемонтирования. Источник правды один и тот же для всех экранов.
function Dashboard({ setNav, setSC, isTrainer, userId, workoutHistory = [] }) {
  const foodDiary = (() => { try { return JSON.parse(localStorage.getItem('fitpro_food_diary')||'{}') } catch { return {} } })()
  const foodDays = Object.keys(foodDiary).length

  // Реальные клиенты тренера — те же, что на экране «Клиенты» (profiles с
  // coach_id=мой uid). Best-effort: главная не должна падать из-за этого
  // запроса, при ошибке список просто остаётся пустым.
  const [realClients,setRealClients]=useState([])
  useEffect(()=>{
    if(!userId)return
    let cancelled=false
    supabase.from('profiles').select('id,name,tg_username,plan,plan_until').eq('coach_id',userId).then(({data,error})=>{
      if(cancelled)return
      if(error){console.error('Главная: ошибка загрузки клиентов тренера:',error);return}
      setRealClients(data||[])
    })
    return()=>{cancelled=true}
  },[userId])
  const quickActions = [
    {icon:'people',label:'Клиенты',nav:'clients'},
    {icon:'dumbbell',label:'Тренировки',nav:'workouts'},
    {icon:'food',label:'Питание',nav:'nutrition'},
    {icon:'book',label:'Упражнения',nav:'library'},
    {icon:'notebook',label:'Дневник',nav:'progress'},
  ]

  return (
    <div>
      <div style={{ marginBottom:18 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:TXT, margin:0 }}>Добро пожаловать 👋</h2>
        <p style={{ fontSize:13, color:TXT3, marginTop:4 }}>Твоя платформа для тренеров</p>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
        <Metric label="Клиентов" value={realClients.length} icon="👥" color={PUR} />
        <Metric label="Тренировок" value={workoutHistory.length} icon={<GlassIcon name="dumbbell" size={22} />} color={TEA} />
        <Metric label="Дней питания" value={foodDays} icon={<GlassIcon name="food" size={22} />} color={BLU} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        {isTrainer&&(
          <Card>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <span style={{ fontWeight:500, color:TXT }}>Клиенты</span>
              <button onClick={()=>setNav('clients')} style={{ fontSize:12, color:PUR, border:'none', background:'none', cursor:'pointer' }}>Все →</button>
            </div>
            {realClients.length===0?(
              <div style={{ fontSize:13, color:TXT3, padding:'4px 0' }}>Пока нет клиентов</div>
            ):realClients.slice(0,5).map(c=>{
              const label=c.name?.trim()||'Без имени'
              const initials=label.split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'КЛ'
              const sub=clientSubStatus(c.plan,c.plan_until)
              return (
                <div key={c.id} onClick={()=>{setSC({id:c.id,name:c.name||'Без имени',tg_username:c.tg_username||null,isReal:true});setNav('cdetail')}}
                  style={{ display:'flex', alignItems:'center', gap:9, padding:'7px 0', borderBottom:`1px solid ${HAIR}`, cursor:'pointer' }}>
                  <Av lbl={initials} sz={30} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:TXT }}>{label}</div>
                    <div style={{ fontSize:11, fontWeight:600, color:sub.color, marginTop:2 }}>{sub.text}</div>
                  </div>
                </div>
              )
            })}
          </Card>
        )}
        <Card>
          <div style={{ fontWeight:500, color:TXT, marginBottom:12 }}>Быстрые действия</div>
          {quickActions.map(a=>(
            <button key={a.label} onClick={()=>setNav(a.nav)} style={{ width:'100%', display:'flex', alignItems:'center', gap:9, padding:'8px 10px', marginBottom:6, background:SURF2, border:'none', borderRadius:8, cursor:'pointer', textAlign:'left' }}>
              <GlassIcon name={a.icon} size={24} /><span style={{ fontSize:13, color:TXT }}>{a.label}</span>
            </button>
          ))}
        </Card>
      </div>
    </div>
  )
}

// Локальная дата дд.мм — тот же паддинг-подход, что и у localTodayISO() выше.
const fmtDDMM=d=>{const dt=new Date(d);const p=n=>String(n).padStart(2,'0');return `${p(dt.getDate())}.${p(dt.getMonth()+1)}`}

const pluralizeDays=n=>{
  const t=n%10, h=n%100
  if(t===1&&h!==11)return 'день'
  if([2,3,4].includes(t)&&![12,13,14].includes(h))return 'дня'
  return 'дней'
}
const pluralizeWorkouts=n=>{
  const t=n%10, h=n%100
  if(t===1&&h!==11)return 'тренировка'
  if([2,3,4].includes(t)&&![12,13,14].includes(h))return 'тренировки'
  return 'тренировок'
}
// Статус подписки клиента для карточек тренера — на главной и на экране
// «Клиенты» он должен читаться одинаково, поэтому хелпер общий. Источник
// правды — planUntil: пустой означает, что клиента привязали вручную, а не
// оплатой. Возвращает { text, color }.
const clientSubStatus=(plan,planUntil)=>{
  if(!planUntil)return{text:'Без подписки',color:TXT3}
  const leftMs=new Date(planUntil).getTime()-Date.now()
  if(!(leftMs>0))return{text:'Подписка закончилась',color:DANGER}
  const days=Math.ceil(leftMs/86400000)
  return{
    text:`осталось ${days} ${pluralizeDays(days)}`,
    color:days<=3?COR:TEA,   // оранжевый = вот-вот истечёт
  }
}

// Модалка со ссылкой доступа клиента: показывается после заведения клиента
// (ClientsView) и после перевыпуска ссылки (RealClientDetail). Вёрстка — копия
// модалки «Пригласить клиента» ниже, чтобы два похожих окна не выглядели
// по-разному.
//
// Ссылка содержит открытый токен, поэтому она НИГДЕ не логируется: ни в
// console.log, ни в журнал ошибок. Показать её повторно нельзя — в базе только
// sha256-хэш; если тренер потерял ссылку, он выпускает новую.
function AccessLinkModal({ link, clientName, onClose }) {
  const [copied,setCopied]=useState(false)
  const [copyFailed,setCopyFailed]=useState(false)
  const copy=async()=>{
    try{
      await navigator.clipboard.writeText(link)
      setCopied(true);setTimeout(()=>setCopied(false),2000)
    }catch(e){
      // Сообщение ошибки печатаем без самой ссылки.
      console.error('Не удалось скопировать ссылку доступа:',e?.message||e)
      setCopyFailed(true);setTimeout(()=>setCopyFailed(false),3500)
    }
  }
  return (
    <>
      {copied&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:2400, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:TEA, color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(48,209,88,0.35)',
        }}>
          Скопировано
        </div>
      )}
      {copyFailed&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:2400, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
        }}>
          Не удалось скопировать — выдели ссылку и скопируй вручную
        </div>
      )}
      <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}
        onClick={onClose}>
        <div style={{ background:SURF,borderRadius:16,padding:'24px 22px',width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14 }}>
            <span style={{ fontSize:16,fontWeight:700,color:TXT }}>Ссылка для входа</span>
            <button onClick={onClose} style={{ background:'none',border:'none',fontSize:20,cursor:'pointer',color:TXT3,lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
          </div>
          <div style={{ fontSize:13,color:TXT2,lineHeight:1.45,marginBottom:10 }}>
            Отправь эту ссылку{clientName?<> клиенту <b style={{color:TXT}}>{clientName}</b></>:' клиенту'} любым мессенджером или СМС.
            Регистрироваться ему не нужно — он просто откроет ссылку и окажется в приложении.
          </div>
          <div style={{ fontSize:12,color:TXT3,lineHeight:1.45,marginBottom:14 }}>
            Ссылка действует 7 дней, открыть её можно несколько раз. Когда срок выйдет — выдай новую
            в карточке клиента.
          </div>
          <input value={link} readOnly onFocus={e=>e.target.select()} onClick={e=>e.target.select()}
            style={{ width:'100%',padding:'10px 12px',fontSize:12,borderRadius:9,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT,background:SURF2,marginBottom:12 }} />
          <button onClick={copy} style={{ width:'100%',padding:'12px',fontSize:14,borderRadius:14,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontWeight:800,cursor:'pointer',boxShadow:'0 8px 22px rgba(124,122,240,.4)' }}>Копировать</button>
        </div>
      </div>
    </>
  )
}

function ClientsView({ setSC, setNav, userId }) {
  const [q,setQ]=useState('')
  const [showAdd,setShowAdd]=useState(false)
  // Программы в форме нет намеренно: у настоящего клиента она задаётся в его
  // карточке (ProgramEditor), а не при заведении.
  const [addForm,setAddForm]=useState({name:'',goal:'Похудение'})
  const [creating,setCreating]=useState(false)
  // Ссылка доступа только что заведённого клиента — показывается модалкой один
  // раз: сервер отдаёт открытый токен единственный раз в ответе, в базе лежит
  // только его хэш, и достать ссылку заново нельзя — можно лишь перевыпустить.
  const [accessLink,setAccessLink]=useState(null)   // {url,name} | null
  const [localClients,setLocalClients]=useState(()=>{
    try{ return JSON.parse(localStorage.getItem('fitpro_local_clients')||'[]') }catch{ return [] }
  })
  // Тост ошибки записи/удаления клиента — тот же паттерн, что showFoodSaveError
  // в DiaryView, своя копия т.к. компонент отдельный.
  const [showClientSaveError,setShowClientSaveError]=useState(false)
  const flashClientSaveError=()=>{setShowClientSaveError(true);setTimeout(()=>setShowClientSaveError(false),3500)}

  // ── Ссылка-приглашение тренера ───────────────────────────────────────────
  // startapp прилетает клиенту как start_param и разбирается в App
  // (pendingInviteRef) — сама привязка идёт через api/link-client.js.
  const [showInvite,setShowInvite]=useState(false)
  const [showCopied,setShowCopied]=useState(false)
  const flashCopied=()=>{setShowCopied(true);setTimeout(()=>setShowCopied(false),2000)}
  const inviteLink=userId?`https://t.me/${BOT_USERNAME}?startapp=coach_${userId}`:''
  // Тот же критерий «мы правда внутри Telegram», что и в App (initData пуст в
  // обычном браузере, хотя объект WebApp там есть — SDK грузится всегда).
  const inTelegram=!!window.Telegram?.WebApp?.initData
  const copyInvite=async()=>{
    try{
      await navigator.clipboard.writeText(inviteLink)
      flashCopied()
    }catch(e){
      console.error('Не удалось скопировать ссылку-приглашение:',e)
      flashClientSaveError()
    }
  }
  const shareInvite=()=>{
    if(window.Telegram?.WebApp)window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(inviteLink)}`)
  }

  // Клиенты, добавленные тренером вручную — подтягиваются из Supabase (единый
  // список на любом устройстве); локальные без supabaseId переносятся один раз.
  useEffect(()=>{
    if(!userId)return
    let cancelled=false
    ;(async()=>{
      let local
      try{local=JSON.parse(localStorage.getItem('fitpro_local_clients')||'[]')}catch{local=[]}
      const toMigrate=local.filter(c=>!c.supabaseId)
      for(const c of toMigrate){
        const{data,error}=await supabase.from('trainer_clients').insert({trainer_id:userId,name:c.name,goal:c.goal||null,program:c.program||null,progress:c.progress||0}).select('id').single()
        if(error)console.error('Миграция клиента: ошибка вставки:',error)
        else if(data)c.supabaseId=data.id
      }
      if(toMigrate.length)localStorage.setItem('fitpro_local_clients',JSON.stringify(local))
      const{data:rows,error}=await supabase.from('trainer_clients').select('*').eq('trainer_id',userId)
      if(cancelled||error||!rows)return
      const mapped=rows.map(r=>{
        const initials=r.name.trim().split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'КЛ'
        return{id:r.id,supabaseId:r.id,name:r.name,goal:r.goal||'',program:r.program||'Без программы',progress:r.progress||0,av:initials,cal:0,wk:0,wts:[],isLocal:true}
      })
      setLocalClients(mapped)
      localStorage.setItem('fitpro_local_clients',JSON.stringify(mapped))
    })()
    return()=>{cancelled=true}
  },[userId])

  // «+ Добавить» заводит НАСТОЯЩЕГО клиента: сервер создаёт ему аккаунт и
  // отдаёт ссылку доступа (api/link-client.js, action='create_client'). Клиент
  // ничего не регистрирует — просто открывает ссылку.
  //
  // Раньше эта кнопка создавала карточку-заметку в trainer_clients («очный
  // клиент»). Ни таблица, ни блок «Очные клиенты» не тронуты — там остаются
  // старые карточки, просто новые туда больше не добавляются.
  const createRealClient=async()=>{
    const name=addForm.name.trim()
    if(!name||creating)return
    setCreating(true)
    try{
      const{data:sessionData}=await supabase.auth.getSession()
      const token=sessionData?.session?.access_token
      if(!token){console.error('Создание клиента: нет access-токена тренера');flashClientSaveError();return}
      const res=await fetch('/api/link-client',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        // goal сервер кладёт в profiles.goal того же нового клиента.
        body:JSON.stringify({action:'create_client',name,goal:addForm.goal||null}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok||!body.token){
        // В консоль и в журнал уходит только статус и текст ошибки — сам токен
        // не логируется нигде: он равносилен паролю клиента.
        console.error('Создание клиента: сервер отказал',res.status,body?.error||'')
        logError('create_client',{message:body?.error||'нет токена в ответе',status:res.status})
        flashClientSaveError()
        return
      }
      setAddForm({name:'',goal:'Похудение'})
      setShowAdd(false)
      loadRealClients()
      setAccessLink({url:`${window.location.origin}/?access=${body.token}`,name})
    }catch(e){
      console.error('Создание клиента: сетевая ошибка:',e)
      logError('create_client',{message:e?.message})
      flashClientSaveError()
    }finally{
      setCreating(false)
    }
  }

  const deleteLocal=async(id)=>{
    const target=localClients.find(c=>c.id===id)
    if(target?.supabaseId!=null){
      const{error}=await supabase.from('trainer_clients').delete().eq('id',target.supabaseId)
      if(error){console.error('Ошибка удаления клиента:',error);flashClientSaveError();return}
    }
    setLocalClients(list=>{
      const next=list.filter(c=>c.id!==id)
      localStorage.setItem('fitpro_local_clients',JSON.stringify(next))
      return next
    })
  }

  // Только карточки, заведённые тренером вручную. Зашитые демо-клиенты отсюда
  // убраны вместе с самим массивом — список показывает лишь настоящие данные.
  const allClients=[...localClients]
  const fl=allClients.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()))

  // Реальные клиенты тренера — из profiles (coach_id=мой uid), а не демо-
  // список ниже. RLS в базе уже разрешает тренеру читать чужие профили с
  // его coach_id — здесь просто читаем, ничего не пишем.
  const [realClients,setRealClients]=useState([])
  const [realClientsLoading,setRealClientsLoading]=useState(true)
  const [realClientsError,setRealClientsError]=useState(false)
  // Сводка активности (сколько тренировок и когда последняя) — по id клиента.
  // Best-effort: список клиентов уже отрисован к этому моменту, ошибка этого
  // запроса не должна ломать основной блок — только логируется.
  const [clientActivity,setClientActivity]=useState({})
  const loadRealClients=async()=>{
    if(!userId)return
    setRealClientsLoading(true);setRealClientsError(false)
    // email тянем вместе с остальным: у клиента без @ника это ЕДИНСТВЕННЫЙ
    // способ с ним связаться, а ради него отдельный запрос гонять незачем.
    // RLS уже пускает тренера в профили своих клиентов целиком (правило
    // построчное, не поколоночное), новых прав тут не нужно.
    const{data,error}=await supabase.from('profiles').select('id,name,email,tg_username,plan,plan_until,goal,weight,height').eq('coach_id',userId)
    if(error){console.error('Ошибка загрузки клиентов тренера:',error);setRealClientsError(true);setRealClientsLoading(false);return}
    const clients=data||[]
    setRealClients(clients)
    setRealClientsLoading(false)
    if(!clients.length)return
    const{data:workoutRows,error:wError}=await supabase.from('workouts').select('user_id,date').in('user_id',clients.map(c=>c.id))
    if(wError){console.error('Ошибка загрузки активности клиентов:',wError);return}
    const summary={}
    for(const w of workoutRows||[]){
      const s=(summary[w.user_id]??={count:0,lastDate:null})
      s.count++
      if(!s.lastDate||w.date>s.lastDate)s.lastDate=w.date
    }
    setClientActivity(summary)
  }
  useEffect(()=>{loadRealClients()},[userId])

  const openRealClient=(c)=>{
    // Объект собирается вручную (не спредом), поэтому каждое новое поле надо
    // проводить явно — иначе оно молча не доедет до RealClientDetail.
    setSC({id:c.id,name:c.name||'Без имени',tg_username:c.tg_username||null,email:c.email||null,isReal:true})
    setNav('cdetail')
  }

  return (
    <div>
      {showClientSaveError&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
        }}>
          Не удалось сохранить — проверь связь и повтори
        </div>
      )}
      {showCopied&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:2400, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:TEA, color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(48,209,88,0.35)',
        }}>
          Скопировано
        </div>
      )}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:TXT, margin:0 }}>Клиенты</h2>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={()=>setShowInvite(true)} style={{ fontSize:13, padding:'7px 14px', background:'none', color:PUR, border:`1px solid ${PUR}`, borderRadius:8, cursor:'pointer' }}>Пригласить</button>
          <button onClick={()=>setShowAdd(true)} style={{ fontSize:13, padding:'7px 14px', background:PUR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>+ Добавить</button>
        </div>
      </div>

      {showInvite&&(
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}
          onClick={()=>setShowInvite(false)}>
          <div style={{ background:SURF,borderRadius:16,padding:'24px 22px',width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14 }}>
              <span style={{ fontSize:16,fontWeight:700,color:TXT }}>Пригласить клиента</span>
              <button onClick={()=>setShowInvite(false)} style={{ background:'none',border:'none',fontSize:20,cursor:'pointer',color:TXT3,lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ fontSize:13,color:TXT2,lineHeight:1.45,marginBottom:14 }}>
              Отправь эту ссылку клиенту. Когда он откроет её и войдёт — он станет твоим клиентом.
            </div>
            <input value={inviteLink} readOnly onFocus={e=>e.target.select()} onClick={e=>e.target.select()}
              style={{ width:'100%',padding:'10px 12px',fontSize:12,borderRadius:9,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT,background:SURF2,marginBottom:12 }} />
            <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
              <button onClick={copyInvite} style={{ width:'100%',padding:'12px',fontSize:14,borderRadius:14,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontWeight:800,cursor:'pointer',boxShadow:'0 8px 22px rgba(124,122,240,.4)' }}>Копировать</button>
              {/* Кнопка только внутри Telegram: openTelegramLink в обычном
                  браузере ничего не сделает. */}
              {inTelegram&&(
                <button onClick={shareInvite} style={{ width:'100%',padding:'11px',fontSize:13,borderRadius:9,border:`1px solid ${HAIR}`,background:'none',color:PUR,cursor:'pointer',fontWeight:600 }}>Поделиться в Telegram</button>
              )}
            </div>
          </div>
        </div>
      )}

      {accessLink&&(
        <AccessLinkModal link={accessLink.url} clientName={accessLink.name} onClose={()=>setAccessLink(null)} />
      )}

      {showAdd&&(
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}
          onClick={()=>setShowAdd(false)}>
          <div style={{ background:SURF,borderRadius:16,padding:'24px 22px',width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18 }}>
              <span style={{ fontSize:16,fontWeight:700,color:TXT }}>Новый клиент</span>
              <button onClick={()=>setShowAdd(false)} style={{ background:'none',border:'none',fontSize:20,cursor:'pointer',color:TXT3,lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ display:'flex',flexDirection:'column',gap:12 }}>
              <div style={{ fontSize:12,color:TXT3,lineHeight:1.45 }}>
                Клиенту не нужно регистрироваться — после сохранения ты получишь ссылку и отправишь её ему.
              </div>
              <div>
                <div style={{ fontSize:11,color:TXT3,marginBottom:4 }}>Имя и фамилия *</div>
                <input value={addForm.name} onChange={e=>setAddForm(f=>({...f,name:e.target.value}))}
                  placeholder="Анна Иванова" autoFocus
                  style={{ width:'100%',padding:'10px 12px',fontSize:13,borderRadius:9,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR}
                  onKeyDown={e=>e.key==='Enter'&&createRealClient()} />
              </div>
              <div>
                <div style={{ fontSize:11,color:TXT3,marginBottom:4 }}>Цель</div>
                <select value={addForm.goal} onChange={e=>setAddForm(f=>({...f,goal:e.target.value}))}
                  style={{ width:'100%',padding:'10px 12px',fontSize:13,borderRadius:9,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT,background:SURF }}>
                  {['Похудение','Набор массы','Выносливость','Тонус','Реабилитация'].map(g=><option key={g}>{g}</option>)}
                </select>
              </div>
              <div style={{ display:'flex',gap:8,marginTop:4 }}>
                <button onClick={()=>setShowAdd(false)} style={{ flex:1,padding:'11px',fontSize:13,borderRadius:9,border:`1px solid ${HAIR}`,background:'none',color:TXT3,cursor:'pointer' }}>Отмена</button>
                <button onClick={createRealClient} disabled={creating||!addForm.name.trim()}
                  style={{ flex:1,padding:'12px',fontSize:14,borderRadius:14,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontWeight:800,cursor:creating||!addForm.name.trim()?'default':'pointer',opacity:creating||!addForm.name.trim()?0.6:1,boxShadow:'0 8px 22px rgba(124,122,240,.4)' }}>
                  {creating?'Создаём…':'Добавить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom:22 }}>
        <h3 style={{ fontSize:15, fontWeight:600, color:TXT, margin:'0 0 10px' }}>Мои клиенты</h3>
        {realClientsLoading?(
          <div style={{ fontSize:13, color:TXT3, padding:'8px 0' }}>Загрузка...</div>
        ):realClientsError?(
          <div style={{ fontSize:13, color:'#ef4444', padding:'8px 0', display:'flex', alignItems:'center', gap:10 }}>
            Не удалось загрузить клиентов
            <button onClick={loadRealClients} style={{ fontSize:12, color:PUR, background:'none', border:`1px solid ${HAIR}`, borderRadius:8, padding:'5px 12px', cursor:'pointer' }}>Повторить</button>
          </div>
        ):realClients.length===0?(
          <div style={{ fontSize:13, color:TXT3, padding:'8px 0' }}>Пока нет клиентов</div>
        ):(
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:8 }}>
            {realClients.map(c=>{
              const label=c.name?.trim()||'Без имени'
              const initials=label.split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'КЛ'
              const activity=clientActivity[c.id]
              const sub=clientSubStatus(c.plan,c.plan_until)
              // Цель, вес и рост — заполнены не у всех, поэтому собираем строку
              // только из непустых полей и не показываем её вовсе, если пусты все.
              const facts=[c.goal,c.weight&&`${c.weight} кг`,c.height&&`${c.height} см`].filter(Boolean).join(' · ')
              // Почта показывается ТОЛЬКО настоящая: у телеграм-аккаунтов и у
              // клиентов, заведённых тренером, в profiles.email лежит
              // техническая строка (tg…@telegram.fitpro / c…@clients.fitproapp.ru),
              // писать на неё некуда — см. realEmail() в src/config.js.
              // Без @ника почта остаётся единственным каналом связи, поэтому
              // тогда она подписана явно, а не показана молчаливой строкой.
              const mail=realEmail(c.email)
              return (
                <Card key={c.id} style={{ cursor:'pointer' }} onClick={()=>openRealClient(c)}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <Av lbl={initials} sz={36} />
                    <div>
                      <div style={{ fontSize:14, fontWeight:500, color:TXT }}>{label}</div>
                      {c.tg_username&&(
                        <div style={{ fontSize:11, color:TXT3, marginTop:2 }}>@{c.tg_username}</div>
                      )}
                      {mail&&(
                        // stopPropagation: карточка целиком открывает клиента, а
                        // клик по почте должен открывать почтовик, а не экран.
                        <div style={{ fontSize:11, marginTop:2 }}>
                          {!c.tg_username&&<span style={{ color:TXT3 }}>почта клиента: </span>}
                          <a href={`mailto:${mail}`} onClick={e=>e.stopPropagation()}
                            style={{ color:TEA, textDecoration:'none', wordBreak:'break-all' }}>{mail}</a>
                        </div>
                      )}
                      <div style={{ fontSize:11, fontWeight:600, color:sub.color, marginTop:3 }}>{sub.text}</div>
                      {facts&&(
                        <div style={{ fontSize:11, color:TXT3, marginTop:3 }}>{facts}</div>
                      )}
                      <div style={{ fontSize:11, color:TXT3, marginTop:3 }}>
                        {activity?`Последняя: ${fmtDDMM(activity.lastDate)} · всего ${activity.count}`:'Пока нет тренировок'}
                      </div>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Очные клиенты — карточки, заведённые тренером вручную. Пока их нет,
          блок скрыт целиком: одинокое поле поиска над пустой сеткой выглядело
          как поломка. */}
      {localClients.length>0&&(<>
      <h3 style={{ fontSize:15, fontWeight:600, color:TXT, margin:'0 0 10px' }}>Очные клиенты</h3>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск..." style={{ width:'100%', marginBottom:14, padding:'8px 12px', fontSize:13, borderRadius:8, border:`1px solid ${HAIR}`, boxSizing:'border-box' }} />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:10 }}>
        {fl.map(c=>(
          <Card key={c.id} style={{ cursor:'pointer', position:'relative' }}>
            <div onClick={()=>{setSC(c);setNav('cdetail')}} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <Av lbl={c.av} sz={40} />
              <div><div style={{ fontSize:14, fontWeight:500, color:TXT }}>{c.name}</div><Badge lbl={c.goal} /></div>
            </div>
            <div onClick={()=>{setSC(c);setNav('cdetail')}}>
              <div style={{ fontSize:12, color:TXT3, marginBottom:7 }}><GlassIcon name="dumbbell" size={16} style={{verticalAlign:'-3px',marginRight:5}} />{c.program}</div>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ fontSize:12, color:TXT3 }}>Прогресс</span>
                <span style={{ fontSize:12, fontWeight:500, color:c.progress>70?TEA:PUR }}>{c.progress}%</span>
              </div>
              <PBar v={c.progress} color={c.progress>70?TEA:PUR} />
            </div>
            {c.isLocal&&(
              <button onClick={async e=>{e.stopPropagation();if(await askConfirm(`Удалить клиента ${c.name}?`))deleteLocal(c.id)}}
                style={{ position:'absolute',top:10,right:10,background:'none',border:'none',color:TXT3,fontSize:16,cursor:'pointer',lineHeight:1,padding:4 }}><GlassIcon name="close" size={26} /></button>
            )}
          </Card>
        ))}
      </div>
      </>)}
    </div>
  )
}

// ── Конструктор тренировок — ЗАМОРОЖЕН ───────────────────────────────────
// Вынесен в src/ConstructorView.jsx, больше не импортируется и не
// рендерится здесь. Полное описание, причины заморозки и как вернуть —
// docs/CONSTRUCTOR_FROZEN.md. Таблицы constructor_exercises/constructor_sets
// в Supabase не удалялись.
function ClientDetail({ client, goBack, trainerId }) {
  // Реальный клиент тренера (см. ClientsView) — отдельная модель данных
  // (id/name из profiles + настоящая история тренировок из Supabase).
  if(client.isReal)return <RealClientDetail client={client} goBack={goBack} trainerId={trainerId} />

  // Очная карточка, заведённая тренером вручную: аккаунта в приложении у
  // такого клиента нет, тренировок и весов в базе тоже — показываем только то,
  // что тренер сам ввёл. Раньше здесь рисовался график по client.wts, но это
  // поле было только у зашитых демо-клиентов; у ручных карточек оно пустое,
  // и экран падал на wts[0].
  const label=client.name?.trim()||'Без имени'
  const initials=label.split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'КЛ'
  const goal=client.goal?.trim()||''
  const program=client.program?.trim()||''
  return (
    <div>
      <button data-back="1" onClick={goBack} style={{ fontSize:12, color:TXT3, border:'none', background:'none', cursor:'pointer', marginBottom:14, padding:0, display:'inline-flex', alignItems:'center', gap:5 }}><GlassIcon name="back" size={16} />Назад</button>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18 }}>
        <Av lbl={initials} sz={50} />
        <div>
          <h2 style={{ fontSize:20, fontWeight:500, color:TXT, margin:0 }}>{label}</h2>
          <span style={{ display:'inline-block', marginTop:6, fontSize:11, fontWeight:700, color:TXT3, background:SURF2, borderRadius:6, padding:'3px 8px' }}>Очный клиент</span>
        </div>
      </div>
      {/* Карточка с введёнными полями. Пустое поле не показываем, а если пусты
          оба — не рисуем и саму карточку, чтобы не оставлять пустую рамку. */}
      {(goal||program)&&(
        <Card style={{ marginBottom:14 }}>
          {goal&&(
            <div style={{ fontSize:13, color:TXT, marginBottom:program?8:0 }}>
              <span style={{ color:TXT3 }}>Цель: </span>{goal}
            </div>
          )}
          {program&&(
            <div style={{ fontSize:13, color:TXT }}>
              <span style={{ color:TXT3 }}>Программа: </span>{program}
            </div>
          )}
        </Card>
      )}
      <div style={{ fontSize:12, color:TXT3, lineHeight:1.5 }}>
        Клиент не пользуется приложением — его прогресс ты ведёшь вне приложения.
      </div>
    </div>
  )
}

// Детальный экран РЕАЛЬНОГО клиента тренера (см. ClientsView) — только
// чтение, история тренировок из Supabase через уже существующую
// loadWorkoutHistoryFromSupabase (RLS разрешает тренеру читать данные
// клиента с его coach_id). Никаких мутаций отсюда не уходит.
function RealClientDetail({ client, goBack, trainerId }) {
  const { exercises: catalogExercises } = useContext(CatalogContext)
  const [tab,setTab]=useState('diary')
  // Экран «Провести тренировку» (src/TrainerSession.jsx): открывается ПОВЕРХ
  // карточки, отдельного маршрута в App не заводим — точка входа только здесь.
  // null — закрыт; {editId:null} — новая сессия; {editId:<id>} — правка своей
  // прошлой записи. По выходу перечитываем дневник: тренер только что в него
  // написал, и старый список был бы неправдой.
  const [session,setSession]=useState(null)
  const [history,setHistory]=useState([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState(false)
  // Перевыпуск ссылки доступа (api/link-client.js, action='reissue_access').
  // Нужен, когда клиент потерял ссылку или у неё вышел срок: показать старую
  // невозможно — в базе только хэш.
  const [accessLink,setAccessLink]=useState(null)   // url | null
  const [issuing,setIssuing]=useState(false)
  const [issueError,setIssueError]=useState('')
  const issueAccess=async()=>{
    if(issuing)return
    if(!await askConfirm('Выдать новую ссылку для входа?\n\nСтарая ссылка сразу перестанет работать — если клиент уже пользуется ей, отправь ему новую.'))return
    setIssuing(true);setIssueError('')
    try{
      const{data:sessionData}=await supabase.auth.getSession()
      const token=sessionData?.session?.access_token
      if(!token){setIssueError('Нужно перезайти в приложение');return}
      const res=await fetch('/api/link-client',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({action:'reissue_access',clientId:client.id}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok||!body.token){
        // Ни ссылка, ни токен в логи не попадают — только статус и текст сервера.
        console.error('Перевыпуск ссылки: сервер отказал',res.status,body?.error||'')
        logError('reissue_access',{message:body?.error||'нет токена в ответе',status:res.status})
        setIssueError('Не удалось выдать ссылку — попробуй ещё раз')
        return
      }
      setAccessLink(`${window.location.origin}/?access=${body.token}`)
    }catch(e){
      console.error('Перевыпуск ссылки: сетевая ошибка:',e)
      logError('reissue_access',{message:e?.message})
      setIssueError('Не удалось выдать ссылку — проверь связь')
    }finally{
      setIssuing(false)
    }
  }
  const load=()=>{
    setLoading(true);setError(false)
    loadWorkoutHistoryFromSupabase(client.id).then(({history,error})=>{
      setHistory(history)
      setError(error)
      setLoading(false)
    })
  }
  useEffect(()=>{load()},[client.id])

  const initials=(client.name||'Без имени').trim().split(' ').map(w=>w[0]?.toUpperCase()||'').join('').slice(0,2)||'КЛ'

  // Пока идёт сессия — карточку не рисуем вовсе: экран записи занимает весь
  // рабочий лист, а закреплённая шапка карточки с ним бы конфликтовала.
  if(session)return (
    <TrainerSession
      client={client}
      trainerId={trainerId}
      catalogExercises={catalogExercises}
      editWorkoutId={session.editId}
      onExit={()=>{setSession(null);load()}}
    />
  )

  return (
    <div>
      <button data-back="1" onClick={goBack} style={{ fontSize:12, color:TXT3, border:'none', background:'none', cursor:'pointer', marginBottom:14, padding:0, display:'inline-flex', alignItems:'center', gap:5 }}><GlassIcon name="back" size={16} />Назад</button>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18 }}>
        <Av lbl={initials} sz={50} />
        <div>
          <h2 style={{ fontSize:20, fontWeight:500, color:TXT, margin:0 }}>{client.name||'Без имени'}</h2>
          {/* @-ник клиента (profiles.tg_username, пишется при входе через
              Telegram — см. api/telegram-auth.js). У кого ник не задан, поля
              нет вовсе — тогда не показываем ничего. Открытие чата — тем же
              способом, что и кнопка "видео тренеру": внутри Mini App обычный
              window.open не всегда открывает внешнюю ссылку. */}
          {client.tg_username&&(
            <div onClick={()=>{
              const url='https://t.me/'+client.tg_username
              if(window.Telegram?.WebApp)window.Telegram.WebApp.openTelegramLink(url)
              else window.open(url,'_blank')
            }} style={{ fontSize:13, color:TEA, marginTop:3, cursor:'pointer', width:'fit-content' }}>
              @{client.tg_username}
            </div>
          )}
          {/* Почта клиента. Показывается только настоящая (realEmail) — у
              телеграм-аккаунтов и заведённых тренером клиентов в profiles.email
              лежит техническая строка, mailto: на неё был бы обманом. Если
              @ника нет, почта — единственный способ связаться, поэтому она
              подписана явно. */}
          {(()=>{
            const mail=realEmail(client.email)
            if(!mail)return null
            return (
              <div style={{ fontSize:13, marginTop:3 }}>
                {!client.tg_username&&<span style={{ color:TXT3 }}>почта клиента: </span>}
                <a href={`mailto:${mail}`} style={{ color:TEA, textDecoration:'none', wordBreak:'break-all' }}>{mail}</a>
              </div>
            )
          })()}
          {/* Ни ника, ни настоящей почты — связаться через приложение нечем.
              Молчание тут читалось бы как «контактов не существует», хотя на
              деле их просто некуда взять: клиент заведён тренером вручную. */}
          {!client.tg_username&&!realEmail(client.email)&&(
            <div style={{ fontSize:12, color:TXT3, marginTop:3 }}>Контактов нет — свяжись с клиентом вне приложения</div>
          )}
        </div>
      </div>
      {accessLink&&(
        <AccessLinkModal link={accessLink} clientName={client.name||''} onClose={()=>setAccessLink(null)} />
      )}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
        {/* Главное действие тренера в карточке — провести занятие и записать
            его клиенту в дневник (src/TrainerSession.jsx). */}
        <button onClick={()=>setSession({editId:null})}
          style={{ fontSize:13, fontWeight:700, padding:'9px 16px', background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', border:'none', borderRadius:10, cursor:'pointer', boxShadow:'0 6px 18px rgba(124,122,240,.35)' }}>
          Провести тренировку
        </button>
        <button onClick={issueAccess} disabled={issuing}
          style={{ fontSize:13, padding:'9px 14px', background:'none', color:PUR, border:`1px solid ${PUR}`, borderRadius:10, cursor:issuing?'default':'pointer', opacity:issuing?0.6:1 }}>
          {issuing?'Выдаём…':'Выдать ссылку для входа'}
        </button>
      </div>
      {issueError&&(
        <div style={{ fontSize:12, color:'#ef4444', marginTop:-8, marginBottom:12 }}>{issueError}</div>
      )}
      {/* Записи, сделанные ЭТИМ тренером, — их он вправе открыть и поправить.
          Тренировки, которые клиент вёл сам, сюда не попадают: их правку база
          не пропустит (политика требует created_by = auth.uid()). */}
      <TrainerSessionsList clientId={client.id} trainerId={trainerId} onEdit={id=>setSession({editId:id})} />
      <div style={{ display:'flex', gap:0, marginBottom:18, background:SURF2, borderRadius:10, padding:3, width:'fit-content', flexWrap:'wrap' }}>
        {[['diary','Дневник'],['program','Программа']].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{ padding:'8px 16px', borderRadius:8, border:'none', background:tab===id?SURF:'transparent', color:tab===id?TXT:TXT3, fontSize:13, fontWeight:600, cursor:'pointer', boxShadow:tab===id?'0 1px 3px rgba(0,0,0,0.1)':'none' }}>
            {label}
          </button>
        ))}
      </div>
      {tab==='diary'&&(
        // Тот же DiaryView, что видит сам клиент (тоннаж/упражнения/питание/
        // планы — идентичная вёрстка и графики), но readOnly: тренер только
        // смотрит, ни один элемент интерфейса здесь данные клиента не пишет.
        <div style={{ minHeight:200 }}>
          <DiaryView
            workoutHistory={history}
            userId={client.id}
            readOnly
            readOnlyName={client.name||''}
            historyLoading={loading}
            historyLoadError={error}
            onRetryHistory={load}
          />
        </div>
      )}
      {tab==='program'&&<ProgramEditor client={client} trainerId={trainerId} />}
    </div>
  )
}

// Редактор персональной программы клиента (сторона тренера) — только
// запись СВОЕЙ строки assigned_programs (client_id уникален, upsert
// onConflict). Клиентская сторона (просмотр/выполнение программы) в этом
// шаге не делается — только редактор.
function ProgramEditor({ client, trainerId }) {
  const { exercises: catalogExercises } = useContext(CatalogContext)
  const [programLoading,setProgramLoading]=useState(true)
  const [programError,setProgramError]=useState(false)
  const [editorOpen,setEditorOpen]=useState(false)
  const [title,setTitle]=useState('Персональная программа')
  const [workouts,setWorkouts]=useState([])
  const [saving,setSaving]=useState(false)
  const [saveState,setSaveState]=useState('idle') // 'idle' | 'saving' | 'saved' | 'error'
  // Текст последнего сбоя сохранения. Держим отдельно от saveState: причины
  // разные (нет тренера в пропсах, отказ базы, сеть), и тренеру нужно знать
  // ИМЕННО свою — «проверь связь» при отказе RLS только сбивает с толку.
  const [saveError,setSaveError]=useState('')
  // Календарь свёрнут/развёрнут (см. ниже): в развёрнутом виде сетка месяца
  // занимает пол-экрана и мешает вводить подходы.
  const [calOpen,setCalOpen]=useState(true)
  const [pickerFor,setPickerFor]=useState(null) // индекс тренировки, для которой открыт выбор упражнения
  const [pickerQuery,setPickerQuery]=useState('')
  // Календарь. viewMonth/selectedDate держим ОТДЕЛЬНО от workouts — иначе тап по
  // дате или листание месяца дёргали бы автосохранение вхолостую.
  const [viewMonth,setViewMonth]=useState(()=>{const d=new Date();return{y:d.getFullYear(),m:d.getMonth()}})
  const [selectedDate,setSelectedDate]=useState(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`})
  // Модалка копирования (несколько дат) и назначения даты тренировке без даты.
  const [copyWi,setCopyWi]=useState(null)
  const [copySel,setCopySel]=useState([])
  const [copyMonth,setCopyMonth]=useState(()=>{const d=new Date();return{y:d.getFullYear(),m:d.getMonth()}})
  const [assignWi,setAssignWi]=useState(null)
  const [assignMonth,setAssignMonth]=useState(()=>{const d=new Date();return{y:d.getFullYear(),m:d.getMonth()}})
  // Автосохранение. skipNextAutosaveRef гасит холостое сохранение сразу после
  // загрузки (установка состояния из базы триггерит эффект, но писать нечего).
  // latestRef держит актуальные title/workouts, чтобы сохранить их из cleanup
  // при уходе с экрана. dirtyRef — есть ли несохранённые правки.
  const skipNextAutosaveRef=useRef(true)
  const latestRef=useRef({title,workouts})
  const dirtyRef=useRef(false)
  // Ссылка на отложенное сохранение — чтобы дискретное действие (blur, кнопка)
  // могло отменить его и записать сразу, не дожидаясь секунды.
  const autosaveTimerRef=useRef(null)
  // Флаг «следующее сохранение — без задержки». Ставится ПЕРЕД изменением
  // состояния: сам записать нельзя, пока setWorkouts не отработал, а читать
  // свежие workouts из обработчика поздно.
  const saveNowRef=useRef(false)
  const markImmediate=()=>{saveNowRef.current=true}
  // Access-токен для keepalive-запроса (см. flushKeepalive). Держим в ref и
  // обновляем заранее: в момент pagehide спрашивать сессию асинхронно уже
  // поздно — страница успевает умереть раньше, чем промис разрешится.
  const tokenRef=useRef(null)
  useEffect(()=>{
    let cancelled=false
    supabase.auth.getSession().then(({data})=>{if(!cancelled)tokenRef.current=data?.session?.access_token||null})
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,session)=>{tokenRef.current=session?.access_token||null})
    return()=>{cancelled=true;subscription?.unsubscribe()}
  },[])

  const loadProgram=()=>{
    setProgramLoading(true);setProgramError(false)
    supabase.from('assigned_programs').select('*').eq('client_id',client.id).maybeSingle().then(({data,error})=>{
      if(error){console.error('Ошибка загрузки программы клиента:',error);setProgramError(true);setProgramLoading(false);return}
      // Состояние приходит из базы — следующий прогон автосохранения холостой.
      skipNextAutosaveRef.current=true
      setTitle(data?.title||'Персональная программа')
      // В базе sets — строка того же формата, что в PROGRAMS_MAP. В редакторе
      // держим её разобранной на подходы и склеиваем обратно при сохранении,
      // чтобы формат хранения не менялся.
      const raw=Array.isArray(data?.structure)?data.structure:[]
      setWorkouts(raw.map(w=>({
        ...w,
        exercises:(w.exercises||[]).map(ex=>{
          const parsed=(ex.sets?parseTemplateSets(ex.sets):[]).map(ts=>({
            reps:String(ts.reps),
            kg:ts.templateKg!=null?String(ts.templateKg):'',
          }))
          return{...ex,sets:parsed.length?parsed:[{reps:'',kg:''}],note:ex.note||''}
        }),
        // Существующие тренировки — свёрнуты: тренер видит чистый список
        // названий и разворачивает нужную. collapsed чисто для UI, в
        // structure при сохранении не уходит (saveProgram берёт name+exercises).
        collapsed:true,
      })))
      setEditorOpen(!!data)
      // Календарь сворачиваем сразу, если в программе уже есть хоть одна
      // тренировка с датой: тренер пришёл править упражнения, а не выбирать
      // день, и сетка месяца ему только мешает. У пустой программы оставляем
      // развёрнутым — первый шаг там как раз выбрать дату.
      setCalOpen(!raw.some(w=>w?.date))
      setProgramLoading(false)
    })
  }
  useEffect(()=>{loadProgram()},[client.id])

  // markImmediate перед каждым дискретным изменением: ввод закончен, ждать
  // секунду нечего. Сам вызов сохранения делает эффект автосохранения — он
  // увидит флаг и запишет без задержки.
  const removeWorkout=async(wi)=>{
    if(!await askConfirm('Удалить тренировку из программы?'))return
    markImmediate()
    setWorkouts(w=>w.filter((_,i)=>i!==wi))
  }
  const renameWorkout=(wi,name)=>{
    setWorkouts(w=>w.map((x,i)=>i===wi?{...x,name}:x))
  }
  const addExercise=(wi,exerciseName)=>{
    markImmediate()
    setWorkouts(w=>{
      // Если это же упражнение уже где-то заведено с заполненными подходами —
      // переносим их копией: тренер часто повторяет упражнение с той же
      // схемой, и вводить заново неудобно. Берём последнее подходящее.
      let carried=null
      for(const wk of w){
        for(const ex of wk.exercises||[]){
          if(ex.name===exerciseName&&Array.isArray(ex.sets)&&ex.sets.some(s=>String(s.reps??'').trim()||String(s.kg??'').trim()))carried=ex.sets
        }
      }
      const sets=carried?carried.map(s=>({reps:s.reps,kg:s.kg})):[{reps:'',kg:''}]
      // note НЕ переносим: подходы могут повторяться, а комментарий у каждого
      // упражнения свой.
      return w.map((x,i)=>i===wi?{...x,exercises:[...(x.exercises||[]),{name:exerciseName,sets,note:''}]}:x)
    })
    setPickerFor(null);setPickerQuery('')
  }
  const removeExercise=(wi,ei)=>{
    markImmediate()
    setWorkouts(w=>w.map((x,i)=>i===wi?{...x,exercises:x.exercises.filter((_,j)=>j!==ei)}:x))
  }
  // Общая обёртка для правок подходов — чтобы три обработчика ниже не
  // повторяли двойной map по тренировкам и упражнениям.
  const updateSets=(wi,ei,fn)=>{
    setWorkouts(w=>w.map((x,i)=>i!==wi?x:{...x,exercises:x.exercises.map((ex,j)=>j!==ei?ex:{...ex,sets:fn(Array.isArray(ex.sets)?ex.sets:[])})}))
  }
  // Новый подход копирует последний: тренер обычно задаёт несколько
  // одинаковых, и «ещё такой же» экономит ввод.
  const addSet=(wi,ei)=>{
    markImmediate()
    updateSets(wi,ei,sets=>{
      const last=sets[sets.length-1]
      return[...sets,last?{...last}:{reps:'',kg:''}]
    })
  }
  // Последний подход не удаляем — упражнение без подходов не имеет смысла.
  const removeSet=(wi,ei,si)=>{
    markImmediate()
    updateSets(wi,ei,sets=>sets.length<=1?sets:sets.filter((_,k)=>k!==si))
  }
  const setSetField=(wi,ei,si,field,value)=>updateSets(wi,ei,sets=>sets.map((s,k)=>k===si?{...s,[field]:value}:s))
  const setExerciseNote=(wi,ei,note)=>{
    setWorkouts(w=>w.map((x,i)=>i!==wi?x:{...x,exercises:x.exercises.map((ex,j)=>j!==ei?ex:{...ex,note})}))
  }

  // Тоннаж считаем здесь: exTonnage живёт внутри WorkoutsView и сюда не
  // достаёт. Формула та же (parseFloat×parseInt), чтобы цифра у тренера в
  // конструкторе сходилась с той, что клиент увидит на тренировке.
  const setsTonnage=sets=>(Array.isArray(sets)?sets:[]).reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)
  const workoutTonnage=w=>(w.exercises||[]).reduce((sum,ex)=>sum+setsTonnage(ex.sets),0)

  // ── Календарь ─────────────────────────────────────────────────────────────
  const MONTHS_NOM=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь']
  const MONTHS_GEN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
  const DOW=['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС']
  const pad2=n=>String(n).padStart(2,'0')
  const mkKey=(y,m,d)=>`${y}-${pad2(m+1)}-${pad2(d)}`
  const _today=new Date()
  const todayKey=mkKey(_today.getFullYear(),_today.getMonth(),_today.getDate())
  // «27 июля» — число + месяц в родительном падеже.
  const dateWords=key=>{const[y,m,d]=key.split('-').map(Number);return `${d} ${MONTHS_GEN[m-1]}`}
  // Кол-во дат словами после «на»: 1 дату, 2–4 даты, 5+ дат.
  const dateCountWord=n=>{const a=n%100,b=n%10;if(a>=11&&a<=14)return 'дат';if(b===1)return 'дату';if(b>=2&&b<=4)return 'даты';return 'дат'}
  // Сетка месяца, недели с понедельника; заполнители — null.
  const monthMatrix=(y,m)=>{
    const startOffset=(new Date(y,m,1).getDay()+6)%7 // getDay: 0=Вс → сдвигаем к Пн-первому
    const days=new Date(y,m+1,0).getDate()
    const cells=[]
    for(let i=0;i<startOffset;i++)cells.push(null)
    for(let d=1;d<=days;d++)cells.push(d)
    while(cells.length%7)cells.push(null)
    return cells
  }
  // Шапка со стрелками ‹ › и подписью «месяц год».
  const monthHead=(view,setView)=>(
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
      <button onClick={()=>setView(v=>v.m>0?{y:v.y,m:v.m-1}:{y:v.y-1,m:11})} style={{ background:SURF2, border:`1px solid ${HAIR}`, borderRadius:8, width:30, height:30, cursor:'pointer', color:TXT, fontSize:16, lineHeight:1, padding:0 }}>‹</button>
      <span style={{ fontSize:14, fontWeight:700, color:TXT, textTransform:'capitalize' }}>{MONTHS_NOM[view.m]} {view.y}</span>
      <button onClick={()=>setView(v=>v.m<11?{y:v.y,m:v.m+1}:{y:v.y+1,m:0})} style={{ background:SURF2, border:`1px solid ${HAIR}`, borderRadius:8, width:30, height:30, cursor:'pointer', color:TXT, fontSize:16, lineHeight:1, padding:0 }}>›</button>
    </div>
  )
  // Подписи дней + сетка; renderCell(key,day) рисует ячейку конкретной даты.
  const monthGrid=(view,renderCell)=>(<>
    <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:4, marginBottom:6 }}>
      {DOW.map(d=><span key={d} style={{ fontSize:10, fontWeight:700, color:TXT3, textAlign:'center' }}>{d}</span>)}
    </div>
    <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:4 }}>
      {monthMatrix(view.y,view.m).map((d,i)=>d==null?<span key={i} />:renderCell(mkKey(view.y,view.m,d),d))}
    </div>
  </>)

  const addWorkoutForDate=dateKey=>{
    markImmediate()
    setWorkouts(w=>[...w,{name:'Тренировка',exercises:[],date:dateKey}])
  }
  // Глубокая копия тренировки на другую дату — НОВЫЕ объекты подходов, не ссылки
  // на те же массивы, иначе правки на одной дате поехали бы на все копии.
  const cloneWorkout=(w,dateKey)=>({
    name:w.name,date:dateKey,
    exercises:(w.exercises||[]).map(ex=>({
      name:ex.name,note:ex.note||'',
      sets:(Array.isArray(ex.sets)?ex.sets:[]).map(s=>({reps:s.reps,kg:s.kg})),
    })),
  })
  const toggleCopyDate=key=>setCopySel(s=>s.includes(key)?s.filter(k=>k!==key):[...s,key])
  const applyCopy=async()=>{
    const src=workouts[copyWi]
    if(!src||!copySel.length){setCopyWi(null);setCopySel([]);return}
    const next=[...workouts]
    for(const key of copySel){
      const idx=next.findIndex(x=>x.date===key)
      if(idx>=0){
        if(!await askConfirm(`На ${dateWords(key)} уже есть тренировка. Заменить её копией?`))continue
        next[idx]=cloneWorkout(src,key)
      }else next.push(cloneWorkout(src,key))
    }
    markImmediate()
    setWorkouts(next)
    setCopyWi(null);setCopySel([])
  }
  // Назначить дату тренировке без даты (перенос старой программы в календарь).
  const assignDate=async key=>{
    const wi=assignWi
    const target=workouts[wi]
    if(!target){setAssignWi(null);return}
    const conflict=workouts.some((x,i)=>x.date===key&&i!==wi)
    if(conflict&&!await askConfirm(`На ${dateWords(key)} уже есть тренировка. Заменить её?`))return
    markImmediate()
    setWorkouts(w=>w.filter((x,i)=>!(x.date===key&&i!==wi)).map(x=>x===target?{...x,date:key}:x))
    setAssignWi(null)
    setSelectedDate(key)
    const[y,m]=key.split('-').map(Number);setViewMonth({y,m:m-1})
  }

  // Строка для базы. Вынесена отдельно, потому что её собирают ДВА пути записи:
  // обычный (supabase-js, ниже) и аварийный keepalive-запрос при закрытии
  // страницы. Оба обязаны писать байт в байт одно и то же — формат structure
  // (массив тренировок {name, date, exercises:[{name,sets,note}]}, где sets —
  // строка того же вида, что в PROGRAMS_MAP из programs.js, её парсит
  // parseTemplateSets) НЕ меняем ни в одном из них.
  const buildRow=(nextTitle,nextWorkouts)=>{
    // Подходы обратно в строку. Без веса подход пишем одним числом повторений
    // — parseTemplateSets понимает обе формы. Подход без повторений пустой,
    // его отбрасываем.
    const serializeSets=sets=>(Array.isArray(sets)?sets:[])
      .filter(s=>String(s.reps??'').trim())
      .map(s=>{
        const reps=String(s.reps).trim()
        const kg=String(s.kg??'').trim()
        return kg?`${kg} кг × ${reps}`:reps
      })
      .join(', ')
    return{
      client_id:client.id,
      trainer_id:trainerId,
      title:(nextTitle||'').trim()||'Персональная программа',
      structure:nextWorkouts.map(w=>({
        name:(w.name||'Тренировка').trim()||'Тренировка',
        date:w.date||null, // дата плана внутри существующего jsonb; формат структуры не меняем
        exercises:(w.exercises||[]).map(ex=>({name:ex.name,sets:serializeSets(ex.sets),note:(ex.note||'').trim()})),
      })),
      updated_at:new Date().toISOString(),
    }
  }

  // Единая запись в базу. Принимает текущие title/workouts, чтобы её можно было
  // звать и с актуальным состоянием (кнопка/таймер), и из cleanup при уходе с
  // экрана (значения из latestRef).
  const persistProgram=async(nextTitle,nextWorkouts)=>{
    if(!Array.isArray(nextWorkouts)){console.error('Программа: structure не массив');setSaveError('Внутренняя ошибка редактора — обнови страницу');setSaveState('error');return false}
    // Без id тренера или клиента писать нельзя. Политика trainer_manages_programs
    // требует trainer_id = auth.uid() И чтобы у клиента был этот coach_id;
    // запрос без trainer_id база отклоняет с 42501 «new row violates row-level
    // security policy» — сообщение, из которого тренер ничего не поймёт.
    // Поэтому ловим случай здесь и говорим по-человечески.
    if(!trainerId||!client?.id){
      console.error('Программа: нет id тренера или клиента — сохранение отменено')
      logError('assigned_program_save',{message:'нет trainerId или client.id',details:{table:'assigned_programs',action:'guard'}})
      setSaveError('Не удалось определить тренера — вернись в «Клиенты» и открой карточку заново')
      setSaveState('error')
      return false
    }
    setSaving(true);setSaveState('saving')
    const{error}=await supabase.from('assigned_programs')
      .upsert(buildRow(nextTitle,nextWorkouts),{onConflict:'client_id'})
    setSaving(false)
    if(error){
      console.error('Ошибка сохранения программы:',error)
      logError('assigned_program_save',{message:error.message,details:{table:'assigned_programs',action:'upsert',code:error.code}})
      // 42501 — отказ RLS: строка ушла, но политика её не пропустила. Это НЕ
      // «проверь связь», и предлагать тренеру ждать сеть бессмысленно.
      setSaveError(error.code==='42501'
        ? 'База отклонила запись: клиент числится не за тобой. Открой карточку клиента заново'
        : 'Не сохранено — проверь связь и нажми «Повторить»')
      setSaveState('error')
      return false
    }
    dirtyRef.current=false
    setSaveError('')
    setSaveState('saved')
    return true
  }
  // Кнопка «Сохранить программу» — немедленное сохранение текущего состояния.
  const saveProgram=()=>persistProgram(title,workouts)

  // Досохранение при уходе с экрана и при закрытии страницы.
  //
  // Почему не обычный supabase-js: внутри Telegram свайп закрытия убивает
  // страницу вместе с незавершённым fetch — правка терялась молча, ни ошибки на
  // экране, ни строки в журнале (запрос просто не доходил). fetch с
  // keepalive:true браузер обязан довести до конца даже после смерти страницы,
  // но supabase-js такой опции не даёт — поэтому здесь единственное место, где
  // запрос к PostgREST собирается руками. Адрес и публичный ключ — те же, из
  // src/supabase.js; токен берём из tokenRef (спрашивать сессию асинхронно в
  // этот момент уже поздно). Тело — buildRow, то же самое, что и в обычном пути.
  //
  // Функция СИНХРОННАЯ и ничего не ждёт: любое await здесь означало бы, что
  // страница может умереть раньше отправки.
  const flushKeepalive=()=>{
    if(!dirtyRef.current)return false
    if(!trainerId||!client?.id)return false
    const token=tokenRef.current
    const{title:t,workouts:w}=latestRef.current
    if(!Array.isArray(w))return false
    // Токен ещё не доехал (правка в первые миллисекунды после открытия) —
    // лучше обычный путь, чем не сохранить вовсе.
    if(!token){persistProgram(t,w);return false}
    let body
    try{ body=JSON.stringify(buildRow(t,w)) }catch(e){ console.error('Программа: не удалось собрать тело запроса:',e); return false }
    // keepalive не принимает тело больше ~64 КБ (лимит спецификации fetch).
    // Программа такого размера — это сотни упражнений, но если это всё же
    // случилось, уходим обычным путём: он не переживёт закрытие страницы, зато
    // при переходе внутри приложения отработает штатно.
    if(body.length>60000){
      persistProgram(t,w)
      return false
    }
    try{
      fetch(`${SUPABASE_URL}/rest/v1/assigned_programs?on_conflict=client_id`,{
        method:'POST',
        keepalive:true,
        headers:{
          'Content-Type':'application/json',
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          Prefer:'resolution=merge-duplicates',
        },
        body,
      }).catch(e=>console.error('Программа: keepalive-досохранение не дошло:',e?.message||e))
      // Помечаем чистым сразу: повторно слать то же самое из соседнего
      // обработчика (pagehide после visibilitychange) незачем.
      dirtyRef.current=false
      return true
    }catch(e){
      console.error('Программа: не удалось отправить keepalive-запрос:',e?.message||e)
      return false
    }
  }

  // Сохранение по дискретному действию — когда ввод заведомо закончен (blur
  // поля, добавление/удаление, работа с датами). Ждать секунду тут незачем:
  // именно эта секунда и терялась при закрытии приложения. Отложенное
  // сохранение отменяем, чтобы не слать то же самое дважды.
  const saveNow=()=>{
    if(!dirtyRef.current)return
    if(autosaveTimerRef.current){clearTimeout(autosaveTimerRef.current);autosaveTimerRef.current=null}
    const{title:t,workouts:w}=latestRef.current
    persistProgram(t,w)
  }

  // Автосохранение с задержкой. latestRef обновляем на каждый прогон, чтобы
  // cleanup при уходе с экрана взял самые свежие значения.
  useEffect(()=>{
    latestRef.current={title,workouts}
    if(programLoading||programError)return
    // Первый прогон после загрузки — холостой: состояние только пришло из базы.
    if(skipNextAutosaveRef.current){skipNextAutosaveRef.current=false;return}
    dirtyRef.current=true
    // Секундная пауза — только для непрерывного набора текста (имя упражнения,
    // заметка, название). Дискретные действия помечают saveNowRef и пишутся
    // сразу: см. markImmediate у обработчиков.
    const immediate=saveNowRef.current
    saveNowRef.current=false
    const t=setTimeout(()=>{autosaveTimerRef.current=null;persistProgram(title,workouts)},immediate?0:1000)
    autosaveTimerRef.current=t
    return()=>clearTimeout(t)
  },[title,workouts])

  // Сохранение при размонтировании: быстрый уход сразу после правки убил бы
  // таймер автосохранения вместе с компонентом. Дописываем из latestRef, и
  // именно keepalive-путём — уход с экрана и закрытие приложения свайпом для
  // компонента выглядят одинаково, а второй случай обычный fetch не переживает.
  useEffect(()=>()=>{flushKeepalive()},[])

  // Флаш при закрытии/сворачивании мини-приложения. Размонтирование ловит уход в
  // другой раздел, но не закрытие Telegram свайпом или сворачивание — компонент
  // не размонтируется, страница просто умирает вместе с таймером автосохранения.
  // pagehide и visibilitychange (hidden) — момент дописать последнюю правку.
  useEffect(()=>{
    const flush=()=>{flushKeepalive()}
    const onVis=()=>{if(document.visibilityState==='hidden')flush()}
    window.addEventListener('pagehide',flush)
    window.addEventListener('visibilitychange',onVis)
    return()=>{
      window.removeEventListener('pagehide',flush)
      window.removeEventListener('visibilitychange',onVis)
    }
  },[])

  if(programLoading)return <div style={{ fontSize:13, color:TXT3, padding:'30px 0', textAlign:'center' }}>Загрузка...</div>
  if(programError)return (
    <div style={{ fontSize:13, color:'#ef4444', padding:'30px 0', textAlign:'center', display:'flex', flexDirection:'column', alignItems:'center', gap:10 }}>
      Не удалось загрузить программу
      <button onClick={loadProgram} style={{ fontSize:12, color:PUR, background:'none', border:`1px solid ${HAIR}`, borderRadius:8, padding:'6px 14px', cursor:'pointer' }}>Повторить</button>
    </div>
  )
  if(!editorOpen)return (
    <div style={{ textAlign:'center', padding:'30px 0' }}>
      <div style={{ fontSize:13, color:TXT3, marginBottom:14 }}>У клиента ещё нет персональной программы</div>
      <button onClick={()=>setEditorOpen(true)} style={{ fontSize:13, padding:'9px 18px', background:PUR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontWeight:600 }}>Создать программу</button>
    </div>
  )

  // Производные для календаря (после ранних возвратов — при загрузке не нужны).
  const dayWi=workouts.findIndex(w=>w.date===selectedDate)
  const viewPrefix=`${viewMonth.y}-${pad2(viewMonth.m+1)}`
  const monthTon=workouts.filter(w=>w.date&&w.date.startsWith(viewPrefix)).reduce((s,w)=>s+workoutTonnage(w),0)
  const datelessList=workouts.map((w,i)=>({w,i})).filter(o=>o.w.date==null)

  return (
    <div>
      {/* Неудачное сохранение обязано быть ЗАМЕТНЫМ. Прежний единственный
          признак — строка 11px под названием программы — при вводе подходов
          уходит за верх экрана, и тренер продолжал работать, считая, что всё
          записано. Плашка закреплена поверх экрана и не исчезает сама: пока
          она висит, изменения в базу не ушли. */}
      {saveState==='error'&&(
        <div style={{
          position:'fixed', top:10, left:'50%', transform:'translateX(-50%)',
          zIndex:2500, width:'calc(100% - 24px)', maxWidth:420, boxSizing:'border-box',
          padding:'12px 14px', borderRadius:14, background:'#dc2626', color:'#fff',
          boxShadow:'0 10px 30px rgba(220,38,38,0.4)',
        }}>
          <div style={{ fontSize:13, fontWeight:800, marginBottom:2 }}>Программа НЕ сохранена</div>
          <div style={{ fontSize:12, lineHeight:1.4, opacity:0.95 }}>{saveError||'Не сохранено — проверь связь и нажми «Повторить»'}</div>
          <button onClick={saveProgram} disabled={saving}
            style={{ marginTop:8, padding:'7px 14px', fontSize:12, fontWeight:700, borderRadius:9, border:'1px solid rgba(255,255,255,0.6)', background:'rgba(255,255,255,0.15)', color:'#fff', cursor:saving?'default':'pointer' }}>
            {saving?'Сохраняем…':'Повторить'}
          </button>
        </div>
      )}
      {/* Статус сохранения закреплён в шапке редактора: тренер вводит подходы
          далеко внизу, и статус под названием программы к этому моменту уже
          за верхом экрана. Сюда же попадает и «Сохраняю…», чтобы было видно,
          что правка ушла, а не просто «ничего не произошло». */}
      <div style={{ position:'sticky', top:0, zIndex:5, background:BG, paddingBottom:6, display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
        <span style={{ fontSize:11, color:TXT3 }}>Программа клиента</span>
        <span style={{ fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:20, whiteSpace:'nowrap',
          background:saveState==='error'?'#fee2e2':saveState==='saved'?'#dcfce7':SURF2,
          color:saveState==='error'?'#b91c1c':saveState==='saved'?'#085041':TXT3 }}>
          {saveState==='saving'?'Сохраняю…':saveState==='saved'?'Сохранено':saveState==='error'?'Не сохранено':'Черновик'}
        </span>
      </div>
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Название программы</div>
        {/* onBlur у всех полей редактора = «ввод закончен» → пишем сразу, не
            дожидаясь секундной паузы автосохранения. */}
        <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Программа"
          style={{ width:'100%', padding:'9px 12px', fontSize:14, fontWeight:600, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
          onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>{e.target.style.borderColor=HAIR;saveNow()}} />
        {/* Статус автосохранения переехал в закреплённую шапку выше — здесь он
            дублировал бы её и при этом всё равно уезжал бы за экран. */}
      </div>

      {/* Календарь: тап по дню выбирает дату, ‹ › листают месяц. Даты мягкие —
          прошедшие дни выглядят как обычные, без «просрочено» и без красного.
          Сворачиваемый: развёрнутая сетка месяца занимала пол-экрана и мешала
          вводить подходы. Свёрнутый вид — строка с выбранной датой; после
          выбора дня схлопывается обратно. Календари копирования и назначения
          даты (модалки ниже) к этому не относятся и работают как раньше. */}
      <Card>
        <div onClick={()=>setCalOpen(o=>!o)}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, cursor:'pointer' }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:15, fontWeight:800, color:TXT }}>
              {dateWords(selectedDate)}{selectedDate===todayKey?' · сегодня':''}
            </div>
            <div style={{ fontSize:11, color:TXT3, marginTop:2 }}>
              {dayWi>=0?'тренировка назначена':'тренировки нет'} · тоннаж за {MONTHS_NOM[viewMonth.m]}: {monthTon} кг
            </div>
          </div>
          <span style={{ fontSize:12, fontWeight:700, color:PUR, flexShrink:0, whiteSpace:'nowrap' }}>
            {calOpen?'Свернуть':'Календарь'}
          </span>
        </div>
        {calOpen&&(
          <div style={{ marginTop:12, paddingTop:10, borderTop:`1px solid ${HAIR}` }}>
            {monthHead(viewMonth,setViewMonth)}
            {monthGrid(viewMonth,(key,d)=>{
              const has=workouts.some(w=>w.date===key)
              const isSel=key===selectedDate
              const isToday=key===todayKey
              return (
                <button key={key} onClick={()=>{setSelectedDate(key);setCalOpen(false)}}
                  style={{ position:'relative', aspectRatio:'1', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:10, cursor:'pointer', fontSize:13, fontWeight:600, padding:0, boxSizing:'border-box',
                    border:(isToday&&!isSel)?`1.5px solid ${PUR}`:'1.5px solid transparent', background:isSel?PUR:'transparent', color:isSel?'#fff':TXT }}>
                  {d}
                  {has&&<span style={{ position:'absolute', bottom:4, width:5, height:5, borderRadius:'50%', background:isSel?'#fff':PUR }} />}
                </button>
              )
            })}
          </div>
        )}
      </Card>

      {/* Тренировка выбранного дня — всегда одна, свёртки/шеврона больше нет. */}
      <div style={{ marginTop:14 }}>
        {dayWi<0?(
          <button onClick={()=>addWorkoutForDate(selectedDate)}
            style={{ width:'100%', padding:'12px', fontSize:13, borderRadius:9, border:'1.5px dashed #d1d5db', background:'none', color:TXT3, cursor:'pointer', fontWeight:600 }}>
            + Тренировка на {dateWords(selectedDate)}
          </button>
        ):(()=>{const w=workouts[dayWi],wi=dayWi;return (
          <Card>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <input value={w.name} onChange={e=>renameWorkout(wi,e.target.value)} placeholder="Тренировка"
                style={{ flex:1, padding:'7px 10px', fontSize:13, fontWeight:600, borderRadius:8, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>{e.target.style.borderColor=HAIR;saveNow()}} />
              <button onClick={()=>{setCopyWi(wi);setCopySel([]);setCopyMonth(viewMonth)}}
                style={{ background:SURF2, border:`1px solid ${HAIR}`, borderRadius:8, padding:'7px 10px', fontSize:12, fontWeight:600, color:PUR, cursor:'pointer', flexShrink:0, whiteSpace:'nowrap' }}>Копировать</button>
              <button onClick={()=>removeWorkout(wi)} style={{ background:'none', border:'none', color:TXT3, fontSize:16, cursor:'pointer', lineHeight:1, padding:4, flexShrink:0 }}><GlassIcon name="close" size={26} /></button>
            </div>
            {/* Упражнения и подходы — та же вёрстка, что на экране активной
                тренировки (WorkoutsView, wMode==='start'): тренер собирает
                программу ровно в том виде, в котором её увидит клиент.
                Клиентские элементы сюда не переносятся — оценка нагрузки,
                заметка к подходу, видео, рекомендованный вес и «Выполнено»
                относятся к выполнению, а не к составлению. */}
            <div>
              {(w.exercises||[]).map((ex,ei)=>{
                const sets=Array.isArray(ex.sets)?ex.sets:[]
                return (
                  <div key={ei} style={{ marginBottom:14, background:SURF, borderRadius:20, padding:'12px 14px', border:`1px solid ${HAIR}` }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, gap:8 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, minWidth:0 }}>
                        <span style={{ width:30, height:30, borderRadius:10, background:`linear-gradient(135deg, ${PUR}, #5b56c9)`, color:'#fff', fontWeight:800, fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{ei+1}</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:16, fontWeight:700, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{labelOf(catalogExercises,ex.name)}</div>
                        </div>
                      </div>
                      <button onClick={()=>removeExercise(wi,ei)}
                        style={{ width:26, height:26, borderRadius:6, border:'none', background:SURF2, color:TXT3, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        🗑
                      </button>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 20px', gap:5, marginBottom:5 }}>
                      {['#','КГ','ПОВТ',''].map((h,i)=>(
                        <span key={i} style={{ fontSize:11, fontWeight:700, color:TXT2, textAlign:'center', textTransform:'uppercase', letterSpacing:'.06em' }}>{h}</span>
                      ))}
                    </div>
                    {sets.map((s,si)=>(
                      <div key={si} style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 20px', gap:5, alignItems:'center', marginBottom:5 }}>
                        <span style={{ fontSize:12, color:TXT3, textAlign:'center', fontWeight:700 }}>{si+1}</span>
                        <input value={s.kg} inputMode="decimal" onChange={e=>setSetField(wi,ei,si,'kg',e.target.value)} onBlur={saveNow} placeholder="0"
                          style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                        <input value={s.reps} inputMode="numeric" onChange={e=>setSetField(wi,ei,si,'reps',e.target.value)} onBlur={saveNow} placeholder="0"
                          style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                        {/* Последний подход не удаляем — упражнение без
                            подходов не имеет смысла. Плейсхолдер держит
                            колонку, чтобы поля не разъезжались. */}
                        {sets.length>1?(
                          <button onClick={()=>removeSet(wi,ei,si)}
                            style={{ background:'none', border:'none', color:TXT3, cursor:'pointer', fontSize:14, textAlign:'center' }}><GlassIcon name="close" size={26} /></button>
                        ):<span />}
                      </div>
                    ))}
                    <button onClick={()=>addSet(wi,ei)}
                      style={{ fontSize:12, color:PUR, background:'none', border:'none', cursor:'pointer', fontWeight:600, padding:0, marginTop:6 }}>
                      + Добавить подход
                    </button>
                    <textarea value={ex.note||''} onChange={e=>setExerciseNote(wi,ei,e.target.value)}
                      placeholder="Комментарий к упражнению (техника, темп, на что обратить внимание)" rows={2}
                      style={{ width:'100%', marginTop:10, padding:'8px 10px', fontSize:12, borderRadius:8, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF2, resize:'vertical', fontFamily:'inherit' }}
                      onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>{e.target.style.borderColor=HAIR;saveNow()}} />
                    <div style={{ fontSize:16, fontWeight:700, color:PUR, marginTop:8 }}>Тоннаж: {setsTonnage(ex.sets)} кг</div>
                  </div>
                )
              })}
            </div>
            <button onClick={()=>{setPickerFor(wi);setPickerQuery('')}}
              style={{ width:'100%', padding:'8px', fontSize:12, color:PUR, background:`${PUR}10`, border:`1px dashed ${PUR}55`, borderRadius:8, cursor:'pointer', fontWeight:600 }}>
              + Упражнение
            </button>
            {(w.exercises||[]).length>0&&(
              <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${HAIR}`, fontSize:15, fontWeight:800, color:TXT }}>
                Общий тоннаж: {workoutTonnage(w)} кг
              </div>
            )}
          </Card>
        )})()}
      </div>

      {/* Без даты — старые тренировки, созданные до календаря. «Назначить дату»
          переносит их в календарь, ничего не теряя. */}
      {datelessList.length>0&&(
        <div style={{ marginTop:16 }}>
          <div style={{ fontSize:12, fontWeight:700, color:TXT3, marginBottom:8 }}>Без даты</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {datelessList.map(({w,i})=>(
              <div key={i} style={{ display:'flex', alignItems:'center', gap:8, background:SURF, border:`1px solid ${HAIR}`, borderRadius:12, padding:'10px 12px' }}>
                <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:600, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{w.name||'Тренировка'}</span>
                <span style={{ fontSize:12, color:TXT3, flexShrink:0 }}>{workoutTonnage(w)} кг</span>
                <button onClick={()=>{setAssignWi(i);setAssignMonth(viewMonth)}}
                  style={{ background:SURF2, border:`1px solid ${HAIR}`, borderRadius:8, padding:'6px 10px', fontSize:12, fontWeight:600, color:PUR, cursor:'pointer', flexShrink:0, whiteSpace:'nowrap' }}>Назначить дату</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:8, marginTop:14 }}>
        <button onClick={saveProgram} disabled={saving} style={{ flex:1, padding:'12px', fontSize:14, borderRadius:14, border:'none', background:saving?SURF2:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', cursor:saving?'default':'pointer', fontWeight:800, boxShadow:'0 8px 22px rgba(124,122,240,.4)' }}>
          {saving?'Сохраняем...':'Сохранить программу'}
        </button>
      </div>

      {pickerFor!=null&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={()=>setPickerFor(null)}>
          <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:400, maxHeight:'75vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Выбери упражнение</span>
              <button onClick={()=>setPickerFor(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <input value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)} placeholder="Поиск..." autoFocus
              style={{ width:'100%', marginBottom:12, padding:'9px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:2 }}>
              {catalogExercises.filter(e=>(e.label||e.n).toLowerCase().includes(pickerQuery.toLowerCase())||e.n.toLowerCase().includes(pickerQuery.toLowerCase())).map(e=>(
                <button key={e.n} onClick={()=>addExercise(pickerFor,e.n)}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', width:'100%', padding:'9px 10px', border:'none', background:'transparent', cursor:'pointer', textAlign:'left', borderRadius:8 }}
                  onMouseEnter={ev=>ev.currentTarget.style.background='#f9fafb'} onMouseLeave={ev=>ev.currentTarget.style.background='transparent'}>
                  <span style={{ fontSize:13, color:TXT }}>{e.label||e.n}</span>
                  <span style={{ fontSize:11, color:TXT3 }}>{e.m}{e.eq?` · ${e.eq}`:''}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Копирование тренировки на несколько дат — та же месячная сетка,
          тап переключает отметку. Если на дате уже есть тренировка — спросим. */}
      {copyWi!=null&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={()=>{setCopyWi(null);setCopySel([])}}>
          <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:400, maxHeight:'85vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
              <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Копировать на даты</span>
              <button onClick={()=>{setCopyWi(null);setCopySel([])}} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ fontSize:12, color:TXT3, marginBottom:12 }}>Отметь дни — тренировка скопируется на каждый.</div>
            {monthHead(copyMonth,setCopyMonth)}
            {monthGrid(copyMonth,(key,d)=>{
              const has=workouts.some(w=>w.date===key)
              const picked=copySel.includes(key)
              return (
                <button key={key} onClick={()=>toggleCopyDate(key)}
                  style={{ position:'relative', aspectRatio:'1', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:10, cursor:'pointer', fontSize:13, fontWeight:600, padding:0, boxSizing:'border-box',
                    border:'1.5px solid transparent', background:picked?PUR:'transparent', color:picked?'#fff':TXT }}>
                  {d}
                  {has&&<span style={{ position:'absolute', bottom:4, width:5, height:5, borderRadius:'50%', background:picked?'#fff':PUR }} />}
                </button>
              )
            })}
            <button onClick={applyCopy} disabled={!copySel.length}
              style={{ width:'100%', marginTop:14, padding:'12px', fontSize:14, borderRadius:12, border:'none', background:copySel.length?`linear-gradient(180deg, ${ACCENT2}, ${PUR})`:SURF2, color:copySel.length?'#fff':TXT3, fontWeight:800, cursor:copySel.length?'pointer':'default' }}>
              Скопировать на {copySel.length} {dateCountWord(copySel.length)}
            </button>
          </div>
        </div>
      )}

      {/* Назначить дату тренировке без даты — та же сетка, но одна дата. */}
      {assignWi!=null&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={()=>setAssignWi(null)}>
          <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:400, maxHeight:'85vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
              <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Назначить дату</span>
              <button onClick={()=>setAssignWi(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ fontSize:12, color:TXT3, marginBottom:12 }}>Тап по дню перенесёт тренировку на эту дату.</div>
            {monthHead(assignMonth,setAssignMonth)}
            {monthGrid(assignMonth,(key,d)=>{
              const has=workouts.some((w,i)=>w.date===key&&i!==assignWi)
              const isToday=key===todayKey
              return (
                <button key={key} onClick={()=>assignDate(key)}
                  style={{ position:'relative', aspectRatio:'1', display:'flex', alignItems:'center', justifyContent:'center', borderRadius:10, cursor:'pointer', fontSize:13, fontWeight:600, padding:0, boxSizing:'border-box',
                    border:isToday?`1.5px solid ${PUR}`:'1.5px solid transparent', background:'transparent', color:TXT }}>
                  {d}
                  {has&&<span style={{ position:'absolute', bottom:4, width:5, height:5, borderRadius:'50%', background:PUR }} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
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

const FOLDER_ICONS={'Full Body':'dumbbell','Сплит':'lightning','Похудение':'runner','Домашние тренировки':'house'}
// Иконка папки: у новых программ ключа в FOLDER_ICONS нет → дефолт, чтобы список
// не падал на отсутствующей иконке.
const folderIcon=key=>FOLDER_ICONS[key]||'dumbbell'
// slugify ключа новой программы (латиница/цифры/дефис) — зеркало slugify в
// api/create-video-upload. Ключ создаётся один раз и НЕ меняется (переименование
// идёт через display_name).
const KEY_TRANSLIT={ а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }
const slugifyKey=s=>((s||'').toLowerCase().split('').map(c=>KEY_TRANSLIT[c]??c).join('').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-+/g,'-'))||'program'
// Описания программ для карточки-инфо ("?" на карточке в списке программ) —
// словарь, а не хардкод в разметке, чтобы новые программы (обещано 7+)
// добавлялись одной строкой здесь, без правки самого рендера.
const FOLDER_DESCRIPTIONS={
  'Full Body':'Тренировка на всё тело',
  'Сплит':'Тренировка, разделённая по группам мышц (например пн — грудь и трицепс)',
  'Похудение':'Силовые + функциональные тренировки',
  'Домашние тренировки':'Тренировки дома с минимальным оборудованием (резинки и т.п.)',
}
const SLOT_COUNT=12
const SUPERSET_COLORS={'A':PUR,'B':TEA,'C':COR,'D':BLU}
// Сентинел для profiles.program, когда выбрана программа тренера, а не
// шаблонная папка. Специально не совпадает ни с одним ключом FOLDERS — иначе
// подсветка шаблонов (selectedProgram===folder) ложно бы срабатывала.
const TRAINER_PROGRAM_KEY='__trainer__'
// Тексты progressNote холодного старта (см. кнопку "▶ Начать тренировку") —
// раньше показывались инлайн в карточке упражнения, теперь объясняются
// модалкой "Откуда взялся этот вес" (showProgressionIntro), инлайн-строку
// для них не рендерим (см. ниже). Два варианта — кг-ось и ось резины/
// повторений домашней программы, тексты заданы в workoutPrompt.js-логике.
const COLD_START_NOTES=new Set(['Стартовый вес из программы — дальше подстроим под тебя','Стартовая нагрузка из программы'])
// Склонение "раз"/"раза" для счётчика повторных прохождений тренировки слота
// (карточка слота в списке программы, "✓ 14 июля · N раза").
const pluralizeTimes=n=>{
  const mod10=n%10,mod100=n%100
  if(mod10===1&&mod100!==11)return'раз'
  if(mod10>=2&&mod10<=4&&(mod100<10||mod100>=20))return'раза'
  return'раз'
}
// Русское склонение по числу: plural(5,'подход','подхода','подходов') → 'подходов'.
const plural=(n,one,few,many)=>{const m=Math.abs(n)%100,d=m%10;if(m>10&&m<20)return many;if(d>1&&d<5)return few;if(d===1)return one;return many;}
// Расшифровка оценки тяжести подхода (1-5, workout_sets.rating) — общая для
// шкалы в активной тренировке (WorkoutsView) и истории в Дневнике (DiaryView):
// без этой оценки невозможно понять, почему движок прогрессии изменил вес.
const RATING_LABELS={1:'легко',2:'легковато',3:'в рабочем режиме',4:'тяжело',5:'на пределе'}

// programsMap/folders по умолчанию — зашитые (запасной вариант, если база не
// ответила). Приложение передаёт сюда структуры/ключи из program_templates.
const makeDefaultSlots=(folder,programsMap=PROGRAMS_MAP)=>{
  const prog=programsMap[folder]
  // Длина — из самой программы (шаблоны бывают любой длины), запасной вариант
  // SLOT_COUNT, если структуры нет.
  const len=Array.isArray(prog)&&prog.length?prog.length:SLOT_COUNT
  return Array.from({length:len},(_,i)=>{
    const slotId=`${folder.replace(/\s+/g,'_')}_${i+1}`
    const exercises=prog&&prog[i]
      ?prog[i].map(ex=>({id:`${slotId}_ex${ex.num}`,num:ex.num,name:ex.name,sets:ex.sets,superset:ex.superset||null,videoId:null,videoUrl:null,videoName:null}))
      :[]
    return {id:slotId,slotNum:i+1,title:`Тренировка ${i+1}`,exercises}
  })
}

const makeDefaultFolderSlots=(folders=FOLDERS,programsMap=PROGRAMS_MAP)=>{
  const o={}; folders.forEach(f=>{o[f]=makeDefaultSlots(f,programsMap)}); return o
}

// hasTrainer — «к клиенту прикреплён тренер» (profiles.coach_id). Раньше проп
// назывался isPremium, что путало с пакетом ПРЕМИУМ: это разные вещи, подписка
// приходит отдельно, в accessLevel.
// accessLevel — уровень пакета: тренировки 4–12 в шаблонах требуют БАЗУ (1),
// в СТАРТ (0) открыты только первые FREE_SLOTS.
function WorkoutsView({ customExercises, setCustomExercises, onWorkoutComplete, onWorkoutUpdate, editTarget, onClearEdit, onWorkoutMeta, pendingAction, onClearPendingAction, userId, historyVersion, onMinimize, hasTrainer, coachSubExpired = false, accessLevel = 0, openPlans, exerciseVideos = {}, userRole = 'client', setExerciseVideos, onOpenConstructor }) {
  const { exercises: catalogExercises } = useContext(CatalogContext)
  // Шаблоны программ — из базы (program_templates) с запасным вариантом из кода.
  // folderKeys — КЛЮЧИ (profiles.program, префиксы workouts держатся за них),
  // folderLabel — как показать ключ на экране.
  const { folders: templateFolders, structures: templateStructures, reload: reloadTemplates } = useContext(TemplatesContext)
  const folderKeys = templateFolders.map(f=>f.key)
  const folderLabel = key => (templateFolders.find(t=>t.key===key)||{}).label || key
  // Редактор шаблона (тренер): {key,isNew,initialDisplayName,initialContext,initialSort} | null
  const [templateEditor,setTemplateEditor]=useState(null)
  // После публикации: перечитать шаблоны (метки/label/контекст/новые папки) и
  // ПЕРЕСОБРАТЬ слоты папки из НОВОЙ структуры — иначе тренер не увидит правку,
  // а удалённое упражнение воскресло бы из localStorage-кеша folderSlots.
  // Отметки о выполнении слотов держатся в истории тренировок (не в folderSlots),
  // поэтому не теряются. Эффект-писатель folderSlots сам обновит кеш.
  const onTemplatePublished=(key,structure)=>{
    reloadTemplates?.()
    if(structure) setFolderSlots(prev=>({...prev,[key]:makeDefaultSlots(key,{[key]:structure})}))
  }
  // Новая программа: спрашиваем имя, key — slug из имени (уникальный среди
  // видимых), sort — максимум+1, context — по умолчанию 'zal', структура —
  // один пустой слот. key потом НЕ меняется, переименование через display_name.
  const createProgram=()=>{
    const name=(window.prompt('Название новой программы')||'').trim()
    if(!name)return
    let key=slugifyKey(name), n=2
    while(folderKeys.includes(key)){key=`${slugifyKey(name)}-${n++}`}
    const maxSort=templateFolders.reduce((m,f)=>Math.max(m,typeof f.sort==='number'?f.sort:0),-1)
    setTemplateEditor({key,isNew:true,initialDisplayName:name.slice(0,100),initialContext:'zal',initialSort:maxSort+1})
  }
  // Подсказка «нужен пакет БАЗА» — показывается модалкой поверх списка слотов.
  const [showSlotLock,setShowSlotLock]=useState(false)
  // Заперт ли слот: платная часть шаблона начинается с FREE_SLOTS+1.
  const isSlotLocked=slotNum=>accessLevel<SLOTS_MIN_LEVEL&&slotNum>FREE_SLOTS
  const [openFolder,setOpenFolder]=useState(null)
  const [infoFolder,setInfoFolder]=useState(null) // карточка-описание программы ("?")
  const [selectedProgram,setSelectedProgram]=useState(null) // выбранная программа клиента (profiles.program)
  const [openSlotId,setOpenSlotId]=useState(null)
  const [openSlotHeaderMenu,setOpenSlotHeaderMenu]=useState(false)
  const [openExMenu,setOpenExMenu]=useState(null)
  // Закрытие по тапу мимо — общим хуком, без прозрачной плёнки поверх меню
  // (см. useCloseOnOutsideTap в src/uiCompat.js и комментарий в DiaryView).
  const slotHeaderMenuRef=useRef(null)
  const exMenuRef=useRef(null)
  useCloseOnOutsideTap(slotHeaderMenuRef,openSlotHeaderMenu?()=>setOpenSlotHeaderMenu(false):null)
  useCloseOnOutsideTap(exMenuRef,openExMenu!=null?()=>setOpenExMenu(null):null)
  const [folderSlots,setFolderSlots]=useState(()=>makeDefaultFolderSlots(folderKeys,templateStructures))
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
      const loaded=makeDefaultFolderSlots(folderKeys,templateStructures)
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
  // Редактор видео упражнения — тренеру, прямо из шаблонов/активной тренировки.
  const isTrainer=userRole==='trainer'
  const [videoPickerFor,setVideoPickerFor]=useState(null) // имя упражнения или null
  // Контекст видео по папке: домашние → 'dom', остальные шаблоны → 'zal'.
  const folderToContext=folder=>(templateFolders.find(t=>t.key===folder)||{}).context||FOLDER_CTX_FALLBACK(folder)
  // Контекст активной тренировки — запоминаем в момент запуска: на экране
  // активной тренировки папки уже нет под рукой. null = общий ролик (тренерская
  // программа / возобновление без известной папки).
  const [activeVideoCtx,setActiveVideoCtx]=useState(null)
  // id запланированной тренировки, из которой запустили текущую (иначе null).
  // По завершении сохранения — удаляем эту строку из planned_workouts.
  const [startedFromPlanId,setStartedFromPlanId]=useState(null)
  // Персональная программа от тренера (assigned_programs, Фаза B, шаг 2) —
  // только показ. Запуск тренировки из неё через движок прогрессии — отдельный
  // следующий шаг, здесь его нет. Нет строки для этого клиента — обычный
  // пользователь без тренера, баннер просто не показываем (ничего не ломаем).
  const [assignedProgram,setAssignedProgram]=useState(null)
  const [assignedProgramLoading,setAssignedProgramLoading]=useState(true)
  const [assignedProgramError,setAssignedProgramError]=useState(false)
  // Программа свёрнута в карточку-папку, содержимое — в модалке по клику.
  const [programOpen,setProgramOpen]=useState(false)
  // Индекс открытой тренировки внутри модалки программы (null — список).
  const [openProgramWorkoutIdx,setOpenProgramWorkoutIdx]=useState(null)
  // Секция «Раньше» (прошедшие даты) по умолчанию свёрнута.
  const [showPastWorkouts,setShowPastWorkouts]=useState(false)
  const loadAssignedProgram=()=>{
    if(!userId){setAssignedProgramLoading(false);return}
    setAssignedProgramLoading(true);setAssignedProgramError(false)
    supabase.from('assigned_programs').select('*').eq('client_id',userId).maybeSingle().then(({data,error})=>{
      if(error){console.error('Ошибка загрузки программы от тренера:',error);setAssignedProgramError(true);setAssignedProgramLoading(false);return}
      setAssignedProgram(data||null)
      setAssignedProgramLoading(false)
    })
  }
  useEffect(()=>{loadAssignedProgram()},[userId])
  // ── Даты программы от тренера ──────────────────────────────────────────────
  const MONTHS_GEN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
  const DOW_SHORT=['вс','пн','вт','ср','чт','пт','сб'] // getDay(): 0=вс
  // Дату 'ГГГГ-ММ-ДД' собираем по частям в МЕСТНУЮ дату — new Date(строка) дал
  // бы UTC и уехал бы на день (см. localTodayISO выше, комментарий на стр. 44).
  const parseLocalDate=key=>{const[y,m,d]=key.split('-').map(Number);return new Date(y,m-1,d)}
  const dateShort=key=>{const d=parseLocalDate(key);return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`}
  const dayKeyOffset=(key,delta)=>{const d=parseLocalDate(key);d.setDate(d.getDate()+delta);const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`}
  // Подпись даты: сегодня/завтра/вчера словом, остальное — «27 июля, пн».
  const dateLabel=key=>{
    const today=localTodayISO()
    if(key===today)return 'Сегодня'
    if(key===dayKeyOffset(today,1))return 'Завтра'
    if(key===dayKeyOffset(today,-1))return 'Вчера'
    const d=parseLocalDate(key)
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, ${DOW_SHORT[d.getDay()]}`
  }
  // Тренировки по секциям с СОХРАНЁННЫМ исходным индексом i в structure —
  // сортируем пары {w,i}, а не сам массив, иначе клиент запустит не ту.
  const groupProgramWorkouts=structure=>{
    const pairs=(Array.isArray(structure)?structure:[]).map((w,i)=>({w,i}))
    const today=localTodayISO()
    return {
      todayList:pairs.filter(p=>p.w.date===today),
      future:pairs.filter(p=>p.w.date&&p.w.date>today).sort((a,b)=>a.w.date<b.w.date?-1:1),
      past:pairs.filter(p=>p.w.date&&p.w.date<today).sort((a,b)=>a.w.date>b.w.date?-1:1),
      dateless:pairs.filter(p=>!p.w.date),
    }
  }
  const [wName,setWName]=useState('Новая тренировка')
  // Цвет тренировки убран из интерфейса — всегда фиолетовый. Все места, что его
  // читают (шапка, кнопки, чипы, бейджи, галочка), подхватывают PUR сами.
  const wColor = PUR
  const [wExercises,setWExercises]=useState([])
  const [wMode,setWMode]=useState('start') // 'start' | 'log'
  const [wDate,setWDate]=useState('')
  // Дата больше не висит постоянно в шапке — спрашивается только в момент
  // реального сохранения (через "Сохранить" в окошке выхода, либо через
  // основную кнопку "Завершить"/"Сохранить" внизу экрана).
  const [showExitConfirm,setShowExitConfirm]=useState(false)
  const [showDatePicker,setShowDatePicker]=useState(false)

  // Плашка-объяснение от AI-ассистента на первом экране активной тренировки —
  // показывается один раз за всё время, дальше флаг в localStorage её глушит навсегда.
  const [showAiTip,setShowAiTip]=useState(false)
  useEffect(()=>{
    if(step!=='active')return
    let seen=false
    try{seen=localStorage.getItem('fitpro_active_ai_tip_seen')==='1'}catch{}
    if(!seen)setShowAiTip(true)
  },[step])
  const dismissAiTip=()=>{
    try{localStorage.setItem('fitpro_active_ai_tip_seen','1')}catch{}
    setShowAiTip(false)
  }

  // Модалка "Откуда взялся этот вес" — объясняет холодный старт (красная
  // рамка на подходах из шаблона программы), в отличие от showAiTip выше
  // показывается ПРИ КАЖДОЙ тренировке, где есть хотя бы один такой подход
  // (не один раз навсегда), пока клиент сам не поставит галочку "Больше не
  // показывать" (fitpro_hide_progression_intro). Открывается и вручную,
  // иконкой "?" в шапке — тогда независимо от галочки.
  const [showProgressionIntro,setShowProgressionIntro]=useState(false)
  const [progressionIntroDontShow,setProgressionIntroDontShow]=useState(false)
  const dismissProgressionIntro=()=>{
    if(progressionIntroDontShow){try{localStorage.setItem('fitpro_hide_progression_intro','1')}catch{}}
    setShowProgressionIntro(false)
  }

  // "Начать новую поверх свёрнутой" — если step уже 'active' (пусть даже
  // тренировка сейчас свёрнута), новый старт не затирает её молча: действие
  // откладывается сюда, модалка (см. return ниже) спрашивает подтверждение.
  const [pendingConflictStart,setPendingConflictStart]=useState(null) // fn | null
  const confirmStartOverActive=()=>{
    const run=pendingConflictStart
    setPendingConflictStart(null)
    exitWorkout() // отбрасывает свёрнутую тренировку и её черновик — как "Выйти без сохранения"
    if(run)run()
  }
  const cancelStartOverActive=()=>setPendingConflictStart(null)

  // Предупреждение о правке повторений — только для тренировок, реально
  // запущенных из слота программы (wIsFromProgram, ставится в
  // startSlotWorkout, сбрасывается при ручном старте/логировании и при
  // редактировании прошлой тренировки). Повторения задают фазу цикла
  // (объём/развитие/сила) — движок их не трогает, а правка руками уводит
  // клиента из фазы, хоть расчёт веса и отработает любые цифры (это НЕ
  // ошибка данных). Показываем один раз за тренировку, не на каждый подход —
  // repsWarningShownThisWorkout взводится при первом срабатывании и больше
  // не сбрасывается до конца сессии (даже если клиент нажмёт "Вернуть как было").
  const [wIsFromProgram,setWIsFromProgram]=useState(false)
  const [showRepsWarning,setShowRepsWarning]=useState(false)
  const [repsWarningShownThisWorkout,setRepsWarningShownThisWorkout]=useState(false)
  const [repsWarningRevert,setRepsWarningRevert]=useState(null) // {ei,si,prevValue}
  const handleRepsChange=(ei,si,newValue)=>{
    const prevValue=wExercises[ei]?.sets[si]?.reps
    setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,reps:newValue}:s)}:x))
    if(wIsFromProgram&&!repsWarningShownThisWorkout&&newValue!==prevValue){
      setRepsWarningShownThisWorkout(true)
      setRepsWarningRevert({ei,si,prevValue})
      setShowRepsWarning(true)
    }
  }
  const revertRepsWarning=()=>{
    if(repsWarningRevert){
      const{ei,si,prevValue}=repsWarningRevert
      setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,reps:prevValue}:s)}:x))
    }
    setShowRepsWarning(false)
  }

  // Удаление упражнения на ЖИВОЙ тренировке — ничего не пишет в Supabase и
  // не трогает историю, просто убирает элемент из wExercises: в базу при
  // сохранении попадёт только то, что осталось (insertWorkoutSetsRows идёт
  // по wExercises целиком). Черновик в localStorage обновится сам — эффект
  // сохранения черновика уже следит за wExercises в зависимостях (см. ниже).
  // Последнее оставшееся упражнение не удаляем — кнопку для него просто не
  // показываем (см. рендер карточки), отдельного экрана-заглушки не нужно.
  const [removeExerciseConfirm,setRemoveExerciseConfirm]=useState(null) // {ei,name} | null
  const confirmRemoveExercise=()=>{
    if(!removeExerciseConfirm)return
    const{ei}=removeExerciseConfirm
    setWExercises(p=>p.filter((_,i)=>i!==ei))
    setRemoveExerciseConfirm(null)
  }

  // Таймер тренировки и секундомер — считаются ОТ ОТМЕТКИ ВРЕМЕНИ
  // (startedAt/swStartedAt, Date.now()), а не прибавлением +1 в setInterval.
  // КРИТИЧНО для свёрнутой тренировки: iOS душит таймеры фоновых вкладок —
  // setInterval(()=>setTimer(t=>t+1),1000) в фоне тикает реже раза в
  // секунду и отстаёт от реальности. Date.now()-startedAt всегда точен,
  // сколько бы тиков ни было пропущено — интервал ниже нужен только чтобы
  // перерисовать компонент раз в секунду, а не чтобы накапливать время.
  const [startedAt,setStartedAt]=useState(null) // ms, Date.now() на старте тренировки
  const [nowTick,setNowTick]=useState(()=>Date.now())
  const timer=startedAt?Math.max(0,Math.floor((nowTick-startedAt)/1000)):0

  // Секундомер — та же модель, но с паузой: swAccumMs копит время УЖЕ
  // завершённых запусков, swStartedAt — отметка ТЕКУЩЕГО запуска (null на
  // паузе). Итоговое время — сумма накопленного и (если не на паузе) того,
  // что прошло с текущего старта — пауза не теряет накопленное, как раньше
  // терялась бы при простом +1 в setInterval, если бы интервал не успевал
  // тикать в фоне.
  const [swAccumMs,setSwAccumMs]=useState(0)
  const [swStartedAt,setSwStartedAt]=useState(null)
  const swRunning=swStartedAt!=null
  const swTime=Math.floor((swAccumMs+(swStartedAt?Math.max(0,nowTick-swStartedAt):0))/1000)
  const toggleStopwatch=()=>{
    if(swStartedAt!=null){
      setSwAccumMs(a=>a+Math.max(0,Date.now()-swStartedAt))
      setSwStartedAt(null)
    } else {
      setSwStartedAt(Date.now())
    }
  }
  const resetStopwatch=()=>{setSwStartedAt(null);setSwAccumMs(0)}

  const [pickOpen,setPickOpen]=useState(false)
  const [pickQ,setPickQ]=useState('')
  const [pickMuscle,setPickMuscle]=useState('Все')

  const [customOpen,setCustomOpen]=useState(false)
  const [customForm,setCustomForm]=useState({n:'',m:'',eq:''})
  const [isEditMode,setIsEditMode]=useState(false)
  const [wComment,setWComment]=useState('')
  const [openSetNote,setOpenSetNote]=useState(null) // {ei,si}
  const [showSendModal,setShowSendModal]=useState(false)
  const [sendCopied,setSendCopied]=useState(false)
  const [showFinishToast,setShowFinishToast]=useState(false)
  const [showSaveError,setShowSaveError]=useState(false)
  const [showProgramSaveError,setShowProgramSaveError]=useState(false)
  const [showCustomExerciseSaveError,setShowCustomExerciseSaveError]=useState(false)

  // ─────────────────────────────────────────────────────────────────────
  // Черновик активной тренировки в localStorage — переживает перезагрузку
  // страницы и закрытие приложения (в зале человек постоянно сворачивает и
  // возвращается). Персистим только СВЕЖИЕ тренировки (не редактирование
  // прошлой записи — isEditMode — там своя история, editTarget/histIdx,
  // персистить черновик для неё отдельная, более редкая история, вне
  // рамок этой задачи).
  // ─────────────────────────────────────────────────────────────────────
  const DRAFT_KEY='fitpro_active_workout'
  const draftRestoredRef=useRef(false) // однократная проверка при монтировании
  const [staleDraft,setStaleDraft]=useState(null) // черновик старше 24ч — ждёт решения клиента

  const applyDraft=(draft)=>{
    setWName(draft.wName||'Тренировка')
    setWExercises(draft.wExercises||[])
    setWMode(draft.wMode||'start')
    setWDate(draft.wDate||'')
    setWComment(draft.wComment||'')
    setStartedAt(draft.startedAt||Date.now())
    setWIsFromProgram(!!draft.wIsFromProgram)
    setRepsWarningShownThisWorkout(!!draft.repsWarningShownThisWorkout)
    setStep('active')
  }

  // Восстановление ОДИН раз при монтировании (WorkoutsView теперь смонтирован
  // всегда за время сессии — см. renderMain в App — поэтому это ровно момент
  // загрузки приложения, не каждое переключение вкладки).
  useEffect(()=>{
    if(draftRestoredRef.current)return
    draftRestoredRef.current=true
    let raw=null
    try{raw=localStorage.getItem(DRAFT_KEY)}catch{}
    if(!raw)return
    let draft=null
    try{draft=JSON.parse(raw)}catch{}
    if(!draft||!draft.startedAt)return
    const ageMs=Date.now()-draft.startedAt
    if(ageMs>24*3600*1000){
      setStaleDraft(draft)
      return
    }
    applyDraft(draft)
  },[])

  const confirmStaleDraft=()=>{
    if(staleDraft)applyDraft(staleDraft)
    setStaleDraft(null)
  }
  const discardStaleDraft=()=>{
    try{localStorage.removeItem(DRAFT_KEY)}catch{}
    setStaleDraft(null)
  }

  // Сохраняем на КАЖДОЕ изменение, пока тренировка активна — вес/повторы/
  // оценки/уровень резины уже внутри wExercises, отдельно перечислять поля
  // не нужно.
  useEffect(()=>{
    if(step!=='active'||isEditMode)return
    const draft={wName,wColor,wExercises,wMode,wDate,wComment,startedAt,wIsFromProgram,repsWarningShownThisWorkout}
    try{localStorage.setItem(DRAFT_KEY,JSON.stringify(draft))}catch{}
  },[step,isEditMode,wName,wColor,wExercises,wMode,wDate,wComment,startedAt,wIsFromProgram,repsWarningShownThisWorkout])

  // Текущая выбранная клиентом программа — для подсветки карточки галочкой.
  useEffect(()=>{
    if(!userId)return
    let cancelled=false
    supabase.from('profiles').select('program').eq('id',userId).single().then(({data})=>{
      if(!cancelled&&data)setSelectedProgram(data.program||null)
    })
    return()=>{cancelled=true}
  },[userId])

  // Пишет выбранную программу в profiles.program. ДОЖИДАЕМСЯ записи и
  // проверяем error, прежде чем менять локальный стейт — раньше галочка
  // "программа выбрана" подставлялась оптимистично СРАЗУ, до подтверждения
  // записи в Supabase (fire-and-forget без await); если запрос падал
  // (сеть, RLS), UI молча врал — показывал программу выбранной, а в БД
  // оставалось старое значение. Теперь при ошибке checkmark не появляется,
  // модалка-источник вызова остаётся открытой (см. её кнопку — retry без
  // повторной навигации), клиенту показывается тост-ошибка.
  const selectProgram=async(folder)=>{
    if(!userId)return{ok:false}
    const{error}=await supabase.from('profiles').update({program:folder}).eq('id',userId)
    if(error){
      console.error('Ошибка сохранения выбранной программы:',error)
      setShowProgramSaveError(true)
      setTimeout(()=>setShowProgramSaveError(false),3500)
      return{ok:false}
    }
    setSelectedProgram(folder)
    setInfoFolder(null)
    return{ok:true}
  }

  // Выбор программы тренера как активной. profiles.program пишем сентинелом —
  // никакой логики циклов/адаптации шаблона тут нет (её у программы тренера и
  // не бывает), только отметка «клиент тренируется по этой программе».
  // Колонка program не под защитой триггера, клиент пишет её сам — как
  // selectProgram выше.
  const selectTrainerProgram=async()=>{
    if(!userId)return
    const{error}=await supabase.from('profiles').update({program:TRAINER_PROGRAM_KEY}).eq('id',userId)
    if(error){
      console.error('Ошибка выбора программы тренера:',error)
      setShowProgramSaveError(true)
      setTimeout(()=>setShowProgramSaveError(false),3500)
      return
    }
    setSelectedProgram(TRAINER_PROGRAM_KEY)
  }

  // Второй путь выбора программы — прямо из "▶ Начать тренировку" в слоте
  // (первый путь остаётся: "?" на карточке -> "Тренироваться по этой
  // программе"). Модалки для двух случаев: программа вообще не выбрана
  // (showAdoptProgramModal, простое подтверждение), и выбрана ДРУГАЯ
  // программа с выполненными тренировками (showSwitchProgramModal, нужно
  // явное согласие клиента на переключение).
  const [showAdoptProgramModal,setShowAdoptProgramModal]=useState(false)
  const [showSwitchProgramModal,setShowSwitchProgramModal]=useState(null) // {from,to,count}

  // "Круг" программы — момент последнего "Пройти заново" (см. задачу про
  // завершение программы). Пока круг не сбрасывали ни разу — вся история
  // считается (ключа в localStorage просто нет, since=null, фильтр не
  // применяется). После сброса галочки/счётчик "выполнено N из 12" должны
  // показывать прогресс ТЕКУЩЕГО круга, а не всех кругов за всё время —
  // иначе клиент не поймёт, где он в новом прохождении. Дата круга хранится
  // как ДЕНЬ (YYYY-MM-DD, localTodayISO()), а не точный момент — дата
  // тренировки хранится с якорем на полдень (см. confirmSaveWithDate), и
  // сравнение "точный таймстамп сброса vs дата тренировки" ломалось: "Пройти
  // заново" после полудня делало сброс "позже" тренировки того же дня, и она
  // выпадала из нового круга. Сравниваем по дню с ОБЕИХ сторон (.slice(0,10))
  // — это заодно совместимо со старыми cycleStart, сохранёнными как полный
  // таймстамп до этой правки (без миграции).
  const cycleStartKey=programName=>`fitpro_cycle_start_${programName}`
  const getCycleStart=programName=>{
    try{return localStorage.getItem(cycleStartKey(programName))}catch{return null}
  }
  const workoutsSinceCycleStart=programName=>{
    const since=getCycleStart(programName)
    return since?workoutsLog.filter(w=>(w.date||'').slice(0,10)>=(since||'').slice(0,10)):workoutsLog
  }

  // N выполненных тренировок программы (текущего круга) — считаем по
  // УНИКАЛЬНЫМ номерам слота, а не по общему числу записей workouts (клиент
  // мог пройти "тренировку 3" дважды — это не два разных пункта из 12, а
  // один и тот же выполненный). Сама логика — в programs.js
  // (countCompletedProgramSlots), общая с определением завершения программы
  // ниже, отдельным от прогрессии запросом (см. задачу).
  const countCompletedSlots=programName=>countCompletedProgramSlots(workoutsSinceCycleStart(programName),programName)

  // ─────────────────────────────────────────────────────────────────────
  // Завершение программы (12 из 12) — модалка-поздравление. См. заголовок
  // задачи: это ОТДЕЛЬНЫЙ от прогрессии запрос (имя ТРЕНИРОВКИ, не
  // упражнения), не смешивать с setsHistory/buildExerciseAggregates выше.
  // ─────────────────────────────────────────────────────────────────────
  const [completedProgramModal,setCompletedProgramModal]=useState(null) // programName | null

  // Флаг "уже показали поздравление за ЭТОТ круг" — параметризован
  // cycleStart, чтобы после "Пройти заново" завершение НОВОГО круга снова
  // показало модалку один раз, а не молчало навсегда.
  const completedFlagKey=(programName,cycleStart)=>`fitpro_program_completed_${programName}_${cycleStart||'initial'}`

  // Вызывается из finishWorkout СРАЗУ после подтверждённого сохранения —
  // savedName это wName только что сохранённой тренировки, freshLog —
  // результат await loadWorkoutsLog() (не устаревший workoutsLog из
  // замыкания). Если сохранённая тренировка не из программы (ручной
  // старт/лог) — savedName не матчит ни один "{X} — тренировка N", смотреть
  // нечего.
  const checkProgramCompletion=(savedName,freshLog)=>{
    const programName=folderKeys.find(f=>savedName&&savedName.startsWith(`${f} — тренировка `))
    if(!programName)return
    const cycleStart=getCycleStart(programName)
    const relevant=cycleStart?freshLog.filter(w=>(w.date||'').slice(0,10)>=(cycleStart||'').slice(0,10)):freshLog
    // Всего слотов — из базы (запасной вариант внутри самой функции, из PROGRAMS_MAP).
    if(!isProgramFullyCompleted(relevant,programName,templateStructures[programName]?.length))return
    const flagKey=completedFlagKey(programName,cycleStart)
    let alreadyShown=false
    try{alreadyShown=localStorage.getItem(flagKey)==='1'}catch{}
    if(alreadyShown)return
    try{localStorage.setItem(flagKey,'1')}catch{}
    setCompletedProgramModal(programName)
  }

  // "Пройти {X} заново" — новый круг: сбрасываем ТОЧКУ ОТСЧЁТА для галочек/
  // счётчика (workoutsSinceCycleStart), саму историю подходов (workout_sets)
  // НЕ трогаем — на ней держится прогрессия второго круга (см. задачу,
  // тренировка 1 не должна снова стать холодным стартом). profiles.program
  // остаётся той же программой X — тут менять нечего, она и так выбрана.
  const startNewProgramCycle=(programName)=>{
    const now=localTodayISO()
    try{localStorage.setItem(cycleStartKey(programName),now)}catch{}
    setCompletedProgramModal(null)
    setOpenFolder(programName)
  }

  // "Выбрать другую программу" — просто вернуть к списку программ; смена
  // программы дальше идёт штатным флоу (handleStartSlotClick/
  // showSwitchProgramModal ниже) — клиент открывает другую папку и жмёт
  // "Начать тренировку" сам.
  const chooseOtherProgramFromCompletion=()=>{
    setCompletedProgramModal(null)
    setOpenFolder(null)
  }

  // История подходов клиента — опора движка прогрессии (buildExerciseAggregates/
  // computeTemplateScale, workoutPrompt.js) для кнопки "▶ Начать тренировку"
  // внутри слота шаблонной программы (см. ниже). Грузим сразу все подходы
  // пользователя одним запросом — агрегаты считаются на лету из плоского
  // списка, отдельного бэкенд-эндпоинта под конкретное упражнение нет.
  const [setsHistory,setSetsHistory]=useState([])
  const loadSetsHistory=async()=>{
    if(!userId)return
    const{data,error}=await supabase.from('workout_sets')
      .select('id,exercise,date,kg,reps,rating,workout_id,band_level').eq('user_id',userId).order('id')
    if(error){console.error('Ошибка загрузки истории подходов для прогрессии:',error);return}
    setSetsHistory(data||[])
  }
  // historyVersion (прокинут из App) растёт при КАЖДОМ подтверждённом
  // изменении тренировок — не только тех, что сделаны отсюда (finishWorkout
  // ниже и так дожидается своей записи и сам перечитывает историю), но и
  // сделанных из DiaryView (удаление/правка/копия) — отдельного компонента,
  // у которого нет доступа к setsHistory этого компонента. Без подписки на
  // historyVersion WorkoutsView, если он в этот момент смонтирован, продолжал
  // бы считать вес по уже удалённой/изменённой тренировке до следующего
  // размонтирования — движок прогрессии не хранит состояние сам, но UI должен
  // ему давать актуальные данные.
  useEffect(()=>{loadSetsHistory()},[userId,historyVersion])

  // Список сохранённых тренировок (id/name/date) — один запрос, переиспользуется
  // и для галочки "выполнено" на карточке слота (уровень 1 папки), и для
  // подсчёта N в модалке смены программы (уровень 2, кнопка "▶ Начать
  // тренировку"): оба места матчат name по шаблону "{Программа} — тренировка
  // {N}", им не нужны сами подходы, только сам факт и дата записи.
  const [workoutsLog,setWorkoutsLog]=useState([])
  // Возвращает свежие данные (не только пишет в state) — finishWorkout ниже
  // проверяет завершение программы СРАЗУ после сохранения, а состояние
  // workoutsLog в его замыкании обновится только на следующий рендер
  // (setState асинхронен); без этого проверка завершения смотрела бы на
  // устаревший список без только что сохранённой тренировки.
  const loadWorkoutsLog=async()=>{
    if(!userId)return[]
    const{data,error}=await supabase.from('workouts').select('id,name,date').eq('user_id',userId).order('date')
    if(error){console.error('Ошибка загрузки списка тренировок:',error);return[]}
    setWorkoutsLog(data||[])
    return data||[]
  }
  useEffect(()=>{loadWorkoutsLog()},[userId,historyVersion])

  useEffect(()=>{
    if(editTarget&&!isEditMode){
      const w=editTarget.workout
      setWName(w.name||'Тренировка')
      setWExercises((w.exercises||[]).map(ex=>({...ex,sets:(ex.sets||[]).map(s=>({...s})),done:false})))
      const isLog=w.duration===null||w.duration===undefined
      setWMode(isLog?'log':'start')
      if(w.date)setWDate(new Date(w.date).toISOString().split('T')[0])
      setStartedAt(Date.now());setSwAccumMs(0);setSwStartedAt(null)
      setWComment(w.comment||'')
      setIsEditMode(true)
      // Редактирование прошлой тренировки — не запуск из слота программы,
      // предупреждение про повторения (wIsFromProgram) здесь не показываем.
      setWIsFromProgram(false)
      setRepsWarningShownThisWorkout(false)
      setStep('active')
    }
  },[editTarget])

  // Небольшой снимок для плашки свёрнутой тренировки (App.jsx рендерит саму
  // плашку — ей нужен доступ к другим экранам/AI-кнопке для z-index, поэтому
  // проще отдать наверх три поля для отображения, чем выносить туда весь
  // стейт тренировки целиком (wExercises и т.п. остаются здесь). Таймер
  // считается на стороне плашки от startedAt самостоятельно.
  useEffect(()=>{
    if(onWorkoutMeta)onWorkoutMeta(step==='active'?{wName,wColor,startedAt}:null)
  },[step,wName,wColor,startedAt])

  // Если тренировка уже активна (в т.ч. свёрнута) — не затираем её молча
  // новым стартом: реальный путь сюда — "Начать тренировку" с Главной/из
  // Дневника (pendingAction), пока на экране тренировки была НЕ в фокусе
  // (см. isForeground/nav в App) — сам список программ, откуда вызывается
  // startSlotWorkout(), в это время недостижим (пока step==='active',
  // WorkoutsView всегда показывает именно активный экран — см. return ниже),
  // так что оттуда конфликт по факту не возникает, но проверка оставлена
  // и там как явная защита, а не только в этом эффекте.
  useEffect(()=>{
    if(!pendingAction||isEditMode)return
    // pendingAction — либо строка ('start'/'done'), либо {action, plan}.
    const act=typeof pendingAction==='string'?pendingAction:pendingAction.action
    const plan=typeof pendingAction==='string'?null:pendingAction.plan
    if(act==='start'||act==='done'||act==='template'){
      if(step==='active'){
        setPendingConflictStart(()=>()=>runHandleAction(act,plan))
      } else {
        runHandleAction(act,plan)
      }
      if(onClearPendingAction)onClearPendingAction()
    }
  },[pendingAction])

  // Единственная задача интервала — перерисовать (nowTick), не накапливать
  // время: сама величина всегда считается от startedAt/swStartedAt заново.
  // Работает даже если браузер пропустил часть тиков (свёрнутое приложение,
  // фоновая вкладка) — как только тик долетит, время досчитается верно.
  useEffect(()=>{
    const need=(step==='active'&&wMode==='start')||swRunning
    if(!need)return
    const id=setInterval(()=>setNowTick(Date.now()),1000)
    return ()=>clearInterval(id)
  },[step,wMode,swRunning])

  const fmt=s=>{
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  // Поля веса/повторений/уровня резины уже содержат рассчитанную рекомендацию —
  // тап должен выделять её целиком (первая же цифра заменяет), а не заставлять
  // стирать посимвольно. iOS Safari иногда не применяет select() синхронно
  // внутри onFocus — откладываем на следующий тик (setTimeout 0).
  const selectOnFocus=e=>{
    const el=e.target
    setTimeout(()=>el.select(),0)
  }

  // runHandleAction — сам сброс на новую тренировку, БЕЗ проверки конфликта
  // (проверка — в handleAction ниже и в pendingAction-эффекте выше). Нужна
  // отдельно, чтобы confirmStartOverActive мог вызвать её напрямую уже
  // ПОСЛЕ того как старая тренировка отброшена (exitWorkout), не проверяя
  // step повторно — на момент вызова setStep(null) из exitWorkout ещё не
  // долетел до этого замыкания (тот же тик), проверка увидела бы старое
  // значение и ошибочно посчитала бы это новым конфликтом.
  const runHandleAction=(key,plan=null)=>{
    setMenuOpen(false)
    const today=localTodayISO()
    // Ручной старт/логирование — не слот программы, предупреждение про
    // повторения (wIsFromProgram) здесь не показываем.
    setWIsFromProgram(false)
    setRepsWarningShownThisWorkout(false)
    // Запуск из плана — запоминаем его id (удалим после сохранения); дату из
    // плана НЕ берём — тренировка пишется на день, когда её реально сделали.
    setStartedFromPlanId(plan?.id||null)
    if(key==='start'){
      setWName(plan?.name||'Новая тренировка');setWExercises([]);setStartedAt(Date.now());setSwAccumMs(0);setSwStartedAt(null);setWMode('start');setWDate(today);setStep('naming')
    }
    if(key==='done'){
      setWName('Тренировка');setWExercises([]);setWMode('log');setWDate(today);setStep('naming')
    }
    if(key==='template'){
      // Запуск по сохранённому шаблону. Состав уже известен — модалку с
      // названием не показываем, сразу на активный экран. Упражнения приводим
      // к рабочему виду ТОЧНО как pickExercise. startedFromPlanId=null (выше):
      // шаблон не план, удалять после сохранения нечего.
      const exs=(plan?.exercises||[]).map(ex=>({...ex,sets:[{kg:'',reps:'',recKg:'',rating:''}],done:false}))
      setWName(plan?.name||'Тренировка');setWExercises(exs);setStartedAt(Date.now());setSwAccumMs(0);setSwStartedAt(null);setWMode('start');setWDate(today);setStep('active')
    }
  }
  // Точка входа с кнопок меню "Новая тренировка" — список программ (откуда
  // виден этот пункт меню) недостижим, пока step==='active' (см. return
  // ниже), так что на практике проверка здесь не срабатывает никогда, но
  // оставлена как явная защита на случай, если это когда-нибудь изменится.
  const handleAction=key=>{
    if(step==='active'){
      setMenuOpen(false)
      setPendingConflictStart(()=>()=>runHandleAction(key))
      return
    }
    runHandleAction(key)
  }

  const allExercises=[...catalogExercises,...customExercises]
  const muscles=['Все',...new Set(allExercises.map(e=>e.m))]
  const filteredEx=allExercises.filter(e=>(pickMuscle==='Все'||e.m===pickMuscle)&&((e.label||e.n).toLowerCase().includes(pickQ.toLowerCase())||e.n.toLowerCase().includes(pickQ.toLowerCase())))

  const pickExercise=ex=>{
    setWExercises(p=>[...p,{...ex,sets:[{kg:'',reps:'',recKg:'',rating:''}],done:false}])
    setPickOpen(false);setPickQ('');setPickMuscle('Все')
  }

  // Тот же класс бага, что чинили в selectProgram: раньше упражнение
  // попадало в локальный список и сразу в текущую тренировку СИНХРОННО, до
  // того как insert в custom_exercises вообще улетел. Если запись падала —
  // ошибка уходила только в консоль, клиент не видел ничего, а упражнение
  // оставалось в списке без supabaseId и пропадало из личной библиотеки при
  // следующей загрузке. Теперь ждём подтверждения записи и добавляем в
  // список (с supabaseId) только после него — как selectProgram.
  const saveCustomExercise=async()=>{
    if(!customForm.n.trim())return
    if(!userId)return
    const newEx={n:customForm.n.trim(),m:customForm.m.trim(),eq:customForm.eq.trim(),custom:true}
    const{data,error}=await supabase.from('custom_exercises').insert({user_id:userId,name:newEx.n,muscle_group:newEx.m||null,equipment:newEx.eq||null}).select('id').single()
    if(error){
      console.error('Ошибка синхронизации своего упражнения с Supabase:',error)
      setShowCustomExerciseSaveError(true)
      setTimeout(()=>setShowCustomExerciseSaveError(false),3500)
      return
    }
    const savedEx={...newEx,supabaseId:data?.id}
    setCustomExercises(p=>[...p,savedEx])
    pickExercise(savedEx)
    setCustomForm({n:'',m:'',eq:''})
    setCustomOpen(false)
  }

  const exitWorkout=()=>{
    setStep(null);setStartedAt(null);setSwAccumMs(0);setSwStartedAt(null);setWExercises([]);setWMode('start');setWDate('')
    setIsEditMode(false)
    setWComment('');setOpenSetNote(null);setShowSendModal(false)
    setShowExitConfirm(false);setShowDatePicker(false)
    setWIsFromProgram(false);setShowRepsWarning(false);setRepsWarningShownThisWorkout(false);setRepsWarningRevert(null)
    setStartedFromPlanId(null)
    try{localStorage.removeItem('fitpro_active_workout')}catch{}
    if(onClearEdit)onClearEdit()
  }

  // Свернуть — явный жест "хочу отсюда уйти" (крестик в шапке), но тренировка
  // НЕ прерывается: step остаётся 'active', таймер и wExercises не трогаем,
  // черновик в localStorage не удаляется. Просто закрываем модалку и просим
  // App увести nav с 'workouts' (тем же путём, что и обычный "назад") —
  // WorkoutsView остаётся смонтированным (см. renderMain в App), просто
  // перестаёт быть видимым экраном, вместо него везде показывается плашка
  // свёрнутой тренировки.
  const minimizeWorkout=()=>{
    setShowExitConfirm(false)
    if(onMinimize)onMinimize()
  }

  // Открывает выбор даты перед сохранением — по умолчанию сегодня, если дата
  // ещё не была выбрана (например при редактировании уже сохранённой
  // тренировки wDate уже стоит на её исходной дате — сохраняем).
  const openDatePicker=()=>{
    if(!wDate)setWDate(localTodayISO())
    setShowExitConfirm(false)
    setShowDatePicker(true)
  }

  const confirmSaveWithDate=()=>{
    setShowDatePicker(false)
    finishWorkout()
  }

  const finishWorkout=async()=>{
    if(wExercises.length>0){
      const date=wDate
        ?new Date(wDate+'T12:00:00').toISOString()
        :(isEditMode&&editTarget?editTarget.workout.date:new Date().toISOString())
      const updated={name:wName,color:wColor,exercises:wExercises,duration:wMode==='start'?timer:null,date,comment:wComment}
      // onWorkoutComplete/onWorkoutUpdate (handleWorkoutComplete/handleWorkoutUpdate
      // в App) теперь возвращают промис {ok}, который резолвится ПОСЛЕ реальной
      // записи в Supabase — ждём его перед перезагрузкой setsHistory, иначе
      // следующая тренировка в этой же сессии приложения посчитается по
      // устаревшей истории (buildExerciseAggregates ниже). Если запись
      // упала — не перезагружаем историю молча и не выходим с экрана, чтобы
      // клиент не потерял введённые данные и мог повторить попытку.
      const{ok}=isEditMode&&editTarget
        ?await onWorkoutUpdate(editTarget.histIdx,updated)
        :await onWorkoutComplete(updated)
      if(!ok){
        setShowSaveError(true)
        setTimeout(()=>setShowSaveError(false),3500)
        return
      }
      // Тренировка сохранена. Если запускали из запланированной — убираем план
      // из базы (не при редактировании). Ошибку только логируем: сохранение
      // тренировки из-за неё падать не должно. DiaryView перечитает список сам.
      if(startedFromPlanId&&!(isEditMode&&editTarget)){
        supabase.from('planned_workouts').delete().eq('id',startedFromPlanId)
          .then(({error})=>{if(error)console.error('Удаление плана после запуска тренировки:',error)})
        setStartedFromPlanId(null)
      }
      if(!(isEditMode&&editTarget)){
        setShowFinishToast(true)
        setTimeout(()=>setShowFinishToast(false),2500)
      }
      await loadSetsHistory()
      const freshWorkoutsLog=await loadWorkoutsLog()
      // Завершение программы — отдельная от прогрессии проверка (см.
      // checkProgramCompletion выше), по свежим данным (не по workoutsLog из
      // замыкания — тот обновится только на следующий рендер).
      checkProgramCompletion(wName,freshWorkoutsLog)
    }
    exitWorkout()
  }

  const exTonnage=ex=>ex.sets.reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)

  const formatWorkoutReport=()=>{
    const lines=[`🏋️ ${wName}`,`📅 ${new Date().toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})}`,'']
    wExercises.forEach((ex,ei)=>{
      lines.push(`${ei+1}. ${labelOf(catalogExercises,ex.n)}`)
      ex.sets.forEach((s,si)=>{
        const w=[]
        if(s.kg)w.push(`${s.kg} кг`)
        if(s.reps)w.push(`${s.reps} повт`)
        const nt=s.note?`\n      📝 ${s.note}`:''
        lines.push(`   ${si+1}. ${w.join(' × ')||'—'}${nt}`)
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

  // Запуск тренировки из слота программы (движок прогрессии, workoutPrompt.js)
  // — вынесено из onClick кнопки "▶ Начать тренировку" отдельной функцией,
  // т.к. теперь перед стартом нужна проверка выбранной программы
  // (handleStartSlotClick ниже, задача про выбор программы через "Начать
  // тренировку") — сам запуск может случиться не сразу по клику, а только
  // после подтверждения в модалке.
  const runStartSlotWorkout=()=>{
    // Гейт по пакету — здесь, а не в обработчиках кликов: через эту функцию
    // проходят ВСЕ пути запуска слота (кнопка "▶ Начать тренировку", модалки
    // "принять программу" и "сменить программу", отложенный старт после
    // конфликта с активной тренировкой). Поставь проверку выше — часть путей
    // осталась бы открытой.
    if(isSlotLocked(currentSlot.slotNum)){setOpenSlotId(null);setShowSlotLock(true);return}
    const exs=currentSlot.exercises.filter(e=>e.name)
    if(exs.length===0)return
    setWName(`${openFolder} — тренировка ${currentSlot.slotNum}`)
    // Движок прогрессии (1ПМ, workoutPrompt.js) — та же математика,
    // что использует test-progression-personas.js. ПОВТОРЕНИЯ
    // ВСЕГДА берутся из шаблона программы (parseTemplateSets),
    // движок их не меняет — пересчитывается только рабочий вес,
    // от накопленной истории этого упражнения (setsHistory,
    // см. выше).
    const aggregates=buildExerciseAggregates(setsHistory)
    // Вторая, независимая ось прогрессии — уровень резины/
    // повторения (домашняя программа, workoutPrompt.js:
    // computeProgressSteps/computeBandTarget). Отдельная
    // строка объяснения от кг-оси, т.к. текст завязан на
    // "шаги", а не на appliedPct/hardStreak.
    const bandProgressNote=(ts,agg)=>{
      if(!agg||!agg.sessions?.length)return'Стартовая нагрузка из программы'
      const steps=agg.progressSteps
      const prevSteps=computeProgressSteps(agg.sessions.slice(0,-1))
      const delta=steps-prevSteps
      if(delta<0)return'Снизили нагрузку — две прошлые тренировки дались тяжело'
      if(ts.bandLevel==null)return steps>0?'Добавлены повторения':'Держим нагрузку — прошлый раз был тяжёлым'
      if(delta>0){
        const prevTarget=computeBandTarget(ts,prevSteps)
        const currTarget=computeBandTarget(ts,steps)
        return currTarget.bandLevel>prevTarget.bandLevel
          ?'Резинка жёстче, повторения вернулись к базовым'
          :'Добавили повторений — прошлый раз дался легко'
      }
      return'Держим нагрузку — прошлый раз был тяжёлым'
    }
    const builtExercises=exs.map(ex=>{
      const templateSets=parseTemplateSets(ex.sets)
      const agg=aggregates[ex.name]
      // Клиент долго не ставит оценку — движок не должен молча растить вес
      // на угаданной "3" до бесконечности (см. unratedStreak в
      // buildExerciseAggregates). Резинки/повторения (домашняя программа) в
      // это правило пока не входят — своя, отдельная ось, см. bandProgressNote.
      const progressionStopped=!!(agg&&agg.unratedStreak>=UNRATED_STOP_AFTER)
      // Один коэффициент масштабирования на упражнение (computeTemplateScale,
      // workoutPrompt.js) — не вес под КАЖДЫЙ подход отдельно (так раньше
      // формула Эпли считала разминку "на отказ" на её же повторения и
      // разгоняла её быстрее рабочего подхода, а подходы с одинаковыми
      // повторениями схлопывались в один вес). Шаблон задаёт форму лестницы
      // весов, scale двигает её целиком — соотношение подходов сохраняется.
      const scale=(agg&&agg.anchorSet)?computeTemplateScale(agg.anchorSet,agg.lastSession.effRatings,templateSets,agg.hardStreak,progressionStopped,isOneSidedExercise(ex.name)):null
      // Одна строка объяснения на упражнение целиком (не на
      // подход) — все подходы упражнения используют один и тот
      // же appliedPct/hardStreak (кг-ось) или steps (ось
      // резины/повторений), так что строка берётся с ПЕРВОГО
      // подхода, для которого вообще посчиталась нагрузка.
      let progressNote=null
      let progressNoteSet=false
      const parsedSets=templateSets.map(ts=>{
        // Резина или голые повторения без снаряда (вес тела) —
        // это НЕ кг-ось: своя прогрессия по шагам, а не по 1ПМ.
        if(ts.templateKg==null){
          // То же правило "стоп без оценки", что и на кг-оси (progressionStopped
          // выше, общий на упражнение) — держим уровень резинки/повторения на
          // последней РЕАЛЬНО оценённой сессии, не даём им ползти вверх от
          // подставленной оценки 3 за пропущенные сессии.
          if(progressionStopped){
            if(!progressNoteSet){progressNote='Прогрессия нагрузки остановлена. Без твоей оценки я не могу безопасно повышать нагрузку — риск травмы. Оцени последние тренировки, и прогрессия продолжится.';progressNoteSet=true}
            // Держим на уровне ПОСЛЕ UNRATED_STOP_AFTER разрешённых приростов
            // (та же семантика, что и у кг-анкера ниже — не откатываем то, что
            // уже выросло за первые 2 неоценённые сессии, замораживаем только
            // сессии СВЕРХ этого порога).
            const heldSteps=computeProgressSteps(agg.sessions.slice(0,agg.sessions.length-Math.max(0,agg.unratedStreak-UNRATED_STOP_AFTER)))
            const bandTarget=computeBandTarget(ts,heldSteps)
            return{kg:'',bandLevel:bandTarget.bandLevel,reps:String(bandTarget.reps),recKg:'',rating:'',fromTemplate:false}
          }
          if(!progressNoteSet){progressNote=bandProgressNote(ts,agg);progressNoteSet=true}
          // Холодный старт (нет истории вообще) — всё из
          // шаблона как есть, steps=0.
          if(!agg||!agg.sessions?.length){
            return{kg:'',bandLevel:ts.bandLevel,reps:String(ts.reps),recKg:'',rating:'',fromTemplate:ts.bandLevel!=null}
          }
          const bandTarget=computeBandTarget(ts,agg.progressSteps)
          return{kg:'',bandLevel:bandTarget.bandLevel,reps:String(bandTarget.reps),recKg:'',rating:'',fromTemplate:false}
        }
        // Холодный старт: по упражнению ещё нет истории, либо в шаблоне
        // нечего масштабировать (scale===null) — подставляем стартовый
        // ориентир тренера как есть (красная рамка в UI, как и раньше).
        if(!scale){
          if(!progressNoteSet){progressNote='Стартовый вес из программы — дальше подстроим под тебя';progressNoteSet=true}
          return{kg:String(ts.templateKg),bandLevel:null,reps:String(ts.reps),recKg:'',rating:'',fromTemplate:true}
        }
        if(!progressNoteSet){
          progressNote=progressionStopped
            ?'Прогрессия нагрузки остановлена. Без твоей оценки я не могу безопасно повышать вес — риск травмы. Оцени последние тренировки, и прогрессия продолжится.'
            :scale.isDeload
            ?'Разгрузка: две тяжёлые тренировки подряд. Вес снижен намеренно, дальше снова пойдём вверх.'
            :scale.appliedPct>=7?'Прибавка больше обычной — прошлый раз дался легко'
            :scale.appliedPct===5?'Плановая прибавка'
            :'Осторожная прибавка — прошлый раз был тяжёлым'
          progressNoteSet=true
        }
        const rawKg=ts.templateKg*scale.scale
        const kg=roundToPlate(rawKg,plateStep(rawKg))
        return{kg:String(kg),bandLevel:null,reps:String(ts.reps),recKg:String(kg),rating:'',fromTemplate:false}
      })
      return{n:ex.name,m:'',eq:'',sets:parsedSets,done:false,progressNote,progressStopped:progressionStopped}
    })
    setWExercises(builtExercises)
    setWMode('start')
    setWDate('')
    setStartedAt(Date.now());setSwAccumMs(0);setSwStartedAt(null)
    // Тренировка реально запущена из слота программы — предупреждение про
    // правку повторений (handleRepsChange) действует именно для неё.
    setWIsFromProgram(true)
    setRepsWarningShownThisWorkout(false)
    setActiveVideoCtx(folderToContext(openFolder)) // зал/дом по папке слота
    setStep('active')
    setOpenSlotId(null)
  }
  // Точка входа кнопки "▶ Начать тренировку" — список программ (откуда она
  // вызывается) недостижим, пока step==='active' (см. return ниже), так что
  // на практике проверка здесь не срабатывает никогда, но оставлена как
  // явная защита на случай, если это когда-нибудь изменится (см. тот же
  // комментарий у handleAction).
  const startSlotWorkout=()=>{
    if(step==='active'){
      setPendingConflictStart(()=>runStartSlotWorkout)
      return
    }
    runStartSlotWorkout()
  }

  // Запуск тренировки из программы тренера. Сознательно БЕЗ движка прогрессии
  // (buildExerciseAggregates/computeTemplateScale, как в runStartSlotWorkout):
  // тренер задал конкретные веса и повторения, и клиент должен получить ровно
  // их — поэтому подходы собираются литерально из parseTemplateSets.
  const runTrainerWorkout=(workout)=>{
    const exs=(workout?.exercises||[]).filter(e=>e.name)
    if(exs.length===0)return
    const builtExercises=exs.map(ex=>{
      const templateSets=parseTemplateSets(ex.sets)
      const parsedSets=templateSets.map(ts=>({
        kg:ts.templateKg!=null?String(ts.templateKg):'',
        bandLevel:ts.bandLevel??null,
        reps:String(ts.reps),
        // recKg пуст и fromTemplate=false — рекомендованного веса тут нет,
        // а значит не должно быть и рамки «откуда взялся вес».
        recKg:'',
        rating:'',
        fromTemplate:false,
      }))
      // coachNote — заметка тренера к упражнению из программы. Отдельно от
      // progressNote (движка тут нет), показывается своим стилем на экране.
      return{n:ex.name,m:'',eq:'',sets:parsedSets,done:false,progressNote:null,coachNote:ex.note||''}
    })
    // Имя уезжает в дневник как есть (workouts.name, см. handleWorkoutComplete)
    // — по нему потом видно, что тренировка была из программы тренера.
    setWName(`Программа от тренера · ${workout.name||'Тренировка'}`)
    setWExercises(builtExercises)
    setWMode('start')
    setWDate('')
    setStartedAt(Date.now());setSwAccumMs(0);setSwStartedAt(null)
    // Движка прогрессии нет — значит ни предупреждения о правке повторений,
    // ни кнопки «?» с объяснением прогрессии здесь быть не должно.
    setWIsFromProgram(false)
    setRepsWarningShownThisWorkout(false)
    setActiveVideoCtx(null) // программа тренера → общий ролик
    setStep('active')
    setProgramOpen(false)
    setOpenProgramWorkoutIdx(null)
    // Клиент реально тренируется по программе тренера — отмечаем её выбранной.
    selectTrainerProgram()
  }
  // Точка входа кнопки — проверка активной тренировки живёт ЗДЕСЬ, а не
  // внутри runTrainerWorkout, ровно как у пары startSlotWorkout/
  // runStartSlotWorkout. Иначе бы вышла петля: confirmStartOverActive зовёт
  // отложённую функцию сразу после exitWorkout(), а step в замыкании к тому
  // моменту ещё 'active' — проверка внутри откладывала бы запуск снова.
  // Модалку программы при этом закрываем: подтверждение конфликта рисуется
  // в самой странице и оказалось бы под её полноэкранной панелью.
  const startTrainerWorkout=(workout)=>{
    if(step==='active'){
      setPendingConflictStart(()=>()=>runTrainerWorkout(workout))
      setProgramOpen(false)
      setOpenProgramWorkoutIdx(null)
      return
    }
    runTrainerWorkout(workout)
  }

  // Клик по "▶ Начать тренировку" — сначала проверяем выбранную программу
  // клиента (profiles.program), см. задачу "выбор программы через Начать
  // тренировку": второй путь выбора программы, помимо "?" -> "Тренироваться
  // по этой программе" на карточке (selectProgram выше, оставлен как есть).
  const handleStartSlotClick=async()=>{
    if(!currentSlot||currentSlot.exercises.filter(e=>e.name).length===0)return
    if(selectedProgram===openFolder){startSlotWorkout();return}
    if(!selectedProgram){setShowAdoptProgramModal(true);return}
    const count=countCompletedSlots(selectedProgram)
    if(count===0){
      const{ok}=await selectProgram(openFolder)
      if(ok)startSlotWorkout()
      return
    }
    setShowSwitchProgramModal({from:selectedProgram,to:openFolder,count})
  }

  // ── Активная тренировка
  if(step==='active'){
    // Высота учитывает верхний отступ контента (~14) + фиксированное нижнее
    // меню приложения (BOTTOM_NAV_H=62) + запас 12 + safe-area iPhone — чтобы
    // бар "+/Завершить/📤" (последний flex-элемент) стоял НАД меню, а не уходил
    // под него. Внутренняя прокрутка листается выше бара.
    return (
      <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 88px - env(safe-area-inset-bottom, 0px))', background:BG, borderRadius:14, overflow:'hidden', color:'#fff', position:'relative' }}>

        {/* Редактор видео (тренер) — портит в body, поверх активного экрана. */}
        {videoPickerFor&&<VideoPicker exerciseName={videoPickerFor} exerciseVideos={exerciseVideos} setExerciseVideos={setExerciseVideos} onClose={()=>setVideoPickerFor(null)} />}
        {/* Плеер видео техники — активный экран это отдельный return, поэтому
            попап нужен и здесь (в основном return он свой, ниже). position:fixed
            перекрывает overflow:hidden контейнера. */}
        {playVideo&&(
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.92)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center' }}
            onClick={()=>setPlayVideo(null)}>
            <div style={{ position:'relative', maxWidth:860, width:'95%' }} onClick={e=>e.stopPropagation()}>
              <button onClick={()=>setPlayVideo(null)}
                style={{ position:'absolute', top:-42, right:0, background:'none', border:'none', color:'#fff', fontSize:26, cursor:'pointer', minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
              <div style={{ fontSize:13, color:TXT3, marginBottom:8 }}>{playVideo.name}</div>
              <video src={playVideo.url} controls autoPlay style={{ width:'100%', borderRadius:12, maxHeight:'75vh' }} />
            </div>
          </div>
        )}

        {/* Тост ошибки сохранения — тренировка НЕ записалась в Supabase,
            остаёмся на экране (см. finishWorkout), клиент ничего не теряет
            и может повторить попытку кнопкой "Завершить"/"Сохранить". */}
        {showSaveError&&(
          <div style={{
            position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
            zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
            background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
            boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
          }}>
            Не удалось сохранить тренировку — проверь связь и повтори
          </div>
        )}

        {/* Тост ошибки сохранения своего упражнения — insert в custom_exercises
            упал (см. saveCustomExercise), попап "Новое упражнение" остаётся
            открытым для повтора, в список тренировки/библиотеки упражнение
            не добавляется. */}
        {showCustomExerciseSaveError&&(
          <div style={{
            position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
            zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
            background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
            boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
          }}>
            Не удалось сохранить упражнение, проверь связь
          </div>
        )}

        {/* Мини-попап нового упражнения */}
        {customOpen&&(
          <div style={{ position:'absolute', inset:0, zIndex:300, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.45)', borderRadius:14, padding:16 }}
            onClick={()=>setCustomOpen(false)}>
            <div style={{ background:SURF, borderRadius:16, padding:'22px 20px', width:'100%', maxWidth:400, boxSizing:'border-box', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Новое упражнение</span>
                <button onClick={()=>setCustomOpen(false)} style={{ background:'none', border:'none', color:TXT3, fontSize:18, cursor:'pointer', lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div>
                  <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Название *</div>
                  <input value={customForm.n} onChange={e=>setCustomForm(f=>({...f,n:e.target.value}))}
                    placeholder="Например: Жим гантелей лёжа" autoFocus
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Группа мышц</div>
                  <input value={customForm.m} onChange={e=>setCustomForm(f=>({...f,m:e.target.value}))}
                    placeholder="Например: Грудь, Ноги, Спина..."
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
                <div>
                  <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Оборудование</div>
                  <input value={customForm.eq} onChange={e=>setCustomForm(f=>({...f,eq:e.target.value}))}
                    placeholder="Например: Гантели, Штанга..."
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
                <div style={{ display:'flex', gap:8, marginTop:4 }}>
                  <button onClick={()=>setCustomOpen(false)} style={{ flex:1, padding:'11px', fontSize:13, fontWeight:600, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:TXT3, cursor:'pointer' }}>Отмена</button>
                  <button onClick={saveCustomExercise} style={{ flex:1, padding:'12px', fontSize:14, borderRadius:14, border:'none', background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontWeight:800, cursor:'pointer' }}>Добавить</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Пикер упражнений */}
        {pickOpen&&(
          <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.8)', zIndex:200, display:'flex', flexDirection:'column', borderRadius:14, overflow:'hidden' }}>
            <div style={{ background:SURF, padding:'16px 18px 12px', borderBottom:'1px solid #2a2a2a', flexShrink:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <span style={{ fontSize:16, fontWeight:700, color:'#fff' }}>Упражнения</span>
                <button onClick={()=>{setPickOpen(false);setPickQ('');setPickMuscle('Все')}} style={{ background:'none', border:'none', color:TXT3, fontSize:20, cursor:'pointer' }}><GlassIcon name="close" size={26} /></button>
              </div>
              <div style={{ display:'flex', gap:8, marginBottom:10 }}>
                <input value={pickQ} onChange={e=>setPickQ(e.target.value)} placeholder="Поиск упражнения..."
                  style={{ flex:1, padding:'9px 12px', fontSize:13, borderRadius:8, border:`1px solid ${HAIR}`, background:SURF2, color:'#fff', boxSizing:'border-box' }} />
                <button onClick={()=>{setCustomOpen(true);setCustomForm({n:'',m:'',eq:''})}}
                  style={{ padding:'9px 13px', fontSize:12, fontWeight:600, borderRadius:8, border:'none', background:wColor, color:'#fff', cursor:'pointer', whiteSpace:'nowrap' }}>
                  Добавить упражнение +
                </button>
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {muscles.map(m=>(
                  <button key={m} onClick={()=>setPickMuscle(m)} style={{ fontSize:11, padding:'4px 10px', borderRadius:20, cursor:'pointer', border:'none', background:pickMuscle===m?wColor:SURF2, color:pickMuscle===m?'#fff':TXT3, fontWeight:pickMuscle===m?600:400 }}>{m}</button>
                ))}
              </div>
            </div>
            <div style={{ flex:1, overflowY:'auto' }}>
              {filteredEx.length===0&&<div style={{ textAlign:'center', color:TXT3, marginTop:40, fontSize:13 }}>Ничего не найдено</div>}
              {filteredEx.map((ex,i)=>(
                <button key={i} onClick={()=>pickExercise(ex)}
                  style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%', padding:'13px 18px', background:'none', border:'none', borderBottom:'1px solid #1f2937', cursor:'pointer', textAlign:'left' }}
                  onMouseEnter={e=>e.currentTarget.style.background='#1f2937'}
                  onMouseLeave={e=>e.currentTarget.style.background='none'}>
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:14, fontWeight:500, color:'#fff' }}>{ex.label||ex.n}</span>
                      {ex.custom&&<span style={{ fontSize:10, padding:'2px 6px', borderRadius:6, background:wColor+'33', color:wColor }}>моё</span>}
                    </div>
                    <div style={{ fontSize:11, color:TXT3, marginTop:2 }}>{ex.m}{ex.eq?` · ${ex.eq}`:''}</div>
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
              </div>
              {wMode==='start'&&<div style={{ fontSize:14, color:'rgba(255,255,255,0.7)', marginTop:3 }}>⏱ {fmt(timer)}</div>}
            </div>
            <div style={{ display:'flex', gap:8, flexShrink:0, marginTop:4 }}>
              {wIsFromProgram&&<button onClick={()=>setShowProgressionIntro(true)} style={{ fontSize:15, fontWeight:700, color:'#fff', background:'rgba(0,0,0,0.25)', border:'none', borderRadius:6, width:28, height:28, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', padding:0, minHeight:'unset' }}>?</button>}
              <button onClick={()=>setShowExitConfirm(true)} style={{ fontSize:16, color:'#fff', background:'rgba(0,0,0,0.25)', border:'none', borderRadius:6, width:28, height:28, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', padding:0, minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
            </div>
          </div>
        </div>

        {/* Окошко выхода — сохранить или выйти без сохранения */}
        {showExitConfirm&&(
          <div style={{ position:'absolute', inset:0, zIndex:350, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.6)', borderRadius:14 }}
            onClick={()=>setShowExitConfirm(false)}>
            <div style={{ background:SURF, borderRadius:14, padding:'22px 20px', width:300, boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontSize:15, fontWeight:700, color:'#fff', marginBottom:6, textAlign:'center' }}>Выйти из тренировки?</div>
              <div style={{ fontSize:12, color:TXT3, marginBottom:18, textAlign:'center', lineHeight:1.5 }}>Можно свернуть — тренировка продолжится в фоне, ничего не потеряется.</div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <button onClick={minimizeWorkout} style={{ padding:'11px', borderRadius:10, border:'none', background:wColor, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>Свернуть</button>
                <button onClick={exitWorkout} style={{ padding:'11px', borderRadius:10, border:`1px solid ${HAIR}`, background:'none', color:'#ef4444', fontSize:14, fontWeight:600, cursor:'pointer' }}>Выйти без сохранения</button>
                <button onClick={()=>setShowExitConfirm(false)} style={{ padding:'9px', borderRadius:10, border:'none', background:'none', color:TXT3, fontSize:13, cursor:'pointer' }}>Отмена</button>
              </div>
            </div>
          </div>
        )}

        {/* Выбор даты перед сохранением — единая точка и для "Завершить", и для
            "Сохранить" из окошка выхода. По умолчанию сегодня, можно сменить. */}
        {showDatePicker&&(
          <div style={{ position:'absolute', inset:0, zIndex:360, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.6)', borderRadius:14 }}
            onClick={()=>setShowDatePicker(false)}>
            <div style={{ background:SURF, borderRadius:14, padding:'22px 20px', width:300, boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontSize:15, fontWeight:700, color:'#fff', marginBottom:16, textAlign:'center' }}>На какую дату сохранить?</div>
              <input type="date" value={wDate} onChange={e=>setWDate(e.target.value)} autoFocus
                style={{ width:'100%', padding:'11px', borderRadius:10, border:`1px solid ${HAIR}`, background:SURF2, color:'#fff', fontSize:15, colorScheme:'dark', cursor:'pointer', outline:'none', boxSizing:'border-box', marginBottom:16, textAlign:'center' }} />
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>setShowDatePicker(false)} style={{ flex:1, padding:'10px', borderRadius:10, border:`1px solid ${HAIR}`, background:'none', color:TXT3, fontSize:13, cursor:'pointer' }}>Отмена</button>
                <button data-testid="workout-save-confirm" onClick={confirmSaveWithDate} style={{ flex:1, padding:'10px', borderRadius:10, border:'none', background:wColor, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>Сохранить</button>
              </div>
            </div>
          </div>
        )}

        {/* Плашка-объяснение от AI-ассистента — один раз за всё время */}
        {showAiTip&&(
          <div style={{ position:'absolute', inset:0, zIndex:380, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.65)', borderRadius:14, padding:'0 18px' }}
            onClick={dismissAiTip}>
            <div style={{ maxWidth:320, width:'100%' }} onClick={e=>e.stopPropagation()}>
              <div style={{ display:'flex', alignItems:'flex-end', gap:8 }}>
                <div style={{ width:32, height:32, borderRadius:'50%', background:`linear-gradient(135deg,${PUR},#5b54c4)`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><GlassIcon name="robot" size={26} /></div>
                <div style={{ background:SURF2, border:`1px solid ${HAIR}`, borderRadius:'4px 16px 16px 16px', padding:'14px 16px', fontSize:13.5, color:'#e5e7eb', lineHeight:1.6, whiteSpace:'pre-wrap' }}>
                  {'Привет! Смотри, как тут всё работает:\n\nВес — это подсказка для старта. Вес горит красным — значит пиши свой реальный вес — тот, с которым действительно тренируешься, и обязательно поставь оценку (1 — легко, 5 — тяжело).\n\nПо оценке я сам подберу тебе вес дальше.\nПогнали! 💪'}
                </div>
              </div>
              <button onClick={dismissAiTip}
                style={{ display:'block', marginLeft:40, marginTop:10, padding:'10px 22px', borderRadius:20, border:'none', background:wColor, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                Понятно!
              </button>
            </div>
          </div>
        )}

        {/* Модалка "Откуда взялся этот вес" — см. showProgressionIntro выше:
            при каждой тренировке с холодным стартом, плюс вручную по "?" в шапке. */}
        {showProgressionIntro&&wIsFromProgram&&(
          <div style={{ position:'absolute', inset:0, zIndex:390, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.65)', borderRadius:14, padding:'0 18px' }}
            onClick={dismissProgressionIntro}>
            <div style={{ background:SURF, borderRadius:16, padding:'20px 20px 16px', width:340, maxWidth:'100%', boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontSize:16, fontWeight:700, color:'#fff', marginBottom:14, textAlign:'center' }}>Откуда взялся этот вес</div>
              <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
                <div style={{ fontSize:13, color:TXT3, lineHeight:1.55 }}>Красным подсвечен вес, взятый прямо из программы тренера — приложение тебя ещё не знает и не может подобрать вес лично под тебя.</div>
                <div style={{ fontSize:13, color:TXT3, lineHeight:1.55 }}>После подхода отметь цифрой, как он дался: 1 — легко, 5 — на пределе.</div>
                <div style={{ fontSize:13, color:TXT3, lineHeight:1.55 }}>В следующий раз приложение поставит вес само: далось легко — прибавит побольше, тяжело — прибавит чуть-чуть, было тяжело два раза подряд — снизит, чтобы не перегореть.</div>
                <div style={{ fontSize:13, color:TXT3, lineHeight:1.55 }}>Вес можно менять руками — приложение запомнит то, что реально сделано, и посчитает от него.</div>
                <div style={{ fontSize:13, color:TXT3, lineHeight:1.55 }}>Значок «<span style={{ color:PUR, fontWeight:700 }}>+</span>» у повторений означает, что упражнение делается на обе стороны, а повторения считаются суммарно, а не на каждую ногу отдельно.</div>
                <div style={{ fontSize:13, color:'#fbbf24', fontWeight:700, lineHeight:1.55 }}>Веса приблизительные — подстрой под своё самочувствие.</div>
              </div>
              <label style={{ display:'flex', alignItems:'center', gap:9, marginBottom:14, cursor:'pointer' }}>
                <input type="checkbox" checked={progressionIntroDontShow} onChange={e=>setProgressionIntroDontShow(e.target.checked)}
                  style={{ width:18, height:18, cursor:'pointer', accentColor:wColor, flexShrink:0 }} />
                <span style={{ fontSize:12.5, color:TXT3 }}>Больше не показывать</span>
              </label>
              <button onClick={dismissProgressionIntro}
                style={{ width:'100%', padding:'12px', borderRadius:10, border:'none', background:wColor, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>
                Понятно
              </button>
            </div>
          </div>
        )}

        {/* Предупреждение о правке повторений (см. handleRepsChange выше) —
            только для тренировок, реально запущенных из слота программы,
            один раз за тренировку. Текст — правда: расчёт веса отработает
            любые цифры, проблема не в поломке, а в том, что клиент выходит
            из фазы цикла (объём/развитие/сила), заданной шаблоном тренера. */}
        {showRepsWarning&&(
          <div style={{ position:'absolute', inset:0, zIndex:395, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.65)', borderRadius:14, padding:'0 18px' }}
            onClick={()=>setShowRepsWarning(false)}>
            <div style={{ background:SURF, borderRadius:16, padding:'20px 20px 16px', width:340, maxWidth:'100%', boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontSize:16, fontWeight:700, color:'#fff', marginBottom:14, textAlign:'center' }}>Повторения из плана</div>
              <div style={{ fontSize:13, color:TXT3, lineHeight:1.55, marginBottom:18 }}>
                Повторения подобраны тренером под текущий этап программы. Менять их не рекомендуется — от них зависит, какую нагрузку приложение подберёт дальше. Если получилось меньше или больше, чем в плане — впиши как есть, приложение учтёт реальный результат.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <button onClick={()=>setShowRepsWarning(false)}
                  style={{ padding:'12px', borderRadius:10, border:'none', background:wColor, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>
                  Понятно
                </button>
                <button onClick={revertRepsWarning}
                  style={{ padding:'11px', borderRadius:10, border:`1px solid ${HAIR}`, background:'none', color:TXT3, fontSize:13, fontWeight:600, cursor:'pointer' }}>
                  Вернуть как было
                </button>
              </div>
            </div>
          </div>
        )}

        {/* "Начать новую поверх свёрнутой" — сюда попадаем, только если
            step уже 'active' в момент попытки стартовать другую тренировку
            (см. pendingConflictStart выше) — то есть по факту только с
            "Начать тренировку" на Главной/в Дневнике, пока эта тренировка
            была свёрнута. */}
        {pendingConflictStart&&(
          <div style={{ position:'absolute', inset:0, zIndex:398, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.65)', borderRadius:14, padding:'0 18px' }}
            onClick={cancelStartOverActive}>
            <div style={{ background:SURF, borderRadius:16, padding:'20px 20px 16px', width:340, maxWidth:'100%', boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontSize:15, color:TXT3, lineHeight:1.55, marginBottom:18, textAlign:'center' }}>
                У тебя есть незавершённая тренировка «{wName}». Начать новую? Незавершённая будет удалена.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <button onClick={confirmStartOverActive}
                  style={{ padding:'12px', borderRadius:10, border:'none', background:'#ef4444', color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>
                  Начать новую
                </button>
                <button onClick={cancelStartOverActive}
                  style={{ padding:'11px', borderRadius:10, border:`1px solid ${HAIR}`, background:'none', color:TXT3, fontSize:13, fontWeight:600, cursor:'pointer' }}>
                  Вернуться к незавершённой
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Подтверждение удаления упражнения с живой тренировки (🗑 на
            карточке) — см. removeExerciseConfirm выше. Ничего не пишет в
            Supabase, просто убирает элемент из wExercises. */}
        {removeExerciseConfirm&&(
          <div style={{ position:'absolute', inset:0, zIndex:399, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.65)', borderRadius:14, padding:'0 18px' }}
            onClick={()=>setRemoveExerciseConfirm(null)}>
            <div style={{ background:SURF, borderRadius:16, padding:'20px 20px 16px', width:320, maxWidth:'100%', boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontSize:15, color:'#fff', lineHeight:1.5, marginBottom:18, textAlign:'center' }}>
                Убрать «{removeExerciseConfirm.name}» из этой тренировки?
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>setRemoveExerciseConfirm(null)}
                  style={{ flex:1, padding:'11px', borderRadius:10, border:`1px solid ${HAIR}`, background:'none', color:TXT3, fontSize:13, fontWeight:600, cursor:'pointer' }}>
                  Отмена
                </button>
                <button onClick={confirmRemoveExercise}
                  style={{ flex:1, padding:'11px', borderRadius:10, border:'none', background:'#ef4444', color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>
                  Убрать
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Контент. paddingBottom крупнее — чтобы последнее упражнение и поле
            «Комментарий» отходили от закреплённого бара действий и не липли к
            нему при долистывании донизу. */}
        <div style={{ flex:1, overflowY:'auto', padding:'14px 18px 24px' }}>

          {/* Секундомер — компактный липкий бар вверху скролла (только в режиме
              активной тренировки). Липнет к верху скролл-области; отрицательные
              margin + top:-14 «выпускают» его в padding контейнера, сплошной
              фон BG перекрывает уезжающий под него контент. Логика таймера
              (toggleStopwatch/resetStopwatch/swTime) не менялась. */}
          {wMode==='start'&&(
            <div style={{ position:'sticky', top:-14, zIndex:20, margin:'-14px -18px 12px', padding:'14px 18px 0', background:BG }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, background:SURF, border:`1px solid ${HAIR}`, borderRadius:16, padding:'8px 12px' }}>
                <span style={{ fontSize:22, fontWeight:800, letterSpacing:'.02em', fontVariantNumeric:'tabular-nums', color:'#EDEBFF', marginRight:'auto' }}>⏱ {fmt(swTime)}</span>
                <button onClick={toggleStopwatch}
                  style={{ padding:'8px 20px', borderRadius:12, border:'none', background:swRunning?SURF2:TEA, color:swRunning?TXT2:'#04310f', fontSize:13, fontWeight:700, cursor:'pointer', minHeight:'unset' }}>
                  {swRunning?'⏸ Стоп':'▶ Старт'}
                </button>
                <button onClick={resetStopwatch}
                  style={{ padding:'8px 14px', borderRadius:12, border:`1px solid ${HAIR}`, background:SURF2, color:TXT2, fontSize:14, cursor:'pointer', minHeight:'unset' }}>
                  ↺
                </button>
              </div>
            </div>
          )}

          {/* Упражнения */}
          {wExercises.length===0?(
            <div style={{ textAlign:'center', marginTop:40 }}>
              <div style={{ fontSize:18, fontWeight:600, color:'#fff', marginBottom:8 }}>
                {wMode==='log'?'Добавь упражнения':'Тренировка началась'}
              </div>
              <div style={{ fontSize:14, color:TXT3, lineHeight:1.7 }}>Нажми «+», чтобы добавить упражнения.</div>
            </div>
          ):(
            wExercises.map((ex,ei)=>{
              const tonnage=exTonnage(ex)
              return (
                <div key={ei} style={{ marginBottom:14, background:ex.done?'#0d2010':SURF, borderRadius:20, padding:'12px 14px', border:ex.done?'1px solid #14532d':`1px solid ${HAIR}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, gap:8 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, minWidth:0 }}>
                      <span style={{ width:30, height:30, borderRadius:10, background:`linear-gradient(135deg, ${PUR}, #5b56c9)`, color:'#fff', fontWeight:800, fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{ei+1}</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:16, fontWeight:700, color:ex.done?'#4ade80':TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{labelOf(catalogExercises,ex.n)}</div>
                        <ExMeta name={ex.n} m={ex.m} eq={ex.eq} />
                      </div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                      {ex.done&&<span style={{ fontSize:11, color:'#4ade80', display:'inline-flex', alignItems:'center', gap:4 }}><GlassIcon name="check" size={13} />Выполнено</span>}
                      {/* Видео техники — если по имени упражнения есть ролик в
                          серверной карте. Тап открывает существующий плеер. */}
                      {pickVideo(exerciseVideos,ex.n,activeVideoCtx)&&(
                        <button onClick={()=>setPlayVideo({url:pickVideo(exerciseVideos,ex.n,activeVideoCtx).video_url,name:labelOf(catalogExercises,ex.n)})}
                          title="Видео техники"
                          style={{ width:26, height:26, borderRadius:'50%', border:'none', background:`${PUR}22`, color:PUR, cursor:'pointer', fontSize:12, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, minHeight:'unset' }}>
                          ▶
                        </button>
                      )}
                      {/* Смена ролика — только тренеру, видна и когда видео нет. */}
                      {isTrainer&&(
                        <button onClick={()=>setVideoPickerFor(ex.n)} title="Изменить видео"
                          style={{ width:26, height:26, borderRadius:'50%', border:'none', background:`${PUR}22`, color:PUR, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, minHeight:'unset' }}>
                          <GlassIcon name="gear" size={15} />
                        </button>
                      )}
                      {/* Последнее оставшееся упражнение не удаляем — кнопку
                          просто не показываем (см. комментарий у removeExerciseConfirm). */}
                      {wExercises.length>1&&(
                        <button onClick={()=>setRemoveExerciseConfirm({ei,name:ex.n})}
                          style={{ width:26, height:26, borderRadius:6, border:'none', background:SURF2, color:TXT3, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Заметка тренера из программы (coachNote, см.
                      runTrainerWorkout). Это НЕ движок прогрессии — оформляем
                      иначе, чем progressNote ниже: подпись «От тренера» и
                      акцент PUR, чтобы клиент понимал, что это слова тренера. */}
                  {ex.coachNote&&!ex.done&&(
                    <div style={{ fontSize:12, color:TXT2, marginTop:-4, marginBottom:8, paddingLeft:8, borderLeft:`2px solid ${PUR}` }}>
                      <span style={{ color:PUR, fontWeight:700 }}>От тренера: </span>{ex.coachNote}
                    </div>
                  )}
                  {/* Объяснение пересчитанного веса (см. кнопку "▶ Начать
                      тренировку" в слоте программы, где считается progressNote) —
                      одна строка на упражнение, почему вес именно такой.
                      Откат — не тревожный красный, а спокойный акцент PUR: это
                      нормальная часть методики, а не ошибка приложения.
                      Холодный старт (COLD_START_NOTES) сюда не попадает — для
                      него теперь отдельная модалка "Откуда взялся этот вес"
                      (showProgressionIntro выше), не инлайн-строка. */}
                  {ex.progressNote&&!ex.done&&!COLD_START_NOTES.has(ex.progressNote)&&(
                    <div style={{
                      fontSize:ex.progressStopped?13.5:12.5,
                      fontWeight:ex.progressStopped?700:400,
                      color:ex.progressStopped?'#ef4444':(ex.progressNote.startsWith('Разгрузка')||ex.progressNote.startsWith('Снизили нагрузку'))?PUR:TXT3,
                      marginTop:-4, marginBottom:8,
                    }}>
                      {ex.progressNote}
                    </div>
                  )}
                  {isOneSidedExercise(ex.n)&&(
                    <div style={{ fontSize:10, color:TXT3, marginTop:-4, marginBottom:8 }}>
                      Повторения считаются суммарно на обе стороны
                    </div>
                  )}

                  {ex.done?(
                    <div>
                      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:8 }}>
                        {ex.sets.map((s,si)=>(s.kg||s.bandLevel||s.reps)&&(
                          <span key={si} style={{ fontSize:11, color:TXT3 }}>
                            {si+1}. {s.bandLevel!=null?`${s.bandLevel} рез.`:`${s.kg||'—'} кг`} × {s.reps||'—'}
                            {isOneSidedExercise(ex.n)&&<span title="Повторения считаются суммарно на обе стороны">+</span>}
                          </span>
                        ))}
                      </div>
                      <div style={{ fontSize:16, fontWeight:700, color:'#4ade80' }}>Тоннаж: {tonnage} кг</div>
                      <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,done:false}:x))}
                        style={{ marginTop:6, fontSize:11, color:TXT3, background:'none', border:'none', cursor:'pointer', padding:0 }}>
                        ↩ Редактировать
                      </button>
                    </div>
                  ):(
                    <>
                      <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 26px 26px 20px', gap:5, marginBottom:5 }}>
                        {['#',ex.sets.some(s=>s.bandLevel!=null)?'РЕЗИНА':'КГ','ПОВТ','','',''].map((h,i)=>(
                          <span key={i} style={{ fontSize:11, fontWeight:700, color:TXT2, textAlign:'center', textTransform:'uppercase', letterSpacing:'.06em' }}>{h}</span>
                        ))}
                      </div>
                      {ex.sets.map((set,si)=>{
                        const noteOpen=openSetNote?.ei===ei&&openSetNote?.si===si
                        const isBandSet=set.bandLevel!=null
                        const isTemplateWeight=!!(set.fromTemplate&&set.kg)
                        const isTemplateBand=!!(set.fromTemplate&&isBandSet)
                        return(
                          <div key={si} style={{ marginBottom:noteOpen?3:5 }}>
                            <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 26px 26px 20px', gap:5, alignItems:'center' }}>
                              <span style={{ fontSize:12, color:TXT3, textAlign:'center', fontWeight:700 }}>{si+1}</span>
                              {isBandSet?(
                                <input value={set.bandLevel} type="number" min={1} max={5}
                                  onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,bandLevel:e.target.value===''?'':Number(e.target.value),fromTemplate:false}:s)}:x))}
                                  onFocus={selectOnFocus}
                                  placeholder="1"
                                  style={{ background:isTemplateBand?'rgba(255,69,58,.08)':SURF2, border:isTemplateBand?'1.5px solid rgba(255,69,58,.55)':`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:isTemplateBand?'#ff8a82':TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                              ):(
                                <input data-testid="set-kg" value={set.kg} inputMode="decimal"
                                  onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,kg:e.target.value,fromTemplate:false}:s)}:x))}
                                  onFocus={selectOnFocus}
                                  placeholder="0"
                                  style={{ background:isTemplateWeight?'rgba(255,69,58,.08)':SURF2, border:isTemplateWeight?'1.5px solid rgba(255,69,58,.55)':`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:isTemplateWeight?'#ff8a82':TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                              )}
                              <div style={{ position:'relative', width:'100%' }}>
                                <input data-testid="set-reps" value={set.reps} inputMode="numeric"
                                  onChange={e=>handleRepsChange(ei,si,e.target.value)}
                                  onFocus={selectOnFocus}
                                  placeholder="0"
                                  style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                                {isOneSidedExercise(ex.n)&&(
                                  // Метка "выполняется на обе стороны" — НЕ кнопка (нет onClick,
                                  // isOneSidedExercise в programs.js только определяет упражнение
                                  // по названию для этой подписи). Тап-зону 44x44 не делаем —
                                  // это ввело бы в заблуждение, что значок интерактивный.
                                  // Заметнее визуально (кружок-бейдж), но по размеру = самому себе.
                                  <span title="Повторения считаются суммарно на обе стороны"
                                    style={{ position:'absolute', top:-8, right:-8, width:17, height:17, borderRadius:'50%', background:PUR, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:'#fff', lineHeight:1 }}>+</span>
                                )}
                              </div>
                              <button onClick={()=>setOpenSetNote(noteOpen?null:{ei,si})}
                                style={{ width:26, height:26, borderRadius:6, border:'none', background:set.note?`${PUR}50`:SURF2, color:set.note?PUR:TXT3, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center' }}><GlassIcon name="pen" size={26} /></button>
                              {/* Видео тренеру — только клиенту с тренером (hasTrainer).
                                  Не загрузка в приложение: открывает чат с тренером
                                  в Telegram, клиент шлёт видео сам. openTelegramLink
                                  сворачивает Mini App (не закрывает — close() не зовём),
                                  тренировка в памяти переживает переход. Плейсхолдер
                                  <span/> у остальных держит колонку, чтобы ✕ не съехал. */}
                              {hasTrainer?(
                                <button onClick={()=>{
                                  if(window.Telegram?.WebApp)window.Telegram.WebApp.openTelegramLink(MAX_TELEGRAM_URL)
                                  else window.open(MAX_TELEGRAM_URL,'_blank')
                                }}
                                  style={{ width:26, height:26, borderRadius:6, border:'none', background:SURF2, color:TXT3, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center' }}><GlassIcon name="video" size={26} /></button>
                              ):<span />}
                              <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.filter((_,j)=>j!==si)}:x).filter(x=>x.sets.length>0))}
                                style={{ background:'none', border:'none', color:TXT3, cursor:'pointer', fontSize:14, textAlign:'center' }}><GlassIcon name="close" size={26} /></button>
                            </div>
                            {set.recKg&&(
                              <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 26px 26px 20px', gap:5 }}>
                                <span />
                                <span style={{ fontSize:11, color:PUR, textAlign:'center', marginTop:2 }}>реком. {set.recKg} кг</span>
                              </div>
                            )}
                            {/* Оценка нагрузки 1-5 — только под рабочими подходами (последние
                                2 в упражнении, как и считает AI-тренер в workoutPrompt.js).
                                На этой шкале держится весь расчёт следующего веса/нагрузки
                                (computeTemplateScale/computeBandTarget) — тап-зона 44x44
                                (гайдлайн Apple) и подписи "легко"/"на пределе", чтобы клиент
                                понимал, что именно он оценивает. */}
                            {wIsFromProgram&&si>=ex.sets.length-2&&(
                              <div style={{ display:'flex', alignItems:'center', flexWrap:'wrap', gap:8, marginTop:6, paddingLeft:29 }}>
                                <span style={{ fontSize:11, color:TXT3, flexShrink:0 }}>Оценка нагрузки</span>
                                <div style={{ display:'flex', gap:3 }}>
                                  {[1,2,3,4,5].map(n=>(
                                    <div key={n} style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
                                      <button
                                        onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,rating:s.rating===n?'':n}:s)}:x))}
                                        title={n===1?'1 — совсем легко':n===5?'5 — на пределе':String(n)}
                                        style={{ width:44, height:44, borderRadius:12, cursor:'pointer', padding:0,
                                          background:set.rating===n?PUR:SURF2,
                                          border:set.rating===n?`1px solid ${PUR}`:`1px solid ${HAIR}`,
                                          boxShadow:set.rating===n?'0 6px 16px rgba(124,122,240,.4)':'none',
                                          fontSize:15, fontWeight:800, lineHeight:1,
                                          color:set.rating===n?'#fff':TXT2, transition:'background .1s, box-shadow .1s' }}>
                                        {n}
                                      </button>
                                      <span style={{ fontSize:11, color:TXT3, marginTop:2, minHeight:13, whiteSpace:'nowrap' }}>
                                        {n===1?'легко':n===5?'на пределе':''}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {noteOpen&&(
                              <input value={set.note||''} autoFocus
                                onChange={e=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:x.sets.map((s,j)=>j===si?{...s,note:e.target.value}:s)}:x))}
                                placeholder="Заметка к подходу..."
                                style={{ width:'100%', background:SURF2, border:`1px solid ${HAIR}`, borderRadius:6, padding:'5px 10px', fontSize:12, color:'#e5e7eb', marginTop:3, boxSizing:'border-box', outline:'none' }} />
                            )}
                          </div>
                        )
                      })}
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:6 }}>
                        <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,sets:[...x.sets,{kg:'',reps:'',recKg:'',rating:''}]}:x))}
                          style={{ fontSize:12, color:wColor, background:'none', border:'none', cursor:'pointer', fontWeight:600, padding:0 }}>
                          + Подход
                        </button>
                        <button onClick={()=>setWExercises(p=>p.map((x,i)=>i===ei?{...x,done:true}:x))}
                          style={{ fontSize:12, color:'#fff', background:'#16a34a', border:'none', borderRadius:6, padding:'6px 14px', cursor:'pointer', fontWeight:600, display:'inline-flex', alignItems:'center', gap:5 }}>
                          <GlassIcon name="check" size={14} />Завершить упражнение
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })
          )}

          {/* Комментарий к тренировке — в конце прокрутки, над закреплённым
              баром "Завершить" (появляется, когда долистал донизу). Логика
              (wComment/setWComment) не менялась, только перенесён сюда. */}
          <div style={{ marginTop:14 }}>
            <textarea value={wComment} onChange={e=>setWComment(e.target.value)} placeholder="💬 Комментарий к тренировке..." rows={2}
              style={{ width:'100%', background:SURF, border:`1px solid ${HAIR}`, borderRadius:16, padding:'10px 12px', fontSize:13, color:TXT, resize:'none', outline:'none', fontFamily:'inherit', boxSizing:'border-box', lineHeight:1.5 }} />
          </div>
        </div>

        {/* Нижняя панель */}
        <div style={{ padding:'10px 18px', display:'flex', justifyContent:'space-between', alignItems:'center', background:SURF2, flexShrink:0 }}>
          <button data-testid="workout-add-exercise" onClick={()=>setPickOpen(true)} style={{ width:42, height:42, borderRadius:'50%', border:`2px solid ${HAIR}`, background:'none', color:TXT3, fontSize:22, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>+</button>
          <button data-testid="workout-finish" onClick={openDatePicker} style={{ padding:'12px 36px', borderRadius:16, border:'none', background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontSize:16, fontWeight:800, cursor:'pointer', boxShadow:'0 10px 26px rgba(124,122,240,.4)' }}>
            {isEditMode?'Сохранить':'Завершить'}
          </button>
          <button onClick={()=>setShowSendModal(true)} style={{ width:42, height:42, borderRadius:'50%', border:`2px solid ${HAIR}`, background:'none', color:TXT3, fontSize:20, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}><GlassIcon name="share" size={26} /></button>
        </div>

        {/* Модал "Отправить тренеру" */}
        {showSendModal&&(
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1200, display:'flex', alignItems:'flex-end', justifyContent:'center' }}
            onClick={()=>setShowSendModal(false)}>
            <div onClick={e=>e.stopPropagation()} style={{ background:SURF2, borderRadius:'16px 16px 0 0', padding:'20px 18px', width:'100%', maxWidth:500, maxHeight:'75vh', display:'flex', flexDirection:'column' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14, flexShrink:0 }}>
                <span style={{ fontSize:16, fontWeight:700, color:'#fff' }}>📤 Отчёт тренеру</span>
                <button onClick={()=>setShowSendModal(false)} style={{ background:'none', border:'none', color:TXT3, fontSize:22, cursor:'pointer', padding:0, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
              </div>
              <pre style={{ background:SURF2, borderRadius:10, padding:'12px 14px', fontSize:12, color:'#e5e7eb', whiteSpace:'pre-wrap', fontFamily:'monospace', flex:1, overflowY:'auto', lineHeight:1.7, marginBottom:14 }}>
                {formatWorkoutReport()}
              </pre>
              <button onClick={copyReport} style={{ width:'100%', padding:'13px', borderRadius:10, border:'none', background:sendCopied?TEA:PUR, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', transition:'background 0.2s', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                <GlassIcon name={sendCopied?'check':'copy'} size={18} />{sendCopied?'Скопировано!':'Скопировать отчёт'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Список программ
  return (
    <div style={{ position:'relative' }}>
      {/* Редактор видео (тренер) — через портал, поверх шаблонов/программы. */}
      {videoPickerFor&&<VideoPicker exerciseName={videoPickerFor} exerciseVideos={exerciseVideos} setExerciseVideos={setExerciseVideos} onClose={()=>setVideoPickerFor(null)} />}
      {/* Редактор шаблона программы (тренер) — через портал. */}
      {templateEditor&&<TemplateEditor templateKey={templateEditor.key} isNew={templateEditor.isNew} initialDisplayName={templateEditor.initialDisplayName||''} initialContext={templateEditor.initialContext||'zal'} initialSort={templateEditor.initialSort||0} onClose={()=>setTemplateEditor(null)} onPublished={onTemplatePublished} />}
      {/* Черновик тренировки старше 24ч, найденный при загрузке приложения —
          через портал: WorkoutsView может быть скрыт (display:none, см.
          renderMain в App), если клиент открыл приложение не на вкладке
          "Тренировки" — модалка всё равно должна быть видна сразу. */}
      {staleDraft&&createPortal(
        <div style={{ position:'fixed', inset:0, zIndex:1450, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.6)', padding:'0 18px' }}>
          <div style={{ background:SURF, borderRadius:16, padding:'22px 20px', width:340, maxWidth:'100%', boxShadow:'0 16px 48px rgba(0,0,0,0.6)' }}>
            <div style={{ fontSize:15, fontWeight:700, color:'#fff', marginBottom:8, textAlign:'center' }}>Незавершённая тренировка</div>
            <div style={{ fontSize:13, color:TXT3, marginBottom:18, textAlign:'center', lineHeight:1.5 }}>
              Осталась незавершённая тренировка от {new Date(staleDraft.startedAt).toLocaleDateString('ru',{day:'numeric',month:'long'})}. Продолжить или удалить?
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              <button onClick={confirmStaleDraft} style={{ padding:'11px', borderRadius:10, border:'none', background:PUR, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>Продолжить</button>
              <button onClick={discardStaleDraft} style={{ padding:'11px', borderRadius:10, border:`1px solid ${HAIR}`, background:'none', color:'#ef4444', fontSize:14, fontWeight:600, cursor:'pointer' }}>Удалить</button>
            </div>
          </div>
        </div>
      , document.body)}
      {showFinishToast&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:1200, padding:'10px 18px', borderRadius:24,
          background:'#16a34a', color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(22,163,74,0.35)',
        }}>
          Тренировка записана в дневник <GlassIcon name="check" size={14} style={{ verticalAlign:'-2px' }} />
        </div>
      )}
      {/* Тост ошибки сохранения выбранной программы (см. selectProgram) —
          галочка НЕ переключилась, потому что запись в Supabase упала. */}
      {showProgramSaveError&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:1400, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
        }}>
          Не удалось сохранить программу — проверь связь и повтори
        </div>
      )}
      {menuOpen&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={()=>setMenuOpen(false)}>
          <div style={{ background:SURF, borderRadius:16, padding:'22px 22px 18px', width:370, boxShadow:'0 12px 40px rgba(0,0,0,0.18)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:TXT }}>Новая тренировка</h3>
              <button onClick={()=>setMenuOpen(false)} style={{ border:'none', background:'none', fontSize:18, color:TXT3, cursor:'pointer' }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
              {WORKOUT_ACTIONS.map(a=>(
                <button key={a.key} onClick={()=>handleAction(a.key)}
                  style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 14px', border:`1px solid ${HAIR}`, borderRadius:10, background:SURF, cursor:'pointer', textAlign:'left', width:'100%' }}
                  onMouseEnter={e=>e.currentTarget.style.background='#f0effe'}
                  onMouseLeave={e=>e.currentTarget.style.background='#fafafa'}>
                  <GlassIcon name={a.icon} size={24} />
                  <div>
                    <div style={{ fontSize:13, fontWeight:500, color:TXT }}>{a.label}</div>
                    <div style={{ fontSize:11, color:TXT3, marginTop:2 }}>{a.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step==='naming'&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
          onClick={()=>{setStep(null);setStartedFromPlanId(null)}}>
          <div style={{ background:SURF, borderRadius:16, padding:'22px 20px', width:'100%', maxWidth:400, boxSizing:'border-box', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:16, fontWeight:700, color:TXT, textAlign:'center', marginBottom:16 }}>
              {wMode==='log'?'Добавить тренировку':'Новая тренировка'}
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div>
                <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Название</div>
                <input value={wName} onChange={e=>setWName(e.target.value)}
                  style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
                  onFocus={e=>{e.target.select();e.target.style.borderColor=PUR}} onBlur={e=>e.target.style.borderColor=HAIR} />
              </div>
              {wMode==='log'&&(
                <div>
                  <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Дата</div>
                  <input type="date" value={wDate} onChange={e=>setWDate(e.target.value)}
                    style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, colorScheme:'dark', cursor:'pointer' }}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
              )}
            </div>
            <div style={{ display:'flex', gap:8, marginTop:18 }}>
              <button onClick={()=>{setStep(null);setStartedFromPlanId(null)}} style={{ flex:1, padding:'11px', fontSize:13, fontWeight:600, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:TXT3, cursor:'pointer' }}>Отмена</button>
              <button onClick={()=>setStep('active')} style={{ flex:1, padding:'12px', fontSize:14, borderRadius:14, border:'none', background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontWeight:800, cursor:'pointer' }}>
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
          <div style={{ background:SURF, borderRadius:16, padding:'22px', width:380, maxWidth:'94vw', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Название тренировки</span>
              <button onClick={()=>setEditingSlotTitle(null)} style={{ background:'none', border:'none', fontSize:20, color:TXT3, cursor:'pointer', minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
            </div>
            <input value={editingSlotTitle.title}
              onChange={e=>setEditingSlotTitle(s=>({...s,title:e.target.value}))}
              placeholder="Название тренировки"
              style={{ width:'100%', padding:'11px 13px', fontSize:14, borderRadius:10, border:`1.5px solid ${HAIR}`, outline:'none', color:TXT, fontFamily:'inherit', boxSizing:'border-box' }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR}
            />
            <div style={{ display:'flex', gap:10, marginTop:16 }}>
              <button onClick={()=>setEditingSlotTitle(null)}
                style={{ flex:1, padding:'12px', fontSize:14, borderRadius:10, border:`1.5px solid ${HAIR}`, background:'none', color:TXT3, cursor:'pointer' }}>Отмена</button>
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
          <div style={{ background:SURF, borderRadius:16, padding:'22px', width:440, maxWidth:'94vw', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Редактировать упражнение</span>
              <button onClick={()=>setEditingExercise(null)} style={{ background:'none', border:'none', fontSize:20, color:TXT3, cursor:'pointer', minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, color:TXT3, marginBottom:6 }}>Название упражнения</div>
              <input value={editingExercise.name}
                onChange={e=>setEditingExercise(v=>({...v,name:e.target.value}))}
                placeholder="Приседания"
                style={{ width:'100%', padding:'11px 13px', fontSize:14, borderRadius:10, border:`1.5px solid ${HAIR}`, outline:'none', color:TXT, fontFamily:'inherit', boxSizing:'border-box' }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR}
              />
            </div>
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, color:TXT3, marginBottom:6 }}>Подходы / вес / повторения</div>
              <textarea value={editingExercise.sets}
                onChange={e=>setEditingExercise(v=>({...v,sets:e.target.value}))}
                placeholder="20 кг × 15, 25 кг × 12, 25 кг × 12"
                rows={4}
                style={{ width:'100%', padding:'11px 13px', fontSize:13, borderRadius:10, border:`1.5px solid ${HAIR}`, outline:'none', color:TXT, resize:'vertical', lineHeight:1.65, fontFamily:'inherit', boxSizing:'border-box' }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR}
              />
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={()=>setEditingExercise(null)}
                style={{ flex:1, padding:'12px', fontSize:14, borderRadius:10, border:`1.5px solid ${HAIR}`, background:'none', color:TXT3, cursor:'pointer' }}>Отмена</button>
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
              style={{ position:'absolute', top:-42, right:0, background:'none', border:'none', color:'#fff', fontSize:26, cursor:'pointer', minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
            <div style={{ fontSize:13, color:TXT3, marginBottom:8 }}>{playVideo.name}</div>
            <video src={playVideo.url} controls autoPlay style={{ width:'100%', borderRadius:12, maxHeight:'75vh' }} />
          </div>
        </div>
      )}

      {/* ── Уровень 2: упражнения тренировки ── */}
      {currentSlot&&createPortal(
        <div style={{ position:'fixed', inset:0, background:SURF2, zIndex:1001, display:'flex', flexDirection:'column' }}>
          <div style={{ background:SURF, borderBottom:`1px solid ${HAIR}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
            <button data-back="1" onClick={()=>setOpenSlotId(null)}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:TXT3, lineHeight:1, padding:0, minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:17, fontWeight:700, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{currentSlot.title}</div>
              <div style={{ fontSize:11, color:TXT3 }}>{currentSlot.exercises.length} {plural(currentSlot.exercises.length,'упражнение','упражнения','упражнений')}</div>
            </div>
            <div ref={slotHeaderMenuRef} style={{ position:'relative' }}>
              <button data-testid="slot-header-menu-trigger" onClick={e=>{e.stopPropagation();setOpenSlotHeaderMenu(v=>!v)}}
                style={{ background:'none',border:`1px solid ${HAIR}`,borderRadius:7,fontSize:16,cursor:'pointer',color:TXT3,padding:'2px 8px',minHeight:'unset',lineHeight:1.4,letterSpacing:1 }}>⋯</button>
              {openSlotHeaderMenu&&(
                <div data-testid="slot-header-menu" style={{ position:'absolute',top:34,right:0,background:SURF,borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:180,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                  <button data-testid="slot-header-menu-edit" onClick={()=>{setOpenSlotHeaderMenu(false);setEditingSlotTitle({id:currentSlot.id,title:currentSlot.title})}}
                    style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:`1px solid ${HAIR}`,background:'transparent',cursor:'pointer',textAlign:'left',color:TXT,fontSize:13 }}>✏️ Редактировать</button>
                  <button data-testid="slot-header-menu-delete" onClick={async()=>{setOpenSlotHeaderMenu(false);if(await askConfirm(`Удалить тренировку «${currentSlot.title}»?`))deleteSlot(currentSlot.id)}}
                    style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                </div>
              )}
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {currentSlot.exercises.length>0&&(
              <button data-testid="workout-start" onClick={handleStartSlotClick}
                style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:8,width:'100%',padding:'15px',marginBottom:14,borderRadius:12,border:'none',background:TEA,color:'#fff',fontSize:15,fontWeight:700,cursor:'pointer',boxSizing:'border-box',minHeight:'unset' }}>
                ▶ Начать тренировку
              </button>
            )}
            {currentSlot.exercises.length===0&&(
              <div style={{ textAlign:'center', color:TXT3, fontSize:13, marginTop:40 }}>Нажми «+ Добавить упражнение»</div>
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
                      <div style={{ fontSize:14, fontWeight:700, color:TXT, marginBottom:3 }}>{labelOf(catalogExercises,ex.name)||'Упражнение'}</div>
                      <ExMeta name={ex.name} style={{ marginTop:-2, marginBottom:3 }} />
                      {ex.sets&&<div style={{ fontSize:12, color:TXT3, lineHeight:1.7 }}>{ex.sets}</div>}
                    </div>
                    <div ref={openExMenu===ex.id?exMenuRef:null} style={{ position:'relative',flexShrink:0 }}>
                      <button data-testid={`ex-menu-trigger-${ex.id}`} onClick={e=>{e.stopPropagation();setOpenExMenu(openExMenu===ex.id?null:ex.id)}}
                        style={{ width:36,height:36,borderRadius:9,background:SURF2,border:'none',cursor:'pointer',fontSize:17,color:TXT3,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,letterSpacing:1,minHeight:'unset' }}>⋯</button>
                      {openExMenu===ex.id&&(
                        <div data-testid="ex-menu" style={{ position:'absolute',top:40,right:0,background:SURF,borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:180,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                          <button data-testid="ex-menu-edit" onClick={()=>{setOpenExMenu(null);setEditingExercise({slotId:currentSlot.id,exId:ex.id,name:ex.name,sets:ex.sets})}}
                            style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:`1px solid ${HAIR}`,background:'transparent',cursor:'pointer',textAlign:'left',color:TXT,fontSize:13 }}>✏️ Редактировать</button>
                          <button data-testid="ex-menu-delete" onClick={()=>{setOpenExMenu(null);deleteExercise(currentSlot.id,ex.id)}}
                            style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Видео упражнения — из серверной карты exercise_videos по
                      имени. Есть — постер-превью с ▶, тап открывает плеер. Нет
                      — блок не рендерим. Старые локальные IndexedDB-кнопки для
                      клиента убраны (редактор тренера — отдельный шаг). */}
                  {(pickVideo(exerciseVideos,ex.name,folderToContext(openFolder))||isTrainer)&&(
                    <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${HAIR}`, display:'flex', alignItems:'flex-start', gap:8 }}>
                      {pickVideo(exerciseVideos,ex.name,folderToContext(openFolder))&&(
                        <button onClick={()=>setPlayVideo({url:pickVideo(exerciseVideos,ex.name,folderToContext(openFolder)).video_url,name:labelOf(catalogExercises,ex.name)})}
                          style={{ position:'relative', display:'block', width:'100%', maxWidth:220, border:'none', padding:0, borderRadius:12, overflow:'hidden', cursor:'pointer', background:SURF2 }}>
                          <img src={pickVideo(exerciseVideos,ex.name,folderToContext(openFolder)).poster_url} alt={ex.name} loading="lazy"
                            style={{ width:'100%', display:'block', aspectRatio:'16/9', objectFit:'cover' }} />
                          <span style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                            <span style={{ width:44, height:44, borderRadius:'50%', background:'rgba(0,0,0,0.55)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>▶</span>
                          </span>
                        </button>
                      )}
                      {/* Смена ролика — только тренеру, видна и когда видео нет. */}
                      {isTrainer&&(
                        <button onClick={()=>setVideoPickerFor(ex.name)} title="Изменить видео"
                          style={{ width:26, height:26, borderRadius:'50%', border:'none', background:`${PUR}22`, color:PUR, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, minHeight:'unset' }}>
                          <GlassIcon name="gear" size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
              return groups.map((g,gi2)=>g.kind==='ss'?(
                <div key={g.items[0].id} style={{ borderRadius:20, overflow:'hidden', marginBottom:10, border:`1.5px solid ${g.color}40`, boxShadow:`0 1px 4px ${g.color}18` }}>
                  <div style={{ background:g.color, padding:'6px 14px', display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#fff', letterSpacing:'0.3px' }}><GlassIcon name="lightning" size={14} style={{verticalAlign:"-3px",marginRight:4}} />СУПЕРСЕТ — без отдыха между упражнениями</span>
                  </div>
                  <div style={{ background:SURF }}>
                    {g.items.map((ex,ii)=>renderExBody(ex,ii>0))}
                  </div>
                </div>
              ):(
                <div key={g.items[0].id} style={{ background:SURF, borderRadius:20, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10 }}>
                  {renderExBody(g.items[0],false)}
                </div>
              ))
            })()}
            <button onClick={()=>addExercise(currentSlot.id)}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, width:'100%', padding:'14px', marginTop:4, borderRadius:12, border:`1.5px dashed ${PUR}`, background:'rgba(124,122,240,0.14)', color:PUR, fontSize:14, fontWeight:700, cursor:'pointer', boxSizing:'border-box', minHeight:'unset' }}>
              ＋ Добавить упражнение
            </button>

          </div>
        </div>
      , document.body)}

      {/* Подсказка про пакет — через портал, как соседние модалки: список слотов
          лежит в прокручиваемом контейнере, обычный fixed внутри него на iOS
          иногда позиционируется относительно предка. */}
      {showSlotLock&&createPortal(
        <PlanLockModal {...LOCK_SLOTS} onClose={()=>setShowSlotLock(false)}
          onOpenPlans={()=>{setShowSlotLock(false);openPlans?.()}} />,
        document.body)}

      {/* Модалка: программа вообще не выбрана — предлагаем принять текущую
          по клику "▶ Начать тренировку" (второй путь выбора программы). */}
      {showAdoptProgramModal&&createPortal(
        <div onClick={()=>setShowAdoptProgramModal(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1400, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:SURF, borderRadius:16, padding:'22px 20px', maxWidth:340, width:'100%', boxSizing:'border-box' }}>
            <div style={{ fontSize:16, fontWeight:700, color:TXT, textAlign:'center', marginBottom:20, lineHeight:1.4 }}>
              Начать тренироваться по программе «{folderLabel(openFolder)}»?
            </div>
            <button onClick={async()=>{const{ok}=await selectProgram(openFolder);if(ok){setShowAdoptProgramModal(false);startSlotWorkout()}}}
              style={{ width:'100%', padding:'13px', borderRadius:12, border:'none', background:PUR, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', marginBottom:8 }}>
              Да, буду тренироваться по этой программе
            </button>
            <button onClick={()=>setShowAdoptProgramModal(false)}
              style={{ width:'100%', padding:'11px', borderRadius:12, border:'none', background:'none', color:TXT3, fontSize:13, cursor:'pointer' }}>
              Отмена
            </button>
          </div>
        </div>
      , document.body)}

      {/* Модалка: выбрана ДРУГАЯ программа с выполненными тренировками —
          явное согласие на переключение, с объяснением что прогресс по
          упражнениям не теряется (история хранится по упражнению, не по
          программе, см. buildExerciseAggregates в workoutPrompt.js). */}
      {showSwitchProgramModal&&createPortal(
        <div onClick={()=>setShowSwitchProgramModal(null)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1400, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:SURF, borderRadius:16, padding:'22px 20px', maxWidth:360, width:'100%', boxSizing:'border-box' }}>
            <div style={{ fontSize:15, fontWeight:700, color:TXT, textAlign:'center', marginBottom:10, lineHeight:1.4 }}>
              Ты тренируешься по программе «{folderLabel(showSwitchProgramModal.from)}», выполнено {showSwitchProgramModal.count} из {(templateStructures[showSwitchProgramModal.from]||[]).length||SLOT_COUNT} тренировок.
              <br />Перейти на «{folderLabel(showSwitchProgramModal.to)}»?
            </div>
            <div style={{ fontSize:12.5, color:TXT3, textAlign:'center', lineHeight:1.5, marginBottom:20 }}>
              Прогресс не потеряется: веса, которые ты набираешь в упражнениях, сохранятся и в новой программе.
            </div>
            <button onClick={async()=>{const to=showSwitchProgramModal.to;const{ok}=await selectProgram(to);if(ok){setShowSwitchProgramModal(null);startSlotWorkout()}}}
              style={{ width:'100%', padding:'13px', borderRadius:12, border:'none', background:PUR, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', marginBottom:8 }}>
              Перейти на «{showSwitchProgramModal.to}»
            </button>
            <button onClick={()=>setShowSwitchProgramModal(null)}
              style={{ width:'100%', padding:'11px', borderRadius:12, border:'none', background:'none', color:TXT3, fontSize:13, cursor:'pointer' }}>
              Остаться на «{showSwitchProgramModal.from}»
            </button>
          </div>
        </div>
      , document.body)}

      {/* Программа пройдена (12 из 12, см. checkProgramCompletion выше) —
          три варианта дальше, каждый заметная кнопка с подписью под ней. */}
      {completedProgramModal&&createPortal(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1400, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:SURF, borderRadius:16, padding:'24px 20px', maxWidth:380, width:'100%', boxSizing:'border-box' }}>
            <div style={{ display:'flex',justifyContent:'center',marginBottom:8 }}><GlassIcon name="trophy" size={38} /></div>
            <div style={{ fontSize:18, fontWeight:700, color:TXT, textAlign:'center', marginBottom:8 }}>
              Программа «{completedProgramModal}» пройдена!
            </div>
            <div style={{ fontSize:13.5, color:TXT3, textAlign:'center', lineHeight:1.5, marginBottom:22 }}>
              Все 12 тренировок пройдены. Отличная работа.
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <button onClick={()=>startNewProgramCycle(completedProgramModal)}
                  style={{ width:'100%', padding:'13px', borderRadius:12, border:'none', background:PUR, color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer' }}>
                  Пройти «{completedProgramModal}» заново
                </button>
                <div style={{ fontSize:11.5, color:TXT3, textAlign:'center', lineHeight:1.4, marginTop:6 }}>
                  Начнёшь сначала, но веса приложение подберёт от твоего текущего уровня, а не со старта.
                </div>
              </div>
              <div>
                <button onClick={chooseOtherProgramFromCompletion}
                  style={{ width:'100%', padding:'13px', borderRadius:12, border:`1.5px solid ${PUR}`, background:'none', color:PUR, fontSize:14, fontWeight:700, cursor:'pointer' }}>
                  Выбрать другую программу
                </button>
                <div style={{ fontSize:11.5, color:TXT3, textAlign:'center', lineHeight:1.4, marginTop:6 }}>
                  Твой прогресс сохранится — в новой программе веса в знакомых упражнениях останутся набранными.
                </div>
              </div>
              <div>
                <a href={MAX_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" onClick={()=>setCompletedProgramModal(null)}
                  style={{ display:'block', width:'100%', padding:'13px', borderRadius:12, border:'none', background:'#16a34a', color:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', textAlign:'center', textDecoration:'none', boxSizing:'border-box' }}>
                  Написать тренеру
                </a>
                <div style={{ fontSize:11.5, color:TXT3, textAlign:'center', lineHeight:1.4, marginTop:6 }}>
                  Максим посмотрит твой прогресс детально и подскажет, куда двигаться дальше. Рекомендую этот вариант.
                </div>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* ── Уровень 1: список тренировок в папке ── */}
      {openFolder&&createPortal(
        <div style={{ position:'fixed', inset:0, background:SURF2, zIndex:1000, display:'flex', flexDirection:'column' }}>
          <div style={{ background:SURF, borderBottom:`1px solid ${HAIR}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
            <button data-back="1" onClick={()=>setOpenFolder(null)}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:TXT3, lineHeight:1, padding:0, minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
            <GlassIcon name={folderIcon(openFolder)} size={34} />
            <div>
              <div style={{ fontSize:17, fontWeight:700, color:TXT }}>{folderLabel(openFolder)}</div>
              <div style={{ fontSize:11, color:TXT3 }}>
                {(folderSlots[openFolder]||[]).length} тренировок · {(folderSlots[openFolder]||[]).reduce((s,sl)=>s+sl.exercises.filter(e=>e.videoId).length,0)} видео
              </div>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {folderSlots[openFolder].map(slot=>{
              const ec=slot.exercises.length
              const vc=slot.exercises.filter(e=>e.videoId).length
              // Отметка выполнения — по записям workouts с именем этого
              // слота (workoutsSinceCycleStart — тот же список workoutsLog,
              // но только с даты последнего "Пройти заново", если он был,
              // см. countCompletedSlots выше). Дата последней тренировки
              // берётся по максимуму, счётчик показывается только при
              // повторных прохождениях (>1).
              const slotName=`${openFolder} — тренировка ${slot.slotNum}`
              const completions=workoutsSinceCycleStart(openFolder).filter(w=>w.name===slotName)
              const lastDate=completions.length?completions.reduce((max,w)=>w.date>max?w.date:max,completions[0].date):null
              // Слоты платной части шаблона: приглушены, вместо "›" замок,
              // клик не открывает слот, а показывает подсказку про пакет.
              const locked=isSlotLocked(slot.slotNum)
              return (
                <div key={slot.id} data-testid={`program-slot-${slot.slotNum}`} style={{ background:SURF, borderRadius:20, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10, display:'flex', flexDirection:'column', alignItems:'center', padding:'16px 16px 14px', cursor:'pointer', position:'relative', opacity:locked?0.55:1 }}
                  onClick={()=>{if(locked){setShowSlotLock(true);return}setOpenSlotId(slot.id)}}>
                  <div style={{ position:'absolute', top:14, left:14, width:36, height:36, borderRadius:'50%', background:locked?SURF2:(ec>0?PUR:SURF2), display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, color:locked?TXT3:(ec>0?'#fff':TXT3) }}>
                    {slot.slotNum}
                  </div>
                  <span style={{ position:'absolute', top:18, right:14, fontSize:locked?15:18, color:TXT3 }}>{locked?'🔒':'›'}</span>
                  <div style={{ textAlign:'center', paddingTop:6 }}>
                    <div style={{ fontSize:16, fontWeight:700, color:TXT, marginBottom:4 }}>{slot.title}</div>
                    <div style={{ fontSize:12, color:TXT3 }}>
                      {locked?'Доступно в пакете БАЗА':(ec===0?'Нет упражнений':`${ec} упр.${vc>0?` · ${vc} видео`:''}`)}
                    </div>
                    {completions.length>0&&(
                      <div style={{ fontSize:11.5, color:'#16a34a', fontWeight:600, marginTop:5, display:'flex', alignItems:'center', gap:4 }}>
                        <GlassIcon name="check" size={13} />{new Date(lastDate).toLocaleDateString('ru',{day:'numeric',month:'long'})}
                        {completions.length>1?` · ${completions.length} ${pluralizeTimes(completions.length)}`:''}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      , document.body)}

      {/* Истёкшая подписка у клиента тренера. Именно плашка, а не блокировка:
          клиент остаётся клиентом, программа ниже никуда не девается — это
          мягкое напоминание продлить. */}
      {coachSubExpired&&(
        <Card style={{ marginBottom:14, border:`1.5px solid ${DANGER}55`, background:'rgba(255,69,58,0.10)' }}>
          <div style={{ fontSize:12, fontWeight:700, color:DANGER, textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>
            Подписка закончилась
          </div>
          <div style={{ fontSize:13, color:TXT2, lineHeight:1.45, marginBottom:12 }}>
            Доступ к ПРЕМИУМ истёк. Продли, чтобы снова открыть ИИ-ассистента, все тренировки и прогресс по упражнениям.
          </div>
          <button onClick={()=>openPlans?.()}
            style={{ padding:'10px 16px', fontSize:13, fontWeight:700, color:'#fff', background:DANGER, border:'none', borderRadius:10, cursor:'pointer' }}>
            Продлить подписку
          </button>
        </Card>
      )}

      {/* Персональная программа от тренера (assigned_programs) — только
          показ, см. loadAssignedProgram выше. Загрузка/ошибка — компактной
          строкой, не мешают основному списку папок ниже; пусто (нет строки
          для этого клиента) — баннер просто не рендерится вообще. */}
      {assignedProgramLoading?(
        <div style={{ fontSize:12, color:TXT3, marginBottom:14, padding:'4px 2px' }}>Загрузка программы от тренера...</div>
      ):assignedProgramError?(
        <div style={{ fontSize:12, color:'#ef4444', marginBottom:14, padding:'4px 2px', display:'flex', alignItems:'center', gap:8 }}>
          Не удалось загрузить программу от тренера
          <button onClick={loadAssignedProgram} style={{ fontSize:11, color:PUR, background:'none', border:`1px solid ${HAIR}`, borderRadius:6, padding:'3px 8px', cursor:'pointer' }}>Повторить</button>
        </div>
      ):assignedProgram&&(()=>{
        // Карточка-папка в ТОЧНО таком же стиле, что и шаблонные папки ниже:
        // иконка, одно название, подпись «N тренировок · M упр.», шеврон,
        // галочка выбранного. Отличие только в акценте (фиолетовая рамка).
        const wCount=assignedProgram.structure?.length||0
        const exCount=(assignedProgram.structure||[]).reduce((s,w)=>s+(w.exercises?.length||0),0)
        const isSel=selectedProgram===TRAINER_PROGRAM_KEY
        return (
        <Card style={{ marginBottom:14, cursor:'pointer', position:'relative', border:isSel?`1.5px solid ${PUR}`:`1.5px solid ${PUR}33`, background:isSel?'rgba(124,122,240,0.14)':SURF }}
          onClick={()=>setProgramOpen(true)}>
          <span style={{ position:'absolute', top:'50%', right:16, transform:'translateY(-50%)', fontSize:20, color:TXT3 }}>›</span>
          {isSel&&<span style={{ position:'absolute', top:10, right:16 }}><GlassIcon name="check" size={18} /></span>}
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingRight:20 }}>
            <div style={{ display:'flex',justifyContent:'center',marginBottom:6 }}><GlassIcon name="template" size={42} /></div>
            <div style={{ fontSize:16, fontWeight:700, color:TXT, textAlign:'center' }}>{programTitle(assignedProgram.title)}</div>
            {(()=>{
              // Осмысленная подпись: сегодняшняя тренировка > ближайшая будущая >
              // нынешний счётчик. Даты мягкие — прошедшие в подписи не «горят».
              const {todayList,future}=groupProgramWorkouts(assignedProgram.structure)
              if(todayList.length)return <div style={{ fontSize:13, color:PUR, fontWeight:700, marginTop:3, textAlign:'center' }}>Сегодня: {todayList[0].w.name||'Тренировка'}</div>
              if(future.length)return <div style={{ fontSize:12, color:TXT3, marginTop:3, textAlign:'center' }}>Ближайшая: {dateShort(future[0].w.date)}</div>
              return <div style={{ fontSize:12, color:TXT3, marginTop:3, textAlign:'center' }}>{wCount} {pluralizeWorkouts(wCount)} · {exCount} упр.</div>
            })()}
          </div>
        </Card>
        )
      })()}

      {/* ── Модалка программы от тренера. Устройство то же, что у модалки
          папки-шаблона выше: полноэкранная панель с шапкой и «Назад».
          Только чтение — запуск тренировок отсюда пока не делаем. ── */}
      {programOpen&&assignedProgram&&createPortal(
        <div style={{ position:'fixed', inset:0, background:SURF2, zIndex:1000, display:'flex', flexDirection:'column' }}>
          <div style={{ background:SURF, borderBottom:`1px solid ${HAIR}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
            {/* «Назад» из тренировки возвращает к списку, из списка — закрывает
                модалку целиком (и сбрасывает выбранную тренировку). */}
            <button data-back="1" onClick={()=>{if(openProgramWorkoutIdx!=null){setOpenProgramWorkoutIdx(null);return}setProgramOpen(false);setOpenProgramWorkoutIdx(null)}}
              style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:TXT3, lineHeight:1, padding:0, minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
            <GlassIcon name="template" size={34} />
            <div>
              <div style={{ fontSize:17, fontWeight:700, color:TXT }}>
                {openProgramWorkoutIdx==null
                  ?(programTitle(assignedProgram.title))
                  :(assignedProgram.structure?.[openProgramWorkoutIdx]?.name||`Тренировка ${openProgramWorkoutIdx+1}`)}
              </div>
              {openProgramWorkoutIdx!=null&&assignedProgram.structure?.[openProgramWorkoutIdx]?.date&&(
                <div style={{ fontSize:11, color:PUR, fontWeight:600 }}>{dateLabel(assignedProgram.structure[openProgramWorkoutIdx].date)}</div>
              )}
              <div style={{ fontSize:11, color:TXT3 }}>
                {openProgramWorkoutIdx==null
                  ?`${assignedProgram.structure?.length||0} ${pluralizeWorkouts(assignedProgram.structure?.length||0)}`
                  :`${assignedProgram.structure?.[openProgramWorkoutIdx]?.exercises?.length||0} ${plural(assignedProgram.structure?.[openProgramWorkoutIdx]?.exercises?.length||0,'упражнение','упражнения','упражнений')}`}
              </div>
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 32px' }}>
            {openProgramWorkoutIdx==null?(()=>{
              // Список по датам. i — ИСХОДНЫЙ индекс в structure: и переход в
              // детали (setOpenProgramWorkoutIdx), и быстрый старт открывают ту
              // самую тренировку. Сортируем пары {w,i}, а не сам массив.
              const {todayList,future,past,dateless}=groupProgramWorkouts(assignedProgram.structure)
              const today=localTodayISO()
              // Карточка тренировки — прежняя вёрстка + число месяца в кружке,
              // подпись даты и рамка для сегодняшней. Прошедшие — как обычные.
              const card=({w,i})=>{
                const ec=w.exercises?.length||0
                const isToday=w.date===today
                const circle=w.date?parseLocalDate(w.date).getDate():(i+1)
                return (
                  <div key={i} onClick={()=>setOpenProgramWorkoutIdx(i)}
                    style={{ background:SURF, borderRadius:20, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10, display:'flex', flexDirection:'column', alignItems:'center', padding:'16px 16px 14px', cursor:'pointer', position:'relative', border:isToday?`1.5px solid ${PUR}`:'1.5px solid transparent' }}>
                    <div style={{ position:'absolute', top:14, left:14, width:36, height:36, borderRadius:'50%', background:ec>0?PUR:SURF2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, color:ec>0?'#fff':TXT3 }}>{circle}</div>
                    <span style={{ position:'absolute', top:18, right:14, fontSize:18, color:TXT3 }}>›</span>
                    <div style={{ textAlign:'center', paddingTop:6 }}>
                      <div style={{ fontSize:16, fontWeight:700, color:TXT, marginBottom:4 }}>{w.name||`Тренировка ${i+1}`}</div>
                      {w.date&&<div style={{ fontSize:12, color:TXT3, marginBottom:2 }}>{dateLabel(w.date)}</div>}
                      <div style={{ fontSize:12, color:TXT3 }}>{ec===0?'Нет упражнений':`${ec} упр.`}</div>
                      {isToday&&(
                        <button onClick={e=>{e.stopPropagation();startTrainerWorkout(assignedProgram.structure[i])}}
                          style={{ marginTop:10, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6, padding:'9px 18px', borderRadius:10, border:'none', background:TEA, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', minHeight:'unset' }}>
                          ▶ Начать
                        </button>
                      )}
                    </div>
                  </div>
                )
              }
              const head=t=>(<div key={`h-${t}`} style={{ fontSize:12, fontWeight:700, color:TXT3, margin:'6px 2px 8px' }}>{t}</div>)
              return (
              <>
                {todayList.length>0&&<>{head('Сегодня')}{todayList.map(card)}</>}
                {future.length>0&&<>{head('Дальше')}{future.map(card)}</>}
                {past.length>0&&(showPastWorkouts
                  ?<>{head('Раньше')}{past.map(card)}</>
                  :<button onClick={()=>setShowPastWorkouts(true)}
                     style={{ width:'100%', marginBottom:10, padding:'11px', borderRadius:12, border:`1px solid ${HAIR}`, background:SURF, color:TXT3, fontSize:13, fontWeight:600, cursor:'pointer' }}>
                     Показать предыдущие ({past.length})
                   </button>
                )}
                {dateless.length>0&&<>{head('Без даты')}{dateless.map(card)}</>}
                {/* Выбор программы тренера активной — с отметкой, когда выбрана. */}
                <button onClick={selectTrainerProgram}
                  style={{ width:'100%', marginTop:4, padding:'13px', borderRadius:12, border:'none', background:selectedProgram===TRAINER_PROGRAM_KEY?SURF2:PUR, color:selectedProgram===TRAINER_PROGRAM_KEY?TXT3:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:7 }}>
                  {selectedProgram===TRAINER_PROGRAM_KEY&&<GlassIcon name="check" size={17} />}{selectedProgram===TRAINER_PROGRAM_KEY?'Эта программа выбрана':'Тренироваться по этой программе'}
                </button>
              </>
              )
            })():(
              // Одна тренировка — ТЕМ ЖЕ экраном, что шаблонный слот: «Начать»
              // сверху, ниже карточки упражнений (бейдж, название, ExMeta,
              // подходы, видео постером). Комментарий тренера — под упражнением.
              <>
                <button data-testid="workout-start-assigned" onClick={()=>startTrainerWorkout(assignedProgram.structure[openProgramWorkoutIdx])}
                  style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:8,width:'100%',padding:'15px',marginBottom:14,borderRadius:12,border:'none',background:TEA,color:'#fff',fontSize:15,fontWeight:700,cursor:'pointer',boxSizing:'border-box',minHeight:'unset' }}>
                  ▶ Начать тренировку
                </button>
                {(assignedProgram.structure?.[openProgramWorkoutIdx]?.exercises||[]).map((ex,ei)=>(
                  <div key={ei} style={{ background:SURF, borderRadius:20, boxShadow:'0 1px 4px rgba(0,0,0,0.07)', marginBottom:10 }}>
                    <div style={{ padding:'14px 14px 12px' }}>
                      <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                        <div style={{ flexShrink:0, width:36, height:36, borderRadius:'50%', background:PUR, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:'#fff' }}>{ei+1}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:700, color:TXT, marginBottom:3 }}>{labelOf(catalogExercises,ex.name)||'Упражнение'}</div>
                          <ExMeta name={ex.name} style={{ marginTop:-2, marginBottom:3 }} />
                          {ex.sets&&<div style={{ fontSize:12, color:TXT3, lineHeight:1.7 }}>{ex.sets}</div>}
                          {ex.note&&(
                            <div style={{ fontSize:12, color:TXT2, marginTop:6, lineHeight:1.45, paddingLeft:8, borderLeft:`2px solid ${PUR}` }}>
                              <span style={{ color:PUR, fontWeight:700 }}>От тренера: </span>{ex.note}
                            </div>
                          )}
                        </div>
                      </div>
                      {(pickVideo(exerciseVideos,ex.name,null)||isTrainer)&&(
                        <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${HAIR}`, display:'flex', alignItems:'flex-start', gap:8 }}>
                          {pickVideo(exerciseVideos,ex.name,null)&&(
                            <button onClick={()=>setPlayVideo({url:pickVideo(exerciseVideos,ex.name,null).video_url,name:labelOf(catalogExercises,ex.name)})}
                              style={{ position:'relative', display:'block', width:'100%', maxWidth:220, border:'none', padding:0, borderRadius:12, overflow:'hidden', cursor:'pointer', background:SURF2 }}>
                              <img src={pickVideo(exerciseVideos,ex.name,null).poster_url} alt={ex.name} loading="lazy"
                                style={{ width:'100%', display:'block', aspectRatio:'16/9', objectFit:'cover' }} />
                              <span style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                                <span style={{ width:44, height:44, borderRadius:'50%', background:'rgba(0,0,0,0.55)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>▶</span>
                              </span>
                            </button>
                          )}
                          {/* Смена ролика — только тренеру, видна и когда видео нет. */}
                          {isTrainer&&(
                            <button onClick={()=>setVideoPickerFor(ex.name)} title="Изменить видео"
                              style={{ width:26, height:26, borderRadius:'50%', border:'none', background:`${PUR}22`, color:PUR, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, minHeight:'unset' }}>
                              <GlassIcon name="gear" size={15} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      , document.body)}

      {/* ── Уровень 0: список папок ── */}
      {templateFolders.map(t=>{
        const folder=t.key
        const slotsArr=folderSlots[folder]||[]
        const totalEx=slotsArr.reduce((s,sl)=>s+sl.exercises.length,0)
        const totalVids=slotsArr.reduce((s,sl)=>s+sl.exercises.filter(e=>e.videoId).length,0)
        const isSelected=selectedProgram===folder
        return (
          <HubCard key={folder}
            testId={`program-folder-${folder}`}
            icon={folderIcon(folder)}
            title={t.label}
            subtitle={`${slotsArr.length} тренировок · ${totalEx} упр.${totalVids>0?` · ${totalVids} видео`:''}`}
            selected={isSelected}
            checked={isSelected}
            onInfo={()=>setInfoFolder(folder)}
            /* Редактор шаблона — только тренеру. Клиент кнопку не видит. */
            topRight={isTrainer?(
              <button onClick={e=>{e.stopPropagation();setTemplateEditor({key:folder,isNew:false})}} title="Редактировать программу"
                style={{ width:26, height:26, borderRadius:'50%', border:'none', background:`${PUR}22`, color:PUR, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset', padding:0 }}>
                <GlassIcon name="gear" size={15} />
              </button>
            ):null}
            onClick={()=>setOpenFolder(folder)} />
        )
      })}
      {/* Новая программа — только тренеру. */}
      {isTrainer&&(
        <button onClick={createProgram}
          style={{ width:'100%', marginBottom:10, padding:'12px', fontSize:13, borderRadius:12, border:`1.5px dashed ${PUR}66`, background:`${PUR}0d`, color:PUR, cursor:'pointer', fontWeight:700 }}>
          + Программа
        </button>
      )}
      {/* Конструктор — только тренеру (этап 1 разморозки, см.
          docs/CONSTRUCTOR_FROZEN.md). Клиент этой кнопки не видит, и другого
          входа в конструктор нет: сам экран тоже закрыт ролью, см.
          case 'constructor' в renderOther (App). */}
      {isTrainer&&(
        <button data-testid="constructor-open" onClick={onOpenConstructor}
          style={{ width:'100%', marginBottom:10, padding:'12px', fontSize:13, borderRadius:12, border:`1.5px dashed ${PUR}66`, background:`${PUR}0d`, color:PUR, cursor:'pointer', fontWeight:700 }}>
          Конструктор
        </button>
      )}

      {/* ── Модалка описания программы ── */}
      {infoFolder&&createPortal(
        <div onClick={()=>setInfoFolder(null)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1300, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:SURF, borderRadius:16, padding:'22px 20px', maxWidth:340, width:'100%', boxSizing:'border-box' }}>
            <div style={{ display:'flex',justifyContent:'center',marginBottom:8 }}><GlassIcon name={folderIcon(infoFolder)} size={42} /></div>
            <div style={{ fontSize:17, fontWeight:700, color:TXT, textAlign:'center', marginBottom:8 }}>{folderLabel(infoFolder)}</div>
            <div style={{ fontSize:13, color:TXT3, textAlign:'center', lineHeight:1.5, marginBottom:18 }}>{FOLDER_DESCRIPTIONS[infoFolder]||''}</div>
            <button onClick={()=>selectProgram(infoFolder)}
              style={{ width:'100%', padding:'13px', borderRadius:12, border:'none', background:selectedProgram===infoFolder?SURF2:PUR, color:selectedProgram===infoFolder?TXT3:'#fff', fontSize:14, fontWeight:700, cursor:'pointer', marginBottom:8, display:'flex', alignItems:'center', justifyContent:'center', gap:7 }}>
              {selectedProgram===infoFolder&&<GlassIcon name="check" size={17} />}{selectedProgram===infoFolder?'Эта программа выбрана':'Тренироваться по этой программе'}
            </button>
            <button onClick={()=>setInfoFolder(null)}
              style={{ width:'100%', padding:'11px', borderRadius:12, border:'none', background:'none', color:TXT3, fontSize:13, cursor:'pointer' }}>
              Закрыть
            </button>
          </div>
        </div>
      , document.body)}
    </div>
  )
}

const NUTRITION_PLANS=[
  {
    id:'45_50',title:'Рацион 45–50 кг',subtitle:'7 дней · ~1400 ккал/день',icon:'plate',
    target:{cal:1400,p:94,c:141,f:47},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'8:00',items:['Овсянка на воде/молоке (45г сух.)','Банан (80г), Семена льна (5г), Грецкие орехи (10г)'],p:12,c:55,f:10,cal:320},
        {name:'Перекус',time:'11:00',items:['Творог 5% (100г)','Яблоко (120г)'],p:18,c:20,f:5,cal:180},
        {name:'Обед',time:'14:00',items:['Куриная грудка запеч. (100г сыр.), Гречка (50г сух.)','Салат (огурец, помидор 150г), Оливковое масло (5г)'],p:35,c:40,f:10,cal:450},
        {name:'Перекус',time:'17:00',items:['Кефир 1% (150мл)','Черника (70г)'],p:6,c:10,f:3,cal:90},
        {name:'Ужин',time:'19:30',items:['Треска на пару (90г)','Брокколи туш. (200г)','1/4 авокадо (30г)'],p:22,c:15,f:10,cal:250},
      ],total:{p:93,c:140,f:38,cal:1290},tip:'добавить 1 ч.л. орехов (5г) или 1 фрукт для добора жиров/углеводов.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречка (45г сух.)','Омлет из 2 яиц','Огурец (100г)'],p:20,c:35,f:15,cal:380},
        {name:'Перекус',time:'',items:['Йогурт натуральный (150г)','Груша (100г)'],p:5,c:20,f:3,cal:130},
        {name:'Обед',time:'',items:['Индейка тушеная (100г сыр.)','Бурый рис (45г сух.)','Кабачок гриль (150г)'],p:30,c:40,f:8,cal:400},
        {name:'Перекус',time:'',items:['Творог 5% (80г)','1/2 грейпфрута'],p:14,c:10,f:4,cal:130},
        {name:'Ужин',time:'',items:['Салат «Греческий»: Помидор (100г), Огурец (100г), Фета (50г), Маслины (5 шт), Масло (3г)'],p:15,c:15,f:18,cal:250},
      ],total:{p:84,c:120,f:48,cal:1290},tip:'добавить 30г риса или 1 хлебец к обеду.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка: Творог 120г + 1 яйцо + Яблоко 50г'],p:22,c:20,f:10,cal:290},
        {name:'Перекус',time:'',items:['Хлебец цельнозерновой (10г)','Сыр (20г)','Помидор (100г)'],p:5,c:8,f:5,cal:90},
        {name:'Обед',time:'',items:['Суп куриный: Курица (70г), Картофель (80г), Овощи (150г)','Хлеб (20г)'],p:20,c:40,f:8,cal:340},
        {name:'Перекус',time:'',items:['Яблоко (120г)','Фисташки (10г)'],p:2,c:15,f:5,cal:120},
        {name:'Ужин',time:'',items:['Говядина отварная (80г)','Свекла варёная (100г)','Чернослив (15г)','Сметана 10% (15г)'],p:20,c:25,f:10,cal:280},
      ],total:{p:69,c:108,f:38,cal:1120},tip:'увеличить порцию говядины до 100г и добавить 30г гречки.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 2 яиц с помидорами (100г)','1/2 тоста (15г)','Авокадо (20г)'],p:15,c:15,f:18,cal:270},
        {name:'Перекус',time:'',items:['Творог 5% (100г)','Киви (80г)'],p:18,c:15,f:5,cal:190},
        {name:'Обед',time:'',items:['Хек запеченный (100г)','Картофель отварной (120г)','Капуста тушеная (150г)'],p:25,c:35,f:8,cal:350},
        {name:'Перекус',time:'',items:['Кефир 1% (150мл)','Курага (20г)'],p:6,c:15,f:3,cal:120},
        {name:'Ужин',time:'',items:['Куриная грудка (70г)','Чечевица (40г сух.)','Руккола (50г)'],p:30,c:30,f:5,cal:320},
      ],total:{p:94,c:110,f:39,cal:1250},tip:'добавить 1 ч.л. масла (5г) в гарнир или фрукт на перекус.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Пшённая каша (40г сух.)','Яйцо вареное (1 шт)','Тыквенные семечки (10г)'],p:15,c:35,f:12,cal:320},
        {name:'Перекус',time:'',items:['Йогурт греческий (150г)','Апельсин (100г)'],p:5,c:20,f:3,cal:130},
        {name:'Обед',time:'',items:['Фрикадельки из индейки (100г фарша)','Макароны (40г сух.)','Стручковая фасоль (120г)'],p:25,c:40,f:10,cal:400},
        {name:'Перекус',time:'',items:['Творог 5% (80г)','Клубника (70г)'],p:14,c:10,f:4,cal:140},
        {name:'Ужин',time:'',items:['Рагу овощное с фасолью: Фасоль конс. (40г), Овощи (200г)','Тофу (60г)'],p:15,c:25,f:8,cal:250},
      ],total:{p:74,c:130,f:37,cal:1240},tip:'увеличить макароны до 50г и добавить 10г орехов.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (120г), Сметана 10% (20г), Изюм (15г), Миндаль (5г)'],p:20,c:20,f:10,cal:270},
        {name:'Перекус',time:'',items:['Хлебец (10г), Авокадо (20г), Огурец (100г)'],p:3,c:8,f:7,cal:110},
        {name:'Обед',time:'',items:['Куриная голень без кожи (100г сыр.), Перловка (40г сух.)','Салат (150г)'],p:25,c:35,f:15,cal:420},
        {name:'Перекус',time:'',items:['Яблоко печеное (120г)','Кешью (10г)'],p:2,c:20,f:5,cal:150},
        {name:'Ужин',time:'',items:['Омлет из 2 яиц с шампиньонами (50г)','Свекла вареная (100г)'],p:20,c:15,f:15,cal:310},
      ],total:{p:70,c:103,f:52,cal:1260},tip:'добавить 30г творога и 30г риса.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (45г сух.)','Яблоко зеленое (100г)','Арахисовая паста (5г)'],p:10,c:50,f:7,cal:300},
        {name:'Перекус',time:'',items:['Кефир 1% (150г)','Банан (70г)'],p:6,c:25,f:3,cal:150},
        {name:'Обед',time:'',items:['Говядина тушеная (90г сыр.)','Гречка (45г сух.)','Морковь тушеная (150г)'],p:30,c:45,f:15,cal:480},
        {name:'Перекус',time:'',items:['Творог 5% (100г)','Мандарин (100г)'],p:18,c:15,f:5,cal:180},
        {name:'Ужин',time:'',items:['Котлеты рыбные (90г филе)','Цветная капуста (250г)','Лимонный сок'],p:20,c:15,f:8,cal:240},
      ],total:{p:84,c:150,f:38,cal:1350},tip:'добавить 1 ст.л. оливкового масла (10г) в салат или гарнир.'},
    ]
  },
  {
    id:'51_55',title:'Рацион 51–55 кг',subtitle:'7 дней · ~1600 ккал/день',icon:'plate',
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
    id:'56_60',title:'Рацион 56–60 кг',subtitle:'7 дней · ~1800 ккал/день',icon:'plate',
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
    id:'61_65',title:'Рацион 61–65 кг',subtitle:'7 дней · ~1900 ккал/день',icon:'plate',
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
    id:'66_70',title:'Рацион 66–70 кг',subtitle:'7 дней · ~2200 ккал/день',icon:'plate',
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
    id:'71_75',title:'Рацион 71–75 кг',subtitle:'7 дней · ~2350 ккал/день',icon:'plate',
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
    id:'76_80',title:'Рацион 76–80 кг',subtitle:'7 дней · ~2550 ккал/день',icon:'plate',
    target:{cal:2550,p:154,c:231,f:77},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (80г сух.) + Банан (150г) + Семена чиа (15г) + Миндаль (30г)'],p:24,c:110,f:28,cal:710},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Яблоко (200г) + Мёд (10г)'],p:38,c:45,f:10,cal:370},
        {name:'Обед',time:'',items:['Куриная грудка (180г сыр.) + Гречка (90г сух.) + Овощной салат (400г) + Оливк. масло (5г)'],p:55,c:75,f:18,cal:760},
        {name:'Перекус',time:'',items:['Кефир 1% (300мл) + Малина (150г)'],p:11,c:25,f:6,cal:220},
        {name:'Ужин',time:'',items:['Лосось на гриле (160г) + Брокколи на пару (300г) + Авокадо (50г)'],p:35,c:20,f:30,cal:520},
      ],total:{p:163,c:275,f:92,cal:2580},tip:'уменьшить орехи до 25г, если нужно снизить жиры.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречка (80г сух.) + Омлет из 3 яиц + Сыр (40г, 10–17%) + Помидор (200г)'],p:42,c:65,f:30,cal:740},
        {name:'Перекус',time:'',items:['Греческий йогурт (300г) + Груша (200г) + Отруби (20г)'],p:15,c:60,f:8,cal:360},
        {name:'Обед',time:'',items:['Индейка (180г сыр.) + Бурый рис (80г сух.) + Тушёные овощи (300г)'],p:47,c:75,f:14,cal:670},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Киви (180г)'],p:38,c:35,f:10,cal:330},
        {name:'Ужин',time:'',items:['Салат с тунцом: Тунец в с/с (150г) + Яйцо (2 шт) + Авокадо (60г) + Овощи (300г) + Лимонный сок'],p:45,c:20,f:25,cal:510},
      ],total:{p:187,c:255,f:87,cal:2610},tip:'заменить одно яйцо в ужине на огурцы, чтобы снизить белок и жиры.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 250г + 2 яйца + Яблоко 100г) + Грецкие орехи (25г)'],p:50,c:50,f:25,cal:680},
        {name:'Перекус',time:'',items:['Тосты цельнозерн. (70г) + Сыр (50г) + Огурец (200г)'],p:20,c:50,f:18,cal:450},
        {name:'Обед',time:'',items:['Чечевичный суп (Чечевица 80г сух. + Говядина 100г + Овощи 200г) + Хлеб (40г)'],p:50,c:90,f:12,cal:720},
        {name:'Перекус',time:'',items:['Запечённое яблоко (250г) + Фисташки (35г)'],p:8,c:40,f:15,cal:340},
        {name:'Ужин',time:'',items:['Телятина запеч. (150г) + Киноа (75г сух.) + Салат (350г)'],p:45,c:70,f:18,cal:670},
      ],total:{p:173,c:300,f:88,cal:2860},tip:'уменьшить хлеб в обеде до 30г и киноа до 65г, если хочешь снизить углеводы.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 3 яиц с брокколи (250г) + Авокадо (60г) + Тост (40г)'],p:30,c:50,f:35,cal:650},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Апельсин (200г)'],p:38,c:35,f:10,cal:330},
        {name:'Обед',time:'',items:['Треска запеч. (180г) + Картофель (300г) + Капустный салат (400г)'],p:40,c:95,f:18,cal:780},
        {name:'Перекус',time:'',items:['Ряженка (300мл) + Чернослив (50г)'],p:10,c:50,f:8,cal:310},
        {name:'Ужин',time:'',items:['Курица-гриль (140г) + Булгур (80г сух.) + Овощи (300г)'],p:42,c:70,f:12,cal:610},
      ],total:{p:160,c:300,f:83,cal:2680},tip:'сократить картофель до 250г и чернослив до 35г, если хочешь снизить углеводы.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Пшённая каша (80г сух.) + 2 яйца + Семена подсолнечника (30г) + Малина (100г)'],p:28,c:110,f:28,cal:780},
        {name:'Перекус',time:'',items:['Смузи: Йогурт (300г) + Персик (200г) + Шпинат (50г)'],p:10,c:40,f:6,cal:260},
        {name:'Обед',time:'',items:['Котлеты из говядины (180г фарша) + Макароны (80г сух.) + Зелёная фасоль (350г)'],p:48,c:80,f:18,cal:740},
        {name:'Перекус',time:'',items:['Творог 5% (220г) + Голубика (150г)'],p:38,c:25,f:10,cal:320},
        {name:'Ужин',time:'',items:['Тофу запеч. (150г) + Чечевица (70г сух.) + Рагу из овощей (400г)'],p:45,c:80,f:20,cal:700},
      ],total:{p:169,c:335,f:82,cal:2800},tip:'уменьшить макароны до 70г и чечевицу до 60г, если хочешь снизить углеводы.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (250г) + Сметана 10% (40г) + Изюм (40г) + Тыквенные семечки (25г)'],p:45,c:60,f:22,cal:640},
        {name:'Перекус',time:'',items:['Хлебец (40г) + Авокадо (80г) + Слайсы индейки (60г)'],p:18,c:30,f:25,cal:420},
        {name:'Обед',time:'',items:['Куриное бедро без кожи (200г сыр.) + Перловка (80г сух.) + Салат (500г)'],p:48,c:70,f:30,cal:780},
        {name:'Перекус',time:'',items:['Творожный мусс: Творог (100г) + Кефир (100г) + Груша (150г)'],p:18,c:40,f:5,cal:270},
        {name:'Ужин',time:'',items:['Омлет из 3 яиц с грибами (200г) + Свёкла отварная (200г) + Льняное масло (5г)'],p:30,c:40,f:25,cal:520},
      ],total:{p:159,c:240,f:107,cal:2630},tip:'уменьшить авокадо до 50г и убрать масло в ужине, если хочешь снизить жиры.'},
      {n:7,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (80г сух.) + Тёртое яблоко (200г) + Арахисовая паста (20г) + Кешью (20г)'],p:25,c:120,f:25,cal:780},
        {name:'Перекус',time:'',items:['Творожная запеканка: Творог (150г) + 1 яйцо + Ягоды (100г)'],p:25,c:20,f:10,cal:280},
        {name:'Обед',time:'',items:['Говядина тушеная (160г сыр.) + Гречка (70г сух.) + Овощи (500г)'],p:48,c:70,f:22,cal:720},
        {name:'Перекус',time:'',items:['Кефир (300мл) + Мандарины (300г)'],p:11,c:45,f:8,cal:290},
        {name:'Ужин',time:'',items:['Креветки (220г очищ.) + Цукини-гриль (500г) + Урбеч (15г)'],p:45,c:40,f:15,cal:500},
      ],total:{p:154,c:295,f:80,cal:2570},tip:'заменить урбеч на лимонный сок, если нужно снизить жиры.'},
    ]
  },
  {
    id:'81_85',title:'Рацион 81–85 кг',subtitle:'7 дней · ~2900 ккал/день',icon:'plate',
    target:{cal:2900,p:164,c:246,f:82},
    days:[
      {n:1,meals:[
        {name:'Завтрак',time:'',items:['Овсянка (90г сух.) + Сывороточный протеин (30г) + Банан (180г) + Миндаль (40г)'],p:50,c:130,f:28,cal:950},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Яблоко (200г) + Льняные семена (10г)'],p:43,c:40,f:12,cal:430},
        {name:'Обед',time:'',items:['Куриная грудка (200г сыр.) + Гречка (100г сух.) + Овощной салат (500г) + Оливк. масло (10г)'],p:60,c:85,f:22,cal:850},
        {name:'Перекус',time:'',items:['Кефир 1% (400мл) + Малина (200г)'],p:14,c:30,f:8,cal:260},
        {name:'Ужин',time:'',items:['Лосось на гриле (180г) + Спаржа (400г) + Авокадо (60г)'],p:40,c:25,f:35,cal:600},
      ],total:{p:207,c:310,f:105,cal:3090},tip:'Можно уменьшить авокадо до 40г, если хочешь снизить жиры.'},
      {n:2,meals:[
        {name:'Завтрак',time:'',items:['Гречка (90г сух.) + Омлет из 4 яиц + Сыр (50г) + Помидор (250г)'],p:50,c:70,f:35,cal:820},
        {name:'Перекус',time:'',items:['Греческий йогурт (400г) + Груша (250г) + Отруби (25г)'],p:20,c:75,f:10,cal:480},
        {name:'Обед',time:'',items:['Индейка (200г сыр.) + Бурый рис (90г сух.) + Тушеные овощи (400г)'],p:52,c:85,f:15,cal:720},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Киви (200г)'],p:43,c:35,f:11,cal:390},
        {name:'Ужин',time:'',items:['Салат с тунцом: Тунец в с/с (180г) + Яйца (2 шт) + Авокадо (70г) + Овощи (400г)'],p:55,c:25,f:30,cal:600},
      ],total:{p:220,c:290,f:101,cal:3010},tip:'Можно убрать 1 яйцо и уменьшить авокадо до 50г, если хочешь снизить белок и жиры.'},
      {n:3,meals:[
        {name:'Завтрак',time:'',items:['Творожная запеканка (Творог 5% 300г + 2 яйца + Яблоко 150г) + Грецкие орехи (30г)'],p:60,c:60,f:30,cal:800},
        {name:'Перекус',time:'',items:['Цельнозерн. тосты (80г) + Сыр (60г) + Огурец (250г)'],p:25,c:60,f:20,cal:520},
        {name:'Обед',time:'',items:['Чечевичный суп (Чечевица 100г сух. + Говядина 120г + Овощи 300г) + Хлеб (50г)'],p:60,c:110,f:15,cal:850},
        {name:'Перекус',time:'',items:['Запеч. яблоко (300г) + Фисташки (40г)'],p:10,c:50,f:18,cal:420},
        {name:'Ужин',time:'',items:['Телятина запеч. (180г) + Киноа (90г сух.) + Салат (500г)'],p:55,c:85,f:22,cal:780},
      ],total:{p:210,c:365,f:105,cal:3370},tip:'Можно уменьшить хлеб до 30г и киноа до 75г, если хочешь снизить углеводы.'},
      {n:4,meals:[
        {name:'Завтрак',time:'',items:['Омлет из 4 яиц с брокколи (300г) + Авокадо (80г) + Тост (50г)'],p:40,c:60,f:40,cal:780},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Апельсин (250г)'],p:43,c:45,f:11,cal:430},
        {name:'Обед',time:'',items:['Треска запеч. (200г) + Картофель (350г) + Капустный салат (600г)'],p:45,c:110,f:20,cal:880},
        {name:'Перекус',time:'',items:['Ряженка (400мл) + Чернослив (60г)'],p:14,c:65,f:10,cal:410},
        {name:'Ужин',time:'',items:['Курица-гриль (160г) + Булгур (90г сух.) + Овощи (500г)'],p:48,c:80,f:14,cal:680},
      ],total:{p:190,c:360,f:95,cal:3180},tip:'Можно уменьшить картофель до 280г и чернослив до 40г, если хочешь снизить углеводы.'},
      {n:5,meals:[
        {name:'Завтрак',time:'',items:['Пшенная каша (90г сух.) + Яйца (3 шт) + Семена подсолнечника (40г) + Малина (150г)'],p:35,c:125,f:35,cal:950},
        {name:'Перекус',time:'',items:['Смузи: Йогурт (400г) + Персик (250г) + Шпинат (100г)'],p:15,c:55,f:8,cal:340},
        {name:'Обед',time:'',items:['Котлеты из говядины (200г фарша) + Макароны (90г сух.) + Зеленая фасоль (500г)'],p:55,c:90,f:20,cal:800},
        {name:'Перекус',time:'',items:['Творог 5% (250г) + Голубика (200г)'],p:43,c:35,f:11,cal:410},
        {name:'Ужин',time:'',items:['Тофу запеч. (180г) + Чечевица (90г сух.) + Рагу из овощей (600г)'],p:55,c:100,f:25,cal:850},
      ],total:{p:203,c:405,f:99,cal:3350},tip:'Можно уменьшить макароны до 75г и чечевицу до 70г, если хочешь снизить углеводы и белок.'},
      {n:6,meals:[
        {name:'Завтрак',time:'',items:['Творог 5% (300г) + Сметана 10% (50г) + Изюм (50г) + Тыкв. семечки (30г)'],p:55,c:70,f:25,cal:750},
        {name:'Перекус',time:'',items:['Хлебец (50г) + Авокадо (100г) + Индейка слайсы (80г)'],p:20,c:35,f:30,cal:500},
        {name:'Обед',time:'',items:['Куриное бедро без кожи (220г сыр.) + Перловка (90г сух.) + Салат (700г)'],p:55,c:80,f:35,cal:850},
        {name:'Перекус',time:'',items:['Творожный мусс: Творог (150г) + Кефир (150г) + Груша (200г)'],p:25,c:50,f:7,cal:350},
        {name:'Ужин',time:'',items:['Омлет из 4 яиц с грибами (300г) + Свекла отварная (300г) + Льняное масло (10г)'],p:40,c:60,f:35,cal:700},
      ],total:{p:195,c:295,f:132,cal:3150},tip:'Можно уменьшить авокадо до 60г и убрать масло, если хочешь снизить жиры.'},
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
const MEAL_ICONS={'Завтрак':'sunrise','Перекус':'food','Обед':'plate','Ужин':'moon'}

// ── Вкладка «Питание» ────────────────────────────────────────────────────────
// Главный экран вкладки — ДНЕВНИК ПИТАНИЯ. Раньше он лежал секцией внутри
// вкладки «Дневник», и человек, который хотел записать съеденное, шёл в
// «Питание», находил там готовые рационы и уходил ни с чем: сквозной прогон
// спотыкался ровно об это, и по коду видно, что иначе и быть не могло.
//
// Готовые рационы никуда не делись — они стали вторым разделом здесь же,
// переключателем сверху. Не отдельным экраном: лишний уровень вложенности
// вернул бы ту же проблему поиска, только на этаж ниже.
//
// FoodDiary и NutritionView переехали как есть, целиком, без правок логики.
function NutritionTab({ userId }){
  const [tab,setTab]=useState('diary')
  // Тот же вид, что у переключателей внутри самого дневника (tabBtn в
  // FoodDiary.jsx) — вкладка не должна выглядеть как чужой экран.
  // Активный раздел должен читаться как ВЫБРАННАЯ вкладка. Фон SURF совпадал
  // с фоном шапки, и активный пункт выглядел просто подписью, а неактивный —
  // единственной кнопкой; смысл переключателя читался наоборот.
  const btn=active=>({
    padding:'9px 14px', borderRadius:9, border:'none',
    background:active?PUR:SURF2, color:active?'#fff':TXT3,
    fontSize:13, fontWeight:active?700:600, cursor:'pointer', minHeight:'unset',
    whiteSpace:'nowrap',
  })
  // Переключатель уезжает ВНУТРЬ шапки дневника (проп headerLeft), а не стоит
  // отдельной строкой над ней: иначе получалось два яруса подряд —
  // переключатель, а под ним плашка с заголовком «Питание», дублирующим имя
  // вкладки. Теперь шапка одна: слева разделы, справа шестерёнка.
  const switcher = (
    <div style={{ display:'flex', gap:6 }}>
      <button data-testid="nutrition-tab-diary" onClick={()=>setTab('diary')} style={btn(tab==='diary')}>Дневник</button>
      <button data-testid="nutrition-tab-plans" onClick={()=>setTab('plans')} style={btn(tab==='plans')}>Рационы</button>
    </div>
  )
  return (
    <div>
      {/* Оба раздела ОСТАЮТСЯ СМОНТИРОВАННЫМИ. Дневник держит собственный стек
          экранов (foodNav.js: день → норма → сводка → день из календаря), и
          размонтирование сбрасывало бы его при каждом переключении — человек
          возвращался бы из «Рационов» не туда, где был. */}
      <div style={{ display: tab==='diary'?'block':'none' }}>
        <FoodDiary userId={userId} embedded headerLeft={switcher} />
      </div>
      {/* У «Рационов» своей шапки нет, поэтому переключатель рисуем над ними. */}
      <div style={{ display: tab==='plans'?'block':'none' }}>
        <div style={{ background:SURF, borderBottom:`1px solid ${HAIR}`, padding:'14px 16px' }}>{switcher}</div>
        <NutritionView userId={userId} />
      </div>
    </div>
  )
}

function NutritionView({ userId }){
  const [openPlan,setOpenPlan]=useState(null)
  const [openDay,setOpenDay]=useState(null)
  const [logDate,setLogDate]=useState(()=>{const t=new Date();return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`})
  const [logDone,setLogDone]=useState(false)
  const [showLogDatePicker,setShowLogDatePicker]=useState(false)
  const logCalInputRef=useRef(null)
  // Тост ошибки записи — тот же паттерн, что showFoodSaveError в DiaryView,
  // своя копия т.к. компонент отдельный.
  const [showLogSaveError,setShowLogSaveError]=useState(false)
  const flashLogSaveError=()=>{setShowLogSaveError(true);setTimeout(()=>setShowLogSaveError(false),3500)}

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
      const{error}=await supabase.from('food_diary').insert(newEntries.map(e=>({
        user_id:userId, date, name:e.name,
        kcal:+e.kcal||0, p:+e.p||0, c:+e.c||0, f:+e.f||0,
      })))
      if(error){console.error('Ошибка записи рациона в дневник:',error);flashLogSaveError();return}
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
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1001,display:'flex',flexDirection:'column' }}>
        {showLogSaveError&&(
          <div style={{
            position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
            zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
            background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
            boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
          }}>
            Не удалось сохранить — проверь связь и повтори
          </div>
        )}
        <div style={{ background:SURF,borderBottom:`1px solid ${HAIR}`,padding:'14px 18px',display:'flex',alignItems:'center',gap:14,flexShrink:0 }}>
          <button data-back="1" onClick={()=>setOpenDay(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:TXT3,lineHeight:1,padding:0,minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
          <div>
            <div style={{ fontSize:17,fontWeight:700,color:TXT }}>День {day.n} — {DAY_NAMES[openDay]}</div>
            <div style={{ fontSize:11,color:TXT3 }}>{plan.title}</div>
          </div>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 100px' }}>
          {/* Target macros */}
          <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14 }}>
            {[{l:'Калории',v:`${day.total.cal}`,u:'ккал',c:PUR},{l:'Белки',v:`${day.total.p}`,u:'г',c:TEA},{l:'Углеводы',v:`${day.total.c}`,u:'г',c:BLU},{l:'Жиры',v:`${day.total.f}`,u:'г',c:COR}].map(m=>(
              <div key={m.l} style={{ background:SURF,borderRadius:11,padding:'10px 8px',textAlign:'center',boxShadow:'0 1px 4px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize:15,fontWeight:700,color:m.c }}>{m.v}<span style={{ fontSize:10,fontWeight:400,color:TXT3 }}> {m.u}</span></div>
                <div style={{ fontSize:10,color:TXT3,marginTop:2 }}>{m.l}</div>
              </div>
            ))}
          </div>
          {/* Meals */}
          {day.meals.map((meal,mi)=>(
            <div key={mi} style={{ background:SURF,borderRadius:13,boxShadow:'0 1px 4px rgba(0,0,0,0.07)',marginBottom:10,overflow:'hidden' }}>
              <div style={{ background:`${TEA}12`,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:`1px solid ${HAIR}` }}>
                <div style={{ display:'flex',alignItems:'center',gap:7 }}>
                  <GlassIcon name={MEAL_ICONS[meal.name]||'plate'} size={34} />
                  <span style={{ fontSize:14,fontWeight:700,color:TXT }}>{meal.name}</span>
                  {meal.time&&<span style={{ fontSize:11,color:TXT3 }}>({meal.time})</span>}
                </div>
                <span style={{ fontSize:13,fontWeight:600,color:COR }}>{meal.cal} ккал</span>
              </div>
              <div style={{ padding:'10px 14px' }}>
                {meal.items.map((item,ii)=>(
                  <div key={ii} style={{ fontSize:13,color:TXT2,padding:'3px 0',borderBottom:ii<meal.items.length-1?'1px solid #f9fafb':'none' }}>{item}</div>
                ))}
                <div style={{ display:'flex',gap:12,marginTop:8,paddingTop:8,borderTop:`1px solid ${HAIR}` }}>
                  {[['Б',meal.p,TEA],['У',meal.c,BLU],['Ж',meal.f,COR]].map(([l,v,c])=>(
                    <span key={l} style={{ fontSize:11,color:c,fontWeight:600 }}>{l}: {v}г</span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {/* Tip */}
          {day.tip&&(
            <div style={{ background:`${PUR}12`,border:`1px solid ${PUR}30`,borderRadius:11,padding:'10px 14px',fontSize:12,color:TXT2,lineHeight:1.6 }}>
              <span style={{ fontWeight:700,color:PUR }}><GlassIcon name="bulb" size={16} style={{verticalAlign:"-3px",marginRight:4}} />Можно: </span>{day.tip}
            </div>
          )}
        </div>
        {/* ── Панель «Копировать рацион» */}
        <div style={{ background:SURF,borderTop:`1px solid ${HAIR}`,padding:'10px 16px 14px',flexShrink:0 }}>
          {showLogDatePicker?(()=>{
            const toISO=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
            const yd=new Date();yd.setDate(yd.getDate()-1);const yISO=toISO(yd)
            const td=new Date();const tISO=toISO(td)
            const tmr=new Date();tmr.setDate(tmr.getDate()+1);const tmrISO=toISO(tmr)
            return(
              <div>
                <div style={{ fontSize:12,color:TXT3,fontWeight:600,marginBottom:8,textAlign:'center' }}>Выбери дату:</div>
                <div style={{ display:'flex',gap:6,marginBottom:10 }}>
                  {[['Вчера',yISO],['Сегодня',tISO],['Завтра',tmrISO]].map(([lbl,iso])=>(
                    <button key={iso} onClick={()=>setLogDate(iso)}
                      style={{ flex:1,padding:'9px 4px',borderRadius:10,border:`1.5px solid ${logDate===iso?BLU:HAIR}`,background:logDate===iso?`${BLU}15`:SURF,color:logDate===iso?BLU:TXT3,fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>
                      {lbl}
                    </button>
                  ))}
                  <button onClick={()=>logCalInputRef.current?.showPicker?.()??logCalInputRef.current?.click()}
                    style={{ width:42,flexShrink:0,borderRadius:10,border:`1.5px solid ${HAIR}`,background:SURF,cursor:'pointer',fontSize:18,display:'flex',alignItems:'center',justifyContent:'center',minHeight:'unset' }}>
                    📅
                    <input ref={logCalInputRef} type="date" value={logDate} onChange={e=>setLogDate(e.target.value)}
                      style={{ position:'absolute',opacity:0,width:0,height:0,pointerEvents:'none' }} />
                  </button>
                </div>
                <div style={{ display:'flex',gap:8 }}>
                  <button data-testid="plan-apply-confirm" onClick={()=>applyToFoodDiary(day,logDate)}
                    style={{ flex:1,padding:'12px',borderRadius:12,border:'none',background:BLU,color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset',display:'flex',alignItems:'center',justifyContent:'center',gap:7 }}>
                    <GlassIcon name="copy" size={17} />Копировать
                  </button>
                  <button onClick={()=>setShowLogDatePicker(false)}
                    style={{ padding:'12px 16px',borderRadius:12,border:'none',background:SURF2,color:TXT3,fontSize:14,cursor:'pointer',minHeight:'unset' }}>
                    Отмена
                  </button>
                </div>
              </div>
            )
          })():(
            <button data-testid="plan-apply" onClick={()=>{if(logDone)return;const t=new Date();setLogDate(`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`);setShowLogDatePicker(true)}}
              style={{ width:'100%',padding:'13px',borderRadius:12,border:'none',
                background:logDone?TEA:BLU,color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset',
                display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'background 0.3s' }}>
              <GlassIcon name={logDone?'check':'copy'} size={18} />{logDone?'Рацион скопирован в дневник!':'Копировать рацион'}
            </button>
          )}
        </div>
      </div>
    , document.body)
  }

  if(openPlan!==null){
    const plan=NUTRITION_PLANS.find(p=>p.id===openPlan)
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1000,display:'flex',flexDirection:'column' }}>
        <div style={{ background:SURF,borderBottom:`1px solid ${HAIR}`,padding:'14px 18px',display:'flex',alignItems:'center',gap:14,flexShrink:0 }}>
          <button data-back="1" onClick={()=>setOpenPlan(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:TXT3,lineHeight:1,padding:0,minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
          <GlassIcon name={plan.icon} size={34} />
          <div>
            <div style={{ fontSize:17,fontWeight:700,color:TXT }}>{plan.title}</div>
            <div style={{ fontSize:11,color:TXT3 }}>Цель: {plan.target.p}г Б / {plan.target.c}г У / {plan.target.f}г Ж / ~{plan.target.cal} ккал</div>
          </div>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          {plan.days.map((day,di)=>(
            <div key={di} style={{ background:SURF,borderRadius:13,boxShadow:'0 1px 4px rgba(0,0,0,0.07)',marginBottom:10,display:'flex',alignItems:'center',gap:12,padding:'14px 16px',cursor:'pointer' }}
              onClick={()=>setOpenDay(di)}>
              <div style={{ flexShrink:0,width:46,height:46,borderRadius:12,background:TEA,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center' }}>
                <span style={{ fontSize:11,fontWeight:700,color:'#fff',lineHeight:1 }}>{DAY_NAMES[di]}</span>
                <span style={{ fontSize:16,fontWeight:800,color:'#fff',lineHeight:1.2 }}>{di+1}</span>
              </div>
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ fontSize:15,fontWeight:600,color:TXT }}>День {day.n}</div>
                <div style={{ fontSize:11,color:TXT3,marginTop:2 }}>
                  {day.meals.length} {plural(day.meals.length,'приём','приёма','приёмов')} · Итого: Б{day.total.p}г У{day.total.c}г Ж{day.total.f}г
                </div>
              </div>
              <div style={{ textAlign:'right',flexShrink:0 }}>
                <div style={{ fontSize:15,fontWeight:700,color:COR }}>{day.total.cal}</div>
                <div style={{ fontSize:10,color:TXT3 }}>ккал</div>
              </div>
              <span style={{ fontSize:20,color:TXT3 }}>›</span>
            </div>
          ))}
        </div>
      </div>
    , document.body)
  }

  return(
    <div>
      <h2 style={{ fontSize:20,fontWeight:500,color:TXT,margin:'0 0 14px' }}>Планы питания</h2>
      {NUTRITION_PLANS.map(plan=>(
        <Card key={plan.id} style={{ marginBottom:10,cursor:'pointer' }} onClick={()=>setOpenPlan(plan.id)}>
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center' }}>
            <div style={{ display:'flex',alignItems:'center',gap:12 }}>
              <GlassIcon name={plan.icon} size={40} />
              <div>
                <div style={{ fontSize:15,fontWeight:600,color:TXT }}>{plan.title}</div>
                <div style={{ fontSize:11,color:TXT3,marginTop:2 }}>{plan.subtitle}</div>
              </div>
            </div>
            <span style={{ fontSize:20,color:TXT3 }}>›</span>
          </div>
          <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginTop:12 }}>
            {[['fluent-emoji-flat:fire',`~${plan.target.cal}`,KCAL,'ккал/день'],['fluent-emoji-flat:cut-of-meat',`${plan.target.p}г`,TEA,'белков'],['fluent-emoji-flat:cooked-rice',`${plan.target.c}г`,BLU,'углеводов'],['fluent-emoji-flat:avocado',`${plan.target.f}г`,COR,'жиров']].map(([ic,v,c,l])=>(
              <div key={l} style={{ background:SURF2,borderRadius:9,padding:'8px 6px',textAlign:'center' }}>
                <div style={{ display:'flex',justifyContent:'center',marginBottom:2 }}><Ic name={ic} size={36} /></div>
                <div style={{ fontSize:13,fontWeight:700,color:c }}>{v}</div>
                <div style={{ fontSize:9,color:TXT3 }}>{l}</div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

const EQ_TIPS={
  'Штанга':'Контролируй траекторию, не бросай снаряд.',
  'Гантели':'Следи за симметрией движения обеих рук.',
  'Турник':'Тяни лопатки вниз перед началом движения.',
  'Блок':'Зафиксируй корпус, двигай только целевой сустав.',
  'Тренажёр':'Настрой сиденье под свой рост перед началом.',
  'Без оборудования':'Контролируй темп — не используй инерцию.',
  'Резина':'Держи резину в постоянном натяжении, не давай ей "отдыхать" в нижней точке.',
  'Гравитрон':'Настрой противовес под свой уровень — чем больше вес стека, тем больше помощь.',
  'Гиря':'Работай от бедра, держи спину нейтральной на протяжении всего движения.',
}

// Редактор шаблона программы (ТОЛЬКО тренер). Переиспользует вёрстку карточки
// упражнения из ProgramEditor (сетка КГ/ПОВТ, «+ Подход», «+ Упражнение», пикер,
// тоннаж). Формат подходов у шаблонов и программ клиента одинаков —
// parseTemplateSets и сериализация в строку те же. Календаря НЕТ: слоты
// нумерованные. Сохранение ЯВНОЕ (кнопка «Опубликовать»), автосейва нет.
function TemplateEditor({ templateKey, isNew=false, initialDisplayName='', initialContext='zal', initialSort=0, onClose, onPublished }){
  const { exercises: catalogExercises } = useContext(CatalogContext)
  const [loading,setLoading]=useState(!isNew)
  const [loadError,setLoadError]=useState(false)
  const [displayName,setDisplayName]=useState(initialDisplayName)
  const [context,setContext]=useState(initialContext==='dom'?'dom':'zal')
  const [sort,setSort]=useState(initialSort)
  // Слоты: [{exercises:[{name,sets:[{reps,kg}]}]}]. sets — разобранные подходы
  // (как в ProgramEditor), склеиваем в строку при публикации.
  const [slots,setSlots]=useState(isNew?[{exercises:[]}]:[])
  const [openSlot,setOpenSlot]=useState(isNew?0:null)
  const [pickerFor,setPickerFor]=useState(null)
  const [pickerQuery,setPickerQuery]=useState('')
  const [publishing,setPublishing]=useState(false)
  const [pubState,setPubState]=useState('idle')
  const [toast,setToast]=useState('')
  const flashErr=m=>{setToast(m);setTimeout(()=>setToast(''),3500)}
  const dirtyRef=useRef(false)
  const skipDirtyRef=useRef(true)

  useEffect(()=>{
    if(isNew){setLoading(false);return}
    let cancelled=false
    supabase.from('program_templates').select('display_name,context,sort,structure').eq('key',templateKey).maybeSingle().then(({data,error})=>{
      if(cancelled)return
      if(error){console.error('Шаблон: ошибка загрузки:',error);setLoadError(true);setLoading(false);return}
      skipDirtyRef.current=true
      setDisplayName(data?.display_name||'')
      setContext(data?.context==='dom'?'dom':'zal')
      if(typeof data?.sort==='number')setSort(data.sort)
      const raw=Array.isArray(data?.structure)?data.structure:[]
      setSlots(raw.map(slot=>({
        exercises:(Array.isArray(slot)?slot:[]).map(ex=>{
          const parsed=(ex.sets?parseTemplateSets(ex.sets):[]).map(ts=>({reps:String(ts.reps),kg:ts.templateKg!=null?String(ts.templateKg):''}))
          return {name:ex.name,sets:parsed.length?parsed:[{reps:'',kg:''}]}
        })
      })))
      setLoading(false)
    })
    return()=>{cancelled=true}
  },[])
  // «Есть несохранённые правки» — кроме прогона сразу после загрузки.
  useEffect(()=>{
    if(skipDirtyRef.current){skipDirtyRef.current=false;return}
    dirtyRef.current=true;setPubState('idle')
  },[displayName,context,slots])

  const addSlot=()=>setSlots(s=>{const n=[...s,{exercises:[]}];setOpenSlot(n.length-1);return n})
  const removeSlot=async si=>{
    if(!await askConfirm('Удалить тренировку из программы?'))return
    setSlots(s=>s.filter((_,i)=>i!==si))
    setOpenSlot(o=>o===si?null:(o!=null&&o>si?o-1:o))
  }
  const toggleSlot=si=>setOpenSlot(o=>o===si?null:si)
  const addExercise=(si,exName)=>{
    setSlots(s=>{
      let carried=null
      for(const sl of s)for(const ex of sl.exercises||[])if(ex.name===exName&&Array.isArray(ex.sets)&&ex.sets.some(x=>String(x.reps??'').trim()||String(x.kg??'').trim()))carried=ex.sets
      const sets=carried?carried.map(x=>({reps:x.reps,kg:x.kg})):[{reps:'',kg:''}]
      return s.map((sl,i)=>i===si?{...sl,exercises:[...(sl.exercises||[]),{name:exName,sets}]}:sl)
    })
    setPickerFor(null);setPickerQuery('')
  }
  const removeExercise=(si,ei)=>setSlots(s=>s.map((sl,i)=>i===si?{...sl,exercises:sl.exercises.filter((_,j)=>j!==ei)}:sl))
  const updateSets=(si,ei,fn)=>setSlots(s=>s.map((sl,i)=>i!==si?sl:{...sl,exercises:sl.exercises.map((ex,j)=>j!==ei?ex:{...ex,sets:fn(Array.isArray(ex.sets)?ex.sets:[])})}))
  const addSet=(si,ei)=>updateSets(si,ei,sets=>{const last=sets[sets.length-1];return[...sets,last?{...last}:{reps:'',kg:''}]})
  const removeSet=(si,ei,k)=>updateSets(si,ei,sets=>sets.length<=1?sets:sets.filter((_,x)=>x!==k))
  const setSetField=(si,ei,k,field,val)=>updateSets(si,ei,sets=>sets.map((s,x)=>x===k?{...s,[field]:val}:s))
  const setsTonnage=sets=>(Array.isArray(sets)?sets:[]).reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)
  const slotTonnage=sl=>(sl.exercises||[]).reduce((sum,ex)=>sum+setsTonnage(ex.sets),0)
  const authToken=async()=>{const{data}=await supabase.auth.getSession();return data?.session?.access_token||null}
  const serializeSets=sets=>(Array.isArray(sets)?sets:[])
    .filter(s=>String(s.reps??'').trim())
    .map(s=>{const reps=String(s.reps).trim();const kg=String(s.kg??'').trim();return kg?`${kg} кг × ${reps}`:reps})
    .join(', ')

  const publish=async()=>{
    if(publishing)return
    const structure=slots.map(sl=>(sl.exercises||[]).filter(ex=>ex.name).map((ex,i)=>({num:i+1,name:ex.name,sets:serializeSets(ex.sets)})))
    if(structure.length<1){flashErr('Нужна хотя бы одна тренировка');return}
    if(!await askConfirm('Программа изменится у всех клиентов, которые по ней тренируются. Опубликовать?'))return
    setPublishing(true);setPubState('saving')
    try{
      const token=await authToken()
      const res=await fetch('/api/set-exercise',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({action:'save_template',key:templateKey,display_name:displayName,context,sort,structure,hidden:false}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){flashErr(body?.error||'Не удалось опубликовать');setPubState('error');return}
      dirtyRef.current=false;setPubState('saved')
      onPublished?.(templateKey,structure)
    }catch(e){console.error('Публикация шаблона:',e);flashErr('Сбой сети, повтори');setPubState('error')}
    finally{setPublishing(false)}
  }
  const hideProgram=async()=>{
    if(publishing)return
    if(!await askConfirm('Скрыть программу из приложения? Клиенты, которые её выбрали, останутся на ней, но новым она не показывается.'))return
    setPublishing(true)
    try{
      const token=await authToken()
      const res=await fetch('/api/set-exercise',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({action:'delete_template',key:templateKey}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){flashErr(body?.error||'Не удалось скрыть');return}
      dirtyRef.current=false
      onPublished?.(templateKey,null,{hidden:true});onClose?.()
    }catch(e){console.error('Скрытие шаблона:',e);flashErr('Сбой сети, повтори')}
    finally{setPublishing(false)}
  }
  const tryClose=async()=>{
    if(dirtyRef.current&&!await askConfirm('Есть неопубликованные изменения. Уйти без сохранения?'))return
    onClose?.()
  }

  return createPortal(<>
    {toast&&(<div style={{ position:'fixed', top:14, left:'50%', transform:'translateX(-50%)', zIndex:2600, padding:'10px 18px', borderRadius:24, maxWidth:340, textAlign:'center', background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700, boxShadow:'0 6px 20px rgba(220,38,38,0.35)' }}>{toast}</div>)}
    <div style={{ position:'fixed', inset:0, background:SURF2, zIndex:2100, display:'flex', flexDirection:'column' }}>
      <div style={{ background:SURF, borderBottom:`1px solid ${HAIR}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
        <button data-back="1" onClick={tryClose} style={{ background:'none', border:'none', cursor:'pointer', color:TXT3, lineHeight:1, padding:0, minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
        <div style={{ fontSize:16, fontWeight:700, color:TXT }}>Редактор программы</div>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'14px 16px 24px' }}>
        {loading?(
          <div style={{ fontSize:13, color:TXT3, textAlign:'center', padding:'30px 0' }}>Загрузка…</div>
        ):loadError?(
          <div style={{ fontSize:13, color:'#ef4444', textAlign:'center', padding:'30px 0' }}>Не удалось загрузить программу</div>
        ):(<>
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Название программы</div>
            <input value={displayName} onChange={e=>setDisplayName(e.target.value)} maxLength={100} placeholder={templateKey}
              style={{ width:'100%', padding:'9px 12px', fontSize:14, fontWeight:600, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            <div style={{ fontSize:10, color:TXT3, marginTop:3 }}>Ключ «{templateKey}» не меняется — переименование только для экрана.</div>
          </div>
          <div style={{ display:'flex', gap:8, marginBottom:12 }}>
            {[['zal','Зал'],['dom','Дом']].map(([v,l])=>(
              <button key={v} onClick={()=>setContext(v)} style={{ flex:1, padding:'9px', fontSize:13, fontWeight:600, borderRadius:9, cursor:'pointer', border:`1px solid ${context===v?PUR:HAIR}`, background:context===v?'#EEEDFE':'transparent', color:context===v?'#3C3489':TXT3 }}>{l}</button>
            ))}
          </div>
          {!isNew&&(
            <button onClick={hideProgram} disabled={publishing} style={{ width:'100%', marginBottom:14, padding:'9px', fontSize:12, fontWeight:600, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:'#ef4444', cursor:publishing?'default':'pointer' }}>Скрыть программу</button>
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:12 }}>
            {slots.map((sl,si)=>(
              <Card key={si}>
                <div style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }} onClick={()=>toggleSlot(si)}>
                  <span style={{ transform:openSlot===si?'rotate(90deg)':'none', transition:'transform .15s', color:TXT3, fontSize:18, lineHeight:1 }}>›</span>
                  <span style={{ flex:1, fontSize:14, fontWeight:700, color:TXT }}>Тренировка {si+1}</span>
                  <span style={{ fontSize:12, color:TXT3 }}>{slotTonnage(sl)} кг</span>
                  <button onClick={e=>{e.stopPropagation();removeSlot(si)}} style={{ background:'none', border:'none', color:TXT3, cursor:'pointer', lineHeight:1, padding:4, flexShrink:0 }}><GlassIcon name="close" size={22} /></button>
                </div>
                {openSlot===si&&(<div style={{ marginTop:10 }}>
                  {(sl.exercises||[]).map((ex,ei)=>{
                    const sets=Array.isArray(ex.sets)?ex.sets:[]
                    return (
                      <div key={ei} style={{ marginBottom:14, background:SURF, borderRadius:20, padding:'12px 14px', border:`1px solid ${HAIR}` }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, gap:8 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, minWidth:0 }}>
                            <span style={{ width:30, height:30, borderRadius:10, background:`linear-gradient(135deg, ${PUR}, #5b56c9)`, color:'#fff', fontWeight:800, fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{ei+1}</span>
                            <div style={{ flex:1, minWidth:0 }}><div style={{ fontSize:16, fontWeight:700, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{labelOf(catalogExercises,ex.name)}</div></div>
                          </div>
                          <button onClick={()=>removeExercise(si,ei)} style={{ width:26, height:26, borderRadius:6, border:'none', background:SURF2, color:TXT3, cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>🗑</button>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 20px', gap:5, marginBottom:5 }}>
                          {['#','КГ','ПОВТ',''].map((h,i)=>(<span key={i} style={{ fontSize:11, fontWeight:700, color:TXT2, textAlign:'center', textTransform:'uppercase', letterSpacing:'.06em' }}>{h}</span>))}
                        </div>
                        {sets.map((s,k)=>(
                          <div key={k} style={{ display:'grid', gridTemplateColumns:'24px 1fr 1fr 20px', gap:5, alignItems:'center', marginBottom:5 }}>
                            <span style={{ fontSize:12, color:TXT3, textAlign:'center', fontWeight:700 }}>{k+1}</span>
                            <input value={s.kg} inputMode="decimal" onChange={e=>setSetField(si,ei,k,'kg',e.target.value)} placeholder="0" style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                            <input value={s.reps} inputMode="numeric" onChange={e=>setSetField(si,ei,k,'reps',e.target.value)} placeholder="0" style={{ background:SURF2, border:`1.5px solid ${HAIR}`, borderRadius:12, padding:'6px 6px', fontSize:17, fontWeight:700, fontVariantNumeric:'tabular-nums', color:TXT, textAlign:'center', width:'100%', boxSizing:'border-box' }} />
                            {sets.length>1?(<button onClick={()=>removeSet(si,ei,k)} style={{ background:'none', border:'none', color:TXT3, cursor:'pointer', fontSize:14, textAlign:'center' }}><GlassIcon name="close" size={26} /></button>):<span />}
                          </div>
                        ))}
                        <button onClick={()=>addSet(si,ei)} style={{ fontSize:12, color:PUR, background:'none', border:'none', cursor:'pointer', fontWeight:600, padding:0, marginTop:6 }}>+ Добавить подход</button>
                        <div style={{ fontSize:16, fontWeight:700, color:PUR, marginTop:8 }}>Тоннаж: {setsTonnage(ex.sets)} кг</div>
                      </div>
                    )
                  })}
                  <button onClick={()=>{setPickerFor(si);setPickerQuery('')}} style={{ width:'100%', padding:'8px', fontSize:12, color:PUR, background:`${PUR}10`, border:`1px dashed ${PUR}55`, borderRadius:8, cursor:'pointer', fontWeight:600 }}>+ Упражнение</button>
                </div>)}
              </Card>
            ))}
          </div>
          <button onClick={addSlot} style={{ width:'100%', padding:'11px', fontSize:13, borderRadius:9, border:'1.5px dashed #d1d5db', background:'none', color:TXT3, cursor:'pointer', fontWeight:600 }}>+ Тренировка</button>
        </>)}
      </div>
      {!loading&&!loadError&&(
        <div style={{ flexShrink:0, borderTop:`1px solid ${HAIR}`, background:SURF, padding:'12px 16px', display:'flex', flexDirection:'column', gap:6 }}>
          {pubState==='saved'&&<div style={{ fontSize:11, color:'#085041', textAlign:'center' }}>Опубликовано ✓</div>}
          <button onClick={publish} disabled={publishing} style={{ width:'100%', padding:'13px', fontSize:14, borderRadius:14, border:'none', background:publishing?SURF2:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontWeight:800, cursor:publishing?'default':'pointer' }}>{publishing?'Публикуем…':'Опубликовать изменения'}</button>
        </div>
      )}
      {pickerFor!=null&&(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={()=>setPickerFor(null)}>
          <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:400, maxHeight:'75vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }} onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Выбери упражнение</span>
              <button onClick={()=>setPickerFor(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <input value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)} placeholder="Поиск..." autoFocus style={{ width:'100%', marginBottom:12, padding:'9px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }} onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:2 }}>
              {catalogExercises.filter(e=>(e.label||e.n).toLowerCase().includes(pickerQuery.toLowerCase())||e.n.toLowerCase().includes(pickerQuery.toLowerCase())).map(e=>(
                <button key={e.n} onClick={()=>addExercise(pickerFor,e.n)} style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', width:'100%', padding:'9px 10px', border:'none', background:'transparent', cursor:'pointer', textAlign:'left', borderRadius:8 }}>
                  <span style={{ fontSize:13, color:TXT }}>{e.label||e.n}</span>
                  <span style={{ fontSize:11, color:TXT3 }}>{e.m}{e.eq?` · ${e.eq}`:''}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  </>, document.body)
}

// Пикер видео упражнения (ТОЛЬКО тренер): загрузка своего файла с устройства
// (сервер сожмёт), выбор готового ролика из общего пула, снятие видео. Вынесен
// из LibraryView, чтобы тем же пикером пользоваться и в шаблонах, и в активной
// тренировке. Модалка-оверлей: открывается для одного упражнения, закрывается
// через onClose. Логика перенесена как есть, поведение не менялось.
function VideoPicker({ exerciseName, exerciseVideos = {}, setExerciseVideos, onClose }) {
  const [pool,setPool]=useState(null)             // null = ещё не грузили
  const [poolLoading,setPoolLoading]=useState(false)
  const [poolQuery,setPoolQuery]=useState('')
  const [busy,setBusy]=useState(false)
  const [uploading,setUploading]=useState(false)  // фаза sign→upload→enqueue
  const [uploadMsg,setUploadMsg]=useState('')
  const [videoToast,setVideoToast]=useState('')
  const flashVideoErr=msg=>{setVideoToast(msg);setTimeout(()=>setVideoToast(''),3500)}
  const fileInputRef=useRef(null)
  // Контекст, к которому применяются назначение/снятие/загрузка: общий/зал/дом.
  const [ctx,setCtx]=useState('default')
  const [showAllPool,setShowAllPool]=useState(false) // снять фильтр пула по контексту

  // Пул грузим один раз при открытии пикера.
  useEffect(()=>{
    let cancelled=false
    setPoolLoading(true)
    supabase.from('video_pool').select('key,title,folder,video_url,poster_url').then(({data,error})=>{
      if(cancelled)return
      setPoolLoading(false)
      if(error){console.error('Пул видео: ошибка загрузки:',error);flashVideoErr('Не удалось загрузить пул видео');return}
      setPool(data||[])
    })
    return()=>{cancelled=true}
  },[])

  const authToken=async()=>{
    const{data}=await supabase.auth.getSession()
    return data?.session?.access_token||null
  }
  const assignVideo=async clip=>{
    if(busy)return
    setBusy(true)
    try{
      const token=await authToken()
      const res=await fetch('/api/set-exercise',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({name:exerciseName,action:'assign_video',context:ctx,video_url:clip.video_url,poster_url:clip.poster_url}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){flashVideoErr(body?.error||'Не удалось назначить видео');return}
      // Обновляем ТОЛЬКО выбранный контекст, остальные не трогаем (иначе назначение
      // зального ролика снесло бы домашний в локальном состоянии). Пикер не
      // закрываем — тренер может тут же переключить контекст и назначить второй.
      setExerciseVideos?.(m=>({...m,[exerciseName]:{...(m[exerciseName]||{}),[ctx]:{video_url:clip.video_url,poster_url:clip.poster_url}}}))
    }catch(e){console.error('Назначение видео:',e);flashVideoErr('Сбой сети, повтори')}
    finally{setBusy(false)}
  }
  const clearVideo=async()=>{
    if(busy)return
    setBusy(true)
    try{
      const token=await authToken()
      const res=await fetch('/api/set-exercise',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({name:exerciseName,action:'clear_video',context:ctx}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){flashVideoErr(body?.error||'Не удалось убрать видео');return}
      // Удаляем только выбранный контекст; если у имени не осталось контекстов — убираем имя.
      setExerciseVideos?.(m=>{
        const cur={...(m[exerciseName]||{})}; delete cur[ctx]
        const n={...m}
        if(Object.keys(cur).length) n[exerciseName]=cur; else delete n[exerciseName]
        return n
      })
    }catch(e){console.error('Снятие видео:',e);flashVideoErr('Сбой сети, повтори')}
    finally{setBusy(false)}
  }
  // Мягкий опрос exercise_videos: сервер сожмёт и обновит запись за ~минуту.
  const pollForVideo=(pollCtx,prevUrl,tries=0)=>{
    supabase.from('exercise_videos').select('video_url,poster_url').eq('exercise_name',exerciseName).eq('context',pollCtx).maybeSingle().then(({data})=>{
      if(data?.video_url&&data.video_url!==prevUrl){
        setExerciseVideos?.(m=>({...m,[exerciseName]:{...(m[exerciseName]||{}),[pollCtx]:{video_url:data.video_url,poster_url:data.poster_url}}}))
        setUploadMsg('Готово ✓')
        return
      }
      if(tries<15) setTimeout(()=>pollForVideo(pollCtx,prevUrl,tries+1),8000)
      else setUploadMsg('Видео загружено, обрабатывается — обновится автоматически чуть позже')
    })
  }
  const uploadFromDevice=async file=>{
    if(!file||uploading||busy)return
    // Проверки до подписи, чтобы гигантский/неподходящий файл не начинал заливаться.
    if(!(file.type||'').startsWith('video/')){flashVideoErr('Нужен видеофайл');return}
    if(file.size>300*1024*1024){flashVideoErr('Файл больше 300 МБ — сожми или сними короче');return}
    setUploading(true);setUploadMsg('Загрузка…')
    const uploadCtx=ctx // фиксируем контекст на момент старта загрузки
    const prevUrl=exerciseVideos[exerciseName]?.[uploadCtx]?.video_url||null
    try{
      const token=await authToken()
      // a) подписанный URL в raw-videos
      const signRes=await fetch('/api/create-video-upload',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({action:'sign',exercise_name:exerciseName}),
      })
      const sign=await signRes.json().catch(()=>null)
      if(!signRes.ok||!sign?.path){flashVideoErr(sign?.error||'Не удалось подготовить загрузку');return}
      // b) заливаем файл в сырьё по подписи
      const{error:upErr}=await supabase.storage.from('raw-videos').uploadToSignedUrl(sign.path,sign.token,file)
      if(upErr){console.error('Загрузка сырья:',upErr);flashVideoErr('Не удалось загрузить файл');return}
      // c) ставим задачу на сжатие
      const enqRes=await fetch('/api/create-video-upload',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({action:'enqueue',exercise_name:exerciseName,raw_key:sign.raw_key,context:uploadCtx}),
      })
      const enq=await enqRes.json().catch(()=>null)
      if(!enqRes.ok||!enq?.ok){flashVideoErr(enq?.error||'Не удалось поставить задачу');return}
      // d/e) сообщение + опрос
      setUploadMsg('Видео загружено, обрабатывается — появится через минуту')
      setTimeout(()=>pollForVideo(uploadCtx,prevUrl,0),8000)
    }catch(e){console.error('Загрузка с устройства:',e);flashVideoErr('Сбой сети, повтори')}
    finally{setUploading(false)}
  }

  // Фильтр пула по контексту: «Зал» → folder='zal', «Дом» → 'dom', «Общее» →
  // все. Галочка «показать все» снимает фильтр для любого контекста.
  const poolFiltered=(pool||[]).filter(c=>{
    if(!c.title.toLowerCase().includes(poolQuery.toLowerCase())) return false
    if(showAllPool||ctx==='default') return true
    return c.folder===ctx
  })
  const entry=exerciseVideos[exerciseName]||{} // { default?, zal?, dom? }
  const hasVideo=!!entry[ctx]                   // есть ли ролик у ВЫБРАННОГО контекста
  const CTX_TABS=[['default','Общее'],['zal','Зал'],['dom','Дом']]

  return createPortal(<>
    {videoToast&&(
      <div style={{ position:'fixed', top:14, left:'50%', transform:'translateX(-50%)', zIndex:2500, padding:'10px 18px', borderRadius:24, maxWidth:340, textAlign:'center', background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700, boxShadow:'0 6px 20px rgba(220,38,38,0.35)' }}>{videoToast}</div>
    )}
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={onClose}>
      <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:440, maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Видео для «{exerciseName}»</span>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
        </div>
        {/* Контекст: назначение/снятие/загрузка идут в выбранный. Точка — у того,
            для кого ролик уже назначен. */}
        <div style={{ display:'flex', gap:6, marginBottom:12 }}>
          {CTX_TABS.map(([v,l])=>(
            <button key={v} onClick={()=>setCtx(v)}
              style={{ flex:1, position:'relative', padding:'8px', fontSize:13, fontWeight:600, borderRadius:9, cursor:'pointer', border:`1px solid ${ctx===v?PUR:HAIR}`, background:ctx===v?'#EEEDFE':'transparent', color:ctx===v?'#3C3489':TXT3 }}>
              {l}
              {entry[v]&&<span style={{ position:'absolute', top:5, right:7, width:6, height:6, borderRadius:'50%', background:TEA }} />}
            </button>
          ))}
        </div>
        {/* Свой файл или готовый ролик из пула — как в старом редакторе Библиотеки. */}
        <input ref={fileInputRef} type="file" accept="video/*" style={{ display:'none' }}
          onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)uploadFromDevice(f)}} />
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
          <button onClick={()=>fileInputRef.current?.click()} disabled={uploading||busy}
            style={{ flex:'1 1 100%', padding:'11px', fontSize:13, fontWeight:700, borderRadius:9, border:'none', background:(uploading||busy)?SURF2:PUR, color:'#fff', cursor:(uploading||busy)?'default':'pointer' }}>
            {uploading?'Загрузка…':'📤 Загрузить с устройства'}
          </button>
          {hasVideo&&(
            <button onClick={clearVideo} disabled={busy||uploading}
              style={{ flex:1, padding:'10px 14px', fontSize:13, fontWeight:600, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:'#ef4444', cursor:(busy||uploading)?'default':'pointer' }}>
              Убрать видео
            </button>
          )}
        </div>
        {uploadMsg&&<div style={{ fontSize:12, color:uploadMsg.startsWith('Готово')?TEA:TXT3, marginBottom:10 }}>{uploadMsg}</div>}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6, gap:8 }}>
          <span style={{ fontSize:12, color:TXT3 }}>Или выбери ролик из пула:</span>
          {ctx!=='default'&&(
            <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:TXT3, cursor:'pointer', flexShrink:0 }}>
              <input type="checkbox" checked={showAllPool} onChange={e=>setShowAllPool(e.target.checked)} />
              показать все
            </label>
          )}
        </div>
        <input value={poolQuery} onChange={e=>setPoolQuery(e.target.value)} placeholder="Поиск ролика..."
          style={{ width:'100%', marginBottom:12, padding:'9px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
          onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
        <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:8 }}>
          {poolLoading?(
            <div style={{ fontSize:13, color:TXT3, padding:'10px 0', textAlign:'center' }}>Загрузка...</div>
          ):poolFiltered.length===0?(
            <div style={{ fontSize:13, color:TXT3, padding:'10px 0', textAlign:'center' }}>Ничего не найдено</div>
          ):poolFiltered.map(c=>(
            <button key={c.key} disabled={busy} onClick={()=>assignVideo(c)}
              style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:8, border:`1px solid ${HAIR}`, borderRadius:10, background:SURF2, cursor:busy?'default':'pointer', textAlign:'left' }}>
              <div style={{ position:'relative', flexShrink:0, width:72, height:44, borderRadius:7, overflow:'hidden', background:'#000' }}>
                <img src={c.poster_url} alt="" loading="lazy" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.title}</div>
                <div style={{ fontSize:11, color:TXT3, marginTop:2 }}>{c.folder==='zal'?'Зал':'Дом'}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  </>, document.body)
}

// workoutHistory — пропом из App по той же причине, что и в Dashboard выше:
// рекорды по упражнениям считались из localStorage-кэша и не обновлялись после
// того, как App догружал историю из Supabase.
function LibraryView({ customExercises, exerciseVideos = {}, userRole = 'client', setExerciseVideos, workoutHistory = [] }) {
  const { exercises: catalogExercises, reloadCatalog } = useContext(CatalogContext)
  const [filt,setFilt]=useState('Все')
  const [sel,setSel]=useState(null)
  const [query,setQuery]=useState('')
  // Свой попап плеера (тот же вид, что в WorkoutsView — компонент отдельный).
  const [playVideo,setPlayVideo]=useState(null)
  const isTrainer=userRole==='trainer'
  // Редактор видео (только тренер): открывает вынесенный VideoPicker.
  const [videoPickerFor,setVideoPickerFor]=useState(null) // имя упражнения или null
  const [videoToast,setVideoToast]=useState('')
  const flashVideoErr=msg=>{setVideoToast(msg);setTimeout(()=>setVideoToast(''),3500)}
  const [busy,setBusy]=useState(false)
  // Редактор блока «Техника» (только тренер).
  const [techEdit,setTechEdit]=useState(false)
  const [techDraft,setTechDraft]=useState('')
  const [techSaving,setTechSaving]=useState(false)
  // Смена выбранного упражнения выходит из режима правки — чтобы черновик не
  // «перетёк» на другое упражнение.
  useEffect(()=>{setTechEdit(false)},[sel?.n])

  const authToken=async()=>{
    const{data}=await supabase.auth.getSession()
    return data?.session?.access_token||null
  }
  // Сохранение текста «Техника» текущего упражнения (только тренер).
  const saveTechnique=async()=>{
    if(techSaving||!sel)return
    setTechSaving(true)
    try{
      const token=await authToken()
      const res=await fetch('/api/set-exercise',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({name:sel.n,action:'save_technique',technique:techDraft}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){flashVideoErr(body?.error||'Не удалось сохранить технику');return}
      // Оптимистично обновляем открытую карточку (sel — снимок, reloadCatalog
      // обновит глобальный список, но не этот объект) + перечитываем каталог.
      setSel(s=>s?{...s,technique:(techDraft||'').trim()}:s)
      reloadCatalog?.()
      setTechEdit(false)
    }catch(e){console.error('Техника:',e);flashVideoErr('Сбой сети, повтори')}
    finally{setTechSaving(false)}
  }

  // ── Редактор каталога упражнений (только тренер) ──────────────────────────
  const [exForm,setExForm]=useState(null)   // null | {mode:'add'|'edit', name, m, eq, type}
  const [showHidden,setShowHidden]=useState(false)
  const [hiddenRows,setHiddenRows]=useState(null) // скрытые из catalog_exercises
  const [hiddenLoading,setHiddenLoading]=useState(false)

  const postExercise=async payload=>{
    // Общий вызов эндпоинта. Возвращает true при успехе. При успехе списки
    // обновляем через reloadCatalog (каталог глобальный, перечитываем с сервера).
    if(busy)return false
    setBusy(true)
    try{
      const token=await authToken()
      const res=await fetch('/api/set-exercise',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify(payload),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){flashVideoErr(body?.error||'Не удалось сохранить');return false}
      reloadCatalog?.()
      return true
    }catch(e){console.error('Каталог: ошибка запроса:',e);flashVideoErr('Сбой сети, повтори');return false}
    finally{setBusy(false)}
  }
  const openAddForm=()=>setExForm({mode:'add',name:'',m:'',eq:'',type:'compound'})
  // display — черновик отображаемого имени (при edit). Пусто, если display_name
  // не задан (тогда показываем ключ). name всегда остаётся ключом.
  const openEditForm=ex=>setExForm({mode:'edit',name:ex.n,display:(ex.label&&ex.label!==ex.n)?ex.label:'',m:ex.m||'',eq:ex.eq||'',type:ex.type||'compound'})
  const saveExForm=async()=>{
    const name=(exForm.name||'').trim()
    if(!name)return
    // name — ключ (при edit не меняется). display_name — отображаемое имя: при add
    // его нет (имя = ключ, покажем name), при edit берём из поля (пустое → null).
    const displayName=exForm.mode==='edit'?(exForm.display||'').trim():''
    const ok=await postExercise({name,action:'save',display_name:displayName,muscle_group:exForm.m.trim()||null,equipment:exForm.eq.trim()||null,type:exForm.type})
    if(ok)setExForm(null)
  }
  // «Убрать из каталога». Зашитые (есть в EX_BY_NAME) прятать нельзя удалением —
  // ставим hidden:true. Чисто добавленные (нет в зашитом) удаляем полностью.
  const hideExercise=async name=>{
    if(EX_BY_NAME.has(name)) await postExercise({name,action:'save',hidden:true})
    else await postExercise({name,action:'delete'})
    setHiddenRows(null) // список скрытых устарел — перечитать при след. открытии
    if(sel?.n===name)setSel(null)
  }
  const returnExercise=async name=>{
    const ok=await postExercise({name,action:'save',hidden:false})
    if(ok)setHiddenRows(rows=>(rows||[]).filter(r=>r.name!==name))
  }
  const toggleHidden=async()=>{
    const next=!showHidden
    setShowHidden(next)
    if(next&&hiddenRows===null){
      setHiddenLoading(true)
      const{data,error}=await supabase.from('catalog_exercises').select('name,muscle_group,equipment,type').eq('hidden',true)
      setHiddenLoading(false)
      if(error){console.error('Скрытые: ошибка загрузки:',error);flashVideoErr('Не удалось загрузить скрытые');return}
      setHiddenRows(data||[])
    }
  }

  const all=[...catalogExercises,...(customExercises||[])]
  const muscles=['Все',...new Set(all.map(e=>e.m))]
  // Группы для карточек-хабов: без «Все» и с числом упражнений в каждой.
  const groupCards=muscles.filter(m=>m!=='Все').map(m=>({ m, count:all.filter(e=>e.m===m).length }))
  // Хаб показываем, только когда человек ничего не ищет и не выбрал группу.
  // Начал печатать — сразу плоский список по всему каталогу: искать внутри
  // одной группы, не зная, в какой лежит упражнение, бессмысленно.
  const showGroupHub = filt==='Все' && !query.trim()
  const fl=all.filter(e=>(filt==='Все'||e.m===filt)&&((e.label||e.n).toLowerCase().includes(query.toLowerCase())||e.n.toLowerCase().includes(query.toLowerCase())))

  const history=workoutHistory

  // Тот же попап плеера, что в WorkoutsView. Один элемент на оба возврата.
  const videoPopup = playVideo&&(
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.92)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={()=>setPlayVideo(null)}>
      <div style={{ position:'relative', maxWidth:860, width:'95%' }} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>setPlayVideo(null)}
          style={{ position:'absolute', top:-42, right:0, background:'none', border:'none', color:'#fff', fontSize:26, cursor:'pointer', minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
        <div style={{ fontSize:13, color:TXT3, marginBottom:8 }}>{playVideo.name}</div>
        <video src={playVideo.url} controls autoPlay style={{ width:'100%', borderRadius:12, maxHeight:'75vh' }} />
      </div>
    </div>
  )

  // Тост ошибки редактора видео (тот же паттерн, что showFoodSaveError).
  const videoErrToast = videoToast&&(
    <div style={{ position:'fixed', top:14, left:'50%', transform:'translateX(-50%)', zIndex:2400, padding:'10px 18px', borderRadius:24, maxWidth:340, textAlign:'center', background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700, boxShadow:'0 6px 20px rgba(220,38,38,0.35)' }}>
      {videoToast}
    </div>
  )

  // Форма добавления/изменения упражнения каталога (только тренер).
  const exFormModal = exForm&&(
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={()=>setExForm(null)}>
      <div style={{ background:SURF, borderRadius:16, padding:'22px 20px', width:'100%', maxWidth:400, boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <span style={{ fontSize:16, fontWeight:700, color:TXT }}>{exForm.mode==='add'?'Новое упражнение':'Изменить упражнение'}</span>
          <button onClick={()=>setExForm(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div>
            <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Название *</div>
            <input value={exForm.mode==='edit'?exForm.display:exForm.name}
              onChange={e=>setExForm(f=>f.mode==='edit'?{...f,display:e.target.value}:{...f,name:e.target.value})} maxLength={100}
              placeholder={exForm.mode==='edit'?exForm.name:'Напр. Жим гантелей сидя'} autoFocus={exForm.mode==='add'}
              style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT, background:SURF }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            {exForm.mode==='edit'&&<div style={{ fontSize:10, color:TXT3, marginTop:3 }}>Так упражнение называется на экране. История тренировок и видео останутся привязанными.</div>}
          </div>
          <div>
            <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Группа мышц</div>
            <input value={exForm.m} onChange={e=>setExForm(f=>({...f,m:e.target.value}))} maxLength={50} placeholder="Напр. Плечи"
              style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
          </div>
          <div>
            <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Снаряд</div>
            <input value={exForm.eq} onChange={e=>setExForm(f=>({...f,eq:e.target.value}))} maxLength={50} placeholder="Напр. Гантели"
              style={{ width:'100%', padding:'10px 12px', fontSize:13, borderRadius:9, border:`1.5px solid ${HAIR}`, boxSizing:'border-box', outline:'none', color:TXT }}
              onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
          </div>
          <div>
            <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Тип</div>
            <div style={{ display:'flex', gap:8 }}>
              {[['compound','Базовое'],['isolation','Изолирующее']].map(([v,l])=>(
                <button key={v} onClick={()=>setExForm(f=>({...f,type:v}))}
                  style={{ flex:1, padding:'9px', fontSize:13, fontWeight:600, borderRadius:9, cursor:'pointer', border:`1px solid ${exForm.type===v?PUR:HAIR}`, background:exForm.type===v?'#EEEDFE':'transparent', color:exForm.type===v?'#3C3489':TXT3 }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display:'flex', gap:8, marginTop:4 }}>
            <button onClick={()=>setExForm(null)} style={{ flex:1, padding:'11px', fontSize:13, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:TXT3, cursor:'pointer' }}>Отмена</button>
            <button onClick={saveExForm} disabled={busy||!exForm.name.trim()}
              style={{ flex:1, padding:'12px', fontSize:14, borderRadius:14, border:'none', background:(busy||!exForm.name.trim())?SURF2:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontWeight:800, cursor:(busy||!exForm.name.trim())?'default':'pointer' }}>Сохранить</button>
          </div>
        </div>
      </div>
    </div>
  )
  const trainerOverlays = <>{videoErrToast}{exFormModal}{videoPickerFor&&<VideoPicker exerciseName={videoPickerFor} exerciseVideos={exerciseVideos} setExerciseVideos={setExerciseVideos} onClose={()=>setVideoPickerFor(null)} />}</>

  if(sel){
    const records=history.flatMap(w=>{
      const found=(w.exercises||[]).find(ex=>ex.n===sel.n)
      if(!found)return[]
      const ton=(found.sets||[]).reduce((s,st)=>s+(parseFloat(st.kg)||0)*(parseInt(st.reps)||0),0)
      const maxKg=Math.max(0,...(found.sets||[]).map(s=>parseFloat(s.kg)||0))
      return[{date:w.date,workoutName:w.name,sets:found.sets||[],ton,maxKg}]
    }).sort((a,b)=>new Date(a.date)-new Date(b.date))
    const tip=(sel.technique||'').trim()||EQ_TIPS[sel.eq]||'Выполняй упражнение в полной амплитуде.'
    const best=records.length?Math.max(...records.map(r=>r.maxKg)):0
    return(
      <div>
        <button data-back="1" onClick={()=>setSel(null)} style={{ fontSize:13,color:TXT3,border:'none',background:'none',cursor:'pointer',padding:0,marginBottom:18,display:'flex',alignItems:'center',gap:5 }}><GlassIcon name="back" size={16} />Все упражнения</button>
        <div style={{ display:'flex',alignItems:'center',gap:12,marginBottom:20 }}>
          <div style={{ width:56,height:56,borderRadius:16,background:'rgba(124,122,240,.14)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
            <GlassIcon name="dumbbell" size={38} />
          </div>
          <div>
            <h2 style={{ fontSize:20,fontWeight:700,color:TXT,margin:0 }}>{sel.label||sel.n}</h2>
            <div style={{ fontSize:12,color:TXT3,marginTop:3 }}>{sel.m}{sel.eq?` · ${sel.eq}`:''}{sel.custom&&<span style={{ marginLeft:6,fontSize:10,padding:'1px 6px',borderRadius:4,background:'#EEEDFE',color:PUR }}>моё</span>}</div>
          </div>
        </div>
        {pickVideo(exerciseVideos,sel.n,null)&&(
          <button onClick={()=>setPlayVideo({url:pickVideo(exerciseVideos,sel.n,null).video_url,name:sel.label||sel.n})}
            style={{ position:'relative', display:'block', width:'100%', border:'none', padding:0, borderRadius:14, overflow:'hidden', cursor:'pointer', background:SURF2, marginBottom:12 }}>
            <img src={pickVideo(exerciseVideos,sel.n,null).poster_url} alt={sel.n} loading="lazy"
              style={{ width:'100%', display:'block', aspectRatio:'16/9', objectFit:'cover' }} />
            <span style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <span style={{ width:54, height:54, borderRadius:'50%', background:'rgba(0,0,0,0.55)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>▶</span>
            </span>
          </button>
        )}
        {/* Управление видео — только тренеру, через вынесенный VideoPicker
            (загрузка файла / выбор из пула / снятие). Клиент видит лишь постер+плей. */}
        {isTrainer&&(
          <button onClick={()=>setVideoPickerFor(sel.n)}
            style={{ width:'100%', marginBottom:12, padding:'11px', fontSize:13, fontWeight:600, borderRadius:9, border:`1px solid ${PUR}`, background:'none', color:PUR, cursor:'pointer' }}>
            {pickVideo(exerciseVideos,sel.n,null)?'Изменить видео':'Добавить видео'}
          </button>
        )}
        {/* Управление записью каталога — только тренеру. «Убрать из каталога»
            прячет упражнение (зашитое — hidden, добавленное — удаляет). */}
        {isTrainer&&(
          <div style={{ display:'flex', gap:8, marginBottom:12 }}>
            <button onClick={()=>openEditForm(sel)}
              style={{ flex:1, padding:'10px', fontSize:13, fontWeight:600, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:TXT, cursor:'pointer' }}>
              Изменить
            </button>
            <button onClick={async()=>{if(await askConfirm('Упражнение исчезнет из библиотеки и из всех списков выбора. Записи в дневнике клиентов останутся. Удалить?'))hideExercise(sel.n)}} disabled={busy}
              style={{ flex:1, padding:'10px', fontSize:13, fontWeight:600, borderRadius:9, border:`1px solid ${HAIR}`, background:'none', color:'#ef4444', cursor:busy?'default':'pointer' }}>
              Удалить из приложения
            </button>
          </div>
        )}
        <Card style={{ marginBottom:12,border:`1.5px solid ${PUR}22` }}>
          <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6 }}>
            <div style={{ fontSize:11,fontWeight:700,color:PUR,textTransform:'uppercase',letterSpacing:'0.5px' }}><GlassIcon name="bulb" size={14} style={{verticalAlign:"-2px",marginRight:4}} />Техника</div>
            {/* Правка — только тренеру; клиент кнопку не видит вообще. */}
            {isTrainer&&!techEdit&&(
              <button onClick={()=>{setTechDraft((sel.technique||'').trim());setTechEdit(true)}}
                style={{ fontSize:11,fontWeight:600,color:PUR,background:'none',border:'none',cursor:'pointer',padding:0,minHeight:'unset' }}>Изменить</button>
            )}
          </div>
          {techEdit?(
            <>
              <textarea value={techDraft} onChange={e=>setTechDraft(e.target.value)} rows={6} maxLength={2000}
                placeholder="Опиши технику выполнения этого упражнения"
                style={{ width:'100%',padding:'8px 10px',fontSize:13,borderRadius:8,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT,background:SURF2,resize:'vertical',fontFamily:'inherit',lineHeight:1.6 }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              <div style={{ display:'flex',gap:8,marginTop:8 }}>
                <button onClick={()=>setTechEdit(false)} disabled={techSaving}
                  style={{ flex:1,padding:'9px',fontSize:13,fontWeight:600,borderRadius:9,border:`1px solid ${HAIR}`,background:'none',color:TXT3,cursor:techSaving?'default':'pointer' }}>Отмена</button>
                <button onClick={saveTechnique} disabled={techSaving}
                  style={{ flex:1,padding:'9px',fontSize:13,fontWeight:700,borderRadius:9,border:'none',background:techSaving?SURF2:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',cursor:techSaving?'default':'pointer' }}>{techSaving?'Сохраняем…':'Сохранить'}</button>
              </div>
            </>
          ):(
            <div style={{ fontSize:13,color:TXT2,lineHeight:1.6 }}>{tip}</div>
          )}
        </Card>
        {records.length===0?(
          <Card>
            <div style={{ textAlign:'center',padding:'20px 0',color:TXT3,fontSize:13 }}>
              <div style={{ display:'flex',justifyContent:'center',marginBottom:8 }}><GlassIcon name="chart" size={34} /></div>
              Нет данных. Выполни тренировку с этим упражнением.
            </div>
          </Card>
        ):(
          <Card>
            <div style={{ fontSize:13,fontWeight:700,color:TXT,marginBottom:12 }}>Статистика</div>
            <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14 }}>
              {[{l:'Лучший вес',v:`${best} кг`,c:PUR},{l:'Тренировок',v:records.length,c:'#111'},{l:'Посл. тоннаж',v:`${records[records.length-1].ton} кг`,c:TEA}].map(m=>(
                <div key={m.l} style={{ background:SURF2,borderRadius:10,padding:'10px 12px',textAlign:'center' }}>
                  <div style={{ fontSize:10,color:TXT3,marginBottom:4 }}>{m.l}</div>
                  <div style={{ fontSize:16,fontWeight:700,color:m.c }}>{m.v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize:11,color:TXT3,marginBottom:6 }}>История по дням</div>
            <div style={{ display:'flex',flexDirection:'column',gap:6 }}>
              {[...records].reverse().slice(0,5).map((r,i)=>(
                <div key={i} style={{ display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 12px',background:SURF2,borderRadius:9 }}>
                  <div>
                    <div style={{ fontSize:13,fontWeight:500,color:TXT }}>{new Date(r.date).toLocaleDateString('ru',{day:'numeric',month:'short'})}</div>
                    <div style={{ fontSize:11,color:TXT3,marginTop:1 }}>{r.workoutName}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:13,fontWeight:700,color:PUR }}>{r.maxKg} кг</div>
                    <div style={{ fontSize:10,color:TXT3 }}>макс. вес</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
        {videoPopup}
        {trainerOverlays}
      </div>
    )
  }

  return (
    <div>
      {videoPopup}
      {trainerOverlays}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <h2 style={{ fontSize:20, fontWeight:500, color:TXT, margin:0 }}>Библиотека упражнений</h2>
        {isTrainer&&(
          <button onClick={openAddForm} style={{ fontSize:13, padding:'7px 14px', background:PUR, color:'#fff', border:'none', borderRadius:8, cursor:'pointer', flexShrink:0 }}>+ Упражнение</button>
        )}
      </div>
      {/* Скрытые из каталога — переключатель тренера. Показываем списком с
          кнопкой «Вернуть» (hidden:false). */}
      {isTrainer&&(
        <div style={{ marginBottom:12 }}>
          <button onClick={toggleHidden} style={{ fontSize:12, color:PUR, background:'none', border:`1px solid ${HAIR}`, borderRadius:8, padding:'6px 12px', cursor:'pointer' }}>
            {showHidden?'Скрыть скрытые':'Показать скрытые'}
          </button>
          {showHidden&&(
            <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:8 }}>
              {hiddenLoading?(
                <div style={{ fontSize:12, color:TXT3, padding:'4px 2px' }}>Загрузка...</div>
              ):(hiddenRows||[]).length===0?(
                <div style={{ fontSize:12, color:TXT3, padding:'4px 2px' }}>Скрытых упражнений нет</div>
              ):(hiddenRows||[]).map(r=>(
                <div key={r.name} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:SURF2, borderRadius:9 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</div>
                    <div style={{ fontSize:11, color:TXT3, marginTop:1 }}>{[r.muscle_group,r.equipment].filter(Boolean).join(' · ')||'—'}</div>
                  </div>
                  <button onClick={()=>returnExercise(r.name)} disabled={busy}
                    style={{ flexShrink:0, fontSize:12, fontWeight:600, color:PUR, background:'none', border:`1px solid ${PUR}`, borderRadius:8, padding:'6px 12px', cursor:busy?'default':'pointer' }}>Вернуть</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск упражнения..."
        style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:9,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',marginBottom:10,color:TXT }}
        onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
      {/* Внутри группы — строка возврата к хабу вместо ряда чипов. */}
      {filt!=='Все'&&(
        <button data-back="1" onClick={()=>setFilt('Все')}
          style={{ fontSize:13,color:TXT3,border:'none',background:'none',cursor:'pointer',padding:0,marginBottom:14,display:'flex',alignItems:'center',gap:5 }}>
          <GlassIcon name="back" size={16} />Все группы
        </button>
      )}
      {/* ── Хаб групп мышц. Ниже, при выбранной группе или поиске, идёт
          обычный плотный список — его специально не трогаем. */}
      {showGroupHub?(
        <div>
          {groupCards.map(g=>(
            <HubCard key={g.m}
              icon={GROUP_ICON[g.m]||'dumbbell'}
              title={g.m}
              subtitle={`${g.count} ${plural(g.count,'упражнение','упражнения','упражнений')}`}
              onClick={()=>setFilt(g.m)} />
          ))}
        </div>
      ):(
      <div style={{ display:'flex', flexDirection:'column', gap:9 }}>
        {fl.map((ex,i)=>{
          const vid=pickVideo(exerciseVideos,ex.n,null)
          return (
          <Card key={i} onClick={()=>setSel(ex)} style={{ cursor:'pointer' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              {/* Превью видео — если есть в карте. Тап по нему открывает плеер,
                  а не карточку (stopPropagation). Нет видео — колонка не рисуется. */}
              {vid&&(
                <button onClick={e=>{e.stopPropagation();setPlayVideo({url:vid.video_url,name:ex.label||ex.n})}}
                  style={{ position:'relative', flexShrink:0, width:76, height:48, border:'none', padding:0, borderRadius:9, overflow:'hidden', cursor:'pointer', background:SURF2 }}>
                  <img src={vid.poster_url} alt={ex.n} loading="lazy" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
                  <span style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <span style={{ width:24, height:24, borderRadius:'50%', background:'rgba(0,0,0,0.55)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11 }}>▶</span>
                  </span>
                </button>
              )}
              <div style={{ flex:1, minWidth:0, textAlign:vid?'left':'center' }}>
                <div style={{ fontSize:15, fontWeight:600, color:TXT }}>{ex.label||ex.n}{ex.custom&&<span style={{ marginLeft:6, fontSize:10, padding:'1px 6px', borderRadius:4, background:'#EEEDFE', color:PUR }}>моё</span>}</div>
                <div style={{ fontSize:12, color:TXT3, marginTop:2 }}>{ex.m}{ex.eq?` · ${ex.eq}`:''}</div>
              </div>
            </div>
          </Card>
          )
        })}
        {fl.length===0&&<div style={{ color:TXT3,fontSize:13,gridColumn:'1/-1',textAlign:'center',padding:'30px 0' }}>Ничего не найдено</div>}
      </div>
      )}
    </div>
  )
}

// ── Дневник
// accessLevel — уровень пакета: «Прогресс по упражнениям» требует БАЗУ (1).
// Остальные разделы Дневника (тоннаж, тренировки, питание, 1ПМ) бесплатны.
// readOnly — просмотр чужого дневника тренером, там гейт не применяем.
function DiaryView({ workoutHistory, onEditWorkout, onDeleteWorkout, onCopyWorkout, onWorkoutAction, isMobile, userId, initialSection, diaryJumpToken, onSectionChange, historyLoading, historyLoadError, onRetryHistory, readOnly=false, readOnlyName='', accessLevel = 0, openPlans }) {
  const { exercises: catalogExercises } = useContext(CatalogContext) // для labelOf (имена в истории — ключи)
  const exercisesLocked=!readOnly&&accessLevel<SLOTS_MIN_LEVEL
  const [showExLock,setShowExLock]=useState(false)
  const [section, setSection] = useState(()=>initialSection??null)
  // Сообщаем родителю текущий подраздел — чтобы App мог его запомнить и вернуть
  // при повторном монтировании DiaryView после вынужденного перехода на другую
  // вкладку (см. borrowedNavRef/pendingSectionRestoreRef в App()).
  useEffect(()=>{ onSectionChange?.(section) },[section])
  // Принудительный переход в initialSection по внешнему сигналу (например
  // кнопка "Перейти к тренировке" из чата) — нужен отдельно от lazy-инициализации
  // выше, т.к. если DiaryView уже смонтирован (nav не менялся), просто новое
  // значение initialSection само по себе ничего не запустит.
  const jumpTokenRef = useRef(diaryJumpToken)
  useEffect(()=>{
    if(diaryJumpToken!==jumpTokenRef.current){
      jumpTokenRef.current=diaryJumpToken
      if(initialSection)setSection(initialSection)
    }
  },[diaryJumpToken,initialSection])
  // tonnage
  const [period,setPeriod]=useState('7')
  const [customFrom,setCustomFrom]=useState('')
  const [customTo,setCustomTo]=useState('')
  const [selectedTonBar,setSelectedTonBar]=useState(null)
  const [showTonPeriodMenu,setShowTonPeriodMenu]=useState(false)
  // exercises
  const [selectedEx,setSelectedEx]=useState(null)
  const [exQuery,setExQuery]=useState('')
  const [activeBar,setActiveBar]=useState(null)
  const [exPeriod,setExPeriod]=useState('all')
  const [showExPeriodMenu,setShowExPeriodMenu]=useState(false)
  const [exCustomFrom,setExCustomFrom]=useState('')
  const [exCustomTo,setExCustomTo]=useState('')
  // workouts
  const [selIdx,setSelIdx]=useState(null)
  const [showWorkoutMenu,setShowWorkoutMenu]=useState(false)
  const [openCardMenu,setOpenCardMenu]=useState(null)
  const [openSelWorkoutMenu,setOpenSelWorkoutMenu]=useState(false)
  // Выпадающие меню Дневника закрываются тапом мимо через общий хук
  // (useCloseOnOutsideTap, src/uiCompat.js), а не прозрачной плёнкой на весь
  // экран, как раньше: на телефоне плёнка перехватывала тап ПО ПУНКТУ меню и
  // пункт не срабатывал. Ref ставится на обёртку вместе с кнопкой-триггером —
  // иначе тап по триггеру закрывал бы меню хуком и тут же открывал обработчиком
  // самой кнопки. У меню внутри списка (карточка тренировки) ref получает
  // только открытая карточка — открыта всегда максимум одна.
  const tonPeriodMenuRef=useRef(null)
  const exPeriodMenuRef=useRef(null)
  const selWorkoutMenuRef=useRef(null)
  const workoutMenuRef=useRef(null)
  const cardMenuRef=useRef(null)
  useCloseOnOutsideTap(tonPeriodMenuRef,showTonPeriodMenu?()=>setShowTonPeriodMenu(false):null)
  useCloseOnOutsideTap(exPeriodMenuRef,showExPeriodMenu?()=>setShowExPeriodMenu(false):null)
  useCloseOnOutsideTap(selWorkoutMenuRef,openSelWorkoutMenu?()=>setOpenSelWorkoutMenu(false):null)
  useCloseOnOutsideTap(workoutMenuRef,showWorkoutMenu?()=>setShowWorkoutMenu(false):null)
  useCloseOnOutsideTap(cardMenuRef,openCardMenu!=null?()=>setOpenCardMenu(null):null)
  const [showScheduleForm,setShowScheduleForm]=useState(false)
  const [scheduleForm,setScheduleForm]=useState({name:'',date:''})
  const [plannedWorkouts,setPlannedWorkouts]=useState(()=>{try{return JSON.parse(localStorage.getItem('fitpro_planned')||'[]')}catch{return[]}})
  const [templateMsg,setTemplateMsg]=useState('')
  // Пикер сохранённых шаблонов (пункт «Шаблон тренировки»).
  const [showTemplatePicker,setShowTemplatePicker]=useState(false)
  const [userTemplates,setUserTemplates]=useState(null) // null = ещё не грузили
  const [templatesLoading,setTemplatesLoading]=useState(false)
  // калькулятор 1ПМ
  const [rmMode,setRmMode]=useState('direct') // direct | reverse | table
  const [rmWeight,setRmWeight]=useState('')
  const [rmReps,setRmReps]=useState('')
  const [rmTargetRM,setRmTargetRM]=useState('')
  const [rmTargetReps,setRmTargetReps]=useState('')
  const [rmTableRM,setRmTableRM]=useState('')

  // Запланированные тренировки — как и остальное, подтягиваются из Supabase,
  // чтобы совпадать на любом устройстве/origin. Локальные записи без supabaseId
  // (старые, ещё не синхронизированные) переносятся один раз, затем список
  // целиком заменяется тем, что реально лежит в базе.
  useEffect(()=>{
    if(!userId)return
    let cancelled=false
    ;(async()=>{
      // readOnly (просмотр клиента тренером): локальный fitpro_planned — кэш
      // ЧУЖОГО (тренерского) устройства, миграция из него в записи клиента
      // была бы записью данных клиента с мусорным источником — только читаем.
      if(!readOnly){
        let local
        try{local=JSON.parse(localStorage.getItem('fitpro_planned')||'[]')}catch{local=[]}
        const toMigrate=local.filter(p=>!p.supabaseId)
        for(const p of toMigrate){
          const{data,error}=await supabase.from('planned_workouts').insert({user_id:userId,name:p.name||null,date:p.date||null}).select('id').single()
          if(error)console.error('Миграция плана тренировки: ошибка вставки:',error)
          else if(data)p.supabaseId=data.id
        }
        if(toMigrate.length)localStorage.setItem('fitpro_planned',JSON.stringify(local))
      }
      const{data:rows,error}=await supabase.from('planned_workouts').select('*').eq('user_id',userId).order('date')
      if(cancelled||error||!rows)return
      const mapped=rows.map(r=>({id:r.id,supabaseId:r.id,name:r.name,date:r.date}))
      setPlannedWorkouts(mapped)
      if(!readOnly)localStorage.setItem('fitpro_planned',JSON.stringify(mapped))
    })()
    return()=>{cancelled=true}
  },[userId,readOnly])

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
      date:w.date,name:w.name,color:w.color||PUR,histIdx,exercises:w.exercises||[],comment:w.comment,createdBy:w.createdBy||null,
      ton:(w.exercises||[]).reduce((s1,ex)=>(ex.sets||[]).reduce((s2,set)=>s2+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),s1),0),
    }))
    .sort((a,b)=>new Date(a.date)-new Date(b.date))
  const fmtD=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'short'}).replace(/\./g,'')
  const fmtFull=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})
  // Метка веса подхода — та же формула, что во вкладке "История" карточки
  // клиента (RealClientDetail). Подход на резине хранит уровень в bandLevel,
  // а kg у него пустой, поэтому без этой ветки резинка выводилась как "— кг"
  // (а в разделе "Прогресс по упражнениям" — как "0 кг"). "б/в" — вес тела.
  const setWeightLabel=s=>s.bandLevel!=null?`${s.bandLevel} рез.`:s.kg?`${s.kg} кг`:'б/в'
  // Заголовок полноэкранной секции. Секции открываются порталом в document.body,
  // поверх всего интерфейса — тренер, провалившись в "Питание", иначе не видит,
  // чей дневник смотрит. В readOnly подставляем имя клиента; own/shared нужны
  // там, где притяжательный заголовок клиента ("Мои тренировки") у тренера
  // должен звучать нейтрально ("Иван Иванов · Тренировки"). При readOnly=false
  // (и на всякий случай при пустом имени) возвращаем ровно прежний заголовок.
  const sectionTitle=(own,shared=own)=>readOnly&&readOnlyName?`${readOnlyName} · ${shared}`:own

  // ── Питание
  // Весь раздел (состояние, загрузка, приёмы пищи, добавление, сканер) живёт в
  // src/FoodDiary.jsx. Здесь остался только вызов: App.jsx не раздуваем.

  // Тост «не удалось сохранить». Имя историческое — завёлся он для дневника
  // питания, но пользуются им и планы тренировок, и шаблоны (см. секцию
  // «Тренировки» ниже). Поэтому при переезде еды в FoodDiary.jsx он остался
  // здесь: у FoodDiary свой такой же, они друг другу не мешают — это разные
  // компоненты со своими порталами.
  const [showFoodSaveError,setShowFoodSaveError]=useState(false)
  const flashFoodSaveError=()=>{setShowFoodSaveError(true);setTimeout(()=>setShowFoodSaveError(false),3500)}

  // ── СЕКЦИЯ: Общий тоннаж
  if(section==='tonnage'){
    const TON_PERIOD_OPTIONS=[{k:'7',l:'Последние 7'},{k:'30d',l:'30 дней'},{k:'all',l:'Всё время'},{k:'custom',l:'Свой период'}]
    const workoutTons=(customFrom||customTo)
      ?allWorkoutTons.filter(w=>{const t=new Date(w.date).getTime();const from=customFrom?new Date(customFrom).getTime():0;const to=customTo?new Date(customTo+'T23:59:59').getTime():Infinity;return t>=from&&t<=to})
      :period==='7'?allWorkoutTons.slice(-7)
      :period==='30d'?allWorkoutTons.filter(w=>new Date(w.date).getTime()>=Date.now()-30*86400000)
      :allWorkoutTons
    const totalTonnage=workoutTons.reduce((s,w)=>s+w.ton,0)
    const chartTons=workoutTons
    const chartMaxTon=chartTons.length?Math.max(...chartTons.map(w=>w.ton),1):1
    const CHART_BAR_H=120
    const selW=selectedTonBar!==null?chartTons[selectedTonBar]:null
    // При большом числе узких столбиков подпись значения над каждым и подпись
    // даты под каждым наезжают друг на друга (см. задачу) — показываем значение
    // только у выделенного столбика, а даты прореживаем до ~6 меток.
    const manyBars=chartTons.length>7
    const dateStride=manyBars?Math.ceil(chartTons.length/6):1
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1000,display:'flex',flexDirection:'column' }}>
        <BackBtn label={sectionTitle('Общий тоннаж')} onBack={()=>setSection(null)} right={
          <div ref={tonPeriodMenuRef} style={{ position:'relative' }}>
            <button data-testid="ton-period-trigger" onClick={()=>setShowTonPeriodMenu(v=>!v)}
              style={{ width:34,height:34,borderRadius:9,border:`1px solid ${HAIR}`,background:period!=='7'||customFrom||customTo?`${PUR}11`:SURF2,cursor:'pointer',fontSize:16,display:'flex',alignItems:'center',justifyContent:'center',color:period!=='7'||customFrom||customTo?PUR:TXT3,minHeight:'unset' }}><GlassIcon name="calendar" size={26} /></button>
            {showTonPeriodMenu&&(
              <div data-testid="ton-period-menu" style={{ position:'absolute',top:40,right:0,background:SURF,borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:160,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                {TON_PERIOD_OPTIONS.map((p,idx)=>(
                  <button key={p.k} data-testid={`ton-period-${p.k}`} onClick={()=>{setPeriod(p.k);if(p.k!=='custom'){setCustomFrom('');setCustomTo('')}setShowTonPeriodMenu(false);setSelectedTonBar(null)}}
                    style={{ display:'block',width:'100%',padding:'10px 15px',border:'none',borderTop:idx>0?`1px solid ${HAIR}`:'none',background:period===p.k?`${PUR}11`:'transparent',cursor:'pointer',textAlign:'left',color:period===p.k?PUR:TXT,fontSize:13,fontWeight:period===p.k?600:400 }}>{p.l}</button>
                ))}
              </div>
            )}
          </div>
        } />
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          {period==='custom'&&(
            <div style={{ display:'flex',flexDirection:isMobile?'column':'row',alignItems:'center',gap:8,width:isMobile?'100%':'auto',marginBottom:10 }}>
              <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                <span style={{ fontSize:11,color:TXT3,flexShrink:0,width:16,textAlign:'right' }}>с</span>
                <input type="date" value={customFrom} onChange={e=>{setCustomFrom(e.target.value);setSelectedTonBar(null)}}
                  style={{ width:128,flexShrink:0,fontSize:13,padding:'7px 6px',borderRadius:7,border:`1.5px solid ${HAIR}`,outline:'none',color:TXT,background:SURF,colorScheme:'light',minHeight:'unset',textAlign:'center',boxSizing:'border-box' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              </div>
              <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                <span style={{ fontSize:11,color:TXT3,flexShrink:0,width:16,textAlign:'right' }}>по</span>
                <input type="date" value={customTo} onChange={e=>{setCustomTo(e.target.value);setSelectedTonBar(null)}}
                  style={{ width:128,flexShrink:0,fontSize:13,padding:'7px 6px',borderRadius:7,border:`1.5px solid ${HAIR}`,outline:'none',color:TXT,background:SURF,colorScheme:'light',minHeight:'unset',textAlign:'center',boxSizing:'border-box' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              </div>
              <div style={{ width:28,display:'flex',justifyContent:'center',flexShrink:0 }}>
                {(customFrom||customTo)&&(
                  <button onClick={()=>{setCustomFrom('');setCustomTo('');setSelectedTonBar(null)}}
                    style={{ fontSize:13,padding:'5px 7px',borderRadius:6,border:'none',background:SURF2,color:TXT3,cursor:'pointer',minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
                )}
              </div>
            </div>
          )}
          <Card style={{ marginBottom:16 }}>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11,fontWeight:500,color:TXT3,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:4 }}>Общий тоннаж</div>
              <div style={{ fontSize:32,fontWeight:800,color:PUR,lineHeight:1 }}>{totalTonnage.toLocaleString('ru')} <span style={{ fontSize:18,fontWeight:600 }}>кг</span></div>
            </div>
            {workoutTons.length===0?(
              <div style={{ textAlign:'center',color:TXT3,fontSize:13,padding:'20px 0' }}>Заверши тренировку — она появится здесь</div>
            ):(
              <div>
                <div style={{ display:'flex',alignItems:'flex-end',gap:5,height:CHART_BAR_H }}>
                  {chartTons.map((w,i)=>{
                    const bh=Math.max(10,Math.round((w.ton/chartMaxTon)*(CHART_BAR_H-22)))
                    const on=selectedTonBar===i
                    return(
                      <div key={i} data-testid={`ton-bar-${i}`} onClick={()=>setSelectedTonBar(on?null:i)}
                        style={{ flex:1,display:'flex',flexDirection:'column',justifyContent:'flex-end',alignItems:'center',height:'100%',minWidth:0,cursor:'pointer' }}>
                        {(!manyBars||on)&&<div style={{ fontSize:11,fontWeight:on?700:600,color:on?PUR:`${PUR}99`,marginBottom:4,textAlign:'center',lineHeight:1,whiteSpace:'nowrap' }}>{w.ton}</div>}
                        <div style={{ width:'68%',height:bh,background:on?PUR:`${PUR}55`,borderRadius:'3px 3px 0 0',transition:'background 0.12s' }} />
                      </div>
                    )
                  })}
                </div>
                <div style={{ borderTop:`2px solid ${HAIR}` }} />
                <div style={{ display:'flex',gap:5,paddingTop:5 }}>
                  {chartTons.map((w,i)=>{
                    const on=selectedTonBar===i
                    const showDate=!manyBars||on||i===0||i===chartTons.length-1||i%dateStride===0
                    return(
                      <div key={i} style={{ flex:1,textAlign:'center',fontSize:9,color:on?PUR:TXT3,lineHeight:1.2,minWidth:0,overflow:'hidden' }}>{showDate?fmtD(w.date):''}</div>
                    )
                  })}
                </div>
                <div style={{ textAlign:'center',fontSize:11,color:TXT3,marginTop:10 }}>
                  Нажми на столбик, чтобы увидеть подробную сводку
                </div>
              </div>
            )}
          </Card>
          {selW&&(
            <Card style={{ marginBottom:16,border:`1.5px solid ${PUR}33` }}>
              <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10 }}>
                <div>
                  <div style={{ fontSize:14,fontWeight:600,color:TXT }}>{fmtFull(selW.date)}</div>
                  <div style={{ fontSize:12,color:TXT3,marginTop:2 }}>{selW.name}</div>
                </div>
                <div ref={selWorkoutMenuRef} style={{ position:'relative' }}>
                  {!readOnly&&<button data-testid="selw-menu-trigger" onClick={e=>{e.stopPropagation();setOpenSelWorkoutMenu(v=>!v)}}
                    style={{ width:30,height:30,borderRadius:8,border:`1px solid ${HAIR}`,background:SURF2,cursor:'pointer',fontSize:17,color:TXT3,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,letterSpacing:1,minHeight:'unset' }}>⋯</button>}
                  {!readOnly&&openSelWorkoutMenu&&(
                    <div data-testid="selw-menu" style={{ position:'absolute',top:34,right:0,background:SURF,borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:180,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                      <button data-testid="selw-menu-edit" onClick={()=>{setOpenSelWorkoutMenu(false);if(onEditWorkout)onEditWorkout(workoutHistory[selW.histIdx],selW.histIdx)}}
                        style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',borderBottom:`1px solid ${HAIR}`,background:'transparent',cursor:'pointer',textAlign:'left',color:TXT,fontSize:13 }}>✏️ Редактировать</button>
                      <button data-testid="selw-menu-delete" onClick={async()=>{setOpenSelWorkoutMenu(false);if(await askConfirm('Удалить тренировку?')){onDeleteWorkout(selW.histIdx);setSelIdx(null)}}}
                        style={{ display:'flex',alignItems:'center',gap:8,width:'100%',padding:'11px 15px',border:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:'#ef4444',fontSize:13 }}>🗑 Удалить</button>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12 }}>
                {[{label:'Тоннаж',value:`${selW.ton} кг`,accent:true},{label:'Упражнений',value:selW.exercises.length,accent:false},{label:'Подходов',value:selW.exercises.reduce((s,ex)=>s+(ex.sets||[]).filter(s=>s.kg||s.reps).length,0),accent:false}].map(c=>(
                  <div key={c.label} style={{ background:SURF2,borderRadius:10,padding:'10px 12px' }}>
                    <div style={{ fontSize:10,color:TXT3,marginBottom:4 }}>{c.label}</div>
                    <div style={{ fontSize:17,fontWeight:700,color:c.accent?PUR:TXT }}>{c.value}</div>
                  </div>
                ))}
              </div>
              {selW.exercises.map((ex,ei)=>{
                const exTon=(ex.sets||[]).reduce((s,set)=>s+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),0)
                return(
                  <div key={ei} style={{ paddingTop:ei>0?10:0,borderTop:ei>0?`1px solid ${HAIR}`:'' }}>
                    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5 }}>
                      <span style={{ fontSize:13,fontWeight:500,color:TXT }}>{labelOf(catalogExercises,ex.n)}</span>
                      {exTon>0&&<span style={{ fontSize:11,color:PUR,fontWeight:600 }}>{exTon} кг</span>}
                    </div>
                    <div style={{ display:'flex',gap:5,flexWrap:'wrap' }}>
                      {(ex.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                        <span key={si} style={{ fontSize:11,color:TXT3,background:SURF2,padding:'2px 8px',borderRadius:5 }}>
                          {si+1}. {setWeightLabel(s)} × {s.reps||'—'}
                          {s.rating&&<span style={{ color:PUR,fontWeight:600 }}> · {s.rating} · {RATING_LABELS[s.rating]}</span>}
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
    // Второй путь в секцию — initialSection (возврат в Дневник из тренировки,
    // App.jsx восстанавливает последнюю открытую секцию), он минует пункт меню.
    // Поэтому гейт продублирован здесь, а не только на клике.
    // Тот же полноэкранный портал, что у обычного содержимого секции ниже —
    // иначе подсказка отрисовалась бы внутри списка Дневника, а не поверх него.
    if(exercisesLocked) return createPortal(
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1000,display:'flex',flexDirection:'column' }}>
        <BackBtn label={sectionTitle('Прогресс по упражнениям')} onBack={()=>setSection(null)} />
        <div style={{ flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:'24px 16px' }}>
          <PlanLockNotice {...LOCK_EXERCISES} onOpenPlans={()=>openPlans?.()} />
        </div>
      </div>
    , document.body)
    const EX_PERIOD_DAYS={'30d':30}
    const filteredExerciseMap={}
    workoutHistory.forEach((w,histIdx)=>{
      const t=new Date(w.date).getTime()
      if(exCustomFrom||exCustomTo){
        const from=exCustomFrom?new Date(exCustomFrom).getTime():0
        const to=exCustomTo?new Date(exCustomTo+'T23:59:59').getTime():Infinity
        if(t<from||t>to)return
      } else if(exPeriod==='30d'&&t<Date.now()-EX_PERIOD_DAYS['30d']*86400000){
        return
      }
      ;(w.exercises||[]).forEach(ex=>{
        if(!filteredExerciseMap[ex.n])filteredExerciseMap[ex.n]={muscle:ex.m,records:[]}
        const validSets=(ex.sets||[]).filter(s=>s.kg||s.reps)
        const tonnage=validSets.reduce((sum,s)=>sum+(parseFloat(s.kg)||0)*(parseInt(s.reps)||0),0)
        const maxKg=validSets.length?Math.max(...validSets.map(s=>parseFloat(s.kg)||0)):0
        filteredExerciseMap[ex.n].records.push({date:w.date,sets:ex.sets,tonnage,maxKg,histIdx,workoutName:w.name})
      })
    })
    const exTonnage=n=>filteredExerciseMap[n].records.reduce((s,r)=>s+r.tonnage,0)
    const sortedExerciseNames=Object.keys(filteredExerciseMap).sort((a,b)=>exTonnage(b)-exTonnage(a))
    const PERIOD_OPTIONS=[{k:'all',l:'Всё время'},{k:'30d',l:'30 дней'},{k:'custom',l:'Свой период'}]
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1000,display:'flex',flexDirection:'column' }}>
        <BackBtn label={sectionTitle('Прогресс по упражнениям')} onBack={()=>setSection(null)} right={
          <div ref={exPeriodMenuRef} style={{ position:'relative' }}>
            <button data-testid="ex-period-trigger" onClick={()=>setShowExPeriodMenu(v=>!v)}
              style={{ width:34,height:34,borderRadius:9,border:`1px solid ${HAIR}`,background:exPeriod!=='all'?`${PUR}11`:SURF2,cursor:'pointer',fontSize:16,display:'flex',alignItems:'center',justifyContent:'center',color:exPeriod!=='all'?PUR:TXT3,minHeight:'unset' }}><GlassIcon name="calendar" size={26} /></button>
            {showExPeriodMenu&&(
              <div data-testid="ex-period-menu" style={{ position:'absolute',top:40,right:0,background:SURF,borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:160,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                {PERIOD_OPTIONS.map((p,idx)=>(
                  <button key={p.k} data-testid={`ex-period-${p.k}`} onClick={()=>{setExPeriod(p.k);if(p.k!=='custom'){setExCustomFrom('');setExCustomTo('')}setShowExPeriodMenu(false);setSelectedEx(null);setActiveBar(null)}}
                    style={{ display:'block',width:'100%',padding:'10px 15px',border:'none',borderTop:idx>0?`1px solid ${HAIR}`:'none',background:exPeriod===p.k?`${PUR}11`:'transparent',cursor:'pointer',textAlign:'left',color:exPeriod===p.k?PUR:TXT,fontSize:13,fontWeight:exPeriod===p.k?600:400 }}>{p.l}</button>
                ))}
              </div>
            )}
          </div>
        } />
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          {exPeriod==='custom'&&(
            <div style={{ display:'flex',flexDirection:isMobile?'column':'row',alignItems:'center',gap:8,width:isMobile?'100%':'auto',marginBottom:10 }}>
              <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                <span style={{ fontSize:11,color:TXT3,flexShrink:0,width:16,textAlign:'right' }}>с</span>
                <input type="date" value={exCustomFrom} onChange={e=>{setExCustomFrom(e.target.value);setSelectedEx(null);setActiveBar(null)}}
                  style={{ width:128,flexShrink:0,fontSize:13,padding:'7px 6px',borderRadius:7,border:`1.5px solid ${HAIR}`,outline:'none',color:TXT,background:SURF,colorScheme:'light',minHeight:'unset',textAlign:'center',boxSizing:'border-box' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              </div>
              <div style={{ display:'flex',alignItems:'center',gap:6 }}>
                <span style={{ fontSize:11,color:TXT3,flexShrink:0,width:16,textAlign:'right' }}>по</span>
                <input type="date" value={exCustomTo} onChange={e=>{setExCustomTo(e.target.value);setSelectedEx(null);setActiveBar(null)}}
                  style={{ width:128,flexShrink:0,fontSize:13,padding:'7px 6px',borderRadius:7,border:`1.5px solid ${HAIR}`,outline:'none',color:TXT,background:SURF,colorScheme:'light',minHeight:'unset',textAlign:'center',boxSizing:'border-box' }}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              </div>
              <div style={{ width:28,display:'flex',justifyContent:'center',flexShrink:0 }}>
                {(exCustomFrom||exCustomTo)&&(
                  <button onClick={()=>{setExCustomFrom('');setExCustomTo('');setSelectedEx(null);setActiveBar(null)}}
                    style={{ fontSize:13,padding:'5px 7px',borderRadius:6,border:'none',background:SURF2,color:TXT3,cursor:'pointer',minHeight:'unset' }}><GlassIcon name="close" size={26} /></button>
                )}
              </div>
            </div>
          )}
          <input value={exQuery} onChange={e=>setExQuery(e.target.value)} placeholder="Поиск упражнения..."
            style={{ width:'100%',padding:'10px 16px',fontSize:14,borderRadius:10,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',marginBottom:10,color:TXT,background:SURF }}
            onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
          {historyLoading&&workoutHistory.length===0?(
            <div style={{ textAlign:'center',color:TXT3,fontSize:13,marginTop:40 }}>Загрузка…</div>
          ):historyLoadError?(
            <div style={{ textAlign:'center',color:TXT3,fontSize:13,marginTop:40 }}>
              <div style={{ marginBottom:10 }}>Не удалось загрузить. Проверь связь.</div>
              <button onClick={onRetryHistory} style={{ fontSize:12,padding:'7px 16px',borderRadius:8,border:'none',background:PUR,color:'#fff',cursor:'pointer',fontWeight:600,minHeight:'unset' }}>Повторить</button>
            </div>
          ):exerciseNames.length===0?(
            <div style={{ textAlign:'center',color:TXT3,fontSize:13,marginTop:40 }}>Заверши тренировку с упражнениями, чтобы видеть аналитику</div>
          ):sortedExerciseNames.length===0?(
            <div style={{ textAlign:'center',color:TXT3,fontSize:13,marginTop:40 }}>Нет тренировок за выбранный период</div>
          ):sortedExerciseNames.filter(n=>n.toLowerCase().includes(exQuery.toLowerCase())).length===0?(
            <div style={{ textAlign:'center',color:TXT3,fontSize:13,marginTop:40 }}>Упражнение не найдено</div>
          ):(
            sortedExerciseNames.filter(n=>n.toLowerCase().includes(exQuery.toLowerCase())).map(name=>{
              const ex=filteredExerciseMap[name]
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
                              <div style={{ fontSize:14,fontWeight:600,color:TXT,marginBottom:2 }}>{name}</div>
                              <div style={{ fontSize:11,color:TXT3 }}>
                                {ex.muscle?`${ex.muscle} · `:''}{records.length} {records.length===1?'тренировка':records.length<5?'тренировки':'тренировок'}
                                {growth>0&&<span style={{ color:'#22c55e',marginLeft:4 }}>+{growth.toFixed(0)} кг</span>}
                              </div>
                            </div>
                            <div style={{ textAlign:'right',flexShrink:0 }}>
                              <div style={{ fontSize:16,fontWeight:700,color:PUR }}>{best} кг</div>
                              <div style={{ fontSize:10,color:TXT3 }}>макс. вес</div>
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
                      <div style={{ marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8 }}>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:14,fontWeight:600,color:TXT }}>{fmtFull(activeRec.date)}</div>
                          {activeRec.workoutName&&<div style={{ fontSize:12,color:TXT3,marginTop:2 }}>{activeRec.workoutName}</div>}
                        </div>
                        {!readOnly&&(
                        <div style={{ display:'flex',gap:6,flexShrink:0 }}>
                          <button onClick={e=>{e.stopPropagation();if(onEditWorkout)onEditWorkout(workoutHistory[activeRec.histIdx],activeRec.histIdx)}}
                            title="Редактировать"
                            style={{ width:30,height:30,borderRadius:8,border:`1px solid ${HAIR}`,background:SURF2,cursor:'pointer',fontSize:13,color:TXT3,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}><GlassIcon name="pen" size={26} /></button>
                          <button onClick={async e=>{e.stopPropagation();if(await askConfirm('Удалить тренировку?')){onDeleteWorkout(activeRec.histIdx)}}}
                            title="Удалить"
                            style={{ width:30,height:30,borderRadius:8,border:'1px solid #fecaca',background:'#fef2f2',cursor:'pointer',fontSize:13,color:'#ef4444',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}><GlassIcon name="trash" size={26} /></button>
                        </div>
                        )}
                      </div>
                      <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12 }}>
                        {[{label:'Тоннаж',value:`${activeRec.tonnage} кг`,accent:true},{label:'Макс. вес',value:`${activeRec.maxKg} кг`,accent:false},{label:'Подходов',value:(activeRec.sets||[]).filter(s=>s.kg||s.reps).length,accent:false}].map(c=>(
                          <div key={c.label} style={{ background:SURF2,borderRadius:10,padding:'10px 12px' }}>
                            <div style={{ fontSize:10,color:TXT3,marginBottom:4 }}>{c.label}</div>
                            <div style={{ fontSize:17,fontWeight:700,color:c.accent?PUR:TXT }}>{c.value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display:'flex',flexDirection:'column',gap:5 }}>
                        {(activeRec.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                          <div key={si} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 12px',background:SURF2,borderRadius:8 }}>
                            <div style={{ display:'flex',alignItems:'center',gap:12 }}>
                              <span style={{ fontSize:11,fontWeight:600,color:TXT3,width:16,textAlign:'center' }}>{si+1}</span>
                              <span style={{ fontSize:14,fontWeight:600,color:TXT }}>{setWeightLabel(s)}</span>
                              <span style={{ fontSize:13,color:TXT3 }}>× {parseInt(s.reps)||0} повт.</span>
                              {/* Оценка тяжести подхода (workout_sets.rating) — без неё не видно,
                                  почему движок прогрессии изменил вес на следующий раз (см. задачу 1). */}
                              {s.rating&&(
                                <span style={{ fontSize:11,fontWeight:600,color:PUR,background:`${PUR}18`,padding:'2px 8px',borderRadius:6 }}>
                                  {s.rating} · {RATING_LABELS[s.rating]}
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize:13,fontWeight:600,color:PUR }}>{(parseFloat(s.kg)||0)*(parseInt(s.reps)||0)} кг</span>
                          </div>
                        ))}
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
    const savePlanned=(pw)=>{
      if(readOnly)return
      const next=[...plannedWorkouts,pw];setPlannedWorkouts(next);localStorage.setItem('fitpro_planned',JSON.stringify(next))
      if(userId){
        supabase.from('planned_workouts').insert({user_id:userId,name:pw.name||null,date:pw.date||null}).select('id').single().then(({data,error})=>{
          if(error){
            console.error('Ошибка синхронизации плана тренировки:',error)
            // Откат оптимистичной вставки — сервер её не принял, "зомби"-запись
            // без supabaseId иначе осталась бы висеть только локально.
            setPlannedWorkouts(list=>{
              const rolledBack=list.filter(p=>p!==pw)
              localStorage.setItem('fitpro_planned',JSON.stringify(rolledBack))
              return rolledBack
            })
            flashFoodSaveError()
            return
          }
          setPlannedWorkouts(list=>{
            const updated=list.map(p=>p===pw?{...p,supabaseId:data?.id}:p)
            localStorage.setItem('fitpro_planned',JSON.stringify(updated))
            return updated
          })
        })
      }
    }
    const deletePlanned=async(id)=>{
      if(readOnly)return
      const target=plannedWorkouts.find(p=>p.id===id)
      if(target?.supabaseId!=null){
        const{error}=await supabase.from('planned_workouts').delete().eq('id',target.supabaseId)
        if(error){console.error('Ошибка удаления плана тренировки:',error);flashFoodSaveError();return}
      }
      setPlannedWorkouts(list=>{
        const next=list.filter(p=>p.id!==id)
        localStorage.setItem('fitpro_planned',JSON.stringify(next))
        return next
      })
    }
    const saveTemplate=async(workout)=>{
      if(readOnly)return
      const tpl={id:Date.now(),name:workout.name,exercises:(workout.exercises||[]).map(ex=>({n:ex.n,m:ex.m,eq:ex.eq}))}
      if(userId){
        const{error}=await supabase.from('workout_templates').insert({user_id:userId,name:tpl.name,exercises:tpl.exercises})
        if(error){console.error('Ошибка сохранения шаблона тренировки:',error);flashFoodSaveError();return}
      }
      const existing=JSON.parse(localStorage.getItem('fitpro_user_templates')||'[]')
      localStorage.setItem('fitpro_user_templates',JSON.stringify([...existing,tpl]))
      setTemplateMsg(`Шаблон «${workout.name}» сохранён`)
      setTimeout(()=>setTemplateMsg(''),2500)
    }
    // Открыть пикер шаблонов и лениво подгрузить список (как пул видео).
    const openTemplatePicker=async()=>{
      setShowTemplatePicker(true)
      setTemplatesLoading(true)
      let list=null
      if(userId){
        const{data,error}=await supabase.from('workout_templates').select('id,name,exercises').eq('user_id',userId).order('created_at',{ascending:false})
        if(!error&&data)list=data
      }
      // Сеть упала или нет userId → зеркало localStorage, чтобы список не был
      // пустым по сетевой причине.
      if(!list){try{list=JSON.parse(localStorage.getItem('fitpro_user_templates')||'[]')}catch{list=[]}}
      setUserTemplates(list||[])
      setTemplatesLoading(false)
    }
    const deleteTemplate=async(tpl)=>{
      if(!await askConfirm(`Удалить шаблон «${tpl.name}»?`))return
      if(userId&&tpl.id!=null){
        const{error}=await supabase.from('workout_templates').delete().eq('id',tpl.id)
        if(error){console.error('Ошибка удаления шаблона:',error);flashFoodSaveError();return} // список не меняем
      }
      // Убрать из зеркала localStorage. id БД (bigint) и локальный (Date.now)
      // лежат в разных пространствах, поэтому чистим и по id, и по имени — best-effort.
      try{
        const mirror=JSON.parse(localStorage.getItem('fitpro_user_templates')||'[]')
        localStorage.setItem('fitpro_user_templates',JSON.stringify(mirror.filter(t=>t.id!==tpl.id&&t.name!==tpl.name)))
      }catch{}
      setUserTemplates(list=>(list||[]).filter(t=>t!==tpl))
    }
    // Запуск по шаблону — как запланированная: передаём name+exercises, App/WorkoutsView соберут тренировку.
    const launchTemplate=(tpl)=>{
      if(onWorkoutAction)onWorkoutAction('template',{name:tpl.name,exercises:tpl.exercises||[]})
      setShowTemplatePicker(false)
    }
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1000,display:'flex',flexDirection:'column' }}>
        {/* Тост ошибки записи. Общий на весь DiaryView (планы, шаблоны),
            savePlanned/deletePlanned/saveTemplate тоже могут упасть в Supabase. */}
        {showFoodSaveError&&(
          <div style={{
            position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
            zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
            background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
            boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
          }}>
            Не удалось сохранить — проверь связь и повтори
          </div>
        )}
        {/* Пикер сохранённых шаблонов — стиль как у videoPicker/exFormModal. */}
        {showTemplatePicker&&(
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1400, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
            onClick={()=>setShowTemplatePicker(false)}>
            <div style={{ background:SURF, borderRadius:16, padding:'20px 18px', width:'100%', maxWidth:400, maxHeight:'80vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <span style={{ fontSize:16, fontWeight:700, color:TXT }}>Шаблоны тренировок</span>
                <button onClick={()=>setShowTemplatePicker(false)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:TXT3, lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
              </div>
              <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:8 }}>
                {templatesLoading?(
                  <div style={{ fontSize:13, color:TXT3, padding:'10px 0', textAlign:'center' }}>Загрузка…</div>
                ):(userTemplates&&userTemplates.length>0)?userTemplates.map((tpl,i)=>(
                  <div key={tpl.id??i} style={{ display:'flex', alignItems:'center', gap:8, background:SURF2, border:`1px solid ${HAIR}`, borderRadius:10, padding:'10px 12px' }}>
                    <button onClick={()=>launchTemplate(tpl)} style={{ flex:1, minWidth:0, background:'none', border:'none', textAlign:'left', cursor:'pointer', padding:0 }}>
                      <div style={{ fontSize:14, fontWeight:600, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tpl.name||'Тренировка'}</div>
                      <div style={{ fontSize:11, color:TXT3, marginTop:2 }}>{(tpl.exercises||[]).length} {plural((tpl.exercises||[]).length,'упражнение','упражнения','упражнений')}</div>
                    </button>
                    <button onClick={()=>deleteTemplate(tpl)} title="Удалить шаблон" style={{ background:'none', border:'none', color:TXT3, cursor:'pointer', lineHeight:1, padding:4, flexShrink:0 }}><GlassIcon name="close" size={22} /></button>
                  </div>
                )):(
                  <div style={{ fontSize:13, color:TXT3, padding:'14px 6px', textAlign:'center', lineHeight:1.5 }}>Шаблонов пока нет. Сохрани тренировку как шаблон через ⋯ на её карточке в дневнике.</div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* ─ Шапка с кнопкой + */}
        <div style={{ background:SURF,borderBottom:`1px solid ${HAIR}`,padding:'14px 18px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0,position:'sticky',top:0,zIndex:10 }}>
          <div style={{ display:'flex',alignItems:'center',gap:14 }}>
            <button data-back="1" onClick={()=>{setSection(null);setShowWorkoutMenu(false);setOpenCardMenu(null)}} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:TXT3,lineHeight:1,padding:0,minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
            <span style={{ fontSize:17,fontWeight:700,color:TXT }}>{sectionTitle('Мои тренировки','Тренировки')}</span>
          </div>
          {!readOnly&&<div ref={workoutMenuRef} style={{ position:'relative' }}>
            <button data-testid="workout-menu-trigger" onClick={()=>{setShowWorkoutMenu(v=>!v);setOpenCardMenu(null)}}
              style={{ width:36,height:36,borderRadius:10,background:PUR,border:'none',color:'#fff',fontSize:26,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,fontWeight:300 }}>+</button>
            {showWorkoutMenu&&(
              <div data-testid="workout-menu" style={{ position:'absolute',top:42,right:0,background:SURF,borderRadius:13,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:228,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                {[
                  {ic:'calendar',label:'Запланировать тренировку',sub:'Назначить дату',test:'plan'},
                  {ic:'play',label:'Начать тренировку',sub:'Запустить прямо сейчас',key:'start',test:'start'},
                  {ic:'check',label:'Добавить выполненную',sub:'Записать прошедшую',key:'done',test:'done'},
                  {ic:'template',label:'Шаблон тренировки',sub:'Выбрать из готовых',key:'template',test:'template'},
                ].map((item,idx)=>(
                  <button key={idx} data-testid={`workout-menu-${item.test}`} onClick={()=>{
                    setShowWorkoutMenu(false)
                    if(item.key==='template'){openTemplatePicker()}
                    else if(item.key){if(onWorkoutAction)onWorkoutAction(item.key)}
                    else{setShowScheduleForm(true)}
                  }} style={{ display:'flex',alignItems:'center',gap:11,width:'100%',padding:'11px 15px',border:'none',borderTop:idx>0?`1px solid ${HAIR}`:'none',background:'transparent',cursor:'pointer',textAlign:'left' }}>
                    <GlassIcon name={item.ic} size={26} />
                    <div>
                      <div style={{ fontSize:13,fontWeight:500,color:TXT }}>{item.label}</div>
                      <div style={{ fontSize:11,color:TXT3 }}>{item.sub}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>}
        </div>

        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>
          {!readOnly&&templateMsg&&<div style={{ background:TEA,color:'#fff',borderRadius:9,padding:'8px 14px',fontSize:13,marginBottom:12,textAlign:'center' }}>{templateMsg}</div>}

          {/* Форма планирования */}
          {!readOnly&&showScheduleForm&&(
            <div style={{ background:SURF,borderRadius:12,padding:'16px',marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize:14,fontWeight:600,color:TXT,marginBottom:10 }}>📅 Запланировать тренировку</div>
              <input value={scheduleForm.name} onChange={e=>setScheduleForm(f=>({...f,name:e.target.value}))} placeholder="Название тренировки"
                style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:8,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT,marginBottom:8 }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              <input type="date" value={scheduleForm.date} onChange={e=>setScheduleForm(f=>({...f,date:e.target.value}))}
                style={{ width:'100%',padding:'9px 12px',fontSize:13,borderRadius:8,border:`1.5px solid ${HAIR}`,boxSizing:'border-box',outline:'none',color:TXT,background:SURF,colorScheme:'light',marginBottom:12 }}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              <div style={{ display:'flex',gap:8 }}>
                <button onClick={()=>{setShowScheduleForm(false);setScheduleForm({name:'',date:''})}}
                  style={{ flex:1,padding:'9px',borderRadius:8,border:`1px solid ${HAIR}`,background:'transparent',color:TXT3,cursor:'pointer',fontSize:13 }}>Отмена</button>
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
            <div key={pw.id} style={{ background:SURF,borderRadius:12,padding:'12px 14px',marginBottom:8,border:`1.5px dashed ${PUR}55`,display:'flex',justifyContent:'space-between',alignItems:'center' }}>
              <div>
                <div style={{ fontSize:13,fontWeight:500,color:TXT }}>{pw.name}</div>
                <div style={{ fontSize:11,color:PUR,marginTop:2 }}>📅 Запланировано · {fmtFull(pw.date)}</div>
              </div>
              {!readOnly&&(
              <div style={{ display:'flex',gap:8,alignItems:'center' }}>
                <button onClick={()=>{if(onWorkoutAction)onWorkoutAction('start',{id:pw.id,name:pw.name})}}
                  style={{ fontSize:11,padding:'5px 10px',borderRadius:7,border:`1px solid ${PUR}`,background:`${PUR}22`,color:PUR,cursor:'pointer',fontWeight:500 }}>▶ Начать</button>
                <button onClick={()=>deletePlanned(pw.id)}
                  style={{ fontSize:14,padding:'4px 9px',borderRadius:7,border:`1px solid ${HAIR}`,background:'transparent',color:TXT3,cursor:'pointer',lineHeight:1 }}><GlassIcon name="close" size={26} /></button>
              </div>
              )}
            </div>
          ))}

          {sorted.length===0&&plannedWorkouts.length===0?(
            <div style={{ textAlign:'center',color:TXT3,fontSize:13,marginTop:60 }}>
              <div style={{ display:'flex',justifyContent:'center',marginBottom:12 }}><GlassIcon name="dumbbell" size={44} /></div>
              Нажми «+», чтобы добавить тренировку
            </div>
          ):sorted.map((w,i)=>(
            <div key={i} style={{ marginBottom:8,position:'relative' }}>
              <div data-testid={`workout-card-${i}`} style={{ background:SURF,borderRadius:13,boxShadow:'0 1px 4px rgba(0,0,0,0.07)',padding:'14px 16px',cursor:'pointer',border:selIdx===i?`1.5px solid ${PUR}33`:'1.5px solid transparent' }}
                onClick={()=>{setSelIdx(selIdx===i?null:i);setOpenCardMenu(null)}}>
                <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start' }}>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:14,fontWeight:600,color:TXT }}>{w.name}</div>
                    <div style={{ fontSize:11,color:TXT3,marginTop:2 }}>
                      {fmtFull(w.date)}
                      {/* Запись внёс тренер, а не сам владелец дневника
                          (workouts.created_by). Без пометки такая тренировка
                          выглядит как «я этого не записывал, откуда это». */}
                      {w.createdBy&&<span style={{ color:PUR,fontWeight:600 }}> · записал тренер</span>}
                    </div>
                  </div>
                  <div style={{ display:'flex',alignItems:'flex-start',gap:8,flexShrink:0 }}>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:16,fontWeight:700,color:PUR }}>{w.ton} кг</div>
                      <div style={{ fontSize:10,color:TXT3 }}>тоннаж</div>
                    </div>
                    {/* Три точки */}
                    {!readOnly&&<div ref={openCardMenu===i?cardMenuRef:null} style={{ position:'relative' }}>
                      <button data-testid={`card-menu-trigger-${i}`} onClick={e=>{e.stopPropagation();setOpenCardMenu(openCardMenu===i?null:i);setShowWorkoutMenu(false)}}
                        style={{ width:28,height:28,borderRadius:7,border:`1px solid ${HAIR}`,background:SURF2,cursor:'pointer',fontSize:17,color:TXT3,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,letterSpacing:1 }}>⋯</button>
                      {openCardMenu===i&&(
                        <div data-testid="card-menu" onClick={e=>e.stopPropagation()} style={{ position:'absolute',top:34,right:0,background:SURF,borderRadius:12,boxShadow:'0 6px 24px rgba(0,0,0,0.14)',zIndex:20,minWidth:200,overflow:'hidden',border:`1px solid ${HAIR}` }}>
                          {[
                            {ic:'pen',label:'Редактировать тренировку',test:'edit'},
                            {ic:'copy',label:'Копировать тренировку',test:'copy'},
                            {ic:'template',label:'Сделать шаблон',test:'template'},
                            {ic:'trash',label:'Удалить тренировку',danger:true,test:'delete'},
                          ].map((item,idx)=>(
                            <button key={idx} data-testid={`card-menu-${item.test}`} onClick={async()=>{
                              setOpenCardMenu(null)
                              if(item.label==='Редактировать тренировку'){if(onEditWorkout)onEditWorkout(workoutHistory[w.histIdx],w.histIdx)}
                              else if(item.label==='Копировать тренировку'){if(onCopyWorkout)onCopyWorkout(workoutHistory[w.histIdx])}
                              else if(item.label==='Сделать шаблон'){saveTemplate(workoutHistory[w.histIdx])}
                              else if(item.label==='Удалить тренировку'){
                                if(await askConfirm(`Удалить тренировку «${w.name}»?`)){if(onDeleteWorkout)onDeleteWorkout(w.histIdx);setSelIdx(null)}
                              }
                            }} style={{ display:'flex',alignItems:'center',gap:10,width:'100%',padding:'11px 15px',border:'none',borderTop:idx>0?`1px solid ${HAIR}`:'none',background:'transparent',cursor:'pointer',textAlign:'left',color:item.danger?'#ef4444':TXT,fontSize:13 }}>
                              <GlassIcon name={item.ic} size={26} />{item.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>}
                  </div>
                </div>
                <div style={{ display:'flex',gap:12,marginTop:8 }}>
                  <span style={{ fontSize:11,color:TXT3 }}><GlassIcon name="dumbbell" size={14} style={{verticalAlign:"-3px",marginRight:4}} />{w.exercises.length} упр.</span>
                  <span style={{ fontSize:11,color:TXT3 }}><GlassIcon name="notebook" size={14} style={{verticalAlign:"-3px",marginRight:4}} />{w.exercises.reduce((s,ex)=>s+(ex.sets||[]).filter(s=>s.kg||s.reps).length,0)} подх.</span>
                </div>
              </div>
              {selIdx===i&&(
                <Card style={{ marginTop:4,border:`1.5px solid ${PUR}22` }}>
                  {/* Комментарий к тренировке — пишет сам клиент при сохранении.
                      Только показ: редактирование живёт в редакторе тренировки. */}
                  {w.comment&&<div style={{ fontSize:12,color:TXT3,marginBottom:8 }}>💬 {w.comment}</div>}
                  {w.exercises.map((ex,ei)=>{
                    const exTon=(ex.sets||[]).reduce((s,set)=>s+(parseFloat(set.kg)||0)*(parseInt(set.reps)||0),0)
                    return(
                      <div key={ei} style={{ paddingTop:ei>0?10:0,borderTop:ei>0?`1px solid ${HAIR}`:'' }}>
                        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4 }}>
                          <span style={{ fontSize:13,fontWeight:500,color:TXT }}>{labelOf(catalogExercises,ex.n)}</span>
                          {exTon>0&&<span style={{ fontSize:11,color:PUR,fontWeight:600 }}>{exTon} кг</span>}
                        </div>
                        <div style={{ display:'flex',gap:5,flexWrap:'wrap' }}>
                          {(ex.sets||[]).map((s,si)=>(s.kg||s.reps)&&(
                            <span key={si} style={{ fontSize:11,color:TXT3,background:SURF2,padding:'2px 8px',borderRadius:5 }}>
                              {si+1}. {setWeightLabel(s)} × {s.reps||'—'}
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
    return <FoodDiary
      userId={userId}
      readOnly={readOnly}
      readOnlyName={readOnlyName}
      onClose={()=>setSection(null)}
    />
  }

  if(section==='onerm'){
    const directRM=oneRepMax(rmWeight,rmReps,'epley')
    const reverseW=weightForReps(rmTargetRM,rmTargetReps,'epley')
    const tableSource=rmTableRM || (directRM?directRM.toFixed(1):'')
    const table=percentTable(tableSource,'epley')
    const tabBtn=(mode,label)=>(
      <button onClick={()=>{if(mode==='table'&&!rmTableRM&&directRM)setRmTableRM(roundToPlate(directRM).toString());setRmMode(mode)}}
        style={{ flex:1,padding:'10px 6px',borderRadius:9,border:'none',background:rmMode===mode?PUR:SURF2,color:rmMode===mode?'#fff':TXT3,fontSize:12.5,fontWeight:600,cursor:'pointer',minHeight:'unset' }}>
        {label}
      </button>
    )
    const inputStyle={ width:'100%',padding:'11px 12px',fontSize:15,borderRadius:9,border:`1.5px solid ${HAIR}`,outline:'none',boxSizing:'border-box',color:TXT,background:SURF }
    const fieldLabel={ fontSize:12,color:TXT3,marginBottom:5,fontWeight:600 }
    return createPortal(
      <div style={{ position:'fixed',inset:0,background:BG,zIndex:1000,display:'flex',flexDirection:'column' }}>
        <div style={{ background:SURF,borderBottom:`1px solid ${HAIR}`,padding:'14px 16px',display:'flex',alignItems:'center',gap:10,flexShrink:0 }}>
          <button data-back="1" onClick={()=>setSection(null)} style={{ background:'none',border:'none',fontSize:24,cursor:'pointer',color:TXT3,lineHeight:1,padding:0,minHeight:'unset' }}><GlassIcon name="back" size={26} /></button>
          <span style={{ fontSize:17,fontWeight:700,color:TXT,flex:1 }}><GlassIcon name="calculator" size={28} style={{marginRight:8,verticalAlign:'-6px'}} />{sectionTitle('Калькулятор 1ПМ')}</span>
        </div>
        <div style={{ flex:1,overflowY:'auto',padding:'14px 16px 32px' }}>

          {/* Табы режимов */}
          <div style={{ display:'flex',gap:8,marginBottom:14 }}>
            {tabBtn('direct','Прямой')}
            {tabBtn('reverse','Обратный')}
            {tabBtn('table','Таблица %')}
          </div>

          {rmMode==='direct'&&(
            <>
              <Card style={{ marginBottom:12 }}>
                <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:10 }}>
                  <div>
                    <div style={fieldLabel}>Вес, кг</div>
                    <input type="number" inputMode="decimal" placeholder="100" value={rmWeight} onChange={e=>setRmWeight(e.target.value)}
                      style={inputStyle} onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                  </div>
                  <div>
                    <div style={fieldLabel}>Повторения</div>
                    <input type="number" inputMode="numeric" placeholder="5" value={rmReps} onChange={e=>setRmReps(e.target.value)}
                      style={inputStyle} onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                  </div>
                </div>
              </Card>
              <Card style={{ textAlign:'center',padding:'22px 16px' }}>
                <div style={{ fontSize:12,color:TXT3,fontWeight:600,marginBottom:6 }}>Твой 1ПМ</div>
                <div style={{ fontSize:40,fontWeight:800,color:PUR,lineHeight:1 }}>
                  {directRM?`≈ ${roundToPlate(directRM)} кг`:'—'}
                </div>
              </Card>
            </>
          )}

          {rmMode==='reverse'&&(
            <>
              <Card style={{ marginBottom:12 }}>
                <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:10 }}>
                  <div>
                    <div style={fieldLabel}>1ПМ, кг</div>
                    <input type="number" inputMode="decimal" placeholder="120" value={rmTargetRM} onChange={e=>setRmTargetRM(e.target.value)}
                      style={inputStyle} onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                  </div>
                  <div>
                    <div style={fieldLabel}>Хочу повторений</div>
                    <input type="number" inputMode="numeric" placeholder="8" value={rmTargetReps} onChange={e=>setRmTargetReps(e.target.value)}
                      style={inputStyle} onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                  </div>
                </div>
              </Card>
              <Card style={{ textAlign:'center',padding:'22px 16px' }}>
                <div style={{ fontSize:12,color:TXT3,fontWeight:600,marginBottom:6 }}>Рабочий вес</div>
                <div style={{ fontSize:40,fontWeight:800,color:PUR,lineHeight:1 }}>
                  {reverseW?`≈ ${roundToPlate(reverseW)} кг`:'—'}
                </div>
              </Card>
            </>
          )}

          {rmMode==='table'&&(
            <>
              <Card style={{ marginBottom:12 }}>
                <div style={fieldLabel}>1ПМ, кг</div>
                <input type="number" inputMode="decimal" placeholder="120" value={rmTableRM} onChange={e=>setRmTableRM(e.target.value)}
                  style={inputStyle} onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              </Card>
              {table.length>0?(
                <Card style={{ padding:0,overflow:'hidden' }}>
                  <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',padding:'10px 14px',background:SURF2,borderBottom:`1px solid ${HAIR}` }}>
                    <div style={{ fontSize:11,color:TXT3,fontWeight:700 }}>Повторы</div>
                    <div style={{ fontSize:11,color:TXT3,fontWeight:700,textAlign:'center' }}>% от 1ПМ</div>
                    <div style={{ fontSize:11,color:TXT3,fontWeight:700,textAlign:'right' }}>Вес</div>
                  </div>
                  {table.map((row,i)=>(
                    <div key={row.reps} style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',padding:'11px 14px',borderBottom:i<table.length-1?`1px solid ${HAIR}`:'none' }}>
                      <div style={{ fontSize:14,fontWeight:700,color:TXT }}>{row.reps}</div>
                      <div style={{ fontSize:13,color:TXT3,textAlign:'center' }}>≈{row.percent}%</div>
                      <div style={{ fontSize:14,fontWeight:700,color:PUR,textAlign:'right' }}>≈ {row.weight} кг</div>
                    </div>
                  ))}
                </Card>
              ):(
                <div style={{ textAlign:'center',color:TXT3,fontSize:13,padding:'20px 0' }}>Введи 1ПМ, чтобы увидеть таблицу</div>
              )}
            </>
          )}
        </div>
      </div>
    , document.body)
  }

  // ── ГЛАВНАЯ: папки
  const totalTon=allWorkoutTons.reduce((s,w)=>s+w.ton,0)
  const FOLDERS_DIARY=[
    {key:'tonnage',ic:'scale',label:'Общий тоннаж',color:PUR,sub:`${totalTon.toLocaleString('ru')} кг · ${allWorkoutTons.length} ${plural(allWorkoutTons.length,'тренировка','тренировки','тренировок')}`},
    {key:'exercises',ic:'chart',label:'Прогресс по упражнениям',color:TEA,sub:`${exerciseNames.length} ${plural(exerciseNames.length,'упражнение','упражнения','упражнений')} отслеживается`},
    {key:'workouts',ic:'dumbbell',label:'Мои тренировки',color:COR,sub:allWorkoutTons.length>0?`Последняя: ${fmtFull(allWorkoutTons[allWorkoutTons.length-1].date)}`:'Нет записей'},
    // Карточка «Питание» отсюда убрана: дневник еды переехал во вкладку
    // «Питание» и стал её главным экраном. Секция section==='food' ниже
    // остаётся рабочей — по ней тренер смотрит питание клиента в его карточке
    // (RealClientDetail рендерит этот же DiaryView с readOnly).
    {key:'onerm',ic:'calculator',label:'Калькулятор 1ПМ',color:'#F59E0B',sub:''},
  ]
  return(
    <div>
      <h2 style={{ fontSize:20,fontWeight:500,color:TXT,margin:'0 0 16px' }}>Прогресс</h2>
      {/* Статус загрузки истории тренировок — иначе при сбое папки тоннажа/
          упражнений/тренировок молча показывали бы нули, будто данных нет.
          Питания не касается (у него своя загрузка). */}
      {historyLoadError?(
        <div style={{ display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',background:SURF,border:`1px solid ${HAIR}`,borderRadius:14,padding:'12px 16px',marginBottom:10 }}>
          <span style={{ fontSize:13,color:DANGER,fontWeight:600,flex:1,minWidth:0 }}>Не удалось загрузить историю тренировок</span>
          <button onClick={onRetryHistory} style={{ fontSize:12,fontWeight:600,padding:'7px 16px',borderRadius:10,border:`1px solid ${HAIR}`,background:SURF2,color:PUR,cursor:'pointer',minHeight:'unset',flexShrink:0 }}>Повторить</button>
        </div>
      ):historyLoading&&workoutHistory.length===0?(
        <div style={{ fontSize:12,color:TXT3,marginBottom:10 }}>Загрузка истории…</div>
      ):null}
      {FOLDERS_DIARY.map(f=>{
        // Заперт только "Прогресс по упражнениям"; соседние разделы бесплатны.
        const locked=f.key==='exercises'&&exercisesLocked
        return (
        <HubCard key={f.key}
          testId={`diary-section-${f.key}`}
          icon={f.ic}
          title={f.label}
          subtitle={locked?'Доступно в пакете БАЗА':f.sub}
          locked={locked}
          onClick={()=>{if(locked){setShowExLock(true);return}if(f.key==='exercises'){setExPeriod('all');setExCustomFrom('');setExCustomTo('')}setSection(f.key)}} />
        )
      })}
      {showExLock&&createPortal(
        <PlanLockModal {...LOCK_EXERCISES} onClose={()=>setShowExLock(false)}
          onOpenPlans={()=>{setShowExLock(false);openPlans?.()}} />,
        document.body)}
    </div>
  )
}

// Иконки меню — гибрид: game-icons для спорта/еды (фирменные силуэты),
// solar bold-duotone для UI-разделов. Вшиты офлайн (см. src/icons.jsx).
// color — «свой» цвет пункта, применяется на активной вкладке.
const NAV=[
  {id:'dashboard',ic:'house',label:'Главная'},
  {id:'clients',ic:'people',label:'Клиенты'},
  {id:'workouts',ic:'dumbbell',label:'Тренировки'},
  {id:'nutrition',ic:'food',label:'Питание'},
  {id:'library',ic:'book',label:'Упражнения'},
  {id:'progress',ic:'notebook',label:'Прогресс'},
]
const NAV_MOBILE=[
  {id:'workouts',ic:'dumbbell',label:'Тренировки'},
  {id:'nutrition',ic:'food',label:'Питание'},
  {id:'library',ic:'book',label:'Упражнения'},
  {id:'progress',ic:'notebook',label:'Прогресс'},
  {id:'clients',ic:'people',label:'Клиенты'},
]

// Поле пароля с кнопкой-глазиком (показать/скрыть) — переиспользуется на
// экранах входа, регистрации и смены пароля, чтобы вид/поведение совпадали
// и не дублировался код. Видимость — своё состояние на каждый инстанс.
function PasswordInput({ value, onChange, placeholder, onKeyDown }) {
  const [visible,setVisible]=useState(false)
  return (
    <div style={{ position:'relative' }}>
      <input value={value} type={visible?'text':'password'} placeholder={placeholder}
        onChange={onChange} onKeyDown={onKeyDown}
        style={{ width:'100%',padding:'12px 40px 12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
        onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
      <button type="button" onClick={()=>setVisible(v=>!v)} aria-label={visible?'Скрыть пароль':'Показать пароль'}
        style={{ position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',padding:4,cursor:'pointer',fontSize:16,color:'rgba(255,255,255,0.45)',lineHeight:1,minHeight:'unset' }}
        onMouseEnter={e=>e.currentTarget.style.color='rgba(255,255,255,0.8)'}
        onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,0.45)'}>
        {visible?'👁‍🗨':'👁'}
      </button>
    </div>
  )
}

// accessError — сообщение о неудачном входе по ссылке доступа (?access=,
// см. App). Показывается плашкой в шапке: клиент, которого завёл тренер, попал
// сюда не по своей воле, и обычная форма входа ему ничего не говорит — у него
// нет ни пароля, ни почты, только ссылка.
function LandingPage({ onEnter, isTelegram, accessError }) {
  const [view,setView]=useState('hero')
  const [authTab,setAuthTab]=useState('login')
  const [form,setForm]=useState({name:'',email:'',password:'',confirm:''})
  const [mobile,setMobile]=useState(()=>window.innerWidth<640)
  const [authError,setAuthError]=useState('')
  const [forgotMode,setForgotMode]=useState(false)
  const [forgotEmail,setForgotEmail]=useState('')
  const [forgotDone,setForgotDone]=useState(false)
  const [forgotBusy,setForgotBusy]=useState(false)
  const [forgotError,setForgotError]=useState('')

  useEffect(()=>{
    const fn=()=>setMobile(window.innerWidth<640)
    window.addEventListener('resize',fn)
    return()=>window.removeEventListener('resize',fn)
  },[])

  const switchTab=(tab)=>{setAuthTab(tab);setAuthError('');setForgotMode(false);setForgotDone(false);setForgotError('');setForm({name:'',email:'',password:'',confirm:''})}

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
    if(!form.email.trim()||!form.password.trim()){setAuthError('Введи почту и пароль');return}
    setAuthBusy(true);setAuthError('')
    const{error}=await supabase.auth.signInWithPassword({email:form.email.trim(),password:form.password})
    // Блокировку от перебора (Auth Hook, sql/2026-07-26_login_bruteforce.sql) показываем
    // текстом из базы: иначе человек видел бы «неверная почта или пароль» при верном пароле
    // и не понимал, что нужно просто подождать. Остальные ошибки по-прежнему схлопываем в
    // общий текст, чтобы не подсказывать, существует ли аккаунт.
    if(error){setAuthError(error.message?.includes('попыток входа')?error.message:'Неверная почта или пароль');setAuthBusy(false);return}
    setAuthBusy(false)
    // onAuthStateChange в App() автоматически установит пользователя
  }

  const handleForgot=async()=>{
    if(!forgotEmail.trim()){setForgotError('Введи почту');return}
    setForgotBusy(true);setForgotError('')
    const{error}=await supabase.auth.resetPasswordForEmail(forgotEmail.trim(),{redirectTo:window.location.origin})
    if(error){setForgotError(error.message);setForgotBusy(false);return}
    setForgotBusy(false)
    setForgotDone(true)
  }

  const G='rgba(255,255,255,0.06)'
  const GB='1px solid rgba(255,255,255,0.09)'

  return(
    <div style={{ minHeight:'100vh',background:BG,color:'#fff',fontFamily:'system-ui,-apple-system,sans-serif',overflowX:'hidden' }}>

      {/* ── Шапка */}
      <div style={{ padding:'13px 22px',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid rgba(255,255,255,0.07)',position:'sticky',top:0,background:'rgba(8,8,15,0.92)',backdropFilter:'blur(12px)',zIndex:20 }}>
        <div style={{ display:'flex',alignItems:'center',gap:9 }}>
          <GlassIcon name="dumbbell" size={26} />
          <span style={{ fontSize:18,fontWeight:800,letterSpacing:'-0.5px' }}>FitPro</span>
        </div>
        <div style={{ display:'flex',gap:8,alignItems:'center' }}>
          <button onClick={()=>openForm('login')}
            style={{ padding:'7px 20px',borderRadius:8,border:`1px solid ${PUR}60`,background:`${PUR}20`,color:'#c4c0f7',fontSize:13,fontWeight:600,cursor:'pointer' }}>
            Войти
          </button>
        </div>
      </div>

      {accessError&&(
        <div style={{ maxWidth:900,margin:'0 auto',padding:mobile?'16px 18px 0':'16px 28px 0' }}>
          <div style={{ padding:'13px 16px',borderRadius:12,background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.45)',color:'#fca5a5',fontSize:13,lineHeight:1.45,textAlign:'center' }}>
            {accessError}
          </div>
        </div>
      )}

      {view==='hero'?(
        <div style={{ maxWidth:900,margin:'0 auto',padding:mobile?'0 18px':'0 28px' }}>

          {/* ── Hero */}
          <div style={{ padding:mobile?'52px 0 44px':'80px 0 60px',textAlign:'center',background:`radial-gradient(ellipse at 50% -10%, ${PUR}30 0%, transparent 62%)` }}>

            {/* Бейдж */}
            <div style={{ display:'inline-flex',alignItems:'center',gap:7,background:`linear-gradient(90deg,${PUR}35,#5b54c420)`,border:`1px solid ${PUR}70`,borderRadius:20,padding:'6px 16px',fontSize:12,color:'#d0ccff',marginBottom:22,fontWeight:700,letterSpacing:'0.5px',boxShadow:`0 0 18px ${PUR}30` }}>
              {/* Было «Первое приложение с AI-ассистентом» — утверждение,
                  которое невозможно подтвердить и легко опровергнуть. Заменено
                  на проверяемое: ассистент действительно обучен тренером. */}
              <GlassIcon name="bulb" size={18} /> AI-ассистент, обученный тренером
            </div>

            <h1 style={{ fontSize:mobile?32:56,fontWeight:800,lineHeight:1.12,margin:'0 0 32px',background:'linear-gradient(150deg,#fff 45%,#9d97e8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent' }}>
              Твой персональный<br />тренер всегда<br />рядом
            </h1>

            {/* «Попробовать» читалось как пробный период: человек решал, что
                дальше придётся платить, и уходил. На СТАРТ (plans.js, level 0)
                бессрочно доступны дневник тренировок и питания, рационы,
                аналитика, библиотека и первые 3 тренировки в каждом шаблоне —
                это не проба, а рабочий бесплатный тариф. */}
            <button onClick={()=>openForm('register')}
              style={{ padding:'15px 40px',borderRadius:14,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:17,fontWeight:700,cursor:'pointer',boxShadow:`0 10px 32px ${PUR}55` }}>
              Начать
            </button>
            <div style={{ fontSize:13,color:TXT3,textAlign:'center',marginTop:10,marginBottom:52 }}>
              Дневник тренировок и питания — бесплатно, без ограничения по времени
            </div>

            {/* ── AI-персонаж */}
            <div style={{ textAlign:'left',background:'rgba(255,255,255,0.03)',border:`1px solid ${PUR}35`,borderRadius:20,overflow:'hidden',boxShadow:`0 0 48px ${PUR}18` }}>

              {/* Хедер карточки */}
              <div style={{ background:`linear-gradient(90deg,${PUR}28,transparent)`,borderBottom:`1px solid ${PUR}25`,padding:'16px 20px',display:'flex',alignItems:'center',gap:14 }}>
                <div style={{ position:'relative',flexShrink:0 }}>
                  <div style={{ width:52,height:52,borderRadius:'50%',background:`linear-gradient(135deg,${PUR},#4d47b0)`,display:'flex',alignItems:'center',justifyContent:'center',boxShadow:`0 4px 16px ${PUR}50` }}><GlassIcon name="robot" size={40} /></div>
                  <div style={{ position:'absolute',bottom:2,right:2,width:13,height:13,borderRadius:'50%',background:'#22c55e',border:'2.5px solid #0d0d1a' }} />
                </div>
                <div>
                  <div style={{ fontSize:16,fontWeight:700,color:'#fff' }}>FitPro AI</div>
                  <div style={{ fontSize:12,color:'rgba(255,255,255,0.4)',marginTop:2 }}>Обучен твоим тренером</div>
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
                        ['template','Знаю твою программу тренировок — вижу, какой вес был в прошлый раз'],
                        ['food','Помогу с питанием — спроси, что съесть, что заменить или как вписать любимое'],
                        ['gear','Скорректирую план, если было слишком тяжело или слишком легко'],
                        ['chat','Отвечаю так, как ответил бы сам тренер — потому что он меня именно так обучил'],
                      ].map(([ic,tx],i)=>(
                        <div key={i} style={{ display:'flex',gap:9,alignItems:'flex-start',background:'rgba(255,255,255,0.04)',borderRadius:9,padding:'8px 11px' }}>
                          <GlassIcon name={ic} size={22} style={{marginTop:1}} />
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
              {icon:'template',title:'Программы тренировок от maxim_athlete',desc:'Готовые программы под твои цели. Просто запусти тренировку — все упражнения, вес и подходы уже внутри'},
              {icon:'dumbbell',title:'Умный журнал тренировок',desc:'Записывай кг и повторы прямо в процессе тренировки, оставляй заметки для тренера или AI-ассистента'},
              {icon:'plate',title:'Умный дневник питания',desc:'Умеет не только считать КБЖУ, но и даёт рекомендации — что на что заменить'},
              {icon:'chart',title:'Достижения',desc:'Аналитика общего тоннажа тренировок, прогресс по каждому упражнению и аналитика питания'},
            ].map((f,i)=>(
              <div key={i} style={{ background:G,border:GB,borderRadius:16,padding:'20px 18px',display:'flex',gap:14,alignItems:'flex-start',textAlign:'left' }}>
                <GlassIcon name={f.icon} size={34} style={{marginTop:2}} />
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
              Теперь тренировки станут ещё комфортнее
            </div>
          </div>

          {/* ── Кнопка внизу */}
          <div style={{ textAlign:'center',paddingBottom:52 }}>
            <button onClick={()=>openForm('register')}
              style={{ padding:'15px 44px',borderRadius:14,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:17,fontWeight:700,cursor:'pointer',boxShadow:`0 10px 32px ${PUR}50` }}>
              Начать
            </button>
            <div style={{ fontSize:13,color:TXT3,textAlign:'center',marginTop:10 }}>
              Дневник тренировок и питания — бесплатно, без ограничения по времени
            </div>
          </div>

        </div>
      ):(
        /* ── Форма входа / регистрации */
        <div style={{ minHeight:'calc(100vh - 62px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'28px 18px' }}>
          <div style={{ width:'100%',maxWidth:400 }}>
            <button data-back="1" onClick={()=>{setView('hero');setAuthError('');setForgotMode(false);setForgotError('')}} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.38)',fontSize:14,cursor:'pointer',padding:'0 0 18px',display:'flex',alignItems:'center',gap:6 }}>
              <GlassIcon name="back" size={16} />Назад
            </button>
            <div style={{ background:'rgba(255,255,255,0.04)',border:GB,borderRadius:20,padding:'30px 24px' }}>

              {forgotMode ? (
                /* ── Восстановление пароля */
                <div>
                  <button data-back="1" onClick={()=>{setForgotMode(false);setForgotDone(false);setForgotEmail('');setForgotError('')}} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.38)',fontSize:13,cursor:'pointer',padding:'0 0 16px',display:'flex',alignItems:'center',gap:5 }}>
                    <GlassIcon name="back" size={15} />Назад к входу
                  </button>
                  <h2 style={{ fontSize:20,fontWeight:800,margin:'0 0 6px' }}>Восстановление пароля</h2>
                  <p style={{ fontSize:13,color:'rgba(255,255,255,0.38)',margin:'0 0 22px',lineHeight:1.65 }}>
                    Введи почту — пришлём инструкции по восстановлению
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
                        <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Эл. почта</label>
                        <input value={forgotEmail} type="email" placeholder="ivan@example.com"
                          onChange={e=>{setForgotEmail(e.target.value);setForgotError('')}}
                          onKeyDown={e=>e.key==='Enter'&&!forgotBusy&&handleForgot()}
                          style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                          onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                      </div>
                      {forgotError && (
                        <div style={{ padding:'10px 14px',borderRadius:9,background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.3)',fontSize:13,color:'#fca5a5' }}>
                          {forgotError}
                        </div>
                      )}
                      <button onClick={handleForgot} disabled={!forgotEmail.trim()||forgotBusy}
                        style={{ padding:'14px',borderRadius:11,border:'none',background:(forgotEmail.trim()&&!forgotBusy)?PUR:`${PUR}35`,color:'#fff',fontSize:15,fontWeight:700,cursor:(forgotEmail.trim()&&!forgotBusy)?'pointer':'default',transition:'all 0.15s' }}>
                        {forgotBusy?'Отправка...':'Отправить инструкции'}
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
                      <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Эл. почта <span style={{ color:COR }}>*</span></label>
                      <input value={form.email} type="email" placeholder="ivan@example.com"
                        onChange={e=>{setForm(v=>({...v,email:e.target.value}));setAuthError('')}}
                        onKeyDown={e=>e.key==='Enter'&&(authTab==='login'?handleLogin():handleRegister())}
                        style={{ width:'100%',padding:'12px 14px',borderRadius:10,border:'1.5px solid rgba(255,255,255,0.1)',background:'rgba(255,255,255,0.05)',color:'#fff',fontSize:14,outline:'none',boxSizing:'border-box' }}
                        onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.1)'} />
                    </div>

                    <div>
                      <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Пароль <span style={{ color:COR }}>*</span></label>
                      <PasswordInput value={form.password} placeholder="Минимум 6 символов"
                        onChange={e=>{setForm(v=>({...v,password:e.target.value}));setAuthError('')}}
                        onKeyDown={e=>e.key==='Enter'&&(authTab==='login'?handleLogin():handleRegister())} />
                    </div>

                    {authTab==='register' && (
                      <div>
                        <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Подтверди пароль <span style={{ color:COR }}>*</span></label>
                        <PasswordInput value={form.confirm} placeholder="Повтори пароль"
                          onChange={e=>{setForm(v=>({...v,confirm:e.target.value}));setAuthError('')}}
                          onKeyDown={e=>e.key==='Enter'&&handleRegister()} />
                      </div>
                    )}

                    {authError && (
                      <div style={{ padding:'10px 14px',borderRadius:9,background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.3)',fontSize:13,color:'#fca5a5' }}>
                        {authError}
                      </div>
                    )}

                    <button onClick={authTab==='login'?handleLogin:handleRegister} disabled={authBusy}
                      style={{ padding:'14px',borderRadius:11,border:'none',background:authBusy?SURF2:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:15,fontWeight:700,cursor:authBusy?'not-allowed':'pointer',marginTop:2,boxShadow:`0 6px 22px ${PUR}44`,transition:'all 0.15s' }}>
                      {authBusy ? 'Подожди...' : authTab==='login' ? 'Войти →' : 'Создать аккаунт →'}
                    </button>

                    {authTab==='login' && !isTelegram && (
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

// ── ResetPasswordView ────────────────────────────────────────────────────────
// Показывается вместо LandingPage/основного приложения, пока App() держит
// recoveryMode===true (переход по ссылке из письма "Восстановление пароля" —
// supabase-js ловит токен из URL и создаёт временную сессию с событием
// PASSWORD_RECOVERY). Стиль карточки — тот же, что у форм LandingPage.
function ResetPasswordView({ onDone }) {
  const [newPassword,setNewPassword]=useState('')
  const [confirmPassword,setConfirmPassword]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [done,setDone]=useState(false)

  const handleSave=async()=>{
    if(!newPassword.trim()||!confirmPassword.trim()){setError('Заполни оба поля');return}
    if(newPassword!==confirmPassword){setError('Пароли не совпадают');return}
    if(newPassword.length<6){setError('Пароль минимум 6 символов');return}
    setBusy(true);setError('')
    const{error}=await supabase.auth.updateUser({password:newPassword})
    if(error){setError(error.message);setBusy(false);return}
    setBusy(false)
    setDone(true)
    // Временную recovery-сессию гасим сразу — иначе после onDone() (сброс
    // recoveryMode) user всё ещё не null и вместо экрана входа откроется
    // обычное приложение под старой сессией восстановления.
    await supabase.auth.signOut({ scope: 'local' }).catch(()=>{})
    setTimeout(onDone,1600)
  }

  const GB='1px solid rgba(255,255,255,0.09)'

  return(
    <div style={{ minHeight:'100vh',background:BG,color:'#fff',fontFamily:'system-ui,-apple-system,sans-serif',display:'flex',alignItems:'center',justifyContent:'center',padding:'28px 18px' }}>
      <div style={{ width:'100%',maxWidth:400 }}>
        <div style={{ background:'rgba(255,255,255,0.04)',border:GB,borderRadius:20,padding:'30px 24px' }}>
          {done ? (
            <div style={{ textAlign:'center',padding:'24px 0' }}>
              <div style={{ fontSize:42,marginBottom:14 }}>✅</div>
              <p style={{ fontSize:15,color:'#22c55e',fontWeight:700,margin:0 }}>Пароль изменён</p>
            </div>
          ) : (
            <div>
              <h2 style={{ fontSize:20,fontWeight:800,margin:'0 0 6px' }}>Новый пароль</h2>
              <p style={{ fontSize:13,color:'rgba(255,255,255,0.38)',margin:'0 0 22px',lineHeight:1.65 }}>
                Придумай новый пароль для входа
              </p>
              <div style={{ display:'flex',flexDirection:'column',gap:14 }}>
                <div>
                  <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Новый пароль</label>
                  <PasswordInput value={newPassword} placeholder="Минимум 6 символов"
                    onChange={e=>{setNewPassword(e.target.value);setError('')}}
                    onKeyDown={e=>e.key==='Enter'&&!busy&&handleSave()} />
                </div>
                <div>
                  <label style={{ fontSize:12,fontWeight:600,color:'rgba(255,255,255,0.45)',display:'block',marginBottom:6 }}>Подтверди пароль</label>
                  <PasswordInput value={confirmPassword} placeholder="Повтори пароль"
                    onChange={e=>{setConfirmPassword(e.target.value);setError('')}}
                    onKeyDown={e=>e.key==='Enter'&&!busy&&handleSave()} />
                </div>
                {error && (
                  <div style={{ padding:'10px 14px',borderRadius:9,background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.3)',fontSize:13,color:'#fca5a5' }}>
                    {error}
                  </div>
                )}
                <button onClick={handleSave} disabled={busy}
                  style={{ padding:'14px',borderRadius:11,border:'none',background:busy?SURF2:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:15,fontWeight:700,cursor:busy?'not-allowed':'pointer',marginTop:2,boxShadow:`0 6px 22px ${PUR}44`,transition:'all 0.15s' }}>
                  {busy?'Сохраняем...':'Сохранить пароль'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Открыть личный чат с пользователем по @нику. Внутри Mini App обычный
// window.open внешнюю ссылку открывает не всегда, поэтому там своя команда SDK.
// Функция общая: ею пользуются и список пользователей в аналитике, и журнал
// ошибок — иначе две копии логики разъезжаются при первой же правке.
const openTg=nick=>{const url='https://t.me/'+nick;if(window.Telegram?.WebApp)window.Telegram.WebApp.openTelegramLink(url);else window.open(url,'_blank')}

// Расшифровка context из error_log: в базе лежит технический ключ, а тренеру
// нужно понимать, ЧТО сломалось. Незнакомый ключ показываем как есть — так
// новый context из свежего кода виден сразу, а не прячется за «прочее».
const ERROR_CONTEXT_LABELS={
  ai_chat:'ИИ-ассистент',
  food_diary_write:'Дневник питания',
  workout_save:'Сохранение тренировки',
  workout_sets_save:'Сохранение тренировки',
  assigned_program_save:'Программа клиента',
}
const errorContextLabel=ctx=>ERROR_CONTEXT_LABELS[ctx]||ctx||'—'

// ── ErrorLogBlock ────────────────────────────────────────────────────────────
// «Последние ошибки» на экране аналитики: техжурнал сбоев у реальных
// пользователей (таблица error_log, пишется из src/logError.js).
//
// Ленивый по умолчанию: свёрнут и НИЧЕГО не грузит, пока тренер не тапнет по
// заголовку. Аналитика и без того делает два тяжёлых запроса при открытии —
// добавлять к ним третий ради блока, в который заглядывают раз в неделю, значит
// замедлять основной экран всем и всегда.
//
// Читать error_log вправе только тренер (политика error_log_trainer_reads,
// sql/2026-07-28_error_log.sql); у клиента запрос вернёт пусто. Компонент
// всё равно рисуется только при userRole==='trainer' — как и AnalyticsView.
//
// Внутри НЕ вызываем logError: сбой чтения журнала, записанный в тот же журнал,
// в плохом случае превращается в самоподдерживающийся поток строк.
function ErrorLogBlock({ userRole }) {
  const [open,setOpen]=useState(false)
  const [rows,setRows]=useState(null)
  // user_id → {name, tg_username}. Ник нужен, чтобы владелец мог написать
  // человеку прямо отсюда: журнал без контакта показывает, ЧТО сломалось, но не
  // даёт связаться с тем, У КОГО сломалось.
  const [people,setPeople]=useState({})
  const [counts,setCounts]=useState({d1:null,d7:null})
  const [loading,setLoading]=useState(false)
  const [failed,setFailed]=useState(false)
  const [expanded,setExpanded]=useState(null)

  const load=async()=>{
    setLoading(true);setFailed(false)
    try{
      const since=h=>new Date(Date.now()-h*3600e3).toISOString()
      // Счётчики считаем отдельными запросами с head+count: по списку из 50
      // строк их не получить — при полусотне ошибок за час обе цифры упёрлись
      // бы в лимит и врали.
      const [list,c1,c7]=await Promise.all([
        supabase.from('error_log').select('id,created_at,context,status,message,user_id')
          .order('created_at',{ascending:false}).limit(50),
        supabase.from('error_log').select('id',{count:'exact',head:true}).gte('created_at',since(24)),
        supabase.from('error_log').select('id',{count:'exact',head:true}).gte('created_at',since(24*7)),
      ])
      if(list.error||list.data==null)throw list.error||new Error('пустой ответ')
      setRows(list.data)
      setCounts({d1:c1.error?null:(c1.count??null),d7:c7.error?null:(c7.count??null)})
      // Имена и ники — ОДНИМ запросом по набору id из уже полученных строк, а не
      // по запросу на строку: полсотни последовательных запросов с телефона это
      // секунды ожидания на ровном месте.
      const ids=[...new Set(list.data.map(r=>r.user_id).filter(Boolean))]
      if(ids.length){
        const {data:profs}=await supabase.from('profiles').select('id,name,tg_username').in('id',ids)
        const map={};for(const p of profs||[])map[p.id]={name:p.name||null,tg_username:p.tg_username||null}
        setPeople(map)
      }
    }catch(e){
      // Только в консоль. Экран аналитики продолжает работать: блок независим
      // от остальных данных и рисуется отдельно от них.
      console.error('Журнал ошибок: не удалось загрузить:',e)
      setFailed(true)
    }finally{
      setLoading(false)
    }
  }

  const toggle=()=>{
    const next=!open
    setOpen(next)
    if(next&&rows==null&&!loading)load()
  }

  // Время по МСК независимо от часового пояса устройства: сдвигаем на +3 и
  // читаем UTC-полями (тот же приём, что в api/chat.js для дневного лимита).
  const fmtMsk=iso=>{
    const t=iso?new Date(iso).getTime():NaN
    if(!Number.isFinite(t))return '—'
    const d=new Date(t+3*3600e3)
    const p=n=>String(n).padStart(2,'0')
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth()+1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  }
  // Имя, если удалось сопоставить; иначе огрызок id — по нему хотя бы видно,
  // что ошибки у разных людей, а не у одного.
  const whoName=r=>people[r.user_id]?.name||(r.user_id?r.user_id.slice(0,8):'—')

  if(userRole!=='trainer')return null

  return (
    <div style={{ background:SURF, border:`1px solid ${HAIR}`, borderRadius:12, marginBottom:14, overflow:'hidden' }}>
      <div onClick={toggle} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', cursor:'pointer' }}>
        <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:600, color:TXT }}>Последние ошибки</span>
        {loading&&<span style={{ fontSize:11, color:TXT3, flexShrink:0 }}>загрузка…</span>}
        <span style={{ fontSize:16, color:TXT3, flexShrink:0 }}>{open?'▾':'›'}</span>
      </div>

      {open&&(
        <div style={{ borderTop:`1px solid ${HAIR}`, padding:'10px 12px 4px' }}>
          {failed&&(
            <div onClick={load} style={{ fontSize:12, color:TXT2, cursor:'pointer', padding:'4px 0 10px' }}>
              Не удалось загрузить журнал · <span style={{ color:TEA }}>повторить</span>
            </div>
          )}

          {rows&&(<>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:10 }}>
              <Metric label="Ошибок за 24 часа" value={counts.d1??'—'} color={counts.d1?'#ef4444':PUR} />
              <Metric label="Ошибок за 7 дней"  value={counts.d7??'—'} color={counts.d7?'#ef4444':PUR} />
            </div>

            {rows.length===0
              ? <div style={{ color:TXT3, fontSize:13, padding:'10px 0 14px', textAlign:'center' }}>Ошибок нет</div>
              : <div style={{ fontSize:11, color:TXT3, marginBottom:4 }}>Последние {rows.length}, новые сверху</div>}

            {rows.map(r=>{
              const rowOpen=expanded===r.id
              return (
                <div key={r.id} onClick={()=>setExpanded(rowOpen?null:r.id)}
                  style={{ borderTop:`1px solid ${HAIR}`, padding:'8px 0', cursor:'pointer' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:r.message?3:0 }}>
                    <span style={{ fontSize:11, color:TXT3, flexShrink:0 }}>{fmtMsk(r.created_at)}</span>
                    <span style={{ fontSize:12, fontWeight:600, color:TXT, flexShrink:0 }}>{errorContextLabel(r.context)}</span>
                    {r.status!=null&&(
                      <span style={{ fontSize:11, fontWeight:700, color:'#ef4444', flexShrink:0 }}>{r.status}</span>
                    )}
                    {/* Контакт. Есть ник — он и показывается, тапом открывается
                        чат; stopPropagation обязателен, иначе тот же тап ещё и
                        развернул бы текст ошибки, а это другое действие.
                        Ника нет (клиент заведён тренером по ссылке доступа) —
                        показываем имя и прямо говорим, что написать некуда. */}
                    <span style={{ flex:1, minWidth:0, fontSize:11, color:TXT3, textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {people[r.user_id]?.tg_username?(
                        <span onClick={e=>{e.stopPropagation();openTg(people[r.user_id].tg_username)}}
                          style={{ color:TEA, cursor:'pointer' }}>@{people[r.user_id].tg_username}</span>
                      ):(<>
                        {whoName(r)}
                        {r.user_id&&<span style={{ opacity:0.75 }}> · нет Telegram</span>}
                      </>)}
                    </span>
                  </div>
                  {/* Свёрнуто — две строки, тап разворачивает целиком: длинные
                      тексты ошибок Postgres иначе занимают пол-экрана. */}
                  {r.message&&(
                    <div style={{
                      fontSize:11.5, color:TXT2, lineHeight:1.45, wordBreak:'break-word',
                      ...(rowOpen?{}:{ display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }),
                    }}>{r.message}</div>
                  )}
                </div>
              )
            })}
          </>)}
        </div>
      )}
    </div>
  )
}

// ── AnalyticsView ────────────────────────────────────────────────────────────
// Экран тренера: только просмотр. Два запроса при открытии (профили + даты
// тренировок), сводка плитками и список пользователей. Никаких рассылок и
// действий — читаем и показываем. RLS открывает эти два запроса тренеру
// (политики trainer_reads_all_*), у остальных они вернут пусто; на всякий
// случай компонент всё равно рисуется только при userRole==='trainer'.
function AnalyticsView({ userRole }) {
  const [rows,setRows]=useState(null)        // профили (без тренера)
  const [wDates,setWDates]=useState({})       // id → дата последней тренировки (ISO)
  const [loading,setLoading]=useState(true)
  const [loadError,setLoadError]=useState(false)
  const [tileFilter,setTileFilter]=useState(null)
  const [planFilter,setPlanFilter]=useState('all')
  const [q,setQ]=useState('')
  const [expanded,setExpanded]=useState(null)
  const retryRef=useRef(null)

  // Загрузка с повторами как у каталога: сетевой сбой не оставляет пустой экран.
  const load=(attempt=0)=>{
    if(retryRef.current){clearTimeout(retryRef.current);retryRef.current=null}
    setLoading(true);setLoadError(false)
    Promise.all([
      supabase.from('profiles')
        .select('id,name,tg_username,created_at,last_seen,plan,plan_until,trial_until,trial_used,role,goal,weight,height')
        .order('created_at',{ascending:false}).limit(2000),
      supabase.from('workouts').select('user_id,date').limit(20000),
    ]).then(([pr,wr])=>{
      const DELAYS=[1500,4000,9000]
      if(pr.error||pr.data==null||wr.error||wr.data==null){
        console.error('Аналитика: ошибка загрузки'+((pr.error||wr.error)?`: ${(pr.error||wr.error).message||''}`:' — пустой ответ'))
        if(attempt<DELAYS.length){retryRef.current=setTimeout(()=>load(attempt+1),DELAYS[attempt]);return}
        setLoading(false);setLoadError(true);return
      }
      // Последняя тренировка на пользователя — максимальная дата.
      const last={}
      for(const w of wr.data){ if(!w.user_id||!w.date)continue; if(!last[w.user_id]||w.date>last[w.user_id])last[w.user_id]=w.date }
      // Тренера из цифр и списка исключаем.
      setRows(pr.data.filter(p=>p.role!=='trainer'))
      setWDates(last)
      setLoading(false);setLoadError(false)
    })
  }
  useEffect(()=>{ load(0); return()=>{if(retryRef.current)clearTimeout(retryRef.current)} },[]) // eslint-disable-line react-hooks/exhaustive-deps

  const now=Date.now()
  const ts=d=>{const t=d?new Date(d).getTime():NaN;return Number.isFinite(t)?t:null}
  const paidActive=p=>{const t=ts(p.plan_until);return t!=null&&t>now}
  const paidExpired=p=>{const t=ts(p.plan_until);return t!=null&&t<=now}
  const trialActive=p=>{const t=ts(p.trial_until);return t!=null&&t>now}
  // Пробный закончился и не купил: брал пробный, срок пробного в прошлом и нет
  // активной платной подписки. Это главная цифра — тёплые лиды на дожатие.
  const trialEndedNoBuy=p=>{const t=ts(p.trial_until);return !!p.trial_used && t!=null && t<=now && !paidActive(p)}
  const within=(p,days)=>{const t=ts(p.created_at);return t!=null && t>=now-days*864e5}
  const noWorkout=p=>!wDates[p.id]

  const TILES=[
    { key:'all',    label:'Всего зарегистрировано', pred:()=>true },
    { key:'d7',     label:'За 7 дней',             pred:p=>within(p,7) },
    { key:'d30',    label:'За 30 дней',            pred:p=>within(p,30) },
    { key:'paid',   label:'Платная активна',       pred:paidActive },
    { key:'trial',  label:'В пробном',             pred:trialActive },
    { key:'lead',   label:'Пробный кончился, не купил', pred:trialEndedNoBuy, highlight:true },
    { key:'exp',    label:'Подписка закончилась',  pred:p=>paidExpired(p)&&!paidActive(p) },
    { key:'nowk',   label:'Ни одной тренировки',   pred:noWorkout },
  ]

  // Пакет для строки/фильтра: активная платная — по её plan, иначе СТАРТ.
  const pkgKey=p=>paidActive(p)?(p.plan||'start'):'start'
  const subName=p=>{
    if(paidActive(p))return (planByKey(p.plan)?.name)||'СТАРТ'
    if(trialActive(p))return 'Пробный'
    return 'СТАРТ'
  }
  // Дата окончания активной подписки (для остатка дней): пробный приоритетнее,
  // если он активен и не ниже платного — как в effectiveAccess.
  const subUntil=p=>{ if(trialActive(p))return p.trial_until; if(paidActive(p))return p.plan_until; return null }
  // Остаток дней: число по активной подписке; прочерк, если бессрочно/истекло.
  const daysLeft=p=>{const u=subUntil(p);const t=ts(u);if(t==null||t<=now)return null;return Math.ceil((t-now)/864e5)}
  const fmtDate=d=>{const t=ts(d);return t==null?'—':new Date(t).toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})}

  const list=useMemo(()=>{
    let r=rows||[]
    const tile=TILES.find(t=>t.key===tileFilter)
    if(tile)r=r.filter(tile.pred)
    if(planFilter!=='all')r=r.filter(p=>pkgKey(p)===planFilter)
    const s=q.trim().toLowerCase()
    if(s)r=r.filter(p=>(p.name||'').toLowerCase().includes(s)||(p.tg_username||'').toLowerCase().includes(s))
    return r
  },[rows,wDates,tileFilter,planFilter,q]) // eslint-disable-line react-hooks/exhaustive-deps

  if(userRole!=='trainer')return null

  const pill=(k,l)=>{
    const on=planFilter===k
    return <button key={k} onClick={()=>setPlanFilter(k)} style={{ fontSize:12, padding:'5px 12px', borderRadius:20, cursor:'pointer', whiteSpace:'nowrap', border:`1px solid ${on?PUR:HAIR}`, background:on?'#EEEDFE':'transparent', color:on?'#3C3489':TXT3 }}>{l}</button>
  }

  return (
    <div style={{ padding:'14px 16px 40px' }}>
      {/* Свёрнутый блок ошибок — сверху и НАМЕРЕННО вне ветки rows&&: он ничего
          не грузит до тапа и не должен пропадать, если основная аналитика не
          загрузилась. Внизу экрана он был бы недосягаем — под ним список на
          сотни человек. */}
      <ErrorLogBlock userRole={userRole} />
      {loading&&!rows&&<div style={{ color:TXT3, fontSize:13, padding:'20px 0', textAlign:'center' }}>Загрузка…</div>}
      {loadError&&!rows&&(
        <div style={{ textAlign:'center', padding:'20px 0' }}>
          <div style={{ color:TXT2, fontSize:13, marginBottom:10 }}>Не удалось загрузить данные</div>
          <button onClick={()=>load(0)} style={{ fontSize:13, padding:'8px 16px', borderRadius:12, border:`1px solid ${HAIR}`, background:SURF2, color:TXT, cursor:'pointer' }}>Повторить</button>
        </div>
      )}
      {rows&&(<>
        {/* Плитки-сводка. Тап — фильтр списка, повторный тап — снять. */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:14 }}>
          {TILES.map(t=>{
            const active=tileFilter===t.key
            const count=rows.filter(t.pred).length
            return (
              <div key={t.key} onClick={()=>setTileFilter(active?null:t.key)}
                style={{ cursor:'pointer', borderRadius:16, border:`2px solid ${active?PUR:(t.highlight?'#ef4444':'transparent')}` }}>
                <Metric label={t.label} value={count} color={t.highlight?'#ef4444':PUR} />
              </div>
            )
          })}
        </div>

        {/* Фильтр по пакету. */}
        <div style={{ display:'flex', gap:8, overflowX:'auto', marginBottom:12, paddingBottom:2 }}>
          {pill('all','Все')}{pill('start','СТАРТ')}{pill('profit','ПРОФИТ')}{pill('premium','ПРЕМИУМ')}
        </div>

        {/* Поиск по имени и нику. */}
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск по имени или нику"
          style={{ width:'100%', boxSizing:'border-box', fontSize:14, padding:'10px 12px', borderRadius:12, border:`1px solid ${HAIR}`, background:SURF2, color:TXT, marginBottom:12, outline:'none' }} />

        <div style={{ fontSize:11, color:TXT3, marginBottom:8 }}>{list.length} {plural(list.length,'человек','человека','человек')}</div>

        {list.length===0&&<div style={{ color:TXT3, fontSize:13, padding:'16px 0', textAlign:'center' }}>Никого не найдено</div>}

        {list.map(p=>{
          const open=expanded===p.id
          const nick=p.tg_username?('@'+p.tg_username):(p.name||'Без имени')
          const dl=daysLeft(p)
          const su=subUntil(p)
          return (
            <div key={p.id} style={{ background:SURF, border:`1px solid ${HAIR}`, borderRadius:12, marginBottom:8, overflow:'hidden' }}>
              {/* Свёрнутая строка: ник/имя · пакет · остаток дней · метка пробного. */}
              <div onClick={()=>setExpanded(open?null:p.id)} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', cursor:'pointer' }}>
                <span style={{ flex:1, minWidth:0, fontSize:13, fontWeight:600, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nick}</span>
                <span style={{ fontSize:12, color:TXT3, flexShrink:0 }}>{subName(p)}</span>
                <span style={{ fontSize:13, fontWeight:700, color:TXT, flexShrink:0, minWidth:20, textAlign:'right' }}>{dl!=null?dl:'—'}</span>
                <span title={p.trial_used?'Пробный использован':'Пробный не брал'} style={{ fontSize:13, fontWeight:800, color:p.trial_used?TEA:'#ef4444', flexShrink:0, width:12, textAlign:'center' }}>П</span>
              </div>
              {open&&(
                <div style={{ borderTop:`1px solid ${HAIR}`, padding:'10px 12px', display:'flex', flexDirection:'column', gap:5, fontSize:12, color:TXT2 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:TXT }}>{p.name||'Без имени'}</div>
                  {p.tg_username&&(
                    <div onClick={()=>openTg(p.tg_username)} style={{ color:TEA, cursor:'pointer', width:'fit-content' }}>@{p.tg_username}</div>
                  )}
                  <div>Подписка: {subName(p)}{su?` · до ${fmtDate(su)}`:''}{dl!=null?` · осталось ${dl} ${plural(dl,'день','дня','дней')}`:''}</div>
                  <div>Цель: {p.goal||'—'} · Вес: {p.weight??'—'} · Рост: {p.height??'—'}</div>
                  <div>Пробный: {p.trial_used?`брал${p.trial_until?`, закончился ${fmtDate(p.trial_until)}`:''}`:'не брал'}</div>
                  <div>Регистрация: {fmtDate(p.created_at)}</div>
                  <div>Последний вход: {p.last_seen?fmtDate(p.last_seen):'не заходил после обновления'}</div>
                  <div>Последняя тренировка: {wDates[p.id]?fmtDate(wDates[p.id]):'не тренировался'}</div>
                </div>
              )}
            </div>
          )
        })}
      </>)}
    </div>
  )
}

// ── SettingsView ─────────────────────────────────────────────────────────────
// subPage/setSubPage подняты в App: под-страницы (Политика, Оферта) рисуются
// внутри Настроек, но кнопка «назад» живёт в шапке уровнем выше — без общего
// состояния она не знала бы, что открыта под-страница, и уводила бы сразу на
// Главную.
function SettingsView({ user, performLogout, onAccountDeleted, subPage, setSubPage, onProfileChanged, userRole }) {
  const load=(k,def)=>{try{return JSON.parse(localStorage.getItem(k)??'null')??def}catch{return def}}
  const [notifs,setNotifs]=useState(()=>normalizeNotifs(load('fitpro_notifs',null)))
  // Есть ли вообще куда слать напоминание. Считается ровно так же, как это
  // делает крон (см. telegramChatIdOf в src/config.js — зеркало extractChatId
  // из api/send-reminders.js): если chat_id не выводится, напоминание не уйдёт
  // никуда, и тумблер обязан это признать, а не молчать.
  const canNotify=!!telegramChatIdOf(user)
  const [units,setUnits]=useState(()=>load('fitpro_units',{weight:'kg',height:'cm'}))
  const [chatCount,setChatCount]=useState(null)
  const [clearConfirm,setClearConfirm]=useState(false)
  const [deleteConfirm,setDeleteConfirm]=useState(false)
  const [deleting,setDeleting]=useState(false)
  const [exporting,setExporting]=useState(false)
  const [dataMsg,setDataMsg]=useState('')
  const [deleteError,setDeleteError]=useState(false)
  const [aiStyle,setAiStyle]=useState('act')
  // Тост ошибки записи настроек — тот же паттерн, что showFoodSaveError и т.п.
  const [showSettingsSaveError,setShowSettingsSaveError]=useState(false)
  const flashSettingsSaveError=()=>{setShowSettingsSaveError(true);setTimeout(()=>setShowSettingsSaveError(false),3500)}

  useEffect(()=>{
    if(!user?.id)return
    supabase.from('chat_messages').select('*',{count:'exact',head:true}).eq('user_id',user.id)
      .then(({count})=>setChatCount(count??0))
    // notifs/units читаются из profiles, а не только из localStorage — иначе
    // настройки, сохранённые на одном устройстве, не видны на другом.
    supabase.from('profiles').select('ai_style,notifs,units').eq('id',user.id).single()
      .then(({data})=>{
        if(!data)return
        if(data.ai_style)setAiStyle(data.ai_style)
        if(data.notifs)setNotifs(normalizeNotifs(data.notifs))
        if(data.units)setUnits(data.units)
      })
  },[user?.id])

  const saveNotifs=async(next)=>{
    const prev=notifs
    setNotifs(next);localStorage.setItem('fitpro_notifs',JSON.stringify(next))
    if(user?.id){
      const{error}=await supabase.from('profiles').update({notifs:next}).eq('id',user.id)
      if(error){
        console.error('Ошибка сохранения уведомлений:',error)
        setNotifs(prev);localStorage.setItem('fitpro_notifs',JSON.stringify(prev))
        flashSettingsSaveError()
      }
    }
  }
  const saveUnits=async(next)=>{
    const prev=units
    setUnits(next);localStorage.setItem('fitpro_units',JSON.stringify(next))
    if(user?.id){
      const{error}=await supabase.from('profiles').update({units:next}).eq('id',user.id)
      if(error){
        console.error('Ошибка сохранения единиц измерения:',error)
        setUnits(prev);localStorage.setItem('fitpro_units',JSON.stringify(prev))
        flashSettingsSaveError()
      }
    }
  }
  const saveAiStyle=async(v)=>{
    const prev=aiStyle
    setAiStyle(v)
    if(user?.id){
      const{error}=await supabase.from('profiles').update({ai_style:v}).eq('id',user.id)
      if(error){
        console.error('Ошибка сохранения стиля AI-ассистента:',error)
        setAiStyle(prev)
        flashSettingsSaveError()
      }
    }
  }

  const clearChat=async()=>{
    if(!user?.id)return
    await supabase.from('chat_messages').delete().eq('user_id',user.id)
    setChatCount(0);setClearConfirm(false)
  }

  // "Скачать мои данные" — реализация права на доступ к своим ПДн (152-ФЗ).
  // Раньше кнопка была заглушкой: рисовала "✓ Данные будут отправлены на твой
  // email" и не делала вообще ничего — никакой выгрузки и никакого письма.
  // Теперь состав файла собирает api/export-data.js по тому же перечню таблиц,
  // что и удаление (api/_userTables.js), и браузер сохраняет его как JSON.
  const exportData=async()=>{
    if(!user?.id||exporting)return
    setExporting(true);setDeleteError(false);setDataMsg('')
    let url=null
    try{
      const{data:{session}}=await supabase.auth.getSession()
      const token=session?.access_token
      if(!token)throw new Error('нет активной сессии, перезайди в приложение')
      // В Telegram Mini App скачивание Blob через <a download> не работает:
      // webview не сохраняет файл, а показывает его содержимое на экране, и при
      // таком инлайн-показе ломается кириллица. Поэтому внутри Telegram просим
      // сервер прислать файл документом в чат с ботом.
      const inTelegram=!!window.Telegram?.WebApp?.initData
      const res=await fetch('/api/export-data',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify(inTelegram?{channel:'telegram'}:{}),
      })
      const body=await res.json().catch(()=>({}))
      if(!res.ok)throw new Error(body?.error||`сервер вернул ${res.status}`)
      if(inTelegram){
        setDataMsg('✓ Файл с твоими данными отправлен тебе в чат с ботом')
        setTimeout(()=>setDataMsg(''),6000)
        return
      }
      // Обычный браузер: Blob + временная <a download> — способ отдать файл без
      // серверного эндпоинта отдачи и без открытия новой вкладки. charset=utf-8
      // обязателен, иначе часть браузеров читает файл как cp1251 и кириллица
      // превращается в «РњР°РєСЃРёРј».
      url=URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:'application/json;charset=utf-8'}))
      const a=document.createElement('a')
      a.href=url
      a.download=`fitpro-данные-${localTodayISO()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setDataMsg('✓ Файл скачан')
      setTimeout(()=>setDataMsg(''),4000)
    }catch(e){
      console.error('Ошибка выгрузки данных:',e)
      setDeleteError(true)
      setDataMsg(`Не удалось выгрузить данные: ${e.message}`)
      setTimeout(()=>{setDataMsg('');setDeleteError(false)},6000)
    }finally{
      // Без revoke Blob висит в памяти вкладки до перезагрузки страницы.
      // Отзываем в следующем тике: Safari успевает начать скачивание только
      // после возврата в цикл событий.
      if(url)setTimeout(()=>URL.revokeObjectURL(url),0)
      setExporting(false)
    }
  }

  // "Удалить аккаунт и данные" — реализация права на удаление (152-ФЗ) и
  // одновременно механизм отзыва согласия на обработку ПДн.
  //
  // Раньше здесь была кнопка "Удалить все мои данные", которая чистила восемь
  // таблиц запросами прямо с клиента. Она НЕ удаляла сам аккаунт (auth.users)
  // и строку profiles, а также не трогала measurements, custom_exercises,
  // training_survey, workout_templates, assigned_programs и trainer_clients —
  // "удалившийся" пользователь при следующем входе получал прежний аккаунт с
  // частью истории на месте. Полное удаление с клиента и невозможно: анонимный
  // ключ под RLS не имеет доступа к auth.users. Поэтому всё делает серверная
  // функция api/delete-account.js на service_role-ключе, а личность берёт из
  // токена вызывающего.
  const deleteAccount=async()=>{
    if(!user?.id||deleting)return
    setDeleting(true);setDeleteError(false);setDataMsg('')
    try{
      const{data:{session}}=await supabase.auth.getSession()
      const token=session?.access_token
      if(!token)throw new Error('нет активной сессии, перезайди в приложение')
      const res=await fetch('/api/delete-account',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      })
      const body=await res.json().catch(()=>({}))
      if(!res.ok)throw new Error(body?.error||`сервер вернул ${res.status}`)
      // Успех — состояние чистит App (onAccountDeleted): без вопроса о
      // несохранённых тренировках, спасать уже нечего.
      onAccountDeleted()
    }catch(e){
      console.error('Ошибка удаления аккаунта:',e)
      setDeleting(false)
      setDeleteConfirm(false)
      setDeleteError(true)
      setDataMsg(`Не удалось удалить аккаунт: ${e.message}`)
      setTimeout(()=>{setDataMsg('');setDeleteError(false)},6000)
    }
  }

  // hideBack: у под-страницы уже есть шапка Настроек со стрелкой «назад» —
  // вторая кнопка внутри текста была бы дублем. В ConsentGate шапки нет, там
  // PolicyView по-прежнему рисует свою кнопку.
  // Аналитика — только тренеру. Двойная защита: пункт скрыт ниже, и здесь при
  // не-тренере подстраница не открывается.
  if(subPage==='analytics') return userRole==='trainer' ? <AnalyticsView userRole={userRole} trainerId={user?.id} /> : null
  if(subPage==='plans') return <PlansView user={user} hideBack onClose={()=>setSubPage(null)} onChanged={onProfileChanged} />
  if(subPage==='policy') return <PolicyView hideBack onClose={()=>setSubPage(null)} />
  if(subPage==='consent') return <ConsentDocView user={user} hideBack onClose={()=>setSubPage(null)} />

  return(
    <div style={{padding:'16px 16px 40px',display:'flex',flexDirection:'column',gap:0}}>
      {showSettingsSaveError&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
        }}>
          Не удалось сохранить — проверь связь и повтори
        </div>
      )}

      {/* Подписка */}
      <Section title="Подписка">
        <button data-testid="settings-plans" onClick={()=>setSubPage('plans')} style={{
          display:'block',width:'100%',padding:0,border:'none',background:'none',
          textAlign:'left',cursor:'pointer',minHeight:'unset',
        }}>
          <Row label="Тарифы и подписка" sub="Пакеты, пробный период и оплата"
               right={<span style={{fontSize:16,color:TXT3}}>›</span>}/>
        </button>
      </Section>

      {/* Аналитика — только тренеру. Клиент этого пункта не видит. */}
      {userRole==='trainer'&&(
        <Section title="Тренеру">
          <button data-testid="settings-analytics" onClick={()=>setSubPage('analytics')} style={{
            display:'block',width:'100%',padding:0,border:'none',background:'none',
            textAlign:'left',cursor:'pointer',minHeight:'unset',
          }}>
            <Row label="Аналитика" sub="Сводка и список пользователей"
                 right={<span style={{fontSize:16,color:TXT3}}>›</span>}/>
          </button>
        </Section>
      )}

      {/* Уведомления.
          Канал доставки один — Telegram: в api/send-reminders.js нет ни одной
          отправки письма, только api.telegram.org/sendMessage. Поэтому у
          аккаунта без chat_id тумблер раньше был обманом — включался, честно
          сохранялся в profiles.notifs, и ничего не приходило. Теперь при
          отсутствии канала тумблера нет вовсе, а вместо него — что сделать,
          чтобы напоминания заработали. */}
      <Section title="Уведомления">
        {!canNotify&&(
          <div style={{ padding:'12px 0 14px', borderBottom:`1px solid ${HAIR}` }}>
            <div style={{ fontSize:14, color:TXT, fontWeight:600, marginBottom:6 }}>Чтобы получать напоминания, подключите Telegram</div>
            <div style={{ fontSize:12.5, color:TXT3, lineHeight:1.5, marginBottom:10 }}>
              Напоминания приходят сообщением от бота — другого канала нет, на почту они не отправляются.
              Откройте приложение через бота один раз, и аккаунт свяжется автоматически.
            </div>
            <a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noopener noreferrer" style={{
              display:'inline-block', padding:'9px 16px', borderRadius:10, textDecoration:'none',
              background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color:'#fff', fontSize:13, fontWeight:700,
            }}>Открыть бота в Telegram</a>
          </div>
        )}
        {[
          {key:'workout',label:'Напоминание о тренировке'},
          {key:'diary',label:'Дневник питания'},
        ].map(({key,label})=>{
          const n=notifs[key]
          const setField=patch=>saveNotifs({...notifs,[key]:{...n,...patch}})
          const toggleDay=d=>setField({days:n.days.includes(d)?n.days.filter(x=>x!==d):[...n.days,d]})
          return (
            <div key={key} style={{ borderBottom:`1px solid ${HAIR}` }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'13px 0' }}>
                <div>
                  <div style={{ fontSize:15, color:canNotify?TXT:TXT3, fontWeight:500 }}>{label}</div>
                  {/* Канал под названием — прямым текстом, а не намёком. */}
                  <div style={{ fontSize:12, color:TXT3, marginTop:2 }}>
                    {!canNotify?'Недоступно без Telegram':n.enabled?'Придут в Telegram':'Выключено'}
                  </div>
                </div>
                {/* Без канала тумблера нет: включать то, что заведомо никуда не
                    придёт, — ровно тот молчаливый обман, который тут чинится. */}
                {canNotify&&<Toggle on={n.enabled} onToggle={()=>setField({enabled:!n.enabled})}/>}
              </div>
              {canNotify&&n.enabled&&(
                <div style={{ padding:'0 0 14px', display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontSize:13, color:TXT3 }}>Время</span>
                    <input type="time" value={n.time} onChange={e=>setField({time:e.target.value})}
                      style={{ padding:'7px 10px', fontSize:14, borderRadius:8, border:`1.5px solid ${HAIR}`, outline:'none', color:TXT, background:SURF2, colorScheme:'dark' }}
                      onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                  </div>
                  <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                    {WEEKDAYS.map(({n:d,l})=>{
                      const active=n.days.includes(d)
                      return (
                        <button key={d} onClick={()=>toggleDay(d)}
                          style={{ width:38, height:34, borderRadius:9, cursor:'pointer', fontSize:12, fontWeight:700, padding:0, minHeight:'unset',
                            background:active?PUR:SURF2, color:active?'#fff':TXT3,
                            border:active?`1px solid ${PUR}`:`1px solid ${HAIR}` }}>
                          {l}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </Section>

      {/* Единицы измерения */}
      <Section title="Единицы измерения">
        <Row label="Вес" right={
          <div style={{display:'flex',gap:4}}>
            {/* Только кг — пересчёта в фунты нет, показывать выбор lbs было бы
                обманом (переключатель есть, а поведение не меняется). units.weight
                и saveUnits не трогаем — на случай если пересчёт появится позже. */}
            {['kg'].map(v=>(
              <button key={v} onClick={()=>saveUnits({...units,weight:v})} style={{
                padding:'5px 12px',borderRadius:8,border:`1.5px solid ${units.weight===v?PUR:HAIR}`,
                background:units.weight===v?`${PUR}15`:SURF,color:units.weight===v?PUR:TXT3,
                fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset',
              }}>{v}</button>
            ))}
          </div>
        }/>
        <Row label="Рост" right={
          <div style={{display:'flex',gap:4}}>
            {['cm','in'].map(v=>(
              <button key={v} onClick={()=>saveUnits({...units,height:v})} style={{
                padding:'5px 12px',borderRadius:8,border:`1.5px solid ${units.height===v?PUR:HAIR}`,
                background:units.height===v?`${PUR}15`:SURF,color:units.height===v?PUR:TXT3,
                fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset',
              }}>{v}</button>
            ))}
          </div>
        }/>
      </Section>

      {/* AI ассистент */}
      <Section title="AI-ассистент">
        <Row label="Стиль AI-ассистента" sub={aiStyle==='ask'?'Уточняет граммовки и детали перед записью еды':'Сам прикидывает и сразу записывает, потом можно поправить'} right={
          <div style={{display:'flex',gap:4}}>
            {[['ask','Спрашивай меня'],['act','Действуй сам']].map(([v,lbl])=>(
              <button key={v} onClick={()=>saveAiStyle(v)} style={{
                padding:'5px 10px',borderRadius:8,border:`1.5px solid ${aiStyle===v?PUR:HAIR}`,
                background:aiStyle===v?`${PUR}15`:SURF,color:aiStyle===v?PUR:TXT3,
                fontSize:12,fontWeight:600,cursor:'pointer',minHeight:'unset',whiteSpace:'nowrap',
              }}>{lbl}</button>
            ))}
          </div>
        }/>
      </Section>

      {/* История чата */}
      <Section title="История чата">
        <Row label="Сохранено сообщений" sub="Хранится, пока не удалишь" right={
          <span style={{fontSize:15,fontWeight:700,color:PUR}}>{chatCount===null?'...' :chatCount}</span>
        }/>
        <div style={{padding:'6px 0 14px'}}>
          <div style={{fontSize:12,color:TXT3,marginBottom:10}}>Переписка хранится на сервере, пока ты сам её не удалишь. Хочешь сохранить — сначала выгрузи файл кнопкой «Скачать мои данные» ниже, в разделе «Конфиденциальность».</div>
          {!clearConfirm?(
            <button onClick={()=>setClearConfirm(true)} style={{
              width:'100%',padding:'11px',borderRadius:10,border:'1px solid rgba(255,69,58,.40)',
              background:'rgba(255,69,58,.12)',color:DANGER,fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset',
            }}>Очистить историю чата</button>
          ):(
            <>
              <div style={{fontSize:13,fontWeight:600,color:TXT,marginBottom:10}}>Очистить историю чата? Действие необратимо, восстановить переписку будет нельзя.</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={clearChat} style={{flex:1,padding:'11px',borderRadius:10,border:'none',background:'#ef4444',color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset'}}>Удалить</button>
                <button onClick={()=>setClearConfirm(false)} style={{flex:1,padding:'11px',borderRadius:10,border:`1.5px solid ${HAIR}`,background:SURF,color:TXT3,fontSize:14,cursor:'pointer',minHeight:'unset'}}>Отмена</button>
              </div>
            </>
          )}
        </div>
      </Section>

      {/* Конфиденциальность */}
      <Section title="Конфиденциальность">
        <button data-testid="settings-policy" onClick={()=>setSubPage('policy')} style={{
          display:'block',width:'100%',padding:0,border:'none',background:'none',
          textAlign:'left',cursor:'pointer',minHeight:'unset',
        }}>
          <Row label="Политика конфиденциальности" sub="Как обрабатываются твои данные (152-ФЗ)"
               right={<span style={{fontSize:16,color:TXT3}}>›</span>}/>
        </button>
        <button data-testid="settings-consent" onClick={()=>setSubPage('consent')} style={{
          display:'block',width:'100%',padding:0,border:'none',background:'none',
          textAlign:'left',cursor:'pointer',minHeight:'unset',
        }}>
          <Row label="Согласие на обработку данных" sub="Текст согласия и когда ты его дал"
               right={<span style={{fontSize:16,color:TXT3}}>›</span>}/>
        </button>
        {/* Оферта ведёт на внешнюю оферту Продамуса (там же оформляется оплата),
            а не на внутреннюю страницу. Стрелка «↗» — признак внешней ссылки. */}
        <button onClick={()=>openExternal('https://maximathlete.payform.ru/public_offer')} style={{
          display:'block',width:'100%',padding:0,border:'none',background:'none',
          textAlign:'left',cursor:'pointer',minHeight:'unset',
        }}>
          <Row label="Пользовательское соглашение (оферта)" sub="Условия оказания услуг"
               right={<span style={{fontSize:16,color:TXT3}}>↗</span>}/>
        </button>
        {/* Атрибуция ODbL — требование лицензии Open Food Facts: источник
            данных о продуктах должен быть назван там, где эти данные видны.
            Место выбрано по смыслу — блок с юридическими документами. */}
        <div style={{padding:'10px 0 2px',fontSize:11,color:TXT3,lineHeight:1.5}}>{DATA_ATTRIBUTION}</div>
        {dataMsg&&<div style={{padding:'10px 0',fontSize:13,color:deleteError?'#ef4444':TEA,fontWeight:500}}>{dataMsg}</div>}
        <div style={{paddingBottom:14,display:'flex',flexDirection:'column',gap:8}}>
          <button onClick={exportData} disabled={exporting} style={{
            width:'100%',padding:'11px',borderRadius:10,border:`1.5px solid ${HAIR}`,
            background:SURF,color:exporting?TXT3:TXT,fontSize:14,fontWeight:500,
            cursor:exporting?'not-allowed':'pointer',minHeight:'unset',textAlign:'left',
          }}>{exporting?'📤 Готовим файл…':'📤 Скачать мои данные'}</button>
          <button onClick={()=>setDeleteConfirm(true)} style={{
            width:'100%',padding:'11px',borderRadius:10,border:'1px solid rgba(255,69,58,.40)',
            background:'rgba(255,69,58,.12)',color:DANGER,fontSize:14,fontWeight:700,cursor:'pointer',minHeight:'unset',
          }}>🗑 Удалить аккаунт и данные</button>
        </div>
      </Section>

      {/* Связаться с тренером — публичный контакт, виден ВСЕМ и везде.
          Раньше единственной точкой связи была строка «Написать тренеру» в
          Поддержке ниже: обычная ссылка t.me, которая внутри Mini App не всегда
          открывается, а у человека без Telegram не работает вовсе. Здесь оба
          канала названы явно, и почта — запасной, работающий без Telegram. */}
      <Section title="Связаться с тренером">
        <a href={MAX_TELEGRAM_URL} target="_blank" rel="noopener noreferrer"
          onClick={e=>{
            // Внутри Mini App внешние ссылки надёжно открывает только
            // openTelegramLink — тот же приём, что у @ника клиента выше.
            if(window.Telegram?.WebApp){e.preventDefault();window.Telegram.WebApp.openTelegramLink(MAX_TELEGRAM_URL)}
          }}
          style={{ display:'flex',alignItems:'center',gap:12,padding:'13px 0',borderBottom:`1px solid ${HAIR}`,textDecoration:'none',color:TXT }}>
          <GlassIcon name="chat" size={26} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15,fontWeight:500 }}>Telegram</div>
            <div style={{ fontSize:12,color:TXT3,marginTop:2 }}>@maxim_athlete — быстрее всего</div>
          </div>
          <span style={{ fontSize:16,color:TXT3 }}>›</span>
        </a>
        <a href={`mailto:${MAX_EMAIL}`}
          style={{ display:'flex',alignItems:'center',gap:12,padding:'13px 0',borderBottom:`1px solid ${HAIR}`,textDecoration:'none',color:TXT }}>
          <GlassIcon name="question" size={26} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15,fontWeight:500 }}>Почта</div>
            <div style={{ fontSize:12,color:TXT3,marginTop:2,wordBreak:'break-all' }}>{MAX_EMAIL}</div>
          </div>
          <span style={{ fontSize:16,color:TXT3 }}>›</span>
        </a>
      </Section>

      {/* Поддержка */}
      <Section title="Поддержка">
        {/* «Написать тренеру» отсюда убран — он переехал выше, в блок
            «Связаться с тренером», вместе с почтой. Дублировать одну и ту же
            ссылку двумя строками подряд смысла нет. */}
        {[
          {label:'Поддержка',icon:'question',url:'https://t.me/fitpro_supportt'},
          {label:'Сообщить об ошибке',icon:'danger',url:'https://t.me/fitpro_supportt'},
        ].map(item=>(
          <a key={item.label} href={item.url} target="_blank" rel="noopener noreferrer" style={{
            display:'flex',alignItems:'center',gap:12,padding:'13px 0',
            borderBottom:`1px solid ${HAIR}`,textDecoration:'none',color:TXT,
          }}>
            <GlassIcon name={item.icon} size={26} />
            <span style={{fontSize:15,fontWeight:500,flex:1}}>{item.label}</span>
            <span style={{fontSize:16,color:TXT3}}>›</span>
          </a>
        ))}
      </Section>

      {deleteConfirm&&(
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}
          onClick={()=>{if(!deleting)setDeleteConfirm(false)}}>
          <div style={{ background:SURF,borderRadius:16,padding:'24px 22px',width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.45)' }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:16,fontWeight:700,color:TXT,marginBottom:10 }}>Удалить аккаунт?</div>
            <div style={{ fontSize:13,lineHeight:1.55,color:TXT2,marginBottom:18 }}>
              Все твои данные и история будут стёрты навсегда, восстановить нельзя.
            </div>
            <div style={{ display:'flex',gap:8 }}>
              <button onClick={deleteAccount} disabled={deleting} style={{
                flex:1,padding:'11px',borderRadius:10,border:'none',background:DANGER,color:'#fff',
                fontSize:14,fontWeight:700,cursor:deleting?'not-allowed':'pointer',minHeight:'unset',opacity:deleting?0.7:1,
              }}>{deleting?'Удаляем…':'Удалить'}</button>
              <button onClick={()=>setDeleteConfirm(false)} disabled={deleting} style={{
                flex:1,padding:'11px',borderRadius:10,border:`1.5px solid ${HAIR}`,background:SURF,color:TXT2,
                fontSize:14,cursor:deleting?'not-allowed':'pointer',minHeight:'unset',
              }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// Заголовки под-страниц Настроек — один источник и для самой страницы, и для
// шапки Настроек, чтобы они не разошлись.
const SETTINGS_SUBPAGE_TITLES = {
  plans: 'Тарифы и подписка',
  policy: 'Политика конфиденциальности',
  consent: 'Согласие на обработку данных',
  analytics: 'Аналитика',
}

// ── Правовые тексты (Политика 152-ФЗ, Оферта). Сами формулировки живут в
// legalText.js — здесь только вёрстка, чтобы правки текста не требовали лезть
// в App.jsx. Разметка одна на оба документа: они отличаются лишь заголовком и
// массивом разделов.
function LegalTextView({ title, sections, onClose, hideBack }) {
  return (
    <div style={{minHeight:'100vh',background:BG,color:TXT,overflowY:'auto'}}>
      <div style={{maxWidth:720,margin:'0 auto',padding:'16px 16px 48px'}}>
        {!hideBack&&(
          <button onClick={onClose} style={{
            padding:'9px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,
            background:SURF,color:TXT,fontSize:14,fontWeight:500,cursor:'pointer',
            minHeight:'unset',marginBottom:18,
          }}>‹ Назад</button>
        )}
        <h1 style={{fontSize:22,fontWeight:700,color:TXT,margin:'0 0 20px'}}>{title}</h1>
        {sections.map(sec=>(
          <div key={sec.h} style={{marginBottom:22}}>
            <h2 style={{fontSize:15,fontWeight:700,color:TXT,margin:'0 0 8px'}}>{sec.h}</h2>
            {sec.p.map((par,i)=>(
              <p key={i} style={{fontSize:14,lineHeight:1.6,color:TXT2,margin:'0 0 8px'}}>{par}</p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// Обёртки с прежними сигнатурами — вызовы PolicyView ({onClose}) в SettingsView
// и ConsentGate менять не пришлось.
function PolicyView({ onClose, hideBack }) {
  return <LegalTextView title={SETTINGS_SUBPAGE_TITLES.policy} sections={POLICY_SECTIONS} onClose={onClose} hideBack={hideBack} />
}

// Читаемая копия документа согласия (экран согласия при входе — отдельно, в
// ConsentGate, его не трогаем). Сверху показываем, когда и на какую версию
// согласие было дано — из profiles. Разметку не наследуем от LegalTextView,
// т.к. нужна ещё строка-статус над текстом.
function ConsentDocView({ user, onClose, hideBack }) {
  const [given,setGiven]=useState(null) // { at, version } | null

  useEffect(()=>{
    if(!user?.id)return
    let cancelled=false
    supabase.from('profiles').select('pd_consent_at,pd_consent_version').eq('id',user.id).single()
      .then(({data,error})=>{
        if(cancelled)return
        if(error){console.error('Не удалось прочитать статус согласия:',error);return}
        if(data?.pd_consent_at)setGiven({at:data.pd_consent_at,version:data.pd_consent_version})
      })
    return()=>{cancelled=true}
  },[user?.id])

  return (
    <div style={{minHeight:'100vh',background:BG,color:TXT,overflowY:'auto'}}>
      <div style={{maxWidth:720,margin:'0 auto',padding:'16px 16px 48px'}}>
        {!hideBack&&(
          <button onClick={onClose} style={{
            padding:'9px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,
            background:SURF,color:TXT,fontSize:14,fontWeight:500,cursor:'pointer',
            minHeight:'unset',marginBottom:18,
          }}>‹ Назад</button>
        )}
        <h1 style={{fontSize:22,fontWeight:700,color:TXT,margin:'0 0 20px'}}>{SETTINGS_SUBPAGE_TITLES.consent}</h1>
        {given&&(
          <div style={{
            background:`${TEA}14`,border:`1px solid ${TEA}40`,borderRadius:12,
            padding:'11px 14px',marginBottom:20,fontSize:13,fontWeight:600,color:TEA,
          }}>
            Согласие дано: {fmtPlanDate(given.at)}{given.version?` (версия ${given.version})`:''}
          </div>
        )}
        {CONSENT_SECTIONS.map(sec=>(
          <div key={sec.h} style={{marginBottom:22}}>
            <h2 style={{fontSize:15,fontWeight:700,color:TXT,margin:'0 0 8px'}}>{sec.h}</h2>
            {sec.p.map((par,i)=>(
              <p key={i} style={{fontSize:14,lineHeight:1.6,color:TXT2,margin:'0 0 8px'}}>{par}</p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Тарифы и подписка. Пока ТОЛЬКО показывает пакеты и статус — ничего не
// блокирует: доступ по level нигде не проверяется, это следующая фаза.
const fmtPlanDate = iso => {
  const d = new Date(iso)
  const p = n => String(n).padStart(2,'0')
  return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()}`
}

// Ссылки наружу: внутри Telegram обычный window.open заблокирован webview,
// нужен SDK. t.me открываем как telegram-ссылку, остальное — как внешнюю.
const openExternal = url => {
  const tg = window.Telegram?.WebApp
  if(tg?.initData){
    if(/^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url)
    else tg.openLink(url)
    return
  }
  window.open(url,'_blank','noopener,noreferrer')
}

function PlansView({ user, onClose, hideBack, onChanged }) {
  const [profile,setProfile]=useState(null)
  const [loading,setLoading]=useState(true)
  const [loadError,setLoadError]=useState(false)
  const [trialBusy,setTrialBusy]=useState(false)
  const [payBusy,setPayBusy]=useState(false)
  const [cancelBusy,setCancelBusy]=useState(false)
  const [showCancelConfirm,setShowCancelConfirm]=useState(false)
  const [msg,setMsg]=useState('')
  const [msgError,setMsgError]=useState(false)
  // Выбранная пилюля тарифа. По умолчанию ПРОФИТ — он же «Хит».
  const [selectedKey,setSelectedKey]=useState('profit')

  const flash=(text,isError)=>{setMsg(text);setMsgError(!!isError);setTimeout(()=>setMsg(''),5000)}

  const loadProfile=async()=>{
    if(!user?.id)return
    setLoading(true);setLoadError(false)
    const{data,error}=await supabase.from('profiles')
      // role нужен, чтобы решить, показывать ли служебные тарифы (staff).
      .select('plan,plan_until,trial_until,trial_used,coach_id,role').eq('id',user.id).single()
    if(error){
      console.error('Не удалось загрузить статус подписки:',error)
      setLoadError(true)
    }else{
      setProfile(data)
    }
    setLoading(false)
  }

  useEffect(()=>{loadProfile()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.id])

  const startTrial=async()=>{
    if(trialBusy)return
    setTrialBusy(true);setMsg('')
    try{
      const{data:{session}}=await supabase.auth.getSession()
      const token=session?.access_token
      if(!token)throw new Error('нет активной сессии, перезайди в приложение')
      const res=await fetch('/api/start-trial',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      })
      const body=await res.json().catch(()=>({}))
      if(!res.ok)throw new Error(body?.error||`сервер вернул ${res.status}`)
      if(body?.ok===false&&body?.reason==='used'){
        flash('Пробный уже использован',true)
        await loadProfile()
        return
      }
      await loadProfile()
      flash(`Пробный активирован до ${fmtPlanDate(body.trial_until)}`)
    }catch(e){
      console.error('Ошибка активации пробного периода:',e)
      flash(`Не удалось активировать пробный: ${e.message}`,true)
    }finally{
      setTrialBusy(false)
    }
  }

  const access=effectiveAccess(profile)
  // Пробный предлагаем, только если его ещё не брали и сейчас нет вообще
  // никакого активного доступа (ни платного, ни пробного).
  const canStartTrial=!!profile&&!profile.trial_used&&access.level===0
  // Активная ПЛАТНАЯ подписка (не пробный) — для кнопки отмены.
  const hasActivePaid=access.level>0&&!access.isTrial
  const hasCoach=!!profile?.coach_id

  const cancelSub=async()=>{
    if(cancelBusy)return
    setCancelBusy(true);setMsg('')
    try{
      const{data:{session}}=await supabase.auth.getSession()
      const token=session?.access_token
      if(!token)throw new Error('нет активной сессии, перезайди в приложение')
      const res=await fetch('/api/cancel-subscription',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      })
      const body=await res.json().catch(()=>({}))
      if(!res.ok||!body?.ok)throw new Error(body?.error||`сервер вернул ${res.status}`)
      setShowCancelConfirm(false)
      await loadProfile()      // экран Тарифов сразу показывает СТАРТ
      onChanged?.()            // и обновляем access во всём приложении
      flash('Подписка отменена')
    }catch(e){
      console.error('Ошибка отмены подписки:',e)
      flash(`Не удалось отменить: ${e.message}`,true)
    }finally{
      setCancelBusy(false)
    }
  }

  // Ссылку оплаты строит сервер (api/create-payment.js): статические ссылки
  // Продамуса не могут нести наш userId, поэтому подписанную ссылку с userId в
  // order_id/customer_extra выписывает бэкенд по токену пользователя.
  const pay=async(plan)=>{
    if(payBusy)return
    // Внутри Telegram ничего заранее открывать не нужно: tg.openLink() под
    // ограничение user-gesture не подпадает и спокойно работает после await.
    const inTelegram=!!window.Telegram?.WebApp?.initData
    // А в обычном браузере вкладку открываем СИНХРОННО, прямо в обработчике
    // клика. Раньше window.open вызывался уже после двух await (getSession +
    // fetch за ссылкой) — к этому моменту жест пользователя "потрачен", и
    // Safari с Chrome mobile блокировали окно как всплывающее: человек жал
    // "Оплатить", и не происходило ровно ничего. Держим пустую вкладку и
    // подставляем в неё адрес, когда сервер ответит.
    //
    // 'noopener' тут передавать НЕЛЬЗЯ: с ним window.open возвращает null, и
    // ссылки на вкладку не остаётся. Разрываем связь через w.opener=null ниже —
    // эффект тот же.
    const w=inTelegram?null:window.open('about:blank','_blank')
    setPayBusy(true);setMsg('')
    try{
      const{data:{session}}=await supabase.auth.getSession()
      const token=session?.access_token
      if(!token)throw new Error('нет активной сессии, перезайди в приложение')
      const res=await fetch('/api/create-payment',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        // source решает, куда Продамус вернёт человека после оплаты. Из
        // браузера — обратно в приложение (?paid=1), из Telegram — в бота.
        // Передаём МЕТКУ, а не адрес: сервер подписывает urlSuccess своим
        // ключом, и принимать URL из тела было бы открытым редиректом.
        body:JSON.stringify({plan:plan.key,source:inTelegram?'telegram':'web'}),
      })
      const body=await res.json().catch(()=>({}))
      if(!res.ok||!body?.url)throw new Error(body?.error||`сервер вернул ${res.status}`)
      if(inTelegram){
        openExternal(body.url)
      }else if(w){
        try{w.opener=null}catch{ /* кросс-origin ещё не наступил, но бывает */ }
        w.location.replace(body.url)
      }else{
        // Вкладку всё-таки заблокировали (жёсткие настройки браузера) — уходим
        // на оплату в текущей вкладке. Хуже, чем новая вкладка, но несравнимо
        // лучше молчания: Продамус вернёт человека обратно по redirect.
        window.location.assign(body.url)
      }
    }catch(e){
      // Пустую вкладку за собой закрываем — иначе на экране остаётся висеть
      // about:blank без всякого объяснения.
      try{w?.close()}catch{ /* уже закрыта пользователем */ }
      console.error('Ошибка создания ссылки оплаты:',e)
      flash(`Не удалось открыть оплату: ${e.message}`,true)
    }finally{
      setPayBusy(false)
    }
  }

  // Пилюли переключателя: все пакеты + VIP отдельным псевдо-тарифом.
  // staff-тарифы (служебный тест оплаты) видит ТОЛЬКО тренер — та же проверка
  // роли, что открывает тренерские экраны. Клиенту тренера её мало: role у него
  // 'client', и пилюля не появится. Это удобство, не защита: отказ на покупку
  // служебного тарифа стоит на сервере (api/create-payment.js).
  const planTabs=[...visiblePlans(profile?.role).map(p=>({key:p.key,name:p.name})),{key:'vip',name:VIP.name}]
  const isVip=selectedKey==='vip'
  const selectedPlan=isVip?null:planByKey(selectedKey)
  // Уровень для подсветки списка. У VIP горят все пункты (VIP_LEVEL выше всех).
  const selectedLevel=isVip?VIP_LEVEL:selectedPlan.level
  const selectedName=isVip?VIP.name:selectedPlan.name
  const isHit=!isVip&&!!selectedPlan.highlight
  // «Твой пакет» — сравнение с текущим доступом (во время пробного access.planKey
  // указывает на ПРОФИТ, что и есть фактический пакет пользователя).
  const isCurrent=!isVip&&access.planKey===selectedKey

  if(loading) return (
    <div style={{minHeight:'100vh',background:BG,display:'flex',alignItems:'center',justifyContent:'center',color:TXT3,fontSize:14}}>Загрузка…</div>
  )

  return (
    <div style={{minHeight:'100vh',background:BG,color:TXT,overflowY:'auto'}}>
      <div style={{maxWidth:720,margin:'0 auto',padding:'16px 16px 48px'}}>
        {!hideBack&&(
          <button onClick={onClose} style={{
            padding:'9px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,
            background:SURF,color:TXT,fontSize:14,fontWeight:500,cursor:'pointer',
            minHeight:'unset',marginBottom:18,
          }}>‹ Назад</button>
        )}

        {/* Строки «Твой доступ» больше нет — срок показывается под названием
            текущего тарифа ниже. Но сообщение о неудачной загрузке профиля
            оставляем: без него пользователь не поймёт, почему пакет и сроки
            выглядят как у бесплатного СТАРТА, и не сможет повторить попытку. */}
        {loadError&&(
          <div style={{
            display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',
            background:'rgba(255,69,58,.12)',border:'1px solid rgba(255,69,58,.40)',
            borderRadius:12,padding:'11px 14px',marginBottom:16,
            fontSize:13,fontWeight:600,color:DANGER,
          }}>
            Не удалось загрузить твой пакет
            <button onClick={loadProfile} style={{padding:'4px 11px',borderRadius:8,border:`1px solid ${HAIR}`,background:SURF2,color:TXT,fontSize:12,cursor:'pointer',minHeight:'unset'}}>Повторить</button>
          </div>
        )}

        {msg&&(
          <div style={{
            borderRadius:10,padding:'11px 14px',marginBottom:14,fontSize:13,fontWeight:600,
            background:msgError?'rgba(255,69,58,.12)':`${TEA}18`,
            border:`1px solid ${msgError?'rgba(255,69,58,.40)':TEA+'40'}`,
            color:msgError?DANGER:TEA,
          }}>{msg}</div>
        )}

        {/* 1. Баннер пробного — только пока пробный реально доступен */}
        {canStartTrial&&(
          <div style={{
            borderRadius:18,padding:'18px 18px 16px',marginBottom:18,
            background:`linear-gradient(135deg, ${ACCENT2}, ${PUR})`,
            boxShadow:`0 10px 30px ${PUR}45`,
          }}>
            <div style={{fontSize:17,fontWeight:800,color:'#fff',marginBottom:6}}>
              🎁 {TRIAL_DAYS} дней ПРОФИТ — бесплатно
            </div>
            <div style={{fontSize:13,lineHeight:1.5,color:'rgba(255,255,255,0.85)',marginBottom:14}}>
              Попробуй ИИ-ассистента и все тренировки без оплаты. Карта не нужна.
            </div>
            <button data-testid="trial-start" onClick={startTrial} disabled={trialBusy} style={{
              width:'100%',padding:'13px',borderRadius:12,border:'none',
              background:'#fff',color:PUR,fontSize:15,fontWeight:800,
              cursor:trialBusy?'not-allowed':'pointer',opacity:trialBusy?0.7:1,minHeight:'unset',
            }}>{trialBusy?'Активируем…':'Активировать пробный период'}</button>
          </div>
        )}

        {/* 2. Переключатель тарифов. Горизонтальная прокрутка: пять пилюль в
            строку на узком экране не помещаются, и VIP не должен обрезаться —
            поэтому flexShrink:0 у пилюль и запас справа. */}
        <div style={{
          display:'flex',gap:7,overflowX:'auto',paddingBottom:10,marginBottom:14,
          scrollbarWidth:'none',WebkitOverflowScrolling:'touch',
        }}>
          {planTabs.map(tab=>{
            const on=tab.key===selectedKey
            return (
              <button key={tab.key} onClick={()=>setSelectedKey(tab.key)} style={{
                flexShrink:0,whiteSpace:'nowrap',padding:'9px 15px',borderRadius:22,
                border:`1px solid ${on?'transparent':HAIR}`,
                background:on?`linear-gradient(180deg, ${ACCENT2}, ${PUR})`:SURF,
                color:on?'#fff':TXT2,fontSize:13,fontWeight:700,
                cursor:'pointer',minHeight:'unset',
              }}>{tab.name}</button>
            )
          })}
          {/* Запас справа, чтобы последняя пилюля не липла к краю при скролле */}
          <span style={{flexShrink:0,width:4}} />
        </div>

        {/* 3. Шапка выбранного тарифа. Акцентная рамка со свечением — у любого
            выбранного пакета, а не только у «Хита»: она означает «это сейчас
            выбрано», а не «это лучший тариф». Бейдж ★ Хит по-прежнему только
            у ПРОФИТ (isHit ниже). */}
        <div style={{
          background:SURF,borderRadius:18,padding:'18px 18px 16px',marginBottom:16,
          border:`1.5px solid ${PUR}`,
          boxShadow:`0 0 32px ${PUR}22`,
        }}>
          <div style={{display:'flex',alignItems:'center',gap:9,flexWrap:'wrap',marginBottom:10}}>
            <span style={{fontSize:22,fontWeight:800,color:isHit?ACCENT2:TXT}}>{selectedName}</span>
            {isHit&&(
              <span style={{fontSize:11,fontWeight:700,color:ACCENT2,background:`${PUR}20`,border:`1px solid ${PUR}40`,borderRadius:20,padding:'3px 10px'}}>★ Хит</span>
            )}
            {isCurrent&&(
              <span style={{fontSize:11,fontWeight:700,color:TEA,background:`${TEA}18`,border:`1px solid ${TEA}40`,borderRadius:20,padding:'3px 10px'}}>Твой пакет</span>
            )}
          </div>

          {/* Служебный тариф подписан прямо на карточке и заметно. Без этого
              «ТЕСТ 50» рядом с ПРОФИТ за 2990 читается как акция, а не как
              инструмент проверки оплаты, — и однажды его нажмут не думая. */}
          {!isVip&&selectedPlan.staff&&(
            <div style={{
              fontSize:12.5,fontWeight:700,color:COR,background:`${COR}18`,
              border:`1px solid ${COR}44`,borderRadius:10,padding:'8px 11px',
              marginTop:-2,marginBottom:12,lineHeight:1.45,
            }}>{selectedPlan.tagline}</div>
          )}

          {/* Срок — только когда он реально есть: у бесплатного СТАРТА
              effectiveAccess отдаёт until:null, и строка не рисуется. */}
          {isCurrent&&access.until&&(
            <div style={{fontSize:12,color:TXT3,marginTop:-4,marginBottom:10}}>
              {access.isTrial?'Пробный период':'Подписка активна'} до {fmtPlanDate(access.until)}
            </div>
          )}

          {isVip?(
            <div style={{fontSize:13,lineHeight:1.55,color:TXT2,marginBottom:14}}>{VIP.desc}</div>
          ):selectedPlan.level===0?(
            <div style={{fontSize:22,fontWeight:800,color:TXT,marginBottom:14}}>Бесплатно</div>
          ):(
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',alignItems:'baseline',gap:10,flexWrap:'wrap'}}>
                {(TEST_MODE||selectedPlan.oldPrice)&&(
                  <span style={{fontSize:16,color:TXT3,textDecoration:'line-through'}}>{TEST_MODE?selectedPlan.price:selectedPlan.oldPrice} ₽</span>
                )}
                <span style={{fontSize:26,fontWeight:800,color:TXT}}>{priceOf(selectedPlan)} ₽</span>
                {/* Период берётся из тарифа, а не зашит словом «мес»: у
                    служебного test50 срок сутки, и подпись «/ мес» рядом с
                    ценой 50 ₽ была бы прямым враньём о том, что покупаешь. */}
                <span style={{fontSize:13,color:TXT3}}>
                  {daysOfPlan(selectedPlan.key)===PLAN_DAYS_DEFAULT?'/ мес':`/ ${daysOfPlan(selectedPlan.key)} дн.`}
                </span>
              </div>
              {TEST_MODE&&(
                <div style={{fontSize:11.5,color:COR,marginTop:4}}>тестовая цена на время запуска</div>
              )}
            </div>
          )}

          {isVip?(
            <button onClick={()=>openExternal(MAX_TELEGRAM_URL)} style={{
              width:'100%',padding:'13px',borderRadius:12,border:`1.5px solid ${HAIR}`,
              background:SURF2,color:TXT,fontSize:15,fontWeight:700,cursor:'pointer',minHeight:'unset',
            }}>Написать в личку</button>
          ):isCurrent?(
            <button disabled style={{
              width:'100%',padding:'13px',borderRadius:12,
              border:`1px solid ${TEA}40`,background:`${TEA}18`,color:TEA,
              fontSize:15,fontWeight:700,cursor:'default',minHeight:'unset',
            }}>Твой пакет</button>
          ):selectedPlan.level>0?(
            <button onClick={()=>pay(selectedPlan)} disabled={payBusy} style={{
              width:'100%',padding:'13px',borderRadius:12,border:'none',
              background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',
              fontSize:15,fontWeight:800,cursor:payBusy?'not-allowed':'pointer',minHeight:'unset',
              boxShadow:`0 8px 24px ${PUR}45`,opacity:payBusy?0.7:1,
            }}>{payBusy?'Готовим оплату…':`Оформить ${selectedPlan.name} · ${priceOf(selectedPlan)} ₽`}</button>
          ):null}
        </div>

        {/* Отмена подписки — только на пилюле ТЕКУЩЕГО оплаченного пакета
            (isCurrent) и только при активной ПЛАТНОЙ подписке. На чужих пилюлях
            и на бесплатном СТАРТЕ кнопки нет. Автосписаний нет — отмена =
            сброс на СТАРТ. */}
        {isCurrent&&hasActivePaid&&(
          <div style={{ marginBottom:18 }}>
            <button onClick={()=>setShowCancelConfirm(true)} disabled={cancelBusy}
              style={{ width:'100%', padding:'12px', borderRadius:12, border:`1px solid ${HAIR}`, background:'none', color:'#ef4444', fontSize:14, fontWeight:600, cursor:cancelBusy?'default':'pointer', minHeight:'unset' }}>
              Отменить подписку
            </button>
            {hasCoach&&(
              <button onClick={()=>openExternal(MAX_TELEGRAM_URL)}
                style={{ width:'100%', marginTop:8, padding:'12px', borderRadius:12, border:`1px solid ${HAIR}`, background:SURF2, color:TXT, fontSize:14, fontWeight:600, cursor:'pointer', minHeight:'unset' }}>
                Написать тренеру
              </button>
            )}
          </div>
        )}

        {/* Подтверждение отмены */}
        {showCancelConfirm&&createPortal(
          <div onClick={()=>setShowCancelConfirm(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1400, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
            <div onClick={e=>e.stopPropagation()} style={{ background:SURF, borderRadius:16, padding:'22px 20px', maxWidth:360, width:'100%', boxSizing:'border-box' }}>
              <div style={{ fontSize:15, fontWeight:700, color:TXT, textAlign:'center', marginBottom:10, lineHeight:1.4 }}>Отменить подписку?</div>
              <div style={{ fontSize:13, color:TXT3, textAlign:'center', lineHeight:1.5, marginBottom:20 }}>
                Доступ к платным функциям прекратится сразу. По возврату средств напишите тренеру.
              </div>
              <button onClick={cancelSub} disabled={cancelBusy}
                style={{ width:'100%', padding:'13px', borderRadius:12, border:'none', background:'#ef4444', color:'#fff', fontSize:14, fontWeight:700, cursor:cancelBusy?'default':'pointer', marginBottom:8, opacity:cancelBusy?0.7:1 }}>
                {cancelBusy?'Отменяем…':'Да, отменить'}
              </button>
              <button onClick={()=>setShowCancelConfirm(false)}
                style={{ width:'100%', padding:'11px', borderRadius:12, border:'none', background:'none', color:TXT3, fontSize:13, cursor:'pointer' }}>
                Оставить подписку
              </button>
            </div>
          </div>
        , document.body)}

        {/* 4. Единый список возможностей: гаснут те, что выше выбранного тарифа */}
        <div style={{
          background:SURF,borderRadius:18,padding:'18px',
          border:`1.5px solid ${PUR}`,
          boxShadow:`0 0 32px ${PUR}22`,
        }}>
          <div style={{display:'flex',flexDirection:'column',gap:11,textAlign:'left'}}>
            {FEATURES
              // startOnly-строки осмысленны только на СТАРТ: на остальных тарифах
              // их заменяет «Доступ ко всем программам тренировок».
              .filter(f=>!f.startOnly||selectedLevel===0)
              .map((f,i)=>{
              const lit=selectedLevel>=f.min
              return (
                // alignItems:flex-start + flex:1 у текста — чтобы двухстрочные
                // пункты переносились по левому краю, а иконка держалась сверху,
                // одинаково у горящих и погашенных.
                <div key={i} style={{display:'flex',gap:10,alignItems:'flex-start',textAlign:'left',opacity:lit?1:0.5}}>
                  <span style={{
                    flexShrink:0,width:20,height:20,borderRadius:'50%',marginTop:1,
                    background:lit?`${TEA}20`:'transparent',
                    border:lit?`1px solid ${TEA}45`:`1px solid ${HAIR}`,
                    display:'flex',alignItems:'center',justifyContent:'center',
                    fontSize:lit?11:9,color:lit?TEA:TXT3,fontWeight:700,
                  }}>{lit?'✓':'🔒'}</span>
                  <span style={{
                    flex:1,minWidth:0,textAlign:'left',
                    fontSize:13.5,lineHeight:1.5,color:lit?TXT2:TXT3,
                    textDecoration:lit?'none':'line-through',
                  }}>{f.t}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Ворота согласия на обработку ПДн. Показываются вместо приложения, пока в
// profiles не записаны pd_consent_at/pd_consent_version текущей версии.
// Факт согласия пишем В БАЗУ, а не в localStorage: это юридически значимое
// подтверждение, оно должно переживать смену устройства и очистку кэша.
function ConsentGate({ user, onAccepted, onDecline }) {
  const [checked,setChecked]=useState(false)
  const [saving,setSaving]=useState(false)
  const [saveError,setSaveError]=useState('')
  const [showPolicy,setShowPolicy]=useState(false)

  const accept=async()=>{
    if(!checked||saving)return
    setSaving(true);setSaveError('')
    // .select() обязателен: без него update по несуществующей строке профиля
    // вернул бы success с нулём затронутых строк — пользователь прошёл бы
    // дальше, а согласие нигде не сохранилось бы, и на следующем входе экран
    // всплыл бы снова. Проверяем, что обновилась ровно наша строка.
    const{data,error}=await supabase.from('profiles')
      .update({pd_consent_at:new Date().toISOString(),pd_consent_version:POLICY_VERSION})
      .eq('id',user.id)
      .select('id')
    setSaving(false)
    if(error){
      console.error('Ошибка сохранения согласия:',error)
      setSaveError('Не удалось сохранить согласие — проверь связь и повтори')
      return
    }
    if(!data?.length){
      console.error('Согласие не сохранено: профиль не найден, id =',user.id)
      setSaveError('Профиль не найден — перезайди в приложение или напиши в поддержку')
      return
    }
    onAccepted()
  }

  if(showPolicy) return <PolicyView onClose={()=>setShowPolicy(false)} />

  // Текст галочки из legalText, где «Политику конфиденциальности» — ссылка на
  // PolicyView. Разбиваем строку по этой фразе, чтобы не дублировать текст в
  // коде: если формулировку в legalText поменяют, ссылка просто исчезнет, а не
  // сломает рендер. stopPropagation — клик по ссылке не переключает галочку.
  const LINK_PHRASE='Политику конфиденциальности'
  const [before,after]=CONSENT_CHECKBOX.split(LINK_PHRASE)
  const checkboxText=(
    <>
      {before}
      {after!==undefined?(
        <>
          <span onClick={e=>{e.stopPropagation();setShowPolicy(true)}}
                style={{color:ACCENT2,fontWeight:600,textDecoration:'underline',cursor:'pointer'}}>{LINK_PHRASE}</span>
          {after}
        </>
      ):null}
    </>
  )

  // Три «плашки-успокоителя».
  const reassurances=[
    {icon:'🇷🇺',title:'Данные — в России',text:'Хранятся на сервере в РФ, не уходят налево'},
    {icon:'🔒',title:'Под защитой',text:'Доступ только у тебя, соединение шифруется'},
    {icon:'🗑️',title:'Ты хозяин',text:'Удалить всё можно в один тап в Настройках'},
  ]

  return (
    <div style={{position:'fixed',inset:0,zIndex:3000,background:BG,color:TXT,overflowY:'auto'}}>
      {/* Мягкое свечение акцентом вверху */}
      <div style={{
        position:'absolute',top:0,left:'50%',transform:'translateX(-50%)',
        width:420,height:280,borderRadius:'50%',pointerEvents:'none',
        background:`radial-gradient(closest-side, ${PUR}33, transparent)`,
      }}/>
      <div style={{position:'relative',maxWidth:460,margin:'0 auto',padding:'40px 20px 44px',textAlign:'center'}}>

        {/* 1. Эмодзи */}
        <div style={{fontSize:60,lineHeight:1,marginBottom:16,filter:`drop-shadow(0 6px 20px ${PUR}66)`}}>👋</div>

        {/* 2-3. Заголовок и подзаголовок */}
        <h1 style={{fontSize:25,fontWeight:800,color:TXT,margin:'0 0 12px'}}>Привет! Ты в ФитПро</h1>
        <p style={{fontSize:14.5,lineHeight:1.55,color:TXT2,margin:'0 auto 26px',maxWidth:360}}>
          Рады тебя видеть 💪 Одна короткая формальность — и начинаем. Обещаем: быстро и без занудства.
        </p>

        {/* 4. Плашки-успокоители */}
        <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:22,textAlign:'left'}}>
          {reassurances.map(r=>(
            <div key={r.title} style={{
              display:'flex',alignItems:'center',gap:13,
              background:SURF,border:`1px solid ${HAIR}`,borderRadius:14,padding:'13px 15px',
            }}>
              <span style={{fontSize:24,flexShrink:0,lineHeight:1}}>{r.icon}</span>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14.5,fontWeight:700,color:TXT}}>{r.title}</div>
                <div style={{fontSize:12.5,lineHeight:1.4,color:TXT3,marginTop:2}}>{r.text}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 5. Строка согласия — клик по строке переключает галочку */}
        <div onClick={()=>setChecked(c=>!c)} style={{
          display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',textAlign:'left',
          background:SURF,border:`1px solid ${checked?ACCENT2:HAIR}`,borderRadius:14,
          padding:'14px 15px',marginBottom:16,transition:'border-color 0.15s',
        }}>
          <span style={{
            width:24,height:24,borderRadius:7,flexShrink:0,marginTop:1,
            display:'flex',alignItems:'center',justifyContent:'center',
            fontSize:14,fontWeight:900,color:'#fff',
            background:checked?`linear-gradient(180deg, ${ACCENT2}, ${PUR})`:SURF2,
            border:checked?'none':`1.5px solid ${HAIR}`,
          }}>{checked?'✓':''}</span>
          <span style={{fontSize:13,lineHeight:1.55,color:TXT}}>{checkboxText}</span>
        </div>

        {saveError&&(
          <div style={{
            background:'rgba(255,69,58,.12)',border:'1px solid rgba(255,69,58,.40)',
            borderRadius:10,padding:'11px 14px',marginBottom:14,textAlign:'left',
            fontSize:13,fontWeight:600,color:DANGER,
          }}>{saveError}</div>
        )}

        {/* 6. Кнопка «Поехали» */}
        <button data-testid="consent-accept" onClick={accept} disabled={!checked||saving} style={{
          width:'100%',padding:'15px',borderRadius:14,border:'none',
          background:checked?`linear-gradient(180deg, ${ACCENT2}, ${PUR})`:SURF2,
          color:checked?'#fff':TXT3,fontSize:16,fontWeight:800,
          cursor:checked&&!saving?'pointer':'not-allowed',
          boxShadow:checked?`0 10px 32px ${PUR}55`:'none',
          opacity:saving?0.7:1,
        }}>{saving?'Сохраняем…':'Поехали 🚀'}</button>

        {/* 7. Выход. Без него экран — ловушка: не согласившись, пользователь не
            может ни войти, ни выйти. onDecline разлогинивает и возвращает на
            LandingPage; согласие в базу при этом не пишется. */}
        <button onClick={onDecline} disabled={saving} style={{
          display:'block',margin:'16px auto 0',padding:'8px 12px',
          border:'none',background:'none',color:TXT3,
          fontSize:14,fontWeight:500,cursor:saving?'not-allowed':'pointer',minHeight:'unset',
        }}>Пока не готов — выйти</button>
      </div>
    </div>
  )
}

// ── ProfileView ──────────────────────────────────────────────────────────────
function ProfileView({ user, onClose, onOpenAI, onUserUpdate }) {
  const [tab,setTab]=useState('profile')
  const [profile,setProfile]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_profile')||'null')||{name:user?.name||'',birthdate:'',height:'',weight:'',goal:'',steps:'',gymDays:'',occupation:'',activityLevel:''}}catch{return{name:user?.name||'',birthdate:'',height:'',weight:'',goal:'',steps:'',gymDays:'',occupation:'',activityLevel:''}}
  })
  const [userEdit,setUserEdit]=useState({name:user?.name||'',email:user?.email||'',telegram:user?.telegram||'',gender:user?.gender||'',photoURL:user?.photoURL||'',tgUsername:''})
  // Вход через Telegram даёт пользователю технический email вида
  // tg{id}@telegram.fitpro (api/telegram-auth.js) — показывать его человеку
  // бессмысленно. Вместо него выводим @-ник из profiles.tg_username, который
  // сервер освежает при каждом входе. У пользователя ник может быть не задан в Telegram —
  // тогда tgNick пустой, и падаем на ручное поле telegram, если оно заполнено.
  const isTgUser=(user?.email||userEdit.email||'').endsWith('@telegram.fitpro')
  const tgNick=userEdit.tgUsername?'@'+userEdit.tgUsername:(userEdit.telegram||'')

  // ── Настоящая почта аккаунта ────────────────────────────────────────────────
  // Раньше здесь было обычное текстовое поле, и оно НИЧЕГО не делало:
  // saveProfile кладёт userEdit.email только в localStorage — ни в auth.users,
  // ни в profiles он не уходил. Человек менял адрес, видел «Сохранено» и был
  // уверен, что почта у аккаунта поменялась. У телеграм-аккаунтов поля не было
  // вовсе, потому что показывать tg<id>@telegram.fitpro бессмысленно.
  //
  // Теперь адрес меняется по-настоящему — через auth.updateUser({email}), то
  // есть с подтверждением по ссылке из письма (GOTRUE_MAILER_AUTOCONFIRM=false
  // на проде): до перехода по ссылке адрес НЕ применяется. Это единственный
  // честный способ — иначе почту можно было бы записать чужую.
  //
  // ПОЧЕМУ ЭТО СТАЛО ВОЗМОЖНО ТОЛЬКО СЕЙЧАС. До появления profiles.tg_id почта
  // БЫЛА идентичностью телеграм-аккаунта: api/telegram-auth.js искал человека
  // по tg<id>@telegram.fitpro. Смена адреса означала бы, что следующий вход
  // через Telegram аккаунт не найдёт и заведёт дубль. Теперь опознание идёт по
  // tg_id, и адрес свободен (см. тест «смена почты больше не рвёт вход через
  // Telegram» в test-telegram-auth.mjs).
  const currentEmail=realEmail(user?.email)
  const [emailEditing,setEmailEditing]=useState(false)
  const [emailInput,setEmailInput]=useState('')
  const [emailBusy,setEmailBusy]=useState(false)
  const [emailMsg,setEmailMsg]=useState(null)   // {ok:boolean,text:string}
  const submitEmail=async()=>{
    const next=emailInput.trim()
    // Проверка нарочно нестрогая: полный разбор адреса по RFC на клиенте
    // бессмысленен, настоящая проверка — дойдёт ли письмо. Ловим только явные
    // опечатки, чтобы не гонять человека за письмом, которого не будет.
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(next)){
      setEmailMsg({ok:false,text:'Проверь адрес — похоже, в нём опечатка'});return
    }
    if(currentEmail&&next.toLowerCase()===currentEmail.toLowerCase()){
      setEmailMsg({ok:false,text:'Это и есть текущая почта аккаунта'});return
    }
    setEmailBusy(true);setEmailMsg(null)
    const{error}=await supabase.auth.updateUser({email:next})
    setEmailBusy(false)
    if(error){
      // Адрес в лог не пишем — это персональные данные. Только код и текст сервера.
      console.error('Смена почты: сервер отказал',error.status||'',error.message||'')
      logError('update_email',{message:error.message,status:error.status})
      setEmailMsg({ok:false,text:/already|exists|registered/i.test(error.message||'')
        ?'Эта почта уже привязана к другому аккаунту'
        :'Не удалось отправить письмо — попробуй позже'})
      return
    }
    setEmailEditing(false)
    setEmailMsg({ok:true,text:`Письмо отправлено на ${next}. Открой его и подтверди — до этого адрес аккаунта не поменяется.`})
  }
  const photoInputPVRef=useRef(null)
  const [saved,setSaved]=useState(false)
  // Запись профиля уходит в сеть (upsert в profiles), и до этой правки на
  // время запроса не показывалось НИЧЕГО: «Сохранено» загоралось уже по факту.
  // На медленной связи это выглядело как молчащая кнопка — человек жал ещё раз.
  // У остальных сетевых кнопок (оплата, пробный, вход, экспорт, удаление,
  // отправка ассистенту) своё busy-состояние уже есть, их не трогаем.
  const [savingProfile,setSavingProfile]=useState(false)
  // Тост ошибки записи — тот же паттерн, что showFoodSaveError/showClientSaveError,
  // своя копия т.к. компонент отдельный.
  const [showProfileSaveError,setShowProfileSaveError]=useState(false)
  const flashProfileSaveError=()=>{setShowProfileSaveError(true);setTimeout(()=>setShowProfileSaveError(false),3500)}
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

  // Профиль и замеры при открытии подтягиваются из Supabase — так на любом
  // origin/устройстве (localhost, прод, новый браузер) видны одни и те же
  // данные, а не только то, что успело закэшироваться в localStorage. Запись
  // (saveProfile/addMeasurement) и раньше шла в Supabase — не хватало именно
  // чтения при загрузке, из-за чего localhost показывал пустой/дефолтный профиль.
  useEffect(()=>{
    if(!user?.id)return
    let cancelled=false
    supabase.from('profiles').select('*').eq('id',user.id).single().then(({data})=>{
      if(cancelled||!data)return
      setProfile(p=>({
        ...p,
        weight:data.weight!=null?String(data.weight):p.weight,
        height:data.height!=null?String(data.height):p.height,
        goal:data.goal??p.goal,
        birthdate:data.birthdate??p.birthdate,
        occupation:data.occupation??p.occupation,
        gymDays:data.gym_days!=null?String(data.gym_days):p.gymDays,
        activityLevel:data.activity_level??p.activityLevel,
      }))
      setUserEdit(u=>({
        ...u,
        name:data.name||u.name,
        gender:data.gender||u.gender,
        // Ручной telegram в приоритете; если его нет — подставляем @-ник из
        // tg_username, чтобы поле не было пустым у Telegram-клиента.
        telegram:data.telegram||u.telegram||(data.tg_username?'@'+data.tg_username:''),
        photoURL:data.photo_url||u.photoURL,
        tgUsername:data.tg_username||u.tgUsername,
      }))
    })
    return()=>{cancelled=true}
  },[user?.id])

  useEffect(()=>{
    if(!user?.id)return
    let cancelled=false
    ;(async()=>{
      // Замеры только добавляются (удаления нет) — поэтому, в отличие от
      // тренировок, здесь безопасно просто дозаписать в Supabase то, у чего
      // ещё нет supabaseId, без риска "воскресить" что-то удалённое.
      let local
      try{local=JSON.parse(localStorage.getItem('fitpro_measurements')||'[]')}catch{local=[]}
      const toMigrate=local.filter(m=>!m.supabaseId)
      for(const m of toMigrate){
        const{data,error}=await supabase.from('measurements').insert({
          user_id:user.id,date:m.date,
          shoulders:m.shoulders||null,underarm:m.underarm||null,chest:m.chest||null,waist:m.waist||null,
          glutes:m.glutes||null,thigh:m.thigh||null,calf:m.calf||null,bicep:m.bicep||null,
        }).select('id').single()
        if(error)console.error('Миграция замера: ошибка вставки:',error)
        else if(data)m.supabaseId=data.id
      }
      if(toMigrate.length)localStorage.setItem('fitpro_measurements',JSON.stringify(local))

      const{data:rows,error}=await supabase.from('measurements').select('*').eq('user_id',user.id).order('date',{ascending:false})
      if(cancelled||error||!rows)return
      setMeasurements(rows.map(r=>({
        supabaseId:r.id,date:r.date,
        shoulders:r.shoulders||'',underarm:r.underarm||'',chest:r.chest||'',waist:r.waist||'',
        glutes:r.glutes||'',thigh:r.thigh||'',calf:r.calf||'',bicep:r.bicep||'',
      })))
    })()
    return()=>{cancelled=true}
  },[user?.id])

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
    if(savingProfile)return
    setSavingProfile(true)
    try{
    // Клампим вес/рост перед сохранением — гигантские/отрицательные значения
    // ломают calcMacroGoals (aiPrompt.js) и норму КБЖУ, которую AI-ассистент
    // считает от этих же полей.
    const clampedProfile={
      ...profile,
      weight:profile.weight?String(clampNum(profile.weight,PROFILE_WEIGHT_MIN,PROFILE_WEIGHT_MAX)):profile.weight,
      height:profile.height?String(clampNum(profile.height,PROFILE_HEIGHT_MIN,PROFILE_HEIGHT_MAX)):profile.height,
    }
    localStorage.setItem('fitpro_profile',JSON.stringify(clampedProfile))
    // Сохраняем также редактируемые данные пользователя
    const updatedUser={...user,...userEdit,name:userEdit.name||user.name}
    localStorage.setItem('fitpro_user',JSON.stringify(updatedUser))
    if(onUserUpdate)onUserUpdate(updatedUser)
    // Синхронизируем с таблицей profiles в Supabase — AI-ассистент по питанию читает профиль только оттуда
    if(user?.id){
      const{error}=await supabase.from('profiles').upsert({
        id:user.id,
        name:updatedUser.name||null,
        gender:updatedUser.gender||null,
        telegram:updatedUser.telegram||null,
        photo_url:updatedUser.photoURL||null,
        weight:clampedProfile.weight?Number(clampedProfile.weight):null,
        height:clampedProfile.height?Number(clampedProfile.height):null,
        goal:profile.goal||null,
        birthdate:profile.birthdate||null,
        occupation:profile.occupation||null,
        gym_days:profile.gymDays?Number(profile.gymDays):null,
        activity_level:profile.activityLevel||null,
      })
      if(error){console.error('Ошибка синхронизации профиля с Supabase:',error);flashProfileSaveError();return}
    }
    setSaved(true); setTimeout(()=>setSaved(false),2000)
    }finally{
      // finally, а не хвост try: при ошибке записи выше стоит return, и без
      // finally кнопка осталась бы навсегда в состоянии «Сохраняем…».
      setSavingProfile(false)
    }
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
    const entry={date:localTodayISO(),...newM}
    const updated=[entry,...measurements]
    setMeasurements(updated)
    localStorage.setItem('fitpro_measurements',JSON.stringify(updated))
    setShowAddM(false)
    setNewM({shoulders:'',underarm:'',chest:'',waist:'',glutes:'',thigh:'',calf:'',bicep:''})
    if(user?.id){
      supabase.from('measurements').insert({
        user_id:user.id,date:entry.date,
        shoulders:entry.shoulders||null,underarm:entry.underarm||null,chest:entry.chest||null,waist:entry.waist||null,
        glutes:entry.glutes||null,thigh:entry.thigh||null,calf:entry.calf||null,bicep:entry.bicep||null,
      }).select('id').single().then(({data,error})=>{
        if(error){
          console.error('Ошибка синхронизации замера с Supabase:',error)
          // Откат оптимистичной вставки — сервер её не принял.
          setMeasurements(list=>{
            const rolledBack=list.filter(m=>m!==entry)
            localStorage.setItem('fitpro_measurements',JSON.stringify(rolledBack))
            return rolledBack
          })
          flashProfileSaveError()
          return
        }
        setMeasurements(list=>{
          const next=list.map(m=>m===entry?{...m,supabaseId:data?.id}:m)
          localStorage.setItem('fitpro_measurements',JSON.stringify(next))
          return next
        })
      })
    }
  }

  const fmtDate=d=>new Date(d).toLocaleDateString('ru',{day:'numeric',month:'long',year:'numeric'})

  return(
    <div style={{position:'fixed',inset:0,background:BG,zIndex:1050,display:'flex',flexDirection:'column',fontFamily:'system-ui,sans-serif'}}>
      {showProfileSaveError&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:1200, padding:'10px 18px', borderRadius:24, maxWidth:320, textAlign:'center',
          background:'#dc2626', color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(220,38,38,0.35)',
        }}>
          Не удалось сохранить — проверь связь и повтори
        </div>
      )}
      {/* Хедер */}
      <div style={{background:SURF,borderBottom:`1px solid ${HAIR}`,padding:'14px 16px',display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
        <button data-back="1" onClick={onClose} style={{background:'none',border:'none',fontSize:24,cursor:'pointer',color:TXT3,lineHeight:1,padding:0,minHeight:'unset'}}><GlassIcon name="back" size={26} /></button>
        <span style={{fontSize:18,fontWeight:800,color:TXT,flex:1}}>Мои данные</span>
      </div>

      {/* Табы */}
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${HAIR}`,background:SURF,flexShrink:0}}>
        {[{id:'profile',label:'Профиль'},{id:'measurements',label:'Замеры'}].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            flex:1,padding:'13px 0',border:'none',borderBottom:tab===t.id?`2.5px solid ${PUR}`:'2.5px solid transparent',
            background:'none',fontSize:15,fontWeight:tab===t.id?700:500,color:tab===t.id?PUR:TXT3,cursor:'pointer',minHeight:'unset'
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
                <div style={{position:'absolute',bottom:0,right:0,width:22,height:22,borderRadius:'50%',background:PUR,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,border:'2px solid #fff'}}><GlassIcon name="plus" size={18} /></div>
              </div>
              {/* minWidth:0 — чтобы длинное имя/ник сжимались и не выдавливали
                  плашку тарифа за край на узких экранах. */}
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:TXT,marginBottom:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{userEdit.name||user?.name}</div>
                <div style={{fontSize:11,color:TXT3,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{isTgUser?tgNick:(userEdit.email||user?.email)}</div>
                <div style={{fontSize:11,color:PUR,marginTop:2,cursor:'pointer'}} onClick={()=>photoInputPVRef.current?.click()}>Изменить фото</div>
              </div>
            </div>

            {/* Пол */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>Пол</label>
              <div style={{display:'flex',gap:8}}>
                {[['male','👨 Мужчина'],['female','👩 Женщина']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setUserEdit(u=>({...u,gender:val}))} type="button"
                    style={{flex:1,padding:'10px',borderRadius:10,border:`1.5px solid ${userEdit.gender===val?PUR:HAIR}`,background:userEdit.gender===val?`${PUR}12`:SURF,color:userEdit.gender===val?PUR:TXT3,fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset'}}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* ФИО */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>ФИО</label>
              <input value={userEdit.name||''} type="text" placeholder="Иванов Иван Иванович"
                onChange={e=>setUserEdit(u=>({...u,name:e.target.value}))}
                style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF}}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            </div>
            {/* Эл. почта — не обычное поле, а отдельный блок со сменой через
                подтверждение. Кнопкой «Сохранить» внизу почта НЕ трогается:
                у неё свой поток, потому что адрес применяется только после
                перехода по ссылке из письма. Показывается ВСЕМ, включая
                телеграм-аккаунты: техническую почту прячем (realEmail вернёт
                null), но возможность добавить настоящую нужна как раз им — без
                неё, потеряв Telegram, человек теряет и доступ. */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>Эл. почта</label>
              {!emailEditing?(
                <div style={{padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,background:SURF}}>
                  <div style={{fontSize:15,color:currentEmail?TXT:TXT3,wordBreak:'break-all'}}>
                    {currentEmail||'Не добавлена'}
                  </div>
                  <div style={{fontSize:12,color:TXT3,marginTop:5,lineHeight:1.45}}>
                    {currentEmail
                      ?'Подтверждена. На неё приходит восстановление пароля.'
                      :'Вход у тебя через Telegram. Почта нужна, чтобы не потерять доступ, если Telegram окажется недоступен.'}
                  </div>
                  <button onClick={()=>{setEmailEditing(true);setEmailInput('');setEmailMsg(null)}}
                    style={{marginTop:10,padding:'8px 14px',borderRadius:9,border:`1px solid ${PUR}`,background:'none',color:PUR,fontSize:13,fontWeight:600,cursor:'pointer',minHeight:'unset'}}>
                    {currentEmail?'Изменить почту':'Добавить почту'}
                  </button>
                </div>
              ):(
                <div style={{padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,background:SURF}}>
                  <input value={emailInput} type="email" inputMode="email" autoComplete="email" placeholder="ivan@example.com" autoFocus
                    onChange={e=>{setEmailInput(e.target.value);setEmailMsg(null)}}
                    onKeyDown={e=>{if(e.key==='Enter'&&!emailBusy)submitEmail()}}
                    style={{width:'100%',padding:'11px 13px',borderRadius:9,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF2}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                  <div style={{fontSize:12,color:TXT3,marginTop:7,lineHeight:1.45}}>
                    На этот адрес придёт письмо со ссылкой. Почта поменяется только после того, как ты по ней перейдёшь.
                  </div>
                  <div style={{display:'flex',gap:8,marginTop:10}}>
                    <button data-testid="profile-email-submit" onClick={submitEmail} disabled={emailBusy||!emailInput.trim()}
                      style={{flex:1,padding:'10px',borderRadius:10,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:13,fontWeight:700,cursor:emailBusy||!emailInput.trim()?'default':'pointer',opacity:emailBusy||!emailInput.trim()?0.6:1,minHeight:'unset'}}>
                      {emailBusy?'Отправляем…':'Отправить подтверждение'}
                    </button>
                    <button onClick={()=>{setEmailEditing(false);setEmailMsg(null)}} disabled={emailBusy}
                      style={{flex:1,padding:'10px',borderRadius:10,border:`1px solid ${HAIR}`,background:'none',color:TXT3,fontSize:13,cursor:emailBusy?'default':'pointer',minHeight:'unset'}}>
                      Отмена
                    </button>
                  </div>
                </div>
              )}
              {emailMsg&&(
                <div style={{fontSize:12.5,lineHeight:1.45,marginTop:8,color:emailMsg.ok?TEA:'#ef4444'}}>{emailMsg.text}</div>
              )}
            </div>
            {/* Telegram — обычное поле, оно действительно пишется в profiles.telegram */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>Telegram</label>
              <input value={userEdit.telegram||''} type="text" placeholder="@username"
                onChange={e=>setUserEdit(u=>({...u,telegram:e.target.value}))}
                style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF}}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            </div>
            {/* Физические данные */}
            {/* Дата рождения — нативный календарь, хранится в ISO (YYYY-MM-DD) */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>Дата рождения</label>
              <input value={profile.birthdate||''} type="date" max={new Date().toISOString().slice(0,10)}
                onChange={e=>setProfile(p=>({...p,birthdate:e.target.value}))}
                style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:profile.birthdate?TXT:TXT3,outline:'none',boxSizing:'border-box',background:SURF}}
                onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
            </div>
            {/* Рост и Вес */}
            {[
              {key:'height', label:'Рост (см)', placeholder:'175', min:PROFILE_HEIGHT_MIN, max:PROFILE_HEIGHT_MAX},
              {key:'weight', label:'Вес (кг)',  placeholder:'75',  min:PROFILE_WEIGHT_MIN, max:PROFILE_WEIGHT_MAX},
            ].map(f=>(
              <div key={f.key}>
                <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>{f.label}</label>
                <input value={profile[f.key]||''} type="number" min={f.min} max={f.max} placeholder={f.placeholder}
                  onChange={e=>setProfile(p=>({...p,[f.key]:e.target.value}))}
                  style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF}}
                  onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
              </div>
            ))}

            {/* Цель */}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:TXT3,display:'block',marginBottom:6}}>Цель</label>
              {/* Строка-триггер */}
              <button onClick={()=>setShowGoalPicker(v=>!v)}
                style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${profile.goal?PUR:HAIR}`,background:profile.goal?'rgba(124,122,240,.14)':SURF2,cursor:'pointer',textAlign:'left',minHeight:'unset',transition:'all 0.2s'}}>
                <span style={{fontSize:15,fontWeight:600,color:profile.goal?PUR:TXT3}}>
                  {profile.goal||'Выбрать цель...'}
                </span>
                <span style={{fontSize:13,color:TXT3,transition:'transform 0.2s',display:'inline-block',transform:showGoalPicker?'rotate(180deg)':'rotate(0deg)'}}>▼</span>
              </button>
              {/* Раскрывающийся список */}
              <div style={{overflow:'hidden',maxHeight:showGoalPicker?400:0,opacity:showGoalPicker?1:0,transition:'max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease'}}>
                <div style={{display:'flex',flexDirection:'column',gap:6,paddingTop:8}}>
                  {[
                    {val:'Похудение',   icon:'flame'},
                    {val:'Набор массы', icon:'dumbbell'},
                    {val:'Поддержание', icon:'scale'},
                    {val:'Рельеф',      icon:'target'},
                  ].map(opt=>(
                    <button key={opt.val} onClick={()=>{setProfile(p=>({...p,goal:opt.val}));setShowGoalPicker(false)}}
                      style={{display:'flex',alignItems:'center',gap:10,padding:'11px 14px',borderRadius:10,border:`1.5px solid ${profile.goal===opt.val?PUR:HAIR}`,background:profile.goal===opt.val?'rgba(124,122,240,.14)':SURF2,cursor:'pointer',textAlign:'left',minHeight:'unset',transition:'all 0.15s'}}>
                      <GlassIcon name={opt.icon} size={26} />
                      <span style={{fontSize:15,fontWeight:600,color:profile.goal===opt.val?PUR:TXT2}}>{opt.val}</span>
                      {profile.goal===opt.val&&<span style={{marginLeft:'auto'}}><GlassIcon name="check" size={18} /></span>}
                    </button>
                  ))}
                  {/* Свой вариант */}
                  <div style={{display:'flex',gap:8,paddingTop:2}}>
                    <input value={customGoal} onChange={e=>setCustomGoal(e.target.value)}
                      placeholder="Написать свой вариант..."
                      style={{flex:1,padding:'11px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:14,color:TXT,outline:'none',background:SURF}}
                      onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR}
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
                  background:`linear-gradient(135deg,${TEA},#1f8f3d)`,
                  display:'flex',alignItems:'center',justifyContent:'center',
                  flexShrink:0,
                  animation: typingDone ? 'bot-float 2.2s ease-in-out infinite' : 'none',
                }}><GlassIcon name="robot" size={26} /></div>
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
            <div style={{background:SURF,border:`1px solid ${HAIR}`,borderRadius:12,padding:'14px 16px'}}>
              <div style={{fontSize:14,fontWeight:700,color:PUR,marginBottom:12}}>Активность</div>
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:TXT2,display:'block',marginBottom:6}}>Шагов в день (среднее)</label>
                  <input value={profile.steps||''} type="number" placeholder="например 8000"
                    onChange={e=>setProfile(p=>({...p,steps:e.target.value}))}
                    style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF2}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:TXT2,display:'block',marginBottom:6}}>Тренировок в неделю</label>
                  <input value={profile.gymDays||''} type="number" placeholder="например 3"
                    onChange={e=>setProfile(p=>({...p,gymDays:e.target.value}))}
                    style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF2}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:TXT2,display:'block',marginBottom:6}}>Род деятельности</label>
                  <input value={profile.occupation||''} type="text" placeholder="например: сидячая работа, много стою, физический труд"
                    onChange={e=>setProfile(p=>({...p,occupation:e.target.value}))}
                    style={{width:'100%',padding:'12px 14px',borderRadius:10,border:`1.5px solid ${HAIR}`,fontSize:15,color:TXT,outline:'none',boxSizing:'border-box',background:SURF2}}
                    onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:600,color:TXT2,display:'block',marginBottom:6}}>Уровень активности</label>
                  <div style={{display:'flex',gap:8}}>
                    {[['sedentary','Малоподвижный'],['moderate','Умеренный'],['high','Высокий']].map(([val,lbl])=>(
                      <button key={val} type="button" onClick={()=>setProfile(p=>({...p,activityLevel:val}))}
                        style={{flex:1,padding:'10px 6px',borderRadius:10,border:`1.5px solid ${profile.activityLevel===val?PUR:HAIR}`,background:profile.activityLevel===val?'rgba(124,122,240,.14)':SURF2,color:profile.activityLevel===val?PUR:TXT2,fontSize:12,fontWeight:600,cursor:'pointer',minHeight:'unset'}}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <button data-testid="profile-save" onClick={saveProfile} disabled={savingProfile} style={{padding:'14px',borderRadius:14,border:'none',background:saved?TEA:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:16,fontWeight:800,cursor:'pointer',transition:'background 0.2s',boxShadow:'0 8px 22px rgba(124,122,240,.4)',display:'flex',alignItems:'center',justifyContent:'center',gap:7}}>
              {saved&&<GlassIcon name="check" size={18} />}{savingProfile?'Сохраняем…':saved?'Сохранено':'Сохранить'}
            </button>
          </div>
        )}

        {/* ── Замеры ── */}
        {tab==='measurements'&&(
          <div>
            {/* Подсказка о замерах */}
            <div style={{display:'flex',gap:10,background:'rgba(255,159,10,.10)',border:'1px solid rgba(255,159,10,.30)',borderRadius:12,padding:'12px 14px',marginBottom:18,alignItems:'flex-start'}}>
              <GlassIcon name="danger" size={20} style={{flexShrink:0}} />
              <div style={{fontSize:13,color:TXT,lineHeight:1.6}}>
                <b style={{color:'#FF9F0A'}}>Важно:</b> все замеры делаются в самых выпуклых (наибольших) точках тела. Мышцы расслаблены, лента расположена горизонтально, без натяжения.
              </div>
            </div>

            <button onClick={()=>setShowAddM(true)} style={{width:'100%',padding:'14px',borderRadius:12,border:`2px dashed ${PUR}`,background:'rgba(124,122,240,.10)',color:PUR,fontSize:15,fontWeight:700,cursor:'pointer',marginBottom:20}}>
              + Добавить замеры
            </button>

            {/* История замеров */}
            {measurements.length===0?(
              <div style={{textAlign:'center',color:TXT3,fontSize:14,marginTop:32}}>
                <div style={{display:'flex',justifyContent:'center',marginBottom:12}}><GlassIcon name="ruler" size={44} /></div>
                Пока нет замеров. Добавь первые — и сможешь отслеживать прогресс.
              </div>
            ):(
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                {measurements.map((m,i)=>(
                  <div key={i} style={{background:SURF,borderRadius:14,padding:'16px',border:`1px solid ${HAIR}`}}>
                    <div style={{fontSize:14,fontWeight:700,color:TXT,marginBottom:12}}>📅 {fmtDate(m.date)}</div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                      {M_FIELDS.map(f=>m[f.key]?(
                        <div key={f.key} style={{background:SURF2,borderRadius:8,padding:'8px 10px'}}>
                          <div style={{fontSize:11,color:TXT3,marginBottom:2}}>{f.label}</div>
                          <div style={{fontSize:16,fontWeight:700,color:PUR}}>{m[f.key]} <span style={{fontSize:11,fontWeight:400,color:TXT3}}>см</span></div>
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
                <div style={{position:'fixed',bottom:0,left:0,right:0,background:SURF,borderRadius:'18px 18px 0 0',zIndex:11,padding:'20px 18px 36px',maxHeight:'85vh',overflowY:'auto'}}>
                  <div style={{width:36,height:4,borderRadius:2,background:SURF2,margin:'0 auto 18px'}}/>
                  <div style={{fontSize:16,fontWeight:700,color:TXT,marginBottom:6}}>Новые замеры</div>
                  <div style={{fontSize:12,color:TXT3,marginBottom:16}}>Все поля необязательны — заполни те, что есть</div>
                  <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:18}}>
                    {M_FIELDS.map(f=>(
                      <div key={f.key} style={{display:'flex',alignItems:'center',gap:10}}>
                        <label style={{fontSize:13,color:TXT2,flex:1}}>{f.label}</label>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <input value={newM[f.key]} type="number" placeholder="см"
                            onChange={e=>setNewM(p=>({...p,[f.key]:e.target.value}))}
                            style={{width:72,padding:'9px 10px',borderRadius:8,border:`1.5px solid ${HAIR}`,fontSize:14,color:TXT,outline:'none',textAlign:'center'}}
                            onFocus={e=>e.target.style.borderColor=PUR} onBlur={e=>e.target.style.borderColor=HAIR} />
                          <span style={{fontSize:12,color:TXT3}}>см</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button onClick={addMeasurement} style={{width:'100%',padding:'14px',borderRadius:14,border:'none',background:`linear-gradient(180deg, ${ACCENT2}, ${PUR})`,color:'#fff',fontSize:15,fontWeight:800,cursor:'pointer',boxShadow:'0 8px 22px rgba(124,122,240,.4)'}}>
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

// Pull-to-refresh — жест "потянуть вниз от самого верха" на мобильном экране
// перезагружает страницу. Раньше пользователю приходилось закрывать вкладку
// целиком, чтобы подтянуть свежие данные — нативный pull-to-refresh браузера
// тут не срабатывает, потому что скроллится не сама страница, а вложенный
// div (.mobile-content), а не document/body. Полная перезагрузка страницы —
// самый надёжный способ гарантированно обновить всё, включая данные внутри
// вложенных полноэкранных подэкранов дневника/тренировок (они рендерятся
// через createPortal, поэтому точечный рефетч пришлось бы тянуть в каждый
// из них по отдельности).
function usePullToRefresh(ref) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(null)
  const pullRef = useRef(0)
  const THRESHOLD = 70

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTouchStart = e => {
      startY.current = el.scrollTop <= 0 ? e.touches[0].clientY : null
    }
    const onTouchMove = e => {
      if (startY.current == null || refreshing) return
      const diff = e.touches[0].clientY - startY.current
      if (diff <= 0 || el.scrollTop > 0) { pullRef.current = 0; setPull(0); return }
      e.preventDefault()
      const next = Math.min(diff * 0.5, 90)
      pullRef.current = next
      setPull(next)
    }
    const onTouchEnd = () => {
      if (pullRef.current > THRESHOLD) {
        setRefreshing(true)
        setTimeout(() => window.location.reload(), 250)
      } else {
        pullRef.current = 0
        setPull(0)
      }
      startY.current = null
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [ref, refreshing])

  return { pull, refreshing }
}

// Реконструкция дневника тренировок из Supabase (workouts + workout_sets) —
// раньше "Мои тренировки"/прогресс/тоннаж читались ТОЛЬКО из localStorage
// браузера, поэтому на новом origin/устройстве (например localhost) дневник
// был пустым, даже если реальные подходы годами копились в workout_sets для
// AI-тренера. Теперь Supabase — источник правды: новые тренировки создают
// строку в workouts и подходы с её workout_id (buildWorkoutRecord ниже),
// старые подходы (ещё без workout_id, до этой миграции) группируются по дате
// как раньше — по одной карточке на день, это лучшее приближение, доступное
// без привязки к конкретной тренировке.
function buildExerciseEntryFromSets(name, sets) {
  const meta = EXERCISES.find(e => e.n === name)
  return {
    n: name, m: meta?.m || '', eq: meta?.eq || '',
    done: sets.some(s => s.kg != null || s.band_level != null),
    sets: sets.map(s => ({
      kg: s.kg != null ? String(s.kg) : '',
      bandLevel: s.band_level != null ? s.band_level : null,
      reps: s.reps != null ? String(s.reps) : '',
      recKg: s.recommended_kg != null ? String(s.recommended_kg) : '',
      note: s.note || '',
      rating: s.rating != null ? s.rating : '',
    })),
  }
}

// Одноразовый перенос старой локальной истории (fitpro_history) в Supabase —
// часть тренировок была записана ДО того, как появилась синхронизация в
// workout_sets вообще, и существует только в localStorage того браузера, где
// их когда-то занесли (обычно прод). Без этого шага такие тренировки никогда
// не появятся ни на каком другом устройстве/origin, включая localhost.
async function migrateLocalWorkoutHistoryToSupabase(userId) {
  let local
  try { local = JSON.parse(localStorage.getItem('fitpro_history') || '[]') } catch { local = [] }
  // fromSupabaseFallback — карточки, которые сами являются лишь чтением уже
  // существующих в Supabase данных (см. loadWorkoutHistoryFromSupabase), их
  // нельзя мигрировать обратно — иначе то, что удалили из Supabase напрямую,
  // но что успело закэшироваться в localStorage, будет воскрешено этой же
  // функцией на следующей загрузке. Доп. проверка по сигнатуре синтетической
  // карточки (имя ровно "Тренировка", без цвета/комментария/длительности) —
  // страховка для копий, закэшированных ДО того как появился сам флаг выше;
  // настоящая новая тренировка называется иначе ("Новая тренировка" по
  // умолчанию), так что коллизии с реальными данными тут не будет.
  const looksLikeStaleFallbackCopy = w => w.name === 'Тренировка' && !w.comment && w.duration == null
  const toMigrate = local.filter(w => w.workoutId == null && !w.fromSupabaseFallback && !looksLikeStaleFallbackCopy(w))
  if (!toMigrate.length) return

  for (const workout of toMigrate) {
    const { data: wRow, error: we } = await supabase.from('workouts').insert({
      user_id: userId, name: workout.name || null, color: workout.color || null,
      date: workout.date, duration: workout.duration != null ? workout.duration : null, comment: workout.comment || null,
    }).select('id').single()
    if (we) { console.error('Миграция тренировки: не удалось создать запись:', we); continue }
    const workoutId = wRow?.id
    if (workoutId == null) continue

    if (workout.supabaseSetIds?.length) {
      // Подходы уже когда-то засинкались (старым способом, без привязки к
      // тренировке) — просто привязываем их к новой строке, не дублируем.
      const { error } = await supabase.from('workout_sets').update({ workout_id: workoutId }).in('id', workout.supabaseSetIds)
      if (error) console.error('Миграция тренировки: не удалось привязать подходы по id:', error)
      continue
    }

    const isoDate = (workout.date || '').slice(0, 10)
    const exerciseNames = [...new Set((workout.exercises || []).map(ex => ex.n).filter(Boolean))]
    let linked = false
    if (isoDate && exerciseNames.length) {
      // Пытаемся найти уже существующие, но ещё ничьи (workout_id is null)
      // строки за эту дату/упражнения — это подходы, засинканные раньше, чем
      // появилось отслеживание id, привязываем их вместо вставки дублей.
      const { data: existing, error: fe } = await supabase.from('workout_sets').select('id')
        .eq('user_id', userId).eq('date', isoDate).in('exercise', exerciseNames).is('workout_id', null)
      if (fe) console.error('Миграция тренировки: ошибка поиска существующих подходов:', fe)
      if (existing?.length) {
        const { error } = await supabase.from('workout_sets').update({ workout_id: workoutId }).in('id', existing.map(r => r.id))
        if (error) console.error('Миграция тренировки: не удалось привязать найденные подходы:', error)
        linked = true
      }
    }

    if (!linked) {
      // Ни supabaseSetIds, ни совпадающих строк в базе не нашлось — эта
      // тренировка ещё ни разу не попадала в Supabase, заносим её подходы сейчас.
      const rows = []
      for (const ex of workout.exercises || []) {
        for (const s of ex.sets || []) {
          if (!s.kg && !s.reps && s.bandLevel == null) continue
          rows.push({ user_id: userId, exercise: ex.n, date: isoDate, kg: s.kg ? Number(s.kg) : null, reps: s.reps ? Number(s.reps) : null, note: s.note || null, recommended_kg: s.recKg ? Number(s.recKg) : null, rating: s.rating ? Number(s.rating) : null, workout_id: workoutId, band_level: s.bandLevel ?? null })
        }
      }
      if (rows.length) {
        const { error } = await supabase.from('workout_sets').insert(rows)
        if (error) console.error('Миграция тренировки: не удалось вставить подходы:', error)
      }
    }
  }
}

async function loadWorkoutHistoryFromSupabase(userId) {
  const [{ data: workoutsRows, error: we }, { data: setsRows, error: se }] = await Promise.all([
    supabase.from('workouts').select('*').eq('user_id', userId),
    supabase.from('workout_sets').select('*').eq('user_id', userId).order('id'),
  ])
  if (we) console.error('Ошибка загрузки тренировок из Supabase:', we)
  if (se) console.error('Ошибка загрузки подходов из Supabase:', se)
  const hadError = !!(we || se)

  const byWorkoutId = {}
  const byDateLegacy = {}
  for (const s of setsRows || []) {
    if (s.workout_id != null) (byWorkoutId[s.workout_id] ??= []).push(s)
    else (byDateLegacy[s.date] ??= []).push(s)
  }

  const groupByExercise = sets => {
    const byExercise = {}
    for (const s of sets) (byExercise[s.exercise] ??= []).push(s)
    return Object.entries(byExercise).map(([name, exSets]) => buildExerciseEntryFromSets(name, exSets))
  }

  const result = []
  for (const w of workoutsRows || []) {
    const sets = byWorkoutId[w.id]
    if (!sets?.length) continue
    result.push({
      workoutId: w.id, name: w.name || 'Тренировка', color: w.color || PUR,
      // Кто внёс запись: null — сам владелец дневника, uuid — его тренер
      // (sql/2026-08-04_trainer_logs_workouts.sql). Нужно только для пометки
      // в карточке тренировки, на расчёты не влияет.
      createdBy: w.created_by || null,
      date: w.date, duration: w.duration != null ? Number(w.duration) : null, comment: w.comment || '',
      exercises: groupByExercise(sets),
    })
  }
  for (const [date, sets] of Object.entries(byDateLegacy)) {
    result.push({
      // fromSupabaseFallback — эта карточка ЦЕЛИКОМ построена из того, что уже
      // лежит в Supabase (просто без workout_id) — её нельзя путать с "новой
      // локальной тренировкой, которую ещё нужно засинхронизировать". Без
      // этого флага миграция при следующей загрузке приняла бы закэшированную
      // в localStorage копию этой карточки за несинхронизированную и заново
      // вставила бы её подходы в Supabase — воскрешая то, что явно удалили.
      fromSupabaseFallback: true,
      name: 'Тренировка', color: PUR, date, duration: null, comment: '',
      exercises: groupByExercise(sets),
    })
  }
  result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  return { history: result, error: hadError }
}

function PullToRefreshIndicator({ pull, refreshing }) {
  if (!refreshing && pull < 4) return null
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 0, overflow: 'visible',
      display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5,
    }}>
      <div style={{
        marginTop: Math.min(pull, 90) - 34, width: 30, height: 30, borderRadius: '50%',
        border: `3px solid ${HAIR}`, borderTopColor: PUR, boxSizing: 'border-box',
        background: SURF, transition: refreshing ? 'none' : 'margin-top .1s',
        animation: refreshing ? 'ptr-spin .7s linear infinite' : 'none',
        transform: refreshing ? 'none' : `rotate(${pull * 3}deg)`,
      }} />
    </div>
  )
}

// Плашка свёрнутой тренировки — показывается на ЛЮБОМ экране, кроме самого
// экрана активной тренировки (см. isWorkoutForeground в App). Портал в
// document.body — не зависит от того, где в дереве она объявлена, и не
// перехватывает события других вкладок (кроме своей собственной area).
// Таймер считается от meta.startedAt независимо от WorkoutsView (та же
// логика "от отметки", не тиками — см. задачу про таймер), так что даже
// если WorkoutsView скрыт (display:none) и не перерисовывается, плашка
// всё равно идёт секунда в секунду.
function MinimizedWorkoutBar({ meta, isMobile, bottomOffset, onClick }) {
  const [now,setNow]=useState(()=>Date.now())
  useEffect(()=>{
    const id=setInterval(()=>setNow(Date.now()),1000)
    return()=>clearInterval(id)
  },[])
  const elapsed=meta.startedAt?Math.max(0,Math.floor((now-meta.startedAt)/1000)):0
  const fmt=s=>{
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }
  return createPortal(
    // z-index 1065 — выше полноэкранных Профиля (1050) и Настроек (1060),
    // чтобы плашка была видна и там (см. задачу "любой другой путь ухода"),
    // но ниже шторки профиля (1100) и тостов/модалок (1200+) — те открыты
    // считаные секунды, плашка на это время просто не видна, а не перекрывает
    // их кнопки поверх. AI-кнопка (1070) с плашкой не пересекается вообще:
    // при видимой плашке кнопка приподнята на её высоту (extraBottomOffset).
    <div onClick={onClick} style={{
      position:'fixed', left:0, right:0, bottom:bottomOffset, zIndex:1065,
      background:meta.wColor||PUR, color:'#fff', cursor:'pointer',
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'10px 16px', boxShadow:'0 -2px 12px rgba(0,0,0,0.18)',
      paddingBottom:isMobile?'max(10px, env(safe-area-inset-bottom))':10,
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0 }}>
        <GlassIcon name="dumbbell" size={22} />
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{meta.wName}</div>
          <div style={{ fontSize:11, opacity:0.85, fontVariantNumeric:'tabular-nums' }}>⏱ {fmt(elapsed)}</div>
        </div>
      </div>
      <span style={{ fontSize:13, fontWeight:700, flexShrink:0, marginLeft:10, whiteSpace:'nowrap' }}>Вернуться ›</span>
    </div>
  , document.body)
}

// Экран для случая, когда сессию не удалось ПОДТВЕРДИТЬ (сеть/5xx), но токены
// на месте. Осознанно НЕ LandingPage: показать форму входа тут — значит соврать
// человеку, что он вышел, и спровоцировать повторный вход там, где достаточно
// дождаться сети. Кнопка дублирует авторетрай по online/visibilitychange.
function ConnectionErrorView({ onRetry, retrying }) {
  return (
    <div style={{ minHeight:'100vh',background:BG,display:'flex',alignItems:'center',justifyContent:'center',padding:24 }}>
      <div style={{ maxWidth:340,width:'100%',textAlign:'center' }}>
        <div style={{ fontSize:17,fontWeight:700,color:TXT,marginBottom:10 }}>Нет связи с сервером</div>
        <div style={{ fontSize:13,color:TXT2,lineHeight:1.5,marginBottom:20 }}>
          Не удалось проверить, что ты в аккаунте. Выходить не нужно — как только
          связь вернётся, приложение откроется само.
        </div>
        <button onClick={onRetry} disabled={retrying}
          style={{ fontSize:14,fontWeight:600,padding:'11px 26px',borderRadius:12,border:`1px solid ${HAIR}`,background:SURF2,color:retrying?TXT3:PUR,cursor:retrying?'default':'pointer' }}>
          {retrying?'Проверяем…':'Повторить'}
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [user,setUser]=useState(null)
  const [authLoading,setAuthLoading]=useState(true)
  // Сессию не удалось подтвердить из-за временного сбоя (сеть/5xx), при этом
  // токены в localStorage целы. НЕ то же самое, что "пользователь вышел":
  // показываем экран "нет связи" с ретраем, а не форму входа. См. authState.js.
  const [authError,setAuthError]=useState(false)
  const [authRetrying,setAuthRetrying]=useState(false)
  const [authRetryToken,setAuthRetryToken]=useState(0)
  // Зеркало authError для слушателей online/visibilitychange: они вешаются
  // один раз с пустыми зависимостями и иначе видели бы authError навсегда false.
  const authErrorRef=useRef(false)
  useEffect(()=>{authErrorRef.current=authError},[authError])
  // Взводится событием PASSWORD_RECOVERY из onAuthStateChange (переход по
  // ссылке "Восстановление пароля" из письма) — пока true, показываем
  // ResetPasswordView вместо обычного входа/приложения, см. ниже.
  const [recoveryMode,setRecoveryMode]=useState(false)
  // Объявлены здесь (выше applySession/эффекта авторизации ниже) — applySession
  // синхронно обнуляет их при смене пользователя устройства, ДО setUser, чтобы
  // чужие данные не мелькнули; persist-в-localStorage эффекты остались у
  // остального стейта истории (historyVersion и т.п.), ниже по файлу.
  const [workoutHistory,setWorkoutHistory]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_history')||'[]')}catch{return []}
  })
  const [customExercises,setCustomExercises]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('fitpro_custom_ex')||'[]')}catch{return []}
  })
  // Карта видео упражнений с сервера (exercise_videos): { имя → {video_url,
  // poster_url} }. Публичное чтение (RLS select=true), грузим один раз на маунт
  // независимо от входа. Показ — по имени упражнения в WorkoutsView/LibraryView.
  const [exerciseVideos,setExerciseVideos]=useState({})
  useEffect(()=>{
    let cancelled=false
    let timer=null
    // Повтор с нарастающей задержкой: без него сетевой сбой на маунте оставлял
    // приложение без видео до перезапуска. Не больше трёх повторов.
    const DELAYS=[1500,4000,9000]
    const load=(attempt=0)=>{
      supabase.from('exercise_videos').select('exercise_name,context,video_url,poster_url').then(({data,error})=>{
        if(cancelled)return
        // Ретраим только при ошибке или отсутствии ответа. Пустой массив —
        // законный результат (в базе может не быть ни одного видео), не ретраим.
        if(error||data==null){
          console.error('Карта видео: ошибка загрузки exercise_videos'+(error?`: ${error.message||error}`:' — пустой ответ'))
          if(attempt<DELAYS.length) timer=setTimeout(()=>load(attempt+1),DELAYS[attempt])
          return
        }
        // Двухуровневая карта: { имя → { контекст → {video_url,poster_url} } }.
        // Отсутствующие контексты просто отсутствуют, пустых объектов не создаём.
        const map={}
        for(const r of data){
          const ctx=r.context||'default'
          ;(map[r.exercise_name]||(map[r.exercise_name]={}))[ctx]={video_url:r.video_url,poster_url:r.poster_url}
        }
        setExerciseVideos(map) // успех — новых повторов не планируем, счётчик сброшен
      })
    }
    load()
    return()=>{cancelled=true;if(timer)clearTimeout(timer)}
  },[])
  // Глобальный каталог упражнений (правки тренера). Читаем публично, мержим с
  // зашитым EXERCISES. reloadCatalog — перечитать после правок тренером.
  const [catalogRows,setCatalogRows]=useState([])
  // Та же схема повторов, что у карты видео: тихий сбой оставлял каталог
  // незагруженным. reloadCatalog() (публичный, зовётся и после правок тренера)
  // всегда стартует новую цепочку с нуля; ref держит отложенный повтор, чтобы
  // его можно было отменить при размонтировании и не плодить параллельные.
  const catalogRetryRef=useRef(null)
  const loadCatalog=(attempt=0)=>{
    if(catalogRetryRef.current){clearTimeout(catalogRetryRef.current);catalogRetryRef.current=null}
    supabase.from('catalog_exercises').select('name,muscle_group,equipment,type,hidden,technique,display_name').then(({data,error})=>{
      if(error||data==null){
        console.error('Каталог: ошибка загрузки catalog_exercises'+(error?`: ${error.message||error}`:' — пустой ответ'))
        const DELAYS=[1500,4000,9000]
        if(attempt<DELAYS.length) catalogRetryRef.current=setTimeout(()=>loadCatalog(attempt+1),DELAYS[attempt])
        return
      }
      setCatalogRows(data) // успех — счётчик сброшен, отложенных повторов нет
    })
  }
  const reloadCatalog=()=>loadCatalog(0)
  useEffect(()=>{
    reloadCatalog()
    return()=>{if(catalogRetryRef.current)clearTimeout(catalogRetryRef.current)}
  },[])
  const mergedExercises=useMemo(()=>mergeCatalog(catalogRows),[catalogRows])
  const catalogValue=useMemo(()=>({exercises:mergedExercises,reloadCatalog}),[mergedExercises])
  // Шаблоны программ из базы (program_templates) — публичное чтение с теми же
  // повторами при сетевой ошибке, что у каталога. Пустой массив = запасной
  // вариант из кода (mergeTemplates отдаст FOLDERS/PROGRAMS_MAP).
  const [templateRows,setTemplateRows]=useState([])
  const templatesRetryRef=useRef(null)
  const loadTemplates=(attempt=0)=>{
    if(templatesRetryRef.current){clearTimeout(templatesRetryRef.current);templatesRetryRef.current=null}
    supabase.from('program_templates').select('key,display_name,sort,context,structure,hidden').then(({data,error})=>{
      if(error||data==null){
        console.error('Шаблоны: ошибка загрузки program_templates'+(error?`: ${error.message||error}`:' — пустой ответ'))
        const DELAYS=[1500,4000,9000]
        if(attempt<DELAYS.length) templatesRetryRef.current=setTimeout(()=>loadTemplates(attempt+1),DELAYS[attempt])
        return
      }
      setTemplateRows(data)
    })
  }
  const reloadTemplates=()=>loadTemplates(0)
  useEffect(()=>{
    loadTemplates()
    return()=>{if(templatesRetryRef.current)clearTimeout(templatesRetryRef.current)}
  },[])
  const templatesValue=useMemo(()=>({...mergeTemplates(templateRows),reload:reloadTemplates}),[templateRows])
  // Отображаемое имя назначенной программы по её ключу — из того же источника
  // шаблонов, что и список папок (label по key). Сентинел «программа тренера»
  // → человекочитаемая строка. Не выбрана (пусто) → null (в промте прежний
  // запасной вариант). Для ИИ-ассистента, чтобы он называл программу как на экране.
  const programLabelOf=key=>!key?null:(key===TRAINER_PROGRAM_KEY?'Персональная программа от тренера':((templatesValue.folders.find(f=>f.key===key)||{}).label||key))
  const [userRole,setUserRole]=useState(()=>localStorage.getItem('fitpro_role')||'client')
  // Согласие на обработку ПДн (152-ФЗ). consentLoaded — «ответ из базы получен»,
  // до него приложение не рендерим вообще, иначе на секунду мелькнёт контент
  // тому, кто согласия ещё не давал.
  const [consentLoaded,setConsentLoaded]=useState(false)
  const [consentGiven,setConsentGiven]=useState(false)
  // Профиль не прочитался (сеть/5xx/401). Отдельно от consentGiven: «не смогли
  // спросить» — не повод требовать согласие заново у того, кто его давал.
  const [consentError,setConsentError]=useState(false)
  const [consentRetryToken,setConsentRetryToken]=useState(0)
  // Признак «к клиенту прикреплён тренер» (profiles.coach_id непустой).
  // По умолчанию false, пока профиль не загрузился — значок видео тренеру не
  // мигнёт свободному пользователю. У самого тренера coach_id пустой, так что
  // он тоже эту функцию не увидит.
  // ВАЖНО: это НЕ уровень подписки. Пакет живёт отдельно, в access ниже —
  // у клиента с тренером может не быть ПРЕМИУМА и наоборот.
  const [hasCoach,setHasCoach]=useState(false)
  // «Клиент тренера с истёкшей подпиской» — см. загрузку профиля ниже.
  const [coachSubExpired,setCoachSubExpired]=useState(false)
  // Уровень доступа по пакету (см. effectiveAccess, src/plans.js): 0 СТАРТ,
  // 1 БАЗА, 2 ПРОФИТ, 3 ПРЕМИУМ. До загрузки профиля — 0: платную функцию
  // лучше на миг не показать, чем показать тому, кто её не купил.
  const [access,setAccess]=useState(()=>effectiveAccess(null))
  // Стартовый экран. У тренера — его Dashboard, у клиента — «Тренировки».
  // Раньше клиент открывался на 'dashboard', а тот отдавал ему ВТОРОЙ
  // экземпляр DiaryView — то есть стартовый экран и вкладка «Дневник» были
  // буквально одним и тем же компонентом с одинаковым содержимым.
  //
  // Считаем синхронно, из того же localStorage, что и userRole строкой выше:
  // через эффект была бы видна лишняя перерисовка — клиент на кадр увидел бы
  // чужой экран.
  const [nav,setNav]=useState(()=>userRole==='trainer'?'dashboard':'workouts')
  // Тренеру стартовое «Добро пожаловать» не нужно — его рабочий экран это
  // «Клиенты». Уводим один раз за сессию, при первом определении роли, и
  // только если тренер ещё не ушёл с dashboard сам. Ref гарантирует
  // одноразовость: вернувшись на главную позже, он там и останется.
  const trainerLandedRef=useRef(false)
  useEffect(()=>{
    if(trainerLandedRef.current||userRole!=='trainer')return
    trainerLandedRef.current=true
    if(nav==='dashboard')setNav('clients')
  },[userRole,nav])
  // История переходов верхнего уровня — чтобы "назад" из экранов вроде деталей
  // клиента (открываются и с Главной, и со вкладки Клиенты) вело туда, откуда
  // реально пришли, а не на жёстко заданный экран.
  const navHistoryRef=useRef([])
  const prevNavRef=useRef(nav)
  useEffect(()=>{
    if(prevNavRef.current!==nav){
      navHistoryRef.current.push(prevNavRef.current)
      if(navHistoryRef.current.length>20)navHistoryRef.current.shift()
      prevNavRef.current=nav
    }
  },[nav])
  const goBackNav=()=>{
    const prev=navHistoryRef.current.pop()
    setNav(prev??'dashboard')
  }
  // Взводится, когда nav принудительно переключают на 'workouts' ради
  // редактирования/быстрого старта тренировки из другого раздела (не обычный
  // клик по вкладке) — на выходе из экрана тренировки это сигнал вернуть
  // пользователя туда, откуда он реально пришёл, через goBackNav().
  const borrowedNavRef=useRef(false)
  // diarySectionRef — DiaryView сообщает сюда свой текущий подраздел через
  // onSectionChange, всегда актуален, пока DiaryView смонтирован.
  // pendingSectionRestoreRef — снимок diarySectionRef в момент вынужденного
  // прыжка (см. handleEditWorkout/handleWorkoutAction), который DiaryView
  // при повторном монтировании подхватит как initialSection и откроется сразу
  // в нужном подразделе, а не на корневом меню.
  // Важно: рендер читает этот реф, но НЕ мутирует его — компонент обёрнут в
  // StrictMode, тело рендера вызывается дважды в dev, и мутация во время
  // рендера привела бы к тому, что второй вызов увидел бы уже очищенное
  // значение. Поэтому очистка вынесена в отдельный эффект ниже, который
  // срабатывает уже после коммита — и только при возврате в Дневник.
  const mobileContentRef=useRef(null)
  const { pull:ptrPull, refreshing:ptrRefreshing } = usePullToRefresh(mobileContentRef)
  const diarySectionRef=useRef(null)
  const pendingSectionRestoreRef=useRef(null)
  useEffect(()=>{
    if(nav==='dashboard'||nav==='progress')pendingSectionRestoreRef.current=null
  },[nav])
  // diaryJumpToken — принудительный переход в конкретный подраздел Дневника
  // (например по кнопке "Перейти к тренировке" из чата), даже если Дневник
  // уже смонтирован и nav не меняется (тогда лишь смена initialSection в
  // lazy-инициализаторе useState ничего не даст — нужен реальный сигнал).
  const [diaryJumpToken,setDiaryJumpToken]=useState(0)
  const [sc,setSC]=useState(null)
  const [isMobile,setIsMobile]=useState(()=>window.innerWidth<768)
  // Telegram Mini App — понадобится дальше (авторизацию/движок пока не трогаем).
  const [isTelegram,setIsTelegram]=useState(false)
  // Авто-вход внутри Telegram (см. эффект ниже) — пока идёт попытка, вместо
  // LandingPage показываем "Входим…"; при неудаче тихо откатываемся на
  // обычный email-вход, а не тупик.
  const [telegramAuthPending,setTelegramAuthPending]=useState(false)
  const telegramAuthTriedRef=useRef(false)
  // ── Вход по ссылке доступа (?access=<токен>) ─────────────────────────────
  // Клиент, которого тренер завёл сам: аккаунт у него уже есть, пароля нет,
  // Telegram не обязателен — ссылка меняется на сессию тем же способом, что и
  // телеграм-вход. Токен держим в ref: из адресной строки он стирается сразу,
  // а обменивать его нужно позже — когда станет известно, что сохранённой
  // сессии нет (authLoading===false и user пуст).
  const pendingAccessRef=useRef(null)
  const accessAuthTriedRef=useRef(false)
  const [accessAuthPending,setAccessAuthPending]=useState(false)
  const [accessAuthError,setAccessAuthError]=useState('')
  const [pendingWorkoutAction,setPendingWorkoutAction]=useState(null)
  const [showProfileView,setShowProfileView]=useState(false)
  const [showProfileSheet,setShowProfileSheet]=useState(false)
  const [showSettingsView,setShowSettingsView]=useState(false)
  // Открытая под-страница Настроек: null | 'plans' | 'policy' | 'consent'. Живёт здесь, а не
  // в SettingsView, потому что стрелка «назад» в шапке ниже должна закрывать
  // сначала под-страницу и только потом сами Настройки.
  const [settingsSubPage,setSettingsSubPage]=useState(null)
  const aiRef=useRef()

  // Тренировка "на переднем плане" — виден именно её полный экран, а не
  // плашка свёрнутой тренировки. nav==='workouts' само по себе НЕ
  // достаточно: аватар/Профиль/Настройки открываются как оверлеи ПОВЕРХ
  // текущего nav (не меняя его), поэтому даже если nav всё ещё 'workouts',
  // пока один из этих оверлеев открыт, тренировку с экрана реально не
  // видно — плашка должна показываться и там (см. задачу про "любой другой
  // путь ухода с экрана тренировки").
  const isWorkoutForeground = nav==='workouts' && !showProfileView && !showSettingsView && !showProfileSheet

  // Тренер ведёт занятие (src/TrainerSession.jsx) — там в правом нижнем углу
  // стоит секундомер, и плавающая кнопка ассистента перекрывала бы его. Флаг
  // приходит событием: TrainerSession монтируется глубоко внутри карточки
  // клиента, и тащить проп через всю цепочку ради одной кнопки незачем.
  const [trainerSessionActive,setTrainerSessionActive]=useState(false)
  useEffect(()=>{
    const h=e=>setTrainerSessionActive(!!e.detail?.active)
    window.addEventListener('fitpro:trainer-session',h)
    return()=>window.removeEventListener('fitpro:trainer-session',h)
  },[])
  // Снимок активной тренировки для плашки (см. onWorkoutMeta в WorkoutsView) —
  // null, когда тренировки нет. Плашка показывается когда снимок есть И
  // тренировка не на переднем плане.
  const [workoutMeta,setWorkoutMeta]=useState(null) // {wName,wColor,startedAt} | null
  const workoutMinimized = !!workoutMeta && !isWorkoutForeground
  // Активная тренировка на весь экран (мобайл) — прячем общий хедер App и
  // отдаём его место контенту (см. мобильный layout ниже).
  const workoutFullscreen = !!workoutMeta && isWorkoutForeground
  // Открыть свёрнутую тренировку — закрывает все оверлеи, которые могли её
  // загородить (см. isWorkoutForeground), и возвращает nav на 'workouts'.
  const reopenWorkout=()=>{
    setShowProfileView(false)
    setShowSettingsView(false)
    setSettingsSubPage(null)
    setShowProfileSheet(false)
    setNav('workouts')
  }

  // «Назад» в шапке Настроек: под-страница → список Настроек → Главная.
  // Раньше стрелка всегда закрывала Настройки целиком, и из Политики/Оферты
  // пользователь улетал на Главную, минуя список настроек.
  const closeSettingsOrSubPage=()=>{
    if(settingsSubPage){setSettingsSubPage(null);return}
    setShowSettingsView(false)
  }

  // Настройки всегда открываются со списка, а не на под-странице, открытой в
  // прошлый заход.
  const openSettings=()=>{
    setSettingsSubPage(null)
    setShowSettingsView(true)
  }

  // Открыть Тарифы из любой точки приложения (подсказки «доступно в ПРОФИТ»).
  // Настройки открываются сразу на под-странице тарифов; «назад» из неё, как и
  // обычно, вернёт в список Настроек — см. closeSettingsOrSubPage.
  const openPlans=()=>{
    setShowSettingsView(true)
    setSettingsSubPage('plans')
  }

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

  // Захват ссылки доступа при загрузке. Токен из адресной строки убираем
  // НЕМЕДЛЕННО — до любых сетевых запросов и независимо от того, будем ли мы
  // его вообще обменивать: иначе он осядет в истории браузера, в заголовке
  // вкладки и уедет вместе со случайно отправленным адресом страницы. Обмен
  // делает эффект ниже, здесь только достаём и прячем — тот же приём, что у
  // ?coach= и ?trainer=1.
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search)
    const access=params.get('access')
    if(!access)return
    pendingAccessRef.current=access
    params.delete('access')
    const newUrl=window.location.pathname+(params.toString()?'?'+params.toString():'')
    window.history.replaceState({},'',newUrl)
  },[])

  // ── Ссылка-приглашение от тренера ────────────────────────────────────────
  // id тренера из приглашения. Кладём в ref, а не в state: привязку решаем
  // ниже, когда загрузится профиль (нужны роль и текущий coach_id), а лишняя
  // перерисовка тут ни к чему.
  const pendingInviteRef=useRef(null)
  // Тост о применении приглашения — тот же паттерн, что showFoodSaveError.
  const [inviteToast,setInviteToast]=useState(null)   // {text,color}
  const flashInvite=(text,color)=>{setInviteToast({text,color});setTimeout(()=>setInviteToast(null),4000)}
  // Перечитать профиль после привязки — тем же приёмом, что historyReloadToken.
  const [profileReloadToken,setProfileReloadToken]=useState(0)

  // Захват приглашения при загрузке. Telegram отдаёт его в start_param
  // ('coach_<uuid>'), веб — обычным ?coach=<uuid>. Сам uuid не проверяем:
  // это делает сервер (api/link-client.js), здесь только достаём и прячем.
  useEffect(()=>{
    const startParam=window.Telegram?.WebApp?.initDataUnsafe?.start_param
    if(typeof startParam==='string'&&startParam.startsWith('coach_')){
      pendingInviteRef.current=startParam.slice('coach_'.length)
      return   // start_param не наш, чистить его не нужно
    }
    const params=new URLSearchParams(window.location.search)
    const coach=params.get('coach')
    if(!coach)return
    pendingInviteRef.current=coach
    // Чистим адресную строку тем же способом, что обработчик ?trainer=1 выше:
    // иначе приглашение осталось бы в URL и «срабатывало» при каждом заходе.
    params.delete('coach')
    const newUrl=window.location.pathname+(params.toString()?'?'+params.toString():'')
    window.history.replaceState({},'',newUrl)
  },[])

  // ── Возврат из Продамуса после оплаты (?paid=1) ──────────────────────────
  // Ставится только для веб-оплаты (api/create-payment.js, source:'web') —
  // из Telegram человек возвращается в бота, и этот путь не работает.
  //
  // Про повторные чтения профиля. Редирект и вебhook Продамуса — две
  // независимые дороги: человек уже вернулся в приложение, а уведомление об
  // оплате (api/prodamus-webhook.js), которое и проставляет пакет в profiles,
  // может дойти на несколько секунд позже. Прочитав профиль только один раз,
  // мы показали бы старый тариф сразу после оплаты — то есть «деньги ушли, а
  // ничего не изменилось». Поэтому читаем сразу, потом на 5-й и 15-й секунде и
  // БОЛЬШЕ НЕ ПРОБУЕМ: если за 15 секунд вебхук не пришёл, дело не в гонке, и
  // бесконечный опрос сервера ничего не исправит — доступ подтянется при
  // следующем открытии приложения.
  const [paidToast,setPaidToast]=useState(false)
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search)
    if(params.get('paid')!=='1')return
    // Параметр убираем сразу, тем же приёмом, что ?access= и ?coach= выше:
    // иначе он останется в истории и «сработает» при каждом обновлении
    // страницы, показывая сообщение об оплате, которой не было.
    params.delete('paid')
    const newUrl=window.location.pathname+(params.toString()?'?'+params.toString():'')
    window.history.replaceState({},'',newUrl)

    setPaidToast(true)
    setProfileReloadToken(t=>t+1)
    const timers=[
      setTimeout(()=>setProfileReloadToken(t=>t+1),5000),
      setTimeout(()=>setProfileReloadToken(t=>t+1),15000),
      setTimeout(()=>setPaidToast(false),12000),
    ]
    return()=>timers.forEach(clearTimeout)
  },[])

  // Второй заход за start_param — уже после того, как Telegram опознан и
  // отработал tg.ready(). Страхует случай, когда на mount initDataUnsafe был
  // ещё пуст. Уже захваченное приглашение (в том числе из ?coach=) не трогаем:
  // первым пришло — тем и привязываем.
  useEffect(()=>{
    if(!isTelegram||pendingInviteRef.current)return
    const startParam=window.Telegram?.WebApp?.initDataUnsafe?.start_param
    if(typeof startParam==='string'&&startParam.startsWith('coach_')){
      pendingInviteRef.current=startParam.slice('coach_'.length)
    }
  },[isTelegram])

  // Собственно привязка. Дёргается один раз — после того как стало известно,
  // что пользователь клиент и тренера у него ещё нет. Неудача не критична:
  // приложение работает и без привязки, поэтому просто сообщаем клиенту.
  const applyInvite=async(trainerId)=>{
    try{
      const{data:sessionData}=await supabase.auth.getSession()
      const token=sessionData?.session?.access_token
      if(!token){console.error('Приглашение: нет access-токена, привязка пропущена');return}
      const res=await fetch('/api/link-client',{
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({trainerId}),
      })
      const body=await res.json().catch(()=>null)
      if(!res.ok||!body?.ok){
        console.error('Приглашение: привязка не удалась',res.status,body?.error||'')
        flashInvite('Не удалось применить приглашение',DANGER)
        return
      }
      // already — клиент уже с тренером, сервер ничего не менял. Молча: он
      // не просил ничего менять, а «ты уже привязан» звучит как ошибка.
      if(body.already){console.log('Приглашение: клиент уже привязан, привязка не менялась');return}
      setHasCoach(true)
      setProfileReloadToken(t=>t+1)
      flashInvite(`Теперь тебя ведёт ${body.trainer_name||'твой тренер'} 🎉`,TEA)
    }catch(e){
      console.error('Приглашение: сетевая ошибка привязки:',e)
      flashInvite('Не удалось применить приглашение',DANGER)
    }
  }

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

  // Локальный кэш (fitpro_*: история, дневник, замеры, профиль, клиенты) не
  // привязан к пользователю сам по себе — если в этом браузере без явного
  // "Выйти" входит ДРУГОЙ аккаунт (обновление сессии, общий браузер, вход
  // после закрытия вкладки), новый пользователь на секунды увидел бы имя/
  // аватар/данные предыдущего, пока не подгрузится база (см. mergeUserWithProfile
  // выше — он берёт имя из fitpro_user/fitpro_profile). fitpro_owner_uid —
  // чей именно это кэш; при смене владельца чистим ДО setUser, чтобы чужое
  // не мелькнуло вообще. При том же владельце (обычная перезагрузка) не
  // трогаем ничего — кэш показывается сразу, без пустого экрана.
  const applySession=(session)=>{
    const incomingId=session?.user?.id??null
    const storedOwner=localStorage.getItem('fitpro_owner_uid')
    if(incomingId&&storedOwner&&storedOwner!==incomingId){
      clearFitproData()
      setWorkoutHistory([])
      setCustomExercises([])
    }
    // После возможной чистки выше — иначе clearFitproData() стёр бы и сам этот ключ.
    if(incomingId)localStorage.setItem('fitpro_owner_uid',incomingId)
    setUser(mergeUserWithProfile(session?.user??null))
  }

  // Первичное чтение сессии. Три исхода вместо прежних двух — см.
  // resolveAuthOutcome в src/authState.js. Ключевое: UNAVAILABLE (рефреш не
  // прошёл из-за сети/5xx, но токены в localStorage целы) больше НЕ приводит
  // к setUser(null). Раньше приводил, и это был тот самый "тихий logout":
  // человек с живыми токенами оказывался на LandingPage после того, как
  // вкладка поспала ночь и первый рефреш на просыпании упал.
  // Перезапускается по authRetryToken — кнопкой "Повторить" и авторетраем ниже.
  useEffect(()=>{
    let cancelled=false
    ;(async()=>{
      const{data,error}=await supabase.auth.getSession()
      if(cancelled)return
      const session=data?.session??null
      // Читаем хранилище ПОСЛЕ запроса: supabase-js успевает вычистить его сам,
      // если сервер отверг refresh token. Токены на месте + ошибка = временный
      // сбой; токенов нет = сессия мертва по-настоящему. См. authState.js.
      const hasStoredSession=(()=>{
        try{return !!localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY)}catch{return false}
      })()
      if(resolveAuthOutcome({session,error,hasStoredSession})===AUTH_OUTCOME.UNAVAILABLE){
        console.warn('Сессию подтвердить не удалось (временный сбой) — выход НЕ выполняем:',error?.message||error)
        setAuthError(true)
        setAuthRetrying(false)
        setAuthLoading(false)
        return
      }
      setAuthError(false)
      setAuthRetrying(false)
      applySession(session)
      setAuthLoading(false)
    })()
    return()=>{cancelled=true}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[authRetryToken])

  useEffect(()=>{
    const{data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      // Переход по ссылке восстановления пароля создаёт временную сессию —
      // это НЕ обычный вход, обычный setUser() увёл бы сразу в приложение
      // вместо формы смены пароля (см. ResetPasswordView).
      if(event==='PASSWORD_RECOVERY'){setRecoveryMode(true);return}
      // INITIAL_SESSION игнорируем целиком. Это НЕ реальная смена состояния, а
      // разовый снимок при подписке, и supabase-js отдаёт в нём session:null не
      // только когда сессии нет, но и когда рефреш упал по сети/5xx (см.
      // _emitInitialSession: ошибка → callback('INITIAL_SESSION', null)). То
      // есть ровно тот случай, ради которого всё это и переписано — обработай
      // мы его тут через applySession(null), тихий logout вернулся бы через
      // заднюю дверь. Начальное состояние целиком за эффектом getSession выше:
      // он единственный различает три исхода.
      if(event==='INITIAL_SESSION')return
      // Дальше — настоящие события (SIGNED_IN/SIGNED_OUT/TOKEN_REFRESHED/
      // USER_UPDATED): состояние достоверно, снимаем экран "нет связи", если он
      // висел. SIGNED_OUT как и раньше: applySession(null) → LandingPage.
      setAuthError(false)
      applySession(session)
    })
    return()=>subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])

  // Авторетрай ровно в двух случаях: вернулась сеть и вкладка стала видимой
  // (тот самый сценарий "вкладка спала ночь"). Слушатели вешаются один раз,
  // а не пересоздаются на каждый ретрай, поэтому состояние читается через ref.
  // Без gate по authErrorRef каждый переход по вкладкам дёргал бы getSession().
  useEffect(()=>{
    const retry=()=>{
      if(!authErrorRef.current)return
      if(document.visibilityState==='hidden')return
      setAuthRetrying(true)
      setAuthRetryToken(t=>t+1)
    }
    window.addEventListener('online',retry)
    document.addEventListener('visibilitychange',retry)
    return()=>{
      window.removeEventListener('online',retry)
      document.removeEventListener('visibilitychange',retry)
    }
  },[])

  useEffect(()=>{
    const fn=()=>setIsMobile(window.innerWidth<768)
    window.addEventListener('resize',fn)
    return()=>window.removeEventListener('resize',fn)
  },[])

  // Telegram Mini App — определяем, что приложение открыто внутри Telegram
  // (SDK из index.html может подгрузиться и в обычном браузере, но initData
  // там всегда пустой — это единственный надёжный признак реального запуска
  // внутри клиента Telegram, а не просто наличия скрипта на странице).
  // Авторизацию и остальную логику НЕ трогаем — email-вход как был.
  useEffect(()=>{
    const tg=window.Telegram?.WebApp
    const detected=!!(tg&&tg.initData)
    setIsTelegram(detected)
    if(!detected)return
    try{
      tg.ready()
      tg.expand()
      // Без этого Telegram трактует протяжку пальцем вниз внутри прокручиваемого
      // контента как жест закрытия мини-приложения — особенно когда палец
      // стартует на input или textarea: клиент не находит внешний скролл-
      // контейнер и закрывает приложение вместо прокрутки. typeof обязателен —
      // метод появился только в Bot API 7.7, на старых клиентах его нет и вызов
      // без проверки бросил бы исключение, оборвав expand() и установку фона ниже.
      if(typeof tg.disableVerticalSwipes==='function')tg.disableVerticalSwipes()
      // Фон из темы Telegram — чтобы не было белой рамки по краям на тёмной
      // теме клиента. Только цвет фона, саму вёрстку пока не переверстываем.
      if(tg.themeParams?.bg_color)document.body.style.background=tg.themeParams.bg_color
    }catch(e){console.error('Telegram WebApp SDK:',e)}
  },[])
  // Класс на <body> — задел для будущей телеграм-темизации (сейчас ничего
  // в CSS на него не завязано, вёрстку не трогаем), заодно делает isTelegram
  // реально используемым состоянием, а не только записываемым.
  useEffect(()=>{
    document.body.classList.toggle('telegram-app',isTelegram)
  },[isTelegram])

  // Согласие на обработку ПДн (152-ФЗ): читаем из profiles, давал ли текущий
  // пользователь согласие и на какую версию Политики. Версию сверяем строго —
  // после поднятия POLICY_VERSION в legalText.js согласие спросят заново.
  // cancelled — защита от гонки при быстрой смене пользователя: ответ по
  // старому id не должен открыть ворота новому.
  useEffect(()=>{
    if(!user?.id){setConsentLoaded(false);setConsentGiven(false);setConsentError(false);return}
    let cancelled=false
    setConsentLoaded(false)
    // maybeSingle(), а не single(): при отсутствии строки профиля single() отдаёт
    // ошибку (PGRST116), неотличимую от сетевого сбоя, а нам эти два случая
    // теперь нужно разделять. maybeSingle() на пустой выборке возвращает
    // data:null БЕЗ ошибки — то есть "профиля нет, согласия нет".
    supabase.from('profiles').select('pd_consent_at,pd_consent_version').eq('id',user.id).maybeSingle()
      .then(({data,error})=>{
        if(cancelled)return
        if(error){
          // Раньше тут был setConsentGiven(false) на любую ошибку — и сетевой
          // сбой заставлял человека, давно давшего согласие, давать его заново.
          // Теперь "не смогли прочитать" ≠ "согласия нет": ранее известное
          // значение не сбрасываем, показываем экран "нет связи" с ретраем.
          console.error('Не удалось прочитать согласие на обработку ПДн:',error)
          setConsentError(true)
          setConsentLoaded(true)
          return
        }
        // Ответ получен — вот тут отсутствие согласия действительно означает,
        // что его не давали (или версия Политики устарела), и спросить надо.
        setConsentError(false)
        setConsentGiven(!!data?.pd_consent_at&&data?.pd_consent_version===POLICY_VERSION)
        setConsentLoaded(true)
      })
    return()=>{cancelled=true}
  },[user?.id,consentRetryToken])

  // Авто-вход внутри Telegram: как только известно, что мы (а) внутри
  // Telegram, (б) уже определили, есть ли сохранённая Supabase-сессия
  // (authLoading===false), и (в) пользователь всё ещё не залогинен — шлём
  // initData на сервер, меняем его на одноразовый код и логинимся им.
  // Успех дальше подхватывает уже существующий onAuthStateChange/applySession
  // — этот эффект сам user не устанавливает. Ровно одна попытка за сессию
  // приложения (telegramAuthTriedRef) — не повторяем при каждом ререндере
  // и не долбим сервер, если попытка уже провалилась. Обычный email-вход
  // (isTelegram=false) этот эффект вообще не трогает.
  useEffect(()=>{
    // authError — не пробуем, пока связи заведомо нет: попытка одноразовая
    // (telegramAuthTriedRef), и сжечь её на мёртвой сети значит не войти уже
    // никогда за эту сессию приложения. Ретрай сам перезапустит эффект.
    if(authLoading||authError||user||!isTelegram||telegramAuthTriedRef.current)return
    const initData=window.Telegram?.WebApp?.initData
    if(!initData)return
    telegramAuthTriedRef.current=true
    setTelegramAuthPending(true)
    ;(async()=>{
      try{
        const res=await fetch('/api/telegram-auth',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({initData}),
        })
        if(!res.ok)throw new Error(`telegram-auth: ${res.status}`)
        const{email,otp}=await res.json()
        const{error}=await supabase.auth.verifyOtp({email,token:otp,type:'email'})
        if(error)throw error
      }catch(e){
        // Не тупик — просто остаёмся без сессии, ниже покажется обычный
        // LandingPage с email-входом.
        console.error('Telegram авто-вход не удался:',e)
      }finally{
        setTelegramAuthPending(false)
      }
    })()
  },[authLoading,authError,user,isTelegram])

  // Обмен ссылки доступа на сессию. Условие запуска то же, что у телеграм-входа
  // выше: сохранённая сессия уже проверена (authLoading===false), пользователя
  // нет, попытка ещё не делалась. От isTelegram НЕ зависит — ссылку открывают и
  // в обычном браузере, и во встроенном браузере мессенджера.
  //
  // Если пользователь УЖЕ залогинен, обмена не происходит вовсе: молча менять
  // текущий аккаунт на другой по ссылке из чата нельзя. Токен при этом всё
  // равно уже стёрт из адресной строки эффектом выше.
  useEffect(()=>{
    // authError — та же логика, что у телеграм-входа выше: попытка одноразовая.
    if(authLoading||authError||user||accessAuthTriedRef.current)return
    const accessToken=pendingAccessRef.current
    if(!accessToken)return
    accessAuthTriedRef.current=true
    pendingAccessRef.current=null
    setAccessAuthPending(true)
    ;(async()=>{
      try{
        const res=await fetch('/api/telegram-auth',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({action:'redeem_access',token:accessToken}),
        })
        if(!res.ok)throw new Error(`redeem_access: ${res.status}`)
        const{email,otp}=await res.json()
        const{error}=await supabase.auth.verifyOtp({email,token:otp,type:'email'})
        if(error)throw error
        // Успех дальше подхватывает onAuthStateChange/applySession — user здесь
        // не устанавливаем, как и в телеграм-входе.
      }catch(e){
        // В сообщении нет ни токена, ни ссылки — только статус/текст ошибки.
        console.error('Вход по ссылке не удался:',e?.message||e)
        setAccessAuthError('Ссылка недействительна или устарела — попроси у тренера новую')
      }finally{
        setAccessAuthPending(false)
      }
    })()
  },[authLoading,authError,user])

  // Счётчик версии истории тренировок — растёт на 1 при КАЖДОМ подтверждённом
  // изменении workouts/workout_sets (завершение, правка, удаление, копия),
  // независимо от того, кто инициировал изменение — WorkoutsView (сама
  // перечитывает свою setsHistory сразу после сохранения) или DiaryView
  // (не имеет доступа к setsHistory/workoutsLog WorkoutsView вообще, это
  // отдельный, часто размонтированный компонент). WorkoutsView подписан на
  // этот счётчик отдельным пропом (historyVersion) и перечитывает историю
  // при каждом его изменении — без этого движок прогрессии мог посчитать
  // вес по уже удалённой/изменённой тренировке, если WorkoutsView в момент
  // изменения был смонтирован (например остался открытым на другом
  // устройстве/вкладке, или просто не размонтировался между действиями).
  const [historyVersion,setHistoryVersion]=useState(0)
  // Загрузка истории тренировок из Supabase (см. эффект ниже) — на новом
  // телефоне/слабой связи данные приходят не мгновенно, а до этого экраны
  // DiaryView не должны выглядеть так, будто тренировок вообще не было.
  const [historyLoading,setHistoryLoading]=useState(false)
  const [historyLoadError,setHistoryLoadError]=useState(false)
  const [historyReloadToken,setHistoryReloadToken]=useState(0)

  useEffect(()=>{localStorage.setItem('fitpro_history',JSON.stringify(workoutHistory))},[workoutHistory])
  useEffect(()=>{localStorage.setItem('fitpro_custom_ex',JSON.stringify(customExercises))},[customExercises])

  // Выход — локальное действие, не должно зависеть от сети. Раньше порядок
  // был "await signOut() -> потом чистим кэш": при сетевом сбое signOut()
  // тихо резолвится с {error} (см. диагностику), _removeSession() внутри
  // supabase-js не вызывается, SIGNED_OUT не приходит, user не сбрасывается —
  // кнопка "нажимается", а пользователь остаётся залогинен. Теперь сначала
  // синхронно сбрасываем всё локальное (state + localStorage, включая ключи
  // самого supabase-js — их больше НЕЛЬЗЯ ждать от signOut()), это само
  // переключает экран на LandingPage (см. `if(!user) return <LandingPage/>`
  // ниже) — и только потом best-effort пытаемся сообщить об этом серверу.
  // workoutHistory/customExercises тоже сбрасываем — они живут в App() и не
  // размонтируются вместе с LandingPage, иначе при повторном входе ДРУГИМ
  // пользователем на этом же табе мелькнули бы чужие старые данные до того,
  // как отработает загрузка из Supabase (см. задачу про источник правды).
  // async — из-за askConfirm ниже (Telegram отвечает колбэком, не синхронно).
  // Возвращаемое значение никто не использует: все вызовы — из onClick и
  // onDecline, «выстрелил и забыл», поэтому порядок действий после
  // подтверждения не изменился.
  const performLogout = async () => {
    // Несохранённая тренировка (workoutId==null, не синтетическая копия из
    // базы — тот же фильтр, что в migrateLocalWorkoutHistoryToSupabase) живёт
    // только в localStorage/памяти; clearFitproData() ниже стирает её
    // безвозвратно. Если офлайн (или миграция ещё не успела) — предупреждаем
    // до сброса, а не после.
    const unsavedCount = workoutHistory.filter(w =>
      w.workoutId == null && !w.fromSupabaseFallback && !(w.name === 'Тренировка' && !w.comment && w.duration == null)
    ).length
    if (unsavedCount > 0) {
      const ok = await askConfirm(`У тебя ${unsavedCount} ${plural(unsavedCount,'несохранённая тренировка','несохранённые тренировки','несохранённых тренировок')} — они ещё не попали в базу (возможно, не было интернета). Если выйти сейчас, они потеряются. Выйти всё равно?`)
      if (!ok) return
    }
    setUser(null)
    // Явный выход — состояние достоверно известно, экран "нет связи" тут
    // показывать нельзя: он перекрыл бы LandingPage, если баннер висел до этого.
    setAuthError(false)
    setWorkoutHistory([])
    setCustomExercises([])
    Object.keys(localStorage).filter(k=>k.startsWith('sb-')).forEach(k=>localStorage.removeItem(k))
    // Ключ сессии живёт под 'fitpro-auth' (через дефис) — под фильтры выше
    // ('sb-' и 'fitpro_' в clearFitproData) он не попадает, поэтому до сих пор
    // не удалялся вообще, и выход целиком зависел от signOut(). А signOut тут
    // best-effort: при сетевом сбое он ловится в catch, и токен оставался
    // лежать в localStorage. Убираем явно, как и предполагал комментарий
    // к константе в src/supabase.js.
    localStorage.removeItem(SUPABASE_AUTH_STORAGE_KEY)
    clearFitproData()
    supabase.auth.signOut({ scope: 'local' }).catch(err => console.warn('signOut (best-effort, не блокирует выход):', err))
  }

  // Сброс после удаления аккаунта. От performLogout отличается тем, что НЕ
  // спрашивает про несохранённые тренировки: аккаунт на сервере уже удалён,
  // отправлять их некуда и спасать нечего. Ключ сессии убираем ещё и руками —
  // signOut() тут best-effort (сеть может отвалиться), а протухший токен от
  // несуществующего аккаунта в localStorage оставлять нельзя.
  const resetAfterAccountDelete = () => {
    setUser(null)
    setAuthError(false)
    setWorkoutHistory([])
    setCustomExercises([])
    Object.keys(localStorage).filter(k=>k.startsWith('sb-')).forEach(k=>localStorage.removeItem(k))
    localStorage.removeItem(SUPABASE_AUTH_STORAGE_KEY)
    clearFitproData()
    supabase.auth.signOut({ scope: 'local' }).catch(err => console.warn('signOut после удаления аккаунта (best-effort):', err))
  }

  // Свои упражнения — так же подтягиваются из Supabase; локальные без
  // supabaseId (старые, ещё не синхронизированные) переносятся один раз.
  useEffect(()=>{
    if(!user?.id)return
    let cancelled=false
    ;(async()=>{
      let local
      try{local=JSON.parse(localStorage.getItem('fitpro_custom_ex')||'[]')}catch{local=[]}
      const toMigrate=local.filter(e=>!e.supabaseId)
      for(const e of toMigrate){
        const{data,error}=await supabase.from('custom_exercises').insert({user_id:user.id,name:e.n,muscle_group:e.m||null,equipment:e.eq||null}).select('id').single()
        if(error)console.error('Миграция своего упражнения: ошибка вставки:',error)
        else if(data)e.supabaseId=data.id
      }
      if(toMigrate.length)localStorage.setItem('fitpro_custom_ex',JSON.stringify(local))
      const{data:rows,error}=await supabase.from('custom_exercises').select('*').eq('user_id',user.id)
      if(cancelled||error||!rows)return
      const mapped=rows.map(r=>({n:r.name,m:r.muscle_group||'',eq:r.equipment||'',custom:true,supabaseId:r.id}))
      setCustomExercises(mapped)
      localStorage.setItem('fitpro_custom_ex',JSON.stringify(mapped))
    })()
    return()=>{cancelled=true}
  },[user?.id])

  // Дневник тренировок при входе подтягивается из Supabase (единый источник для
  // любого origin/устройства) и подменяет то, что успело подгрузиться из
  // localStorage — так на localhost и на проде видна одна и та же реальная
  // история, а не пустой локальный кэш браузера.
  useEffect(()=>{
    if(!user?.id)return
    let cancelled=false
    setHistoryLoading(true)
    setHistoryLoadError(false)
    ;(async()=>{
      await migrateLocalWorkoutHistoryToSupabase(user.id)
      const{history,error}=await loadWorkoutHistoryFromSupabase(user.id)
      if(cancelled)return
      if(error)setHistoryLoadError(true)
      else setWorkoutHistory(history)
      setHistoryLoading(false)
    })()
    return()=>{cancelled=true}
  },[user?.id,historyReloadToken])

  // Имя/пол/фото/telegram — сразу при входе обогащаем user данными из Supabase
  // (mergeUserWithProfile до этого брал их только из localStorage, поэтому шапка
  // и аватар на новом устройстве показывали пусто, пока не откроешь "Мои данные").
  // role — источник правды тоже здесь, а не localStorage/URL (см. ?trainer=1
  // выше): фейковый параметр в адресной строке или устаревший кэш больше не
  // должны давать тренерский доступ, если в базе у клиента role='client'.
  useEffect(()=>{
    if(!user?.id)return
    let cancelled=false
    supabase.from('profiles').select('name,gender,telegram,photo_url,role,coach_id,tg_username,plan,plan_until,trial_until').eq('id',user.id).single().then(({data})=>{
      if(cancelled||!data)return
      setUser(u=>u?{...u,name:data.name||u.name,gender:data.gender||u.gender,telegram:data.telegram||u.telegram,photoURL:data.photo_url||u.photoURL,tgUsername:data.tg_username}:u)
      const role=data.role||'client'
      setUserRole(role)
      localStorage.setItem('fitpro_role',role)
      setHasCoach(!!data.coach_id)
      // Клиент тренера, у которого оплаченный доступ уже кончился. coach_id и
      // программа при этом сохраняются — признак нужен только для мягкого
      // напоминания продлить. У тренера coach_id пуст, так что для него всегда
      // false.
      setCoachSubExpired(!!data.coach_id&&!!data.plan_until&&new Date(data.plan_until).getTime()<=Date.now())
      setAccess(effectiveAccess(data))
      // Отметка посещения — один раз за загрузку (и клиент, и тренер). last_seen
      // не привилегированное поле, guard-триггер его не трогает. Ошибка не влияет
      // на работу приложения — только в консоль.
      supabase.from('profiles').update({last_seen:new Date().toISOString()}).eq('id',user.id)
        .then(({error})=>{if(error)console.error('last_seen: не удалось обновить:',error)})
      // Ссылка-приглашение (см. pendingInviteRef выше). Решаем именно здесь:
      // до загрузки профиля роль и coach_id неизвестны. Тренера не привязываем
      // (он ничей не клиент), уже привязанного — тоже, чужую связь не рвём.
      // Ref гасим в любом случае: одна попытка на заход, без ретраев.
      const invite=pendingInviteRef.current
      if(invite){
        pendingInviteRef.current=null
        if(role!=='trainer'&&!data.coach_id)applyInvite(invite)
      }
    })
    return()=>{cancelled=true}
  },[user?.id,profileReloadToken])

  // Клиентский захват @-ника из Telegram при открытии Mini App: если у
  // текущего клиента в WebApp есть username и он отличается от сохранённого,
  // пишем его в свою строку profiles (RLS разрешает свою строку) и сразу
  // обновляем локально, чтобы UI подхватил без перелогина. Серверная запись
  // при входе (api/telegram-auth.js) остаётся — это её дополняет на случай,
  // когда клиент уже залогинен и просто открыл приложение снова.
  useEffect(()=>{
    if(!user?.id||!isTelegram)return
    const username=window.Telegram?.WebApp?.initDataUnsafe?.user?.username
    if(!username||username===user.tgUsername)return
    supabase.from('profiles').update({ tg_username:username }).eq('id',user.id).then(({error})=>{
      if(error)console.error('Ошибка записи tg_username:',error)
    })
    setUser(u=>u?{...u,tgUsername:username}:u)
  },[user?.id,user?.tgUsername,isTelegram])

  const [editTarget,setEditTarget]=useState(null)

  // Шапка сессии Конструктора (название/цвет/дата) — ConstructorView читает её
  // как sessionMeta. Заводится в момент открытия конструктора и сбрасывается
  // на выходе из него.
  const [pendingConstructorMeta,setPendingConstructorMeta]=useState(null)
  const openConstructor=()=>{
    setPendingConstructorMeta({ name:'Конструктор', color:PUR, date:new Date().toISOString().slice(0,10) })
    handleNav('constructor')
  }

  // Переход по нижнему меню во время активной тренировки — НЕ спрашивает
  // подтверждения (раньше здесь был window.confirm "Прогресс будет
  // потерян" — неверно, клиент не просил ничего выкидывать, он просто
  // переключает экран). Тренировка молча сворачивается: WorkoutsView
  // остаётся смонтированным (см. renderMain ниже, always-mounted +
  // display:none), её внутренний step не трогаем — только nav уходит с
  // 'workouts', и это само по себе делает тренировку "не на переднем
  // плане" (см. isWorkoutForeground) — везде показывается плашка
  // свёрнутой тренировки с таймером.
  const handleNav=(id)=>{
    setNav(id)
  }

  // Переход в раздел "Мои тренировки" Дневника из чата AI-тренера (кнопка
  // "Перейти к тренировке" под сообщением с SET_PROGRAM). Клиент дальше сам
  // открывает нужную запись — сюда не передаём конкретную тренировку.
  const goToDiaryWorkouts=()=>{
    pendingSectionRestoreRef.current='workouts'
    setDiaryJumpToken(t=>t+1)
    // Раньше вело на dashboard — там у клиента жила копия Дневника. История
    // тренировок теперь только во вкладке «Прогресс».
    handleNav('progress')
  }

  // Тот же переход, но в подраздел дневника питания — для постоянной кнопки
  // "Дневник" в чате AI-ассистента (режим "Питание").
  const goToDiaryFood=()=>{
    // Дневник питания переехал во вкладку «Питание» и стал её главным экраном:
    // ни секция, ни токен прыжка тут больше не нужны — достаточно открыть
    // вкладку, дневник и так первое, что там видно.
    handleNav('nutrition')
  }

  // workouts/workout_sets в Supabase — единственный источник правды и для Дневника,
  // и для AI-тренера (см. workoutPrompt.js), так же как food_diary для питания.
  // Раньше тренировка существовала только в workout_sets (плоские подходы без
  // группировки) — удаление/правка в дневнике либо не трогали Supabase вовсе,
  // либо угадывали нужные строки по дате+названию. Теперь каждая тренировка —
  // отдельная строка в workouts, её id (workoutId) хранится на самой записи и
  // однозначно определяет "чьи это подходы", включая на любом другом устройстве.
  // {id,error} вместо голого id/null — вызывающему (handleWorkoutComplete/
  // handleWorkoutUpdate) нужно уметь отличить "ошибка записи" от "писать
  // было нечего", чтобы честно вернуть {ok:false} в WorkoutsView и не
  // перезагружать setsHistory молча по несуществующим данным.
  const insertWorkoutRow=async(workout)=>{
    if(!user?.id)return{id:null,error:null}
    const{data,error}=await supabase.from('workouts').insert({
      user_id:user.id, name:workout.name||null, color:workout.color||null,
      date:workout.date, duration:workout.duration!=null?workout.duration:null, comment:workout.comment||null,
    }).select('id').single()
    if(error){console.error('Ошибка создания тренировки в Supabase:',error);logError('workout_save',{message:error.message,details:{table:'workouts',action:'insert',code:error.code}});return{id:null,error}}
    return{id:data?.id??null,error:null}
  }

  const insertWorkoutSetsRows=async(workout,workoutId)=>{
    if(!user?.id)return{ids:[],error:null}
    const isoDate=(workout.date||'').slice(0,10)
    const rows=[]
    for(const ex of workout.exercises||[]){
      for(const s of ex.sets||[]){
        if(!s.kg&&!s.reps&&s.bandLevel==null)continue
        rows.push({user_id:user.id,exercise:ex.n,date:isoDate,kg:s.kg?Number(s.kg):null,reps:s.reps?Number(s.reps):null,note:s.note||null,recommended_kg:s.recKg?Number(s.recKg):null,rating:s.rating?Number(s.rating):null,workout_id:workoutId??null,band_level:s.bandLevel??null})
      }
    }
    if(!rows.length)return{ids:[],error:null}
    const{data,error}=await supabase.from('workout_sets').insert(rows).select('id')
    if(error){console.error('Ошибка синхронизации тренировки с Supabase:',error);logError('workout_sets_save',{message:error.message,details:{table:'workout_sets',action:'insert',code:error.code,rows:rows.length}});return{ids:[],error}}
    return{ids:(data||[]).map(r=>r.id),error:null}
  }

  const deleteWorkoutSetsRows=async(workout)=>{
    if(!user?.id||!workout)return
    if(workout.workoutId!=null){
      // Одна запись в workouts — удаление каскадом (ON DELETE CASCADE) чистит
      // все её строки в workout_sets разом, без угадывания по дате/названию.
      const{error}=await supabase.from('workouts').delete().eq('id',workout.workoutId)
      if(error)console.error('Ошибка удаления тренировки из Supabase:',error)
      return
    }
    if(workout.supabaseSetIds?.length){
      const{error}=await supabase.from('workout_sets').delete().in('id',workout.supabaseSetIds)
      if(error)console.error('Ошибка удаления тренировки из Supabase:',error)
      return
    }
    // Записи без workoutId/supabaseSetIds (старые подходы ещё до перехода на
    // таблицу workouts) — fallback по дате и названиям упражнений, менее
    // точный, но лучше чем оставить AI видеть их вечно.
    const isoDate=(workout.date||'').slice(0,10)
    const exerciseNames=[...new Set((workout.exercises||[]).map(ex=>ex.n).filter(Boolean))]
    if(!isoDate||!exerciseNames.length)return
    const{error}=await supabase.from('workout_sets').delete().eq('user_id',user.id).eq('date',isoDate).in('exercise',exerciseNames)
    if(error)console.error('Ошибка удаления тренировки из Supabase (fallback):',error)
  }

  // Возвращает {ok} ПОСЛЕ фактического завершения записи в Supabase —
  // WorkoutsView (finishWorkout) ждёт этот промис перед перезагрузкой
  // setsHistory (движок прогрессии) и не должен обновлять историю молча,
  // если запись не удалась.
  const handleWorkoutComplete=async workout=>{
    // workoutId/supabaseSetIds намеренно не копируем из workout (может прийти
    // из handleCopyWorkout, который спредит старую запись) — это ВСЕГДА новая
    // тренировка и ей нужна своя собственная строка в Supabase, а не связь со
    // старой (иначе удаление копии удалило бы и оригинал).
    const{workoutId:_wid,supabaseSetIds:_sids,...rest}=workout
    const withDate={...rest,date:workout.date||new Date().toISOString()}
    setWorkoutHistory(h=>[...h,withDate])
    const{id:workoutId,error:rowError}=await insertWorkoutRow(withDate)
    const{ids,error:setsError}=await insertWorkoutSetsRows(withDate,workoutId)
    const ok=!rowError&&!setsError
    if(ok){setWorkoutHistory(h=>h.map(w=>w===withDate?{...w,workoutId,supabaseSetIds:ids}:w));setHistoryVersion(v=>v+1)}
    return{ok}
  }

  const handleWorkoutUpdate=async(histIdx,updated)=>{
    const old=workoutHistory[histIdx]
    const merged={...updated,date:updated.date||old?.date,workoutId:old?.workoutId}
    setWorkoutHistory(h=>h.map((w,i)=>i===histIdx?merged:w))
    if(old?.workoutId!=null){
      const{error:updateError}=await supabase.from('workouts').update({
        name:merged.name||null, color:merged.color||null, date:merged.date,
        duration:merged.duration!=null?merged.duration:null, comment:merged.comment||null,
      }).eq('id',old.workoutId)
      if(updateError)console.error('Ошибка обновления тренировки в Supabase:',updateError)
      if(old.supabaseSetIds?.length){
        // Безопасный порядок: сначала вставляем новые подходы и только при
        // успехе удаляем старые — по их КОНКРЕТНЫМ id (не по workout_id, тот
        // же у только что вставленных новых строк). Обрыв связи между шагами
        // больше не теряет данные безвозвратно — в худшем случае старые и
        // новые подходы временно задвоятся, а не исчезнут.
        const{ids,error:setsError}=await insertWorkoutSetsRows(merged,old.workoutId)
        let delError=null
        if(!setsError){
          const{error}=await supabase.from('workout_sets').delete().in('id',old.supabaseSetIds)
          delError=error
          if(delError)console.error('Ошибка удаления старых подходов при обновлении тренировки:',delError)
        }
        const ok=!updateError&&!setsError&&!delError
        if(ok){setWorkoutHistory(h=>h.map((w,i)=>i===histIdx?{...w,supabaseSetIds:ids}:w));setHistoryVersion(v=>v+1)}
        return{ok}
      }
      // Старые подходы без сохранённых id (запись создана до появления
      // supabaseSetIds) — точно нацелиться на них нечем, оставляем прежний
      // порядок (удаление по workout_id, затем вставка) запасным путём.
      const{error:delError}=await supabase.from('workout_sets').delete().eq('workout_id',old.workoutId)
      if(delError)console.error('Ошибка удаления старых подходов при обновлении тренировки:',delError)
      const{ids,error:setsError}=await insertWorkoutSetsRows(merged,old.workoutId)
      const ok=!updateError&&!delError&&!setsError
      if(ok){setWorkoutHistory(h=>h.map((w,i)=>i===histIdx?{...w,supabaseSetIds:ids}:w));setHistoryVersion(v=>v+1)}
      return{ok}
    }
    // Старая запись без workoutId (ещё не переведена на таблицу workouts) —
    // удаляем прежним способом и создаём заново уже с полноценной привязкой.
    if(old)await deleteWorkoutSetsRows(old)
    const{id:workoutId,error:rowError}=await insertWorkoutRow(merged)
    const{ids,error:setsError}=await insertWorkoutSetsRows(merged,workoutId)
    const ok=!rowError&&!setsError
    if(ok){setWorkoutHistory(h=>h.map((w,i)=>i===histIdx?{...w,workoutId,supabaseSetIds:ids}:w));setHistoryVersion(v=>v+1)}
    return{ok}
  }

  const handleEditWorkout=(workout,histIdx)=>{
    if(nav!=='workouts'){borrowedNavRef.current=true;pendingSectionRestoreRef.current=diarySectionRef.current}
    setEditTarget({workout,histIdx})
    setNav('workouts')
  }

  // async + await удаления в Supabase (было fire-and-forget) — historyVersion
  // растёт ТОЛЬКО после того, как запрос на удаление реально отработал, а не
  // сразу по клику. Без этого WorkoutsView (если смонтирован) мог перечитать
  // setsHistory РАНЬШЕ, чем строка реально исчезла из workout_sets, и всё
  // равно увидеть удалённую тренировку в новой выборке.
  const handleDeleteWorkout=async(histIdx)=>{
    const workout=workoutHistory[histIdx]
    if(workout)await deleteWorkoutSetsRows(workout)
    setWorkoutHistory(h=>h.filter((_,i)=>i!==histIdx))
    setHistoryVersion(v=>v+1)
  }

  const handleCopyWorkout=(workout)=>{
    handleWorkoutComplete({...workout,date:localTodayISO(),name:workout.name+' (копия)'})
  }

  const handleWorkoutAction=(action,plan)=>{
    // С планом кладём объект {action, plan}; без плана — строку, как раньше
    // (обратная совместимость: обычные «Начать»/«Добавить выполненную»).
    if(action==='start'||action==='done'||action==='template') setPendingWorkoutAction(plan?{action,plan}:action)
    if(nav!=='workouts'){borrowedNavRef.current=true;pendingSectionRestoreRef.current=diarySectionRef.current}
    handleNav('workouts')
  }

  if(recoveryMode) return <ResetPasswordView onDone={()=>setRecoveryMode(false)} />
  if(authLoading) return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:BG,color:TXT3,fontSize:14}}>Загрузка...</div>
  if(!user&&(telegramAuthPending||accessAuthPending)) return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:BG,color:TXT3,fontSize:14}}>Входим…</div>
  // Строго перед LandingPage: "не смогли проверить" ≠ "вышел". Условие только
  // на !user — если сессия уже подтверждена, временный сбой рефреша не должен
  // выбрасывать человека из приложения вообще.
  if(!user&&authError) return <ConnectionErrorView onRetry={()=>{setAuthRetrying(true);setAuthRetryToken(t=>t+1)}} retrying={authRetrying} />
  // GlassDefs обязателен и здесь. Он объявляет <linearGradient>, на которые
  // ссылаются ВСЕ GlassIcon; ниже по коду он монтируется в основном layout, но
  // до него дело не доходит — этот return срабатывает раньше. Без определений
  // иконки на стартовом экране рисовались пустыми квадратами.
  if(!user) return (<>
    <GlassDefs/>
    <LandingPage onEnter={setUser} isTelegram={isTelegram} accessError={accessAuthError} />
  </>)
  if(!consentLoaded) return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:BG,color:TXT3,fontSize:14}}>Загрузка…</div>
  // Профиль не прочитался и согласия мы за эту сессию так и не подтвердили —
  // честно говорим про связь вместо того, чтобы требовать согласие повторно.
  if(consentError&&!consentGiven) return <ConnectionErrorView onRetry={()=>setConsentRetryToken(t=>t+1)} retrying={false} />
  if(!consentGiven) return <ConsentGate user={user} onAccepted={()=>setConsentGiven(true)} onDecline={performLogout} />

  // Всё, КРОМЕ Тренировок — обычная свитч-навигация, монтируется/
  // размонтируется по nav, как и раньше.
  const renderOther=()=>{
    if(nav==='cdetail'&&sc)return <ClientDetail client={sc} goBack={goBackNav} trainerId={user?.id} />
    switch(nav){
      // dashboard остаётся ТОЛЬКО тренерским. У клиента этот case раньше
      // отдавал второй экземпляр DiaryView — то есть стартовый экран и вкладка
      // «Дневник» были буквально одним и тем же компонентом. Клиент теперь
      // стартует на «Тренировках» (см. начальное значение nav), и попасть сюда
      // ему нечем; null — страховка на случай прямого перехода.
      case 'dashboard': return userRole==='trainer'
        ? <Dashboard setNav={handleNav} setSC={setSC} isTrainer={true} userId={user?.id} workoutHistory={workoutHistory} />
        : null
      case 'clients':   return <ClientsView setSC={setSC} setNav={handleNav} userId={user?.id} />
      case 'nutrition': return <NutritionTab userId={user?.id} />
      case 'library':   return <LibraryView customExercises={customExercises} exerciseVideos={exerciseVideos} userRole={userRole} setExerciseVideos={setExerciseVideos} workoutHistory={workoutHistory} />
      // Конструктор — только тренеру (этап 1 разморозки, см.
      // docs/CONSTRUCTOR_FROZEN.md). Проверка роли ровно та же, что у
      // тренерских экранов выше; клиенту здесь возвращается null, даже если он
      // как-то окажется на этом nav — кнопки входа он всё равно не видит.
      case 'constructor': return userRole==='trainer'
        ? <ConstructorView userId={user?.id} sessionMeta={pendingConstructorMeta} onClearSessionMeta={()=>setPendingConstructorMeta(null)} onWorkoutComplete={handleWorkoutComplete} setNav={handleNav} />
        : null
      case 'progress':  return <DiaryView key={user?.id} workoutHistory={workoutHistory} onEditWorkout={handleEditWorkout} onDeleteWorkout={handleDeleteWorkout} onCopyWorkout={handleCopyWorkout} onWorkoutAction={handleWorkoutAction} isMobile={isMobile} userId={user?.id} initialSection={pendingSectionRestoreRef.current} diaryJumpToken={diaryJumpToken} onSectionChange={s=>{diarySectionRef.current=s}} historyLoading={historyLoading} historyLoadError={historyLoadError} onRetryHistory={()=>setHistoryReloadToken(t=>t+1)} accessLevel={access.level} openPlans={openPlans} />
      default:          return null
    }
  }

  // WorkoutsView — ВСЕГДА смонтирован (не через switch/case), а не только
  // когда nav==='workouts'. Свёрнутая тренировка должна пережить переход на
  // любую другую вкладку — её локальный стейт (wExercises, таймер,
  // черновик и т.п.) живёт внутри самого компонента, а не в App (см. задачу
  // "состояние тренировки должно переживать навигацию"); unmount уничтожил
  // бы его безвозвратно. Видимость переключается через display:none —
  // компонент не размонтируется никогда за время сессии, включая когда сам
  // экран тренировки не активен (там просто нет активной тренировки, но
  // компонент всё равно смонтирован и слушает свою историю/профиль).
  const renderMain=()=>(
    <>
      <div data-testid="screen-workouts" style={{ display: nav==='workouts' ? 'block' : 'none' }}>
        <WorkoutsView customExercises={customExercises} setCustomExercises={setCustomExercises} onWorkoutComplete={handleWorkoutComplete} onWorkoutUpdate={handleWorkoutUpdate} editTarget={editTarget} onClearEdit={()=>{setEditTarget(null);if(borrowedNavRef.current){borrowedNavRef.current=false;goBackNav()}}} onWorkoutMeta={setWorkoutMeta} pendingAction={pendingWorkoutAction} onClearPendingAction={()=>setPendingWorkoutAction(null)} userId={user?.id} historyVersion={historyVersion} onMinimize={goBackNav} hasTrainer={hasCoach} coachSubExpired={coachSubExpired} accessLevel={access.level} openPlans={openPlans} exerciseVideos={exerciseVideos} userRole={userRole} setExerciseVideos={setExerciseVideos} onOpenConstructor={openConstructor} />
      </div>
      {nav!=='workouts'&&renderOther()}
    </>
  )

  const BOTTOM_NAV_H = 62
  const MOBILE_TOP_H = 48
  const MINIMIZED_BAR_H = 56

  return (
    <CatalogContext.Provider value={catalogValue}>
     <TemplatesContext.Provider value={templatesValue}>
      {/* Градиенты для стеклянных иконок — монтируются один раз на всё приложение */}
      <GlassDefs/>
      {/* Градиенты для иконок групп мышц. Сам <MuscleIcon> в рядах упражнений
          сейчас не используется (откатили силуэт-манекен, остались текстовые
          подписи ExMeta), но набор оставлен в проекте — чтобы вернуть, хватит
          одной строки в ряду, пересобирать ничего не нужно. */}
      <MuscleDefs/>
      {/* Тост о применении приглашения от тренера — поверх всего, см.
          applyInvite. Тот же вид, что тосты ошибок записи в других экранах. */}
      {/* Возврат с оплаты. Формулировка намеренно не обещает «доступ открыт»:
          пакет проставляет вебхук, и на момент показа он мог ещё не дойти. */}
      {paidToast&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:3000, padding:'11px 20px', borderRadius:24, maxWidth:340, textAlign:'center',
          background:TEA, color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(0,0,0,0.28)',
        }}>
          Оплата принята, доступ откроется в течение минуты
        </div>
      )}
      {inviteToast&&(
        <div style={{
          position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
          zIndex:3000, padding:'11px 20px', borderRadius:24, maxWidth:340, textAlign:'center',
          background:inviteToast.color, color:'#fff', fontSize:13, fontWeight:700,
          boxShadow:'0 6px 20px rgba(0,0,0,0.28)',
        }}>
          {inviteToast.text}
        </div>
      )}
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

        @keyframes ptr-spin { to { transform: rotate(360deg); } }
      `}</style>

      {isMobile ? (
        /* ── МОБИЛЬНЫЙ LAYOUT ── */
        <div style={{ display:'flex', flexDirection:'column', minHeight:'100vh', fontFamily:'system-ui,sans-serif', background:BG, color:TXT }}>

          {/* Мобильный хедер — на весь экран активной тренировки скрыт, чтобы
              не держать пустую полосу сверху (см. workoutFullscreen). */}
          {!workoutFullscreen&&(
          <div style={{ position:'fixed', top:0, left:0, right:0, height:MOBILE_TOP_H, background:BG, borderBottom:`1px solid ${SEP}`, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px', zIndex:901, flexShrink:0 }}>
            <button onClick={()=>setShowProfileSheet(true)}
              style={{ width:36, height:36, borderRadius:'50%', border:'none', background:'transparent', padding:0, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', minHeight:'unset', overflow:'hidden' }}>
              <Av lbl={user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={36} photo={user.photoURL} gender={user.gender} />
            </button>
            <div style={{ display:'flex', alignItems:'center', gap:7 }}>
              <GlassIcon name="dumbbell" size={24} />
              <span style={{ fontSize:16, fontWeight:800, color:TXT, letterSpacing:'-0.3px' }}>FitPro</span>
            </div>
          </div>
          )}

          <div ref={mobileContentRef} data-screen={nav} className="mobile-content" style={{ flex:1, overflowY:'auto', padding:`${workoutFullscreen?14:MOBILE_TOP_H+14}px 16px ${BOTTOM_NAV_H+16}px`, position:'relative' }}>
            <PullToRefreshIndicator pull={ptrPull} refreshing={ptrRefreshing} />
            {renderMain()}
          </div>

          <nav className="bottom-nav" style={{
            position:'fixed', bottom:0, left:0, right:0,
            background:'rgba(20,20,22,0.86)', backdropFilter:'blur(20px)', WebkitBackdropFilter:'blur(20px)', borderTop:`1px solid ${SEP}`,
            display:'flex', height:BOTTOM_NAV_H, zIndex:900,
          }}>
            {NAV_MOBILE.filter(item=>userRole==='trainer'||item.id!=='clients').map(item=>{
              const active=nav===item.id||(nav==='cdetail'&&item.id==='clients')
              return (
                <button key={item.id} data-testid={`tab-${item.id}`} onClick={()=>handleNav(item.id)} style={{
                  flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                  gap:3, border:'none', background:'none', cursor:'pointer', padding:'0 2px',
                  position:'relative', minHeight:'unset',
                }}>
                  <div style={{ position:'absolute', top:0, left:'50%', transform:'translateX(-50%)', width:active?28:0, height:2.5, borderRadius:'0 0 3px 3px', background:ACCENT2, transition:'width 0.18s' }} />
                  <GlassIcon name={item.ic} size={34} style={{opacity:active?1:.45}} />
                  <span style={{ fontSize:11, fontWeight:active?700:400, color:active?ACCENT2:TXT3 }}>{item.label}</span>
                </button>
              )
            })}
          </nav>

          {/* Профиль — bottom sheet */}
          {showProfileSheet&&(
            <>
              <div onClick={()=>setShowProfileSheet(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1100 }} />
              <div style={{ position:'fixed', bottom:0, left:0, right:0, background:SURF, borderRadius:'18px 18px 0 0', zIndex:1101, padding:'20px 20px 36px' }}>
                <div style={{ width:36, height:4, borderRadius:2, background:SURF2, margin:'0 auto 16px' }} />
                {/* Аватар + имя */}
                <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20, padding:'0 2px' }}>
                  <Av lbl={user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={48} photo={user.photoURL} gender={user.gender} />
                  {/* minWidth:0 — чтобы длинное имя/ник сжимались многоточием и не
                      выдавливали плашку тарифа за край шторки на узких экранах. */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                      <span style={{ fontSize:17, fontWeight:700, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.name}</span>
                      {userRole==='trainer'&&<span style={{ fontSize:11, fontWeight:700, color:PUR, background:`${PUR}18`, borderRadius:6, padding:'2px 7px', flexShrink:0 }}>Тренер</span>}
                    </div>
                    <div style={{ fontSize:12, color:TXT3, marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(user?.email||'').endsWith('@telegram.fitpro')?(user.tgUsername?'@'+user.tgUsername:(user.telegram||'')):user.email}</div>
                  </div>
                  {/* Плашка текущего тарифа — вход на экран Тарифов из шторки */}
                  <button onClick={()=>{setShowProfileSheet(false);openPlans()}} style={{
                    flexShrink:0, display:'flex', alignItems:'center', gap:6,
                    padding:'7px 10px', borderRadius:11, cursor:'pointer', minHeight:'unset',
                    background:SURF2, border:`1px solid ${HAIR}`,
                  }}>
                    <span style={{ textAlign:'right' }}>
                      <span style={{ display:'block', fontSize:12.5, fontWeight:800, color:ACCENT2, lineHeight:1.25 }}>
                        {access.isTrial?'Пробный':planByKey(access.planKey).name}
                      </span>
                      {/* Остаток дней — только у активной платной подписки. */}
                      {!access.isTrial&&access.level>0&&access.until&&(()=>{
                        const d=Math.max(0,Math.ceil((new Date(access.until).getTime()-Date.now())/86400000))
                        return <span style={{ display:'block', fontSize:9.5, color:TXT3, lineHeight:1.2, marginTop:1 }}>осталось {d} {pluralizeDays(d)}</span>
                      })()}
                    </span>
                    <span style={{ fontSize:14, color:TXT3, lineHeight:1 }}>›</span>
                  </button>
                </div>
                {/* Меню */}
                {[
                  { ic:'people',     label:'Мои данные',  sub:'Профиль, замеры и динамика',    action:()=>{ setShowProfileSheet(false); setShowProfileView(true) } },
                  { ic:'chart',     label:'Мой прогресс', sub:'Тоннаж, тренировки, питание', action:()=>{ setShowProfileSheet(false); handleNav('progress') } },
                  { ic:'gear', label:'Настройки',   sub:'Уведомления, единицы, данные',  action:()=>{ setShowProfileSheet(false); openSettings() } },
                ].map((item,i)=>(
                  <button key={i} onClick={item.action} style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 16px', borderRadius:14, border:`1px solid ${HAIR}`, background:SURF2, cursor:'pointer', marginBottom:10, textAlign:'left' }}>
                    <GlassIcon name={item.ic} size={32} />
                    <div>
                      <div style={{ fontSize:15, fontWeight:700, color:TXT }}>{item.label}</div>
                      <div style={{ fontSize:12, color:TXT3, marginTop:1 }}>{item.sub}</div>
                    </div>
                    <span style={{ marginLeft:'auto', fontSize:18, color:TXT3 }}>›</span>
                  </button>
                ))}
                {!isTelegram&&(
                  <button data-back="1" onClick={()=>{setShowProfileSheet(false);performLogout()}}
                    style={{ width:'100%', padding:'13px', borderRadius:12, border:'1.5px solid #fee2e2', background:'#fff5f5', color:'#ef4444', fontSize:14, fontWeight:600, cursor:'pointer', marginTop:4, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                    <GlassIcon name="back" size={16} />Выйти / сменить аккаунт
                  </button>
                )}
              </div>
            </>
          )}

        </div>
      ) : (
        /* ── ДЕСКТОПНЫЙ LAYOUT ── */
        <div style={{ display:'flex', minHeight:'100vh', fontFamily:'system-ui,sans-serif', background:BG, color:TXT }}>
          <div style={{ width:190, background:SURF, borderRight:`1px solid ${HAIR}`, display:'flex', flexDirection:'column', flexShrink:0 }}>
            <div style={{ padding:'16px 14px 12px', borderBottom:`1px solid ${HAIR}` }}>
              <div onClick={()=>setShowProfileView(true)} style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                <Av lbl={user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()} sz={34} photo={user.photoURL} gender={user.gender} />
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:TXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{user.name.split(' ')[0]}</div>
                  <div style={{ fontSize:11, color:TXT3 }}>{userRole==='trainer'?'Тренер':'Клиент'}</div>
                </div>
              </div>
            </div>
            <nav style={{ padding:'8px', flex:1 }}>
              {NAV.filter(item=>userRole==='trainer'||item.id!=='clients').map(item=>(
                <NavBtn key={item.id} {...item} active={nav===item.id||(nav==='cdetail'&&item.id==='clients')} onClick={()=>handleNav(item.id)} />
              ))}
            </nav>
            <div style={{ padding:'12px 14px', borderTop:`1px solid ${HAIR}` }}>
              <button onClick={openSettings}
                style={{ display:'flex',alignItems:'center',gap:7,fontSize:12,color:TXT3,background:'none',border:'none',cursor:'pointer',padding:'4px 0',marginBottom:4,width:'100%' }}>
                <span>⚙️</span> Настройки
              </button>
              {!isTelegram&&(
                <button onClick={performLogout}
                  style={{ fontSize:11, color:TXT3, background:'none', border:'none', cursor:'pointer', padding:0, marginTop:2, display:'block' }}>
                  Выйти →
                </button>
              )}
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
        <div style={{position:'fixed',inset:0,background:BG,zIndex:1060,display:'flex',flexDirection:'column',fontFamily:'system-ui,sans-serif'}}>
          <div style={{background:SURF,borderBottom:`1px solid ${HAIR}`,padding:'14px 16px',display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
            <button data-back="1" onClick={closeSettingsOrSubPage} style={{background:'none',border:'none',fontSize:24,cursor:'pointer',color:TXT3,lineHeight:1,padding:0,minHeight:'unset'}}><GlassIcon name="back" size={26} /></button>
            <span style={{fontSize:18,fontWeight:800,color:TXT,flex:1}}>{settingsSubPage?SETTINGS_SUBPAGE_TITLES[settingsSubPage]:'Настройки'}</span>
          </div>
          <div style={{flex:1,overflowY:'auto'}}>
            <SettingsView user={user} performLogout={performLogout} onAccountDeleted={resetAfterAccountDelete} subPage={settingsSubPage} setSubPage={setSettingsSubPage} onProfileChanged={()=>setProfileReloadToken(t=>t+1)} userRole={userRole} />
          </div>
        </div>
      )}

      {/* Плашка свёрнутой тренировки — на любом экране, кроме самого экрана
          активной тренировки (см. workoutMinimized выше). Позиция — над
          нижним меню на мобильном (BOTTOM_NAV_H), у самого низа на
          десктопе (там нижнего меню нет вообще). */}
      {workoutMinimized&&(
        <MinimizedWorkoutBar meta={workoutMeta} isMobile={isMobile} bottomOffset={isMobile?BOTTOM_NAV_H:0} onClick={reopenWorkout} />
      )}

      {/* hideButton — скрываем плавающую кнопку AI-ассистента только когда
          виден именно полный экран АКТИВНОЙ тренировки: там она перекрывает
          крайние элементы ряда (оценку нагрузки 1-5). НЕ когда тренировка
          просто свёрнута: тогда кнопка возвращается, но приподнятая на
          высоту плашки (extraBottomOffset), чтобы плашка её не перекрыла
          (известный ранее z-index-баг, явно проверяем каждый раз).

          Условие — workoutFullscreen (тренировка ИДЁТ и её экран на переднем
          плане), а не isWorkoutForeground (просто открыта вкладка). Разница
          стала важна, когда клиент начал стартовать на «Тренировках»: по
          старому условию кнопка была спрятана на ПЕРВОМ ЖЕ экране, который
          видит новый пользователь, хотя никакой тренировки ещё нет. Сам
          комментарий выше это поведение и описывал — разошлась реализация. */}
      <AIAssistant ref={aiRef} workoutHistory={workoutHistory} isMobile={isMobile} nutritionPlans={NUTRITION_PLANS} userId={user?.id} onGoToWorkoutsDiary={goToDiaryWorkouts} onGoToFoodDiary={goToDiaryFood} hideButton={workoutFullscreen||trainerSessionActive} extraBottomOffset={workoutMinimized?MINIMIZED_BAR_H:0} accessLevel={access.level} openPlans={openPlans} programLabelOf={programLabelOf} />
     </TemplatesContext.Provider>
    </CatalogContext.Provider>
  )
}

