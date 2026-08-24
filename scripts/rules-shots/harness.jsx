/**
 * СТРАНИЦА СЪЁМКИ ЭКРАНОВ MOTION.
 *
 * Тот же `<MotionApp />`, что стоит в FitPro, с той же сборкой и той же
 * виртуальной камерой, что у прогона персонажа (tools/motion-persona): камера
 * подменена записью живых движений, всё остальное настоящее — распознавание,
 * судейство, отрисовка. Значит и картинка в правилах будет настоящим экраном
 * приложения, а не его пересказом.
 *
 * ОТЛИЧИЕ ОТ ПРОГОНА ПЕРСОНАЖА ОДНО: приложение монтируется НЕ САМО.
 * Съёмке нужны экраны с данными — выбор уровня с потраченной попыткой, комната
 * с пройденными днями, — а день, попытки и рекорды читаются синхронно в ленивых
 * инициализаторах useState. Смонтируй мы раньше засева, экран показал бы
 * пустой первый день и никакого засева уже не увидел бы.
 *
 * Поэтому здесь: поднять камеру → отдать наружу ручку `window.__shots` →
 * ждать. Засев и монтирование зовёт съёмочный скрипт (scripts/rules-shots.mjs).
 */
import { createRoot } from 'react-dom/client'

import MotionApp from '../../src/motion/index.jsx'
import { loadDemoLoops, loopKey } from '../../src/motion/debug/DemoSkeleton.jsx'
import { FIGHT_TYPES } from '../../src/motion/game/session.js'
import { currentScreen } from '../../src/motion/debug/errorReporter.js'
import { getShippedText } from '../../src/motion/debug/logShipper.js'
import { TARGETS_LIVE, readTargets } from '../../src/motion/debug/liveTargets.js'
import { submitAttempt } from '../../src/motion/game/day.js'
import { advanceDay, completeDay } from '../../src/motion/game/challenge.js'

import { installVirtualCamera } from '../../tools/motion-persona/camera.js'
import { createPersona, makeRandom, readActivity } from '../../tools/motion-persona/persona.js'

async function boot() {
  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('vt-seed') || 7)

  const loops = await loadDemoLoops()
  const persona = createPersona({
    loops,
    loopKey,
    profile: {},
    fightTypes: FIGHT_TYPES,
    random: makeRandom(seed),
  })

  let activity = { kind: 'stand', screen: 'boot' }
  let lastLook = 0
  const look = (now) => {
    if (now - lastLook >= 200) {
      lastLook = now
      activity = readActivity(currentScreen(), getShippedText(), TARGETS_LIVE)
    }
    return activity
  }

  const camera = installVirtualCamera({
    poseAt: (now) => persona.poseAt(look(now), now),
    aim: TARGETS_LIVE
      ? (pts, now, w, h) => persona.applyReach(pts, readTargets(), now, w, h)
      : null,
  })

  let root = null

  window.__shots = {
    get screen() {
      return currentScreen()
    },
    get frames() {
      return camera.stats.frames
    },
    /**
     * Сколько мишеней сейчас в воздухе. Экран боя публикует их только под
     * `?motion-debug` (см. debug/liveTargets.js) — съёмке это нужно, чтобы
     * поймать кадр С МИШЕНЬЮ, а не паузу между ними: на картинке правил бой
     * должен быть виден боем.
     */
    get targets() {
      return readTargets().targets.length
    },
    /**
     * ЗАСЕВ ПРОЙДЕННЫМИ ДНЯМИ И ПОТРАЧЕННЫМИ ПОПЫТКАМИ — настоящими функциями
     * игры, а не записью в localStorage руками. Формат хранилища знает только
     * game/day.js, и любая рукописная копия его формы разъедется с ней на первой
     * же правке — а на картинке в правилах это будет выглядеть как пустой экран.
     */
    seed({ days = [], attemptsToday = [] } = {}) {
      for (const d of days) {
        for (const a of d.attempts || []) submitAttempt(a.tier, a.stats, d.day)
        completeDay(d.day, new Date(d.at || Date.now()), d.runs || 1)
        advanceDay()
      }
      for (const a of attemptsToday) submitAttempt(a.tier, a.stats, a.day)
    },
    mount(props = {}) {
      if (!root) root = createRoot(document.getElementById('root'))
      root.render(<MotionApp {...props} />)
    },
  }

  window.__shotsReady = true
}

boot().catch((error) => {
  window.__shotsBootError = String(error?.stack || error)
  console.error('[shots] страница съёмки не поднялась:', error)
})
