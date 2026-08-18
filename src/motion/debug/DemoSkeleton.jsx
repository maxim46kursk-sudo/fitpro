import { useEffect, useRef, useState } from 'react'
import { LM } from '../pose/landmarks.js'

/**
 * Зелёная фигурка, которая показывает движение. Нужна там, где раньше стояла
 * одна текстовая инструкция.
 *
 * Причина простая: словами движение не передаётся. «Мах рукой» человек понимает
 * как угодно — от рывка перед собой до круга плечом, — и инструкцию к нему
 * приходилось растить до полутора строк («подними ПРЯМУЮ руку ЧЕРЕЗ СТОРОНУ
 * вверх НАД ГОЛОВОЙ и опусти»), которую с двух метров никто не читает. Показ
 * решает это за секунду и без слов.
 *
 * Петли не нарисованы руками, а вырезаны из ЖИВЫХ ЗАПИСЕЙ тем же кодом, что
 * судит детекторы (tools/make-demo-loops.mjs). Это важно: человек должен видеть
 * ровно то движение, которое потом будет засчитано, а не режиссёрскую его
 * версию. Нарисованная от руки анимация неизбежно разошлась бы с порогами.
 *
 * Координаты в файле нормализованы (начало — таз, масштаб — длина корпуса),
 * поэтому фигурка рисуется в любом размере и не зависит ни от роста снятого
 * человека, ни от того, как далеко он стоял от камеры.
 */

/**
 * Связи скелета — в индексах MediaPipe, а не в позициях внутри файла. Файл
 * перебирается инструментом, и порядок точек в нём менять можно; ломаться от
 * этого рисование не должно.
 */
const BONES = [
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  [LM.LEFT_SHOULDER, LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.LEFT_KNEE],
  [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE],
  [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
]

/**
 * Петли грузятся ОТДЕЛЬНЫМ ЧАНКОМ, а не вместе с приложением: это семьдесят
 * килобайт данных ради одного экрана, который открывает тренер и который не
 * видит ни один участник челленджа. Первая загрузка игры от них тормозить не
 * должна — телефон в этот момент и так тянет нейросеть.
 */
let cache = null
let pending = null

export function loadDemoLoops() {
  if (cache) return Promise.resolve(cache)
  if (!pending) {
    pending = import('./demoLoops.json')
      .then((module) => {
        cache = module.default ?? module
        return cache
      })
      .catch(() => {
        // не догрузилось — экран калибровки работает как до появления демо
        pending = null
        return null
      })
  }
  return pending
}

/** Где в кадре петли лежит точка с таким индексом MediaPipe. */
const slotsOf = (data) => new Map((data?.points ?? []).map((lm, i) => [lm, i]))

/**
 * ЗЕРКАЛО. Петли лежат в сырых координатах кадра, где собственная ЛЕВАЯ рука
 * человека оказывается СПРАВА на картинке. Видео же человек видит отражённым
 * (.mt-mirror, scaleX(-1)) — там его левая рука слева, как в настоящем зеркале.
 *
 * Нарисовать фигурку без отражения значило бы поставить рядом с человеком
 * двойника, который на «мах ЛЕВОЙ» поднимает противоположную руку. Для парных
 * движений — а их семь из девяти — это хуже, чем не показывать ничего.
 */
const mirrorX = (v) => -v

/**
 * У одного и того же движения ДВА имени, и это не оплошность, а история: в
 * калибровке они зовутся по движению (`raise`, `jump`), а в игре — по
 * препятствию, которое их требует (`bird`, `pit`). Петли собраны с записей
 * калибровки, поэтому лежат под первыми именами.
 *
 * Полевой тест 13 августа: на экране «Настройка под себя» у птицы и ямы
 * фигурки не было вовсе — экран просил их по игровым именам, а в файле таких
 * ключей нет. Компонент честно рисовал пустоту, человек видел один текст.
 */
const LOOP_ALIAS = { bird: 'raise', pit: 'jump' }

/**
 * ОДНОСТОРОННИЕ ДВИЖЕНИЯ, У КОТОРЫХ ПОКАЗ ЧЕРЕДУЕТ СТОРОНЫ.
 *
 * Полевой прогон сессии: инструктор весь силовой блок делал выпад одной и той
 * же ногой, человек послушно копировал — и тридцать секунд грузил одну сторону.
 * Детекторам всё равно, они принимают обе; беда чисто показная, и лечится она
 * тоже показом.
 *
 * Петля снята с одной стороны, второй записи нет и не нужно: каждый второй
 * проход отражается по горизонтали относительно центра фигуры. Для этих трёх
 * движений зеркальное отражение и ЕСТЬ другая сторона — выпад левой в зеркале
 * это выпад правой.
 *
 * Симметричные движения (присед, прыжок, звезда) сюда не входят: отражать их
 * значит показывать ту же картинку и зря дёргать глаз.
 */
const ALTERNATES = new Set(['lunge', 'sidelunge', 'twistknee'])

/** Ключ петли: у парных движений своя на каждую сторону. */
export const loopKey = (movement, side) => {
  const name = LOOP_ALIAS[movement] ?? movement
  return side ? `${name}:${side}` : name
}

/**
 * Есть ли демо для этого движения. По нему же сторожит тест списка движений —
 * ему петли надо сперва дождаться через loadDemoLoops().
 */
export const hasDemo = (movement, side, data = cache) =>
  !!data?.loops?.[loopKey(movement, side)]

/**
 * Габарит ВСЕЙ петли, а не текущего кадра. Если считать по кадру, фигурка на
 * каждом шаге пересчитывала бы масштаб и прыгала: в приседе человек становится
 * ниже, и «подогнанный» скелет остался бы одного роста, то есть присед просто
 * не был бы виден. Здесь же движение видно именно потому, что рамка неподвижна.
 */
function boundsOf(frames) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const row of frames) {
    for (let i = 0; i + 1 < row.length; i += 2) {
      // рамка считается по тем же координатам, в которых потом рисуем, —
      // то есть уже отражённым: иначе фигурка уехала бы из центра
      const x = mirrorX(row[i])
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (row[i + 1] < minY) minY = row[i + 1]
      if (row[i + 1] > maxY) maxY = row[i + 1]
    }
  }
  return { minX, maxX, minY, maxY }
}

function drawFrame(ctx, row, box, slots, width, height, flipped = false) {
  ctx.clearRect(0, 0, width, height)

  const pad = Math.max(6, Math.min(width, height) * 0.08)
  const spanX = Math.max(box.maxX - box.minX, 0.001)
  const spanY = Math.max(box.maxY - box.minY, 0.001)
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY)
  // рамка петли ставится по центру канвы один раз — она общая для всех кадров
  const offX = (width - spanX * scale) / 2 - box.minX * scale
  const offY = (height - spanY * scale) / 2 - box.minY * scale

  const at = (lm) => {
    const slot = slots.get(lm)
    if (slot == null) return null
    const x = mirrorX(row[slot * 2])
    const y = row[slot * 2 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const px = x * scale + offX
    /**
     * Чередование сторон: отражаем уже готовый пиксель относительно середины
     * канвы. Рамка петли ставится по центру (см. offX), поэтому середина канвы
     * и есть центр фигуры — отражение не сдвигает её ни на пиксель.
     */
    return [flipped ? width - px : px, y * scale + offY]
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#3ddc97'
  ctx.fillStyle = '#3ddc97'
  ctx.lineWidth = Math.max(2, Math.min(width, height) * 0.035)

  ctx.beginPath()
  for (const [from, to] of BONES) {
    const a = at(from)
    const b = at(to)
    if (!a || !b) continue
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
  }
  ctx.stroke()

  // голова точкой: лица в петле нет, а без головы фигурка читается как палка
  const head = at(LM.NOSE)
  if (head) {
    ctx.beginPath()
    ctx.arc(head[0], head[1], Math.max(3, Math.min(width, height) * 0.06), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Человек просил систему не анимировать — уважаем и показываем один кадр. */
function prefersReducedMotion() {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  } catch {
    // matchMedia нет вовсе (jsdom, старый вебвью) — значит и просьбы нет
    return false
  }
}

/**
 * @param {{movement: string, side?: string|null, width?: number, height?: number,
 *          className?: string}} props
 */
export default function DemoSkeleton({
  movement,
  side = null,
  width = 96,
  height = 132,
  /**
   * Во сколько раз крутить петлю быстрее записи. Инструктору силового блока
   * это нужно: на профи то же движение делается чаще, и фигура обязана
   * показывать тот темп, которого от человека ждут.
   */
  tempo = 1,
  className = '',
}) {
  const canvasRef = useRef(null)
  // петли приезжают отдельным чанком: до их приезда шаг работает как раньше
  const [loops, setLoops] = useState(cache)
  const frames = loops?.loops?.[loopKey(movement, side)] ?? null

  useEffect(() => {
    if (cache) return undefined
    let alive = true
    loadDemoLoops().then((data) => {
      if (alive && data) setLoops(data)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    // в среде без канвы (jsdom) экран работает как обычно, просто без фигурки
    const ctx = canvas?.getContext ? canvas.getContext('2d') : null
    if (!ctx || !frames?.length) return undefined

    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const slots = slotsOf(loops)
    const box = boundsOf(frames)

    // Петля вырезана вокруг зачётного момента, поэтому её середина — это и есть
    // сама суть движения: нижняя точка приседа, рука над головой, нога сзади.
    // На неподвижном кадре показывать надо именно её, а не безразличный старт.
    const still = Math.floor(frames.length / 2)
    if (prefersReducedMotion()) {
      drawFrame(ctx, frames[still], box, slots, width, height)
      return undefined
    }

    const stepMs = 1000 / ((loops.fps || 12) * (tempo > 0 ? tempo : 1))
    // односторонние движения показываются то одной стороной, то другой
    const alternates = ALTERNATES.has(movement)
    let index = 0
    let flipped = false
    let acc = 0
    let prev = performance.now()
    let raf = 0

    drawFrame(ctx, frames[index], box, slots, width, height, flipped)

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      // вкладку могли увести в фон — один огромный скачок не должен прокрутить
      // всю петлю разом
      acc += Math.min(now - prev, 250)
      prev = now
      if (acc < stepMs) return
      while (acc >= stepMs) {
        acc -= stepMs
        index += 1
        // петля кончилась — следующую показываем с другой стороны
        if (index >= frames.length) {
          index = 0
          if (alternates) flipped = !flipped
        }
      }
      drawFrame(ctx, frames[index], box, slots, width, height, flipped)
    }
    raf = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(raf)
  }, [frames, loops, movement, width, height, tempo])

  // Нет петли для движения — не рисуем ничего вовсе. Новое движение появляется
  // в калибровке раньше, чем под него снята запись, и шаг обязан работать без
  // демо ровно так же, как работал до него.
  if (!frames?.length) return null

  return (
    <canvas
      ref={canvasRef}
      className={`mt-demo ${className}`}
      style={{ width: `${width}px`, height: `${height}px` }}
      data-testid="demo-skeleton"
      data-loop={loopKey(movement, side)}
      aria-hidden="true"
    />
  )
}
