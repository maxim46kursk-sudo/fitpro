import crypto from 'node:crypto'

// Общий код Продамуса для серверных функций: подпись (одна на вебхук и на
// создание ссылки) и справочники цен/названий пакетов. Имя файла с
// подчёркиванием — Vercel не делает из таких файлов эндпоинты.

// Цены пакетов (рубли) и человекочитаемые имена. Сейчас это тестовые цены;
// перед боевым запуском синхронизируй с src/plans.js (там TEST_MODE/price).
export const PLAN_PRICE = { base: 50, profit: 60, premium: 70 }
export const PLAN_NAME  = { base: 'БАЗА', profit: 'ПРОФИТ', premium: 'ПРЕМИУМ' }

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
