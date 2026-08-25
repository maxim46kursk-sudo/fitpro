import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { rateLimit } from './_ratelimit.js'
// Разбор и валидация карточек продуктов — общие с api/chat.js (распознавание
// этикетки по фото). Пределы правдоподобия обязаны совпадать в обеих ручках:
// иначе в общий справочник попадёт карточка, которую одна ручка пропустила, а
// другая бы завернула. Файл с подчёркиванием — не serverless-функция.
import {
  isValidBarcode, normalizeOffProduct, fromRow, sanitizeMacros,
  cleanText, MAX_NAME_LEN, MAX_BRAND_LEN,
  basisToSource, isSoftSource, weakerSources, hasUsableMacros,
} from './_foodProduct.js'
// Журнал ошибок + мгновенное уведомление тренеру. Файл с подчёркиванием —
// не serverless-функция.
import { logServerError, reportError } from './_logError.js'
// Выход наружу: на своём сервере адреса Telegram и Anthropic переписываются
// на мост (см. api/_egress.js), на Vercel остаются как есть — там оба API
// доступны напрямую. Файл с подчёркиванием — не serverless-функция.
import { egressFetch } from './_egress.js'

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
//      ?action=motion-health — GET, доступ по КЛЮЧУ НАБЛЮДАТЕЛЯ, не по токену
//                             пользователя. Живёт в этой группе вынужденно:
//                             задумывалась рядом с motion-log, но там выше
//                             стоят 405 для не-POST и 401 без токена, и до
//                             сверки ключа дело не дошло бы никогда. У неё,
//                             как и у barcode, свой метод и своя логика
//                             доступа — значит и место то же.
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
  // Неуточнённая карточка (ai_estimate, ai_web) кэш НЕ закрывает. Её числа не
  // сняты с упаковки в руках: у ai_estimate это оценка модели, у ai_web —
  // страница товара, найденная по названию, то есть возможно соседний вариант
  // линейки. Как только товар появится в Open Food Facts, такие числа надо
  // заменить сверенными. Поэтому по ним мы всё равно идём в OFF, а саму
  // карточку держим наготове как запасной ответ: если OFF не ответит или не
  // знает товар, отдадим её, а не ошибку.
  //
  // Для точных источников (off, ai_photo) поведение прежнее — ответ из кэша
  // без похода наружу.
  let cachedSoft = null
  if (supabaseAdmin) {
    let { data: cached, error: cacheError } = await supabaseAdmin
      .from('food_products')
      .select(CARD_COLUMNS)
      .eq('barcode', code)
      .maybeSingle()

    // Промах по главному коду — пробуем дополнительные (food_products.barcodes,
    // см. sql/2026-08-09_food_products_aliases.sql). Один товар физически
    // бывает под несколькими кодами: у того зефира их два, оба с верной
    // контрольной суммой.
    //
    // ВТОРЫМ запросом, а не переписанным первым, и это осознанно: обращение по
    // первичному ключу остаётся самым быстрым путём и работает как работало, а
    // лишний поход по GIN-индексу случается только на промахе — там, где мы и
    // так собирались в сеть за Open Food Facts, то есть на порядок дороже.
    if (!cacheError && !cached) {
      const alias = await supabaseAdmin
        .from('food_products')
        .select(CARD_COLUMNS)
        .contains('barcodes', [code])
        .maybeSingle()
      if (alias.error) {
        console.error(`Штрих-код ${code}: ошибка поиска по дополнительным кодам:`, alias.error)
      } else if (alias.data) {
        console.log(`Штрих-код ${code}: найден как дополнительный код карточки ${alias.data.barcode}`)
        cached = alias.data
      }
    }

    if (cacheError) {
      // Кэш отвалился — не повод отказывать пользователю, идём в OFF.
      console.error(`Штрих-код ${code}: ошибка чтения кэша:`, cacheError)
    } else if (cached) {
      const row = fromRow(cached)
      // Строка без полного КБЖУ (или из одних нулей) — НЕ попадание, чем бы её
      // ни завели. Идём дальше по обычной цепочке: OFF, а не найдётся там —
      // {found:false}, и клиент предложит снять этикетку. Показать такую
      // карточку значило бы соврать «нашли» и закрыть оба пути к настоящим
      // числам; её же саму перезапишет upsert ниже, когда данные найдутся.
      if (!hasUsableMacros(row)) {
        console.log(`Штрих-код ${code}: в справочнике пустая карточка (source=${row.source}) — считаем промахом`)
      } else if (!isSoftSource(row.source)) {
        return res.status(200).json({ found: true, product: row, cached: true })
      } else {
        cachedSoft = row
      }
    }
  }

  // Ответ неуточнённой карточкой из кэша — общий выход для всех случаев, когда
  // сходить в OFF не вышло или он ничего не знает. Отдельная функция, чтобы
  // формулировка «ошибка → но что-то у нас есть» не разъехалась по четырём
  // местам ниже.
  const fallbackToCached = () =>
    res.status(200).json({ found: true, product: cachedSoft, cached: true })

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
    if (cachedSoft) return fallbackToCached()
    // 502, а НЕ {found:false}. Разница принципиальная: «не найден» —
    // достоверный ответ базы, после него человек вводит продукт руками и
    // больше не пытается. «Источник недоступен» — наша временная беда, тот же
    // скан через минуту сработает, и клиент говорит именно это.
    return res.status(502).json({ error: 'source_unavailable' })
  }
  clearTimeout(timer)

  // 404 — штатный ответ OFF «такого кода в базе нет».
  if (offRes.status === 404) {
    return cachedSoft ? fallbackToCached() : res.status(200).json({ found: false })
  }
  if (!offRes.ok) {
    console.error(`Штрих-код ${code}: OFF ответил ${offRes.status}`)
    if (cachedSoft) return fallbackToCached()
    return res.status(502).json({ error: 'source_unavailable' })
  }

  let offJson
  try {
    offJson = await offRes.json()
  } catch (e) {
    console.error(`Штрих-код ${code}: не удалось разобрать ответ OFF:`, e?.message)
    if (cachedSoft) return fallbackToCached()
    return res.status(502).json({ error: 'source_unavailable' })
  }

  // OFF отдаёт «не нашёл» двумя способами: HTTP 404 (выше) и HTTP 200 с
  // status:0 в теле. Второй встречается чаще.
  if (offJson?.status === 0) {
    return cachedSoft ? fallbackToCached() : res.status(200).json({ found: false })
  }

  const product = normalizeOffProduct(code, offJson?.product)
  // Карточка без названия — пустышка: в OFF полно записей, заведённых одним
  // лишь сканом, где не заполнено вообще ничего. Для пользователя это то же
  // самое, что «не найден».
  if (!product) {
    return cachedSoft ? fallbackToCached() : res.status(200).json({ found: false })
  }

  // ЭТО И БЫЛ БАГ С ПРОЧЕРКАМИ. В Open Food Facts полно карточек, заведённых
  // одним сканом: название и марка есть, пищевой ценности нет вовсе. Раньше
  // такую карточку мы кэшировать не стали (правильно), но КЛИЕНТУ ОТДАВАЛИ с
  // found:true — и человек видел «Зефир … NEO botanica» с прочерками вместо
  // цифр, активную кнопку «Добавить в дневник» и записывал ноль калорий.
  //
  // Теперь неполная карточка из OFF — такой же промах, как её отсутствие: если
  // есть оценка с числами, отдаём её, иначе честное {found:false}, после
  // которого клиент предлагает снять этикетку. Название без цифр не стоит того,
  // чтобы ради него закрывать дорогу к настоящим данным.
  if (!hasUsableMacros(product)) {
    console.log(`Штрих-код ${code}: OFF знает товар, но без полного КБЖУ — считаем промахом`)
    return cachedSoft ? fallbackToCached() : res.status(200).json({ found: false })
  }

  // ── 3. В кэш — только то, что стоит кэшировать
  // К этому месту карточка уже проверена hasUsableMacros выше, так что условие
  // осталось про одно: есть ли вообще куда писать.
  const worthCaching = !!supabaseAdmin
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
    reportError('api:set-exercise:config', ['SUPABASE_SERVICE_ROLE_KEY не настроен — ветка food-search не работает'], { message: 'SUPABASE_SERVICE_ROLE_KEY не настроен (food-search)', status: 500 })
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
    // Пишем только новые карточки и те, что до сих пор были неуточнёнными
    // (ai_estimate, ai_web). Точные (off, ai_photo) не трогаем: данные,
    // прочитанные с реальной упаковки, не должны уступать место результату
    // текстового поиска.
    const toWrite = cards.filter(c => {
      // Без полного КБЖУ не пишем ничего и отсюда: в выдаче поиска OFF
      // попадаются те же пустышки, что и при поиске по коду.
      if (!hasUsableMacros(c)) return false
      if (!sourceByCode.has(c.barcode)) return true
      return isSoftSource(sourceByCode.get(c.barcode))
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
// ПРИОРИТЕТ ИСТОЧНИКОВ — главное правило ветки. Он задан рангом в
// _foodProduct.js (rankOf/weakerSources), а не цепочкой сравнений здесь:
//   off, ai_photo  — точные, НЕ перезаписываются никогда;
//   ai_web         — числа найдены поиском по названию; уступают чтению таблицы;
//   ai_estimate    — оценка модели по лицевой стороне упаковки; уступает всему.
//
// Отсюда разрешённые апгрейды: карточка вытесняет ту, чей ранг СТРОГО ниже
// (ai_estimate → ai_web → чтение таблицы). Все прочие сочетания оставляют
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

  // БЕЗ ПОЛНОГО КБЖУ В СПРАВОЧНИК НЕ ПИШЕМ. До этой проверки хватало одного
  // названия: клиент требовал калорийность только когда модель не дала вообще
  // ни одного числа (labelEmpty), — то есть карточка с белками, но без ккал
  // проезжала и клиента, и сервер и ложилась в общую базу пустой на вид.
  //
  // Проверка именно на сервере, а не только в интерфейсе: ручка публичная, и
  // строка отсюда достаётся ВСЕМ следующим, кто отсканирует этот код.
  if (!hasUsableMacros(macros)) {
    return res.status(400).json({ error: 'Заполни калорийность, белки, жиры и углеводы' })
  }

  const source = basisToSource(req.body?.basis)
  const row = { barcode, name, brand, ...macros, source }

  const readCard = () => supabaseAdmin
    .from('food_products').select(CARD_COLUMNS).eq('barcode', barcode).maybeSingle()

  // Что делать, если строка уже есть: либо уступить, либо вытеснить менее
  // точный источник. Кого именно эта карточка вправе вытеснить — решает ранг.
  const displaced = weakerSources(source)

  const resolveExisting = async (existing) => {
    if (!displaced.includes(existing.source)) {
      return res.status(200).json({ ok: true, product: fromRow(existing), created: false })
    }
    const { data: upgraded, error: upgradeError } = await supabaseAdmin
      .from('food_products')
      .update(row)
      .eq('barcode', barcode)
      // Условие на source ОБЯЗАТЕЛЬНО и в самом UPDATE, а не только в проверке
      // выше: между чтением и записью строку мог обновить кто-то ещё (например,
      // ветка barcode данными из OFF). Без него мы затёрли бы точный источник
      // тем, что прочитали с телефона. Список тот же, что и в проверке, —
      // одна переменная на оба места, чтобы они не разъехались.
      .in('source', displaced)
      .select(CARD_COLUMNS)
      .maybeSingle()
    if (upgradeError) {
      reportError('api:save-product', [`save-product ${barcode}: ошибка замены менее точной карточки:`, upgradeError], { message: upgradeError?.message, status: 500, userId: userId })
      return res.status(500).json({ error: 'Не удалось сохранить продукт' })
    }
    // upgraded пуст — значит, гонку мы проиграли и source уже не тот, что мы
    // вправе вытеснить. Перечитываем и отдаём то, что победило.
    if (!upgraded) {
      const { data: current } = await readCard()
      return res.status(200).json({ ok: true, product: fromRow(current || existing), created: false })
    }
    console.log(`save-product: пользователь ${userId} уточнил карточку ${barcode} «${name}» (${existing.source} → ${source})`)
    return res.status(200).json({ ok: true, product: fromRow(upgraded), created: false, replaced: true })
  }

  // Сначала смотрим, не завёл ли кто карточку раньше.
  const { data: existing, error: readError } = await readCard()
  if (readError) {
    reportError('api:save-product', [`save-product ${barcode}: ошибка чтения справочника:`, readError], { message: readError?.message, status: 500, userId: userId })
    return res.status(500).json({ error: 'Не удалось сохранить продукт' })
  }
  if (existing) return resolveExisting(existing)

  // ── Карточки на этот код нет — заводим. По названию НИЧЕГО НЕ ИЩЕМ.
  //
  // Здесь стояла ветка «похожий продукт»: поиск карточки с таким же названием и
  // маркой под другим кодом, вопрос человеку «тот же продукт или другой вкус» и
  // привязка кода к найденной строке. Её убрали целиком, и не за
  // надоедливость — она была сломана.
  //
  // find_product_by_name объявлена `returns food_products`, и при промахе
  // Postgres отдаёт не NULL, а СТРОКУ ИЗ ОДНИХ NULL-полей. В JS это обычный
  // truthy-объект, поэтому проверка «нашёлся похожий» срабатывала ВСЕГДА.
  // Отсюда шло всё остальное: вопрос выскакивал почти при каждом сохранении и
  // показывал карточку с прочерками; ответ «это тот же продукт» присылал
  // sameAs со строкой "null"; link_barcode возвращала такую же пустую строку,
  // и она тоже считалась успехом — сервер отвечал ok:true, НЕ ЗАПИСАВ НИЧЕГО.
  // Человек видел «сохранено», а на следующем скане продукта не было.
  //
  // Новое правило простое: штрих-код — удостоверение товара. Кода нет в
  // справочнике → распознали по фото → человек подтвердил → завели карточку
  // именно на этот код. Два кода на один товар дадут две одинаковые карточки —
  // это нормально и честно: дубль виден и поправим, а подменённые чужие КБЖУ
  // незаметны.
  //
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
    reportError('api:save-product', [`save-product ${barcode}: ошибка записи:`, writeError], { message: writeError?.message, status: 500, userId: userId })
    return res.status(500).json({ error: 'Не удалось сохранить продукт' })
  }

  console.log(`save-product: пользователь ${userId} завёл карточку ${barcode} «${name}» (${source})`)
  return res.status(200).json({ ok: true, product: fromRow(inserted), created: true })
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * МГНОВЕННАЯ ТРЕВОГА В ТЕЛЕГРАМ — про сломавшееся у живого человека.
 *
 * Зачем отдельно от уведомлений тренеру (_logError.js). Те адресованы владельцу
 * и говорят про приложение целиком; эта — про бету Motion и адресована тому,
 * кто её ведёт: свой бот, свой чат, свой ритм. Сводка раз в час
 * (?action=motion-health) отвечает на вопрос «как оно вообще», а тревога — на
 * «прямо сейчас у кого-то не работает», и ждать до следующего часа она не может.
 *
 * ДВА ПОВОДА, И ОБА ПРИХОДЯТ САМИ В ЭТУ ЖЕ РУЧКУ:
 *   error_log   — приложение упало у человека (ветка ?action=log-error);
 *   user.report — человек нажал «Сообщить о проблеме» (ветка ?action=motion-log).
 * Второй дороже первого: ошибку присылает код, жалобу — человек, который ещё и
 * потратил на это время посреди тренировки.
 *
 * ОДНО СООБЩЕНИЕ В ДЕСЯТЬ МИНУТ НА ТИП. Без этого первый же массовый сбой
 * превращается в пулемёт: тридцать телефонов ловят одну и ту же ошибку за
 * минуту — тридцать сообщений, после чего уведомления выключают вместе с
 * полезными. Глушится ТОЛЬКО СИГНАЛ: строка в журнал ложится каждая, и сводка
 * покажет все до единой. Тишина по типу, а не по тексту, — сознательно: в
 * тревоге ценно «началось», подробности всё равно смотреть в журнале.
 *
 * СЧЁТЧИК В ПАМЯТИ ИНСТАНСА, как у _ratelimit.js, и с той же оговоркой: у
 * Vercel их несколько, холодный старт обнуляет. Значит в худшем случае придёт
 * не одно сообщение за десять минут, а по одному с каждого живого инстанса.
 * Для «не молчать, когда сломалось» этого достаточно, а хранилище ради
 * антиспама заводить дороже пользы.
 *
 * СТРОГО FIRE-AND-FORGET. Ответ ручки не ждёт отправки и не зависит от неё
 * ничем: телефон, отправивший лог, не должен ни секунды стоять из-за Телеграма,
 * а упавший Телеграм не имеет права уронить приём журнала. Поэтому промис
 * никто не ждёт, а внутри всё завёрнуто в try/catch.
 *
 * НЕТ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ — МОЛЧА НИЧЕГО НЕ ДЕЛАЕМ. Тревога это добавка, а не
 * условие работы: на превью-выкладке и у любого, кто поднимет проект себе,
 * TG_ALERT_* не заданы, и ругаться на это незачем.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Тишина после первого крика — на тип тревоги. */
const ALERT_QUIET_MS = 10 * 60 * 1000
/**
 * Сколько текста уходит в сообщение. Тысячи хватает на слова человека целиком
 * (пятьсот знаков) и снимок состояния следом; при этом до потолка Телеграма в
 * четыре тысячи далеко. Для тревоги об ошибке столько и не нужно — там текст
 * короткий, — но резать жалобу ради единообразия значит терять ровно то, ради
 * чего её и просили написать.
 */
const ALERT_TEXT_MAX = 1000
/** тип → когда по нему уже кричали. Живёт столько же, сколько тёплый инстанс. */
const alertedAt = new Map()

/**
 * Отправить тревогу. Ничего не ждёт и никогда не бросает.
 *
 * @param {string} тип  'error' | 'user.report' — по нему же и молчим десять минут
 * @param {string} текст  уже очищенная техническая суть, без личного
 */
function тревога(тип, текст) {
  try {
    const token = process.env.TG_ALERT_TOKEN
    const chat = process.env.TG_ALERT_CHAT
    if (!token || !chat) return

    const было = alertedAt.get(тип) ?? 0
    const сейчас = Date.now()
    if (сейчас - было < ALERT_QUIET_MS) return
    // Отметка ставится ДО отправки: иначе десяток одновременных запросов
    // успеет проскочить проверку прежде, чем первый допишет её после ответа.
    alertedAt.set(тип, сейчас)

    const тело = JSON.stringify({
      chat_id: String(chat),
      text: String(текст).slice(0, ALERT_TEXT_MAX),
      disable_web_page_preview: true,
    })
    // Промис намеренно не ждём — см. fire-and-forget выше. .catch обязателен:
    // без него отказ сети стал бы необработанным отклонением и убил бы процесс
    // функции вместе с ответом, который она в этот момент отдаёт.
    egressFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: тело,
    }).catch(() => {})
  } catch {
    // Тревога не имеет права ломать ручку — ни при какой поломке внутри себя.
  }
}

/**
 * СКОЛЬКО СТРОК ЖУРНАЛА MOTION ПРИНИМАЕМ ЗА РАЗ. Телефон копит буфер десять
 * секунд — это десяток-другой строк; пятьсот берём с запасом на срочную
 * отправку при падении клиента. Всё сверх — отрезаем: это приёмник телеметрии,
 * а не файлопомойка.
 */
const MOTION_LOG_MAX_LINES = 500
/** Одна строка лога длиннее этого ни о чём не расскажет, а место займёт. */
const MOTION_LOG_MAX_LEN = 2000

/**
 * Строка журнала Motion, годная для записи.
 *
 * Чистка стоит на СЕРВЕРЕ, хотя клиент уже не шлёт ни метку камеры, ни
 * deviceId: сборки у людей на телефонах живут своей жизнью, и та, что стоит
 * сейчас, будет слать старое тело ещё долго. Приёмник обязан быть последним
 * рубежом, а не первым доверчивым.
 */
function motionLogLine(line) {
  return String(line ?? '')
    .slice(0, MOTION_LOG_MAX_LEN)
    // "label":"Galaxy A54 front camera" и "deviceId":"a1b2…" — отпечаток
    // устройства; остальное в строке техническое и нужно для разбора
    .replace(/"(label|deviceId)":\s*("(?:[^"\\]|\\.)*"|null)/g, '"$1":"—"')
}

/**
 * СКОЛЬКО ЗНАКОВ ЖАЛОБЫ ХРАНИМ. Столько же, сколько пропускает поле на клиенте
 * (NOTE_MAX в src/motion/debug/diagnostics.js). Пятьсот — это несколько фраз,
 * то есть весь реальный объём: жалобу пишут одной рукой, стоя в спортзале.
 */
const NOTE_MAX = 500

/**
 * ТЕКСТ ЧЕЛОВЕКА, ГОДНЫЙ ДЛЯ ХРАНЕНИЯ И ДЛЯ СООБЩЕНИЯ.
 *
 * Ровно та же чистка, что на клиенте, и стоит она здесь по той же причине, по
 * какой продублирована чистка метки камеры: сборка на телефоне живёт своей
 * жизнью, и приёмник обязан быть последним рубежом, а не первым доверчивым.
 * Переводы строк остаются — ими пользуются осмысленно; прочее управляющее
 * вычищается: оно ничего не значит для читателя, зато ломает и сообщение в
 * Телеграме, и разбор строки глазами.
 */
function cleanNote(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NOTE_MAX)
}

/** Разбор строки жалобы: «…[user.report] {json}» → сам объект или null. */
function parseReport(line) {
  const m = String(line ?? '').match(/\[user\.report\]\s*(\{[\s\S]*\})\s*$/)
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

/**
 * Строка жалобы с вычищенным текстом человека.
 *
 * Пересобирается, а не правится по месту: длину и управляющие символы внутри
 * JSON-строки регуляркой честно не поправить — экранирование там своё. Строка,
 * которая не разобралась, уходит как есть: это либо чужой формат, либо сломанный
 * клиент, и терять её из-за неудачного разбора хуже, чем сохранить непонятной.
 */
function motionReportLine(line) {
  const data = parseReport(line)
  if (!data || typeof data.note !== 'string') return line
  const { note, ...остальное } = data
  const чистый = cleanNote(note)
  const голова = line.slice(0, line.indexOf('{'))
  // note первым: и строку журнала, и сообщение тревоги читают сверху
  return голова + JSON.stringify(чистый ? { note: чистый, ...остальное } : остальное)
}

// ══════════════════════════════════════════════════════════════════════════
// ВЕТКА ?action=motion-health: сводка по бете Motion для наблюдателя.
//
// Зачем. Бета идёт на живых людях, а видно её только изнутри базы. Наблюдателю
// (постоянной задаче раз в час) нужен ответ на один вопрос: «за последний час
// что-нибудь сломалось или затихло?» — и ради этого он не должен ни иметь
// учётной записи в приложении, ни ходить в базу сам.
//
// ТОЛЬКО ЧИТАЕТ. Ни одной записи отсюда не уходит: наблюдатель, способный
// что-то изменить, — это уже не наблюдатель, а вторая точка отказа. Автопочинку
// решено включать после беты, когда станет ясно, какие поломки бывают.
//
// ТОЛЬКО АГРЕГАТЫ. В ответе нет ни user_id, ни имён, ни содержимого строк —
// счётчики, типы событий и метки времени. Это сознательное ограничение, а не
// экономия: сводка уезжает наружу по ключу, и всё, что в неё попало, считай
// вынесенным за пределы базы. Типы берутся из ТЕГА строки (`[render.cheap]`),
// сам текст строки наружу не идёт; уникальные люди считаются множеством, из
// которого отдаётся только размер.
//
// ДОСТУП ПО КЛЮЧУ, А НЕ ПО ТОКЕНУ, и потому ветка стоит в первой группе: в
// группе motion-log до неё бы не дошло — выше 405 для не-POST и 401 без токена.
// Ключ ищется в заголовке x-monitor-key или в ?key=. Сверка постоянная по
// времени: обычное === на длинном секрете сравнивает посимвольно и на потоке
// запросов выдаёт длину общего префикса.
//
// АДРЕС БЕЗ СТРОКИ ЗАПРОСА: /api/motion-health/<ключ>. Реврайт в vercel.json
// разворачивает его обратно в ?action=motion-health&key=..., и сюда всё
// приходит как обычно — ветка о реврайте не знает и знать не должна.
//
// Зачем он вообще. Клиент наблюдателя не доносит строку запроса: «?» уезжает в
// путь закодированным (%3F), и запрос отбивается маршрутизацией Vercel с 404
// NOT_FOUND, не дойдя до функции. Корень сайта тот же клиент читает нормально —
// значит дело не в доступе, а в форме адреса. Путь вместо строки запроса эту
// форму убирает.
//
// ЧЕМ ЗА ЭТО ПЛАТИМ: ключ в пути виден журналам доступа и истории запросов
// целиком, тогда как заголовок туда обычно не попадает. Поэтому путь — запасной
// вход для клиента, который иначе не может позвонить вовсе, а заголовок
// x-monitor-key остаётся предпочтительным для всех, кто его умеет. Ключ при
// компрометации меняется одной переменной окружения: ветка только читает
// агрегаты, ничего не пишет и ничего личного не отдаёт.
//
// НЕТ КЛЮЧА В ОКРУЖЕНИИ — 404, а не 500. Ненастроенная ручка не должна
// сообщать, что она существует и ждёт ключ: неверный ключ, отсутствующий ключ
// и незаданный MONITOR_KEY отвечают одинаково и молча, как несуществующий путь.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Сколько строк читаем на одно окно. Бета маленькая, но сводка не имеет права
 * стать тяжёлым запросом: она ходит раз в час и обязана быть дешёвой всегда, в
 * том числе если телеметрия однажды хлынет потоком. Упёрлись в потолок — так и
 * говорим полем `обрезано`, а не тихо отдаём неполную картину.
 */
const HEALTH_MAX_ROWS = 2000

/** Постоянное по времени сравнение секретов. Разная длина — сразу нет. */
function секретСовпал(дано, ожидается) {
  const a = Buffer.from(String(дано ?? ''), 'utf8')
  const b = Buffer.from(String(ожидается ?? ''), 'utf8')
  if (a.length !== b.length || !a.length) return false
  return timingSafeEqual(a, b)
}

/** Тег события из строки лога: «2026-08-19T… [render.cheap] {…}» → render.cheap. */
function тегСтроки(line) {
  const m = String(line ?? '').match(/\[([a-zA-Z0-9._-]{1,40})\]/)
  return m ? m[1] : 'без-тега'
}

/**
 * Модель устройства из User-Agent — коротко и без версий.
 *
 * Полная строка в сводке нечитаема и ничего не добавляет: чинить приходится по
 * «все маячки с одного айфона» или «все с андроида такого-то», а не по номеру
 * сборки WebKit.
 */
function коротко(ua) {
  const s = String(ua || '')
  if (!s) return '—'
  const m = /\(([^)]+)\)/.exec(s)
  const внутри = m ? m[1] : s
  return внутри.split(';').slice(0, 2).join(';').trim().slice(0, 60) || '—'
}

async function handleMotionHealth(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-monitor-key')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const ожидается = process.env.MONITOR_KEY
  const дано = req.headers?.['x-monitor-key'] ?? req.query?.key
  // Одинаковый ответ на все три случая: ключа нет в окружении, ключа нет в
  // запросе, ключ не тот. Наружу это неотличимо от несуществующего пути.
  if (!ожидается || Array.isArray(дано) || !секретСовпал(дано, ожидается)) {
    return res.status(404).end()
  }
  if (req.method !== 'GET') return res.status(404).end()

  // Лимит свой и скромный: сюда ходит одна задача раз в час, всё остальное —
  // перебор ключа. Он всё равно не подберётся, но и считать за него не будем.
  if (!rateLimit(req, res, { name: 'motion-health', limit: 30 })) return

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    reportError('api:set-exercise:motion-health', ['SUPABASE_SERVICE_ROLE_KEY не настроен — сводка не собирается'], { message: 'SUPABASE_SERVICE_ROLE_KEY не настроен (motion-health)', status: 500 })
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const db = createClient(SUPABASE_URL, serviceRoleKey)

  const сейчас = Date.now()
  const окна = {
    час: new Date(сейчас - 60 * 60 * 1000).toISOString(),
    сутки: new Date(сейчас - 24 * 60 * 60 * 1000).toISOString(),
  }

  /** Просто счётчик строк: head:true — база считает, строк не отдаёт вовсе. */
  const сколько = async (таблица, колонкаВремени, от) => {
    const { count, error } = await db
      .from(таблица)
      .select('id', { count: 'exact', head: true })
      .gte(колонкаВремени, от)
    if (error) throw new Error(`${таблица}: ${error.message}`)
    return count ?? 0
  }

  /** Метка последней записи. Читается одна колонка одной строки. */
  const последняя = async (таблица, колонкаВремени) => {
    const { data, error } = await db
      .from(таблица)
      .select(колонкаВремени)
      .order(колонкаВремени, { ascending: false })
      .limit(1)
    if (error) throw new Error(`${таблица}: ${error.message}`)
    return data?.[0]?.[колонкаВремени] ?? null
  }

  /**
   * События motion_log по типам. Читается payload — иначе тип не узнать, — но
   * наружу уходит только «тип → сколько раз». Сами строки остаются здесь.
   */
  const поТипам = async (от) => {
    const { data, error } = await db
      .from('motion_log')
      .select('payload')
      .gte('at', от)
      .order('at', { ascending: false })
      .limit(HEALTH_MAX_ROWS)
    if (error) throw new Error(`motion_log: ${error.message}`)
    const типы = {}
    let событий = 0
    for (const строка of data ?? []) {
      for (const line of строка?.payload?.lines ?? []) {
        событий += 1
        const тег = тегСтроки(line)
        типы[тег] = (типы[тег] ?? 0) + 1
      }
    }
    return { записей: data?.length ?? 0, событий, типы, обрезано: (data?.length ?? 0) >= HEALTH_MAX_ROWS }
  }

  /**
   * Попытки и сколько РАЗНЫХ людей их делало. user_id читается, чтобы построить
   * множество, и не покидает эту функцию — наружу идёт только его размер.
   */
  const попытки = async (от) => {
    const { data, error } = await db
      .from('motion_attempts')
      .select('user_id')
      .gte('at', от)
      .order('at', { ascending: false })
      .limit(HEALTH_MAX_ROWS)
    if (error) throw new Error(`motion_attempts: ${error.message}`)
    const люди = new Set((data ?? []).map((r) => r.user_id))
    return { попыток: data?.length ?? 0, людей: люди.size, обрезано: (data?.length ?? 0) >= HEALTH_MAX_ROWS }
  }

  /**
   * МАЯЧКИ НЕВЗЛЕТЕВШЕЙ ЗАГРУЗКИ — не просто число, а разбор.
   *
   * Одно число отвечает «сколько», но не отвечает «что чинить». Стадия говорит,
   * где встали: 'html' — не приехал бандл, 'bundle' — упал код. Устройства
   * говорят, у кого: одна модель телефона на все маячки — это не сеть.
   */
  const маячки = async (от) => {
    const { data, error } = await db
      .from('boot_beacons')
      .select('stage,attempt,conn,ua')
      .gte('created_at', от)
      .order('created_at', { ascending: false })
      .limit(HEALTH_MAX_ROWS)
    if (error) throw new Error(`boot_beacons: ${error.message}`)
    const строки = data ?? []
    const стадии = {}
    const устройства = {}
    for (const r of строки) {
      стадии[r.stage || '—'] = (стадии[r.stage || '—'] ?? 0) + 1
      // Не весь User-Agent, а модель: длинная строка в сводке нечитаема, а
      // ответ на «у кого» даёт именно она.
      const модель = коротко(r.ua)
      устройства[модель] = (устройства[модель] ?? 0) + 1
    }
    return {
      маячков: строки.length,
      по_стадиям: стадии,
      устройства,
      повторных: строки.filter((r) => r.attempt === 2).length,
      обрезано: строки.length >= HEALTH_MAX_ROWS,
    }
  }

  const окно = async (от) => {
    const [лог, att, ошибок, boot] = await Promise.all([
      поТипам(от),
      попытки(от),
      сколько('error_log', 'created_at', от),
      маячки(от),
    ])
    return {
      motion_log: { записей: лог.записей, событий: лог.событий, по_типам: лог.типы, обрезано: лог.обрезано },
      motion_attempts: { попыток: att.попыток, уникальных_людей: att.людей, обрезано: att.обрезано },
      error_log: { записей: ошибок },
      boot_beacons: boot,
    }
  }

  /**
   * ВОРОНКА ГОСТЯ — рядом со сводкой Motion, а не отдельной ручкой: новых
   * файлов в api/ заводить нельзя (лимит функций тарифа исчерпан), а смотреть
   * эти цифры будет тот же человек и тем же ключом.
   *
   * Две недели — столько, чтобы видеть будни против выходных и эффект правки
   * «до/после», и не столько, чтобы ответ раздулся.
   *
   * Ошибка чтения роняет ТОЛЬКО этот блок. Сводка Motion следит за живой бетой,
   * и уронить её из-за вспомогательного счётчика было бы обменом важного на
   * второстепенное.
   */
  const воронка = async () => {
    try {
      const от = new Date(сейчас - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const { data, error } = await db
        .from('funnel_counts')
        .select('day,event,n')
        .gte('day', от)
        .order('day')
        .order('event')
      if (error) throw new Error(error.message)
      return data ?? []
    } catch (e) {
      reportError('api:set-exercise:motion-health', ['воронка не прочиталась:', e], { message: e?.message, status: 500 })
      return null
    }
  }

  try {
    const [час, сутки, последнееLog, последнееAtt, последнееErr, funnel] = await Promise.all([
      окно(окна.час),
      окно(окна.сутки),
      последняя('motion_log', 'at'),
      последняя('motion_attempts', 'at'),
      последняя('error_log', 'created_at'),
      воронка(),
    ])
    return res.status(200).json({
      снято: new Date(сейчас).toISOString(),
      час,
      сутки,
      последняя_запись: {
        motion_log: последнееLog,
        motion_attempts: последнееAtt,
        error_log: последнееErr,
      },
      funnel,
    })
  } catch (e) {
    reportError('api:set-exercise:motion-health', ['сводка не собралась:', e], { message: e?.message, status: 500 })
    return res.status(500).json({ error: 'Сводка недоступна' })
  }
}

/**
 * СЧЁТЧИК ВОРОНКИ — этап 0 гостевого режима.
 *
 * Зачем. Переходы из Инстаграма есть, регистраций почти нет, и до сих пор это
 * знание держалось на ощущении: продуктовой аналитики в проекте нет вовсе — ни
 * метрики, ни счётчиков. Прежде чем убирать стену регистрации, нужен способ
 * увидеть, помогло ли: сколько людей открыло, сколько потрогало разделы,
 * сколько дошло до предложения и сколько завелось.
 *
 * ПУБЛИЧНАЯ И БЕЗ ТОКЕНА — иначе она не измерит ровно тех, ради кого затеяна:
 * у гостя токена нет и не будет до самой регистрации.
 *
 * ЧТО ЗДЕСЬ НЕ ХРАНИТСЯ. Ни личности, ни устройства, ни адреса — только
 * «событие такое-то случилось ещё раз сегодня». Таблица `funnel_counts` это
 * счётчики по дням, а не журнал: строку нельзя связать ни с человеком, ни с
 * заходом. Поэтому в USER_TABLES она не входит и под выгрузку с удалением по
 * 152-ФЗ не попадает — связывать там нечего.
 *
 * ЛИМИТ ТОЛЬКО ПО IP. Соблазн считать по deviceId с клиента здесь особенно
 * велик — и запрещён правилом самого лимитера (_ratelimit.js): всё, что пришло
 * телом запроса, подделывается сменой одного поля, и лимит перестаёт быть
 * лимитом. Пусть за одним NAT счётчик общий: испортить можно только точность
 * собственных цифр, а не чужую работу.
 *
 * ОТВЕТ ВСЕГДА 200. Счётчик — вспомогательная вещь, и клиент про его проблемы
 * знать не должен: он шлёт событие и забывает (см. src/funnel.js). Ошибка
 * записи, незнакомое событие, ненастроенный ключ — наружу одинаковое
 * `{ok:true}`. Единственное, что 200 обязан означать, — «запрос принят и
 * дальше не твоя забота».
 */

/**
 * СПИСОК РАЗРЕШЁННЫХ СОБЫТИЙ, и он закрытый.
 *
 * Ветка публичная: без списка любой желающий насыпал бы в таблицу
 * произвольных строк, и она перестала бы читаться. Незнакомое имя не ошибка и
 * не повод для 400 — просто ничего не пишем: у людей в кэше живут старые
 * сборки, и присланное ими имя из прошлой версии не должно выглядеть как атака.
 */
const FUNNEL_EVENTS = new Set([
  // заход
  'open',
  'open_guest',
  // потрогал раздел
  'try_motion',
  'try_workout',
  'try_diary',
  // дошёл до ценности
  'value_motion',
  'value_workout',
  'value_diary',
  // увидел предложение сохранить
  'offer_shown_motion',
  'offer_shown_workout',
  'offer_shown_diary',
  // закрыл предложение
  'offer_closed_motion',
  'offer_closed_workout',
  'offer_closed_diary',
  // принял предложение
  'offer_accepted_motion',
  'offer_accepted_workout',
  'offer_accepted_diary',
  // завёлся
  'register',
  'register_from_offer',
  // гостевые данные переехали в аккаунт
  'migrated',
  // воронка челленджа: страница → правила → «Участвовать» → аккаунт → оплата.
  // Оплаченные билеты сюда не пишутся вовсе: они есть в challenge_entries, и
  // счётчик с клиента был бы худшим из источников — его легко потерять и
  // невозможно сверить с деньгами.
  'ch_open',
  'ch_rules',
  'ch_join',
  'ch_signup',
  'ch_pay',
])

async function handleFunnel(req, res) {
  // Свои CORS-заголовки: у ветки свой метод и нет авторизации.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  /**
   * ПО АДРЕСУ — тоже по построению: воронку считают ДО регистрации, личности
   * ещё нет. Триста в минуту: полсотни человек, пришедших по одной ссылке из
   * Инстаграма, дают за первую минуту по несколько событий каждый, а
   * шестидесяти на них не хватало.
   *
   * ЧЕМ ПЛАТИМ: с одного адреса можно накрутить триста событий в минуту, и
   * вечерняя сводка покажет неправду. Считать это защитой и раньше было нельзя
   * (шестьдесят в минуту — те же восемьдесят тысяч за сутки), но сказать прямо
   * стоит: цифры воронки — оценка, а не учёт. Деньги считаются не здесь, а по
   * challenge_entries.
   */
  if (!rateLimit(req, res, { name: 'funnel', limit: 300 })) return

  const event = typeof req.body?.event === 'string' ? req.body.event : ''
  if (!FUNNEL_EVENTS.has(event)) return res.status(200).json({ ok: true })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  // Без ключа считать нечем. Молча: счётчик не тот повод, чтобы отвечать
  // ошибкой человеку, который просто открыл приложение.
  if (!serviceRoleKey) return res.status(200).json({ ok: true })

  try {
    const db = createClient(SUPABASE_URL, serviceRoleKey)
    // Функция в базе (security definer): права на неё отобраны у anon и
    // authenticated, вызвать её может только service role — то есть эта ветка.
    await db.rpc('funnel_bump', { ev: event })
  } catch {
    // Счётчик не работает — приложение работает. Молчим.
  }
  return res.status(200).json({ ok: true })
}

/**
 * МАЯЧОК НЕВЗЛЕТЕВШЕЙ ЗАГРУЗКИ.
 *
 * Шлёт его код из index.html, когда приложение за восемь секунд не дошло до
 * монтирования. Смысл ветки — принять сигнал от человека, у которого приложение
 * НЕ РАБОТАЕТ: ни токена, ни сессии, ни даже бандла у него нет.
 *
 * ПУБЛИЧНАЯ И БЕЗ ТОКЕНА — по построению, ровно как воронка. Отсюда и защита та
 * же: лимит по адресу и жёсткая проверка каждого поля. Всё, что пришло, — чужой
 * ввод, и в базу оно попадает обрезанным и приведённым к своему типу.
 *
 * ЧТО НЕ ХРАНИМ: ни личности, ни IP. Адрес нужен лимиту и остаётся в памяти
 * процесса; в таблице его нет и быть не должно — маячок присылает человек,
 * которого мы не знаем и знать не обязаны.
 *
 * ОТВЕТ ВСЕГДА 200 И ВСЕГДА ПУСТОЙ. sendBeacon ответа не читает, а человеку с
 * белым экраном наша ошибка не поможет ничем: единственное, что мы можем ему
 * дать, — не мешать.
 */
const BOOT_STAGES = new Set(['html', 'bundle', 'react', 'data'])
/** Раз в сутки на процесс: чистка старых маячков идёт попутно, без cron. */
let bootSweptAt = 0

async function handleBoot(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  /**
   * ПО АДРЕСУ — И ИНАЧЕ НЕЛЬЗЯ: маячок шлёт человек, у которого приложение НЕ
   * ПОДНЯЛОСЬ. Ни токена, ни сессии, ни личности у него нет по построению.
   *
   * Сто двадцать в минуту — это полсотни человек из одной сети по два маячка
   * (восьмая и двадцатая секунда) плюс запас. Двадцати не хватало: в день
   * старта потока полсотни человек, у которых всё легло, — это ровно тот
   * случай, ради которого маячок и заведён, а старый потолок отрезал бы три
   * четверти сигнала именно тогда, когда он нужен.
   *
   * ЧЕМ ПЛАТИМ: с одного адреса можно насыпать сто двадцать строк в минуту в
   * boot_beacons. Таблица чистится раз в неделю, а тревога «больше трёх маячков
   * за час» на такой поток сработает — то есть шум будет виден, а не растворится.
   */
  if (!rateLimit(req, res, { name: 'boot', limit: 120 })) return

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) return res.status(200).end()

  /**
   * ТЕЛО РАЗБИРАЕМ САМИ. sendBeacon шлёт Blob, и обёртка Vercel разбирает его
   * как JSON только когда тип угадан; на своём сервере тело приезжает строкой.
   * Полагаться на догадку в ветке, которая существует ради сломанных случаев,
   * было бы смешно.
   */
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { body = null }
  }
  if (!body || typeof body !== 'object') return res.status(200).end()

  const stage = BOOT_STAGES.has(body.stage) ? body.stage : 'html'
  const ms = Number.isFinite(Number(body.ms)) ? Math.min(600000, Math.max(0, Math.round(Number(body.ms)))) : 0
  const attempt = Number(body.attempt) === 2 ? 2 : 1
  const conn = typeof body.conn === 'string' ? body.conn.slice(0, 20) : null
  const ua = typeof body.ua === 'string' ? body.ua.slice(0, 300) : null
  // Список недогруженных файлов: не больше двадцати, каждый — имя и мгновение.
  const pending = Array.isArray(body.pending)
    ? body.pending.slice(0, 20).map((r) => ({
      name: typeof r?.name === 'string' ? r.name.slice(0, 200) : '',
      ms: Number.isFinite(Number(r?.ms)) ? Math.round(Number(r.ms)) : 0,
    }))
    : []

  try {
    const db = createClient(SUPABASE_URL, serviceRoleKey)
    await db.from('boot_beacons').insert({ stage, ms, attempt, conn, ua, pending })
    // Уборка попутно, не чаще раза в сутки на процесс: маячки живут неделю, и
    // заводить ради этого отдельный cron значило бы завести ещё одно место,
    // которое может однажды перестать ходить.
    if (Date.now() - bootSweptAt > 24 * 60 * 60 * 1000) {
      bootSweptAt = Date.now()
      db.rpc('boot_beacons_sweep').then(() => {}, () => {})
    }
  } catch {
    // Записать не вышло — молчим: это ветка про сломанное, и падать ей нельзя.
  }
  return res.status(200).end()
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
  // Сводка по бете Motion. Тоже до проверки метода и токена: доступ у неё по
  // ключу наблюдателя, и 401 «требуется авторизация» ей не подходит — см.
  // порядок веток в шапке файла.
  if (req.query?.action === 'motion-health') return handleMotionHealth(req, res)
  // Счётчик воронки. Тоже до проверки метода и токена: ветка публичная по
  // построению — у гостя, ради которого она заведена, токена нет.
  if (req.query?.action === 'funnel') return handleFunnel(req, res)
  // Маячок невзлетевшей загрузки. Адрес у него БЕЗ строки запроса (/api/boot,
  // реврайт в vercel.json и server.mjs): его шлёт sendBeacon со страницы, у
  // которой ничего не поднялось, и чем короче и стабильнее адрес, тем меньше
  // поводов ему не доехать.
  if (req.query?.action === 'boot') return handleBoot(req, res)

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  /**
   * ДВА ЛИМИТА ВМЕСТО ОДНОГО, И ЭТО НЕ УСЛОЖНЕНИЕ, А ИСПРАВЛЕНИЕ КЛЮЧА.
   *
   * Здесь сходятся почти все записи вошедшего человека: подходы, шаблоны,
   * журнал Motion, ошибки клиента. Раньше на всё это стоял один лимит — 30 в
   * минуту НА АДРЕС. Замер (qa/load.mjs, сценарий «г»): пятьдесят заходов,
   * заканчивающихся одновременно с одного адреса, теряли двадцать журналов из
   * пятидесяти.
   *
   * До токена — грубый заслон по адресу: триста в минуту, то есть полсотни
   * человек по шесть запросов. ЧЕМ ПЛАТИМ: с одного адреса можно заставить
   * сервер триста раз в минуту проверить токен — пять запросов в секунду к
   * своему же GoTrue.
   */
  if (!rateLimit(req, res, { name: 'set-exercise-ip', limit: 300 })) return

  // Личность — только из подписанного токена.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = data.user.id

  /**
   * НАСТОЯЩИЙ ЛИМИТ — ПО ЧЕЛОВЕКУ. Шестьдесят в минуту: тренер, записывающий
   * занятие, ставит подход за подходом, и тридцати ему бывает мало даже одному.
   * ЧЕМ ПЛАТИМ: угнанный аккаунт напишет шестьдесят строк в минуту вместо
   * тридцати. Это по-прежнему потолок, а не свобода, и он больше не зависит от
   * того, кто ещё сидит в той же сети.
   */
  if (!rateLimit(req, res, { name: 'set-exercise', limit: 60, subject: userId })) return

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Fail closed: без ключа ни роль проверить, ни записать. Ошибка громкая.
    reportError('api:set-exercise:config', ['SUPABASE_SERVICE_ROLE_KEY не настроен — управление каталогом невозможно'], { message: 'SUPABASE_SERVICE_ROLE_KEY не настроен (каталог)', status: 500 })
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Ветка обычного пользователя — ВЫШЕ проверки роли (см. порядок веток в
  // шапке файла). Ей нужен вошедший человек, но не тренер: справочник
  // продуктов наполняют те, кто стоит у полки с телефоном.
  if (req.query?.action === 'save-product') {
    return handleSaveProduct(req, res, { supabaseAdmin, userId })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ВЕТКА ?action=log-error: клиент сообщает о своей ошибке.
  //
  // Раньше src/logError.js писал в error_log НАПРЯМУЮ под сессией
  // пользователя. Запись при этом появлялась, но мгновенного сигнала не было:
  // уведомление умеет отправлять только сервер — у него токен бота и права
  // читать журнал целиком. Поэтому клиент теперь стучится сюда, а прямая
  // вставка осталась у него запасным путём на случай, если ручка недоступна.
  //
  // Тоже ветка ОБЫЧНОГО пользователя: стоит выше проверки роли, ниже проверки
  // токена. Аноним сюда не пишет — иначе журнал стал бы открытой свалкой.
  //
  // Свой ключ rate limit и свой лимит: сломанный клиент в цикле перерисовки
  // способен звать это десятки раз в секунду, и такой поток не должен ни
  // выжигать лимит сохранения продуктов, ни забивать журнал.
  // ══════════════════════════════════════════════════════════════════════════
  if (req.query?.action === 'log-error') {
    if (!rateLimit(req, res, { name: 'log-error', limit: 20, subject: userId })) return
    const контекст = cleanText(req.body?.context, 100) || 'ui:unknown'
    await logServerError(контекст, {
      message: req.body?.message,
      status: req.body?.status,
      userId,
    })
    // Тревога ведущему бету. Только контекст и текст ошибки — то же, что уже
    // лежит в error_log; ни user_id, ни адреса, ни содержимого экранов.
    тревога('error', `⚠️ Ошибка у пользователя\n${контекст}\n${cleanText(req.body?.message, 200) || 'без текста'}`)
    // Всегда 200 и пустое тело: клиенту нечего делать с результатом
    // журналирования, а отказ он всё равно проглотит.
    return res.status(200).json({ ok: true })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ВЕТКА ?action=motion-log: телеметрия раздела Motion (тренировка с камерой).
  //
  // Тоже ветка ОБЫЧНОГО пользователя: выше проверки роли, ниже проверки токена.
  // Человек шлёт свой лог под своей учёткой — аноним сюда не пишет.
  //
  // ЛИЧНОСТЬ БЕРЁТСЯ ИЗ ТОКЕНА, а не из тела. Тело приходит с телефона, и любое
  // поле в нём подделывается; user_id оттуда означал бы, что чужую тренировку
  // можно записать на кого угодно.
  //
  // СВОЙ ЛИМИТ ПО userId, а не общий по адресу. Общий даёт тридцать запросов в
  // минуту на IP и делится с тренерскими действиями: две квартиры с телефонами
  // за одним адресом выжгли бы его, и отвалился бы не лог, а работа тренера.
  // Телефон шлёт раз в десять секунд, то есть шесть в минуту; двадцать —
  // запас на срочные отправки при падении клиента.
  //
  // ЧЕГО ЗДЕСЬ НЕТ. Метки камеры и её deviceId: первая почти всегда содержит
  // модель устройства, второй — его устойчивый отпечаток. Клиент их и не шлёт
  // (см. logSafeCamera в src/motion/pose/useCamera.js), но приёмник обязан
  // работать и с сырым телом старой сборки, поэтому чистка стоит и здесь.
  // ══════════════════════════════════════════════════════════════════════════
  if (req.query?.action === 'motion-log') {
    if (!rateLimit(req, res, { name: 'motion-log', limit: 20, subject: userId })) return

    const session = cleanText(req.body?.session, 64) || 'unknown'
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, MOTION_LOG_MAX_LINES) : []
    if (!lines.length) return res.status(200).json({ ok: true })

    const строки = lines.map((line) => motionReportLine(motionLogLine(line)))
    const { error: insErr } = await supabaseAdmin.from('motion_log').insert({
      user_id: userId,
      session,
      payload: { lines: строки },
    })

    /**
     * ЖАЛОБА ЧЕЛОВЕКА — повод для тревоги. Её не отличить от прочего лога ничем,
     * кроме тега: телефон шлёт одну пачку строк, и жалоба приезжает внутри неё.
     *
     * В сообщение идёт САМА СТРОКА — она уже прошла motionLogLine, то есть
     * очищена от метки камеры и deviceId, и содержит только технический снимок
     * (экран, частота, задержка, режим отрисовки, звук). Ровно то, ради чего
     * жалоба и посылается; ничего сверх того, что и так лежит в журнале.
     */
    const жалоба = строки.find((строка) => строка.includes('[user.report]'))
    if (жалоба) {
      /**
       * СЛОВА ЧЕЛОВЕКА ПЕРВЫМИ. Сообщение читают с телефона и по первой строке
       * решают, бросать ли дела: «не начислились очки» решается за секунду,
       * снимок состояния — нет. Техчасть идёт следом и никуда не девается.
       *
       * Из техчасти слова ВЫРЕЗАНЫ. Иначе пятьсот знаков жалобы уезжают дважды —
       * сверху и внутри строки — и съедают потолок сообщения, обрубая как раз
       * снимок, ради которого техчасть и приложена.
       */
      const данные = parseReport(жалоба)
      const текст = cleanNote(данные?.note)
      let тех = жалоба
      if (данные) {
        const прочее = { ...данные }
        delete прочее.note
        тех = JSON.stringify(прочее)
      }
      тревога(
        'user.report',
        `🙋 Жалоба из Motion\n${текст || '(без описания)'}\n\nсессия ${session}\n${тех}`,
      )
    }
    if (insErr) {
      /**
       * Об ошибке говорим в свой журнал, а телефону всё равно отвечаем успехом:
       * получив не-2xx, он выключает отправку до конца сессии (см. logShipper),
       * и одна неудачная вставка стоила бы нам всего остатка тренировки.
       */
      reportError('api:set-exercise:motion-log', ['motion-log: не записано:', insErr], { message: insErr?.message, status: 500, userId })
    }
    return res.status(200).json({ ok: true })
  }

  // ── Дальше только тренерское. Роль читаем из базы service_role-ключом, а не
  // из тела. Всё, что ниже этой черты, обязано оставаться ниже неё.
  const { data: me, error: meErr } = await supabaseAdmin
    .from('profiles').select('role').eq('id', userId).maybeSingle()
  if (meErr) {
    reportError('api:set-exercise:profile', [`set-exercise: ошибка чтения профиля ${userId}:`, meErr], { message: meErr?.message, status: 500, userId: userId })
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
        reportError('api:set-exercise:template', [`set-exercise: ошибка скрытия шаблона «${key}»:`, error], { message: error?.message, status: 500, userId: userId })
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
      reportError('api:set-exercise:template', [`set-exercise: ошибка сохранения шаблона «${key}»:`, error], { message: error?.message, status: 500, userId: userId })
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
      reportError('api:set-exercise:catalog', [`set-exercise: ошибка удаления «${name}»:`, error], { message: error?.message, status: 500, userId: userId })
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
      reportError('api:set-exercise:catalog', [`set-exercise: ошибка сохранения «${name}»:`, error], { message: error?.message, status: 500, userId: userId })
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
      reportError('api:set-exercise:video', [`set-exercise: ошибка снятия видео (${name}/${context}):`, error], { message: error?.message, status: 500, userId: userId })
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
      reportError('api:set-exercise:video', [`set-exercise: ошибка назначения видео (${name}):`, error], { message: error?.message, status: 500, userId: userId })
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
      reportError('api:set-exercise:catalog', [`set-exercise: ошибка сохранения техники «${name}»:`, error], { message: error?.message, status: 500, userId: userId })
      return res.status(500).json({ error: 'Не удалось сохранить технику' })
    }
    console.log(`set-exercise: тренер ${userId} обновил технику «${name}»`)
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'Неизвестное действие' })
}
