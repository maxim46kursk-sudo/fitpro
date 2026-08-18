import { describe, expect, it } from 'vitest'
import { TIERS, configForTier, obstaclePointsFor } from './levels.js'
import { createScore } from './score.js'
import { createRound } from './engine.js'
import { createTargets, readBody } from './targets.js'
import { LM } from '../pose/landmarks.js'

/**
 * ЦЕНА ЗАЧЁТА ДОЕЗЖАЕТ ДО ЧИСЛА НА ЭКРАНЕ — вся цепочка, звено за звеном.
 *
 * Полевая жалоба «числа +очки не видно в бою» имеет две независимые причины, и
 * вторая тише первой: число создаётся ТОЛЬКО при `points > 0`
 * (`targets.clear()`), а ноль до него доехать может — если счёт не завёлся с
 * ценой уровня, или если зачёт пришёл разминочным, и `scoreRef.hit()` не
 * позвался вовсе. И в том, и в другом случае на экране просто ничего нет: ни
 * ошибки, ни пустого «+0», ни строки в логе.
 *
 * Поэтому здесь проверяется не «функция вернула число», а весь путь:
 *
 *   уровень -> obstaclePointsFor -> createScore({hitPoints}) -> hit().points
 *     -> targets.clear({points}) -> текст на холсте
 *
 * Порвись любое звено — число молча исчезнет с экрана, а счёт при этом
 * продолжит расти: человек увидит растущую сумму и ни одного ответа на своё
 * движение.
 */

const FIT = { ox: 0, oy: 0, dw: 400, dh: 800, scale: 1 }

function pose() {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  p[LM.LEFT_SHOULDER] = { x: 0.4, y: 0.3, visibility: 1 }
  p[LM.RIGHT_SHOULDER] = { x: 0.6, y: 0.3, visibility: 1 }
  p[LM.LEFT_HIP] = { x: 0.45, y: 0.55, visibility: 1 }
  p[LM.RIGHT_HIP] = { x: 0.55, y: 0.55, visibility: 1 }
  p[LM.LEFT_KNEE] = { x: 0.45, y: 0.72, visibility: 1 }
  p[LM.RIGHT_KNEE] = { x: 0.55, y: 0.72, visibility: 1 }
  p[LM.LEFT_ANKLE] = { x: 0.45, y: 0.9, visibility: 1 }
  p[LM.RIGHT_ANKLE] = { x: 0.55, y: 0.9, visibility: 1 }
  p[LM.NOSE] = { x: 0.5, y: 0.2, visibility: 1 }
  return p
}

/** Холст-счётчик: важно только то, какой текст на него лёг. */
function fakeCtx() {
  const texts = []
  return new Proxy(
    { texts },
    {
      get(target, key) {
        if (key === 'texts') return texts
        if (key === 'canvas') return { width: 400, height: 800 }
        if (key === 'fillText') return (...args) => texts.push(String(args[0]))
        if (key === 'createLinearGradient' || key === 'createRadialGradient') {
          return () => ({ addColorStop() {} })
        }
        return () => {}
      },
      set: () => true,
    },
  )
}

const obstacleOf = (over = {}) => ({
  id: 1,
  type: 'strike',
  side: 'left',
  spawnAt: 0,
  travelMs: 2000,
  status: 'incoming',
  ...over,
})

const frameOf = (obstacles, over = {}) => ({
  width: 400,
  height: 800,
  clockMs: 1000,
  obstacles,
  body: readBody(pose(), FIT),
  cheap: false,
  ...over,
})

describe('цена уровня доходит до числа на экране', () => {
  for (const tier of TIERS) {
    it(`${tier.id}: человек видит «+${tier.obstaclePoints}», а не пустоту`, () => {
      // ровно так счёт заводится в бою (GameScreen)
      const score = createScore({ hitPoints: obstaclePointsFor(tier.id) })
      const res = score.hit()

      expect(res.points).toBe(tier.obstaclePoints)
      expect(res.points).toBeGreaterThan(0)

      const targets = createTargets()
      const ctx = fakeCtx()
      targets.draw(ctx, frameOf([obstacleOf()]))
      targets.clear(1, { points: res.points })
      targets.draw(ctx, frameOf([], { clockMs: 1010 }))

      expect(ctx.texts).toContain(`+${tier.obstaclePoints}`)
    })
  }

  it('у каждого уровня цена больше нуля — иначе число не родится вовсе', () => {
    for (const tier of TIERS) {
      expect(obstaclePointsFor(tier.id)).toBeGreaterThan(0)
    }
  })

  /**
   * Так выглядит поломка, которую этот файл и стережёт: всё «работает», ошибок
   * нет, счёт растёт — а на экране пусто. Ноль не рисуется намеренно (писать
   * «+0» бессмысленно), и ровно поэтому он и опасен: он ничем себя не выдаёт.
   */
  it('ноль не рисуется ничем — вот как выглядит потерянное число', () => {
    const targets = createTargets()
    const ctx = fakeCtx()
    targets.draw(ctx, frameOf([obstacleOf()]))
    targets.clear(1, { points: 0 })
    targets.draw(ctx, frameOf([], { clockMs: 1010 }))

    expect(targets.effects.floats).toHaveLength(0)
    expect(ctx.texts.some((t) => t.startsWith('+'))).toBe(false)
  })
})

describe('в бою зачёт всегда зачётный, а не разминочный', () => {
  /**
   * ВТОРОЙ СПОСОБ ПОЛУЧИТЬ НОЛЬ. В GameScreen счёт берётся так:
   *
   *   const res = ev.practice ? null : scoreRef.current.hit()
   *   targets.clear(id, { points: res?.points ?? 0 })
   *
   * То есть разминочный зачёт кладёт в мишень ровно ноль — и это правильно: за
   * пробу очки не идут. Но бой сессии обязан идти БЕЗ разминки, иначе человек
   * работает всерьёз, а числа не видит.
   *
   * Разминка выключается не флагом, а самим режимом: у ловца мишеней (`catch` —
   * режим боя по умолчанию) фазы разминки нет вовсе, раунд начинается сразу
   * зачётным. Здесь проверяется именно это: не «сейчас не разминка», а «в этом
   * режиме разминки не бывает».
   */
  const roundOf = (over = {}) =>
    createRound({
      ...configForTier('novice'),
      mode: 'catch',
      seed: 7,
      durationMs: 20000,
      // разминка включена в конфиге — и всё равно не должна начаться у ловца
      practiceNeeded: 2,
      ...over,
    })

  it('у ловца нет фазы разминки ни в один момент раунда', () => {
    const round = roundOf()
    const stand = pose()

    for (let t = 0; t <= 20000; t += 250) {
      for (const ev of round.update(t, stand)) {
        // судейское событие боя обязано быть зачётным: разминочное положило бы
        // в мишень ноль, и числа на экране не было бы вовсе
        if (ev.type === 'obstacle.clear' || ev.type === 'obstacle.miss') {
          expect(ev.practice).toBe(false)
        }
      }
      const state = round.getState()
      expect(state.mode).toBe('catch')
      expect(state.practice).toBe(false)
      expect(state.practiceMovement).toBeNull()
    }
  })

  it('а прежняя ротация движений разминку по-прежнему ведёт', () => {
    // контроль на то, что предыдущая проверка не проходит сама собой
    const round = roundOf({ mode: 'moves' })
    round.update(0, pose())
    expect(round.getState().practice).toBe(true)
  })
})
