/**
 * Тема «Космос» — вся отрисовка игрового слоя. Отдельно от таймлайна: по ТЗ
 * механика одна, а тем четыре (раздел 4), меняться будет этот файл, а не engine.
 *
 * Задача картинки одна — ощущение полёта от первого лица. Оно держится на двух
 * вещах: звёзды разлетаются из точки схода навстречу зрителю, а барьер вырастает
 * от этой же точки и в момент пролёта уходит за нижний край — так выглядит всё,
 * что проходит ниже линии глаз.
 *
 * Только canvas-геометрия: градиенты, линии, свечение. Ни картинок, ни 3D —
 * телефон в этот же момент крутит нейросеть, и рисование не имеет права
 * претендовать на его время.
 *
 * Отсюда же экономный режим. Полевой тест на слабом андроиде: картинка дёргалась
 * так, будто вот-вот зависнет. Дороже всего обходятся мягкие тени (shadowBlur) —
 * их на кадр набирается больше десятка, и на слабом GPU каждая стоит как всё
 * остальное вместе. В экономном режиме тени выключены, звёзд меньше, а заливки
 * градиентом заменены на плоские. Геометрия и правила игры при этом те же.
 */

import WALL_POSES from './wallPoses.json'

/** Мягкая тень — самая дорогая операция в этом файле. */
function glow(ctx, blur, color, cheap) {
  ctx.shadowBlur = cheap ? 0 : blur
  ctx.shadowColor = color
}

/** Псевдослучайное 0..1 без Math.random: картинка воспроизводима. */
function hash01(n, salt) {
  const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Точка схода: чуть выше середины, под ней остаётся место человеку в кадре. */
const HORIZON = 0.44

export function createStarfield(count = 130) {
  const stars = []
  for (let i = 0; i < count; i += 1) {
    stars.push({
      seed: i,
      gen: 0,
      angle: hash01(i, 3) * Math.PI * 2,
      // разная начальная удалённость — иначе первый кадр выглядит залпом
      dist: 0.04 + hash01(i, 5) * 0.96,
      prevDist: 0,
      speed: 0.7 + hash01(i, 7) * 0.9,
      size: 0.7 + hash01(i, 11) * 1.4,
    })
  }
  return stars
}

/**
 * Звёзды ускоряются к краям: вблизи точки схода объект почти неподвижен,
 * у края проносится. Это и есть вся перспектива.
 */
export function updateStarfield(stars, dtMs, boost = 1) {
  for (const s of stars) {
    s.prevDist = s.dist
    s.dist += (0.00007 + s.dist * s.dist * 0.0022) * s.speed * boost * dtMs
    if (s.dist > 1.35) {
      s.gen += 1
      s.angle = hash01(s.seed, 13 + s.gen) * Math.PI * 2
      s.dist = 0.02 + hash01(s.seed, 17 + s.gen) * 0.05
      s.prevDist = s.dist
    }
  }
  return stars
}

/** Проскочил — искры вдоль кромки, под которой поднырнули. */
export function burstForObstacle(width, height, seed = 1, count = 28) {
  const parts = []
  for (let i = 0; i < count; i += 1) {
    const x = (0.08 + 0.84 * (i / (count - 1))) * width
    const spread = (hash01(seed + i, 19) - 0.5) * 0.5
    parts.push({
      x,
      y: height * 0.78,
      vx: spread * 0.5,
      vy: -(0.14 + hash01(seed + i, 23) * 0.26),
      life: 620,
      maxLife: 620,
    })
  }
  return parts
}

/** Двигает частицы и выбрасывает погасшие. Список меняется на месте. */
export function updateParticles(parts, dtMs) {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i]
    p.life -= dtMs
    if (p.life <= 0) {
      parts.splice(i, 1)
      continue
    }
    p.x += p.vx * dtMs
    p.y += p.vy * dtMs
    p.vy += 0.00035 * dtMs
  }
  return parts
}

/**
 * Числа «+очки» здесь больше не живут.
 *
 * Их было два комплекта: этот и слой мишеней (targets.js). Рисовался ровно один
 * из двух, и в формате по умолчанию — «человек герой» — это был НЕ этот: сюда
 * приходил пустой список, а объекты копились впустую. Число теперь одно, в
 * targets.js, и классический режим зовёт тот же проход (см. GameScreen).
 */

/**
 * Затемнение и свечение горизонта рисует не canvas, а CSS-слой под ним
 * (.mt-game__sky): это два полноэкранных градиента, и перерисовывать их каждый
 * кадр на слабом телефоне непозволительно — композитор делает это один раз.
 */

function drawStarfield(ctx, stars, width, height, cheap) {
  const cx = width / 2
  const cy = height * HORIZON
  const reach = Math.hypot(width, height) * 0.62
  // на слабом телефоне треть звёзд: ощущение полёта держится, работы втрое меньше
  const count = cheap ? Math.ceil(stars.length / 3) : stars.length

  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#dfe9ff'

  if (cheap) {
    // все звёзды одним путём: один stroke вместо полусотни. Толщина и яркость
    // общие — на слабом телефоне разницы всё равно не видно
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1.6
    ctx.beginPath()
    for (let i = 0; i < count; i += 1) {
      const s = stars[i]
      const cos = Math.cos(s.angle)
      const sin = Math.sin(s.angle)
      const tail = Math.max(s.prevDist, s.dist - 0.02)
      ctx.moveTo(cx + cos * tail * reach, cy + sin * tail * reach)
      ctx.lineTo(cx + cos * s.dist * reach, cy + sin * s.dist * reach)
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  for (let i = 0; i < count; i += 1) {
    const s = stars[i]
    const cos = Math.cos(s.angle)
    const sin = Math.sin(s.angle)
    const x = cx + cos * s.dist * reach
    const y = cy + sin * s.dist * reach
    // хвост тем длиннее, чем ближе звезда — это и читается как скорость
    const tail = Math.max(s.prevDist, s.dist - 0.02)
    const px = cx + cos * tail * reach
    const py = cy + sin * tail * reach

    ctx.globalAlpha = clamp01(0.15 + s.dist * 1.2)
    ctx.lineWidth = s.size * (0.5 + s.dist * 1.6)
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(x, y)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Общая для всех препятствий геометрия подлёта: 0 — далеко у точки схода,
 * 1 — момент пролёта, дальше короткий хвост ухода из кадра.
 */
function approach(obstacle, clockMs) {
  const p = (clockMs - obstacle.spawnAt) / obstacle.travelMs
  // Зачтённое сразу зеленеет — это и есть ответ на «как оно засчитывается»:
  // человек видит момент зачёта на самом препятствии, а не гадает по очкам.
  const done = obstacle.status === 'cleared'
  return {
    p,
    done,
    // степень, а не прямая: у горизонта объект почти стоит, у зрителя проносится
    k: Math.pow(Math.min(Math.max(p, 0), 1.5), 2.2),
    alpha: p <= 1 ? 1 : clamp01(1 - (p - 1) / 0.3),
    // голубой вдали -> тревожный розовый вблизи (через фиолетовый, а не через зелёный)
    hue: done ? 145 : 205 + 125 * clamp01(p),
  }
}

/**
 * Барьер сверху. Далеко — узкая полоска у точки схода, ближе — растёт и опускается,
 * потому что его нижняя кромка ниже линии глаз. На пролёте уходит за нижний край:
 * если человек присел, барьер прошёл над ним.
 */
function drawBarrier(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const horizon = height * HORIZON
  const y = horizon + (height * 1.22 - horizon) * k
  const halfW = width * (0.035 + 1.15 * k)
  const thick = height * (0.006 + 0.125 * k)
  const top = y - thick / 2
  const left = width / 2 - halfW

  ctx.save()
  ctx.globalAlpha = alpha

  const body = ctx.createLinearGradient(0, top, 0, top + thick)
  body.addColorStop(0, `hsla(${hue}, 90%, 30%, 0.55)`)
  body.addColorStop(1, `hsla(${hue}, 100%, 62%, 0.95)`)
  ctx.fillStyle = body
  glow(ctx, 30 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)
  ctx.fillRect(left, top, halfW * 2, thick)

  // нижняя кромка — то, подо что надо поднырнуть
  ctx.shadowBlur = cheap ? 0 : 24
  ctx.strokeStyle = `hsla(${hue}, 100%, 82%, 0.95)`
  ctx.lineWidth = Math.max(2, thick * 0.16)
  ctx.beginPath()
  ctx.moveTo(left, top + thick)
  ctx.lineTo(left + halfW * 2, top + thick)
  ctx.stroke()

  ctx.restore()

  drawDepthGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, 'ПОДСЯДЬ!', {
    p,
    alpha,
    cheap,
    x: width / 2,
    y: height * 0.2,
    width,
    height,
  })
}

/**
 * Полоска глубины приседа — то же, что полоска смещения у стены, только снизу
 * по центру: она показывает, насколько человек уже подсел и когда хватит.
 * Без неё присед был единственным движением вообще без обратной связи.
 */
function drawDepthGauge(ctx, obstacle, clockMs, width, height, alpha, cheap) {
  const progress = obstacle.progress
  if (progress == null) return

  const done = progress >= 1
  const y = height * 0.9
  const half = width * 0.28
  const thick = Math.max(8, height * 0.012)
  const pulse = done ? 0.75 + 0.25 * Math.sin(clockMs / 90) : 1

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'

  ctx.strokeStyle = 'rgba(210, 230, 255, 0.22)'
  ctx.lineWidth = thick
  ctx.beginPath()
  ctx.moveTo(width / 2 - half, y)
  ctx.lineTo(width / 2 + half, y)
  ctx.stroke()

  if (progress > 0) {
    const hue = done ? 145 : 48
    ctx.globalAlpha = alpha * pulse
    ctx.strokeStyle = `hsla(${hue}, 100%, 62%, 0.95)`
    glow(ctx, done ? 26 : 12, `hsla(${hue}, 100%, 55%, ${done ? 0.95 : 0.75})`, cheap)
    ctx.beginPath()
    ctx.moveTo(width / 2 - half, y)
    ctx.lineTo(width / 2 - half + 2 * half * clamp01(progress), y)
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * Полоска смещения у стены — единственная обратная связь во время уворота.
 * Полевой тест: человек шагал и не понимал, хватило или нет, потому что узнавал
 * это только по факту пролёта. Полоска заполняется по мере ухода от базы к
 * зачётному порогу, а на пороге вспыхивает зелёным — «уже хватит» видно, не
 * читая слов и не глядя на цифры.
 */
function drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap) {
  const progress = obstacle.progress
  if (progress == null) return

  // ушёл шагом вместо наклона — полоска не зеленеет, сколько ни наклоняйся
  const blocked = !!obstacle.blocked
  const done = progress >= 1 && !blocked
  const x = obstacle.side === 'left' ? width * 0.055 : width * 0.945
  const top = height * 0.3
  const bottom = height * 0.66
  const thick = Math.max(8, width * 0.022)
  const filled = (bottom - top) * clamp01(progress)
  // вспышка на пороге: заметна боковым зрением, а на неё как раз и смотрят
  const pulse = done ? 0.75 + 0.25 * Math.sin(clockMs / 90) : 1

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'

  ctx.strokeStyle = 'rgba(210, 230, 255, 0.22)'
  ctx.lineWidth = thick
  ctx.beginPath()
  ctx.moveTo(x, bottom)
  ctx.lineTo(x, top)
  ctx.stroke()

  if (filled > 0) {
    ctx.globalAlpha = alpha * pulse
    // красный — «так не считается», зелёный — «хватит», жёлтый — «ещё немного»
    const hue = blocked ? 2 : done ? 145 : 48
    ctx.strokeStyle = `hsla(${hue}, 100%, 62%, 0.95)`
    glow(ctx, done ? 26 : 12, `hsla(${hue}, 100%, 55%, ${done ? 0.95 : 0.75})`, cheap)
    ctx.lineWidth = thick
    ctx.beginPath()
    ctx.moveTo(x, bottom)
    ctx.lineTo(x, bottom - filled)
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * Стена сбоку. Далеко — узкий клин у точки схода, ближе — расходится к своему
 * краю экрана и вырастает за его пределы: так выглядит всё, что проносится
 * мимо плеча. Свободная половина экрана остаётся пустой — туда и надо шагнуть.
 */
function drawWall(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1

  // дальняя кромка почти не движется, ближняя уезжает за край — это и есть скорость
  const farX = cx + dir * width * (0.03 + 0.3 * k)
  const nearX = cx + dir * width * (0.07 + 1.7 * k)
  const farHalfH = height * (0.03 + 0.4 * k)
  const nearHalfH = height * (0.05 + 1.5 * k)

  ctx.save()
  ctx.globalAlpha = alpha

  const body = ctx.createLinearGradient(farX, 0, nearX, 0)
  body.addColorStop(0, `hsla(${hue}, 90%, 32%, 0.5)`)
  body.addColorStop(1, `hsla(${hue}, 100%, 60%, 0.92)`)
  ctx.fillStyle = body
  glow(ctx, 30 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)

  ctx.beginPath()
  ctx.moveTo(farX, horizon - farHalfH)
  ctx.lineTo(nearX, horizon - nearHalfH)
  ctx.lineTo(nearX, horizon + nearHalfH)
  ctx.lineTo(farX, horizon + farHalfH)
  ctx.closePath()
  ctx.fill()

  // внутренняя кромка — граница, за которую нельзя заходить
  ctx.shadowBlur = cheap ? 0 : 22
  ctx.strokeStyle = `hsla(${hue}, 100%, 84%, 0.95)`
  ctx.lineWidth = Math.max(2, width * 0.006)
  ctx.beginPath()
  ctx.moveTo(farX, horizon - farHalfH)
  ctx.lineTo(nearX, horizon - nearHalfH)
  ctx.moveTo(farX, horizon + farHalfH)
  ctx.lineTo(nearX, horizon + nearHalfH)
  ctx.stroke()

  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  // пока стена далеко — куда шагать. Ближе подпись не нужна: уже видно глазами
  drawCallout(ctx, obstacle.side === 'left' ? 'ВПРАВО!' : 'ВЛЕВО!', {
    p,
    alpha,
    cheap,
    x: cx - dir * width * 0.24,
    y: horizon,
    width,
    height,
  })
}

/**
 * Балка: нависает по диагонали со своей стороны. Там она опускается ниже линии
 * глаз, а к свободной стороне уходит вверх — под этот подъём и надо увести
 * корпус, не сходя с места.
 */
function drawBeam(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1

  // со стороны балки — низкий конец, со свободной — высокий
  const lowX = cx + dir * width * (0.1 + 1.3 * k)
  const lowY = horizon + height * (0.02 + 0.55 * k)
  const highX = cx - dir * width * (0.1 + 1.3 * k)
  const highY = horizon - height * (0.1 + 0.95 * k)
  const thick = height * (0.012 + 0.12 * k)

  ctx.save()
  ctx.globalAlpha = alpha

  const body = ctx.createLinearGradient(lowX, lowY, highX, highY)
  body.addColorStop(0, `hsla(${hue}, 100%, 60%, 0.95)`)
  body.addColorStop(1, `hsla(${hue}, 90%, 34%, 0.55)`)
  ctx.strokeStyle = body
  ctx.lineWidth = thick
  ctx.lineCap = 'butt'
  glow(ctx, 30 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)
  ctx.beginPath()
  ctx.moveTo(lowX, lowY)
  ctx.lineTo(highX, highY)
  ctx.stroke()

  // светлая кромка снизу — то, подо что уходит корпус
  ctx.shadowBlur = cheap ? 0 : 18
  ctx.strokeStyle = `hsla(${hue}, 100%, 85%, 0.9)`
  ctx.lineWidth = Math.max(2, thick * 0.14)
  ctx.beginPath()
  ctx.moveTo(lowX, lowY + thick / 2)
  ctx.lineTo(highX, highY + thick / 2)
  ctx.stroke()

  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, obstacle.side === 'left' ? 'НАКЛОН ВПРАВО!' : 'НАКЛОН ВЛЕВО!', {
    p,
    alpha,
    cheap,
    x: cx - dir * width * 0.2,
    y: horizon + height * 0.16,
    width,
    height,
  })
}

/** Подсказка направления. Живёт, пока препятствие далеко, и гаснет к пролёту. */
function drawCallout(ctx, text, { p, alpha, x, y, width, height, cheap = false }) {
  if (p >= 0.62) return
  const fade = clamp01((0.62 - p) / 0.2)
  const base = Math.min(width, height)
  const size = Math.round(base * (text.length > 8 ? 0.052 : 0.075))

  ctx.save()
  ctx.globalAlpha = fade * alpha
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
  glow(ctx, 24, 'rgba(120, 220, 255, 0.9)', cheap)
  ctx.fillStyle = '#eaf6ff'
  // подпись стоит на свободной стороне и называет её же
  ctx.fillText(text, x, y)
  ctx.restore()
}

/**
 * Астероид: глыба на уровне груди со своей стороны. Вдали точка у горизонта,
 * вблизи — камень в полэкрана. Бить надо рукой той же стороны, поэтому он и
 * висит там, куда рука дотягивается, а не в центре.
 */
function drawAsteroid(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1
  const x = cx + dir * width * (0.04 + 0.55 * k)
  // грудь чуть ниже линии глаз, поэтому цель опускается по мере подлёта
  const y = horizon + height * (0.01 + 0.18 * k)
  const r = Math.min(width, height) * (0.018 + 0.34 * k)

  ctx.save()
  ctx.globalAlpha = alpha
  glow(ctx, 30 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)

  const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
  body.addColorStop(0, `hsla(${hue}, 100%, 68%, 0.95)`)
  body.addColorStop(1, `hsla(${hue}, 90%, 26%, 0.9)`)
  ctx.fillStyle = body

  // рваный контур: восемь вершин с постоянным для этой глыбы разбросом
  ctx.beginPath()
  const points = 8
  for (let i = 0; i <= points; i += 1) {
    const a = (Math.PI * 2 * i) / points
    const jag = r * (0.78 + 0.32 * hash01(obstacle.id * 7 + i, 29))
    const px = x + Math.cos(a) * jag
    const py = y + Math.sin(a) * jag
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()

  ctx.shadowBlur = 0
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 88 : 80}%, 0.9)`
  ctx.lineWidth = Math.max(2, r * 0.08)
  ctx.stroke()
  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, obstacle.side === 'left' ? 'БЕЙ ЛЕВОЙ!' : 'БЕЙ ПРАВОЙ!', {
    p,
    alpha,
    cheap,
    x: cx + dir * width * 0.24,
    y: horizon - height * 0.14,
    width,
    height,
  })
}

/**
 * Кольцо снизу: плывёт от горизонта к нижнему краю со своей стороны от центра.
 * Пробивается коленом той же ноги, поэтому и держится на её половине.
 */
function drawRing(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1
  const x = cx + dir * width * (0.03 + 0.3 * k)
  // идёт снизу: к моменту пролёта кольцо на уровне бедра
  const y = horizon + (height * 0.95 - horizon) * k
  const r = Math.min(width, height) * (0.02 + 0.3 * k)

  ctx.save()
  ctx.globalAlpha = alpha
  glow(ctx, 26 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 82 : 70}%, 0.95)`
  ctx.lineWidth = Math.max(3, r * 0.22)

  // эллипс, а не круг: кольцо лежит горизонтально, мы смотрим на него сверху
  ctx.beginPath()
  ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI * 2)
  ctx.stroke()

  ctx.shadowBlur = 0
  // имя именно такое: glow — это функция мягкой тени выше, и локальная
  // переменная с тем же именем роняла всю отрисовку кадра, а не только кольцо
  const inner = ctx.createRadialGradient(x, y, 0, x, y, r)
  inner.addColorStop(0, `hsla(${hue}, 100%, 70%, 0.28)`)
  inner.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
  ctx.fillStyle = inner
  ctx.beginPath()
  ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, obstacle.side === 'left' ? 'КОЛЕНО ЛЕВОЕ!' : 'КОЛЕНО ПРАВОЕ!', {
    p,
    alpha,
    cheap,
    x: cx + dir * width * 0.22,
    y: horizon - height * 0.1,
    width,
    height,
  })
}

/**
 * Птица над головой со своей стороны: достать её надо махом руки той же
 * стороны, поэтому она и висит там, куда рука дотягивается. Силуэт тёмный, с
 * двумя крыльями, и держится выше линии глаз — по высоте сразу видно, что
 * тянуться надо вверх, а не вперёд, как к астероиду.
 */
function drawBird(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1
  const x = cx + dir * width * (0.04 + 0.5 * k)
  // выше линии глаз и с подлётом поднимается ещё: она проходит над головой
  const y = horizon - height * (0.01 + 0.2 * k)
  const span = Math.min(width, height) * (0.03 + 0.42 * k)
  // взмах: крылья ходят вверх-вниз, иначе силуэт читается как камень
  const flap = Math.sin(clockMs / 160 + obstacle.id) * span * 0.22

  ctx.save()
  ctx.globalAlpha = alpha
  glow(ctx, 26 * (0.3 + k), `hsla(${hue}, 100%, 62%, 0.8)`, cheap)

  // тело — тёмный силуэт, обведённый светом: на звёздах чёрное само по себе
  // не читается, видно только контур
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 86 : 74}%, 0.95)`
  ctx.lineWidth = Math.max(2, span * 0.1)
  ctx.fillStyle = 'rgba(6, 8, 24, 0.82)'

  ctx.beginPath()
  ctx.moveTo(x - span, y + flap)
  // левое крыло -> тело -> правое крыло, одной ломаной с прогибом
  ctx.quadraticCurveTo(x - span * 0.45, y - span * 0.3 + flap * 0.4, x, y)
  ctx.quadraticCurveTo(x + span * 0.45, y - span * 0.3 + flap * 0.4, x + span, y + flap)
  ctx.quadraticCurveTo(x + span * 0.4, y + span * 0.22, x, y + span * 0.16)
  ctx.quadraticCurveTo(x - span * 0.4, y + span * 0.22, x - span, y + flap)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.stroke()
  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, obstacle.side === 'left' ? 'ЛЕВОЙ ВВЕРХ!' : 'ПРАВОЙ ВВЕРХ!', {
    p,
    alpha,
    cheap,
    x: cx + dir * width * 0.24,
    y: horizon + height * 0.12,
    width,
    height,
  })
}

/**
 * Яма во всю ширину: тёмный провал, который наезжает снизу. Перепрыгнуть можно
 * только вместе с обеими ногами, поэтому она и не имеет стороны — уйти в бок
 * от неё нельзя, и это должно быть видно по картинке сразу.
 */
function drawPit(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const horizon = height * HORIZON
  // передняя кромка идёт от горизонта к нижнему краю — как у кольца
  const front = horizon + (height * 1.05 - horizon) * k
  const depth = height * (0.01 + 0.3 * k)
  const halfW = width * (0.06 + 0.95 * k)
  const cx = width / 2

  ctx.save()
  ctx.globalAlpha = alpha

  // сам провал: чем ближе, тем чернее — это дыра, а не полоса на полу
  const hole = ctx.createLinearGradient(0, front - depth, 0, front)
  hole.addColorStop(0, 'rgba(2, 3, 12, 0.55)')
  hole.addColorStop(1, 'rgba(0, 0, 0, 0.95)')
  ctx.fillStyle = hole
  ctx.beginPath()
  // трапеция: дальняя кромка уже ближней, отсюда и читается глубина
  ctx.moveTo(cx - halfW * 0.55, front - depth)
  ctx.lineTo(cx + halfW * 0.55, front - depth)
  ctx.lineTo(cx + halfW, front)
  ctx.lineTo(cx - halfW, front)
  ctx.closePath()
  ctx.fill()

  // светящаяся кромка: по ней и понятно, когда отталкиваться
  glow(ctx, 24 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 86 : 76}%, 0.95)`
  ctx.lineWidth = Math.max(2, height * (0.004 + 0.012 * k))
  ctx.beginPath()
  ctx.moveTo(cx - halfW, front)
  ctx.lineTo(cx + halfW, front)
  ctx.stroke()
  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, 'ПРЫГАЙ!', {
    p,
    alpha,
    cheap,
    x: cx,
    y: horizon - height * 0.1,
    width,
    height,
  })
}

/**
 * Волна у самой земли со своей стороны: длинный низкий вал, который наезжает
 * от горизонта и растёт к игроку. Перешагнуть её нельзя и уйти вбок тоже —
 * от неё ОТСТУПАЮТ, унося ногу назад, и картинка говорит ровно это: гребень
 * идёт низко, у самого пола, и подпирает ту ногу, чьей стороны он держится.
 *
 * Высоко её поднимать нельзя: волна на уровне груди читалась бы как астероид,
 * а это движение ногой, а не рукой.
 */
function drawSurge(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1
  // идёт понизу, как кольцо: к пролёту вал у самых ног
  const y = horizon + (height * 0.98 - horizon) * k
  // центр вала смещён на свою сторону и уезжает к краю по мере подлёта
  const x = cx + dir * width * (0.03 + 0.34 * k)
  const halfW = width * (0.05 + 0.62 * k)
  const crest = height * (0.012 + 0.17 * k)

  ctx.save()
  ctx.globalAlpha = alpha

  // тело вала: гребень посередине, пологие края — одна дуга на всю ширину
  const body = ctx.createLinearGradient(0, y - crest, 0, y)
  body.addColorStop(0, `hsla(${hue}, 100%, 62%, 0.92)`)
  body.addColorStop(1, `hsla(${hue}, 90%, 28%, 0.4)`)
  ctx.fillStyle = body
  glow(ctx, 26 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.8)`, cheap)

  ctx.beginPath()
  ctx.moveTo(x - halfW, y)
  ctx.quadraticCurveTo(x - halfW * 0.4, y - crest, x, y - crest * 0.92)
  ctx.quadraticCurveTo(x + halfW * 0.4, y - crest, x + halfW, y)
  ctx.closePath()
  ctx.fill()

  // светящийся гребень: по нему видно, когда вал дойдёт до ног
  ctx.shadowBlur = cheap ? 0 : 20
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 88 : 80}%, 0.95)`
  ctx.lineWidth = Math.max(2, crest * 0.16)
  ctx.beginPath()
  ctx.moveTo(x - halfW, y)
  ctx.quadraticCurveTo(x - halfW * 0.4, y - crest, x, y - crest * 0.92)
  ctx.quadraticCurveTo(x + halfW * 0.4, y - crest, x + halfW, y)
  ctx.stroke()

  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  // подпись стоит на СВОЕЙ стороне, как у кольца и птицы: сторона здесь значит
  // «работает эта нога», а не «уходи туда» — у стены и балки наоборот
  drawCallout(ctx, obstacle.side === 'left' ? 'ЛЕВОЙ НАЗАД!' : 'ПРАВОЙ НАЗАД!', {
    p,
    alpha,
    cheap,
    x: cx + dir * width * 0.22,
    y: horizon - height * 0.12,
    width,
    height,
  })
}

/**
 * Уголёк у земли со своей стороны: маленький жаркий комок с хвостом искр,
 * который тянется НАЗАД-ВВЕРХ — туда же, куда уходит пятка при захлёсте. Хвост
 * здесь и есть подсказка движения: у кольца ничего подобного нет, и спутать
 * «колено вперёд-вверх» с «пяткой назад-вверх» по картинке не выйдет.
 */
function drawEmber(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, hue, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const cx = width / 2
  const horizon = height * HORIZON
  const dir = obstacle.side === 'left' ? -1 : 1
  const x = cx + dir * width * (0.035 + 0.32 * k)
  // у земли, как и волна: это движение голенью, а не рукой
  const y = horizon + (height * 0.94 - horizon) * k
  // вдали уголёк — самое мелкое препятствие в игре, и совсем крошечным его
  // делать нельзя: на звёздном фоне он просто теряется
  const r = Math.min(width, height) * (0.019 + 0.16 * k)
  // хвост уходит назад (к своему краю) и вверх — как пятка к ягодице
  const tailX = x + dir * r * 2.6
  const tailY = y - r * 2.2

  ctx.save()
  ctx.globalAlpha = alpha
  glow(ctx, 26 * (0.3 + k), `hsla(${hue}, 100%, 62%, 0.85)`, cheap)

  // хвост: три искры вдоль одной линии, мельче и тусклее к концу
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 86 : 74}%, 0.9)`
  ctx.lineWidth = Math.max(2, r * 0.34)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.quadraticCurveTo(x + dir * r * 1.1, y - r * 1.5, tailX, tailY)
  ctx.stroke()

  for (let i = 1; i <= 3; i += 1) {
    const t = i / 4
    const sx = x + (tailX - x) * t + dir * r * 0.5 * hash01(obstacle.id + i, 31)
    const sy = y + (tailY - y) * t - r * 0.3 * hash01(obstacle.id + i, 37)
    ctx.globalAlpha = alpha * (1 - t * 0.7)
    ctx.fillStyle = `hsla(${hue}, 100%, 78%, 0.9)`
    ctx.beginPath()
    ctx.arc(sx, sy, r * (0.28 - 0.05 * i), 0, Math.PI * 2)
    ctx.fill()
  }

  // сам уголёк: горячее ядро с тёмной каймой — иначе он теряется в звёздах
  ctx.globalAlpha = alpha
  const core = ctx.createRadialGradient(x, y, 0, x, y, r)
  core.addColorStop(0, `hsla(${hue}, 100%, 82%, 0.98)`)
  core.addColorStop(1, `hsla(${hue}, 95%, 34%, 0.85)`)
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()

  ctx.shadowBlur = 0
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 90 : 82}%, 0.95)`
  ctx.lineWidth = Math.max(2, r * 0.16)
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  drawCallout(ctx, obstacle.side === 'left' ? 'ЛЕВОЙ ПЯТКОЙ!' : 'ПРАВОЙ ПЯТКОЙ!', {
    p,
    alpha,
    cheap,
    x: cx + dir * width * 0.22,
    y: horizon - height * 0.12,
    width,
    height,
  })
}

/**
 * ЕДИНАЯ ПЛИТА — одна летящая фигура на все восемнадцать движений.
 *
 * До неё было два подхода, и оба провалились в поле.
 *
 * Своя фигура каждому движению (барьер, стена, балка, астероид, кольцо, птица,
 * яма, волна, уголёк плюс девять пластин с буквами): человек сначала разбирал
 * фигуру, потом вспоминал, что она значит, и только потом двигался. Восемнадцать
 * разных значков не выучиваются за один раунд.
 *
 * Стена с вырезом: вырез требует СОВПАСТЬ ТЕЛОМ, а засчитывается движение — и
 * человек честно делал упражнение, но видел, что в дыру не попал. Картинка
 * обещала не то, что судит движок; такое расхождение дороже любой красоты.
 *
 * Отсюда грамматика этой плиты, где смысл несут ТРИ вещи сразу, и ни одна не
 * требует ничего заучивать:
 *
 *   СТРЕЛКА — что делать: вниз, вверх, вниз-вверх, в сторону, в обе стороны,
 *     назад дугой, диагональ локоть-колено. Крупная и тёмная, читается с двух
 *     метров, и читается ДВИЖЕНИЕМ, а не названием.
 *   ЦВЕТ — чем работать: голубой ноги, оранжевый руки, зелёный корпус,
 *     фиолетовый всё тело. Четыре зоны запоминаются, восемнадцать оттенков нет.
 *   ПОДПИСЬ — словами, тем же текстом, что и раньше: стрелка говорит «вбок»,
 *     подпись уточняет, какой ногой.
 *
 * Плита не обещает совпадения телом: она долетает до кольца-приёмника, и всё,
 * что от человека нужно, — успеть сделать движение к этому моменту. Ровно это
 * движок и судит.
 */
const PLATE = {
  bend: { call: 'К ПОЛУ!' },
  jumpsquat: { call: 'ПРИСЕД+ПРЫЖОК!' },
  jack: { call: 'ЗВЕЗДА!' },
  hop: { call: 'НОГИ ВРОЗЬ!' },
  legside: { call: 'НОГОЙ ВБОК!' },
  sidelunge: { call: 'ВЫПАД ВБОК!' },
  wings: { call: 'РУКИ В СТОРОНЫ!' },
  clap: { call: 'ХЛОПОК ВВЕРХ!' },
  twistknee: { call: 'ЛОКОТЬ К КОЛЕНУ!' },
}

export const PLATE_TYPES = Object.keys(PLATE)

/**
 * Какой стрелкой рисуется движение. Стрелка называет НАПРАВЛЕНИЕ УСИЛИЯ, а не
 * траекторию предмета: «вниз» — присесть или наклониться, «вниз-вверх» —
 * присесть и выпрыгнуть, «дуга назад» — увести ногу назад.
 */
const ARROW = {
  barrier: 'down',
  bend: 'down',
  jumpsquat: 'downUp',
  pit: 'downUp',
  knee: 'up',
  bird: 'up',
  clap: 'up',
  wall: 'side',
  // наклон вбок в списке движений есть, а в грамматике стрелок его забыли:
  // своей стрелки ему не досталось. Берёт боковую — движение и правда в
  // сторону, — а от стены его отличают цвет (корпус, не ноги) и подпись
  beam: 'side',
  strike: 'side',
  legside: 'side',
  sidelunge: 'side',
  hop: 'bothSides',
  wings: 'bothSides',
  jack: 'bothSides',
  lunge: 'back',
  heel: 'back',
  twistknee: 'cross',
}

/**
 * КУДА СМОТРИТ БОКОВАЯ СТРЕЛКА. На экране человек видит себя зеркально (камера
 * с scaleX(-1)), и его левая сторона лежит СЛЕВА: поэтому «левой» — это стрелка
 * влево. Исключение одно — стена: её сторона говорит, где препятствие, а уходить
 * от него надо в свободную, то есть в противоположную.
 */
const AWAY_FROM = new Set(['wall', 'beam'])
const sideDir = (type, side) => {
  const own = side === 'left' ? -1 : 1
  // у стены и балки сторона говорит, ГДЕ препятствие, а уходить надо в
  // свободную: их подписи так и звучат — «слева стена» значит «шагни вправо»
  return AWAY_FROM.has(type) ? -own : own
}

/** Головка стрелки: треугольник остриём в (x, y) по направлению angle. */
function arrowHead(ctx, x, y, angle, size) {
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - Math.cos(angle - 0.44) * size, y - Math.sin(angle - 0.44) * size)
  ctx.lineTo(x - Math.cos(angle + 0.44) * size, y - Math.sin(angle + 0.44) * size)
  ctx.closePath()
  ctx.fill()
}

/**
 * Стрелка на плите. Всё в долях s — половины высоты плиты, — поэтому рисунок
 * растёт вместе с ней и на подлёте остаётся тем же самым.
 */
function drawArrow(ctx, kind, { x, y, s, dir, color }) {
  const head = s * 0.62
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = Math.max(3, s * 0.3)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const line = (x1, y1, x2, y2) => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  if (kind === 'down' || kind === 'up') {
    const way = kind === 'down' ? 1 : -1
    line(x, y - way * s * 0.72, x, y + way * s * 0.18)
    arrowHead(ctx, x, y + way * s * 0.82, way > 0 ? Math.PI / 2 : -Math.PI / 2, head)
  } else if (kind === 'downUp') {
    // присед и выпрыг — одно движение из двух половин, и головки у него две
    line(x, y - s * 0.28, x, y + s * 0.28)
    arrowHead(ctx, x, y + s * 0.82, Math.PI / 2, head)
    arrowHead(ctx, x, y - s * 0.82, -Math.PI / 2, head)
  } else if (kind === 'side') {
    line(x - dir * s * 1.0, y, x + dir * s * 0.35, y)
    arrowHead(ctx, x + dir * s * 1.1, y, dir > 0 ? 0 : Math.PI, head)
  } else if (kind === 'bothSides') {
    line(x - s * 0.45, y, x + s * 0.45, y)
    arrowHead(ctx, x + s * 1.15, y, 0, head)
    arrowHead(ctx, x - s * 1.15, y, Math.PI, head)
  } else if (kind === 'back') {
    // дуга назад: нога уходит за спину, и прямой стрелкой это не сказать
    ctx.beginPath()
    ctx.arc(x, y + s * 0.35, s * 0.78, -Math.PI * 0.95, -Math.PI * 0.1)
    ctx.stroke()
    arrowHead(ctx, x + s * 0.78 * Math.cos(-Math.PI * 0.05), y + s * 0.35 + s * 0.78 * Math.sin(-Math.PI * 0.05), Math.PI * 0.42, head)
  } else if (kind === 'cross') {
    // локоть и колено идут НАВСТРЕЧУ друг другу, отсюда две головки внутрь
    const ax = x + dir * s * 0.95
    const ay = y - s * 0.7
    const bx = x - dir * s * 0.95
    const by = y + s * 0.7
    line(ax - dir * s * 0.3, ay + s * 0.22, bx + dir * s * 0.3, by - s * 0.22)
    arrowHead(ctx, bx, by, Math.atan2(by - ay, bx - ax), head)
    arrowHead(ctx, ax, ay, Math.atan2(ay - by, ax - bx), head)
  }

  ctx.restore()
}

/**
 * Какая стрелка достаётся движению и куда она смотрит. Наружу — потому что это
 * и есть вся грамматика плиты: восемнадцать типов против семи стрелок, и
 * забытый тип означает молча не ту подсказку, а не заметную поломку.
 */
export const plateArrow = (type, side) => ({
  kind: ARROW[type] ?? null,
  dir: sideDir(type, side),
})

/**
 * Летящая плита. Одна на все восемнадцать движений: меняются только цвет зоны,
 * стрелка и подпись.
 */
function drawPlate(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  const hue = done ? 145 : ZONE_HUE[TYPE_ZONE[obstacle.type]] ?? ZONE_HUE.legs
  const cx = width / 2
  const horizon = height * HORIZON
  // плита летит В КОЛЬЦО-ПРИЁМНИК: сторона движения сказана стрелкой, а не
  // местом на экране, и все плиты сходятся в одну точку — так видно, когда
  // «пора», а не только «летит»
  const y = horizon + (height * RECEIVER_Y - horizon) * k
  const halfW = width * (0.045 + 0.34 * k)
  const halfH = halfW * 0.62

  ctx.save()
  ctx.globalAlpha = alpha

  const body = ctx.createLinearGradient(0, y - halfH, 0, y + halfH)
  body.addColorStop(0, `hsla(${hue}, 100%, 62%, 0.9)`)
  body.addColorStop(1, `hsla(${hue}, 90%, 28%, 0.55)`)
  ctx.fillStyle = body
  glow(ctx, 26 * (0.3 + k), `hsla(${hue}, 100%, 60%, 0.85)`, cheap)

  // скошенные углы: пластина, а не окно интерфейса
  const cut = Math.min(halfW, halfH) * 0.35
  ctx.beginPath()
  ctx.moveTo(cx - halfW + cut, y - halfH)
  ctx.lineTo(cx + halfW - cut, y - halfH)
  ctx.lineTo(cx + halfW, y - halfH + cut)
  ctx.lineTo(cx + halfW, y + halfH - cut)
  ctx.lineTo(cx + halfW - cut, y + halfH)
  ctx.lineTo(cx - halfW + cut, y + halfH)
  ctx.lineTo(cx - halfW, y + halfH - cut)
  ctx.lineTo(cx - halfW, y - halfH + cut)
  ctx.closePath()
  ctx.fill()

  ctx.shadowBlur = cheap ? 0 : 18
  ctx.strokeStyle = `hsla(${hue}, 100%, ${done ? 88 : 80}%, 0.95)`
  ctx.lineWidth = Math.max(2, halfH * 0.1)
  ctx.stroke()

  // стрелка живёт НА плите и растёт вместе с ней: с двух метров читается
  // только очень крупное, а направление читается ещё и боковым зрением
  ctx.shadowBlur = 0
  drawArrow(ctx, plateArrow(obstacle.type, obstacle.side).kind ?? 'down', {
    x: cx,
    y,
    s: halfH * 0.62,
    dir: sideDir(obstacle.type, obstacle.side),
    color: 'rgba(8, 12, 24, 0.92)',
  })

  ctx.restore()

  drawDodgeGauge(ctx, obstacle, clockMs, width, height, alpha, cheap)

  const text = callFor(obstacle.type, obstacle.side)
  if (text) {
    drawCallout(ctx, text, {
      p,
      alpha,
      cheap,
      x: cx,
      y: horizon - height * 0.12,
      width,
      height,
    })
  }
}

/**
 * КОЛЬЦО-ПРИЁМНИК — место, куда плиты прилетают, и единственный ответ на
 * вопрос «когда».
 *
 * Без него плита просто растёт, и момент «пора» приходится угадывать по
 * размеру. С ним у полёта появляется цель: кольцо начинает пульсировать, когда
 * ближайшая плита подходит, и вспыхивает на зачёте. Пульс — это метроном,
 * который видно боковым зрением, пока человек смотрит на своё движение.
 */
const RECEIVER_Y = 0.8

function drawReceiver(ctx, { width, height, obstacles, clockMs, cheap }) {
  let pulse = 0
  let flash = 0
  for (const o of obstacles) {
    const p = (clockMs - o.spawnAt) / o.travelMs
    if (p >= 0 && p <= 1.1) pulse = Math.max(pulse, clamp01((p - 0.55) / 0.45))
    // вспышка идёт от МОМЕНТА СУДА, а не от статуса: иначе зачтённая плита
    // светила бы всё время, пока уходит из кадра
    if (o.status === 'cleared' && o.judgedAt != null) {
      flash = Math.max(flash, clamp01(1 - (clockMs - o.judgedAt) / 420))
    }
  }

  const cx = width / 2
  const cy = height * RECEIVER_Y
  const rx = width * (0.3 + 0.03 * pulse)
  const ry = rx * 0.28
  const hue = flash > 0 ? 145 : 190

  ctx.save()
  ctx.lineCap = 'round'
  ctx.globalAlpha = 0.2 + 0.35 * pulse + 0.45 * flash
  ctx.lineWidth = Math.max(2, width * (0.006 + 0.006 * pulse + 0.01 * flash))
  ctx.strokeStyle = `hsla(${hue}, 100%, ${70 + 20 * flash}%, 0.9)`
  glow(ctx, 14 + 26 * pulse + 30 * flash, `hsla(${hue}, 100%, 65%, 0.9)`, cheap)
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.stroke()

  // на зачёте от кольца расходится вторая волна: короткая, но её видно
  if (flash > 0) {
    ctx.globalAlpha = 0.5 * flash
    ctx.lineWidth = Math.max(1, width * 0.004)
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx * (1 + 0.5 * (1 - flash)), ry * (1 + 0.5 * (1 - flash)), 0, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * СТЕНА С ВЫРЕЗОМ — снятая с поля картинка, оставленная целиком.
 *
 * Полевой прогон её и забраковал: вырез требует СОВПАСТЬ ТЕЛОМ, а засчитывается
 * движение — человек делал упражнение честно и всё равно видел, что в дыру не
 * попал. Код не удалён намеренно: поз в wallPoses.json 28 штук, они сняты с
 * записей, и если плита в поле не полетит, вернуться сюда дешевле, чем снимать
 * всё заново. drawScene её больше не зовёт.
 */
/**
 * СТЕНА С ВЫРЕЗОМ — общая картинка всех восемнадцати препятствий.
 *
 * Прежде у каждого движения была своя фигура: барьер, стена, балка, астероид,
 * кольцо, птица, яма, волна, уголёк и девять пластин с буквами. Их приходилось
 * и придумывать, и объяснять, и каждая новая просилась в свой день работы, а
 * человеку в двух метрах от телефона всё равно надо было СНАЧАЛА понять фигуру
 * и только потом — движение.
 *
 * Стена с вырезом снимает этот перевод: в летящей на тебя панели вырезан
 * силуэт позы, и пройти сквозь неё можно, только приняв эту позу. Объяснять
 * нечего — форма дыры и есть инструкция, одна и та же для всех восемнадцати.
 *
 * Живой макет, с которого снята вся геометрия, — docs/design/wall-live.html.
 *
 * ЕДИНИЦЫ ПОЗ. В wallPoses.json начало координат — середина таза, рост стоя
 * равен ЕДИНИЦЕ, y растёт вниз. В макете единица была другой (там рост это
 * примерно 3.1), поэтому все его коэффициенты пересчитаны: множитель 0.2576 —
 * это отношение единиц, и от него взяты толщина выреза, радиус головы и
 * подъём её центра. Числа макета оставлены в комментариях рядом: иначе при
 * следующей правке их пришлось бы выводить заново.
 *
 * X ЗЕРКАЛЬНЫЙ. Человек видит себя в камере зеркально (video: scaleX(-1)), и
 * вырез обязан совпасть с его отражением: своя правая рука — слева на экране.
 */
const WALL = {
  /** Панель почти во весь кадр: поля нужны, чтобы читалась рамка. */
  left: 0.05,
  top: 0.1,
  width: 0.9,
  height: 0.85,
  /** Стопы фигуры и её рост — в долях высоты кадра. */
  feet: 0.93,
  bodyHeight: 0.66,
  /**
   * Стояние: насколько ниже таза стопы в единицах файла. Это НЕ минимум позы, а
   * общая для всех поз опора: в приседе или прыжке стопы уезжают, и привяжи мы
   * фигуру к её собственному низу — присед всплыл бы над полом.
   */
  standFeet: 0.5,
  /** Толщина выреза: 0.62 единицы макета, переведённые в наши. */
  cutStroke: 0.62 * 0.2576,
  /** Голова: радиус и подъём центра над точкой носа, оттуда же. */
  headRadius: 0.14 * 0.2576,
  headLift: 0.06 * 0.2576,
}

/** Скелет из 13 точек: пары индексов в позе (нос, плечи, локти, кисти, таз, колени, стопы). */
const BONES = [
  [1, 2],
  [1, 3],
  [3, 5],
  [2, 4],
  [4, 6],
  [1, 7],
  [2, 8],
  [7, 8],
  [7, 9],
  [9, 11],
  [8, 10],
  [10, 12],
]

/**
 * Имя позы в файле не всегда совпадает с типом препятствия: позы снимались с
 * калибровки, где движения зовутся своими именами, а препятствия — своими.
 * Птица в калибровке «мах», яма — «прыжок».
 */
const POSE_ALIAS = { bird: 'raise', pit: 'jump' }

/**
 * Цвет — по ЗОНЕ ТЕЛА, а не по движению. Восемнадцать разных оттенков человек
 * не различит и запоминать не станет, а четыре зоны читаются с двух метров и
 * сами подсказывают, чем работать: голубой — ноги, оранжевый — руки, зелёный —
 * корпус, фиолетовый — всё тело сразу.
 */
const ZONE_HUE = { legs: 188, arms: 36, torso: 152, whole: 278 }
const TYPE_ZONE = {
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
  beam: 'torso',
  bend: 'torso',
  twistknee: 'torso',
  jack: 'whole',
}

/** Подписи старых девяти — ровно те, что были у их собственных фигур. */
const CALL = {
  barrier: () => 'ПОДСЯДЬ!',
  wall: (side) => (side === 'left' ? 'ВПРАВО!' : 'ВЛЕВО!'),
  beam: (side) => (side === 'left' ? 'НАКЛОН ВПРАВО!' : 'НАКЛОН ВЛЕВО!'),
  strike: (side) => (side === 'left' ? 'БЕЙ ЛЕВОЙ!' : 'БЕЙ ПРАВОЙ!'),
  knee: (side) => (side === 'left' ? 'КОЛЕНО ЛЕВОЕ!' : 'КОЛЕНО ПРАВОЕ!'),
  bird: (side) => (side === 'left' ? 'ЛЕВОЙ ВВЕРХ!' : 'ПРАВОЙ ВВЕРХ!'),
  pit: () => 'ПРЫГАЙ!',
  lunge: (side) => (side === 'left' ? 'ЛЕВОЙ НАЗАД!' : 'ПРАВОЙ НАЗАД!'),
  // «пятка» была именем препятствия-уголька; движение зовётся захлёстом, и
  // подпись обязана звать его так же, как экран
  heel: (side) => (side === 'left' ? 'ЗАХЛЁСТ ЛЕВОЙ!' : 'ЗАХЛЁСТ ПРАВОЙ!'),
}

const callFor = (type, side) => CALL[type]?.(side) ?? PLATE[type]?.call ?? null

/**
 * Поза выреза: у парных движений своя на каждую сторону.
 *
 * Последняя строчка — не перестраховка. Стена без выреза глухая: человек перед
 * ней просто остановится, и это ровно та беда, которая в этом проекте уже
 * случалась («фигуры нет, только слова»). Поэтому если стороны не дали, а поза
 * парная, берём любую — кривой вырез несравнимо лучше глухой стены.
 */
function poseFor(type, side) {
  const name = POSE_ALIAS[type] ?? type
  const poses = WALL_POSES.poses
  return (
    (side ? poses[`${name}:${side}`] : null) ??
    poses[name] ??
    poses[`${name}:right`] ??
    poses[`${name}:left`] ??
    null
  )
}

/**
 * Силуэт позы: кости штрихом плюс круг головы. Одной и той же функцией
 * ВЫБИВАЕТСЯ дыра (толстым штрихом на destination-out) и обводится её кромка
 * (тонким светящимся) — иначе кромка не совпала бы с дырой.
 */
function poseOutline(ctx, row, { cx, cy, scale, lineWidth, style }) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = style
  ctx.fillStyle = style
  ctx.lineWidth = lineWidth
  // x зеркальный: человек видит себя в отражении, и вырез обязан с ним совпасть
  const X = (i) => cx - row[i * 2] * scale
  const Y = (i) => cy + row[i * 2 + 1] * scale
  for (const [a, b] of BONES) {
    ctx.beginPath()
    ctx.moveTo(X(a), Y(a))
    ctx.lineTo(X(b), Y(b))
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(X(0), Y(0) - WALL.headLift * scale, WALL.headRadius * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Куда и в каком размере ложится силуэт.
 *
 * ЗАЧЕМ ПОДГОНКА, а не просто «рост 0.66 высоты», как в макете. Макет проверялся
 * на четырёх узких позах (присед, мах вверх, выпад, шаг), а движений у нас
 * восемнадцать, и среди них есть «руки в стороны»: размах рук человека равен
 * его росту, и на телефоне шириной в пол-экрана такая поза в панель НЕ
 * помещается ни при каком росте, кроме половинного. Замер по wallPoses.json на
 * 390x844: при росте 0.66 высоты за края панели вылезают ВСЕ 28 поз, у махов и
 * разведённых рук — на 200 с лишним точек.
 *
 * Вылезший силуэт — это не косметика: вырез вскрывает край панели, и стена
 * перестаёт быть стеной, сквозь неё можно пройти мимо. Поэтому 0.66 — это
 * ЖЕЛАЕМЫЙ рост, а фактический ужимается ровно настолько, чтобы силуэт целиком
 * остался внутри: узкие позы (присед, прыжок, выпад) идут в полный рост, а
 * «руки в стороны» на узком экране становятся вдвое ниже — потому что шире
 * панели рук не развести, это геометрия, а не настройка.
 *
 * По горизонтали фигура ставится серединой СВОЕЙ ОГРАНИЧИВАЮЩЕЙ РАМКИ, а не
 * тазом: в махе ногой вбок таз сильно смещён от середины силуэта, и центровка
 * по тазу впустую отдавала бы половину панели.
 *
 * Низ не ограничен намеренно: стопы стоят на 0.93 высоты, и штрих выреза
 * уходит ниже кромки панели — дыра открывается у пола, как дверной проём.
 */
function poseFit(row, width, height) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  for (let i = 0; i < 13; i += 1) {
    const x = row[i * 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    const y = row[i * 2 + 1]
    if (y < minY) minY = y
  }
  const halfWide = (maxX - minX) / 2 + WALL.cutStroke / 2
  // выше всех либо самая верхняя точка со своим штрихом, либо макушка головы
  const highest = Math.min(minY - WALL.cutStroke / 2, row[1] - WALL.headLift - WALL.headRadius)
  const topY = height * WALL.top

  const want = height * WALL.bodyHeight
  const byWidth = (width * WALL.width) / 2 / halfWide

  /**
   * ПОЛ ПОДНИМАЕТСЯ ВМЕСТЕ С УМЕНЬШЕНИЕМ, и это не подгонка под красоту.
   * Ужиматься приходится широким позам («руки в стороны» шире собственного
   * роста), а ужатая фигура на прежней линии пола выглядит крохой, прилипшей к
   * нижнему краю: полстены пустой, а сама поза не читается. По перспективе
   * маленькое — это ДАЛЁКОЕ, а у далёкого стопы выше, ближе к точке схода.
   * Поэтому линия пола едет от 0.93 высоты к горизонту ровно настолько,
   * насколько ужалась фигура.
   */
  const shrink = clamp01(Math.min(want, byWidth) / want)
  const feetY = height * (HORIZON + (WALL.feet - HORIZON) * shrink)

  const scale = Math.min(want, byWidth, (feetY - topY) / (WALL.standFeet - highest))
  return {
    scale,
    // x зеркальный (cx - x*S), поэтому середина рамки сдвигает центр в плюс
    cx: width / 2 + ((minX + maxX) / 2) * scale,
    cy: feetY - WALL.standFeet * scale,
  }
}

/**
 * Разгорание кромки: последнюю четверть подлёта вырез светится всё ярче — это
 * и есть «пора». Ступенями, а не плавно: панель кэшируется, и плавная яркость
 * означала бы перерисовку каждый кадр.
 */
const GLOW_STEPS = 5
const glowStageOf = (p) =>
  Math.round(clamp01((p - 0.75) / 0.25) * (GLOW_STEPS - 1))

/**
 * Панель со всем, что на ней есть, нарисованная один раз и потом только
 * растягиваемая. Считать её каждый кадр незачем: меняется она лишь на смене
 * размера кадра, ступени разгорания и цвета (зачёт зеленит панель целиком).
 *
 * Кэш маленький нарочно: каждая запись — целый холст в размер экрана, и на
 * телефоне это мегабайты. Одновременно в полёте бывает два-три препятствия,
 * поэтому четырёх записей хватает, а лишние вытесняются по очереди.
 */
const surfaceCache = new Map()
const SURFACE_CACHE_MAX = 3

/**
 * Забыть нарисованные панели. Нужно всюду, где холсты становятся чужими: смена
 * темы, новый разбор, соседний тест. Сама игра этого не зовёт — там кэш живёт
 * ровно столько же, сколько экран.
 */
export function clearWallCache() {
  surfaceCache.clear()
}

/**
 * Где и в каком размере встанет силуэт — наружу для проверок геометрии.
 * Вылезший за панель вырез вскрывает её край, и стена перестаёт быть стеной:
 * проверять это глазами на каждом из восемнадцати движений и на каждом
 * соотношении сторон никто не станет.
 */
export function wallCutBox(type, side, width, height) {
  const row = poseFor(type, side)
  if (!row) return null
  const { scale, cx, cy } = poseFit(row, width, height)
  const half = (WALL.cutStroke * scale) / 2
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (let i = 0; i < 13; i += 1) {
    const x = cx - row[i * 2] * scale
    const y = cy + row[i * 2 + 1] * scale
    left = Math.min(left, x - half)
    right = Math.max(right, x + half)
    top = Math.min(top, y - half)
    bottom = Math.max(bottom, y + half)
  }
  // голова — отдельным кругом, и он бывает выше всех точек скелета
  top = Math.min(top, cy + row[1] * scale - (WALL.headLift + WALL.headRadius) * scale)
  return { left, right, top, bottom, scale }
}

/** Границы самой панели — в тех же координатах, что и вырез. */
export const wallPanelBox = (width, height) => ({
  left: width * WALL.left,
  right: width * (WALL.left + WALL.width),
  top: height * WALL.top,
  bottom: height * (WALL.top + WALL.height),
})

/** Холст под панель. В браузере обычный, в разборе и тестах — какой дадут. */
function makeSurface(ctx, pixelWidth, pixelHeight) {
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(pixelWidth, pixelHeight)
    const doc = ctx.canvas?.ownerDocument ?? globalThis.document
    if (!doc?.createElement) return null
    const canvas = doc.createElement('canvas')
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    return canvas
  } catch {
    // холста нет — панель нарисуется прямо на кадре, без выреза (см. ниже)
    return null
  }
}

function wallSurface(ctx, { type, side, hue, stage, width, height, cheap }) {
  const key = `${type}:${side ?? ''}:${hue}:${stage}:${width}x${height}:${cheap ? 1 : 0}`
  const hit = surfaceCache.get(key)
  if (hit) {
    // свежее — в конец очереди: вытесняется всегда самое залежавшееся
    surfaceCache.delete(key)
    surfaceCache.set(key, hit)
    return hit
  }

  // плотность пикселей берём у самого кадра: на телефоне холст крупнее CSS
  const dpr = ctx.canvas?.width > 0 ? clampDpr(ctx.canvas.width / width) : 1
  const canvas = makeSurface(ctx, Math.round(width * dpr), Math.round(height * dpr))
  const c = canvas?.getContext?.('2d')
  if (!canvas || !c) return null
  if (c.setTransform) c.setTransform(dpr, 0, 0, dpr, 0, 0)

  paintWall(c, { type, side, hue, stage, width, height, cheap })

  surfaceCache.set(key, canvas)
  if (surfaceCache.size > SURFACE_CACHE_MAX) {
    surfaceCache.delete(surfaceCache.keys().next().value)
  }
  return canvas
}

/**
 * Плотность пикселей панели. Потолок — двойная, как и у самого кадра: холст
 * панели во весь экран, и на 1080x2400 каждая запись кэша это пять мегабайт.
 */
const clampDpr = (v) => (Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(1, v)) : 1)

/** Вся панель целиком: заливка, сетка, рамка, вырез и его кромка. */
function paintWall(c, { type, side, hue, stage, width, height, cheap }) {
  const glowK = stage / (GLOW_STEPS - 1)
  const x = width * WALL.left
  const y = height * WALL.top
  const w = width * WALL.width
  const h = height * WALL.height

  c.clearRect(0, 0, width, height)
  c.fillStyle = `hsla(${hue}, 80%, 50%, 0.5)`
  c.fillRect(x, y, w, h)

  // редкая сетка: панель читается как поверхность, а не как заливка
  if (!cheap) {
    c.strokeStyle = `hsla(${hue}, 85%, 70%, 0.2)`
    c.lineWidth = 1.5
    for (let i = 1; i < 7; i += 1) {
      const gy = y + (i * h) / 7
      c.beginPath()
      c.moveTo(x, gy)
      c.lineTo(x + w, gy)
      c.stroke()
    }
    for (let i = 1; i < 5; i += 1) {
      const gx = x + (i * w) / 5
      c.beginPath()
      c.moveTo(gx, y)
      c.lineTo(gx, y + h)
      c.stroke()
    }
  }

  c.lineWidth = 4
  c.strokeStyle = `hsla(${hue}, 95%, 65%, 0.95)`
  glow(c, 18, `hsla(${hue}, 95%, 60%, 0.9)`, cheap)
  c.strokeRect(x, y, w, h)
  c.shadowBlur = 0

  const row = poseFor(type, side)
  if (!row) return
  const place = poseFit(row, width, height)

  // сам вырез: дыра в панели, сквозь неё видно человека
  c.globalCompositeOperation = 'destination-out'
  poseOutline(c, row, {
    ...place,
    lineWidth: WALL.cutStroke * place.scale,
    style: 'rgba(0, 0, 0, 1)',
  })
  c.globalCompositeOperation = 'source-over'

  // и кромка по краю дыры — то, что разгорается к пролёту
  glow(c, 10 + 26 * glowK, `hsla(${hue}, 95%, 70%, ${0.6 + 0.4 * glowK})`, cheap)
  poseOutline(c, row, {
    ...place,
    lineWidth: Math.max(2, height * 0.005 * (1 + 0.75 * glowK)),
    style: `hsla(${hue}, 100%, ${78 + 14 * glowK}%, ${0.7 + 0.3 * glowK})`,
  })
  c.shadowBlur = 0
}

/**
 * Запасной путь: холста под панель не дали (старый движок, разбор без DOM).
 * Тогда рисуем то же самое прямо на кадре, но БЕЗ выреза — вырезать одно из
 * другого без второго холста нечем. Цель при этом видно: панель, рамка и
 * силуэт светящимся штрихом. Молча не рисовать нельзя — невидимое препятствие
 * в этом проекте уже стоило полевого теста.
 */
function paintWallFlat(ctx, { type, side, hue, stage, width, height, cheap }) {
  const glowK = stage / (GLOW_STEPS - 1)
  const x = width * WALL.left
  const y = height * WALL.top
  const w = width * WALL.width
  const h = height * WALL.height

  ctx.fillStyle = `hsla(${hue}, 80%, 50%, 0.5)`
  ctx.fillRect(x, y, w, h)
  ctx.lineWidth = 4
  ctx.strokeStyle = `hsla(${hue}, 95%, 65%, 0.95)`
  glow(ctx, 18, `hsla(${hue}, 95%, 60%, 0.9)`, cheap)
  ctx.strokeRect(x, y, w, h)
  ctx.shadowBlur = 0

  const row = poseFor(type, side)
  if (!row) return
  poseOutline(ctx, row, {
    ...poseFit(row, width, height),
    lineWidth: Math.max(2, height * 0.006 * (1 + 0.75 * glowK)),
    style: `hsla(${hue}, 100%, ${78 + 14 * glowK}%, 0.95)`,
  })
}

/**
 * Тень под стеной. Держит её на полу: без тени панель висит в пустоте, и
 * подлёт читается как наезд камеры, а не как приближение стены.
 */
function drawWallShadow(ctx, { width, height, k, hue, cheap }) {
  const bottom = height * HORIZON + (height * (WALL.top + WALL.height) - height * HORIZON) * k
  const rx = width * (0.02 + 0.46 * k)
  const ry = Math.max(1, height * (0.004 + 0.03 * k))
  ctx.save()
  ctx.globalAlpha = 0.35 * clamp01(k * 1.6)
  ctx.fillStyle = `hsla(${hue}, 60%, 8%, 0.9)`
  glow(ctx, 22 * k, `hsla(${hue}, 80%, 30%, 0.8)`, cheap)
  ctx.beginPath()
  ctx.ellipse(width / 2, bottom, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Стена с вырезом — одна отрисовка на все восемнадцать препятствий.
 *
 * Подлёт тот же, что у всех прежних фигур: панель растёт от точки схода до
 * полного кадра, и растёт она ВОКРУГ этой точки, а не из центра экрана —
 * иначе стена наезжала бы на человека сбоку.
 */
function drawCutWall(ctx, obstacle, clockMs, width, height, cheap) {
  const { p, k, alpha, done } = approach(obstacle, clockMs)
  if (p < 0 || alpha <= 0) return

  // зачтённое зеленеет, как и прежде: ответ на «засчитали?» человек читает на
  // самом препятствии, а не по очкам
  const hue = done ? 145 : ZONE_HUE[TYPE_ZONE[obstacle.type]] ?? ZONE_HUE.legs
  const stage = glowStageOf(p)
  const side = obstacle.side ?? null

  ctx.save()
  ctx.globalAlpha = alpha
  drawWallShadow(ctx, { width, height, k, hue, cheap })

  const horizonY = height * HORIZON
  ctx.translate(width / 2, horizonY)
  ctx.scale(k, k)
  ctx.translate(-width / 2, -horizonY)

  const surface = wallSurface(ctx, { type: obstacle.type, side, hue, stage, width, height, cheap })
  if (surface) ctx.drawImage(surface, 0, 0, width, height)
  else paintWallFlat(ctx, { type: obstacle.type, side, hue, stage, width, height, cheap })

  ctx.restore()

  const text = callFor(obstacle.type, side)
  if (text) {
    drawCallout(ctx, text, {
      p,
      alpha,
      cheap,
      x: width / 2,
      y: height * 0.14,
      width,
      height,
    })
  }
}

function drawParticles(ctx, parts) {
  ctx.save()
  for (const p of parts) {
    const k = p.life / p.maxLife
    ctx.globalAlpha = k
    ctx.fillStyle = `hsla(${170 + 60 * (1 - k)}, 100%, ${68 + 22 * k}%, 1)`
    ctx.beginPath()
    ctx.arc(p.x, p.y, 1.5 + 2.5 * k, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

export function drawScene(
  ctx,
  { width, height, clockMs, stars, obstacles, particles, cheap = false },
) {
  ctx.clearRect(0, 0, width, height)
  drawStarfield(ctx, stars, width, height, cheap)
  // кольцо-приёмник рисуется ДО плит: они прилетают в него и проходят поверх
  drawReceiver(ctx, { width, height, obstacles, clockMs, cheap })
  /**
   * Дальние (вылетевшие позже) рисуем первыми — ближнее препятствие их
   * перекрывает.
   *
   * Все восемнадцать типов идут ОДНОЙ ПЛИТОЙ: что делать, говорят стрелка,
   * цвет зоны тела и подпись. Прежние фигуры и стена с вырезом остались в
   * файле нетронутыми — обе сняты с поля, и обе могут ещё понадобиться, если
   * плита в поле не полетит.
   */
  for (const obstacle of [...obstacles].sort((a, b) => b.spawnAt - a.spawnAt)) {
    drawPlate(ctx, obstacle, clockMs, width, height, cheap)
  }
  drawParticles(ctx, particles)
}
