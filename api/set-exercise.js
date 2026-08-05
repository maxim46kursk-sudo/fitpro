import { createClient } from '@supabase/supabase-js'
import { rateLimit } from './_ratelimit.js'
// Разбор и валидация карточек продуктов — общие с api/chat.js (распознавание
// этикетки по фото). Пределы правдоподобия обязаны совпадать в обеих ручках:
// иначе в общий справочник попадёт карточка, которую одна ручка пропустила, а
// другая бы завернула. Файл с подчёркиванием — не serverless-функция.
import {
  isValidBarcode, normalizeOffProduct, fromRow, sanitizeMacros,
  cleanText, MAX_NAME_LEN, MAX_BRAND_LEN,
  basisToSource, SOURCE_ESTIMATE, SOURCE_LABEL,
} from './_foodProduct.js'

// Набор колонок карточки, который отдаём клиенту. source в списке обязателен:
// от него зависит и решение сервера (идти ли за обновлением в OFF), и пометка
// «примерные значения» в интерфейсе.
const CARD_COLUMNS = 'barcode,name,brand,kcal100,p100,c100,f100,source'

// Ручка ТРЕНЕРСКОГО КОНТЕНТА — ТОЛЬКО для роли trainer. Ведёт и глобальный
// каталог упражнений (catalog_exercises), и видео (exercise_videos), и ШАБЛОНЫ
// ПРОГРАММ (program_templates). Отдельный эндпоинт под шаблоны не заводим:
// у Vercel Hobby лимит 12 serverless-функций, мы ровно на нём — поэтому всё
// тренерское складываем сюда, разделяя по полю action.
// Кто действует, берём из подписанного токена; роль проверяем service_role-
// ключом (клиент под RLS свою роль в теле подделать не может).
//
// ⚠ ЗДЕСЬ ЖЕ КВАРТИРУЮТ ДВЕ ЧУЖИЕ ВЕТКИ — обе про справочник продуктов
// food_products, к тренерскому каталогу отношения не имеют и живут тут по
// единственной причине: лимит 12 функций Vercel Hobby выбран целиком, своя
// api/barcode.js была бы 13-й и деплой бы не прошёл.
//
// ПОРЯДОК ВЕТОК В ЭТОМ ФАЙЛЕ (ломать нельзя, дублируется в handoff §3):
//   1. ?action=barcode      — GET, БЕЗ авторизации вовсе. Отвечает первой,
//                             до проверки метода и токена: у неё свой метод,
//                             свой ключ rate limit и своя логика доступа.
//      ?action=food-search  — GET, тоже публичная, та же группа: поиск по
//                             нашему справочнику продуктов по названию.
//   2. ?action=save-product — POST, нужен токен, роль НЕ проверяется. Стоит
//                             после авторизации, но ВЫШЕ проверки роли: это
//                             ручка обычного пользователя, а не тренера.
//   3. Проверка роли trainer.
//   4. Тренерские ветки action (из ТЕЛА запроса) — save, delete,
//      save_template, delete_template, assign_video, clear_video,
//      save_technique. Все обязаны оставаться НИЖЕ проверки роли:
//      save_template переписывает программы всех клиентов.
//
// Ветки 1 и 2 опознаются ТОЛЬКО по req.query.action; тренерские вызовы — это
// POST на голый /api/set-exercise без строки запроса, пересечься они не могут.
// Обе трогают единственную таблицу food_products — обезличенный справочник
// «штрих-код → КБЖУ» без user_id. Если лимит функций когда-нибудь перестанет
// жать — вынести их обратно отдельным файлом, здесь им не место.
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

// ══════════════════════════════════════════════════════════════════════════
// ВЕТКА ШТРИХ-КОДА: GET /api/set-exercise?action=barcode&code=4600682000129
//
// Карточка продукта для дневника питания. Была отдельной функцией
// api/barcode.js — переехала сюда целиком из-за лимита 12 функций на Vercel
// Hobby (подробности в шапке файла). Ниже — весь её код без изменений в
// поведении; с тренерским каталогом он не пересекается ничем, кроме
// константы SUPABASE_URL.
//
// Зачем прокси, а не запрос из браузера напрямую в Open Food Facts:
//  • OFF из РФ доступен через раз. Пусть с этим разбирается сервер в
//    Vercel — у него сеть предсказуемее, чем у телефона в метро.
//  • Всё найденное оседает в нашей таблице food_products (см.
//    sql/2026-08-05_food_products_cache.sql). Один и тот же десяток продуктов
//    сканируют изо дня в день: первый скан идёт в OFF, остальные — из кэша,
//    мгновенно и без внешней сети.
//  • OFF просит не долбить его API. Кэш — наша часть этой договорённости,
//    а User-Agent ниже — вторая: OFF требует представляться.
//
// Авторизация НЕ требуется намеренно — и это осознанное отличие от всего
// остального в этом файле. Ответ — обезличенный справочник «штрих-код →
// КБЖУ», ничего личного тут не отдаётся и не пишется. А дневник питания в
// приложении работает и без входа (App.jsx, addFood: при пустом userId запись
// живёт в localStorage) — требование токена сломало бы сканер ровно для этих
// пользователей. От флуда защищает rateLimit со своим ключом.
// ══════════════════════════════════════════════════════════════════════════

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product'
const OFF_FIELDS = 'product_name,product_name_ru,brands,nutriments'
// OFF просит указывать приложение и контакт — по этой строке они отличают
// клиентов и, если что, находят, кому написать, вместо того чтобы молча
// закрыть доступ по IP.
const OFF_USER_AGENT = 'FitPro/1.0 (fitpro-dun.vercel.app)'
// Шесть секунд. Дольше ждать бессмысленно: человек стоит у полки с телефоном
// в руке, и «сервис недоступен, введи вручную» через 6 с полезнее, чем
// крутилка на полминуты. Плюс это заметно меньше потолка функции на Vercel.
const OFF_TIMEOUT_MS = 6000

async function handleBarcode(req, res) {
  // Свои CORS-заголовки: у ветки другой метод, чем у тренерской части файла.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Свой ключ лимита ('barcode', не 'set-exercise'): счётчики не должны
  // смешиваться — иначе тренер, сохраняющий шаблоны, выжигал бы лимит
  // сканера, и наоборот.
  // 60 в минуту: один продукт — один запрос, но человек у полки сканирует
  // корзину подряд, а за одним IP (домашний вайфай, NAT оператора) их может
  // быть несколько. Лимит бьёт только по явному скрипту.
  if (!rateLimit(req, res, { name: 'barcode', limit: 60 })) return

  // ?code=1&code=2 приезжает массивом — это не опечатка пользователя, а
  // подбор формата, отвечаем ровно как на любой мусор.
  const raw = req.query?.code
  const code = Array.isArray(raw) ? '' : String(raw ?? '').trim()
  if (!isValidBarcode(code)) {
    return res.status(400).json({ error: 'Штрих-код должен состоять из 8–14 цифр' })
  }

  // Кэш — оптимизация, а не условие работы. Если серверный ключ не настроен,
  // сканер обязан продолжать работать напрямую через OFF, просто медленнее;
  // громко пишем в лог, чтобы поломка настроек не осталась незамеченной.
  // (Тренерские ветки этого файла, наоборот, fail closed — им без ключа
  // делать нечего.)
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — ветка barcode работает без кэша')
  const supabaseAdmin = serviceRoleKey ? createClient(SUPABASE_URL, serviceRoleKey) : null

  // ── 1. Свой кэш
  //
  // Примерная карточка (ai_estimate) кэш НЕ закрывает. Её завёл человек по
  // лицевой стороне упаковки, числа в ней — оценка модели; как только товар
  // появится в Open Food Facts, оценку надо заменить сверенными данными.
  // Поэтому при ai_estimate мы всё равно идём в OFF, а саму карточку держим
  // наготове как запасной ответ: если OFF не ответит или не знает товар,
  // отдадим её, а не ошибку.
  //
  // Для точных источников (off, ai_photo) поведение прежнее — ответ из кэша
  // без похода наружу.
  let cachedEstimate = null
  if (supabaseAdmin) {
    const { data: cached, error: cacheError } = await supabaseAdmin
      .from('food_products')
      .select(CARD_COLUMNS)
      .eq('barcode', code)
      .maybeSingle()
    if (cacheError) {
      // Кэш отвалился — не повод отказывать пользователю, идём в OFF.
      console.error(`Штрих-код ${code}: ошибка чтения кэша:`, cacheError)
    } else if (cached) {
      const row = fromRow(cached)
      if (row.source !== SOURCE_ESTIMATE) {
        return res.status(200).json({ found: true, product: row, cached: true })
      }
      cachedEstimate = row
    }
  }

  // Ответ примерной карточкой из кэша — общий выход для всех случаев, когда
  // сходить в OFF не вышло или он ничего не знает. Отдельная функция, чтобы
  // формулировка «ошибка → но у нас есть оценка» не разъехалась по четырём
  // местам ниже.
  const fallbackToEstimate = () =>
    res.status(200).json({ found: true, product: cachedEstimate, cached: true })

  // ── 2. Open Food Facts
  // AbortController — единственный способ ограничить fetch по времени;
  // без него зависший запрос держал бы функцию до её собственного таймаута,
  // а пользователь смотрел бы на крутилку.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS)
  let offRes
  try {
    offRes = await fetch(`${OFF_URL}/${code}.json?fields=${OFF_FIELDS}`, {
      headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    console.error(`Штрих-код ${code}: OFF недоступен:`, e?.name === 'AbortError' ? 'таймаут' : e?.message)
    // Есть примерная карточка — отдаём её. Показать оценку человеку, который
    // стоит у полки, полезнее, чем «сервис недоступен»: числа он всё равно
    // видит на экране сверки и может поправить.
    if (cachedEstimate) return fallbackToEstimate()
    // 502, а НЕ {found:false}. Разница принципиальная: «не найден» —
    // достоверный ответ базы, после него человек вводит продукт руками и
    // больше не пытается. «Источник недоступен» — наша временная беда, тот же
    // скан через минуту сработает, и клиент говорит именно это.
    return res.status(502).json({ error: 'source_unavailable' })
  }
  clearTimeout(timer)

  // 404 — штатный ответ OFF «такого кода в базе нет».
  if (offRes.status === 404) {
    return cachedEstimate ? fallbackToEstimate() : res.status(200).json({ found: false })
  }
  if (!offRes.ok) {
    console.error(`Штрих-код ${code}: OFF ответил ${offRes.status}`)
    if (cachedEstimate) return fallbackToEstimate()
    return res.status(502).json({ error: 'source_unavailable' })
  }

  let offJson
  try {
    offJson = await offRes.json()
  } catch (e) {
    console.error(`Штрих-код ${code}: не удалось разобрать ответ OFF:`, e?.message)
    if (cachedEstimate) return fallbackToEstimate()
    return res.status(502).json({ error: 'source_unavailable' })
  }

  // OFF отдаёт «не нашёл» двумя способами: HTTP 404 (выше) и HTTP 200 с
  // status:0 в теле. Второй встречается чаще.
  if (offJson?.status === 0) {
    return cachedEstimate ? fallbackToEstimate() : res.status(200).json({ found: false })
  }

  const product = normalizeOffProduct(code, offJson?.product)
  // Карточка без названия — пустышка: в OFF полно записей, заведённых одним
  // лишь сканом, где не заполнено вообще ничего. Для пользователя это то же
  // самое, что «не найден».
  if (!product) {
    return cachedEstimate ? fallbackToEstimate() : res.status(200).json({ found: false })
  }

  // OFF знает товар, но без калорийности, а у нас лежит оценка с числами —
  // оценка полезнее. Пустая карточка из точного источника хуже заполненной из
  // примерного: в дневник её всё равно не занести.
  if (product.kcal100 === null && cachedEstimate?.kcal100 !== null && cachedEstimate) {
    return fallbackToEstimate()
  }

  // ── 3. В кэш — только то, что стоит кэшировать
  // Название И калорийность: карточка без ккал бесполезна для дневника, а
  // положив её в кэш, мы бы навсегда закрыли себе повторный поход в OFF за
  // теми же данными — а там их вполне могут дозаполнить завтра. Поэтому такую
  // карточку отдаём клиенту (пусть он покажет, что нашлось), но не сохраняем.
  const worthCaching = supabaseAdmin && product.kcal100 !== null
  if (worthCaching) {
    // upsert по barcode, а не insert: параллельный скан того же кода другим
    // пользователем мог опередить нас на доли секунды, и insert упал бы на
    // первичном ключе. Заодно это способ обновить карточку, если в OFF её
    // с прошлого раза поправили, — и именно этим upsert'ом примерная карточка
    // (ai_estimate) вытесняется сверенными данными OFF.
    const { error: writeError } = await supabaseAdmin
      .from('food_products')
      .upsert({ ...product }, { onConflict: 'barcode' })
    // Ошибка записи в кэш пользователя не касается — продукт у нас на руках,
    // отдаём его и молча теряем только выгоду от кэширования.
    if (writeError) console.error(`Штрих-код ${code}: ошибка записи в кэш:`, writeError)
  }

  return res.status(200).json({ found: true, product, cached: false })
}

// ══════════════════════════════════════════════════════════════════════════
// ВЕТКА ?action=food-search: GET — поиск по НАШЕМУ справочнику продуктов.
//
// Зачем: сканер закрывает случай «товар в руках, штрих-код на месте». Но чаще
// человек добавляет то, что уже ел (гречка, творог, банан) — доставать пачку
// ради этого глупо. Поиск по названию отдаёт карточки, которые кто-то уже
// завёл сканом или фото, — тем самым общая база начинает работать и на тех,
// у кого упаковки под рукой нет.
//
// Публичная, как и barcode: отдаётся обезличенный справочник, ничего личного
// тут нет, а дневник в приложении работает и без входа. От флуда — rateLimit
// со своим ключом.
// ══════════════════════════════════════════════════════════════════════════

// Минимум — два символа: по одной букве нашлось бы полсправочника, и это был
// бы не поиск, а выгрузка базы постранично.
const SEARCH_MIN_LEN = 2
const SEARCH_MAX_LEN = 40
const SEARCH_LIMIT = 20

// ── Живой поиск в Open Food Facts, когда своих карточек почти нет ──────────
//
// Порог: меньше пяти локальных находок — значит по этому слову у нас пусто
// или почти пусто, и человек упрётся в «не нашли». Пять, а не ноль: одна
// случайная карточка не делает выдачу полезной, а лишний поход в OFF на
// каждый набор букв нам не нужен.
const SEARCH_OFF_THRESHOLD = 5
// Текстовый поиск OFF заметно медленнее выборки по коду, а человек в это
// время смотрит в поле ввода. Четыре секунды — потолок, после которого
// полезнее отдать то, что нашлось локально, чем держать его в ожидании.
const SEARCH_OFF_TIMEOUT_MS = 4000
const SEARCH_OFF_PAGE_SIZE = 10
// ru.openfoodfacts.org, а не world: тот же индекс, но выдача приоритезирует
// русские названия и товары, продающиеся в РФ, — ровно то, что нужно.
const OFF_SEARCH_URL = 'https://ru.openfoodfacts.org/cgi/search.pl'

// Строка запроса уходит в PostgREST-фильтр `or=(name.ilike.*q*,brand.ilike.*q*)`,
// где запятая разделяет условия, а скобки их группируют. Пользовательский
// текст с запятой или скобкой сломал бы разбор фильтра — в лучшем случае
// ошибкой, в худшем чужим условием. Поэтому НЕ экранируем, а вычищаем:
// оставляем только буквы, цифры, пробел, дефис и точку (точка нужна —
// «Молоко 3.2%» без неё ищется хуже).
//
// Проценты и подчёркивания тоже вон: это подстановочные знаки LIKE, запрос из
// одних «%» вернул бы всю таблицу в обход проверки длины.
function sanitizeQuery(raw) {
  return String(raw ?? '')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MAX_LEN)
}

// Ранжирование выдачи. Обе таблицы дают «где-то внутри названия есть q», но
// для человека это очень разные попадания: набрав «молоко», он ждёт сверху
// молоко, а не «Какао с молоком».
//
// Три уровня:
//   0 — название НАЧИНАЕТСЯ с q («Молоко 3.2%» для «молоко»);
//   1 — q стоит в начале другого слова («Какао с молоком»);
//   2 — q где-то внутри слова («Молочный» для «молочн»).
// Уровни 0 и 1 разведены намеренно, хотя оба — «начало слова». С одним общим
// уровнем сортировка по длине вклинивала «Какао с молоком» (15 символов)
// между «Молоко 6%» и «Молоко топлёное 4%»: список видов молока разрывался
// посторонним блюдом ровно там, где человек его листает.
//
// При равенстве выигрывает КОРОТКОЕ название: «Молоко 2.5%» конкретнее и
// нужнее, чем «Молоко сгущённое с сахаром». Последний ключ — сам текст, чтобы
// порядок не плавал между запросами при полностью равных названиях.
function rankSearchResults(rows, q) {
  const needle = q.toLowerCase()
  const tier = name => {
    const n = String(name || '').toLowerCase()
    if (n.startsWith(needle)) return 0
    if (n.includes(` ${needle}`)) return 1
    return 2
  }
  return rows
    .map(r => ({ r, t: tier(r.name), len: String(r.name || '').length }))
    .sort((a, b) => a.t - b.t || a.len - b.len || String(a.r.name).localeCompare(String(b.r.name), 'ru'))
    .map(x => x.r)
}

async function handleFoodSearch(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Свой ключ ('food-search'), не общий с barcode: набор в поле поиска идёт
  // пачками по одному запросу на слово, и смешивать его со счётчиком сканера
  // значило бы выжигать один другим.
  if (!rateLimit(req, res, { name: 'food-search', limit: 60 })) return

  const rawQ = req.query?.q
  const q = sanitizeQuery(Array.isArray(rawQ) ? '' : rawQ)
  if (q.length < SEARCH_MIN_LEN) {
    return res.status(400).json({ error: 'Запрос должен быть не короче 2 символов' })
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Без ключа искать негде: справочник закрыт RLS и грантами, клиент к нему
    // не ходит. Пустой результат тут был бы враньём — честнее сказать, что
    // поиск сломан, чем «ничего не нашлось».
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — ветка food-search не работает')
    return res.status(500).json({ error: 'Поиск временно недоступен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Ищем в ДВУХ таблицах сразу и параллельно:
  //  • food_basics   — стартовый справочник (гречка, творог, яблоко). Именно
  //                    он делает поиск полезным, пока сканов мало;
  //  • food_products — то, что пользователи насканировали и наснимали.
  // Из каждой берём по SEARCH_LIMIT, объединяем, ранжируем и режем общим
  // лимитом: иначе одна таблица могла бы вытеснить другую целиком просто
  // потому, что её запрос выполнился первым.
  const [basicsRes, productsRes] = await Promise.all([
    supabaseAdmin
      .from('food_basics')
      .select('id,name,kcal100,p100,c100,f100')
      // У базовых нет бренда — искать есть только по названию.
      .ilike('name', `*${q}*`)
      .limit(SEARCH_LIMIT),
    supabaseAdmin
      .from('food_products')
      .select(CARD_COLUMNS)
      // Ищем и по названию, и по бренду: люди набирают и «творог», и
      // «простоквашино», и то и другое должно находить одно и то же.
      .or(`name.ilike.*${q}*,brand.ilike.*${q}*`)
      // Карточка без калорийности бесполезна: в дневник её не занести, а место
      // в короткой выдаче она займёт.
      .not('kcal100', 'is', null)
      .limit(SEARCH_LIMIT),
  ])

  // Падение ЛЮБОЙ из таблиц не должно обнулять выдачу: базовый справочник и
  // пользовательские карточки независимы, и половина ответа полезнее ошибки.
  if (basicsRes.error) console.error(`food-search «${q}»: ошибка food_basics:`, basicsRes.error)
  if (productsRes.error) console.error(`food-search «${q}»: ошибка food_products:`, productsRes.error)
  if (basicsRes.error && productsRes.error) {
    return res.status(500).json({ error: 'Поиск временно недоступен' })
  }

  const basics = (basicsRes.data || []).map(r => ({
    // key нужен клиенту для React-списка: у базовых нет barcode, а по одному
    // лишь названию ключ был бы хрупким.
    key: `basic:${r.id}`,
    barcode: null,
    name: r.name,
    // Бренда у базового продукта нет по определению — это не товар, а позиция
    // справочника. Клиент по source:'basic' не рисует ни бренда, ни пометки
    // «≈»: значения тут точнее, чем у чего угодно другого в выдаче.
    brand: null,
    kcal100: Number(r.kcal100),
    p100: Number(r.p100),
    c100: Number(r.c100),
    f100: Number(r.f100),
    source: 'basic',
  }))
  const products = (productsRes.data || []).map(r => ({ key: `product:${r.barcode}`, ...fromRow(r) }))

  const local = rankSearchResults([...basics, ...products], q).slice(0, SEARCH_LIMIT)

  // Локального хватило — наружу не ходим вовсе.
  if (local.length >= SEARCH_OFF_THRESHOLD) {
    return res.status(200).json({ results: local })
  }

  // ── Добор из Open Food Facts
  // Всё, что дальше, — best effort: OFF может лечь, ответить мусором или
  // задуматься. Любая беда здесь означает «отдаём то, что нашли локально», а
  // не ошибку: человек и так видит мало результатов, показать ему сверху
  // красное сообщение — сделать хуже.
  const known = new Set(local.map(r => r.barcode).filter(Boolean))
  const fresh = await searchOpenFoodFacts(q, known)
  if (fresh.length && supabaseAdmin) await cacheOffCards(supabaseAdmin, fresh, q)

  const results = [
    ...local,
    // Найденное в OFF идёт ПОСЛЕ локального: свой справочник и то, что уже
    // сканировали люди, достовернее случайной карточки из открытой базы.
    // Внутри группы — то же ранжирование, что и у локальных.
    ...rankSearchResults(fresh.map(c => ({ key: `product:${c.barcode}`, ...c })), q),
  ].slice(0, SEARCH_LIMIT)

  return res.status(200).json({ results })
}

// Текстовый поиск в OFF. Возвращает массив готовых карточек (возможно пустой);
// НИКОГДА не бросает — вызывающий не должен об этом думать.
async function searchOpenFoodFacts(q, known) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_OFF_TIMEOUT_MS)
  try {
    const url = `${OFF_SEARCH_URL}?search_terms=${encodeURIComponent(q)}`
      + `&search_simple=1&action=process&json=1&page_size=${SEARCH_OFF_PAGE_SIZE}`
      + `&fields=code,product_name,product_name_ru,brands,nutriments`
    const offRes = await fetch(url, {
      headers: { 'User-Agent': OFF_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!offRes.ok) {
      console.error(`food-search «${q}»: OFF ответил ${offRes.status}`)
      return []
    }
    const json = await offRes.json()
    const raw = Array.isArray(json?.products) ? json.products : []

    const out = []
    for (const p of raw) {
      // Штрих-код обязателен: без него карточку некуда положить (barcode —
      // первичный ключ) и незачем — повторно её уже не найти сканом.
      const code = String(p?.code ?? '').trim()
      if (!isValidBarcode(code)) continue
      if (known.has(code)) continue           // уже есть в локальной выдаче
      // Тот же нормализатор, что и у поиска по коду: пределы правдоподобия,
      // приоритет product_name_ru, отсев мусора — всё уже написано.
      const card = normalizeOffProduct(code, p)
      // Без калорийности карточка бесполезна в дневнике; в локальной выдаче
      // такие тоже отсекаются (not kcal100 is null), и здесь правило то же.
      if (!card || card.kcal100 === null) continue
      out.push(card)
      if (out.length >= SEARCH_OFF_PAGE_SIZE) break
    }
    return out
  } catch (e) {
    console.error(`food-search «${q}»: OFF недоступен:`, e?.name === 'AbortError' ? 'таймаут' : e?.message)
    return []
  } finally {
    clearTimeout(timer)
  }
}

// Складываем найденное в свой справочник, чтобы ВТОРОЙ такой же поиск был уже
// локальным и мгновенным. Ошибки записи глотаем: продукт у пользователя на
// экране, а потерянный кэш — не его проблема.
async function cacheOffCards(supabaseAdmin, cards, q) {
  try {
    const codes = cards.map(c => c.barcode)
    const { data: existing, error: readError } = await supabaseAdmin
      .from('food_products').select('barcode,source').in('barcode', codes)
    if (readError) { console.error(`food-search «${q}»: не прочитать существующие карточки:`, readError); return }

    const sourceByCode = new Map((existing || []).map(r => [r.barcode, r.source]))
    // Пишем только новые карточки и те, что до сих пор были оценкой модели.
    // Точные (off, ai_photo) не трогаем: данные, прочитанные с реальной
    // упаковки, не должны уступать место результату текстового поиска.
    const toWrite = cards.filter(c => {
      if (!sourceByCode.has(c.barcode)) return true
      return sourceByCode.get(c.barcode) === SOURCE_ESTIMATE
    })
    if (!toWrite.length) return

    const { error: writeError } = await supabaseAdmin
      .from('food_products').upsert(toWrite, { onConflict: 'barcode' })
    if (writeError) console.error(`food-search «${q}»: ошибка записи в кэш:`, writeError)
  } catch (e) {
    console.error(`food-search «${q}»: сбой кэширования:`, e?.message)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ВЕТКА ?action=save-product: POST — пользователь заводит карточку в ОБЩИЙ
// справочник по фотографии этикетки (распознавание — в api/chat.js,
// type:'food_label'; сюда приходит уже подтверждённый человеком результат).
//
// Почему это ручка ОБЫЧНОГО пользователя, а не тренера: смысл затеи в том,
// чтобы база наполнялась теми, кто стоит у полки. Роль здесь не проверяется
// намеренно — поэтому ветка и стоит ВЫШЕ проверки trainer, но НИЖЕ проверки
// токена: аноним сюда не пишет.
//
// ПРИОРИТЕТ ИСТОЧНИКОВ — главное правило ветки:
//   off, ai_photo  — точные, НЕ перезаписываются никогда;
//   ai_estimate    — оценка модели по лицевой стороне упаковки; уступает место
//                    точному источнику, как только тот появляется.
//
// Отсюда единственный разрешённый апгрейд: лежит ai_estimate, пришло чтение
// таблицы (basis='label') → перезаписываем. Все прочие сочетания оставляют
// существующую строку нетронутой. Данные OFF сверены сообществом, а тут —
// прочитанное моделью с телефонного снимка и подтверждённое одним человеком;
// менять первое на второе было бы шагом назад.
//
// Это же аккуратно разруливает гонку: двое сфотографировали один товар
// одновременно, побеждает первый, второй получает ok:true с чужой (уже
// сохранённой) карточкой и ничего не теряет.
//
// source клиент НЕ передаёт и передать не может — только basis, из которого
// сервер сам выводит source (basisToSource). Иначе браузер объявил бы
// примерную карточку точной и навсегда закрыл её от обновления из OFF.
// ══════════════════════════════════════════════════════════════════════════
async function handleSaveProduct(req, res, { supabaseAdmin, userId }) {
  const barcode = String(req.body?.barcode ?? '').trim()
  if (!isValidBarcode(barcode)) {
    return res.status(400).json({ error: 'Штрих-код должен состоять из 8–14 цифр' })
  }
  const name = cleanText(req.body?.name, MAX_NAME_LEN)
  if (!name) return res.status(400).json({ error: 'Не указано название продукта' })
  const brand = cleanText(req.body?.brand, MAX_BRAND_LEN)
  // Те же пределы, что у ветки barcode: тело запроса — источник ничуть не
  // более доверенный, чем открытая база или модель.
  const macros = sanitizeMacros(req.body)
  const source = basisToSource(req.body?.basis)
  const row = { barcode, name, brand, ...macros, source }

  const readCard = () => supabaseAdmin
    .from('food_products').select(CARD_COLUMNS).eq('barcode', barcode).maybeSingle()

  // Что делать, если строка уже есть: либо уступить, либо вытеснить оценку.
  const resolveExisting = async (existing) => {
    const canUpgrade = existing.source === SOURCE_ESTIMATE && source === SOURCE_LABEL
    if (!canUpgrade) {
      return res.status(200).json({ ok: true, product: fromRow(existing), created: false })
    }
    const { data: upgraded, error: upgradeError } = await supabaseAdmin
      .from('food_products')
      .update(row)
      .eq('barcode', barcode)
      // Условие на source ОБЯЗАТЕЛЬНО и в самом UPDATE, а не только в проверке
      // выше: между чтением и записью строку мог обновить кто-то ещё (например,
      // ветка barcode данными из OFF). Без него мы затёрли бы точный источник
      // тем, что прочитали с телефона.
      .eq('source', SOURCE_ESTIMATE)
      .select(CARD_COLUMNS)
      .maybeSingle()
    if (upgradeError) {
      console.error(`save-product ${barcode}: ошибка замены оценки:`, upgradeError)
      return res.status(500).json({ error: 'Не удалось сохранить продукт' })
    }
    // upgraded пуст — значит, гонку мы проиграли и source уже не ai_estimate.
    // Перечитываем и отдаём то, что победило.
    if (!upgraded) {
      const { data: current } = await readCard()
      return res.status(200).json({ ok: true, product: fromRow(current || existing), created: false })
    }
    console.log(`save-product: пользователь ${userId} уточнил карточку ${barcode} «${name}» (оценка → таблица)`)
    return res.status(200).json({ ok: true, product: fromRow(upgraded), created: false, replaced: true })
  }

  // Сначала смотрим, не завёл ли кто карточку раньше.
  const { data: existing, error: readError } = await readCard()
  if (readError) {
    console.error(`save-product ${barcode}: ошибка чтения справочника:`, readError)
    return res.status(500).json({ error: 'Не удалось сохранить продукт' })
  }
  if (existing) return resolveExisting(existing)

  // insert, а НЕ upsert: upsert по определению перезаписал бы чужую карточку,
  // а нам нужно ровно обратное — проиграть гонку молча.
  const { data: inserted, error: writeError } = await supabaseAdmin
    .from('food_products')
    .insert(row)
    .select(CARD_COLUMNS)
    .single()
  if (writeError) {
    // 23505 — нарушение первичного ключа: пока мы читали и писали, карточку
    // успел завести кто-то другой. Это не ошибка, а штатный проигрыш в гонке.
    // Прогоняем победившую строку через то же правило приоритета: если успели
    // положить оценку, а у нас чтение таблицы — всё равно уточняем.
    if (writeError.code === '23505') {
      const { data: raced } = await readCard()
      if (raced) return resolveExisting(raced)
    }
    console.error(`save-product ${barcode}: ошибка записи:`, writeError)
    return res.status(500).json({ error: 'Не удалось сохранить продукт' })
  }

  console.log(`save-product: пользователь ${userId} завёл карточку ${barcode} «${name}» (${source})`)
  return res.status(200).json({ ok: true, product: fromRow(inserted), created: true })
}

export default async function handler(req, res) {
  // Развилка ДО всего остального. Ветка штрих-кода опознаётся ТОЛЬКО по
  // query-параметру: существующие вызовы тренерского каталога — это POST на
  // голый /api/set-exercise без строки запроса (App.jsx, шесть мест), у них
  // req.query.action не бывает вовсе. Поэтому строка ниже физически не может
  // изменить ни один из старых сценариев — она либо срабатывает на новом
  // GET-запросе, либо пропускает всё как раньше.
  //
  // Именно query, а не body: у веток метод GET, тела у них нет.
  if (req.query?.action === 'barcode') return handleBarcode(req, res)
  if (req.query?.action === 'food-search') return handleFoodSearch(req, res)

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'set-exercise', limit: 30 })) return

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

  // Ветка обычного пользователя — ВЫШЕ проверки роли (см. порядок веток в
  // шапке файла). Ей нужен вошедший человек, но не тренер: справочник
  // продуктов наполняют те, кто стоит у полки с телефоном.
  if (req.query?.action === 'save-product') {
    return handleSaveProduct(req, res, { supabaseAdmin, userId })
  }

  // ── Дальше только тренерское. Роль читаем из базы service_role-ключом, а не
  // из тела. Всё, что ниже этой черты, обязано оставаться ниже неё.
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
