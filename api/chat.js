import { createClient } from '@supabase/supabase-js'
import { effectiveLevel, AI_MIN_LEVEL } from './_access.js'
import { rateLimit } from './_ratelimit.js'
// Разбор ответа модели про этикетку — общий код с api/set-exercise.js, где
// живёт справочник food_products. Пределы правдоподобия должны совпадать в
// обеих ручках. Файл с подчёркиванием — не serverless-функция.
import { parseModelJson, normalizeLabelProduct, isValidBarcode } from './_foodProduct.js'

// Потолок времени выполнения функции. Без него Vercel рубит ответ по короткому
// дефолту, и длинные ответы модели просто обрываются на полуслове. 60 секунд —
// максимум плана Hobby.
export const maxDuration = 60

// Серверный клиент Supabase — проверка токена (auth.getUser) и, ниже, чтение
// пакета пользователя service_role-ключом. Тот же env и те же безопасные
// fallback-значения (URL и publishable-ключ несекретны), что и у клиента
// (src/supabase.js) — без fallback createClient падает сразу при холодном
// старте, если переменная почему-то не долетела до серверной функции.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Модель и потолок длины ответа задаём здесь, а не берём из тела запроса —
// иначе анонимный клиент мог бы заказать любую доступную по ключу модель
// или огромный max_tokens за наш счёт. 4096 — с запасом над тем, что реально
// шлёт клиент (3000 для тренировок, 1000 для питания, см. AIAssistant.jsx).
const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS_CEILING = 4096

// На 5 секунд меньше maxDuration — чтобы успеть отдать клиенту осмысленный 503,
// а не быть убитыми платформой посреди ответа.
const ANTHROPIC_TIMEOUT_MS = 55_000

// ══════════════════════════════════════════════════════════════════════════
// РЕЖИМ type:'food_label' — распознавание этикетки продукта по фотографии.
//
// Зачем: сканер штрих-кода (src/BarcodeScanner.jsx) упирается в то, что в Open
// Food Facts нет доброй половины российских товаров. Вместо тупика «продукт не
// найден» предлагаем сфотографировать упаковку: модель читает таблицу
// пищевой ценности, человек проверяет числа глазами и подтверждает — карточка
// уходит в ОБЩИЙ справочник food_products (api/set-exercise.js,
// ?action=save-product), и следующему она достанется уже по одному скану.
//
// Режим живёт здесь, а не в своей ручке, по той же причине, что и ветки
// справочника в set-exercise.js: лимит 12 serverless-функций Vercel Hobby
// выбран целиком. Доступ, гейт по пакету и дневной лимит — ОБЩИЕ с обычным
// чатом, специально не отдельные: это тот же расход нашего ключа Anthropic.
// ══════════════════════════════════════════════════════════════════════════

// Потолок размера фото в base64. 1.5 МБ base64 — это примерно 1.1 МБ
// исходного jpeg, чего с запасом хватает на кадр 1280px/q0.8, который шлёт
// клиент. Больше — почти наверняка несжатый оригинал с камеры на 4–8 МБ: он и
// в лимит тела Vercel (4.5 МБ) упрётся, и денег за токены стоит заметно
// дороже без выигрыша в читаемости.
const LABEL_MAX_BASE64 = 1_500_000

// Квоты на распознавание. Режим открыт ВСЕМ вошедшим (в отличие от чата,
// который живёт с ПРОФИТа) — смысл затеи в том, чтобы общий справочник
// продуктов наполняли все, а пользуются им тоже все. Но платит за vision-запрос
// наш ключ Anthropic, поэтому бесплатному тарифу — узкая суточная квота, а
// платному — широкая почасовая.
//
// Разные механизмы под разные горизонты, и это не случайность:
//  • СУТОЧНЫЕ квоты обоих тарифов живут в Postgres (incr_feature_usage), потому
//    что в памяти инстанса они бы обнулялись на каждом холодном старте;
//  • почасовой потолок платных — in-memory _ratelimit.js: он гасит всплеск
//    «зажал кнопку», а точный учёт там не нужен.
//
// Зачем платным ЕЩЁ и суточный потолок поверх почасового: 20 в час — это до
// 480 снимков в сутки, а почасовой счётчик вдобавок мягче номинала (своя Map у
// каждого живого инстанса). Сотня в день — страховка от того, что один аккаунт
// за ночь выпишет нам счёт за vision-запросы; живой сценарий «разбираю
// покупки» до неё не дотягивается и близко.
const FREE_LABELS_PER_DAY = 3
const PAID_LABELS_PER_HOUR = 20
const PAID_LABELS_PER_DAY = 100

// Признак в теле 429, по которому клиент выбирает формулировку. Три разных
// исчерпания — три разных совета, и путать их нельзя:
//  • free_daily_limit — бесплатному раньше завтра ничего не поможет, кроме
//    ПРОФИТа, и сказать надо именно это;
//  • daily_limit — платному тоже ждать до завтра, но продавать ему нечего;
//  • признака нет вовсе — упёрлись в почасовой потолок, через час отпустит.
const REASON_FREE_DAILY = 'free_daily_limit'
const REASON_DAILY = 'daily_limit'

// Ответ короткий и строго структурный — потолок токенов маленький.
const LABEL_MAX_TOKENS = 512

// Промт вынесен в константу, а не собирается из тела запроса: клиент не должен
// иметь возможности подменить инструкцию и превратить режим в дешёвый
// произвольный vision-прокси.
const LABEL_PROMPT = `На фото — упаковка продукта питания. Это может быть ЛЮБАЯ сторона упаковки: лицевая с названием или обратная с таблицей пищевой ценности.

Ответь СТРОГО одним JSON-объектом, без markdown-обёртки и без пояснений:
{"name": string, "brand": string|null, "kcal100": number|null, "p100": number|null, "c100": number|null, "f100": number|null, "per": "100g"|"portion"|"unknown", "portion_g": number|null, "basis": "label"|"estimate", "readable": true|false}

Действуй по порядку:

1. ЕСЛИ в кадре видна и читается таблица пищевой ценности — возьми точные значения из неё и верни basis="label".

2. ЕСЛИ таблицы в кадре нет или её не разобрать, НО продукт узнаётся по названию, марке, оформлению упаковки — верни название и марку, а КБЖУ дай ТИПИЧНЫЕ для ИМЕННО ЭТОГО продукта из своих знаний, basis="estimate".
   - Оценивай конкретный товар, а не категорию: для «Активиа черника 2.9%» — значения этого йогурта, а не «йогурта вообще». Учитывай жирность и вариант, если они написаны на упаковке.
   - Если продукт слишком нишевый и уверенных значений нет — оставь kcal100/p100/c100/f100 равными null, но название и марку всё равно верни, basis="estimate". Числа впишет человек.

3. readable=false — ТОЛЬКО если не удалось разобрать даже название продукта (кадр размыт, упаковки в кадре нет, снят посторонний предмет).

Поля:
- name — название продукта в формате «Название вариант/жирность», с большой буквы, без КАПСА, без слов «БЗМЖ», «ГОСТ», «новинка», без рекламных фраз. Пример: «Творог 5%», «Молоко ультрапастеризованное 3.2%».
- brand — торговая марка отдельно от названия («Простоквашино», «Домик в деревне»). Если марки не видно — null.
- kcal100/p100/c100/f100 — калорийность (ккал), белки, углеводы, жиры (граммы).
- per — на какой вес приведены числа: "100g" — на 100 г продукта, "portion" — на порцию/упаковку, "unknown" — не указано. При basis="estimate" давай значения на 100 г и per="100g".
- portion_g — вес порции в граммах, если per="portion" и вес указан. Иначе null.
- При basis="label" числа приводи как есть с этикетки, НИЧЕГО не пересчитывай сам.`

// Разбор и проверка входа — ОТДЕЛЬНО от самого распознавания, потому что
// вызывается РАНЬШЕ учёта квоты. Иначе кривой запрос (нет фото, битый
// штрих-код) сжигал бы бесплатному пользователю одну из трёх суточных попыток,
// ничего ему не дав.
// Возвращает либо {status, error} — ответить и выйти, либо {barcode, image}.
function parseLabelInput(req) {
  const barcode = String(req.body?.barcode ?? '').trim()
  if (!isValidBarcode(barcode)) {
    return { status: 400, error: 'Штрих-код должен состоять из 8–14 цифр' }
  }

  // data:image/jpeg;base64,XXXX — клиент может прислать с префиксом (так
  // отдаёт canvas.toDataURL), Anthropic ждёт голый base64.
  const rawImage = typeof req.body?.image === 'string' ? req.body.image : ''
  const image = rawImage.includes(',') ? rawImage.slice(rawImage.indexOf(',') + 1) : rawImage
  if (!image) return { status: 400, error: 'Не приложено фото' }
  if (image.length > LABEL_MAX_BASE64) {
    // 413, а не 400: клиент по этому коду понимает, что дело именно в размере,
    // и может пережать кадр, а не сдаваться.
    return { status: 413, error: 'Фото слишком большое, пересними' }
  }
  return { barcode, image }
}

async function handleFoodLabel(req, res, { userId, barcode, image }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)
  let responseData
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: LABEL_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: LABEL_PROMPT },
          ],
        }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error(`Этикетка ${barcode} (${userId}): Anthropic ответил ${response.status}: ${detail.slice(0, 300)}`)
      return res.status(503).json({ error: 'Распознавание сейчас недоступно, попробуй ещё раз через минуту' })
    }
    responseData = await response.json()
  } catch (err) {
    console.error(`Этикетка ${barcode} (${userId}): запрос к Anthropic не удался:`, err)
    return res.status(503).json({ error: 'Распознавание сейчас недоступно, попробуй ещё раз через минуту' })
  } finally {
    clearTimeout(timeoutId)
  }

  // Текст ответа. Модель отвечает блоками; берём первый текстовый.
  const text = Array.isArray(responseData?.content)
    ? (responseData.content.find(b => b?.type === 'text')?.text || '')
    : ''
  const parsed = parseModelJson(text)

  // ВАЛИДИРУЕМ ОТВЕТ МОДЕЛИ КАК ЛЮБОЙ ДРУГОЙ НЕДОВЕРЕННЫЙ ВВОД. Модель может
  // выдать 5400 ккал/100 г, отрицательный белок или JSON не той формы — эти
  // числа поедут в ОБЩИЙ справочник, из которого их потом будут брать все.
  const product = normalizeLabelProduct(barcode, parsed)
  if (!product) {
    // Один ответ на три случая — модель не разобрала ничего, названия нет,
    // вернула не JSON: пользователю во всех трёх нужно ровно одно и то же —
    // переснять упаковку целиком.
    console.log(`Этикетка ${barcode} (${userId}): не разобрана (readable/name/JSON)`)
    return res.status(200).json({ ok: false, reason: 'unreadable' })
  }

  console.log(`Этикетка ${barcode} (${userId}): распознано «${product.name}», basis=${product.basis}, per=${product.per}`)
  return res.status(200).json({ ok: true, product })
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!rateLimit(req, res, { name: 'chat', limit: 12 })) return

  // Без валидного Supabase-токена — эндпоинт был открытым анонимным прокси
  // к Anthropic на нашем ключе (любой посторонний мог гонять запросы за наш
  // счёт). Авторизация обязательна ДО обращения к Anthropic.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const { data, error: authError } = await supabase.auth.getUser(token)
  if (authError || !data?.user) return res.status(401).json({ error: 'Требуется авторизация' })

  // ── Гейт по пакету. Клиентской блокировки (AIAssistant.jsx) недостаточно:
  // без этой проверки любой авторизованный пользователь дёргает /api/chat
  // напрямую и гоняет Anthropic за наш счёт в обход тарифа.
  //
  // Профиль читаем service_role-ключом: под RLS анонимный клиент чужую строку
  // не увидит, а нам нужен гарантированный ответ по id из токена.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    // Fail closed: без ключа уровень не проверить, а пускать всех к платной
    // функции нельзя. Ошибка громкая — чинится настройкой переменной.
    console.error('SUPABASE_SERVICE_ROLE_KEY не настроен — проверка пакета невозможна')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('plan, plan_until, trial_until, role')
    .eq('id', data.user.id)
    .maybeSingle()
  if (profileError) {
    console.error(`ИИ-ассистент ${data.user.id}: ошибка чтения пакета:`, profileError)
    return res.status(500).json({ error: 'Не удалось проверить доступ' })
  }
  const isFoodLabel = req.body?.type === 'food_label'
  const level = effectiveLevel(profile)

  // Гейт по пакету — ТОЛЬКО для обычного чата. Распознавание этикетки открыто
  // всем вошедшим: общий справочник продуктов наполняют все, и пользуются им
  // тоже все, так что запирать сбор данных за тариф — стрелять себе в ногу.
  // Расход при этом ограничен квотами ниже, а не тарифом.
  if (!isFoodLabel && level < AI_MIN_LEVEL) {
    return res.status(403).json({ error: 'ИИ-ассистент доступен в пакете ПРОФИТ' })
  }

  // Дата по МСК (UTC+3) — общая для обоих суточных счётчиков.
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  const today = `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}-${pad(msk.getUTCDate())}`

  // ── Ветка распознавания этикетки: свой вход, свои квоты, СВОЙ счётчик.
  // Ключевое: incr_ai_usage тут не вызывается вовсе — разобранные этикетки
  // больше не съедают дневной лимит реплик ассистента (и наоборот).
  if (isFoodLabel) {
    // Проверка входа ДО учёта квоты: кривой запрос не должен стоить
    // бесплатному пользователю одной из трёх суточных попыток.
    const input = parseLabelInput(req)
    if (input.error) return res.status(input.status).json({ error: input.error })

    const paid = level >= AI_MIN_LEVEL

    // Платному — сначала почасовой потолок. Он in-memory, то есть бесплатный
    // по стоимости: упёршись в него, до базы не идём вовсе. Считаем ПО
    // ПОЛЬЗОВАТЕЛЮ (id из подписанного токена), а не по IP — за одним
    // оператором связи сидят сотни людей, и IP-лимит бил бы по чужим.
    if (paid && !rateLimit(req, res, { name: 'food-label', limit: PAID_LABELS_PER_HOUR, windowMs: 3_600_000, subject: data.user.id })) return

    // Суточная квота — у обоих тарифов, различается только потолком. Живёт в
    // базе (см. sql/2026-08-05_feature_usage.sql). Инкремент атомарный;
    // считаем и отклонённые попытки — иначе подбором можно было бы крутить
    // счётчик бесконечно, ничего не тратя.
    //
    // Счётчик у тарифов ОБЩИЙ (один kind), и это осознанно: если тариф истёк
    // посреди дня, уже потраченные за сегодня снимки продолжают считаться —
    // человек не получает свежие три штуки сверх сотни, которую уже разобрал.
    // В обратную сторону так же: доплатив днём, он не обнуляет расход.
    const { data: used, error: usageError } = await supabaseAdmin
      .rpc('incr_feature_usage', { uid: data.user.id, d: today, k: 'food_label' })
    if (usageError) {
      // Fail closed, как и у дневного лимита чата ниже: без учёта квота не
      // держится, а за каждый снимок платим мы. Молча пускать нельзя.
      console.error(`Этикетка ${data.user.id}: ошибка учёта суточной квоты:`, usageError)
      return res.status(500).json({ error: 'Не удалось проверить лимит' })
    }
    if (used > (paid ? PAID_LABELS_PER_DAY : FREE_LABELS_PER_DAY)) {
      return res.status(429).json(paid
        ? { error: 'Дневной лимит фото исчерпан, продолжим завтра', reason: REASON_DAILY }
        : { error: `Лимит ${FREE_LABELS_PER_DAY} фото в день исчерпан`, reason: REASON_FREE_DAILY })
    }

    // Распознавание собирает запрос к модели само (свой промт, картинка вместо
    // истории переписки) и наружу отдаёт не сырой ответ Anthropic, а
    // разобранную и проверенную карточку.
    return handleFoodLabel(req, res, { userId: data.user.id, barcode: input.barcode, image: input.image })
  }

  // ── Дальше только обычный чат. Ниже ничего не менялось.
  // Анти-абьюз: ручку нельзя использовать как безлимитный LLM-прокси.
  // 1) Ограничение размера входа: суммарная длина content всех messages.
  const msgsForSize = Array.isArray(req.body?.messages) ? req.body.messages : []
  const inputChars = msgsForSize.reduce((sum, m) => {
    const c = m?.content
    if (typeof c === 'string') return sum + c.length
    if (Array.isArray(c)) return sum + c.reduce((s, b) => s + (typeof b?.text === 'string' ? b.text.length : 0), 0)
    return sum
  }, 0)
  if (inputChars > 16000) return res.status(400).json({ error: 'Слишком длинный запрос' })

  // 2) Пер-юзер дневной лимит по дате МСК. Инкремент атомарный через
  // security-definer RPC; считаем и отклонённые лимитом попытки.
  const { data: usageCount, error: usageError } = await supabaseAdmin.rpc('incr_ai_usage', { uid: data.user.id, d: today })
  if (usageError) {
    console.error(`ИИ-ассистент ${data.user.id}: ошибка учёта лимита:`, usageError)
    return res.status(500).json({ error: 'Не удалось проверить лимит' })
  }
  if (usageCount > 40) {
    return res.status(429).json({ error: 'Достигнут дневной лимит запросов к ассистенту, попробуйте завтра' })
  }

  // Тело клиента не прокидываем целиком — только system/messages, реально
  // нужные для ответа. model и max_tokens задаём/клампим сами (см. выше).
  const { system, messages } = req.body || {}
  const maxTokens = Math.min(Number(req.body?.max_tokens) || 2048, MAX_TOKENS_CEILING)

  // Свой таймаут чуть меньше maxDuration: если Anthropic отвечает слишком долго
  // или сеть залипла, лучше вернуть внятную ошибку самим, чем дать платформе
  // прибить функцию и отдать клиенту пустой обрыв соединения.
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
      signal: controller.signal
    })
    const responseData = await response.json()
    res.status(response.status).json(responseData)
  } catch (err) {
    console.error(`ИИ-ассистент ${data.user.id}: запрос к Anthropic не удался:`, err)
    res.status(503).json({ error: 'ИИ-ассистент сейчас перегружен, попробуй ещё раз через минуту' })
  } finally {
    clearTimeout(timeoutId)
  }
}
