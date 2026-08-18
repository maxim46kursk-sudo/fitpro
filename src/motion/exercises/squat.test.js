import { describe, expect, it } from 'vitest'
import { createSquatTracker, STATE } from './squat.js'
import { LM } from '../pose/landmarks.js'
import { angleAt2D, angleAt3D, aspectOf } from '../pose/geometry.js'
import { measureKneeAngle } from './squat.js'

/**
 * Синтетическая нога: колено в начале координат, голеностоп строго под ним,
 * бедро развёрнуто на нужный угол. Ось y направлена вниз, как у MediaPipe.
 */
function legPoints(angleDeg) {
  const t = (angleDeg * Math.PI) / 180
  return {
    hip: { x: Math.sin(t) * 0.5, y: Math.cos(t) * 0.5, z: 0 },
    knee: { x: 0, y: 0, z: 0 },
    ankle: { x: 0, y: 0.5, z: 0 },
  }
}

function makeFrame(angleDeg, visibility = 1) {
  const { hip, knee, ankle } = legPoints(angleDeg)
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }))
  const worldLandmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }))

  for (const [hipI, kneeI, ankleI] of [
    [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
    [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
  ]) {
    worldLandmarks[hipI] = { ...hip, visibility }
    worldLandmarks[kneeI] = { ...knee, visibility }
    worldLandmarks[ankleI] = { ...ankle, visibility }
  }

  return { landmarks, worldLandmarks }
}

/** Подержать позу N кадров. Возвращает последний вывод трекера. */
function hold(tracker, clock, angleDeg, frames = 5, dtMs = 50, visibility = 1) {
  let out = null
  for (let i = 0; i < frames; i += 1) {
    const { landmarks, worldLandmarks } = makeFrame(angleDeg, visibility)
    out = tracker.update(landmarks, clock.t, worldLandmarks)
    clock.t += dtMs
  }
  return out
}

function newClock() {
  return { t: 0 }
}

describe('geometry', () => {
  it('прямая нога даёт ~180°', () => {
    const { hip, knee, ankle } = legPoints(180)
    expect(angleAt3D(hip, knee, ankle)).toBeCloseTo(180, 4)
  })

  it('присед до прямого угла даёт ~90°', () => {
    const { hip, knee, ankle } = legPoints(90)
    expect(angleAt3D(hip, knee, ankle)).toBeCloseTo(90, 4)
  })

  it('2D-версия учитывает пропорции кадра', () => {
    const a = { x: 0.5, y: 0.0 }
    const b = { x: 0.5, y: 0.5 }
    const c = { x: 1.0, y: 0.5 }
    expect(angleAt2D(a, b, c, 1)).toBeCloseTo(90, 4)
    // при aspect=2 угол остаётся 90°, потому что лучи ортогональны по осям
    expect(angleAt2D(a, b, c, 2)).toBeCloseTo(90, 4)
    // а вот наклонный луч без коррекции посчитался бы иначе
    const d = { x: 1.0, y: 1.0 }
    expect(angleAt2D(a, b, d, 1)).not.toBeCloseTo(angleAt2D(a, b, d, 2), 1)
  })
})

describe('ландшафтный кадр 640x480', () => {
  /**
   * Парный полевой тест 18 августа: iPhone отдаёт ЛАНДШАФТНЫЙ кадр 640x480,
   * Redmi — портретный 480x640. Поправка на соотношение сторон у них не просто
   * разная, а обратная друг другу (1.33 против 0.75), а в замер до сих пор
   * уходила единица — то есть кадр молча считался квадратным.
   */
  const W = 640
  const H = 480
  /** Точка в пикселях кадра -> нормированная, как её отдаёт MediaPipe. */
  const px = (x, y) => ({ x: x / W, y: y / H, visibility: 1 })

  it('поправка возвращает угол, который человек видит на кадре', () => {
    // нога согнута под углом, который в ПИКСЕЛЯХ равен 116.57°
    const hip = px(300, 100)
    const knee = px(300, 300)
    const ankle = px(500, 400)

    expect(angleAt2D(hip, knee, ankle, aspectOf(W, H))).toBeCloseTo(116.57, 1)
    // без поправки тот же кадр даёт лишние семь градусов
    expect(angleAt2D(hip, knee, ankle, 1)).toBeCloseTo(123.69, 1)
  })

  it('портретный кадр промахивается в другую сторону — потому и нужен настоящий размер', () => {
    const p = (x, y) => ({ x: x / 480, y: y / 640, visibility: 1 })
    const hip = p(200, 100)
    const knee = p(200, 300)
    const ankle = p(400, 400)

    // в пикселях это тот же угол, что и в ландшафтном случае выше
    const real = angleAt2D(hip, knee, ankle, aspectOf(480, 640))
    const flat = angleAt2D(hip, knee, ankle, 1)
    expect(real).toBeCloseTo(116.57, 1)
    // а единица завышала его на ландшафтном кадре (123.7) и занижает на
    // портретном: ошибка не просто разная, она разного знака
    expect(flat).toBeCloseTo(110.56, 1)
    expect(flat).toBeLessThan(real)
  })

  it('стоящий человек на ландшафтном кадре остаётся стоящим', () => {
    /**
     * Проверка ГРАНИЦЫ ОБЪЯСНЕНИЯ, а не только формулы. Соотношение сторон
     * само по себе НЕ превращает стойку в присед: почти прямая нога остаётся
     * почти прямой при любом растяжении осей. Значит, полевые 37.6° на iPhone
     * этим не объясняются — там виновата глубина (замер шёл по метрическим
     * точкам), и от этого спасает не поправка, а страховка в
     * applyPersonalCalibration.
     */
    const hip = px(320, 140)
    const knee = px(330, 300)
    const ankle = px(322, 452)

    const real = angleAt2D(hip, knee, ankle, aspectOf(W, H))
    const flat = angleAt2D(hip, knee, ankle, 1)
    expect(real).toBeGreaterThan(150)
    expect(flat).toBeGreaterThan(150)
  })

  it('замер колена берёт поправку из конфига, а не считает кадр квадратным', () => {
    // ровно тот путь, которым идёт калибровка: точки кадра, без метрических
    const marks = []
    marks[LM.LEFT_HIP] = px(300, 100)
    marks[LM.LEFT_KNEE] = px(300, 300)
    marks[LM.LEFT_ANKLE] = px(500, 400)
    marks[LM.RIGHT_HIP] = px(300, 100)
    marks[LM.RIGHT_KNEE] = px(300, 300)
    marks[LM.RIGHT_ANKLE] = px(500, 400)

    expect(measureKneeAngle(marks, null, { aspect: aspectOf(W, H) })).toBeCloseTo(116.57, 1)
    expect(measureKneeAngle(marks, null, {})).toBeCloseTo(123.69, 1)
  })
})

describe('squat tracker', () => {
  it('считает ровно 10 корректных приседов', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 8)
    for (let i = 0; i < 10; i += 1) {
      hold(tracker, clock, 80, 8)
      hold(tracker, clock, 175, 8)
    }

    expect(tracker.getStats().reps).toBe(10)
  })

  it('не засчитывает неполный присед (не ниже 120°)', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)
    for (let i = 0; i < 5; i += 1) {
      hold(tracker, clock, 125, 5)
      hold(tracker, clock, 175, 5)
    }

    expect(tracker.getStats().reps).toBe(0)
  })

  it('гистерезис: дрожание в мёртвой зоне не плодит повторы', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)
    // болтаемся между 100 и 160 — состояние меняться не должно
    for (let i = 0; i < 20; i += 1) hold(tracker, clock, i % 2 ? 155 : 110, 2)

    expect(tracker.getStats().reps).toBe(0)
  })

  it('быстрое покачивание в нижней точке не начисляет лишних повторов', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)
    hold(tracker, clock, 85, 4)
    for (let i = 0; i < 10; i += 1) hold(tracker, clock, i % 2 ? 95 : 115, 2)
    hold(tracker, clock, 175, 5)

    expect(tracker.getStats().reps).toBe(1)
  })

  it('цикл короче minCycleMs не засчитывается', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    // весь цикл вниз-вверх укладывается в ~120 мс — это не присед
    hold(tracker, clock, 175, 8, 10)
    hold(tracker, clock, 80, 4, 10)
    const fast = hold(tracker, clock, 175, 8, 10)
    expect(fast.reps).toBe(0)
    expect(tracker.getEvents().at(-1).kind).toBe('too_fast')

    // нормальный по длительности цикл засчитывается
    hold(tracker, clock, 80, 8, 50)
    const ok = hold(tracker, clock, 175, 8, 50)
    expect(ok.reps).toBe(1)
  })

  it('потеря человека дольше pauseAfterMs -> пауза, повтор не засчитывается', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)
    // 20 кадров по 50 мс = 1 с непрерывно плохих кадров
    const lost = hold(tracker, clock, 80, 20, 50, 0.02)

    expect(lost.outOfFrame).toBe(true)
    expect(lost.paused).toBe(true)
    expect(lost.angle).toBe(null)
    expect(lost.reps).toBe(0)
  })

  it('одиночный плохой кадр паузу не включает и цикл не рвёт', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 8)
    hold(tracker, clock, 80, 4)
    hold(tracker, clock, 80, 1, 50, 0.02) // один плохой кадр в нижней точке
    hold(tracker, clock, 80, 4)
    const out = hold(tracker, clock, 175, 8)

    expect(out.paused).toBe(false)
    expect(out.reps).toBe(1)
  })

  it('возврат в кадр не создаёт фантомный повтор', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)
    hold(tracker, clock, 80, 5) // ушёл вниз
    hold(tracker, clock, 80, 20, 50, 0.02) // пропал из кадра в нижней точке
    const back = hold(tracker, clock, 175, 8) // вернулся уже стоя

    expect(back.outOfFrame).toBe(false)
    expect(back.paused).toBe(false)
    expect(back.reps).toBe(0)
  })

  it('считает среднюю и лучшую глубину', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 8)
    hold(tracker, clock, 90, 8)
    hold(tracker, clock, 175, 8)
    hold(tracker, clock, 70, 8)
    hold(tracker, clock, 175, 8)

    const stats = tracker.getStats()
    expect(stats.reps).toBe(2)
    expect(stats.depths).toHaveLength(2)
    expect(stats.avgDepth).toBeCloseTo((stats.depths[0] + stats.depths[1]) / 2, 6)
    expect(stats.bestDepth).toBeCloseTo(Math.min(...stats.depths), 6)
    expect(stats.bestDepth).toBeLessThan(80)
  })

  it('сообщает зону: UP / мёртвая / DOWN', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    expect(hold(tracker, clock, 175, 5).zone).toBe('up')
    expect(hold(tracker, clock, 130, 5).zone).toBe('dead')
    expect(hold(tracker, clock, 80, 5).zone).toBe('down')
  })

  it('отдаёт сырой и сглаженный угол', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)
    const out = hold(tracker, clock, 90, 1)

    expect(out.rawAngle).toBeCloseTo(90, 1)
    // сглаживание по трём кадрам ещё тянет предыдущие 175°
    expect(out.angle).toBeGreaterThan(out.rawAngle)
  })

  it('называет потерянные точки, когда пауза уже включилась', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 5)

    let out = null
    for (let i = 0; i < 25; i += 1) {
      const { landmarks, worldLandmarks } = makeFrame(175)
      landmarks[LM.LEFT_ANKLE] = { ...landmarks[LM.LEFT_ANKLE], visibility: 0.02 }
      out = tracker.update(landmarks, clock.t, worldLandmarks)
      clock.t += 50
    }

    expect(out.paused).toBe(true)
    expect(out.missing).toEqual([LM.LEFT_ANKLE])
  })

  it('setConfig меняет пороги на лету, не сбрасывая счёт', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 8)
    hold(tracker, clock, 80, 8)
    hold(tracker, clock, 175, 8)
    expect(tracker.getStats().reps).toBe(1)

    // поднимаем порог DOWN до 130 — теперь неглубокий присед тоже считается
    tracker.setConfig({ downAngle: 130 })
    clock.t += 600
    hold(tracker, clock, 125, 8)
    hold(tracker, clock, 175, 8)

    expect(tracker.getStats().reps).toBe(2)
    expect(tracker.config.downAngle).toBe(130)
  })

  describe('лог событий', () => {
    it('пишет засчитанный повтор с глубиной и таймингами', () => {
      const tracker = createSquatTracker()
      const clock = newClock()

      hold(tracker, clock, 175, 8)
      hold(tracker, clock, 80, 8)
      hold(tracker, clock, 175, 8)

      const events = tracker.getEvents()
      expect(events).toHaveLength(1)
      const [e] = events
      expect(e.kind).toBe('rep')
      expect(e.index).toBe(1)
      expect(e.minAngle).toBeLessThan(100)
      expect(e.downMs).toBeGreaterThan(0)
      expect(e.upMs).toBeGreaterThan(0)
    })

    it('объясняет, почему неглубокий присед не засчитан', () => {
      const tracker = createSquatTracker()
      const clock = newClock()

      hold(tracker, clock, 175, 5)
      hold(tracker, clock, 125, 5)
      hold(tracker, clock, 175, 5)

      const events = tracker.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('shallow')
      expect(events[0].minAngle).toBeCloseTo(125, 0)
      expect(tracker.getStats().reps).toBe(0)
    })

    it('объясняет, почему слишком быстрый цикл отклонён', () => {
      const tracker = createSquatTracker()
      const clock = newClock()

      // нормальный повтор
      hold(tracker, clock, 175, 8, 50)
      hold(tracker, clock, 80, 8, 50)
      hold(tracker, clock, 175, 8, 50)

      // рывок: весь цикл в ~150 мс
      hold(tracker, clock, 80, 5, 10)
      hold(tracker, clock, 175, 10, 10)

      const kinds = tracker.getEvents().map((e) => e.kind)
      expect(kinds).toEqual(['rep', 'too_fast'])
      expect(tracker.getStats().reps).toBe(1)
      expect(tracker.getEvents().at(-1).reason).toMatch(/короче/)
    })

    it('лёгкое покачивание стоя в лог не попадает', () => {
      const tracker = createSquatTracker()
      const clock = newClock()

      hold(tracker, clock, 175, 5)
      for (let i = 0; i < 6; i += 1) {
        hold(tracker, clock, 168, 3)
        hold(tracker, clock, 175, 3)
      }

      expect(tracker.getEvents()).toHaveLength(0)
    })
  })

  describe('резервная оценка глубины по тазу', () => {
    /** Кадр с управляемой высотой таза и опционально потерянными голеностопами. */
    function hipFrame({ hipY = 0.5, anklesVisible = true, angleDeg = 175 }) {
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

      const { worldLandmarks } = makeFrame(angleDeg)
      return { landmarks: lm, worldLandmarks }
    }

    it('голеностопы потеряны 3+ с, колени видны → подход не встаёт, считаем по тазу', () => {
      const tracker = createSquatTracker()
      let t = 0
      const feed = (opts, n) => {
        let out = null
        for (let i = 0; i < n; i += 1) {
          const f = hipFrame(opts)
          out = tracker.update(f.landmarks, t, f.worldLandmarks)
          t += 50
        }
        return out
      }

      // стойка с видимыми голеностопами: запоминается база (таз 0.5, бедро 0.2)
      feed({ hipY: 0.5 }, 10)

      // голеностопы пропали: через 0.7 с подход честно встаёт на паузу
      let out = feed({ hipY: 0.5, anklesVisible: false }, 20)
      expect(out.mode).toBe('knee')
      expect(out.paused).toBe(true)

      // но на 3-й секунде включается резервный режим и снимает паузу,
      // вместо того чтобы стоять до бесконечности
      out = feed({ hipY: 0.5, anklesVisible: false }, 45)
      expect(out.mode).toBe('hip')
      expect(out.paused).toBe(false)

      // приседаем: таз опускается на длину бедра
      feed({ hipY: 0.7, anklesVisible: false }, 10)
      out = feed({ hipY: 0.5, anklesVisible: false }, 10)

      expect(out.reps).toBe(1)
      const rep = tracker.getEvents().find((e) => e.kind === 'rep')
      expect(rep.fallback).toBe(true)
    })

    /**
     * ОДНА ШКАЛА НА ОБА РЕЖИМА — здесь была самая дорогая ошибка модуля.
     *
     * Резервный режим переводил просадку таза в псевдоугол по НЕПОДВИЖНОЙ шкале
     * «стоя 175°, бедро вниз 80°», а пороги считаются от стойки конкретного
     * человека. У человека с фронтальной камеры стойка 155.3°, DOWN выходит
     * 93° — и на чужой шкале этот порог означал «опусти таз на 0.86 бедра»
     * вместо задуманных 62° сгиба. Полевой лог 16 августа: двенадцать циклов
     * подряд отклонены с минимумами 104.7–120.6°, то есть просадками 0.57–0.74.
     */
    /** Прогнать присед заданной глубины: просадка таза в долях бедра. */
    function squatByHip(dropRatio, thresholds) {
      const tracker = createSquatTracker(thresholds)
      let t = 0
      const feed = (opts, n) => {
        let out = null
        for (let i = 0; i < n; i += 1) {
          const f = hipFrame(opts)
          out = tracker.update(f.landmarks, t, f.worldLandmarks)
          t += 50
        }
        return out
      }
      // стойка с голеностопами: база таза 0.5, бедро 0.2
      feed({ hipY: 0.5 }, 10)
      // голеностопы пропали, через три секунды включается резервный режим
      feed({ hipY: 0.5, anklesVisible: false }, 70)
      feed({ hipY: 0.5 + 0.2 * dropRatio, anklesVisible: false }, 10)
      const out = feed({ hipY: 0.5, anklesVisible: false }, 10)
      return { reps: out.reps, events: tracker.getEvents() }
    }

    /** Пороги того самого полевого прогона: стойка 155.3 -> UP 143, DOWN 93. */
    const FIELD = { upAngle: 143, downAngle: 93 }

    it('стоя резервный режим читается выше UP, а не «почти присед»', () => {
      // иначе стоящий человек не считался бы выпрямившимся, и цикл не закрылся бы
      const { events } = squatByHip(0, FIELD)
      expect(events.filter((e) => e.kind === 'rep')).toHaveLength(0)
    })

    it('полевые просадки 0.57–0.74 бедра засчитываются — раньше не проходила ни одна', () => {
      for (const drop of [0.573, 0.62, 0.68, 0.74]) {
        expect({ просадка: drop, повторов: squatByHip(drop, FIELD).reps }).toEqual({
          просадка: drop,
          повторов: 1,
        })
      }
    })

    it('мелкий подсед приседом не становится', () => {
      // подсед за низкой мишенью — треть бедра и меньше: это не работа
      for (const drop of [0.2, 0.3, 0.4]) {
        expect({ просадка: drop, повторов: squatByHip(drop, FIELD).reps }).toEqual({
          просадка: drop,
          повторов: 0,
        })
      }
    })

    it('порог одинаков при любой калибровке: он всегда одна и та же просадка', () => {
      /**
       * Смысл всей правки. Стойка у двух людей разная, пороги разные — а
       * ТРЕБУЕМАЯ ГЛУБИНА в резервном режиме обязана остаться одной и той же
       * долей бедра, иначе порог значит разное в зависимости от того, видно
       * голеностопы или нет.
       */
      for (const pair of [FIELD, { upAngle: 160, downAngle: 100 }, { upAngle: 130, downAngle: 70 }]) {
        expect({ ...pair, ok: squatByHip(0.6, pair).reps }).toEqual({ ...pair, ok: 1 })
        expect({ ...pair, ok: squatByHip(0.45, pair).reps }).toEqual({ ...pair, ok: 0 })
      }
    })

    it('в событии видно, по какой планке судили и каким режимом мерили', () => {
      // без этой тройки полевой лог нечитаем: «минимум 112°» ничего не значит
      const { events } = squatByHip(0.7, FIELD)
      const rep = events.find((e) => e.kind === 'rep')
      expect(rep.bar).toBe(93)
      expect(rep.stand).toBe(143)
      expect(rep.amplitude).toBeGreaterThan(0)
      expect(rep.fallback).toBe(true)
    })
  })

  describe('второй подход подряд', () => {
    const runSet = (tracker, clock) => {
      hold(tracker, clock, 175, 8)
      for (let i = 0; i < 6; i += 1) {
        hold(tracker, clock, 80, 8)
        hold(tracker, clock, 175, 8)
      }
      return tracker.getStats().reps
    }

    it('reset полностью очищает состояние: второй подход считает так же', () => {
      const tracker = createSquatTracker()
      const clock = newClock()

      const first = runSet(tracker, clock)
      expect(first).toBe(6)

      tracker.reset()
      // время идёт дальше, как в реальности между подходами
      clock.t += 30000
      const second = runSet(tracker, clock)

      expect(second).toBe(first)
      expect(tracker.getEvents().filter((e) => e.kind === 'rep')).toHaveLength(6)
    })

    it('новый трекер после первого подхода считает столько же', () => {
      const a = createSquatTracker()
      const clockA = newClock()
      const first = runSet(a, clockA)

      const b = createSquatTracker()
      const clockB = newClock()
      clockB.t = clockA.t + 30000
      const second = runSet(b, clockB)

      expect(second).toBe(first)
    })
  })

  describe('аварийный простой режим', () => {
    it('считает по пересечению порогов, без проверки формы цикла', () => {
      const tracker = createSquatTracker({ simpleMode: true })
      const clock = newClock()

      // цикл ~200 мс — основной режим отклонил бы как слишком короткий
      hold(tracker, clock, 175, 8, 10)
      hold(tracker, clock, 80, 5, 20)
      const out = hold(tracker, clock, 175, 8, 20)

      expect(out.simpleMode).toBe(true)
      expect(out.reps).toBe(1)
    })

    it('минимальный интервал между повторами всё ещё работает', () => {
      const tracker = createSquatTracker({ simpleMode: true, minRepIntervalMs: 400 })
      const clock = newClock()

      hold(tracker, clock, 175, 8, 10)
      hold(tracker, clock, 80, 4, 10)
      hold(tracker, clock, 175, 6, 10)
      hold(tracker, clock, 80, 4, 10)
      const out = hold(tracker, clock, 175, 6, 10)

      expect(out.reps).toBe(1)
      expect(tracker.getEvents().map((e) => e.kind)).toEqual(['rep', 'too_fast'])
    })

    it('переключается на лету через setConfig', () => {
      const tracker = createSquatTracker()
      const clock = newClock()

      hold(tracker, clock, 175, 8, 10)
      hold(tracker, clock, 80, 4, 10)
      hold(tracker, clock, 175, 8, 10)
      expect(tracker.getStats().reps).toBe(0) // цикл короче minCycleMs

      tracker.setConfig({ simpleMode: true })
      clock.t += 600
      hold(tracker, clock, 80, 4, 10)
      const out = hold(tracker, clock, 175, 8, 10)
      expect(out.reps).toBe(1)
    })
  })

  it('сообщает причину отклонения последнего цикла', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    // неглубокий присед
    hold(tracker, clock, 175, 8)
    hold(tracker, clock, 130, 8)
    let out = hold(tracker, clock, 175, 8)
    expect(out.lastReject).toMatch(/не достиг DOWN/)

    // слишком короткий цикл
    hold(tracker, clock, 80, 3, 10)
    out = hold(tracker, clock, 175, 8, 10)
    expect(out.lastReject).toMatch(/короче/)

    // засчитанный повтор снимает причину
    hold(tracker, clock, 80, 8, 50)
    out = hold(tracker, clock, 175, 8, 50)
    expect(out.reps).toBe(1)
    expect(out.lastReject).toBe(null)
  })

  it('reset возвращает трекер в исходное состояние', () => {
    const tracker = createSquatTracker()
    const clock = newClock()

    hold(tracker, clock, 175, 8)
    hold(tracker, clock, 80, 8)
    hold(tracker, clock, 175, 8)
    expect(tracker.getStats().reps).toBe(1)

    tracker.reset()
    expect(tracker.getStats().reps).toBe(0)
    expect(tracker.getStats().avgDepth).toBe(null)
  })
})
