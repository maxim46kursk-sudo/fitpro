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
// Цвета — ТОЛЬКО отсюда. Своей палитры у экрана больше нет: раньше он держал
// собственный фиолетовый и десяток tailwind-серых, из-за чего выглядел как
// кусок другого приложения (см. reports/constructor-ui/before-*.png).
import {
  BG, SURF, SURF2, SEP, HAIR, TXT, TXT2, TXT3, PUR, DANGER,
  SCRIM, SCRIM_STRONG, SHADOW_CARD, SHADOW_POPUP, SHADOW_MODAL, SHADOW_PRIMARY, GRADIENT_PRIMARY,
} from './theme.js'

// Подписи групп мышц для фильтра каталога — ключи те же, что отдаёт
// muscleGroup (exerciseMeta.js), плюс 'other' для упражнений, которым
// эвристика группу не назначила (см. catalogGroup).
const GROUP_LABELS = {
  legs: 'Ноги', back: 'Спина', chest: 'Грудь', shoulders: 'Плечи',
  arms: 'Руки', abs: 'Пресс', cardio: 'Кардио', [CATALOG_OTHER_GROUP]: 'Другое',
}

// Склонение счётного существительного — та же формула, что у plural() в
// App.jsx (копия из трёх строк вместо импорта: App.jsx импортирует этот файл,
// обратный импорт замкнул бы зависимость в кольцо).
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
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
    <div data-testid="constructor-screen" style={{ position: 'fixed', inset: 0, background: BG, zIndex: 1000, display: 'flex', flexDirection: 'column', color: TXT }}>
      {/* Шапка — как у прочих полноэкранных подэкранов приложения (тренировка
          программы, разделы Дневника): тёмная поверхность, стрелка «назад»
          слева, заголовок с подписью. Сплошной цветной плиты, которой этот
          экран отличался от всего остального, больше нет. */}
      <div style={{ background: SURF, borderBottom: `1px solid ${HAIR}`, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button data-back="1" data-testid="constructor-close" onClick={() => setShowExitConfirm(true)}
          style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: TXT3, lineHeight: 1, padding: 0, minHeight: 'unset' }}><GlassIcon name="back" size={26} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: TXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionName}</div>
          <div style={{ fontSize: 11, color: TXT3 }}>
            {sessionExercises.length ? `${sessionExercises.length} ${plural(sessionExercises.length, 'упражнение', 'упражнения', 'упражнений')}` : 'Упражнения не добавлены'}
          </div>
        </div>
        <button data-testid="constructor-info" onClick={() => setShowInfo(true)} title="Как это работает"
          style={{ width: 26, height: 26, borderRadius: '50%', border: `1px solid ${HAIR}`, background: SURF2, color: TXT3, fontSize: 13, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'unset', padding: 0, flexShrink: 0 }}>!</button>
      </div>

      {/* Выход — до "Завершить" ничего не записано (черновик только в
          состоянии компонента), поэтому три варианта: дозаписать сейчас,
          выйти без сохранения, или вернуться. Тот же принцип, что и на
          рабочем экране тренировки (showExitConfirm в WorkoutsView) — но
          отдельная копия для конструктора, тот экран не трогаем. */}
      {showExitConfirm && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 350, display: 'flex', alignItems: 'center', justifyContent: 'center', background: SCRIM_STRONG }}
          onClick={() => setShowExitConfirm(false)}>
          <div style={{ background: SURF, borderRadius: 16, padding: '22px 20px', width: 300, boxShadow: SHADOW_MODAL }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, color: TXT, marginBottom: 6, textAlign: 'center' }}>Выйти из конструктора?</div>
            <div style={{ fontSize: 13, color: TXT3, marginBottom: 18, textAlign: 'center', lineHeight: 1.5 }}>Если выйти без сохранения — добавленные упражнения не будут записаны.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessionExercises.length > 0 && (
                <button data-testid="constructor-exit-finish" onClick={() => { setShowExitConfirm(false); handleFinish() }}
                  style={{ padding: '11px', borderRadius: 10, border: 'none', background: PUR, color: TXT, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Завершить</button>
              )}
              <button data-testid="constructor-exit-discard" onClick={exitSession}
                style={{ padding: '11px', borderRadius: 10, border: `1px solid ${HAIR}`, background: 'none', color: DANGER, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Выйти без сохранения</button>
              <button data-testid="constructor-exit-cancel" onClick={() => setShowExitConfirm(false)}
                style={{ padding: '9px', borderRadius: 10, border: 'none', background: 'none', color: TXT3, fontSize: 13, cursor: 'pointer' }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 32px' }}>
        {/* Секундомер — элемент только этого экрана, поэтому оформлен не «как
            где-то ещё», а в общих токенах и общей типографике: та же карточка
            SURF/13, те же подписи TXT3 uppercase, та же главная кнопка. */}
        <div style={{ background: SURF, borderRadius: 13, boxShadow: SHADOW_CARD, padding: '14px 16px 16px', marginBottom: 10, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: TXT3, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>Секундомер</div>
          <div style={{ fontSize: 40, fontWeight: 800, color: TXT, fontVariantNumeric: 'tabular-nums', letterSpacing: 2, marginBottom: 14 }}>{fmt(swTime)}</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button data-testid="constructor-sw-toggle" onClick={() => setSwRunning(r => !r)}
              style={{ padding: '10px 32px', borderRadius: 12, border: swRunning ? `1px solid ${HAIR}` : 'none', background: swRunning ? SURF2 : GRADIENT_PRIMARY, color: swRunning ? TXT2 : TXT, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              {swRunning ? '⏸ Стоп' : '▶ Старт'}
            </button>
            <button data-testid="constructor-sw-reset" onClick={() => { setSwRunning(false); setSwTime(0) }}
              style={{ padding: '10px 18px', borderRadius: 12, border: `1px solid ${HAIR}`, background: 'none', color: TXT3, fontSize: 14, cursor: 'pointer' }}>↺</button>
          </div>
        </div>

        {/* Упражнения сессии — карточки того же вида, что в «Моих тренировках»:
            SURF, радиус 13, та же тень и те же отступы. */}
        {sessionExercises.length === 0 ? (
          <div style={{ textAlign: 'center', color: TXT3, fontSize: 13, marginTop: 60 }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><GlassIcon name="dumbbell" size={44} /></div>
            Нажми «+», чтобы выбрать упражнение из каталога
          </div>
        ) : sessionExercises.map(se => (
          <div key={se.exerciseId} data-testid="constructor-ex-card" style={{ marginBottom: 10, background: SURF, borderRadius: 13, boxShadow: SHADOW_CARD, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: TXT, minWidth: 0 }}>{se.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {!se.isBaseline && (
                  <button data-testid="constructor-ex-reset" onClick={() => setResetConfirmId(se.exerciseId)}
                    title="Начать заново — сбросить историю этого упражнения"
                    style={{ background: 'none', border: 'none', color: TXT3, fontSize: 13, cursor: 'pointer', padding: 0 }}>↺</button>
                )}
                <button data-testid="constructor-ex-remove" onClick={() => removeSessionExercise(se.exerciseId)}
                  style={{ background: 'none', border: 'none', color: TXT3, fontSize: 16, cursor: 'pointer', padding: 0 }}><GlassIcon name="close" size={20} /></button>
              </div>
            </div>
            {/* Тип упражнения — из каталога, клиент его не задаёт. Строка нужна
                прежде всего затем, чтобы было видно, ПОЧЕМУ у одностороннего
                упражнения 2 подхода, а не 4, и чтобы старая запись со
                свободным названием честно называлась старой. */}
            <div style={{ fontSize: 11, color: TXT3, marginBottom: 8 }}>
              {se.profile?.fromCatalog
                ? `${se.profile.muscle}${se.profile.equipment ? ` · ${se.profile.equipment}` : ''}${se.profile.oneSided ? ' · одностороннее' : ''}`
                : 'Добавлено вручную раньше — тип упражнения неизвестен'}
            </div>
            {se.isBaseline && (
              <div style={{ fontSize: 11, color: TXT2, marginBottom: 10 }}>
                Первый замер — впиши вес и повторы сам
              </div>
            )}

            {resetConfirmId === se.exerciseId && (
              <div style={{ background: SURF2, borderRadius: 12, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: TXT2, marginBottom: 8, lineHeight: 1.5 }}>
                  Сбросить историю «{se.name}»? Упражнение снова станет первым замером — впишешь вес и повторы сам.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={async () => { await resetExerciseHistory(se); setResetConfirmId(null) }}
                    style={{ flex: 1, padding: '8px', borderRadius: 10, border: 'none', background: DANGER, color: TXT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Сбросить</button>
                  <button onClick={() => setResetConfirmId(null)}
                    style={{ flex: 1, padding: '8px', borderRadius: 10, border: `1px solid ${HAIR}`, background: 'none', color: TXT3, fontSize: 12.5, cursor: 'pointer' }}>Отмена</button>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr 22px', gap: 8, marginBottom: 4 }}>
              {['#', 'КГ', 'ПОВТ', ''].map((h, i) => (
                <span key={i} style={{ fontSize: 9, color: TXT3, textAlign: 'center', textTransform: 'uppercase', letterSpacing: 1 }}>{h}</span>
              ))}
            </div>
            {se.sets.map((s, si) => (
              <div key={si} style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr 22px', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: TXT3, textAlign: 'center', fontWeight: 700 }}>{si + 1}</span>
                {/* Поля веса/повторов — ровно те же, что на экране тренировки
                    по шаблону (см. set-kg/set-reps в WorkoutsView). */}
                <input data-testid="constructor-kg" type="number" inputMode="decimal" value={s.kg} onChange={e => updateSetField(se.exerciseId, si, 'kg', e.target.value)} placeholder="0"
                  style={{ width: '100%', background: SURF2, border: `1.5px solid ${HAIR}`, borderRadius: 12, padding: '6px 6px', fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: TXT, textAlign: 'center', boxSizing: 'border-box' }} />
                <input data-testid="constructor-reps" type="number" inputMode="numeric" value={s.reps} onChange={e => updateSetField(se.exerciseId, si, 'reps', e.target.value)} placeholder="0"
                  style={{ width: '100%', background: SURF2, border: `1.5px solid ${HAIR}`, borderRadius: 12, padding: '6px 6px', fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: TXT, textAlign: 'center', boxSizing: 'border-box' }} />
                <button data-testid="constructor-set-remove" onClick={() => removeSetFromExercise(se.exerciseId, si)} disabled={se.sets.length <= 1}
                  style={{ background: 'none', border: 'none', color: TXT3, opacity: se.sets.length <= 1 ? 0.35 : 1, cursor: se.sets.length <= 1 ? 'default' : 'pointer', fontSize: 14, textAlign: 'center', padding: 0 }}><GlassIcon name="close" size={20} /></button>
              </div>
            ))}
            <div style={{ marginBottom: 4 }}>
              <button data-testid="constructor-add-set" onClick={() => addSetToExercise(se.exerciseId)}
                style={{ fontSize: 13, color: PUR, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, padding: '4px 0' }}>
                + Подход
              </button>
            </div>

            {/* Оценка усилия — ФИКСИРОВАННОЕ место внизу карточки, одна на
                упражнение целиком. Не двигается при добавлении/удалении
                подходов (был баг: раньше ряд оценки был приклеен к
                последнему подходу и уезжал вниз вслед за ним). */}
            <div style={{ borderTop: `1px solid ${HAIR}`, marginTop: 10, paddingTop: 10 }}>
              <div style={{ fontSize: 10, color: TXT3, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Насколько было тяжело?</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'space-between' }}>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} data-testid={`constructor-rating-${n}`} onClick={() => { updateExerciseRating(se.exerciseId, n); setRatingTouchedIds(t => ({ ...t, [se.exerciseId]: false })) }}
                    title={n === 1 ? '1 — совсем легко' : n === 5 ? '5 — на пределе' : String(n)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: se.rating === n ? 22 : 17, fontWeight: se.rating === n ? 800 : 600, lineHeight: 1, color: se.rating === n ? PUR : TXT3, transition: 'font-size .1s, color .1s' }}>
                    {n}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: ratingTouchedIds[se.exerciseId] ? DANGER : TXT3, marginTop: 8, lineHeight: 1.5 }}>{RATING_HINT}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Нижняя панель — та же, что на экране тренировки: круглая «+» слева,
          главная кнопка градиентом по центру. */}
      <div style={{ padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: SURF2, flexShrink: 0 }}>
        <button data-testid="constructor-add" onClick={() => setPickOpen(true)}
          style={{ width: 42, height: 42, borderRadius: '50%', border: `2px solid ${HAIR}`, background: 'none', color: TXT3, fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
        <button data-testid="constructor-finish" onClick={handleFinish} disabled={finishing || !sessionExercises.length}
          style={{ padding: '12px 36px', borderRadius: 16, border: 'none', background: GRADIENT_PRIMARY, color: TXT, fontSize: 16, fontWeight: 800, cursor: finishing || !sessionExercises.length ? 'default' : 'pointer', opacity: finishing || !sessionExercises.length ? 0.5 : 1, boxShadow: SHADOW_PRIMARY }}>
          Завершить
        </button>
        <div style={{ width: 42 }} />
      </div>

      {/* Пикер упражнений — каталог приложения (EXERCISES), поиск + фильтр по
          группе мышц. Свободного ввода названия здесь больше нет. */}
      {pickOpen && (
        <div data-testid="constructor-picker" style={{ position: 'absolute', inset: 0, background: BG, zIndex: 200, display: 'flex', flexDirection: 'column' }}>
          <div style={{ background: SURF, padding: '14px 18px 12px', borderBottom: `1px solid ${HAIR}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: TXT }}>Каталог упражнений</span>
              <button data-testid="constructor-picker-close" onClick={() => { setPickOpen(false); setPickQuery(''); setPickGroup(null) }}
                style={{ background: 'none', border: 'none', color: TXT3, fontSize: 20, cursor: 'pointer', padding: 0, minHeight: 'unset' }}><GlassIcon name="close" size={26} /></button>
            </div>
            <input data-testid="constructor-search" value={pickQuery} onChange={e => setPickQuery(e.target.value)} placeholder="Поиск по названию..."
              style={{ width: '100%', padding: '10px 12px', fontSize: 14, borderRadius: 12, border: `1.5px solid ${HAIR}`, background: SURF2, color: TXT, boxSizing: 'border-box', outline: 'none' }} />
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 10, paddingBottom: 2 }}>
              {[null, ...groups].map(g => {
                const active = pickGroup === g
                return (
                  <button key={g || 'all'} data-testid={`constructor-group-${g || 'all'}`} onClick={() => setPickGroup(g)}
                    style={{ padding: '7px 13px', fontSize: 12, fontWeight: 600, borderRadius: 16, whiteSpace: 'nowrap', cursor: 'pointer', border: `1px solid ${active ? PUR : HAIR}`, background: active ? PUR : SURF2, color: active ? TXT : TXT2 }}>
                    {g === null ? 'Все' : (GROUP_LABELS[g] || g)}
                  </button>
                )
              })}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {catalogMatches.length === 0 && legacyMatches.length === 0 && (
              <div style={{ textAlign: 'center', color: TXT3, marginTop: 40, fontSize: 13 }}>Ничего не найдено</div>
            )}
            {catalogMatches.map(ex => {
              const personal = findByCatalogName(ex.n, exercises)
              const already = personal && sessionExercises.some(se => se.exerciseId === personal.id)
              const creating = addingName === ex.n
              const profile = exerciseProfile(ex.n)
              return (
                <button key={`c-${ex.n}`} data-testid="constructor-cat-item" onClick={() => !already && !creating && selectCatalogExercise(ex)} disabled={already || creating}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', padding: '13px 18px', background: 'none', border: 'none', borderBottom: `1px solid ${SEP}`, cursor: already || creating ? 'default' : 'pointer', textAlign: 'left', opacity: already ? 0.4 : creating ? 0.5 : 1 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: TXT }}>{ex.n}</div>
                    <div style={{ fontSize: 11, color: TXT3, marginTop: 2 }}>
                      {ex.m}{ex.eq ? ` · ${ex.eq}` : ''}{profile.oneSided ? ' · одностороннее' : ''}
                    </div>
                  </div>
                  {creating ? <span style={{ color: TXT3, fontSize: 18 }}>…</span> : <GlassIcon name={already ? 'check' : 'plus'} size={20} />}
                </button>
              )
            })}
            {legacyMatches.length > 0 && (
              <div style={{ padding: '14px 18px 6px', fontSize: 10, color: TXT3, textTransform: 'uppercase', letterSpacing: 1 }}>Раньше добавлено вручную</div>
            )}
            {legacyMatches.map(ex => {
              const already = sessionExercises.some(se => se.exerciseId === ex.id)
              return (
                <button key={`o-${ex.id}`} data-testid="constructor-legacy-item" onClick={() => !already && addExerciseToSession(ex)} disabled={already}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '13px 18px', background: 'none', border: 'none', borderBottom: `1px solid ${SEP}`, cursor: already ? 'default' : 'pointer', textAlign: 'left', opacity: already ? 0.4 : 1 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: TXT }}>{ex.name}</div>
                    <div style={{ fontSize: 11, color: TXT3, marginTop: 2 }}>Не из каталога — тип упражнения неизвестен</div>
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
        <div style={{ position: 'fixed', inset: 0, background: SCRIM, zIndex: 2200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setShowInfo(false)}>
          {/* Плашка была светлой — единственное белое пятно во всём тёмном
              приложении. Теперь обычная тёмная карточка, как остальные модалки. */}
          <div data-testid="constructor-info-modal" style={{ background: SURF, borderRadius: 16, padding: '22px 20px', maxWidth: 380, width: '100%', boxSizing: 'border-box', boxShadow: SHADOW_MODAL }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: TXT }}>{CONSTRUCTOR_INFO_TEXT.title}</span>
              <button onClick={() => setShowInfo(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: TXT3, lineHeight: 1, padding: 0 }}><GlassIcon name="close" size={26} /></button>
            </div>
            <div style={{ fontSize: 13.5, color: TXT2, lineHeight: 1.65, whiteSpace: 'pre-wrap', marginBottom: 14 }}>{CONSTRUCTOR_INFO_TEXT.body}</div>
            <button onClick={() => setInfoWhyOpen(v => !v)} style={{ background: 'none', border: 'none', color: PUR, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: infoWhyOpen ? 8 : 14, display: 'flex', alignItems: 'center', gap: 4 }}>
              Почему это работает {infoWhyOpen ? '▲' : '▼'}
            </button>
            {infoWhyOpen && <div style={{ fontSize: 12.5, color: TXT3, lineHeight: 1.6, marginBottom: 14 }}>{CONSTRUCTOR_INFO_TEXT.why}</div>}
            <div style={{ fontSize: 12, color: PUR, fontWeight: 600, background: `${PUR}1a`, borderRadius: 12, padding: '10px 12px', lineHeight: 1.5 }}>{CONSTRUCTOR_INFO_TEXT.mandatory}</div>
          </div>
        </div>
      )}

      {/* Тост "меньше 3 подходов" — ненавязчивый, не блокирует сохранение */}
      {fewSetsToast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', background: SURF, border: `1px solid ${HAIR}`, color: TXT, fontSize: 13, padding: '10px 18px', borderRadius: 20, boxShadow: SHADOW_POPUP, zIndex: 2300, whiteSpace: 'nowrap' }}>
          Рекомендуем хотя бы 3 подхода
        </div>
      )}
    </div>
  , document.body)
}
