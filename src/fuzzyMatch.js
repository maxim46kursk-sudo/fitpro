// Нечёткое сравнение названий упражнений — используется в src/ConstructorView.jsx
// (заморожен, см. docs/CONSTRUCTOR_FROZEN.md), чтобы предупредить клиента о
// возможном дубле при создании нового упражнения в его личном списке. Ничего
// не блокирует, только предупреждает.

// Служебные слова, которые не несут смысла для сравнения названий (предлоги,
// союзы) — убираем вместе с цифрами веса, чтобы "присед 20кг" и "присед с
// 25 кг" совпали как одно и то же упражнение.
const STOPWORDS = new Set(['с', 'со', 'на', 'для', 'из', 'и', 'в', 'во', 'по', 'до', 'от', 'у', 'к'])

// Нижний регистр, ё→е (частая орфографическая вариативность — "лёжа"/"лежа"
// должны считаться одним и тем же словом), без цифр/единиц веса, без
// служебных слов, схлопнутые пробелы.
export function normalizeExerciseName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\d+([.,]\d+)?\s*(кг|kg)?/g, ' ')
    .replace(/[×xX*]/g, ' ')
    .replace(/[^a-zа-яё\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w))
    .join(' ')
    .trim()
}

// Слова-антонимы/уточнители варианта упражнения — если в сравниваемых
// названиях встречаются РАЗНЫЕ корни из одной такой группы (например
// "верхнего" в одном названии и "нижнего" в другом), это два разных
// упражнения независимо от того, насколько похожи остальные буквы
// ("тяга верхнего блока"/"тяга нижнего блока" отличаются одним словом и
// проходили бы порог схожести по Левенштейну, но означают разные
// тренажёры). Это жёсткое вето — при конфликте кандидат не считается
// похожим, дальнейшие проверки для него не выполняются.
const ANTONYM_GROUPS = [
  ['верхн', 'нижн'],
  ['сгибан', 'разгибан'],
  ['сидя', 'леж', 'стоя'],
]

function hasAntonymConflict(normA, normB) {
  return ANTONYM_GROUPS.some(group => {
    const rootsA = group.filter(root => normA.includes(root))
    const rootsB = group.filter(root => normB.includes(root))
    return rootsA.some(ra => rootsB.some(rb => rb !== ra))
  })
}

// Сравнивает только начало (длину короче из двух строк) — ловит уменьшительные
// формы с изменением конца слова ("люба"/"любочка": суффикс "-очка" меняет
// не только хвост, но и последнюю гласную основы, поэтому "любочка" не
// начинается буквально с "люба" и обычная проверка на подстроку/префикс их
// не находит; сравнение усечённых до общей длины строк это ловит).
function prefixSimilarity(a, b) {
  const len = Math.min(a.length, b.length)
  if (!len) return 0
  return similarity(a.slice(0, len), b.slice(0, len))
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

// 1 = идентичны после нормализации, 0 = совсем разные.
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length)
  if (!maxLen) return 1
  return 1 - levenshtein(a, b) / maxLen
}

const SIMILARITY_THRESHOLD = 0.72

// Слова-варианты — если КОРОЧЕ название вложено в ДЛИННЕЕ как подмножество
// слов, но "лишние" слова длинного названия — один из этих корней, это не
// уточнение (оборудование/хват), а другой вариант упражнения ("приседания"
// vs "приседания сумо"). Список специально узкий: "широким"/"узким" (хват)
// сюда НЕ входят — "подтягивания"/"подтягивания широким хватом" должны
// считаться одним упражнением (см. контрольные пары).
const DISTINGUISHING_MODIFIERS = ['сумо', 'обратн']

function tokenize(norm) {
  return norm.split(' ').filter(Boolean)
}

// Короче ⊂ длиннее как МНОЖЕСTBO слов (порядок и число слов не важны) — ловит
// "отжимания" ⊂ "отжимания от пола", "жим лежа" ⊂ "жим штанги лежа" и т.п.,
// которые проверка при РАВНОМ числе слов ниже не видит (разное число слов).
// Блокируется, если "лишние" слова длинного названия — различающий вариант
// (DISTINGUISHING_MODIFIERS), а не просто уточнение оборудования/хвата.
function isQualifierSubset(shortTokens, longTokens) {
  if (!shortTokens.length || !shortTokens.every(w => longTokens.includes(w))) return false
  const extra = longTokens.filter(w => !shortTokens.includes(w))
  return !extra.some(w => DISTINGUISHING_MODIFIERS.some(mod => w.includes(mod)))
}

// Ищет в списке существующих упражнений похожее на кандидата. Возвращает
// первую похожую запись или null. Не различает "похоже" и "то же самое" —
// весь смысл именно в мягком предупреждении, а не в точном вердикте.
//
// Проверка на подстроку/префикс (норм. присед ⊂ приседания) и на усечённый
// префикс (люба/любочка) включаются ТОЛЬКО когда оба названия состоят из
// одинакового числа слов — при РАЗНОМ числе слов вместо неё работает
// isQualifierSubset выше (множество слов, а не буквальная подстрока/префикс) —
// так "жим лежа"/"жим штанги лежа" (слово-вставка в середине) тоже matчится,
// а "приседания"/"приседания сумо" по-прежнему нет (лишнее слово — вариант,
// не уточнение).
export function findSimilarExercise(candidateName, existingExercises) {
  const norm = normalizeExerciseName(candidateName)
  if (!norm) return null
  const tokens = tokenize(norm)
  for (const ex of existingExercises) {
    const exNorm = normalizeExerciseName(ex.name)
    if (!exNorm) continue
    if (exNorm === norm) return ex
    if (hasAntonymConflict(norm, exNorm)) continue
    const exTokens = tokenize(exNorm)
    const sameTokenCount = tokens.length === exTokens.length
    if (sameTokenCount && norm.length >= 3 && exNorm.length >= 3) {
      if (exNorm.includes(norm) || norm.includes(exNorm)) return ex
      if (prefixSimilarity(norm, exNorm) >= SIMILARITY_THRESHOLD) return ex
    }
    if (!sameTokenCount) {
      const [shortTokens, longTokens] = tokens.length < exTokens.length ? [tokens, exTokens] : [exTokens, tokens]
      if (isQualifierSubset(shortTokens, longTokens)) return ex
    }
    if (similarity(norm, exNorm) >= SIMILARITY_THRESHOLD) return ex
  }
  return null
}
