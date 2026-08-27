/**
 * Замер личной амплитуды для экрана «Настройка под себя».
 *
 * Экран знакомит человека с движениями и заодно узнаёт, на что он способен:
 * три повтора каждого движения во всю силу — и по ним считается личная планка
 * (personal.js). Здесь живёт всё, что можно проверить без React: как считается
 * повтор, какая у него амплитуда и что из трёх повторов идёт в планку.
 *
 * ТРИ РЕШЕНИЯ, КОТОРЫЕ ЗДЕСЬ ВАЖНЕЕ КОДА.
 *
 * 1. Повтор засчитывается по ПОЛУ — половине общего порога. Настройка обязана
 *    пройтись у любого: если требовать на знакомстве полноценный игровой порог,
 *    негибкий человек не сможет отметить ни одного повтора, застрянет на первом
 *    же движении и до челленджа не доберётся. А смысл экрана ровно обратный —
 *    узнать МАЛЕНЬКУЮ амплитуду, чтобы потом судить по ней.
 *
 * 2. Планка считается по МЕДИАНЕ трёх повторов, а не по максимуму. Один
 *    выброс — дёрнувшаяся точка трекинга, случайный шаг, ловля равновесия —
 *    задрал бы планку на всю неделю, и человек потом не понимал бы, почему
 *    игра перестала его засчитывать. Медиана трёх такой выброс просто
 *    выбрасывает. По той же причине повторов именно три, а не два: у двух нет
 *    середины.
 *
 * 3. Метрики те же, по которым судит игра (см. personal.js, METRIC). Мерить
 *    амплитуду одним числом, а судить другим — верный способ получить планку,
 *    которая ни к чему не относится.
 */

import { DEFAULT_ROUND } from './engine.js'
import { checkFrame, createGateState } from '../pose/frameGate.js'
import { FLOOR_SHARE } from './personal.js'
import { punchValue } from './strike.js'
import { createJumpWatcher } from './vertical.js'
import { DEFAULT_LUNGE } from './legs.js'

/** Сколько повторов просим на каждое движение. Три — чтобы была середина. */
export const SETUP_REPS = 3

/**
 * ТРИ ДВИЖЕНИЯ — присед, выпад, прыжок.
 *
 * Было девять, и это оказалось входным барьером не хуже платного: девять
 * движений по три повтора — двадцать семь подходов ДО первой тренировки, и всё
 * это стоя перед камерой в незнакомой игре. Человек, пришедший попробовать,
 * уходил на середине знакомства и до челленджа не добирался вовсе.
 *
 * Оставлены силовые, и это не «первые три из списка». Именно они идут в силовые
 * блоки каждого круга — то есть именно их личная планка работает всю сессию, а
 * боевые движения ловец судит попаданием в круг, и амплитуда там ни при чём.
 * Мерить то, что потом не судится, значило продавать человеку двадцать минут
 * его времени ни за что.
 *
 * Порядок от знакомого к незнакомому: присед человек делал, выпад видел,
 * прыжок в игре свой.
 *
 * Словари ниже (SETUP_SIDE, SETUP_NAME, задачи) остались полными — лишние
 * записи просто не используются. Выкинуть их значило бы закрыть дорогу назад,
 * а список движений мы за месяц меняли трижды.
 */
export const SETUP_MOVEMENTS = ['barrier', 'lunge', 'pit']

/**
 * Парные движения настраиваются ОДНОЙ стороной: планка в personal.js общая на
 * движение, и гонять человека по обеим сторонам значило бы удвоить экран ради
 * того же числа. Сторона здесь только для показа — какую фигурку и какие слова
 * показать; засчитывается движение любой стороной (см. metricOf).
 */
export const SETUP_SIDE = {
  wall: 'right',
  beam: 'right',
  strike: 'right',
  knee: 'right',
  bird: 'right',
  lunge: 'right',
  heel: 'right',
}

/** Человеческие названия — их же видит человек в сводке. */
export const SETUP_NAME = {
  barrier: 'Присед',
  wall: 'Шаг в сторону',
  beam: 'Наклон вбок',
  strike: 'Удар рукой',
  knee: 'Подъём колена',
  bird: 'Мах рукой вверх',
  pit: 'Прыжок',
  lunge: 'Выпад назад',
  heel: 'Захлёст голени',
}

/** Что просим сделать — коротко и глаголом, читается с двух метров. */
export const SETUP_TASK = {
  barrier: 'Присядь как можно глубже',
  wall: 'Шагни вправо как можно шире',
  beam: 'Наклонись вправо как можно сильнее',
  strike: 'Выбрось правую руку вперёд',
  knee: 'Подними правое колено как можно выше',
  bird: 'Подними правую руку через сторону вверх',
  pit: 'Подпрыгни как можно выше',
  lunge: 'Шагни правой далеко назад и опустись',
  heel: 'Достань правой пяткой до ягодицы',
}

/**
 * Общий порог движения — тот самый, по которому судит игра. Пороги приседа
 * зависят от калибровки стойки, поэтому она передаётся снаружи.
 */
export function globalBarOf(movement, thresholds = {}) {
  const up = Number.isFinite(thresholds.upAngle) ? thresholds.upAngle : DEFAULT_ROUND.upAngle
  const down = Number.isFinite(thresholds.downAngle)
    ? thresholds.downAngle
    : DEFAULT_ROUND.downAngle

  switch (movement) {
    // глубина в градусах: стойка минус зачётный угол
    case 'barrier':
      return up - (down + DEFAULT_ROUND.duckMarginDeg)
    case 'wall':
      return DEFAULT_ROUND.dodgeShouldersK
    case 'beam':
      return DEFAULT_ROUND.leanShouldersK
    case 'strike':
      return DEFAULT_ROUND.punchOutK
    case 'knee':
      return DEFAULT_ROUND.kneeLiftK
    case 'bird':
      return DEFAULT_ROUND.raiseK
    case 'pit':
      return DEFAULT_ROUND.jumpFootLiftK
    case 'lunge':
      return DEFAULT_ROUND.lungeBackK
    case 'heel':
      return DEFAULT_ROUND.heelFootK
    default:
      return null
  }
}

/** Планка, на которой засчитывается повтор при настройке: половина общей. */
export const setupBarOf = (movement, thresholds) =>
  globalBarOf(movement, thresholds) * FLOOR_SHARE

/** Медиана. Она, а не среднее: один выброс её не сдвигает. */
export function median(values) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (!clean.length) return null
  const sorted = [...clean].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const bestOf = (a, b) => {
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null
  if (!Number.isFinite(b)) return a
  return Math.max(a, b)
}

/**
 * Как объяснить планку человеку. Он не читает ни долей корпуса, ни метров
 * мировых точек, поэтому каждое движение переводится в то, что можно
 * представить: градусы, ширины плеч, сантиметры.
 */
export function describeBar(movement, bar, thresholds = {}) {
  if (!Number.isFinite(bar)) return 'общая планка'
  const up = Number.isFinite(thresholds.upAngle) ? thresholds.upAngle : DEFAULT_ROUND.upAngle
  const round1 = (v) => Number(v.toFixed(1))
  const round2 = (v) => Number(v.toFixed(2))

  switch (movement) {
    case 'barrier':
      return `до ${Math.round(up - bar)}° в колене`
    case 'wall':
      return `${round1(bar)} ширины плеч в сторону`
    case 'beam':
      return `${round1(bar)} ширины плеч наклона`
    case 'strike':
      return `рука вперёд на ${round2(bar)} своей длины`
    case 'knee':
      return `колено на ${round2(bar)} корпуса выше таза`
    case 'bird':
      return `запястье на ${round2(bar)} корпуса выше носа`
    case 'pit':
      return `обе стопы на ${round2(bar)} корпуса от пола`
    // не в сантиметрах: глубина меряется в долях собственной ноги, и «42 см»
    // значили бы разное у высокого и у низкого
    case 'lunge':
      return `нога назад на ${Math.round(bar * 100)}% длины ноги`
    case 'lunge-drop':
      return `и просадка таза на ${round2(bar)} корпуса`
    case 'heel':
      return `стопа на ${round2(bar)} корпуса выше второй`
    default:
      return `${round2(bar)}`
  }
}

/**
 * Счётчик повторов одного движения.
 *
 * Повтор — это ВХОД И ВЫХОД: значение поднялось выше планки и вернулось назад.
 * Одного порога мало — человек, замерший в приседе, иначе нащёлкал бы три
 * повтора за полсекунды. Гистерезис на выходе и рефрактерный период страхуют
 * от дребезга на границе.
 *
 * @param {string} movement
 * @param {{thresholds?: object, refractoryMs?: number}} [options]
 */
export function createAmplitudeCounter(movement, options = {}) {
  /** Ворота кадра — те же, что у приседа и силового блока. */
  const gate = createGateState(options.thresholds ?? {})
  const bar = setupBarOf(movement, options.thresholds)
  /** Ниже этого повтор считается законченным и разрешается следующий. */
  const exit = bar * 0.6
  const refractoryMs = options.refractoryMs ?? 400
  const window = options.homeWindowMs ?? 4000

  /**
   * Прыжку нужна своя опора: высота стоп меряется от их медианы, а «пол» в
   * кадре не виден. Автомат прыжка это уже умеет, поэтому берём его целиком и
   * читаем только подъём стоп — события нам здесь не нужны.
   */
  const jumpWatcher = movement === 'pit' ? createJumpWatcher({ footLiftK: 0 }) : null
  /** Домашняя позиция для шага: медиана таза по горизонтали за окно. */
  const hips = []

  /**
   * У выпада мер ДВЕ: нога назад и просадка таза. Обе обязательны в игре,
   * значит обе должны быть личными — иначе человек настраивает одно, а
   * упирается в другое. Поэтому у выпада замер парный: повтор считается по
   * ноге, а внутри повтора копится ещё и пик просадки.
   */
  const paired = movement === 'lunge'
  const shinK = DEFAULT_LUNGE.shinK
  /** Высота таза за окно: по её медиане считается просадка, как в legs.js. */
  const hipsY = []

  let inside = false
  let peak = null
  let dropPeak = null
  let lastAt = null
  const reps = []
  const drops = []

  function homeX(nowMs, hipX) {
    if (hipX == null) return null
    hips.push({ t: nowMs, x: hipX })
    while (hips.length && nowMs - hips[0].t > window) hips.shift()
    const xs = hips.map((h) => h.x).sort((a, b) => a - b)
    return xs[Math.floor(xs.length / 2)]
  }

  /** Насколько таз ниже своей медианы, в корпусах. Считается как в детекторе. */
  function dropNow(nowMs, pose) {
    if (pose.hipY == null || !pose.torso) return null
    hipsY.push({ t: nowMs, y: pose.hipY })
    while (hipsY.length && nowMs - hipsY[0].t > window) hipsY.shift()
    const ys = hipsY.map((h) => h.y).sort((a, b) => a - b)
    return (pose.hipY - ys[Math.floor(ys.length / 2)]) / pose.torso
  }

  /**
   * Нога ушла назад — теми же двумя путями, что и в детекторе: по глубине из
   * мировых точек либо по укорочению голени в кадре. Иначе на телефоне без
   * рабочей оценки глубины настройку выпада было бы не пройти вовсе.
   */
  const legBack = (pose, threshold) => {
    const back = bestOf(pose.ankleBack?.left, pose.ankleBack?.right)
    const shin = Math.min(
      pose.shin?.left ?? Infinity,
      pose.shin?.right ?? Infinity,
    )
    return (back != null && back >= threshold) || shin <= shinK
  }

  function metricOf(nowMs, pose) {
    const up = Number.isFinite(options.thresholds?.upAngle)
      ? options.thresholds.upAngle
      : DEFAULT_ROUND.upAngle
    const width = pose.shoulderWidth

    switch (movement) {
      case 'barrier':
        return pose.angle == null ? null : up - pose.angle
      case 'wall': {
        const home = homeX(nowMs, pose.hipX)
        if (home == null || !width) return null
        return Math.abs(pose.hipX - home) / width
      }
      case 'beam':
        if (pose.shoulderX == null || pose.hipX == null || !width) return null
        return Math.abs(pose.shoulderX - pose.hipX) / width
      case 'strike': {
        // засчитываем любой рукой: планка всё равно одна на движение, а
        // заставлять левшу бить правой ради настройки незачем
        const of = (side) =>
          punchValue({
            reach: pose.reach?.[side],
            foreshorten: pose.foreshorten?.[side],
            elbow: pose.elbow?.[side],
          })
        return bestOf(of('left'), of('right'))
      }
      case 'knee':
        return bestOf(pose.kneeLift?.left, pose.kneeLift?.right)
      case 'bird':
        return bestOf(pose.raise?.left, pose.raise?.right)
      case 'pit':
        jumpWatcher.update(nowMs, {
          ankleY: pose.ankleY ?? { left: null, right: null },
          hipY: pose.hipY ?? null,
          torso: pose.torso ?? null,
        })
        return jumpWatcher.feetLift
      case 'lunge':
        return bestOf(pose.ankleBack?.left, pose.ankleBack?.right)
      case 'heel':
        return bestOf(pose.ankleDy?.left, pose.ankleDy?.right)
      default:
        return null
    }
  }

  return {
    movement,
    /** Планка, на которой засчитывается повтор здесь. */
    bar,
    /** Пики засчитанных повторов, по порядку. */
    reps,
    /** Пики просадки таза внутри повторов — только у выпада. */
    drops,
    /** Значение метрики в последнем кадре — по нему рисуется полоска. */
    value: null,
    /** Просадка таза в последнем кадре — только у выпада. */
    drop: null,

    /**
     * @param {number} nowMs
     * @param {object} pose признаки кадра — те же, что получает движок
     * @returns {{rep: number, peak: number}|null} повтор, если он только что закрылся
     */
    /**
     * @param {number} nowMs
     * @param {object} pose признаки кадра — те же, что получает движок
     * @param {Array} [landmarks] точки кадра. Есть — калибровка проверяет кадр
     *   гейтом, тем же, что судит повторы. Нет — прежнее поведение (разбор
     *   записей кормит счётчик готовыми признаками, кадра там уже нет).
     */
    update(nowMs, pose, landmarks) {
      /**
       * ГЕЙТ КАДРА НА КАЛИБРОВКЕ. Личная планка снимается ровно теми же
       * точками, которыми потом судят, — и снималась она без единой проверки
       * кадра. Планка, снятая с достроенных таза и коленей, дальше становится
       * порогом на весь челлендж: одна плохая калибровка портит все повторы
       * после неё, и никакой гейт в судействе этого уже не исправит.
       */
      if (landmarks) {
        const g = gate.update(checkFrame(landmarks, options.thresholds ?? {}), nowMs)
        this.gate = g
        if (!g.usable) {
          this.value = null
          this.drop = null
          return null
        }
      }
      const value = pose ? metricOf(nowMs, pose) : null
      this.value = Number.isFinite(value) ? value : null
      // просадка таза копится только у выпада — у остальных мера одна
      const drop = paired && pose ? dropNow(nowMs, pose) : null
      this.drop = drop

      // Ворота повтора. У всех движений это сама метрика, у выпада — «нога
      // ушла назад», и увидеть это можно двумя путями. Глубина при этом может
      // быть неизвестна вовсе: тогда повтор засчитается, а пик по ноге
      // останется пустым, и личной станет только просадка таза.
      const open = paired ? legBack(pose ?? {}, bar) : this.value != null && this.value >= bar
      const close = paired
        ? !legBack(pose ?? {}, exit)
        : this.value != null && this.value <= exit

      if (!inside) {
        if (!open) return null
        // один повтор — один вход: пока не прошёл рефрактерный период, новый
        // не начинается, иначе дребезг на границе даст три повтора разом
        if (lastAt != null && nowMs - lastAt < refractoryMs) return null
        inside = true
        peak = this.value
        dropPeak = drop
        return null
      }

      if (this.value != null && (peak == null || this.value > peak)) peak = this.value
      if (drop != null && (dropPeak == null || drop > dropPeak)) dropPeak = drop
      if (!close) return null

      // движение закончилось — записываем его пики
      inside = false
      lastAt = nowMs
      const done = peak
      const doneDrop = dropPeak
      peak = null
      dropPeak = null
      reps.push(done)
      drops.push(doneDrop)
      return { rep: reps.length, peak: done, drop: doneDrop }
    },

    /**
     * Личные планки по набранным повторам: медиана, а не максимум. См. заголовок.
     *
     * Возвращает обе меры всегда, просто у восьми движений из девяти вторая
     * пустая. У выпада пустой может оказаться и первая — если устройство не
     * отдало мировых точек, повторы считались по укорочению голени, и глубину
     * мерить было нечем. Тогда личной станет только просадка таза, а нога
     * останется на общей планке.
     *
     * @returns {{value: number|null, drop: number|null}}
     */
    result() {
      return { value: median(reps), drop: median(drops) }
    },

    reset() {
      inside = false
      peak = null
      dropPeak = null
      lastAt = null
      reps.length = 0
      drops.length = 0
      hips.length = 0
      hipsY.length = 0
      jumpWatcher?.reset()
      this.value = null
      this.drop = null
    },
  }
}
