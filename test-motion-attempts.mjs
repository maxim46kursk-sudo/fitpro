// test-motion-attempts.mjs — попытка челленджа и сид трассы.
//
// ДВЕ ДЫРЫ, ради которых написан этот набор, обе видны в боевом журнале беты.
//
//   1. ПРОГРЕСС НЕ СОХРАНЯЛСЯ ВООБЩЕ. Попытка записывалась только на фазе done,
//      то есть после семи кругов целиком. За неделю беты `session.end` не
//      случился ни разу: люди играют шесть-десять минут, берут по сотне мишеней
//      и выходят — и в базе от них ноль строк. Теперь заход закрывается попыткой
//      при любом исходе, а «день сдан» остаётся строго за полным прохождением:
//      там деньги, и этот смысл не меняется.
//
//   2. ТРАССА БЫЛА ОДНА И ТА ЖЕ. Сид считался из «сколько попыток записано», а
//      записано было ноль — значит номер всегда единица. В журнале `attempt:1`
//      у всех, всегда, и одинаковая последовательность мишеней: elbow, elbow,
//      foot, palm… Плюс номера круга в сиде не было вовсе, поэтому все семь боёв
//      одной сессии шли по одной трассе.
//
// Здесь проверяется чистая часть — хранилище попыток и сид (src/motion/game/day.js).
// Поведение экрана (что попытка закрывается на выходе и на уходе со страницы)
// проверяет SessionScreen.test.jsx: там нужен React, а тут его нет.
//
// Запуск: node test-motion-attempts.mjs

// ── Хранилище устройства для node ──────────────────────────────────────────
function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
  }
}
globalThis.localStorage = makeStorage()

const day = await import('./src/motion/game/day.js')
const {
  MAX_ATTEMPTS, attemptSeed, attemptsUsed, closePending, dropPending,
  holdAttempt, pendingAttempt, resetDay, startAttempt, startedCount, submitAttempt,
} = day

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`)
}
const reset = () => { globalThis.localStorage = makeStorage(); resetDay() }

/** Статистика захода, как её собирает сессия. */
const заход = (score, extra = {}) => ({ score, reps: 0, hits: 0, spawned: 0, reactMs: 0, ...extra })

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Попытка переживает любой уход ─────────────────────────────────')
{
  // ГЛАВНЫЙ ТЕСТ. Человек бросил сессию на середине — черновик закрывается
  // попыткой. Раньше здесь не записывалось НИЧЕГО.
  reset()
  holdAttempt('pro', заход(4200, { hits: 51, spawned: 58 }), 1)
  const итог = closePending()
  report('брошенный заход стал попыткой', !!итог?.recorded)
  eq('счёт сохранён', итог?.score, 4200)
  eq('и попытка видна в дне', attemptsUsed('pro', 1), 1)
}
{
  // Черновик переписывается по ходу сессии: закрыть должно ПОСЛЕДНИЙ.
  reset()
  holdAttempt('pro', заход(1000), 1)
  holdAttempt('pro', заход(2000), 1)
  holdAttempt('pro', заход(3000), 1)
  eq('закрывается последнее состояние', closePending()?.score, 3000)
  eq('попытка при этом ровно одна', attemptsUsed('pro', 1), 1)
}
{
  // ДУБЛЕЙ НЕТ. Закрытие зовётся и с кнопки выхода, и при следующем открытии
  // раздела — второй раз закрывать нечего.
  reset()
  holdAttempt('pro', заход(500), 1)
  closePending()
  report('второе закрытие ничего не пишет', closePending() === null)
  eq('попытка осталась одна', attemptsUsed('pro', 1), 1)
}
{
  // Пустой заход попыткой не становится: открыл, посмотрел, вышел — не повод
  // сжечь одну из трёх попыток дня.
  reset()
  holdAttempt('pro', заход(0), 1)
  report('пустой заход не записан', closePending() === null)
  eq('попыток по-прежнему ноль', attemptsUsed('pro', 1), 0)
}
{
  // Но заход, где были повторы силового блока и не было очков, — записывается.
  reset()
  holdAttempt('pro', заход(0, { reps: 12 }), 1)
  report('заход с повторами записан', !!closePending()?.recorded)
}
{
  // Отменённый черновик не воскресает.
  reset()
  holdAttempt('pro', заход(900), 1)
  dropPending()
  report('снятый черновик не закрывается', closePending() === null)
  report('и его больше нет', pendingAttempt() === null)
}
{
  // Черновик переживает «перезагрузку»: он лежит в том же хранилище.
  reset()
  holdAttempt('pro', заход(1500), 3)
  const p = pendingAttempt()
  eq('черновик помнит день', p?.day, 3)
  eq('черновик помнит уровень', p?.tier, 'pro')
  eq('черновик помнит счёт', p?.stats?.score, 1500)
}
{
  // Потолок в три попытки за день остаётся потолком.
  reset()
  for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
    holdAttempt('pro', заход(100 + i), 1)
    closePending()
  }
  eq('больше трёх попыток за день не ложится', attemptsUsed('pro', 1), MAX_ATTEMPTS)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Номер захода растёт даже у брошенных ──────────────────────────')
{
  // Счётчик на СТАРТЕ: иначе брошенный заход не менял бы трассу следующего.
  reset()
  eq('первый заход', startAttempt('pro', 1), 1)
  eq('второй — даже если первый бросили без записи', startAttempt('pro', 1), 2)
  eq('третий', startAttempt('pro', 1), 3)
  eq('записанных попыток при этом ноль', attemptsUsed('pro', 1), 0)
}
{
  // У каждого уровня и каждого дня свой счёт.
  reset()
  startAttempt('pro', 1); startAttempt('pro', 1)
  eq('другой уровень считает с нуля', startAttempt('novice', 1), 1)
  eq('другой день тоже', startAttempt('pro', 2), 1)
  eq('а свой продолжает', startAttempt('pro', 1), 3)
}
{
  // Счётчик потерялся (чужое устройство, чистка кэша), а попытки есть —
  // отставать от них он не имеет права, иначе трасса повторится.
  reset()
  submitAttempt('pro', заход(100), 1)
  submitAttempt('pro', заход(200), 1)
  eq('счётчик догоняет записанное', startedCount('pro', 1), 2)
  eq('следующий заход — третий', startAttempt('pro', 1), 3)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Трасса: одна у всех, разная у попыток и кругов ────────────────')
{
  // ЧЕСТНОЕ СРАВНЕНИЕ. День, уровень, попытка, круг совпали — трасса та же.
  eq('одинаковые условия — одинаковая трасса',
    attemptSeed('pro', 2, 5, 3), attemptSeed('pro', 2, 5, 3))
}
{
  // ГЛАВНЫЙ ТЕСТ ПУНКТА. Семь боёв одной сессии обязаны быть разными.
  const круги = new Set([0, 1, 2, 3, 4, 5, 6].map(c => attemptSeed('pro', 1, 1, c)))
  eq('семь кругов — семь разных трасс', круги.size, 7)
}
{
  const попытки = new Set([1, 2, 3].map(a => attemptSeed('pro', a, 1, 0)))
  eq('три попытки — три разные трассы', попытки.size, 3)
}
{
  const дни = new Set([1, 2, 3, 4, 5].map(d => attemptSeed('pro', 1, d, 0)))
  eq('пять дней — пять разных трасс', дни.size, 5)
  const уровни = new Set(['novice', 'experienced', 'pro'].map(t => attemptSeed(t, 1, 1, 0)))
  eq('три уровня — три разные трассы', уровни.size, 3)
}
{
  // Сид никогда не ноль: движок понимает ноль как «сид не задан».
  let нули = 0
  for (let d = 1; d <= 30; d += 1) {
    for (const t of ['novice', 'experienced', 'pro']) {
      for (let a = 1; a <= 3; a += 1) {
        for (let c = 0; c <= 6; c += 1) if (!attemptSeed(t, a, d, c)) нули += 1
      }
    }
  }
  eq('ни одного нулевого сида на всём челлендже', нули, 0)
}
{
  // Круг по умолчанию — ноль: одиночный бой по ?round=1 кругов не имеет.
  eq('без круга сид определён', attemptSeed('pro', 1, 1), attemptSeed('pro', 1, 1, 0))
}

console.log('\n' + '─'.repeat(68))
console.log(`Итог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
