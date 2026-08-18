import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATCH_TYPE, DEFAULT_ROUND, LUNGE_DROP, MODE, TYPE, createRound } from './engine.js'
import { PART_POINTS, TORSO_K } from './catcher.js'
import { SIDE } from './dodge.js'
import { DEFAULT_MOVES } from './moves.js'
import { readMaxes } from './personal.js'

/**
 * Компактный раунд с разведённым расписанием: обучающее препятствие пролетает
 * на 4000, следующее вылетает позже — так в каждом шаге видно ровно одно событие.
 */
const SHORT = {
  /**
   * Весь этот файл — про РОТАЦИЮ ДВИЖЕНИЙ: препятствия, окна зачёта, разминку,
   * детекторы и личные планки. Движок с недавних пор по умолчанию собирает
   * ловца мишеней, и режим здесь задан прямо, а не подразумевается: у ловца
   * нет ни одного из перечисленного, и проверять им эти правила нечем.
   * Ловец проверяется своим файлом — catcher.test.js.
   */
  mode: 'moves',
  durationMs: 20000,
  // разминка изучается отдельно: здесь важно судейство зачётной части
  practiceNeeded: 0,
  startGapMs: 4000,
  endGapMs: 4000,
  startTravelMs: 2000,
  endTravelMs: 2000,
  firstSpawnAtMs: 2000,
  rampCurve: 1,
  downAngle: 100,
  upAngle: 160,
  duckMarginDeg: 15,
  dodgeShouldersK: 0.55,
  leanShouldersK: 0.5,
  leanDriftK: 0.3,
  seed: 7,
}

const SHOULDERS = 0.2
/** Зачётный шаг в долях ширины плеч. */
const K = SHORT.dodgeShouldersK
/** Зачётный наклон в долях ширины плеч. */
const LEAN_K = SHORT.leanShouldersK

/**
 * Куда встать, чтобы уйти от стены на factor зачётных шагов.
 * factor > 1 — хватает с запасом, < 1 — недобор, отрицательный — к стене.
 */
function stepFor(wall, factor, { base = 0.5, width = SHOULDERS } = {}) {
  const shift = factor * K * width
  return wall.side === SIDE.LEFT ? base + shift : base - shift
}

/** Стоит прямо: плечи ровно над тазом. */
const stand = (hipX = 0.5) => ({
  angle: 175,
  hipX,
  shoulderX: hipX,
  shoulderWidth: SHOULDERS,
})
/** Сидит ниже зачётной глубины. */
const squat = (hipX = 0.5) => ({
  angle: 80,
  hipX,
  shoulderX: hipX,
  shoulderWidth: SHOULDERS,
})

/**
 * Наклон корпуса: плечи уходят от таза на factor зачётных наклонов.
 * hipShift — заодно уехавший таз, то есть шаг вместо наклона.
 */
function leanFor(beam, factor, { base = 0.5, hipShift = 0, angle = 175 } = {}) {
  const hipX = base + hipShift
  const lean = factor * LEAN_K * SHOULDERS
  return {
    angle,
    hipX,
    shoulderX: beam.side === SIDE.LEFT ? hipX + lean : hipX - lean,
    shoulderWidth: SHOULDERS,
  }
}

/** По одному препятствию каждого типа: восемнадцать типов -> столько же разминочных. */
const PRACTICE_LEN = 18
/** Окно зачёта вокруг пролёта. */
const BEFORE = DEFAULT_ROUND.hitWindowBeforeMs
const AFTER = DEFAULT_ROUND.hitWindowAfterMs
/** Удару окно после пролёта дано шире: он приходит реакцией, а не заранее. */
const STRIKE_AFTER = DEFAULT_ROUND.strikeWindowAfterMs

const typesOf = (events) => events.map((e) => e.type)
const verdictsOf = (events) => typesOf(events).filter((t) => t !== 'obstacle.spawn')

/** Прогнать раунд шагами и собрать все вылетевшие препятствия. */
function collectSpawns(round, untilMs, pose = stand(), step = 100) {
  const spawns = []
  for (let t = 0; t <= untilMs; t += step) {
    for (const ev of round.update(t, pose)) {
      if (ev.type === 'obstacle.spawn') spawns.push(ev.obstacle)
    }
  }
  return spawns
}

/** Раунд, где все препятствия — барьеры: для проверок, не связанных с типом. */
const barriersOnly = (extra = {}) =>
  createRound({ ...SHORT, types: [TYPE.BARRIER], ...extra, startGapMs: 4000, endGapMs: 4000 })

/**
 * Отдать позу и дождаться вердикта: зачёт приходит сразу, промах — по закрытию
 * окна. Возвращает само событие вердикта, каким бы оно ни было.
 */
function verdictFor(round, obstacle, pose, at = obstacle.passAt, after = AFTER) {
  // подводим раунд к окну стоя: так же, как в жизни — человек стоит и ждёт
  round.update(obstacle.passAt - BEFORE - 100, stand())
  const events = round.update(at, pose)
  const early = events.find((e) => e.type !== 'obstacle.spawn')
  if (early) return early
  const late = round.update(obstacle.passAt + after + 1, pose)
  return late.find((e) => e.type !== 'obstacle.spawn')
}

/** Первое препятствие нужного типа: расписание детерминированное от сида. */
function firstOfType(round, type, pose = stand(), untilMs = 120000) {
  for (let t = 0; t <= untilMs; t += 100) {
    for (const ev of round.update(t, pose)) {
      if (ev.type === 'obstacle.spawn' && ev.obstacle.type === type) return ev.obstacle
    }
  }
  return null
}

describe('таймлайн раннера', () => {
  it('пороги сняты с живой калибровки, а не выдуманы', () => {
    // шаг: вправо человек уходит на 1.1 ширины плеч, влево только на 0.69
    expect(DEFAULT_ROUND.dodgeShouldersK).toBe(0.45)
    // колено: в его сегментах подъём 0.65–0.71, в прочих движениях не выше 0.05
    expect(DEFAULT_ROUND.kneeLiftK).toBe(0.2)
    // наклон вбок сам уводит таз — запас на это больше самого наклона
    expect(DEFAULT_ROUND.leanDriftK).toBeGreaterThan(DEFAULT_ROUND.leanShouldersK)
  })

  it('раунд по умолчанию — три минуты с разгоном темпа', () => {
    expect(DEFAULT_ROUND.durationMs).toBe(180000)
    expect(DEFAULT_ROUND.startGapMs).toBe(4500)
    expect(DEFAULT_ROUND.endGapMs).toBe(2000)
    expect(DEFAULT_ROUND.startTravelMs).toBe(3000)
    expect(DEFAULT_ROUND.endTravelMs).toBe(1800)
  })

  it('препятствия вылетают по расписанию, а не пачкой на старте', () => {
    const round = barriersOnly()

    expect(round.update(1999, stand())).toEqual([])

    const first = round.update(2000, stand())
    expect(typesOf(first)).toEqual(['obstacle.spawn'])
    expect(first[0].obstacle).toMatchObject({ index: 0, spawnAt: 2000, type: TYPE.BARRIER })

    // до следующего вылета ничего не происходит
    expect(round.update(3000, stand())).toEqual([])
  })

  it('пропущенные кадры не теряют препятствий: длинный шаг судит всё накопленное', () => {
    const round = createRound(SHORT)
    // прыжок сразу на 6-ю секунду: первое успело вылететь и пролететь
    const events = round.update(6000, stand())

    expect(typesOf(events)).toEqual(['obstacle.spawn', 'obstacle.spawn', 'obstacle.miss'])
    expect(round.getState().incoming).toHaveLength(1)
    // промах объявлен только после закрытия окна, а не в момент пролёта
    expect(events[2].at).toBeGreaterThan(events[2].obstacle.passAt)
  })

  it('часы идут только вперёд: откат времени не воскрешает препятствие', () => {
    const round = createRound(SHORT)
    round.update(5000, stand())
    expect(round.getState().missed).toBe(1)

    round.update(3000, squat())
    expect(round.getState()).toMatchObject({ missed: 1, elapsedMs: 5000 })
  })

  it('препятствие, которое не успевает долететь до конца раунда, не выпускается', () => {
    const round = createRound({ ...SHORT, durationMs: 8000 })
    const spawns = collectSpawns(round, 8000)

    expect(spawns.length).toBeGreaterThan(0)
    for (const o of spawns) expect(o.passAt).toBeLessThanOrEqual(8000)
    expect(round.getState().spawned).toBe(spawns.length)
  })

  it('в конце раунда — round.end со счётом, и дальше тишина', () => {
    const round = barriersOnly()
    round.update(1000, stand())
    round.update(4000, squat())
    round.update(4600, stand())

    const end = round.update(20000, stand()).find((e) => e.type === 'round.end')
    expect(end).toMatchObject({ at: 20000, cleared: 1 })
    expect(end.spawned).toBeGreaterThan(1)
    expect(round.getState().ended).toBe(true)
    expect(round.update(30000, squat())).toEqual([])
  })

  it('промахи ничего не стоят: раунд идёт до таймера, сколько бы их ни было', () => {
    const round = barriersOnly()
    const events = []
    // стоит столбом весь раунд — не проходит вообще ничего
    for (let t = 0; t <= 20000; t += 100) events.push(...round.update(t, stand()))

    const ends = events.filter((e) => e.type === 'round.end')
    expect(ends).toHaveLength(1)
    expect(ends[0].at).toBe(20000)
    // раунд отработал полностью: препятствий столько же, сколько по расписанию
    expect(ends[0].missed).toBeGreaterThan(3)
    // все выпущенные препятствия успели отсудиться до конца раунда
    expect(ends[0].spawned).toBe(ends[0].missed)
  })

  it('остаток времени не уходит в минус', () => {
    const round = createRound(SHORT)
    round.update(25000, stand())
    expect(round.getState()).toMatchObject({ remainingMs: 0, elapsedMs: 20000 })
  })
})

describe('разминка: движение за движением', () => {
  const WARMUP = {
    ...SHORT,
    practiceNeeded: 2,
    practiceTravelMs: 3000,
    practiceGapMs: 1000,
    readyMs: 4000,
    firstSpawnAtMs: 1000,
    durationMs: 60000,
  }

  /** Довести очередное разминочное препятствие до вердикта заданной позой. */
  function attempt(round, pose) {
    // ждём вылета: разминочные идут строго по одному, с паузой между ними
    for (let guard = 0; guard < 400 && !round.getState().incoming.length; guard += 1) {
      round.update(round.getState().elapsedMs + 100, stand())
    }
    const live = round.getState().incoming[0]
    if (!live) return null

    round.update(live.passAt - BEFORE + 100, pose)
    round.update(live.passAt + AFTER + 1, stand())
    return live
  }

  it('разминка идёт по одному препятствию за раз и только по текущему движению', () => {
    const round = createRound(WARMUP)
    round.update(1000, stand())

    const state = round.getState()
    expect(state.phase).toBe('practice')
    expect(state.incoming).toHaveLength(1)
    expect(state.incoming[0].practice).toBe(true)
    expect(state.practiceMovement).toBe(TYPE.BARRIER)
    expect(state.practiceNeeded).toBe(2)
  })

  it('движение засчитывается два раза подряд — и только тогда идёт следующее', () => {
    const round = createRound({ ...WARMUP, types: [TYPE.BARRIER, TYPE.WALL] })
    round.update(1000, stand())

    attempt(round, squat())
    expect(round.getState()).toMatchObject({ practiceDone: 1, practiceMovement: TYPE.BARRIER })

    attempt(round, squat())
    // два подряд — движение разучено, дальше стена
    expect(round.getState()).toMatchObject({ practiceDone: 0, practiceMovement: TYPE.WALL })
  })

  it('промах обнуляет пару: два раза именно подряд', () => {
    const round = createRound({ ...WARMUP, types: [TYPE.BARRIER] })
    round.update(1000, stand())

    attempt(round, squat())
    expect(round.getState().practiceDone).toBe(1)

    attempt(round, stand()) // не присел
    expect(round.getState()).toMatchObject({ practiceDone: 0, practiceMovement: TYPE.BARRIER })
  })

  it('движение не даётся — разминка ждёт столько, сколько нужно', () => {
    const round = createRound({
      ...WARMUP,
      practiceMaxTries: 0,
      types: [TYPE.BARRIER, TYPE.WALL],
    })
    round.update(1000, stand())

    // стоит столбом: восемь попыток подряд не засчитаны — и это всё ещё присед
    for (let i = 0; i < 8; i += 1) attempt(round, stand())
    expect(round.getState()).toMatchObject({ phase: 'practice', practiceMovement: TYPE.BARRIER })

    // как только получилось два раза подряд — идёт следующее движение
    attempt(round, squat())
    attempt(round, squat())
    expect(round.getState().practiceMovement).toBe(TYPE.WALL)
  })

  it('предел попыток можно задать отдельно — для особых сессий', () => {
    const round = createRound({
      ...WARMUP,
      practiceMaxTries: 3,
      types: [TYPE.BARRIER, TYPE.WALL],
    })
    round.update(1000, stand())

    for (let i = 0; i < 3; i += 1) attempt(round, stand())
    expect(round.getState().practiceMovement).toBe(TYPE.WALL)
  })

  it('вся разминка пройдена — «молодец» и отсчёт до зачётной части', () => {
    const round = createRound({ ...WARMUP, types: [TYPE.BARRIER] })
    round.update(1000, stand())

    attempt(round, squat())
    attempt(round, squat())

    const state = round.getState()
    expect(state.phase).toBe('ready')
    expect(state.readyLeftMs).toBeGreaterThan(0)
    expect(state.readyLeftMs).toBeLessThanOrEqual(WARMUP.readyMs)

    // во время отсчёта ничего не летит
    const during = round.update(state.elapsedMs + 1000, stand())
    expect(during.filter((e) => e.type === 'obstacle.spawn')).toHaveLength(0)
  })

  it('после отсчёта начинается полный зачётный раунд', () => {
    const round = createRound({ ...WARMUP, types: [TYPE.BARRIER] })
    round.update(1000, stand())
    attempt(round, squat())
    attempt(round, squat())

    const readyAt = round.getState().elapsedMs + round.getState().readyLeftMs
    const events = round.update(readyAt, stand())
    const start = events.find((e) => e.type === 'round.start')

    expect(start).toBeTruthy()
    expect(round.getState()).toMatchObject({ phase: 'round', remainingMs: WARMUP.durationMs })

    // зачётная часть идёт свои полные 60 секунд от старта, а не от начала разминки
    const end = round.update(readyAt + WARMUP.durationMs, stand())
    expect(end.find((e) => e.type === 'round.end')).toBeTruthy()
  })

  it('очки разминки в итог не идут', () => {
    const round = createRound({ ...WARMUP, types: [TYPE.BARRIER] })
    round.update(1000, stand())
    attempt(round, squat())

    const state = round.getState()
    expect(state).toMatchObject({ cleared: 0, missed: 0, spawned: 0 })
    expect(state.practiceCleared).toBe(1)
  })

  it('без разминки раунд начинается сразу', () => {
    const round = createRound({ ...WARMUP, practiceNeeded: 0 })
    expect(round.getState().phase).toBe('round')
    expect(collectSpawns(round, 10000).every((o) => !o.practice)).toBe(true)
  })
})

describe('барьер: зачёт по приседу', () => {
  it('сидит в момент пролёта — барьер проскочил', () => {
    const round = barriersOnly()
    round.update(2000, stand()) // вылет, заодно засчитана стойка

    // до открытия окна поза ещё ничего не решает
    expect(round.update(3200, squat())).toEqual([])

    const events = round.update(4000, squat())
    expect(typesOf(events)).toEqual(['obstacle.clear'])
    expect(events[0].obstacle).toMatchObject({ status: 'cleared', angleAtPass: 80 })
    expect(round.getState()).toMatchObject({ cleared: 1, missed: 0, incoming: [] })
  })

  it('присел раньше пролёта — засчитано сразу, а не отложено до момента', () => {
    const round = barriersOnly()
    round.update(2000, stand())

    // полсекунды до пролёта: движение сделано, значит и зачёт сейчас
    const events = round.update(3500, squat())

    expect(typesOf(events)).toEqual(['obstacle.clear'])
    expect(events[0].at).toBe(3500)
    expect(events[0].timing).toBe(-500)
  })

  it('присел чуть позже пролёта — всё равно засчитано', () => {
    const round = barriersOnly()
    round.update(2000, stand())

    round.update(4000, stand()) // в сам момент пролёта ещё не успел
    const events = round.update(4300, squat())

    expect(typesOf(events)).toEqual(['obstacle.clear'])
    expect(events[0].timing).toBe(300)
  })

  it('стоит всё окно — задел, и промах объявляется по закрытию окна', () => {
    const round = barriersOnly()
    round.update(2000, stand())

    expect(round.update(4000, stand())).toEqual([])

    const events = round.update(4000 + AFTER + 1, stand())
    expect(verdictsOf(events)).toEqual(['obstacle.miss'])
    expect(events.find((e) => e.type === 'obstacle.miss').reason).toBe('not-low')
    expect(round.getState()).toMatchObject({ cleared: 0, missed: 1 })
  })

  it('присел слишком рано и успел встать до окна — промах', () => {
    const round = barriersOnly()
    round.update(2000, stand())

    round.update(2400, squat()) // присел задолго до окна
    round.update(3200, stand()) // и уже поднялся, окно открывается в 3300

    expect(verdictFor(round, { passAt: 4000 }, stand()).type).toBe('obstacle.miss')
  })

  it('зачётная глубина — рабочая плюс запас на задержку камеры', () => {
    const exact = barriersOnly()
    exact.update(2000, stand())
    // ровно DOWN + 15 ещё засчитывается
    expect(verdictFor(exact, { passAt: 4000 }, { ...squat(), angle: 115 }).type).toBe(
      'obstacle.clear',
    )

    const over = barriersOnly()
    over.update(2000, stand())
    expect(verdictFor(over, { passAt: 4000 }, { ...squat(), angle: 116 }).type).toBe(
      'obstacle.miss',
    )
  })

  it('человека не видно — угла нет, значит не присел', () => {
    const round = barriersOnly()
    round.update(2000, stand())

    const verdict = verdictFor(round, { passAt: 4000 }, { angle: null, hipX: null })
    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-person')
  })

  it('калибровка на ходу двигает зачётную глубину', () => {
    const round = barriersOnly()
    round.setThresholds({ downAngle: 140, upAngle: 165 })
    round.update(2000, { ...stand(), angle: 170 })

    // при рабочей глубине 140 зачёт идёт уже со 155°
    expect(round.getState()).toMatchObject({ duckAngle: 155, standAngle: 165 })
    expect(verdictFor(round, { passAt: 4000 }, { ...squat(), angle: 150 }).type).toBe(
      'obstacle.clear',
    )
  })

  it('глубина видна полоской ещё до пролёта', () => {
    const round = barriersOnly()
    const events = round.update(2000, stand())
    const barrier = events[0].obstacle

    expect(barrier.progress).toBe(0)

    // ровно половина пути от стойки (160°) до зачётной глубины (115°)
    round.update(2500, { ...stand(), angle: 137.5 })
    expect(barrier.progress).toBeCloseTo(0.5, 2)

    round.update(3000, squat())
    expect(barrier.progress).toBe(1)
  })

  it('одно препятствие судится ровно один раз', () => {
    const round = barriersOnly()
    round.update(2000, stand())
    round.update(4000, squat())

    expect(verdictsOf(round.update(4100, squat()))).toEqual([])
    expect(round.getState().cleared).toBe(1)
  })
})

describe('анти-чит: между препятствиями надо вставать', () => {
  it('сидит весь раунд — не засчитывается ничего', () => {
    const round = barriersOnly()
    // ни одного кадра в стойке: человек сел и сидит
    const events = []
    for (let t = 0; t <= 12000; t += 100) events.push(...round.update(t, squat()))

    expect(verdictsOf(events).every((v) => v === 'obstacle.miss')).toBe(true)
    expect(round.getState()).toMatchObject({ cleared: 0 })
    expect(round.getState().missed).toBeGreaterThan(1)
  })

  it('первый присед засчитан, второй без подъёма — уже нет', () => {
    const round = barriersOnly()
    round.update(2000, stand()) // стойка есть
    expect(typesOf(round.update(4000, squat()))).toEqual(['obstacle.clear'])

    // и дальше не вставал ни разу
    for (let t = 4100; t < 9000; t += 100) round.update(t, squat())

    expect(round.getState()).toMatchObject({ cleared: 1, missed: 1 })
  })

  it('встал между препятствиями — снова засчитывается', () => {
    const round = barriersOnly()
    round.update(2000, stand())
    round.update(4000, squat()) // зачёт
    round.update(6000, stand()) // выпрямился
    for (let t = 6100; t < 9000; t += 100) round.update(t, squat())

    expect(round.getState()).toMatchObject({ cleared: 2, missed: 0 })
  })

  it('пока не встал — движок просит встать, и причина промаха видна', () => {
    const round = barriersOnly()
    round.update(2000, stand())
    round.update(4000, squat())

    expect(round.getState().mustStand).toBe(true)

    const miss = round
      .update(8000 + AFTER + 1, squat())
      .find((e) => e.type === 'obstacle.miss')
    expect(miss.reason).toBe('no-stand')

    round.update(8100, stand())
    expect(round.getState().mustStand).toBe(false)
  })
})

describe('стена: зачёт по шагу в сторону', () => {
  /** Раунд, где первое препятствие — стена нужной стороны. */
  function wallRound(side = SIDE.LEFT) {
    const round = createRound({ ...SHORT, types: [TYPE.WALL], firstSpawnAtMs: 1000 })
    // обучающее всегда барьер — пропускаем его и берём первую стену
    return { round, side }
  }

  /** Собрать первую стену раунда: вернуть её и момент пролёта. */
  function firstWall(round, pose = stand()) {
    let wall = null
    for (let t = 0; t <= 20000 && !wall; t += 100) {
      for (const ev of round.update(t, pose)) {
        if (ev.type === 'obstacle.spawn' && ev.obstacle.type === TYPE.WALL) wall = ev.obstacle
      }
    }
    return wall
  }

  it('шаг в свободную сторону сверх порога — стена пройдена', () => {
    const { round } = wallRound()
    const wall = firstWall(round)
    expect(wall).toBeTruthy()
    expect(wall.baseX).toBeCloseTo(0.5, 5)

    // стена слева -> уходим в больший экранный X, стена справа -> в меньший
    const events = round.update(wall.passAt, stand(stepFor(wall, 1.2)))

    expect(verdictsOf(events)).toEqual(['obstacle.clear'])
  })

  it('шаг в сторону самой стены не спасает', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    const verdict = verdictFor(round, wall, stand(stepFor(wall, -1.2)))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-step')
  })

  it('шага не хватило — промах', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    expect(verdictFor(round, wall, stand(stepFor(wall, 0.8))).type).toBe('obstacle.miss')
  })

  it('шагнул заранее — засчитано сразу, возвращаться к пролёту не обязано', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    const events = round.update(wall.passAt - 400, stand(stepFor(wall, 1.2)))

    expect(verdictsOf(events)).toEqual(['obstacle.clear'])
    expect(events.find((e) => e.type === 'obstacle.clear').timing).toBe(-400)
  })

  it('порог едет вместе с человеком: узкие плечи — меньший шаг', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    // встал вдвое дальше от камеры: плечи вдвое уже, и шаг нужен вдвое короче
    const narrow = SHOULDERS / 2
    const events = round.update(wall.passAt, {
      angle: 175,
      hipX: stepFor(wall, 1.2, { width: narrow }),
      shoulderWidth: narrow,
    })

    expect(verdictsOf(events)).toEqual(['obstacle.clear'])
  })

  it('от стены уходят на ногах: присед вместо шага не считается', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    const verdict = verdictFor(round, wall, squat(stepFor(wall, 1.2)))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('sitting')
  })

  it('ноги ушли за край кадра — стена всё равно судится по тазу', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    // угол в колене неизвестен: голеностопы вне кадра, трекер кадр забраковал
    const verdict = verdictFor(round, wall, {
      angle: null,
      hipX: stepFor(wall, 1.2),
      shoulderWidth: SHOULDERS,
    })

    expect(verdict.type).toBe('obstacle.clear')
  })

  it('пока стена летит, видно живое смещение: доля пути до зачёта', () => {
    const { round } = wallRound()
    const wall = firstWall(round)
    // ровно половина зачётного шага
    round.update(wall.spawnAt + 100, stand(stepFor(wall, 0.5)))
    expect(wall.progress).toBeCloseTo(0.5, 5)
    expect(wall.dodgeK).toBeCloseTo(K / 2, 5)

    // шаг в сторону стены — полоска пустая, а не отрицательная
    round.update(wall.spawnAt + 200, stand(stepFor(wall, -1)))
    expect(wall.progress).toBe(0)

    // дошёл до порога — полоска полная
    round.update(wall.spawnAt + 300, stand(stepFor(wall, 1.1)))
    expect(wall.progress).toBe(1)
  })

  it('пока стена в воздухе, движок сообщает об этом экрану', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    expect(round.getState().wallIncoming).toBe(true)
    round.update(wall.passAt, stand(stepFor(wall, 1.2)))
    expect(round.getState().wallIncoming).toBe(false)
  })

  it('вердикт несёт сторону и фактическое смещение со знаком', () => {
    const { round } = wallRound()
    const wall = firstWall(round)

    const wrong = wall.side === SIDE.LEFT ? 0.5 - 0.3 * SHOULDERS : 0.5 + 0.3 * SHOULDERS
    const miss = verdictFor(round, wall, stand(wrong))

    expect(miss.type).toBe('obstacle.miss')
    expect(miss.side).toBe(wall.side)
    // прижался к стене — смещение отрицательное
    expect(miss.dodge).toBeCloseTo(-0.3, 3)
  })

  it('базовая точка берётся в момент вылета стены, а не в начале раунда', () => {
    const round = createRound({ ...SHORT, types: [TYPE.WALL] })
    // человек стоит слева от центра экрана и там же остаётся до вылета стены
    const wall = firstWall(round, stand(0.35))

    expect(wall.baseX).toBeCloseTo(0.35, 5)

    // шаг считается от 0.35, а не от середины кадра
    const target = wall.side === SIDE.LEFT ? 0.35 + 0.9 * SHOULDERS : 0.35 - 0.9 * SHOULDERS
    expect(verdictsOf(round.update(wall.passAt, stand(target)))).toEqual(['obstacle.clear'])
  })
})

describe('балка: зачёт по наклону корпуса', () => {
  const beamRound = () => createRound({ ...SHORT, durationMs: 60000, types: [TYPE.BEAM] })

  it('наклон в свободную сторону — балка пройдена', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)
    expect(beam).toBeTruthy()

    const events = round.update(beam.passAt, leanFor(beam, 1.2))

    expect(verdictsOf(events)).toEqual(['obstacle.clear'])
    expect(events[0].dodge).toBeCloseTo(1.2 * LEAN_K, 10)
  })

  it('наклон в сторону самой балки не спасает', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)

    const verdict = verdictFor(round, beam, leanFor(beam, -1.2))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-lean')
  })

  it('наклона не хватило — промах', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)

    expect(verdictFor(round, beam, leanFor(beam, 0.8)).type).toBe('obstacle.miss')
  })

  it('шаг вместо наклона не считается: таз должен остаться на месте', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)

    // корпус увело достаточно, но вместе с ним уехал и таз — это шаг
    const stepped = leanFor(beam, 1.2, { hipShift: 0.4 * SHOULDERS })
    const verdict = verdictFor(round, beam, stepped)

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('stepped')
    expect(verdict.drift).toBeCloseTo(0.4, 10)
  })

  it('таз чуть качнулся — это ещё наклон, а не шаг', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)

    const events = round.update(beam.passAt, leanFor(beam, 1.2, { hipShift: 0.2 * SHOULDERS }))

    expect(verdictsOf(events)).toEqual(['obstacle.clear'])
  })

  it('присед вместо наклона не считается', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)

    const verdict = verdictFor(round, beam, leanFor(beam, 1.2, { angle: 80 }))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('sitting')
  })

  it('пока балка летит, видно живой прогресс наклона', () => {
    const round = beamRound()
    const beam = firstOfType(round, TYPE.BEAM)

    round.update(beam.spawnAt + 100, leanFor(beam, 0.5))
    expect(beam.progress).toBeCloseTo(0.5, 5)
    expect(beam.blocked).toBe(false)

    // наклонился достаточно, но сошёл с места — полоска помечена как негодная
    round.update(beam.spawnAt + 200, leanFor(beam, 1.2, { hipShift: 0.5 * SHOULDERS }))
    expect(beam.progress).toBe(1)
    expect(beam.blocked).toBe(true)
  })
})

describe('астероид: зачёт по удару рукой', () => {
  const strikeRound = () => createRound({ ...SHORT, types: [TYPE.STRIKE], durationMs: 60000 })

  /** Поза с заданным выносом рук вперёд (0 — вдоль тела, 1 — прямо в камеру). */
  const arms = (left, right, extra = {}) => ({
    ...stand(),
    reach: { left, right },
    ...extra,
  })

  /** Ударить рукой obstacle.side: рука убрана, потом резко выброшена вперёд. */
  function punch(round, obstacle, { ms = 250, other = false } = {}) {
    const side = other ? (obstacle.side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT) : obstacle.side
    const backAt = obstacle.passAt - BEFORE - 100
    round.update(backAt, arms(0.05, 0.05))
    const out = side === SIDE.LEFT ? { left: 0.9, right: 0.05 } : { left: 0.05, right: 0.9 }
    // вынос ровно через ms после замаха — столько движок и намерит
    return round.update(backAt + ms, arms(out.left, out.right))
  }

  /**
   * Та же поза, но с высотой таза: по ней движок и отличает удар от приседа с
   * выносом рук. torso — длина корпуса, в её долях и меряется гуляние таза.
   */
  const hips = (pose, hipY) => ({ ...pose, hipY, torso: 0.4 })

  it('быстрый удар нужной рукой — астероид разбит', () => {
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)
    expect(asteroid).toBeTruthy()

    const events = punch(round, asteroid)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    // фактические величины уходят в лог — по ним калибруются пороги
    expect(clear.strikeMs).toBe(250)
    // фактический рывок: с чего начал и куда дошёл
    expect(clear.strikeFrom).toBe(0.05)
    expect(clear.strikeTo).toBe(0.9)
  })

  it('рука вытягивается медленно — это не удар', () => {
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)

    // рука ползёт вперёд пять секунд: ни в одном окне памяти рывка нет
    const from = asteroid.passAt - 5000
    for (let t = from; t <= asteroid.passAt; t += 100) {
      const v = 0.05 + ((t - from) / 5000) * 0.85
      round.update(t, arms(v, v))
    }
    const verdict = round
      .update(asteroid.passAt + STRIKE_AFTER + 1, arms(0.9, 0.9))
      .find((e) => e.type === 'obstacle.miss')

    expect(verdict.reason).toBe('no-strike')
  })

  it('удар другой рукой не засчитывается', () => {
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)

    punch(round, asteroid, { other: true })
    const verdict = round
      .update(asteroid.passAt + STRIKE_AFTER + 1, arms(0.05, 0.05))
      .find((e) => e.type === 'obstacle.miss')

    expect(verdict.reason).toBe('no-strike')
  })

  it('удар до открытия окна не засчитывается', () => {
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)

    // ударил задолго до подлёта
    round.update(asteroid.spawnAt + 100, arms(0.05, 0.05))
    round.update(asteroid.spawnAt + 300, arms(0.9, 0.9))

    const verdict = verdictFor(round, asteroid, arms(0.9, 0.9), asteroid.passAt, STRIKE_AFTER)
    expect(verdict.type).toBe('obstacle.miss')
  })

  it('в разминке астероид засчитывается сразу после вылета', () => {
    // разминочный астероид ползёт пять секунд, и человек бьёт его, как только
    // увидел: по записи с айфона — за 1.5–4 с до пролёта, оставляя руку
    // вытянутой навстречу. Нового рывка к обычному окну уже не будет, поэтому
    // в разминке окно открыто с вылета
    const round = createRound({
      ...SHORT,
      types: [TYPE.STRIKE],
      practiceNeeded: 2,
      practiceTravelMs: 5000,
      practiceGapMs: 1000,
      durationMs: 60000,
    })
    const asteroid = firstOfType(round, TYPE.STRIKE)
    expect(asteroid).toMatchObject({ practice: true, travelMs: 5000 })

    const out = asteroid.side === SIDE.LEFT ? { left: 0.9, right: 0.05 } : { left: 0.05, right: 0.9 }
    round.update(asteroid.passAt - 3200, arms(0.05, 0.05))
    const clear = round
      .update(asteroid.passAt - 3000, arms(out.left, out.right))
      .find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.obstacle.id).toBe(asteroid.id)
    expect(clear.timing).toBe(-3000)
  })

  it('в зачётной части удар за три секунды до пролёта по-прежнему не в счёт', () => {
    // тот же ранний удар с той же оставленной рукой, но в зачётной части: здесь
    // окно снято с записи раунда, где удар приходит реакцией — после пролёта
    const round = createRound({
      ...SHORT,
      types: [TYPE.STRIKE],
      startTravelMs: 5000,
      endTravelMs: 5000,
      durationMs: 60000,
    })
    const asteroid = firstOfType(round, TYPE.STRIKE)
    expect(asteroid.practice).toBe(false)

    const out = asteroid.side === SIDE.LEFT ? { left: 0.9, right: 0.05 } : { left: 0.05, right: 0.9 }
    round.update(asteroid.passAt - 3200, arms(0.05, 0.05))
    expect(verdictsOf(round.update(asteroid.passAt - 3000, arms(out.left, out.right)))).toEqual([])

    // рука осталась вытянутой навстречу — нового рывка в окне нет
    const verdict = round
      .update(asteroid.passAt + STRIKE_AFTER + 1, arms(out.left, out.right))
      .find((e) => e.type === 'obstacle.miss')

    expect(verdict.reason).toBe('no-strike')
  })

  /**
   * Промах удара срезает либо отсутствие рывка, либо гуляющий таз — и в логе это
   * должны быть разные причины. Пока обе назывались 'no-strike', по полевой
   * записи нельзя было понять, человек не бил или бил на ходу вниз-вверх.
   */
  it('рывок при гуляющем тазе — отдельная причина, а не общий no-strike', () => {
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)
    const out = asteroid.side === SIDE.LEFT ? { left: 0.9, right: 0.05 } : { left: 0.05, right: 0.9 }
    const back = asteroid.passAt - BEFORE - 100

    // таз ходит вниз-вверх почти на треть корпуса: так выглядит присед, из
    // которого человек и выбрасывает руки вперёд
    round.update(back, hips(arms(0.05, 0.05), 0.5))
    // рывок рукой состоялся, но зачёта нет — окно ещё открыто, вердикта нет
    expect(verdictsOf(round.update(back + 250, hips(arms(out.left, out.right), 0.62)))).toEqual([])

    const verdict = round
      .update(asteroid.passAt + STRIKE_AFTER + 1, hips(arms(out.left, out.right), 0.5))
      .find((e) => e.type === 'obstacle.miss')

    expect(verdict.reason).toBe('strike-hips')
    // и по числам в логе видно ровно то же: рывок был, таз при нём гулял
    expect(verdict.hip).toBeGreaterThan(DEFAULT_ROUND.punchHipMoveK)
    expect(verdict.strikeMs).toBe(250)
    expect(verdict.punchAt).toBe(-550)
  })

  it('рывок руки над головой ударом не считается: это мах', () => {
    // калибровочная запись: мах через сторону вверх детектор удара принимал за
    // вынос руки в камеру — 4 ложных удара на один сегмент маха
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)
    const out = asteroid.side === SIDE.LEFT ? { left: 0.9, right: 0.05 } : { left: 0.05, right: 0.9 }
    const overhead =
      asteroid.side === SIDE.LEFT
        ? { left: DEFAULT_ROUND.raiseOverheadK, right: -2 }
        : { left: -2, right: DEFAULT_ROUND.raiseOverheadK }
    const back = asteroid.passAt - BEFORE - 100

    round.update(back, { ...arms(0.05, 0.05), raise: overhead })
    round.update(back + 250, { ...arms(out.left, out.right), raise: overhead })

    const verdict = round
      .update(asteroid.passAt + STRIKE_AFTER + 1, arms(0.05, 0.05))
      .find((e) => e.type === 'obstacle.miss')

    expect(verdict.reason).toBe('no-strike')
    // рывка для движка не было вовсе: замеров удара тоже нет
    expect(verdict.strikeMs).toBeNull()
  })

  it('рывка не было вовсе — прежняя причина no-strike', () => {
    const round = strikeRound()
    const asteroid = firstOfType(round, TYPE.STRIKE)
    const back = asteroid.passAt - BEFORE - 100

    // таз гуляет так же, но руки так и остались у тела
    round.update(back, hips(arms(0.05, 0.05), 0.5))
    round.update(back + 250, hips(arms(0.05, 0.05), 0.62))

    const verdict = round
      .update(asteroid.passAt + STRIKE_AFTER + 1, hips(arms(0.05, 0.05), 0.5))
      .find((e) => e.type === 'obstacle.miss')

    expect(verdict.reason).toBe('no-strike')
    // удара не случилось — ни замеров рывка, ни момента
    expect(verdict.strikeMs).toBe(null)
    expect(verdict.punchAt).toBe(null)
  })
})

describe('птица: зачёт по маху рукой вверх', () => {
  const birdRound = () => createRound({ ...SHORT, types: [TYPE.BIRD], durationMs: 60000 })

  /**
   * Поза с поднятой рукой. value — насколько запястье выше носа в длинах
   * корпуса: настоящие махи по калибровочной записи дают 0.72–0.83.
   */
  const raiseFor = (bird, value, other = -2) => ({
    ...stand(),
    raise:
      bird.side === SIDE.LEFT ? { left: value, right: other } : { left: other, right: value },
  })

  it('рука нужной стороны выше носа — птица достана', () => {
    const round = birdRound()
    const bird = firstOfType(round, TYPE.BIRD)
    expect(bird).toBeTruthy()
    expect(bird.side).toBeTruthy()

    const verdict = verdictFor(round, bird, raiseFor(bird, 0.78))

    expect(verdict.type).toBe('obstacle.clear')
    // в лог уходит, до чего дотянулась рука: по этому числу и двигать порог
    expect(verdict.raise).toBeCloseTo(0.78, 2)
  })

  it('рука не дотянула — промах, и видно, сколько не хватило', () => {
    const round = birdRound()
    const bird = firstOfType(round, TYPE.BIRD)

    const verdict = verdictFor(round, bird, raiseFor(bird, 0.3))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-raise')
    expect(verdict.raise).toBeCloseTo(0.3, 2)
  })

  it('другая рука не считается: птицу достают своей стороной', () => {
    const round = birdRound()
    const bird = firstOfType(round, TYPE.BIRD)

    // подняли не ту руку: value уехало на чужую сторону
    const wrong = {
      ...stand(),
      raise: bird.side === SIDE.LEFT ? { left: -2, right: 0.78 } : { left: 0.78, right: -2 },
    }

    expect(verdictFor(round, bird, wrong).reason).toBe('no-raise')
  })

  it('обе руки вверх — это потягивание, а не мах', () => {
    const round = birdRound()
    const bird = firstOfType(round, TYPE.BIRD)

    const verdict = verdictFor(round, bird, raiseFor(bird, 0.78, 0.7))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-raise')
  })

  it('поднятая рука видна полоской ещё до пролёта', () => {
    const round = birdRound()
    const bird = firstOfType(round, TYPE.BIRD)

    round.update(bird.spawnAt + 100, raiseFor(bird, 0))
    expect(bird.progress).toBe(0)

    // ровно половина пути до зачётной высоты
    round.update(bird.spawnAt + 200, raiseFor(bird, DEFAULT_ROUND.raiseK / 2))
    expect(bird.progress).toBeCloseTo(0.5, 5)

    round.update(bird.spawnAt + 300, raiseFor(bird, DEFAULT_ROUND.raiseK))
    expect(bird.progress).toBe(1)
  })

  it('держать руку поднятой бесполезно: анти-чит требует опустить её', () => {
    const round = birdRound()
    const first = firstOfType(round, TYPE.BIRD)
    const up = raiseFor(first, 0.78)

    // первая птица достана честно
    expect(verdictFor(round, first, up).type).toBe('obstacle.clear')

    // и дальше рука так и осталась над головой. Вердикт снимаем руками, а не
    // через verdictFor: тот подводит раунд к окну стоя, то есть сам опускает
    // руку и снимает анти-чит, который здесь и проверяется
    const second = firstOfType(round, TYPE.BIRD, up)
    round.update(second.passAt - BEFORE - 100, up)
    const events = [
      ...round.update(second.passAt, up),
      ...round.update(second.passAt + AFTER + 1, up),
    ]
    const verdict = events.find((e) => e.type === 'obstacle.miss')

    expect(verdict).toBeTruthy()
    expect(verdict.reason).toBe('no-stand')
    // опустил руку — и следующая птица снова засчитывается
    round.update(second.passAt + AFTER + 200, stand())
    expect(round.getState().mustStand).toBe(false)
  })
})

describe('яма: зачёт по прыжку', () => {
  const pitRound = (extra = {}) =>
    createRound({ ...SHORT, types: [TYPE.PIT], durationMs: 60000, ...extra })

  /** Стоит на земле: по этим кадрам детектор прыжка и узнаёт, где пол. */
  const ground = () => ({
    ...stand(),
    hipY: 0.6,
    torso: 0.2,
    ankleY: { left: 0.95, right: 0.95 },
  })
  /** В воздухе: тело ушло вверх, обе стопы оторвались от пола. */
  const air = () => ({
    ...stand(),
    hipY: 0.55,
    torso: 0.2,
    ankleY: { left: 0.9, right: 0.9 },
  })

  /** Прыгнуть в момент at: два кадра на земле и один в воздухе. */
  function jump(round, at) {
    round.update(at - 200, ground())
    round.update(at - 100, ground())
    return round.update(at, air())
  }

  it('прыжок в окне — яма перепрыгнута', () => {
    const round = pitRound()
    const pit = firstOfType(round, TYPE.PIT, ground())
    expect(pit).toBeTruthy()
    // яма во всю ширину: уйти от неё в сторону нельзя
    expect(pit.side).toBeNull()

    const events = jump(round, pit.passAt)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.jumped).toBe(true)
    expect(clear.jumpAt).toBe(0)
  })

  it('прыжка не было — промах с понятной причиной', () => {
    const round = pitRound()
    const pit = firstOfType(round, TYPE.PIT, ground())

    // стоит на земле всё окно
    const verdict = verdictFor(round, pit, ground())

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-jump')
    expect(verdict.jumped).toBe(false)
    expect(verdict.jumpAt).toBeNull()
  })

  it('приземление в полуприсед зачёт не отменяет', () => {
    const round = pitRound()
    const pit = firstOfType(round, TYPE.PIT, ground())

    jump(round, pit.passAt - 300)
    // погасил удар о пол: угол в колене ушёл ниже зачётной глубины приседа
    const events = round.update(pit.passAt, { ...ground(), angle: 80 })

    expect(verdictsOf(events)).toEqual([])
    expect(round.getState().cleared).toBe(1)
  })

  it('в зачётной части прыжок задолго до окна не считается', () => {
    const round = pitRound({ startTravelMs: 5000, endTravelMs: 5000 })
    const pit = firstOfType(round, TYPE.PIT, ground())

    // прыгнул за три секунды до пролёта: окно откроется много позже
    jump(round, pit.passAt - 3000)

    const verdict = verdictFor(round, pit, ground())
    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-jump')
  })

  it('в разминке ранний прыжок засчитывается: яма ползёт пять секунд', () => {
    // то же исключение, что у астероида: прыжок — событие, и медленное
    // препятствие человек перепрыгивает, как только увидел
    const round = pitRound({
      practiceNeeded: 2,
      practiceTravelMs: 5000,
      practiceGapMs: 1000,
    })
    const pit = firstOfType(round, TYPE.PIT, ground())
    expect(pit).toMatchObject({ practice: true, travelMs: 5000 })

    const events = jump(round, pit.passAt - 3000)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.jumpAt).toBe(-3000)
  })
})

/**
 * Волна и уголёк судятся не позой, а состоявшимся событием автомата из
 * legs.js. Поэтому позы здесь идут ЧЕРЕДОЙ КАДРОВ, а не одним снимком: автомат
 * ведёт медиану таза за четыре секунды и отдаёт событие только по выдержке.
 */
describe('волна и уголёк: зачёт по выпаду назад и захлёсту голени', () => {
  const legRound = (type, extra = {}) =>
    createRound({ ...SHORT, types: [type], durationMs: 60000, ...extra })

  /** Стойка со всеми признаками ног: от неё автомат и отсчитывает просадку таза. */
  const feet = (over = {}) => ({
    ...stand(),
    hipY: 0.6,
    torso: 0.2,
    kneeLift: { left: -1, right: -1 },
    ankleDy: { left: 0, right: 0 },
    ankleBack: { left: 0, right: 0 },
    ...over,
  })

  const bySide = (side, own, other) =>
    side === SIDE.LEFT ? { left: own, right: other } : { left: other, right: own }

  /**
   * Выпад этой ногой: стопа ушла на полметра назад по глубине, таз просел на
   * 0.35 корпуса, а колени согнулись до 72° — глубже любого зачётного приседа.
   * Угол здесь не для красоты: именно он и проверяет, что срез «в приседе
   * ничего не судим» стоит ПОСЛЕ ветки выпада.
   */
  const lungePose = (side) =>
    feet({ angle: 72, hipY: 0.67, ankleBack: bySide(side, 0.8, 0) })

  /** Захлёст этой ногой: стопа на полкорпуса выше второй, таз и колено на месте. */
  const heelPose = (side) => feet({ ankleDy: bySide(side, 0.5, -0.5) })

  /** Продержать позу: автомат отдаёт событие только после своей выдержки. */
  function hold(round, pose, from, ms, step = 50) {
    const events = []
    for (let t = from; t <= from + ms; t += step) events.push(...round.update(t, pose))
    return events
  }

  /** Подвести раунд к окну стоя — и заодно набрать автомату медиану таза. */
  const settle = (round, at) => round.update(at, feet())

  it('выпад нужной ногой — волна пройдена, и в лог уходят оба признака', () => {
    const round = legRound(TYPE.LUNGE)
    const surge = firstOfType(round, TYPE.LUNGE, feet())
    expect(surge).toBeTruthy()
    // сторона у волны есть, и это рабочая нога
    expect(surge.side).toBeTruthy()

    settle(round, surge.passAt - BEFORE - 100)
    const events = hold(round, lungePose(surge.side), surge.passAt - 200, 200)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    // выдержка 150 мс: событие приходит на четвёртом кадре, а не на первом
    expect(clear.legAt).toBe(-50)
    // оба признака в логе: по ним и станет видно, чего не хватало на промахах
    expect(clear.lungeBack).toBeCloseTo(0.8, 2)
    expect(clear.lungeDrop).toBeCloseTo(0.35, 2)
  })

  it('выпад не режется срезом «в приседе ничего не судим»', () => {
    // Ровно та грабля, что была с подъёмом колена (коммит c7a3918): в выпаде
    // колени сгибаются глубже зачётного приседа, и общий срез убил бы само
    // движение. Ветка выпада поэтому стоит ДО среза.
    const round = legRound(TYPE.LUNGE)
    const surge = firstOfType(round, TYPE.LUNGE, feet())

    settle(round, surge.passAt - BEFORE - 100)
    const events = hold(round, lungePose(surge.side), surge.passAt - 200, 200)

    // человек в этот момент по всем меркам «в приседе» — и волна всё равно взята
    expect(round.getState().ducking).toBe(true)
    expect(events.find((e) => e.type === 'obstacle.clear')).toBeTruthy()
  })

  it('ногу унесло назад, а таз не просел — промах, и это видно по числам', () => {
    const round = legRound(TYPE.LUNGE)
    const surge = firstOfType(round, TYPE.LUNGE, feet())

    settle(round, surge.passAt - BEFORE - 100)
    // мелкий отшаг: нога назад всего на 0.25 при пороге 0.40
    const shallow = feet({ ankleBack: bySide(surge.side, 0.35, 0), hipY: 0.67 })
    hold(round, shallow, surge.passAt - 200, 200)
    const miss = round
      .update(surge.passAt + DEFAULT_ROUND.legWindowAfterMs + 1, feet())
      .find((e) => e.type === 'obstacle.miss')

    expect(miss.reason).toBe('no-lunge')
    // в логе ровно то, что случилось: сел человек честно, а ногу не унёс
    expect(miss.lungeBack).toBeCloseTo(0.35, 2)
    expect(miss.lungeDrop).toBeCloseTo(0.35, 2)
    expect(miss.legAt).toBeNull()
  })

  it('захлёст нужной ногой — уголёк взят, высота стопы уходит в лог', () => {
    const round = legRound(TYPE.HEEL)
    const ember = firstOfType(round, TYPE.HEEL, feet())
    expect(ember).toBeTruthy()

    settle(round, ember.passAt - BEFORE - 100)
    // выдержка захлёста длиннее выпада: 350 мс
    const events = hold(round, heelPose(ember.side), ember.passAt - 400, 400)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.heelLift).toBeCloseTo(0.5, 2)
    expect(clear.legAt).toBe(-50)
  })

  it('захлёст другой ногой не считается: сторона — рабочая нога', () => {
    const round = legRound(TYPE.HEEL)
    const ember = firstOfType(round, TYPE.HEEL, feet())
    const other = ember.side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT

    settle(round, ember.passAt - BEFORE - 100)
    hold(round, heelPose(other), ember.passAt - 400, 400)
    const miss = round
      .update(ember.passAt + DEFAULT_ROUND.legWindowAfterMs + 1, feet())
      .find((e) => e.type === 'obstacle.miss')

    expect(miss.reason).toBe('no-heel')
  })

  it('барьер выпадом не проходится: колени в нём гнутся так же, как в приседе', () => {
    // Замер с записи: детектор приседа дал 6 ложных срабатываний в сегментах
    // выпадов. Тот же срез стоит и в разборе записей (tools/punch-replay.mjs).
    const round = barriersOnly()
    const barrier = firstOfType(round, TYPE.BARRIER)

    const verdict = verdictFor(round, barrier, lungePose(SIDE.RIGHT))

    expect(verdict.type).toBe('obstacle.miss')
    // угол при этом ниже зачётной глубины: барьер спасает не он, а ушедшая нога
    expect(verdict.angle).toBe(72)
  })

  it('окно у волны и уголька шире обычного: движение приходит реакцией', () => {
    expect(DEFAULT_ROUND.legWindowAfterMs).toBe(1400)
    expect(DEFAULT_ROUND.legWindowAfterMs).toBeGreaterThan(DEFAULT_ROUND.hitWindowAfterMs)

    const round = legRound(TYPE.LUNGE)
    const surge = firstOfType(round, TYPE.LUNGE, feet())

    settle(round, surge.passAt - BEFORE - 100)
    // выпад начат уже ПОСЛЕ пролёта, позже обычного окна в 500 мс
    const events = hold(round, lungePose(surge.side), surge.passAt + AFTER + 200, 200)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.legAt).toBeGreaterThan(DEFAULT_ROUND.hitWindowAfterMs)
    expect(clear.legAt).toBeLessThan(DEFAULT_ROUND.legWindowAfterMs)
  })

  it('в разминке окно открывается с вылета: волна ползёт пять секунд', () => {
    // то же исключение, что у астероида и ямы: движение — событие, и медленное
    // препятствие человек отрабатывает, как только увидел
    const round = legRound(TYPE.LUNGE, {
      practiceNeeded: 2,
      practiceTravelMs: 5000,
      practiceGapMs: 1000,
    })
    const surge = firstOfType(round, TYPE.LUNGE, feet())
    expect(surge).toMatchObject({ practice: true, travelMs: 5000 })

    const events = hold(round, lungePose(surge.side), surge.passAt - 3000, 200)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.legAt).toBe(-2850)
  })

  it('в зачётной части выпад задолго до окна не считается', () => {
    const round = legRound(TYPE.LUNGE, { startTravelMs: 5000, endTravelMs: 5000 })
    const surge = firstOfType(round, TYPE.LUNGE, feet())

    // сделал выпад за три секунды до пролёта: окно откроется много позже
    hold(round, lungePose(surge.side), surge.passAt - 3000, 200)
    settle(round, surge.passAt - BEFORE - 100)

    const miss = round
      .update(surge.passAt + DEFAULT_ROUND.legWindowAfterMs + 1, feet())
      .find((e) => e.type === 'obstacle.miss')

    expect(miss.reason).toBe('no-lunge')
  })

  it('просадка таза у выпада тоже личная — иначе настройка не спасает', () => {
    /**
     * Негибкий человек проходил «Настройку под себя», получал мягкую планку по
     * ноге — и всё равно не видел ни одного зачёта выпада, потому что упирался
     * ровно в то, чего настройка не мерила: в просадку таза.
     */
    const round = createRound({
      ...SHORT,
      types: [TYPE.LUNGE],
      durationMs: 60000,
      personalMax: { [LUNGE_DROP]: DEFAULT_ROUND.lungeDropK },
    })
    const surge = firstOfType(round, TYPE.LUNGE, feet())
    // личная планка таза: 0.7 от 0.30 — то есть 0.21 вместо 0.30
    const shallow = feet({
      angle: 72,
      hipY: 0.645,
      ankleBack: bySide(surge.side, 0.8, 0),
    })

    settle(round, surge.passAt - BEFORE - 100)
    const events = hold(round, shallow, surge.passAt - 200, 200)

    expect(events.find((e) => e.type === 'obstacle.clear')).toBeTruthy()
    // просадка всего 0.21 корпуса — общей планки в 0.30 не хватило бы
    expect(round.getState().cleared).toBe(1)
  })

  it('полоска волны показывает оба признака, а не один', () => {
    // Стопа, унесённая назад без просадки таза, выпадом не является. Полоска по
    // одной глубине горела бы полной и врала человеку.
    const round = legRound(TYPE.LUNGE)
    const surge = firstOfType(round, TYPE.LUNGE, feet())
    const side = surge.side

    // нога назад с запасом, таз на месте — полоска пуста
    round.update(surge.spawnAt + 100, feet({ ankleBack: bySide(side, 0.9, 0) }))
    expect(surge.progress).toBe(0)

    // ровно половина по каждому признаку
    round.update(
      surge.spawnAt + 200,
      feet({ ankleBack: bySide(side, DEFAULT_ROUND.lungeBackK / 2, 0), hipY: 0.63 }),
    )
    expect(surge.progress).toBeCloseTo(0.5, 2)

    // и оба признака целиком — полоска полна
    round.update(surge.spawnAt + 300, lungePose(side))
    expect(surge.progress).toBe(1)
  })
})

/**
 * Девять новых движений судятся так же, как волна с угольком, — состоявшимся
 * событием автомата (moves.js), а не позой в кадре. Здесь проверяется не сам
 * детектор (у него свой файл), а ПРОВОДКА: доходит ли событие до зачёта, где
 * стоит срез по приседу и что уходит в лог.
 */
describe('девять новых движений: зачёт по событию автомата', () => {
  const moveRound = (type, extra = {}) =>
    createRound({ ...SHORT, types: [type], durationMs: 60000, ...extra })

  /** Сырые признаки кадра — ровно то, что кладёт в позу readMoves. */
  const rawMoves = (over = {}) => ({
    hipX: 0.5,
    hipY: 0.6,
    torso: 0.2,
    shW: 0.2,
    ankleOut: { left: 0.1, right: 0.1 },
    wristOut: { left: 0.2, right: 0.2 },
    wristGap: 1.4,
    kneeUp: { left: -0.2, right: -0.2 },
    wristUp: { left: -0.3, right: -0.3 },
    wristDown: { left: -0.02, right: -0.02 },
    wristKnee: { left: 0.3, right: 0.3 },
    elbowKnee: { left: 0.3, right: 0.3 },
    ankleY: { left: 0.95, right: 0.95 },
    ...over,
  })

  /** Стойка со всеми признаками: от неё автомат и отсчитывает свою опору. */
  const rest = (over = {}) => ({ ...stand(), hipY: 0.6, torso: 0.2, moves: rawMoves(over) })

  /** Продержать позу: автомат отдаёт событие только после своей выдержки. */
  function hold(round, pose, from, ms, step = 50) {
    const events = []
    for (let t = from; t <= from + ms; t += step) events.push(...round.update(t, pose))
    return events
  }

  it('хлопок в окне — препятствие пройдено, и замер уходит в лог', () => {
    const round = moveRound(TYPE.CLAP)
    const plate = firstOfType(round, TYPE.CLAP, rest())
    expect(plate).toBeTruthy()
    // хлопок делают обеими руками: стороны у него нет
    expect(plate.side).toBeNull()

    round.update(plate.passAt - BEFORE - 100, rest())
    const clap = rest({ wristGap: 0.4, wristUp: { left: 0.1, right: 0.1 } })
    const events = hold(round, clap, plate.passAt - 200, 200)
    const clear = events.find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    // выдержка 200 мс: хлопать человек начал за 200 мс до пролёта, а событие
    // пришло ровно на пролёте — на пятом кадре, а не на первом
    expect(clear.moveAt).toBe(0)
    // в лог идёт САМ замер, а не доля: у хлопка это расстояние между кистями
    expect(clear.movePeak).toBeCloseTo(0.4, 2)
    expect(clear.bar).toBeCloseTo(DEFAULT_ROUND.clapK, 2)
  })

  it('движения не было — промах с причиной по имени движения', () => {
    const round = moveRound(TYPE.BEND)
    const plate = firstOfType(round, TYPE.BEND, rest())

    round.update(plate.passAt - BEFORE - 100, rest())
    const miss = round
      .update(plate.passAt + DEFAULT_ROUND.legWindowAfterMs + 1, rest())
      .find((e) => e.type === 'obstacle.miss')

    expect(miss.reason).toBe('no-bend')
  })

  it('боковой выпад не режется срезом «в приседе ничего не судим»', () => {
    /**
     * Та же грабля, что была с подъёмом колена и с волной: в боковом выпаде
     * колени согнуты по устройству движения, и общий срез убил бы само движение.
     * Ветка девяти новых поэтому стоит ДО среза.
     */
    const round = moveRound(TYPE.SIDELUNGE)
    const plate = firstOfType(round, TYPE.SIDELUNGE, rest())

    round.update(plate.passAt - BEFORE - 100, rest())
    // таз уехал в свою сторону и человек опустился на эту ногу; угол в колене
    // при этом глубже любого зачётного приседа
    const shift = plate.side === SIDE.LEFT ? 0.62 : 0.38
    const lunge = {
      ...rest({ hipX: shift, hipY: 0.665 }),
      angle: 72,
    }
    const events = hold(round, lunge, plate.passAt - 200, 200)

    expect(round.getState().ducking).toBe(true)
    expect(events.find((e) => e.type === 'obstacle.clear')).toBeTruthy()
  })

  /**
   * ПРОМАХ ДЕВЯТИ НОВЫХ ДОЛЖЕН БЫТЬ РАЗБИРАЕМ. В поле 14 августа складка дала
   * 2 зачёта из 13, и назвать причину было нечем: в логе стояла одна планка —
   * ни высоты колена, ни положения рук. У выпада такие замеры есть с самого
   * начала, и его промахи разбираются по логу за минуту.
   */
  const pairOf = (side, own, other) =>
    side === SIDE.LEFT ? { left: own, right: other } : { left: other, right: own }

  it('у скручивания в лог уходят оба признака, выдержка и помеха', () => {
    const round = moveRound(TYPE.TWISTKNEE)
    const plate = firstOfType(round, TYPE.TWISTKNEE, rest())
    const side = plate.side

    round.update(plate.passAt - BEFORE - 100, rest())
    // колено поднято, НО рука осталась при себе — это обычный подъём колена, и
    // по логу должно быть видно, чем именно скручивание не стало
    const kneeOnly = rest({ kneeUp: pairOf(side, 0.08, -0.2) })
    hold(round, kneeOnly, plate.passAt - 200, 200)
    const miss = round
      .update(plate.passAt + DEFAULT_ROUND.legWindowAfterMs + 1, kneeOnly)
      .find((e) => e.type === 'obstacle.miss')

    expect(miss).toBeTruthy()
    // высота колена и ОБА замера встречной руки: какой из них сработает,
    // зависит от манеры человека, и по одному промах не разбирается
    expect(miss.peaks).toEqual({ elbowCross: 1.5, wristCross: 1.5, kneeLift: 0.4 })
    // условия ни разу не сошлись, и мешала им именно рука
    expect(miss.held).toBe(0)
    expect(miss.block).toBe('cross')
  })

  it('скручивание в окне — препятствие пройдено', () => {
    const round = moveRound(TYPE.TWISTKNEE)
    const plate = firstOfType(round, TYPE.TWISTKNEE, rest())
    const side = plate.side
    // сторона у скручивания — по поднимаемому колену
    expect(side).toBeTruthy()

    round.update(plate.passAt - BEFORE - 100, rest())
    // человек тянется ЛОКТЕМ, как и просит команда: кисть при этом уходит мимо
    // колена, и по ней одной зачёта не было бы вовсе
    const twist = rest({
      kneeUp: pairOf(side, 0.08, -0.2),
      elbowKnee: pairOf(side, 0.06, 0.3),
    })
    const clear = hold(round, twist, plate.passAt - 200, 200).find(
      (e) => e.type === 'obstacle.clear',
    )

    expect(clear).toBeTruthy()
    // в лог идут оба замера, и «лучший» у обоих самый МАЛЕНЬКИЙ
    expect(clear.peaks).toEqual({ elbowCross: 0.3, wristCross: 1.5, kneeLift: 0.4 })
  })

  it('на зачёте замеры те же: по ним видно, с каким запасом движение прошло', () => {
    const round = moveRound(TYPE.CLAP)
    const plate = firstOfType(round, TYPE.CLAP, rest())

    round.update(plate.passAt - BEFORE - 100, rest())
    const clap = rest({ wristGap: 0.4, wristUp: { left: 0.1, right: 0.1 } })
    const clear = hold(round, clap, plate.passAt - 200, 200).find(
      (e) => e.type === 'obstacle.clear',
    )

    expect(clear).toBeTruthy()
    // у хлопка признак ОБРАТНЫЙ: в лог идёт самое малое расстояние между
    // кистями за окно, а не самое большое — иначе там стоял бы худший кадр
    expect(clear.peaks).toEqual({ wristGap: 0.4, armsUp: 0.5 })
    // выдержка дошла до своей планки, и мешать под конец было нечему
    expect(clear.held).toBeGreaterThanOrEqual(DEFAULT_MOVES.holdMs)
  })

  it('полоска показывает долю от порога главного признака', () => {
    const round = moveRound(TYPE.WINGS)
    const plate = firstOfType(round, TYPE.WINGS, rest())

    round.update(plate.spawnAt + 100, rest())
    expect(plate.progress).toBeCloseTo(0.2 / DEFAULT_ROUND.wingsK, 2)

    // ровно половина порога — половина полоски
    round.update(plate.spawnAt + 200, rest({ wristOut: { left: 0.55, right: 0.55 } }))
    expect(plate.progress).toBeCloseTo(0.5, 2)

    // и порог целиком — полоска полна
    round.update(plate.spawnAt + 300, rest({ wristOut: { left: 1.3, right: 1.3 } }))
    expect(plate.progress).toBe(1)
  })
})

/**
 * ПРЕДОХРАНИТЕЛЬ НА СЛОЖЕННЫЙ КОРПУС. В наклоне вперёд длина корпуса в кадре
 * падает до 0.06 от обычной, и всё, что на неё делится, взрывается: на записи
 * это дало 10 ложных ПРЫЖКОВ на наклонах — то есть наклоном вперёд можно было
 * бы бесплатно проходить ямы.
 */
describe('сложенный корпус не судится метриками, нормированными корпусом', () => {
  const pitRound = () => createRound({ ...SHORT, types: [TYPE.PIT], durationMs: 60000 })

  const upright = (over = {}) => ({
    hipX: 0.5,
    hipY: 0.6,
    torso: 0.2,
    shW: 0.2,
    ankleOut: { left: 0.1, right: 0.1 },
    wristOut: { left: 0.2, right: 0.2 },
    wristGap: 1.4,
    kneeUp: { left: -0.2, right: -0.2 },
    wristUp: { left: -0.3, right: -0.3 },
    wristDown: { left: -0.02, right: -0.02 },
    wristKnee: { left: 0.3, right: 0.3 },
    elbowKnee: { left: 0.3, right: 0.3 },
    ankleY: { left: 0.95, right: 0.95 },
    ...over,
  })

  /** Стоит на земле. torso — длина корпуса в кадре: 0.05 это сложенный пополам. */
  const ground = (torso = 0.2) => ({
    ...stand(),
    hipY: 0.6,
    torso: 0.2,
    ankleY: { left: 0.95, right: 0.95 },
    moves: upright({ torso }),
  })
  /** «В воздухе»: тело ушло вверх, обе стопы оторвались от пола. */
  const air = (torso = 0.2) => ({
    ...stand(),
    hipY: 0.55,
    torso: 0.2,
    ankleY: { left: 0.9, right: 0.9 },
    moves: upright({ torso, hipY: 0.55, ankleY: { left: 0.9, right: 0.9 } }),
  })

  it('прыжок стоя засчитывается как обычно', () => {
    const round = pitRound()
    const pit = firstOfType(round, TYPE.PIT, ground())

    round.update(pit.passAt - 200, ground())
    round.update(pit.passAt - 100, ground())
    const clear = round.update(pit.passAt, air()).find((e) => e.type === 'obstacle.clear')

    expect(clear).toBeTruthy()
    expect(clear.jumped).toBe(true)
  })

  it('те же кадры со сложенным корпусом прыжком не считаются', () => {
    const round = pitRound()
    const pit = firstOfType(round, TYPE.PIT, ground())

    // человек сложился вперёд: корпус в кадре вчетверо короче своей медианы
    round.update(pit.passAt - 200, ground(0.05))
    round.update(pit.passAt - 100, ground(0.05))
    const events = round.update(pit.passAt, air(0.05))

    expect(events.find((e) => e.type === 'obstacle.clear')).toBeFalsy()
    const miss = round
      .update(pit.passAt + AFTER + 1, ground(0.05))
      .find((e) => e.type === 'obstacle.miss')
    expect(miss.reason).toBe('no-jump')
  })
})

/**
 * Личные пороги в раунде. Модуль personal.js проверяется отдельно; здесь —
 * что движок их и правда СПРАШИВАЕТ и что личный максимум растёт от настоящей
 * игры, а не от отдельного экрана «покажи максимум».
 */
describe('личная планка амплитуды', () => {
  // подменённое хранилище не должно утекать в соседние проверки
  afterEach(() => vi.unstubAllGlobals())

  const kneeRound = (personalMax) =>
    createRound({ ...SHORT, types: [TYPE.KNEE], durationMs: 60000, personalMax })
  const knees = (left, right) => ({ ...stand(), kneeLift: { left, right } })
  const lifted = (ring, lift) =>
    ring.side === SIDE.LEFT ? knees(lift, -0.78) : knees(-0.78, lift)

  it('новый профиль без личных данных судится общими порогами', () => {
    const round = kneeRound({})
    const ring = firstOfType(round, TYPE.KNEE)

    // ровно на общем пороге не хватает, чуть выше — зачёт: планка общая
    expect(verdictFor(round, ring, lifted(ring, DEFAULT_ROUND.kneeLiftK)).type).toBe(
      'obstacle.miss',
    )
    const next = firstOfType(round, TYPE.KNEE, stand())
    expect(verdictFor(round, next, lifted(next, DEFAULT_ROUND.kneeLiftK + 0.01)).type).toBe(
      'obstacle.clear',
    )
  })

  it('слабому человеку планка мягче: 70% от его максимума', () => {
    // максимум 0.2 — ровно общий порог. Личная планка: 0.7 * 0.2 = 0.14
    const round = kneeRound({ knee: DEFAULT_ROUND.kneeLiftK })
    const ring = firstOfType(round, TYPE.KNEE)

    const verdict = verdictFor(round, ring, lifted(ring, 0.15))

    expect(verdict.type).toBe('obstacle.clear')
    // и по какой планке судили, видно прямо в логе
    expect(verdict.bar).toBeCloseTo(0.14, 2)
    expect(verdict.amp).toBeCloseTo(0.15, 2)
  })

  it('сильному человеку планка НЕ строже общей', () => {
    // 0.7 от максимума 2.0 — это 1.4, но общие пороги проверены записями:
    // выше них детектор ненадёжен, и планка упирается в потолок
    const round = kneeRound({ knee: 2 })
    const ring = firstOfType(round, TYPE.KNEE)

    const verdict = verdictFor(round, ring, lifted(ring, DEFAULT_ROUND.kneeLiftK + 0.01))

    expect(verdict.type).toBe('obstacle.clear')
    expect(verdict.bar).toBeCloseTo(DEFAULT_ROUND.kneeLiftK, 2)
  })

  it('пол не пробивается: на шевелении зачёта нет даже с нулевым максимумом', () => {
    const round = kneeRound({ knee: 0.01 })
    const ring = firstOfType(round, TYPE.KNEE)

    // планка упёрлась в пол — половину общего порога
    const verdict = verdictFor(round, ring, lifted(ring, 0.05))
    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.bar).toBeCloseTo(DEFAULT_ROUND.kneeLiftK / 2, 2)
  })

  it('планка внутри раунда не ползёт под ногами', () => {
    // человек выдал амплитуду лучше прежней — следующее препятствие не должно
    // потребовать от него больше, чем предыдущее
    const round = kneeRound({ knee: DEFAULT_ROUND.kneeLiftK })
    const first = firstOfType(round, TYPE.KNEE)
    const one = verdictFor(round, first, lifted(first, 0.9))

    const second = firstOfType(round, TYPE.KNEE, stand())
    const two = verdictFor(round, second, lifted(second, 0.15))

    expect(one.type).toBe('obstacle.clear')
    expect(two.type).toBe('obstacle.clear')
    expect(two.bar).toBe(one.bar)
  })

  it('личный максимум растёт от настоящей игры — и на зачёте, и на промахе', () => {
    // Отдельного экрана «покажи максимум» нет намеренно: его кто-нибудь прошёл
    // бы вполсилы, чтобы всю неделю собирать зачёты на мелких движениях.
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    })

    // раунд читает личные данные сам: их пока нет
    const round = createRound({ ...SHORT, types: [TYPE.KNEE], durationMs: 60000 })
    expect(readMaxes()).toEqual({})

    const ring = firstOfType(round, TYPE.KNEE)
    // движение не дотянуло до зачёта — но амплитуда всё равно запомнилась
    expect(verdictFor(round, ring, lifted(ring, 0.12)).type).toBe('obstacle.miss')
    expect(readMaxes().knee).toBeCloseTo(0.12, 2)

    const next = firstOfType(round, TYPE.KNEE, stand())
    verdictFor(round, next, lifted(next, 0.85))
    expect(readMaxes().knee).toBeCloseTo(0.85, 2)

    // слабое движение следом максимум не опускает
    const third = firstOfType(round, TYPE.KNEE, stand())
    verdictFor(round, third, lifted(third, 0.05))
    expect(readMaxes().knee).toBeCloseTo(0.85, 2)

    vi.unstubAllGlobals()
  })

  it('после раунда с большими амплитудами планка следующего выросла', () => {
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    })

    // первый раунд человека со слабой амплитудой: планка упала до пола
    const weak = createRound({ ...SHORT, types: [TYPE.KNEE], durationMs: 60000 })
    const ring = firstOfType(weak, TYPE.KNEE)
    const before = verdictFor(weak, ring, lifted(ring, 0.05))
    expect(before.bar).toBeCloseTo(DEFAULT_ROUND.kneeLiftK, 2)

    // дальше он размялся и выдал вдвое больше
    const better = firstOfType(weak, TYPE.KNEE, stand())
    verdictFor(weak, better, lifted(better, 0.24))

    // следующий раунд считает планку уже от нового максимума: 0.7 * 0.24
    const round = createRound({ ...SHORT, types: [TYPE.KNEE], durationMs: 60000 })
    const after = firstOfType(round, TYPE.KNEE)
    const verdict = verdictFor(round, after, lifted(after, 0.17))

    expect(verdict.type).toBe('obstacle.clear')
    expect(verdict.bar).toBeCloseTo(0.168, 2)
    expect(verdict.bar).toBeLessThan(before.bar)

    vi.unstubAllGlobals()
  })
})

describe('кольцо: зачёт по подъёму колена', () => {
  const kneeRound = () => createRound({ ...SHORT, types: [TYPE.KNEE], durationMs: 60000 })

  /** Поза с поднятым коленом: lift — высота над тазом в длинах корпуса. */
  const knees = (left, right, extra = {}) => ({
    ...stand(),
    kneeLift: { left, right },
    ...extra,
  })

  it('колено нужной ноги выше таза — кольцо пробито', () => {
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)
    expect(ring).toBeTruthy()

    const lifted = ring.side === SIDE.LEFT ? knees(0.6, -0.78) : knees(-0.78, 0.6)
    const verdict = verdictFor(round, ring, lifted)

    expect(verdict.type).toBe('obstacle.clear')
    expect(verdict.lift).toBeCloseTo(0.6, 5)
  })

  it('колено другой ноги не считается', () => {
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)

    const wrongLeg = ring.side === SIDE.LEFT ? knees(-0.78, 0.6) : knees(0.6, -0.78)
    const verdict = verdictFor(round, ring, wrongLeg)

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-knee')
  })

  it('колено поднято чуть-чуть — недобор', () => {
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)

    // зачёт даётся на середине пути от покоя (-0.78) к линии таза
    const low = ring.side === SIDE.LEFT ? knees(0.1, -0.78) : knees(-0.78, 0.1)
    expect(verdictFor(round, ring, low).reason).toBe('no-knee')
  })

  it('оба колена идут к тазу — это присед, а не подъём колена', () => {
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)

    // живая запись: в приседе к тазу идут обе ноги, разница между ними мала
    const verdict = verdictFor(round, ring, knees(0.25, 0.22))

    expect(verdict.type).toBe('obstacle.miss')
    expect(verdict.reason).toBe('no-knee')
  })

  it('подъём колена засчитывается и с согнутыми ногами', () => {
    // поднятая нога сама сгибается, и средний угол коленей падает ниже зачётной
    // глубины приседа: общий срез «в приседе ничего не судим» отбивал
    // правильный подъём. Полевой лог: lift 0.27–0.41 при пороге 0.2 — и промах
    // с причиной 'sitting'
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)

    const lifted = ring.side === SIDE.LEFT ? knees(0.35, -0.78) : knees(-0.78, 0.35)
    const verdict = verdictFor(round, ring, { ...lifted, angle: 80 })

    expect(verdict.type).toBe('obstacle.clear')
    expect(verdict.lift).toBeCloseTo(0.35, 5)
  })

  it('присед кольцом не засчитывается: колено держит асимметрия, а не угол', () => {
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)

    // настоящий присед: ноги согнуты, оба колена высоко и почти на одной высоте
    const verdict = verdictFor(round, ring, { ...knees(0.35, 0.3), angle: 80 })

    expect(verdict.type).toBe('obstacle.miss')
    // причина у колена всегда одна: «колено выше», а не «не приседай»
    expect(verdict.reason).toBe('no-knee')
  })

  it('поднятое колено видно полоской ещё до пролёта', () => {
    const round = kneeRound()
    const ring = firstOfType(round, TYPE.KNEE)

    // нога внизу — полоска пустая
    round.update(ring.spawnAt + 100, knees(-0.9, -0.9))
    expect(ring.progress).toBe(0)

    // колено на зачётной высоте — полоска полная
    round.update(ring.spawnAt + 200, ring.side === SIDE.LEFT ? knees(0.25, -0.9) : knees(-0.9, 0.25))
    expect(ring.progress).toBe(1)
  })
})

describe('анти-чит для рук и ног', () => {
  it('присед не ломает нейтральную стойку: в нём таз опускается к коленям', () => {
    const round = createRound({ ...SHORT, types: [TYPE.BARRIER] })

    // в приседе колено оказывается почти на уровне таза, а руки уходят вперёд —
    // полевой тест показал, что строгая проверка после этого не давала засчитать
    // вообще ничего
    round.update(2000, { ...squat(), kneeLift: { left: 0.15, right: 0.15 } })
    round.update(2200, { ...stand(), kneeLift: { left: -0.5, right: -0.5 } })

    expect(round.getState().mustStand).toBe(false)
  })

  const kneeRound = () => createRound({ ...SHORT, types: [TYPE.KNEE], durationMs: 60000 })

  it('держать колено поднятым весь раунд нельзя', () => {
    // сторону первого кольца узнаём на отдельном раунде: иначе прогон стоя
    // сам снимет анти-чит, и проверка потеряет смысл
    const ring = firstOfType(kneeRound(), TYPE.KNEE)
    const round = kneeRound()
    const held = ring.side === SIDE.LEFT ? { left: 0.6, right: -0.78 } : { left: -0.78, right: 0.6 }
    const pose = { ...stand(), kneeLift: held }

    // ни одного кадра в нейтральной стойке: колено так и не опускалось
    const events = []
    for (let t = 0; t <= 30000; t += 100) events.push(...round.update(t, pose))

    const verdicts = events.filter(
      (e) => e.type === 'obstacle.clear' || e.type === 'obstacle.miss',
    )
    expect(verdicts.length).toBeGreaterThan(1)
    expect(verdicts.every((v) => v.type === 'obstacle.miss')).toBe(true)
    expect(verdicts[1].reason).toBe('no-stand')
  })

  it('держать руку вытянутой бесполезно: удар — это переход, а не поза', () => {
    const round = createRound({ ...SHORT, types: [TYPE.STRIKE], durationMs: 60000 })
    const first = firstOfType(round, TYPE.STRIKE)
    const out = first.side === SIDE.LEFT ? { left: 0.9, right: 0.05 } : { left: 0.05, right: 0.9 }
    const punched = { ...stand(), reach: out }

    // ударил один раз и оставил руку вытянутой (замах и удар — 200 мс)
    round.update(first.passAt - 500, { ...stand(), reach: { left: 0.05, right: 0.05 } })
    expect(round.update(first.passAt - 300, punched).some((e) => e.type === 'obstacle.clear')).toBe(
      true,
    )

    // следующий астероид с той же вытянутой рукой не засчитывается: удар — это
    // возврат и новый вынос, а не поза
    const second = firstOfType(round, TYPE.STRIKE, punched)
    const verdict = verdictFor(round, second, punched, second.passAt, STRIKE_AFTER)
    expect(verdict.type).toBe('obstacle.miss')
  })
})

describe('симметрия сторон', () => {
  // только стены: здесь проверяется разбор сторон, а не разнообразие потока
  const LONG = {
    ...SHORT,
    types: [TYPE.WALL],
    durationMs: 180000,
    firstSpawnAtMs: 1500,
    rampCurve: 0.5,
  }

  /**
   * Пройти раунд стоя, у каждой стены сделав зеркальный шаг одной и той же
   * величины. Расписание не зависит от позы, поэтому план снимаем сухим
   * прогоном, а потом отыгрываем его точными кадрами в моменты пролёта.
   */
  function runWalls(factor) {
    const plan = collectSpawns(createRound(LONG), LONG.durationMs, stand(), 250)
    const walls = plan.filter((o) => o.type === TYPE.WALL)
    const round = createRound(LONG)
    const verdicts = []
    let t = 0

    for (const wall of walls) {
      while (t < wall.passAt - 100) {
        t += 100
        round.update(t, stand(0.5))
      }
      // шагнул и держит смещение, пока стена не пройдёт: при зачёте вердикт
      // приходит сразу, при недоборе — по закрытию окна
      const pose = stand(stepFor(wall, factor))
      t = wall.passAt
      for (const at of [t, wall.passAt + AFTER + 1]) {
        for (const ev of round.update(at, pose)) {
          if (ev.obstacle?.type === TYPE.WALL && ev.type !== 'obstacle.spawn') verdicts.push(ev)
        }
      }
      t = wall.passAt + AFTER + 1
    }
    return verdicts
  }

  it('зеркальные шаги от одинаковой базы дают одинаковый вердикт', () => {
    const verdicts = runWalls(1.2)
    const left = verdicts.filter((v) => v.side === SIDE.LEFT)
    const right = verdicts.filter((v) => v.side === SIDE.RIGHT)

    expect(left.length).toBeGreaterThan(1)
    expect(right.length).toBeGreaterThan(1)
    // обе стороны засчитаны, и величина смещения одна и та же
    for (const v of verdicts) {
      expect(v.type).toBe('obstacle.clear')
      expect(v.dodge).toBeCloseTo(1.2 * K, 10)
    }
  })

  it('недобор наказывается одинаково слева и справа', () => {
    const verdicts = runWalls(0.8)
    const sides = new Set(verdicts.map((v) => v.side))

    expect(sides).toEqual(new Set([SIDE.LEFT, SIDE.RIGHT]))
    for (const v of verdicts) {
      expect(v.type).toBe('obstacle.miss')
      expect(v.dodge).toBeCloseTo(0.8 * K, 10)
    }
  })

  it('обе стороны встречаются, и ни одна не пропадает', () => {
    const walls = collectSpawns(createRound(LONG), LONG.durationMs, stand(), 250).filter(
      (o) => o.type === TYPE.WALL,
    )
    const left = walls.filter((o) => o.side === SIDE.LEFT).length
    const right = walls.filter((o) => o.side === SIDE.RIGHT).length

    expect(left).toBeGreaterThan(2)
    expect(right).toBeGreaterThan(2)
    // случайность не должна выродиться в перекос вроде 9 к 1
    expect(Math.min(left, right) / Math.max(left, right)).toBeGreaterThan(0.4)
  })
})

describe('генератор препятствий', () => {
  const LONG = { ...SHORT, durationMs: 180000, firstSpawnAtMs: 1500, rampCurve: 0.6 }

  const planOf = (seed) =>
    collectSpawns(createRound({ ...LONG, seed }), LONG.durationMs, stand(), 250)

  it('раунд набирает почти все типы, и не больше двух одинаковых подряд', () => {
    const kinds = planOf(11).map((o) => o.type)
    const all = Object.values(TYPE)

    /**
     * Типов стало восемнадцать, а препятствий в трёхминутном раунде — около
     * шестидесяти. Требовать от КАЖДОГО типа по два вхождения больше нельзя:
     * на трёх препятствиях на тип это уже не свойство генератора, а везение
     * броска. Проверяем то, что и правда обязано выполняться, — что раунд
     * набирает подавляющее большинство типов, а не крутится на трёх-четырёх.
     */
    const seen = all.filter((type) => kinds.includes(type))
    expect(seen.length).toBeGreaterThanOrEqual(all.length - 3)

    for (let i = 2; i < kinds.length; i += 1) {
      const three = kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]
      expect(three).toBe(false)
    }
  })

  it('недостижимых типов нет: за несколько раундов выпадает каждый', () => {
    // то, что прежде проверялось одним раундом: тип, который не выпадает
    // НИКОГДА, — это выпавший из пула тип, а не редкость броска
    const kinds = new Set([11, 12, 13].flatMap((seed) => planOf(seed).map((o) => o.type)))
    // выключенные движения сюда не входят по замыслу: они сняты с ротации
    const expected = Object.values(TYPE).filter(
      (type) => !DEFAULT_ROUND.disabledTypes.includes(type),
    )

    expect(expected.filter((type) => !kinds.has(type))).toEqual([])
  })

  it('выключенное движение не выпадает ни разу, но по прямому запросу работает', () => {
    /**
     * Захлёст снят с ротации по полю: детектор рабочий, но само движение в
     * потоке не прижилось. Снят он именно с ПОТОКА, а не из кода — тесты
     * детектора, снятие записей и отладочный ключ `?types=` продолжают его
     * звать, и он обязан отзываться.
     */
    const kinds = new Set([11, 12, 13].flatMap((seed) => planOf(seed).map((o) => o.type)))
    for (const type of DEFAULT_ROUND.disabledTypes) expect(kinds.has(type)).toBe(false)

    const forced = collectSpawns(
      createRound({ ...SHORT, types: [TYPE.HEEL], durationMs: 30000 }),
      30000,
      stand(),
      200,
    )
    expect(forced.length).toBeGreaterThan(3)
    expect(forced.every((o) => o.type === TYPE.HEEL)).toBe(true)
  })

  it('раунд воспроизводим по сиду и различается между сидами', () => {
    const key = (o) => `${o.type}${o.side}`
    const a = planOf(11).map(key)
    const b = planOf(11).map(key)
    const other = planOf(12).map(key)

    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(5)
    // порядок не угадать по предыдущему раунду
    expect(other).not.toEqual(a)
  })

  it('одна и та же тренировка повторяется полностью: три попытки сравнимы', () => {
    const key = (o) => `${o.type}:${o.side}:${o.spawnAt}:${o.travelMs}`
    const first = planOf(20260811).map(key)
    const second = planOf(20260811).map(key)
    const nextDay = planOf(20260812).map(key)

    // попытка за попыткой — одно и то же расписание, иначе результаты
    // сравнивать не с чем: одному достанется лёгкий порядок, другому тяжёлый
    expect(second).toEqual(first)
    expect(nextDay).not.toEqual(first)
  })

  it('порядок не читается наперёд: типы не идут жёстким циклом', () => {
    // разминки в этом раунде нет вовсе (practiceNeeded: 0), и отрезать от плана
    // её длину незачем: это отъедало бы у проверки треть препятствий
    const kinds = planOf(11).map((o) => o.type)

    // при жёстком чередовании каждый тип точно предсказывался бы по предыдущему
    const followers = new Map()
    kinds.slice(0, -1).forEach((k, i) => {
      const set = followers.get(k) || new Set()
      set.add(kinds[i + 1])
      followers.set(k, set)
    })
    /**
     * Смотрим на типы, которые в раунде и правда повторялись: у выпавшего
     * дважды за раунд типа продолжений физически не больше двух, и «одно
     * продолжение» у него значит редкость, а не жёсткий цикл. Типов теперь
     * восемнадцать, и такие в каждом раунде есть.
     */
    const often = [...followers.keys()].filter(
      (k) => kinds.filter((x) => x === k).length >= 4,
    )
    expect(often.length).toBeGreaterThan(3)
    for (const type of often) expect(followers.get(type).size).toBeGreaterThan(1)
  })

  it('стороны не чередуются механически, но обе встречаются', () => {
    const sides = planOf(11)
      .filter((o) => o.side != null)
      .map((o) => o.side)

    expect(sides.filter((s) => s === SIDE.LEFT).length).toBeGreaterThan(2)
    expect(sides.filter((s) => s === SIDE.RIGHT).length).toBeGreaterThan(2)
    // где-то сторона обязана повториться — иначе это то же жёсткое чередование
    expect(sides.some((s, i) => i > 0 && s === sides[i - 1])).toBe(true)
  })

})

describe('состав потока зависит от темпа', () => {
  /**
   * Полевой тест уровней: новичок 39/40, профи 59/76 — и почти все промахи во
   * второй половине раунда, где интервал уходит ниже порога. Барьер, стена и
   * балка судятся честно на любом темпе (там поза), а удару и колену нужно
   * время на возврат: рука не успевает уйти назад (промахи с peak 0.67–0.89),
   * а поднятая нога режет следующий шаг (промах no-step при шаге на 1.39).
   * Поэтому на плотном темпе их доля в потоке падает вдвое.
   */
  const LONG_MS = 600000

  /** Долгий раунд с постоянным интервалом: темп здесь задаётся одним числом. */
  const streamAt = (gapMs, extra = {}) => {
    const config = {
      ...SHORT,
      seed: 4242,
      durationMs: LONG_MS,
      startGapMs: gapMs,
      endGapMs: gapMs,
      startTravelMs: 2000,
      endTravelMs: 2000,
      firstSpawnAtMs: 2000,
      ...extra,
    }
    return collectSpawns(createRound(config), LONG_MS, stand(), 500)
  }

  /**
   * Движения, которым нужно время на возврат. Их уже одиннадцать из
   * восемнадцати типов: к удару, колену, прыжку, выпаду и захлёсту добавились
   * присед с прыжком, прыжок врозь, джек, боковой выпад, мах ногой и
   * скручивание — из всех шести человек ВОЗВРАЩАЕТСЯ в стойку, а не остаётся
   * в позе.
   */
  const RECOVERY = [
    TYPE.STRIKE,
    TYPE.KNEE,
    TYPE.PIT,
    TYPE.LUNGE,
    TYPE.HEEL,
    TYPE.JUMPSQUAT,
    TYPE.HOP,
    TYPE.JACK,
    TYPE.SIDELUNGE,
    TYPE.LEGSIDE,
    TYPE.TWISTKNEE,
  ]
  const recoveryShare = (spawns) =>
    spawns.filter((o) => RECOVERY.includes(o.type)).length / spawns.length

  it('порог и множитель лежат в конфиге раунда', () => {
    expect(DEFAULT_ROUND.crowdedGapMs).toBe(2800)
    // половина — значит вдвое реже остальных типов
    expect(DEFAULT_ROUND.recoveryTypeWeight).toBe(0.5)
  })

  it('на плотном темпе движений с возвратом заметно меньше, чем на спокойном', () => {
    const calm = recoveryShare(streamAt(4000))
    const crowded = recoveryShare(streamAt(2200))

    // спокойный темп: все восемнадцать типов равновероятны, значит одиннадцать
    // из восемнадцати
    expect(calm).toBeGreaterThan(0.55)
    // плотный: вдвое меньший вес уводит их долю к 5.5 из 12.5
    expect(crowded).toBeLessThan(0.47)
    expect(crowded).toBeLessThan(calm * 0.8)
  })

  it('но совсем они не исчезают: это десять движений из семнадцати', () => {
    const spawns = streamAt(2200)
    // захлёст снят с ротации, поэтому движений с возвратом теперь десять
    for (const type of RECOVERY) {
      if (DEFAULT_ROUND.disabledTypes.includes(type)) continue
      expect(spawns.filter((o) => o.type === type).length).toBeGreaterThan(3)
    }
  })

  it('множитель из конфига и правда решает: с единицей поток снова ровный', () => {
    const crowded = recoveryShare(streamAt(2200))
    const flat = recoveryShare(streamAt(2200, { recoveryTypeWeight: 1 }))

    expect(flat).toBeGreaterThan(0.5)
    expect(crowded).toBeLessThan(flat)
  })

  it('взвешенный выбор не сломал ни детерминизм, ни правило двух подряд', () => {
    const key = (o) => `${o.type}:${o.side}:${o.spawnAt}`
    const first = streamAt(2200).map(key)
    const second = streamAt(2200).map(key)
    const otherSeed = streamAt(2200, { seed: 99 }).map(key)

    expect(second).toEqual(first)
    expect(first.length).toBeGreaterThan(100)
    expect(otherSeed).not.toEqual(first)

    // и на плотном темпе три одинаковых подряд по-прежнему невозможны
    const kinds = streamAt(2200).map((o) => o.type)
    for (let i = 2; i < kinds.length; i += 1) {
      expect(kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]).toBe(false)
    }
  })
})

describe('конец раунда не оставляет неотсуженного', () => {
  /**
   * Запас перед концом раунда считался по обычному окну в 500 мс, а у удара,
   * выпада и захлёста оно 1400. Такое препятствие успевало вылететь, раунд
   * кончался раньше, чем закрывалось его окно, и оно навсегда оставалось
   * incoming: spawned больше, чем cleared + missed, а экран результата занижал
   * «сколько было».
   */
  const playToEnd = (types, durationMs) => {
    const round = createRound({ ...SHORT, types, durationMs, practiceNeeded: 0 })
    // человек просто стоит: важно не что засчиталось, а что всё отсужено
    for (let t = 0; t <= durationMs + 3000; t += 100) round.update(t, stand())
    return round.getState()
  }

  /**
   * Длину раунда перебираем, а не берём одну. Баг граничный: он вылезает,
   * только когда последний вылет попадает в узкую щель между «успевает по
   * обычному окну» и «не успевает по широкому». При одной длине расписание
   * может в эту щель не попасть — и тест молча прозевает поломку.
   */
  const LENGTHS = Array.from({ length: 21 }, (_, i) => 19000 + i * 100)

  const hung = (types) => {
    const bad = []
    for (const durationMs of LENGTHS) {
      const state = playToEnd(types, durationMs)
      if (state.incoming.length || state.cleared + state.missed !== state.spawned) {
        bad.push({ durationMs, повисло: state.incoming.length })
      }
    }
    return bad
  }

  it('раунд из одних астероидов: ни одного повисшего препятствия', () => {
    // у удара окно после пролёта 1400 мс — втрое шире обычного
    expect(DEFAULT_ROUND.strikeWindowAfterMs).toBeGreaterThan(DEFAULT_ROUND.hitWindowAfterMs)
    expect(hung([TYPE.STRIKE])).toEqual([])

    // и раунд при этом не опустел: препятствия были и все отсужены
    const state = playToEnd([TYPE.STRIKE], 20000)
    expect(state.ended).toBe(true)
    expect(state.spawned).toBeGreaterThan(0)
    expect(state.cleared + state.missed).toBe(state.spawned)
  })

  it('и так же у всех остальных типов, включая широкие окна', () => {
    for (const type of [
      TYPE.BARRIER,
      TYPE.WALL,
      TYPE.BEAM,
      TYPE.KNEE,
      TYPE.BIRD,
      TYPE.PIT,
      TYPE.LUNGE,
      TYPE.HEEL,
    ]) {
      expect({ тип: type, повисло: hung([type]) }).toEqual({ тип: type, повисло: [] })
    }
  })

  it('в смешанном раунде запас берётся по САМОМУ ШИРОКОМУ окну пула', () => {
    // тип на момент проверки ещё не выбран, поэтому считать надо по худшему
    expect(hung(null)).toEqual([])
  })
})

describe('разгон темпа', () => {
  /** Зачётная часть боевого раунда: разминка проверяется отдельно. */
  const realRound = () => createRound({ mode: 'moves', practiceNeeded: 0 })

  it('интервалы сжимаются от начала к концу раунда', () => {
    const spawns = collectSpawns(realRound(), 180000, stand(), 250)
    const at = spawns.map((o) => o.spawnAt)
    const gaps = at.slice(1).map((t, i) => t - at[i])

    expect(gaps[0]).toBeLessThanOrEqual(DEFAULT_ROUND.startGapMs)
    expect(gaps[gaps.length - 1]).toBeLessThan(DEFAULT_ROUND.startGapMs * 0.65)
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1])
  })

  it('разгон заметен уже в первую минуту, а не только к финалу', () => {
    const spawns = collectSpawns(realRound(), 180000, stand(), 250)
    const at = spawns.map((o) => o.spawnAt)
    const gaps = at.slice(1).map((t, i) => t - at[i])

    // интервал на первой минуте против стартового: полевой тест жил именно здесь,
    // и линейный разгон там давал меньше 15% — это глазом не читается
    const firstMinute = gaps[at.findIndex((t) => t > 60000) - 1]
    const shrink = 1 - firstMinute / DEFAULT_ROUND.startGapMs
    expect(shrink).toBeGreaterThan(0.3)
  })

  it('время пути тоже сжимается к концу раунда', () => {
    // обучающие не в счёт — у них своя длительность
    const travels = collectSpawns(realRound(), 180000, stand(), 250)
      .filter((o) => o.index >= PRACTICE_LEN)
      .map((o) => o.travelMs)

    expect(travels[0]).toBeLessThanOrEqual(DEFAULT_ROUND.startTravelMs)
    expect(travels[travels.length - 1]).toBeLessThan(travels[0])
    expect(travels[travels.length - 1]).toBeLessThanOrEqual(DEFAULT_ROUND.endTravelMs + 50)
  })

  it('темп отдаётся наружу — по нему разгоняется и картинка', () => {
    const round = realRound()
    round.update(0, stand())
    expect(round.getState().tempo).toBe(0)

    round.update(90000, stand())
    const middle = round.getState().tempo
    expect(middle).toBeGreaterThan(0.5) // к середине уже больше половины разгона

    round.update(180000, stand())
    expect(round.getState().tempo).toBe(1)
  })
})

describe('боевой раунд по умолчанию — ловец мишеней', () => {
  /**
   * Здесь проверяется не судейство ловца (оно своё, в catcher.test.js), а ШОВ:
   * движок обязан отдавать его мишени тем же самым видом события, что и
   * препятствия. Разойдись словари — и очки, звук, слой мишеней, логи и оба
   * автопрогона пришлось бы учить второму, а половина из них разъехалась бы с
   * первой же правкой.
   */
  const W = 0.24
  const VY = W / (4 / 3)

  /** Человек стоит по центру кадра 3:4. Про пропорции подробно — catcher.test.js. */
  function catchPose(over = {}) {
    const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }))
    const put = (i, x, y) => {
      points[i] = { x, y }
    }
    const sy = 0.3
    const hy = sy + TORSO_K * VY
    put(11, 0.5 + W / 2, sy)
    put(12, 0.5 - W / 2, sy)
    put(13, 0.5 + 0.45 * W, sy + 0.78 * VY)
    put(14, 0.5 - 0.45 * W, sy + 0.78 * VY)
    put(15, 0.5 + 0.4 * W, sy + 1.45 * VY)
    put(16, 0.5 - 0.4 * W, sy + 1.45 * VY)
    put(23, 0.5 + 0.29 * W, hy)
    put(24, 0.5 - 0.29 * W, hy)
    put(25, 0.5 + 0.29 * W, hy + 1.11 * VY)
    put(26, 0.5 - 0.29 * W, hy + 1.11 * VY)
    put(27, 0.5 + 0.29 * W, hy + 2.07 * VY)
    put(28, 0.5 - 0.29 * W, hy + 2.07 * VY)
    for (const [i, [x, y]] of Object.entries(over)) put(Number(i), x, y)
    return points
  }

  const standing = () => ({ landmarks: catchPose() })
  /** Кадр, где названная точка стоит ровно в центре мишени. */
  const reaching = (obstacle) => ({
    landmarks: catchPose({
      [PART_POINTS[obstacle.part][obstacle.side]]: [obstacle.spot.x, obstacle.spot.y],
    }),
  })

  const catchRound = (extra = {}) =>
    createRound({ durationMs: 60000, seed: 3, firstSpawnAtMs: 0, ...extra })

  /** Довести раунд до ближайшей мишени. */
  function nextTarget(round, from = 0) {
    for (let t = from; t <= from + 8000; t += 50) {
      for (const event of round.update(t, standing())) {
        if (event.type === 'obstacle.spawn') return event.obstacle
      }
    }
    return null
  }

  it('по умолчанию раунд собирается ловцом, а ?moves=1 возвращает движения', () => {
    expect(DEFAULT_ROUND.mode).toBe(MODE.CATCH)
    expect(catchRound().getState().mode).toBe(MODE.CATCH)
    expect(createRound({ mode: MODE.MOVES }).getState().mode).toBe(MODE.MOVES)
  })

  it('у ловца нет разминки: мишень объясняет себя сама', () => {
    const round = catchRound({ practiceNeeded: 2 })
    round.update(0, standing())
    expect(round.getState().practice).toBe(false)
    expect(round.getState().practiceMovement).toBeNull()
  })

  it('мишень приходит обычным obstacle.spawn — с частью тела и местом', () => {
    const target = nextTarget(catchRound())
    expect(target.type).toBe(CATCH_TYPE)
    expect(['palm', 'elbow', 'knee', 'foot']).toContain(target.part)
    expect(['left', 'right']).toContain(target.side)
    // место в НОРМИРОВАННЫХ координатах: перевод в пиксели — дело отрисовки
    expect(target.spot.x).toBeGreaterThan(0)
    expect(target.spot.x).toBeLessThan(1)
    expect(target.spot.rx).toBeGreaterThan(0)
    expect(target.lifeMs).toBe(DEFAULT_ROUND.targetLifeMs)
  })

  it('зачёт и промах приходят теми же событиями, что и у препятствий', () => {
    const round = catchRound()
    const target = nextTarget(round)
    let clear = null
    for (let t = target.spawnAt + 50; t <= target.spawnAt + 500 && !clear; t += 50) {
      for (const event of round.update(t, reaching(target))) {
        if (event.type === 'obstacle.clear') clear = event
      }
    }
    expect(clear).not.toBeNull()
    expect(clear.obstacle.id).toBe(target.id)
    expect(clear.part).toBe(target.part)
    expect(clear.reason).toBeNull()
    expect(round.getState().cleared).toBe(1)

    // а следующую мишень человек просто пропускает
    const next = nextTarget(round, clear.at)
    let miss = null
    for (let t = next.spawnAt; t <= next.passAt + 200 && !miss; t += 50) {
      for (const event of round.update(t, standing())) {
        if (event.type === 'obstacle.miss') miss = event
      }
    }
    expect(miss.reason).toBe('no-catch')
    // единственное число, по которому разбирается промах ловца
    expect(miss.near).toBeGreaterThan(1)
    expect(round.getState().missed).toBe(1)
  })

  it('время жизни мишени берётся у уровня, и от него зависит поток', () => {
    const count = (lifeMs) => {
      const round = createRound({ durationMs: 90000, seed: 9, targetLifeMs: lifeMs })
      let spawned = 0
      for (let t = 0; t <= 90000; t += 50) {
        for (const event of round.update(t, standing())) {
          if (event.type === 'obstacle.spawn') spawned += 1
        }
      }
      return spawned
    }
    // человек стоит столбом: чем короче жизнь мишени, тем больше их выходит
    expect(count(2500)).toBeGreaterThan(count(3500))
  })

  it('мишень, которая не успевает истечь до конца раунда, не выпускается', () => {
    const round = createRound({ durationMs: 10000, seed: 5, targetLifeMs: 2500 })
    const spawns = []
    let ended = null
    for (let t = 0; t <= 12000; t += 50) {
      for (const event of round.update(t, standing())) {
        if (event.type === 'obstacle.spawn') spawns.push(event.obstacle)
        if (event.type === 'round.end') ended = event
      }
    }
    // ни одной неотсуженной: spawned обязан сойтись с cleared + missed
    for (const target of spawns) expect(target.status).not.toBe('incoming')
    expect(ended.spawned).toBe(spawns.length)
    expect(ended.cleared + ended.missed).toBe(ended.spawned)
  })

  it('анти-чита на стойку у ловца нет — он ничего такого не просит', () => {
    const round = catchRound()
    nextTarget(round)
    expect(round.getState().mustStand).toBe(false)
  })

  it('мишень под ногу снимает паузу по потере ног у края кадра', () => {
    // нога уходит в полторы ширины плеч вбок, и голеностоп закономерно
    // теряется: останавливать раунд ровно в этот момент — то же самое, что
    // наказывать за движение, которого игра сама и потребовала
    const round = createRound({ durationMs: 120000, seed: 2, targetLifeMs: 3500 })
    let sawLeg = false
    for (let t = 0; t <= 60000; t += 50) {
      round.update(t, standing())
      const state = round.getState()
      const live = state.incoming[0]
      if (live && (live.part === 'foot' || live.part === 'knee')) {
        sawLeg = true
        expect(state.wallIncoming).toBe(true)
      }
    }
    expect(sawLeg).toBe(true)
  })

  it('без точек позы мишени не появляются и раунд просто ждёт', () => {
    const round = catchRound()
    let spawned = 0
    for (let t = 0; t <= 20000; t += 50) {
      for (const event of round.update(t, { landmarks: null })) {
        if (event.type === 'obstacle.spawn') spawned += 1
      }
    }
    expect(spawned).toBe(0)
  })

  it('один сид — один и тот же поток мишеней', () => {
    const run = () => {
      const round = createRound({ durationMs: 40000, seed: 77 })
      const out = []
      for (let t = 0; t <= 40000; t += 50) {
        for (const event of round.update(t, standing())) {
          if (event.type === 'obstacle.spawn') {
            out.push(`${event.obstacle.part}:${event.obstacle.side}:${event.obstacle.spawnAt}`)
          }
        }
      }
      return out
    }
    expect(run()).toEqual(run())
    // сорок секунд стояния столбом при жизни мишени 3.5 с — это девять мишеней
    expect(run().length).toBeGreaterThan(8)
  })
})
