import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_TYPES,
  TYPE_ZONE,
  buildObstacle,
  createSpace3d,
  fovFor,
  markCleared,
} from './space3d.js'

/**
 * 3D-слой препятствий. Проверяется не красота — её видно только глазами на
 * телефоне, — а три вещи, из-за которых картинка может молча пропасть:
 *
 *   у каждого из восемнадцати типов ЕСТЬ предмет (пропущенный тип — это
 *     невидимое препятствие, а человек, бьющий в пустоту, здесь уже был);
 *   зачёт МЕНЯЕТ материал (иначе «засчитано» никак не показано);
 *   без WebGL слой сдаётся СРАЗУ и сообщает об этом (иначе игра осталась бы
 *     без препятствий вовсе, вместо того чтобы вернуться к 2D).
 *
 * three здесь настоящая: она собирает геометрию и материалы без всякого
 * WebGL — холст нужен только на отрисовку, а её тут и не просят.
 */

/** Все типы препятствий движка — список отдельный от каталога нарочно. */
const TYPES = [
  'barrier',
  'wall',
  'beam',
  'strike',
  'knee',
  'bird',
  'pit',
  'lunge',
  'heel',
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

/** Собрать все цвета материалов дерева: по ним и видно смену состояния. */
function colorsOf(group) {
  const out = []
  group.traverse((node) => {
    const material = node.material
    if (!material) return
    if (material.attenuationColor) out.push(material.attenuationColor.getHex())
    else if (material.color) out.push(material.color.getHex())
  })
  return out
}

describe('каталог предметов', () => {
  it('на каждый тип препятствия есть свой предмет', () => {
    expect([...CATALOG_TYPES].sort()).toEqual([...TYPES].sort())
  })

  it('и у каждого назначена зона тела — от неё цвет', () => {
    for (const type of TYPES) {
      expect({ тип: type, зона: TYPE_ZONE[type] }).toEqual({
        тип: type,
        зона: expect.stringMatching(/^(legs|arms|core|full)$/),
      })
    }
  })

  for (const type of TYPES) {
    it(`${type}: предмет собирается и не пустой`, () => {
      const group = buildObstacle(type, 'left')
      expect(group).toBeTruthy()
      expect(group.children.length).toBeGreaterThan(0)
      // геометрия есть хотя бы у одного узла: пустая группа на экране никак
      // не выглядит, и заметить это можно было бы только в поле
      let meshes = 0
      group.traverse((node) => {
        if (node.geometry) meshes += 1
      })
      expect(meshes).toBeGreaterThan(0)
    })
  }

  it('неизвестный тип не роняет слой, а честно отдаёт пустоту', () => {
    expect(buildObstacle('нет-такого', null)).toBeNull()
  })

  it('парные движения зеркальны: сторона двигает предмет, а не только цвет', () => {
    const left = buildObstacle('wall', 'left')
    const right = buildObstacle('wall', 'right')
    const xOf = (g) => g.children[0].position.x

    expect(xOf(left)).toBeLessThan(0)
    expect(xOf(right)).toBeGreaterThan(0)
  })

  it('экономный режим меняет материал стекла на плоский', () => {
    const glass = buildObstacle('barrier', null, { cheap: false })
    const flat = buildObstacle('barrier', null, { cheap: true })

    expect(glass.children[0].material.transmission).toBe(1)
    expect(flat.children[0].material.transmission).toBeUndefined()
    expect(flat.children[0].material.transparent).toBe(true)
  })
})

describe('кадр держится по ширине', () => {
  /**
   * Предметы расставлены вширь, а телефоны уже образца (428x779). При
   * неизменном угле боковые предметы уезжали бы за край: полуширина кадра
   * падает с 1.79 до 1.51 мировых единиц. Проверяем, что по горизонтали видно
   * то же самое, что в образце, — на любом телефоне.
   */
  const halfWidthAt = (width, height, distance = 7) => {
    const aspect = width / height
    return Math.tan((fovFor(aspect) / 2) * (Math.PI / 180)) * aspect * distance
  }

  it('на узком экране угол раскрывается, и рамка остаётся образцовой', () => {
    const reference = halfWidthAt(428, 779)
    for (const [width, height] of [
      [390, 844],
      [360, 800],
      [430, 932],
    ]) {
      expect({ экран: `${width}x${height}`, полуширина: halfWidthAt(width, height).toFixed(2) }).toEqual(
        { экран: `${width}x${height}`, полуширина: reference.toFixed(2) },
      )
    }
  })

  it('на широком экране угол не сужается ниже образцового', () => {
    expect(fovFor(768 / 1024)).toBe(50)
    expect(fovFor(0)).toBe(50)
  })
})

describe('зачёт виден на самом предмете', () => {
  it('золотит материалы, а не только помечает флагом', () => {
    const group = buildObstacle('knee', 'right')
    const before = colorsOf(group)

    markCleared(group)

    expect(group.userData.cleared).toBe(true)
    expect(colorsOf(group)).not.toEqual(before)
  })

  it('позолота не расползается на соседние предметы', () => {
    // материалы у каждого предмета свои: общий материал покрасил бы и то,
    // что ещё летит, — то есть «засчитано» показалось бы там, где его нет
    const first = buildObstacle('strike', 'left')
    const second = buildObstacle('strike', 'left')
    const before = colorsOf(second)

    markCleared(first)

    expect(colorsOf(second)).toEqual(before)
  })
})

describe('отказ 3D — не поломка, а возврат к 2D', () => {
  /** Холст, который не отдаёт WebGL: ровно так ведёт себя старый телефон. */
  const deadCanvas = () => ({
    width: 400,
    height: 800,
    getContext: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
  })

  it('без WebGL слой не включается и говорит почему', () => {
    const onNotice = vi.fn()
    const layer = createSpace3d({ canvas: deadCanvas(), onNotice })

    expect(layer.active).toBe(false)
    expect(onNotice).toHaveBeenCalledTimes(1)
    expect(onNotice.mock.calls[0][0]).toBe('no-webgl')
  })

  it('выключенный слой молча ничего не рисует, а не падает', () => {
    const layer = createSpace3d({ canvas: deadCanvas(), onNotice: () => {} })

    expect(() =>
      layer.render({ clockMs: 100, obstacles: [{ id: 1, type: 'barrier', spawnAt: 0, travelMs: 2000 }] }),
    ).not.toThrow()
    expect(layer.render({ clockMs: 100, obstacles: [] })).toBe(false)
    expect(() => layer.resize(400, 800, 2)).not.toThrow()
    expect(() => layer.dispose()).not.toThrow()
  })

  it('штатное закрытие экрана в лог не сыплет', () => {
    // сообщать надо об ОТКАЗАХ: выход из игры отказом не является, и лог,
    // полный «3D выключен», перестают читать
    const onNotice = vi.fn()
    const layer = createSpace3d({ canvas: deadCanvas(), onNotice })
    onNotice.mockClear()

    layer.dispose()

    expect(onNotice).not.toHaveBeenCalled()
  })
})
