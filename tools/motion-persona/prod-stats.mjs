/**
 * ЧТО ЛЮДИ НА САМОМ ДЕЛЕ ДЕЛАЮТ — из motion_log с прода.
 *
 * Персонаж не должен быть выдуман. Движения он берёт из живых записей
 * (debug/demoLoops.json), а ТЕМП — отсюда: сколько повторов в минуту человек
 * реально выдаёт, с какими промежутками бьёт по мишеням, какую частоту замеров
 * при этом показывает телефон и как долго живёт сессия.
 *
 * Скрипт только ЧИТАЕТ и только агрегаты. Ничего, что опознаёт человека, из
 * базы не выносится: наружу идут распределения и медианы, user_id не
 * печатается и в файл не попадает.
 *
 * Запуск: node tools/motion-persona/prod-stats.mjs [--days 30] [--out файл]
 *
 * Без доступа к базе прогон не останавливается: persona.mjs берёт запасной
 * профиль и честно помечает его как «не из прода».
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** .env читаем сами: тянуть dotenv ради двух строк незачем. */
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
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const DAYS = Number(argOf('--days', 30))
const OUT = argOf('--out', 'tools/motion-persona/prod-profile.json')

const env = { ...readEnv('.env'), ...readEnv('.env.local'), ...process.env }
const URL_BASE = env.VITE_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY

if (!URL_BASE || !KEY) {
  console.error('нет VITE_SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY — профиль с прода не собрать')
  process.exit(2)
}

const since = new Date(Date.now() - DAYS * 86400000).toISOString()

/** Строки лога приезжают пачками по сессиям; тянем страницами. */
async function fetchRows() {
  const rows = []
  const PAGE = 1000
  for (let from = 0; from < 50000; from += PAGE) {
    const url =
      `${URL_BASE}/rest/v1/motion_log?select=session,at,payload&at=gte.${since}` +
      `&order=at.asc&limit=${PAGE}&offset=${from}`
    const res = await fetch(url, {
      headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
    })
    if (!res.ok) throw new Error(`motion_log ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const page = await res.json()
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return rows
}

/** `2026-08-19T12:00:00.000Z [game.rep] {"movement":"lunge"}` */
const LINE = /^(\S+)\s+\[([^\]]+)\]\s*(.*)$/

function parse(rows) {
  const events = []
  for (const row of rows) {
    const lines = row.payload?.lines
    if (!Array.isArray(lines)) continue
    for (const raw of lines) {
      const m = String(raw).match(LINE)
      if (!m) continue
      const t = Date.parse(m[1])
      if (!Number.isFinite(t)) continue
      let data = null
      if (m[3]) {
        try {
          data = JSON.parse(m[3])
        } catch {
          data = null
        }
      }
      events.push({ session: row.session, t, tag: m[2], data })
    }
  }
  events.sort((a, b) => a.t - b.t || a.session.localeCompare(b.session))
  return events
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null)
const pct = (a, p) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

function build(events) {
  const tags = {}
  for (const e of events) tags[e.tag] = (tags[e.tag] || 0) + 1

  const sessions = new Map()
  for (const e of events) {
    let s = sessions.get(e.session)
    if (!s) sessions.set(e.session, (s = { from: e.t, to: e.t, events: 0 }))
    s.to = e.t
    s.events += 1
  }

  /**
   * ТЕМП СИЛОВОГО БЛОКА — из `block.end`, а не из промежутков между повторами.
   *
   * Блок длится ровно тридцать секунд по часам расписания, и в его итоге стоит
   * число повторов: этого хватает, чтобы получить период повтора, и это
   * надёжнее, чем считать промежутки по строкам лога. Строки уезжают пачками
   * раз в десять секунд, метка времени у них — момент СОБЫТИЯ, но переполнение
   * буфера выбрасывает массовые события первыми, и дырки в такой гребёнке
   * означали бы «человек отдыхал», хотя он просто потерял строки.
   */
  const strengthReps = {}
  for (const e of events) {
    if (e.tag !== 'block.end' && e.tag !== 'session.strength') continue
    const move = e.data?.movement
    const reps = Number(e.data?.reps)
    if (!move || !Number.isFinite(reps) || reps <= 0) continue
    ;(strengthReps[move] ||= []).push(reps)
  }
  const strengthRepMs = {}
  for (const [move, list] of Object.entries(strengthReps)) {
    const m = median(list)
    // тридцать секунд блока (PHASE_MS.strength) на медианное число повторов
    strengthRepMs[move] = { reps: m, periodMs: Math.round(30000 / m), n: list.length }
  }

  /**
   * ТЕМП БОЯ — как часто в человека летит мишень. Бой длится полторы минуты, в
   * итоге боя стоит `spawned`; отсюда и период. Персонаж делает движение под
   * каждую мишень, поэтому его темп в бою — это темп появления мишеней.
   */
  const spawnPeriods = []
  for (const e of events) {
    const spawned = Number(e.data?.spawned)
    if (e.tag === 'game.end' && Number.isFinite(spawned) && spawned > 0) {
      spawnPeriods.push(90000 / spawned)
    }
  }

  /** Реакция на мишень: сколько человеку нужно, чтобы до неё дотянуться. */
  const reaction = []
  for (const e of events) {
    const t = Number(e.data?.timing)
    if (e.tag === 'game.clear' && Number.isFinite(t) && t > 0) reaction.push(t)
  }

  /** Частота замеров, которую телефоны реально показывают. */
  const fps = []
  const fpsMin = []
  const inference = []
  const latency = []
  for (const e of events) {
    const d = e.data
    if (!d) continue
    if (Number.isFinite(d.fps)) fps.push(d.fps)
    if (Number.isFinite(d.fpsMin)) fpsMin.push(d.fpsMin)
    if (Number.isFinite(d.inferenceMs)) inference.push(d.inferenceMs)
    if (Number.isFinite(d.inferenceAvg)) inference.push(d.inferenceAvg)
    if (Number.isFinite(d.latencyMs)) latency.push(d.latencyMs)
  }

  /** Доля зачётов: по ней сверяется правдоподобие прогона. */
  let cleared = 0
  let missed = 0
  for (const e of events) {
    if (e.tag !== 'game.end') continue
    cleared += Number(e.data?.cleared) || 0
    missed += Number(e.data?.missed) || 0
  }

  const durations = [...sessions.values()].map((s) => s.to - s.from).filter((d) => d > 60000)

  return {
    collectedAt: new Date().toISOString(),
    windowDays: DAYS,
    sessions: sessions.size,
    events: events.length,
    tags,
    sessionMs: { median: median(durations), max: durations.length ? Math.max(...durations) : null },
    strengthRepMs,
    fightSpawnMs: {
      median: spawnPeriods.length ? Math.round(median(spawnPeriods)) : null,
      n: spawnPeriods.length,
    },
    reactionMs: { median: median(reaction), p75: pct(reaction, 0.75), n: reaction.length },
    poseRate: {
      median: median(fps),
      p10: pct(fps, 0.1),
      min: fpsMin.length ? Math.min(...fpsMin) : null,
      n: fps.length,
    },
    inferenceMs: { median: median(inference), p90: pct(inference, 0.9), n: inference.length },
    latencyMs: { median: median(latency), p90: pct(latency, 0.9), n: latency.length },
    hitRate: cleared + missed ? +(cleared / (cleared + missed)).toFixed(3) : null,
  }
}

const rows = await fetchRows()
const events = parse(rows)
const profile = build(events)
writeFileSync(OUT, JSON.stringify(profile, null, 2))
console.log(`строк motion_log: ${rows.length}, событий: ${events.length}, сессий: ${profile.sessions}`)
console.log(JSON.stringify(profile, null, 2))
console.log(`\nпрофиль записан: ${OUT}`)
