import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { STRENGTH_TYPES, barFor, createRepCounter } from './strength.js'
import { loadRecording } from '../../../tools/punch-replay.mjs'
import { measureKneeAngle } from '../exercises/squat.js'
import { DEFAULT_THRESHOLDS } from '../exercises/thresholds.js'
import { LM } from '../pose/landmarks.js'

/**
 * СЧЁТ ПОВТОРОВ В СИЛОВОМ БЛОКЕ.
 *
 * Здесь проверяется две вещи, и обе выросли из полевого лога 16 августа, где
 * присед дал один повтор из восьми:
 *
 *   ПОВТОР — ТОЛЬКО СОСТОЯВШИЙСЯ. У трекера приседа три вида событий, и два из
 *     них отказы; раньше блок считал повтором любое из трёх;
 *   ПОПЫТКА ОБЯЗАНА РАССКАЗАТЬ О СЕБЕ. Блок с одним повтором был неразбираем:
 *     в логе стояло только итоговое число.
 */

const REC = new URL('../../../recordings/', import.meta.url)
const recordings = readdirSync(REC).filter((f) => f.endsWith('.json'))

/** Кадр с управляемой высотой таза: тем же приёмом, что и в squat.test.js. */
function hipFrame({ hipY = 0.5, anklesVisible = true }) {
  const vis = 0.9
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: vis }))
  lm[LM.NOSE] = { x: 0.5, y: hipY - 0.42, z: 0, visibility: vis }
  lm[LM.LEFT_SHOULDER] = { x: 0.44, y: hipY - 0.3, z: 0, visibility: vis }
  lm[LM.RIGHT_SHOULDER] = { x: 0.56, y: hipY - 0.3, z: 0, visibility: vis }
  lm[LM.LEFT_HIP] = { x: 0.46, y: hipY, z: 0, visibility: vis }
  lm[LM.RIGHT_HIP] = { x: 0.54, y: hipY, z: 0, visibility: vis }
  lm[LM.LEFT_KNEE] = { x: 0.46, y: 0.7, z: 0, visibility: vis }
  lm[LM.RIGHT_KNEE] = { x: 0.54, y: 0.7, z: 0, visibility: vis }
  const ankleVis = anklesVisible ? vis : 0.02
  lm[LM.LEFT_ANKLE] = { x: 0.46, y: 0.9, z: 0, visibility: ankleVis }
  lm[LM.RIGHT_ANKLE] = { x: 0.54, y: 0.9, z: 0, visibility: ankleVis }
  return { landmarks: lm, worldLandmarks: null }
}

/** Присед заданной глубины резервным режимом: просадка таза в долях бедра. */
function squatBlock(dropRatio) {
  const counter = createRepCounter('barrier')
  let t = 0
  let reps = 0
  const feed = (opts, n) => {
    for (let i = 0; i < n; i += 1) {
      reps += counter.update(t, hipFrame(opts)) ?? 0
      t += 50
    }
  }
  feed({ hipY: 0.5 }, 10)
  feed({ hipY: 0.5, anklesVisible: false }, 70)
  feed({ hipY: 0.5 + 0.2 * dropRatio, anklesVisible: false }, 10)
  feed({ hipY: 0.5, anklesVisible: false }, 10)
  return { reps, attempts: counter.attempts() }
}

describe('повтор — только состоявшийся', () => {
  it('честный присед считается один раз', () => {
    expect(squatBlock(0.8).reps).toBe(1)
  })

  it('мелкий подсед не считается вовсе, но в лог попадает', () => {
    /**
     * Раньше здесь было ровно наоборот: отказ трекера («не достиг DOWN»)
     * приходил тем же событием, что и зачёт, и блок считал его повтором.
     */
    const { reps, attempts } = squatBlock(0.3)
    expect(reps).toBe(0)
    const shallow = attempts.find((a) => !a.ok)
    expect(shallow).toBeTruthy()
    expect(shallow.why).toMatch(/не достиг DOWN/)
  })
})

describe('попытки цикла уходят в лог', () => {
  it('у приседа в попытке есть замер, планка, размах и режим', () => {
    // без режима трактовка числа меняется на противоположную: 112° по колену —
    // мелкий подсед, 112° по тазу — честный присед на чужой шкале
    const { attempts } = squatBlock(0.8)
    const done = attempts.find((a) => a.ok)
    expect(done).toBeTruthy()
    expect(typeof done.metric).toBe('number')
    expect(typeof done.bar).toBe('number')
    expect(typeof done.amp).toBe('number')
    expect(done.mode).toBe('таз')
  })

  it('блок, кончившийся без повторов, всё равно говорит, до чего дотянули', () => {
    /**
     * Главное требование полевого разбора: следующий лог обязан давать диагноз
     * по ЛЮБОМУ движению, а не только по приседу. Незавершённая попытка
     * закрывается концом блока и уносит с собой лучший замер подхода.
     */
    const counter = createRepCounter('jack')
    for (let t = 0; t < 2000; t += 50) counter.update(t, hipFrame({ hipY: 0.5 }))
    const attempts = counter.flush()
    expect(attempts).toHaveLength(1)
    expect(attempts[0].ok).toBe(false)
    expect(attempts[0].why).toBe('блок кончился')
    expect(attempts[0].bar).toBe(barFor('jack'))
  })

  it('у каждого силового движения есть своя планка — кроме приседа', () => {
    // у приседа планка не постоянная: она калибруется под человека, и трекер
    // приносит её в каждом событии сам
    for (const type of STRENGTH_TYPES) {
      if (type === 'barrier') expect(barFor(type)).toBeNull()
      else expect(barFor(type)).toBeGreaterThan(0)
    }
  })

  it('счётчик любого движения умеет отдавать попытки, а не только присед', () => {
    for (const type of STRENGTH_TYPES) {
      const counter = createRepCounter(type)
      expect(typeof counter.attempts).toBe('function')
      expect(typeof counter.flush).toBe('function')
      expect(counter.attempts()).toEqual([])
    }
  })
})

describe('силовой блок судит ПОРОГАМИ КАЛИБРОВКИ, а не заводскими', () => {
  /**
   * ЭТОТ ТЕСТ ПРИБИВАЕТ БАГ ГВОЗДЁМ.
   *
   * Счётчик приседа создавался БЕЗ конфига, то есть с заводскими UP 160 /
   * DOWN 100. У человека, прошедшего калибровку, стойка читается как 155–158°,
   * и его пороги 143/96 — а с заводским UP 160 угол в стойке НИКОГДА не
   * поднимается выше порога. Цикл не закрывается ни разу: ноль повторов, ноль
   * попыток, пустой лог, и разбирать в поле нечего.
   *
   * Проверяется на живой записи: тот же сегмент, тот же счётчик, разница
   * только в порогах — 5 из 5 против 0 из 5.
   */
  const barrier = (() => {
    const data = loadRecording(new URL('calibration-full-20260811.json', REC))
    const segment = data.segments.find((s) => s.movement === 'barrier')
    return {
      data,
      frames: data.frames.filter((f) => f.t >= segment.from && f.t <= segment.to),
    }
  })()

  /**
   * Пороги, которые получил бы человек с этой записи, — тем же способом, каким
   * их считает экран калибровки: медиана угла в стойке минус личные запасы
   * (см. applyPersonalCalibration в thresholds.js).
   */
  function thresholdsOf(frames) {
    const angles = []
    for (const frame of frames) {
      const value = measureKneeAngle(frame.landmarks, frame.worldLandmarks, DEFAULT_THRESHOLDS)
      if (Number.isFinite(value)) angles.push(value)
    }
    angles.sort((a, b) => a - b)
    const stand = angles[Math.floor((angles.length - 1) * 0.55)]
    return {
      stand,
      upAngle: Math.round(stand - DEFAULT_THRESHOLDS.upMarginDeg),
      downAngle: Math.round(stand - DEFAULT_THRESHOLDS.downMarginDeg),
    }
  }

  /** Прогнать сегмент счётчиком и вернуть повторы вместе с попытками. */
  function run(config) {
    const counter = config ? createRepCounter('barrier', config) : createRepCounter('barrier')
    let reps = 0
    for (const frame of barrier.frames) {
      reps += counter.update(frame.t, {
        landmarks: frame.landmarks,
        worldLandmarks: frame.worldLandmarks,
      }) ?? 0
    }
    return { reps, attempts: counter.attempts() }
  }

  it('стойка на записи ниже заводского UP — тот самый случай из поля', () => {
    const { stand, upAngle, downAngle } = thresholdsOf(barrier.data.frames)
    // 154.8: заводской порог 160 такой стойкой не пересекается никогда
    expect(stand).toBeLessThan(DEFAULT_THRESHOLDS.upAngle)
    expect({ upAngle, downAngle }).toEqual({ upAngle: 143, downAngle: 93 })
  })

  it('с порогами калибровки — 5 повторов из 5 и пять зачётных попыток', () => {
    const { upAngle, downAngle } = thresholdsOf(barrier.data.frames)
    const { reps, attempts } = run({ upAngle, downAngle })

    expect(reps).toBe(5)
    expect(attempts).toHaveLength(5)
    expect(attempts.filter((a) => a.ok)).toHaveLength(5)
    // и каждая попытка сама рассказывает, по какой планке её судили
    for (const attempt of attempts) expect(attempt.bar).toBe(downAngle)
  })

  it('без порогов — ноль повторов и ПУСТОЙ лог: разбирать в поле нечего', () => {
    expect(run()).toEqual({ reps: 0, attempts: [] })
  })

  it('пороги переживают сброс: подход второй, человек тот же', () => {
    const { upAngle, downAngle } = thresholdsOf(barrier.data.frames)
    const counter = createRepCounter('barrier', { upAngle, downAngle })
    counter.reset()
    let reps = 0
    for (const frame of barrier.frames) {
      reps += counter.update(frame.t, {
        landmarks: frame.landmarks,
        worldLandmarks: frame.worldLandmarks,
      }) ?? 0
    }
    expect(reps).toBe(5)
  })

  it('остальным движениям пороги приседа не нужны и не мешают', () => {
    // их автоматы меряют доли тела, а не углы: калибровка им ни к чему
    for (const type of STRENGTH_TYPES.filter((t) => t !== 'barrier')) {
      const counter = createRepCounter(type, { upAngle: 143, downAngle: 93 })
      expect(counter.update(0, hipFrame({ hipY: 0.5 }))).toBe(0)
    }
  })
})

describe('присед не срабатывает на чужих движениях', () => {
  /**
   * ЗАЩИТА ОТ ЛОЖНЫХ ЗАЧЁТОВ НА ЖИВЫХ ЗАПИСЯХ. Смягчать порог глубины можно
   * ровно до тех пор, пока подсед за низкой мишенью не начинает считаться
   * приседом. Ближайшее, что есть в записях к такому подседу, — сегменты
   * подъёма колена, маха ногой и наклона к полу: там человек опускается, но
   * не приседает.
   *
   * Число не ноль и нулём быть не может: выпад и присед с прыжком опускают таз
   * по своему устройству, и детектор глубины их честно видит. Важно, что оно НЕ
   * РАСТЁТ: планка держится тестом, а не памятью.
   */
  const DIPS = ['knee', 'legside', 'bend']

  it('на подседах за низкой целью приседов почти нет', () => {
    let total = 0
    const seen = []
    for (const name of recordings) {
      const data = loadRecording(new URL(name, REC))
      if (!data.segments?.length) continue
      for (const seg of data.segments) {
        if (!DIPS.includes(seg.movement)) continue
        const frames = data.frames.filter((f) => f.t >= seg.from && f.t <= seg.to)
        if (frames.length < 30) continue
        const counter = createRepCounter('barrier')
        let reps = 0
        for (const f of frames) {
          reps += counter.update(f.t, { landmarks: f.landmarks, worldLandmarks: f.worldLandmarks }) ?? 0
        }
        total += reps
        if (reps) seen.push(`${seg.movement}/${seg.side ?? '—'}: ${reps}`)
      }
    }
    // до правки этих ложных приседов было пятнадцать
    expect({ всего: total, где: seen.sort() }).toEqual({
      всего: 3,
      где: ['knee/right: 1', 'legside/left: 1', 'legside/right: 1'],
    })
  })
})
