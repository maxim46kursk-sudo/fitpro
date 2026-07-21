// Конструктор тренировок с прогрессией — ЗАМОРОЖЕН, не подключён к
// приложению (см. docs/CONSTRUCTOR_FROZEN.md для полного описания и причин
// заморозки). Этот файл больше никуда не импортируется — код рабочий и
// оставлен как есть для возможного возврата, но не используется.
//
// Изначально жил прямо в App.jsx, вынесен в отдельный файл при заморозке,
// чтобы не раздувать App.jsx мёртвым кодом. Логика и разметка не менялись.
//
// Отдельный от AI-чата и от основного дневника (workouts/workout_sets)
// режим: персональный список упражнений клиента (constructor_exercises) +
// история подходов по exercise_id (constructor_sets). Никакого диалога с AI
// и никакого маркера SET_PROGRAM здесь нет — только детерминированный расчёт
// через реальный движок прогрессии (buildExerciseAggregates/
// computeTargetWeight из src/workoutPrompt.js, 1ПМ + таблица {10,7,5,3,2} +
// откат, протестировано в test-progression-personas.js, 41/41) — движок не
// меняем, только подключаем. Прогрессия ключится СТРОГО по exercise_id
// (передаём его как "exercise" в подходы для агрегатора) — совпадение
// названий не участвует в расчёте вообще, только в мягком предупреждении о
// дубле при создании упражнения (см. fuzzyMatch.js).
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabase.js'
import { EXERCISES } from './programs.js'
import { computeTargetWeight } from './workoutPrompt.js'
import { findSimilarExercise, normalizeExerciseName } from './fuzzyMatch.js'
import { getUpcomingScheme, hasHardStreak, computeHardStreakTarget, buildConstructorSessions } from './constructorPhases.js'

const PUR = '#7F77DD'

const RATING_HINT = 'Оцени, насколько было тяжело — без этого ассистент не сможет подобрать следующий вес.'
const CONSTRUCTOR_INFO_TEXT = {
  title: 'Как это работает',
  body: 'Добавь упражнения, которые тебе нравятся — с любым названием. После каждого отметь вес, повторы и оценку усилия. В следующий раз ассистент подскажет рабочий вес и число повторений для прогресса.\n\nПервая тренировка каждого упражнения — стартовый замер: веса задаёшь ты. Дальше рекомендации считает ассистент.\n\nСовет: первыми лучше ставить базовые упражнения.',
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
  const [sessionExercises, setSessionExercises] = useState([]) // [{exerciseId,name,isBaseline,phase,isDeload,rating,sets:[{kg,reps}]}]
  const [ratingTouchedIds, setRatingTouchedIds] = useState({})
  const [pickOpen, setPickOpen] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [duplicateCandidate, setDuplicateCandidate] = useState(null) // {name, match}
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
  const fetchRecommendationFor = async (ex) => {
    const emptySets = () => Array.from({ length: 4 }, () => ({ kg: '', reps: '' }))
    const { data, error } = await supabase.from('constructor_sets').select('*').eq('exercise_id', ex.id).eq('user_id', userId).order('id')
    if (error) { console.error('Конструктор: ошибка загрузки истории упражнения:', error); return { isBaseline: true, phase: null, isDeload: false, sets: emptySets() } }
    const history = data || []
    const sessions = buildConstructorSessions(history)
    const scheme = getUpcomingScheme(sessions)
    if (scheme.isBaseline || !sessions.length) return { isBaseline: true, phase: null, isDeload: false, sets: emptySets() }
    const lastSession = sessions[sessions.length - 1]
    const anchorSet = lastSession.workingSets[lastSession.workingSets.length - 1]
    const hard = hasHardStreak(sessions)
    const sets = scheme.reps.map(reps => {
      const target = hard
        ? computeHardStreakTarget(anchorSet, reps)
        : computeTargetWeight(anchorSet, lastSession.effRatings, reps, null)
      return { kg: target?.kg != null ? String(target.kg) : '', reps: String(reps) }
    })
    return { isBaseline: false, phase: scheme.phase, isDeload: hard, sets }
  }

  // Сброс истории одного упражнения ("Начать заново") — удаляет ТОЛЬКО его
  // constructor_sets, остальные упражнения не трогает. После удаления
  // перезапрашиваем рекомендацию тем же путём, что и при добавлении — история
  // пуста, значит вернётся чистый baseline.
  const resetExerciseHistory = async (ex) => {
    const { error } = await supabase.from('constructor_sets')
      .delete().eq('exercise_id', ex.exerciseId).eq('user_id', userId)
    if (error) { console.error('Конструктор: ошибка сброса истории упражнения:', error); return }
    const { isBaseline, phase, isDeload, sets } = await fetchRecommendationFor({ id: ex.exerciseId, name: ex.name })
    setSessionExercises(list => list.map(se =>
      se.exerciseId === ex.exerciseId ? { ...se, isBaseline, phase, isDeload, rating: '', sets } : se
    ))
  }

  const addExerciseToSession = async (ex) => {
    setPickOpen(false); setPickQuery('')
    if (sessionExercises.some(se => se.exerciseId === ex.id)) return
    const { isBaseline, phase, isDeload, sets } = await fetchRecommendationFor(ex)
    setSessionExercises(list => [...list, {
      exerciseId: ex.id, name: ex.name, isBaseline, phase, isDeload, rating: '', sets,
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

  const createExercise = async (name) => {
    const trimmed = name.trim()
    if (!trimmed || !userId) return null
    const { data, error } = await supabase.from('constructor_exercises').insert({ user_id: userId, name: trimmed }).select('*').single()
    if (error) { console.error('Конструктор: ошибка создания упражнения:', error); return null }
    setExercises(list => {
      const updated = [...list, data]
      localStorage.setItem('fitpro_constructor_exercises', JSON.stringify(updated))
      return updated
    })
    return data
  }

  const handleAddSubmit = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    const match = findSimilarExercise(trimmed, exercises)
    if (match) { setDuplicateCandidate({ name: trimmed, match }); return }
    finishAdd(trimmed)
  }
  const finishAdd = async (name) => {
    const created = await createExercise(name)
    setShowAdd(false); setNewName(''); setDuplicateCandidate(null)
    if (created) addExerciseToSession(created)
  }
  const useExisting = (ex) => {
    setShowAdd(false); setNewName(''); setDuplicateCandidate(null)
    addExerciseToSession(ex)
  }

  // Выбор упражнения из ОБЩЕЙ библиотеки приложения (EXERCISES) — витрина
  // для поиска, сама прогрессия по ней никогда не считается. Первый раз
  // заводим личную запись в constructor_exercises — дальше история и вес
  // ведутся по её exercise_id, не по названию и не по id библиотеки. Если
  // findSimilarExercise находит похожую личную запись — показываем ту же
  // модалку "Это оно / новое", что и при ручном создании (duplicateCandidate),
  // а не молча переиспользуем: иначе ложноотрицательный матч (разное число
  // слов слегка за порогом) тихо форкает exercise_id и обрывает историю —
  // ровно баг, который и чинит эта правка.
  const [addingLibraryName, setAddingLibraryName] = useState(null)
  const selectLibraryExercise = async (libEx) => {
    const match = findSimilarExercise(libEx.n, exercises)
    if (match) { setDuplicateCandidate({ name: libEx.n, match }); return }
    setAddingLibraryName(libEx.n)
    const created = await createExercise(libEx.n)
    setAddingLibraryName(null)
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

  // Поиск сравнивает НОРМАЛИЗОВАННЫЕ строки (normalizeExerciseName из
  // fuzzyMatch.js — регистр, цифры/кг, лишние пробелы уже не мешают:
  // "выпады" = "Выпады" = "выпады 20кг" находятся одним и тем же запросом).
  // Личный список — фильтруется всегда (в т.ч. при пустом запросе, тогда
  // показывается целиком, как раньше). Общая библиотека подключается только
  // от 2 символов реального ввода и дедуплицируется против уже имеющихся
  // личных упражнений (findSimilarExercise — та же фаззи-логика, что и при
  // дедупе на выборе/создании, чтобы список не показывал как "из библиотеки"
  // то, что у пользователя уже есть под другим написанием).
  const rawQuery = pickQuery.trim()
  const normQuery = normalizeExerciseName(rawQuery)
  const personalMatches = normQuery
    ? exercises.filter(ex => normalizeExerciseName(ex.name).includes(normQuery))
    : exercises
  const libraryMatches = rawQuery.length >= 2 && normQuery
    ? EXERCISES.filter(ex => normalizeExerciseName(ex.n).includes(normQuery) && !findSimilarExercise(ex.n, exercises))
    : []

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
          <button onClick={() => setShowExitConfirm(true)} style={{ fontSize: 16, color: '#fff', background: 'rgba(0,0,0,0.25)', border: 'none', borderRadius: 6, width: 28, height: 28, cursor: 'pointer', marginTop: 4, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, minHeight: 'unset' }}>✕</button>
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
            <div style={{ fontSize: 14, color: '#9ca3af', lineHeight: 1.7 }}>Нажми «+», чтобы выбрать упражнение из своего списка.</div>
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
                <button onClick={() => removeSessionExercise(se.exerciseId)} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 16, cursor: 'pointer', padding: 0 }}>✕</button>
              </div>
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
                  style={{ background: 'none', border: 'none', color: se.sets.length <= 1 ? '#374151' : '#6b7280', cursor: se.sets.length <= 1 ? 'default' : 'pointer', fontSize: 14, textAlign: 'center', padding: 0 }}>✕</button>
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

      {/* Пикер упражнений из личного списка */}
      {pickOpen && (
        <div style={{ position: 'absolute', inset: 0, background: '#111', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Мои упражнения</span>
              <button onClick={() => { setPickOpen(false); setPickQuery('') }} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={pickQuery} onChange={e => setPickQuery(e.target.value)} placeholder="Поиск упражнения..."
                style={{ flex: 1, padding: '9px 12px', fontSize: 13, borderRadius: 8, border: '1px solid #374151', background: '#2a2a2e', color: '#fff', boxSizing: 'border-box' }} />
              <button onClick={() => { setShowAdd(true); setNewName('') }}
                style={{ padding: '9px 13px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: 'none', background: sessionColor, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                Новое +
              </button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {personalMatches.length === 0 && libraryMatches.length === 0 && (
              <div style={{ textAlign: 'center', color: '#6b7280', marginTop: 40, fontSize: 13 }}>Ничего не найдено</div>
            )}
            {personalMatches.map(ex => {
              const already = sessionExercises.some(se => se.exerciseId === ex.id)
              return (
                <button key={`p-${ex.id}`} onClick={() => !already && addExerciseToSession(ex)} disabled={already}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '13px 18px', background: 'none', border: 'none', borderBottom: '1px solid #1f2937', cursor: already ? 'default' : 'pointer', textAlign: 'left', opacity: already ? 0.4 : 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>{ex.name}</div>
                  <span style={{ color: sessionColor, fontSize: 18, fontWeight: 300 }}>{already ? '✓' : '+'}</span>
                </button>
              )
            })}
            {libraryMatches.length > 0 && (
              <div style={{ padding: '10px 18px 6px', fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Библиотека упражнений</div>
            )}
            {libraryMatches.map(ex => {
              const creating = addingLibraryName === ex.n
              return (
                <button key={`l-${ex.n}`} onClick={() => !creating && selectLibraryExercise(ex)} disabled={creating}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '13px 18px', background: 'none', border: 'none', borderBottom: '1px solid #1f2937', cursor: creating ? 'default' : 'pointer', textAlign: 'left', opacity: creating ? 0.5 : 1 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>{ex.n}</div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{ex.m}{ex.eq ? ` · ${ex.eq}` : ''}</div>
                  </div>
                  <span style={{ color: '#9ca3af', fontSize: 18, fontWeight: 300 }}>{creating ? '…' : '+'}</span>
                </button>
              )
            })}
            {pickQuery.trim() && (
              <button onClick={() => { setNewName(pickQuery.trim()); setShowAdd(true) }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '13px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ color: sessionColor, fontSize: 16, fontWeight: 700 }}>+</span>
                <span style={{ fontSize: 13, color: sessionColor, fontWeight: 600 }}>Новое: «{pickQuery.trim()}»</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Новое упражнение (создание в личном списке) */}
      {showAdd && !duplicateCandidate && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
          onClick={() => { setShowAdd(false); setNewName('') }}>
          <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '22px 20px 18px', width: 300, boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Новое упражнение</span>
              <button onClick={() => { setShowAdd(false); setNewName('') }} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 5 }}>Название</div>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Назови как удобно" autoFocus
              style={{ width: '100%', padding: '10px 12px', fontSize: 13, borderRadius: 8, border: '1px solid #374151', background: '#2a2a2e', color: '#fff', boxSizing: 'border-box', outline: 'none' }}
              onKeyDown={e => e.key === 'Enter' && handleAddSubmit()} />
            <button onClick={handleAddSubmit} style={{ width: '100%', marginTop: 16, padding: '12px', borderRadius: 9, border: 'none', background: sessionColor, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Добавить</button>
          </div>
        </div>
      )}

      {/* Мягкое предупреждение о похожем упражнении — не блокирует */}
      {duplicateCandidate && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 310, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setDuplicateCandidate(null)}>
          <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '22px 20px', width: 300, boxShadow: '0 16px 48px rgba(0,0,0,0.6)', textAlign: 'center' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>🤔</div>
            <div style={{ fontSize: 14, color: '#fff', lineHeight: 1.6, marginBottom: 20 }}>
              У тебя уже есть «{duplicateCandidate.match.name}». Это оно или новое упражнение?
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => useExisting(duplicateCandidate.match)} style={{ padding: '12px', borderRadius: 9, border: 'none', background: sessionColor, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Это оно</button>
              <button onClick={() => finishAdd(duplicateCandidate.name)} style={{ padding: '12px', borderRadius: 9, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Нет, создать новое</button>
            </div>
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
              <button onClick={() => setShowInfo(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', lineHeight: 1, padding: 0 }}>✕</button>
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
