/**
 * Детекторы двух «ножных» движений из ТЗ: ВЫПАД НАЗАД и ЗАХЛЁСТ ГОЛЕНИ.
 *
 * Пороги сняты с размеченной записи
 * `recordings/calibration-lunge-heel-20260813.json` (2570 кадров, 20.6 fps,
 * 4 сегмента: выпад правой 5, выпад левой 5, захлёст правой 5, захлёст левой 5)
 * и проверены прогоном против трёх старых записей — калибровки пяти движений,
 * игрового раунда на Android и синтетического образца, где ни того, ни другого
 * движения нет вовсе. Менять их без нового прогона `tools/replay-game.mjs`
 * нельзя: именно так этот проект дважды терял по несколько часов на правках
 * «на глаз».
 *
 * ЧЕМ ЭТИ ДВА ПОХОЖИ И ЧЕМ РАЗЛИЧАЮТСЯ. И там, и там одна нога уходит назад, и
 * по кадру это почти одно и то же: голень сзади, стопа не на месте. Развести их
 * можно только по двум вещам сразу — по ГЛУБИНЕ и по ТАЗУ.
 *
 * Глубина. В выпаде стопа уезжает НАЗАД, от камеры: в мировых точках её z
 * становится заметно больше, чем у второй стопы. В захлёсте стопа идёт ВВЕРХ, к
 * ягодице, оставаясь примерно над своим местом, и разница по z остаётся мелкой.
 *
 * Таз. В выпаде человек ОПУСКАЕТСЯ: таз уходит вниз почти как в приседе. В
 * захлёсте таз стоит на месте — работает только голень. Высота таза меряется от
 * его собственной медианы за HIP_WINDOW_MS: «пол» в кадре не виден, а медиана за
 * четыре секунды и есть рост человека в его обычной стойке.
 *
 * Отсюда и перекрёстные запреты в порогах: у выпада нижняя граница по глубине и
 * по опусканию таза, у захлёста — верхняя по обоим. Без них запись выпадов
 * давала захлёсты, а низкий захлёст с приседанием — выпады.
 *
 * НО ОСНОВНАЯ РАЗВОДКА — ТАЗ, А НЕ ГЛУБИНА, и полевой лог 14 августа это
 * доказал: у промахов захлёста глубина доходила до 0.43–0.56 при тогдашнем
 * ограничителе 0.38, то есть запрет «стопа не ушла назад» резал само движение.
 * Так и должно было выйти — стопа, идущая к ягодице, уезжает от камеры и без
 * всякого выпада (на записи до 0.48). Верхняя граница по глубине поэтому
 * поднята до 0.65 и работает грубым предохранителем, а разводит два движения
 * таз: в настоящем захлёсте он не двигается вовсе (по полю 0.01–0.05), в выпаде
 * проседает сразу и по устройству движения.
 *
 * ГЛУБИНА МЕРЯЕТСЯ В ДОЛЯХ СОБСТВЕННОЙ НОГИ, а не в метрах. В метрах один и тот
 * же выпад у высокого и у низкого человека даёт разные числа, и общий порог
 * оказывается для одного лёгким, а для другого недостижимым. Длина ноги
 * (бедро + голень по мировым точкам, среднее по двум ногам) — это мера самого
 * человека, и после деления на неё выпады всех людей ложатся в один диапазон:
 * по записям 0.79–0.94 доли ноги, ближайшее чужое срабатывание (захлёст) 0.32,
 * а на трёх старых записях ничто не поднимается выше 0.42.
 *
 * ДВА ПУТИ, И ВТОРОЙ БЕЗ 3D. Фронтальная камера глубину не измеряет, а лишь
 * ОЦЕНИВАЕТ: мировые точки MediaPipe — это догадка модели о том, как человек
 * стоит, и на слабом устройстве её может не быть вовсе. Поэтому у выпада есть
 * запасной признак, который живёт целиком в плоскости кадра, — УКОРОЧЕНИЕ
 * ГОЛЕНИ. Нога, ушедшая назад, направлена в камеру, и на плоской картинке её
 * голень коротка; вторая нога стоит боком к камере и остаётся длинной. Отношение
 * одной к другой и есть признак: по записям в выпаде 0.13–0.19, в захлёсте
 * 0.15–0.21, а в любом другом движении не ниже 0.43.
 *
 * Условие выпада поэтому такое: (глубина ИЛИ укорочение голени) И просадка таза.
 * На телефоне с рабочей оценкой глубины судим по ней, на телефоне без неё — по
 * кадру. Проверено прогоном: с обоими путями цифры на записи те же, а с
 * НАЦЕЛО отключённой глубиной выпад по-прежнему находится 5 из 5 на каждую
 * сторону.
 *
 * ПЛАТА ЗА ВТОРОЙ ПУТЬ, КОТОРОЙ БОЛЬШЕ НЕТ. Укорочение голени выпад от захлёста
 * НЕ отличает — значения у них почти одинаковые, — и разводит их только просадка
 * таза. Пока защитой захлёста служила глубина, это стоило дорого: без мировых
 * точек `backMaxK` не работает вовсе, и замер давал 4 ложных захлёста в
 * сегментах выпада против 1 с мировыми точками. После того как защитой стал таз
 * (dropMaxK 0.08), разницы между двумя путями не осталось: на
 * calibration-lunge-heel-20260813.json и с мировыми точками, и с НАЦЕЛО
 * отключёнными — 20 повторов из 20 и одно ложное срабатывание.
 *
 * ОДИН ПОТЕРЯННЫЙ КАДР НЕ УБИВАЕТ ЗАЧЁТ. Полевой лог 14 августа: захлёст
 * засчитался при выдержке 350 и 351 мс против порога 350, выпад — при 151 и 180
 * против 150. Оба прошли с запасом ровно в один кадр, то есть любое дрожание
 * признака между кадрами обнуляло накопленное и убивало зачёт: вчерашние 0 из 6
 * у захлёста и сегодняшние пять попыток на один мах ногой — про это. Поэтому
 * сорвавшееся условие обнуляет выдержку НЕ СРАЗУ, а только если срыв длится
 * дольше HOLD_GRACE_MS. Пороги при этом не тронуты: 350 мс у захлёста отделяют
 * его от начала выпада, и это замерено по записи, а не поставлено на глаз.
 *
 * ЧТО ЭТО ДАЛО И ЧЕГО СТОИЛО, по calibration-lunge-heel-20260813.json. Захлёст
 * правой: было 3 повтора из 5, стало 5 из 5 — три раза подряд его убивал ровно
 * один провалившийся кадр (на 34969 мс подъём стопы дрогнул до 0.39 при планке
 * 0.45 и вернулся к 0.57 через 50 мс). Плата — один лишний ложный захлёст в
 * сегменте выпадов правой, 4 чужих срабатывания вместо 3 на 5 выпадов: это та
 * же дырка в один кадр, только на подъёме в выпад, где таз ещё не просел
 * (drop 0.05 при планке 0.08), а нога ещё не уехала назад (back 0.32 при 0.65).
 * Ни один из двух порогов его не ловит, и это честная цена. Обмен сознательный:
 * пропущенный повтор человек видит и переделывает, а лишнее срабатывание в чужом
 * сегменте зачёта не даёт — препятствия судятся по своему типу.
 *
 * ЧТО БУДЕТ, ЕСЛИ МИРОВЫХ ТОЧЕК НЕТ. Тогда `ankleBack` — null, а не ноль. Ноль
 * здесь означал бы «стопы стоят рядом», то есть «это точно не выпад, а
 * захлёст», и всякий выпад на устройстве без мировых точек молча превращался бы
 * в захлёст. null означает «неизвестно»: судим по укорочению голени, а захлёст
 * остаётся без своей страховки по глубине.
 */

import { LM } from '../pose/landmarks.js'
import { createPace } from './pace.js'

export const MIN_VISIBILITY = 0.5

export const SIDE = { LEFT: 'left', RIGHT: 'right' }

const ANKLE = { left: LM.LEFT_ANKLE, right: LM.RIGHT_ANKLE }
const KNEE = { left: LM.LEFT_KNEE, right: LM.RIGHT_KNEE }
const HIP = { left: LM.LEFT_HIP, right: LM.RIGHT_HIP }

const dist3 = (a, b) =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)) : null
const dist2 = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null)

/**
 * Длина ноги по мировым точкам: бедро плюс голень, среднее по двум ногам.
 *
 * Это мера самого человека, и глубина делится на неё, чтобы один и тот же выпад
 * у высокого и у низкого давал одно и то же число. Среднее по двум ногам, а не
 * по одной: у ноги, ушедшей назад, модель оценивает длину хуже — она дальше от
 * камеры и частью перекрыта.
 */
function legLengthOf(world) {
  const lengths = []
  for (const side of ['left', 'right']) {
    const thigh = dist3(world[HIP[side]], world[KNEE[side]])
    const shin = dist3(world[KNEE[side]], world[ANKLE[side]])
    if (thigh > 0 && shin > 0) lengths.push(thigh + shin)
  }
  if (!lengths.length) return null
  return lengths.reduce((sum, v) => sum + v, 0) / lengths.length
}

/**
 * За сколько считается медиана «таз в обычной стойке». Четыре секунды — это
 * несколько повторов подряд: одиночный выпад медиану не утащит, а смена стойки
 * между сегментами в неё уложится.
 */
export const HIP_WINDOW_MS = 4000

/**
 * Сколько условие может побыть невыполненным, не обнуляя накопленную выдержку.
 * Один кадр на 20 fps — это 50 мс, и 120 мс дают запас ещё на один: столько
 * стоит потерянный кадр, но заметно меньше любого настоящего возврата в стойку.
 *
 * Это НЕ послабление порога: держать движение всё так же надо holdMs, просто
 * дырка в один кадр посреди выдержки больше не считается за «начал заново».
 */
export const HOLD_GRACE_MS = 120

export const DEFAULT_LUNGE = {
  /**
   * Насколько стопа должна уйти назад от второй, В ДОЛЯХ СОБСТВЕННОЙ НОГИ.
   * Замер: настоящие выпады 0.79–0.94, ближайшее чужое (захлёст) 0.32, на трёх
   * старых записях ничто не выше 0.42. Порог стоит в разрыве между ними.
   */
  backK: 0.55,
  /** И насколько при этом должен опуститься таз, в длинах корпуса. */
  dropK: 0.3,
  /**
   * Запасной путь без 3D: укорочение голени в кадре, отношение своей голени к
   * чужой. Меньше порога — нога направлена в камеру, то есть ушла назад. Замер:
   * выпад 0.13–0.19, захлёст 0.15–0.21, любое другое движение не ниже 0.43.
   * Захлёст этим признаком НЕ отсекается — его отсекает просадка таза.
   */
  shinK: 0.4,
  /** Столько условие держится подряд, чтобы это был выпад, а не проход мимо. */
  holdMs: 150,
  /** Ниже этого выпад считается законченным и разрешается следующий. */
  exitBackK: 0.28,
  /** Один выпад — одно событие: возврат из него занимает несколько кадров. */
  refractoryMs: 800,
}

export const DEFAULT_HEEL = {
  /** Насколько стопа должна уйти вверх относительно второй, в корпусах. */
  footK: 0.45,
  /**
   * Колено при этом остаётся внизу. Захлёст и подъём колена — соседи по
   * ошибкам: в обоих одна стопа высоко. Различает их именно колено — в захлёсте
   * оно почти не уходит вперёд-вверх и остаётся ниже линии таза.
   */
  kneeMaxK: -0.3,
  /**
   * И таз стоит: в захлёсте не приседают.
   *
   * Это и есть ГЛАВНАЯ защита от выпада, а не глубина. По полевому логу
   * 14 августа heelDrop у всех настоящих захлёстов 0.01–0.05: таз в захлёсте не
   * трогается вовсе — работает одна голень. Выпад же проседает сразу и по
   * устройству движения, поэтому планка в 0.08 разводит их надёжнее, чем
   * глубина (см. backMaxK), и стоит в разрыве между 0.05 и просадкой выпада.
   */
  dropMaxK: 0.08,
  /**
   * И стопа не уехала назад по глубине — иначе это выпад. В долях ноги, как и
   * порог самого выпада. Без мировых точек эта защита не работает вовсе, и
   * захлёст изредка срабатывает в начале выпада — см. заголовок модуля.
   *
   * БЫЛО 0.38, И ЭТО ЧИСЛО РЕЗАЛО САМО ДВИЖЕНИЕ. Полевой лог 14 августа: у
   * промахов захлёста heelBack 0.43–0.56 при ограничителе 0.38 — то есть
   * защита от выпада отбивала честные захлёсты. Так и должно было выйти: сам
   * захлёст на записи доходит по глубине до 0.48, потому что стопа, идущая к
   * ягодице, уходит от камеры и без всякого выпада. 0.65 оставляет ей этот
   * ход, а разводит два движения теперь таз (dropMaxK), где разрыв настоящий.
   */
  backMaxK: 0.65,
  /** Захлёст держат дольше, чем проходят через похожую фазу выпада. */
  holdMs: 350,
  /** Ниже этого захлёст считается законченным. */
  exitFootK: 0.3,
  refractoryMs: 700,
}

const visible = (point, minVisibility = MIN_VISIBILITY) => {
  if (!point || typeof point.y !== 'number') return false
  return point.visibility == null || point.visibility >= minVisibility
}

const EMPTY = () => ({
  hipY: null,
  torso: null,
  ankleDy: { left: null, right: null },
  kneeLift: { left: null, right: null },
  ankleBack: { left: null, right: null },
  shin: { left: null, right: null },
})

/**
 * Всё, что нужно этим двум детекторам от кадра. Экран читает это один раз и
 * кладёт в позу раунда: движок судит по признакам, а не по сырым точкам — так
 * же, как он уже делает с углом колена и выносом руки.
 *
 * @param {Array} landmarks точки кадра
 * @param {Array} worldLandmarks мировые точки — только из них берётся глубина
 */
export function readLegs(landmarks, worldLandmarks, minVisibility = MIN_VISIBILITY) {
  const out = EMPTY()
  if (!landmarks || landmarks.length < 33) return out

  const ls = landmarks[LM.LEFT_SHOULDER]
  const rs = landmarks[LM.RIGHT_SHOULDER]
  const lh = landmarks[LM.LEFT_HIP]
  const rh = landmarks[LM.RIGHT_HIP]
  // без плеч или таза нет ни высоты таза, ни меры роста в кадре: делить не на
  // что, и все признаки остаются неизвестными
  if (![ls, rs, lh, rh].every((p) => visible(p, minVisibility))) return out

  const shoulderY = (ls.y + rs.y) / 2
  const hipY = (lh.y + rh.y) / 2
  const torso = Math.abs(hipY - shoulderY)
  if (!torso) return out

  out.hipY = hipY
  out.torso = torso

  for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
    const knee = landmarks[KNEE[side]]
    // плюс — колено выше линии таза
    if (visible(knee, minVisibility)) out.kneeLift[side] = (hipY - knee.y) / torso
  }

  // высота стопы считается ОТНОСИТЕЛЬНО второй стопы, а не от пола: пола в
  // кадре не видно. Поэтому нужны обе — по одной ноге поднятость не измерить
  const left = landmarks[ANKLE.left]
  const right = landmarks[ANKLE.right]
  if (visible(left, minVisibility) && visible(right, minVisibility)) {
    for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
      const own = side === SIDE.LEFT ? left : right
      const other = side === SIDE.LEFT ? right : left
      out.ankleDy[side] = (other.y - own.y) / torso
    }
  }

  // Укорочение голени — целиком по кадру, без всякого 3D. Нога, ушедшая назад,
  // направлена в камеру и на плоской картинке коротка; вторая стоит боком и
  // остаётся длинной. Это запасной путь выпада на устройствах без глубины.
  const shinLeft = dist2(landmarks[KNEE.left], landmarks[ANKLE.left])
  const shinRight = dist2(landmarks[KNEE.right], landmarks[ANKLE.right])
  const shinSeen = (side) =>
    visible(landmarks[KNEE[side]], minVisibility) && visible(landmarks[ANKLE[side]], minVisibility)
  if (shinSeen(SIDE.LEFT) && shinSeen(SIDE.RIGHT) && shinLeft > 0 && shinRight > 0) {
    out.shin.left = shinLeft / shinRight
    out.shin.right = shinRight / shinLeft
  }

  // Глубина — только из мировых точек, и только их: в кадре ухода ноги назад
  // почти не видно. Нет мировых — null, а не ноль (см. заголовок модуля).
  const world = worldLandmarks?.length >= 33 ? worldLandmarks : null
  if (world) {
    const wl = world[ANKLE.left]
    const wr = world[ANKLE.right]
    // делим на длину ноги: в метрах один и тот же выпад у высокого и у низкого
    // даёт разные числа, и общий порог одному лёгок, а другому недостижим
    const leg = legLengthOf(world)
    if (typeof wl?.z === 'number' && typeof wr?.z === 'number' && leg > 0) {
      // z тем больше, чем дальше точка от камеры: нога, ушедшая назад, даёт плюс
      out.ankleBack.left = (wl.z - wr.z) / leg
      out.ankleBack.right = (wr.z - wl.z) / leg
    }
  }

  return out
}

/** Медиана по списку. Именно она, а не среднее: один выброс её не сдвигает. */
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Состояние одного движения на одной стороне. */
const newState = () => ({ since: null, lastOkAt: null, fired: false, lastAt: null })

/**
 * Условие в этом кадре не выполнено. Выдержка обнуляется НЕ СРАЗУ: пропажа
 * короче graceMs — это потерянный кадр, а не конец движения (см. заголовок
 * модуля). Пока идёт эта фора, состояние не трогается вовсе — иначе снятый
 * флаг `fired` выдал бы второе событие на ту же выдержку.
 */
function loosen(own, nowMs, graceMs) {
  if (own.since != null && own.lastOkAt != null && nowMs - own.lastOkAt <= graceMs) return
  own.since = null
  own.lastOkAt = null
}

/**
 * Диагностика одной стороны: сколько условие держится ПРЯМО СЕЙЧАС и что именно
 * мешает в этом кадре.
 *
 * Зачем отдельно от событий. Захлёст требует ЧЕТЫРЁХ условий сразу и подряд
 * 350 мс. Пики каждого признака за окно этого не раскрывают: все четыре могут
 * побывать в норме порознь и ни разу не сойтись в один кадр. В поле 13 августа
 * так и вышло — подъём стопы втрое выше планки, а зачёта нет, и по логу нельзя
 * было понять, чего не хватило. Мерить надо выдержку, а не пики.
 *
 * На судейство это не влияет: ни одна проверка отсюда не читается.
 */
const newProbe = () => ({ heldMs: 0, block: 'pose' })

/**
 * Выпад назад и захлёст голени — одним автоматом на оба движения и обе стороны.
 *
 * Разделять их незачем: оба живут на одних и тех же признаках, у обоих одна и
 * та же опора — высота таза за окно, и главное, они друг друга ИСКЛЮЧАЮТ. Два
 * независимых автомата пришлось бы связывать снаружи, и связь эта разъезжалась
 * бы при каждой правке порогов.
 *
 * @param {{lunge?: object, heel?: object, minVisibility?: number}} overrides
 */
export function createLegWatchers(overrides = {}) {
  const config = {
    lunge: { ...DEFAULT_LUNGE, ...(overrides.lunge ?? {}) },
    heel: { ...DEFAULT_HEEL, ...(overrides.heel ?? {}) },
    hipWindowMs: overrides.hipWindowMs ?? HIP_WINDOW_MS,
    holdGraceMs: overrides.holdGraceMs ?? HOLD_GRACE_MS,
    minVisibility: overrides.minVisibility ?? MIN_VISIBILITY,
  }
  /** Запас на дрогнувший замер берётся от наблюдаемого темпа съёмки. */
  const pace = createPace(config.holdGraceMs)
  /** Высота таза за окно: по её медиане считается, насколько человек присел. */
  const hips = []
  const state = {
    lunge: { left: newState(), right: newState() },
    heel: { left: newState(), right: newState() },
  }

  return {
    config,
    /** Насколько таз ниже своей медианы, в корпусах. Наружу — для разбора записей. */
    drop: null,
    /**
     * Живая диагностика по каждой стороне: heldMs — сколько условие держится
     * подряд прямо сейчас (0, если в этом кадре не выполнено), block — какое
     * именно условие мешает ('foot' | 'knee' | 'drop' | 'back' у захлёста,
     * 'depth' | 'drop' у выпада, 'pose' — судить не по чему, null — всё
     * выполнено). Только для разбора: судейство её не читает.
     */
    heel: { left: newProbe(), right: newProbe() },
    lunge: { left: newProbe(), right: newProbe() },

    /**
     * @param {number} nowMs
     * @param {Array|object} source точки кадра или уже прочитанные признаки (readLegs)
     * @param {Array} [worldLandmarks] мировые точки — нужны, только если source это кадр
     * @returns {Array<object>} события этого кадра (обычно пустой массив)
     */
    update(nowMs, source, worldLandmarks) {
      const graceMs = pace.see(nowMs)
      this.stepMs = pace.stepMs
      this.graceMs = graceMs
      this.drop = null

      // разбор записей кормит детектор точками, игра — признаками из позы:
      // считать одно и то же дважды незачем, а расходиться им нельзя
      const frame = Array.isArray(source)
        ? readLegs(source, worldLandmarks, config.minVisibility)
        : source || {}
      const { hipY, torso } = frame
      if (hipY == null || !torso) {
        // судить не по чему — так и говорим, а не молчим прошлым состоянием
        for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
          this.heel[side] = newProbe()
          this.lunge[side] = newProbe()
        }
        return []
      }

      hips.push({ t: nowMs, y: hipY })
      while (hips.length && nowMs - hips[0].t > config.hipWindowMs) hips.shift()
      const home = median(hips.map((h) => h.y))
      // плюс — таз НИЖЕ обычного: в кадре y растёт вниз
      const drop = (hipY - home) / torso
      this.drop = drop

      const events = []

      for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
        const back = frame.ankleBack?.[side] ?? null
        const dy = frame.ankleDy?.[side] ?? null
        const kneeLift = frame.kneeLift?.[side] ?? null
        const shin = frame.shin?.[side] ?? null

        // --- выпад назад: нога ушла назад, и человек опустился ---
        // Ногу назад видно двумя способами: по глубине из мировых точек и по
        // укорочению голени в кадре. Хватает любого — на телефоне без рабочей
        // оценки глубины работает второй. Просадка таза нужна в обоих случаях:
        // она и есть то, что отличает выпад от захлёста.
        const lunge = state.lunge[side]
        const legBack =
          (back != null && back >= config.lunge.backK) ||
          (shin != null && shin <= config.lunge.shinK)
        // выпад закончен, только когда НИ ОДИН из путей больше его не видит:
        // сбрасывать флаг по одной глубине значило бы выдавать по нескольку
        // событий на один выпад там, где глубины нет вовсе
        const backHome = back == null || back < config.lunge.exitBackK
        const shinHome = shin == null || shin > config.lunge.shinK
        if (backHome && shinHome) lunge.fired = false

        // ровно те же два условия, что и в проверке ниже, — только названные
        this.lunge[side] = {
          heldMs: 0,
          block: !legBack ? 'depth' : drop < config.lunge.dropK ? 'drop' : null,
        }

        if (!legBack || drop < config.lunge.dropK) {
          loosen(lunge, nowMs, graceMs)
        } else {
          if (lunge.since == null) lunge.since = nowMs
          lunge.lastOkAt = nowMs
          const held = nowMs - lunge.since
          this.lunge[side].heldMs = held
          const cool = lunge.lastAt != null && nowMs - lunge.lastAt < config.lunge.refractoryMs
          if (!lunge.fired && held >= config.lunge.holdMs && !cool) {
            lunge.fired = true
            lunge.lastAt = nowMs
            events.push({
              movement: 'lunge',
              side,
              at: nowMs,
              holdMs: Math.round(held),
              back,
              shin,
              drop,
            })
          }
        }

        // --- захлёст голени: стопа вверх, колено внизу, таз на месте ---
        const heel = state.heel[side]
        if (dy == null || dy < config.heel.exitFootK) heel.fired = false

        // Четыре условия захлёста, названные порознь. Логика ровно та же, что
        // была одним выражением: собрана из тех же сравнений в том же порядке.
        // Разбито потому, что «не сошлось» без указания, ЧТО не сошлось, в поле
        // ничего не говорит.
        const footOk = dy != null && dy >= config.heel.footK
        const kneeOk = kneeLift != null && kneeLift <= config.heel.kneeMaxK
        const dropOk = drop <= config.heel.dropMaxK
        const deepEnough = back == null || back < config.heel.backMaxK
        const held = footOk && kneeOk && dropOk && deepEnough

        this.heel[side] = {
          heldMs: 0,
          block: !footOk ? 'foot' : !kneeOk ? 'knee' : !dropOk ? 'drop' : !deepEnough ? 'back' : null,
        }

        if (!held) {
          loosen(heel, nowMs, graceMs)
        } else {
          if (heel.since == null) heel.since = nowMs
          heel.lastOkAt = nowMs
          const heldMs = nowMs - heel.since
          this.heel[side].heldMs = heldMs
          const cool = heel.lastAt != null && nowMs - heel.lastAt < config.heel.refractoryMs
          if (!heel.fired && heldMs >= config.heel.holdMs && !cool) {
            heel.fired = true
            heel.lastAt = nowMs
            events.push({
              movement: 'heel',
              side,
              at: nowMs,
              holdMs: Math.round(heldMs),
              lift: dy,
              kneeLift,
            })
          }
        }
      }

      return events
    },

    reset() {
      hips.length = 0
      this.drop = null
      for (const movement of ['lunge', 'heel']) {
        for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
          state[movement][side] = newState()
          this[movement][side] = newProbe()
        }
      }
    },
  }
}
