/**
 * Звуковая обратная связь. Человек стоит в двух метрах и смотрит вперёд,
 * а не в экран, поэтому всё важное должно быть слышно.
 *
 * Речи здесь нет намеренно. Web Speech API оказался неработоспособен на целевом
 * устройстве: Chrome на iOS принимал фразы и выбрасывал их без звука и без
 * ошибки — в логе с телефона «попыток 43, озвучено 0, ошибок 0», не прозвучала
 * даже пробная фраза внутри жеста. Тоны Web Audio на том же устройстве звучат
 * всегда, поэтому весь язык общения построен на них.
 *
 * Словарь сигналов:
 *   тик отсчёта      тихий короткий щелчок, секунды до последних трёх
 *   отсчёт 5..1      короткий тон, высота растёт к старту
 *   старт            восходящее трезвучие
 *   повтор засчитан  короткий 800 Гц
 *   каждый пятый     сдвоенный акцент, чтобы не терять счёт без голоса
 *   неглубокий       низкий 300 Гц
 *   десять секунд    двойной 700 Гц
 *   конец подхода    нисходящее трезвучие
 *   потерян кадр     два низких, не чаще раза в 4 секунды
 */

import { logEvent } from '../debug/logShipper.js'
import { KEYS, readRaw, writeRaw } from '../storage.js'

const STORAGE_KEY = KEYS.audio
/** Сигнал о потерянном кадре не должен долбить. */
export const HINT_GAP_MS = 4000

let enabled = readEnabled()
let ctx = null
let lastHintAt = -Infinity

const subscribers = new Set()

/**
 * ПОЧЕМУ БЫЛО ТИХО — по одной строке на причину за сессию.
 *
 * Жалоба «не слышно» приходит уже после тренировки, и различить по ней тумблер,
 * незапущенный контекст и отсутствие Web Audio нечем. Пишется ПЕРВЫЙ случай
 * каждой причины: сигналов за сессию сотни, и записывать каждый молчаливый
 * значило бы заменить лог одной этой строкой.
 */
const blockedSeen = new Set()

function noteBlocked(cause) {
  if (blockedSeen.has(cause)) return
  blockedSeen.add(cause)
  logEvent('audio.blocked', { cause, ctxState: ctx ? ctx.state : 'none' })
}

function readEnabled() {
  // хранилища нет или ключа нет — звук по умолчанию включён
  const raw = readRaw(STORAGE_KEY)
  return raw == null ? true : raw === '1'
}

export function isAudioEnabled() {
  return enabled
}

export function setAudioEnabled(next) {
  enabled = !!next
  writeRaw(STORAGE_KEY, enabled ? '1' : '0')
  if (enabled) unlockAudio()
  for (const fn of subscribers) fn(enabled)
  return enabled
}

export function subscribeAudio(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * Разблокировка звука. Браузеры не дают запустить AudioContext без жеста
 * пользователя, а кнопок запуска в сценарии нет — ловим первое касание
 * где угодно по документу.
 */
export function unlockAudio() {
  // iOS глушит Web Audio, пока на боку телефона поднят беззвучный переключатель:
  // по умолчанию звук со страницы считается «звуком интерфейса». Категория
  // playback переводит его в разряд медиа — и он играет даже в беззвучном режиме.
  if (globalThis.navigator?.audioSession) {
    try {
      globalThis.navigator.audioSession.type = 'playback'
    } catch {
      // старый Safari — просто нет этой ручки
    }
  }
  const audio = ensureContext()
  if (audio?.state === 'suspended') audio.resume().catch(() => {})
}

/**
 * Снимок для лога и диагностики: почему на телефоне тихо — выключен тумблер
 * или контекст так и не вышел из suspended.
 */
export function getAudioState() {
  return { enabled, ctxState: ctx ? ctx.state : 'none' }
}

/** @returns {boolean} звук готов играть (иначе нужен тап по экрану) */
export function isAudioReady() {
  if (!enabled || !ctx) return false
  return ctx.state === 'running'
}

/**
 * ЗАКРЫТЬ ЗВУК ПРИ ЗАКРЫТИИ РАЗДЕЛА.
 *
 * AudioContext модульный и до сих пор не закрывался никогда: его убирала
 * перезагрузка страницы, которой внутри FitPro больше не будет. Незакрытый
 * контекст держит аудиовыход устройства, а браузеры дают их около шести на
 * страницу — то есть шестое открытие Motion осталось бы без звука вовсе, и
 * выглядело бы это как «на этом телефоне игра молчит».
 *
 * Память о том, ПОЧЕМУ было тихо, тоже забывается: причина «контекст не
 * запустился» относилась к прошлому контексту, а нового ещё нет. Иначе первая
 * строка audio.blocked нового захода не написалась бы — та же причина уже
 * значилась виденной.
 *
 * Тумблер (enabled) не трогаем: это выбор человека, он лежит в хранилище и
 * переживает не только закрытие раздела, но и смену телефона.
 */
export function disposeAudio() {
  const audio = ctx
  ctx = null
  lastHintAt = -Infinity
  blockedSeen.clear()
  try {
    audio?.close?.()?.catch?.(() => {})
  } catch {
    // контекст уже закрыт системой — закрывать нечего
  }
}

function ensureContext() {
  if (!enabled) return null
  if (ctx) return ctx
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!AudioCtx) return null
  try {
    ctx = new AudioCtx()
  } catch {
    ctx = null
  }
  return ctx
}

/** Короткий тон. Мягкая огибающая, чтобы не щёлкало. */
export function tone(frequency, durationMs, { gain = 0.18, type = 'sine', delayMs = 0 } = {}) {
  if (!enabled) {
    noteBlocked('off')
    return false
  }
  const audio = ensureContext()
  if (!audio) {
    noteBlocked('no-context')
    return false
  }
  if (audio.state === 'suspended') {
    // играть всё равно пробуем: часть браузеров догоняет очередь после resume
    noteBlocked('suspended')
    audio.resume().catch(() => {})
  }

  try {
    const osc = audio.createOscillator()
    const amp = audio.createGain()
    const start = audio.currentTime + delayMs / 1000
    const dur = durationMs / 1000

    osc.type = type
    osc.frequency.setValueAtTime(frequency, start)

    amp.gain.setValueAtTime(0, start)
    amp.gain.linearRampToValueAtTime(gain, start + 0.008)
    amp.gain.setValueAtTime(gain, start + Math.max(0.008, dur - 0.02))
    amp.gain.linearRampToValueAtTime(0, start + dur)

    osc.connect(amp).connect(audio.destination)
    osc.start(start)
    osc.stop(start + dur + 0.02)
    return true
  } catch {
    return false
  }
}

/**
 * Последовательность тонов. Планируется сразу на таймлайне AudioContext,
 * а не через setTimeout: так рисунок не плывёт, когда основной поток занят
 * инференсом.
 */
function sequence(steps) {
  if (!enabled) {
    noteBlocked('off')
    return false
  }
  let at = 0
  let ok = false
  for (const step of steps) {
    ok = tone(step.freq, step.ms, { gain: step.gain, delayMs: at }) || ok
    at += step.ms + (step.gap ?? 60)
  }
  return ok
}

/**
 * Тик отсчёта — секунда прошла, и только.
 *
 * Нужен там, где отсчёт длинный: стартовые десять секунд сессии тикают, а
 * акцент (cueCountdown) остаётся на последних трёх. Отбей все десять акцентом —
 * и «пора» перестало бы значить «пора». Поэтому тише и глуше остальных
 * сигналов: он держит ритм, а не зовёт.
 */
export function cueTick() {
  return tone(380, 45, { gain: 0.1 })
}

/** Отсчёт: чем ближе старт, тем выше тон. */
export function cueCountdown(n) {
  const step = Math.max(0, Math.min(5, 5 - n))
  return tone(440 + step * 60, 120, { gain: 0.2 })
}

/** Старт подхода — восходящее трезвучие, ни с чем не спутать. */
export function cueStart() {
  return sequence([
    { freq: 660, ms: 90 },
    { freq: 880, ms: 90 },
    { freq: 1180, ms: 200 },
  ])
}

/** Засчитанный повтор. */
export function cueRep() {
  return tone(800, 60, { gain: 0.2 })
}

/** Каждый пятый повтор — акцент, чтобы не терять счёт без голоса. */
export function cueMilestone() {
  return sequence([
    { freq: 900, ms: 70, gap: 50 },
    { freq: 1200, ms: 110 },
  ])
}

/** Присед не доведён до нижнего порога. */
export function cueShallow() {
  return tone(300, 160, { gain: 0.22 })
}

/** Осталось десять секунд. */
export function cueWarn() {
  return sequence([
    { freq: 700, ms: 100 },
    { freq: 700, ms: 100 },
  ])
}

/** Подход закончен. */
export function cueFinish() {
  return sequence([
    { freq: 880, ms: 120 },
    { freq: 660, ms: 120 },
    { freq: 520, ms: 280 },
  ])
}

/**
 * Кадр потерян. С ограничением частоты: без него сигнал долбит каждый кадр,
 * пока человек идёт обратно в кадр.
 */
export function cueFrameLost(now = Date.now()) {
  if (!enabled) return false
  if (now - lastHintAt < HINT_GAP_MS) return false
  lastHintAt = now
  return sequence([
    { freq: 320, ms: 110 },
    { freq: 260, ms: 170 },
  ])
}

export function resetHintThrottle() {
  lastHintAt = -Infinity
}
