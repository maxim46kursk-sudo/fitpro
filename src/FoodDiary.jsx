// Дневник питания — весь раздел «Питание» целиком (шапка, календарь, сводки,
// приёмы пищи, добавление продукта, сканер).
//
// Зачем отдельный файл: раздел жил внутри DiaryView в App.jsx и разросся до
// трёхсот с лишним строк разметки плюс своё состояние, эффекты и работа с
// Supabase. App.jsx не раздуваем — это правило проекта, по нему уже выехали
// TrainerSession.jsx, AIAssistant.jsx и BarcodeScanner.jsx. DiaryView теперь
// рендерит <FoodDiary …> и про еду больше ничего не знает.
//
// Экран дня устроен как в привычных дневниках питания: сверху сводка «съедено
// из нормы», ниже — четыре приёма пищи (завтрак/обед/ужин/перекус), в каждый
// добавляется отдельно. Записи, сделанные до появления приёмов, собираются в
// пятую секцию «Без категории» — они не теряются и переносятся руками.

import { useState, useEffect, useMemo, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './supabase.js'
import { resolveLoadOutcome, LOAD_OUTCOME } from './authState.js'
import { GlassIcon } from './glassIcons'
import { Ic } from './icons.jsx'
import MacroInputs from './MacroInputs.jsx'
import {
  CAL_MIN, CAL_MAX, MACRO_MIN, MACRO_MAX, clampNum,
  buildFoodEntry, scaleProduct, clampGrams,
  GRAMS_DEFAULT, GRAMS_MIN, GRAMS_MAX,
} from './nutrition.js'
import {
  MEALS, MEAL_ICONS, NO_MEAL, NO_MEAL_LABEL, mealLabel,
  groupByMeal, sumEntries, remainingOf, overBy, pctOf, recentProducts, moveEntry,
  scaleEntryByPortions, clampPortions, PORTIONS_DEFAULT, PORTIONS_MIN, PORTIONS_MAX,
  shiftISO,
} from './foodMeals.js'
import {
  DAY, GOALS, SUMMARY, initialStack, currentScreen, currentDate, currentMonth,
  pushScreen, replaceTop, popScreen, canGoBack, monthTotals,
} from './foodNav.js'

// Сканер — лениво, как и раньше: внутри него декодер @zxing, которому нечего
// делать в основном бандле.
const BarcodeScanner = lazy(() => import('./BarcodeScanner.jsx'))

// Те же токены тёмной темы, что в App.jsx. Скопированы, а не импортированы:
// App.jsx импортирует этот файл, обратный импорт замкнул бы зависимость в
// кольцо. Тот же приём в TrainerSession.jsx, AIAssistant.jsx, BarcodeScanner.jsx.
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
const BLU = '#0A84FF'
const COR = '#FF9F0A'
const KCAL = '#BF5AF2'

// Подвал «нет нужного» — три кнопки в родном стиле приложения: ровно те же
// размеры и цвета, что у табов режимов в калькуляторе 1ПМ (App.jsx, tabBtn).
// Без иконок и эмодзи: табы в приложении текстовые, это и есть фирменный вид.
//
// Отдельным компонентом, а не переменной в теле FoodDiary: он рисуется в двух
// местах — в конце списка и под «не нашли», — и общий компонент гарантирует,
// что они не разъедутся при следующей правке.
function FooterActions({ onScan, onPhoto, onManual }) {
  // flex:1 у каждой: на 320px под кнопку остаётся ~91px, «Штрих-код» кеглем
  // 12.5 занимает около 62 — переноса нет с запасом.
  const tabBtn = {
    flex: 1, padding: '10px 6px', borderRadius: 9, border: 'none',
    background: SURF2, color: TXT3, fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer', minHeight: 'unset',
  }
  return (
    <>
      <div style={{ height: 1, background: HAIR, margin: '12px 0' }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onScan} style={tabBtn}>Штрих-код</button>
        <button onClick={onPhoto} style={tabBtn}>Фото</button>
        <button onClick={onManual} style={tabBtn}>Вручную</button>
      </div>
    </>
  )
}

// Копия Card из App.jsx — по той же причине, что и токены выше.
function Card({ children, style = {}, onClick }) {
  return (
    <div onClick={onClick} style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 20, padding: '14px 16px', ...style }}>
      {children}
    </div>
  )
}

const isoOf = d => {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Задержка перед запросом поиска. 300 мс — примерно пауза между словами:
// набор «творог» не превращается в шесть запросов подряд.
const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN_LEN = 2

export default function FoodDiary({ userId, readOnly = false, readOnlyName = '', onClose, embedded = false, headerLeft = null }) {
  // ── Состояние дневника (перенесено из DiaryView без изменений)
  // Инициализация из localStorage-кэша — мгновенный показ до ответа сети
  // (полная загрузка из Supabase ниже перезатирает это, как только придёт
  // ответ; кэш — только для первого кадра, не источник правды).
  const [foodDiary, setFoodDiary] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}') } catch { return {} }
  })
  // Стек экранов раздела. В основании всегда день; поверх ложатся «Норма» и
  // «Сводка», а из календаря сводки — ещё один день. «Назад» = снять верхний.
  const [stack, setStack] = useState(() => initialStack(isoOf(new Date())))
  const screen = currentScreen(stack)
  const foodDate = currentDate(stack)
  // Какой месяц подгружать для чисел в календаре: тот, что листают в «Сводке»,
  // а если она не открыта — месяц выбранного дня (данные пригодятся, когда её
  // откроют, и нужны недельной сводке).
  const loadMonth = useMemo(() => {
    const inSummary = currentMonth(stack)
    if (inSummary) return inSummary
    const [y, m] = (foodDate || '').split('-').map(Number)
    return { y, m: m - 1 }
  }, [stack, foodDate])
  const [editingFoodId, setEditingFoodId] = useState(null)
  const [editFoodForm, setEditFoodForm] = useState({ name: '', kcal: '', p: '', c: '', f: '', items: [] })
  const [openFoodMenu, setOpenFoodMenu] = useState(null)
  // Меню записи переключается в режим выбора приёма — «Перенести в другой
  // приём» показывает те же четыре пункта вместо Редактировать/Удалить.
  const [movingFoodId, setMovingFoodId] = useState(null)
  // Меню шестерёнки — оверлей, в стек «назад» НЕ входит: закрывается тапом
  // мимо, как и меню записи.
  const [gearOpen, setGearOpen] = useState(false)
  // Тост ошибки записи в дневник/нормы — addFood/removeFood/saveEditFood/
  // сохранение нормы падают в Supabase молча, тот же паттерн, что и у своих
  // упражнений.
  const [showFoodSaveError, setShowFoodSaveError] = useState(false)
  const flashFoodSaveError = () => { setShowFoodSaveError(true); setTimeout(() => setShowFoodSaveError(false), 3500) }
  const [foodGoals, setFoodGoals] = useState({ kcal: 2000, p: 150, c: 200, f: 60 })
  const [goalsForm, setGoalsForm] = useState(foodGoals)
  const [foodLoading, setFoodLoading] = useState(false)
  const [foodLoadError, setFoodLoadError] = useState(false)
  const [foodReloadToken, setFoodReloadToken] = useState(0)

  // ── Состояние добавления
  // Открытый лист добавления: ключ приёма или null. Он же говорит, в какой
  // приём попадёт всё, что человек оттуда добавит.
  const [sheetMeal, setSheetMeal] = useState(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)   // null — ещё не искали
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)
  // Выбранный из поиска/недавних продукт → экран порции внутри листа.
  // { kind:'product'|'recent', data, } — у первого граммы, у второго порции.
  const [picked, setPicked] = useState(null)
  const [grams, setGrams] = useState(String(GRAMS_DEFAULT))
  const [portions, setPortions] = useState(String(PORTIONS_DEFAULT))
  // Ручная форма внутри листа.
  const [manualOpen, setManualOpen] = useState(false)
  const [foodForm, setFoodForm] = useState({ name: '', kcal: '', p: '', c: '', f: '' })
  const [showScanner, setShowScanner] = useState(false)

  // ── Переходы между экранами
  const goBack = () => {
    if (canGoBack(stack)) setStack(popScreen(stack))
    else onClose?.()
  }
  const openGoals = () => { setGearOpen(false); setGoalsForm(foodGoals); setStack(st => pushScreen(st, { type: GOALS })) }
  const openSummary = () => {
    setGearOpen(false)
    const [y, m] = foodDate.split('-').map(Number)
    setStack(st => pushScreen(st, { type: SUMMARY, tab: 'week', month: { y, m: m - 1 } }))
  }
  // Стрелки даты и «Сегодня» ЗАМЕНЯЮТ верхний экран, а не добавляют новый:
  // иначе после десяти нажатий «‹» пришлось бы десять раз жать «назад».
  const setDate = date => setStack(st => replaceTop(st, { date }))
  const todayISO = isoOf(new Date())

  const closeSheet = () => {
    setSheetMeal(null); setQuery(''); setSearchResults(null); setSearchError(null)
    setPicked(null); setManualOpen(false); setFoodForm({ name: '', kcal: '', p: '', c: '', f: '' })
  }

  // ── Загрузка (перенесено без изменений)
  // Полная загрузка при входе: Supabase — единственный источник правды. При
  // КАЖДОМ входе вся история питания перечитывается по user_id и ПОЛНОСТЬЮ
  // заменяет локальное состояние. Без этого после logout (который чистит
  // fitpro_food_diary) экран долго оставался бы пустым.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setFoodLoading(true)
    setFoodLoadError(false)
    supabase.from('food_diary').select('*').eq('user_id', userId).order('created_at')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error('Ошибка полной загрузки дневника питания:', error)
          setFoodLoadError(true); setFoodLoading(false)
          return
        }
        const byDate = {}
        for (const r of (data || [])) {
          const entry = { id: r.id, name: r.name, kcal: String(r.kcal || 0), p: String(r.p || 0), c: String(r.c || 0), f: String(r.f || 0), meal: r.meal || null }
          ;(byDate[r.date] ??= []).push(entry)
        }
        setFoodDiary(byDate)
        if (!readOnly) localStorage.setItem('fitpro_food_diary', JSON.stringify(byDate))
        setFoodLoading(false)
      })
    return () => { cancelled = true }
  }, [userId, foodReloadToken, readOnly])

  // Загрузка при смене даты
  useEffect(() => {
    if (!userId) {
      setFoodDiary(d => ({ ...d, ...(() => { try { return JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}') } catch { return {} } })() }))
      return
    }
    let cancelled = false
    supabase.from('food_diary').select('*').eq('user_id', userId).eq('date', foodDate).order('created_at')
      .then(({ data, error }) => {
        if (cancelled) return
        // Упавший запрос раньше превращался в `(data || [])` → пустой день,
        // который ЕЩЁ И уезжал в localStorage, затирая кэш. Теперь при ошибке
        // не трогаем ни state, ни кэш — показываем баннер с «Повторить».
        // Пустой массив от сервера (день реально пуст) по-прежнему применяется.
        if (resolveLoadOutcome({ data, error }) === LOAD_OUTCOME.FAILED) {
          console.error('Ошибка загрузки дня дневника питания:', error)
          setFoodLoadError(true)
          return
        }
        const entries = data.map(r => ({ id: r.id, name: r.name, kcal: String(r.kcal || 0), p: String(r.p || 0), c: String(r.c || 0), f: String(r.f || 0), meal: r.meal || null }))
        setFoodDiary(d => {
          const updated = { ...d, [foodDate]: entries }
          if (!readOnly) {
            const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), [foodDate]: entries }
            localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
          }
          return updated
        })
      })
    return () => { cancelled = true }
  }, [foodDate, userId, readOnly, foodReloadToken])

  // Загрузка за весь видимый месяц (для чисел в календаре)
  useEffect(() => {
    if (!userId) return
    const { y, m } = loadMonth
    const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const lastDay = new Date(y, m + 1, 0).getDate()
    const monthEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    let cancelled = false
    supabase.from('food_diary').select('*').eq('user_id', userId).gte('date', monthStart).lte('date', monthEnd).order('created_at')
      .then(({ data, error }) => {
        if (cancelled) return
        // См. комментарий в загрузке дня выше: ошибка не должна выглядеть как
        // «в этом месяце ничего не ели» и не должна затирать кэш календаря.
        if (resolveLoadOutcome({ data, error }) === LOAD_OUTCOME.FAILED) {
          console.error('Ошибка загрузки месяца дневника питания:', error)
          setFoodLoadError(true)
          return
        }
        const byDate = {}
        for (const r of data) {
          const entry = { id: r.id, name: r.name, kcal: String(r.kcal || 0), p: String(r.p || 0), c: String(r.c || 0), f: String(r.f || 0), meal: r.meal || null }
          if (!byDate[r.date]) byDate[r.date] = []
          byDate[r.date].push(entry)
        }
        setFoodDiary(d => {
          const updated = { ...d, ...byDate }
          if (!readOnly) {
            const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), ...byDate }
            localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
          }
          return updated
        })
      })
    return () => { cancelled = true }
    // Зависимости — ПОЛЯ loadMonth, а не сам объект: useMemo отдаёт новую
    // ссылку при каждом изменении стека, и эффект перезапрашивал бы месяц на
    // каждое нажатие стрелки даты.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMonth.y, loadMonth.m, userId, readOnly, foodReloadToken])

  // Нормы КБЖУ
  useEffect(() => {
    if (!userId) {
      const g = JSON.parse(localStorage.getItem('fitpro_food_goals') || '{"kcal":2000,"p":150,"c":200,"f":60}')
      setFoodGoals(g); setGoalsForm(g); return
    }
    supabase.from('food_goals').select('*').eq('user_id', userId).maybeSingle()
      .then(({ data }) => {
        if (data) {
          const g = { kcal: data.kcal || 2000, p: data.p || 150, c: data.c || 200, f: data.f || 60 }
          setFoodGoals(g); setGoalsForm(g)
          if (!readOnly) localStorage.setItem('fitpro_food_goals', JSON.stringify(g))
        }
      })
  }, [userId, readOnly])

  useEffect(() => {
    const handler = () => {
      if (!userId) {
        setFoodDiary(JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'))
        return
      }
      supabase.from('food_diary').select('*').eq('user_id', userId).eq('date', foodDate).order('created_at')
        .then(({ data, error }) => {
          // Перечитывание после записи. Ошибка тут особенно опасна: запись уже
          // легла в базу, а пустой ответ стёр бы её и из state, и из кэша —
          // выглядело бы как «еда не сохранилась».
          if (resolveLoadOutcome({ data, error }) === LOAD_OUTCOME.FAILED) {
            console.error('Ошибка обновления дня дневника питания:', error)
            setFoodLoadError(true)
            return
          }
          const entries = data.map(r => ({ id: r.id, name: r.name, kcal: String(r.kcal || 0), p: String(r.p || 0), c: String(r.c || 0), f: String(r.f || 0), meal: r.meal || null }))
          setFoodDiary(d => {
            const updated = { ...d, [foodDate]: entries }
            if (!readOnly) {
              const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), [foodDate]: entries }
              localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
            }
            return updated
          })
        })
    }
    window.addEventListener('fitpro:diary-update', handler)
    return () => window.removeEventListener('fitpro:diary-update', handler)
  }, [userId, foodDate, readOnly])

  // Через useMemo, а не `foodDiary[foodDate] || []` на месте: пустой литерал
  // создаёт НОВЫЙ массив на каждый рендер, и мемоизация группировки ниже
  // никогда бы не срабатывала — считали бы приёмы заново по десять раз на
  // каждое нажатие в поле поиска.
  const dayEntries = useMemo(() => foodDiary[foodDate] || [], [foodDiary, foodDate])
  const dayTotal = useMemo(() => sumEntries(dayEntries), [dayEntries])
  const grouped = useMemo(() => groupByMeal(dayEntries), [dayEntries])

  // ── Запись в дневник
  // Единственный путь добавления. Без аргументов берёт то, что набрано в
  // ручной форме; с аргументом — готовую запись от поиска, недавних или
  // сканера. Логика сохранения (Supabase + localStorage + разбор ошибки)
  // остаётся в одном месте, иначе две копии разъедутся на первой же правке.
  const addFood = async (external, meal = null) => {
    if (readOnly) return
    const src = external || foodForm
    if (!String(src.name || '').trim()) return
    const kcal = clampNum(src.kcal, CAL_MIN, CAL_MAX)
    const p = clampNum(src.p, MACRO_MIN, MACRO_MAX)
    const c = clampNum(src.c, MACRO_MIN, MACRO_MAX)
    const f = clampNum(src.f, MACRO_MIN, MACRO_MAX)
    let entry = { id: Date.now(), ...src, kcal, p, c, f, meal }
    if (userId) {
      const { data, error } = await supabase.from('food_diary').insert({
        user_id: userId, date: foodDate, name: src.name,
        kcal, p, c, f, meal,
      }).select().single()
      if (error) { console.error('Ошибка записи в дневник питания:', error); flashFoodSaveError(); return }
      entry = { ...entry, id: data.id }
    }
    setFoodDiary(d => {
      const updated = { ...d, [foodDate]: [...(d[foodDate] || []), entry] }
      const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), [foodDate]: updated[foodDate] }
      localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
      return updated
    })
    if (!external) setFoodForm({ name: '', kcal: '', p: '', c: '', f: '' })
  }

  const removeFood = async (id) => {
    if (readOnly) return
    if (userId) {
      const { error } = await supabase.from('food_diary').delete().eq('id', id)
      if (error) { console.error('Ошибка удаления записи дневника питания:', error); flashFoodSaveError(); return }
    }
    setFoodDiary(d => {
      const updated = { ...d, [foodDate]: (d[foodDate] || []).filter(e => e.id !== id) }
      const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), [foodDate]: updated[foodDate] }
      localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
      return updated
    })
  }

  // Перенос записи в другой приём. Меняется ровно одно поле — числа и название
  // остаются как были.
  const moveFood = async (id, meal) => {
    if (readOnly) return
    if (userId) {
      const { error } = await supabase.from('food_diary').update({ meal }).eq('id', id)
      if (error) { console.error('Ошибка переноса записи в другой приём:', error); flashFoodSaveError(); return }
    }
    setFoodDiary(d => {
      const updated = { ...d, [foodDate]: moveEntry(d[foodDate], id, meal) }
      const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), [foodDate]: updated[foodDate] }
      localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
      return updated
    })
  }

  const startEditFood = (e) => { setEditFoodForm({ name: e.name, kcal: e.kcal || '', p: e.p || '', c: e.c || '', f: e.f || '', items: e.items || [] }); setEditingFoodId(e.id) }

  const saveEditFood = async () => {
    if (readOnly) return
    if (!editFoodForm.name.trim()) return
    const kcal = clampNum(editFoodForm.kcal, CAL_MIN, CAL_MAX)
    const p = clampNum(editFoodForm.p, MACRO_MIN, MACRO_MAX)
    const c = clampNum(editFoodForm.c, MACRO_MIN, MACRO_MAX)
    const f = clampNum(editFoodForm.f, MACRO_MIN, MACRO_MAX)
    if (userId) {
      // meal не трогаем: правка чисел не должна переносить запись между
      // приёмами, для этого есть отдельный пункт меню.
      const { error } = await supabase.from('food_diary').update({
        name: editFoodForm.name, kcal, p, c, f,
      }).eq('id', editingFoodId)
      if (error) { console.error('Ошибка сохранения правки записи дневника питания:', error); flashFoodSaveError(); return }
    }
    setFoodDiary(d => {
      const updated = { ...d, [foodDate]: (d[foodDate] || []).map(e => e.id === editingFoodId ? { ...e, ...editFoodForm, kcal, p, c, f } : e) }
      const all = { ...JSON.parse(localStorage.getItem('fitpro_food_diary') || '{}'), [foodDate]: updated[foodDate] }
      localStorage.setItem('fitpro_food_diary', JSON.stringify(all))
      return updated
    })
    setEditingFoodId(null)
  }

  // ── Недавние: считаются из уже загруженного дневника, без похода в сеть.
  const recents = useMemo(
    () => recentProducts(foodDiary, { today: foodDate }),
    [foodDiary, foodDate],
  )

  // ── Поиск по общему справочнику
  // Сброс при коротком запросе делает сам обработчик ввода, а не эффект:
  // синхронный setState в теле эффекта — лишний каскад рендеров (и ровно то,
  // на что ругается react-hooks/set-state-in-effect). Здесь же и «Ищу…»
  // зажигается ПОСЛЕ дебаунса, а не на каждой букве — иначе надпись мигала бы
  // при наборе, ничего не сообщая.
  const onQueryChange = v => {
    setQuery(v)
    if (v.trim().length < SEARCH_MIN_LEN) { setSearchResults(null); setSearchError(null); setSearching(false) }
  }

  useEffect(() => {
    const q = query.trim()
    if (q.length < SEARCH_MIN_LEN) return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      setSearching(true)
      try {
        const res = await fetch(`/api/set-exercise?action=food-search&q=${encodeURIComponent(q)}`)
        if (cancelled) return
        if (!res.ok) { setSearchError('Поиск временно недоступен'); setSearchResults([]); return }
        const json = await res.json()
        if (cancelled) return
        setSearchError(null)
        setSearchResults(Array.isArray(json?.results) ? json.results : [])
      } catch {
        if (!cancelled) { setSearchError('Нет связи. Проверь интернет'); setSearchResults([]) }
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  // ── Производные для сводки
  const selDate = new Date(foodDate + 'T00:00:00')
  const dow = selDate.getDay()
  const weekStart = new Date(selDate); weekStart.setDate(selDate.getDate() - (dow === 0 ? 6 : dow - 1))
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i)
    const iso = isoOf(d)
    const entries = foodDiary[iso] || []
    return { iso, d, entries, tot: sumEntries(entries) }
  })
  const weekTotal = weekDays.reduce((a, d) => ({ kcal: a.kcal + d.tot.kcal, p: a.p + d.tot.p, c: a.c + d.tot.c, f: a.f + d.tot.f }), { kcal: 0, p: 0, c: 0, f: 0 })
  const hasGoal = foodGoals.kcal > 0

  // ── Стили
  const inputStyle = { width: '100%', padding: '11px 13px', fontSize: 15, borderRadius: 10, border: `1.5px solid ${HAIR}`, outline: 'none', boxSizing: 'border-box', color: TXT, background: SURF2 }
  const sheetBtn = { width: '100%', padding: '12px', borderRadius: 12, border: `1px solid ${HAIR}`, background: SURF2, color: TXT, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 'unset', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
  // Строка списка. Компактная намеренно: на 320px с открытой клавиатурой под
  // список остаётся ~200px, и каждый лишний пиксель строки — это минус целый
  // результат на экране.
  const rowStyle = { background: SURF, border: `1px solid ${HAIR}`, borderRadius: 10, padding: '6px 11px', marginBottom: 4, cursor: 'pointer' }

  // Назад по одному шагу. Порция → результаты (запрос НЕ сбрасываем: человек
  // возвращается к той же выдаче), ручная форма → поиск, поиск → день.
  const sheetBack = () => {
    if (picked) setPicked(null)
    else if (manualOpen) setManualOpen(false)
    else closeSheet()
  }

  // Подвал рисуется в двух местах — в конце списка и под «не нашли».
  // Именно в конце и внутри прокрутки: постоянный подвал поверх списка съедал
  // бы те же строки результатов, ради которых экран и переделывался.
  const footer = (
    <FooterActions
      onScan={() => setShowScanner(true)}
      onPhoto={() => setShowScanner(true)}
      onManual={() => setManualOpen(true)} />
  )

  const sectionTitle = own => (readOnly && readOnlyName ? `${readOnlyName} · ${own}` : own)

  // ── Экран порции внутри листа (общий для поиска и недавних)
  const gramsClamped = clampGrams(grams)
  const portionsClamped = clampPortions(portions)
  const pickedScaled = picked?.kind === 'product'
    ? scaleProduct(picked.data, gramsClamped)
    : picked ? (() => { const s = scaleEntryByPortions(picked.data, portionsClamped); return { kcal: s.kcal, p: s.p, c: s.c, f: s.f } })() : null

  const confirmPicked = async () => {
    if (!picked) return
    const meal = sheetMeal
    const entry = picked.kind === 'product'
      ? buildFoodEntry(picked.data, gramsClamped)
      : scaleEntryByPortions(picked.data, portionsClamped)
    closeSheet()
    await addFood(entry, meal)
  }

  const pickProduct = (p) => { setPicked({ kind: 'product', data: p }); setGrams(String(GRAMS_DEFAULT)) }
  const pickRecent = (r) => { setPicked({ kind: 'recent', data: r }); setPortions(String(PORTIONS_DEFAULT)) }

  const num = v => (v === null || v === undefined ? '—' : String(v))

  // ПОРТАЛ ТОЛЬКО В ОВЕРЛЕЙНОМ РЕЖИМЕ. Вынос в document.body был нужен, пока
  // раздел открывался поверх Дневника: так он гарантированно ложился выше
  // любых родительских контекстов наложения. Встроенный в свою вкладку
  // дневник, наоборот, ОБЯЗАН рендериться на месте — иначе он уезжает из
  // потока вкладки в конец body, обёртка схлопывается в нулевую высоту, а сам
  // экран оказывается ниже видимой области.
  const tree = (
    // embedded — дневник живёт ВНУТРИ вкладки «Питание» и обязан оставить
    // место нижнему меню. position:fixed/inset:0/zIndex:1000 подходил, пока
    // раздел открывался поверх Дневника; как главный экран вкладки он
    // накрывал нижнее меню (zIndex 900) целиком, и уйти из вкладки было
    // нельзя — она превращалась в ловушку.
    <div style={embedded
      ? { background: BG, display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 190px)' }
      : { position: 'fixed', inset: 0, background: BG, zIndex: 1000, display: 'flex', flexDirection: 'column' }}>
      {/* Тост ошибки записи — операция упала в Supabase, локально ничего не менялось. */}
      {showFoodSaveError && (
        <div style={{
          position: 'fixed', top: 14, left: '50%', transform: 'translateX(-50%)',
          zIndex: 2200, padding: '10px 18px', borderRadius: 24, maxWidth: 320, textAlign: 'center',
          background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700,
          boxShadow: '0 6px 20px rgba(220,38,38,0.35)',
        }}>
          Не удалось сохранить — проверь связь и повтори
        </div>
      )}

      {/* Шапка. Кнопка «назад» одна на все экраны раздела: снимает верхний
          экран стека, а из основания закрывает раздел целиком. */}
      <div style={{ background: SURF, borderBottom: `1px solid ${HAIR}`, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {/* Кнопку рисуем, только когда ей есть куда вести: со дня (основание
            стека) без onClose уходить некуда — дневник теперь сам является
            главным экраном вкладки «Питание», а не подразделом. Молчащая
            стрелка в шапке была бы ровно тем, что мы вычищаем по всему
            приложению. */}
        {(stack.length > 1 || onClose) && (
          <button data-back="1" onClick={goBack} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: TXT3, lineHeight: 1, padding: 0, minHeight: 'unset' }}><GlassIcon name="back" size={26} /></button>
        )}
        {/* Во встроенном режиме на экране дня заголовок не рисуем: он повторял
            бы название вкладки. Его место занимает переключатель разделов
            (headerLeft) — шапка остаётся ОДНА, а не два яруса подряд.
            На подэкранах («Норма», «Сводка») заголовок нужен: там он
            единственное, что говорит, где ты находишься. */}
        {embedded && screen.type === DAY && headerLeft
          ? <div style={{ flex: 1, minWidth: 0 }}>{headerLeft}</div>
          : (
            <span style={{ fontSize: 17, fontWeight: 700, color: TXT, flex: 1 }}>
              {screen.type === GOALS ? 'Норма' : screen.type === SUMMARY ? sectionTitle('Сводка') : sectionTitle('Питание')}
            </span>
          )}
        {/* Шестерёнка только на экране дня: на подэкранах ей некуда вести. */}
        {!readOnly && screen.type === DAY && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {/* 44x44 — минимальная площадь нажатия, как у прочих кнопок
                действий в приложении. Иконка была 26 и рядом с соседними
                выглядела недоделанной. */}
            <button data-testid="food-gear" onClick={() => setGearOpen(o => !o)} aria-label="Настройки питания"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: TXT3, padding: 0, width: 44, height: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
              <GlassIcon name="gear" size={34} />
            </button>
            {gearOpen && (
              <>
                <div onClick={() => setGearOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
                <div onClick={ev => ev.stopPropagation()} style={{ position: 'absolute', top: 32, right: 0, background: SURF, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,0.35)', zIndex: 51, minWidth: 170, overflow: 'hidden', border: `1px solid ${HAIR}` }}>
                  <button data-testid="food-goals" onClick={openGoals} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 15px', border: 'none', borderBottom: `1px solid ${HAIR}`, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: TXT, fontSize: 13 }}>
                    <GlassIcon name="target" size={20} />Норма
                  </button>
                  <button data-testid="food-summary" onClick={openSummary} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 15px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: TXT, fontSize: 13 }}>
                    <GlassIcon name="chart" size={20} />Сводка
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div style={embedded
        ? { padding: '14px 16px 32px' }
        : { flex: 1, overflowY: 'auto', padding: '14px 16px 32px' }}>

        {/* ── Экран «Норма» */}
        {screen.type === GOALS && (
          <>
        {/* Настройка норм */}
        {(
          <Card style={{ marginBottom: 14, background: SURF, border: `1.5px solid ${PUR}33` }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: TXT, marginBottom: 10 }}>Дневная норма</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
              {[['ккал', 'kcal', KCAL], ['Белки г', 'p', TEA], ['Углев. г', 'c', BLU], ['Жиры г', 'f', COR]].map(([pl, k, c]) => (
                <div key={k}>
                  <div style={{ fontSize: 9, color: TXT3, marginBottom: 3, textAlign: 'center' }}>{pl}</div>
                  <input type="number" min={k === 'kcal' ? CAL_MIN : MACRO_MIN} max={k === 'kcal' ? CAL_MAX : MACRO_MAX} value={goalsForm[k]} onChange={e => setGoalsForm(f => ({ ...f, [k]: +e.target.value || 0 }))}
                    style={{ width: '100%', padding: '8px 4px', fontSize: 14, fontWeight: 700, borderRadius: 16, border: `1.5px solid ${c}55`, outline: 'none', boxSizing: 'border-box', color: c, background: SURF2, textAlign: 'center' }}
                    onFocus={e => e.target.style.borderColor = c} onBlur={e => e.target.style.borderColor = `${c}55`} />
                </div>
              ))}
            </div>
            <button onClick={async () => {
              if (readOnly) return
              const clampedGoals = {
                kcal: clampNum(goalsForm.kcal, CAL_MIN, CAL_MAX),
                p: clampNum(goalsForm.p, MACRO_MIN, MACRO_MAX),
                c: clampNum(goalsForm.c, MACRO_MIN, MACRO_MAX),
                f: clampNum(goalsForm.f, MACRO_MIN, MACRO_MAX),
              }
              if (userId) {
                const { error } = await supabase.from('food_goals').upsert({ user_id: userId, ...clampedGoals, updated_at: new Date().toISOString() })
                if (error) { console.error('Ошибка сохранения нормы КБЖУ:', error); flashFoodSaveError(); return }
              }
              setFoodGoals(clampedGoals); goBack()
              localStorage.setItem('fitpro_food_goals', JSON.stringify(clampedGoals))
            }}
              style={{ width: '100%', padding: '12px', borderRadius: 16, border: 'none', background: `linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color: '#fff', fontSize: 14, fontWeight: 800, cursor: 'pointer', minHeight: 'unset', boxShadow: '0 10px 26px rgba(124,122,240,.4)' }}>
              Сохранить
            </button>
          </Card>
        )}
          </>
        )}

        {/* ── Экран «Сводка»: две вкладки */}
        {screen.type === SUMMARY && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {[['week', 'Неделя'], ['month', 'Месяц']].map(([k, label]) => (
                <button key={k} onClick={() => setStack(st => replaceTop(st, { tab: k }))}
                  style={{ flex: 1, padding: '10px 6px', borderRadius: 9, border: 'none', background: screen.tab === k ? PUR : SURF2, color: screen.tab === k ? '#fff' : TXT3, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }}>
                  {label}
                </button>
              ))}
            </div>
        {screen.tab === 'week' && (
        <Card style={{ marginBottom: 14, background: SURF, border: `1px solid ${HAIR}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: TXT, marginBottom: 4 }}>Сводка за неделю</div>
          <div style={{ fontSize: 11, color: TXT3, marginBottom: 12 }}>
            {weekStart.toLocaleDateString('ru', { day: 'numeric', month: 'short' })} — {weekDays[6].d.toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
          {/* Факт за неделю относительно недельной нормы (foodGoals.X*7).
              Перебор — заливка полная, а число процентов показывает реальное
              значение. Норма не задана — столбик пустой, только факт. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
            {[['fluent-emoji-flat:fire', weekTotal.kcal, foodGoals.kcal * 7, '', 'ккал', 'linear-gradient(180deg,#d07bff,#BF5AF2)', '#d79bff'], ['fluent-emoji-flat:cut-of-meat', weekTotal.p, foodGoals.p * 7, 'г', 'белки', 'linear-gradient(180deg,#4ce07a,#30D158)', '#5be389'], ['fluent-emoji-flat:cooked-rice', weekTotal.c, foodGoals.c * 7, 'г', 'углев.', 'linear-gradient(180deg,#3f9bff,#0A84FF)', '#5aa8ff'], ['fluent-emoji-flat:avocado', weekTotal.f, foodGoals.f * 7, 'г', 'жиры', 'linear-gradient(180deg,#ffb54a,#FF9F0A)', '#ffbf5a']].map(([ic, fact, norm7, unit, label, grad, factColor]) => {
              const pct = norm7 > 0 ? Math.round(fact / norm7 * 100) : 0
              const fillH = Math.min(100, pct)
              return (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 2 }}><Ic name={ic} size={36} /></div>
                  <div style={{ fontSize: 10, color: TXT3, marginBottom: 5, minHeight: 12 }}>{norm7 > 0 ? `из ${norm7}${unit}` : ''}</div>
                  <div style={{ width: 34, height: 96, background: 'rgba(255,255,255,.07)', borderRadius: 9, position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: `${fillH}%`, background: grad, borderRadius: '9px 9px 0 0' }} />
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: factColor, marginTop: 5 }}>{fact}{unit}</div>
                  <div style={{ fontSize: 10, color: TXT3, minHeight: 12 }}>{norm7 > 0 ? `${pct}%` : ''}</div>
                  <div style={{ fontSize: 10, color: TXT3 }}>{label}</div>
                </div>
              )
            })}
          </div>
        </Card>
            )}
        {screen.tab === 'month' && (() => {
          const { y, m } = screen.month
          const first = new Date(y, m, 1)
          const startDow = (first.getDay() + 6) % 7 // Пн=0
          const daysInMonth = new Date(y, m + 1, 0).getDate()
          const MONTH_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
          const DAY_HEADS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
          const todayISO = isoOf(new Date())
          // Суммы по дням — чистой функцией (foodNav.monthTotals), чтобы их
          // можно было проверить тестом, а не только глазами в календаре.
          const totals = monthTotals(foodDiary, y, m)
          const cells = []
          for (let i = 0; i < startDow; i++) cells.push(null)
          for (let d = 1; d <= daysInMonth; d++) cells.push(d)
          while (cells.length % 7 !== 0) cells.push(null)
          return (
            <div style={{ background: SURF, borderRadius: 20, boxShadow: '0 4px 24px rgba(0,0,0,0.35)', border: `1px solid ${HAIR}`, padding: '16px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <button onClick={() => setStack(st => replaceTop(st, { month: m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 } }))}
                  style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: TXT3, minHeight: 'unset', padding: '0 6px' }}>‹</button>
                <span style={{ fontSize: 15, fontWeight: 700, color: TXT }}>{MONTH_RU[m]} {y}</span>
                <button onClick={() => setStack(st => replaceTop(st, { month: m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 } }))}
                  style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: TXT3, minHeight: 'unset', padding: '0 6px' }}>›</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 4 }}>
                {DAY_HEADS.map(h => (
                  <div key={h} style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: TXT3, padding: '2px 0' }}>{h}</div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
                {cells.map((d, ci) => {
                  if (!d) return <div key={ci} />
                  const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
                  const kcal = totals[iso] || 0
                  const hasData = kcal > 0
                  const isSel = iso === foodDate
                  const isToday = iso === todayISO
                  return (
                    <div key={ci} onClick={() => setStack(st => pushScreen(st, { type: DAY, date: iso }))}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 12, padding: '5px 2px', minHeight: 44,
                        background: isSel ? PUR : hasData ? SURF2 : isToday ? `${PUR}18` : 'transparent',
                        border: isToday && !isSel ? `1px solid ${PUR}40` : '1px solid transparent',
                      }}>
                      <span style={{ fontSize: 13, fontWeight: isSel || isToday ? 700 : 400, color: isSel ? '#fff' : isToday ? PUR : TXT2, lineHeight: 1.4 }}>{d}</span>
                      {hasData && (
                        <span style={{ fontSize: 8, fontWeight: 600, color: isSel ? 'rgba(255,255,255,0.85)' : TXT3, lineHeight: 1.2, marginTop: 1, textAlign: 'center' }}>
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
          </>
        )}

        {/* ── Экран дня */}
        {screen.type === DAY && (
          <>
        {/* ── Сводка дня */}
        <Card style={{ marginBottom: 14, background: 'linear-gradient(150deg,#241f3a,#151519)', border: `1px solid ${HAIR}`, borderRadius: 22 }}>
          {/* Переключатель даты. Стрелки и «Сегодня» ЗАМЕНЯЮТ верхний экран
              стека, а не добавляют новый: листание дней не должно копиться в
              кнопке «назад». */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: TXT, flex: 1 }}>Итого за день</span>
            <button onClick={() => setDate(shiftISO(foodDate, -1))} aria-label="Предыдущий день"
              style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: TXT3, padding: '0 6px', minHeight: 'unset', lineHeight: 1 }}>‹</button>
            <span style={{ fontSize: 12, fontWeight: 700, color: TXT, minWidth: 62, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {selDate.toLocaleDateString('ru', { day: 'numeric', month: 'short' })}
            </span>
            <button onClick={() => setDate(shiftISO(foodDate, 1))} aria-label="Следующий день"
              style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: TXT3, padding: '0 6px', minHeight: 'unset', lineHeight: 1 }}>›</button>
            {/* «Сегодня» появляется только когда мы не на сегодняшнем дне —
                иначе это кнопка, которая ничего не делает. */}
            {foodDate !== todayISO && (
              <button onClick={() => setDate(todayISO)}
                style={{ background: SURF2, border: 'none', borderRadius: 8, padding: '4px 9px', fontSize: 11, fontWeight: 600, color: PUR, cursor: 'pointer', minHeight: 'unset' }}>
                Сегодня
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: TXT, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{dayTotal.kcal}</div>
            {hasGoal
              ? <div style={{ fontSize: 18, fontWeight: 700, color: TXT3, paddingBottom: 4 }}>из {foodGoals.kcal} ккал</div>
              : <div style={{ fontSize: 18, fontWeight: 700, color: TXT3, paddingBottom: 4 }}>ккал</div>}
            {foodLoading && dayEntries.length === 0 ? (
              <div style={{ fontSize: 11, color: TXT3, paddingBottom: 4 }}>загрузка…</div>
            ) : foodLoadError ? (
              <div style={{ fontSize: 11, color: COR, paddingBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                не удалось загрузить
                <button onClick={() => setFoodReloadToken(t => t + 1)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, border: 'none', background: COR, color: '#fff', cursor: 'pointer', fontWeight: 600, minHeight: 'unset' }}>Повторить</button>
              </div>
            ) : null}
          </div>

          {/* Остаток или перебор — одной строкой, крупно. Норма не задана —
              вместо остатка ссылка на экран норм: без неё «осталось» не из
              чего считать, а промолчать значило бы спрятать настройку. */}
          {hasGoal ? (
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: overBy(dayTotal.kcal, foodGoals.kcal) > 0 ? COR : TEA }}>
              {overBy(dayTotal.kcal, foodGoals.kcal) > 0
                ? `перебор ${overBy(dayTotal.kcal, foodGoals.kcal)} ккал`
                : `осталось ${remainingOf(dayTotal.kcal, foodGoals.kcal)} ккал`}
            </div>
          ) : !readOnly && (
            <button onClick={openGoals}
              style={{ background: 'none', border: 'none', color: PUR, fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: 12, minHeight: 'unset' }}>
              Задать норму
            </button>
          )}

          <div style={{ height: 10, background: 'rgba(255,255,255,.10)', borderRadius: 6, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ height: '100%', width: `${pctOf(dayTotal.kcal, foodGoals.kcal)}%`, background: `linear-gradient(90deg, ${KCAL}, #e07bff)`, borderRadius: 6, transition: 'width 0.3s' }} />
          </div>

          {/* Три тонкие шкалы Б/У/Ж */}
          {[['Белки', 'p', TEA], ['Углеводы', 'c', BLU], ['Жиры', 'f', COR]].map(([l, k, c]) => {
            const ov = overBy(dayTotal[k], foodGoals[k])
            return (
              <div key={k} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ color: TXT2, fontWeight: 600 }}>{l}</span>
                  <span style={{ fontWeight: 700, color: c }}>{Math.round(dayTotal[k])} г</span>
                  <span style={{ flex: 1 }} />
                  {foodGoals[k] > 0 && (ov > 0
                    ? <span style={{ fontSize: 11, color: COR }}>+{ov} г перебор</span>
                    : <span style={{ fontSize: 11, color: TXT3 }}>осталось {remainingOf(dayTotal[k], foodGoals[k])} г</span>)}
                  {foodGoals[k] > 0 && <span style={{ fontSize: 11, color: TXT3 }}>/ {foodGoals[k]} г</span>}
                </div>
                <div style={{ height: 7, background: 'rgba(255,255,255,.10)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pctOf(dayTotal[k], foodGoals[k])}%`, background: ov > 0 ? COR : c, borderRadius: 4, transition: 'width 0.3s' }} />
                </div>
              </div>
            )
          })}
        </Card>
        {/* ── Приёмы пищи */}
        {[...MEALS, { key: NO_MEAL, label: NO_MEAL_LABEL }].map(meal => {
          const list = grouped[meal.key] || []
          // «Без категории» показываем только когда там что-то есть: пустая
          // служебная секция с кнопкой «добавить» сбивала бы с толку —
          // добавлять записи «никуда» нельзя и не нужно.
          if (meal.key === NO_MEAL && list.length === 0) return null
          const tot = sumEntries(list)
          return (
            <div key={meal.key} data-testid={`meal-${meal.key}`} style={{ marginBottom: 12 }}>
              {/* Заголовок приёма — той же семьи, что карточки-хабы на других
                  вкладках: крупная иконка и тот же вес шрифта. Сами секции
                  хабами НЕ делаем — внутри списки записей, там важна
                  плотность, а не воздух. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 4px', marginBottom: 7 }}>
                {MEAL_ICONS[meal.key] && <GlassIcon name={MEAL_ICONS[meal.key]} size={28} />}
                <span style={{ fontSize: 17, fontWeight: 700, color: TXT, flex: 1 }}>{meal.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: list.length ? KCAL : TXT3 }}>{Math.round(tot.kcal)} ккал</span>
              </div>

              {list.map(e => (
                <div key={e.id} style={{ background: SURF, borderRadius: 11, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 8, position: 'relative', zIndex: openFoodMenu === e.id ? 50 : 'auto' }}>
                  {editingFoodId === e.id ? (
                    <div style={{ padding: '12px 14px' }}>
                      <input value={editFoodForm.name} onChange={ev => setEditFoodForm(f => ({ ...f, name: ev.target.value }))}
                        style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 8, border: `1.5px solid ${HAIR}`, outline: 'none', boxSizing: 'border-box', color: TXT, marginBottom: 8, background: SURF2 }}
                        onFocus={ev => ev.target.style.borderColor = PUR} onBlur={ev => ev.target.style.borderColor = HAIR} />
                      {editFoodForm.items.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          {editFoodForm.items.map((item, ii) => (
                            <div key={ii} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                              <input value={item} onChange={ev => setEditFoodForm(f => ({ ...f, items: f.items.map((it, idx) => idx === ii ? ev.target.value : it) }))}
                                style={{ flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 7, border: `1px solid ${HAIR}`, outline: 'none', color: TXT2, background: SURF2 }}
                                onFocus={ev => ev.target.style.borderColor = PUR} onBlur={ev => ev.target.style.borderColor = HAIR} />
                              <button onClick={() => setEditFoodForm(f => ({ ...f, items: f.items.filter((_, idx) => idx !== ii) }))}
                                style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: TXT3, padding: '4px', minHeight: 'unset' }}><GlassIcon name="close" size={26} /></button>
                            </div>
                          ))}
                          <button onClick={() => setEditFoodForm(f => ({ ...f, items: [...f.items, ''] }))}
                            style={{ fontSize: 12, color: PUR, border: 'none', background: 'none', cursor: 'pointer', padding: '4px 0', minHeight: 'unset' }}>+ добавить позицию</button>
                        </div>
                      )}
                      <div style={{ marginBottom: 10 }}>
                        <MacroInputs size="sm" values={editFoodForm}
                          onChange={(k, v) => setEditFoodForm(f => ({ ...f, [k]: v }))} />
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button data-testid="food-edit-save" onClick={saveEditFood} style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: PUR, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }}>Сохранить</button>
                        <button onClick={() => setEditingFoodId(null)} style={{ padding: '9px 14px', borderRadius: 8, border: 'none', background: SURF2, color: TXT3, fontSize: 13, cursor: 'pointer', minHeight: 'unset' }}>Отмена</button>
                        <button onClick={() => { removeFood(e.id); setEditingFoodId(null) }} style={{ padding: '9px 14px', borderRadius: 8, border: 'none', background: '#fff5f5', color: '#ef4444', fontSize: 13, cursor: 'pointer', minHeight: 'unset' }}>Удалить</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: '12px 14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: TXT, marginBottom: 2 }}>{e.name}</div>
                          {e.items && e.items.length > 0 && (
                            <div style={{ marginBottom: 6 }}>
                              {e.items.map((item, ii) => (
                                <div key={ii} style={{ fontSize: 12, color: TXT2, lineHeight: 1.5, paddingLeft: 8, borderLeft: `2px solid ${HAIR}`, marginBottom: 1 }}>• {item}</div>
                              ))}
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: TXT3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {e.kcal && <span style={{ color: PUR, fontWeight: 600 }}>{e.kcal} ккал</span>}
                            {e.p && <span>Б: {e.p}г</span>}
                            {e.c && <span>У: {e.c}г</span>}
                            {e.f && <span>Ж: {e.f}г</span>}
                          </div>
                        </div>
                        {!readOnly && <div style={{ position: 'relative', flexShrink: 0 }}>
                          <button data-testid="food-menu" onClick={ev => { ev.stopPropagation(); setOpenFoodMenu(openFoodMenu === e.id ? null : e.id); setMovingFoodId(null); setEditingFoodId(null) }}
                            style={{ background: 'none', border: `1px solid ${HAIR}`, borderRadius: 7, fontSize: 15, cursor: 'pointer', color: TXT3, padding: '2px 7px', minHeight: 'unset', lineHeight: 1.4, letterSpacing: 1 }}>⋯</button>
                          {openFoodMenu === e.id && (
                            <>
                              <div onClick={() => { setOpenFoodMenu(null); setMovingFoodId(null) }} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
                              <div onClick={ev => ev.stopPropagation()} style={{ position: 'absolute', top: 30, right: 0, background: SURF, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,0.14)', zIndex: 51, minWidth: 190, overflow: 'hidden', border: `1px solid ${HAIR}` }}>
                                {movingFoodId === e.id ? (
                                  // Второй уровень того же меню: куда перенести.
                                  // Текущий приём в списке отсутствует — переносить
                                  // запись саму в себя незачем.
                                  [...MEALS, { key: NO_MEAL, label: NO_MEAL_LABEL }]
                                    .filter(m => m.key !== (e.meal || NO_MEAL))
                                    .map(m => (
                                      <button key={m.key} data-testid={`food-move-${m.key}`} onClick={() => { setOpenFoodMenu(null); setMovingFoodId(null); moveFood(e.id, m.key === NO_MEAL ? null : m.key) }}
                                        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 15px', border: 'none', borderBottom: `1px solid ${HAIR}`, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: TXT, fontSize: 13 }}>
                                        {MEAL_ICONS[m.key] ? <GlassIcon name={MEAL_ICONS[m.key]} size={20} /> : <span style={{ width: 20 }} />}{m.label}
                                      </button>
                                    ))
                                ) : (
                                  <>
                                    <button data-testid="food-edit" onClick={() => { setOpenFoodMenu(null); startEditFood(e) }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 15px', border: 'none', borderBottom: `1px solid ${HAIR}`, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: TXT, fontSize: 13 }}>✏️ Редактировать</button>
                                    <button data-testid="food-move-open" onClick={() => setMovingFoodId(e.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 15px', border: 'none', borderBottom: `1px solid ${HAIR}`, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: TXT, fontSize: 13 }}>↔️ Перенести в другой приём</button>
                                    <button data-testid="food-delete" onClick={() => { setOpenFoodMenu(null); removeFood(e.id) }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 15px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: '#ef4444', fontSize: 13 }}>🗑 Удалить</button>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </div>}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* В «Без категории» добавлять нечего — это склад старых записей. */}
              {!readOnly && meal.key !== NO_MEAL && (
                <button data-testid={`meal-add-${meal.key}`} onClick={() => { closeSheet(); setSheetMeal(meal.key) }}
                  style={{ width: '100%', padding: '11px', borderRadius: 12, border: `2px dashed ${PUR}44`, background: 'transparent', color: PUR, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }}>
                  + Добавить
                </button>
              )}
            </div>
          )
        })}
          </>
        )}
      </div>

      {/* ── Экран добавления в приём: ПОЛНОЭКРАННЫЙ, а не полулист.
          Полулист отдавал половину высоты трём большим кнопкам, и на список
          результатов над клавиатурой оставалось полторы строки. Здесь главный
          и единственный герой — поиск: строка ввода сразу под шапкой, всё
          остальное место у списка, а три пути «нет нужного» ужаты в одну
          строку в конце списка и уезжают вместе с ним. */}
      {!readOnly && sheetMeal && (
        <div style={{
          position: 'fixed', left: 0, right: 0, top: 0, bottom: 0,
          // dvh даёт реальную высоту окна на мобильных: с 100% на iOS низ
          // экрана уезжает под панель браузера.
          height: '100dvh', zIndex: 1500,
          background: BG, display: 'flex', flexDirection: 'column',
        }}>
          {/* Шапка ниже общей на 8px и строка поиска плотнее: на 320px с
              открытой клавиатурой под список остаётся около 200px, и эти
              пиксели — это ровно одна лишняя видимая строка результата. */}
          <div style={{ background: SURF, borderBottom: `1px solid ${HAIR}`, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {/* Назад по одному шагу: из порции — к результатам (запрос
                сохраняется), из ручной формы — к поиску, из поиска — в день. */}
            <button data-back="1" onClick={sheetBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: TXT3, padding: 0, minHeight: 'unset', lineHeight: 1 }}>
              <GlassIcon name="back" size={26} />
            </button>
            {/* Иконка приёма — слева, вплотную к заголовку: она поясняет
                именно его («В Завтрак»), а в правом углу читалась как
                отдельная кнопка. */}
            {MEAL_ICONS[sheetMeal] && !picked && !manualOpen && <GlassIcon name={MEAL_ICONS[sheetMeal]} size={20} />}
            <span style={{ fontSize: 17, fontWeight: 700, color: TXT, flex: 1 }}>
              {picked ? 'Порция' : manualOpen ? 'Вручную' : `В ${mealLabel(sheetMeal)}`}
            </span>
          </div>

          {/* Строка поиска — вне прокручиваемой области: она не должна
              уезжать вместе со списком. */}
          {!picked && !manualOpen && (
            <div style={{ padding: '8px 16px 6px', flexShrink: 0, position: 'relative' }}>
              <input
                value={query}
                onChange={e => onQueryChange(e.target.value)}
                placeholder="Найти продукт" data-testid="food-search-input"
                autoFocus
                style={{ ...inputStyle, paddingRight: 46 }}
                onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = HAIR} />
              {/* Сканер живёт прямо в строке поиска — там, где у поля обычно
                  стоит крестик очистки: это второй способ «ввести» продукт,
                  а не отдельный раздел. */}
              <button onClick={() => setShowScanner(true)} aria-label="Сканировать штрих-код"
                style={{ position: 'absolute', right: 22, top: 16, background: 'none', border: 'none', cursor: 'pointer', padding: 4, minHeight: 'unset', lineHeight: 1 }}>
                {/* Моно-глиф штрих-кода, а не иконка видео: у той красное
                    свечение, оно из раздела тренировок и здесь читается как
                    «записать видео». */}
                <GlassIcon name="barcode" size={20} />
              </button>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', padding: picked || manualOpen ? '14px 16px 24px' : '4px 16px 24px', WebkitOverflowScrolling: 'touch' }}>
            {picked ? (
                // ── Экран порции
                <>
                  <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: TXT, marginBottom: 2 }}>{picked.data.name}</div>
                    {picked.kind === 'product' && picked.data.brand && <div style={{ fontSize: 13, color: TXT2, marginBottom: 8 }}>{picked.data.brand}</div>}
                    {picked.kind === 'product' ? (
                      <div style={{ fontSize: 12, color: TXT3 }}>
                        На 100 г: <span style={{ color: KCAL, fontWeight: 700 }}>{num(picked.data.kcal100)} ккал</span>
                        {' · '}Б {num(picked.data.p100)} · У {num(picked.data.c100)} · Ж {num(picked.data.f100)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: TXT3 }}>
                        В прошлый раз: <span style={{ color: KCAL, fontWeight: 700 }}>{picked.data.kcal} ккал</span>
                        {' · '}Б {picked.data.p} · У {picked.data.c} · Ж {picked.data.f}
                      </div>
                    )}
                    {picked.kind === 'product' && picked.data.source === 'ai_estimate' && (
                      <div style={{ fontSize: 11, color: COR, marginTop: 6 }}>≈ примерные значения</div>
                    )}
                    {/* Без «≈» и без тревожного цвета: у этих чисел есть
                        источник, они не прикидка (см. BarcodeScanner). */}
                    {picked.kind === 'product' && picked.data.source === 'ai_web' && (
                      <div style={{ fontSize: 11, color: TXT3, marginTop: 6 }}>По данным карточки магазина</div>
                    )}
                  </div>

                  <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, marginBottom: 6 }}>
                    {picked.kind === 'product' ? 'Вес порции, г' : 'Сколько порций'}
                  </div>
                  <input
                    value={picked.kind === 'product' ? grams : portions}
                    onChange={e => (picked.kind === 'product' ? setGrams : setPortions)(e.target.value)}
                    inputMode="decimal"
                    style={{ ...inputStyle, fontSize: 26, fontWeight: 800, textAlign: 'center', padding: '13px' }}
                    onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = HAIR} />
                  {picked.kind === 'product' && gramsClamped === null && (
                    <div style={{ fontSize: 12, color: COR, marginTop: 6 }}>Укажи вес порции числом (от {GRAMS_MIN} до {GRAMS_MAX} г)</div>
                  )}
                  {picked.kind === 'recent' && portionsClamped === null && (
                    <div style={{ fontSize: 12, color: COR, marginTop: 6 }}>Укажи число порций (от {PORTIONS_MIN} до {PORTIONS_MAX})</div>
                  )}

                  <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '14px 16px', margin: '14px 0' }}>
                    <div style={{ fontSize: 34, fontWeight: 800, color: KCAL, lineHeight: 1, marginBottom: 10 }}>
                      {num(pickedScaled?.kcal)} <span style={{ fontSize: 15, color: TXT3, fontWeight: 700 }}>ккал</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                      {[['Белки', pickedScaled?.p, TEA], ['Углеводы', pickedScaled?.c, BLU], ['Жиры', pickedScaled?.f, COR]].map(([l, v, c]) => (
                        <div key={l} style={{ background: SURF2, borderRadius: 10, padding: '8px 6px', textAlign: 'center' }}>
                          <div style={{ fontSize: 11, color: TXT3, marginBottom: 2 }}>{l}</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: c }}>{num(v)} г</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button onClick={confirmPicked}
                    disabled={picked.kind === 'product' ? gramsClamped === null : portionsClamped === null}
                    style={{
                      width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: PUR, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', minHeight: 'unset',
                      opacity: (picked.kind === 'product' ? gramsClamped === null : portionsClamped === null) ? 0.45 : 1,
                    }}>
                    Добавить в «{mealLabel(sheetMeal)}»
                  </button>
                </>
            ) : manualOpen ? (
                // ── Ручной ввод
                <>
                  <input placeholder="Название *" value={foodForm.name} onChange={e => setFoodForm(f => ({ ...f, name: e.target.value }))}
                    style={{ ...inputStyle, marginBottom: 10 }}
                    onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = HAIR} />
                  <div style={{ marginBottom: 14 }}>
                    <MacroInputs values={foodForm}
                      onChange={(k, v) => setFoodForm(f => ({ ...f, [k]: v }))} />
                  </div>
                  <button onClick={async () => { const meal = sheetMeal; const src = foodForm; closeSheet(); await addFood({ ...src }, meal) }}
                    disabled={!foodForm.name.trim()}
                    style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: PUR, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', minHeight: 'unset', opacity: foodForm.name.trim() ? 1 : 0.45 }}>
                    Добавить в «{mealLabel(sheetMeal)}»
                  </button>
                  <button onClick={() => setManualOpen(false)} style={{ ...sheetBtn, marginTop: 10 }}>Назад к поиску</button>
                </>
            ) : (
              // ── Поиск и недавние
              <>
                {query.trim().length >= SEARCH_MIN_LEN ? (
                  <>
                    {searching && <div style={{ fontSize: 12, color: TXT3, margin: '6px 0 10px' }}>Ищу…</div>}
                    {searchError && <div style={{ fontSize: 12, color: COR, margin: '6px 0 10px' }}>{searchError}</div>}
                    {!searching && !searchError && searchResults && searchResults.length === 0 && (
                      <div style={{ fontSize: 13, color: TXT2, margin: '10px 0 4px' }}>
                        Не нашли — заведи продукт сам, он появится в базе для всех
                      </div>
                    )}
                    {/* key приходит с сервера: у позиции базового справочника
                        нет штрих-кода, а по названию ключ был бы хрупким. */}
                    {(searchResults || []).map(p => (
                      <div key={p.key || p.barcode} onClick={() => pickProduct(p)} style={rowStyle}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: TXT }}>
                          {p.name}
                          {p.brand && <span style={{ color: TXT3, fontWeight: 400 }}> {p.brand}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: TXT3, marginTop: 1 }}>
                          <span style={{ color: KCAL, fontWeight: 600 }}>{num(p.kcal100)} ккал</span>
                          {' · '}Б {num(p.p100)} · У {num(p.c100)} · Ж {num(p.f100)} / 100 г
                          {/* «≈» — ТОЛЬКО у прикидки. Найденное в интернете
                              этим значком не метим: у тех чисел есть источник,
                              и ставить им знак приблизительности значило бы
                              врать в другую сторону. */}
                          {p.source === 'ai_estimate' && <span style={{ color: COR }}> · ≈</span>}
                        </div>
                      </div>
                    ))}
                    {!searching && footer}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, margin: '6px 0 8px' }}>Недавние</div>
                    {recents.length === 0 && (
                      <div style={{ fontSize: 13, color: TXT3, marginBottom: 4 }}>
                        Пока пусто. Найди продукт по названию или отсканируй штрих-код.
                      </div>
                    )}
                    {recents.map(r => (
                      <div key={r.name} onClick={() => pickRecent(r)} style={rowStyle}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: TXT }}>{r.name}</div>
                        <div style={{ fontSize: 11, color: TXT3, marginTop: 1 }}>
                          <span style={{ color: KCAL, fontWeight: 600 }}>{r.kcal} ккал</span>
                          {' · '}Б {r.p} · У {r.c} · Ж {r.f} — как в прошлый раз
                        </div>
                      </div>
                    ))}
                    {footer}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}


      {/* Сканер штрих-кода. Записывает НЕ сам: отдаёт готовую строку в addFood
          вместе с приёмом, в который его открыли, — тот же путь, что у поиска и
          ручной формы. Оверлей закрываем ДО записи: тост об ошибке живёт в
          этом разделе, из-под сканера его было бы не видно. */}
      {!readOnly && showScanner && (
        <Suspense fallback={
          <div style={{ position: 'fixed', inset: 0, background: BG, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', color: TXT3, fontSize: 14 }}>
            Загружаю сканер…
          </div>
        }>
          <BarcodeScanner
            userId={userId}
            meal={sheetMeal}
            onClose={() => setShowScanner(false)}
            onAdd={(entry, meal) => { setShowScanner(false); closeSheet(); addFood(entry, meal ?? null) }}
          />
        </Suspense>
      )}
    </div>
  )

  return embedded ? tree : createPortal(tree, document.body)
}
