// Общая арифметика и валидация карточек продуктов (таблица food_products).
//
// Зачем отдельный модуль: карточку теперь заводят ДВА разных эндпоинта —
// api/set-exercise.js (ветки ?action=barcode и ?action=save-product) и
// api/chat.js (распознавание этикетки по фото). Пределы правдоподобия и разбор
// чисел у них обязаны совпадать бит-в-бит: разъедься они, и в общем справочнике
// оказались бы карточки, прошедшие проверку в одной ручке и не прошедшие в
// другой. Дублировать это в двух файлах — верный способ однажды поправить
// только один.
//
// Имя файла с подчёркиванием — Vercel не делает из таких файлов эндпоинты
// (лимит 12 функций на Hobby у нас выбран целиком), ровно как у _ratelimit.js,
// _access.js и _userTables.js. Новой serverless-функции здесь НЕ появляется.

// Потолки правдоподобия для значений «на 100 г».
// Калорийность: чистый жир — это 900 ккал/100 г, физического способа
// превысить 1000 нет. Макронутриент: больше 100 г в 100 г продукта не
// помещается. Всё, что выше, — мусор (перепутанная единица измерения в
// открытой базе, галлюцинация модели, опечатка в порции), и он не должен
// попасть ни в кэш, ни в дневник: одна такая запись перекосит дневную сумму
// до бессмыслицы.
export const MAX_KCAL100 = 1000
export const MAX_MACRO100 = 100

// Длины текстовых полей. Режем жёстко: и OFF, и модель иногда возвращают в
// поле бренда абзац текста, который потом целиком уедет в название записи
// дневника.
export const MAX_NAME_LEN = 200
export const MAX_BRAND_LEN = 100

// Коэффициент кДж → ккал. В OFF поле energy_100g — это килоджоули.
const KJ_PER_KCAL = 4.184

// ── Источники карточки и их точность ──────────────────────────────────────
//
// В справочнике теперь лежат карточки трёх происхождений, и они НЕ равны по
// достоверности:
//   'off'         — Open Food Facts, сверено сообществом;
//   'ai_photo'    — модель прочитала таблицу пищевой ценности прямо с фото;
//   'ai_estimate' — таблицы в кадре не было, продукт опознан по названию и
//                   обложке, числа взяты из знаний модели. Это ОЦЕНКА.
//
// Первые два считаем точными: их числа привязаны к конкретной упаковке.
// Третий — заглушка, которая лучше пустоты, но обязана уступить дорогу любому
// точному источнику, как только он появится.
export const SOURCE_OFF = 'off'
export const SOURCE_LABEL = 'ai_photo'
export const SOURCE_ESTIMATE = 'ai_estimate'

// basis из ответа модели → source в базе. Клиентскому полю source не доверяем
// вообще: браузер мог бы объявить примерную карточку точной и тем самым
// закрыть её от последующего обновления из OFF. Принимаем только basis, и
// только два его значения.
//
// Отсутствующий/незнакомый basis трактуем как 'label' — тем же умолчанием, что
// и normalizeLabelProduct ниже. Это обратная совместимость: клиент, который
// сейчас в проде, поля basis не шлёт, а его карточки приходят именно от чтения
// таблицы. Умолчания в двух местах обязаны совпадать, иначе одна и та же
// карточка получит разный basis по дороге.
export const basisToSource = basis => (basis === 'estimate' ? SOURCE_ESTIMATE : SOURCE_LABEL)

// Штрих-коды: EAN-8 (8), UPC-E (8), UPC-A (12), EAN-13 (13), ITF-14 (14).
// Только цифры — ни пробелов, ни дефисов, ни ведущего плюса.
export function isValidBarcode(code) {
  return typeof code === 'string' && /^[0-9]{8,14}$/.test(code)
}

// Разбор числа из недоверенного источника. И OFF, и модель присылают одно и то
// же поле то числом, то строкой ("12.5"), то строкой с запятой, то пустой
// строкой.
export function toNumber(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).replace(',', '.').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Отсев неправдоподобного + округление до одного знака.
// Проверка ДО округления: 1000.04 — это уже мусор, а не «ровно потолок».
// Отрицательные отбрасываем целиком, а не поджимаем к нулю: минус в
// калорийности означает сломанные данные, и ноль был бы выдумкой.
export function sanitize(n, max) {
  if (n === null || n < 0 || n > max) return null
  return Math.round(n * 10) / 10
}

// HTML-сущности. В дампе и в базе Open Food Facts названия местами хранятся
// экранированными — «Йогурт &quot;Густой Греческий&quot;». Без раскодирования
// это попадёт в дневник ровно в таком виде и будет мозолить глаза каждый день.
//
// Список короткий и закрытый: раскодируем ровно те сущности, что реально
// встречаются в названиях продуктов. Полноценный HTML-парсер тут не нужен и
// вреден — названия это не разметка, и превращать «&lt;» в рабочий тег мы не
// хотим, только в текст.
const HTML_ENTITIES = {
  '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#039;': "'",
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ',
}
export const decodeEntities = v =>
  String(v ?? '').replace(/&(?:quot|apos|amp|lt|gt|nbsp|#0?39);/g, m => HTML_ENTITIES[m] ?? m)

// Текстовые поля: раскодируем сущности, схлопываем пробелы (модель любит
// переносы строк внутри названия) и режем длину. Пусто → null.
export function cleanText(v, max) {
  const s = decodeEntities(v).replace(/\s+/g, ' ').trim().slice(0, max)
  return s || null
}

// Четыре числа «на 100 г» из произвольного объекта — общий финальный фильтр
// для ЛЮБОГО источника карточки (OFF, модель, тело запроса от клиента).
export function sanitizeMacros(src) {
  return {
    kcal100: sanitize(toNumber(src?.kcal100), MAX_KCAL100),
    p100: sanitize(toNumber(src?.p100), MAX_MACRO100),
    c100: sanitize(toNumber(src?.c100), MAX_MACRO100),
    f100: sanitize(toNumber(src?.f100), MAX_MACRO100),
  }
}

// ── Источник 1: Open Food Facts ────────────────────────────────────────────
// Ответ OFF → наша карточка продукта. Чистая функция, отдельно от сети:
// именно её гоняет test-barcode.mjs на записанных ответах.
// Возвращает null, если брать нечего (нет даже названия).
export function normalizeOffProduct(barcode, product) {
  if (!product || typeof product !== 'object') return null

  // Русское название приоритетнее: в дневнике «Молоко 3.2%» читается лучше,
  // чем «Milk 3.2%», а у российских товаров в OFF заполнены оба поля.
  //
  // Обрезаем ДО выбора, а не после: в OFF полно карточек, где product_name_ru
  // заполнен одними пробелами. Такое поле «истинно» для ||, и наивный
  // `ru || en` выбрал бы пробелы, а потом отбросил карточку целиком — хотя
  // английское название рядом есть.
  const nameRu = cleanText(product.product_name_ru, MAX_NAME_LEN) || ''
  const nameAny = cleanText(product.product_name, MAX_NAME_LEN) || ''
  const rawName = nameRu || nameAny
  if (!rawName) return null

  // brands в OFF — список через запятую ("Простоквашино, Danone"), берём
  // первый: это производитель, остальное обычно владелец марки.
  const brand = cleanText(String(product.brands || '').split(',')[0], MAX_BRAND_LEN)

  const nutr = product.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {}

  // Калорийность: сначала готовое поле в ккал, и только если его нет —
  // пересчёт из килоджоулей. Не наоборот и не «взять оба и сверить»:
  // energy-kcal_100g в OFF заполняют с упаковки, а energy_100g часто
  // досчитан самой базой из макронутриентов.
  const kcalDirect = toNumber(nutr['energy-kcal_100g'])
  const kj = toNumber(nutr['energy_100g'])
  const kcalRaw = kcalDirect !== null ? kcalDirect : (kj !== null ? kj / KJ_PER_KCAL : null)

  return {
    barcode,
    name: rawName.slice(0, MAX_NAME_LEN),
    brand,
    kcal100: sanitize(kcalRaw, MAX_KCAL100),
    p100: sanitize(toNumber(nutr['proteins_100g']), MAX_MACRO100),
    c100: sanitize(toNumber(nutr['carbohydrates_100g']), MAX_MACRO100),
    f100: sanitize(toNumber(nutr['fat_100g']), MAX_MACRO100),
    source: SOURCE_OFF,
  }
}

// ── Источник 2: фото этикетки, распознанное моделью ────────────────────────

// Модель просят отдать голый JSON, но она регулярно оборачивает его в
// ```json … ``` или предваряет фразой «Вот данные:». Достаём первый объект от
// первой { до последней } — это переживает и обёртку, и болтовню вокруг.
// Возвращает null, если объекта в ответе нет вообще.
export function parseModelJson(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Разобранный ответ модели → карточка продукта.
//
// Возвращает null, когда карточки нет: модель прямо сказала, что не разобрала
// ничего (readable:false), или не смогла прочитать название. Без названия
// карточка бесполезна — в общем справочнике её потом не отличить от соседних.
//
// basis — ОТКУДА взялись числа, и это главное новое поле:
//   'label'    — прочитаны с таблицы пищевой ценности в кадре, значения точные;
//   'estimate' — таблицы не было, продукт опознан по названию и обложке, числа
//                взяты из знаний модели. Может прийти вообще без чисел (нишевый
//                товар) — тогда карточка всё равно ценна названием, а КБЖУ
//                впишет человек.
// Отсутствующий/незнакомый basis → 'label': обратная совместимость с тем, что
// сейчас в проде (старый промт умел только читать таблицу). То же умолчание
// продублировано в basisToSource — менять их надо парой.
//
// per — на какой вес модель прочитала числа:
//   '100g'    — как на большинстве российских упаковок, берём как есть;
//   'portion' — на порцию; пересчитываем, если известен её вес, иначе числа
//               выбрасываем (см. ниже);
//   'unknown' — модель не поняла. Берём как есть (по техрегламенту ТР ТС
//               022/2011 пищевая ценность указывается на 100 г, и это
//               подавляющее большинство случаев), но поле per уходит наверх —
//               клиент по нему просит проверить особенно внимательно.
export function normalizeLabelProduct(barcode, raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.readable === false) return null

  const name = cleanText(raw.name, MAX_NAME_LEN)
  if (!name) return null

  const per = ['100g', 'portion', 'unknown'].includes(raw.per) ? raw.per : 'unknown'
  const macros = { kcal100: raw.kcal100, p100: raw.p100, c100: raw.c100, f100: raw.f100 }

  let scaled = macros
  if (per === 'portion') {
    const portionG = toNumber(raw.portion_g)
    if (portionG !== null && portionG > 0) {
      // На 100 г = значение_на_порцию × 100 / вес_порции.
      const k = 100 / portionG
      scaled = {
        kcal100: toNumber(macros.kcal100) === null ? null : toNumber(macros.kcal100) * k,
        p100: toNumber(macros.p100) === null ? null : toNumber(macros.p100) * k,
        c100: toNumber(macros.c100) === null ? null : toNumber(macros.c100) * k,
        f100: toNumber(macros.f100) === null ? null : toNumber(macros.f100) * k,
      }
    } else {
      // Числа на порцию, а вес порции неизвестен — пересчитать НЕЛЬЗЯ.
      // Отдать их как есть было бы худшим из вариантов: они выглядят
      // правдоподобно, молча уедут в общий справочник и будут врать всем
      // следующим. Лучше пустые поля и просьба вписать руками.
      scaled = { kcal100: null, p100: null, c100: null, f100: null }
    }
  }

  return {
    barcode,
    name,
    brand: cleanText(raw.brand, MAX_BRAND_LEN),
    ...sanitizeMacros(scaled),
    per,
    basis: raw.basis === 'estimate' ? 'estimate' : 'label',
  }
}

// ── Строка из базы ─────────────────────────────────────────────────────────
// Строка food_products → та же форма, что отдают нормализаторы выше. Числа
// гоняем через Number: numeric в PostgREST может приехать строкой, и тогда
// клиент молча получил бы "3.2" вместо 3.2 и склеил бы строки при пересчёте
// порции.
export function fromRow(row) {
  const n = v => (v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  return {
    barcode: row.barcode,
    name: row.name,
    brand: row.brand ?? null,
    kcal100: n(row.kcal100),
    p100: n(row.p100),
    c100: n(row.c100),
    f100: n(row.f100),
    // Точность карточки нужна и серверу (решить, идти ли за обновлением в OFF),
    // и клиенту (пометить примерные числа). Старые строки, заведённые до
    // появления колонки, приезжают с дефолтом 'off' — он проставлен в схеме.
    source: row.source ?? null,
  }
}
