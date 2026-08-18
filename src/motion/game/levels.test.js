import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIER,
  MAX_PACE,
  MIN_PACE,
  PACE,
  TIERS,
  clampPace,
  configForTier,
  obstaclePointsFor,
  paceFor,
  tierById,
} from './levels.js'

describe('шкала темпа 1–13', () => {
  it('тринадцать шагов подряд, без пропусков', () => {
    expect(PACE).toHaveLength(13)
    expect(PACE.map((p) => p.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(MIN_PACE).toBe(1)
    expect(MAX_PACE).toBe(13)
  })

  it('обе колонки монотонно убывают: дальше по шкале — быстрее', () => {
    // если хоть одна колонка сорвётся, «уровень выше» перестанет означать
    // «быстрее», и уровни начнут врать человеку
    for (let i = 1; i < PACE.length; i += 1) {
      expect(PACE[i].gapMs).toBeLessThan(PACE[i - 1].gapMs)
      expect(PACE[i].travelMs).toBeLessThan(PACE[i - 1].travelMs)
    }
  })

  it('концы шкалы — те самые проверенные значения', () => {
    expect(paceFor(1)).toEqual({ gapMs: 6000, travelMs: 4000 })
    // быстрее этого не идём: предел, проверенный в поле
    expect(paceFor(13)).toEqual({ gapMs: 2000, travelMs: 1800 })
  })

  it('шаг вне шкалы прижимается к границам', () => {
    expect(clampPace(0)).toBe(MIN_PACE)
    expect(clampPace(99)).toBe(MAX_PACE)
    expect(clampPace('не число')).toBe(MIN_PACE)
    expect(paceFor(99)).toEqual(paceFor(MAX_PACE))
  })
})

describe('три уровня челленджа', () => {
  it('имена, диапазоны и цены — как решил Максим', () => {
    expect(TIERS.map((t) => [t.name, t.from, t.to, t.obstaclePoints])).toEqual([
      ['НОВИЧОК', 1, 6, 100],
      ['ОПЫТНЫЙ', 5, 9, 150],
      ['ПРОФИ', 8, 12, 200],
    ])
  })

  it('верхние концы срезаны по полевому тесту, шкала при этом целая', () => {
    // на профи 59/76, и промахи шли там, где темп уходил за десятый шаг
    expect(TIERS.at(-1).to).toBeLessThan(MAX_PACE)
    // сама шкала не тронута: последний шаг остаётся запасом на потом
    expect(MAX_PACE).toBe(13)
  })

  it('диапазоны перекрываются: переход между уровнями без обрыва', () => {
    // конец лёгкого лежит внутри следующего, иначе между уровнями была бы дыра
    for (let i = 1; i < TIERS.length; i += 1) {
      expect(TIERS[i].from).toBeLessThan(TIERS[i - 1].to)
      expect(TIERS[i].to).toBeGreaterThan(TIERS[i - 1].to)
    }
  })

  it('цена растёт вместе со скоростью', () => {
    for (let i = 1; i < TIERS.length; i += 1) {
      expect(TIERS[i].obstaclePoints).toBeGreaterThan(TIERS[i - 1].obstaclePoints)
    }
    expect(obstaclePointsFor('pro')).toBe(200)
  })

  it('конфиг раунда собирается из концов диапазона', () => {
    // новичок: старт с шага 1, финиш на шаге 6
    expect(configForTier('novice')).toEqual({
      startGapMs: 6000,
      endGapMs: 3700,
      startTravelMs: 4000,
      endTravelMs: 2800,
      targetRadiusK: 0.42,
      targetLifeMs: 3600,
      targetGapMs: 400,
    })
    // профи: старт с шага 8, финиш на 12-м — тринадцатый срезан полевым тестом
    expect(configForTier('pro')).toEqual({
      startGapMs: 3100,
      endGapMs: 2200,
      startTravelMs: 2400,
      endTravelMs: 1900,
      targetRadiusK: 0.3,
      targetLifeMs: 2000,
      targetGapMs: 150,
    })
    // опытный: 5 -> 9
    expect(configForTier('experienced')).toEqual({
      startGapMs: 4100,
      endGapMs: 2800,
      startTravelMs: 3000,
      endTravelMs: 2250,
      targetRadiusK: 0.35,
      targetLifeMs: 2800,
      targetGapMs: 250,
    })
  })

  it('внутри уровня раунд разгоняется, а не тормозит', () => {
    for (const tier of TIERS) {
      const cfg = configForTier(tier.id)
      expect(cfg.endGapMs).toBeLessThan(cfg.startGapMs)
      expect(cfg.endTravelMs).toBeLessThan(cfg.startTravelMs)
    }
  })

  it('уровень меняет темп и три числа ловца — и больше ничего', () => {
    /**
     * Ни поз, ни порогов, ни длительности: уровень про то, НАСКОЛЬКО ТОЧНО и
     * НАСКОЛЬКО БЫСТРО делать работу, а не про то, какую работу делать.
     */
    expect(Object.keys(configForTier('experienced')).sort()).toEqual([
      'endGapMs',
      'endTravelMs',
      'startGapMs',
      'startTravelMs',
      'targetGapMs',
      'targetLifeMs',
      'targetRadiusK',
    ])
  })

  it('уровни ловца разведены по трём числам, а не по одному', () => {
    /**
     * Полевой отзыв после сессии: «одни настройки» — человек не почувствовал
     * разницы между уровнями. Одно время жизни её и не даёт: секунда на фоне
     * полутора, которые уходят на дорогу до мишени, не читается никак.
     *
     * Теперь их три, и каждое давит своим: точность (размер круга), спешка
     * (сколько висит), плотность (пауза между мишенями).
     */
    expect(TIERS.map((tier) => tier.targetRadiusK)).toEqual([0.42, 0.35, 0.3])
    expect(TIERS.map((tier) => tier.targetLifeMs)).toEqual([3600, 2800, 2000])
    expect(TIERS.map((tier) => tier.targetGapMs)).toEqual([400, 250, 150])
    for (let i = 1; i < TIERS.length; i += 1) {
      expect(TIERS[i].targetRadiusK).toBeLessThan(TIERS[i - 1].targetRadiusK)
      expect(TIERS[i].targetLifeMs).toBeLessThan(TIERS[i - 1].targetLifeMs)
      expect(TIERS[i].targetGapMs).toBeLessThan(TIERS[i - 1].targetGapMs)
    }
    // у новичка круг заметно шире профийного — попадать можно примерно
    expect(TIERS[0].targetRadiusK / TIERS[2].targetRadiusK).toBeGreaterThan(1.3)
  })

  it('неизвестный уровень не роняет игру, а становится новичком', () => {
    // в хранилище может лежать имя из старой версии
    expect(tierById('уровень-из-прошлой-жизни').id).toBe(DEFAULT_TIER)
    expect(configForTier(undefined)).toEqual(configForTier('novice'))
  })
})

describe('автопрогрессия убрана', () => {
  it('модуль больше не экспортирует ни прогрессию, ни разгрузку', async () => {
    // уровень выбирает человек; ни nextLevel, ни isDeload, ни вердиктов
    const levels = await import('./levels.js')
    for (const gone of ['nextLevel', 'isDeload', 'playedLevel', 'roundOutcome', 'VERDICT']) {
      expect(levels[gone]).toBeUndefined()
    }
  })
})
