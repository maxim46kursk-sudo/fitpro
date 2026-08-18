/**
 * 3D-СЛОЙ ПРЕПЯТСТВИЙ — стеклянные предметы между видео и игровым 2D-канвасом.
 *
 * Зачем третий подход к картинке. Восемнадцать своих плоских фигур человек не
 * выучивал; стена с вырезом требовала СОВПАСТЬ ТЕЛОМ, хотя засчитывается
 * движение; единая плита со стрелкой честна, но безлика. Стеклянный предмет
 * решает ту же задачу иначе: он занимает МЕСТО В ПРОСТРАНСТВЕ — балка над
 * головой, колонна сбоку, волна по полу, — и тело само понимает, что с ним
 * делать, без перевода через значок.
 *
 * Внешний вид портирован с docs/design/scene3d-reference.mjs: материал стекла
 * (MeshPhysicalMaterial с transmission), неоновое ядро внутри и мягкая тень на
 * полу. Оттуда же геометрия строителей и высоты предметов — числа не
 * пересчитывались, чтобы игра выглядела ровно как согласованный образец.
 *
 * ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ. Слой только рисует. Он не судит, не считает очки и не
 * знает про детекторы: время и список препятствий приходят снаружи ровно те же,
 * что и у 2D-слоя. Частицы, всплывающие очки, полоски и подписи остаются на
 * 2D-канвасе поверх — их сюда не переносили намеренно, чтобы отказ 3D не уносил
 * с собой ещё и обратную связь.
 *
 * ТРИ СТУПЕНИ И ОТКАЗ. Полный режим — стекло, блум, пиксельная плотность до
 * двух. Экономный (тот же флаг, что и у 2D) — плоский полупрозрачный материал
 * того же цвета, плотность 1, ни блума, ни хало. И если WebGL не создался или
 * отрисовка провалилась ниже 12 кадров в секунду в среднем за пять секунд —
 * слой выключается НАСОВСЕМ и уступает место 2D: телефон, который не тянет
 * стекло, будет не тянуть его и через минуту, а мигание режимов хуже простой
 * картинки. Про каждое такое переключение слой сообщает наружу, чтобы оно
 * попало в полевой лог.
 */

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

/** Пол сцены. Всё, что «на полу», отсчитывается от этой отметки. */
export const FLOOR_Y = -1.05

/**
 * Цвет — по ЗОНЕ ТЕЛА, как и у плоской плиты: голубой ноги, янтарь руки,
 * зелёный корпус, фиолетовый всё тело. Четыре цвета запоминаются, восемнадцать
 * оттенков нет.
 *
 * TINT — цвет затухания внутри стекла (им предмет и красится), NEON — цвет
 * ядра, которое светится внутри.
 */
const TINT = { legs: '#0f7f9e', arms: '#b87818', core: '#1d8a4e', full: '#6d28c9' }
const NEON = { legs: 0x7deaff, arms: 0xffd27a, core: 0x7dffb8, full: 0xc9a1ff }

/** Зачтённое золотится — тот же ответ «засчитано», что и зелёный у 2D-слоя. */
const CLEARED = { tint: '#c9922a', neon: 0xffe3a0 }

export const TYPE_ZONE = {
  barrier: 'legs',
  wall: 'legs',
  knee: 'legs',
  lunge: 'legs',
  heel: 'legs',
  pit: 'legs',
  jumpsquat: 'legs',
  hop: 'legs',
  legside: 'legs',
  sidelunge: 'legs',
  strike: 'arms',
  bird: 'arms',
  wings: 'arms',
  clap: 'arms',
  beam: 'core',
  bend: 'core',
  twistknee: 'core',
  jack: 'full',
}

/**
 * Сторона в мире сцены: слева от человека — слева на экране. Камера смотрит
 * человеку в лицо, а видео зеркалится (scaleX(-1)), поэтому его левая рука и
 * лежит в отрицательных x — там же, где 2D-слой рисует «левую» подпись.
 */
const dirOf = (side) => (side === 'left' ? -1 : 1)

/* --------------------------------------------------------------- материалы */

/**
 * Стекло. transmission вместо opacity — это не «полупрозрачный цвет», а
 * преломление: предмет виден по бликам и по искажению того, что за ним, и
 * поэтому читается даже поверх пёстрого видео с камеры.
 */
function glassMat(tint, rough) {
  return new THREE.MeshPhysicalMaterial({
    transmission: 1,
    thickness: 0.9,
    roughness: rough ?? 0.07,
    ior: 1.5,
    attenuationColor: new THREE.Color(tint),
    attenuationDistance: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    color: 0xffffff,
    metalness: 0,
    iridescence: 0.4,
    iridescenceIOR: 1.3,
    specularIntensity: 1,
    envMapIntensity: 0.7,
  })
}

/**
 * Экономная замена стеклу: тот же цвет, но плоско и полупрозрачно. Преломление
 * стоит целого прохода рендера — на слабом телефоне это и есть та разница,
 * из-за которой картинка начинает дёргаться.
 */
const flatMat = (tint) =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color(tint), transparent: true, opacity: 0.42 })

const neonMat = (color) => new THREE.MeshBasicMaterial({ color })

/** Есть ли из чего делать текстуры: в разборе и тестах холста может не быть. */
function texCanvas(size) {
  const doc = globalThis.document
  if (!doc?.createElement) return null
  const canvas = doc.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext?.('2d')
  return ctx ? { canvas, ctx } : null
}

/** Мягкое свечение вокруг предмета. Спрайт, потому что смотрит всегда в камеру. */
function haloSprite(color, size, x, y, z, opacity) {
  const made = texCanvas(256)
  if (!made) return null
  const { canvas, ctx } = made
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255,255,255,.9)')
  g.addColorStop(0.25, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      opacity: opacity ?? 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  sprite.scale.set(size, size, 1)
  sprite.position.set(x, y, z)
  return sprite
}

/**
 * Тень на полу. Не спрайт, а лежащая плоскость: спрайт всегда развёрнут к
 * камере, и тень от него стояла бы стеной. А тень нужна ровно за тем, чтобы
 * предмет не висел в пустоте — по ней видно, где он стоит и как приближается.
 */
function shadowMesh(width, depth, z, opacity) {
  const made = texCanvas(128)
  if (!made) return null
  const { canvas, ctx } = made
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(0,0,0,.85)')
  g.addColorStop(0.55, 'rgba(0,0,0,.35)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      opacity: opacity ?? 0.55,
      depthWrite: false,
    }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(0, FLOOR_Y + 0.012, z ?? 0.5)
  return mesh
}

/* --------------------------------------------------------------- строители */

/** Общая обвязка: стекло или плоская замена — решается одним местом. */
function makeSkin(kit, tint, rough) {
  return kit.cheap ? flatMat(tint) : glassMat(tint, rough)
}

function addHalo(group, kit, ...args) {
  if (kit.cheap) return
  const sprite = haloSprite(...args)
  if (sprite) group.add(sprite)
}

function addShadow(group, kit, width, depth, z, opacity) {
  const mesh = shadowMesh(width, depth, z, opacity)
  if (mesh) group.add(mesh)
}

/** Балка поперёк пути: над головой, под наклоном или у самого пола. */
function beamObj(kit, tint, neon, y, len, tilt) {
  const g = new THREE.Group()
  const beam = new THREE.Mesh(new RoundedBoxGeometry(len, 0.36, 0.42, 5, 0.17), makeSkin(kit, tint))
  beam.position.set(0, y, 0.5)
  beam.rotation.z = tilt || 0
  g.add(beam)
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, len * 0.94, 10), neonMat(neon))
  core.rotation.z = Math.PI / 2 + (tilt || 0)
  core.position.set(0, y, 0.5)
  g.add(core)
  addHalo(g, kit, 'rgba(120,220,255,.55)', 1.6, 0, y, 0.55, 0.35)
  addShadow(g, kit, len * 0.9, 1.2, 0.5, 0.4)
  return g
}

/** Волна-купол по полу: её перепрыгивают. */
function waveObj(kit, tint, neon) {
  const g = new THREE.Group()
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.15, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
    makeSkin(kit, tint),
  )
  dome.scale.set(1.5, 0.5, 0.8)
  dome.position.set(0, FLOOR_Y, 2.3)
  g.add(dome)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.018, 10, 70), neonMat(neon))
  ring.rotation.x = Math.PI / 2
  ring.position.set(0, FLOOR_Y + 0.03, 2.3)
  ring.scale.set(1.25, 1, 0.65)
  g.add(ring)
  addShadow(g, kit, 4.2, 2.4, 2.3, 0.45)
  return g
}

/** Сфера с ядром: её достают рукой или ногой. */
function orbObj(kit, tint, neon, x, y, r) {
  const g = new THREE.Group()
  const orb = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 36), makeSkin(kit, tint))
  orb.position.set(x, y, 0.35)
  g.add(orb)
  const core = new THREE.Mesh(new THREE.SphereGeometry(r * 0.38, 20, 20), neonMat(neon))
  core.position.set(x, y, 0.35)
  g.add(core)
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(r * 1.5, 0.012, 8, 60),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }),
  )
  ring.position.set(x, y, 0.35)
  ring.rotation.x = 1.1
  ring.rotation.y = 0.4
  g.add(ring)
  addHalo(g, kit, 'rgba(255,210,120,.5)', r * 5, x, y, 0.4, 0.4)
  return g
}

/** Колонна сбоку: от неё уходят шагом. */
function columnObj(kit, tint, neon, x) {
  const g = new THREE.Group()
  const col = new THREE.Mesh(new RoundedBoxGeometry(0.72, 2.6, 0.5, 5, 0.2), makeSkin(kit, tint))
  col.position.set(x, FLOOR_Y + 1.3, 0.4)
  g.add(col)
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 2.45, 10), neonMat(neon))
  core.position.set(x, FLOOR_Y + 1.3, 0.4)
  g.add(core)
  addShadow(g, kit, 1.6, 1.2, 0.4, 0.5)
  return g
}

/** Арка: под неё складываются к полу. */
function archObj(kit, tint, neon) {
  const g = new THREE.Group()
  const arch = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.17, 16, 44, Math.PI), makeSkin(kit, tint))
  arch.position.set(0, FLOOR_Y + 0.15, 0.8)
  g.add(arch)
  const core = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.02, 8, 44, Math.PI), neonMat(neon))
  core.position.set(0, FLOOR_Y + 0.16, 0.82)
  g.add(core)
  addShadow(g, kit, 3.4, 1.2, 0.8, 0.4)
  return g
}

/** Клин снизу: его перепрыгивают, разводя ноги. */
function wedgeObj(kit, tint, neon) {
  const g = new THREE.Group()
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.15, 4), makeSkin(kit, tint))
  cone.rotation.y = Math.PI / 4
  cone.position.set(0, FLOOR_Y + 0.58, 0.9)
  g.add(cone)
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), neonMat(neon))
  tip.position.set(0, FLOOR_Y + 1.18, 0.9)
  g.add(tip)
  addShadow(g, kit, 1.6, 1.2, 0.9, 0.5)
  return g
}

/** Плита на полу сбоку: на неё опускаются боковым выпадом. */
function slabObj(kit, tint, neon, x) {
  const g = new THREE.Group()
  const slab = new THREE.Mesh(new RoundedBoxGeometry(1.35, 0.16, 0.9, 5, 0.07), makeSkin(kit, tint))
  slab.position.set(x, FLOOR_Y + 0.09, 0.9)
  g.add(slab)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.014, 8, 40), neonMat(neon))
  ring.rotation.x = Math.PI / 2
  ring.position.set(x, FLOOR_Y + 0.19, 0.9)
  g.add(ring)
  return g
}

/** Гонг на подвесе: его достают рукой вверху. */
function bellObj(kit, tint, neon, x, y) {
  const g = new THREE.Group()
  const wire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 3, 6),
    new THREE.MeshBasicMaterial({ color: 0x8fa8bb, transparent: true, opacity: 0.5 }),
  )
  wire.position.set(x, y + 1.5, 0.3)
  g.add(wire)
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.34, 28, 28), makeSkin(kit, tint))
  bell.position.set(x, y, 0.3)
  g.add(bell)
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 16), neonMat(neon))
  core.position.set(x, y, 0.3)
  g.add(core)
  for (let i = 1; i <= 2; i += 1) {
    const arc = new THREE.Mesh(
      new THREE.TorusGeometry(0.34 + i * 0.14, 0.008, 6, 30, Math.PI * 0.7),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 - i * 0.15 }),
    )
    arc.position.set(x, y, 0.3)
    arc.rotation.z = Math.PI * 0.15
    g.add(arc)
  }
  return g
}

/** Столбик с кнопкой: её выбивают коленом. */
function pedestalObj(kit, tint, neon) {
  const g = new THREE.Group()
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.9, 16), makeSkin(kit, tint))
  col.position.set(0, FLOOR_Y + 0.45, 0.9)
  g.add(col)
  const btn = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 22, 22, 0, Math.PI * 2, 0, Math.PI / 2),
    neonMat(neon),
  )
  btn.position.set(0, FLOOR_Y + 0.9, 0.9)
  g.add(btn)
  addHalo(g, kit, 'rgba(120,220,255,.5)', 1, 0, FLOOR_Y + 0.95, 0.95, 0.4)
  addShadow(g, kit, 1.1, 0.9, 0.9, 0.5)
  return g
}

/** Рама-звезда: в неё вписываются всем телом. */
function starObj(kit, tint) {
  const shape = new THREE.Shape()
  const R = 1.5
  const r = 0.95
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2
    const rad = i % 2 ? r : R
    const x = Math.cos(a) * rad
    const y = Math.sin(a) * rad
    if (i) shape.lineTo(x, y)
    else shape.moveTo(x, y)
  }
  shape.closePath()
  const hole = new THREE.Path()
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2
    const rad = (i % 2 ? r : R) * 0.78
    const x = Math.cos(a) * rad
    const y = Math.sin(a) * rad
    if (i) hole.lineTo(x, y)
    else hole.moveTo(x, y)
  }
  hole.closePath()
  shape.holes.push(hole)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.22,
    bevelEnabled: true,
    bevelSize: 0.04,
    bevelThickness: 0.04,
  })
  const g = new THREE.Group()
  const star = new THREE.Mesh(geo, makeSkin(kit, tint))
  star.position.set(0, 0.45, 0.3)
  g.add(star)
  return g
}

/** Две сферы по бокам: до них дотягиваются разведёнными руками. */
function twinOrbs(kit, tint, neon, y, dx) {
  const g = new THREE.Group()
  for (const d of [-1, 1]) {
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 28, 28), makeSkin(kit, tint))
    orb.position.set(d * dx, y, 0.35)
    g.add(orb)
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 16), neonMat(neon))
    core.position.set(d * dx, y, 0.35)
    g.add(core)
  }
  return g
}

/** Две полусферы над головой: их сводят хлопком. */
function clapObj(kit, tint, neon) {
  const g = new THREE.Group()
  for (const d of [-1, 1]) {
    const half = new THREE.Mesh(new THREE.SphereGeometry(0.3, 26, 26, 0, Math.PI), makeSkin(kit, tint))
    half.position.set(d * 0.62, 2.15, 0.3)
    half.rotation.y = d > 0 ? Math.PI / 2 : -Math.PI / 2
    g.add(half)
  }
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), neonMat(neon))
  spark.position.set(0, 2.15, 0.3)
  g.add(spark)
  return g
}

/** Малая сфера на поясе и пунктир к ней: локоть идёт по диагонали. */
function diagOrb(kit, tint, neon, dir) {
  const g = new THREE.Group()
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 24), makeSkin(kit, tint))
  orb.position.set(dir * 0.55, 0.35, 0.5)
  g.add(orb)
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 14), neonMat(neon))
  core.position.set(dir * 0.55, 0.35, 0.5)
  g.add(core)
  for (let i = 0; i < 6; i += 1) {
    const t = i / 5
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
    )
    dot.position.set(dir * (-0.7 + 1.25 * t), 1.35 - 1 * t, 0.5)
    g.add(dot)
  }
  return g
}

/**
 * Каталог: тип препятствия -> из чего он собран. Восемнадцать записей, и
 * список полный намеренно — пропущенный тип означает НЕВИДИМОЕ препятствие,
 * а человек, бьющий в пустоту, в этом проекте уже был.
 */
export const CATALOG = {
  // ноги: всё, через что переступают, подо что подседают и от чего уходят
  barrier: (kit) => beamObj(kit, kit.tint, kit.neon, 1.34, 3.3),
  heel: (kit) => beamObj(kit, kit.tint, kit.neon, FLOOR_Y + 0.35, 3.2),
  lunge: (kit) => {
    const g = beamObj(kit, kit.tint, kit.neon, 0.6, 2.6)
    // широкая плита, а не балка: в выпаде уходят назад, и предмет должен
    // читаться как стена перед ногами
    g.children[0].scale.y = 2.6
    return g
  },
  wall: (kit) => columnObj(kit, kit.tint, kit.neon, kit.dir * 0.85),
  sidelunge: (kit) => slabObj(kit, kit.tint, kit.neon, kit.dir * 1.35),
  knee: (kit) => pedestalObj(kit, kit.tint, kit.neon),
  legside: (kit) => orbObj(kit, kit.tint, kit.neon, kit.dir * 1.5, FLOOR_Y + 0.5, 0.3),
  hop: (kit) => wedgeObj(kit, kit.tint, kit.neon),
  pit: (kit) => waveObj(kit, kit.tint, kit.neon),
  /**
   * Присед с прыжком — та же волна, но с балкой над ней: иначе он неотличим
   * от простого прыжка, у которого и зона та же, и цвет тот же. Балка и есть
   * то, ради чего сначала приседают.
   */
  jumpsquat: (kit) => {
    const g = new THREE.Group()
    g.add(waveObj(kit, kit.tint, kit.neon))
    g.add(beamObj(kit, kit.tint, kit.neon, 1.5, 3.3))
    return g
  },
  // корпус
  beam: (kit) => beamObj(kit, kit.tint, kit.neon, 1.5, 3.4, kit.dir * 0.3),
  bend: (kit) => archObj(kit, kit.tint, kit.neon),
  twistknee: (kit) => diagOrb(kit, kit.tint, kit.neon, kit.dir),
  // руки
  strike: (kit) => orbObj(kit, kit.tint, kit.neon, kit.dir * 1.42, 1.1, 0.4),
  bird: (kit) => bellObj(kit, kit.tint, kit.neon, kit.dir * 1.15, 2.35),
  wings: (kit) => twinOrbs(kit, kit.tint, kit.neon, 1.15, 1.5),
  clap: (kit) => clapObj(kit, kit.tint, kit.neon),
  // всё тело
  jack: (kit) => starObj(kit, kit.tint),
}

export const CATALOG_TYPES = Object.keys(CATALOG)

/**
 * Собрать предмет по типу препятствия.
 *
 * @param {string} type тип из движка
 * @param {string|null} side сторона движения, если она есть
 * @param {{cheap?: boolean}} [options] cheap — плоский материал вместо стекла
 * @returns {object|null} группа three или null, если тип неизвестен
 */
export function buildObstacle(type, side, options = {}) {
  const make = CATALOG[type]
  if (!make) return null
  const zone = TYPE_ZONE[type] ?? 'legs'
  const group = make({
    cheap: !!options.cheap,
    tint: TINT[zone],
    neon: NEON[zone],
    dir: dirOf(side),
  })
  group.userData.zone = zone
  return group
}

/**
 * Зачтено: предмет золотится. Материалы у каждого предмета свои (не общие на
 * тип), поэтому перекраска одного не трогает остальные — иначе позолота
 * расползлась бы на всё, что летит следом.
 */
export function markCleared(group) {
  group.userData.cleared = true
  group.traverse((node) => {
    const material = node.material
    if (!material || material.isSpriteMaterial) return
    if (material.attenuationColor) material.attenuationColor.set(CLEARED.tint)
    else if (material.color) material.color.set(material.isMeshBasicMaterial ? CLEARED.neon : CLEARED.tint)
    material.needsUpdate = true
  })
  return group
}

/** Освободить геометрию и материалы: их сборщик мусора сам не заберёт. */
function disposeTree(node) {
  node.traverse((child) => {
    child.geometry?.dispose?.()
    const material = child.material
    if (!material) return
    material.map?.dispose?.()
    material.dispose?.()
  })
}

/* ------------------------------------------------------------------- сцена */

/**
 * Камера образца: 50 градусов по вертикали при кадре 428x779.
 *
 * КАДР ДЕРЖИТСЯ ПО ШИРИНЕ, а не по высоте, и это не украшательство. Предметы
 * расставлены вширь — балка на 3.3 единицы, плита бокового выпада до 2.0 от
 * середины, — а телефоны уже образца: 390x844 это 0.46 против 0.55. При
 * неизменных 50 градусах полуширина кадра падает с 1.79 до 1.51, и боковые
 * предметы уезжают за край экрана. Поэтому на узком кадре угол РАСКРЫВАЕТСЯ
 * ровно настолько, чтобы по горизонтали было видно то же самое, что в образце.
 */
const REF_FOV = 50
const REF_ASPECT = 428 / 779
const REF_HALF_TAN = Math.tan((REF_FOV / 2) * (Math.PI / 180)) * REF_ASPECT

export const fovFor = (aspect) => {
  if (!(aspect > 0)) return REF_FOV
  if (aspect >= REF_ASPECT) return REF_FOV
  const half = Math.atan(REF_HALF_TAN / aspect) * (180 / Math.PI)
  return Math.min(75, half * 2)
}

/** Подлёт: из глубины к камере. Числа те же, что в образце. */
const Z_FAR = -4.4
const Z_NEAR = 0
const APPROACH_POW = 1.35

/** Сколько секунд подряд отрисовка должна проседать, чтобы слой сдался. */
const SLOW_WINDOW_MS = 5000
/** И ниже какого среднего fps. */
const SLOW_FPS = 12

/**
 * Создать слой. Ничего не рисует, пока не позовут render.
 *
 * @param {{canvas: object, onNotice?: Function}} options canvas — холст под
 *   WebGL; onNotice(reason, detail) зовётся при выключении слоя.
 */
export function createSpace3d({ canvas, onNotice, now } = {}) {
  /**
   * Часы сторожа — НАСТОЯЩИЕ, а не игровые. Игровые останавливаются, когда
   * человек вышел из кадра, и по ним просадка отрисовки не читалась бы вовсе.
   */
  const clock = now ?? (() => (globalThis.performance?.now?.() ?? Date.now()))
  const notice = (reason, detail) => {
    try {
      onNotice?.(reason, detail)
    } catch {
      // сообщать о беде — не повод устроить вторую
    }
  }

  let renderer = null
  let composer = null
  let bloom = null
  let scene = null
  let camera = null
  let world = null
  let active = false
  let cheapNow = null
  let width = 0
  let height = 0

  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    renderer.setClearAlpha(0)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.35
    renderer.outputColorSpace = THREE.SRGBColorSpace

    scene = new THREE.Scene()
    // окружение нужно самому стеклу: без него преломлять нечего и предмет
    // выглядит серым пузырём
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture
    scene.environmentIntensity = 0.45

    camera = new THREE.PerspectiveCamera(REF_FOV, 1, 0.1, 80)
    camera.position.set(0, 0.9, 7.5)
    camera.lookAt(0, 0.55, 0)

    const key = new THREE.DirectionalLight(0xfff2e0, 1.2)
    key.position.set(-4, 7, 5)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x6fd9ff, 1)
    rim.position.set(4, 3, -3)
    scene.add(rim)
    const fill = new THREE.PointLight(0x9b6bff, 18, 20)
    fill.position.set(-3, 2.5, 2)
    scene.add(fill)

    world = new THREE.Group()
    scene.add(world)
    active = true
  } catch (error) {
    // WebGL не создался — это не поломка, а телефон: играем на 2D
    active = false
    notice('no-webgl', { message: String(error?.message ?? error) })
  }

  /** Живые предметы: id препятствия -> что для него собрано. */
  const items = new Map()
  /** Замер отрисовки: кадры за окно, по ним же и решение отключиться. */
  let windowStart = null
  let framesInWindow = 0
  let fps = null

  const dropItem = (id) => {
    const item = items.get(id)
    if (!item) return
    world.remove(item.group)
    disposeTree(item.group)
    items.delete(id)
  }

  const clearAll = () => {
    for (const id of [...items.keys()]) dropItem(id)
  }

  const shutdown = (reason, detail) => {
    if (!active) return
    active = false
    clearAll()
    try {
      composer?.dispose?.()
      renderer?.dispose?.()
    } catch {
      // на выключении уже всё равно
    }
    // о снятии слоя сообщаем, о штатном закрытии экрана — нет: в логе нужны
    // отказы, а не выходы из игры
    if (reason !== 'disposed') notice(reason, detail)
  }

  const buildComposer = () => {
    if (!width || !height) return
    composer = new EffectComposer(renderer)
    composer.setSize(width, height)
    composer.addPass(new RenderPass(scene, camera))
    bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.45, 0.5, 0.88)
    composer.addPass(bloom)
  }

  return {
    /** Жив ли слой. Стал false — назад уже не включается, это решение навсегда. */
    get active() {
      return active
    },
    /** Средний fps отрисовки за последнее окно; null, пока нечего показать. */
    get fps() {
      return fps
    },
    get items() {
      return items
    },

    /**
     * Размер кадра в CSS-точках и плотность пикселей. Плотность режется до 1 в
     * экономном режиме: это самая дешёвая экономия из всех — вчетверо меньше
     * работы на том же кадре.
     */
    resize(nextWidth, nextHeight, dpr = 1) {
      if (!active || !(nextWidth > 0) || !(nextHeight > 0)) return
      width = nextWidth
      height = nextHeight
      renderer.setPixelRatio(Math.min(dpr, 2))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.fov = fovFor(camera.aspect)
      camera.updateProjectionMatrix()
      if (composer) {
        composer.setPixelRatio(Math.min(dpr, 2))
        composer.setSize(width, height)
      }
    },

    /**
     * Нарисовать кадр по тем же данным, что и 2D-слой.
     *
     * @param {{clockMs: number, obstacles: Array, cheap?: boolean}} frame
     */
    render({ clockMs, obstacles = [], cheap = false }) {
      if (!active) return false

      // смена ступени пересобирает предметы: материал у них разный, и подменить
      // его на лету дешевле не выйдет — предметов на экране два-три
      if (cheapNow !== cheap) {
        cheapNow = cheap
        clearAll()
        if (cheap) {
          composer?.dispose?.()
          composer = null
          bloom = null
        }
      }
      // блум собирается, когда стал известен размер: до первого resize собирать
      // его не из чего, а кадр рисовать уже надо
      if (!cheap && !composer && width > 0) buildComposer()

      const seen = new Set()
      for (const obstacle of obstacles) {
        const p = (clockMs - obstacle.spawnAt) / obstacle.travelMs
        if (p < 0) continue
        seen.add(obstacle.id)

        let item = items.get(obstacle.id)
        if (!item) {
          const group = buildObstacle(obstacle.type, obstacle.side, { cheap })
          if (!group) continue
          item = { group, cleared: false }
          items.set(obstacle.id, item)
          world.add(group)
        }

        if (!item.cleared && obstacle.status === 'cleared') {
          item.cleared = true
          markCleared(item.group)
        }

        const grow = Math.pow(Math.max(0, Math.min(p, 1)), APPROACH_POW)
        const scale = 0.35 + 0.65 * grow
        item.group.scale.set(scale, scale, 1)
        if (item.cleared) {
          // зачтённое улетает за камеру: человек видит, что предмет пройден,
          // а не просто исчез
          const age = obstacle.judgedAt == null ? 0 : (clockMs - obstacle.judgedAt) / 600
          item.group.position.z = 1.5 + Math.max(0, age) * 3
        } else {
          item.group.position.z = Z_FAR + (Z_NEAR - Z_FAR) * grow
        }
      }

      for (const id of [...items.keys()]) if (!seen.has(id)) dropItem(id)

      try {
        if (composer && !cheap) composer.render()
        else renderer.render(scene, camera)
      } catch (error) {
        shutdown('render-failed', { message: String(error?.message ?? error) })
        return false
      }

      // сторож производительности: считаем кадры за окно и один раз решаем
      const wall = clock()
      if (windowStart == null) windowStart = wall
      framesInWindow += 1
      const span = wall - windowStart
      if (span >= SLOW_WINDOW_MS) {
        fps = Math.round((framesInWindow / span) * 1000)
        windowStart = wall
        framesInWindow = 0
        if (fps < SLOW_FPS) shutdown('slow', { fps })
      }
      return active
    },

    dispose() {
      shutdown('disposed')
    },
  }
}
