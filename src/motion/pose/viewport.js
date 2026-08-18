/**
 * Пересчёт координат landmark'ов в пиксели канваса.
 *
 * Кадр вписывается в контейнер по правилам `object-fit: contain` — то есть
 * целиком, с полями по краям. Это принципиально: `cover` обрезал бы края кадра,
 * а вместе с ними и часть человека. Пустые поля лучше потери обзора.
 *
 * Функции чистые, без DOM — чтобы проверять математику тестами.
 */

/**
 * @returns {{scale:number, dw:number, dh:number, ox:number, oy:number}|null}
 *   dw/dh — размер отрисованного кадра, ox/oy — отступы (поля) слева и сверху.
 */
export function fitContain(videoW, videoH, boxW, boxH) {
  if (!videoW || !videoH || !boxW || !boxH) return null

  const scale = Math.min(boxW / videoW, boxH / videoH)
  const dw = videoW * scale
  const dh = videoH * scale

  return {
    scale,
    dw,
    dh,
    ox: (boxW - dw) / 2,
    oy: (boxH - dh) / 2,
  }
}

/** Нормализованная координата landmark'а [0..1] -> пиксель контейнера. */
export function projectX(x, fit) {
  return fit.ox + x * fit.dw
}

export function projectY(y, fit) {
  return fit.oy + y * fit.dh
}

/**
 * Оценка минимальной дистанции: с какого расстояния человек влезает в кадр целиком.
 *
 * Поля зрения камеры веб-API не отдаёт вообще — ни в getCapabilities, ни где-либо
 * ещё. Поэтому горизонтальный угол приходится ЗАДАВАТЬ константой; 70° — типичная
 * фронталка смартфона. Число выводится в панель именно как оценка, вместе с
 * допущением, чтобы его можно было сверить с реальностью на устройстве.
 *
 * Ограничивает всегда вертикаль: человек стоит вертикально, а кадр у фронталки
 * почти всегда шире, чем выше.
 */
export const ASSUMED_HFOV_DEG = 70
/** Доля высоты кадра, которую должен занимать человек: с запасом на движение. */
export const TARGET_FILL = 0.85

export function estimateMinDistance(
  streamW,
  streamH,
  { personHeightM = 1.8, hfovDeg = ASSUMED_HFOV_DEG, fill = TARGET_FILL } = {},
) {
  if (!streamW || !streamH) return null

  const hfov = (hfovDeg * Math.PI) / 180
  // вертикальный угол выводится из горизонтального и соотношения сторон кадра
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (streamH / streamW))
  const distance = personHeightM / (2 * fill * Math.tan(vfov / 2))

  return {
    distanceM: distance,
    vfovDeg: (vfov * 180) / Math.PI,
    hfovDeg,
    personHeightM,
    fill,
  }
}

/** Соотношение сторон в читаемом виде: 1.333 -> "4:3". */
export function describeAspect(width, height) {
  if (!width || !height) return '—'
  const ratio = width / height
  const known = [
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [4 / 3, '4:3'],
    [3 / 4, '3:4'],
    [3 / 2, '3:2'],
    [2 / 3, '2:3'],
    [1, '1:1'],
  ]
  for (const [value, label] of known) {
    if (Math.abs(ratio - value) < 0.02) return label
  }
  return ratio.toFixed(2)
}
