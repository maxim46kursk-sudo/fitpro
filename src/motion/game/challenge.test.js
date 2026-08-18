// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DAYS,
  DELOAD,
  INTENSITY,
  ORDER,
  FREE_DAYS,
  UNLOCK_CODE,
  advanceDay,
  allDays,
  completeDay,
  currentDay,
  dayPlan,
  dayPlayable,
  isChallengeDone,
  isDayDone,
  isUnlocked,
  movementsOf,
  unlock,
  unlockFromUrl,
  progress,
  resetProgress,
} from './challenge.js'
import { STRENGTH_TYPES } from './strength.js'

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

  it('код открывает челлендж целиком и навсегда', () => {
    expect(isUnlocked()).toBe(false)
    expect(unlock(UNLOCK_CODE)).toBe(true)

    expect(isUnlocked()).toBe(true)
    expect(dayPlayable(6)).toBe(true)
    expect(dayPlayable(30)).toBe(true)
  })

  it('код принимается в любом регистре и с пробелами — его вводят с телефона', () => {
    expect(unlock(` ${UNLOCK_CODE.toUpperCase()} `)).toBe(true)
    expect(isUnlocked()).toBe(true)
  })

  it('чужой код не открывает ничего', () => {
    for (const wrong of ['', ' ', 'start', UNLOCK_CODE + 'x', null, undefined, 1]) {
      expect(unlock(wrong)).toBe(false)
    }
    expect(isUnlocked()).toBe(false)
    expect(dayPlayable(6)).toBe(false)
  })

  it('код из адреса открывает челлендж в тот же заход', () => {
    // человек переходит по ссылке от тренера один раз и дальше открывает игру
    // как обычно
    vi.stubGlobal('location', { search: `?start=${UNLOCK_CODE}`, hash: '' })
    expect(unlockFromUrl()).toBe(true)
    expect(isUnlocked()).toBe(true)
    vi.unstubAllGlobals()
  })

  it('без ключа в адресе ничего не открывается', () => {
    vi.stubGlobal('location', { search: '?day=6', hash: '' })
    expect(unlockFromUrl()).toBe(false)
    expect(isUnlocked()).toBe(false)
    vi.unstubAllGlobals()
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
    expect(done[0]).toEqual({ day: 1, at: '2026-08-18T10:00:00.000Z' })
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
