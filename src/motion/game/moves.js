/**
 * Детекторы девяти движений сверх ТЗ: НАКЛОН ВПЕРЁД, ПРИСЕД С ПРЫЖКОМ,
 * ДЖАМПИНГ-ДЖЕК, ПРЫЖОК НОГИ ВРОЗЬ, БОКОВОЙ МАХ НОГОЙ, БОКОВОЙ ВЫПАД,
 * РАЗВЕДЕНИЕ РУК, ХЛОПОК НАД ГОЛОВОЙ и СКРУЧИВАНИЕ С КОЛЕНОМ.
 *
 * Пороги сняты с размеченных записей `recordings/calibration-new9-20260813.json`
 * и `recordings/calibration-crunch-20260813.json` и проверены прогоном по
 * шести записям: в своих сегментах детекторы дают ровно столько повторов,
 * сколько просили, а на четырёх старых записях (калибровка пяти движений, мах с
 * прыжком, выпад с захлёстом и игровой раунд на Android) ни один из девяти не
 * срабатывает ни разу. Менять числа без нового прогона `tools/replay-game.mjs`
 * нельзя: именно так этот проект дважды терял по несколько часов на правках
 * «на глаз».
 *
 * ОБЩАЯ ОПОРА. Все меры нормированы, и нормировщиков два: `ref` — медиана длины
 * корпуса за четыре секунды (рост человека на картинке) и `shW` — ширина плеч в
 * кадре (его же ширина). Делить на текущую длину корпуса нельзя: в наклоне
 * вперёд она падает почти до нуля, и всё, что на неё делится, взрывается — см.
 * ниже про предохранитель. Медиана за четыре секунды переживает и наклон, и
 * присед: это несколько повторов подряд, один из них её не утащит.
 *
 * ЧЕМ ЭТИ ДЕВЯТЬ ОТЛИЧАЮТСЯ ДРУГ ОТ ДРУГА И ОТ СТАРЫХ ПЯТИ. Пары, которые по
 * кадру почти неразличимы, и число, которым они разведены:
 *
 *   ДЖЕК и ПРЫЖОК НОГИ ВРОЗЬ. Ноги в обоих уходят в стороны одинаково, и
 *     развести их можно ТОЛЬКО по рукам: в джеке обе руки над головой
 *     (raise >= 0.20), в прыжке врозь обе внизу (raise < 0). Между этими двумя
 *     множествами нет ничего: рука либо над носом, либо под ним.
 *
 *   ПРЫЖОК НОГИ ВРОЗЬ и БОКОВОЙ МАХ НОГОЙ. И там, и там стопа уходит вбок. Но
 *     врозь уходят ОБЕ (min(ankleOut) >= 0.85), а в махе одна, и уходит она
 *     втрое дальше — 2.20 ширины плеч от таза против 0.85.
 *
 *   БОКОВОЙ ВЫПАД и ШАГ В СТОРОНУ. Таз в обоих уезжает вбок ровно так же.
 *     Отличает их ТОЛЬКО просадка: в выпаде человек опускается на ногу
 *     (drop >= 0.25), в шаге остаётся на своей высоте.
 *
 *   БОКОВОЙ МАХ НОГОЙ и ПОДЪЁМ КОЛЕНА. В махе нога идёт вбок ПРЯМОЙ, колено не
 *     поднимается (kneeLift < 0.30); в подъёме колена оно и есть движение.
 *
 *   НАКЛОН ВПЕРЁД и ПРИСЕД. Оба складывают человека вниз, и по одной высоте
 *     таза они неразличимы. Отличает их корпус: в наклоне плечи доходят до
 *     линии таза (fold <= 0.30), в приседе корпус стоит прямо. Второе условие
 *     наклона — руки НИЖЕ КОЛЕН (belowKnee >= 0.50): в глубоком приседе корпус
 *     тоже кое-как складывается, а руки к полу не идут.
 *
 *   ПРИСЕД С ПРЫЖКОМ и ПРИСЕД, и он же и ПРЫЖОК. Это не поза, а
 *     ПОСЛЕДОВАТЕЛЬНОСТЬ: сначала просадка (drop >= 0.50), потом, не позже чем
 *     через 1500 мс, обе стопы над своей медианой на 0.10 роста. Порознь ни то,
 *     ни другое приседом с прыжком не является.
 *
 *   РАЗВЕДЕНИЕ РУК и ХЛОПОК. Руки в стороны — это широко разведённые кисти
 *     (wristOut >= 1.10 ширины плеч) НИЖЕ носа; хлопок — сведённые кисти
 *     (wristGap <= 0.55) ВЫШЕ носа. Взмах к хлопку проходит через развод, и
 *     поэтому у развода выдержка вдвое длиннее общей — 400 мс: с 200 мс замах
 *     хлопка успевал зачесться разведением рук.
 *
 *   СКРУЧИВАНИЕ С КОЛЕНОМ и ПОДЪЁМ КОЛЕНА. Колено в скручивании поднимается так
 *     же (kneeLift >= 0.20), и разводит их ВСТРЕЧНОЕ ДВИЖЕНИЕ РУКИ: локоть или
 *     кисть противоположной руки приходит к этому колену. В обычном подъёме
 *     колена руки остаются при себе.
 *
 * ДВА ЗАМЕРА ОДНОГО ДВИЖЕНИЯ, И ЭТО НЕ ПЕРЕСТРАХОВКА. Человеку говорят «тянись
 * ЛОКТЕМ» — только эта команда заставляет СКРУЧИВАТЬ корпус, а «дотянись рукой»
 * он выполняет одним махом руки. Но выполняют её люди ДВУМЯ РАЗНЫМИ МАНЕРАМИ, и
 * две записи показали это прямо:
 *
 *   calibration-crunch-20260813 (тянулся кистью): локоть не ближе 0.80, кисть
 *     0.14–0.31 — локоть к колену даже не двинулся;
 *   calibration-twist-20260814 (тянулся локтем):  локоть 0.10–0.46, кисть
 *     0.12–0.59 — кисть уходила мимо колена и в свою планку не укладывалась.
 *
 * По одному локтю первая запись даёт 0 повторов из 10, по одной кисти вторая —
 * 6 из 10. Правило «локоть ИЛИ кисть» находит все 10 на обеих, по 5 на каждую
 * сторону. Это не два порога на всякий случай, а два ЗАМЕРА одного движения:
 * какой из них сработает, зависит от того, как человек тянется. Планка локтя
 * при этом устойчива — 0.60, 0.65 и 0.70 дают на записях одно и то же.
 *
 * ПОЧЕМУ ОДНОЙ РУКИ МАЛО, КАКУЮ БЫ ТОЧКУ НИ МЕРИТЬ. На calibration-full в
 * сегменте обычного ПРИСЕДА локоть подходит к колену на 0.55, а кисть на
 * 0.45 — обе планки взяты, хотя никакого скручивания там нет и близко. Причина
 * простая: приседая, человек складывается, и руки оказываются у коленей сами
 * собой. Спасает только условие по ПОДНЯТОМУ КОЛЕНУ — в приседе колено к линии
 * таза не идёт вовсе (максимум -0.02 при планке 0.20). Выбросить его,
 * понадеявшись на «руку у колена», значит начать засчитывать приседы.
 *
 * ЧТО БЫЛО ДО СКРУЧИВАНИЯ. На этом месте стояла БОКОВАЯ СКЛАДКА (колено вверх
 * плюс завал линии плеч к нему), и её потолок в поле — 13 зачётов из 22, 59%.
 * Причина конструктивная, а не в порогах: подъём колена меряется ОТ ЛИНИИ ТАЗА,
 * а наклон корпуса эту линию заваливает, и два условия детектора отбирают друг
 * у друга запас — чем лучше человек делал складку, тем ниже измерялось его
 * колено. У скручивания такой связи нет: колено и встречная рука меряются
 * независимо друг от друга.
 *
 * ОДИН ПОТЕРЯННЫЙ КАДР НЕ УБИВАЕТ ЗАЧЁТ. Полевой лог 14 августа: у старых
 * движений выдержка проходила с запасом ровно в один кадр (захлёст 350 и 351 мс
 * против порога 350), то есть любое дрожание признака между кадрами обнуляло
 * накопленное. У этих девяти условий по два-четыре, и сойтись они должны
 * одновременно — дырка вероятнее вдвое. Поэтому сорвавшееся условие обнуляет
 * выдержку не сразу, а только если срыв длится дольше HOLD_GRACE_MS. Правило
 * одно на любой сбой: и на дрогнувший признак, и на кадр, где поза не читается
 * вовсе, — в глубоком наклоне модель теряет плечи и таз, и это стоило зачётов
 * (полевой лог 15 августа: выдержка 194 и 157 мс при пороге 200).
 *
 * ПРЕДОХРАНИТЕЛЬ НА СЛОЖЕННЫЙ КОРПУС. В наклоне вперёд длина корпуса В КАДРЕ
 * падает до 0.06 от обычной: плечи доходят до линии таза и уходят ниже. Всё,
 * что на неё делится, в этот момент взрывается — на записи это дало 10 ложных
 * ПРЫЖКОВ на наклонах, то есть наклоном вперёд можно было бы бесплатно
 * проходить ямы. Поэтому при fold < READABLE_FOLD поза считается НЕЧИТАЕМОЙ для
 * метрик, нормированных корпусом: прыжок, колено, птица и захлёст в этот момент
 * не судятся вовсе — их признаки отдаются как null, а не как число. Пороги при
 * этом не тронуты: чинить надо не планку, а деление на почти ноль.
 *
 * СТОРОНА — СТОРОНА ТЕЛА ЧЕЛОВЕКА, как и во всех остальных детекторах. В кадре
 * его правая сторона лежит в МЕНЬШИХ x (человек стоит лицом к камере), и отсюда
 * знак у смещения таза. У скручивания сторона — по ПОДНИМАЕМОМУ КОЛЕНУ, а рука
 * к нему идёт противоположная.
 */

import { LM } from '../pose/landmarks.js'
import { createPace } from './pace.js'

export const MIN_VISIBILITY = 0.5

export const SIDE = { LEFT: 'left', RIGHT: 'right' }

/**
 * За сколько считается опора: рост, дом и высота стоп в обычной стойке.
 * Четыре секунды — несколько повторов подряд: одно движение медиану не утащит,
 * а смена стойки между сегментами в неё уложится.
 */
export const WINDOW_MS = 4000

/**
 * Ниже этой доли роста корпус в кадре сложен, и метрики, нормированные им, не
 * значат ничего. Число одно на три применения: предохранитель снаружи (см.
 * заголовок), запрет ложного приседа с прыжком и запрет ложного бокового
 * выпада — оба они делаются со СТОЯЩИМ корпусом, и в наклоне их быть не может.
 */
export const READABLE_FOLD = 0.4

/**
 * Сколько условие может побыть невыполненным, не обнуляя накопленную выдержку.
 * Один кадр на 20 fps — это 50 мс, и 120 мс дают запас ещё на один: столько
 * стоит потерянный кадр, но заметно меньше любого настоящего возврата в стойку.
 *
 * Это НЕ послабление порога: держать движение всё так же надо holdMs, просто
 * дырка в один кадр посреди выдержки больше не считается за «начал заново».
 */
export const HOLD_GRACE_MS = 120

/** Движения, которые этот автомат умеет. Порядок — как в списке калибровки. */
export const MOVEMENTS = [
  'bend',
  'jumpsquat',
  'jack',
  'hop',
  'legside',
  'sidelunge',
  'wings',
  'clap',
  'twistknee',
]

/** У этих движений стороны нет по самому их устройству. */
export const SIDELESS = new Set(['bend', 'jumpsquat', 'jack', 'hop', 'wings', 'clap'])

export const DEFAULT_MOVES = {
  /** Столько условие держится подряд, чтобы это было движение, а не проход мимо. */
  holdMs: 200,
  /** Одно движение — одно событие: возврат в стойку занимает несколько кадров. */
  refractoryMs: 800,

  bend: {
    /** Корпус сложен: плечи дошли до линии таза. */
    foldMaxK: 0.3,
    /** И руки ушли ниже колен — в приседе они туда не идут. */
    belowKneeK: 0.5,
  },
  jumpsquat: {
    /** Сначала присед: таз ниже своей медианы на столько ростов. */
    dropK: 0.5,
    /**
     * Потом отрыв: обе стопы выше своей медианы на столько ростов.
     *
     * ОБЩАЯ ВЫДЕРЖКА ОТНОСИТСЯ К ПЕРВОЙ ПОЛОВИНЕ, а не ко второй. Присед — это
     * поза, и её человек держит; отрыв — мгновение, и требовать от него 200 мс
     * значило бы требовать зависнуть в воздухе на четыре кадра. Событие
     * отдаётся на первом же кадре отрыва после состоявшегося приседа.
     *
     * БЫЛО 0.10, И ЭТО РЕЗАЛО ЧЕСТНЫЕ ПРЫЖКИ. Полевой лог 15 августа: присед
     * 1.53 роста, выдержка 665 мс, отрыв 0.09 при планке 0.10 — человек присел
     * глубоко, выпрыгнул, и всё это не засчиталось из-за одной сотой. Отрыв
     * ловится в один кадр, и на 20 кадрах в секунду его пик почти всегда
     * приходится между кадрами: планка обязана стоять с запасом, а не впритык.
     *
     * Замер по записям: при 0.10 в своём сегменте 4 повтора из 5, при 0.07 —
     * все 5, и ни одного нового ложного срабатывания ни на одной из записей
     * (два известных остаются на наклоне вперёд и разобраны в
     * vertical.replay.test). Ниже 0.06 картина уже не меняется — порог стоит в
     * разрыве, а не на краю.
     */
    footLiftK: 0.07,
    /** И не позже, чем через столько после приседа, — иначе это два движения. */
    windowMs: 1500,
  },
  jack: {
    /** Обе стопы в стороны от таза, в ширинах плеч. */
    ankleOutK: 0.7,
    /** И обе кисти выше носа: этим джек и отличается от прыжка врозь. */
    raiseK: 0.2,
    /**
     * ДЖЕК СУДИТСЯ ПЕРЕСЕЧЕНИЕМ ПОРОГОВ, А НЕ ВЫДЕРЖКОЙ. Причина в замерах:
     * вершина джека держится 260–400 мс, а выдержка holdMs набирается только по
     * замерам, и на 7 поз/с (шаг 143 мс) для 200 мс нужны ТРИ замера подряд, то
     * есть вершина длиной 286–429 мс. На 23 поз/с хватает 218 мс. Полевой парный
     * тест: 10 повторов на Redmi против 17 на iPhone у одного человека.
     *
     * Здесь важно, что вершина БЫЛА, а не сколько раз в неё попал замер: хватает
     * одного замера выше порога. Ноги и руки засчитываются порознь и сводятся по
     * времени — на редкой съёмке они попадают в разные замеры.
     *
     * От двойного счёта защищает не рефрактерный период, а ВОЗВРАТ В СТОЙКУ:
     * пока ноги не сошлись обратно ниже ankleBackK, следующего повтора нет.
     * Это и есть гистерезис, и он не зависит от частоты замеров вовсе.
     */
    ankleBackK: 0.45,
    raiseBackK: 0,
    /** Насколько ноги врозь и руки вверх могут разъехаться по замерам. */
    pairWindowMs: 400,
    /**
     * И защита от сбойного замера, которую раньше давала сама выдержка: одного
     * замера теперь достаточно, значит одного мусорного тоже. Живой пример из
     * записи: человек уходит из кадра, видимость стоп падает с 0.95 до 0.25, и
     * ноги «разъезжаются» на 1.74 ширины плеч КАЖДАЯ от центра таза.
     *
     * Так ноги не разводятся. По всем девяти записям (16 295 замеров) 99.9%
     * значений лежат ниже 0.90 при пороге джека 0.7, и выше 1.0 набирается
     * четыре штуки — все в местах, где трекинг рассыпается. Потолок в 1.2
     * отсекает их и не трогает ни одного живого джека.
     *
     * Потолок, а не ограничение скорости: джек — прыжок, ноги в нём разлетаются
     * быстро, и запрещать резкое движение детектору прыжка было бы странно.
     */
    ankleOutMaxK: 1.2,
  },
  hop: {
    /** Ноги врозь шире, чем в джеке: там их разводит прыжок с руками. */
    ankleOutK: 0.85,
    /** И человек не приседает. */
    dropMaxK: 0.2,
    /** И обе кисти НИЖЕ носа — этим прыжок врозь и отличается от джека. */
    raiseMaxK: 0,
  },
  legside: {
    /** Стопа уходит вбок втрое дальше, чем в прыжке врозь. */
    ankleOutK: 2.2,
    /** Нога при этом прямая: колено не поднимается. */
    kneeMaxK: 0.3,
    /** И таз стоит: в махе не приседают. */
    dropMaxK: 0.2,
  },
  sidelunge: {
    /** Таз уехал в свою сторону от дома, в ширинах плеч. */
    shiftK: 0.55,
    /** И человек ОПУСТИЛСЯ на эту ногу — этим выпад отличается от шага. */
    dropK: 0.25,
  },
  wings: {
    /** Кисти разведены от своих плеч, в ширинах плеч. */
    wristOutK: 1.1,
    /** И обе ниже носа: выше — это уже хлопок. */
    raiseMaxK: 0.2,
    /**
     * Выдержка вдвое длиннее общей. Замах к хлопку проходит ровно через
     * положение «руки в стороны», и с общими 200 мс он успевал зачитываться
     * разведением рук.
     */
    holdMs: 400,
  },
  clap: {
    /** Кисти сошлись, в ширинах плеч. */
    wristGapMaxK: 0.55,
    /** И обе выше носа: сведённые внизу руки — это не хлопок над головой. */
    raiseK: 0.3,
  },
  twistknee: {
    /**
     * Колено поднято — как в обычном подъёме колена, и планка та же по смыслу.
     * Одного этого мало: подъём колена — соседнее движение, и разводит их рука.
     * Зато и рука без него ничего не стоит: в приседе локоть подходит к колену
     * на 0.55, а кисть на 0.45 — обе планки взяты (см. заголовок модуля).
     */
    kneeLiftK: 0.2,
    /**
     * И встречная рука пришла к этому колену — ЛОКТЕМ ЛИБО КИСТЬЮ, в долях
     * роста. Хватает любого из двух: люди тянутся двумя разными манерами, и
     * замер, работающий у одного, у другого не срабатывает вовсе (замеры и
     * числа — в заголовке модуля).
     *
     * Планка локтя выше планки кисти, и это не поблажка: локоть физически
     * останавливается дальше от колена — он на середине руки, а не на конце.
     * Порог устойчив: 0.60, 0.65 и 0.70 дают на записях один и тот же
     * результат.
     */
    elbowCrossK: 0.65,
    wristCrossK: 0.5,
    /**
     * Скручивание — движение быстрое: человек тянется к колену и опускает ногу.
     * Держать его 200 мс, как позу, значило бы требовать паузы в верхней точке.
     */
    holdMs: 150,
    /** И возврат из него короче общего: нога опускается сама. */
    refractoryMs: 700,
  },
}

const WRIST = { left: LM.LEFT_WRIST, right: LM.RIGHT_WRIST }
const ELBOW = { left: LM.LEFT_ELBOW, right: LM.RIGHT_ELBOW }
const ANKLE = { left: LM.LEFT_ANKLE, right: LM.RIGHT_ANKLE }
const KNEE = { left: LM.LEFT_KNEE, right: LM.RIGHT_KNEE }

const visible = (point, minVisibility = MIN_VISIBILITY) => {
  if (!point || typeof point.y !== 'number' || typeof point.x !== 'number') return false
  return point.visibility == null || point.visibility >= minVisibility
}

const NONE = () => ({ left: null, right: null })

const EMPTY = () => ({
  hipX: null,
  hipY: null,
  torso: null,
  shW: null,
  ankleOut: NONE(),
  wristOut: NONE(),
  wristGap: null,
  kneeUp: NONE(),
  wristUp: NONE(),
  wristDown: NONE(),
  wristKnee: NONE(),
  elbowKnee: NONE(),
  ankleY: NONE(),
})

/**
 * Всё, что нужно этим девяти детекторам от кадра, и ровно один раз на кадр.
 * Экран читает это и кладёт в позу раунда: движок судит по признакам, а не по
 * сырым точкам — так же, как он уже делает с ногами и руками.
 *
 * Числители здесь ещё НЕ поделены на рост: рост — это медиана за четыре
 * секунды, и она живёт в автомате, а не в кадре. Поделены только те меры, чей
 * нормировщик виден в этом же кадре, — ширина плеч.
 */
export function readMoves(landmarks, minVisibility = MIN_VISIBILITY) {
  const out = EMPTY()
  if (!landmarks || landmarks.length < 33) return out

  const ls = landmarks[LM.LEFT_SHOULDER]
  const rs = landmarks[LM.RIGHT_SHOULDER]
  const lh = landmarks[LM.LEFT_HIP]
  const rh = landmarks[LM.RIGHT_HIP]
  if (![ls, rs, lh, rh].every((p) => visible(p, minVisibility))) return out

  const shoulderY = (ls.y + rs.y) / 2
  const hipY = (lh.y + rh.y) / 2
  const shW = Math.abs(ls.x - rs.x)
  const torso = Math.abs(hipY - shoulderY)
  if (!shW) return out

  out.hipX = (lh.x + rh.x) / 2
  out.hipY = hipY
  out.torso = torso
  out.shW = shW

  const nose = landmarks[LM.NOSE]
  for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
    const ankle = landmarks[ANKLE[side]]
    const knee = landmarks[KNEE[side]]
    const wrist = landmarks[WRIST[side]]
    const shoulder = side === SIDE.LEFT ? ls : rs

    if (visible(ankle, minVisibility)) {
      // насколько стопа отставлена вбок от таза — в ширинах плеч, поэтому
      // расстояние до камеры на число не влияет
      out.ankleOut[side] = Math.abs(ankle.x - out.hipX) / shW
      out.ankleY[side] = ankle.y
    }
    if (visible(knee, minVisibility)) out.kneeUp[side] = hipY - knee.y
    if (visible(wrist, minVisibility)) {
      out.wristOut[side] = Math.abs(wrist.x - shoulder.x) / shW
      if (visible(nose, minVisibility)) out.wristUp[side] = nose.y - wrist.y
      if (visible(knee, minVisibility)) out.wristDown[side] = wrist.y - knee.y
    }
  }

  const lw = landmarks[WRIST.left]
  const rw = landmarks[WRIST.right]
  if (visible(lw, minVisibility) && visible(rw, minVisibility)) {
    out.wristGap = Math.hypot(lw.x - rw.x, lw.y - rw.y) / shW
  }

  // Встречная рука: расстояние от ЛОКТЯ и от КИСТИ противоположной руки до
  // колена этой стороны. Сторона — по колену, потому что колено человек и
  // поднимает. Оба замера нужны сразу: люди тянутся разными манерами, и один
  // из двух у конкретного человека может не сработать вовсе (см. заголовок).
  // Числители в единицах кадра: на рост их делит автомат.
  for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
    const other = side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT
    const knee = landmarks[KNEE[side]]
    if (!visible(knee, minVisibility)) continue
    const wrist = landmarks[WRIST[other]]
    const elbow = landmarks[ELBOW[other]]
    if (visible(wrist, minVisibility)) {
      out.wristKnee[side] = Math.hypot(wrist.x - knee.x, wrist.y - knee.y)
    }
    if (visible(elbow, minVisibility)) {
      out.elbowKnee[side] = Math.hypot(elbow.x - knee.x, elbow.y - knee.y)
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
 * Живая диагностика одного движения на одной стороне: сколько его условия
 * держатся подряд прямо сейчас и какое из них мешает в этом кадре.
 *
 * Зачем отдельно от событий. Условий у движения два и больше, и сойтись они
 * должны в один кадр и подряд. Пики каждого признака за окно этого не
 * раскрывают: все могут побывать в норме порознь и ни разу не совпасть — ровно
 * то, что случилось в поле 14 августа, когда складка дала 2 зачёта из 13 и
 * причину нельзя было назвать. Мерить надо выдержку, а не пики.
 *
 * На судейство это не влияет: ни одна проверка отсюда не читается.
 */
const newProbe = () => ({ heldMs: 0, block: 'pose' })

const div = (value, by) => (value == null || !by ? null : value / by)
/** Насколько стопа поднялась над своей землёй. Неизвестное так и остаётся null. */
const lift = (ground, y) => (ground == null || y == null ? null : ground - y)
const atLeast = (value, bar) => value != null && value >= bar
const atMost = (value, bar) => value != null && value <= bar
const below = (value, bar) => value != null && value < bar

/**
 * Меньшее из двух, но только если известны ОБА: неизвестное не считается нулём.
 *
 * Наружу — потому что теми же пáрами движок пишет пики признаков в лог, и
 * считать «обе руки вверх» там по другому правилу, чем судит автомат, значило бы
 * разбирать промах по числу, которого автомат не видел.
 */
export const bothMin = (pair) =>
  pair?.left == null || pair?.right == null ? null : Math.min(pair.left, pair.right)
export const bothMax = (pair) =>
  pair?.left == null || pair?.right == null ? null : Math.max(pair.left, pair.right)

/**
 * Девять движений — одним автоматом, как выпад с захлёстом в legs.js.
 *
 * Разделять их незачем: все девять живут на одной опоре (рост, дом, наклон
 * плеч за четыре секунды), считать её девять раз было бы расточительством, а
 * главное — они друг друга ИСКЛЮЧАЮТ, и связывать девять независимых автоматов
 * снаружи пришлось бы при каждой правке порогов.
 *
 * @param {object} overrides пороги на замену — по одному ключу на движение
 */
export function createMoveWatchers(overrides = {}) {
  const config = {
    ...DEFAULT_MOVES,
    ...overrides,
    holdMs: overrides.holdMs ?? DEFAULT_MOVES.holdMs,
    refractoryMs: overrides.refractoryMs ?? DEFAULT_MOVES.refractoryMs,
    windowMs: overrides.windowMs ?? WINDOW_MS,
    holdGraceMs: overrides.holdGraceMs ?? HOLD_GRACE_MS,
    minVisibility: overrides.minVisibility ?? MIN_VISIBILITY,
  }
  for (const movement of MOVEMENTS) {
    config[movement] = { ...DEFAULT_MOVES[movement], ...(overrides[movement] ?? {}) }
  }

  /** Опора за окно: рост, высота и положение таза, наклон плеч, высота стоп. */
  const history = []
  const state = {}
  for (const movement of MOVEMENTS) {
    state[movement] = SIDELESS.has(movement)
      ? { none: newState() }
      : { left: newState(), right: newState() }
  }
  /** Запас на дрогнувший замер берётся от наблюдаемого темпа съёмки. */
  const pace = createPace(config.holdGraceMs)
  /** До какого момента присед ещё может стать приседом с прыжком. */
  let jumpArmedUntil = null
  /**
   * Джек: когда в последний раз видели ноги врозь и руки вверху, и не пора ли
   * ждать возврата в стойку. Оба следа живут до возврата, а не до следующего
   * кадра — на редкой съёмке ноги и руки попадают в разные замеры.
   */
  const jackState = {
    feetAt: null,
    armsAt: null,
    armed: true,
  }
  const squatState = newState()

  const sidesOf = (movement) => (SIDELESS.has(movement) ? ['none'] : [SIDE.LEFT, SIDE.RIGHT])

  /** Живая диагностика по каждому движению и стороне: probes[movement][side]. */
  const probes = {}
  for (const movement of MOVEMENTS) {
    probes[movement] = {}
    for (const side of sidesOf(movement)) probes[movement][side] = newProbe()
  }
  const blankProbes = () => {
    for (const movement of MOVEMENTS) {
      for (const side of sidesOf(movement)) probes[movement][side] = newProbe()
    }
  }

  return {
    config,

    /**
     * Сколько условия каждого движения держатся подряд прямо сейчас и какое из
     * них мешает: probes[movement][side].{heldMs, block}, где side — 'none' у
     * движений без стороны. Имена помех — это имена самих условий ('fold',
     * 'wristLow', 'feetOut', 'armsUp', 'cross', 'kneeLift' и так далее);
     * 'pose' — судить не по чему, null — всё сошлось. Только для разбора:
     * судейство её не читает.
     */
    probes,

    /**
     * Опора кадра, наружу — для разбора записей и для полосок в игре. Считается
     * один раз и отдаётся всем, кому нужна.
     */
    ref: null,
    drop: null,
    fold: null,
    shW: null,
    homeX: null,
    /** Признаки этого кадра, уже нормированные. Судейство читает только их. */
    metrics: null,

    /**
     * @param {number} nowMs
     * @param {Array|object} source точки кадра или уже прочитанные признаки (readMoves)
     * @returns {Array<object>} события этого кадра (обычно пустой массив)
     */
    update(nowMs, source) {
      const graceMs = pace.see(nowMs)
      this.stepMs = pace.stepMs
      this.graceMs = graceMs
      this.ref = null
      this.drop = null
      this.fold = null
      this.shW = null
      this.homeX = null
      this.metrics = null

      // разбор записей кормит детектор точками, игра — признаками из позы:
      // считать одно и то же дважды незачем, а расходиться им нельзя
      const frame = Array.isArray(source) ? readMoves(source, config.minVisibility) : source || {}
      const { hipX, hipY, torso, shW } = frame
      if (hipX == null || hipY == null || !torso || !shW) {
        /**
         * Судить не по чему — так и говорим, а не молчим прошлым состоянием. Но
         * НАКОПЛЕННУЮ ВЫДЕРЖКУ ОДИН ТАКОЙ КАДР НЕ УБИВАЕТ, и это правка по
         * полевому логу 15 августа: у наклона к полу промахи с выдержкой 194 и
         * 157 мс при пороге 200 — человек держал позу, а поза на кадр
         * переставала читаться. В глубоком наклоне это норма, а не сбой: плечи
         * уходят к линии таза, корпус в кадре схлопывается, и модель теряет
         * то плечо, то таз.
         *
         * Раньше фора распространялась только на «признак дрогнул», а «человека
         * не видно» обнуляло всё сразу — при том, что у захлёста (legs.js)
         * потерянный кадр выдержку не трогает вовсе. Теперь правило одно на все
         * девять: пропажа короче HOLD_GRACE_MS — потерянный кадр, длиннее —
         * конец движения.
         */
        for (const movement of MOVEMENTS) {
          const own = state[movement]
          for (const side of sidesOf(movement)) {
            if (own[side].since != null && nowMs - own[side].lastOkAt <= graceMs) {
              continue
            }
            own[side].since = null
            own[side].lastOkAt = null
          }
        }
        squatState.since = null
        blankProbes()
        return []
      }

      history.push({
        t: nowMs,
        torso,
        hipY,
        hipX,
        ankleLeft: frame.ankleY?.left ?? null,
        ankleRight: frame.ankleY?.right ?? null,
      })
      while (history.length && nowMs - history[0].t > config.windowMs) history.shift()

      // рост человека на картинке. Именно медиана, а не текущая длина: в
      // наклоне вперёд текущая падает почти до нуля, и деление на неё взрывает
      // всё, что на неё делится
      const ref = median(history.map((h) => h.torso))
      const homeY = median(history.map((h) => h.hipY))
      const homeX = median(history.map((h) => h.hipX))
      const ground = {
        left: median(history.map((h) => h.ankleLeft).filter((v) => v != null)),
        right: median(history.map((h) => h.ankleRight).filter((v) => v != null)),
      }
      if (!ref) return []

      /**
       * Насколько таз ниже обычного (плюс — ниже: в кадре y растёт вниз).
       *
       * ДЕЛИТСЯ НА ТЕКУЩУЮ ДЛИНУ КОРПУСА, а не на медиану, и это не описка.
       * Два замера, оба против медианы:
       *
       *   1. Ровно поэтому у приседа с прыжком и у бокового выпада стоит
       *      обязательное условие fold > READABLE_FOLD. Просадка, делённая на
       *      МЕДИАНУ, в наклоне вперёд остаётся мелкой (таз в наклоне почти не
       *      уходит вниз — человек складывается в тазобедренном суставе), и
       *      запрещать наклону давать ложные приседы с прыжком было бы нечего.
       *      Взрывается именно текущая длина: она падает до 0.06 медианы, и
       *      любое движение таза становится «просадкой» в несколько ростов.
       *
       *   2. На calibration-full человек между дублями подходит к телефону:
       *      корпус в кадре вырастает вдвое (0.21 -> 0.50), четырёхсекундная
       *      опора устаревает, и просадка ПРОТИВ МЕДИАНЫ читается как 0.49 там,
       *      где человек опустился на 0.23. Это давало два ложных боковых
       *      выпада на записи, где ни одного из девяти движений нет вовсе.
       *
       * В самих движениях разницы между двумя способами нет: корпус в них стоит
       * (fold около единицы), и обе величины совпадают.
       */
      const drop = (hipY - homeY) / torso
      const fold = torso / ref
      this.ref = ref
      this.drop = drop
      this.fold = fold
      this.shW = shW
      this.homeX = homeX

      const metrics = {
        drop,
        fold,
        ankleOut: frame.ankleOut ?? NONE(),
        wristOut: frame.wristOut ?? NONE(),
        wristGap: frame.wristGap ?? null,
        kneeLift: {
          left: div(frame.kneeUp?.left, ref),
          right: div(frame.kneeUp?.right, ref),
        },
        raise: {
          left: div(frame.wristUp?.left, ref),
          right: div(frame.wristUp?.right, ref),
        },
        belowKnee: {
          left: div(frame.wristDown?.left, ref),
          right: div(frame.wristDown?.right, ref),
        },
        // встречная рука: локоть и кисть противоположной руки у этого колена
        elbowCross: {
          left: div(frame.elbowKnee?.left, ref),
          right: div(frame.elbowKnee?.right, ref),
        },
        wristCross: {
          left: div(frame.wristKnee?.left, ref),
          right: div(frame.wristKnee?.right, ref),
        },
        shift: {
          left: (hipX - homeX) / shW,
          right: (homeX - hipX) / shW,
        },
        // насколько стопа поднялась над собственной медианой: «пола» в кадре
        // не видно, а медиана за четыре секунды и есть стопа на земле
        feetLift: {
          left: div(lift(ground.left, frame.ankleY?.left), ref),
          right: div(lift(ground.right, frame.ankleY?.right), ref),
        },
      }
      this.metrics = metrics

      const events = []
      /**
       * Общий ход для всех девяти: условия держатся подряд holdMs, событие
       * отдаётся один раз на вход, следующее — не раньше рефрактерного периода.
       * Пока условия держатся, второго события нет: одно движение — один зачёт.
       *
       * Условия приходят СПИСКОМ ПО ИМЕНАМ, а не одним «сошлось/не сошлось»:
       * логика от этого та же (нужны все), но в разбор уходит имя того, чего не
       * хватило. «Не сошлось» без указания, ЧТО не сошлось, в поле не говорит
       * ничего — на складке это стоило целого дня замеров.
       *
       * @param {Array<[string, boolean]>} checks условия по порядку проверки
       */
      const step = (movement, side, checks, measure) => {
        const own = state[movement][side]
        const failed = checks.find((check) => !check[1])
        const probe = probes[movement][side]
        probe.block = failed ? failed[0] : null
        if (failed) {
          probe.heldMs = 0
          // сорвалось ненадолго — это потерянный кадр, а не конец движения:
          // накопленное не трогаем вовсе, иначе снятый `fired` выдал бы второе
          // событие на ту же выдержку (см. заголовок модуля)
          if (own.since != null && nowMs - own.lastOkAt <= graceMs) return false
          own.since = null
          own.lastOkAt = null
          own.fired = false
          return false
        }
        if (own.since == null) own.since = nowMs
        own.lastOkAt = nowMs
        const held = nowMs - own.since
        probe.heldMs = held
        const hold = config[movement].holdMs ?? config.holdMs
        if (own.fired || held < hold) return false
        const cool = config[movement].refractoryMs ?? config.refractoryMs
        if (own.lastAt != null && nowMs - own.lastAt < cool) return false
        own.fired = true
        own.lastAt = nowMs
        events.push({
          movement,
          side: side === 'none' ? null : side,
          at: nowMs,
          holdMs: Math.round(held),
          ...measure(),
        })
        return true
      }

      const readable = fold > READABLE_FOLD
      const minAnkleOut = bothMin(metrics.ankleOut)
      const minRaise = bothMin(metrics.raise)
      const maxRaise = bothMax(metrics.raise)
      const minWristOut = bothMin(metrics.wristOut)
      const minBelowKnee = bothMin(metrics.belowKnee)

      // --- наклон вперёд: корпус сложен, руки ниже колен ---
      // Второе условие обязательно: в глубоком приседе корпус тоже кое-как
      // складывается, а руки к полу не идут.
      step(
        'bend',
        'none',
        [
          ['fold', atMost(fold, config.bend.foldMaxK)],
          ['wristLow', atLeast(minBelowKnee, config.bend.belowKneeK)],
        ],
        () => ({ fold, belowKnee: minBelowKnee }),
      )

      // --- присед с прыжком: сначала просадка, потом отрыв обеих стоп ---
      // Это последовательность, а не поза, и обе её половины требуют СТОЯЩЕГО
      // корпуса: без этого наклон вперёд давал ложные приседы с прыжком —
      // в нём и просадка таза, и «отрыв» стоп получаются сами собой.
      const squatting = readable && atLeast(drop, config.jumpsquat.dropK)
      if (!squatting) {
        squatState.since = null
        squatState.fired = false
      } else {
        if (squatState.since == null) squatState.since = nowMs
        if (!squatState.fired && nowMs - squatState.since >= config.holdMs) {
          squatState.fired = true
          jumpArmedUntil = nowMs + config.jumpsquat.windowMs
        }
      }
      const feetLift = bothMin(metrics.feetLift)
      const airborne = readable && atLeast(feetLift, config.jumpsquat.footLiftK)
      if (jumpArmedUntil != null && nowMs > jumpArmedUntil) jumpArmedUntil = null
      // присед с прыжком — последовательность, а не поза: выдержка относится к
      // приседу, а помеха — к той её половине, до которой человек ещё не дошёл
      probes.jumpsquat.none = {
        heldMs: squatting && squatState.since != null ? nowMs - squatState.since : 0,
        block: airborne ? null : jumpArmedUntil == null && !squatting ? 'drop' : 'feetLift',
      }
      if (jumpArmedUntil != null && airborne) {
        const own = state.jumpsquat.none
        const cool = own.lastAt != null && nowMs - own.lastAt < config.refractoryMs
        if (!cool) {
          own.lastAt = nowMs
          jumpArmedUntil = null
          events.push({
            movement: 'jumpsquat',
            side: null,
            at: nowMs,
            holdMs: 0,
            drop,
            lift: feetLift,
          })
        }
      }

      // --- джампинг-джек: ноги врозь И обе руки над головой ---
      // Здесь не выдержка, а пересечение порогов с возвратом в стойку —
      // единственное движение с такой судьёй (почему, см. DEFAULT_MOVES.jack).
      {
        const jack = config.jack
        const probe = probes.jack.none
        // замер вне физических пределов — это не поза, а рассыпавшийся трекинг
        const goodAnkle = Number.isFinite(minAnkleOut) && minAnkleOut <= jack.ankleOutMaxK
        const goodRaise = Number.isFinite(minRaise)

        const feetOut = goodAnkle && atLeast(minAnkleOut, jack.ankleOutK)
        const armsUp = goodRaise && atLeast(minRaise, jack.raiseK)
        if (feetOut) jackState.feetAt = nowMs
        if (armsUp) jackState.armsAt = nowMs

        // возврат в стойку: ноги сошлись и руки опустились — можно считать заново
        const back =
          goodAnkle &&
          goodRaise &&
          below(minAnkleOut, jack.ankleBackK) &&
          below(minRaise, jack.raiseBackK)
        if (back) {
          jackState.armed = true
          jackState.feetAt = null
          jackState.armsAt = null
        }

        const { feetAt, armsAt } = jackState
        const together =
          feetAt != null && armsAt != null && Math.abs(feetAt - armsAt) <= jack.pairWindowMs
        probe.block = feetAt == null ? 'feetOut' : armsAt == null ? 'armsUp' : null
        probe.heldMs = together ? Math.round(Math.max(feetAt, armsAt) - Math.min(feetAt, armsAt)) : 0

        if (together && jackState.armed) {
          jackState.armed = false
          state.jack.none.lastAt = nowMs
          events.push({
            movement: 'jack',
            side: null,
            at: nowMs,
            holdMs: 0,
            ankleOut: minAnkleOut,
            raise: minRaise,
          })
        }
      }

      // --- прыжок ноги врозь: те же ноги, но руки ВНИЗУ ---
      // Руки — единственное, чем он отличается от джека, и потому условие по
      // ним строгое: обе кисти ниже носа.
      step(
        'hop',
        'none',
        [
          ['feetOut', atLeast(minAnkleOut, config.hop.ankleOutK)],
          ['drop', atMost(drop, config.hop.dropMaxK)],
          ['armsUp', below(maxRaise, config.hop.raiseMaxK)],
        ],
        () => ({ ankleOut: minAnkleOut, drop, raise: maxRaise }),
      )

      // --- руки в стороны: кисти разведены и обе ниже носа ---
      step(
        'wings',
        'none',
        [
          ['wristOut', atLeast(minWristOut, config.wings.wristOutK)],
          ['raise', below(maxRaise, config.wings.raiseMaxK)],
        ],
        () => ({ wristOut: minWristOut, raise: maxRaise }),
      )

      // --- хлопок над головой: кисти сошлись и обе выше носа ---
      step(
        'clap',
        'none',
        [
          ['wristGap', atMost(metrics.wristGap, config.clap.wristGapMaxK)],
          ['armsUp', atLeast(minRaise, config.clap.raiseK)],
        ],
        () => ({ wristGap: metrics.wristGap, raise: minRaise }),
      )

      for (const side of [SIDE.LEFT, SIDE.RIGHT]) {
        // --- боковой мах ногой: стопа далеко вбок, нога ПРЯМАЯ, таз стоит ---
        step(
          'legside',
          side,
          [
            ['ankleOut', atLeast(metrics.ankleOut[side], config.legside.ankleOutK)],
            ['kneeLift', below(metrics.kneeLift[side], config.legside.kneeMaxK)],
            ['drop', atMost(drop, config.legside.dropMaxK)],
          ],
          () => ({
            ankleOut: metrics.ankleOut[side],
            kneeLift: metrics.kneeLift[side],
            drop,
          }),
        )

        // --- боковой выпад: таз уехал вбок И человек опустился ---
        // Просадка здесь и есть всё отличие от шага в сторону.
        step(
          'sidelunge',
          side,
          [
            ['shift', atLeast(metrics.shift[side], config.sidelunge.shiftK)],
            ['drop', atLeast(drop, config.sidelunge.dropK)],
            ['fold', readable],
          ],
          () => ({ shift: metrics.shift[side], drop }),
        )

        // --- скручивание: колено вверх И встречная рука к нему ---
        // Сторона — по КОЛЕНУ: его человек и поднимает, а рука идёт встречная.
        // Рука засчитывается ЛОКТЕМ ЛИБО КИСТЬЮ — хватает любого из двух
        // замеров, потому что тянутся люди разными манерами (см. заголовок).
        step(
          'twistknee',
          side,
          [
            ['kneeLift', atLeast(metrics.kneeLift[side], config.twistknee.kneeLiftK)],
            [
              'cross',
              atMost(metrics.elbowCross[side], config.twistknee.elbowCrossK) ||
                atMost(metrics.wristCross[side], config.twistknee.wristCrossK),
            ],
          ],
          () => ({
            kneeLift: metrics.kneeLift[side],
            elbowCross: metrics.elbowCross[side],
            wristCross: metrics.wristCross[side],
          }),
        )
      }

      return events
    },

    reset() {
      history.length = 0
      jumpArmedUntil = null
      squatState.since = null
      squatState.fired = false
      squatState.lastAt = null
      this.ref = null
      this.drop = null
      this.fold = null
      this.shW = null
      this.homeX = null
      this.metrics = null
      for (const movement of MOVEMENTS) {
        for (const side of sidesOf(movement)) state[movement][side] = newState()
      }
      blankProbes()
    },
  }
}

/**
 * ГЛАВНЫЙ ПРИЗНАК движения — тот, по которому рисуется полоска и объясняется
 * промах. У движений с несколькими условиями это то, чего человеку не хватает
 * чаще прочего, и то, что он поправит сам, увидев полоску: у наклона — руки к
 * полу, у бокового выпада — уход таза, у скручивания — рука к колену.
 *
 * @returns {number|null} замер как есть, в тех же единицах, что и порог
 */
export function moveMetric(movement, side, metrics) {
  if (!metrics) return null
  const own = (pair) => (side ? pair[side] ?? null : null)

  switch (movement) {
    case 'bend':
      return bothMin(metrics.belowKnee)
    case 'jumpsquat':
      return metrics.drop
    case 'jack':
    case 'hop':
      return bothMin(metrics.ankleOut)
    case 'wings':
      return bothMin(metrics.wristOut)
    case 'clap':
      return metrics.wristGap
    case 'legside':
      return own(metrics.ankleOut)
    case 'sidelunge':
      return own(metrics.shift)
    case 'twistknee':
      // из двух замеров главный — кисть: планка у неё строже, и в лог по ней же
      // идёт `bar`. Оба замера всё равно уходят в лог отдельными полями
      return own(metrics.wristCross)
    default:
      return null
  }
}

/**
 * Движения, у которых замер ОБРАТНЫЙ: чем он меньше, тем ближе зачёт. У хлопка
 * это расстояние между кистями, у скручивания — от руки до колена. Полоска,
 * растущая при разведении рук, врала бы человеку ровно в обратную сторону.
 */
const INVERSE = new Set(['clap', 'twistknee'])

/**
 * Ключ ВТОРОЙ планки скручивания в таблице порогов. У него два пути к зачёту с
 * разными планками — локоть и кисть, — и полоска обязана показывать тот, по
 * которому человек ближе, иначе она гаснет ровно у того, кто тянется локтем.
 * Так же движок держит вторую личную меру выпада (LUNGE_DROP в engine.js).
 */
export const TWIST_ELBOW = 'twistknee-elbow'

/** Доля обратного признака: порог делится на замер, а не наоборот. */
const inverseShare = (bar, value) => (bar > 0 && value > 0 ? bar / value : null)

/**
 * Доля от порога — то, что видно полоской. Растёт по мере приближения к зачёту.
 * У обратных признаков (см. INVERSE) доля считается делением порога на замер, а
 * не наоборот.
 *
 * @returns {number|null} 0..1 и выше
 */
export function moveProgress(movement, side, metrics, bars) {
  const bar = bars?.[movement]
  if (!bar) return null

  // у скручивания путей к зачёту два, и полоска показывает ТОТ, ПО КОТОРОМУ
  // человек ближе: тянуться он будет как умеет, а планки у путей разные
  if (movement === 'twistknee') {
    const own = (pair) => (side ? pair?.[side] ?? null : null)
    const shares = [
      inverseShare(bars?.[TWIST_ELBOW], own(metrics?.elbowCross)),
      inverseShare(bar, own(metrics?.wristCross)),
    ].filter((v) => v != null)
    return shares.length ? Math.max(...shares) : null
  }

  const value = moveMetric(movement, side, metrics)
  if (value == null) return null
  if (INVERSE.has(movement)) return value <= 0 ? null : bar / value
  return value / bar
}
