/**
 * РАЗБОР ОТКАТОВ НА ГЛАВНЫЙ ПОТОК — по motion_log с прода.
 *
 * Прогон персонажа (`run.mjs`) показал: когда воркер распознавания не
 * поднимается, приложение честно уходит считать на главный поток, и это НЕ
 * «просто медленнее» — это другая архитектура. Инференс начинает блокировать и
 * насос кадров, и отрисовку: замер в WebKit без OffscreenCanvas дал 2 позы/с и
 * кадр раз в 330 мс против 11–14 поз/с в воркере.
 *
 * В поле откат встречается. Вопрос этого скрипта ровно один: **у сессий с
 * откатом частота падает так, как жалуются, а у остальных нет?** Если да —
 * причина найдена, и чинить надо откат, а не пороги судейства.
 *
 * Скрипт только читает и печатает агрегаты. user_id наружу не выносится.
 *
 * Запуск: node tools/motion-persona/fallback-report.mjs [--days 60]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

function readEnv(file = '.env') {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const args = process.argv.slice(2)
const argOf = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const DAYS = Number(argOf('--days', 60))
const OUT = argOf('--out', 'reports/motion-fallback.json')

const env = { ...readEnv('.env'), ...readEnv('.env.local'), ...process.env }
if (!env.VITE_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('нет VITE_SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}

const since = new Date(Date.now() - DAYS * 86400000).toISOString()

async function fetchRows() {
  const rows = []
  for (let from = 0; from < 100000; from += 1000) {
    const url =
      `${env.VITE_SUPABASE_URL}/rest/v1/motion_log?select=session,at,payload` +
      `&at=gte.${since}&order=at.asc&limit=1000&offset=${from}`
    const res = await fetch(url, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    })
    if (!res.ok) throw new Error(`motion_log ${res.status}`)
    const page = await res.json()
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

const LINE = /^(\S+)\s+\[([^\]]+)\]\s*(.*)$/

function parse(rows) {
  const events = []
  for (const row of rows) {
    for (const raw of row.payload?.lines ?? []) {
      const m = String(raw).match(LINE)
      if (!m) continue
      const t = Date.parse(m[1])
      if (!Number.isFinite(t)) continue
      let data = null
      try {
        data = m[3] ? JSON.parse(m[3]) : null
      } catch {
        data = null
      }
      events.push({ session: row.session, t, tag: m[2], data, raw })
    }
  }
  return events.sort((a, b) => a.t - b.t)
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null)

/** Круг из имени экрана: `session:fight:круг3` -> 3. Иначе null. */
const cycleOf = (screen) => {
  const m = String(screen || '').match(/круг(\d+)/)
  return m ? Number(m[1]) : null
}

function build(events) {
  const sessions = new Map()
  const get = (id) => {
    let s = sessions.get(id)
    if (!s) {
      sessions.set(
        id,
        (s = {
          id,
          from: null,
          to: null,
          fellBack: false,
          fallbackReasons: [],
          modelErrors: [],
          /** Каким потоком считали в итоге — по последнему model.ready. */
          thread: null,
          delegate: null,
          camera: null,
          assets: [],
          /** Снимки: частота и задержка по кругам. */
          byCycle: new Map(),
          fpsAll: [],
          latAll: [],
          cheap: 0,
          cleared: 0,
          missed: 0,
          reps: 0,
        }),
      )
    }
    return s
  }

  for (const e of events) {
    const s = get(e.session)
    if (s.from == null) s.from = e.t
    s.to = e.t

    switch (e.tag) {
      case 'worker.fallback':
        s.fellBack = true
        if (e.data?.why) s.fallbackReasons.push(String(e.data.why))
        break
      case 'model.error':
        s.modelErrors.push({ code: e.data?.code, stage: e.data?.stage, message: e.data?.message })
        break
      case 'model.ready':
        s.thread = e.data?.thread ?? 'worker'
        s.delegate = e.data?.delegate ?? null
        break
      case 'camera.ready':
        s.camera = e.data
        break
      case 'assets.source':
      case 'assets.fallback':
        s.assets.push(e.data?.from ?? '?')
        break
      case 'render.cheap':
        if (e.data?.on) s.cheap += 1
        break
      case 'game.end':
        s.cleared += Number(e.data?.cleared) || 0
        s.missed += Number(e.data?.missed) || 0
        break
      case 'block.end':
        s.reps += Number(e.data?.reps) || 0
        break
      case 'snapshot': {
        const fps = Number(e.data?.fps)
        const lat = Number(e.data?.latencyMs)
        // снимок пишется и на паузе; нулевая частота там — не просадка, а
        // «человека нет в кадре», и в темп её брать нельзя
        if (Number.isFinite(fps) && fps > 0) s.fpsAll.push(fps)
        if (Number.isFinite(lat) && lat > 0) s.latAll.push(lat)
        if (e.data?.thread && !s.thread) s.thread = e.data.thread
        const c = cycleOf(e.data?.screen)
        if (c != null && Number.isFinite(fps) && fps > 0) {
          if (!s.byCycle.has(c)) s.byCycle.set(c, { fps: [], lat: [] })
          s.byCycle.get(c).fps.push(fps)
          if (Number.isFinite(lat) && lat > 0) s.byCycle.get(c).lat.push(lat)
        }
        break
      }
      default:
        break
    }
  }

  const list = []
  for (const s of sessions.values()) {
    const cycles = {}
    for (const [c, v] of [...s.byCycle.entries()].sort((a, b) => a[0] - b[0])) {
      cycles[c] = { fps: median(v.fps), lat: median(v.lat), n: v.fps.length }
    }
    const total = s.cleared + s.missed
    list.push({
      id: s.id,
      durationMs: s.to - s.from,
      fellBack: s.fellBack,
      thread: s.thread,
      delegate: s.delegate,
      reasons: [...new Set(s.fallbackReasons)],
      modelErrors: s.modelErrors,
      camera: s.camera,
      assets: [...new Set(s.assets)],
      fpsMedian: median(s.fpsAll),
      fpsSamples: s.fpsAll.length,
      latMedian: median(s.latAll),
      cheapTransitions: s.cheap,
      cleared: s.cleared,
      missed: s.missed,
      hitRate: total ? +(s.cleared / total).toFixed(3) : null,
      reps: s.reps,
      cycles,
    })
  }
  return list.sort((a, b) => a.id.localeCompare(b.id))
}

// ------------------------------------------------------------------ печать ---

const pad = (v, n) => String(v ?? '—').padStart(n)

function render(list) {
  const out = []
  const withFb = list.filter((s) => s.fellBack)
  const without = list.filter((s) => !s.fellBack)
  /** Сессии, где вообще что-то считалось: пустые в сравнение не берём. */
  const real = (a) => a.filter((s) => s.fpsSamples >= 5)

  out.push('═'.repeat(78))
  out.push(`ОТКАТЫ НА ГЛАВНЫЙ ПОТОК: ${withFb.length} из ${list.length} сессий за ${DAYS} дней`)
  out.push('═'.repeat(78))

  out.push('')
  out.push('ПРИЧИНА ОТКАТА (что написано в событии):')
  const reasons = new Map()
  for (const s of withFb) for (const r of s.reasons) reasons.set(r, (reasons.get(r) || 0) + 1)
  if (!reasons.size) out.push('  — событий отката с причиной нет')
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${n}× ${r}`)
  }

  out.push('')
  out.push('СНИМОК УСТРОЙСТВА у откатившихся (камера — единственное, что есть в журнале):')
  for (const s of withFb) {
    const c = s.camera
    out.push(
      `  ${s.id}  ${c ? `${c.width}x${c.height}@${c.frameRate ?? '—'} ${c.facingMode ?? ''}` : 'камеры в журнале нет'}` +
        `  поток=${s.thread ?? '—'} делегат=${s.delegate ?? '—'} источник=${s.assets.join(',') || '—'}`,
    )
  }

  out.push('')
  out.push('СЕССИИ ПОДРЯД (↯ — был откат):')
  out.push('   сессия                 длит.  поток   поз/с  задержка  зачёт  повт.  круги: поз/с по кругам')
  for (const s of list) {
    const cyc = Object.entries(s.cycles)
      .map(([c, v]) => `${c}:${v.fps}`)
      .join(' ')
    out.push(
      `  ${s.fellBack ? '↯' : ' '} ${s.id.padEnd(20)} ${pad(Math.round(s.durationMs / 1000), 5)}с` +
        ` ${String(s.thread ?? '—').padEnd(7)}${pad(s.fpsMedian, 5)}${pad(s.latMedian, 9)}мс` +
        `${pad(s.hitRate == null ? '—' : Math.round(s.hitRate * 100) + '%', 7)}${pad(s.reps, 7)}   ${cyc}`,
    )
  }

  const summarise = (group, name) => {
    const g = real(group)
    if (!g.length) return `  ${name}: сессий с замерами нет`
    const fps = median(g.map((s) => s.fpsMedian).filter(Number.isFinite))
    const lat = median(g.map((s) => s.latMedian).filter(Number.isFinite))
    const hits = g.map((s) => s.hitRate).filter((v) => v != null)
    const hit = hits.length ? Math.round(median(hits) * 100) + '%' : '—'
    return `  ${name.padEnd(28)} сессий ${String(g.length).padStart(2)}   поз/с ${pad(fps, 4)}   задержка ${pad(lat, 5)}мс   зачёт ${hit.padStart(4)}`
  }

  out.push('')
  out.push('СРАВНЕНИЕ (медианы по сессиям, где вообще шёл замер):')
  out.push(summarise(withFb, 'с откатом'))
  out.push(summarise(without, 'без отката'))

  /**
   * ГЛАВНЫЙ ВОПРОС: падает ли частота К ТРЕТЬЕМУ КРУГУ у откатившихся и держится
   * ли у остальных. Именно наклон, а не уровень: телефоны разные, и медленный
   * телефон без отката — это не то же самое, что откат.
   */
  out.push('')
  out.push('ЧАСТОТА ПО КРУГАМ (медиана по сессиям группы):')
  out.push('  группа                круг1  круг2  круг3  круг4  круг5  круг6  круг7')
  for (const [group, name] of [
    [withFb, 'с откатом'],
    [without, 'без отката'],
  ]) {
    const cells = []
    for (let c = 1; c <= 7; c += 1) {
      const vals = real(group)
        .map((s) => s.cycles[c]?.fps)
        .filter(Number.isFinite)
      cells.push(pad(vals.length ? median(vals) : '—', 6))
    }
    out.push(`  ${name.padEnd(20)}${cells.join(' ')}`)
  }

  return out.join('\n')
}

const rows = await fetchRows()
const events = parse(rows)
const list = build(events)
console.log(render(list))
writeFileSync(OUT, JSON.stringify({ collectedAt: new Date().toISOString(), windowDays: DAYS, sessions: list }, null, 2))
console.log(`\nполный разбор: ${OUT}`)
