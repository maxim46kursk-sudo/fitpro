/**
 * ТАБЛИЦА «МИНУТА -> СТАДИИ» И ВЕРДИКТ.
 *
 * Приложение меряет стадии от начала КАЖДОГО отрезка: `resetStages()` стоит на
 * старте боя и на старте силового блока, и это правильно — внутри приложения
 * разбирают один бой, а не сессию. Прогону нужна сессия целиком, поэтому строки
 * отрезков раскладываются здесь на общую шкалу: у каждого отрезка известно, во
 * сколько он начался, а строка внутри него знает свою минуту от начала отрезка.
 *
 * СВЁРТКА ВРЕМЕНИ ПО МИНУТЕ — СРЕДНЕЕ, ВЗВЕШЕННОЕ ПО КАДРАМ. Складывать медианы
 * вообще говоря нельзя, и это признаётся честно: минута, в которую попали и
 * силовой блок, и половина боя, даёт число между их медианами, а не медиану
 * минуты. Для вопроса «растёт ли стадия к седьмому кругу» этого достаточно, а
 * поминутные строки самих отрезков остаются в отчёте нетронутыми — там видно
 * всё как есть.
 *
 * СВЁРТКА ЧИСЛА ОБЪЕКТОВ — МАКСИМУМ. Приложение отдаёт их пиком за минуту (см.
 * `peak` в stageMeter.js), и усреднять пики нельзя: минута, где были и тихий
 * силовой блок, и всплеск эффектов в бою, дала бы число, какого на экране не
 * было ни разу.
 */

/** Стадии в порядке конвейера — тот же список, что в debug/stageMeter.js. */
export const STAGES = ['grab', 'inference', 'judge', 'draw', 'log']
export const COUNTS = ['targets', 'obstacles', 'particles', 'stars', 'dom', 'canvas', 'heapMb']

/**
 * Разложить собранные события в поминутную таблицу.
 *
 * @param {Array<{tag: string, iso: string, data: object}>} events
 */
export function buildTable(events) {
  const timed = events
    .map((e) => ({ ...e, t: Date.parse(e.iso) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t)

  /** Ноль шкалы — начало первого отрезка сессии. */
  const firstStart = timed.find((e) => e.tag === 'block.start' || e.tag === 'game.round.start')
  const zero = firstStart ? firstStart.t : timed[0]?.t
  if (zero == null) return { minutes: [], segments: [], zero: null }

  /**
   * НАЧАЛО ОТРЕЗКА — по его собственному событию старта, а не «конец минус
   * длительность». Длительность боя знает расписание, но бой заканчивается и
   * досрочно, а силовой блок может подождать, пока человек встанет в кадр.
   */
  const segments = []
  let openStrength = null
  let openFight = null

  for (const e of timed) {
    if (e.tag === 'block.start') openStrength = e
    else if (e.tag === 'game.round.start') openFight = e
    else if (e.tag === 'block.end' || e.tag === 'game.end') {
      const open = e.tag === 'block.end' ? openStrength : openFight
      const kind = e.tag === 'block.end' ? 'сила' : 'бой'
      if (e.tag === 'block.end') openStrength = null
      else openFight = null
      const rows = e.data?.stages?.minutes
      if (!Array.isArray(rows) || !rows.length) continue
      segments.push({
        kind,
        movement: e.data?.movement ?? null,
        startMs: (open ? open.t : e.t) - zero,
        endMs: e.t - zero,
        poseFps: e.data?.poseFps ?? null,
        latencyMs: e.data?.latencyMs ?? null,
        cleared: e.data?.cleared ?? null,
        missed: e.data?.missed ?? null,
        reps: e.data?.reps ?? null,
        rows,
      })
    }
  }

  /** minute -> {stage: {sum, weight}} */
  const bucket = new Map()
  for (const seg of segments) {
    for (const row of seg.rows) {
      const at = seg.startMs + (row.min || 0) * 60000
      const minute = Math.max(0, Math.floor(at / 60000))
      let b = bucket.get(minute)
      if (!b) bucket.set(minute, (b = { minute, frames: 0, stages: {}, counts: {}, kinds: {} }))
      const w = Number(row.frames) || 1
      b.frames += Number(row.frames) || 0
      b.kinds[seg.kind] = (b.kinds[seg.kind] || 0) + w
      for (const s of STAGES) {
        if (!Number.isFinite(row[s])) continue
        const acc = (b.stages[s] ||= { sum: 0, w: 0 })
        acc.sum += row[s] * w
        acc.w += w
      }
      /**
       * Живые объекты приложение отдаёт ПИКОМ за минуту (см. stageMeter.js), и
       * складывать пики средним нельзя: минута, в которую попали и силовой блок
       * без единого эффекта, и половина боя со всплеском, дала бы число, какого
       * на экране не было ни разу. Пик минуты — это максимум её пиков.
       */
      for (const c of COUNTS) {
        if (!Number.isFinite(row[c])) continue
        const cur = b.counts[c]
        if (cur == null || row[c] > cur) b.counts[c] = row[c]
      }
    }
  }

  const minutes = [...bucket.values()]
    .sort((a, b) => a.minute - b.minute)
    .map((b) => {
      const out = { min: b.minute, frames: b.frames }
      // чего в минуте было больше — боя или силовой: строка без этого читается
      // как «стадия выросла», хотя это просто другая работа
      out.phase = (b.kinds['бой'] || 0) >= (b.kinds['сила'] || 0) ? 'бой' : 'сила'
      for (const s of STAGES) {
        const a = b.stages[s]
        if (a?.w) out[s] = Math.round((a.sum / a.w) * 100) / 100
      }
      for (const c of COUNTS) {
        if (Number.isFinite(b.counts[c])) out[c] = Math.round(b.counts[c])
      }
      return out
    })

  return { zero, minutes, segments }
}

/** Во сколько раз выросло: конец сессии против её начала. */
function slope(values) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length < 4) return null
  const cut = Math.max(1, Math.floor(clean.length / 3))
  const head = clean.slice(0, cut)
  const tail = clean.slice(-cut)
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
  const from = avg(head)
  const to = avg(tail)
  if (!from) return null
  return { from: +from.toFixed(2), to: +to.toFixed(2), ratio: +(to / from).toFixed(2) }
}

/**
 * ЧТО ЭТО ЗНАЧИТ.
 *
 * Порог роста — полтора раза. Ниже него шум прогона (сборка мусора, чужие
 * процессы на машине) уверенно не отличить от настоящего наклона, а объявить
 * виноватой стадию, которая «подросла на двадцать процентов», значит послать
 * чинить то, что не сломано.
 *
 * Падение частоты — вдвое. Полевая жалоба звучит как «20 -> 8 за шесть минут»,
 * это в два с половиной раза; вдвое ловит её с запасом и не срабатывает на
 * обычной разнице между боями.
 */
const GROWTH = 1.5
const RATE_DROP = 0.5

export function verdictOf(table, events) {
  const { minutes, segments } = table

  if (!minutes.length) {
    return {
      kind: 'error',
      title: 'мерить нечего: ни одного отчёта по стадиям',
      why:
        'ни один бой и ни один силовой блок не дошёл до конца. Смотри ошибки страницы и ' +
        'журнал в отчёте — скорее всего сессия не стартовала.',
    }
  }

  const rates = segments.filter((s) => s.kind === 'бой' && Number.isFinite(s.poseFps))
  const rateSlope = slope(rates.map((s) => s.poseFps))

  const stageSlopes = {}
  for (const s of STAGES) {
    const v = slope(minutes.map((m) => m[s]))
    if (v) stageSlopes[s] = v
  }
  const countSlopes = {}
  for (const c of COUNTS) {
    const v = slope(minutes.map((m) => m[c]))
    if (v) countSlopes[c] = v
  }

  const grew = Object.entries(stageSlopes)
    .filter(([, v]) => v.ratio >= GROWTH)
    .sort((a, b) => b[1].ratio - a[1].ratio)
  const grewCounts = Object.entries(countSlopes)
    .filter(([, v]) => v.ratio >= GROWTH)
    .sort((a, b) => b[1].ratio - a[1].ratio)

  const rateFell = rateSlope && rateSlope.ratio <= RATE_DROP

  /** Сессия дошла до конца? Семь боёв — семь отчётов. */
  const fightSegs = segments.filter((s) => s.kind === 'бой')
  const complete = events.some((e) => e.tag === 'session.end') || fightSegs.length >= 7

  /**
   * НАСКОЛЬКО СЦЕНА В БОЮ ПОХОЖА НА ЖИВУЮ.
   *
   * Персонаж не видит, какая мишень летит, и бьёт вслепую. Мало зачётов —
   * значит мало вспышек, чисел и частиц, то есть отрисовка прогоном
   * недопроверена, и рост, который жил бы именно в эффектах попадания, он
   * пропустит. Вердикт «всё ровно» без этой оговорки читался бы шире, чем
   * заслуживает.
   */
  let cleared = 0
  let spawned = 0
  for (const s of fightSegs) {
    cleared += Number(s.cleared) || 0
    spawned += (Number(s.cleared) || 0) + (Number(s.missed) || 0)
  }
  const hitRate = spawned ? cleared / spawned : null

  if (rateFell && grew.length) {
    return {
      kind: 'found',
      title: `частота упала (${rateSlope.from} -> ${rateSlope.to} поз/с), выросла стадия «${grew[0][0]}»`,
      stage: grew[0][0],
      rateSlope,
      stageSlopes,
      countSlopes,
      grew,
      grewCounts,
      complete,
      hitRate,
      why:
        `Стадия «${grew[0][0]}» выросла с ${grew[0][1].from} до ${grew[0][1].to} мс ` +
        `(в ${grew[0][1].ratio} раза) — это и есть причина. Чинить её.`,
    }
  }

  if (rateFell) {
    return {
      kind: 'rate-only',
      title: `частота упала (${rateSlope.from} -> ${rateSlope.to} поз/с), но ни одна стадия не выросла`,
      rateSlope,
      stageSlopes,
      countSlopes,
      grewCounts,
      complete,
      hitRate,
      why:
        'Падение воспроизвелось, но время стадий держится. Значит время уходит не в ' +
        'размеченные стадии: смотри живые объекты в таблице и паузы между кадрами ' +
        '(насос кадров, сборщик мусора, троттлинг вкладки).',
    }
  }

  if (grew.length) {
    return {
      kind: 'stage-only',
      title: `частота держится, но стадия «${grew[0][0]}» всё равно выросла`,
      stage: grew[0][0],
      rateSlope,
      stageSlopes,
      countSlopes,
      grew,
      grewCounts,
      complete,
      hitRate,
      why:
        `Запас по времени пока перекрывает рост, но на телефоне слабее этого запаса нет. ` +
        `Стадия «${grew[0][0]}» растёт — разбирать её.`,
    }
  }

  return {
    kind: 'clean',
    title: 'за всю сессию всё ровно: ни одна стадия не выросла, частота не упала',
    rateSlope,
    stageSlopes,
    countSlopes,
    complete,
    hitRate,
    why:
      'Замедления в коде нет — по крайней мере такого, которое воспроизводится за полную ' +
      'сессию на одном и том же входе. Дело в устройстве: тепловой сброс частоты, ' +
      'экономия батареи, чужие приложения в фоне. Проверять телефоном, а не кодом.',
  }
}

// ------------------------------------------------------------- печать ---

const pad = (v, n) => String(v ?? '—').padStart(n)

export function renderTable({ minutes, segments }) {
  if (!minutes.length) return 'таблицы нет: отчётов по стадиям не собрано'

  const head =
    'мин  фаза  кадров │ grab  infer  judge   draw    log │ пик: мишен препят части звёзд   DOM холст  куча'
  const rule = '─'.repeat(head.length)
  const lines = [head, rule]

  for (const m of minutes) {
    lines.push(
      `${pad(m.min, 3)}  ${String(m.phase).padEnd(4)}  ${pad(m.frames, 6)} │` +
        `${pad(m.grab, 5)} ${pad(m.inference, 6)} ${pad(m.judge, 6)} ${pad(m.draw, 6)} ${pad(m.log, 6)} │` +
        `${pad(m.targets, 6)} ${pad(m.obstacles, 7)} ${pad(m.particles, 6)} ${pad(m.stars, 6)}` +
        ` ${pad(m.dom, 6)} ${pad(m.canvas, 6)} ${pad(m.heapMb, 5)}`,
    )
  }

  lines.push('')
  lines.push('отрезки сессии:')
  lines.push('  начало  вид   движение      поз/с  задержка  зачтено/промах')
  for (const s of segments) {
    lines.push(
      `  ${pad(Math.round(s.startMs / 1000), 5)}с  ${String(s.kind).padEnd(5)} ` +
        `${String(s.movement ?? (s.reps != null ? `${s.reps} повт.` : '')).padEnd(13)}` +
        `${pad(s.poseFps, 5)}  ${pad(s.latencyMs, 8)}  ` +
        `${s.cleared != null ? `${s.cleared}/${s.missed}` : ''}`,
    )
  }

  return lines.join('\n')
}

export function renderVerdict(v, { fromProd, engine, pageErrors = [], collected = [] } = {}) {
  const out = []
  out.push('═'.repeat(70))
  out.push(`ВЕРДИКТ: ${v.title}`)
  out.push('═'.repeat(70))
  out.push(v.why)

  /**
   * ГДЕ СЧИТАЛОСЬ РАСПОЗНАВАНИЕ — первым делом после вердикта.
   *
   * Откат на главный поток меняет не скорость, а устройство конвейера: инференс
   * начинает блокировать и насос кадров, и отрисовку, и «какая стадия растёт»
   * превращается в «главный поток занят». Такой прогон можно читать только как
   * проверку того, что приложение вообще живёт, — и об этом надо сказать
   * прямо, а не прятать в отчёте.
   */
  const ready = collected.filter((e) => e.tag === 'model.ready').pop()
  const fell = collected.some((e) => e.tag === 'worker.fallback')
  if (ready?.data?.thread === 'main' || fell) {
    out.push('')
    out.push(
      '!! РАСПОЗНАВАНИЕ СЧИТАЛОСЬ НА ГЛАВНОМ ПОТОКЕ: воркер не поднялся.\n' +
        '   Это другая архитектура, и по стадиям такой прогон не читается — инференс\n' +
        '   в нём блокирует и захват, и отрисовку. Гонять с движком, у которого есть\n' +
        '   OffscreenCanvas (по умолчанию chromium).',
    )
  } else if (ready) {
    out.push('')
    out.push(`распознавание: ${ready.data.thread}, делегат ${ready.data.delegate}`)
  }

  if (v.rateSlope) {
    out.push('')
    out.push(
      `частота замеров: ${v.rateSlope.from} -> ${v.rateSlope.to} поз/с ` +
        `(×${v.rateSlope.ratio}) по боям от начала сессии к концу`,
    )
  }
  if (v.stageSlopes && Object.keys(v.stageSlopes).length) {
    out.push('')
    out.push('наклон стадий (начало -> конец сессии):')
    for (const [name, s] of Object.entries(v.stageSlopes)) {
      out.push(`  ${name.padEnd(10)} ${pad(s.from, 7)} -> ${pad(s.to, 7)} мс   ×${s.ratio}`)
    }
  }
  if (v.grewCounts?.length) {
    out.push('')
    out.push('живые объекты, которых стало больше:')
    for (const [name, s] of v.grewCounts) out.push(`  ${name.padEnd(10)} ${s.from} -> ${s.to}  ×${s.ratio}`)
  }
  if (v.complete === false) {
    out.push('')
    out.push('! сессия не дошла до конца — вердикт по неполной сессии, доверять ему меньше')
  }
  /**
   * Порог — четверть. В поле зачётов 57%; ниже 25% сцена в бою стоит пустая, и
   * «отрисовка не выросла» означает лишь «нечего было рисовать».
   */
  if (v.hitRate != null && v.hitRate < 0.25) {
    out.push('')
    out.push(
      `! зачётов всего ${Math.round(v.hitRate * 100)}% против 57% в поле: персонаж бьёт вслепую,\n` +
        '  он не знает, какая мишень летит. Сцена в бою почти пустая — значит ОТРИСОВКА И\n' +
        '  ЭФФЕКТЫ ПОПАДАНИЯ этим прогоном недопроверены, и рост, живущий в них, он пропустит.',
    )
  }
  if (!fromProd) {
    out.push('')
    out.push('! темп персонажа взят по умолчанию, а не из motion_log: prod-profile.json не собран')
  }
  if (pageErrors.length) {
    out.push('')
    out.push(`! ошибок на странице: ${pageErrors.length} (первая: ${pageErrors[0].slice(0, 120)})`)
  }
  out.push('')
  out.push(`движок: ${engine}`)
  return out.join('\n')
}
