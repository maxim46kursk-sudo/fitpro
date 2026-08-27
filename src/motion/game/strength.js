/**
 * СИЛОВОЙ БЛОК — одно движение, тридцать секунд, счёт повторов.
 *
 * Игра ловит движение НА ЛЕТУ: препятствие пролетает, и человек должен успеть в
 * окно. Силовой блок устроен иначе — он про объём: одно движение, время на
 * табло и столько повторов, сколько человек успеет. Инструктор в углу крутит
 * это движение петлёй, чтобы не надо было вспоминать, что делать.
 *
 * СЧЁТ ПОВТОРОВ ИДЁТ ТЕМИ ЖЕ ДЕТЕКТОРАМИ, ЧТО И ИГРА. Ни одного своего порога и
 * ни одной своей проверки здесь нет: те же автоматы (moves.js, legs.js,
 * vertical.js, squat.js), что судят препятствия, — просто без препятствий.
 * Разойдись счёт блока с судейством раунда, и человек получил бы две разные
 * игры в одном приложении.
 */

import { createSquatTracker } from '../exercises/squat.js'
import { checkFrame, createGateState } from '../pose/frameGate.js'
import { DEFAULT_JUMP, readVertical, createJumpWatcher } from './vertical.js'
import { DEFAULT_LUNGE, readLegs, createLegWatchers } from './legs.js'
import { DEFAULT_MOVES, moveMetric, readMoves, createMoveWatchers } from './moves.js'

/** Сколько идёт блок. Тридцать секунд — столько живёт силовой подход в ТЗ. */
export const BLOCK_MS = 30000

/**
 * Движения силового блока. Не все восемнадцать: сюда идут те, что делаются
 * ПОВТОРАМИ НА МЕСТЕ и нагружают, а не те, что придуманы как реакция на
 * летящее препятствие. Шаг в сторону, наклон вбок, удар и мах рукой остаются
 * игровыми: тридцать секунд шагов вбок — это не силовая работа.
 */
export const STRENGTH_TYPES = ['barrier', 'jumpsquat', 'lunge', 'sidelunge', 'twistknee', 'pit', 'jack']

export const isStrength = (type) => STRENGTH_TYPES.includes(type)

/** Команда тренера — те же слова, что и на мишенях игры. */
export const STRENGTH_LABEL = {
  barrier: 'ПРИСЯДЬ',
  jumpsquat: 'ПРИСЯДЬ И ВЫПРЫГНИ',
  lunge: 'ВЫПАД НАЗАД',
  sidelunge: 'ВЫПАД ВБОК',
  twistknee: 'ЛОКОТЬ К КОЛЕНУ',
  pit: 'ПРЫГНИ',
  jack: 'ЗВЕЗДА',
}

/**
 * Какой точкой тела движение «выстреливает» — оттуда и летят частицы за повтор.
 * Не украшение: вспышка у таза за присед и у головы за прыжок читаются как
 * ответ именно на это движение, а вспышка в углу экрана — как системное окно.
 */
export const STRENGTH_ANCHOR = {
  barrier: 'hip',
  jumpsquat: 'hip',
  lunge: 'hip',
  sidelunge: 'hip',
  twistknee: 'hip',
  pit: 'nose',
  jack: 'shoulder',
}

/** Петля инструктора: у парных движений показываем одну сторону. */
export const STRENGTH_LOOP = {
  barrier: { movement: 'barrier', side: null },
  jumpsquat: { movement: 'jumpsquat', side: null },
  lunge: { movement: 'lunge', side: 'left' },
  sidelunge: { movement: 'sidelunge', side: 'right' },
  twistknee: { movement: 'twistknee', side: 'right' },
  pit: { movement: 'jump', side: null },
  jack: { movement: 'jack', side: null },
}

/**
 * Темп петли инструктора по уровню. Новичку — родной темп записи, дальше
 * быстрее: на профи то же движение делается чаще, и фигура обязана показывать
 * тот темп, который от человека ждут.
 */
export const TEMPO_BY_TIER = { novice: 1, experienced: 1.2, pro: 1.4 }
export const tempoFor = (tier) => TEMPO_BY_TIER[tier] ?? 1

/**
 * ГЛАВНЫЙ ЗАМЕР КАЖДОГО СИЛОВОГО ДВИЖЕНИЯ И ЕГО ПЛАНКА.
 *
 * Зачем. Блок, давший мало повторов, до сих пор молчал о том, ПОЧЕМУ: в логе
 * было только число повторов. Присед 16 августа дал 1 из восьми, и разобрать
 * это удалось лишь потому, что у трекера приседа свои события с минимумом угла;
 * у остальных шести движений не было и этого. Теперь у каждого есть замер и
 * планка, а блок пишет в лог, до чего человек дотянул в каждой попытке.
 *
 * Числа берутся ИЗ детекторов, а не переписываются сюда: судит по ним автомат,
 * и вторая копия неминуемо разъехалась бы с первой при следующей правке.
 *
 * `dir` +1 — чем больше замер, тем ближе к зачёту; -1 — наоборот (у приседа
 * планка это минимум угла, и «лучше» значит МЕНЬШЕ).
 */
const MAIN_METRIC = {
  barrier: { dir: -1 },
  pit: { dir: 1, bar: DEFAULT_JUMP.footLiftK },
  lunge: { dir: 1, bar: DEFAULT_LUNGE.backK },
  jumpsquat: { dir: 1, bar: DEFAULT_MOVES.jumpsquat.dropK },
  sidelunge: { dir: 1, bar: DEFAULT_MOVES.sidelunge.shiftK },
  twistknee: { dir: 1, bar: DEFAULT_MOVES.twistknee.wristCrossK },
  jack: { dir: 1, bar: DEFAULT_MOVES.jack.ankleOutK },
}

/** Планка движения — та же, по которой судит его автомат. */
export const barFor = (type) => MAIN_METRIC[type]?.bar ?? null

/**
 * Копилка попыток: держит лучший замер с последнего зачёта и отдаёт его, когда
 * попытка закрылась. Попытка — это отрезок между повторами: у движений без
 * собственных циклов другого понятия «попытки» просто нет, а это даёт ровно то,
 * что нужно в поле, — «лучшее за подход было 0.31 при планке 0.45».
 */
function createAttempts(type) {
  const rule = MAIN_METRIC[type] ?? { dir: 1 }
  const list = []
  let best = null

  return {
    /** Замер этого кадра. Неизвестный пропускается, а не пишется нулём. */
    see(value) {
      if (value == null || !Number.isFinite(value)) return
      if (best == null || rule.dir * value > rule.dir * best) best = value
    },
    /** Попытка кончилась: зачётом или концом блока. */
    close(ok, extra = {}) {
      list.push({
        ok,
        metric: best == null ? null : Number(best.toFixed(2)),
        bar: rule.bar == null ? null : Number(rule.bar.toFixed(2)),
        ...extra,
      })
      best = null
    },
    /** Забрать накопленное. Блок сливает его в лог и очищает. */
    take() {
      return list.splice(0, list.length)
    },
    get pending() {
      return best != null
    },
  }
}

/**
 * Счётчик повторов одного движения.
 *
 * Внутри — тот же автомат, что судит это движение в игре. Наружу торчит одно:
 * «сколько повторов случилось в этом кадре». Стороны блок не различает: выпад
 * левой и выпад правой — это два повтора выпада, а не два разных упражнения.
 *
 * Плюс `attempts()` — попытки цикла с их замерами: то, что уходит в полевой лог
 * и без чего блок с одним повтором неразбираем.
 *
 * ПОРОГИ КАЛИБРОВКИ ОБЯЗАТЕЛЬНЫ ДЛЯ ПРИСЕДА, и это не украшение параметра.
 * Счётчик создавался БЕЗ конфига, то есть с заводскими UP 160 / DOWN 100. У
 * человека, прошедшего калибровку, стойка читается как 158°, и его пороги
 * 146/96 — а с заводским UP 160 угол в стойке НИКОГДА не поднимается выше
 * порога, цикл не закрывается ни разу, и блок отдаёт ноль повторов, ноль
 * попыток и пустой лог. Проверено на записи calibration-full-20260811: тот же
 * сегмент даёт 0 из 5 без порогов и 5 из 5 с ними (см. strength.test.js).
 *
 * Остальные шесть движений порогов приседа не спрашивают: их автоматы меряют
 * доли тела, а не углы, и калибровка им не нужна.
 *
 * @param {string} type движение силового блока
 * @param {object} config пороги калибровки — нужны только приседу
 * @returns {{update: Function, reset: Function, attempts: Function, flush: Function}}
 */
export function createRepCounter(type, config = {}) {
  /**
   * ГЕЙТ КАДРА — ТОТ ЖЕ, ЧТО У ПРИСЕДА, И ЗДЕСЬ ЕГО ДО СИХ ПОР НЕ БЫЛО.
   *
   * Присед (`barrier`) считает createSquatTracker, а он спрашивает checkFrame
   * сам. Остальные шесть движений — выпад, звезда, прыжок и прочие — судились
   * по голым координатам: MediaPipe отдаёт все 33 точки всегда и достраивает
   * те, что вне кадра, поэтому таз и колени «есть» и тогда, когда в кадре одни
   * плечи. По журналу за месяц это 135 повторов из 184.
   *
   * Ничего нового не заводим: тот же checkFrame, тот же createGateState, те же
   * пороги. Кадр без таза и коленей до детектора не доходит и повтором не
   * становится.
   *
   * ПРИСЕД НЕ ОБОРАЧИВАЕМ. У него гейт уже внутри трекера, и второй снаружи
   * означал бы двое ворот с раздельным состоянием: внешние глотали бы кадр, а
   * внутренние не видели бы разрыва и не успевали бы уйти в паузу.
   */
  const счётчик = собратьСчётчик(type, config)
  if (type === 'barrier') return счётчик

  const gate = createGateState(config)
  let усыпить = false
  /** Метки годных кадров за последнюю секунду — из них и считается частота. */
  const кадры = []
  let частота = null

  return {
    ...счётчик,
    /**
     * Частота дописывается ЗДЕСЬ, а не внутри счётчика: счётчик про движение, а
     * не про камеру, и знать о кадрах ему незачем. У приседа частота уже своя,
     * посчитанная по самому повтору (см. squat.js), — её не трогаем.
     */
    attempts() {
      return счётчик.attempts().map((a) => (a.fps === undefined ? { ...a, fps: частота } : a))
    },
    flush() {
      return счётчик.flush().map((a) => (a.fps === undefined ? { ...a, fps: частота } : a))
    },
    update(clockMs, frame = {}) {
      const check = checkFrame(frame.landmarks, config)
      const g = gate.update(check, clockMs)
      /** Что показал гейт на последнем кадре — для журнала повтора. */
      this.gate = g
      this.check = check

      /**
       * Пауза — человек ушёл или встал не так. Детектор надо сбросить целиком:
       * иначе фаза, начатая до ухода, встретится с фазой после возврата и
       * сложится в повтор, которого не было.
       */
      if (g.paused) {
        if (!усыпить) {
          усыпить = true
          счётчик.reset()
        }
        return 0
      }
      усыпить = false

      // Кадр негоден, но пауза ещё не набежала: кадр пропускаем, накопленное
      // не трогаем — ровно как в приседе (см. squat.js).
      if (!g.usable) return 0

      /**
       * ЧАСТОТА ГОДНЫХ КАДРОВ — по последней секунде.
       *
       * Присед кладёт в повтор своё число измерений сам (см. squat.js), а у
       * остальных движений повтор — это мгновенное событие, и «измерений
       * внутри» у него нет. Общее у обоих одно: на какой частоте судили. Без
       * неё зачёт на пяти кадрах в секунду и на тридцати неразличимы в журнале.
       */
      кадры.push(clockMs)
      while (кадры.length && clockMs - кадры[0] > 1000) кадры.shift()
      частота = кадры.length > 1 ? кадры.length : null

      return счётчик.update(clockMs, frame)
    },
    reset() {
      gate.reset()
      усыпить = false
      счётчик.reset()
    },
  }
}

/** Сам счётчик, без ворот. Обёртку ставит createRepCounter выше. */
function собратьСчётчик(type, config = {}) {
  let attempts = createAttempts(type)
  const shared = {
    attempts: () => attempts.take(),
    /** Закрыть незавершённую попытку — блок зовёт это на своём последнем кадре. */
    flush() {
      if (attempts.pending) attempts.close(false, { why: 'блок кончился' })
      return attempts.take()
    },
  }

  if (type === 'barrier') {
    // присед считает тот же трекер, что и обычный подход: он для этого и сделан,
    // и пороги ему нужны те же — личные, а не заводские
    let tracker = createSquatTracker(config)
    return {
      ...shared,
      update(clockMs, { landmarks, worldLandmarks } = {}) {
        const out = tracker.update(landmarks, clockMs, worldLandmarks)
        const event = out?.event
        if (!event) return 0
        /**
         * У приседа попытка — это ЗАКРЫТЫЙ ЦИКЛ, и трекер отдаёт по нему всё
         * сразу: минимум, размах, планку и режим замера. Ничего копить не надо.
         */
        attempts.close(event.kind === 'rep', {
          metric: Number(event.minAngle.toFixed(1)),
          bar: event.bar,
          amp: event.amplitude,
          // по колену мерили или по тазу — от этого зависит вся трактовка
          mode: event.fallback ? 'таз' : 'колено',
          // сколько измерений легло в повтор и какая при этом была частота:
          // повтор из двух кадров и повтор из четырнадцати выглядели одинаково
          samples: event.samples ?? null,
          fps: event.fps ?? null,
          why: event.reason ?? null,
        })
        /**
         * ПОВТОР — ТОЛЬКО СОСТОЯВШИЙСЯ. Раньше здесь считалось любое событие, а
         * событий у трекера три вида, и два из них — отказы: мелкий подсед и
         * слишком быстрый цикл шли в зачёт наравне с честным приседом.
         */
        return event.kind === 'rep' ? 1 : 0
      },
      reset() {
        // те же пороги и после сброса: подход второй, человек тот же
        tracker = createSquatTracker(config)
        attempts = createAttempts(type)
      },
    }
  }

  if (type === 'pit') {
    let watcher = createJumpWatcher()
    return {
      ...shared,
      update(clockMs, { landmarks } = {}) {
        const vertical = readVertical(landmarks)
        const done = watcher.update(clockMs, vertical)
        attempts.see(watcher.feetLift)
        if (done) attempts.close(true)
        return done ? 1 : 0
      },
      reset() {
        watcher = createJumpWatcher()
        attempts = createAttempts(type)
      },
    }
  }

  if (type === 'lunge') {
    let watcher = createLegWatchers()
    return {
      ...shared,
      update(clockMs, { landmarks, worldLandmarks } = {}) {
        const legs = readLegs(landmarks, worldLandmarks)
        const events = watcher.update(clockMs, legs)
        // лучшая из двух ног: блок сторон не различает
        attempts.see(bestOf(legs.ankleBack))
        const done = events.filter((e) => e.movement === 'lunge').length
        for (let i = 0; i < done; i += 1) attempts.close(true)
        return done
      },
      reset() {
        watcher = createLegWatchers()
        attempts = createAttempts(type)
      },
    }
  }

  // остальные четыре — девять новых движений одним автоматом
  let watcher = createMoveWatchers()
  return {
    ...shared,
    update(clockMs, { landmarks } = {}) {
      const events = watcher.update(clockMs, readMoves(landmarks))
      const metrics = watcher.metrics
      attempts.see(
        Math.max(
          moveMetric(type, 'left', metrics) ?? -Infinity,
          moveMetric(type, 'right', metrics) ?? -Infinity,
        ),
      )
      const done = events.filter((e) => e.movement === type).length
      for (let i = 0; i < done; i += 1) attempts.close(true)
      return done
    },
    reset() {
      watcher = createMoveWatchers()
      attempts = createAttempts(type)
    },
  }
}

/** Лучшее из двух: неизвестная сторона не считается нулём. */
function bestOf(pair) {
  const values = [pair?.left, pair?.right].filter((v) => v != null && Number.isFinite(v))
  return values.length ? Math.max(...values) : null
}
