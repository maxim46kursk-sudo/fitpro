/**
 * ЧЕЛОВЕК, КОТОРОГО ВИДИТ КАМЕРА. Рисуется в браузере, в холст подставного
 * видеопотока.
 *
 * Зачем вообще рисовать тело, а не подавать готовые точки. Прогон должен идти
 * через ВЕСЬ конвейер: захват кадра, распознавание, судейство, отрисовка. Отдай
 * мы судье готовые позы — прогон перепрыгнул бы захват и распознавание, то есть
 * ровно те две стадии, в которых замедление и живёт. Значит на вход обязана
 * приходить КАРТИНКА, и распознавать её должна настоящая модель.
 *
 * ПОЧЕМУ НЕ ПАЛОЧНЫЙ ЧЕЛОВЕЧЕК. Модель обучена на фотографиях людей и на схему
 * из линий не отзывается: детектор не находит человека вовсе, кадр уходит
 * пустым, и прогон меряет конвейер, по которому ничего не течёт. Поэтому здесь
 * заполненное тело: голова с лицом и волосами, шея, футболка поверх корпуса и
 * плеч, шорты, кожа на предплечьях и голенях, тень под ногами и комната на
 * фоне. Это не украшательство — это то, без чего распознавание молчит.
 *
 * ТОЧКИ ПРИХОДЯТ ГОТОВЫМИ, в пикселях кадра. Откуда они взялись — забота
 * persona.js; здесь только рисование.
 */

/** Порядок точек тот же, что в debug/demoLoops.json. */
export const J = {
  NOSE: 0,
  L_SHOULDER: 1,
  R_SHOULDER: 2,
  L_ELBOW: 3,
  R_ELBOW: 4,
  L_WRIST: 5,
  R_WRIST: 6,
  L_HIP: 7,
  R_HIP: 8,
  L_KNEE: 9,
  R_KNEE: 10,
  L_ANKLE: 11,
  R_ANKLE: 12,
}

const SKIN = '#c98d63'
const SKIN_DARK = '#a9714c'
const SHIRT = '#3f6fb5'
const SHIRT_DARK = '#2f558c'
const SHORTS = '#2d3340'
const HAIR = '#2b2119'

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * Конечность как сужающаяся к концу колбаса.
 *
 * Именно заливкой, а не толстой линией: у линии с круглыми концами оба конца
 * одинаковой толщины, и предплечье выходит той же ширины, что и плечо. Модель
 * на такие пропорции реагирует хуже — на человеке конечность сужается.
 */
function limb(ctx, a, b, wA, wB, fill) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len

  ctx.beginPath()
  ctx.moveTo(a[0] + nx * wA, a[1] + ny * wA)
  ctx.lineTo(b[0] + nx * wB, b[1] + ny * wB)
  ctx.arc(b[0], b[1], wB, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false)
  ctx.lineTo(a[0] - nx * wA, a[1] - ny * wA)
  ctx.arc(a[0], a[1], wA, Math.atan2(-ny, -nx), Math.atan2(ny, nx), false)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
}

/**
 * КОМНАТА НА ФОНЕ. Ровная заливка — плохой фон: у модели пропадает опора для
 * оценки масштаба, а у нас — уверенность, что распознаётся тело, а не
 * единственное пятно в кадре. Рисуется один раз в отдельный холст и дальше
 * только копируется: шум по пикселям на каждом кадре стоил бы дороже всего
 * остального вместе взятого.
 */
export function makeBackdrop(width, height, doc = document) {
  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  const wall = ctx.createLinearGradient(0, 0, 0, height)
  wall.addColorStop(0, '#d8d2c6')
  wall.addColorStop(1, '#b3ab9c')
  ctx.fillStyle = wall
  ctx.fillRect(0, 0, width, height)

  // пол: линия горизонта даёт модели низ сцены
  const floorY = height * 0.86
  const floor = ctx.createLinearGradient(0, floorY, 0, height)
  floor.addColorStop(0, '#8d7b63')
  floor.addColorStop(1, '#6d5e4b')
  ctx.fillStyle = floor
  ctx.fillRect(0, floorY, width, height - floorY)

  // дверной проём и плинтус — чтобы в кадре было хоть что-то кроме человека
  ctx.fillStyle = 'rgba(0,0,0,0.10)'
  ctx.fillRect(width * 0.06, height * 0.18, width * 0.16, floorY - height * 0.18)
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  ctx.fillRect(0, floorY - height * 0.012, width, height * 0.012)

  // зерно: без него кадр слишком «чистый» для камеры
  const grain = ctx.getImageData(0, 0, width, height)
  const px = grain.data
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 14
    px[i] += n
    px[i + 1] += n
    px[i + 2] += n
  }
  ctx.putImageData(grain, 0, 0)

  return canvas
}

/**
 * Нарисовать кадр: фон и человека по точкам.
 *
 * @param {CanvasRenderingContext2D} ctx куда рисуем
 * @param {Array<[number, number]>} p 13 точек в пикселях кадра
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.backdrop заранее нарисованная комната
 * @param {number} opts.width
 * @param {number} opts.height
 */
export function drawFigure(ctx, p, { backdrop, width, height }) {
  ctx.drawImage(backdrop, 0, 0, width, height)

  const shoulders = mid(p[J.L_SHOULDER], p[J.R_SHOULDER])
  const hips = mid(p[J.L_HIP], p[J.R_HIP])
  const torso = dist(shoulders, hips) || height * 0.2
  // все толщины — от длины корпуса: тело обязано оставаться пропорциональным
  // на любом расстоянии от камеры
  const u = torso / 100

  // --- тень под ногами: без неё фигура висит в воздухе ---
  const feet = mid(p[J.L_ANKLE], p[J.R_ANKLE])
  ctx.save()
  ctx.globalAlpha = 0.28
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.ellipse(feet[0], feet[1] + 6 * u, torso * 0.55, torso * 0.11, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // --- дальняя сторона (правая половина тела уходит за корпус) ---
  limb(ctx, p[J.R_HIP], p[J.R_KNEE], 17 * u, 13 * u, SHORTS)
  limb(ctx, p[J.R_KNEE], p[J.R_ANKLE], 13 * u, 8 * u, SKIN_DARK)
  limb(ctx, p[J.R_SHOULDER], p[J.R_ELBOW], 12 * u, 9 * u, SHIRT_DARK)
  limb(ctx, p[J.R_ELBOW], p[J.R_WRIST], 9 * u, 6 * u, SKIN_DARK)

  // --- корпус: футболка от плеч до таза ---
  ctx.beginPath()
  ctx.moveTo(p[J.L_SHOULDER][0], p[J.L_SHOULDER][1])
  ctx.lineTo(p[J.R_SHOULDER][0], p[J.R_SHOULDER][1])
  ctx.lineTo(p[J.R_HIP][0], p[J.R_HIP][1])
  ctx.lineTo(p[J.L_HIP][0], p[J.L_HIP][1])
  ctx.closePath()
  const shirt = ctx.createLinearGradient(shoulders[0], shoulders[1], hips[0], hips[1])
  shirt.addColorStop(0, SHIRT)
  shirt.addColorStop(1, SHIRT_DARK)
  ctx.fillStyle = shirt
  ctx.fill()
  // плечи и таз скруглены: угловатый корпус читается как предмет, а не тело
  ctx.beginPath()
  ctx.ellipse(shoulders[0], shoulders[1], torso * 0.34, torso * 0.19, 0, 0, Math.PI * 2)
  ctx.fillStyle = SHIRT
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(hips[0], hips[1], torso * 0.29, torso * 0.17, 0, 0, Math.PI * 2)
  ctx.fillStyle = SHORTS
  ctx.fill()

  // --- ближняя сторона ---
  limb(ctx, p[J.L_HIP], p[J.L_KNEE], 18 * u, 14 * u, SHORTS)
  limb(ctx, p[J.L_KNEE], p[J.L_ANKLE], 14 * u, 8 * u, SKIN)
  limb(ctx, p[J.L_SHOULDER], p[J.L_ELBOW], 13 * u, 10 * u, SHIRT)
  limb(ctx, p[J.L_ELBOW], p[J.L_WRIST], 10 * u, 6 * u, SKIN)

  // кисти и стопы: концы конечностей модель ищет отдельно
  for (const w of [p[J.L_WRIST], p[J.R_WRIST]]) {
    ctx.beginPath()
    ctx.arc(w[0], w[1], 7 * u, 0, Math.PI * 2)
    ctx.fillStyle = SKIN
    ctx.fill()
  }
  for (const a of [p[J.L_ANKLE], p[J.R_ANKLE]]) {
    ctx.beginPath()
    ctx.ellipse(a[0], a[1] + 4 * u, 11 * u, 6 * u, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#2a2a2e'
    ctx.fill()
  }

  // --- шея и голова ---
  const nose = p[J.NOSE]
  const headR = torso * 0.26
  const neck = [shoulders[0] * 0.35 + nose[0] * 0.65, shoulders[1] * 0.55 + nose[1] * 0.45]
  limb(ctx, shoulders, neck, 13 * u, 10 * u, SKIN)

  ctx.save()
  ctx.translate(nose[0], nose[1])
  // голова наклоняется вместе с линией «таз -> нос»
  ctx.rotate(Math.atan2(nose[0] - hips[0], hips[1] - nose[1]))
  ctx.beginPath()
  ctx.ellipse(0, -headR * 0.15, headR * 0.78, headR, 0, 0, Math.PI * 2)
  ctx.fillStyle = SKIN
  ctx.fill()
  // волосы
  ctx.beginPath()
  ctx.ellipse(0, -headR * 0.55, headR * 0.8, headR * 0.6, 0, Math.PI, Math.PI * 2)
  ctx.fillStyle = HAIR
  ctx.fill()
  // лицо: детектор позы опирается на голову сильнее, чем кажется
  ctx.fillStyle = '#2a1d14'
  ctx.beginPath()
  ctx.ellipse(-headR * 0.3, -headR * 0.12, headR * 0.1, headR * 0.07, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(headR * 0.3, -headR * 0.12, headR * 0.1, headR * 0.07, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = SKIN_DARK
  ctx.lineWidth = Math.max(1, headR * 0.08)
  ctx.beginPath()
  ctx.arc(0, headR * 0.18, headR * 0.3, 0.25 * Math.PI, 0.75 * Math.PI)
  ctx.stroke()
  ctx.restore()
}
