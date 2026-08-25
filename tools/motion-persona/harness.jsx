/**
 * СТРАНИЦА ПРОГОНА: настоящий раздел Motion с виртуальной камерой вместо живой.
 *
 * Монтируется ровно тот же `<MotionApp />`, что стоит в FitPro, из тех же
 * исходников и той же сборкой (см. `vite.harness.config.js` — конфигурация
 * наследуется от боевой, меняется только точка входа). Вокруг него нет
 * оболочки FitPro: ни входа в аккаунт, ни навигации, ни синхронизации прогресса
 * с сервером. Это осознанно — весь конвейер, ради которого затевался прогон
 * (захват, распознавание, судейство, отрисовка), живёт внутри `src/motion`, а
 * оболочка добавила бы к прогону только вход по паролю и его отказы.
 *
 * ПОРЯДОК ВАЖЕН: камера ставится ДО монтирования. `useCamera` спрашивает
 * getUserMedia в первом же эффекте, и опоздай мы на один тик — приложение
 * получило бы отказ и показало экран «нет камеры».
 *
 * БЕЗ StrictMode, и это не небрежность: он монтирует дерево дважды, то есть
 * дважды поднимает камеру и воркер распознавания. В бою такого не бывает, а
 * прогон ищет лишнюю работу — и нашёл бы свою собственную.
 */
import { createRoot } from 'react-dom/client'

import MotionApp from '../../src/motion/index.jsx'
import { loadDemoLoops, loopKey } from '../../src/motion/debug/DemoSkeleton.jsx'
import { FIGHT_TYPES } from '../../src/motion/game/session.js'
import { currentScreen } from '../../src/motion/debug/errorReporter.js'
import { getShippedText } from '../../src/motion/debug/logShipper.js'
import { rateStats } from '../../src/motion/debug/diagnostics.js'
import { TARGETS_LIVE, readTargets } from '../../src/motion/debug/liveTargets.js'

import { readHits } from '../../src/motion/debug/hitLatency.js'
import { installVirtualCamera } from './camera.js'
import { createPersona, makeRandom, readActivity } from './persona.js'

const startedAt = performance.now()

/**
 * СБОР ОТЧЁТА ПО СТАДИЯМ.
 *
 * Приложение уже кладёт `stageReport()` в журнал — в `game.end` после каждого
 * боя и в `block.end` после каждого силового блока. Ничего нового ради прогона
 * измерять не надо и не следует: мерил бы прогон себя, а не приложение.
 *
 * Журнал читается ПО ХОДУ, а не в конце. Буфер журнала ограничен шестьюстами
 * строками и переполняется за сессию не один раз; выбрасываются сначала
 * массовые события, но полагаться на то, что итоги блоков доживут до конца
 * семнадцати минут, нельзя.
 */
const collected = []
const seen = new Set()
const LINE =
  /^(\S+)\s+\[(game\.end|block\.end|session\.end|game\.round\.start|block\.start|render\.cheap|worker\.fallback|model\.error|model\.ready|camera\.degraded)\]\s*(.*)$/

function harvest() {
  for (const raw of getShippedText().split('\n')) {
    if (seen.has(raw)) continue
    const m = raw.match(LINE)
    if (!m) continue
    seen.add(raw)
    let data
    try {
      data = JSON.parse(m[3])
    } catch {
      // строка без полезной нагрузки или с обрезанной — событие всё равно
      // ценно самим фактом и временем
      data = null
    }
    collected.push({
      tag: m[2],
      // время СБОРА, а не строки: строка несёт стенные часы, а таблица
      // раскладывается по минутам от начала прогона
      atMs: Math.round(performance.now() - startedAt),
      iso: m[1],
      data,
    })
  }
}

async function boot() {
  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('vt-seed') || 7)

  /** Профиль прода кладётся рядом сборкой; нет его — прогон скажет об этом сам. */
  const profile = await fetch('./prod-profile.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

  const loops = await loadDemoLoops()

  const persona = createPersona({
    loops,
    loopKey,
    profile: profile ?? {},
    fightTypes: FIGHT_TYPES,
    random: makeRandom(seed),
  })

  /**
   * ЧТО ПЕРСОНАЖ ДЕЛАЕТ ПРЯМО СЕЙЧАС.
   *
   * Пересчитывается не на каждом кадре камеры, а раз в 200 мс: `currentScreen()`
   * дёшев, а вот разбор текста журнала ради имени движения — нет, и звать его
   * тридцать раз в секунду значило бы добавить к прогону работу, которой в
   * приложении нет. Экран меняется реже, чем раз в тридцать секунд.
   */
  let activity = { kind: 'stand', screen: 'boot' }
  let lastLook = 0
  const look = (now) => {
    if (now - lastLook >= 200) {
      lastLook = now
      activity = readActivity(currentScreen(), getShippedText(), TARGETS_LIVE)
    }
    return activity
  }

  /**
   * ЗРЕНИЕ. Список летящих мишеней публикует сам экран боя — но только под
   * `?motion-debug` (см. src/motion/debug/liveTargets.js). Читается КАЖДЫЙ кадр
   * камеры, и это правильно: мишень живёт две секунды на «профи», и опоздание
   * даже на десятую долю секунды — это промах, которого у человека не было бы.
   *
   * Без ключа `readTargets()` всегда отдаёт один и тот же пустой снимок, и
   * персонаж возвращается к слепому перебору движений.
   */
  const camera = installVirtualCamera({
    poseAt: (now) => persona.poseAt(look(now), now),
    aim: TARGETS_LIVE
      ? (pts, now, w, h) => persona.applyReach(pts, readTargets(), now, w, h)
      : null,
  })

  setInterval(harvest, 2000)

  /** Ручка для прогона: playwright читает отсюда. */
  window.__vt = {
    get screen() {
      return currentScreen()
    },
    get activity() {
      return activity
    },
    get cameraFrames() {
      return camera.stats.frames
    },
    get elapsedMs() {
      return Math.round(performance.now() - startedAt)
    },
    rate: () => rateStats(),
    profileFromProd: !!profile,
    eyes: TARGETS_LIVE,
    get targets() {
      return readTargets().targets.length
    },
    collect() {
      harvest()
      return collected
    },
    /**
     * Путь каждого попадания от захвата кадра до кадра со взрывом. Пишет его
     * сам экран боя (src/motion/debug/hitLatency.js) — прогон только забирает,
     * ничего не измеряя от себя: мерил бы прогон себя, а не приложение.
     */
    hits: () => readHits(),
    log: () => getShippedText(),
  }

  createRoot(document.getElementById('root')).render(<MotionApp />)
}

boot().catch((error) => {
  window.__vtBootError = String(error?.stack || error)
  console.error('[vt] прогон не поднялся:', error)
})
