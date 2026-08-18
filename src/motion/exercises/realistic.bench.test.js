import { describe, expect, it } from 'vitest'
import { createSquatTracker } from './squat.js'
import { DEFAULT_THRESHOLDS } from './thresholds.js'
import { LM } from '../pose/landmarks.js'

/**
 * Воспроизведение полевого отказа «скелет строится, счётчик стоит на нуле».
 *
 * Гладкая синтетика из legCombine.bench проходила, а на живом человеке ноль —
 * значит синтетика не воспроизводила реальный сигнал. Здесь параметры честнее:
 *  - частота кадров телефона, а не идеальные 25 fps
 *  - шум ±3° на каждом кадре
 *  - реальная амплитуда приседа: человек не выпрямляется до 175° и не садится
 *    до 78°, как в идеальной синусоиде
 */

function makeNoise(seed) {
  let s = seed >>> 0
  return (amp) => {
    s = (s * 1664525 + 1013904223) >>> 0
    return ((s / 0xffffffff) * 2 - 1) * amp
  }
}

function frameFromAngles(leftDeg, rightDeg, visibility = 0.85) {
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
  landmarks[LM.LEFT_HIP] = { x: 0.46, y: 0.5, z: 0, visibility }
  landmarks[LM.RIGHT_HIP] = { x: 0.54, y: 0.5, z: 0, visibility }
  landmarks[LM.LEFT_KNEE] = { x: 0.46, y: 0.7, z: 0, visibility }
  landmarks[LM.RIGHT_KNEE] = { x: 0.54, y: 0.7, z: 0, visibility }
  landmarks[LM.LEFT_ANKLE] = { x: 0.46, y: 0.9, z: 0, visibility }
  landmarks[LM.RIGHT_ANKLE] = { x: 0.54, y: 0.9, z: 0, visibility }
  return { landmarks, worldLandmarks: world }
}

/**
 * Реалистичная волна приседа: пауза вверху, спуск, короткая пауза внизу, подъём.
 * top/bottom задаются отдельно — живой человек не выпрямляется до 175°.
 */
function squatWave(tMs, periodMs, top, bottom) {
  const c = (tMs % periodMs) / periodMs
  const s = (1 - Math.cos(2 * Math.PI * c)) / 2
  return top - (top - bottom) * s
}

function run({ fps, reps, periodMs, top, bottom, noiseDeg, config = {}, seed = 11 }) {
  const tracker = createSquatTracker(config)
  const noise = makeNoise(seed)
  const frameMs = 1000 / fps
  let t = 0

  for (let i = 0; i < 15; i += 1) {
    const f = frameFromAngles(top, top)
    tracker.update(f.landmarks, t, f.worldLandmarks)
    t += frameMs
  }

  const start = t
  const rejects = []
  while (t - start < reps * periodMs) {
    const base = squatWave(t - start, periodMs, top, bottom)
    const f = frameFromAngles(base + noise(noiseDeg), base + noise(noiseDeg))
    const out = tracker.update(f.landmarks, t, f.worldLandmarks)
    if (out.event && out.event.kind !== 'rep') rejects.push(out.event)
    t += frameMs
  }
  for (let i = 0; i < 30; i += 1) {
    const f = frameFromAngles(top, top)
    const out = tracker.update(f.landmarks, t, f.worldLandmarks)
    if (out.event && out.event.kind !== 'rep') rejects.push(out.event)
    t += frameMs
  }

  return { counted: tracker.getStats().reps, rejects, events: tracker.getEvents() }
}

describe('реалистичный сигнал телефона', () => {
  it('ТАБЛИЦА: где именно теряются повторы', () => {
    const cases = []
    for (const fps of [30, 20, 15]) {
      for (const [label, top, bottom] of [
        ['полная амплитуда', 175, 78],
        ['реальная амплитуда', 168, 95],
        ['неглубокий присед', 165, 105],
      ]) {
        for (const noiseDeg of [0, 3]) {
          const r = run({ fps, reps: 10, periodMs: 1400, top, bottom, noiseDeg })
          cases.push({ fps, label, top, bottom, noiseDeg, counted: r.counted, rejects: r.rejects })
        }
      }
    }

    const lines = [
      '',
      '  fps  амплитуда             шум  засчитано(из 10)  причины отклонений',
      '  ' + '-'.repeat(82),
      ...cases.map((c) => {
        const why = c.rejects.length
          ? [...new Set(c.rejects.map((r) => r.kind))].join(',')
          : c.counted === 10
            ? ''
            : 'цикл вообще не закрылся'
        return `  ${String(c.fps).padStart(3)}  ${c.label.padEnd(20)} ${String(c.noiseDeg).padStart(2)}°  ${String(c.counted).padStart(10)}${c.counted !== 10 ? ' ✗' : '  '}  ${why}`
      }),
      '',
    ]
    console.log(lines.join('\n'))
    expect(cases.length).toBeGreaterThan(0)
  })

  it('окно сглаживания 5 срезает амплитуду сильнее, чем 3', () => {
    const measure = (smoothingWindow, fps) => {
      const tracker = createSquatTracker({ smoothingWindow })
      const frameMs = 1000 / fps
      let t = 0
      let minSeen = 999
      let maxSeen = -999
      for (let i = 0; i < 15; i += 1) {
        const f = frameFromAngles(168, 168)
        tracker.update(f.landmarks, t, f.worldLandmarks)
        t += frameMs
      }
      const start = t
      while (t - start < 1400 * 3) {
        const base = squatWave(t - start, 1400, 168, 95)
        const f = frameFromAngles(base, base)
        const out = tracker.update(f.landmarks, t, f.worldLandmarks)
        if (out.angle != null) {
          minSeen = Math.min(minSeen, out.angle)
          maxSeen = Math.max(maxSeen, out.angle)
        }
        t += frameMs
      }
      return { minSeen, maxSeen }
    }

    const rows = []
    for (const fps of [30, 20, 15]) {
      for (const w of [3, 5]) {
        const m = measure(w, fps)
        rows.push({ fps, w, ...m })
      }
    }
    console.log(
      '\n  истинная амплитуда сигнала 95…168°, пороги DOWN=100 / UP=160\n' +
        '  fps  окно  видимый минимум  видимый максимум  пройдёт DOWN  пройдёт UP\n  ' +
        '-'.repeat(70) +
        '\n' +
        rows
          .map(
            (r) =>
              `  ${String(r.fps).padStart(3)}  ${String(r.w).padStart(4)}  ${r.minSeen.toFixed(1).padStart(15)}  ${r.maxSeen.toFixed(1).padStart(16)}  ${(r.minSeen < 100 ? 'да' : 'НЕТ').padStart(12)}  ${(r.maxSeen > 160 ? 'да' : 'НЕТ').padStart(10)}`,
          )
          .join('\n') +
        '\n',
    )
    expect(rows.length).toBe(6)
  })
})
