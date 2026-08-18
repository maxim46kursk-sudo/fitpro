import { describe, expect, it } from 'vitest'
import { createSquatTracker } from './squat.js'
import { DEFAULT_THRESHOLDS } from './thresholds.js'
import { LM } from '../pose/landmarks.js'

/**
 * Сравнение двух способов объединить углы двух ног — среднее против минимума —
 * на синтетических данных с рассинхроном ног, шумом и разным темпом.
 *
 * Это не столько тест, сколько эксперимент: он печатает таблицу, по которой
 * выбран вариант по умолчанию. Assert в конце фиксирует результат, чтобы
 * выбор нельзя было случайно откатить.
 */

const FPS = 25
const FRAME_MS = 1000 / FPS

/** Детерминированный псевдослучайный шум: тест не должен «моргать». */
function makeNoise(seed) {
  let s = seed >>> 0
  return (amplitude) => {
    s = (s * 1664525 + 1013904223) >>> 0
    const u = s / 0xffffffff
    s = (s * 1664525 + 1013904223) >>> 0
    const v = s / 0xffffffff
    const gauss = Math.sqrt(-2 * Math.log(u + 1e-9)) * Math.cos(2 * Math.PI * v)
    return gauss * amplitude
  }
}

/** Один присед как приподнятый косинус: 175° -> bottom -> 175°. */
function legWave(tMs, periodMs, phaseMs, top, bottom) {
  const t = tMs - phaseMs
  if (t < 0) return top
  const cycle = (t % periodMs) / periodMs
  // 0 -> top, 0.5 -> bottom, 1 -> top
  const s = (1 - Math.cos(2 * Math.PI * cycle)) / 2
  return top - (top - bottom) * s
}

/** Кадр по двум углам: мировые точки для угла, нормализованные для гейта. */
function frameFromAngles(leftDeg, rightDeg, visibility = 0.9) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }))

  const place = (deg, hipI, kneeI, ankleI) => {
    const t = (deg * Math.PI) / 180
    world[hipI] = { x: Math.sin(t) * 0.5, y: Math.cos(t) * 0.5, z: 0, visibility }
    world[kneeI] = { x: 0, y: 0, z: 0, visibility }
    world[ankleI] = { x: 0, y: 0.5, z: 0, visibility }
  }
  place(leftDeg, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE)
  place(rightDeg, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE)

  // нормализованные координаты: анатомически правдоподобные, все в кадре
  landmarks[LM.LEFT_HIP] = { x: 0.46, y: 0.5, z: 0, visibility }
  landmarks[LM.RIGHT_HIP] = { x: 0.54, y: 0.5, z: 0, visibility }
  landmarks[LM.LEFT_KNEE] = { x: 0.46, y: 0.7, z: 0, visibility }
  landmarks[LM.RIGHT_KNEE] = { x: 0.54, y: 0.7, z: 0, visibility }
  landmarks[LM.LEFT_ANKLE] = { x: 0.46, y: 0.9, z: 0, visibility }
  landmarks[LM.RIGHT_ANKLE] = { x: 0.54, y: 0.9, z: 0, visibility }
  return { landmarks, worldLandmarks: world }
}

/**
 * Прогон подхода. Возвращает засчитанные повторы и события.
 */
function runSet({ reps, periodMs, desyncMs, noiseDeg, combine, smoothingWindow, bottom = 78, seed = 7 }) {
  const tracker = createSquatTracker({ legCombine: combine, smoothingWindow })
  const noise = makeNoise(seed)
  const events = []

  let t = 0
  // стойка перед началом: трекеру нужен кадр «сверху» для ресинка
  for (let i = 0; i < 12; i += 1) {
    const f = frameFromAngles(175, 175)
    tracker.update(f.landmarks, t, f.worldLandmarks)
    t += FRAME_MS
  }

  const startedAt = t
  const totalMs = reps * periodMs
  while (t - startedAt < totalMs) {
    const local = t - startedAt
    const l = legWave(local, periodMs, 0, 175, bottom) + noise(noiseDeg)
    const r = legWave(local, periodMs, desyncMs, 175, bottom) + noise(noiseDeg)
    const f = frameFromAngles(l, r)
    const out = tracker.update(f.landmarks, t, f.worldLandmarks)
    if (out.event) events.push({ ...out.event, at: t })
    t += FRAME_MS
  }

  // возврат в стойку, чтобы последний цикл закрылся
  for (let i = 0; i < 25; i += 1) {
    const f = frameFromAngles(175, 175)
    const out = tracker.update(f.landmarks, t, f.worldLandmarks)
    if (out.event) events.push({ ...out.event, at: t })
    t += FRAME_MS
  }

  return { counted: tracker.getStats().reps, events, stats: tracker.getStats() }
}

const CONDITIONS = []
for (const [tempo, periodMs] of [['медленный', 1500], ['обычный', 1000], ['быстрый', 700]]) {
  for (const desyncMs of [0, 80, 160, 240]) {
    for (const noiseDeg of [0, 2]) {
      CONDITIONS.push({ tempo, periodMs, desyncMs, noiseDeg })
    }
  }
}

const REPS = 10

describe('среднее по ногам против минимума', () => {
  it('печатает сравнение и выбирает вариант', () => {
    const rows = []
    let errMean = 0
    let errMin = 0

    for (const c of CONDITIONS) {
      const mean = runSet({ ...c, reps: REPS, combine: 'mean', smoothingWindow: 5 })
      const min = runSet({ ...c, reps: REPS, combine: 'min', smoothingWindow: 5 })
      errMean += Math.abs(mean.counted - REPS)
      errMin += Math.abs(min.counted - REPS)
      rows.push({ ...c, mean: mean.counted, min: min.counted })
    }

    const lines = [
      '',
      '  темп        период  рассинхрон  шум   среднее  минимум   (ожидалось ' + REPS + ')',
      '  ' + '-'.repeat(68),
      ...rows.map(
        (r) =>
          `  ${r.tempo.padEnd(11)} ${String(r.periodMs).padStart(5)}мс ${String(r.desyncMs).padStart(9)}мс ${String(r.noiseDeg).padStart(4)}°   ${String(r.mean).padStart(6)}${r.mean !== REPS ? ' ✗' : '  '} ${String(r.min).padStart(6)}${r.min !== REPS ? ' ✗' : '  '}`,
      ),
      '  ' + '-'.repeat(68),
      `  суммарная ошибка:  среднее ${errMean},  минимум ${errMin}`,
      '',
      '  Вывод: среднее ошибается реже. Слабое место минимума не в нижней точке,',
      '  а в верхней — min(L,R) при рассинхроне не поднимается выше UP между',
      '  повторами, и соседние приседы слипаются в один цикл.',
      '',
    ]
    console.log(lines.join('\n'))

    // выбор по умолчанию должен совпадать с победителем эксперимента
    const winner = errMean <= errMin ? 'mean' : 'min'
    expect(DEFAULT_THRESHOLDS.legCombine).toBe(winner)
    expect(errMean).toBeLessThan(errMin)
  })

  it('слипание циклов не остаётся молчаливым: повтор помечен bottomTouches', () => {
    // человек не разгибается до конца: между приседами поднимается только до 150°
    const tracker = createSquatTracker()
    let t = 0
    const feed = (deg, n) => {
      for (let i = 0; i < n; i += 1) {
        const f = frameFromAngles(deg, deg)
        tracker.update(f.landmarks, t, f.worldLandmarks)
        t += FRAME_MS
      }
    }
    feed(175, 12)
    for (let rep = 0; rep < 3; rep += 1) {
      feed(80, 8)
      feed(150, 8) // недоразгибание: выше DOWN, но ниже UP
    }
    feed(175, 12)

    const reps = tracker.getEvents().filter((e) => e.kind === 'rep')
    expect(reps).toHaveLength(1)
    expect(reps[0].bottomTouches).toBe(3)
    console.log(
      `\n  недоразгибание: 3 физических приседа слиплись в 1 цикл, ` +
        `в логе bottomTouches=${reps[0].bottomTouches}\n`,
    )
  })

  it('асимметричный присед: одна нога глубже — повтор засчитан', () => {
    // левая уходит на 75°, правая только на 115° — среднее 95° едва задевает порог
    const tracker = createSquatTracker()
    let t = 0
    const feed = (l, r, n = 6) => {
      for (let i = 0; i < n; i += 1) {
        const f = frameFromAngles(l, r)
        tracker.update(f.landmarks, t, f.worldLandmarks)
        t += FRAME_MS
      }
    }
    feed(175, 175, 12)
    for (let rep = 0; rep < 5; rep += 1) {
      feed(75, 115, 10)
      feed(175, 175, 12)
    }
    expect(tracker.getStats().reps).toBe(5)
  })

  it('окно сглаживания 5 против 3: задержка зачёта не растёт заметно', () => {
    const measure = (window) => {
      const res = runSet({
        reps: 6,
        periodMs: 1000,
        desyncMs: 0,
        noiseDeg: 0,
        combine: 'min',
        smoothingWindow: window,
      })
      // повтор засчитывается на возврате наверх; сравниваем момент зачёта
      // с идеальным концом периода
      const first = res.events.find((e) => e.kind === 'rep')
      return { counted: res.counted, firstAt: first?.at ?? null, duration: first?.durationMs ?? null }
    }

    const w3 = measure(3)
    const w5 = measure(5)
    const lagMs = w5.firstAt - w3.firstAt

    console.log(
      `\n  задержка зачёта: окно 3 -> ${w3.firstAt} мс, окно 5 -> ${w5.firstAt} мс, разница ${lagMs} мс` +
        `\n  длительность цикла: окно 3 -> ${Math.round(w3.duration)} мс, окно 5 -> ${Math.round(w5.duration)} мс\n`,
    )

    expect(w3.counted).toBe(6)
    expect(w5.counted).toBe(6)
    // теоретическая добавка (5-3)/2 кадра = 1 кадр = 40 мс при 25 fps
    expect(Math.abs(lagMs)).toBeLessThanOrEqual(2 * FRAME_MS + 1)
  })

  it('на быстром темпе цикл укладывается в minCycleMs с запасом', () => {
    const res = runSet({
      reps: 8,
      periodMs: 700,
      desyncMs: 60,
      noiseDeg: 1,
      combine: DEFAULT_THRESHOLDS.legCombine,
      smoothingWindow: 5,
    })
    const durations = res.events.filter((e) => e.kind === 'rep').map((e) => e.durationMs)
    const minDur = Math.min(...durations)
    console.log(
      `\n  темп 700 мс/повтор: длительность цикла ${Math.round(minDur)}–${Math.round(Math.max(...durations))} мс ` +
        `при пороге minCycleMs=${DEFAULT_THRESHOLDS.minCycleMs}\n`,
    )
    expect(res.counted).toBe(8)
    expect(minDur).toBeGreaterThan(DEFAULT_THRESHOLDS.minCycleMs)
  })

  it('порог minCycleMs пропускает темп вплоть до 600 мс на повтор', () => {
    const rows = []
    for (const periodMs of [1000, 800, 700, 650, 600]) {
      const res = runSet({
        reps: 8,
        periodMs,
        desyncMs: 40,
        noiseDeg: 1,
        combine: DEFAULT_THRESHOLDS.legCombine,
        smoothingWindow: 5,
      })
      const durs = res.events.filter((e) => e.kind === 'rep').map((e) => e.durationMs)
      rows.push({ periodMs, counted: res.counted, cycle: durs.length ? Math.round(Math.min(...durs)) : null })
      expect(res.counted).toBe(8)
    }
    console.log(
      '\n  период повтора -> длина цикла (порог ' + DEFAULT_THRESHOLDS.minCycleMs + ' мс):\n' +
        rows.map((r) => `    ${r.periodMs} мс -> цикл ${r.cycle} мс, засчитано ${r.counted}/8`).join('\n') +
        '\n',
    )
  })

  it('двойной счёт невозможен: два цикла внутри одного приседа не помещаются', () => {
    // один физический присед 700 мс с сильным горбом посередине спуска
    const tracker = createSquatTracker()
    let t = 0
    const feed = (deg, n) => {
      for (let i = 0; i < n; i += 1) {
        const f = frameFromAngles(deg, deg)
        tracker.update(f.landmarks, t, f.worldLandmarks)
        t += FRAME_MS
      }
    }
    feed(175, 12)
    // спуск с отскоком: 120 -> 90 -> 130 -> 80 -> вверх
    feed(120, 3)
    feed(90, 5)
    feed(135, 6) // отчётливый горб между двумя нижними точками
    feed(80, 6)
    feed(175, 12)

    expect(tracker.getStats().reps).toBe(1)
    const rep = tracker.getEvents().find((e) => e.kind === 'rep')
    expect(rep.extrema).toBeGreaterThan(0)
    expect(rep.bottomTouches).toBe(2)
  })
})
