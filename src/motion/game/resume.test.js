import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * НЕЗАВЕРШЁННАЯ СЕССИЯ: СНИМОК И ПРОДОЛЖЕНИЕ.
 *
 * Сессия идёт двадцать минут, и люди выходят из неё на третьем круге —
 * зазвонил телефон, позвали, кончилось время. Попытка их результат уже
 * переживала (черновик), а вот ПОЗИЦИЯ терялась: вернуться было некуда, только
 * начинать заново, тратя вторую попытку на то, что уже сделано.
 *
 * Проверяется четыре обещания, и каждое можно нарушить по-своему:
 *
 *   снимок есть   — иначе продолжать нечего;
 *   попытка та же — иначе продолжение стоит человеку второй попытки из трёх;
 *   трасса та же  — иначе продолженный круг отличается от непрерывного, и
 *                   выход из сессии превращается в способ подобрать мишени;
 *   пустое не в счёт — открыл, посмотрел, вышел: предлагать ему завтра
 *                   «продолжить» ничто было бы враньём.
 */

function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

/** Накопленное за три круга — то, что кладёт SessionScreen. */
const totalsAfter = (cycles, score) => ({
  score,
  strength: Array.from({ length: cycles }, (_, i) => ({ movement: `m${i}`, reps: 8 })),
  fights: Array.from({ length: cycles }, () => ({ cleared: 20, score: 1000 })),
  hits: cycles * 20,
  spawned: cycles * 30,
  reactSum: cycles * 8000,
  reactCount: cycles * 20,
})

describe('снимок незавершённой сессии', () => {
  let day

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    day = await import('./day.js')
  })

  it('выход на третьем круге: снимок есть, попытка одна', () => {
    const attempt = day.startAttempt('pro', 1)
    expect(attempt).toBe(1)
    day.holdAttempt('pro', { score: 3000 }, 1)
    day.holdSession('pro', { cycle: 3, attempt, runs: 1, totals: totalsAfter(3, 3000) }, 1)

    const snap = day.sessionResume(1)
    expect(snap).toBeTruthy()
    expect(snap.cycle).toBe(3)
    expect(snap.attempt).toBe(1)
    expect(snap.tier).toBe('pro')
    expect(snap.totals.score).toBe(3000)
    // попытка ещё НЕ записана: заход не закончен, черновик жив
    expect(day.attemptsUsed('pro', 1)).toBe(0)
    expect(day.pendingAttempt()).toBeTruthy()
    expect(day.hasSessionResume(1)).toBe(true)
  })

  it('пустой выход снимком не становится', () => {
    day.startAttempt('pro', 1)
    day.holdSession('pro', { cycle: 1, attempt: 1, runs: 1, totals: totalsAfter(0, 0) }, 1)

    expect(day.sessionResume(1)).toBe(null)
    expect(day.hasSessionResume(1)).toBe(false)
  })

  it('снимок чужого дня не отдаётся: он не должен тянуть назад по челленджу', () => {
    day.holdSession('pro', { cycle: 3, attempt: 1, runs: 1, totals: totalsAfter(3, 3000) }, 5)

    expect(day.sessionResume(5)).toBeTruthy()
    expect(day.sessionResume(6)).toBe(null)
  })

  it('«Начать заново»: прошлый заход закрывается попыткой, снимок уходит', () => {
    const attempt = day.startAttempt('pro', 1)
    day.holdAttempt('pro', { score: 3000, reps: 24 }, 1)
    day.holdSession('pro', { cycle: 3, attempt, runs: 1, totals: totalsAfter(3, 3000) }, 1)

    // ровно то, что делает кнопка на выборе уровня
    const closed = day.closePending()
    day.dropSession()

    expect(closed?.recorded).toBe(true)
    expect(closed.score).toBe(3000)
    expect(day.attemptsUsed('pro', 1)).toBe(1)
    expect(day.sessionResume(1)).toBe(null)
    // новая сессия — новая попытка
    expect(day.startAttempt('pro', 1)).toBe(2)
  })

  it('ПРОДОЛЖЕНИЕ НЕ ТРАТИТ ПОПЫТКУ: заход тот же, просто разорванный', () => {
    const attempt = day.startAttempt('pro', 1)
    day.holdAttempt('pro', { score: 3000 }, 1)
    day.holdSession('pro', { cycle: 3, attempt, runs: 1, totals: totalsAfter(3, 3000) }, 1)

    // SessionScreen при resume НЕ зовёт ни closePending, ни startAttempt
    const snap = day.sessionResume(1)
    expect(snap.attempt).toBe(attempt)
    expect(day.attemptsUsed('pro', 1)).toBe(0)
    // черновик жив — он и есть незакрытая попытка этого захода
    expect(day.pendingAttempt()?.stats.score).toBe(3000)

    // дошёл до конца со второго захода
    day.holdAttempt('pro', { score: 9000 }, 1)
    const closed = day.closePending()
    day.dropSession()

    expect(closed.recorded).toBe(true)
    expect(closed.attempt).toBe(1)
    expect(day.attemptsUsed('pro', 1)).toBe(1)
    expect(day.bestFor('pro', 1)).toBe(9000)
  })
})

describe('трасса продолженной сессии', () => {
  let day

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    day = await import('./day.js')
  })

  /**
   * Главное свойство продолжения: круг k+1 обязан дать те же мишени, что дал бы
   * без выхода. Иначе выход из сессии становится способом перебрать трассу —
   * а на кону призы.
   */
  it('круг k+1 той же попытки даёт тот же сид, что и непрерывное прохождение', () => {
    const непрерывно = []
    for (let cycle = 0; cycle < 7; cycle += 1) непрерывно.push(day.attemptSeed('pro', 1, 4, cycle))

    // вышли на третьем круге и продолжили: попытка та же, день тот же
    const snap = { attempt: 1, day: 4 }
    const продолжив = []
    for (let cycle = 3; cycle < 7; cycle += 1) {
      продолжив.push(day.attemptSeed('pro', snap.attempt, snap.day, cycle))
    }

    expect(продолжив).toEqual(непрерывно.slice(3))
  })

  it('а новая попытка даёт ДРУГУЮ трассу — иначе «начать заново» было бы заучиванием', () => {
    const перваяПопытка = day.attemptSeed('pro', 1, 4, 3)
    const втораяПопытка = day.attemptSeed('pro', 2, 4, 3)
    expect(втораяПопытка).not.toBe(перваяПопытка)
  })
})

describe('с какого места продолжается сессия', () => {
  /**
   * Правило: продолжаем с НАЧАЛА следующего круга. Круг, брошенный на середине,
   * доигранным не считается и переигрывать его человек не обязан — силы на него
   * уже потрачены, а счёт за него в снимке.
   *
   * Индекс ищется по расписанию, а не арифметикой «плюс четыре фазы»: длина
   * круга зависит от плана дня (разгрузка, восьмой круг на тяжёлых днях), и
   * арифметика разошлась бы с расписанием на первом же таком дне.
   */
  const startIndexOf = (phases, cycleLeftOn) => {
    const i = phases.findIndex((p) => p.kind === 'strength' && (p.cycle ?? 0) + 1 === cycleLeftOn + 1)
    return i >= 0 ? i : 0
  }

  it('вышел на круге 3 — продолжаем с силового блока круга 4', async () => {
    const { buildSession } = await import('./session.js')
    const { phases } = buildSession()

    const i = startIndexOf(phases, 3)
    expect(phases[i].kind).toBe('strength')
    expect(phases[i].cycle).toBe(3) // внутри расписания круги с нуля
  })

  it('вышел на последнем круге — продолжать нечего, начинаем сначала', async () => {
    const { buildSession, CYCLES } = await import('./session.js')
    const { phases } = buildSession()

    // следующего круга за последним нет: findIndex вернёт -1, падаем на ноль
    expect(startIndexOf(phases, CYCLES)).toBe(0)
  })

  it('план дня с другим числом кругов не ломает поиск', async () => {
    const { buildSession } = await import('./session.js')
    // тяжёлый день: кругов восемь
    const { phases } = buildSession({ strengthOrder: ['barrier', 'lunge', 'jack', 'sidelunge', 'jumpsquat', 'twistknee', 'pit', 'jack'] })

    const i = startIndexOf(phases, 7)
    expect(phases[i].kind).toBe('strength')
    expect(phases[i].cycle).toBe(7)
  })
})

describe('день, собранный за несколько заходов', () => {
  let day
  let challenge

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    day = await import('./day.js')
    challenge = await import('./challenge.js')
  })

  it('день за два захода: зачтён, и в сводке видно, что заходов было два', () => {
    // первый заход: три круга и выход
    const attempt = day.startAttempt('pro', 1)
    day.holdAttempt('pro', { score: 3000 }, 1)
    day.holdSession('pro', { cycle: 3, attempt, runs: 1, totals: totalsAfter(3, 3000) }, 1)
    expect(challenge.isDayDone(1)).toBe(false)

    // второй заход: продолжили и дошли до конца
    const snap = day.sessionResume(1)
    const runs = Math.max(1, snap.runs) + 1
    day.holdAttempt('pro', { score: 9000 }, 1)
    challenge.completeDay(1, new Date('2026-08-23T10:00:00Z'), runs)
    day.closePending()
    day.dropSession()

    expect(challenge.isDayDone(1)).toBe(true)
    expect(challenge.dayRuns(1)).toBe(2)
    // и это по-прежнему ОДНА попытка из трёх
    expect(day.attemptsUsed('pro', 1)).toBe(1)
    expect(day.attemptsLeft('pro', 1)).toBe(2)
  })

  it('день за один заход помечается одним — сводка не выдумывает лишнего', () => {
    challenge.completeDay(2, new Date('2026-08-23T10:00:00Z'), 1)
    expect(challenge.dayRuns(2)).toBe(1)
  })
})
