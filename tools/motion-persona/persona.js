/**
 * ПЕРСОНАЖ: КТО СТОИТ ПЕРЕД КАМЕРОЙ И ЧТО ОН ДЕЛАЕТ.
 *
 * Собран из того, что в проекте уже есть, и ничего не выдумывает сам:
 *
 *   ДВИЖЕНИЯ — `src/motion/debug/demoLoops.json`. Петли там не нарисованы
 *     руками, а ВЫРЕЗАНЫ ИЗ ЖИВЫХ ЗАПИСЕЙ тем же инструментом, который судит
 *     детекторы. Значит форма движения и его скорость — настоящие, снятые с
 *     человека, а не придуманные под пороги.
 *
 *   СООТВЕТСТВИЕ «движение игры -> петля» — `loopKey()` из
 *     `debug/DemoSkeleton.jsx`, то есть ТА ЖЕ таблица, по которой инструктор
 *     показывает движение человеку. Заведи мы свою — персонаж делал бы не то,
 *     что просят с экрана, и расхождение вылезло бы как «судейство не считает».
 *
 *   ТЕМП — `prod-profile.json`, собранный из motion_log с прода
 *     (`prod-stats.mjs`): сколько повторов человек успевает за силовой блок,
 *     как часто в бою прилетает мишень, за сколько он до неё дотягивается.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО — знания о расписании сессии. Персонаж не
 * ведёт свой счёт кругам и не решает, когда начнётся бой: он СМОТРИТ, что
 * приложение показывает прямо сейчас (`currentScreen()` и строки журнала), и
 * делает то, что просят. Свой счёт разошёлся бы с приложением на первой же
 * задержке загрузки модели, и дальше персонаж выполнял бы выпады под бой.
 */

/**
 * ПЕРИОД ПОВТОРА, КОТОРОМУ МОЖНО ВЕРИТЬ.
 *
 * В проде лежит число ЗАСЧИТАННЫХ повторов, а не сделанных: по приседу это
 * 3 за тридцать секунд при живых отказах «не достиг DOWN: минимум 146° при
 * пороге 98°». Взять оттуда период буквально — значит заставить персонажа
 * приседать раз в десять секунд, то есть воспроизвести не человека, а
 * недосчёт детектора, и потом этим же недосчётом мерить конвейер.
 *
 * Поэтому прод задаёт темп только внутри физически возможных границ, а форму и
 * скорость самого движения задаёт петля — она снята с живого человека.
 */
const PERIOD_MIN_MS = 1200
const PERIOD_MAX_MS = 4200
const PERIOD_DEFAULT_MS = 2400

/** Насколько петлю можно ускорить или замедлить относительно записанной. */
const TEMPO_MIN = 0.6
const TEMPO_MAX = 1.6

/**
 * Разброс темпа. Живой человек не метроном: у него повтор к повтору гуляет, и
 * судейство обязано увидеть именно такой поток. Ровная гребёнка проходит пороги
 * там, где человек их не проходит, и прогон соврал бы в лучшую сторону.
 */
const JITTER = 0.18

/**
 * СКОЛЬКО ПОВТОРОВ В ПЕТЛЕ.
 *
 * Петля — это кусок живой записи, а не ровно один повтор: в звезде их два, в
 * приседе один, и на глаз это не видно. Пока считалось «один», персонаж делал
 * звезду вдвое чаще человека — тридцать три повтора за блок против
 * семнадцати по проду, — то есть темп из motion_log переставал что-либо
 * значить ровно там, где он важнее всего.
 *
 * Считается по одной координате — той, что за петлю ходит дальше всех, — с
 * гистерезисом: повтор засчитывается, когда сигнал сходил вниз до 30% размаха
 * и вернулся выше 70%. Автокорреляция здесь пробовалась первой и врала в обе
 * стороны: звезду с её двумя повторами объявляла одним, а `wall:right` —
 * восемью, поймав совпадение на бессмысленно большой задержке.
 */
export function cyclesInLoop(frames) {
  const n = frames.length
  if (n < 8) return 1
  const dim = frames[0].length

  /**
   * ПО ОДНОЙ КООРДИНАТЕ — той, что за петлю ходит дальше всех. В звезде это
   * запястье по вертикали, в приседе таз. Брать все сразу нельзя: неподвижные
   * точки размывают размах, и порог перестаёт что-либо отделять.
   */
  let pick = 0
  let bestRange = -1
  for (let d = 0; d < dim; d += 1) {
    let lo = Infinity
    let hi = -Infinity
    for (const f of frames) {
      if (f[d] < lo) lo = f[d]
      if (f[d] > hi) hi = f[d]
    }
    if (hi - lo > bestRange) {
      bestRange = hi - lo
      pick = d
    }
  }
  // почти неподвижная запись — считать в ней нечего
  if (!(bestRange > 0.2)) return 1

  const signal = frames.map((f) => f[pick])
  const lo = Math.min(...signal)
  const range = bestRange
  /**
   * ГИСТЕРЕЗИС, А НЕ ПОРОГ ПОСЕРЕДИНЕ. Дрожание около середины иначе
   * насчитывает по повтору на кадр; здесь повтор засчитывается только когда
   * сигнал сходил вниз до 30% размаха и вернулся выше 70%.
   */
  const low = lo + range * 0.3
  const high = lo + range * 0.7

  /**
   * Петля ЦИКЛИЧНА: последний кадр стыкуется с первым, и повтор, разрезанный
   * границей записи, обязан посчитаться один раз. Поэтому сигнал проходится
   * дважды, а считаются переходы на втором круге — к нему состояние уже
   * установилось.
   */
  let state = null
  let count = 0
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      const v = signal[i]
      if (v >= high) {
        if (state === 'low' && pass === 1) count += 1
        state = 'high'
      } else if (v <= low) {
        state = 'low'
      }
    }
  }
  return Math.max(1, count)
}

/**
 * КУДА ТЯНУТЬСЯ ЗА МИШЕНЬЮ. Части тела ловца — в точки нашей фигуры.
 *
 * Порядок точек в петлях тот же, что в `debug/demoLoops.json`, а имена сторон —
 * те же, что в `PART_POINTS` ловца (левое запястье это левое запястье). Ловец
 * засчитывает ЛЮБУЮ из двух сторон: подпись называет часть тела, а не рабочую
 * руку, и человек тянется тем, чем ближе. Персонаж поступает так же.
 */
const REACH_JOINTS = {
  palm: { left: 5, right: 6, parent: { left: 3, right: 4 } },
  elbow: { left: 3, right: 4, parent: { left: 1, right: 2 } },
  knee: { left: 9, right: 10, parent: { left: 7, right: 8 } },
  foot: { left: 11, right: 12, parent: { left: 9, right: 10 } },
}

/** Простой воспроизводимый генератор: один и тот же прогон — один и тот же человек. */
export function makeRandom(seed = 1) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

/**
 * КАКОЕ ДВИЖЕНИЕ ИДЁТ СЕЙЧАС — читается из приложения, а не из своих часов.
 *
 * `currentScreen()` отдаёт `session:strength:круг3`, `session:fight:круг3`,
 * `session:rest:круг3`, `calibration`, `levels`, `room` и так далее. Какое
 * именно силовое движение в блоке, экран в своём имени не несёт — оно приходит
 * строкой журнала `[block.start] {"movement":"jack"}`, и берётся последняя.
 */
export function readActivity(screenName, logText, hasEyes = false) {
  const screen = String(screenName || '')

  if (screen.startsWith('session:strength')) {
    const all = String(logText || '').match(/\[block\.start\][^\n]*"movement":"([a-z]+)"/g)
    const last = all?.[all.length - 1]?.match(/"movement":"([a-z]+)"/)?.[1]
    return { kind: 'strength', movement: last || 'barrier', screen }
  }

  // `eyes` — публикуется ли список летящих мишеней (?motion-debug). Со зрением
  // персонаж тянется к мишени и петли не крутит; без него остаётся перебор
  // движений вслепую, каким прогон и был до этого
  if (screen.startsWith('session:fight')) return { kind: 'fight', screen, eyes: hasEyes }

  /**
   * Отладочный вход в один силовой блок: `?block=barrier` (см. index.jsx).
   * Движение стоит прямо в имени экрана — журнала спрашивать незачем.
   */
  const single = screen.match(/^block:([a-z]+)$/)
  if (single) return { kind: 'strength', movement: single[1], screen }

  // калибровка, выбор уровня, постановка в кадр, отсчёт, отдых, результат —
  // везде человек просто стоит в кадре, и именно это от него и требуется
  return { kind: 'stand', screen }
}

/**
 * ПЕРСОНАЖ.
 *
 * @param {object} options
 * @param {object} options.loops содержимое demoLoops.json
 * @param {(movement: string, side: string|null) => string} options.loopKey из DemoSkeleton
 * @param {object} options.profile prod-profile.json (может быть пустым)
 * @param {string[]} options.fightTypes FIGHT_TYPES из game/session.js
 * @param {() => number} [options.random]
 */
export function createPersona({ loops, loopKey, profile = {}, fightTypes = [], random = makeRandom(7) }) {
  const fps = loops.fps || 12
  const has = (key) => Array.isArray(loops.loops?.[key]) && loops.loops[key].length > 0

  /** Петля с обеими сторонами там, где они есть. */
  function pickLoop(movement, side) {
    const wanted = loopKey(movement, side)
    if (has(wanted)) return wanted
    for (const alt of [loopKey(movement, 'right'), loopKey(movement, 'left'), loopKey(movement, null)]) {
      if (has(alt)) return alt
    }
    return null
  }

  /**
   * СТОЙКА. Берётся не из воздуха, а первым кадром звезды: петля начинается с
   * человека, стоящего ровно, — ноги вместе, руки вдоль тела. Это же та поза, по
   * которой приложение снимает личную калибровку угла в стойке, поэтому
   * выдумывать её отдельно нельзя: выдуманная стойка сдвинула бы пороги
   * судейства ещё до первого повтора.
   */
  const standKey = has('jack') ? 'jack' : Object.keys(loops.loops)[0]
  const standFrame = loops.loops[standKey][0]

  const periodOf = (movement) => {
    const fromProd = profile.strengthRepMs?.[movement]?.periodMs
    const raw = Number.isFinite(fromProd) ? fromProd : PERIOD_DEFAULT_MS
    return Math.min(PERIOD_MAX_MS, Math.max(PERIOD_MIN_MS, raw))
  }

  const spawnMs = Number(profile.fightSpawnMs?.median) || 1957
  const reactionMs = Number(profile.reactionMs?.median) || 1400

  /** Текущее состояние: что играем, с какого момента и с каким разбросом. */
  let current = null
  /** Стороны чередуются: тридцать секунд на одну ногу — это не тренировка. */
  let sideFlip = false
  let fightIndex = 0
  /** Когда в бою начинается следующее движение. */
  let nextFightAt = 0

  /** Повторов в петле — считается один раз на петлю, автокорреляцией. */
  const cycles = new Map()
  const cyclesOf = (key) => {
    if (!cycles.has(key)) cycles.set(key, cyclesInLoop(loops.loops[key]))
    return cycles.get(key)
  }

  function startClip(key, periodMs, nowMs) {
    const frames = loops.loops[key]
    const naturalMs = (frames.length / fps) * 1000
    // период В ПЕТЛЕ, а не в повторе: если в записи два повтора, то и времени
    // ей полагается вдвое больше, иначе персонаж делает вдвое больше человека
    const wantMs = periodMs * cyclesOf(key)
    // темп из прода — но только в тех пределах, в каких человек вообще может
    // двигаться; остаток периода становится паузой между повторами
    const tempo = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, naturalMs / wantMs))
    const playMs = naturalMs / tempo
    current = {
      key,
      frames,
      startedAt: nowMs,
      playMs,
      // пауза после повтора: то, что не уместилось в темп петли
      holdMs: Math.max(0, wantMs - playMs) * (0.7 + random() * 0.6),
    }
  }

  /**
   * Поза на данный момент — 13 точек в нормированных координатах петли
   * (таз в начале координат, масштаб — длина корпуса, y вниз).
   *
   * @param {{kind: string, movement?: string}} activity что сейчас требуется
   * @param {number} nowMs
   * @returns {number[]} плоский список [x0,y0, x1,y1, ...]
   */
  function poseAt(activity, nowMs) {
    if (activity.kind === 'strength') {
      const side = sideFlip ? 'left' : 'right'
      const key = pickLoop(activity.movement, side)
      if (!key) return breathe(standFrame, nowMs)
      if (!current || current.key !== key) startClip(key, periodOf(activity.movement) * jitter(), nowMs)
      return advance(nowMs, () => {
        sideFlip = !sideFlip
        const next = pickLoop(activity.movement, sideFlip ? 'left' : 'right') || key
        startClip(next, periodOf(activity.movement) * jitter(), nowMs)
      })
    }

    if (activity.kind === 'fight') {
      /**
       * СО ЗРЕНИЕМ ПЕТЛИ НЕ КРУТЯТСЯ. Мишень ловца требует не движения, а
       * дотягивания в точку, и делает это `applyReach` поверх уже размещённых
       * точек. Живой человек в этот момент тоже не делает выпадов: он стоит и
       * тянется. Слепой перебор остаётся ниже — на случай, когда список мишеней
       * не публикуется.
       */
      if (activity.eyes) {
        current = null
        return breathe(standFrame, nowMs)
      }
      if (!current && nowMs >= nextFightAt) {
        // мишени в бою идут вперемешку — персонаж перебирает их по кругу,
        // а не долбит одно движение: движок раунда чередует типы
        for (let i = 0; i < fightTypes.length; i += 1) {
          const type = fightTypes[(fightIndex + i) % fightTypes.length]
          const key = pickLoop(type, sideFlip ? 'left' : 'right')
          if (key) {
            fightIndex = (fightIndex + i + 1) % fightTypes.length
            sideFlip = !sideFlip
            // движение делается за время реакции человека, а не за время петли
            startClip(key, Math.max(PERIOD_MIN_MS, reactionMs) * jitter(), nowMs)
            break
          }
        }
      }
      if (current) {
        return advance(nowMs, () => {
          // до следующей мишени — столько, сколько движок её и держит
          nextFightAt = nowMs + spawnMs * jitter() * 0.5
        })
      }
      return breathe(standFrame, nowMs)
    }

    current = null
    return breathe(standFrame, nowMs)
  }

  const jitter = () => 1 + (random() - 0.5) * 2 * JITTER

  /** Проиграть текущий отрезок; когда он кончился — позвать onDone. */
  function advance(nowMs, onDone) {
    const t = nowMs - current.startedAt
    if (t >= current.playMs + current.holdMs) {
      const done = current
      current = null
      onDone?.()
      // если следующий отрезок не начался (бой ждёт мишень) — стоим
      return current ? sampleClip(current, 0) : breathe(done.frames[0], nowMs)
    }
    if (t >= current.playMs) {
      // повтор доигран, человек стоит и дышит перед следующим
      return breathe(current.frames[current.frames.length - 1], nowMs)
    }
    return sampleClip(current, t)
  }

  /**
   * Кадр петли с линейной вставкой между соседними.
   *
   * Петля снята на 12 кадрах в секунду, камера отдаёт 30: без вставки человек
   * двигался бы ступеньками, и детекторы, которые считают пересечение порогов
   * по времени между замерами, увидели бы рывки вместо движения.
   */
  function sampleClip(clip, t) {
    const pos = (t / clip.playMs) * (clip.frames.length - 1)
    const i = Math.min(clip.frames.length - 1, Math.floor(pos))
    const j = Math.min(clip.frames.length - 1, i + 1)
    const k = pos - i
    const a = clip.frames[i]
    const b = clip.frames[j]
    const out = new Array(a.length)
    for (let n = 0; n < a.length; n += 1) out[n] = a[n] + (b[n] - a[n]) * k
    return out
  }

  /**
   * ДЫХАНИЕ И МИКРОКАЧАНИЕ В СТОЙКЕ.
   *
   * Не украшение. Приложение снимает личную калибровку по МЕДИАНЕ угла в
   * стойке за две секунды, а неподвижная до пикселя фигура даёт одно и то же
   * число и нулевой разброс — то есть условия, которых на живом человеке не
   * бывает. Заодно неподвижная картинка ломает и сам замер: модель на
   * неизменном кадре отдаёт неизменные точки, и «частота замеров» перестаёт
   * что-либо значить.
   */
  function breathe(frame, nowMs) {
    const out = new Array(frame.length)
    const sway = Math.sin(nowMs / 1700) * 0.012
    const lift = Math.sin(nowMs / 2300) * 0.008
    for (let n = 0; n < frame.length; n += 2) {
      out[n] = frame[n] + sway
      out[n + 1] = frame[n + 1] + lift
    }
    return out
  }

  /**
   * ЕСТЬ ЛИ ЖИВАЯ МИШЕНЬ, ЗА КОТОРОЙ НАДО ТЯНУТЬСЯ.
   *
   * Пока она висит, персонаж не крутит петли: живой человек в этот момент
   * тоже не делает выпадов, он тянется. Петли остаются на бой БЕЗ зрения —
   * когда `?motion-debug` выключен и список мишеней не публикуется.
   */
  let reach = null

  /**
   * ДОТЯНУТЬСЯ ДО МИШЕНИ — уже в пикселях кадра.
   *
   * Почему здесь, а не в `poseAt`: мишень ловца приходит в НОРМИРОВАННЫХ
   * координатах кадра (той же системе, в которой модель отдаёт точки), а петля
   * живёт в своей — таз в начале координат, масштаб по корпусу. Общая у них
   * только та рамка, в которой камера рисует человека, и знает её камера.
   * Поэтому поза считается в своей системе, а дотягивание накладывается поверх
   * уже размещённых точек.
   *
   * ЧЕЛОВЕК ТЯНЕТСЯ НЕ МГНОВЕННО. Задержка и время выноса берутся из прода
   * (`reactionMs`, медиана 1401 мс по 364 зачётам) и гуляют от мишени к мишени.
   * Это не украшение: мишень на «профи» живёт две секунды, и персонаж, который
   * попадает в неё мгновенно, дал бы 100% зачётов — то есть сцену, которой в
   * поле не бывает, и проверку отрисовки на несуществующей нагрузке.
   *
   * @param {Array<[number, number]>} pts точки фигуры в пикселях кадра
   * @param {{targets: Array<object>}|null} snapshot то, что опубликовал экран
   * @param {number} nowMs
   * @param {number} width
   * @param {number} height
   */
  function applyReach(pts, snapshot, nowMs, width, height) {
    const target = snapshot?.targets?.find((t) => t.spot && REACH_JOINTS[t.part])
    if (!target) {
      reach = null
      return pts
    }

    if (!reach || reach.id !== target.id) {
      const joints = REACH_JOINTS[target.part]
      // тянемся той стороной, которая сейчас ближе: ловец засчитывает обе
      const px = target.spot.x * width
      const py = target.spot.y * height
      const near = (side) => {
        const p = pts[joints[side]]
        return Math.hypot(p[0] - px, p[1] - py)
      }
      const side = near('left') <= near('right') ? 'left' : 'right'
      reach = {
        id: target.id,
        side,
        // задержка и вынос вместе дают время до касания около reactionMs
        lagMs: reactionMs * 0.45 * jitter(),
        pullMs: reactionMs * 0.55 * jitter(),
        startedAt: nowMs,
      }
    }

    const joints = REACH_JOINTS[target.part]
    const tip = joints[reach.side]
    const parent = joints.parent[reach.side]
    const px = target.spot.x * width
    const py = target.spot.y * height

    const t = nowMs - reach.startedAt - reach.lagMs
    if (t <= 0) return pts
    // плавный вынос и остановка: рывком до точки конечность не двигается ни у
    // кого, а судейство считает касание по времени на отрезке между замерами
    const k = t >= reach.pullMs ? 1 : 1 - (1 - t / reach.pullMs) ** 3

    const tipX = pts[tip][0] + (px - pts[tip][0]) * k
    const tipY = pts[tip][1] + (py - pts[tip][1]) * k
    // родительский сустав идёт следом наполовину — иначе конечность
    // растягивается, и модель видит не человека, а сломанную фигуру
    pts[parent] = [
      pts[parent][0] + (tipX - pts[tip][0]) * 0.45,
      pts[parent][1] + (tipY - pts[tip][1]) * 0.45,
    ]
    pts[tip] = [tipX, tipY]
    return pts
  }

  /** Идёт ли сейчас дотягивание: пока идёт, петли не крутятся. */
  const isReaching = () => reach != null

  return { poseAt, pickLoop, applyReach, isReaching }
}
