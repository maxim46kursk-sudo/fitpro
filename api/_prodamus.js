import crypto from 'node:crypto'

// Общий код Продамуса для серверных функций: подпись (одна на вебхук и на
// создание ссылки) и справочники цен/названий пакетов. Имя файла с
// подчёркиванием — Vercel не делает из таких файлов эндпоинты.

// Цены пакетов (рубли) и человекочитаемые имена. Боевые цены (синхронно с
// src/plans.js: profit 2990, premium 9990, test50 50).
// БАЗА снята с продажи — ключ base убран: ссылку на неё больше не выписываем.
//
// СИНХРОННОСТЬ С src/plans.js ПРОВЕРЯЕТСЯ ТЕСТОМ (test-prodamus.mjs): значения
// перечислены здесь копией, а не импортом из src/, потому что api/ и src/
// собираются раздельно, — и копия, за которой никто не следит, однажды
// разъезжается. Тест сверяет обе таблицы поимённо и падает при расхождении.
//
// test50 — служебный тариф для проверки живой оплаты. Он ЗДЕСЬ, среди
// обычных, намеренно: цена подставляется тем же кодом, подпись считается тем
// же кодом, ссылка строится тем же кодом. Особый путь проверял бы особый путь.
export const PLAN_PRICE = { profit: 2990, premium: 9990, test50: 50 }
export const PLAN_NAME  = { profit: 'ПРОФИТ', premium: 'ПРЕМИУМ', test50: 'ТЕСТ 50' }

// Тарифы, которые вправе купить только тренер. Список здесь, а не в ручке:
// им пользуется и create-payment (отказ не-тренеру), и тест.
export const STAFF_PLANS = new Set(['test50'])

// ── Билет челленджа: ТОВАР, А НЕ ТАРИФ ──────────────────────────────────────
// Разовая покупка места в потоке (sql/2026-08-24_challenge_seasons.sql). Уровня
// доступа она НЕ даёт: в PAID_PLANS ручки create-payment билета нет, plan и
// plan_until вебхук по нему не трогает, оплата превращается в строку
// challenge_entries — и только.
//
// ПОЧЕМУ ОТДЕЛЬНО ОТ PLAN_PRICE, А НЕ ЕЩЁ ОДНИМ КЛЮЧОМ В НЁМ. PLAN_PRICE — это
// зеркало src/plans.js, и test-plan-test50.mjs сверяет его поимённо: каждый
// ключ обязан найтись среди тарифов клиента. Билета там нет и быть не должно,
// поэтому в PLAN_PRICE он сломал бы проверку синхронности, которая стережёт
// настоящие цены.
export const CHALLENGE_ITEM  = 'challenge'
export const CHALLENGE_PRICE = 2990
export const CHALLENGE_TITLE = 'Челлендж FitPro — Поток'

// Всё продаваемое разом: ключ товара → цена в рублях. Тарифы плюс билет.
// Этой таблицей вебхук проверяет ярлык платежа: цена товара из ярлыка обязана
// сойтись с оплаченной суммой (api/prodamus-webhook.js).
export const ITEM_PRICE = { ...PLAN_PRICE, [CHALLENGE_ITEM]: CHALLENGE_PRICE }

// Название товара для чека Продамуса.
export function itemTitle(item) {
  if (item === CHALLENGE_ITEM) return CHALLENGE_TITLE
  return `Подписка FitPro — ${PLAN_NAME[item]}`
}

// ── Куда Продамус вернёт человека после оплаты ──────────────────────────────
// Раньше адрес был один на всех — ссылка на бота. Для того, кто платит из
// браузера и Telegram не пользуется, это тупик В САМЫЙ НЕУДАЧНЫЙ МОМЕНТ: деньги
// уже списаны, а вместо приложения открывается предложение установить
// мессенджер. Поэтому адрес выбирается по источнику платежа.
export const TELEGRAM_RETURN_URL = 'https://t.me/maxim_fitpro_bot'
// Основной адрес приложения. Старый fitpro-dun.vercel.app продолжает работать
// и остаётся в URI_ALLOW_LIST у GoTrue, но возвращать после оплаты человека
// нужно на основной домен.
export const DEFAULT_APP_URL = 'https://fitproapp.ru'

// ГЛАВНОЕ ПРО БЕЗОПАСНОСТЬ: сюда приходит НЕ адрес, а метка источника — 'web'
// либо 'telegram'. Принимать URL из тела запроса нельзя ни в каком виде: он
// попадает в urlSuccess, который мы же и подписываем своим ключом, — то есть
// получился бы открытый редирект на ссылке с нашей подписью. Любое значение,
// кроме точного 'web', трактуется как telegram: неизвестное, пустое,
// отсутствующее, в другом регистре, не строка.
export function returnUrlFor(source, appUrlOverride) {
  if (source !== 'web') return TELEGRAM_RETURN_URL
  const raw = appUrlOverride || process.env.APP_PUBLIC_URL || DEFAULT_APP_URL
  // Опечатка в переменной окружения не должна превращаться в битый возврат
  // после оплаты — молча падаем на заведомо рабочий адрес.
  if (!/^https:\/\/[^\s/]+/.test(raw)) {
    console.error('prodamus: APP_PUBLIC_URL не похож на https-адрес, беру адрес по умолчанию')
    return DEFAULT_APP_URL + '/?paid=1'
  }
  return raw.replace(/\/+$/, '') + '/?paid=1'
}

// Тело платёжной формы. Вынесено сюда целиком (а не только выбор адреса)
// намеренно: проверять надо не «правильный ли адрес выбран», а «ушёл ли этот
// адрес в подпись». Подпись считается по ЭТОМУ объекту, поэтому объект и тест
// обязаны видеть одно и то же. Если urlSuccess вдруг начнут подставлять после
// createSignature, Продамус отклонит ссылку — тест ловит это заранее.
// plan здесь — ключ ТОВАРА: тариф ('profit', 'premium', 'test50') либо билет
// челленджа ('challenge'). Имя параметра осталось прежним, чтобы не разъехаться
// с полем plan, которое присылает клиент и которым подписан ярлык платежа.
export function buildPaymentData({ userId, plan, source }) {
  const price = Object.hasOwn(ITEM_PRICE, plan) ? ITEM_PRICE[plan] : undefined
  // Неизвестный товар — это цена undefined в чеке и платёж, который вебхук
  // потом не опознает. Лучше упасть здесь, чем выписать ссылку в никуда.
  if (price === undefined) throw new Error(`buildPaymentData: неизвестный товар ${plan}`)
  const tag = `${userId}__${plan}`
  const returnUrl = returnUrlFor(source)
  return {
    do: 'pay',
    order_id: tag,
    customer_extra: tag,
    products: [{ name: itemTitle(plan), price: String(price), quantity: '1' }],
    urlSuccess: returnUrl,
    // Кнопка «вернуться в магазин» на форме. Добавлено ДО подписи — иначе
    // поле уехало бы в ссылку неподписанным и Продамус её отклонил.
    urlReturn: returnUrl,
  }
}

// ── Подпись как в официальной библиотеке Prodamus\Hmac (PHP).
// Нормализуем структуру: у объектов ключи сортируем по алфавиту (рекурсивно),
// у массивов порядок элементов сохраняем, но их вложенные объекты тоже
// сортируем; все конечные значения приводим к строке.
function normalizeForSign(value) {
  if (Array.isArray(value)) return value.map(normalizeForSign)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = normalizeForSign(value[key])
    return out
  }
  // null/undefined → пустая строка (в форме таких почти не бывает, но чтобы
  // JSON не получил null вместо "").
  return value == null ? '' : String(value)
}

// Итоговая JSON-строка, по которой считается HMAC. json_encode PHP по
// умолчанию экранирует прямые слэши как \/ (JSON_UNESCAPED_SLASHES не задан),
// а юникод НЕ экранирует (задан JSON_UNESCAPED_UNICODE) — JS не экранирует
// юникод сам, а слэши воспроизводим руками. signature из подписи исключаем.
export function signPayload(data) {
  const clean = { ...data }
  delete clean.signature
  return JSON.stringify(normalizeForSign(clean)).replace(/\//g, '\\/')
}

// HMAC-SHA256(json, secret) в hex. Ровно этот алгоритм уже принят Продамусом
// на входящих уведомлениях — им же подписываем исходящую ссылку.
export function createSignature(data, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(signPayload(data), 'utf8').digest('hex')
}

// Сравнение подписей: регистр к нижнему, длину сверяем до timingSafeEqual
// (он бросает на разной длине), само сравнение — постоянного времени.
export function verifySignature(data, secretKey, provided) {
  if (!provided) return false
  const expected = createSignature(data, secretKey)
  const a = Buffer.from(String(provided).toLowerCase(), 'utf8')
  const b = Buffer.from(expected.toLowerCase(), 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
