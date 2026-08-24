// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DAYS,
  DELOAD,
  INTENSITY,
  ORDER,
  FREE_DAYS,
  advanceDay,
  allDays,
  completeDay,
  currentDay,
  dayPlan,
  dayPlayable,
  dayRuns,
  isChallengeDone,
  isDayDone,
  isUnlocked,
  movementsOf,
  progress,
  resetProgress,
  moscowDate,
  setStreamStart,
  streamDay,
  streamPhase,
} from './challenge.js'
import { STRENGTH_TYPES } from './strength.js'
import { KEYS, writeRaw } from '../storage.js'

/**
 * ПЛАН ТРИДЦАТИ ДНЕЙ. Главное здесь — не формулы, а СВЕРКА С УТВЕРЖДЁННОЙ
 * ТАБЛИЦЕЙ: план придуман тренером и согласован, а код его лишь считает. Дни
 * 1, 7, 15, 20 и 30 выписаны числами намеренно — это те строки, по которым
 * человек будет проверять, ту ли тренировку ему дали.
 */

describe('таблица интенсивности', () => {
  it('тридцать дней и ни одним больше', () => {
    expect(INTENSITY).toHaveLength(30)
    expect(DAYS).toBe(30)
    expect(INTENSITY.every((v) => v >= 50 && v <= 100)).toBe(true)
  })

  it('разгрузки стоят там, где договорились', () => {
    expect([...DELOAD].sort((a, b) => a - b)).toEqual([7, 14, 21, 28, 29])
    /**
     * Разгрузка обязана быть легче СВОЕЙ НЕДЕЛИ, а не обязательно предыдущего
     * дня: дни 28 и 29 стоят парой, и второй из них тяжелее первого — это уже
     * подводка к тридцатому, а не отдых.
     */
    for (const day of [7, 14, 21, 28]) {
      const week = INTENSITY.slice(day - 7, day - 1)
      expect(INTENSITY[day - 1]).toBeLessThan(Math.min(...week))
    }
  })

  it('все движения плана — силовые', () => {
    for (const movement of ORDER) expect(STRENGTH_TYPES).toContain(movement)
  })
})

describe('параметры дня совпадают с утверждённой таблицей', () => {
  /**
   * Строка таблицы: то, что человек увидит и по чему сверит тренировку.
   *
   * СЕКУНДЫ ВЫРОСЛИ НА СЕМЬ во всех днях разом — стартовый отсчёт стал десятью
   * секундами вместо трёх (session.js, START_COUNTDOWN_MS): на старте человек
   * стоит у телефона, и за три секунды он не успевает отойти и встать в кадр.
   * Работа и отдых не тронуты ни на секунду.
   */
  const row = (plan) => ({
    кругов: plan.circles,
    сила: plan.strengthSec,
    бой: plan.fightSec,
    отдых: `${plan.restStrengthSec}/${plan.restFightSec}`,
    темп: plan.tempoMult,
    жизнь: plan.lifeMult,
    пауза: plan.gapMult,
    секунд: plan.totalSec,
  })

  it('день 1 — самый лёгкий рабочий', () => {
    expect(row(dayPlan(1))).toEqual({
      кругов: 7,
      сила: 32,
      бой: 96,
      отдых: '14/24',
      темп: 0.93,
      жизнь: 1.12,
      пауза: 1.12,
      секунд: 1172,
    })
  })

  it('день 7 — разгрузка: базовый день без прыжкового', () => {
    const plan = dayPlan(7)
    expect(plan.deload).toBe(true)
    expect(row(plan)).toEqual({
      кругов: 7,
      сила: 30,
      бой: 90,
      отдых: '15/25',
      темп: 0.9,
      жизнь: 1.15,
      пауза: 1.15,
      секунд: 1130,
    })
    // ударные заменены: ни одного прыжка и ни одного приседа с прыжком
    expect(plan.movements).not.toContain('pit')
    expect(plan.movements).not.toContain('jumpsquat')
  })

  it('день 15 — середина второй половины', () => {
    expect(row(dayPlan(15))).toEqual({
      кругов: 8,
      сила: 40,
      бой: 128,
      отдых: '11/19',
      темп: 1.06,
      жизнь: 0.96,
      пауза: 0.96,
      секунд: 1594,
    })
  })

  it('день 20 — почти предельный', () => {
    expect(row(dayPlan(20))).toEqual({
      кругов: 8,
      сила: 44,
      бой: 144,
      отдых: '9/16',
      темп: 1.13,
      жизнь: 0.88,
      пауза: 0.88,
      секунд: 1714,
    })
  })

  it('день 30 — предел: восемь кругов и двойной выпад', () => {
    const plan = dayPlan(30)
    expect(row(plan)).toEqual({
      кругов: 8,
      сила: 45,
      бой: 150,
      отдых: '8/15',
      темп: 1.15,
      жизнь: 0.85,
      пауза: 0.85,
      секунд: 1754,
    })
    // движение дня делается дважды: первым на свежих силах и последним на усталых
    expect(plan.movementOfDay).toBe('lunge')
    expect(plan.movements[0]).toBe('lunge')
    expect(plan.movements.at(-1)).toBe('lunge')
    expect(plan.movements.filter((m) => m === 'lunge')).toHaveLength(2)
  })
})

describe('движения дня', () => {
  it('порядок сдвигается на один каждый день', () => {
    expect(movementsOf(1).week).toEqual(ORDER)
    expect(movementsOf(2).week).toEqual([...ORDER.slice(1), ORDER[0]])
    // через неделю круг замыкается
    expect(movementsOf(8).week).toEqual(ORDER)
  })

  it('за неделю каждое движение бывает и первым, и последним', () => {
    /**
     * Ради этого сдвиг и сделан: первым движение делается на свежих силах,
     * последним — на усталых, и за неделю каждое успевает побывать и там и там.
     *
     * Считается по САМОМУ СДВИГУ, а не по готовому дню: в разгрузку два
     * движения подменяются, и набор недели там честно беднее — но это свойство
     * разгрузки, а не сдвига, и проверяется оно отдельно.
     */
    const first = new Set()
    const last = new Set()
    for (let day = 1; day <= 7; day += 1) {
      const shift = (day - 1) % ORDER.length
      first.add(ORDER[shift])
      last.add(ORDER[(shift + ORDER.length - 1) % ORDER.length])
    }
    expect(first.size).toBe(ORDER.length)
    expect(last.size).toBe(ORDER.length)
  })

  it('в разгрузку прыжковое заменяется, в рабочий день — нет', () => {
    // разгрузка, в которой человек всё равно прыгает, разгрузкой не является
    for (let day = 1; day <= DAYS; day += 1) {
      const { movements } = dayPlan(day)
      const jumping = movements.filter((m) => m === 'pit' || m === 'jumpsquat')
      if (DELOAD.has(day)) expect(jumping).toEqual([])
      else expect(jumping.length).toBeGreaterThan(0)
    }
  })

  it('кругов ровно столько, сколько сказал план', () => {
    for (const plan of allDays()) {
      expect(plan.movements).toHaveLength(plan.circles)
      expect(plan.circles === 7 || plan.circles === 8).toBe(true)
    }
  })

  it('восьмой круг — движение дня, и он есть только на восьмикруговых днях', () => {
    for (const plan of allDays()) {
      const week = movementsOf(plan.day).week
      if (plan.circles === 8) {
        // неделя целиком плюс движение дня сверху
        expect(plan.movements).toEqual([...week, plan.movementOfDay])
        expect(plan.movements.at(-1)).toBe(plan.movementOfDay)
      } else {
        // ровно неделя, без добавки
        expect(plan.movements).toEqual(week)
      }
    }
  })
})

describe('весь челлендж целиком', () => {
  it('нагрузка растёт, но не монотонно: провалы после тяжёлых дней есть', () => {
    const days = allDays()
    const firstWeek = days.slice(0, 7).reduce((s, p) => s + p.totalSec, 0)
    const lastWeek = days.slice(23, 30).reduce((s, p) => s + p.totalSec, 0)
    expect(lastWeek).toBeGreaterThan(firstWeek * 1.3)
    // и хотя бы один день легче предыдущего — иначе это не план, а лестница
    expect(days.some((p, i) => i > 0 && p.totalSec < days[i - 1].totalSec)).toBe(true)
  })

  it('день вне диапазона прижимается к нему, а не роняет игру', () => {
    expect(dayPlan(0).day).toBe(1)
    expect(dayPlan(99).day).toBe(30)
    expect(dayPlan('чепуха').day).toBe(1)
  })
})

describe('прогресс участника', () => {
  beforeEach(() => {
    // и прогресс, и флаг разблокировки: разблокировав челлендж в одном тесте,
    // мы иначе открывали бы его всем последующим
    globalThis.localStorage?.clear()
    resetProgress()
  })

  it('челлендж начинается с первого дня', () => {
    expect(currentDay()).toBe(1)
    expect(progress().done).toEqual([])
    expect(isChallengeDone()).toBe(false)
  })

  it('завершённая сессия отмечает день сданным, но никуда не переводит', () => {
    /**
     * Раньше переводила — и оставшиеся попытки дня сгорали. Человек, прошедший
     * день слабо, оказывался наказан за то, что дошёл до конца: брось он
     * сессию на последнем круге, попытки остались бы при нём.
     */
    const marked = completeDay(1)
    expect(marked.dayDone).toBe(true)
    expect(isDayDone(1)).toBe(true)
    expect(currentDay()).toBe(1)
  })

  it('день растёт только через явный переход и только со сданного дня', () => {
    /**
     * Инвариант тот же, ради которого всё писалось: вперёд только через
     * полностью завершённую сессию. Другой двери нет.
     */
    expect(advanceDay().advanced).toBe(false)
    expect(currentDay()).toBe(1)

    completeDay(1)
    expect(advanceDay().advanced).toBe(true)
    expect(currentDay()).toBe(2)

    // второй день не сдан — дальше не пускает, сколько ни жми
    expect(advanceDay().advanced).toBe(false)
    expect(advanceDay().advanced).toBe(false)
    expect(currentDay()).toBe(2)
  })

  it('сданный чужой день дверь не открывает', () => {
    // заглянуть вперёд через ?day= и сдать двадцатый можно — перейти нельзя
    completeDay(20)
    expect(isDayDone(20)).toBe(true)
    expect(advanceDay().advanced).toBe(false)
    expect(currentDay()).toBe(1)
  })

  it('назад дороги нет: переход необратим', () => {
    /**
     * Иначе человек, которому не понравился результат, ходил бы по старым дням,
     * добирая очки, и тридцатидневный челлендж превратился бы в тридцать
     * уровней, которые можно перепроходить до бесконечности.
     */
    completeDay(1)
    advanceDay()
    completeDay(1) // прошёл первый день ещё раз — уже вне зачёта дня
    expect(currentDay()).toBe(2)
  })

  it('первые пять дней играются без кода, шестой — нет', () => {
    /**
     * Пять дней — это неделя минус разгрузка: достаточно, чтобы человек увидел,
     * как растут его цифры, и слишком мало, чтобы это заменило челлендж.
     */
    expect(FREE_DAYS).toBe(5)
    for (let day = 1; day <= FREE_DAYS; day += 1) expect(dayPlayable(day)).toBe(true)
    expect(dayPlayable(6)).toBe(false)
    expect(dayPlayable(30)).toBe(false)
  })

  it('участник живого потока играет все тридцать дней', () => {
    /**
     * Это и есть новая дверь: место в потоке покупается билетом, и участие
     * приходит В ПАРАМЕТРЕ — challenge.js в сеть не ходит и про сезоны ничего
     * не знает (кто участник, знает src/challengeSeason.js).
     */
    expect(dayPlayable(6, true)).toBe(true)
    expect(dayPlayable(30, true)).toBe(true)
    // и это не портит счёт дней тому, кто не участник
    expect(dayPlayable(6, false)).toBe(false)
  })

  it('не участник — ровно пять дней, чем бы ни было участие', () => {
    // случайная правда вместо булева не должна открывать челлендж
    for (const notMember of [false, undefined, null, 0, '', 'yes', 1, {}]) {
      expect(dayPlayable(6, notMember)).toBe(false)
    }
  })

  it('старый ключ доступа продолжает работать', () => {
    /**
     * Кода `?start=` больше нет, выдать этот флаг больше нечем — но у тех, кому
     * доступ открыли раньше, он остался в хранилище. Забрать его нельзя:
     * человек получил доступ честно, а объяснить ему пропажу нечем.
     */
    expect(isUnlocked()).toBe(false)
    expect(dayPlayable(6)).toBe(false)

    writeRaw(KEYS.challengeUnlocked, '1')

    expect(isUnlocked()).toBe(true)
    expect(dayPlayable(6)).toBe(true)
    expect(dayPlayable(30)).toBe(true)
  })

  it('переход на шестой день не заблокирован: блокируется тренировка', () => {
    // человек должен ДОЙТИ до плашки со своими результатами, а не упереться в
    // неработающую кнопку на пятом дне и решить, что игра сломалась
    for (let day = 1; day <= 5; day += 1) {
      completeDay(day)
      expect(advanceDay().advanced).toBe(true)
    }
    expect(currentDay()).toBe(6)
    expect(dayPlayable(6)).toBe(false)
  })

  it('даты завершений копятся по дням и не двоятся', () => {
    completeDay(1, new Date('2026-08-17T10:00:00Z'))
    completeDay(1, new Date('2026-08-18T10:00:00Z'))
    const done = progress().done
    expect(done).toHaveLength(1)
    // runs — за сколько заходов собран день; по умолчанию за один
    expect(done[0]).toEqual({ day: 1, at: '2026-08-18T10:00:00.000Z', runs: 1 })
  })

  /**
   * С появлением продолжения незавершённой сессии день стало можно собрать за
   * несколько заходов. Для судейства призов «прошёл целиком за раз» и
   * «дособирал третьим заходом» — разные вещи, а по одной дате завершения их
   * не различить никак.
   */
  it('за сколько заходов собран день — запоминается', () => {
    expect(dayRuns(3)).toBe(0)
    completeDay(3, new Date('2026-08-18T10:00:00Z'), 2)
    expect(dayRuns(3)).toBe(2)
    expect(progress().done.find((r) => r.day === 3).runs).toBe(2)
    // пересобрал за один заход — запись обновляется целиком
    completeDay(3, new Date('2026-08-19T10:00:00Z'), 1)
    expect(dayRuns(3)).toBe(1)
  })

  it('тридцатый день плюс переход — челлендж пройден', () => {
    for (let day = 1; day <= DAYS; day += 1) {
      completeDay(day)
      advanceDay()
    }
    expect(currentDay()).toBe(30)
    expect(isChallengeDone()).toBe(true)
    expect(progress().done).toHaveLength(DAYS)
  })

  it('сданный тридцатый день сам по себе челлендж не завершает', () => {
    // последний шаг человек делает сам, как и все предыдущие
    for (let day = 1; day < DAYS; day += 1) {
      completeDay(day)
      advanceDay()
    }
    completeDay(DAYS)
    expect(isChallengeDone()).toBe(false)

    advanceDay()
    expect(isChallengeDone()).toBe(true)
  })
})

/**
 * ПОТОК ИДЁТ ПО КАЛЕНДАРЮ. Здесь проверяется единственное правило, из-за
 * которого возможен спор о призах: в день N потока играется день N, и никакой
 * другой. Время всюду задаётся явно — тест, зависящий от часов машины, в этом
 * вопросе не доказывает ничего.
 */
describe('день потока считает календарь', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    resetProgress()
    setStreamStart(null)
  })

  const START = '2026-09-10'
  /** Полдень по Москве указанного дня — заведомо середина суток, не край. */
  const мск = (iso) => new Date(`${iso}T09:00:00Z`)

  it('день = (сегодня − старт) + 1', () => {
    expect(streamDay(START, мск('2026-09-10'))).toBe(1)
    expect(streamDay(START, мск('2026-09-14'))).toBe(5)
    expect(streamDay(START, мск('2026-10-09'))).toBe(30)
    // до старта и после конца число не прижимается: оба ответа нужны экранам
    expect(streamDay(START, мск('2026-09-07'))).toBe(-2)
    expect(streamDay(START, мск('2026-10-10'))).toBe(31)
    expect(streamDay(null, мск('2026-09-14'))).toBe(null)
  })

  it('граница суток — полночь по Москве, и она одна на всех', () => {
    /**
     * 20:59:59 UTC — это 23:59:59 в Москве, ещё вчерашний день; секунда спустя
     * начинается следующий. Ни часовой пояс браузера, ни летнее время сюда не
     * входят: у человека из Владивостока и у человека из Берлина день потока
     * меняется в одну и ту же секунду, иначе последний день у них был бы
     * разной длины — а на нём призы.
     */
    expect(streamDay(START, new Date('2026-09-13T20:59:59Z'))).toBe(4)
    expect(streamDay(START, new Date('2026-09-13T21:00:00Z'))).toBe(5)

    // и меняется РОВНО ОДИН РАЗ: минута до, минута после и час после — один день
    expect(streamDay(START, new Date('2026-09-13T21:01:00Z'))).toBe(5)
    expect(streamDay(START, new Date('2026-09-13T22:00:00Z'))).toBe(5)
    expect(streamDay(START, new Date('2026-09-14T20:59:59Z'))).toBe(5)
  })

  it('фазы потока: до старта, идёт, завершён', () => {
    expect(streamPhase(START, мск('2026-09-09'))).toBe('before')
    expect(streamPhase(START, мск('2026-09-10'))).toBe('running')
    expect(streamPhase(START, мск('2026-10-09'))).toBe('running')
    expect(streamPhase(START, мск('2026-10-10'))).toBe('over')
    expect(streamPhase(null)).toBe('unknown')
  })

  it('участник в день 5 играет только день 5 — ни четвёртый, ни шестой', () => {
    const at = мск('2026-09-14')
    expect(dayPlayable(5, true, START, at)).toBe(true)
    // вчерашний закрыт навсегда: пропущенный день остаётся нулём
    expect(dayPlayable(4, true, START, at)).toBe(false)
    expect(dayPlayable(1, true, START, at)).toBe(false)
    // завтрашний под замком
    expect(dayPlayable(6, true, START, at)).toBe(false)
    expect(dayPlayable(30, true, START, at)).toBe(false)
  })

  it('пропущенный день не открывается задним числом', () => {
    // человек не играл день 5 вовсе; на шестой день он по-прежнему недоступен
    expect(dayPlayable(5, true, START, мск('2026-09-15'))).toBe(false)
    expect(dayPlayable(6, true, START, мск('2026-09-15'))).toBe(true)
    // и сданный день назад тоже не пускает — дверь одна и только сегодняшняя
    completeDay(5)
    expect(dayPlayable(5, true, START, мск('2026-09-15'))).toBe(false)
  })

  it('до старта и после тридцатого дня закрыто всё', () => {
    for (const day of [1, 5, 30]) {
      expect(dayPlayable(day, true, START, мск('2026-09-09'))).toBe(false)
      expect(dayPlayable(day, true, START, мск('2026-10-10'))).toBe(false)
    }
  })

  it('поток без объявленной даты идёт по-старому — все тридцать дней', () => {
    // поле пустое у сезона, а место оплачено: закрыть человеку всё было бы хуже
    expect(dayPlayable(6, true, null, мск('2026-09-14'))).toBe(true)
    expect(dayPlayable(30, true, null, мск('2026-09-14'))).toBe(true)
  })

  it('не участник ходит по пяти дням кнопкой, календарь его не касается', () => {
    setStreamStart(START)
    for (let day = 1; day <= FREE_DAYS; day += 1) expect(dayPlayable(day, false)).toBe(true)
    expect(dayPlayable(6, false)).toBe(false)

    // и переход у него по-прежнему работает
    completeDay(1)
    expect(advanceDay().advanced).toBe(true)
    expect(progress().day).toBe(2)
  })

  it('currentDay участника — день потока, а не его прогресс', () => {
    completeDay(1)
    advanceDay()
    expect(currentDay()).toBe(2)

    /**
     * Поток, начавшийся четыре московских дня назад, идёт пятым днём — и это
     * тот день, которым подписывается ВСЁ: попытки, черновик, снимок сессии и
     * сид трассы (day.js берёт день по умолчанию отсюда). Дата собирается от
     * сегодняшнего московского числа, а не от машинного полудня: иначе тест
     * ломался бы у всех, кто западнее Москвы.
     */
    const [y, m, d] = moscowDate().split('-').map(Number)
    const старт = new Date(Date.UTC(y, m - 1, d - 4)).toISOString().slice(0, 10)
    setStreamStart(старт)
    expect(currentDay()).toBe(5)

    setStreamStart(null)
    expect(currentDay()).toBe(2)
  })

  it('поток кончился — день упирается в тридцатый, а не растёт дальше', () => {
    const [y, m, d] = moscowDate().split('-').map(Number)
    const давно = new Date(Date.UTC(y, m - 1, d - 60)).toISOString().slice(0, 10)
    setStreamStart(давно)
    expect(currentDay()).toBe(DAYS)
    // играть при этом нечего
    expect(dayPlayable(DAYS, true)).toBe(false)
  })
})
