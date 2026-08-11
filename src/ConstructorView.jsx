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
  BG, SURF, SURF2, SEP, HAIR, TXT, TXT2, TXT3, PUR, TEA, DANGER,
  SCRIM, SCRIM_STRONG, SHADOW_POPUP, SHADOW_MODAL, SHADOW_PRIMARY, GRADIENT_PRIMARY,
  HEADER_MUTED, HEADER_BTN, TIMER_DIGITS, ON_TEA, SUCCESS, DONE_TXT, DONE_BG, DONE_BORDER,
  GRADIENT_BADGE, SHADOW_RATING,
} from './theme.js'

// Подписи групп мышц для фильтра каталога — ключи те же, что отдаёт
// muscleGroup (exerciseMeta.js), плюс 'other' для упражнений, которым
// эвристика группу не назначила (см. catalogGroup).
const GROUP_LABELS = {
  legs: 'Ноги', back: 'Спина', chest: 'Грудь', shoulders: 'Плечи',
  arms: 'Руки', abs: 'Пресс', cardio: 'Кардио', [CATALOG_OTHER_GROUP]: 'Другое',
}

const CONSTRUCTOR_INFO_TEXT = {
  title: 'Как это работает',
  body: 'Выбери упражнения из каталога — по названию или через фильтр по группе мышц. После каждого отметь вес, повторы и оценку усилия. В следующий раз ассистент подскажет рабочий вес и число повторений для прогресса.\n\nПервая тренировка каждого упражнения — стартовый замер: веса задаёшь ты. Дальше рекомендации считает ассистент.\n\nОдносторонние упражнения (выпады, работа одной ногой или рукой) идут по своей схеме — 2 подхода вместо 4. Тип упражнения ассистент берёт из каталога, вручную его указывать не нужно.\n\nСовет: первыми лучше ставить базовые упражнения.',
  why: 'Мышцы растут от постепенного увеличения нагрузки и работы близко к отказу. Ассистент рассчитывает прогрессию по твоим оценкам усилия — вес и повторы подбираются автоматически от тренировки к тренировке.',
  mandatory: 'Оценка усилия обязательна — без неё ассистент не сможет подобрать следующий вес.',
}

// Конструктор — ОТДЕЛЬНЫЙ экран, повторяющий по устройству рабочий экран
// "Начать тренировку" (WorkoutsView, ветка step==='active', см. src/App.jsx),
// но не переиспользующий его компонент и не модифицирующий его. Это
// сознательное дублирование разметки: рабочая тренировка не должна зависеть
// от конструктора и наоборот, чтобы правки одного не могли сломать другое.
//
// Что у эталона есть, а здесь сознательно НЕТ (этап 1.6, полная таблица
// сверки — в отчёте к коммиту):
//   * карандаш-заметка к подходу — в constructor_sets нет колонки note,
//     добавить её значит менять схему прода, а это не этап про механику;
//   * кнопка «отправить видео тренеру» и «Отчёт тренеру» в нижней панели —
//     экран пока открыт только тренеру, слать отчёт самому себе некому;
//     вернуться к обеим на этапе 3, когда экран откроют клиентам;
//   * «Свернуть» в окне выхода — у конструктора нет фонового режима: экран
//     размонтируется при уходе, и «свернуть» означало бы потерю черновика,
//     поэтому вместо неё «Завершить»;
//   * рекомендация под первым замером — её ещё неоткуда взять, истории нет.
// Всё остальное (шапка, секундомер, карточки, сетка подходов, «реком. X кг»,
// оценка на подход, done-состояние, комментарий, выбор даты) сделано так же.
export default function ConstructorView({ userId, sessionMeta, onClearSessionMeta, onWorkoutComplete, setNav }) {
  const [exercises, setExercises] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fitpro_constructor_exercises') || '[]') } catch { return [] }
  })
  // sets: [{kg,reps,recKg,rating}] — та же форма, что у подходов на экране
  // тренировки по шаблону (WorkoutsView), включая оценку НА ПОДХОД: в
  // constructor_sets колонка rating и так на строку-подход, формат записи не
  // меняется, просто перестала дублироваться одним значением на всё упражнение.
  const [sessionExercises, setSessionExercises] = useState([]) // [{exerciseId,name,profile,isBaseline,phase,isDeload,done,sets}]
  const [ratingTouched, setRatingTouched] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [pickGroup, setPickGroup] = useState(null) // ключ группы мышц или null = все
  const [addingName, setAddingName] = useState(null) // название, по которому сейчас создаётся личная запись
  const [showInfo, setShowInfo] = useState(false)
  const [infoWhyOpen, setInfoWhyOpen] = useState(false)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [saveDate, setSaveDate] = useState(() => sessionMeta?.date || new Date().toISOString().slice(0, 10))
  const [comment, setComment] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [fewSetsToast, setFewSetsToast] = useState(false)
  const [resetConfirmId, setResetConfirmId] = useState(null)

  // Время сессии и секундомер — считаются ОТ ОТМЕТКИ ВРЕМЕНИ (Date.now()), а
  // не прибавлением +1 в setInterval: ровно та же модель, что на экране
  // тренировки по шаблону. Прежний +1 в интервале отставал бы от реальности,
  // как только вкладку уводят в фон (iOS душит фоновые таймеры) — интервал
  // ниже нужен лишь для перерисовки раз в секунду, а не для накопления.
  const [startedAt] = useState(() => Date.now())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [swAccumMs, setSwAccumMs] = useState(0)
  const [swStartedAt, setSwStartedAt] = useState(null)
  const swRunning = swStartedAt != null
  const swTime = Math.floor((swAccumMs + (swStartedAt ? Math.max(0, nowTick - swStartedAt) : 0)) / 1000)
  const timer = Math.max(0, Math.floor((nowTick - startedAt) / 1000))
  const toggleStopwatch = () => {
    if (swStartedAt != null) { setSwAccumMs(a => a + Math.max(0, Date.now() - swStartedAt)); setSwStartedAt(null) }
    else setSwStartedAt(Date.now())
  }
  const resetStopwatch = () => { setSwStartedAt(null); setSwAccumMs(0) }

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

  // Один тик в секунду на весь экран — перерисовать время сессии и секундомер.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // В конструктор входят кнопкой в САМОМ НИЗУ списка программ, то есть страница
  // к этому моменту промотана — и шапка экрана оказывалась за верхней границей
  // окна. Экран тренировки такого не показывает (в него входят из портала, где
  // прокрутки нет), поэтому при открытии возвращаем прокрутку наверх: и саму
  // страницу, и контейнер-скроллер, если экран лежит внутри него.
  const rootRef = useRef(null)
  useEffect(() => {
    window.scrollTo(0, 0)
    for (let el = rootRef.current?.parentElement; el; el = el.parentElement) {
      if (el.scrollTop > 0) el.scrollTop = 0
    }
  }, [])

  const fmt = s => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  // Тоннаж завершённого упражнения — та же формула, что на экране тренировки
  // по шаблону (exTonnage в WorkoutsView): показывается в сводке, в расчёт
  // прогрессии не участвует (там всё считается от 1ПМ).
  const exTonnage = se => se.sets.reduce((sum, s) => sum + (parseFloat(s.kg) || 0) * (parseInt(s.reps) || 0), 0)

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
    const emptySets = () => Array.from({ length: baselineSetCount(profile.oneSided) }, () => ({ kg: '', reps: '', recKg: '', rating: '' }))
    const { data, error } = await supabase.from('constructor_sets').select('*').eq('exercise_id', ex.id).eq('user_id', userId).order('id')
    if (error) { console.error('Конструктор: ошибка загрузки истории упражнения:', error); return { profile, isBaseline: true, phase: null, isDeload: false, sets: emptySets() } }
    const history = data || []
    const sessions = buildConstructorSessions(history)
    const scheme = getUpcomingScheme(sessions, { oneSided: profile.oneSided })
    if (scheme.isBaseline || !sessions.length) return { profile, isBaseline: true, phase: null, isDeload: false, sets: emptySets() }
    const lastSession = sessions[sessions.length - 1]
    const anchorSet = lastSession.workingSets[lastSession.workingSets.length - 1]
    const hard = hasHardStreak(sessions)
    // recKg — та же величина, что подставлена в поле веса, но сохранённая
    // отдельно: поле клиент правит под себя, а подпись «реком. X кг» под
    // строкой остаётся и показывает, что именно советовал движок (ровно как на
    // экране тренировки по шаблону). Расчёт не меняется — значение то же самое.
    const sets = scheme.reps.map(reps => {
      const target = hard
        ? computeHardStreakTarget(anchorSet, reps)
        : computeTargetWeight(anchorSet, lastSession.effRatings, reps, null)
      const kg = target?.kg != null ? String(target.kg) : ''
      return { kg, reps: String(reps), recKg: kg, rating: '' }
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
      se.exerciseId === ex.exerciseId ? { ...se, profile, isBaseline, phase, isDeload, done: false, sets } : se
    ))
  }

  const addExerciseToSession = async (ex) => {
    setPickOpen(false); setPickQuery(''); setPickGroup(null)
    if (sessionExercises.some(se => se.exerciseId === ex.id)) return
    const { profile, isBaseline, phase, isDeload, sets } = await fetchRecommendationFor(ex)
    setSessionExercises(list => [...list, {
      exerciseId: ex.id, name: ex.name, profile, isBaseline, phase, isDeload, done: false, sets,
    }])
  }

  const removeSessionExercise = exerciseId => setSessionExercises(list => list.filter(se => se.exerciseId !== exerciseId))
  const setExerciseDone = (exerciseId, done) => setSessionExercises(list => list.map(se => se.exerciseId === exerciseId ? { ...se, done } : se))

  // Оценка нагрузки — НА ПОДХОД и только под рабочими подходами (последние до
  // двух), ровно как на экране тренировки по шаблону. Именно эти подходы и
  // читает движок (buildExerciseAggregates, workingCount = min(2, число
  // подходов дня)) — остальные для расчёта разминочные, их оценка не нужна.
  const isWorkingSetIndex = (setIdx, totalSets) => setIdx >= totalSets - Math.min(2, totalSets)
  const updateSetRating = (exerciseId, setIdx, value) => setSessionExercises(list => list.map(se => {
    if (se.exerciseId !== exerciseId) return se
    return { ...se, sets: se.sets.map((s, i) => i === setIdx ? { ...s, rating: s.rating === value ? '' : value } : s) }
  }))

  const addSetToExercise = exerciseId => setSessionExercises(list => list.map(se => {
    if (se.exerciseId !== exerciseId) return se
    const last = se.sets[se.sets.length - 1]
    return { ...se, sets: [...se.sets, { kg: last?.kg ?? '', reps: last?.reps ?? '', recKg: '', rating: '' }] }
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
    const sessionDate = saveDate || sessionMeta?.date || new Date().toISOString().slice(0, 10)

    // 1) Прогрессия — по одной строке constructor_sets на КАЖДЫЙ подход (не
    // на упражнение), чтобы движок видел день целиком и сам определил
    // рабочие подходы (см. buildExerciseAggregates). Оценка берётся с самого
    // подхода; rating в БД NOT NULL — разминочным подходам без своей оценки
    // подставляем 3 (тот же дефолт, что и у движка для пропущенной оценки),
    // движок их всё равно не читает, это чисто ограничение схемы.
    for (const se of sessionExercises) {
      const total = se.sets.length
      for (let si = 0; si < total; si++) {
        const s = se.sets[si]
        const kg = s.kg === '' ? null : Number(s.kg)
        const rating = isWorkingSetIndex(si, total) && s.rating ? Number(s.rating) : 3
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
        exercises: sessionExercises.map(se => ({
          n: se.name, m: se.profile?.muscle || '', eq: se.profile?.equipment || '',
          sets: se.sets.map(s => ({
            kg: s.kg === '' ? null : Number(s.kg), reps: Number(s.reps) || 0,
            rating: s.rating ? Number(s.rating) : null,
          })),
          done: true,
        })),
        duration: swTime,
        date: new Date(sessionDate + 'T12:00:00').toISOString(),
        comment,
      })
    }
    setFinishing(false)
    exitSession()
  }

  // "Завершить" сначала спрашивает дату — единая точка сохранения, как на
  // экране тренировки по шаблону (openDatePicker → confirmSaveWithDate).
  const openDatePicker = () => {
    if (!sessionExercises.length || finishing) return
    // Оценка обязательна на КАЖДОМ рабочем подходе: без неё движку нечего
    // читать и следующий вес он не посчитает (в шаблонной тренировке оценка
    // не обязательна — там вес на следующий раз есть и из самого шаблона).
    const missing = sessionExercises.some(se => se.sets.some((s, si) => isWorkingSetIndex(si, se.sets.length) && !s.rating))
    if (missing) { setRatingTouched(true); return }
    setShowDatePicker(true)
  }

  const handleFinish = async () => {
    if (!sessionExercises.length || finishing) return
    setShowDatePicker(false)
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

  // Экран НЕ портал: тренировка по шаблону живёт внутри обычного лэйаута
  // приложения, и нижнее меню на ней видно. Портал перекрывал таббар и делал
  // конструктор единственным экраном, из которого «некуда деться» — теперь
  // устройство то же, включая высоту контейнера с поправкой на меню.
  return (
    <div data-testid="constructor-screen" ref={rootRef}
      style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 88px - env(safe-area-inset-bottom, 0px))', background: BG, borderRadius: 14, overflow: 'hidden', color: TXT, position: 'relative' }}>
      {/* Шапка — плита цвета сессии, название и время сессии под ним, справа
          «!» и закрытие. Один в один шапка активной тренировки. */}
      <div style={{ background: sessionColor, padding: '14px 18px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: TXT }}>{sessionName}</div>
            <div data-testid="constructor-session-timer" style={{ fontSize: 14, color: HEADER_MUTED, marginTop: 3 }}>⏱ {fmt(timer)}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginTop: 4 }}>
            <button data-testid="constructor-info" onClick={() => setShowInfo(true)} title="Как это работает"
              style={{ fontSize: 15, fontWeight: 700, color: TXT, background: HEADER_BTN, border: 'none', borderRadius: 6, width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, minHeight: 'unset' }}>?</button>
            <button data-back="1" data-testid="constructor-close" onClick={() => setShowExitConfirm(true)}
              style={{ fontSize: 16, color: TXT, background: HEADER_BTN, border: 'none', borderRadius: 6, width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, minHeight: 'unset' }}><GlassIcon name="close" size={26} /></button>
          </div>
        </div>
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
                <button data-testid="constructor-exit-finish" onClick={() => { setShowExitConfirm(false); openDatePicker() }}
                  style={{ padding: '11px', borderRadius: 10, border: 'none', background: sessionColor, color: TXT, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Завершить</button>
              )}
              <button data-testid="constructor-exit-discard" onClick={exitSession}
                style={{ padding: '11px', borderRadius: 10, border: `1px solid ${HAIR}`, background: 'none', color: DANGER, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Выйти без сохранения</button>
              <button data-testid="constructor-exit-cancel" onClick={() => setShowExitConfirm(false)}
                style={{ padding: '9px', borderRadius: 10, border: 'none', background: 'none', color: TXT3, fontSize: 13, cursor: 'pointer' }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* Выбор даты перед сохранением — единая точка и для «Завершить», и для
          «Завершить» из окошка выхода, как на экране тренировки по шаблону. */}
      {showDatePicker && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', background: SCRIM_STRONG, borderRadius: 14 }}
          onClick={() => setShowDatePicker(false)}>
          <div style={{ background: SURF, borderRadius: 14, padding: '22px 20px', width: 300, boxShadow: SHADOW_MODAL }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, color: TXT, marginBottom: 16, textAlign: 'center' }}>На какую дату сохранить?</div>
            <input data-testid="constructor-save-date" type="date" value={saveDate} onChange={e => setSaveDate(e.target.value)} autoFocus
              style={{ width: '100%', padding: '11px', borderRadius: 10, border: `1px solid ${HAIR}`, background: SURF2, color: TXT, fontSize: 15, colorScheme: 'dark', cursor: 'pointer', outline: 'none', boxSizing: 'border-box', marginBottom: 16, textAlign: 'center' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowDatePicker(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: `1px solid ${HAIR}`, background: 'none', color: TXT3, fontSize: 13, cursor: 'pointer' }}>Отмена</button>
              <button data-testid="constructor-save-confirm" onClick={handleFinish}
                style={{ flex: 1, padding: '10px', borderRadius: 10, border: 'none', background: sessionColor, color: TXT, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 24px' }}>
        {/* Секундомер — компактный липкий бар вверху прокрутки, как на экране
            тренировки по шаблону: отдельной большой карточки здесь больше нет.
            Отрицательные margin + top:-14 «выпускают» бар в padding контейнера,
            сплошной фон BG перекрывает уезжающий под него контент. */}
        <div style={{ position: 'sticky', top: -14, zIndex: 20, margin: '-14px -18px 12px', padding: '14px 18px 0', background: BG }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: SURF, border: `1px solid ${HAIR}`, borderRadius: 16, padding: '8px 12px' }}>
            <span data-testid="constructor-sw-time" style={{ fontSize: 22, fontWeight: 800, letterSpacing: '.02em', fontVariantNumeric: 'tabular-nums', color: TIMER_DIGITS, marginRight: 'auto' }}>⏱ {fmt(swTime)}</span>
            <button data-testid="constructor-sw-toggle" onClick={toggleStopwatch}
              style={{ padding: '8px 20px', borderRadius: 12, border: 'none', background: swRunning ? SURF2 : TEA, color: swRunning ? TXT2 : ON_TEA, fontSize: 13, fontWeight: 700, cursor: 'pointer', minHeight: 'unset' }}>
              {swRunning ? '⏸ Стоп' : '▶ Старт'}
            </button>
            <button data-testid="constructor-sw-reset" onClick={resetStopwatch}
              style={{ padding: '8px 14px', borderRadius: 12, border: `1px solid ${HAIR}`, background: SURF2, color: TXT2, fontSize: 14, cursor: 'pointer', minHeight: 'unset' }}>↺</button>
          </div>
        </div>

        {/* Упражнения сессии — карточки того же вида, что на экране тренировки
            по шаблону: SURF, радиус 20, рамка HAIR, номер-бейдж, название 16/700. */}
        {sessionExercises.length === 0 ? (
          <div style={{ textAlign: 'center', marginTop: 40 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: TXT, marginBottom: 8 }}>Тренировка началась</div>
            <div style={{ fontSize: 14, color: TXT3, lineHeight: 1.7 }}>Нажми «+», чтобы добавить упражнения.</div>
          </div>
        ) : sessionExercises.map((se, ei) => (
          <div key={se.exerciseId} data-testid="constructor-ex-card"
            style={{ marginBottom: 14, background: se.done ? DONE_BG : SURF, borderRadius: 20, padding: '12px 14px', border: se.done ? `1px solid ${DONE_BORDER}` : `1px solid ${HAIR}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                <span style={{ width: 30, height: 30, borderRadius: 10, background: GRADIENT_BADGE, color: TXT, fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{ei + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: se.done ? DONE_TXT : TXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{se.name}</div>
                  {/* Тип упражнения — из каталога, клиент его не задаёт. Та же
                      строка и та же типографика, что у ExMeta на экране
                      тренировки по шаблону. */}
                  <div style={{ fontSize: 12, color: TXT2, marginTop: 2 }}>
                    {se.profile?.fromCatalog
                      ? [se.profile.muscle, se.profile.equipment].filter(Boolean).join(' · ')
                      : 'Добавлено вручную раньше — тип упражнения неизвестен'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {se.done && <span style={{ fontSize: 11, color: DONE_TXT, display: 'inline-flex', alignItems: 'center', gap: 4 }}><GlassIcon name="check" size={13} />Выполнено</span>}
                {!se.isBaseline && !se.done && (
                  <button data-testid="constructor-ex-reset" onClick={() => setResetConfirmId(se.exerciseId)}
                    title="Начать заново — сбросить историю этого упражнения"
                    style={{ width: 26, height: 26, borderRadius: 6, border: 'none', background: SURF2, color: TXT3, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>↺</button>
                )}
                <button data-testid="constructor-ex-remove" onClick={() => removeSessionExercise(se.exerciseId)}
                  style={{ width: 26, height: 26, borderRadius: 6, border: 'none', background: SURF2, color: TXT3, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>🗑</button>
              </div>
            </div>
            {se.profile?.oneSided && !se.done && (
              <div style={{ fontSize: 10, color: TXT3, marginTop: -4, marginBottom: 8 }}>
                Повторения считаются суммарно на обе стороны
              </div>
            )}
            {se.isBaseline && !se.done && (
              <div style={{ fontSize: 12.5, color: TXT3, marginTop: -4, marginBottom: 8 }}>
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

            {se.done ? (
              /* Завершённое упражнение сворачивается в сводку с тоннажем и
                 кнопкой «↩ Редактировать» — как на экране тренировки по
                 шаблону. Ни на запись, ни на расчёт флаг не влияет: в
                 constructor_sets всё равно уходят все подходы. */
              <div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  {se.sets.map((s, si) => (s.kg || s.reps) ? (
                    <span key={si} style={{ fontSize: 11, color: TXT3 }}>
                      {si + 1}. {s.kg || '—'} кг × {s.reps || '—'}{se.profile?.oneSided ? '+' : ''}
                    </span>
                  ) : null)}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: DONE_TXT }}>Тоннаж: {exTonnage(se)} кг</div>
                <button data-testid="constructor-ex-edit" onClick={() => setExerciseDone(se.exerciseId, false)}
                  style={{ marginTop: 6, fontSize: 11, color: TXT3, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  ↩ Редактировать
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr 20px', gap: 5, marginBottom: 5 }}>
                  {['#', 'КГ', 'ПОВТ', ''].map((h, i) => (
                    <span key={i} style={{ fontSize: 11, fontWeight: 700, color: TXT2, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</span>
                  ))}
                </div>
                {se.sets.map((s, si) => (
                  <div key={si} style={{ marginBottom: 5 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr 20px', gap: 5, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: TXT3, textAlign: 'center', fontWeight: 700 }}>{si + 1}</span>
                      {/* Поля веса/повторов — ровно те же, что на экране тренировки
                          по шаблону (см. set-kg/set-reps в WorkoutsView). */}
                      <input data-testid="constructor-kg" type="number" inputMode="decimal" value={s.kg} onChange={e => updateSetField(se.exerciseId, si, 'kg', e.target.value)} placeholder="0"
                        style={{ width: '100%', background: SURF2, border: `1.5px solid ${HAIR}`, borderRadius: 12, padding: '6px 6px', fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: TXT, textAlign: 'center', boxSizing: 'border-box' }} />
                      <div style={{ position: 'relative', width: '100%' }}>
                        <input data-testid="constructor-reps" type="number" inputMode="numeric" value={s.reps} onChange={e => updateSetField(se.exerciseId, si, 'reps', e.target.value)} placeholder="0"
                          style={{ width: '100%', background: SURF2, border: `1.5px solid ${HAIR}`, borderRadius: 12, padding: '6px 6px', fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: TXT, textAlign: 'center', boxSizing: 'border-box' }} />
                        {se.profile?.oneSided && (
                          <span title="Повторения считаются суммарно на обе стороны"
                            style={{ position: 'absolute', top: -8, right: -8, width: 17, height: 17, borderRadius: '50%', background: PUR, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: TXT, lineHeight: 1 }}>+</span>
                        )}
                      </div>
                      <button data-testid="constructor-set-remove" onClick={() => removeSetFromExercise(se.exerciseId, si)} disabled={se.sets.length <= 1}
                        style={{ background: 'none', border: 'none', color: TXT3, opacity: se.sets.length <= 1 ? 0.35 : 1, cursor: se.sets.length <= 1 ? 'default' : 'pointer', fontSize: 14, textAlign: 'center', padding: 0 }}><GlassIcon name="close" size={26} /></button>
                    </div>
                    {/* Рекомендация движка — отдельной подписью под строкой, а не
                        только подставленным числом в поле: поле клиент правит под
                        себя, а совет должен остаться виден. Как «реком. X кг» на
                        экране тренировки по шаблону. */}
                    {s.recKg && (
                      <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr 20px', gap: 5 }}>
                        <span />
                        <span data-testid="constructor-rec" style={{ fontSize: 11, color: PUR, textAlign: 'center', marginTop: 2 }}>реком. {s.recKg} кг</span>
                      </div>
                    )}
                    {/* Оценка нагрузки — под рабочими подходами, тот же блок, что
                        на экране тренировки по шаблону: заголовок, квадраты 44×44,
                        подписи «легко»/«на пределе». */}
                    {isWorkingSetIndex(si, se.sets.length) && (
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 6, paddingLeft: 29 }}>
                        <span style={{ fontSize: 11, color: ratingTouched && !s.rating ? DANGER : TXT3, flexShrink: 0 }}>Оценка нагрузки</span>
                        <div style={{ display: 'flex', gap: 3 }}>
                          {[1, 2, 3, 4, 5].map(n => (
                            <div key={n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                              <button data-testid={`constructor-rating-${n}`}
                                onClick={() => { updateSetRating(se.exerciseId, si, n); setRatingTouched(false) }}
                                title={n === 1 ? '1 — совсем легко' : n === 5 ? '5 — на пределе' : String(n)}
                                style={{ width: 44, height: 44, borderRadius: 12, cursor: 'pointer', padding: 0,
                                  background: s.rating === n ? PUR : SURF2,
                                  border: s.rating === n ? `1px solid ${PUR}` : `1px solid ${HAIR}`,
                                  boxShadow: s.rating === n ? SHADOW_RATING : 'none',
                                  fontSize: 15, fontWeight: 800, lineHeight: 1,
                                  color: s.rating === n ? TXT : TXT2, transition: 'background .1s, box-shadow .1s' }}>
                                {n}
                              </button>
                              <span style={{ fontSize: 11, color: TXT3, marginTop: 2, minHeight: 13, whiteSpace: 'nowrap' }}>
                                {n === 1 ? 'легко' : n === 5 ? 'на пределе' : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <button data-testid="constructor-add-set" onClick={() => addSetToExercise(se.exerciseId)}
                    style={{ fontSize: 12, color: sessionColor, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}>
                    + Подход
                  </button>
                  <button data-testid="constructor-ex-done" onClick={() => setExerciseDone(se.exerciseId, true)}
                    style={{ fontSize: 12, color: TXT, background: SUCCESS, border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <GlassIcon name="check" size={14} />Завершить упражнение
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        {/* Комментарий к тренировке — в конце прокрутки, как на экране
            тренировки по шаблону; уходит в дневник вместе с сессией. */}
        <div style={{ marginTop: 14 }}>
          <textarea data-testid="constructor-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="💬 Комментарий к тренировке..." rows={2}
            style={{ width: '100%', background: SURF, border: `1px solid ${HAIR}`, borderRadius: 16, padding: '10px 12px', fontSize: 13, color: TXT, resize: 'none', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', lineHeight: 1.5 }} />
        </div>
      </div>

      {/* Нижняя панель — та же, что на экране тренировки: круглая «+» слева,
          главная кнопка градиентом по центру. */}
      <div style={{ padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: SURF2, flexShrink: 0 }}>
        <button data-testid="constructor-add" onClick={() => setPickOpen(true)}
          style={{ width: 42, height: 42, borderRadius: '50%', border: `2px solid ${HAIR}`, background: 'none', color: TXT3, fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
        <button data-testid="constructor-finish" onClick={openDatePicker} disabled={finishing || !sessionExercises.length}
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
  )
}
