import { createClient } from '@supabase/supabase-js'

// Ручка ТРЕНЕРСКОГО КОНТЕНТА — ТОЛЬКО для роли trainer. Ведёт и глобальный
// каталог упражнений (catalog_exercises), и видео (exercise_videos), и ШАБЛОНЫ
// ПРОГРАММ (program_templates). Отдельный эндпоинт под шаблоны не заводим:
// у Vercel Hobby лимит 12 serverless-функций, мы ровно на нём — поэтому всё
// тренерское складываем сюда, разделяя по полю action.
// Кто действует, берём из подписанного токена; роль проверяем service_role-
// ключом (клиент под RLS свою роль в теле подделать не может).
//
// Тот же env и безопасные fallback (URL и publishable-ключ несекретны), что и
// у остальных функций api/.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Разрешённые префиксы для видео (действия assign_video/clear_video) — только
// наши публичные бакеты, защита от подстановки чужих ссылок.
const VIDEO_PREFIX = 'https://api.fitproapp.ru/storage/v1/object/public/exercise-videos/'
const POSTER_PREFIX = 'https://api.fitproapp.ru/storage/v1/object/public/exercise-posters/'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Личность — только из подписанного токена.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = data.user.id

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Fail closed: без ключа ни роль проверить, ни записать. Ошибка громкая.
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — управление каталогом невозможно')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Только тренер. Роль читаем из базы service_role-ключом, а не из тела.
  const { data: me, error: meErr } = await supabaseAdmin
    .from('profiles').select('role').eq('id', userId).maybeSingle()
  if (meErr) {
    console.error(`set-exercise: ошибка чтения профиля ${userId}:`, meErr)
    return res.status(500).json({ error: 'Не удалось проверить доступ' })
  }
  if (me?.role !== 'trainer') return res.status(403).json({ error: 'Доступно только тренеру' })

  const action = req.body?.action

  // ── Шаблоны программ (program_templates). Работают по key, а НЕ по name,
  //    поэтому идут ДО требования name ниже. Проверка роли trainer — выше. ──
  if (action === 'save_template' || action === 'delete_template') {
    const key = req.body?.key != null ? String(req.body.key).trim().slice(0, 100) : ''
    if (!key) return res.status(400).json({ error: 'Не указан ключ программы' })

    if (action === 'delete_template') {
      // НЕ удаляем строку: profiles.program у выбравших её клиентов держится за
      // key. Прячем (hidden), чтобы не оборвать им выбранную программу.
      const { error } = await supabaseAdmin.from('program_templates')
        .update({ hidden: true, updated_at: new Date().toISOString() }).eq('key', key)
      if (error) {
        console.error(`set-exercise: ошибка скрытия шаблона «${key}»:`, error)
        return res.status(500).json({ error: 'Не удалось скрыть программу' })
      }
      console.log(`set-exercise: тренер ${userId} скрыл шаблон «${key}»`)
      return res.status(200).json({ ok: true })
    }

    // save_template. structure уезжает ВСЕМ клиентам — валидируем строго на
    // сервере, клиенту не доверяем. Строку sets НЕ разбираем и НЕ нормализуем:
    // её понимает parseTemplateSets, любое «улучшение» сломает подходы во всех
    // шаблонах сразу. Пишем ровно {num, name, sets}, лишние поля выбрасываем.
    const rawStructure = req.body?.structure
    if (!Array.isArray(rawStructure) || rawStructure.length < 1 || rawStructure.length > 30) {
      return res.status(400).json({ error: 'Недопустимая структура программы' })
    }
    const structure = []
    for (const rawSlot of rawStructure) {
      if (!Array.isArray(rawSlot) || rawSlot.length > 30) {
        return res.status(400).json({ error: 'Недопустимый слот программы' })
      }
      const slot = []
      rawSlot.forEach((ex, i) => {
        const exName = ex && ex.name != null ? String(ex.name).trim().slice(0, 100) : ''
        if (!exName) return // упражнение без имени в базу не пишем
        const numParsed = parseInt(ex && ex.num, 10)
        const num = Number.isFinite(numParsed) ? numParsed : i + 1
        const sets = ex && ex.sets != null ? String(ex.sets).trim().slice(0, 200) : ''
        slot.push({ num, name: exName, sets })
      })
      structure.push(slot)
    }
    const displayName = req.body?.display_name != null ? (String(req.body.display_name).trim().slice(0, 100) || null) : null
    const context = ['zal', 'dom'].includes(req.body?.context) ? req.body.context : 'zal'
    const sortParsed = parseInt(req.body?.sort, 10)
    const sort = Number.isFinite(sortParsed) ? sortParsed : 0
    const { error } = await supabaseAdmin.from('program_templates').upsert({
      key,
      display_name: displayName,
      context,
      sort,
      structure,
      hidden: req.body?.hidden === true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' })
    if (error) {
      console.error(`set-exercise: ошибка сохранения шаблона «${key}»:`, error)
      return res.status(500).json({ error: 'Не удалось сохранить программу' })
    }
    console.log(`set-exercise: тренер ${userId} сохранил шаблон «${key}» (${structure.length} слотов)`)
    return res.status(200).json({ ok: true })
  }

  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 100) : ''
  if (!name) return res.status(400).json({ error: 'Не указано название упражнения' })

  if (action === 'delete') {
    const { error } = await supabaseAdmin.from('catalog_exercises').delete().eq('name', name)
    if (error) {
      console.error(`set-exercise: ошибка удаления «${name}»:`, error)
      return res.status(500).json({ error: 'Не удалось удалить упражнение' })
    }
    console.log(`set-exercise: тренер ${userId} удалил «${name}»`)
    return res.status(200).json({ ok: true })
  }

  if (action === 'save') {
    const rawType = req.body?.type != null ? String(req.body.type) : ''
    const row = {
      name,
      muscle_group: req.body?.muscle_group != null ? String(req.body.muscle_group).slice(0, 50) : null,
      equipment: req.body?.equipment != null ? String(req.body.equipment).slice(0, 50) : null,
      type: ['compound', 'isolation'].includes(rawType) ? rawType : 'compound',
      // Отображаемое имя (переименование тренером). Пустое → null: показываем
      // исходное имя. Ключ name НЕ трогаем — за него держатся история/видео/программы.
      display_name: req.body?.display_name != null ? (String(req.body.display_name).trim().slice(0, 100) || null) : null,
      hidden: req.body?.hidden === true,
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabaseAdmin.from('catalog_exercises').upsert(row, { onConflict: 'name' })
    if (error) {
      console.error(`set-exercise: ошибка сохранения «${name}»:`, error)
      return res.status(500).json({ error: 'Не удалось сохранить упражнение' })
    }
    console.log(`set-exercise: тренер ${userId} сохранил «${name}»`)
    return res.status(200).json({ ok: true })
  }

  // Назначение/снятие видео упражнению (раньше отдельный set-exercise-video,
  // слито сюда ради лимита serverless-функций Vercel). name = exercise_name.
  if (action === 'clear_video') {
    // Снимаем ролик ТОЛЬКО выбранного контекста (пара exercise_name+context),
    // иначе снятие зального видео снесло бы и домашнее. context не передан → 'default'.
    const context = ['default', 'zal', 'dom'].includes(req.body?.context) ? req.body.context : 'default'
    const { error } = await supabaseAdmin.from('exercise_videos').delete().eq('exercise_name', name).eq('context', context)
    if (error) {
      console.error(`set-exercise: ошибка снятия видео (${name}/${context}):`, error)
      return res.status(500).json({ error: 'Не удалось снять видео' })
    }
    console.log(`set-exercise: тренер ${userId} снял видео с «${name}» (${context})`)
    return res.status(200).json({ ok: true })
  }

  if (action === 'assign_video') {
    // Контекст ролика (зал/дом/общий). Чужое/пустое → 'default'.
    const context = ['default', 'zal', 'dom'].includes(req.body?.context) ? req.body.context : 'default'
    const videoUrl = req.body?.video_url != null ? String(req.body.video_url) : ''
    const posterUrl = req.body?.poster_url != null ? String(req.body.poster_url) : ''
    if (!videoUrl.startsWith(VIDEO_PREFIX)) return res.status(400).json({ error: 'Недопустимый video_url' })
    if (posterUrl && !posterUrl.startsWith(POSTER_PREFIX)) return res.status(400).json({ error: 'Недопустимый poster_url' })
    const { error } = await supabaseAdmin.from('exercise_videos').upsert({
      exercise_name: name,
      context,
      video_url: videoUrl,
      poster_url: posterUrl || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'exercise_name,context' })
    if (error) {
      console.error(`set-exercise: ошибка назначения видео (${name}):`, error)
      return res.status(500).json({ error: 'Не удалось назначить видео' })
    }
    console.log(`set-exercise: тренер ${userId} назначил видео «${name}»`)
    return res.status(200).json({ ok: true })
  }

  // Текст «Техника» на КАЖДОЕ упражнение. Отдельное действие, а НЕ поле в 'save':
  // ветка 'save' upsert'ит всю строку и затёрла бы технику при обычном
  // редактировании упражнения. Здесь пишем только name+technique. Пустая строка
  // после trim = сброс на значение по умолчанию (EQ_TIPS на клиенте) → null.
  if (action === 'save_technique') {
    const technique = req.body?.technique != null ? String(req.body.technique).trim().slice(0, 2000) : ''
    const { error } = await supabaseAdmin.from('catalog_exercises').upsert({
      name,
      technique: technique || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'name' })
    if (error) {
      console.error(`set-exercise: ошибка сохранения техники «${name}»:`, error)
      return res.status(500).json({ error: 'Не удалось сохранить технику' })
    }
    console.log(`set-exercise: тренер ${userId} обновил технику «${name}»`)
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'Неизвестное действие' })
}
