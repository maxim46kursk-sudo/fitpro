// Конструктор тренировок с прогрессией — размораживается по этапам (см.
// docs/CONSTRUCTOR_FROZEN.md). Этап 1: экран снова в навигации, но вход к нему
// открыт ТОЛЬКО тренеру (см. App.jsx), а упражнение больше нельзя ввести
// текстом — только выбрать из каталога EXERCISES (programs.js). Именно
// свободный ввод и был причиной заморозки: о произвольном названии неоткуда
// узнать тип упражнения. Каталог этот вопрос закрывает — одностороннее
// упражнение опознаётся по нему и получает свою схему повторов
// (ONE_SIDED_SCHEMES, constructorPhases.js).
//
// Изначально экран жил прямо в App.jsx, вынесен в отдельный файл при заморозке.
//
// Отдельный от AI-чата и от основного дневника (workouts/workout_sets)
// режим: персональный список упражнений клиента (constructor_exercises) +
// история подходов по exercise_id (constructor_sets). Никакого диалога с AI
// и никакого маркера SET_PROGRAM здесь нет — только детерминированный расчёт
// через реальный движок прогрессии (buildExerciseAggregates/
// computeTargetWeight из src/workoutPrompt.js, 1ПМ + таблица {10,7,5,3,2} +
// откат, протестировано в test-progression-personas.js) — движок не меняем,
// только подключаем. Прогрессия ключится СТРОГО по exercise_id (передаём его
// как "exercise" в подходы для агрегатора) — совпадение названий в расчёте не
// участвует; название нужно ровно для одного — связать личную запись клиента
// с каталогом (см. exerciseProfile).
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabase.js'
import { computeTargetWeight } from './workoutPrompt.js'
import { GlassIcon } from './glassIcons'
import {
  getUpcomingScheme, hasHardStreak, computeHardStreakTarget, buildConstructorSessions,
  exerciseProfile, filterCatalog, catalogGroups, findByCatalogName, baselineSetCount,
  CATALOG_OTHER_GROUP,
} from './constructorPhases.js'

const PUR = '#7F77DD'

// Подписи групп мышц для фильтра каталога — ключи те же, что отдаёт
// muscleGroup (exerciseMeta.js), плюс 'other' для упражнений, которым
// эвристика группу не назначила (см. catalogGroup).
const GROUP_LABELS = {
  legs: 'Ноги', back: 'Спина', chest: 'Грудь', shoulders: 'Плечи',
  arms: 'Руки', abs: 'Пресс', cardio: 'Кардио', [CATALOG_OTHER_GROUP]: 'Другое',
}

const RATING_HINT = 'Оцени, насколько было тяжело — без этого ассистент не сможет подобрать следующий вес.'
const CONSTRUCTOR_INFO_TEXT = {
  title: 'Как это работает',
  body: 'Выбери упражнения из каталога — по названию или через фильтр по группе мышц. После каждого отметь вес, повторы и оценку усилия. В следующий раз ассистент подскажет рабочий вес и число повторений для прогресса.\n\nПервая тренировка каждого упражнения — стартовый замер: веса задаёшь ты. Дальше рекомендации считает ассистент.\n\nОдносторонние упражнения (выпады, работа одной ногой или рукой) идут по своей схеме — 2 подхода вместо 4. Тип упражнения ассистент берёт из каталога, вручную его указывать не нужно.\n\nСовет: первыми лучше ставить базовые упражнения.',
  why: 'Мышцы растут от постепенного увеличения нагрузки и работы близко к отказу. Ассистент рассчитывает прогрессию по твоим оценкам усилия — вес и повторы подбираются автоматически от тренировки к тренировке.',
  mandatory: 'Оценка усилия обязательна — без неё ассистент не сможет подобрать следующий вес.',
}

// Конструктор — ОТДЕЛЬНЫЙ экран, скопированный по виду и поведению с
// рабочего экрана "Начать тренировку" (WorkoutsView, ветка step==='active',
// см. src/App.jsx) — но не переиспользующий его компонент и не
// модифицирующий его. Это сознательное дублирование вида: рабочая
// тренировка не должна зависеть от конструктора и наоборот, чтобы правки
// одного не могли сломать другое. Отличия от рабочего экрана (сознательно
// упрощено под задачу конструктора — там не нужны видео/заметки/комментарий,
// это персональный трекер веса, а не полноценный лог тренировки):
// нет видео к упражнению, нет заметок к подходу, нет комментария к
// тренировке; всего один подход на упражнение за сессию (не сетка из
// нескольких подходов).
export default function ConstructorView({ userId, sessionMeta, onClearSessionMeta, onWorkoutComplete, setNav }) {
  const [exercises, setExercises] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fitpro_constructor_exercises') || '[]') } catch { return [] }
  })
  const [sessionExercises, setSessionExercises] = useState([]) // [{exerciseId,name,profile,isBaseline,phase,isDeload,rating,sets:[{kg,reps}]}]
  const [ratingTouchedIds, setRatingTouchedIds] = useState({})
  const [pickOpen, setPickOpen] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [pickGroup, setPickGroup] = useState(null) // ключ группы мышц или null = все
  const [addingName, setAddingName] = useState(null) // название, по которому сейчас создаётся личная запись
  const [showInfo, setShowInfo] = useState(false)
  const [infoWhyOpen, setInfoWhyOpen] = useState(false)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [fewSetsToast, setFewSetsToast] = useState(false)
  const [resetConfirmId, setResetConfirmId] = useState(null)
  const [swTime, setSwTime] = useState(0)
  const [swRunning, setSwRunning] = useState(false)
  const swRef = useRef(null)

  const sessionColor = sessionMeta?.color || PUR
  const sessionName = sessionMeta?.name || 'Конструктор'

  // Личный список упражнений — из Supabase (не виден другим клиентам за счёт RLS).
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase.from('constructor_exercises').select('*').eq('user_id', userId).order('created_at')
      if (cancelled || error || !data) return
      setExercises(data)
      localStorage.setItem('fitpro_constructor_exercises', JSON.stringify(data))
    })()
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    if (swRunning) { swRef.current = setInterval(() => setSwTime(t => t + 1), 1000) }
    else { clearInterval(swRef.current) }
    return () => clearInterval(swRef.current)
  }, [swRunning])

  const fmt = s => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // Реальный движок прогрессии — 1ПМ + таблица оценок, та же математика, что
  // у чата (computeTargetWeight, немодифицированный). Ключ агрегации —
  // exercise_id (не название). Границы тренировок здесь — свои
  // (buildConstructorSessions, constructorPhases.js), а НЕ agg.sessions из
  // buildExerciseAggregates (workoutPrompt.js, дата — единственная граница):
  // одно "Завершить" всегда пишет все подходы пачкой за доли секунды, а
  // buildConstructorSessions ещё и режет по разрыву времени внутри одной
  // даты — иначе клиент с двумя настоящими тренировками одного упражнения в
  // один день (утро/вечер) терял бы вторую тренировку в глазах ротации фаз и
  // счётчика отката. Откат в Конструкторе — свой, одноразовый −15%
  // (computeHardStreakTarget/hasHardStreak); buildDeload из workoutPrompt.js
  // (используется только чатом) здесь не участвует вообще.
  // Тип упражнения (одностороннее или нет) приходит ИЗ КАТАЛОГА по названию
  // личной записи — exerciseProfile. Для старых строк со свободным названием
  // (каталог их не знает) profile.fromCatalog === false: считаем как раньше,
  // 4 подхода, никакого нового типа им не приписываем.
  const fetchRecommendationFor = async (ex) => {
    const profile = exerciseProfile(ex.name)
    const emptySets = () => Array.from({ length: baselineSetCount(profile.oneSided) }, () => ({ kg: '', reps: '' }))
    const { data, error } = await supabase.from('constructor_sets').select('*').eq('exercise_id', ex.id).eq('user_id', userId).order('id')
    if (error) { console.error('Конструктор: ошибка загрузки истории упражнения:', error); return { profile, isBaseline: true, phase: null, isDeload: false, sets: emptySets() } }
    const history = data || []
    const sessions = buildConstructorSessions(history)
    const scheme = getUpcomingScheme(sessions, { oneSided: profile.oneSided })
    if (scheme.isBaseline || !sessions.length) return { profile, isBaseline: true, phase: null, isDeload: false, sets: emptySets() }
    const lastSession = sessions[sessions.length - 1]
    const anchorSet = lastSession.workingSets[lastSession.workingSets.length - 1]
    const hard = hasHardStreak(sessions)
    const sets = scheme.reps.map(reps => {
      const target = hard
        ? computeHardStreakTarget(anchorSet, reps)
        : computeTargetWeight(anchorSet, lastSession.effRatings, reps, null)
      return { kg: target?.kg != null ? String(target.kg) : '', reps: String(reps) }
    })
    return { profile, isBaseline: false, phase: scheme.phase, isDeload: hard, sets }
  }

  // Сброс истории одного упражнения ("Начать заново") — удаляет ТОЛЬКО его
  // constructor_sets, остальные упражнения не трогает. После удаления
  // перезапрашиваем рекомендацию тем же путём, что и при добавлении — история
  // пуста, значит вернётся чистый baseline.
  const resetExerciseHistory = async (ex) => {
    const { error } = await supabase.from('constructor_sets')
      .delete().eq('exercise_id', ex.exerciseId).eq('user_id', userId)
    if (error) { console.error('Конструктор: ошибка сброса истории упражнения:', error); return }
    const { profile, isBaseline, phase, isDeload, sets } = await fetchRecommendationFor({ id: ex.exerciseId, name: ex.name })
    setSessionExercises(list => list.map(se =>
      se.exerciseId === ex.exerciseId ? { ...se, profile, isBaseline, phase, isDeload, rating: '', sets } : se
    ))
  }

  const addExerciseToSession = async (ex) => {
    setPickOpen(false); setPickQuery(''); setPickGroup(null)
    if (sessionExercises.some(se => se.exerciseId === ex.id)) return
    const { profile, isBaseline, phase, isDeload, sets } = await fetchRecommendationFor(ex)
    setSessionExercises(list => [...list, {
      exerciseId: ex.id, name: ex.name, profile, isBaseline, phase, isDeload, rating: '', sets,
    }])
  }

  const removeSessionExercise = exerciseId => setSessionExercises(list => list.filter(se => se.exerciseId !== exerciseId))
  const updateExerciseRating = (exerciseId, value) => setSessionExercises(list => list.map(se => se.exerciseId === exerciseId ? { ...se, rating: se.rating === value ? '' : value } : se))

  // Оценка усилия — ОДНА на упражнение целиком, не на подход (см. фикс:
  // раньше ряд оценки был приклеен к последнему подходу и уезжал вниз при
  // каждом "+ Подход", что путало — казалось, будто оценивается конкретный
  // подход). При записи (handleFinish) эта единая оценка проставляется в БД
  // только "рабочим" подходам — последним до двух за день (см. движок в
  // workoutPrompt.js: buildExerciseAggregates, workingCount = min(2, число
  // подходов дня) — только они реально влияют на расчёт следующего веса,
  // усредняя до 2 последних оценок; одна и та же оценка на обоих — то же
  // самое, что подтверждённое единое значение). Более ранним (разминочным)
  // подходам движок оценку не читает вообще.
  const isWorkingSetIndex = (setIdx, totalSets) => setIdx >= totalSets - Math.min(2, totalSets)

  const addSetToExercise = exerciseId => setSessionExercises(list => list.map(se => {
    if (se.exerciseId !== exerciseId) return se
    const last = se.sets[se.sets.length - 1]
    return { ...se, sets: [...se.sets, { kg: last?.kg ?? '', reps: last?.reps ?? '' }] }
  }))
  const removeSetFromExercise = (exerciseId, setIdx) => setSessionExercises(list => list.map(se => {
    if (se.exerciseId !== exerciseId || se.sets.length <= 1) return se
    return { ...se, sets: se.sets.filter((_, i) => i !== setIdx) }
  }))
  const updateSetField = (exerciseId, setIdx, field, value) => setSessionExercises(list => list.map(se => {
    if (se.exerciseId !== exerciseId) return se
    return { ...se, sets: se.sets.map((s, i) => i === setIdx ? { ...s, [field]: value } : s) }
  }))

  // Личная запись клиента заводится ТОЛЬКО под каталожным названием — оно же
  // и есть ссылка на каталог (отдельной колонки в constructor_exercises нет,
  // схема не менялась). Свободного ввода названия больше нет вообще.
  const createExercise = async (name) => {
    if (!name || !userId) return null
    const { data, error } = await supabase.from('constructor_exercises').insert({ user_id: userId, name }).select('*').single()
    if (error) { console.error('Конструктор: ошибка создания упражнения:', error); return null }
    setExercises(list => {
      const updated = [...list, data]
      localStorage.setItem('fitpro_constructor_exercises', JSON.stringify(updated))
      return updated
    })
    return data
  }

  // Выбор упражнения из каталога (EXERCISES) — единственный способ завести
  // упражнение. Защита от дублей вместо fuzzyMatch: смотрим, нет ли уже личной
  // записи ровно с этим каталожным названием (findByCatalogName). Есть —
  // переиспользуем её exercise_id, и история упражнения продолжается, а не
  // форкается. Нечёткое сравнение здесь больше не нужно: названия приходят из
  // одного и того же списка, "присед"/"Приседания" разойтись уже не могут.
  const selectCatalogExercise = async (catEx) => {
    const existing = findByCatalogName(catEx.n, exercises)
    if (existing) { addExerciseToSession(existing); return }
    setAddingName(catEx.n)
    const created = await createExercise(catEx.n)
    setAddingName(null)
    if (created) addExerciseToSession(created)
  }

  const exitSession = () => {
    if (onClearSessionMeta) onClearSessionMeta()
    if (setNav) setNav('workouts')
  }

  // Пишет черновик сессии в БД (прогрессия + дневник) — вызывается ТОЛЬКО
  // из handleFinish (кнопка "Завершить") и из подтверждения выхода "Завершить
  // и выйти". До этого момента ничего не пишется никуда — все правки веса/
  // повторов/оценки живут только в sessionExercises (локальный state), их
  // можно свободно передумать и поменять сколько угодно раз. В движок и в
  // дневник уходит именно ПОСЛЕДНЕЕ значение оценки на момент нажатия
  // "Завершить", а не то, что было выбрано первым.
  const commitSession = async () => {
    setFinishing(true)
    const sessionDate = sessionMeta?.date || new Date().toISOString().slice(0, 10)

    // 1) Прогрессия — по одной строке constructor_sets на КАЖДЫЙ подход (не
    // на упражнение), чтобы движок видел день целиком и сам определил
    // рабочие подходы (см. buildExerciseAggregates). Единая оценка
    // упражнения проставляется рабочим подходам (последние до двух);
    // rating в БД NOT NULL — разминочным подходам без своей оценки
    // подставляем 3 (тот же дефолт, что и у движка для пропущенной оценки),
    // движок их всё равно не читает, это чисто ограничение схемы.
    for (const se of sessionExercises) {
      const total = se.sets.length
      for (let si = 0; si < total; si++) {
        const s = se.sets[si]
        const kg = s.kg === '' ? null : Number(s.kg)
        const rating = isWorkingSetIndex(si, total) ? Number(se.rating) : 3
        const { error } = await supabase.from('constructor_sets').insert({
          user_id: userId, exercise_id: se.exerciseId, date: sessionDate, kg, reps: Number(s.reps) || 0, rating,
        })
        if (error) console.error('Конструктор: ошибка записи подхода:', error)
      }
    }

    // 2) Дневник тренировок — тот же путь, что и обычная тренировка
    // (onWorkoutComplete → insertWorkoutRow/insertWorkoutSetsRows в App.jsx),
    // чтобы сессия конструктора появилась в общей истории как завершённая.
    if (onWorkoutComplete) {
      onWorkoutComplete({
        name: sessionName, color: sessionColor,
        exercises: sessionExercises.map(se => {
          const total = se.sets.length
          return {
            n: se.name, m: '', eq: '',
            sets: se.sets.map((s, si) => ({
              kg: s.kg === '' ? null : Number(s.kg), reps: Number(s.reps) || 0,
              rating: isWorkingSetIndex(si, total) ? Number(se.rating) : null,
            })),
            done: true,
          }
        }),
        duration: swTime,
        date: new Date(sessionDate + 'T12:00:00').toISOString(),
        comment: '',
      })
    }
    setFinishing(false)
    exitSession()
  }

  const handleFinish = async () => {
    if (!sessionExercises.length || finishing) return
    // Оценка обязательна одна на упражнение целиком (не на подход).
    const missingRating = sessionExercises.filter(se => !se.rating)
    if (missingRating.length) { setRatingTouchedIds(Object.fromEntries(missingRating.map(se => [se.exerciseId, true]))); return }
    // Меньше 3 подходов у какого-то упражнения — не блокирует сохранение,
    // просто ненавязчивый тост.
    if (sessionExercises.some(se => se.sets.length < 3)) {
      setFewSetsToast(true)
      setTimeout(() => setFewSetsToast(false), 2500)
    }
    await commitSession()
  }

  // Каталог — поиск по названию + фильтр по группе мышц (filterCatalog,
  // constructorPhases.js). Показывается всегда, в том числе при пустом запросе.
  const catalogMatches = filterCatalog(pickQuery, pickGroup)
  const groups = catalogGroups()

  // Старые личные упражнения со свободными названиями (каталог их не знает).
  // Их не прячем и не переименовываем — клиент может продолжить по ним
  // тренироваться, прогрессия у них прежняя, 4 подхода. Заводить новые такие
  // записи больше нельзя, поэтому у списка нет ни поля ввода, ни фильтра по
  // группе (muscleGroup для произвольного названия ненадёжен).
  const legacyExercises = exercises.filter(ex => !exerciseProfile(ex.name).fromCatalog)
  const legacyQuery = pickQuery.trim().toLowerCase()
  const legacyMatches = legacyQuery
    ? legacyExercises.filter(ex => (ex.name || '').toLowerCase().includes(legacyQuery))
    : legacyExercises

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: '#111', zIndex: 1000, display: 'flex', flexDirection: 'column', color: '#fff' }}>
      {/* Шапка */}
      <div style={{ background: sessionColor, padding: '14px 18px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>{sessionName}</div>
            <button onClick={() => setShowInfo(true)} title="Как это работает"
              style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 12, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'unset', padding: 0, flexShrink: 0 }}>!</button>
          </div>
          <button onClick={() => setShowExitConfirm(true)} style={{ fontSize: 16, color: '#fff', background: 'rgba(0,0,0,0.25)', border: 'none', borderRadius: 6, width: 28, height: 28, cursor: 'pointer', marginTop: 4, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, minHeight: 'unset' }}><GlassIcon name="close" size={20} /></button>
        </div>
      </div>

      {/* Выход — до "Завершить" ничего не записано (черновик только в
          состоянии компонента), поэтому три варианта: дозаписать сейчас,
          выйти без сохранения, или вернуться. Тот же принцип, что и на
          рабочем экране тренировки (showExitConfirm в WorkoutsView) — но
          отдельная копия для конструктора, тот экран не трогаем. */}
      {showExitConfirm && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 350, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowExitConfirm(false)}>
          <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '22px 20px', width: 300, boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 6, textAlign: 'center' }}>Выйти из конструктора?</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 18, textAlign: 'center', lineHeight: 1.5 }}>Если выйти без сохранения — добавленные упражнения не будут записаны.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessionExercises.length > 0 && (
                <button onClick={() => { setShowExitConfirm(false); handleFinish() }}
                  style={{ padding: '11px', borderRadius: 10, border: 'none', background: sessionColor, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Завершить</button>
              )}
              <button onClick={exitSession} style={{ padding: '11px', borderRadius: 10, border: '1px solid #374151', background: 'none', color: '#ef4444', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Выйти без сохранения</button>
              <button onClick={() => setShowExitConfirm(false)} style={{ padding: '9px', borderRadius: 10, border: 'none', background: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer' }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
        {/* Секундомер */}
        <div style={{ background: '#1c1c1e', borderRadius: 12, padding: '14px 18px 16px', marginBottom: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>Секундомер</div>
          <div style={{ fontSize: 46, fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums', letterSpacing: 2, marginBottom: 14 }}>{fmt(swTime)}</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={() => setSwRunning(r => !r)}
              style={{ padding: '10px 32px', borderRadius: 8, border: 'none', background: swRunning ? '#374151' : sessionColor, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              {swRunning ? '⏸ Стоп' : '▶ Старт'}
            </button>
            <button onClick={() => { setSwRunning(false); setSwTime(0) }}
              style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontSize: 14, cursor: 'pointer' }}>↺</button>
          </div>
        </div>

        {/* Упражнения сессии */}
        {sessionExercises.length === 0 ? (
          <div style={{ textAlign: 'center', marginTop: 40 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Добавь упражнение</div>
            <div style={{ fontSize: 14, color: '#9ca3af', lineHeight: 1.7 }}>Нажми «+», чтобы выбрать упражнение из каталога.</div>
          </div>
        ) : sessionExercises.map(se => (
          <div key={se.exerciseId} style={{ marginBottom: 14, background: '#1f2937', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: sessionColor }}>{se.name}</span>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {!se.isBaseline && (
                  <button onClick={() => setResetConfirmId(se.exerciseId)}
                    title="Начать заново — сбросить историю этого упражнения"
                    style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', padding: 0, marginRight: 4 }}>↺</button>
                )}
                <button onClick={() => removeSessionExercise(se.exerciseId)} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 16, cursor: 'pointer', padding: 0 }}><GlassIcon name="close" size={20} /></button>
              </div>
            </div>
            {/* Тип упражнения — из каталога, клиент его не задаёт. Строка нужна
                прежде всего затем, чтобы было видно, ПОЧЕМУ у одностороннего
                упражнения 2 подхода, а не 4, и чтобы старая запись со
                свободным названием честно называлась старой. */}
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
              {se.profile?.fromCatalog
                ? `${se.profile.muscle}${se.profile.equipment ? ` · ${se.profile.equipment}` : ''}${se.profile.oneSided ? ' · одностороннее' : ''}`
                : 'Добавлено вручную раньше — тип упражнения неизвестен'}
            </div>
            {se.isBaseline && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>
                Первый замер — впиши вес и повторы сам
              </div>
            )}

            {resetConfirmId === se.exerciseId && (
              <div style={{ background: '#111', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: '#f3f4f6', marginBottom: 8, lineHeight: 1.5 }}>
                  Сбросить историю «{se.name}»? Упражнение снова станет первым замером — впишешь вес и повторы сам.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={async () => { await resetExerciseHistory(se); setResetConfirmId(null) }}
                    style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Сбросить</button>
                  <button onClick={() => setResetConfirmId(null)}
                    style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontSize: 12.5, cursor: 'pointer' }}>Отмена</button>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr 20px', gap: 6, marginBottom: 4 }}>
              {['#', 'КГ', 'ПОВТ', ''].map((h, i) => (
                <span key={i} style={{ fontSize: 9, color: '#6b7280', textAlign: 'center', textTransform: 'uppercase' }}>{h}</span>
              ))}
            </div>
            {se.sets.map((s, si) => (
              <div key={si} style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr 20px', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', fontWeight: 700 }}>{si + 1}</span>
                <input type="number" inputMode="decimal" value={s.kg} onChange={e => updateSetField(se.exerciseId, si, 'kg', e.target.value)} placeholder="0"
                  style={{ width: '100%', background: '#374151', border: '1px solid #4b5563', borderRadius: 6, padding: '7px 6px', fontSize: 13, color: '#fff', textAlign: 'center', boxSizing: 'border-box' }} />
                <input type="number" inputMode="numeric" value={s.reps} onChange={e => updateSetField(se.exerciseId, si, 'reps', e.target.value)} placeholder="0"
                  style={{ width: '100%', background: '#374151', border: '1px solid #4b5563', borderRadius: 6, padding: '7px 6px', fontSize: 13, color: '#fff', textAlign: 'center', boxSizing: 'border-box' }} />
                <button onClick={() => removeSetFromExercise(se.exerciseId, si)} disabled={se.sets.length <= 1}
                  style={{ background: 'none', border: 'none', color: se.sets.length <= 1 ? '#374151' : '#6b7280', cursor: se.sets.length <= 1 ? 'default' : 'pointer', fontSize: 14, textAlign: 'center', padding: 0 }}><GlassIcon name="close" size={20} /></button>
              </div>
            ))}
            <div style={{ marginBottom: 4 }}>
              <button onClick={() => addSetToExercise(se.exerciseId)}
                style={{ fontSize: 12, color: sessionColor, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}>
                + Подход
              </button>
            </div>

            {/* Оценка усилия — ФИКСИРОВАННОЕ место внизу карточки, одна на
                упражнение целиком. Не двигается при добавлении/удалении
                подходов (был баг: раньше ряд оценки был приклеен к
                последнему подходу и уезжал вниз вслед за ним). */}
            <div style={{ borderTop: '1px solid #374151', marginTop: 10, paddingTop: 10 }}>
              <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase' }}>Насколько было тяжело?</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'space-between' }}>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} onClick={() => { updateExerciseRating(se.exerciseId, n); setRatingTouchedIds(t => ({ ...t, [se.exerciseId]: false })) }}
                    title={n === 1 ? '1 — совсем легко' : n === 5 ? '5 — на пределе' : String(n)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: se.rating === n ? 22 : 17, fontWeight: se.rating === n ? 800 : 600, lineHeight: 1, color: se.rating === n ? sessionColor : '#4b5563', transition: 'font-size .1s, color .1s' }}>
                    {n}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: ratingTouchedIds[se.exerciseId] ? '#ef4444' : '#6b7280', marginTop: 8, lineHeight: 1.5 }}>{RATING_HINT}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Нижняя панель */}
      <div style={{ padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', flexShrink: 0 }}>
        <button onClick={() => setPickOpen(true)} style={{ width: 42, height: 42, borderRadius: '50%', border: '2px solid #374151', background: 'none', color: '#9ca3af', fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
        <button onClick={handleFinish} disabled={finishing || !sessionExercises.length}
          style={{ padding: '12px 36px', borderRadius: 24, border: 'none', background: sessionColor, color: '#fff', fontSize: 15, fontWeight: 700, cursor: finishing || !sessionExercises.length ? 'default' : 'pointer', opacity: finishing || !sessionExercises.length ? 0.5 : 1, boxShadow: `0 4px 16px ${sessionColor}66` }}>
          Завершить
        </button>
        <div style={{ width: 42 }} />
      </div>

      {/* Пикер упражнений — каталог приложения (EXERCISES), поиск + фильтр по
          группе мышц. Свободного ввода названия здесь больше нет. */}
      {pickOpen && (
        <div style={{ position: 'absolute', inset: 0, background: '#111', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Каталог упражнений</span>
              <button onClick={() => { setPickOpen(false); setPickQuery(''); setPickGroup(null) }} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 20, cursor: 'pointer' }}><GlassIcon name="close" size={20} /></button>
            </div>
            <input value={pickQuery} onChange={e => setPickQuery(e.target.value)} placeholder="Поиск по названию..."
              style={{ width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 8, border: '1px solid #374151', background: '#2a2a2e', color: '#fff', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 10, paddingBottom: 2 }}>
              {[null, ...groups].map(g => {
                const active = pickGroup === g
                return (
                  <button key={g || 'all'} onClick={() => setPickGroup(g)}
                    style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 16, whiteSpace: 'nowrap', cursor: 'pointer', border: `1px solid ${active ? sessionColor : '#374151'}`, background: active ? sessionColor : 'none', color: active ? '#fff' : '#9ca3af' }}>
                    {g === null ? 'Все' : (GROUP_LABELS[g] || g)}
                  </button>
                )
              })}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {catalogMatches.length === 0 && legacyMatches.length === 0 && (
              <div style={{ textAlign: 'center', color: '#6b7280', marginTop: 40, fontSize: 13 }}>Ничего не найдено</div>
            )}
            {catalogMatches.map(ex => {
              const personal = findByCatalogName(ex.n, exercises)
              const already = personal && sessionExercises.some(se => se.exerciseId === personal.id)
              const creating = addingName === ex.n
              const profile = exerciseProfile(ex.n)
              return (
                <button key={`c-${ex.n}`} onClick={() => !already && !creating && selectCatalogExercise(ex)} disabled={already || creating}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', padding: '13px 18px', background: 'none', border: 'none', borderBottom: '1px solid #1f2937', cursor: already || creating ? 'default' : 'pointer', textAlign: 'left', opacity: already ? 0.4 : creating ? 0.5 : 1 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>{ex.n}</div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                      {ex.m}{ex.eq ? ` · ${ex.eq}` : ''}{profile.oneSided ? ' · одностороннее' : ''}
                    </div>
                  </div>
                  {creating ? <span style={{ color: '#9ca3af', fontSize: 18 }}>…</span> : <GlassIcon name={already ? 'check' : 'plus'} size={20} />}
                </button>
              )
            })}
            {legacyMatches.length > 0 && (
              <div style={{ padding: '14px 18px 6px', fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Раньше добавлено вручную</div>
            )}
            {legacyMatches.map(ex => {
              const already = sessionExercises.some(se => se.exerciseId === ex.id)
              return (
                <button key={`o-${ex.id}`} onClick={() => !already && addExerciseToSession(ex)} disabled={already}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '13px 18px', background: 'none', border: 'none', borderBottom: '1px solid #1f2937', cursor: already ? 'default' : 'pointer', textAlign: 'left', opacity: already ? 0.4 : 1 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>{ex.name}</div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>Не из каталога — тип упражнения неизвестен</div>
                  </div>
                  <GlassIcon name={already ? 'check' : 'plus'} size={20} />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Информационная плашка по значку "!" */}
      {showInfo && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setShowInfo(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '22px 20px', maxWidth: 380, width: '100%', boxSizing: 'border-box' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>{CONSTRUCTOR_INFO_TEXT.title}</span>
              <button onClick={() => setShowInfo(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', lineHeight: 1, padding: 0 }}><GlassIcon name="close" size={20} /></button>
            </div>
            <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.65, whiteSpace: 'pre-wrap', marginBottom: 14 }}>{CONSTRUCTOR_INFO_TEXT.body}</div>
            <button onClick={() => setInfoWhyOpen(v => !v)} style={{ background: 'none', border: 'none', color: PUR, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: infoWhyOpen ? 8 : 14, display: 'flex', alignItems: 'center', gap: 4 }}>
              Почему это работает {infoWhyOpen ? '▲' : '▼'}
            </button>
            {infoWhyOpen && <div style={{ fontSize: 12.5, color: '#6b7280', lineHeight: 1.6, marginBottom: 14 }}>{CONSTRUCTOR_INFO_TEXT.why}</div>}
            <div style={{ fontSize: 12, color: PUR, fontWeight: 600, background: `${PUR}10`, borderRadius: 9, padding: '10px 12px', lineHeight: 1.5 }}>{CONSTRUCTOR_INFO_TEXT.mandatory}</div>
          </div>
        </div>
      )}

      {/* Тост "меньше 3 подходов" — ненавязчивый, не блокирует сохранение */}
      {fewSetsToast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', background: '#1c1c1e', color: '#fff', fontSize: 13, padding: '10px 18px', borderRadius: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 2300, whiteSpace: 'nowrap' }}>
          Рекомендуем хотя бы 3 подхода
        </div>
      )}
    </div>
  , document.body)
}
