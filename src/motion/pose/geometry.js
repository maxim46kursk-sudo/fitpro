/**
 * Геометрия: угол между тремя точками. Без зависимостей, чистые функции.
 */

const RAD_TO_DEG = 180 / Math.PI

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v
}

/**
 * Угол в градусах при вершине b, лучи ba и bc, в 3D.
 * Для worldLandmarks (метры) это самый честный вариант: нет искажения пропорций кадра.
 */
export function angleAt3D(a, b, c) {
  if (!a || !b || !c) return null

  const bax = a.x - b.x
  const bay = a.y - b.y
  const baz = (a.z ?? 0) - (b.z ?? 0)

  const bcx = c.x - b.x
  const bcy = c.y - b.y
  const bcz = (c.z ?? 0) - (b.z ?? 0)

  const lenBa = Math.hypot(bax, bay, baz)
  const lenBc = Math.hypot(bcx, bcy, bcz)
  if (lenBa === 0 || lenBc === 0) return null

  const cos = (bax * bcx + bay * bcy + baz * bcz) / (lenBa * lenBc)
  return Math.acos(clamp(cos, -1, 1)) * RAD_TO_DEG
}

/**
 * Угол в градусах при вершине b в плоскости кадра.
 * `aspect` = width / height: нормализованные landmark'и лежат в [0..1] по каждой оси,
 * поэтому без коррекции по x угол на неквадратном кадре врёт.
 */
export function angleAt2D(a, b, c, aspect = 1) {
  if (!a || !b || !c) return null

  const bax = (a.x - b.x) * aspect
  const bay = a.y - b.y
  const bcx = (c.x - b.x) * aspect
  const bcy = c.y - b.y

  const lenBa = Math.hypot(bax, bay)
  const lenBc = Math.hypot(bcx, bcy)
  if (lenBa === 0 || lenBc === 0) return null

  const cos = (bax * bcx + bay * bcy) / (lenBa * lenBc)
  return Math.acos(clamp(cos, -1, 1)) * RAD_TO_DEG
}

/** Скользящее среднее фиксированного окна. Возвращает новое значение среднего. */
export function createMovingAverage(windowSize = 3) {
  const buffer = []
  return {
    push(value) {
      buffer.push(value)
      if (buffer.length > windowSize) buffer.shift()
      let sum = 0
      for (const v of buffer) sum += v
      return sum / buffer.length
    },
    reset() {
      buffer.length = 0
    },
    get size() {
      return buffer.length
    },
  }
}

/**
 * СООТНОШЕНИЕ СТОРОН КАДРА для angleAt2D.
 *
 * Нормированные точки лежат в [0..1] по каждой оси независимо, то есть на
 * неквадратном кадре одна и та же нормированная величина по x и по y — это
 * разные расстояния в пикселях. Без поправки угол считается по искажённой
 * картинке, и чем дальше кадр от квадрата, тем сильнее врёт.
 *
 * Полевой случай: iPhone отдаёт ЛАНДШАФТНЫЙ кадр 640x480, Redmi — портретный
 * 480x640. Поправка у них не просто разная, а обратная друг другу (1.33 и
 * 0.75), и подставленная единица врёт на обоих.
 *
 * Мусор на входе — единица: не поправить хуже, чем поправить наугад.
 */
export function aspectOf(width, height) {
  return width > 0 && height > 0 ? width / height : 1
}
